#!/usr/bin/env node
'use strict';
// 风控闸门（risk.js）
// 目的：把「可能导致账号被风控的动作」收进一个地方管：每日登录/重启额度、掉线熔断、冷却期。
// 2026-10-23 实测教训：一天内被 watchdog 连环重启十几次 + 主动发消息，直接触发风控（手机端提示「身份验证信息已失效」）。
// 结论：能否发消息不取决于「这条消息重不重要」，而取决于「客户端是否稳、登录是否频繁、动作是否像人」。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'risk.json');

const DEFAULTS = {
  enabled: true,
  // 每日额度（跨天自动归零）
  loginPerDayMax: 3, // 一天最多启动登录 3 次（含 watchdog 重启）
  restartPerDayMax: 2, // 一天最多自动重启 2 次
  loginGapMin: 10, // 两次登录尝试至少间隔 10 分钟（NapCat 官方排障文档：5~10 分钟）
  // 掉线熔断
  dropWindowMin: 30,
  dropThreshold: 2, // 30 分钟内掉线 2 次 → 进入冷却
  coolingHours: 6, // 掉线熔断冷却
  coolingHoursAfterLoginFail: 12, // 登录失败（要扫码/要验证）冷却
  // 冷却期间
  allowReplyWhileCooling: false, // 冷却期连被动回复也停（只保留手动）
  // 主动动作通道
  requirePhoneChannelForProactive: true, // 主动开场/发说说/改资料/加好友 必须走手机官方客户端（A 通道）
  allowProactiveOnClient: false // 明确禁止用 NapCat 客户端主动发（默认关）
};

function dirOf() { return process.env.QQRISK_DIR || path.join(ROOT, 'logs', 'risk'); }
function fileOf() { return path.join(dirOf(), 'state.json'); }
function nowMs(now) { return typeof now === 'number' ? now : Date.now(); }
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let overrides = {};
function configure(over) { overrides = Object.assign({}, over || {}); }
function loadCfg(refresh) {
  const base = Object.assign({}, DEFAULTS);
  try {
    if (fs.existsSync(CFG_PATH)) Object.assign(base, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')));
  } catch (e) { /* 配置坏了就用默认值，绝不能因此把闸门关掉 */ }
  Object.assign(base, overrides);
  return base;
}

function blank() {
  return {
    level: 'normal',
    coolingUntil: 0,
    coolingWhy: '',
    counts: { date: dayKey(Date.now()), login: 0, restart: 0 },
    lastLoginAt: 0,
    lastRestartAt: 0,
    drops: [],
    lastChangeAt: 0,
    history: []
  };
}

function load() {
  const f = fileOf();
  try {
    if (!fs.existsSync(f)) return blank();
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    const b = blank();
    const out = Object.assign(b, s);
    out.counts = Object.assign(b.counts, s.counts || {});
    out.drops = Array.isArray(s.drops) ? s.drops : [];
    out.history = Array.isArray(s.history) ? s.history : [];
    return out;
  } catch (e) {
    // 坏文件改名留证，不当成「没问题」
    try { if (fs.existsSync(f)) fs.renameSync(f, f + '.bad-' + Date.now()); } catch (e2) { }
    return blank();
  }
}

function save(st) {
  const f = fileOf();
  const dir = dirOf();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  const body = JSON.stringify(st, null, 2);
  for (let i = 0; i < 4; i++) {
    const tmp = f + '.' + process.pid + '.' + i + '.tmp';
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, f);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { }
      const until = Date.now() + 15 + 25 * i;
      while (Date.now() < until) { }
    }
  }
  try { fs.writeFileSync(f, body); return true; } catch (e) {
    try { fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'logs', 'risk-error.log'), new Date().toISOString() + ' save failed: ' + (e.message || e) + '\n'); } catch (e2) { }
    return false;
  }
}

function refreshCounts(st, now) {
  const d = dayKey(now);
  if (!st.counts || st.counts.date !== d) st.counts = { date: d, login: 0, restart: 0 };
  return st;
}

