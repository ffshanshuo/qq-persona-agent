'use strict';
/**
 * longing.js —— 想念调度：没人找我时，我什么时候会主动想起某个人。
 *
 * 核心（用户 2026-10-23 的想法）：
 *   亲密度 / 关系类型决定「多久会想起 TA」「想到什么程度」。
 *   intimacy 高 → 期望空窗短；warmth 高 → 更容易想起；tension 高 → 往后拖；
 *   最近一次聊得有分量（salience 高）→ 想起得更早；还欠着对方一件事 → 略早。
 *
 * 落盘：logs/longing/<slug>.json（每个会话的主动记录）、logs/longing/_global.json（全局节流）
 * 环境变量：QQLONGING_DIR 可覆盖目录（测试用）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const mind = require('./mind.js');
const context = require('./context.js');
const brain = require('./brain.js');
const promises = require('./promises.js');

const DEFAULTS = {
  enabled: true,
  checkEveryMin: 20,     // 多久扫一次「是不是该想谁了」
  maxPerCheck: 1,        // 每次最多主动找一个人
  intensityThreshold: 1, // 想念强度到 1.0 才算「到点了」
  minIdleHours: 2,       // 至少安静 2 小时才考虑（别人还在聊就别插话）
  minTurns: 6,           // 至少聊过 6 轮才算「认识」
  perContactHours: 20,   // 同一个人 20 小时内不重复主动
  perContactDaily: 1,    // 同一个人每天最多主动 1 次
  dailyMax: 2,           // 全局每天最多主动 2 次
  globalGapHours: 2,     // 两次主动之间至少隔 2 小时
  quietHours: [], // 默不设免打扰（DSH 不按人的作息活）；想夜里闭嘴就填 [23, 8]   // 免打扰：23:00–08:00 不主动
  allowGroups: false,    // 暂时只主动私聊
  baseHours: 36,         // 完全不熟的人，大约 36 小时才会「想起」
  intimacyDecay: 2.4,    // 亲密度对「想起间隔」的加速系数
  maxIntensity: 1.5,
  followUpAfterHours: 3, // 主动了这么久还没回音，可以再补一句
  followUpMax: 1,        // 同一次主动最多补几句（别连发）
  tensionBlock: 0.6,     // 关系僵到这个程度就先别寒暄（说好的事除外）
  jitterRatio: 0.12,     // 「到点了」的阈值上下浮动（别每次都同一分钟想起）
  topicChars: 60,        // 给模型的话题线索最长多少字
  // 关系分档：不是所有认识的人都会「思念」
  minIntimacy: 0.55,         // 低于这个亲密度＝不熟，绝不主动（约定的事除外）
  acquaintanceIntimacy: 0.75, // 这个以下算「一般偏熟」（够熟但还没到亲近），想起间隔按 acquaintanceFactor 放大
  acquaintanceFactor: 6,     // 一般偏熟的人，期望间隔 × 6（几天才可能想起一次）
  followUpMinIntimacy: 0.55, // 没回音要补一句，只对够熟的人做（跟一般关系补话很怪）
  muteList: []
};

let cfg = { ...DEFAULTS };
const CFG_PATH = path.join(ROOT, 'config', 'longing.json');
function loadCfg(force) {
  if (!force && loadCfg._c) return cfg;
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    cfg = { ...DEFAULTS, ...j };
    delete cfg._note; delete cfg._notes;
  } catch (e) { cfg = { ...DEFAULTS }; }
  loadCfg._c = true;
  return cfg;
}
function configure(o = {}) { cfg = { ...cfg, ...o }; loadCfg._c = true; return cfg; }
function options() { return { ...cfg }; }

function dirOf() { return process.env.QQLONGING_DIR || path.join(ROOT, 'logs', 'longing'); }
function slugOf(key) { return String(key || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120); }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }
function globalFile() { return path.join(dirOf(), '_global.json'); }

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { } };
function saveRaw(file, body) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { }
  for (let i = 0; i < 4; i++) {
    const tmp = `${file}.${process.pid}.${i}.tmp`;
    try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); return true; }
    catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { } sleep(15 + 25 * i); }
  }
  try { fs.writeFileSync(file, body); return true; }
  catch (e) {
    try {
      fs.appendFileSync(path.join(ROOT, 'logs', 'longing-error.log'), `${new Date().toISOString()} ${file} ${e.message}\n`);
    } catch (e2) { }
    return false;
  }
}
function loadJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return fallback; }
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : fallback;
  } catch (e) {
    try { fs.renameSync(file, file + '.bad-' + Date.now()); } catch (e2) { }
    return fallback;
  }
}

function blank(key) { return { key, lastOutAt: 0, count: 0, followUps: 0, items: [] }; }
function load(key) { const j = loadJson(fileOf(key), blank(key)); return { ...blank(key), ...j }; }
function save(key, c) { return saveRaw(fileOf(key), JSON.stringify({ ...c, key, updatedAt: Date.now() }, null, 2)); }

function loadGlobal() { return loadJson(globalFile(), { sent: [] }); }
function saveGlobal(g) { return saveRaw(globalFile(), JSON.stringify({ sent: (g.sent || []).slice(-200), updatedAt: Date.now() }, null, 2)); }

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

/**
 * 「这个人多久没消息我会想起 TA」——小时。
 * intimacy↑ 大幅缩短；warmth↑ 略缩短；tension↑ 明显拉长；salience↑ 略缩短。
 */
