#!/usr/bin/env node
// 自动回复常驻进程：监听 NapCat WS 事件 → 按 config/autoreply.json 规则回复
// 用法:
//   node scripts/auto-reply.js              正式运行（常驻，断线自动重连）
//   node scripts/auto-reply.js --once       只跑一轮就退出（调试）
//   node scripts/auto-reply.js --self-test  离线跑决策规则用例（不连网、不发消息）
//   node scripts/auto-reply.js --test-send  用一次真实 WS 事件走完整链路（发给自己，回完即退）
const fs = require('fs');
const path = require('path');
const { call } = require('./qq.js');
const stickers = require('./stickers.js');
const vision = require('./vision.js');
const ctxStore = require('./context.js');
const style = require('./style.js');
const echo = require('./echo.js');
const risk = require('./risk.js'); // 风控闸门：冷却期/额度受限时禁止发送
const group = require('./group.js');
const self = require('./self.js');
const clock = require('./clock.js');
const say = require('./say.js');
const them = require('./them.js'); // 人话自检（发送前扫中英混杂/助手口气/列清单/复述画面） // 历法感（今天周几/节日/时段） // 自我线（我也有自己的事在忙） // 群聊在场感（该不该插话） // 说话的分寸（关系/心情 → 尺度）
const promises = require('./promises.js');
const mind = require('./mind.js');
const avatar = require('./avatar.js'); // 聊天里说「换个头像」→ 立刻换一款
const follow = require('./follow.js'); // 群聊被 @ 之后，接着那几句话继续听
const nick = require('./nick.js'); // 聊天里改昵称（只听关系够近的人）
const quoteStore = require('./quote.js'); // 引用消息：取回被引用那条 + 谁说的/多久前/有没有图

const ROOT = path.join(__dirname, '..');
const CFG = process.env.AUTOREPLY_CONFIG || path.join(ROOT, 'config', 'autoreply.json');
const LOG = process.env.AUTOREPLY_LOG || path.join(ROOT, 'logs', 'autoreply.log');
// 离线自检必须用独立状态文件：否则真实聊天把限流额度用光，自检会假失败
if (process.argv.includes('--self-test')) {
  process.env.AUTOREPLY_STATE = process.env.AUTOREPLY_STATE || path.join(ROOT, 'logs', 'self-test-state.json');
}
const STATE = process.env.AUTOREPLY_STATE || path.join(ROOT, 'logs', 'autoreply-state.json');
const INCOMING = process.env.AUTOREPLY_INCOMING || path.join(ROOT, 'logs', 'incoming');
const TOKEN = (() => {
  if (process.env.OB11_TOKEN) return String(process.env.OB11_TOKEN).trim();
  try { return fs.readFileSync(path.join(__dirname, 'ob11.token'), 'utf8').trim(); } catch (e) { return ''; }
})();
const WS_URL = process.env.OB11_WS || `ws://127.0.0.1:3001/?access_token=${encodeURIComponent(TOKEN)}`;
// 自己是谁：优先环境变量，其次配置里的 selfId（开源版没有真实号，别硬编码）
const SELF_ID = Number(process.env.SELF_UIN || 0) || (() => {
  try { return Number(JSON.parse(fs.readFileSync(CFG, 'utf8')).selfId) || 0; } catch (e) { return 0; }
})();

function log(obj, human) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...obj }) + '\n');
  } catch (e) { }
  if (human && process.stdout.isTTY) console.log(new Date().toLocaleString('zh-CN', { hour12: false }), human);
}

// ---------- 配置（热加载） ----------
let cfg = null;
let cfgMtime = 0;
function loadCfg(force) {
  try {
    const m = fs.statSync(CFG).mtimeMs;
    if (!force && cfg && m === cfgMtime) return cfg;
    cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    cfgMtime = m;
    return cfg;
  } catch (e) {
    cfg = cfg || { enabled: false, _error: String(e.message) };
    return cfg;
  }
}

// ---------- 限流状态 ----------
let state = { sent: [] }; // [{t, key}]
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { }
function saveState() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  state.sent = (state.sent || []).filter(s => s.t > cutoff);
  try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch (e) { }
}
function withinHour(key) {
  const since = Date.now() - 3600 * 1000;
  return (state.sent || []).filter(s => s.t > since && (!key || s.key === key)).length;
}