function levelOf(st, now) {
  if (st.coolingUntil && st.coolingUntil > now) return 'cooling';
  const cfg = loadCfg();
  if (st.counts.login >= cfg.loginPerDayMax || st.counts.restart >= cfg.restartPerDayMax) return 'caution';
  return 'normal';
}

function enterCooling(st, hours, why, now) {
  const n = nowMs(now);
  st.coolingUntil = n + hours * 3600 * 1000;
  st.coolingWhy = String(why || '');
  st.lastChangeAt = n;
  st.history.push({ t: n, event: 'cooling', hours, why: st.coolingWhy });
  if (st.history.length > 60) st.history = st.history.slice(-60);
  return st;
}

function noteDrop(reason, now) {
  const n = nowMs(now);
  const cfg = loadCfg();
  const st = refreshCounts(load(), n);
  st.drops = (st.drops || []).filter((t) => n - t <= cfg.dropWindowMin * 60 * 1000);
  st.drops.push(n);
  st.history.push({ t: n, event: 'drop', reason: String(reason || '') });
  if (st.history.length > 60) st.history = st.history.slice(-60);
  let cooled = false;
  if (st.drops.length >= cfg.dropThreshold && !(st.coolingUntil > n)) {
    enterCooling(st, cfg.coolingHours, '掉线 ' + st.drops.length + ' 次/' + cfg.dropWindowMin + ' 分钟：' + (reason || ''), n);
    cooled = true;
  }
  st.level = levelOf(st, n);
  save(st);
  return { state: st, cooled, level: st.level, drops: st.drops.length };
}

function canLogin(now) {
  const n = nowMs(now);
  const cfg = loadCfg();
  if (!cfg.enabled) return { ok: true, why: 'disabled' };
  const st = refreshCounts(load(), n);
  if (st.coolingUntil > n) return { ok: false, why: '冷却中（还有 ' + Math.ceil((st.coolingUntil - n) / 60000) + ' 分钟）：' + st.coolingWhy };
  if (st.counts.login >= cfg.loginPerDayMax) return { ok: false, why: '今日登录已达上限 ' + cfg.loginPerDayMax + ' 次' };
  const gap = n - (st.lastLoginAt || 0);
  if (st.lastLoginAt && gap < cfg.loginGapMin * 60 * 1000) {
    return { ok: false, why: '距上次登录仅 ' + Math.floor(gap / 60000) + ' 分钟（要求 ≥' + cfg.loginGapMin + '）' };
  }
  return { ok: true };
}

function recordLogin(now) {
  const n = nowMs(now);
  const st = refreshCounts(load(), n);
  st.counts.login += 1;
  st.lastLoginAt = n;
  st.history.push({ t: n, event: 'login' });
  if (st.history.length > 60) st.history = st.history.slice(-60);
  st.level = levelOf(st, n);
  save(st);
  return st;
}

function loginFailed(why, now) {
  const n = nowMs(now);
  const cfg = loadCfg();
  const st = refreshCounts(load(), n);
  enterCooling(st, cfg.coolingHoursAfterLoginFail, '登录失败需要人工处理：' + (why || ''), n);
  st.level = levelOf(st, n);
  save(st);
  return st;
}

function canRestart(now) {
  const n = nowMs(now);
  const cfg = loadCfg();
  if (!cfg.enabled) return { ok: true, why: 'disabled' };
  const st = refreshCounts(load(), n);
  if (st.coolingUntil > n) return { ok: false, why: '冷却中（还有 ' + Math.ceil((st.coolingUntil - n) / 60000) + ' 分钟）：' + st.coolingWhy };
  if (st.counts.restart >= cfg.restartPerDayMax) return { ok: false, why: '今日自动重启已达上限 ' + cfg.restartPerDayMax + ' 次' };
  return { ok: true };
}

function recordRestart(now) {
  const n = nowMs(now);
  const st = refreshCounts(load(), n);
  st.counts.restart += 1;
  st.lastRestartAt = n;
  st.history.push({ t: n, event: 'restart' });
  if (st.history.length > 60) st.history = st.history.slice(-60);
  st.level = levelOf(st, n);
  save(st);
  return st;
}

