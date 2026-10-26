#!/usr/bin/env node
// 对话上下文存储：把「跟某个人的来回」落到磁盘，进程重启/看门狗重启都不丢。
//
// 设计借鉴（同类成熟实现的做法）：
// - LangBot / chatgpt-on-wechat：会话按 联系人 / 群 隔离，上下文超限后裁掉最早的，只留最近若干轮；
// - LangChain ConversationSummaryBufferMemory：原文超预算时把「最老的一段」交给模型压成摘要，摘要接着往下滚；
// - mem0 / MemGPT 的分层记忆：短期=原文窗口，长期=少量稳定事实（对方是谁、在忙什么），只在摘要时顺手抽取；
// - 冷启动回填：进程刚起来时用 NapCat 的 get_friend_msg_history / get_group_msg_history 把最近几条拉回来，
//   这样重启后接得上话头（大多数机器人重启即失忆，这是它的短板）。
//
// 磁盘布局：logs/context/<slug>.json
// {
//   key, kind: 'private'|'group', peer: {uin|gid, name},
//   updatedAt, sessionStartedAt,
//   turns: [{t, from:'them'|'me', speaker, text}],
//   summary: '更早对话的摘要（滚动）', summaryAt,
//   facts: ['关于对方的稳定事实', ...],
//   dropped: 已折叠进摘要的条数（仅供排查）
// }
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.QQCTX_DIR || path.join(ROOT, 'logs', 'context');

const DEFAULTS = {
  enabled: true,
  maxTurns: 60,          // 硬上限：原文最多留这么多条（再多先摘要再丢）
  budgetChars: 1400,     // 送给模型的原文预算（字符）；超了就摘要
  keepRecent: 8,         // 摘要后仍然保留的最近原文条数
  idleMinutes: 45,       // 这么久没说话算「换了话题」，把上一段压成摘要
  warmupCount: 20,       // 冷启动时从 NapCat 拉多少条历史回填
  warmup: true,
  summarize: true,
  factsMax: 6
};

let cfg = DEFAULTS;
function configure(c) {
  cfg = { ...DEFAULTS, ...(c || {}) };
  return cfg;
}
function options() { return { ...cfg }; }

// key: 'p:100000001' / 'g:200000001'
function slugOf(key) {
  return String(key).replace(/[^0-9a-zA-Z_.-]+/g, '_').slice(0, 80);
}
function fileOf(key) { return path.join(DIR, slugOf(key) + '.json'); }

function blank(key, kind, peer) {
  return {
    key, kind, peer: peer || {},
    updatedAt: 0, sessionStartedAt: 0,
    turns: [], summary: '', summaryAt: 0, facts: [], dropped: 0
  };
}

function load(key, kind, peer) {
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    if (!s || typeof s !== 'object') return blank(key, kind, peer);
    s.turns = Array.isArray(s.turns) ? s.turns : [];
    s.facts = Array.isArray(s.facts) ? s.facts : [];
    s.summary = typeof s.summary === 'string' ? s.summary : '';
    return s;
  } catch (e) {
    return blank(key, kind, peer);
  }
}

function sleepMs(ms) {
  // 同步小睡：这里整条链路都是同步写，用 Atomics.wait 比忙等省 CPU
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 忽略 */ }
}

/**
 * 原子写。E:\ 上 rename 偶发 EIO/EPERM（杀软或同步盘占着句柄），所以：
 * 失败就换个临时名重试几次，最后退回直接写 —— 宁可短暂非原子，也不能悄悄丢上下文。
 */
function save(ctx) {
  const file = fileOf(ctx.key);
  const data = JSON.stringify(ctx);
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const tmp = `${file}.${process.pid}.${i}.tmp`;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
      sleepMs(15 + 25 * i);
    }
  }
  try {
    fs.writeFileSync(file, data);
    return true;
  } catch (e) {
    lastErr = e;
  }
  try {
    fs.appendFileSync(path.join(ROOT, 'logs', 'context-error.log'),
      JSON.stringify({ t: Date.now(), key: ctx.key, err: String(lastErr && lastErr.message) }) + '\n');
  } catch (e2) { /* 忽略 */ }
  return false;
}