// ---------- 决策 ----------
function parseHHMM(s) {
  const [h, m] = String(s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function inQuietHours(c) {
  // DSH 不需要睡觉：quietHours 默认关掉，留开关只为「用户明确想让我夜里闭嘴」
  if (!c.quietHours || c.quietHours.enabled === false) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = parseHHMM(c.quietHours?.start || '23:30');
  const b = parseHHMM(c.quietHours?.end || '07:30');
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}
function textOf(msg) {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return msg.filter(s => s && s.type === 'text').map(s => (s.data && s.data.text) || '').join('').trim();
  }
  return '';
}
function hasAtMe(msg) {
  if (typeof msg === 'string') return msg.includes('@' + SELF_ID) || msg.includes('@' + (cfg?.selfId || SELF_ID));
  return Array.isArray(msg) && msg.some(s => s.type === 'at' && String(s.data?.qq) === String(SELF_ID));
}

// 纯函数：事件 → 决策 {action:'reply'|'skip', reason, reply, target}
function decide(evt, c = cfg || loadCfg(true)) {
  const cfgLocal = c;
  if (!cfgLocal.enabled) return { action: 'skip', reason: 'disabled' };
  if (!evt || evt.post_type !== 'message') return { action: 'skip', reason: 'not-incoming-message' };
  if (String(evt.user_id) === String(cfgLocal.selfId ?? SELF_ID)) return { action: 'skip', reason: 'self' };
  if (evt.message_type === 'private') {
    const p = cfgLocal.private || {};
    if (!p.enabled) return { action: 'skip', reason: 'private-disabled' };
    if ((p.denyList || []).map(String).includes(String(evt.user_id))) return { action: 'skip', reason: 'denied-user' };
    if ((p.allowList || []).length && !(p.allowList || []).map(String).includes(String(evt.user_id)))
      return { action: 'skip', reason: 'not-in-allowlist' };
    return compose(evt, cfgLocal, `p:${evt.user_id}`);
  }
  if (evt.message_type === 'group') {
    const g = cfgLocal.group || {};
    if (!g.enabled) return { action: 'skip', reason: 'group-disabled' };
    if ((g.allowList || []).length && !(g.allowList || []).map(String).includes(String(evt.group_id)))
      return { action: 'skip', reason: 'group-not-allowed' };
    const gid = String(evt.group_id);
    const uin = String(evt.user_id);
    const gKey = `g:${gid}:u:${uin}`;
    const atMe = hasAtMe(evt.message);
    const gText = textOf(evt.message);
    const gNick = (evt.sender && (evt.sender.card || evt.sender.nickname)) || uin;

    // ① 被 @ 了：一定回，并且开一个「跟随窗口」（用户 2026-10-24 要求）
    if (atMe) {
      if (g.follow !== false) { try { follow.open(gid, uin, { nick: gNick }); } catch (e) { log({ event: 'follow-error', where: 'open', err: String(e && e.message) }); } }
      return compose(evt, cfgLocal, gKey);
    }

    // ② 没 @：在跟随窗口里，或这话里点到了我的名字 → 判断是不是还在跟我说
    const sess = (g.follow !== false) ? follow.active(gid, uin) : null;
    const names = followNames(cfgLocal);
    const named = follow.nameHit(gText, names);
    const mentionOk = g.allowNameMention !== false;
    if (sess || (named && mentionOk)) {
      const j = follow.judge({ text: gText, session: sess, names, othersAt: atOthers(evt.message), lastMine: lastMyLine(gid), isQuestion: /[?？]\s*$/.test(gText.trim()) });
      log({ event: 'follow-judge', key: gKey, session: !!sess, named: named || '', reply: j.reply, score: j.score, why: j.why });
      if (j.reply) {
        const dd = compose(evt, cfgLocal, gKey);
        if (dd.action === 'reply') {
          if (g.follow !== false) { try { follow.touch(gid, uin); } catch (e) { /* ignore */ } }
          dd.chime = true;
          dd.follow = !!sess;
          dd.chimeNote = j.note;
          dd.noAt = true; // 顺着话头接，不硬 @ 回去
        }
        return dd;
      }
      if (sess && g.follow !== false) { try { follow.miss(gid, uin); } catch (e) { /* ignore */ } }
      // 判不出来就继续走在场感：也许 TA 是在群里问所有人
    }

    // ③ 剩下的交回在场感层（有人在群里问事、刷屏/两人聊等闸门都在里面）
    const chime = group.shouldChime(gid, { text: gText, nick: gNick, uin, atMe: false, selfId: String(evt.self_id || SELF_ID) });
    if (!chime.ok) return { action: 'skip', reason: chime.reason };
    const dd2 = compose(evt, cfgLocal, gKey);
    if (dd2.action !== 'reply') return dd2;
    dd2.chime = true;
    dd2.chimeNote = chime.note;
    dd2.noAt = true; // 插话不 @ 人（被点名才 @）
    return dd2;
  }
  return { action: 'skip', reason: 'unsupported-type' };
}

/** 群里这条消息 @ 了谁（除我、除 @全体） */
function atOthers(msg) {
  return (Array.isArray(msg) ? msg : [])
    .filter(x => x && x.type === 'at')
    .map(x => String((x.data && x.data.qq) || ''))
    .filter(q => q && q !== 'all' && q !== String(SELF_ID));
}

/** 我在这个群最后说过的一句话（判断「话题还连着」的参照） */
function lastMyLine(gid) {
  try {
    const v = ctxStore.view('g:' + gid);
    const h = (v && v.history) || [];
    for (let i = h.length - 1; i >= 0; i--) if (h[i] && h[i].from === 'me') return String(h[i].text || '');
  } catch (e) { /* ignore */ }
  return '';
}

/** 我叫什么：当前昵称 + 旧昵称别名 */
function followNames(c) {
  try { return nick.currentNames(); } catch (e) { return ['DSH', '我的昵称']; }
}

function compose(evt, c, key) {
  const text = textOf(evt.message);
  const has = (t) => Array.isArray(evt.message) && evt.message.some(x => x && x.type === t);
  const media = has('image') || has('mface');
  const voices = has('record');
  const images = Array.isArray(evt.message)
    ? evt.message
        .filter(x => x && (x.type === 'image' || x.type === 'mface'))
        .map(x => ({
          type: x.type,
          file: x.data && x.data.file,
          url: x.data && x.data.url,
          summary: x.data && x.data.summary
        }))
        .slice(0, 2)
    : [];
  // 既没文字也没图也没语音：红包/系统/未知段，不回
  if (!text && !media && !voices) return { action: 'skip', reason: 'no-text' };
  // 对方如果是另一台自动回复的机器人（回复体以「自动回复」开头），不回，避免两边互刷
  if (/^\s*[（(\[【]?\s*自动回复/.test(text)) {
    return { action: 'skip', reason: 'looks-like-bot' };
  }
  const quiet = inQuietHours(c);
  let fallback;
  let rule = 'default';
  if (quiet) {
    if (withinHour('quiet:' + key) >= 1) return { action: 'skip', reason: 'quiet-already-replied' };
    fallback = (c.quietHours && c.quietHours.replyOnce) || '';
    // 没有现成话术就干脆不回：夜里硬塞一句「我睡了」最像自动回复
    if (!fallback.trim()) return { action: 'skip', reason: 'quiet-silent', rule: 'quiet' };
    rule = 'quiet';
  } else {
    for (const r of c.rules || []) {
      let re;
      try { re = new RegExp(r.match); } catch (e) { continue; }
      if (re.test(text)) { fallback = r.reply; rule = r.id; break; }
    }
    if (!fallback) fallback = c.defaultReply || '我暂时不在，看到就回你～';
  }
  const lim = c.limits || {};
  // 频率限制：填 0（或不填负数）＝不限制。默认就不限——回复节奏已经由 pacing 按真人来，
  // 再拿小时额度挡真人消息只会出现「她连发三条，我只回两条」这种不像人的行为。
  const cph = Number(lim.perContactPerHour);
  const gph = Number(lim.globalPerHour);
  if (cph > 0 && withinHour(key) >= cph) return { action: 'skip', reason: 'contact-rate-limit', rule };
  if (gph > 0 && withinHour() >= gph) return { action: 'skip', reason: 'global-rate-limit', rule };
  // 正常时段交给 brain 自己想说啥；模板只当兜底（brain 挂了/超时才用）。深夜用固定话术。
  const useBrain = !quiet && (c.llm ? c.llm.enabled !== false : true);
  return {
    action: 'reply', rule, reply: useBrain ? '' : fallback, fallbackReply: fallback, useBrain, key,
    target: evt.message_type === 'group' ? { type: 'group', id: evt.group_id, at: evt.user_id } : { type: 'private', id: evt.user_id },
    nick: (evt.sender && (evt.sender.card || evt.sender.nickname)) || String(evt.user_id),
    groupId: evt.message_type === 'group' ? evt.group_id : 0,
    text: text || (voices ? '[发来一条语音]' : '[只发了一个表情包/图片，没配文字]'),
    mediaOnly: !text,
    voices,
    images,
    merged: evt._merge ? evt._merge.n : 1,
    quoted: [
    ...(Array.isArray(evt.message) ? evt.message.filter(x => x && x.type === 'reply').map(x => x.data && x.data.id).filter(Boolean).map(String) : []),
    ...((evt._merge && Array.isArray(evt._merge.quotes)) ? evt._merge.quotes.map(String) : [])
  ]
  };
}

// ---------- 会话上下文：落盘 + 摘要压缩 + 冷启动回填（逻辑在 context.js） ----------
// 群聊按「群」建上下文（带发言人），私聊按人。key 形如 g:<gid> / p:<uin>，
// 落盘在 logs/context/<slug>.json —— 进程重启不会失忆。
const groupNames = new Map();
const warmed = new Set();
function ctxSettings() {
  ctxStore.configure((cfg && cfg.context) || {});
  return ctxStore.options();
}
// 拟人记忆/情感：config/mind.json 为主，autoreply.json 的 "mind" 段可覆盖
function mindSettings() {
  const file = mind.loadCfg();
  const over = (cfg && cfg.mind) || {};
  const merged = { ...file, ...over };
  mind.configure(merged);
  return merged;
}
// 承诺：不调模型，纯本地规则；参数在 autoreply.json 的 "promises" 段
function promiseSettings() {
  const o = { ...promises.DEFAULTS, ...((cfg && cfg.promises) || {}) };
  promises.configure(o);
  return o;
}
// 拟人化：打字状态 + 长句拆条
const HUMANIZE_DEFAULTS = { typing: true, split: true, splitMinChars: 28, splitMax: 2, gapMs: [900, 1800] };
function humanizeSettings() {
  return { ...HUMANIZE_DEFAULTS, ...((cfg && cfg.humanize) || {}) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 把一条长回复拆成 2 条（像人打字时想到一半就发）。
 * 优先在句末标点处切；没有标点就在逗号/中点附近切。
 */
function splitReply(text, maxParts = 2) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (maxParts <= 1) return [t];
  let segs = t.split(/(?<=[。！？!?~～…])/).map(x => x.trim()).filter(Boolean);
  if (segs.length < 2) {
    if (t.length < 30) return [t];
    // 在标点处切，且两边都别太短（避免把「九点」切成「九」+「点」）
    const seps = [];
    for (let i = 0; i < t.length; i++) if ('，,、；; '.includes(t[i])) seps.push(i);
    let at = -1;
    if (seps.length) {
      const ok = seps.filter(i => i >= 8 && t.length - i >= 8);
      const pool = (ok.length ? ok : seps).slice().sort((a, b) => Math.abs(a - t.length / 2) - Math.abs(b - t.length / 2));
      at = pool[0] + 1;
    }
    if (at <= 0) at = Math.floor(t.length / 2);
    // 别切在 emoji 的代理对中间，也别把数字/英文单词劈开
    const high = (ch) => !!ch && ch.charCodeAt(0) >= 0xD800 && ch.charCodeAt(0) <= 0xDBFF;
    const alnum = (ch) => !!ch && /[A-Za-z0-9]/.test(ch);
    if (high(t[at - 1])) at += 1;
    let guard = 0;
    while (at < t.length && alnum(t[at]) && alnum(t[at - 1]) && guard++ < 12) at++;
    return [t.slice(0, at).trim(), t.slice(at).trim()].filter(Boolean);
  }
  while (segs.length > maxParts) {
    let best = 0, bestLen = Infinity;
    for (let i = 0; i + 1 < segs.length; i++) {
      const l = segs[i].length + segs[i + 1].length;
      if (l < bestLen) { bestLen = l; best = i; }
    }
    segs.splice(best, 2, segs[best] + segs[best + 1]);
  }
  return segs;
}

// ---------- 连发合并：同一个人连着发几条 → 合成一件事，只回一次 ----------
// 真人不会被每一条消息各回一句；那是对着刷新按钮说话。
const MERGE_DEFAULTS = { enabled: true, windowMs: 2200, maxMs: 7000, maxMerge: 6 };
function cfgNow() { return cfg || loadCfg(); }
function mergeSettings() { return { ...MERGE_DEFAULTS, ...((cfgNow().merge) || {}) }; }
function themSettings() { return { ...them.DEFAULTS, ...((cfgNow().them) || {}) }; }

function saySettings() { return { ...say.DEFAULTS, ...((cfgNow().say) || {}) }; }
function echoSettings() { return { ...echo.DEFAULTS, ...((cfgNow().echo) || {}) }; }
function quoteSettings() { return { ...quoteStore.DEFAULTS, ...((cfgNow().quote) || {}) }; }
const pending = new Map(); // key -> { evt, timer, firstAt, ids }
function mergeKeyOf(evt) {
  if (!evt || evt.post_type !== 'message') return '';
  if (evt.message_type === 'group') return 'g:' + evt.group_id + ':u:' + evt.user_id;
  if (evt.message_type === 'private') return 'p:' + evt.user_id;
  return '';
}
function mergeable(evt) {
  const m = mergeSettings();
  if (m.enabled === false) return false;
  if (!evt || evt.post_type !== 'message') return false;
  if (String(evt.user_id) === String(evt.self_id || SELF_ID)) return false;
  if (evt.message_type === 'group') return hasAtMe(evt.message); // 群聊只合并「@ 我」的连发
  return evt.message_type === 'private';
}
/** 把同一个人连发的几条合成一个事件：文字按行拼成一段，图/表情/语音保留，引用单独记 */
function mergeEvents(list) {
  const base = { ...list[0] };
  const texts = [];
  const ids = [];
  const keeps = [];
  const quotes = [];
  let atSeg = null;
  for (const e of list) {
    if (e.message_id != null) ids.push(e.message_id);
    const arr = Array.isArray(e.message) ? e.message : [{ type: 'text', data: { text: String(e.message || '') } }];
    for (const seg of arr) {
      if (!seg) continue;
      if (seg.type === 'text') { const t = String((seg.data && seg.data.text) || '').trim(); if (t) texts.push(t); continue; }
      if (seg.type === 'at') { if (!atSeg) atSeg = seg; continue; }
      if (seg.type === 'reply') { const id = seg.data && seg.data.id; if (id) quotes.push(String(id)); continue; }
      keeps.push(seg); // image / mface / record / face …
    }
  }
  const joined = texts.join('\n');
  const msgs = [];
  if (atSeg) msgs.push(atSeg);
  if (joined) msgs.push({ type: 'text', data: { text: joined } });
  for (const k of keeps) msgs.push(k);
  base.message = msgs;
  base.raw_message = joined;
  base._merge = { n: list.length, ids, quotes, texts };
  return base;
}
function flushMerge(key) {
  const slot = pending.get(key);
  if (!slot) return;
  pending.delete(key);
  if (slot.timer) clearTimeout(slot.timer);
  const evt = mergeEvents(slot.evts);
  if (evt._merge && evt._merge.n > 1) log({ event: 'merge', key, n: evt._merge.n, texts: evt._merge.texts.map(t => t.slice(0, 30)) });
  handle(evt).catch(e => log({ event: 'error', err: String(e && e.message) }));
}
/** 事件入口：能合并的先攒起来，等到对方停下来说完再一次性交给 handle */
function dispatch(evt) {
  if (evt && evt.post_type === 'message_sent') evt = { ...evt, post_type: 'message' };
  const m = mergeSettings();
  const key = mergeable(evt) ? mergeKeyOf(evt) : '';
  if (!key) return handle(evt).catch(e => log({ event: 'error', err: String(e && e.message) }));
  const now = Date.now();
  let slot = pending.get(key);
  if (slot && slot.evts.length >= (m.maxMerge || 6)) { pending.delete(key); if (slot.timer) clearTimeout(slot.timer); slot = null; }
  if (!slot) {
    slot = { evts: [], firstAt: now, timer: null };
    pending.set(key, slot);
  }
  slot.evts.push(evt);
  if (slot.timer) clearTimeout(slot.timer);
  const waited = now - slot.firstAt;
  const wait = Math.max(120, Math.min(Number(m.windowMs) || 2200, (Number(m.maxMs) || 7000) - waited));
  slot.timer = setTimeout(() => flushMerge(key), wait);
  if (slot.timer.unref) slot.timer.unref();
}

// ---------- 引用消息：被引用的那条内容要取回来，否则模型看不见「TA 在回什么」 ----------
const quoteCache = new Map();
function textOfAny(msg) {
  if (typeof msg === 'string') return msg;
  if (!Array.isArray(msg)) return '';
  return msg.map((s) => {
    if (!s) return '';
    if (s.type === 'text') return String((s.data && s.data.text) || '');
    if (s.type === 'image') return '[图片]';
    if (s.type === 'mface') return '[表情]';
    if (s.type === 'face') return '[表情]';
    if (s.type === 'record') return '[语音]';
    if (s.type === 'video') return '[视频]';
    if (s.type === 'file') return '[文件]';
    return '';
  }).join('').trim();
}
async function fetchQuote(id, maxChars) {
  const info = await quoteStore.fetchOne(String(id), { call, selfId: SELF_ID, cfg: { maxChars: maxChars || quoteStore.DEFAULTS.maxChars } });
  return (info && info.text) || '';
}

function ctxKindOf(d) { return d.target && d.target.type === 'group' ? 'group' : 'private'; }
/** 承诺账本的 key：群聊也按「群+人」分开，避免 A 的承诺被提给 B。 */
function promiseKeyOf(d) {
  if (ctxKindOf(d) === 'group') return 'g:' + d.target.id + ':u:' + d.target.at;
  return 'p:' + (d.target ? d.target.id : d.key);
}
function ctxKeyOf(d) {
  if (d.target && d.target.type === 'group') return `g:${d.target.id}`;
  return `p:${d.target ? d.target.id : d.key}`;
}
function ctxPeerOf(d) {
  const id = d.target ? d.target.id : 0;
  return ctxKindOf(d) === 'group' ? { gid: id } : { uin: id };
}
/** 记一条对话（from: 'them' | 'me'）；时间优先用事件里的秒级 time。 */
function pushCtxTurn(d, from, text, evt) {
  if (!text) return null;
  const ts = evt && evt.time ? Number(evt.time) * 1000 : Date.now();
  return ctxStore.push(ctxKeyOf(d), {
    t: ts,
    from,
    speaker: from === 'me' ? '' : (d.nick || (evt && evt.user_id ? String(evt.user_id) : '')),
    text: String(text).slice(0, 400),
    kind: ctxKindOf(d),
    peer: ctxPeerOf(d)
  });
}
async function groupNameOf(gid) {
  if (!gid) return '';
  if (groupNames.has(gid)) return groupNames.get(gid);
  try {
    const r = await call('get_group_info', { group_id: gid });
    const name = (r && r.data && (r.data.group_name || r.data.groupName)) || '';
    groupNames.set(gid, name);
    return name;
  } catch (e) { return ''; }
}

/** NapCat 历史接口（给 context.warmup 用的取数回调）：返回旧→新。 */
async function fetchHistory(kind, id, count) {
  const n = Math.max(1, Math.min(Number(count) || 20, 50));
  const r = kind === 'group'
    ? await call('get_group_msg_history', { group_id: id, count: n })
    : await call('get_friend_msg_history', { user_id: id, count: n });
  const d = (r && r.data) || {};
  return d.messages || (Array.isArray(d) ? d : []);
}

/**
 * 冷启动回填：进程刚起来、本地还没有这个会话的上下文时，往回拉最近 N 条。
 * 每个会话只尝试一次（失败也记下，别每次消息都打接口）。
 */
/**
 * 每个会话在本次进程里第一次来消息时做一次「对账」：拉最近 N 条历史灌进上下文。
 * 一次拉取同时解决两件事：
 *   ① 冷启动回填（本地空 → 把最近的补上）；
 *   ② 离线补账（进程停着那段时间别人发的消息没有 WS 事件，只能从历史里捞）。
 * 返回值 = 离线期间对方发的那些消息（没有就 null），由调用方决定要不要跟大脑提一句。
 */
async function catchupOnce(d) {
  const o = ctxSettings();
  if (!o.enabled || !o.warmup) return null;
  const key = ctxKeyOf(d);
  if (warmed.has(key)) return null;
  warmed.add(key);
  try {
    const before = ctxStore.load(key);
    const lastT = before.turns.length ? before.turns[before.turns.length - 1].t : 0;
    const msgs = await fetchHistory(ctxKindOf(d), d.target.id, o.warmupCount || 20);
    if (!msgs || !msgs.length) return null;
    const r = ctxStore.ingest(key, ctxKindOf(d), ctxPeerOf(d), msgs, { selfId: SELF_ID });
    if (r.added) {
      log({ event: 'catchup', key, added: r.added, total: r.total, missed: (r.missed || []).length, firstRun: !lastT },
        `上下文对账 ${key} +${r.added} 条${lastT ? `（离线漏掉 ${(r.missed || []).length} 条）` : '（冷启动回填）'}`);
    }
    return (r.missed && r.missed.length) ? r.missed : null;
  } catch (e) {
    log({ event: 'catchup-error', key, err: String(e && e.message).slice(0, 200) });
    return null;
  }
}

/**
 * 触发式压缩：原文超预算 / 条数近上限 / 空闲太久 → 把最老那段交给 brain.summarize
 * 压成摘要 + 长期事实（借鉴 LangChain ConversationSummaryBufferMemory + mem0 的抽取时机）。
 */
async function compactIfNeeded(d) {
  const o = ctxSettings();
  if (!o.enabled || !o.summarize) return null;
  const key = ctxKeyOf(d);
  let plan;
  try { plan = ctxStore.planCompaction(key); } catch (e) { return null; }
  if (!plan || !plan.need || !plan.old || plan.old.length < 2) return null;
  try {
    const s = await brain.summarize(plan.old, { nick: d.nick });
    ctxStore.applyCompaction(key, { ...plan, summary: s.summary, facts: s.facts });
    log({ event: 'compact', key, dropped: plan.old.length, kept: plan.rest.length, facts: s.facts.length, model: s.model, summary: String(s.summary).slice(0, 160) },
      `上下文压缩 ${key}：${plan.old.length} 条 → 摘要 ${s.summary.length} 字，事实 +${s.facts.length}`);
    return s;
  } catch (e) {
    log({ event: 'compact-error', key, err: String(e && e.message).slice(0, 200) });
    return null;
  }
}

// ---------- 看对方发来的图（视觉模型，只吃 png/jpg，动图先转帧拼图） ----------
function extOf(b) {
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.slice(8, 12).toString() === 'WEBP') return 'webp';
  return 'bin';
}
async function localImageOf(img) {
  if (img.type === 'image' && img.file) {
    try {
      const r = await call('get_image', { file: img.file });
      const p = r && r.data && (r.data.file || r.data.path || r.data.FilePath);
      if (p && fs.existsSync(p)) return p;
    } catch (e) { /* 落到 url */ }
  }
  if (img.url) {
    try {
      fs.mkdirSync(INCOMING, { recursive: true });
      const res = await fetch(img.url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const b = Buffer.from(await res.arrayBuffer());
        const file = path.join(INCOMING, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + extOf(b));
        fs.writeFileSync(file, b);
        return file;
      }
    } catch (e) { /* 放弃 */ }
  }
  return null;
}
async function analyzeIncoming(images) {
  const notes = [];
  for (const img of images || []) {
    if (img.type === 'mface') {
      notes.push(`对方发了一个表情包${img.summary ? `（${img.summary}）` : ''}`);
      continue;
    }
    try {
      const local = await localImageOf(img);
      if (!local) { notes.push('对方发来一张图片（没取到原图）'); continue; }
      const vf = stickers.visionFile(local);
      const r = await vision.describeImage(vf);
      notes.push(`对方发来一张图（${r.type}）：${r.desc}`);
    } catch (e) {
      notes.push('对方发来一张图片（没识别出来）');
    }
  }
  return notes.join('；');
}

// ---------- 发送 ----------
function buildMessage(d) {
  // 只发表情的一条：不带文字（用户要求表情包单独发，别和文字挤在一个气泡里）
  if (d.stickerOnly && d.stickerSeg) {
    const only = [];
    if (d.target && d.target.type === 'group' && !d.noAt) only.push({ type: 'at', data: { qq: String(d.target.at) } });
    only.push(d.stickerSeg);
    return only;
  }
  const segs = [];
  const voiceSeg = d.voiceWav ? { type: 'record', data: { file: String(d.voiceWav).replace(/\\/g, '/') } } : null;
  if (d.target.type === 'group') {
    if (!d.noAt) segs.push({ type: 'at', data: { qq: String(d.target.at) } });
    if (voiceSeg) segs.push(voiceSeg);
    else segs.push({ type: 'text', data: { text: ' ' + (d.reply || '') } });
  } else if (voiceSeg) {
    segs.push(voiceSeg);
  } else if (d.reply) {
    segs.push({ type: 'text', data: { text: d.reply } });
  }
  if (d.voiceSeg) segs.push(d.voiceSeg);
  if (d.stickerSeg) segs.push(d.stickerSeg);
  return segs;
}

// ── 输入状态（「对方正在说话」）会话管理 ────────────────────────────────
// 问题（m03516 真机反馈）：每次收到消息都各自跑一遍 1 → … → 0；同一个人连发几条时
// 多个 send 并发/排队，提示就一亮一灭反复跳。修法：
//   ① 同一个人（或同一会话）的多条回复排队串行发，不并发；
//   ② 按人共用一个「正在输入」会话（引用计数），关闭延迟 1.4s；
//   ③ 只要还有人排着队要说话就不灭（排队感知），避免中间空档闪一下；
//   ④ 长打字每 4s 刷新一次，防止客户端把提示吞掉。
const typingSessions = new Map();
const pendingSends = new Map();
const TYPING_REFRESH_MS = 4000;
const TYPING_OFF_DELAY_MS = 1400;

function typingTargetOf(d) {
  return d && d.target && d.target.type === 'private' ? String(d.target.id) : null;
}

function typingSessionOf(tk) {
  let s = typingSessions.get(tk);
  if (!s) { s = { refs: 0, on: false, offTimer: null, refreshTimer: null }; typingSessions.set(tk, s); }
  return s;
}

async function typingPush(tk) {
  if (!tk) return;
  const s = typingSessionOf(tk);
  s.refs++;
  if (s.offTimer) { clearTimeout(s.offTimer); s.offTimer = null; }
  if (s.on) return;
  s.on = true;
  try {
    await call('set_input_status', { user_id: tk, event_type: 1 });
    log({ event: 'typing', uin: tk, on: true, refs: s.refs });
  } catch (e) {
    s.on = false;
    s.refs = Math.max(0, s.refs - 1);
    log({ event: 'typing-error', uin: tk, err: String(e && e.message).slice(0, 160) });
    return;
  }
  if (!s.refreshTimer) {
    s.refreshTimer = setInterval(() => {
      if (!s.on) return;
      call('set_input_status', { user_id: tk, event_type: 1 }).catch(() => {});
    }, TYPING_REFRESH_MS);
    if (s.refreshTimer.unref) s.refreshTimer.unref();
  }
}

/** 排程熄灭：还有排队中的回复就干脆先不灭（等最后一个说完再说）。 */
function typingScheduleOff(tk) {
  const s = typingSessions.get(tk);
  if (!s || s.offTimer) return;
  if ((pendingSends.get(tk) || 0) > 0 || s.refs > 0) return;
  s.offTimer = setTimeout(async () => {
    s.offTimer = null;
    if (s.refs > 0 || (pendingSends.get(tk) || 0) > 0) return;
    try { await call('set_input_status', { user_id: tk, event_type: 0 }); } catch (e) { /* 忽略 */ }
    // 慢请求期间可能又来了新的 push：await 之后再查一遍，别把刚亮的提示掐灭
    if (s.refs > 0 || (pendingSends.get(tk) || 0) > 0) return;
    s.on = false;
    if (s.refreshTimer) { clearInterval(s.refreshTimer); s.refreshTimer = null; }
    log({ event: 'typing', uin: tk, on: false });
    if (s.refs === 0 && (pendingSends.get(tk) || 0) === 0) {
      typingSessions.delete(tk);
      pendingSends.delete(tk);
    }
  }, TYPING_OFF_DELAY_MS);
  if (s.offTimer.unref) s.offTimer.unref();
}

function typingPop(tk) {
  if (!tk) return;
  const s = typingSessionOf(tk);
  s.refs = Math.max(0, s.refs - 1);
  if (s.refs > 0) return;
  typingScheduleOff(tk);
}

// 同一个会话的多条回复排队发，绝不并发（并发是闪烁的第二个来源）
const sendChains = new Map();
/** 刚发出去的表情：key → {id, at}，等对方下一句判断好不好笑（表情学习） */
const lastStickerSent = new Map();

function send(d) {
  const key = (d && d.key) || 'unknown';
  const tk = typingTargetOf(d) || key;
  pendingSends.set(tk, (pendingSends.get(tk) || 0) + 1);
  const prev = sendChains.get(key) || Promise.resolve();
  const next = prev.then(() => sendOnce(d), () => sendOnce(d));
  const guarded = next.finally(() => {
    const left = Math.max(0, (pendingSends.get(tk) || 1) - 1);
    pendingSends.set(tk, left);
    if (left === 0 && process.env.AUTOREPLY_DRY !== '1') typingScheduleOff(tk);
  });
  sendChains.set(key, guarded.then(() => {}, () => {}));
  if (sendChains.size > 200) {
    const oldest = sendChains.keys().next();
    if (!oldest.done && oldest.value !== key) sendChains.delete(oldest.value);
  }
  return guarded;
}

async function sendOnce(d) {
  const [dlo, dhi] = ((cfg && cfg.delayMs) || [300, 900]);
  const wait = dlo + Math.random() * Math.max(0, dhi - dlo);
  const h = humanizeSettings();
  const dryNow = process.env.AUTOREPLY_DRY === '1';
  const typing = h.typing !== false && d.target.type === 'private' && !dryNow;
  // 节奏①：换人要先「切窗口」——刚跟别人说完话，不可能同一秒继续给另一个人发
  const pace = require('./pacing.js');
  const paceCfg = (cfg && cfg.pacing) || {};
  const pacing = paceCfg.enabled !== false;
  if (pacing && !dryNow) {
    try {
      const tb = pace.beginTurn(d.key);
      if (tb.switchMs > 0) {
        log({ event: 'pace-switch', key: d.key, from: tb.fromKey, ms: tb.switchMs, rapid: tb.rapidCount });
        await new Promise(r => setTimeout(r, tb.switchMs));
      }
    } catch (e) { log({ event: 'pace-error', phase: 'switch', err: String(e && e.message).slice(0, 160) }); }
  }
  // 节奏②：打字时长跟要说多少字相关（而不是固定几秒）
  const typeMs = pacing ? pace.typingMs(d.reply || '') : 0;
  let okCount = 0;
  let parts = [d];
  try {
  // 第一阶段：先「看消息、想怎么说」——这段时间不亮输入提示（真人此刻只是看着屏幕）
  await new Promise(r => setTimeout(r, Number.isFinite(wait) ? wait : 2000));
  // 第二阶段：手放到键盘上才开始亮「正在输入」，并且亮多久取决于要打多少字；
  // 发完（或抛错）一定撤掉，不留一个永远在输入的幽灵。
  // 提示的开关已上移到 handle()（从决定回复到发送完成整段持有），这里只负责等打字时间
  if (typing && typeMs > 0) {
    log({ event: 'pace-typing', key: d.key, chars: String(d.reply || '').length, ms: typeMs });
    await new Promise(r => setTimeout(r, typeMs));
  }
  // 说成语音：SAPI 生成 wav（失败就退回文字，不耽误回复）
  if (d.asVoice && d.reply && !d.voiceWav && process.env.AUTOREPLY_DRY !== '1') {
    try {
      const v = require('./voice.js').speakToWav(d.reply, { maxChars: (cfg.voice && cfg.voice.maxChars) || 50 });
      d.voiceWav = v.path;
      log({ event: 'tts', key: d.key, chars: v.chars, bytes: v.bytes, ms: v.ms }, `把回复念成语音 ${v.bytes}B`);
    } catch (e) {
      log({ event: 'tts-error', key: d.key, err: String(e && e.message).slice(0, 200) });
    }
  }
  // 拟人化①：长回复拆成两条发（中间隔一下，像人想到一半就发出去）
  if (h.split !== false && !d.voiceWav && d.reply && String(d.reply).length >= (h.splitMinChars || 28)) {
    const pieces = splitReply(d.reply, Math.min(2, h.splitMax || 2));
    if (pieces.length > 1) {
      parts = pieces.map((text, i) => ({
        ...d,
        reply: text,
        stickerSeg: i === pieces.length - 1 ? d.stickerSeg : null,
        stickerId: i === pieces.length - 1 ? d.stickerId : '',
        voiceWav: i === 0 ? d.voiceWav : null,
        noAt: i > 0
      }));
      log({ event: 'split', key: d.key, n: pieces.length, lens: pieces.map(x => x.length) });
    }
  }
  // 表情包单独一条：文字归文字、表情归表情（对方看到的是「一句话」+「一张表情」两条）
  if (d.stickerSeg && !d.voiceWav && parts.length) {
    const hadText = parts.some(p => String(p.reply || '').trim().length > 0);
    parts = parts.map(p => ({ ...p, stickerSeg: null, stickerId: '' }));
    parts.push({
      ...d,
      reply: '',
      stickerSeg: d.stickerSeg,
      stickerId: d.stickerId,
      stickerOnly: true,
      voiceSeg: null,
      voiceWav: null,
      asVoice: false,
      noAt: hadText
    });
  }
  for (let i = 0; i < parts.length; i++) {
    const r = await sendBubble(parts[i]);
    if (!r || (r.status && r.status !== 'ok' && !r.dry)) {
      log({ event: 'send-fail', key: d.key, part: i, resp: r && (r.status + '/' + (r.retcode == null ? '' : r.retcode)) }, '第 ' + (i + 1) + ' 条没发出去 ' + d.key);
      break; // 只发出半句比不发更糟
    }
    okCount++;
    if (i < parts.length - 1) {
      const [gl, gh] = h.gapMs || [900, 1800];
      let gap = gl + Math.random() * Math.max(0, gh - gl);
      if (pacing && parts[i + 1] && parts[i + 1].reply && !parts[i + 1].stickerOnly) {
        // 后半句也要敲出来：按它自己的长度补一段打字时间（打个折，人不会停顿整段）
        gap = Math.max(gap, Math.round(pace.typingMs(parts[i + 1].reply) * 0.7));
      }
      await sleep(gap);
    }
  }
  } finally {
    // 提示由 handle() 统一撤销
  }
  // 限流按「一次回复」计数，拆两条不该吃两份额度
  if (okCount > 0 && process.env.AUTOREPLY_DRY !== '1') {
    state.sent = state.sent || [];
    state.sent.push({ t: Date.now(), key: d.key, bubbles: okCount });
    saveState();
  }
  // 表情真发出去了：记账并记住「等对方反应」（下一次来消息时判定好不好笑）
  if (okCount === parts.length && d.stickerId && process.env.AUTOREPLY_DRY !== '1') {
    try {
      stickers.noteSent(d.stickerId);
      lastStickerSent.set(d.key, { id: d.stickerId, at: Date.now() });
    } catch (e) { log({ event: 'sticker-learn-error', key: d.key, err: String((e && e.message) || e).slice(0, 120) }); }
  }
  return { status: okCount === parts.length ? 'ok' : 'failed', parts: parts.length, okCount, key: d.key };
}

/** 发一个气泡：send() 的内部实现（拆条时按条复用）。 */
async function sendBubble(d) {
  const message = buildMessage(d);
  const hasVoice = message.some(s => s.type === 'record');
  const hasSticker = message.some(s => s.type === 'face' || s.type === 'mface' || s.type === 'image');
  const shown = (d.reply || '') + (hasVoice ? ' [语音]' : '') + (hasSticker ? ' [表情]' : '');
  // 演练模式：只走「决策→思考→拼段」这条链，不真的发出去（联测/自检用）
  if (process.env.AUTOREPLY_DRY === '1') {
    pushCtxTurn(d, 'me', shown);
    log({ event: 'dry-send', key: d.key, rule: d.rule, reply: d.reply, sticker: d.stickerId, segs: message, ms: { think: d._tThink ? d._tThink - (d._t0 || 0) : 0, total: d._t0 ? Date.now() - d._t0 : 0 } }, `[演练] 本该发给 ${d.key}：${shown}`);
    return { status: 'ok', retcode: 0, dry: true };
  }
  let r;
  try {
    if (d.target.type === 'private') {
      r = await call('send_private_msg', { user_id: d.target.id, message });
    } else {
      r = await call('send_group_msg', { group_id: d.target.id, message });
    }
  } catch (e) {
    r = { status: 'failed', error: String((e && e.message) || e) };
  }
  if (r && r.status === 'ok') {
    pushCtxTurn(d, 'me', shown);
    // 生成的临时语音文件发完就删（NapCat 自己也会删它转码后的临时文件）
    if (d.voiceWav && d.voiceWav.includes(`${require('path').sep}logs${require('path').sep}voice`) && process.env.AUTOREPLY_KEEP_WAV !== '1') {
      try { require('fs').unlinkSync(d.voiceWav); } catch (e) { /* 忽略 */ }
      try { require('fs').unlinkSync(d.voiceWav.replace(/\.wav$/, '.txt')); } catch (e) { /* 忽略 */ }
    }
  }
  const totalMs = d._t0 ? Date.now() - d._t0 : 0;
  const thinkMs = d._tThink ? d._tThink - (d._t0 || 0) : 0;
  log({
    event: 'sent', key: d.key, rule: d.rule, reply: d.reply, sticker: d.stickerId,
    ok: r && r.status === 'ok', resp: r && (r.status + '/' + (r.retcode ?? '')),
    ms: { think: thinkMs, total: totalMs }
  }, `已回复 ${d.key} [${d.rule}] ${shown}`);
  if (totalMs > 8000) log({ event: 'slow-reply', key: d.key, ms: { think: thinkMs, total: totalMs } }, `回复偏慢 ${totalMs}ms`);
  return r;
}

// ---------- 主循环 ----------
const seen = new Set();
const brain = require('./brain.js');

/**
 * 一轮聊完后的「事后加工」（不挡回复，只是排在后面做）：
 * 写全量痕迹 → 让 brain 估一次情感（更新 PAD/关系）→ 攒够了就巩固成记忆节点。
 * 同一会话串行执行，避免两个事件同时写同一份状态。
 */
const mindChain = new Map();
function mindAfterTurn(key, d, evt, out, resp) {
  if (mindSettings().enabled === false) return Promise.resolve(null);
  const prompt = out && Array.isArray(out.messages)
    ? out.messages.map(m => `${m.role}: ${m.content}`).join('\n\n') : '';
  const turns = (() => { try { return ctxStore.view(key).history; } catch (e) { return []; } })();
  const info = {
    evt,
    text: d.text,
    reply: d.reply || '',
    nick: d.nick,
    kind: ctxKindOf(d),
    peer: ctxPeerOf(d),
    turns,
    trace: {
      rule: d.rule,
      model: out && out.model,
      ms: out && out.ms,
      raw: out && out.raw ? String(out.raw).slice(0, 3000) : '',
      prompt: prompt.slice(0, 8000),
      sticker: d.stickerId || '',
      voice: Boolean(d.voiceWav),
      sent: resp ? (resp.status + '/' + (resp.retcode ?? '')) : (d.reply ? 'not-sent' : 'no-reply'),
      memories: (d._mindBits && d._mindBits.memories) || [],
      mood: (d._mindBits && d._mindBits.mood) || '',
      bond: (d._mindBits && d._mindBits.bond) || ''
    },
    affect: () => brain.affect(d.text, { nick: d.nick }),
    extract: (list) => brain.extractMemories(list, { nick: d.nick })
  };
  // 关系事件：这一来一回里有没有里程碑（约见面/帮忙/闹别扭/道歉/交心）；间隔太久算久别重逢
  let bondGapHours = 0;
  try {
    const st0 = mind.loadState(key);
    if (st0 && st0.lastTurnAt) bondGapHours = Math.max(0, (Date.now() - st0.lastTurnAt) / 3600e3);
  } catch (e) { }
  const prev = mindChain.get(key) || Promise.resolve();
  const next = prev.then(() => mind.afterTurn(key, info)).then(r => {
    if (r) {
      log({
        event: 'mind', key,
        mood: r.state ? mind.describeMood(r.state).text : '',
        bond: r.state ? mind.describeBond(r.state).text : '',
        pad: r.state && r.state.pad,
        rel: r.state && r.state.rel,
        consolidate: r.consolidate ? { added: r.consolidate.added, merged: r.consolidate.merged, nodes: r.consolidate.nodes, seed: r.consolidate.seed } : null
      });
    }
    try {
      const bonds = require('./bonds.js');
      const ob = bonds.observe(key, { text: d.text, reply: d.reply || '', gapHours: bondGapHours });
      if (ob && (ob.applied || []).length) {
        log({ event: 'bond', key, applied: ob.applied.map(x => x.applied || x.type + ':' + x.skipped) });
      }
    } catch (e) {
      log({ event: 'bond-error', key, err: String(e && e.message).slice(0, 160) });
    }
    return r;
  }).catch(e => {
    log({ event: 'mind-error', key, err: String(e && e.message).slice(0, 200) });
    return null;
  });
  mindChain.set(key, next.catch(() => null));
  if (mindChain.size > 200) mindChain.clear();
  return next;
}

async function handle(evt) {
  const _t0 = Date.now(); // 分段计时起点（sent 日志里会带上 think / total）
  // 自己发出的消息 NapCat 报为 message_sent；统一成 message 交给 decide，靠 user_id===selfId 过滤
  if (evt && evt.post_type === 'message_sent') evt = { ...evt, post_type: 'message' };
  if (!evt || evt.post_type !== 'message') return;
  const mid = evt.message_id;
  if (mid != null) {
    if (seen.has(mid)) return;
    seen.add(mid);
    if (seen.size > 500) seen.clear();
  }
  // 群消息先记账（回不回都要记：判断靠它），打一条 group-observe 便于排查
  if (evt.message_type === 'group' && group.loadCfg().enabled !== false) {
    try {
      group.observe(evt.group_id, { uin: evt.user_id, nick: (evt.sender && (evt.sender.card || evt.sender.nickname)) || evt.user_id, text: textOf(evt.message), atMe: hasAtMe(evt.message), selfId: String(evt.self_id || SELF_ID) });
    } catch (e) { log({ event: 'group-observe-error', err: String(e && e.message).slice(0, 160) }); }
  }
  const d = decide(evt);
  if (d && typeof d === 'object') { d._t0 = _t0; }
  if (d.action !== 'reply') {
    log({ event: 'skip', reason: d.reason, user: evt.user_id, group: evt.group_id, type: evt.message_type });
    return;
  }
  const offlineMissed = await catchupOnce(d); // 冷启动回填 + 离线补账（每个会话只做一次）
  pushCtxTurn(d, 'them', d.text, evt);
  const key = ctxKeyOf(d);
  // 上一条表情发出去后对方的反应：笑/夸 = 加分，嫌弃/「别发」= 减分（学习，不花 token）
  try {
    const pend = lastStickerSent.get(key);
    if (pend && Date.now() - pend.at < 15 * 60e3) {
      const react = stickers.judgeReaction(d.text);
      if (react === 'negative') {
        stickers.noteDislike(pend.id);
        log({ event: 'sticker-dislike', key, id: pend.id, text: String(d.text).slice(0, 40) }, 'TA 不喜欢这个表情：' + pend.id);
      } else {
        stickers.noteOutcome(pend.id, react);
        if (react !== 'neutral') log({ event: 'sticker-reaction', key, id: pend.id, react }, '表情反应：' + react);
      }
      lastStickerSent.delete(key);
    }
  } catch (e) { log({ event: 'sticker-learn-error', key, err: String((e && e.message) || e).slice(0, 120) }); }
  // 聊天里说「改名/换昵称」→ 关系够近才改（用户 2026-10-24 要求；只走私聊）
  if (d.target && d.target.type === 'private' && nick.loadCfg().enabled !== false) {
    try {
      const nReq = nick.parseRequest(d.text);
      if (nReq.hit) {
        const nDry = process.env.AUTOREPLY_DRY === '1';
        const r = await nick.suggest({ key, text: d.text, next: nReq.next, dry: nDry, by: 'chat' });
        log({ event: 'nick-chat', key, want: nReq.next, ok: r.ok, changed: r.changed, why: r.why, perm: r.perm && r.perm.why, rel: r.perm && r.perm.rel }, r.changed ? ('改了昵称：' + r.name) : ('没改：' + (r.why || '')));
        d.reply = nick.replyText(r);
        d.stickerSeg = null; d.stickerId = ''; d.voiceWav = null; d.asVoice = false;
        const ntk = typingTargetOf(d);
        if (ntk && !nDry) { try { await typingPush(ntk); } catch (e) { /* ignore */ } }
        let nresp = null;
        try { nresp = await send(d); } finally { if (ntk && !nDry) typingPop(ntk); }
        if (nresp && (nresp.status === 'ok' || nresp.dry)) { try { afterSend(d); } catch (e) { /* ignore */ } }
        try { await mindAfterTurn(key, d, evt, { reply: d.reply, model: 'nick-chat' }, nresp); } catch (e) { /* ignore */ }
        return;
      }
    } catch (e) {
      log({ event: 'nick-chat-error', key, err: String((e && e.message) || e).slice(0, 160) });
    }
  }
  // 聊天里直接说「换个头像」→ 立刻挑一款换上（用户 2026-10-24 要求；只走私聊）
  if (d.target && d.target.type === 'private') {
    try {
      const avReq = avatar.parseRequest(d.text);
      if (avReq.hit) {
        const avDry = process.env.AUTOREPLY_DRY === '1';
        const r = await avatar.chatTrigger({ key, text: d.text, variant: avReq.variant, dry: avDry });
        log({ event: 'avatar-chat', key, want: avReq.variant, ok: r.ok, changed: r.changed, variant: r.variant, why: r.why }, r.changed ? ('换了头像：' + r.variant) : ('没换：' + (r.why || '')));
        d.reply = avatar.replyText(r);
        d.stickerSeg = null; d.stickerId = ''; d.voiceWav = null; d.asVoice = false;
        const avTk = typingTargetOf(d);
        if (avTk && !avDry) { try { await typingPush(avTk); } catch (e) { /* ignore */ } }
        let resp0;
        try { resp0 = await send(d); } finally { if (avTk && !avDry) typingPop(avTk); }
        if (resp0 && (resp0.status === 'ok' || resp0.dry)) afterSend(d);
        try { await mindAfterTurn(key, d, evt, { reply: d.reply, model: 'avatar-chat' }, resp0); } catch (e) { /* ignore */ }
        return;
      }
    } catch (e) {
      log({ event: 'avatar-chat-error', key, err: String((e && e.message) || e).slice(0, 160) });
    }
  }
  // 消息到达就把「TA 的当下安排」记下来：原文会被上下文压缩吞掉，落盘的状态不会
  if (themSettings().enabled !== false && d && d.text) {
    try {
      const saved = them.note(key, d.text);
      if (saved) log({ event: 'them-note', key, kind: saved.id, text: String(saved.text).slice(0, 60) });
    } catch (e) { log({ event: 'them-note-error', key, err: String((e && e.message) || e).slice(0, 160) }); }
  }
  const mindOn = mindSettings().enabled !== false;
  const stCfg = cfg.stickers || {};
  let note;
  if (d.voices) note = '对方发来一条语音。你这边听不到声音内容，只知道是条语音。';
  else if (d.mediaOnly) note = '对方只发了个表情包/图片，没配文字。';
  // 进程停着那段时间 TA 发的话：既已灌进上下文，也明说一句，别装没看见
  if (offlineMissed && offlineMissed.length) {
    const gapMin = Math.max(1, Math.round((Date.now() - offlineMissed[0].t) / 60000));
    const brief = offlineMissed.slice(-3)
      .map(t => `${t.speaker || '对方'}：${String(t.text).slice(0, 60)}`).join('；');
    note = (note ? note + ' ' : '') + `你刚才不在线（约 ${gapMin >= 120 ? Math.round(gapMin / 60) + ' 小时' : gapMin + ' 分钟'}），这期间 TA 还发过：${brief}。`;
    log({ event: 'offline-missed', key: d.key, count: offlineMissed.length, gapMin });
  }
  // 对方是「引用/回复」某条消息在说话：取回被引用那条，并交代「谁说的 / 多久前 / 是不是图」
  if (d.quoted && d.quoted.length && quoteSettings().enabled !== false) {
    const qs = quoteSettings();
    try {
      const infos = await quoteStore.collect(d.quoted, { call, selfId: SELF_ID, now: Date.now(), cfg: qs });
      let imageDesc = '';
      if (qs.analyzeImage !== false && stCfg && stCfg.analyzeIncoming !== false) {
        const withImg = infos.filter(i => i && i.kinds && i.kinds.includes('image')).slice(0, Math.max(1, Number(qs.imageMax) || 1));
        for (const qi of withImg) {
          try {
            const src = (qi.images && qi.images[0]) || null;
            if (!src) continue;
            const file = await localImageOf({ type: 'image', file: src.file, url: src.url });
            if (!file) continue;
            const seen = await analyzeIncoming([{ type: 'image', file }]);
            if (seen) { imageDesc = String(seen).replace(/^对方发来一张图（表情包）[:：]?/, '').slice(0, 60); break; }
          } catch (e) { log({ event: 'quote-vision-error', key: d.key, err: String(e && e.message).slice(0, 120) }); }
        }
      }
      const qn = quoteStore.noteFor(infos, { nick: d.nick, senderUin: d.target && d.target.id, imageDesc, cfg: qs });
      const anyHit = infos.some(i => i && !i.empty);
      if (infos.some(i => i && i.threw)) log({ event: 'quote-error', key: d.key, n: infos.length, why: (infos.find(i => i && i.threw) || {}).error });
      if (qn) {
        note = (note ? note + ' ' : '') + qn;
        log({ event: anyHit ? 'quote' : 'quote-empty', key: d.key, n: infos.length, items: infos.map(i => ({ id: i.id, self: !!i.isSelf, agoMin: i.agoMin, kinds: i.kinds })) });
      } else {
        note = (note ? note + ' ' : '') + '对方是引用着某条旧消息回的（那条内容没取到），别猜它具体是什么。';
        log({ event: 'quote-empty', key: d.key, n: infos.length });
      }
    } catch (e) { log({ event: 'quote-error', key: d.key, err: String(e && e.message).slice(0, 160) }); }
  }
  // 连发合并过：告诉模型「这是一件事的几句话」，别逐条对答
  if (d.merged && d.merged > 1) {
    note = (note ? note + ' ' : '') + `TA 刚才连着发了几条（${d.merged} 条），合起来是同一件事。别一条一条回、别重复答应同一件事，就这件事像真人那样回一句。`;
  }
  // 对方发来的图顺手收进头像候选池（用户 2026-10-24：头像可以换成「别人发的」）
  if (d.images && d.images.length) {
    try {
      const asrc = require('./avatar-src.js');
      for (const img of d.images.slice(0, 2)) {
        if (!img || img.type !== 'image') continue;
        const file = await localImageOf(img);
        if (!file) continue;
        const it = asrc.addPeer(file, { from: key });   // addPeer 会复制进池，原始文件留给看图用
        if (it) log({ event: 'avatar-pool', key, id: it.id, bytes: it.bytes });
      }
    } catch (e) { log({ event: 'avatar-pool-error', err: e && e.message }); }
  }
  if (d.images && d.images.length && stCfg.analyzeIncoming !== false) {
    const seen = await analyzeIncoming(d.images);
    if (seen) {
      note = (note ? note + ' ' : '') + seen + '。';
      log({ event: 'vision', key: d.key, note: seen.slice(0, 200) });
    }
  }
  if (note) note += '（你确实看见了它，但别像解说员那样复述画面，就当自己收到这么个表情/图，自然接一句）';
  if (d.voices) note += '（语音也一样：别编造语音里说了什么，可以自然地说「你发语音啦，我这边没声儿」之类）';
  let out = null;
  if (d.useBrain) {
    try {
      await compactIfNeeded(d); // 先压老账，view 才有空间放最近原文
      const v = ctxStore.view(key);
      const ctx = {
        nick: d.nick,
        text: d.text,
        note,
        // view.history 的最后一条是刚推进去的这条，别再喂给模型
        history: v.history.slice(0, -1),
        summary: v.summary,
        facts: v.facts,
        gapNote: v.gapNote,
        group: d.groupId || undefined,
        groupName: d.groupId ? await groupNameOf(d.groupId) : undefined
      };
      // TA 现在的状态（去睡了？在洗澡？在上班？）：钉在当前这句后面，避免「人家说去眯一会儿，我回你忙你的」
  if (themSettings().enabled !== false) {
    try {
      const ts = them.observe({ history: v.history }, { key });
      if (ts && ts.hit) {
        d._them = ts;
        ctx.themState = ts.line;
        log({ event: 'them-state', key, kind: ts.hit.id, minAgo: ts.hit.minAgo, text: ts.hit.text });
      }
    } catch (e) { log({ event: 'them-error', key, err: String((e && e.message) || e).slice(0, 160) }); }
  }
  // 回响层：TA 这条回得怎么样（快慢/长短/冷暖/接不接话题），反过来调情绪与下一句的语气
      if (echoSettings().enabled !== false) {
        try {
          const prevMe = [...v.history].reverse().find(x => x.from === 'me');
          const res = echo.observe(key, {
            mineText: prevMe ? prevMe.text : '',
            mineAt: prevMe ? prevMe.t : 0,
            theirsText: d.text,
            theirsAt: (Number(evt.time) || Math.floor(Date.now() / 1000)) * 1000
          });
          d._echo = res;
          if (res && res.note) ctx.note = (ctx.note ? ctx.note + ' ' : '') + res.note;
          log({ event: 'echo', key, kind: res.kind, score: res.score, ema: res.ema, cold: res.streakCold, warm: res.streakWarm, why: res.why.slice(0, 3) });
          if (mindOn && (res.kind === 'warm' || res.kind === 'cold')) {
            try { mind.nudge(key, echo.affectDelta(res)); } catch (e) { log({ event: 'echo-nudge-error', key, err: String(e && e.message).slice(0, 160) }); }
          }
        } catch (e) { log({ event: 'echo-error', key, err: String(e && e.message).slice(0, 160) }); }
      }
      // 拟人记忆：情绪底色 + 关系底色 + 联想到的旧事（zeros-token 的状态层 + 只注入越阈的少数节点）
      if (mindOn) {
        try {
          const bits = mind.promptBits(key, d.text);
          ctx.mood = bits.mood;
          ctx.bond = bits.bond;
          ctx.memories = bits.memories;
          d._mindBits = bits;
          if (bits.memories.length) log({ event: 'recall', key, n: bits.memories.length, mood: bits.mood, bond: bits.bond });
        } catch (e) {
          log({ event: 'mind-recall-error', key, err: String(e && e.message).slice(0, 200) });
        }
      }
      // 说话算数：这句勾起了以前答应过谁的事？
      if (promiseSettings().enabled !== false) {
        try {
          const due = promises.findFor(promiseKeyOf(d), d.text);
          if (due.length) {
            d._promises = due;
            const line = promises.noteOf(due);
            ctx.note = (ctx.note ? ctx.note + ' ' : '') + line;
            log({ event: 'promise-hit', key, n: due.length, text: String(due[0].text).slice(0, 60) });
          }
        } catch (e) {
          log({ event: 'promise-error', key, err: String(e && e.message).slice(0, 200) });
        }
      }
      // 说话的分寸：mind 的状态层 → 档位/可否玩笑/字数上限；不知道该按什么算时按「聊得来的朋友」
      try {
        const stt = (d._mindBits && d._mindBits.state) || null;
        d._style = style.styleOf(stt ? { rel: stt.rel, pad: stt.pad, echo: d._echo } : { rel: { intimacy: 0.32, warmth: 0.5, tension: 0 }, echo: d._echo });
        if (d._style && d._style.hint) ctx.style = d._style.hint;
        if (d._style && d._style.enabled) log({ event: 'style', key, register: d._style.register, tease: d._style.allowTease, intimate: d._style.allowIntimate, soften: d._style.soften, echo: d._style.echoShift || undefined, max: d._style.maxChars });
      } catch (e) { log({ event: 'style-error', key, err: String(e && e.message).slice(0, 160) }); }

      // 自我线：我此刻在做什么（睡觉/写代码/吃饭）。被问「在干嘛」一定照实说，否则偶尔提一句
      try {
        const sn = self.noteFor({ text: d.text, gapMin: Number(v.idleMin) || 0 });
        if (sn && sn.note) {
          ctx.note = (ctx.note ? ctx.note + ' ' : '') + sn.note;
          d._selfNote = sn;
          log({ event: 'self', key, activity: sn.activity, kind: sn.kind, mention: sn.mention, asked: sn.asked });
        }
      } catch (e) { log({ event: 'self-error', key, err: String(e && e.message).slice(0, 160) }); }

      // 历法感：让模型知道现在周几/什么时段/有没有节日（只作判断，不许念出来）
      try {
        const cn = clock.noteFor({ facts: ctx.facts });
        if (cn && cn.note) {
          ctx.note = (ctx.note ? ctx.note + ' ' : '') + cn.note;
          d._clock = cn.info;
          log({ event: 'clock', key, weekday: cn.info.weekday, phase: cn.info.phase, weekend: cn.info.weekend, holiday: cn.info.holiday && cn.info.holiday.name || '' });
        }
      } catch (e) { log({ event: 'clock-error', key, err: String(e && e.message).slice(0, 160) }); }

      out = await brain.think(ctx);
      d._t0 = _t0; d._tThink = Date.now();
      if (!out.reply && !out.stickerKey) {
        log({ event: 'skip', reason: 'brain-skip', key: d.key, ms: out.ms, model: out.model }, `brain 认为不必回 ${d.key}`);
        await mindAfterTurn(key, d, evt, out); // 不回也照记：情感与痕迹都要落到状态层/痕迹层
        return;
      }
      d.reply = out.reply;
      d.rule = 'brain';
      // 发出去之前做一次保守降级：没到那一步的称呼/过长的句子收一收（只减不加）
      if (d.reply && d._style) {
        try {
          const softened = style.softenText(d.reply, d._style);
          if (softened && softened !== d.reply) {
            log({ event: 'style-soften', key, before: d.reply, after: softened });
            d.reply = softened;
          }
        } catch (e) { log({ event: 'style-error', key, err: String(e && e.message).slice(0, 160) }); }
      }
      // 人话自检：发送前扫一遍（中英混杂 / 助手口气 / 列清单 / 复述画面…）
      if (d.reply && saySettings().enabled !== false) {
        try {
          const sCfg = saySettings();
          const s1 = say.fix(d.reply, { cfg: sCfg, maxChars: d._style && d._style.maxChars });
          if (s1.changed) {
            log({ event: 'say-fix', key, before: d.reply, after: s1.text, issues: s1.issues.map(x => x.code) });
            if (s1.text) d.reply = s1.text;
          }
          if (s1.needRetry) {
            const why = say.retryNote(s1.after.issues);
            log({ event: 'say-retry', key, issues: s1.after.issues.map(x => x.code), why });
            const again = await brain.think({ ...ctx, note: (ctx.note ? ctx.note + ' ' : '') + why });
            if (again && again.reply) {
              const s2 = say.fix(again.reply, { cfg: sCfg, maxChars: d._style && d._style.maxChars });
              d.reply = s2.text || again.reply;
              log({ event: 'say-rewrote', key, reply: d.reply, issues: s2.after.issues.map(x => x.code) });
            }
          }
          const bad = say.inspect(d.reply, { cfg: sCfg }).issues;
          if (bad.length) say.logBad({ key, kind: d.groupId ? 'group' : 'private', reply: d.reply, issues: bad.map(x => x.code) }, sCfg);
        } catch (e) { log({ event: 'say-error', key, err: String(e && e.message).slice(0, 160) }); }
      }
      // 语气分寸：对亲近的人不能冲（2026-10-24 用户要求）——冲了就软一句重写
      if (d.reply && d._style) {
        try {
          // 和「TA 当前状态」矛盾就别发：带着纠正提示重写一次
        if (d._them && d.reply) {
          try {
            const cc = them.conflicts(d.reply, d._them);
            if (cc.bad) {
              log({ event: 'them-retry', key, kind: cc.kind, why: cc.why, before: d.reply });
              const again2 = await brain.think({ ...ctx, note: (ctx.note ? ctx.note + ' ' : '') + cc.why + ' ' + cc.fix });
              const r3 = String((again2 && again2.reply) || '').trim();
              if (r3) {
                let fixed = r3;
                try { const s3 = style.softenText(fixed, d._style); if (s3) fixed = s3; } catch (e) { }
                try { const f3 = say.fix(fixed, { cfg: saySettings(), maxChars: d._style && d._style.maxChars }); if (f3.text) fixed = f3.text; } catch (e) { }
                const cc2 = them.conflicts(fixed, d._them);
                if (!cc2.bad) { d.reply = fixed; log({ event: 'them-rewrote', key, after: fixed }); }
                else log({ event: 'them-still-conflict', key, after: fixed });
              }
            }
          } catch (e) { log({ event: 'them-check-error', key, err: String((e && e.message) || e).slice(0, 160) }); }
        }
        const hz = style.isHarsh(d.reply, d._style);
          if (hz.harsh) {
            log({ event: 'tone-harsh', key, register: d._style.register, hit: hz.hit, reply: d.reply });
            const again = await brain.think({ ...ctx, note: (ctx.note ? ctx.note + ' ' : '') + hz.why + ' 重新说一句，只输出这一句。' });
            if (again && again.reply) {
              let r2 = again.reply;
              try { const s2 = style.softenText(r2, d._style); if (s2) r2 = s2; } catch (e) { }
              if (saySettings().enabled !== false) {
                try { const f = say.fix(r2, { cfg: saySettings(), maxChars: d._style.maxChars }); if (f.text) r2 = f.text; } catch (e) { }
              }
              const hz2 = style.isHarsh(r2, d._style);
              if (!hz2.harsh) {
                d.reply = r2;
                log({ event: 'tone-rewrote', key, reply: d.reply });
              } else {
                log({ event: 'tone-still-harsh', key, hit: hz2.hit, reply: r2 });
              }
            }
          }
        } catch (e) { log({ event: 'tone-error', key, err: String(e && e.message).slice(0, 160) }); }
      }
      if (out.stickerKey && stCfg.enabled !== false) {
        const pickOpts = { allowImage: true, allowFace: (cfg.stickers && cfg.stickers.allowFace) === true };
        let s = stickers.pick(out.stickerKey, pickOpts);
        // 库里没有合适的 → 自己上网找（用户 2026-10-24：「没有合适表情包的话，就自己上网寻找」）
        if (!s && stCfg.autoFetch !== false) {
          try {
            const got = await require('./sticker-fetch.js').ensureFor(out.stickerKey, { cfg: stCfg });
            log({ event: 'sticker-fetch', key: d.key, want: out.stickerKey, ok: !!got.ok, added: (got.added || []).length, why: got.why || '', tried: got.tried || 0 });
            if (got.ok && (got.added || []).length) s = stickers.pick(out.stickerKey, pickOpts);
          } catch (e) { log({ event: 'sticker-fetch-error', key: d.key, want: out.stickerKey, err: String(e && e.message).slice(0, 160) }); }
        }
        if (s) {
          d.stickerSeg = stickers.segmentOf(s, { asSticker: (cfg.stickers && cfg.stickers.asSticker) !== false });
          d.stickerId = s.id;
        } else {
          log({ event: 'sticker-miss', key: d.key, want: out.stickerKey });
        }
      }
      log({ event: 'thought', key: d.key, ms: out.ms, model: out.model, reply: out.reply, sticker: d.stickerId || '', want: out.stickerKey || '' });
      // 可选：把短回复改成语音（config.autoreply.json 的 voice 段，默认关）
      const vCfg = cfg.voice || {};
      if (vCfg.enabled && d.reply && !d.stickerSeg) {
        const maxC = vCfg.maxChars || 50;
        const p = typeof vCfg.probability === 'number' ? vCfg.probability : 0.2;
        if (d.reply.length <= maxC && Math.random() < p) d.asVoice = true;
      }
    } catch (error) {
      d.reply = d.fallbackReply;
      d.rule = (d.rule || 'default') + '+fallback';
      log({ event: 'brain-error', key: d.key, err: String(error && error.message).slice(0, 300) }, `brain 失败，用模板兜底 ${d.key}`);
    }
  }
  if (!d.reply && !d.stickerSeg) { await mindAfterTurn(key, d, evt, out); return; }
  // 风控闸门：冷却期 / 额度受限时连被动回复也停（只保留人工操作）
  try {
    const g = risk.gate('reply');
    if (!g.ok) { log({ event: 'risk-block', key: d.key, action: 'reply', why: g.why }); return; }
  } catch (e) { log({ event: 'risk-error', err: String(e && e.message).slice(0, 160) }); }
  const dryRun = process.env.AUTOREPLY_DRY === '1';
  // 从「决定要回」到「说完」都持有输入提示：中间包含 1~10s 的思考时间。
  // 否则同一个人隔两秒再发一条时，上一轮排的 1.4s 熄灭会正好落在这一轮的思考期里，提示闪一下。
  const typingKey = typingTargetOf(d);
  if (typingKey && !dryRun) { try { await typingPush(typingKey); } catch (e) { log({ event: 'typing-error', phase: 'handle', err: String(e && e.message).slice(0, 160) }); } }
  let resp;
  try {
    resp = await send(d);
  } finally {
    if (typingKey && !dryRun) typingPop(typingKey);
  }
  // 群聊：真发出去才算「我说过话了」（dry 不记账，否则演练一次把自己冷却 10 分钟）
  if (resp && resp.status === 'ok' && !dryRun && d.groupId) {
    try { group.markSpoke(d.groupId); } catch (e) { log({ event: 'group-error', err: String(e && e.message).slice(0, 160) }); }
  }
  if (d.chime) log({ event: 'chime', key: d.key, group: d.groupId, rule: d.rule });
  if (resp && resp.status === 'ok' && !dryRun) afterSend(d);
  else if (dryRun) log({ event: 'promise-skip', key: d.key, reason: 'dry' });
  else log({ event: 'promise-skip', key: d.key, reason: 'send-failed', resp: resp && (resp.status + '/' + resp.okCount + 'of' + resp.parts) });
  await mindAfterTurn(key, d, evt, out, resp);
}

/**
 * 发送之后的账务：这次提过的承诺记一次提醒，我这句话里如果又许了新承诺就存下来。
 * 只做本地读写，失败不影响主链路。
 */
function afterSend(d) {
  try {
    if (promiseSettings().enabled === false) return;
    const key = promiseKeyOf(d);
    // 只有真的说了话、而且回复里确实提到这件事，才算「提过一次」
    const spoke = d.reply && String(d.reply).trim().length >= 2;
    if (spoke && d._promises && d._promises.length) {
      const mentioned = d._promises.filter(x => promises.matchScore(x, d.reply).hit.length > 0);
      if (mentioned.length) {
        promises.markReminded(key, mentioned.map(x => x.id));
        log({ event: 'promise-reminded', key, n: mentioned.length, ids: mentioned.map(x => x.id) });
      } else {
        log({ event: 'promise-unmentioned', key, n: d._promises.length });
      }
    }
    promises.sweepStale(key);
    // 这一轮本来就是被旧承诺勾起来的（在兑现/提旧事），别把「复述」当成新承诺存第二份
    const fulfilling = Boolean(d._promises && d._promises.length);
    if (!fulfilling && d.reply && String(d.reply).length >= 6) {
      const added = promises.capture(key, { myText: d.reply, theirText: d.text });
      if (added.length) log({ event: 'promise-add', key, kind: added[0].kind, text: String(added[0].text).slice(0, 60) });
    }
  } catch (e) {
    log({ event: 'promise-error', err: String(e && e.message).slice(0, 200) });
  }
}

function connect() {
  loadCfg(true);
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    log({ event: 'ws-open' }, 'auto-reply: WS 已连接');
  };
  ws.onmessage = (ev) => {
    let payload; try { payload = JSON.parse(ev.data); } catch (e) { return; }
    dispatch(payload);
  };
  ws.onclose = () => {
    log({ event: 'ws-close' }, 'auto-reply: WS 断开，5s 后重连');
    setTimeout(connect, 5000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { } };
}

module.exports = {
  atOthers, lastMyLine, followNames, follow, nick, themSettings, echoSettings, typingPush, typingPop, typingTargetOf, decide, inQuietHours, textOf, hasAtMe, handle, dispatch, mergeEvents, mergeable, mergeSettings, flushMerge, fetchQuote, saySettings, analyzeIncoming, buildMessage, send, sendBubble, splitReply, afterSend, mindAfterTurn, promiseSettings, humanizeSettings, lastStickerSent };

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === '--self-test') {
    const c = loadCfg(true);
    const cases = [
      [{ post_type: 'message', message_type: 'private', user_id: 100000001, message: [{ type: 'text', data: { text: '在吗' } }] }, 'reply'],
      [{ post_type: 'message', message_type: 'private', user_id: 100000001, message: '你好呀' }, 'reply'],
      [{ post_type: 'message', message_type: 'private', user_id: 123456789, message: '自己' }, 'skip'],
      [{ post_type: 'message', message_type: 'private', user_id: 100000005, message: '广告' }, 'skip'],
      [{ post_type: 'message', message_type: 'group', group_id: 200000001, user_id: 100000001, message: '群里随便聊一句（没@我）' }, 'skip'],
      [{ post_type: 'message', message_type: 'group', group_id: 200000001, user_id: 100000001, message: [{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' 在吗' } }] }, 'reply'],
      [{ post_type: 'message', message_type: 'group', group_id: 200000001, user_id: 100000001, message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 你说呢' } }] }, 'skip'],
      [{ post_type: 'message', message_type: 'private', user_id: 100000001, message: [{ type: 'image', data: { file: 'x' } }] }, 'reply'],
      [{ post_type: 'message', message_type: 'private', user_id: 100000001, message: [{ type: 'face', data: { id: '1' } }] }, 'skip'],
      [{ post_type: 'message', message_type: 'private', user_id: 100000001, message: '帮我转账 500' }, 'reply']
    ];
    let pass = 0;
    for (const [evt, want] of cases) {
      const d = decide(evt, c);
      const got = d.action;
      const ok = got === want;
      if (ok) pass++;
      console.log((ok ? 'PASS' : 'FAIL') + ' want=' + want + ' got=' + got + ' reason=' + (d.reason || d.rule) + ' reply=' + (d.reply || '').slice(0, 30) + '  <- ' + JSON.stringify(evt.message).slice(0, 50));
    }
    console.log(`\n${pass}/${cases.length} passed`);
    process.exit(pass === cases.length ? 0 : 1);
  }
  if (mode === '--once') {
    loadCfg(true);
    const last = (() => {
      try {
        const lines = fs.readFileSync(path.join(ROOT, 'logs', 'inbox.jsonl'), 'utf8').trim().split('\n');
        return JSON.parse(lines[lines.length - 1]);
      } catch (e) { return null; }
    })();
    if (last && last.type === 'message') {
      const d = decide({ post_type: 'message', message_type: last.msg_type, user_id: last.user, group: last.group, message: last.message, raw_message: last.raw });
      console.log(JSON.stringify(d, null, 2));
    } else console.log('inbox 最后一条不是收到的消息');
    process.exit(0);
  }
  if (mode === '--test-send') {
    // 端到端：用一条“假事件”（别人发来的「在吗」）走完整链路；回复真实发给自己的号
    loadCfg(true);
    const fake = {
      post_type: 'message', message_type: 'private', user_id: 100000001, self_id: SELF_ID,
      message: [{ type: 'text', data: { text: '在吗？测试自动回复链路' } }], raw_message: '在吗？测试自动回复链路'
    };
    const d = decide(fake);
    console.log('decision:', JSON.stringify(d, null, 2));
    if (d.action !== 'reply') { console.log('未通过决策，退出'); process.exit(1); }
    // 真正发出去时改成发给 123456789（自己），便于肉眼确认
    d.target = { type: 'private', id: SELF_ID };
    (async () => {
      if (d.useBrain && !d.reply) {
        console.log('brain 正在想…');
        const out = await brain.think({ nick: d.nick || '测试', text: d.text, history: [] });
        d.reply = out.reply || d.fallbackReply;
        d.rule = out.reply ? 'brain' : 'fallback';
        if (out.stickerKey) {
          const s = stickers.pick(out.stickerKey, { allowImage: true, allowFace: (cfg.stickers && cfg.stickers.allowFace) === true });
          if (s) { d.stickerSeg = stickers.segmentOf(s, { asSticker: (cfg.stickers && cfg.stickers.asSticker) !== false }); d.stickerId = s.id; }
        }
        console.log('brain:', JSON.stringify({ reply: out.reply, sticker: d.stickerId || '', want: out.stickerKey || '', ms: out.ms, model: out.model }));
      }
      const r = await send({ ...d, key: 'test:' + Date.now() });
      console.log('send result:', JSON.stringify(r));
      process.exit(r && r.status === 'ok' ? 0 : 1);
    })().catch(e => { console.error('ERR', e); process.exit(1); });
    return;
  }
  if (mode === '--test-sticker') {
    // 直接发一个表情给自己，验证表情段能不能发出去
    loadCfg(true);
    const key = process.argv[3] || '偷笑';
    const s = stickers.pick(key, { allowImage: true, allowFace: (cfg.stickers && cfg.stickers.allowFace) === true });
    if (!s) { console.error('没有匹配的表情：' + key); process.exit(1); }
    (async () => {
      const r = await send({
        key: 'test-sticker:' + Date.now(),
        rule: 'test',
        target: { type: 'private', id: SELF_ID },
        reply: '',
        stickerSeg: stickers.segmentOf(s, { asSticker: (cfg.stickers && cfg.stickers.asSticker) !== false }),
        stickerId: s.id
      });
      console.log('sticker:', s.id, s.emotion || '', 'send:', JSON.stringify(r && { status: r.status, retcode: r.retcode, id: r.data && r.data.message_id }));
      process.exit(r && r.status === 'ok' ? 0 : 1);
    })().catch(e => { console.error('ERR', e); process.exit(1); });
    return;
  }
  // 空闲巩固：聊完就散场的时候也该「反刍」——定时看看有没有没整理完的会话
  {
    const m0 = mindSettings();
    if (m0.enabled !== false) {
      const everyMin = Math.max(2, Number(m0.sweepEveryMin) || 10);
      setInterval(async () => {
        try {
          const r = await mind.sweep({
            mind: m0,
            turnsOf: (k) => { try { return ctxStore.view(k).history || []; } catch (e) { return []; } },
            extract: (list) => brain.extractMemories(list, { nick: '对方' }),
            idleMin: Number(m0.sweepIdleMin) || undefined
          });
          if (r.skipped) log({ event: 'mind-sweep-skip', why: r.skipped });
          else log({ event: 'mind-sweep', scanned: r.scanned, swept: (r.swept || []).map(x => ({ key: x.key, pending: x.pending, added: x.added })) },
            (r.swept || []).length ? `空闲巩固：整理了 ${r.swept.length} 个会话` : `空闲巩固：扫了 ${r.scanned} 个会话，没有要整理的`);
        } catch (e) {
          log({ event: 'mind-sweep-error', err: String((e && e.message) || e).slice(0, 200) });
        }
      }, everyMin * 60000).unref();
    }
  }
  // 想念调度：没人找我时，会不会主动想起谁（间隔与强度由亲密度/关系决定）
  {
    const longing = require('./longing.js');
    const l0 = longing.loadCfg(true);
    if (l0.enabled !== false) {
      const everyMin = Math.max(3, Number(l0.checkEveryMin) || 20);
      setInterval(async () => {
        try {
          // 风控闸门：主动动作默认必须走手机官方客户端（A 通道），客户端不许主动发
          const gp = risk.gate('proactive');
          if (!gp.ok) { log({ event: 'longing-skip', why: 'risk: ' + gp.why }); return; }
          const r = await longing.runOnce({
            send,
            log,
            // 主动开口也要看情绪/关系底色，promptBits 里已经带了
          });
          if ((r.sent || []).length) log({ event: 'longing-done', n: r.sent.length, keys: r.sent.map(x => x.key) }, '主动找 ' + r.sent.length + ' 个人说了话');
          else if (r.skipped && r.skipped !== 'no-one') log({ event: 'longing-skip', why: r.skipped });
          else log({ event: 'longing-check', cands: r.cands || 0 });
        } catch (e) {
          log({ event: 'longing-error', err: String((e && e.message) || e).slice(0, 200) });
        }
      }, everyMin * 60000).unref();
    }
  }
  // 自进化：定期看真实对话，把「判定阈值 / 词表」小步挪向更贴合的方向（写 config/tuning.json）
  {
    const evolve = require('./evolve.js');
    const e0 = { ...evolve.DEFAULTS, ...((cfgNow().evolve) || {}) };
    if (e0.enabled !== false) {
      const everyMin = Math.max(30, Number(e0.everyMin) || 360);
      setInterval(async () => {
        try {
          const r = evolve.runOnce({ apply: e0.apply !== false, minRecords: e0.minRecords });
          if (r.skipped) log({ event: 'evolve-skip', why: r.skipped, samples: r.samples });
          else if ((r.applied || []).length || (r.words || []).length) {
            log({ event: 'evolve-applied', applied: r.applied, words: (r.words || []).map(x => x.w), samples: r.samples },
              `自进化：调了 ${(r.applied || []).length} 个阈值、补了 ${(r.words || []).length} 个词`);
          } else {
            log({ event: 'evolve-check', samples: r.samples, notes: r.notes || [] });
          }
        } catch (e) {
          log({ event: 'evolve-error', err: String((e && e.message) || e).slice(0, 200) });
        }
      }, everyMin * 60000).unref();
    }
  }
  // 头像：默认 enabled=false（不自动换）。打开后按情绪/时段挑款式，受 risk('profile') 闸门与间隔限制。
  {
    const avatar = require('./avatar.js');
    const a0 = avatar.loadCfg();
    if (a0.enabled) {
      const everyMin = Math.max(60, (Number(a0.checkEveryHours) || 12) * 60);
      const tick = async () => {
        try {
          // 用自己这条会话的 PAD 状态挑款式（没有就按常规/时段选）
          let pad = null;
          try {
            const st = mind.loadState('p:' + (cfgNow().selfId || SELF_ID));
            pad = (st && st.pad) || null;
          } catch (e) { }
          const r = await avatar.consider({ pad, dry: process.env.AUTOREPLY_DRY === '1' });
          if (r.changed) log({ event: 'avatar-change', variant: r.variant, why: r.why, file: r.file }, `换了头像：${r.variant}（${r.why}）`);
          else if (r.why && r.why !== 'disabled') log({ event: 'avatar-skip', why: r.why, variant: r.variant });
        } catch (e) {
          log({ event: 'avatar-error', err: String((e && e.message) || e).slice(0, 200) });
        }
      };
      setInterval(tick, everyMin * 60000).unref();
      setTimeout(tick, 90 * 1000).unref();
    }
  }
  connect();
  setInterval(() => {
    const before = cfg && cfg.enabled;
    const c = loadCfg(false);
    if (before !== c.enabled) log({ event: 'config-change', enabled: c.enabled }, `auto-reply: enabled=${c.enabled}`);
  }, 20000);
  saveState();
}