function expectedHours(rel = {}, salience = 0) {
  const decay = Number(cfg.intimacyDecay);
  const base = (Number(cfg.baseHours) || 36) * Math.exp(-(Number.isFinite(decay) ? decay : 2.4) * clamp01(rel.intimacy));
  const warm = 1 - 0.25 * clamp01(rel.warmth);
  const tense = 1 + 1.2 * clamp01(rel.tension);
  const sal = 1 - 0.3 * clamp01(salience);
  return Math.max(1.2, base * warm * tense * sal);
}

/** 想念强度：过了这么久的空窗 / 期望空窗，再按情感分量微调。≥1 就是「到点了」。 */
function intensityOf({ hours = 0, expected = 1, salience = 0, owed = false } = {}) {
  let v = Number(hours) / Math.max(0.5, Number(expected) || 1);
  v += 0.15 * clamp01(salience);
  if (owed) v += 0.1;  // 还欠着对方一件事，会更容易惦记
  return Math.min(Number(cfg.maxIntensity) || 1.5, v);
}

function inQuiet(now = Date.now()) {
  const q = cfg.quietHours || [];
  if (!Array.isArray(q) || q.length < 2) return false;
  const h = new Date(now).getHours();
  const [from, to] = q;
  return from <= to ? (h >= from && h < to) : (h >= from || h < to);
}

function nickOf(key) {
  try {
    const hist = (context.view(key).history || []);
    for (let i = hist.length - 1; i >= 0; i--) {
      const who = hist[i].speaker;
      if (hist[i].from !== 'me' && who) return String(who);
    }
  } catch (e) { }
  return '';
}

/**
 * 主动开口时能抓住的具体由头：约定到日子的事 > 我上次说的那句 > 记忆里的一件旧事 > 日子（节日/周末）。
 * 返回 null 表示没有由头，让模型自己找话。
 */
function topicOf(key, cand = {}, now = Date.now()) {
  const cap = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, Number(cfg.topicChars) || 60);
  if (cand && cand.due && cand.due.text) return { kind: 'due', text: cap(cand.due.text) };
  // 模型给自己排的「想做的事」：比「我最后一句」更像有由头地开口
  try {
    const w = require('./selfwrite.js').wantsFor(key, { max: 1, maxAgeDays: 14 })[0];
    const wt = cap(w && w.text);
    if (wt.length >= 4) return { kind: 'want', text: wt };
  } catch (e) { /* 没有就没有 */ }
  try {
    const hist = context.view(key).history || [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const t = cap(hist[i].text);
      if (hist[i].from === 'me' && t.length >= 4) return { kind: 'mine-last', text: t };
    }
  } catch (e) { }
  try {
    const r = mind.recall(key, '');
    const m = ((r && r.memories) || [])[0];
    const t = cap(m);
    if (t.length >= 4) return { kind: 'memory', text: t };
  } catch (e) { }
  try {
    const cn = require('./clock.js').noteFor({ now });
    const info = (cn && cn.info) || {};
    if (info.holiday && (info.holiday.isHoliday || info.holiday.tomorrow)) return { kind: 'clock', text: '今天是' + info.holiday.name };
    if (info.weekend) return { kind: 'clock', text: '现在是周末' };
  } catch (e) { }
  return null;
}

