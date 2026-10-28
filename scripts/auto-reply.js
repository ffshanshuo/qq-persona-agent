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
const persona = require('./persona.js');
const autonomy = require('./autonomy.js');
const selfwrite = require('./selfwrite.js');
const selfmod = require('./selfmod.js');
const echo = require('./echo.js');
const mode = require('./mode.js'); // 思维模式（这轮该先接情绪 / 给建议 / 讲原理 / 一句带过）
const risk = require('./risk.js'); // 风控闸门：冷却期/额度受限时禁止发送
const group = require('./group.js');
const self = require('./self.js');
const clock = require('./clock.js');
const say = require('./say.js');
const them = require('./them.js');
const timeline = require('./timeline.js'); // 时间线（从时间戳算「去洗澡→洗完了 约 10 分钟」） // 人话自检（发送前扫中英混杂/助手口气/列清单/复述画面） // 历法感（今天周几/节日/时段） // 自我线（我也有自己的事在忙） // 群聊在场感（该不该插话） // 说话的分寸（关系/心情 → 尺度）
const promises = require('./promises.js');
const watch = require('./watch.js'); // 反复盯着消息看：话头悬着没人接时自己决定要不要追问
const mind = require('./mind.js');
const follow = require('./follow.js'); // 群聊被 @ 之后，接着那几句话继续听
const nick = require('./nick.js'); // 聊天里改昵称（只听关系够近的人）；currentNames 也给群聊跟随用
const quoteStore = require('./quote.js');
const forwardStore = require('./forward.js'); // 引用消息：取回被引用那条 + 谁说的/多久前/有没有图
const ties = require('./ties.js'); // 关系类型（陌生人/朋友/恋人/前任）+ 恋人唯一性 + 冷战分手复合
const intercepts = require('./intercepts.js'); // 聊天里「直接执行」类指令（换头像 / 改昵称），不过模型
const timers = require('./timers.js'); // 四个后台定时器（巩固 / 想念 / 自进化 / 头像）

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
  const forwards = Array.isArray(evt.message) ? evt.message.filter(x => x && x.type === 'forward').map(x => x.data && x.data.id).filter(Boolean).map(String) : [];
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
  // 既没文字也没图也没语音也没有合并转发：红包/系统/未知段，不回
  if (!text && !media && !voices && !forwards.length) return { action: 'skip', reason: 'no-text' };
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
    // 2026-10-27 用户要求删掉固定回复：没有模板就不兜模板（brain 失败另有重投逻辑）
    if (!fallback) fallback = c.defaultReply || '';
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
    text: text || (forwards.length ? '[发来一条聊天记录（合并转发）]' : (voices ? '[发来一条语音]' : '[只发了一个表情包/图片，没配文字]')),
    mediaOnly: !text,
    voices,
    images,
    forwards,
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
const BUSY_DEFAULTS = { enabled: false, kinds: ['focus'], delayMin: [2, 9], urgentRe: '急|在吗|在不在|电话|马上|现在就|救命|快回', maxTracked: 500 };
function busySettings() { return { ...BUSY_DEFAULTS, ...((cfgNow().busy) || {}) }; }

function humanizeSettings() {
  return { ...HUMANIZE_DEFAULTS, ...((cfg && cfg.humanize) || {}) };
}
// 连发多条（2026-10-26 用户要求）：真人常常「一句一句蹦」，还会文字夹语音夹表情
const BURST_DEFAULTS = { enabled: true, max: 4, gapMs: [500, 1200], marker: '[[分条]]' };
function burstSettings() {
  return { ...BURST_DEFAULTS, ...((cfg && cfg.burst) || {}) };
}
const SPLIT_MARK = /(?:\[\[\s*(?:分条|换条|下一条|另起一条)\s*\]\]|【\s*分条\s*】|\[\[>>>\]\])/g;
const BUBBLE_VOICE = /(?:\[\[|［［|【|\[|［)\s*(?:语音|voice|发语音|朗读)\s*(?:\]\]|］］|\】|\]|］)/gi;
/**
 * 把一条回复拆成多个气泡。只有模型显式写了 [[分条]] 才拆（避免把正常段落拆碎）。
 * 每个气泡末尾的 [[语音]] 只作用于它自己那一句。
 * @returns {Array<{text:string, voice:boolean}>}
 */
function parseBurst(text, opts) {
  const o = { ...BURST_DEFAULTS, ...(opts || {}) };
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return [];
  const segs = raw.split(SPLIT_MARK).map((x) => x.trim()).filter(Boolean);
  const max = Math.max(1, Math.min(8, Number(o.max) || 4));
  const out = [];
  for (const seg of segs) {
    const voice = BUBBLE_VOICE.test(seg);
    BUBBLE_VOICE.lastIndex = 0;
    const clean = seg.replace(BUBBLE_VOICE, '').replace(/[ \t]{2,}/g, ' ').trim();
    if (!clean && !voice) continue;
    out.push({ text: clean, voice });
  }
  if (!out.length) return [];
  if (o.enabled === false) return [{ text: out.map((x) => x.text).filter(Boolean).join(' '), voice: out.some((x) => x.voice) }];
  if (out.length > max) {
    // 超出的并进最后一条，别刷屏
    const head = out.slice(0, max - 1);
    const tail = out.slice(max - 1);
    head.push({
      text: tail.map((x) => x.text).filter(Boolean).join(' '),
      voice: tail.some((x) => x.voice)
    });
    return head;
  }
  return out;
}
// 碎话：对方只发「嗯」「哦」「？」时，直接回一句短的，不过模型
function murmurSettings() {
  return { ...require('./murmur.js').DEFAULTS, ...((cfg && cfg.murmur) || {}) };
}const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
function tieSettings() { return { ...ties.DEFAULTS, ...((cfgNow().ties) || {}) }; }
function timelineSettings() { return { ...timeline.DEFAULTS, ...((cfgNow().timeline) || {}) }; }

