#!/usr/bin/env node
'use strict';
/**
 * watch.js —— 「反复盯着消息看」：话头悬在半空没人接时，自己知道要不要追问
 *
 * 场景（用户 m11836 原文）：「比如对面抛出一个问题，不说话了，能够自己知道追问」。
 * 真人不会「对方问完就翻篇」——他会隔一会儿把话接回去。这里把「悬着的话头」显式记下来：
 *
 *   1. my-q   ：我问了 TA 一句（带问号/疑问语气），TA 一直没答 —— 可以再问一次、换个说法，或者干脆不提
 *   2. their-q：TA 问了我一句，然后自己也不说话了（我上一轮可能被打断/没接上）—— 我可以先把那句答上、或问问是什么意思
 *
 * 只负责「判断该不该动 + 该说什么由模型现想」，不负责发送（发送留在 auto-reply，避免循环依赖）。
 * 纯本地 0 token：detect / due 全是规则，只有真的到点追问时才调一次模型。
 *
 * 落盘：logs/watch/<slug>.json（QQWATCH_DIR 可覆盖）
 * 闸门：总开关 → 悬着时长 [minIdleMin, maxIdleMin] → 每条话头最多追一次 → 同会话冷却 → 每天总量 → 免打扰(默认不看钟点)
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store.js');

const DIR = process.env.QQWATCH_DIR || path.join(__dirname, '..', 'logs', 'watch');
const LOG = path.join(__dirname, '..', 'logs', 'watch-error.log');

const DEFAULTS = {
  enabled: true,
  checkEveryMin: 5,
  minIdleMin: 20,          // 悬着至少 20 分钟才动（避免人家刚问完就催）
  maxIdleMin: 720,         // 超过 12 小时就别翻旧账
  perKeyCooldownMin: 180,  // 同一会话两次追问至少隔 3 小时
  dailyMax: 8,
  maxPerScan: 1,
  maxTriesPerItem: 1,   // 同一条话头最多追几次；0 = 不限（交给模型自己判断还该不该提）
  allowGroups: false,   // 群里默认不追（悬着的话头在群里太常见，容易刷屏）；设 true 才追
  quietHours: [],          // 空数组 = 不看钟点；[23,8] 才压住
  questionRe: /[?？]\s*$|[吗呢吧]\s*[?？。!！~～]?\s*$|(?:怎么|为什么|为啥|多久|哪[个里天]|行不行|好不好|要不要|是不是|有没有|能不能|可以吗)/,
  askRe: /(?:帮我|帮忙|能不能|可以吗|可不可以|求你|拜托|教我|给我|发我|推荐|怎么办|咋办|要不要|该不该|有没有|怎么弄|怎么搞|看看这)/,
  keepItems: 40
};

function cfgOf(over) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'watch.json'), 'utf8')); } catch (e) { }
  return { ...DEFAULTS, ...(file || {}), ...(over || {}) };
}

function slugOf(key) {
  return String(key || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'unknown';
}
function fileOf(key) { return path.join(DIR, slugOf(key) + '.json'); }

function blank(key, kind, peer) {
  return { key: String(key || ''), kind: kind || '', peer: peer || '', items: [], lastAt: 0, lastFollowAt: 0, dayKey: '', dayCount: 0 };
}

function load(key) {
  const f = fileOf(key);
  const j = store.readJson(f, null, { onError: (e) => appendErr('read', f, e) });
  if (!j || typeof j !== 'object') return blank(key);
  const b = blank(key, j.kind, j.peer);
  return { ...b, ...j, items: Array.isArray(j.items) ? j.items : [] };
}

function save(key, st) {
  st.items = (st.items || []).slice(-(cfgOf().keepItems || 40));
  return store.writeJson(fileOf(key), st);
}

function appendErr(where, file, e) {
  try { store.ensureDir(path.dirname(LOG)); fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), where, file, err: String((e && e.message) || e).slice(0, 200) }) + '\n'); } catch (x) { }
}

function dayKeyOf(now) {
  const d = new Date(now || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isQuestion(text, cfg) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  if (t.length > 120) return false;                 // 太长的一般是在倾诉，不当成提问
  const c = cfg || cfgOf();
  return c.questionRe.test(t);
}

function looksAsk(text, cfg) {
  const t = String(text || '');
  const c = cfg || cfgOf();
  return c.askRe.test(t);
}

/** 应和式的回话（嗯嗯/好/收到…）：不算真回答，话头其实还悬着 */
const ACK_RE = /^(?:嗯+|哦+|喔+|好+|行|可以|对|是|知道了|收到|了解|ok|OK|哈哈+|嘿嘿+|在|在呢)[。！!.…~～\s]*$/;
function isAck(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 8) return false;
  return ACK_RE.test(t);
}