function daysAgoCount(times, now, days = 1) {
  const from = now - days * 86400e3;
  return (times || []).filter(t => t >= from).length;
}

/** 纯计算：现在该想谁了（不发送）。返回按想念强度降序的候选。 */
function plan(opts = {}) {
  loadCfg();
  const now = Number(opts.now) || Date.now();
  const out = [];
  let keys = [];
  try { keys = mind.allKeys() || []; } catch (e) { keys = []; }
  for (const key of keys) {
    if (!key) continue;
    const isGroup = key.startsWith('g:');
    if (isGroup && !cfg.allowGroups) continue;
    const uin = isGroup ? key.split(':')[1] : key.slice(2);
    if ((cfg.muteList || []).map(String).includes(String(uin))) continue;
    let st;
    try { st = mind.loadState(key, isGroup ? 'group' : 'private', isGroup ? { gid: Number(uin) } : { uin: Number(uin) }); }
    catch (e) { continue; }
    if ((Number(st.msgCount) || 0) < (Number(cfg.minTurns) || 6)) continue;
    let hist = [];
    try { hist = context.view(key).history || []; } catch (e) { hist = []; }
    const lastTurnT = hist.length ? Number(hist[hist.length - 1].t) || 0 : 0;
    const lastAt = Math.max(Number(st.lastTurnAt) || 0, lastTurnT);
    if (!lastAt) continue;
    const hours = (now - lastAt) / 3600e3;
    // 约定到日子的承诺：就算刚聊过，也值得提一句（不是催账，是"说好的事"）
    let due = null;
    try { const ds = promises.dueItems(key, { now }); if (ds.length) due = ds[0]; } catch (e) { }
    // 关系一般的人不会思念：亲密度不到 minIntimacy 就不主动（约定到日子的事除外）
    let rel = st.rel || {};
    try { rel = require('./bonds.js').effectiveRel(key, rel, now); } catch (e) { }
    const intimacy = clamp01(rel.intimacy);
    if (!due && intimacy < (Number(cfg.minIntimacy) || 0.55)) continue;
    if (hours < (Number(cfg.minIdleHours) || 2) && !due) continue;
    // 关系正僵着的时候先别主动寒暄——那才像真的在别扭（说好的事除外）
    if (!due && clamp01(rel.tension) >= (Number(cfg.tensionBlock) || 0.6)) continue;
    const salience = Number(st.lastAffect && st.lastAffect.salience) || 0;
    let owed = false;
    try { owed = promises.list(key).some(x => x.status === 'open'); } catch (e) { }
    // 一般偏熟（还没到老朋友）把「想起间隔」大幅放大：认识归认识，但不惦记
    const acqFactor = (!due && intimacy < (Number(cfg.acquaintanceIntimacy) || 0.75))
      ? (Number(cfg.acquaintanceFactor) || 6) : 1;
    const expected = expectedHours(rel, salience) * acqFactor;
    // 关系类型：恋人期望更短（冷战期拉长）、前任永不主动（说好的事除外）
    let tieF = { factor: 1, never: false, why: '' };
    try { tieF = require('./ties.js').longingFactor(key); } catch (e) { }
    if (tieF.never && !due) continue;
    let expectedT = expected;
    if (Number.isFinite(tieF.factor) && tieF.factor > 0) expectedT = expected * tieF.factor;

    let intensity = intensityOf({ hours, expected: expectedT, salience, owed });
    if (due) intensity = Math.max(1.25, intensity); // 到日子的承诺优先
    // 想起一个人的时机本来就有早有晚，别每次都卡在同一分钟（测试可传 opts.random 固定）
    const jr = Math.max(0, Math.min(0.5, Number(cfg.jitterRatio) || 0));
    const jit = typeof opts.random === 'function' ? (opts.random() - 0.5) * 2 * jr : 0;
    if (intensity < (Number(cfg.intensityThreshold) || 1) * (1 + jit)) continue;
    // 同一个人别老去打扰
    const c = load(key);
    if (!due && c.lastOutAt && now - c.lastOutAt < (Number(cfg.perContactHours) || 20) * 3600e3) continue;
    if (!due && daysAgoCount((c.items || []).map(x => x.t), now, 1) >= (Number(cfg.perContactDaily) || 1)) continue;
    out.push({
      key, uin, kind: isGroup ? 'group' : 'private',
      nick: nickOf(key) || String(uin),
      hours: Math.round(hours * 10) / 10,
      expected: Math.round(expected * 10) / 10,
      intensity: Math.round(intensity * 100) / 100,
      rel, salience, owed,
      tension: Math.round(clamp01(rel.tension) * 100) / 100,
      topic: topicOf(key, { due: due ? { text: due.text } : null }, now),
      due: due ? { id: due.id, text: due.text, dueAt: due.dueAt, overdueHours: due.overdueHours } : null
    });
  }
  out.sort((a, b) => b.intensity - a.intensity || b.hours - a.hours);
  return out;
}