function charsOf(turns) {
  return turns.reduce((n, t) => n + String(t.text || '').length, 0);
}

/** 追加一条；返回更新后的 ctx（已落盘）。 */
function push(key, turn, opts = {}) {
  // seq = QQ 里真实的 message_seq（事件字段 real_seq）。主动引用要用它，不能用 message_id。
  if (turn && turn.seq != null && turn.seq !== '') turn.seq = String(turn.seq);
  const o = { ...cfg, ...opts };
  if (!o.enabled) return null;
  const c = load(key, turn.kind || (String(key).startsWith('g:') ? 'group' : 'private'), turn.peer);
  const item = {
    t: turn.t || Date.now(),
    from: turn.from,
    speaker: turn.speaker || '',
    text: String(turn.text || '').slice(0, 400)
  };
  // 全量保存都带人可读时间戳（毫秒 t 给机器算间隔，ISO at 给人/日志看）
  item.at = new Date(item.t).toISOString();
  // 真实 message_seq：主动引用要靠它指「引用哪一条」；没有就留 null
  item.seq = turn.seq != null && turn.seq !== '' ? String(turn.seq) : null;
  if (!item.text) return c;
  c.turns.push(item);
  c.updatedAt = item.t;
  if (!c.sessionStartedAt) c.sessionStartedAt = item.t;
  if (turn.peer && (turn.peer.name || turn.peer.uin || turn.peer.gid)) c.peer = { ...c.peer, ...turn.peer };
  while (c.turns.length > o.maxTurns) { c.turns.shift(); c.dropped++; }
  save(c);
  return c;
}

/**
 * 把 NapCat 历史接口拉回来的一批消息「灌」进上下文：按时间排序、按 (时间|方向|文本) 去重。
 *
 * 一把抓两件事：
 *   ① 冷启动回填 —— 本地空、或本地最早的比历史还新，就把更早的补进来；
 *   ② 离线补账 —— 进程停着那段时间别人发的消息没有 WS 事件，只能从历史里捞；
 *      返回值里的 missed 就是「比本地最新一条还新的、对方发的」那些，供调用方给大脑提一句。
 *
 * msgs 是 NapCat 原始消息数组；返回 {ok, added, total, missed:[{t,from,speaker,text}]}。
 */
function ingest(key, kind, peer, msgs, opts = {}) {
  const o = { ...cfg, ...opts };
  if (!o.enabled) return { ok: false, added: 0, total: 0, missed: [] };
  const c = load(key, kind, peer);
  const lastT = c.turns.length ? c.turns[c.turns.length - 1].t : 0;
  const seen = new Set(c.turns.map(t => t.t + '|' + t.from + '|' + t.text));
  const added = [];
  for (const m of msgs || []) {
    const t = turnOfMsg(m, o.selfId);
    if (!t) continue;
    const sig = t.t + '|' + t.from + '|' + t.text;
    if (seen.has(sig)) continue;
    seen.add(sig);
    added.push({ t: t.t, at: new Date(t.t).toISOString(), from: t.from, speaker: t.speaker, text: String(t.text).slice(0, 400) });
  }
  const missed = lastT ? added.filter(t => t.t > lastT && t.from === 'them') : [];
  if (!added.length) return { ok: true, added: 0, total: c.turns.length, missed: [] };
  c.turns = c.turns.concat(added).sort((a, b) => a.t - b.t);
  while (c.turns.length > o.maxTurns) { c.turns.shift(); c.dropped++; }
  if (kind) c.kind = kind;
  if (peer && (peer.uin || peer.gid)) c.peer = { ...c.peer, ...peer };
  c.updatedAt = c.turns.length ? c.turns[c.turns.length - 1].t : c.updatedAt;
  if (!c.sessionStartedAt) c.sessionStartedAt = c.turns.length ? c.turns[0].t : 0;
  save(c);
  return { ok: true, added: added.length, total: c.turns.length, missed };
}

