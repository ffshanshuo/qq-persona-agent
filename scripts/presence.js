'use strict';
/**
 * presence.js —— 心情状态：让 QQ 上那个「在线状态」跟着心情走，而不是永远挂着「在线」。
 *
 * 能做什么（能力来自 NapCat 的 set_online_status，源码里自带状态表）：
 *   - 在线/离开/忙碌/请勿打扰/隐身 这几档基础状态；
 *   - 加上「心情」扩展状态：恋爱中、元气满满、emo中、一言难尽、想静静、无聊中、
 *     学习中、搬砖中、肝作业、摸鱼中、熬夜中、睡觉中、追剧中、听歌中、timi中……
 *
 * 做什么决定：把内部状态（心情 PAD、回声走势、此刻的活动、有没有恋人、风控等级）
 * 翻成一个具体的状态码，然后在**节流**之后调用接口。
 *
 * 纪律：
 *   - 同一个状态至少挂 3 小时，一天最多换 4 次（换太勤像在抽风）；
 *   - 只在有理由时换，每次变化都记 `logs/presence.jsonl`（after 能看出为什么）；
 *   - 连续两次设置失败就自动「只记录不动手」（`presence-paused`），不再骚扰接口；
 *   - 不做 DIY 自定义状态（NapCat 需要 face_config.json 里的 QSid，本机没有这个文件）。
 *
 * 纯本地规则，不调模型。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const store = require('../lib/store.js');

const DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(DIR, 'presence-state.json');
const LOG_FILE = path.join(DIR, 'presence.jsonl');
const CFG_PATH = path.join(ROOT, 'config', 'presence.json');

/** 基础状态（NapCat 源码状态表中的 status 值） */
const BASE = {
  online: { status: 10, label: '在线' },
  qme: { status: 60, label: 'Q我吧' },
  away: { status: 30, label: '离开' },
  busy: { status: 50, label: '忙碌' },
  dnd: { status: 70, label: '请勿打扰' },
  invisible: { status: 40, label: '隐身' }
};

/** 心情/活动扩展状态（status 固定 10，靠 ext_status 显示） */
const MOODS = {
  inLove: { ext: 1051, label: '恋爱中' },
  energetic: { ext: 1058, label: '元气满满' },
  flying: { ext: 1056, label: '嗨到飞起' },
  emo: { ext: 1401, label: 'emo中' },
  complicated: { ext: 1063, label: '一言难尽' },
  quiet: { ext: 1061, label: '想静静' },
  enlightened: { ext: 2013, label: '我想开了' },
  bored: { ext: 1060, label: '无聊中' },
  studying: { ext: 1018, label: '学习中' },
  working: { ext: 2023, label: '搬砖中' },
  homework: { ext: 2012, label: '肝作业' },
  slacking: { ext: 1300, label: '摸鱼中' },
  nightOwl: { ext: 1032, label: '熬夜中' },
  sleeping: { ext: 1016, label: '睡觉中' },
  bingeWatching: { ext: 1021, label: '追剧中' },
  listeningMusic: { ext: 1028, label: '听歌中' },
  gaming: { ext: 1027, label: 'timi中' }
};

const DEFAULTS = {
  enabled: true,
  everyMin: 30,          // 多久检查一次（timers 用）
  minHoldHours: 3,       // 同一状态至少挂多久
  maxPerDay: 4,          // 一天最多换几次
  batteryStatus: 0,      // 0 = 不显示电量
  coolingStatus: 'invisible', // 风控/掉线时对外显示什么
  sleepyPad: -0.25,      // 心情低到什么程度算「emo」
  activityMap: {
    写代码: 'working', 调试: 'homework', 看文档: 'studying', 看书: 'studying',
    吃早饭: 'slacking', 吃饭: 'slacking', 散步: 'slacking', 午休: 'slacking',
    看剧: 'bingeWatching', 听歌: 'listeningMusic', 听歌发呆: 'listeningMusic', 刷手机: 'slacking'
  },
  nightOwlFrom: 0,       // 0–6 点算熬夜
  nightOwlTo: 6,
  watchFrom: 22,         // 22–24 点算追剧
  watchTo: 24,

  // ── 用户可改的个性化覆盖：key 是「状态 id」，value 是 {status, ext, label} ──
  overrides: {}
};

function loadCfg() {
  const c = store.readJson(CFG_PATH, {}, { onError: () => { } }) || {};
  const cfg = { ...DEFAULTS, ...c };
  cfg.activityMap = { ...DEFAULTS.activityMap, ...(c.activityMap || {}) };
  cfg.overrides = { ...(c.overrides || {}) };
  return cfg;
}
function configure(over) {
  const cur = loadCfg();
  const next = { ...cur, ...(over || {}) };
  store.ensureDir(path.dirname(CFG_PATH));
  store.writeJson(CFG_PATH, next);
  return next;
}
function options() { return loadCfg(); }