function saySettings() { return { ...say.DEFAULTS, ...((cfgNow().say) || {}) }; }
function echoSettings() { return { ...echo.DEFAULTS, ...((cfgNow().echo) || {}) }; }
function modeSettings() { return { ...mode.DEFAULTS, ...((cfgNow().mode) || {}) }; }
function personaSettings() { return { ...persona.DEFAULTS, ...((cfgNow().persona) || {}) }; }

function watchSettings() { return { ...((cfgNow().watch) || {}) }; }

/**
 * 话头悬着没人接 → 自己去追问一句
 * item 来自 watch.due()：{kind:'my-q'|'their-q', text, idleMin}
 * 只在真发成功才记账；dry 与失败都不记（否则演练一次就把这轮追问吃掉）
 */
async function sendWatchFollowUp(key, item, opts) {
  const o = opts || {};
  const dry = o.dry != null ? !!o.dry : (process.env.AUTOREPLY_DRY === '1');
  if (String(key || '').startsWith('g:')) return { ok: false, why: 'group-not-supported' };
  try {
    const gate = risk.gate('proactive');
    if (!gate.ok) { log({ event: 'watch-skip', key, why: 'risk: ' + gate.why }); return { ok: false, why: 'risk' }; }
  } catch (e) { }
  let v;
  try { v = ctxStore.view(key); } catch (e) { v = { history: [] }; }
  const kindOf = (item && item.kind) || 'my-q';
  const said = String((item && item.text) || '').slice(0, 80);
  const idleMin = Number(item && item.idleMin) || null;
  const peer = String(key || '').replace(/^p:/, '');
  const nick = (v.history || []).filter(h => h.from !== 'me').slice(-1).map(h => h.speaker)[0] || '对方';
  const instruction = kindOf === 'my-q'
    ? '你之前问过 TA 一句「' + said + '」，到现在' + (idleMin ? '（' + idleMin + ' 分钟）' : '') + '都没回你。' +
      '现在你自己惦记起这件事了：可以再问一句、换个更轻的说法、或者干脆不提（说点别的）。' +
      '别质问、别说「你怎么不回我」、别催、别说「在吗」、别解释自己在等；只输出这一句，觉得这会儿不该说就输出 [SKIP]。'
    : 'TA 之前问过你一句「' + said + '」，然后就没下文了。' +
      '你现在可以先把那句答上（哪怕只说一半），或者问问 TA 到底什么意思。别装作没看见，也别长篇大论；只输出这一句，觉得没什么可说的就输出 [SKIP]。';
  const ctx = {
    nick, kind: 'private', history: v.history || [], summary: v.summary || '', facts: v.facts || [],
    gapNote: v.gapNote || '', note: instruction, watchFollow: { kind: kindOf, said, idleMin }
  };
  let out = null;
  try { out = await brain.think(ctx); } catch (e) {
    log({ event: 'watch-brain-error', key, err: String((e && e.message) || e).slice(0, 160) });
    return { ok: false, why: 'brain-error' };
  }
  const reply = out && (out.reply || '').trim();
  if (!reply && !(out && out.stickerKey)) {
    log({ event: 'watch-skip', key, why: 'model-skip', kind: kindOf });
    if (!dry) watch.markFollowed(key, item, { why: 'model-skip' });
    return { ok: false, why: 'model-skip' };
  }
  const d = {
    key, rule: 'watch', nick,
    target: { type: 'private', id: peer },
    reply, stickerKey: (out && out.stickerKey) || '', replyAhead: false
  };
  let resp = null;
  try { resp = await send(d); } catch (e) {
    log({ event: 'watch-send-error', key, err: String((e && e.message) || e).slice(0, 160) });
    return { ok: false, why: 'send-error' };
  }
  const okSent = !!(resp && (resp.status === 'ok' || resp.dry));
  if (okSent && !dry) watch.markFollowed(key, item, { why: 'sent' });
  log({ event: okSent ? 'watch-out' : 'watch-send-failed', key, kind: kindOf, idleMin, chars: reply.length, dry });
  return { ok: okSent, dry, kind: kindOf, chars: reply.length };
}
function selfmodSettings() { return { ...selfmod.loadCfg(), ...((cfgNow().selfmod) || {}) }; }
function selfwriteSettings() { return { ...selfwrite.loadCfg(), ...((cfgNow().selfwrite) || {}) }; }
function autonomySettings() { return { ...autonomy.loadCfg(), ...((cfgNow().autonomy) || {}) }; }
function forwardSettings() { return { ...forwardStore.DEFAULTS, ...((cfgNow().forward) || {}) }; }

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
    peer: ctxPeerOf(d),
    // real_seq 才是真序号（事件里的 message_seq 恒等于 message_id，不能用来引用）
    seq: evt && evt.real_seq != null ? String(evt.real_seq) : (evt && evt.message_seq != null && String(evt.message_seq) !== String(evt.message_id) ? String(evt.message_seq) : null)
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
      const animated = /\.(gif|webp)$/i.test(String(local || ''));
      if (animated && typeof vision.describeAnimation === 'function') {
        // 动图：拆帧 + 多帧视觉，才能看出「在做什么动作」（2026-10-25 需求）
        const a = await vision.describeAnimation(local);
        const m = a.meta || {};
        const extra = [m.n_frames ? m.n_frames + ' 帧' : '', m.interval_ms ? '约 ' + m.interval_ms + 'ms/帧' : '', m.loops ? '循环' : ''].filter(Boolean).join('，');
        notes.push(`对方发来一个动图表情包${extra ? '（' + extra + '）' : ''}${a.motion ? '：' + a.motion : ''}${a.emotion ? '（情绪：' + a.emotion + '）' : ''}`);
      } else {
        const vf = stickers.visionFile(local);
        const r = await vision.describeImage(vf);
        notes.push(`对方发来一张图（${r.type}）：${r.desc}`);
      }
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
  // 主动引用：说清楚「我在接的是哪一条」（NapCat 出站 reply 段，seq 优先于 id）
  if (d.quoteSeq && d.target && d.target.type !== 'group') segs.push({ type: 'reply', data: { seq: String(d.quoteSeq) } });
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
// 真忙时先搁着的消息（message_id → 记下时间），防止同一条被重复排期
const busyDeferred = new Map();
// brain 全挂时的重投（只重投一次，再失败就静默——用户不要「我在的，刚看到」这类模板）
const retryDeferred = new Map();
const REPLY_RETRY_MS = Number(process.env.AUTOREPLY_RETRY_MS) || 75000;
// 上一轮用的是哪种「想」法：等对方回话后，用 TA 的反应回头修这一档的深度偏好
const lastMode = new Map();