/**
 * 给 brain 的视图。返回 { history:[{from,text,speaker,ageMin}], summary, facts, idleMin, gapNote }
 * history 由旧到新，且保证字符数不超过 budgetChars（从最旧开始丢，摘要逻辑在外面兜）。
 */
function view(key, opts = {}) {
  const o = { ...cfg, ...opts };
  const c = load(key);
  if (!c.updatedAt) return { history: [], summary: '', facts: [], idleMin: null, gapNote: '' };
  const now = Date.now();
  const idleMin = Math.round((now - c.updatedAt) / 60000);
  let turns = c.turns.slice();
  let used = 0;
  const kept = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = String(turns[i].text || '').length;
    if (kept.length && used + len > o.budgetChars) break;
    kept.unshift(turns[i]);
    used += len;
  }
  const gapNote = idleMin >= (o.idleMinutes || 45)
    ? `距上次对话约 ${idleMin >= 120 ? Math.round(idleMin / 60) + ' 小时' : idleMin + ' 分钟'}，可以自然地问一句这段时间的事。`
    : '';
  return {
    history: kept.map(t => ({ from: t.from, text: t.text, speaker: t.speaker, t: t.t, at: t.at || new Date(t.t).toISOString(), seq: t.seq != null ? String(t.seq) : null, ageMin: Math.round((now - t.t) / 60000) })),
    summary: c.summary || '',
    facts: c.facts || [],
    idleMin,
    gapNote,
    raw: c
  };
}

/** 把 turns 前 n 条切出来（摘要用），返回 {old, rest} */
function splitOld(ctx, n) {
  const turns = ctx.turns || [];
  const k = Math.max(0, Math.min(n, turns.length));
  return { old: turns.slice(0, k), rest: turns.slice(k) };
}

/**
 * 需要压缩吗？返回 {need, oldTurns, ctx}。
 * 触发条件：原文超预算，或空闲超时，或条数超过 maxTurns 的软线。
 */
function planCompaction(key, opts = {}) {
  const o = { ...cfg, ...opts };
  const c = load(key);
  if (!c.updatedAt || !o.enabled || !o.summarize) return { need: false, ctx: c };
  const now = Date.now();
  const idleMs = (o.idleMinutes || 45) * 60000;
  const overBudget = charsOf(c.turns) > (o.budgetChars || 1400) * 1.6;
  const overCount = c.turns.length > (o.maxTurns || 60) - 4;
  const idle = c.updatedAt && now - c.updatedAt > idleMs && c.turns.length > 2;
  const need = overBudget || overCount || idle;
  if (!need) return { need: false, ctx: c };
  const keepN = Math.max(2, o.keepRecent || 8);
  const cut = Math.max(0, c.turns.length - keepN);
  const { old, rest } = splitOld(c, cut);
  return { need: old.length > 0, old, rest, ctx: c };
}

/** 压缩完成后写回（summary + facts 合并，旧原文删掉）。 */
function applyCompaction(key, { old, rest, summary, facts }, opts = {}) {
  const o = { ...cfg, ...opts };
  const c = load(key);
  c.turns = rest || [];
  c.dropped = (c.dropped || 0) + (old ? old.length : 0);
  if (summary) {
    c.summary = mergeSummary(c.summary, summary);
    c.summaryAt = Date.now();
  }
  if (Array.isArray(facts) && facts.length) {
    const seen = new Set(c.facts.map(f => f.toLowerCase()));
    for (const f of facts) {
      const s = String(f).trim().slice(0, 80);
      if (!s || seen.has(s.toLowerCase())) continue;
      c.facts.push(s);
      seen.add(s.toLowerCase());
    }
    c.facts = c.facts.slice(-(o.factsMax || 6));
  }
  save(c);
  return c;
}