/**
 * 主动了但对方一直没回音的人——可以补一句（最多 followUpMax 次，且只在那之后一两天内）。
 * 判「对方回没回」用 lastTurnAt 与 lastOutAt 比：回过的绝不追问。
 */
function followUpCandidates(opts = {}) {
  loadCfg();
  const now = Number(opts.now) || Date.now();
  const after = Math.max(1, Number(cfg.followUpAfterHours) || 3);
  const out = [];
  let keys = [];
  try { keys = mind.allKeys() || []; } catch (e) { keys = []; }
  for (const key of keys) {
    if (!key) continue;
    const isGroup = key.startsWith('g:');
    if (isGroup && !cfg.allowGroups) continue;
    const uin = isGroup ? key.split(':')[1] : key.slice(2);
    if ((cfg.muteList || []).map(String).includes(String(uin))) continue;
    let st;
    try { st = mind.loadState(key); } catch (e) { continue; }
    if ((Number(st.msgCount) || 0) < (Number(cfg.minTurns) || 6)) continue;
    const c = load(key);
    if (!c.lastOutAt) continue;
    if ((Number(st.lastTurnAt) || 0) > Number(c.lastOutAt)) continue; // 对方回过了，绝不追问
    if (Number(c.followUps) >= (Number(cfg.followUpMax) || 1)) continue;
    const hours = (now - Number(c.lastOutAt)) / 3600e3;
    if (hours < after || hours > after * 8) continue; // 太久就算了，别翻旧账
    const last = (c.items || []).length ? c.items[c.items.length - 1] : null;
    let rel = st.rel || {};
    try { rel = require('./bonds.js').effectiveRel(key, rel, now); } catch (e) { }
    if (clamp01(rel.tension) >= (Number(cfg.tensionBlock) || 0.6)) continue;
    // 补一句是「惦记」的动作，关系一般的人不这么干
    if (clamp01(rel.intimacy) < (Number(cfg.followUpMinIntimacy) || 0.55)) continue;
    out.push({
      key, uin, kind: isGroup ? 'group' : 'private',
      nick: nickOf(key) || String(uin),
      followUp: true, intensity: 1.3,
      hoursSinceOut: Math.round(hours * 10) / 10,
      lastText: String((last && last.text) || '').slice(0, Number(cfg.topicChars) || 60),
      rel, tension: Math.round(clamp01(rel.tension) * 100) / 100
    });
  }
  out.sort((a, b) => b.hoursSinceOut - a.hoursSinceOut);
  return out;
}

/** 现在整体允许主动吗（免打扰 / 全局节流）。 */
function canOutNow(opts = {}) {
  loadCfg();
  const now = Number(opts.now) || Date.now();
  if (cfg.enabled === false) return { ok: false, why: 'disabled' };
  if (inQuiet(now)) return { ok: false, why: 'quiet' };
  const g = loadGlobal();
  // 追一句是「同一次主动的补充」，不占每天主动几个人的名额
  if (!opts.forFollow && daysAgoCount((g.sent || []).map(x => (typeof x === 'number' ? x : x.t)), now, 1) >= (Number(cfg.dailyMax) || 2)) {
    return { ok: false, why: 'daily-cap' };
  }
  const last = (g.sent || []).map(x => (typeof x === 'number' ? x : x.t)).sort((a, b) => b - a)[0] || 0;
  if (last && now - last < (Number(cfg.globalGapHours) || 2) * 3600e3) return { ok: false, why: 'global-gap' };
  return { ok: true };
}

