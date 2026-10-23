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

function blank(key) { return { key, lastOutAt: 0, count: 0, items: [] }; }
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
  const base = (cfg.baseHours || 36) * Math.exp(-(cfg.intimacyDecay || 2.4) * clamp01(rel.intimacy));
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
    if (hours < (Number(cfg.minIdleHours) || 2) && !due) continue;
    let rel = st.rel || {};
    try { rel = require('./bonds.js').effectiveRel(key, rel, now); } catch (e) { }
    const salience = Number(st.lastAffect && st.lastAffect.salience) || 0;
    let owed = false;
    try { owed = promises.list(key).some(x => x.status === 'open'); } catch (e) { }
    const expected = expectedHours(rel, salience);
    let intensity = intensityOf({ hours, expected, salience, owed });
    if (due) intensity = Math.max(1.25, intensity); // 到日子的承诺优先
    if (intensity < (Number(cfg.intensityThreshold) || 1)) continue;
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
      rel, salience, owed, due: due ? { id: due.id, text: due.text, dueAt: due.dueAt, overdueHours: due.overdueHours } : null
    });
  }
  out.sort((a, b) => b.intensity - a.intensity || b.hours - a.hours);
  return out;
}

/** 现在整体允许主动吗（免打扰 / 全局节流）。 */
function canOutNow(opts = {}) {
  loadCfg();
  const now = Number(opts.now) || Date.now();
  if (cfg.enabled === false) return { ok: false, why: 'disabled' };
  if (inQuiet(now)) return { ok: false, why: 'quiet' };
  const g = loadGlobal();
  if (daysAgoCount((g.sent || []).map(x => (typeof x === 'number' ? x : x.t)), now, 1) >= (Number(cfg.dailyMax) || 2)) {
    return { ok: false, why: 'daily-cap' };
  }
  const last = (g.sent || []).map(x => (typeof x === 'number' ? x : x.t)).sort((a, b) => b - a)[0] || 0;
  if (last && now - last < (Number(cfg.globalGapHours) || 2) * 3600e3) return { ok: false, why: 'global-gap' };
  return { ok: true };
}

function markOut(key, info = {}) {
  const c = load(key);
  c.lastOutAt = Number(info.at) || Date.now();
  c.count = (Number(c.count) || 0) + 1;
  c.items = (c.items || []).concat([{
    t: c.lastOutAt,
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
  if (!cands.length) return { ok: true, sent: [], skipped: 'no-one', cands: 0 };
  const sent = [];
  const list = cands.slice(0, Math.max(1, Number(cfg.maxPerCheck) || 1));
  for (const cand of list) {
    let ctx = { nick: cand.nick, kind: cand.kind, proactive: true, reason: reasonOf(cand), due: Boolean(cand.due) };
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
    let r = null;
    try { r = await opts.send(d); }
    catch (e) {
      if (opts.log) opts.log({ event: 'longing-send-error', key: cand.key, err: String((e && e.message) || e).slice(0, 200) });
      continue;
    }
    const ok = r && (r.status === 'ok' || r.dry);
    if (!ok) {
      if (opts.log) opts.log({ event: 'longing-send-failed', key: cand.key, resp: r && (r.status + '/' + (r.retcode == null ? '' : r.retcode)) });
      continue;
    }
    if (!dry) markOut(cand.key, { at: now, intensity: cand.intensity, hours: cand.hours, text: out.reply });
    // 「到日子的承诺」提醒过一次就记账，免得一天念三遍（dry 不记账）
    if (!dry && cand.due && cand.due.id) {
      try {
        const n = promises.markReminded(cand.key, [cand.due.id]);
        if (opts.log) opts.log({ event: 'due-reminded', key: cand.key, id: cand.due.id, n, text: cand.due.text });
      } catch (e) { if (opts.log) opts.log({ event: 'due-reminded-error', key: cand.key, err: String(e && e.message).slice(0, 120) }); }
    } else if (dry && cand.due && opts.log) {
      opts.log({ event: 'due-skip', key: cand.key, why: 'dry', text: cand.due.text });
    }
    sent.push({ key: cand.key, intensity: cand.intensity, hours: cand.hours, reply: out.reply, dry: Boolean(dry) });
    if (opts.log) opts.log({ event: 'longing-out', key: cand.key, intensity: cand.intensity, hours: cand.hours, dry: Boolean(dry), text: out.reply });
  }
  return { ok: true, sent, skipped: sent.length ? '' : 'declined' };
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
    const expected = expectedHours(rel, salience);
    const intensity = lastAt ? intensityOf({ hours, expected, salience }) : 0;
    const c = load(key);
    rows.push({
      key, nick: nickOf(key) || key,
      turns: Number(st.msgCount) || 0,
      rel: { warmth: rel.warmth, trust: rel.trust, intimacy: rel.intimacy, tension: rel.tension },
      idleHours: Math.round(hours * 10) / 10,
      expectedHours: Math.round(expected * 10) / 10,
      intensity: Math.round(intensity * 100) / 100,
      due: intensity >= (Number(cfg.intensityThreshold) || 1),
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
  expectedHours, intensityOf, inQuiet, canOutNow, plan, runOnce, markOut, list, nickOf, reasonOf
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'list') {
    const rows = list();
    if (!rows.length) console.log('（还没有可主动联系的会话）');
    else for (const r of rows) {
      console.log(`${r.nick} ${r.key}｜聊过 ${r.turns} 轮｜静了 ${r.idleHours}h / 期望 ${r.expectedHours}h｜想念 ${r.intensity}${r.due ? ' ← 到点了' : ''}`);
    }
  } else if (cmd === 'plan') out(plan());
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