// 动作闸门：read < reply < proactive < profile/qzone/friend < login/restart
const ACTIONS = ['read', 'reply', 'proactive', 'qzone', 'profile', 'friend', 'login', 'restart'];
function gate(action, opts) {
  const n = nowMs(opts && opts.now);
  const cfg = loadCfg();
  const st = refreshCounts(load(), n);
  const level = levelOf(st, n);
  const act = String(action || '').toLowerCase();
  if (!ACTIONS.includes(act)) return { ok: false, why: '未知动作：' + action, level };
  if (!cfg.enabled) return { ok: true, level, why: 'disabled' };
  if (act === 'read') return { ok: true, level };
  if (level === 'cooling') {
    const left = Math.ceil((st.coolingUntil - n) / 60000);
    if (act === 'reply' && cfg.allowReplyWhileCooling) return { ok: true, level, why: '冷却中但允许被动回复' };
    return { ok: false, why: '冷却中（还有 ' + left + ' 分钟）：' + (st.coolingWhy || ''), level };
  }
  if (act === 'login') return canLogin(n);
  if (act === 'restart') return canRestart(n);
  if (act === 'proactive' || act === 'qzone' || act === 'profile' || act === 'friend') {
    if (cfg.allowProactiveOnClient) return { ok: true, level, why: 'client-allowed' };
    if (cfg.requirePhoneChannelForProactive) {
      return { ok: false, why: '这类动作必须走手机官方客户端（A 通道），客户端只做被动回复', level };
    }
    if (level === 'caution') return { ok: false, why: '今日登录/重启额度已接近上限，暂缓主动动作', level };
  }
  return { ok: true, level };
}

function status(now) {
  const n = nowMs(now);
  const st = refreshCounts(load(), n);
  const dm = st.drops && st.drops.length ? Math.round((n - st.drops[st.drops.length - 1]) / 60000) : null;
  return {
    level: levelOf(st, n),
    coolingLeftMin: st.coolingUntil > n ? Math.ceil((st.coolingUntil - n) / 60000) : 0,
    coolingWhy: st.coolingUntil > n ? st.coolingWhy : '',
    today: st.counts,
    droppedLast: dm,
    lastProbe: st.drops && st.drops.length ? new Date(st.drops[st.drops.length - 1]).toLocaleString('zh-CN', { hour12: false }) : '—'
  };
}

function clear(now) {
  const n = nowMs(now);
  const st = refreshCounts(load(), n);
  st.coolingUntil = 0;
  st.coolingWhy = '';
  st.drops = [];
  st.counts = { date: dayKey(n), login: 0, restart: 0 };
  st.history.push({ t: n, event: 'clear' });
  st.level = 'normal';
  save(st);
  return st;
}

module.exports = {
  DEFAULTS, CFG_PATH, ACTIONS,
  configure, loadCfg, dirOf, fileOf, blank, load, save,
  levelOf, enterCooling, noteDrop, canLogin, recordLogin, loginFailed,
  canRestart, recordRestart, gate, status, clear
};

// CLI
if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  const rest = process.argv.slice(3);
  if (cmd === 'status') {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === 'clear') {
    clear();
    console.log('已清除冷却与今日计数');
  } else if (cmd === 'drop') {
    console.log(JSON.stringify(noteDrop(rest.join(' ') || 'manual'), null, 2));
  } else if (cmd === 'gate') {
    console.log(JSON.stringify(gate(rest[0] || 'reply'), null, 2));
  } else if (cmd === 'login') {
    console.log(JSON.stringify({ can: canLogin(), state: recordLogin() }, null, 2));
  } else if (cmd === 'fail') {
    console.log(JSON.stringify(loginFailed(rest.join(' ') || 'manual'), null, 2));
  } else {
    console.log('用法: node scripts/risk.js [status|clear|drop <原因>|gate <动作>|login|fail <原因>]');
  }
}