function markOut(key, info = {}) {
  const c = load(key);
  const isFollow = Boolean(info.follow);
  c.lastOutAt = Number(info.at) || Date.now();
  c.count = (Number(c.count) || 0) + 1;
  c.followUps = isFollow ? (Number(c.followUps) || 0) + 1 : 0;
  c.items = (c.items || []).concat([{
    t: c.lastOutAt,
    kind: info.kind || (isFollow ? 'follow' : 'remember'),
    intensity: info.intensity,
    hours: info.hours,
    text: String(info.text || '').slice(0, 120)
  }]).slice(-50);
  save(key, c);
  const g = loadGlobal();
  g.sent = (g.sent || []).concat([{ t: c.lastOutAt, key, intensity: info.intensity }]).slice(-200);
  saveGlobal(g);
}

function reasonOf(cand) {
  if (cand.followUp) {
    return '你 ' + cand.hoursSinceOut + ' 小时前主动找过 TA，说了句「' + (cand.lastText || '') + '」，到现在没回音。';
  }
  const rel = cand.rel || {};
  const parts = [];
  if (clamp01(rel.intimacy) >= 0.6) parts.push('你们挺熟的');
  else if (clamp01(rel.intimacy) >= 0.3) parts.push('你们聊得还行');
  else parts.push('你们还不算熟');
  if (clamp01(rel.warmth) >= 0.6) parts.push('你挺喜欢跟 TA 聊');
  if (clamp01(rel.tension) >= 0.3) parts.push('上次有点别扭');
  if (cand.due) {
    try { parts.push(promises.dueNote({ text: cand.due.text, dueAt: cand.due.dueAt }, Date.now())); } catch (e) { }
  } else if (cand.owed) parts.push('你还欠 TA 一件说过的事');
  return `${parts.join('，')}。${cand.hours} 小时没说话了（按你们的关系，大概 ${cand.expected} 小时会想起 TA）。`;
}

/**
 * 走一轮：挑一个人、让 brain 写开场、发出去。
 * send 由调用方注入（auto-reply 的 send）。dry=true 时只演练不记账。
 */