/** 从上下文里找出「悬着的话头」——返回 null 或 {kind, text, at, len} */
function detect(key, opts) {
  const o = opts || {};
  const history = Array.isArray(o.history) ? o.history : [];
  const cfg = cfgOf(o.cfg);
  if (!history.length) return null;
  const last = history[history.length - 1];
  const mine = last.from === 'me';
  const text = String(last.text || '').trim();
  if (!text || text.length < 2) return null;
  const q = isQuestion(text, cfg);
  if (mine && q) return { kind: 'my-q', text: text.slice(0, 120), at: Number(last.t) || 0 };
  if (!mine && (q || looksAsk(text, cfg))) return { kind: 'their-q', text: text.slice(0, 120), at: Number(last.t) || 0 };
  return null;
}

/** 把这个话头写进账本（同一句话只记一次）；返回存储条目 */
function remember(key, thread, opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const st = load(key);
  if (o.kind) st.kind = o.kind;
  if (o.peer) st.peer = o.peer;
  st.lastAt = Math.max(Number(st.lastAt) || 0, Number(thread.at) || 0);
  const id = thread.kind + '|' + thread.text;
  let it = st.items.find(x => x.id === id);
  if (!it) {
    it = { id, kind: thread.kind, text: thread.text, at: Number(thread.at) || now, followed: false, followedAt: 0, tries: 0 };
    st.items.push(it);
  }
  // 只留最近的若干条没追过的
  save(key, st);
  return it;
}

/** 判断某个会话现在该不该追问；返回 {ok:true,item,...} 或 {ok:false,why} */
function due(key, opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const cfg = cfgOf(o.cfg);
  if (cfg.enabled === false) return { ok: false, why: 'disabled' };
  if (Array.isArray(cfg.quietHours) && cfg.quietHours.length >= 2) {
    const h = new Date(now).getHours() + new Date(now).getMinutes() / 60;
    const [a, b] = cfg.quietHours;
    const inQ = a < b ? (h >= a && h < b) : (h >= a || h < b);
    if (inQ) return { ok: false, why: 'quiet' };
  }
  const history = Array.isArray(o.history) ? o.history : [];
  const thread = o.thread || detect(key, { history, cfg, now });
  if (!thread) return { ok: false, why: 'no-thread' };

  const st = load(key);
  const idleMin = thread.at ? Math.round((now - thread.at) / 60000) : null;
  if (idleMin == null || idleMin < Number(cfg.minIdleMin || 0)) return { ok: false, why: 'too-soon', idleMin };
  const maxIdle = Number(cfg.maxIdleMin);
  if (Number.isFinite(maxIdle) && maxIdle > 0 && idleMin > maxIdle) return { ok: false, why: 'too-late', idleMin };

  const id = thread.kind + '|' + thread.text;
  const prev = st.items.find(x => x.id === id);
  const maxTries = Number(cfg.maxTriesPerItem);
  if (prev && prev.followed && Number.isFinite(maxTries) && maxTries > 0 && (Number(prev.tries) || 1) >= maxTries) {
    return { ok: false, why: 'already-followed' };
  }

  const lastFollow = Number(st.lastFollowAt) || 0;
  const cdMin = Number(cfg.perKeyCooldownMin);
  if (lastFollow && Number.isFinite(cdMin) && cdMin > 0 && now - lastFollow < cdMin * 60000) {
    return { ok: false, why: 'cooldown', leftMin: Math.round((Number(cfg.perKeyCooldownMin) * 60000 - (now - lastFollow)) / 60000) };
  }

  const dk = dayKeyOf(now);
  if (st.dayKey !== dk) { st.dayKey = dk; st.dayCount = 0; }
  const dmax = Number(cfg.dailyMax);
  if (Number.isFinite(dmax) && dmax > 0 && (Number(st.dayCount) || 0) >= dmax) return { ok: false, why: 'daily-cap' };

  return { ok: true, item: { ...thread, id, idleMin }, state: st };
}

/** 记一次追问（只在真的发出去之后调用；dry 也要记账吗——不，dry 不记，避免演练吃掉配额） */
function markFollowed(key, item, opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const st = load(key);
  const id = (item && item.id) || (item && item.kind + '|' + item.text);
  let it = st.items.find(x => x.id === id);
  if (!it) { it = { id, kind: item && item.kind, text: item && item.text, at: Number(item && item.at) || now, followed: false, followedAt: 0, tries: 0 }; st.items.push(it); }
  it.followed = true;
  it.followedAt = now;
  it.tries = (Number(it.tries) || 0) + 1;
  it.why = o.why || 'followed';
  st.lastFollowAt = now;
  const dk = dayKeyOf(now);
  if (st.dayKey !== dk) { st.dayKey = dk; st.dayCount = 0; }
  st.dayCount = (Number(st.dayCount) || 0) + 1;
  save(key, st);
  return { ok: true, item: it, dayCount: st.dayCount };
}