function dirOf() { return process.env.QQPRESENCE_DIR || DIR; }
function stateFile() { return path.join(dirOf(), 'presence-state.json'); }
function logFile() { return path.join(dirOf(), 'presence.jsonl'); }

function blankState() {
  return {
    current: null,      // { status, ext, label, at, why }
    lastSetAt: 0,
    today: { date: dayKey(Date.now()), count: 0 },
    fails: 0,
    paused: false,
    history: []
  };
}
function dayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function loadState(now) {
  const raw = store.readJson(stateFile(), null, { onError: () => { } });
  const st = { ...blankState(), ...(raw || {}) };
  st.today = st.today && st.today.date ? st.today : { date: dayKey(now), count: 0 };
  if (st.today.date !== dayKey(now)) st.today = { date: dayKey(now), count: 0 };
  st.history = Array.isArray(st.history) ? st.history : [];
  return st;
}
function saveState(st) {
  store.ensureDir(dirOf());
  return store.writeJson(stateFile(), st);
}
function appendLog(rec) {
  store.ensureDir(dirOf());
  store.appendJsonl(logFile(), rec);
}

/**
 * 内部信号 → 状态。signals:
 *   { riskLevel, pad:{p,a,d}, mood, echoColdStreak, selfKind, selfActivity, hour, lover, cooling, minute }
 * 返回 { status, ext, label, id, why }
 */
function mapStatus(signals = {}, cfg) {
  const o = cfg || options();
  const s = signals;
  const hour = Number.isFinite(Number(s.hour)) ? Number(s.hour) : new Date().getHours();
  const pad = s.pad || {};
  const pick = (base, moodKey, why) => {
    const ov = (o.overrides && (o.overrides[moodKey] || o.overrides[base])) || null;
    const b = BASE[base] || BASE.online;
    const m = moodKey ? MOODS[moodKey] : null;
    const status = ov && ov.status != null ? Number(ov.status) : (m ? 10 : b.status);
    const ext = ov && ov.ext != null ? Number(ov.ext) : (m ? m.ext : 0);
    const label = (ov && ov.label) || (m ? `${m.label}` : b.label);
    return { status, ext, label, id: moodKey || base, why };
  };

  // 1) 风控冷却 / 掉线 → 对外像人不在
  if (String(s.riskLevel || 'normal') !== 'normal') {
    return pick(o.coolingStatus || 'invisible', '', `风控等级 ${s.riskLevel}：先隐身`);
  }
  // 2) 有恋人且心情不是低谷 → 恋爱中
  const p = Number(pad.p);
  if (s.lover && !(Number.isFinite(p) && p <= Number(o.sleepyPad))) {
    return pick('online', 'inLove', s.cooling ? '恋人（但正在冷战）' : '有恋人');
  }
  // 3) 心情低谷 / 对方连着冷淡 → emo中
  if ((Number.isFinite(p) && p <= Number(o.sleepyPad)) || Number(s.echoColdStreak) >= 2) {
    return pick('online', 'emo', Number(s.echoColdStreak) >= 2 ? '对方连着冷了几回' : '心情低落');
  }
  // 4) 我正在专注做某件事 → 学习中 / 搬砖中 / 肝作业
  if (s.selfKind === 'focus' && s.selfActivity) {
    const mapped = (o.activityMap && o.activityMap[s.selfActivity]) || 'working';
    return pick('online', mapped, `正在${s.selfActivity}`);
  }
  // 5) 深夜 / 追剧时段
  const nightFrom = Number(o.nightOwlFrom) || 0;
  const nightTo = Number(o.nightOwlTo) || 6;
  if (hour >= nightFrom && hour < nightTo) {
    if (String(s.mood || '').includes('困')) return pick('online', 'sleeping', '这个点困了');
    return pick('online', 'nightOwl', '深夜还在忙');
  }
  const wFrom = Number(o.watchFrom) || 22;
  const wTo = Number(o.watchTo) || 24;
  if (hour >= wFrom && hour < wTo) return pick('online', 'bingeWatching', '晚上在追剧');
  // 6) 摸鱼（非专注的日常活动）
  if (s.selfKind === 'light') {
    return pick('online', 'slacking', s.selfActivity ? `在${s.selfActivity}` : '闲着');
  }
  // 7) 兜底
  return pick('online', '', '没什么特别的');
}