async function runOnce(opts = {}) {
  loadCfg();
  const now = Number(opts.now) || Date.now();
  const dry = opts.dry !== undefined ? Boolean(opts.dry) : process.env.AUTOREPLY_DRY === '1';
  const gate = canOutNow({ now });
  if (!gate.ok) return { ok: true, sent: [], skipped: gate.why, cands: 0 };
  const cands = plan({ now });
  const follows = followUpCandidates({ now });
  const followGate = follows.length ? canOutNow({ now, forFollow: true }) : { ok: false, why: 'none' };
  const followOk = follows.length > 0 && followGate.ok;
  if (follows.length && !followGate.ok && opts.log) {
    opts.log({ event: 'longing-follow-skip', key: follows[0].key, why: followGate.why });
  }
  const pool = followOk ? [follows[0], ...cands] : cands;
  if (!pool.length) return { ok: true, sent: [], skipped: 'no-one', cands: 0, follow: 0 };
  const sent = [];
  const list = pool.slice(0, Math.max(1, Number(cfg.maxPerCheck) || 1));
  // 主动引用：给每条要发的话配一条「接得上的旧消息」；引用本身失败会降级重发
  let quoteStore = null;
  try { quoteStore = require('./quote.js'); } catch (e) { }
  const wantQuote = opts.noQuote !== true && String(cfg.quoteOut || 'on') !== 'off';
  for (const cand of list) {
    const isFollow = Boolean(cand.followUp);
    let ctx = { nick: cand.nick, kind: cand.kind, proactive: true, reason: reasonOf(cand), due: Boolean(cand.due) };
    if (isFollow) { ctx.followUp = true; ctx.lastText = cand.lastText; }
    if (cand.topic && cand.topic.text) ctx.topic = cand.topic.text;
    try {
      const v = context.view(cand.key);
      ctx.history = v.history || [];
      ctx.summary = v.summary;
      ctx.facts = v.facts;
    } catch (e) { }
    try {
      const bits = mind.promptBits(cand.key, '');
      ctx.mood = bits.mood; ctx.bond = bits.bond; ctx.memories = bits.memories;
    } catch (e) { }
    let out;
    const think = typeof opts.think === 'function' ? opts.think : brain.think;
    try { out = await think(ctx); }
    catch (e) {
      if (opts.log) opts.log({ event: 'longing-brain-error', key: cand.key, err: String((e && e.message) || e).slice(0, 200) });
      continue;
    }
    if (!out || !out.reply) {
      if (opts.log) opts.log({ event: 'longing-skip', key: cand.key, why: 'brain-declined', intensity: cand.intensity });
      continue;
    }
    const d = {
      key: cand.key,
      rule: 'longing',
      target: cand.kind === 'group' ? { type: 'group', id: cand.uin } : { type: 'private', id: cand.uin },
      nick: cand.nick,
      reply: out.reply
    };
    if (out.stickerKey) {
      try {
        const stickers = require('./stickers.js');
        const s = stickers.pick(out.stickerKey);
        if (s) { d.stickerSeg = stickers.segmentOf(s); d.stickerId = s.id; }
      } catch (e) { }
    }
    if (wantQuote && quoteStore && d.target && d.target.type !== 'group') {
      try {
        const q = quoteStore.pickForQuote(cand.key, { topic: cand.topic && cand.topic.text, now, cfg: cfg.quoteOutCfg || {} });
        if (q) { d.quoteSeq = q.seq; d.quoteText = q.text; }
      } catch (e) {
        if (opts.log) opts.log({ event: 'quote-out-error', key: cand.key, err: String((e && e.message) || e).slice(0, 160) });
      }
    }
    let r = null;
    try { r = await opts.send(d); }
    catch (e) {
      if (opts.log) opts.log({ event: 'longing-send-error', key: cand.key, err: String((e && e.message) || e).slice(0, 200) });
      continue;
    }
    // 引用段发不出去（老客户端/seq 失效）就退回不带引用再发一次，别整条丢
    if (r && r.status !== 'ok' && !r.dry && d.quoteSeq) {
      if (opts.log) opts.log({ event: 'quote-out-fallback', key: cand.key, seq: d.quoteSeq, resp: r.status + '/' + (r.retcode == null ? '' : r.retcode) });
      delete d.quoteSeq; delete d.quoteText;
      d._quoted = false;
      try { r = await opts.send(d); } catch (e) { r = { status: 'failed', error: String((e && e.message) || e).slice(0, 120) }; }
    }
    const ok = r && (r.status === 'ok' || r.dry);
    if (!ok) {
      if (opts.log) opts.log({ event: 'longing-send-failed', key: cand.key, resp: r && (r.status + '/' + (r.retcode == null ? '' : r.retcode)) });
      continue;
    }
    if (!dry) markOut(cand.key, { at: now, intensity: cand.intensity, hours: cand.hours, text: out.reply, follow: isFollow, kind: isFollow ? 'follow' : (cand.due ? 'due' : 'remember') });
    // 「到日子的承诺」提醒过一次就记账，免得一天念三遍（dry 不记账）
    if (!dry && cand.due && cand.due.id) {
      try {
        const n = promises.markReminded(cand.key, [cand.due.id]);
        if (opts.log) opts.log({ event: 'due-reminded', key: cand.key, id: cand.due.id, n, text: cand.due.text });
      } catch (e) { if (opts.log) opts.log({ event: 'due-reminded-error', key: cand.key, err: String(e && e.message).slice(0, 120) }); }
    } else if (dry && cand.due && opts.log) {
      opts.log({ event: 'due-skip', key: cand.key, why: 'dry', text: cand.due.text });
    }
    sent.push({ key: cand.key, intensity: cand.intensity, hours: cand.hours, reply: out.reply, dry: Boolean(dry), follow: isFollow, topic: cand.topic ? cand.topic.kind : null, quoted: d.quoteSeq || null });
    if (opts.log) opts.log({ event: isFollow ? 'longing-follow-out' : 'longing-out', key: cand.key, intensity: cand.intensity, hours: cand.hours, dry: Boolean(dry), follow: isFollow, topic: cand.topic ? cand.topic.kind : null, quoted: d.quoteSeq || null, text: out.reply });
  }
  return { ok: true, sent, skipped: sent.length ? '' : 'declined', follow: sent.filter(x => x.follow).length };
}