/** 给普通回复用的提示：还有话头悬着，可以顺手接一句（返回 null 或一句话） */
function noteFor(key, opts) {
  const o = opts || {};
  const cfg = cfgOf(o.cfg);
  if (cfg.enabled === false) return null;
  const history = Array.isArray(o.history) ? o.history : [];
  // 只看「最近 6 轮里、我问出去还没被接的」——太老的别提
  const tail = history.slice(-6);
  for (let i = tail.length - 1; i >= 0; i--) {
    const h = tail[i];
    if (h.from !== 'me') continue;
    if (!isQuestion(h.text, cfg)) continue;
    const answered = tail.slice(i + 1).some(x => x.from !== 'me' && !isAck(x.text));
    if (answered) continue;
    const idleMin = h.t ? Math.round((Number(o.now) || Date.now()) - h.t) / 60000 : null;
    if (idleMin != null && idleMin > Number(cfg.maxIdleMin || 720)) continue;
    return '你之前问过 TA 一句「' + String(h.text).slice(0, 60) + '」，到现在还没回你（或者被别的话题岔过去了）。如果这轮接得上，可以顺着把话接回来；接不上就别硬提。';
  }
  return null;
}

/** 扫一遍所有会话，返回该追问的列表（给定时器用） */
function scan(opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const cfg = cfgOf(o.cfg);
  if (cfg.enabled === false) return { skipped: 'disabled', list: [] };
  const sessions = Array.isArray(o.sessions) ? o.sessions : [];
  const out = [];
  for (const s of sessions) {
    const key = s && s.key;
    if (!key) continue;
    const idle = Number(s.idleMin);
    if (Number.isFinite(idle) && idle < Number(cfg.minIdleMin || 0)) continue;
    if (Number.isFinite(idle) && idle > Number(cfg.maxIdleMin || 720)) continue;
    const allowG = o.allowGroups === true || cfg.allowGroups === true;
    if (String(key).startsWith('g:') && !allowG) continue;
    let d;
    try { d = due(key, { now, cfg, history: typeof o.historyOf === 'function' ? o.historyOf(key) : [] }); } catch (e) { appendErr('scan', key, e); continue; }
    if (d.ok) out.push({ key, item: d.item });
    const mps = Number(cfg.maxPerScan);
    if (Number.isFinite(mps) && mps > 0 && out.length >= mps) break;
  }
  return { list: out, scanned: sessions.length };
}

function status(key) {
  const st = load(key);
  const cfg = cfgOf();
  return {
    enabled: cfg.enabled !== false,
    key: st.key, items: st.items.length,
    open: st.items.filter(x => !x.followed).length,
    followed: st.items.filter(x => x.followed).length,
    lastFollowMin: st.lastFollowAt ? Math.round((Date.now() - st.lastFollowAt) / 60000) : null,
    todayCount: (st.dayKey === dayKeyOf(Date.now()) ? st.dayCount : 0),
    dailyMax: cfg.dailyMax,
    items_detail: st.items.slice(-5)
  };
}

function list() {
  try {
    const cfg = cfgOf();
    return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        const items = Array.isArray(j.items) ? j.items : [];
        return {
          key: j.key, total: items.length,
          open: items.filter(x => !x.followed).length,
          followed: items.filter(x => x.followed).length,
          lastAt: j.lastAt || 0, lastFollowAt: j.lastFollowAt || 0,
          idleMin: j.lastAt ? Math.round((Date.now() - j.lastAt) / 60000) : null
        };
      } catch (e) { return { file: f, error: e.message }; }
    }).sort((a, b) => (b.lastFollowAt || 0) - (a.lastFollowAt || 0));
  } catch (e) { return []; }
}

function reset(key) {
  try { fs.rmSync(fileOf(key), { force: true }); return { ok: true }; } catch (e) { return { ok: false, why: String(e.message || e) }; }
}

module.exports = {
  DEFAULTS, DIR, cfgOf, slugOf, fileOf, blank, load, save,
  isQuestion, looksAsk, isAck, detect, remember, due, markFollowed, noteFor, scan, status, list, reset
};

// ---------- CLI ----------
if (require.main === module) {
  const [cmd, key] = process.argv.slice(2);
  const ctxStore = require('./context.js');
  if (cmd === 'list') {
    const r = list();
    console.log(r.length ? r.map(x => `${x.key}  open=${x.open} followed=${x.followed} 静了=${x.idleMin == null ? '?' : x.idleMin + 'min'}`).join('\n') : '（还没有记录）');
  } else if (cmd === 'scan') {
    const sessions = ctxStore.list().map(s => ({ key: s.key, idleMin: s.idleMin }));
    const r = scan({ sessions, historyOf: (k) => ctxStore.view(k).history || [] });
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'status' && key) {
    console.log(JSON.stringify(status(key), null, 2));
  } else if (cmd === 'reset' && key) {
    console.log(JSON.stringify(reset(key)));
  } else {
    console.log('用法: node scripts/watch.js list | scan | status <key> | reset <key>');
  }
}