/** 从各模块现读信号（都做 try/catch，任何一个模块坏了不影响状态） */
function readSignals(now) {
  const t = Number(now) || Date.now();
  const sig = { hour: new Date(t).getHours(), riskLevel: 'normal', pad: {}, mood: '', echoColdStreak: 0, selfKind: '', selfActivity: '', lover: false, cooling: false };
  try { sig.riskLevel = (require('./risk.js').status({ now: t }) || {}).level || 'normal'; } catch (e) { }
  try {
    const mind = require('./mind.js');
    const keys = mind.allKeys ? mind.allKeys() : [];
    const mine = keys.find(k => /^p:/.test(k) && k.includes('__')) || null;
    // 自己号的状态按「私聊里最近说话那个人的 mind」读，拿不到就用空
    const st = mine ? mind.loadState(mine) : null;
    if (st && st.pad) sig.pad = st.pad;
  } catch (e) { }
  try {
    const echo = require('./echo.js');
    const list = echo.list ? echo.list() : [];
    if (Array.isArray(list) && list.length) {
      const maxCold = list.reduce((a, b) => Math.max(a, Number(b.streakCold) || 0), 0);
      sig.echoColdStreak = maxCold;
    }
  } catch (e) { }
  try {
    const self = require('./self.js');
    const st = self.state ? self.state(t) : null;
    if (st) { sig.selfKind = st.kind || ''; sig.selfActivity = st.activity || ''; }
  } catch (e) { }
  try {
    const ties = require('./ties.js');
    const g = ties.loadGlobal();
    sig.lover = !!(g && g.lover);
    if (sig.lover) {
      const tie = ties.load(g.lover.key);
      sig.cooling = tie.phase === 'cooling';
    }
  } catch (e) { }
  return sig;
}

/**
 * 决定这一刻该不该换、换成什么。
 * @param {object} opts { now, dry, force, signals, cfg, call }
 * @returns {{ok:boolean, skipped?:string, why:string, from?:object, to?:object, dry?:boolean}}
 */
async function consider(opts = {}) {
  const t = Number(opts.now) || Date.now();
  const o = opts.cfg || options();
  if (o.enabled === false) return { ok: false, skipped: 'disabled', why: '总开关关着' };
  const st = loadState(t);
  if (st.paused) return { ok: false, skipped: 'paused', why: '之前连续设置失败，已暂停（删 logs/presence-state.json 可恢复）' };

  const sig = opts.signals || readSignals(t);
  const want = mapStatus(sig, o);
  const cur = st.current;

  // 同状态不动；换新状态要过「至少挂 3 小时」
  if (cur && cur.status === want.status && Number(cur.ext || 0) === Number(want.ext || 0)) {
    return { ok: false, skipped: 'same', why: '已经是这个状态了', to: want, current: cur };
  }
  const holdMs = (Number(o.minHoldHours) || 3) * 3600e3;
  if (cur && t - Number(cur.at || 0) < holdMs && !opts.force) {
    return { ok: false, skipped: 'hold', why: `刚换过 ${Math.round((t - cur.at) / 60000)} 分钟，先挂够 ${o.minHoldHours} 小时`, to: want, current: cur };
  }
  const cap = Number(o.maxPerDay);
  if (cap > 0 && Number(st.today.count) >= cap && !opts.force) {
    return { ok: false, skipped: 'daily-cap', why: `今天已经换了 ${st.today.count} 次`, to: want, current: cur };
  }

  if (opts.dry) {
    appendLog({ at: new Date(t).toISOString(), event: 'presence-dry', to: want, from: cur, why: want.why });
    return { ok: true, dry: true, from: cur, to: want, why: want.why };
  }

  // 真调接口
  let resp = null;
  try {
    const call = opts.call || require('./qq.js').call;
    // 必须 await：qq.call 返回 Promise，漏了 await 会拿到 Promise 对象，
    // 判定 resp.status 永远 undefined → 每次都被当成「设置失败」并误开 paused（2026-10-25 真 bug）
    resp = await call('set_online_status', {
      status: Number(want.status) || 10,
      ext_status: Number(want.ext) || 0,
      battery_status: Number(o.batteryStatus) || 0
    });
  } catch (e) {
    resp = { status: 'failed', error: String(e && e.message) };
  }
  const okc = !!(resp && (resp.status === 'ok' || resp.retcode === 0));
  if (!okc) {
    st.fails = Number(st.fails || 0) + 1;
    if (st.fails >= 2) { st.paused = true; appendLog({ at: new Date(t).toISOString(), event: 'presence-paused', fails: st.fails, resp: resp && resp.error ? String(resp.error).slice(0, 120) : resp }); }
    saveState(st);
    appendLog({ at: new Date(t).toISOString(), event: 'presence-fail', to: want, from: cur, resp: resp && (resp.error || resp.message || resp.retcode) });
    return { ok: false, skipped: 'failed', why: '设置失败：' + (resp && (resp.error || resp.message || 'unknown')), to: want };
  }

  st.current = { status: want.status, ext: want.ext, label: want.label, id: want.id, at: t, why: want.why };
  st.lastSetAt = t;
  st.fails = 0;
  if (st.today.date !== dayKey(t)) st.today = { date: dayKey(t), count: 0 };
  st.today.count = Number(st.today.count || 0) + 1;
  st.history = (st.history || []).concat([{ at: t, status: want.status, ext: want.ext, label: want.label, why: want.why }]).slice(-50);
  saveState(st);
  appendLog({ at: new Date(t).toISOString(), event: 'presence-change', from: cur, to: st.current, why: want.why });
  return { ok: true, from: cur, to: st.current, why: want.why };
}