/** 给人看的清单：每个会话的想念进度。 */
function list(opts = {}) {
  loadCfg();
  const now = Number(opts.now) || Date.now();
  const rows = [];
  let keys = [];
  try { keys = mind.allKeys() || []; } catch (e) { }
  for (const key of keys) {
    if (!key) continue;
    let st;
    try { st = mind.loadState(key); } catch (e) { continue; }
    let hist = [];
    try { hist = context.view(key).history || []; } catch (e) { }
    const lastAt = Math.max(Number(st.lastTurnAt) || 0, hist.length ? Number(hist[hist.length - 1].t) || 0 : 0);
    const hours = lastAt ? (now - lastAt) / 3600e3 : 0;
    const rel = st.rel || {};
    const salience = Number(st.lastAffect && st.lastAffect.salience) || 0;
    // 关系分档：一般偏熟的期望间隔要放大，太生的干脆不算「惦记」
    const intimacy = clamp01(rel.intimacy);
    const acqFactor = intimacy < (Number(cfg.acquaintanceIntimacy) || 0.75) ? (Number(cfg.acquaintanceFactor) || 6) : 1;
    const tooFar = intimacy < (Number(cfg.minIntimacy) || 0.55);
    const expected = expectedHours(rel, salience) * acqFactor;
    const intensity = (lastAt && !tooFar) ? intensityOf({ hours, expected, salience }) : 0;
    const c = load(key);
    rows.push({
      key, nick: nickOf(key) || key,
      turns: Number(st.msgCount) || 0,
      rel: { warmth: rel.warmth, trust: rel.trust, intimacy: rel.intimacy, tension: rel.tension },
      idleHours: Math.round(hours * 10) / 10,
      expectedHours: Math.round(expected * 10) / 10,
      intensity: Math.round(intensity * 100) / 100,
      intimacy: Math.round(intimacy * 100) / 100,
      tier: intimacy >= (Number(cfg.acquaintanceIntimacy) || 0.75) ? 'close' : 'acquaintance',
      tooFar,  // 关系一般：不会主动（约定的事除外）
      due: !tooFar && intensity >= (Number(cfg.intensityThreshold) || 1),
      lastOutAt: c.lastOutAt || 0,
      outs: Number(c.count) || 0
    });
  }
  rows.sort((a, b) => b.intensity - a.intensity);
  return rows;
}