function send(d) {
  // 最后一道防线：任何路径（含 say-retry / tone-retry / them-retry 的重写结果）里残留的
  // [表情:xxx] 标记都不许进聊天框——2026-10-24 真事故就是把标记原样发给了对方。
  if (d && typeof d.reply === 'string' && d.reply) {
    try {
      const cleaned = require('./brain.js').stripMarkers(d.reply);
      if (cleaned !== d.reply) {
        log({ event: 'marker-stripped', key: d.key, before: d.reply.slice(0, 80), after: cleaned.slice(0, 80) });
        d.reply = cleaned;
      }
    } catch (e) { /* 剥不了也不能拦住发送 */ }
  }
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
  // 热聊模式：一旦聊起来了就是秒回，不额外拖时间（用户 2026-10-27 要求）
  const hc = (cfg && cfg.hotChat) || {};
  const [dlo, dhi] = d._hotChat && hc.fastDelayMs
    ? hc.fastDelayMs
    : ((cfg && cfg.delayMs) || [300, 900]);
  // 自主权：模型可以用 [[慢点回]] / [[很快回]] 覆盖这一档（上限由 autonomy policy 钳）
  const wait = Number.isFinite(d.delayOverrideMs)
    ? Math.max(0, d.delayOverrideMs)
    : dlo + Math.random() * Math.max(0, dhi - dlo);
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
  // 模型自己挑了语气（[[语气:温柔]]）就整轮沿用它，不让规则再替它决定
  if (d.tone) parts.forEach((p) => { p._tone = d.tone; });
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
  // ---- 连发多条：模型在句间写 [[分条]] 就拆成几条发；每条可单独带 [[语音]] ----
  const burst = burstSettings();
  const bubbles = parseBurst(d.reply, burst);
  parts = bubbles.length
    ? bubbles.map((b, i) => ({
        ...d,
        reply: b.text,
        stickerSeg: null,
        stickerId: '',
        voiceWav: null,
        noAt: i > 0,
        asVoice: !!(b.voice || (bubbles.length === 1 && d.asVoice))
      }))
    : [{ ...d }];
  // 只有一条气泡时，沿用「长回复自动拆两条」
  if (parts.length === 1 && h.split !== false && !d.asVoice && d.reply && String(d.reply).length >= (h.splitMinChars || 28)) {
    const pieces = splitReply(d.reply, Math.min(2, h.splitMax || 2));
    if (pieces.length > 1) {
      parts = pieces.map((text, i) => ({ ...d, reply: text, voiceWav: null, asVoice: false, noAt: i > 0 }));
      log({ event: 'split', key: d.key, n: pieces.length, lens: pieces.map((x) => x.length) });
    }
  }
  // 语音总开关先落实：choice=off / enabled=false 时，气泡级 [[语音]] 也不该生效
  const voiceOn = (() => {
    const vc = (cfgNow().voice || {});
    return vc.enabled !== false && (vc.choice || 'model') !== 'off';
  })();
  if (!voiceOn) {
    for (const piece of parts) piece.asVoice = false;
  }
  if (parts.length > 1) {
    log({
      event: 'burst', key: d.key, n: parts.length,
      lens: parts.map((x) => String(x.reply || '').length),
      voice: parts.filter((x) => x.asVoice).length
    });
  }
  // 每个要「说出口」的气泡单独合成（语音只覆盖它自己那一句，其它仍是文字）
  if (!dryNow) {
    for (const piece of parts) {
      if (!piece.asVoice || !piece.reply || piece.voiceWav) continue;
      try {
        const V = require('./voice.js');
        const sig = piece._voiceSignals || {};
        const modelTone = piece._tone || piece.tone || d.tone || null;
        const pr = (modelTone && V.prosody.byTone(modelTone)) || V.prosody.prosodyFor({
          mood: sig.mood, pad: sig.pad, mode: sig.mode, echo: sig.echo, tie: sig.tie,
          hour: new Date().getHours()
        });
        if (modelTone) log({ event: 'tone-choice', key: d.key, tone: pr.tone, want: modelTone, by: pr.by || 'model' });
        const vp = V.prosody.voiceFor({ tone: pr.tone, cfg: (cfg.voice || {}), random: Math.random }) || { voice: null, why: 'no-voice-pick' };
        const _vm = Number(cfg.voice && cfg.voice.maxChars);
        const v = V.synth(piece.reply, { maxChars: Number.isFinite(_vm) && _vm > 0 ? _vm : 0, prosody: pr, voice: vp.voice });
        piece.voiceWav = v.path;
        log({ event: 'voice-prosody', key: d.key, tone: pr.tone, rate: pr.rate, pitch: pr.pitch, volume: pr.volume, why: pr.why, voice: vp.voice, voiceWhy: vp.why });
        log({ event: 'tts', key: d.key, chars: v.chars, bytes: v.bytes, ms: v.ms, provider: v.provider, voice: v.voice || '', tone: pr.tone, estSec: v.estSec || 0, fellBack: v.fellBack || '' }, `把回复念成语音 ${v.bytes}B（${pr.tone}）`);
      } catch (e) {
        log({ event: 'tts-error', key: d.key, err: String(e && e.message).slice(0, 200) });
        piece.asVoice = false; // 合成失败就退回文字，别发空气泡
      }
    }
  }
  // 表情包单独一条：文字归文字、表情归表情（对方看到的是「一句话」+「一张表情」两条）
  if (d.stickerSeg && parts.length) {
    const hadText = parts.some((x) => String(x.reply || '').trim().length > 0);
    // 只留「真有内容的」气泡：模型只给了表情标记时 reply 是空串，
    // 空消息发出去 NapCat 会回 retcode 200，循环里 break，表情就永远发不掉了（2026-10-24 真事故）
    parts = parts.filter((x) => String(x.reply || '').trim().length > 0 || x.voiceWav || x.asVoice);
    parts.push({
      ...d,
      reply: '',
      stickerSeg: d.stickerSeg,
      stickerId: d.stickerId,
      stickerOnly: true,
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
  // 一个段都没有就别浪费一次 API：空消息在 NapCat 侧是 200/failed，还会把后面的气泡截断
  if (!message.length) {
    log({ event: 'empty-bubble', key: d.key, reply: d.reply || '' }, '这条拼出来是空的，跳过');
    return { status: 'ok', skipped: 'empty' };
  }
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

async function handle(evt, opts) {
  opts = opts || {};
  const _t0 = Date.now(); // 分段计时起点（sent 日志里会带上 think / total）
  // 每条消息进来先看一眼配置文件有没有被改过（loadCfg 内部按 mtime 判断，没变就直接返回缓存）
  loadCfg();
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
  // 合并转发：只给四个字「[合并转发]」等于没看见，得再调 get_forward_msg 把它拆开（用户 2026-10-24 要求）
  if (d.forwards && d.forwards.length) {
    const fsCfg = forwardSettings();
    if (fsCfg.enabled !== false) {
      try {
        const fw = await forwardStore.collect(d.forwards, { call, selfId: SELF_ID, now: Date.now(), cfg: fsCfg, nick: d.nick });
        if (fw.anyHit) {
          d.forwardNote = fw.note;
          d.forwardText = fw.items.map(it => forwardStore.briefOf(it, { cfg: fsCfg })).join(' ');
          log({ event: 'forward', key: ctxKeyOf(d), ids: d.forwards.length, total: fw.total, nested: fw.nested }, '展开合并转发 ' + fw.total + ' 条');
        } else {
          d.forwardNote = '对方转发了一条聊天记录，但内容没取到（可能过期或撤回了）——别猜里面写了什么，可以说一句「这条我这边打不开」。';
          log({ event: 'forward-empty', key: ctxKeyOf(d), ids: d.forwards.length, why: fw.why });
        }
      } catch (e) {
        log({ event: 'forward-error', key: ctxKeyOf(d), err: String((e && e.message) || e).slice(0, 160) });
      }
    }
  }
  pushCtxTurn(d, 'them', d.text + (d.forwardText ? ' ' + d.forwardText : ''), evt);
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
  // 聊天里一句话能直接执行的指令（换头像 / 改昵称）：听懂就做，不过模型（用户 2026-10-24 要求）
  // 只走私聊；识别/执行/回执在 intercepts.js，这里只负责发出去、记账、写进记忆。
  {
    const dry0 = process.env.AUTOREPLY_DRY === '1';
    const hit = await intercepts.tryRun(d, { key, dry: dry0, log, murmur: murmurSettings(), random: Math.random });
    if (hit) {
      d.reply = hit.reply;
      d.stickerSeg = null; d.stickerId = ''; d.voiceWav = null; d.asVoice = false;
      const itk = typingTargetOf(d);
      if (itk && !dry0) { try { await typingPush(itk); } catch (e) { /* ignore */ } }
      let iresp = null;
      try { iresp = await send(d); } finally { if (itk && !dry0) typingPop(itk); }
      if (iresp && (iresp.status === 'ok' || iresp.dry)) { try { afterSend(d); } catch (e) { /* ignore */ } }
      try { await mindAfterTurn(key, d, evt, { reply: d.reply, model: hit.model }, iresp); } catch (e) { /* ignore */ }
      return;
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
  if (d.forwardNote) {
    note = (note ? note + ' ' : '') + d.forwardNote;
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
  // 真忙就别秒回「我手上有事，晚点回你」——真人忙着的时候根本不回，等腾出手才看到消息。
  // 热聊判定：正聊着（距上一次来回 < hotChat.windowMin 分钟且已经聊过 hotChat.minTurns 轮）＝秒回，
  // 不排期、不「慢点回」、不加额外延迟。慢回只留给刚开场或对方明显在忙的时候。
  const hotNow = (() => {
    try {
      const hc = { enabled: true, windowMin: 10, minTurns: 6, ...((cfgNow().hotChat) || {}) };
      if (hc.enabled === false) return null;
      const v = ctxStore.view(key);
      const turns = (v.history || []).length;
      const idle = Number(v.idleMin);
      if (turns >= (Number(hc.minTurns) || 6) && Number.isFinite(idle) && idle <= (Number(hc.windowMin) || 10)) {
        return { cfg: hc, idleMin: idle, turns };
      }
    } catch (e) { /* 忽略 */ }
    return null;
  })();
  if (hotNow) { d._hotChat = true; log({ event: 'hot-chat', key, idleMin: hotNow.idleMin, turns: hotNow.turns }); }

  // 这里只做一件事：把这条消息往后放几分钟（日志 busy-defer），到点再走正常流程（模型照常想怎么回）。
  {
    const bz = busySettings();
    const dryNow = process.env.AUTOREPLY_DRY === '1';
    if (hotNow) { /* 正聊着就别排期 */ }
    else if (bz.enabled !== false && !dryNow && !opts.fromDefer) {
      let st = null;
      try { st = self.state(); } catch (e) { st = null; }
      const kind = st && st.kind;
      const urgentRe = bz.urgentRe ? new RegExp(bz.urgentRe) : null;
      const urgent = urgentRe ? urgentRe.test(d.text || '') : false;
      if (!urgent && kind && (Array.isArray(bz.kinds) ? bz.kinds : ['focus']).includes(kind)) {
        const mid = String((evt && evt.message_id) || '') || (d.key + ':' + (d.text || '').slice(0, 20));
        if (!busyDeferred.has(mid)) {
          const [lo, hi] = Array.isArray(bz.delayMin) ? bz.delayMin : [2, 9];
          const mins = lo + Math.random() * Math.max(0, hi - lo);
          const ms = Math.round(mins * 60000);
          busyDeferred.set(mid, Date.now());
          if (busyDeferred.size > (Number(bz.maxTracked) || 500)) {
            const oldest = busyDeferred.keys().next();
            if (!oldest.done) busyDeferred.delete(oldest.value);
          }
          log({ event: 'busy-defer', key, kind, activity: (st && st.activity) || '', mins: Math.round(mins * 10) / 10, urgent });
          setTimeout(() => {
            busyDeferred.delete(mid);
            // 同一条消息再来一次会被 message_id 去重挡掉，先把标记摘掉再走正常流程
            if (evt && evt.message_id != null) seen.delete(evt.message_id);
            handle(evt, { fromDefer: true }).catch((e) => log({ event: 'busy-defer-error', key, err: String((e && e.message) || e).slice(0, 160) }));
          }, ms).unref();
          return { deferred: true, key, mins: Math.round(mins * 10) / 10 };
        }
      }
    }
  }
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
  // 时间线：从时间戳里算「去洗澡→洗完了 约 10 分钟」这类常识，并留痕
  if (timelineSettings().enabled !== false) {
    try {
      const tl = timeline.noteFor(key);
      if (tl && tl.note) {
        ctx.timelineNote = tl.note;
        timeline.remember(key, tl.spans);
        log({ event: 'timeline', key, n: tl.spans.length, last: tl.spans[0] ? tl.spans[0].label + ' ' + tl.spans[0].minutes + 'min' : '' });
      }
    } catch (e) { log({ event: 'timeline-error', key, err: String((e && e.message) || e).slice(0, 160) }); }
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
          // 思维模式的反向调节：上一轮那个「想」法换来的是热还是冷，回头微调它的深度偏好
          try {
            const prev = lastMode.get(key);
            if (prev && prev.mode && (res.kind === 'warm' || res.kind === 'cold') && modeSettings().learnFromReaction !== false) {
              const lr = mode.learn(key, { mode: prev.mode, kind: res.kind }, modeSettings());
              log({ event: 'mode-learn', key, mode: prev.mode, kind: res.kind, bias: lr.bias, n: lr.n, good: lr.good, bad: lr.bad });
            }
          } catch (e) { log({ event: 'mode-learn-error', key, err: String((e && e.message) || e).slice(0, 160) }); }
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
          // 我自己刚说过的话也要在视野里（用户要求：回复时也看自己发过的消息）
          try {
            const full = (v && Array.isArray(v.history)) ? v.history : [];
            const mine = full.filter((h) => h && h.from === 'me' && h.text).slice(-3).map((h) => ({ t: h.t, text: h.text }));
            if (mine.length) { ctx.myRecent = mine; log({ event: 'my-recent', key, n: mine.length }); }
          } catch (e) { /* 忽略 */ }
          if (bits.memories.length) log({ event: 'recall', key, n: bits.memories.length, mood: bits.mood, bond: bits.bond });
        } catch (e) {
          log({ event: 'mind-recall-error', key, err: String(e && e.message).slice(0, 200) });
        }
      }
      // 关系类型：恋人/前任/冷战——只由「对方明确表达」推动，DSH 绝不自己宣布身份
      if (tieSettings().enabled !== false) {
        try {
          const stv = (d._mindBits && d._mindBits.state) || null;
          const tr = ties.observe(key, {
            text: d.text,
            rel: (stv && stv.rel) || {},
            uin: d.target && d.target.id,
            now: Date.now(),
            cfg: tieSettings()
          });
          d._tie = tr;
          if (tr.changed) log({ event: 'tie', key, from: tr.from, to: tr.to, why: tr.why }, `关系变了：${tr.from} → ${tr.to}`);
          if (tr.conflict) log({ event: 'ties-conflict', key, why: tr.why, note: tr.note });
          if (tr.note) ctx.tieNote = tr.note;
          if (tr.conflict && tr.note) ctx.note = (ctx.note ? ctx.note + ' ' : '') + tr.note;
        } catch (e) { log({ event: 'tie-error', key, err: String(e && e.message).slice(0, 160) }); }
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
        d._style = style.styleOf(stt ? { rel: stt.rel, pad: stt.pad, echo: d._echo, tie: ties.styleHint(key) } : { rel: { intimacy: 0.32, warmth: 0.5, tension: 0 }, echo: d._echo, tie: ties.styleHint(key) });
        if (d._style && d._style.hint) ctx.style = d._style.hint;
        try { ctx.habits = style.habitHint(key); } catch (e) { /* ignore */ }
        // 还有话头悬着（我问了 TA 没接）→ 顺口提一句，别硬提
        try {
          const wn = watch.noteFor(key, { history: (v && v.history) || [], now: Date.now(), cfg: watchSettings() });
          if (wn) { ctx.note = (ctx.note ? ctx.note + ' ' : '') + wn; log({ event: 'watch-note', key }); }
        } catch (e) { log({ event: 'watch-note-error', key, err: String((e && e.message) || e).slice(0, 120) }); }
        // 模型自己写下过什么（心情/印象/想做的事）：读回来给它自己看
        try {
          const sn = selfwrite.selfNotes(key, { max: 3 });
          if (sn && sn.length) { ctx.selfNotes = sn; log({ event: 'selfwrite-notes', key, n: sn.length, kinds: sn.map(x => x.label) }); }
        } catch (e) { /* ignore */ }
        // 说话风格：从满穗语料统计出来的句长/句尾/口癖倾向（缺统计文件时静默跳过）
        try {
          const pn = persona.note(null, personaSettings());
          if (pn && pn.hint) { ctx.personaNote = pn.hint; d._persona = { samples: pn.samples, why: pn.why }; log({ event: 'persona', key, samples: pn.samples, name: pn.name }); }
          // 它自己写的规矩：每轮都注入（条数少，开销可忽略）
          try { if (selfmodSettings().enabled !== false) { const ch = selfmod.readCharter(); if (ch) { ctx.charterNote = ch; log({ event: 'charter', key, lines: selfmod.parseCharter(ch).length }); } } } catch (e) { log({ event: 'charter-error', key, error: e && e.message }); }
        } catch (e) { log({ event: 'persona-error', key, err: String(e && e.message).slice(0, 160) }); }
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

      // 思维模式：这轮该「怎么想」（先接情绪 / 给可执行建议 / 讲清原理 / 一句带过），并按此给深度预算
      try {
        const mst = (d._mindBits && d._mindBits.state) || null;
        const md = mode.noteFor(key, {
          text: d.text, now: Date.now(),
          rel: (mst && mst.rel) || null, pad: (mst && mst.pad) || null, echo: d._echo
        }, modeSettings());
        d._mode = md;
        if (md && md.note) {
          const cm = md.budget && md.budget.maxChars ? `（大概别超过 ${md.budget.maxChars} 字）` : '';
          ctx.modeNote = md.note + cm;
        }
        if (md && md.budget && md.budget.maxTokens) ctx.maxTokens = md.budget.maxTokens;
        log({ event: 'mode', key, mode: md.mode, want: md.requested, why: md.why, bias: md.bias, tokens: md.budget && md.budget.maxTokens });
        lastMode.set(key, { mode: md.mode, at: Date.now(), maxTokens: md.budget && md.budget.maxTokens });
      } catch (e) { log({ event: 'mode-error', key, err: String((e && e.message) || e).slice(0, 160) }); }

      // 热聊：正聊着就秒回，别拖（用户 2026-10-27 要求）
      if (d._hotChat) ctx.note = (ctx.note ? ctx.note + ' ' : '') + '你们正聊着，接着回就行——别拖、别排期、别说「等下再说」。';
      // 你之前约好过一会儿要说的话：现在对方又发来消息，你可以当场决定还说不说
      try {
        const pend = autonomy.pendingPlans(key);
        if (pend.length) {
          const p0 = pend[pend.length - 1];
          const mins = Math.max(0, Math.round((p0.at - Date.now()) / 60000));
          ctx.note = (ctx.note ? ctx.note + ' ' : '') + `你之前打算 ${mins <= 0 ? '马上' : mins + ' 分钟后'}跟 TA 说：「${String(p0.text || '').slice(0, 80)}」。如果现在这几句已经让它没必要说了，就写 [[取消主动]]。`;
          log({ event: 'plan-hint', key, id: p0.id, mins });
        }
      } catch (e) { log({ event: 'plan-hint-error', key, err: String((e && e.message) || e).slice(0, 120) }); }
      out = await brain.think(ctx);
      d._t0 = _t0; d._tThink = Date.now();
      // 自我修改：模型在正文里写了 [[规则:…]] / [[自定:…]]，这里落盘（四道关：白名单/上下界/单次台阶/审计+可回滚）
      try {
        if (out && out.marks && out.marks.any) {
          const smr = selfmod.applyMarks(out.marks, { key, uin: d.target && d.target.id, by: 'model', dry: dryRun, reason: String(d.text || '').slice(0, 60) });
          log({ event: 'selfmod', key, rules: smr.rules.map(r => ({ key: r.key, ok: r.ok, why: r.why, to: r.to })), charter: smr.charter && smr.charter.applied, dry: dryRun });
        }
      } catch (e) { log({ event: 'selfmod-error', key, err: String((e && e.message) || e).slice(0, 160) }); }
      // ===== 自主权（第 1 阶段：反应式自主）=====
      // 模型提议、policy 审批：@我/问事/求助/催 → 不许不回；额度与冷却照旧
      if (out.skip) {
        let idleMin = null;
        try { idleMin = ctxStore.view(key).idleMin; } catch (e) { /* ignore */ }
        const sk = autonomy.decideSkip(key, d, { cfg: autonomySettings(), dry: process.env.AUTOREPLY_DRY === '1', idleMinutes: idleMin });
        if (sk.ok) {
          log({ event: 'autonomy-skip', key, text: String(d.text || '').slice(0, 40) }, '这次它选择先不接');
          await mindAfterTurn(key, d, evt, out);
          return;
        }
        log({ event: 'autonomy-skip-denied', key, why: sk.why });
      }
      if (out.cancelPlan) {
        try {
          const cp = autonomy.cancelPlans(key, { why: 'model-cancel', now: Date.now() });
          log({ event: 'plan-cancel', key, n: cp.n }, `撤掉了 ${cp.n} 条还没发出去的主动消息`);
        } catch (e) { log({ event: 'plan-cancel-error', key, err: String((e && e.message) || e).slice(0, 120) }); }
      }
      if (out.slow) {
        if (d._hotChat) log({ event: 'autonomy-slow-denied', key, why: 'hot-chat' });   // 正聊着就不许拖
        else {
          const sl = autonomy.decideSlow(key, { cfg: autonomySettings(), dry: process.env.AUTOREPLY_DRY === '1' });
          if (sl.ok) { d.delayOverrideMs = sl.ms; log({ event: 'autonomy-slow', key, ms: sl.ms }, `它想晚点回（${Math.round(sl.ms / 1000)} 秒）`); }
          else log({ event: 'autonomy-slow-denied', key, why: sl.why });
        }
      } else if (out.fast) {
        const fa = autonomy.decideFast({ key, cfg: autonomySettings(), dry: process.env.AUTOREPLY_DRY === '1' });
        d.delayOverrideMs = fa.ms;
        log({ event: 'autonomy-fast', key, ms: fa.ms });
      }
      if (out.quote) {
        const hasQuote = Array.isArray(d.quoted) && d.quoted.length > 0;
        const aq = autonomy.allowQuote(key, { cfg: autonomySettings(), dry: process.env.AUTOREPLY_DRY === '1', hasQuote });
        if (aq.ok) {
          try {
            const q = require('./quote.js').pickForQuote(key, { topic: d.text, cfg: quoteSettings() });
            if (q && q.seq) { d.quoteSeq = q.seq; d.quoteText = q.text; log({ event: 'autonomy-quote', key, seq: q.seq, why: q.why }, '它引了一句旧话'); }
          } catch (e) { log({ event: 'autonomy-quote-error', key, err: String((e && e.message) || e).slice(0, 160) }); }
        } else log({ event: 'autonomy-quote-denied', key, why: aq.why });
      }
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
      // 要不要「说」出来：默认由模型自己选（它在回复里写 [[语音]]），choice='random' 才回到掷骰子
      const vCfg = cfg.voice || {};
      const choice = String(vCfg.choice || 'model').toLowerCase();
      // 记下当轮的语气信号，等真正合成语音时（sendOnce 里）用来挑 rate/pitch/volume
      d._voiceSignals = {
        mood: ctx.mood || '',
        pad: (d._mindBits && d._mindBits.state && d._mindBits.state.pad) || null,
        mode: (d._mode && d._mode.mode) || '',
        echo: d._echo || null,
        tie: (d._tie && (d._tie.type || '')) || ''
      };
      if (vCfg.enabled !== false && choice !== 'off' && d.reply && !d.stickerSeg) {
        // maxChars <= 0（或没设）= 不限字数：DSH 想把多长的话用语音说都行（2026-10-26 用户要求解除限制）
        const rawMax = Number(vCfg.maxChars);
        const maxC = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0;
        const tooLong = maxC > 0 && String(d.reply).length > maxC;
        if (out.voice) {
          if (tooLong) log({ event: 'voice-skip', key: d.key, why: 'too-long', chars: String(d.reply).length, max: maxC });
          else { d.asVoice = true; log({ event: 'voice-choice', key: d.key, by: 'model', chars: String(d.reply).length }, '这句用语音说'); }
        } else if (choice === 'random' && !tooLong) {
          const p = typeof vCfg.probability === 'number' ? vCfg.probability : 0.2;
          if (Math.random() < p) { d.asVoice = true; log({ event: 'voice-choice', key: d.key, by: 'dice', chars: String(d.reply).length }); }
        }
      } else if (out && out.voice && vCfg.enabled === false) {
        log({ event: 'voice-skip', key: d.key, why: 'disabled' });
      }
    } catch (error) {
      log({ event: 'brain-error', key: d.key, err: String(error && error.message).slice(0, 300) }, `brain 失败 ${d.key}`);
      const mid = evt && evt.message_id ? String(evt.message_id) : '';
      const already = opts.retried === true || d._retried === true || (mid && retryDeferred.has(mid));
      // 注意：dryRun 在 handle 后面才声明（TDZ），这里只能用环境变量判断
      const isDryNow = process.env.AUTOREPLY_DRY === '1';
      if (!isDryNow && !already && mid) {
        retryDeferred.set(mid, Date.now());
        setTimeout(() => {
          retryDeferred.delete(mid);
          try { seen.delete(evt.message_id); } catch (e) { /* 去重表是 handle 内的，删不到就算了 */ }
          log({ event: 'brain-retry', key: d.key, mid }, '过一会儿再想一次');
          handle(evt, { fromRetry: true, retried: true }).catch(e => log({ event: 'brain-retry-error', key: d.key, err: String(e && e.message).slice(0, 200) }));
        }, REPLY_RETRY_MS).unref();
        await mindAfterTurn(key, d, evt, null);
        return;
      }
      log({ event: 'reply-skip', key: d.key, why: 'brain-failed' }, '想不出来就不发了');
      await mindAfterTurn(key, d, evt, null);
      return;
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
    // 模型自己挑了在线状态（[[状态:emo中]]）就照它设；风控闸门在 presence.setByLabel 里
    if (out && out.status && resp && resp.status === 'ok') {
      try {
        const presetR = await require('./presence.js').setByLabel(out.status, { dry: process.env.AUTOREPLY_DRY === '1' });
        log({ event: 'presence-model', key: d.key, want: out.status, ok: !!(presetR && presetR.ok), why: (presetR && presetR.why) || '' });
      } catch (e) { log({ event: 'presence-model-error', key: d.key, err: String((e && e.message) || e).slice(0, 160) }); }
    }
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
  // 模型自己写的文件（关系 / 随手记）：发送后处理；dry 只审计不落盘
  if (out && Array.isArray(out.writes) && out.writes.length) {
    try {
      const r = selfwrite.apply(out.writes, {
        key, uin: (d.target && d.target.id) || null, kind: d.target && d.target.type,
        text: d.text, dry: !!dryRun || !!(resp && resp.dry), log
      });
      if (r.applied.length || r.skipped.length || r.disabled) log({ event: 'selfwrite', key, applied: r.applied.map(x => x.kind + ':' + (x.type || x.text || '')), skipped: r.skipped, disabled: !!r.disabled });
    } catch (e) { log({ event: 'selfwrite-error', key, err: String(e && e.message).slice(0, 160) }); }
  }
  await mindAfterTurn(key, d, evt, out, resp);
}

/**
 * 发送之后的账务：这次提过的承诺记一次提醒，我这句话里如果又许了新承诺就存下来。
 * 只做本地读写，失败不影响主链路。
 */
function afterSend(d) {
  // 只要这一轮发的是实质内容（不是碎话），就把「连两条碎话」的闸门打开
  try { require('./murmur.js').markSubstantive(d && d.key); } catch (e) { /* ignore */ }
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

/** 排期到点：先让模型重估（A→B→C），再决定发/改/推后/撤。不直接盲发。 */
async function sendPlanned(plan, opts = {}) {
  const now = opts.now || Date.now();
  const key = String(plan.key || '');
  const dryRun = process.env.AUTOREPLY_DRY === '1';
  if (!key) { autonomy.markPlanSent(plan.id, { ok: false, why: 'no-key', now }); return { ok: false, why: 'no-key' }; }
  const kind = key.startsWith('g:') ? 'group' : 'private';
  const id = kind === 'group' ? key.split(':')[1] : key.replace(/^p:/, '');
  const target = kind === 'group' ? { type: 'group', id } : { type: 'private', id };
  const nick = opts.nick || (kind === 'group' ? '群里的人' : (ctxStore.view(key).history.filter((h) => h.from !== 'me').slice(-1)[0] || {}).speaker || '对方');
  // 这期间对方又发来几条（用来判断这句话还该不该说）
  let sinceMsgs = 0;
  try {
    const h = ctxStore.view(key).history || [];
    sinceMsgs = h.filter((x) => x.from !== 'me' && Number(x.t) > Number(plan.createdAt || 0)).length;
  } catch (e) { /* ignore */ }
  const ctx = {
    key, nick, kind, text: '', proactive: true,
    replan: { text: plan.text || '', ageMin: (now - Number(plan.createdAt || now)) / 60000, sinceMsgs },
    history: ctxStore.view(key).history
  };
  let out;
  try { out = await brain.think(ctx); } catch (e) {
    log({ event: 'plan-brain-error', key, err: String((e && e.message) || e).slice(0, 160) });
    autonomy.markPlanSent(plan.id, { ok: false, why: 'brain-error', now });
    return { ok: false, why: 'brain-error' };
  }
  if (out && out.plan) {                       // 模型认为该往后挪
    const re = autonomy.schedulePlan(key, out.plan, { now });
    autonomy.markPlanSent(plan.id, { ok: false, why: 'rescheduled', now });
    log({ event: 'plan-rescheduled', key, id: plan.id, inMs: out.plan.inMs, again: re && re.id });
    return { ok: false, why: 'rescheduled' };
  }
  if (!out || !out.reply || out.skip) {         // 话题过去了 / 模型判断不必说
    autonomy.markPlanSent(plan.id, { ok: false, why: out && out.skip ? 'model-skip' : 'empty', now });
    log({ event: 'plan-dropped', key, id: plan.id, why: out && out.skip ? 'model-skip' : 'empty' });
    return { ok: false, why: 'dropped' };
  }
  const d = { key, rule: 'planned', target, nick, reply: out.reply, planId: plan.id };
  let resp = null;
  try { resp = await send(d); } catch (e) {
    autonomy.markPlanSent(plan.id, { ok: false, why: 'send-error', now });
    log({ event: 'plan-send-error', key, id: plan.id, err: String((e && e.message) || e).slice(0, 160) });
    return { ok: false, why: 'send-error' };
  }
  const ok = resp && (resp.status === 'ok' || resp.dry);
  autonomy.markPlanSent(plan.id, { ok: !!ok, why: ok ? '' : 'send-failed', now });
  log({ event: 'plan-fired', key, id: plan.id, ok: !!ok, dry: !!dryRun, reply: String(out.reply).slice(0, 40) });
  try { await mindAfterTurn(key, d, null, out, resp); } catch (e) { /* ignore */ }
  return { ok: !!ok, reply: out.reply };
}

module.exports = { selfmodSettings,
  autonomySettings,
  selfwriteSettings,
  loadCfg, burstSettings, parseBurst, forwardSettings, modeSettings, personaSettings, murmurSettings, pushCtxTurn,
  atOthers, lastMyLine, followNames, follow, nick, themSettings, timelineSettings, echoSettings, typingPush, typingPop, typingTargetOf, decide, inQuietHours, textOf, hasAtMe, handle, dispatch, mergeEvents, mergeable, mergeSettings, flushMerge, fetchQuote, saySettings, analyzeIncoming, buildMessage, send, sendBubble, splitReply, afterSend, mindAfterTurn, promiseSettings, humanizeSettings, lastStickerSent,
  sendPlanned,
  watchSettings, sendWatchFollowUp
};

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
  // 后台定时器：空闲巩固 / 想念调度 / 自进化 / 头像（各自可关，失败只记日志，绝不影响回复）
  timers.startAll({ log, send, mindSettings, cfgNow, SELF_ID, watchSettings, sendWatchFollowUp });
  connect();
  setInterval(() => {
    const before = cfg && cfg.enabled;
    const c = loadCfg(false);
    if (before !== c.enabled) log({ event: 'config-change', enabled: c.enabled }, `auto-reply: enabled=${c.enabled}`);
  }, 20000);
  saveState();
}