/** 直接指定一个状态（手动/调试用），同样走节流与记账 */
async function setById(id, opts = {}) {
  const o = opts.cfg || options();
  const key = String(id || '');
  const base = BASE[key];
  const mood = MOODS[key];
  if (!base && !mood) return { ok: false, why: '未知状态：' + key };
  const want = base
    ? { status: base.status, ext: 0, label: base.label, id: key, why: '手动指定' }
    : { status: 10, ext: mood.ext, label: mood.label, id: key, why: '手动指定' };
  const call = opts.call || require('./qq.js').call;
  const t = Number(opts.now) || Date.now();
  const resp = await call('set_online_status', { status: want.status, ext_status: want.ext, battery_status: Number(o.batteryStatus) || 0 });
  const okc = !!(resp && (resp.status === 'ok' || resp.retcode === 0));
  if (!okc) return { ok: false, why: '设置失败', resp };
  const st = loadState(t);
  st.current = { ...want, at: t };
  st.lastSetAt = t;
  if (st.today.date !== dayKey(t)) st.today = { date: dayKey(t), count: 0 };
  st.today.count = Number(st.today.count || 0) + 1;
  st.history = (st.history || []).concat([{ at: t, ...want }]).slice(-50);
  saveState(st);
  appendLog({ at: new Date(t).toISOString(), event: 'presence-manual', to: st.current });
  return { ok: true, to: st.current };
}

function status(opts = {}) {
  const t = Number(opts.now) || Date.now();
  const st = loadState(t);
  const sig = opts.signals || readSignals(t);
  const want = mapStatus(sig, opts.cfg || options());
  return {
    enabled: (opts.cfg || options()).enabled !== false,
    current: st.current,
    minutesSince: st.current ? Math.round((t - st.current.at) / 60000) : null,
    todayCount: st.today.count,
    paused: !!st.paused,
    fails: st.fails || 0,
    want,
    signals: { hour: sig.hour, riskLevel: sig.riskLevel, pad: sig.pad, echoColdStreak: sig.echoColdStreak, selfKind: sig.selfKind, selfActivity: sig.selfActivity, lover: sig.lover, cooling: sig.cooling }
  };
}

function reset() {
  try { fs.unlinkSync(stateFile()); } catch (e) { }
  return true;
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'status' || !cmd) console.log(JSON.stringify(status(), null, 2));
  else if (cmd === 'map') console.log(JSON.stringify(mapStatus(readSignals(Date.now())), null, 2));
  else if (cmd === 'dry') console.log(JSON.stringify(consider({ dry: true, force: true }), null, 2));
  else if (cmd === 'apply') console.log(JSON.stringify(consider({ force: true }), null, 2));
  else if (cmd === 'set') console.log(JSON.stringify(setById(arg), null, 2));
  else if (cmd === 'reset') console.log(JSON.stringify({ ok: reset() }));
  else if (cmd === 'list') {
    console.log(JSON.stringify({
      base: Object.entries(BASE).map(([k, v]) => ({ id: k, ...v })),
      moods: Object.entries(MOODS).map(([k, v]) => ({ id: k, ...v }))
    }, null, 2));
  } else console.log('用法: node scripts/presence.js <status|map|dry|apply|set <id>|reset|list>');
}
if (require.main === module) main();

module.exports = {
  DEFAULTS, BASE, MOODS, loadCfg, configure, options, CFG_PATH, dirOf, stateFile, logFile,
  blankState, loadState, saveState, dayKey, appendLog, mapStatus, readSignals, consider, setById, status, reset
};