module.exports = {
  DEFAULTS, configure, options, loadCfg, CFG_PATH,
  dirOf, fileOf, slugOf, globalFile, load, save, loadGlobal, saveGlobal,
  expectedHours, intensityOf, inQuiet, canOutNow, plan, followUpCandidates, topicOf, runOnce, markOut, list, nickOf, reasonOf
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'list') {
    const rows = list();
    if (!rows.length) console.log('（还没有可主动联系的会话）');
    else for (const r of rows) {
      const tierTxt = r.tooFar ? '关系一般（不会主动）' : (r.tier === 'close' ? '熟' : '一般偏熟');
      console.log(`${r.nick} ${r.key}｜${tierTxt}｜亲密度 ${r.intimacy}｜聊过 ${r.turns} 轮｜静了 ${r.idleHours}h / 期望 ${r.expectedHours}h｜想念 ${r.intensity}${r.due ? ' ← 到点了' : ''}`);
    }
  } else if (cmd === 'plan') out(plan());
  else if (cmd === 'why') {
    // 逐闸门解释：这个人为什么还没被想起 / 为什么到点了却不能开口
    const key = argv[1];
    loadCfg();
    const now = Date.now();
    const isGroup = key.startsWith('g:');
    const st = mind.loadState(key, isGroup ? 'group' : 'private');
    const hist = (context.view(key).history) || [];
    const lastTurnT = hist.length ? Number(hist[hist.length - 1].t) || 0 : 0;
    const lastAt = Math.max(Number(st.lastTurnAt) || 0, lastTurnT);
    const hours = lastAt ? (now - lastAt) / 3600e3 : 0;
    let rel = st.rel || {};
    try { rel = require('./bonds.js').effectiveRel(key, rel, now); } catch (e) { }
    const salience = Number(st.lastAffect && st.lastAffect.salience) || 0;
    let due = null;
    try { const ds = promises.dueItems(key, { now }); if (ds.length) due = ds[0]; } catch (e) { }
    const expected = expectedHours(rel, salience);
    let owed = false;
    try { owed = promises.list(key).some(x => x.status === 'open'); } catch (e) { }
    const intensity = intensityOf({ hours, expected, salience, owed });
    const c = load(key);
    const gate = canOutNow({ now });
    const round1 = (x) => Math.round(Number(x) * 10) / 10;
    const checks = [
      ['总开关开着', cfg.enabled !== false],
      ['聊过 ' + (Number(st.msgCount) || 0) + ' 轮（≥' + cfg.minTurns + '）', (Number(st.msgCount) || 0) >= (Number(cfg.minTurns) || 6)],
      ['关系够近（亲密度 ' + (Math.round(clamp01(rel.intimacy) * 100) / 100) + ' ≥ ' + (cfg.minIntimacy || 0.55) + '）', Boolean(due) || clamp01(rel.intimacy) >= (Number(cfg.minIntimacy) || 0.55)],
      ['安静 ' + round1(hours) + 'h（≥' + cfg.minIdleHours + '）', hours >= (Number(cfg.minIdleHours) || 2) || Boolean(due)],
      ['关系不僵（tension ' + (Math.round(clamp01(rel.tension) * 100) / 100) + ' < ' + cfg.tensionBlock + '）', Boolean(due) || clamp01(rel.tension) < (Number(cfg.tensionBlock) || 0.6)],
      ['想念 ' + (Math.round(intensity * 100) / 100) + '（≥' + cfg.intensityThreshold + '）', intensity >= (Number(cfg.intensityThreshold) || 1)],
      ['距上次主动够久', Boolean(due) || !c.lastOutAt || now - c.lastOutAt >= (Number(cfg.perContactHours) || 20) * 3600e3],
      ['今天还没主动过', Boolean(due) || daysAgoCount((c.items || []).map(x => x.t), now, 1) < (Number(cfg.perContactDaily) || 1)],
      ['全局允许开口（' + gate.why + '）', gate.ok]
    ];
    out({
      key, nick: nickOf(key) || key, rel, salience,
      idleHours: round1(hours), expectedHours: round1(expected), intensity: Math.round(intensity * 100) / 100,
      due: due ? { text: due.text, dueAt: due.dueAt } : null,
      lastOutAt: c.lastOutAt, followUps: c.followUps || 0,
      gate, checks, pendingFollowUp: followUpCandidates({ now }).filter(x => x.key === key)
    });
  } else if (cmd === 'follow') {
    const rows = followUpCandidates({});
    if (!rows.length) console.log('（暂时没有该补一句的人）');
    else for (const r of rows) console.log(r.nick + ' ' + r.key + '｜' + r.hoursSinceOut + 'h 前主动过｜上次：「' + r.lastText + '」');
  }
  else if (cmd === 'sim') {
    const key = argv[1];
    const st = mind.loadState(key);
    const rel = st.rel || {};
    const sal = Number(st.lastAffect && st.lastAffect.salience) || 0;
    const hours = ((Date.now() - (Number(st.lastTurnAt) || Date.now())) / 3600e3);
    const expected = expectedHours(rel, sal);
    out({ key, rel, salience: sal, idleHours: Math.round(hours * 10) / 10, expectedHours: Math.round(expected * 10) / 10, intensity: Math.round(intensityOf({ hours, expected, salience: sal }) * 100) / 100 });
  } else if (cmd === 'run') {
    // 默认演练；加 --send 才真发
    const real = argv.includes('--send');
    const ar = require('./auto-reply.js');
    runOnce({ dry: !real, send: ar.send, log: (o) => console.log(JSON.stringify(o)) })
      .then(r => out(r))
      .catch(e => { console.error(e); process.exit(1); });
  }
}