function mergeSummary(oldS, newS) {
  const a = String(oldS || '').trim();
  const b = String(newS || '').trim();
  if (!a) return b;
  if (!b) return a;
  // 摘要本身也要防膨胀：总长控制在 400 字内，超了就从最前面截断（保留较新的部分）
  const merged = a + '；' + b;
  return merged.length > 400 ? merged.slice(merged.length - 400).replace(/^[^；]*；/, '') : merged;
}

// ---------- 冷启动回填：用 NapCat 的历史接口把最近几条拉回来 ----------
/** 从一条 NapCat 消息 → 我们的 turn（拿不到文本就返回 null） */
function turnOfMsg(m, selfId) {
  if (!m) return null;
  const from = String(m.user_id) === String(selfId) ? 'me' : 'them';
  const segs = Array.isArray(m.message) ? m.message : [];
  const text = segs.filter(s => s && s.type === 'text').map(s => s.data && s.data.text || '').join('').trim();
  const face = segs.find(s => s && s.type === 'mface');
  const img = segs.find(s => s && s.type === 'image');
  const voice = segs.find(s => s && s.type === 'record');
  let body = text;
  if (!body && face) body = '[表情包]';
  if (!body && voice) body = '[语音]';
  if (!body && img) body = '[图片]';
  if (!body) return null;
  const sp = (m.sender && (m.sender.card || m.sender.nickname)) || String(m.user_id);
  return { t: (m.time || 0) * 1000 || Date.now(), from, speaker: from === 'me' ? '我' : sp, text: body, seq: m.message_seq || m.message_id };
}

/**
 * 回填。fetchHistory(kind, id, count) 是外部注入的回调（避免本文件依赖 qq.js）。
 * 只在本地上下文为空、或本地最早一条比历史还新（重启后很久没聊）时回填。
 */
async function warmup(key, kind, id, fetchHistory, opts = {}) {
  const o = { ...cfg, ...opts };
  if (!o.enabled || !o.warmup || typeof fetchHistory !== 'function') return { ok: false, reason: 'disabled' };
  const c = load(key);
  const localOldest = c.turns.length ? c.turns[0].t : Infinity;
  const msgs = await fetchHistory(kind, id, o.warmupCount || 20);
  const turns = (msgs || []).map(m => turnOfMsg(m, o.selfId)).filter(Boolean);
  if (!turns.length) return { ok: false, reason: 'empty' };
  const merged = turns.filter(t => t.t <= localOldest).concat(c.turns);
  // 去重（同时间+同文本）
  const seen = new Set();
  const out = [];
  for (const t of merged) {
    const sig = t.t + '|' + t.from + '|' + t.text;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ t: t.t, from: t.from, speaker: t.speaker, text: String(t.text).slice(0, 400) });
  }
  c.turns = out.slice(-(o.maxTurns || 60));
  c.updatedAt = c.turns.length ? c.turns[c.turns.length - 1].t : c.updatedAt;
  if (!c.sessionStartedAt) c.sessionStartedAt = c.turns.length ? c.turns[0].t : 0;
  if (kind === 'group') c.kind = 'group';
  save(c);
  return { ok: true, added: turns.length, total: c.turns.length, file: fileOf(key) };
}

/** 维护/排查用：列出所有上下文文件概要。 */
function list() {
  try {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        return {
          key: c.key, kind: c.kind, peer: c.peer, turns: (c.turns || []).length,
          chars: charsOf(c.turns || []), summaryChars: (c.summary || '').length,
          facts: (c.facts || []).length, idleMin: c.updatedAt ? Math.round((Date.now() - c.updatedAt) / 60000) : null,
          updatedAt: c.updatedAt
        };
      } catch (e) { return { file: f, error: e.message }; }
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (e) { return []; }
}

module.exports = {
  configure, options, DEFAULTS, dir: DIR,
  fileOf, load, save, push, ingest, view, charsOf,
  planCompaction, applyCompaction, mergeSummary, warmup, turnOfMsg, list, slugOf
};
