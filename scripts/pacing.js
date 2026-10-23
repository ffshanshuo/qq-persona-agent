#!/usr/bin/env node
'use strict';
// 节奏控制（pacing.js）——「什么时候该慢」
// 真人聊天有两个几乎骗不过去的时间特征：
//  ① 打字时长跟「要说多少字」强相关：被问一句「在吗」，不会花 8 秒才回嗯；
//  ② 切换聊天窗口有成本：刚跟 A 说完话，马上又给 B 发，中间一定有切换动作（几百毫秒到几秒），
//     而且这个成本跟「刚聊完谁、隔了多久」有关。
// 本模块只负责算这两个时间，不负责发消息；C 通道（NapCat）与 A 通道（手机 adb）共用。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'pacing.json');
const DIR = path.join(ROOT, 'logs', 'pacing');

const DEFAULTS = {
  enabled: true,
  // 打字：中文输入大概 2.5~4 字/秒，取 3.2 作基准；另有固定「反应/抬手」底时
  charsPerSec: 3.2,
  typingBaseMs: 650,
  typingMinMs: 900,
  typingMaxMs: 12000,
  jitter: 0.25,
  // 切换窗口：至少一次「点开列表 → 找人 → 点进会话」的动作
  switchBaseMs: 1800,
  switchMaxMs: 6500,
  switchJitter: 0.35,
  // 刚跟别人聊完、马上切回来时额外多停一下（读一眼未读）
  recentWindowMs: 20000,
  recentExtraMs: [200, 900],
  // 单个会话连续快速切来切去的累计惩罚（同一分钟内切第 3 次开始变慢）
  rapidCountWindowMs: 60000,
  rapidPenaltyMs: 700,
  keepSwitches: 200
};

function dirOf() { return process.env.QQPACING_DIR || DIR; }
function stateFile() { return path.join(dirOf(), 'state.json'); }

function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { } }
function rnd() { return Math.random(); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }

function loadCfg(fresh) {
  try {
    if (!fresh && loadCfg._c) return loadCfg._c;
    const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    loadCfg._c = Object.assign({}, DEFAULTS, raw);
  } catch (e) {
    loadCfg._c = Object.assign({}, DEFAULTS);
  }
  return loadCfg._c;
}
function configure(over) {
  loadCfg._c = Object.assign({}, loadCfg(true), over || {});
  return loadCfg._c;
}

function blank() { return { lastKey: '', lastAt: 0, switches: [] }; }
function load() {
  try {
    const c = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (c && typeof c === 'object') return Object.assign(blank(), c);
  } catch (e) { }
  return blank();
}
function save(c) {
  const file = stateFile();
  const dir = dirOf();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  const body = JSON.stringify(c, null, 0);
  for (let i = 0; i < 4; i++) {
    const tmp = file + '.' + process.pid + '.' + i + '.tmp';
    try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); return true; } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { } sleepSync(15 + 25 * i); }
  }
  try { fs.writeFileSync(file, body); return true; } catch (e) {
    try { fs.appendFileSync(path.join(ROOT, 'logs', 'pacing-error.log'), JSON.stringify({ t: Date.now(), err: String(e && e.message) }) + '\n'); } catch (e2) { }
    return false;
  }
}

/** 打字时长：字数 → 毫秒（含抖动，钳在 [typingMinMs, typingMaxMs]） */
function typingMs(text, opts) {
  const cfg = Object.assign({}, loadCfg(), opts || {});
  if (cfg.enabled === false) return 0;
  const s = String(text == null ? '' : text);
  // 只数「真正要敲的内容」：空白、换行不算；表情段之类的标记也不算
  const chars = s.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '').length;
  if (!chars) return Math.max(cfg.typingMinMs, 400);
  const perSec = Math.max(0.5, Number(cfg.charsPerSec) || 3.2);
  const base = Number(cfg.typingBaseMs) || 0;
  let ms = base + (chars / perSec) * 1000;
  const j = clamp(cfg.jitter == null ? 0.25 : cfg.jitter, 0, 0.8);
  ms = ms * (1 + (rnd() * 2 - 1) * j);
  return Math.round(clamp(ms, cfg.typingMinMs, cfg.typingMaxMs));
}

/** 切换窗口成本：fromKey → toKey（同一会话为 0） */
function switchMs(fromKey, toKey, opts) {
  const cfg = Object.assign({}, loadCfg(), opts || {});
  if (cfg.enabled === false) return 0;
  const from = String(fromKey || '');
  const to = String(toKey || '');
  if (!from || !to || from === to) return 0;
  const j = clamp(cfg.switchJitter == null ? 0.35 : cfg.switchJitter, 0, 0.9);
  let ms = (Number(cfg.switchBaseMs) || 0) * (1 + rnd() * j);
  return Math.round(clamp(ms, 300, Number(cfg.switchMaxMs) || 6500));
}

/**
 * 一轮开始的节奏：返回 { switchMs, typingMs, fromKey, rapidCount }
 * 会读/写 state（记录"上一次跟谁说话、什么时候"），但不 sleep —— 由调用方等。
 */
function beginTurn(key, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, loadCfg(), o.cfg || {});
  const now = Number(o.now) || Date.now();
  const st = load();
  const fromKey = st.lastKey || '';
  let sw = switchMs(fromKey, key, { cfg });
  let rapidCount = 0;
  if (sw > 0) {
    // 刚跟别人聊完马上切回来：多停一下（看未读）
    const since = now - (Number(st.lastAt) || 0);
    if (since >= 0 && since <= (Number(cfg.recentWindowMs) || 0)) {
      const [a, b] = Array.isArray(cfg.recentExtraMs) ? cfg.recentExtraMs : [200, 900];
      sw += Math.round(a + rnd() * Math.max(0, b - a));
    }
    // 一分钟内在多个会话间切来切去：越切越慢
    st.switches = (st.switches || []).filter((x) => now - (Number(x.t) || 0) <= (Number(cfg.rapidCountWindowMs) || 60000));
    rapidCount = st.switches.length + 1;
    if (rapidCount >= 3) sw += (Number(cfg.rapidPenaltyMs) || 0) * (rapidCount - 2);
    sw = Math.round(clamp(sw, 0, Number(cfg.switchMaxMs) || 6500));
    st.switches.push({ t: now, from: fromKey, to: String(key || '') });
    if (st.switches.length > (Number(cfg.keepSwitches) || 200)) st.switches = st.switches.slice(-(Number(cfg.keepSwitches) || 200));
  }
  st.lastKey = String(key || '');
  st.lastAt = now;
  save(st);
  return { switchMs: sw, fromKey, rapidCount };
}

/** 只记「我刚在这个会话里说过话」，不产生等待 */
function touch(key, now) {
  const st = load();
  st.lastKey = String(key || '');
  st.lastAt = Number(now) || Date.now();
  save(st);
  return st.lastKey;
}

function status(now) {
  const st = load();
  const cfg = loadCfg();
  const t = Number(now) || Date.now();
  return {
    enabled: cfg.enabled !== false,
    lastKey: st.lastKey || '',
    sinceLastMin: st.lastAt ? Math.round((t - Number(st.lastAt)) / 6000) / 10 : null,
    switchesLastMin: (st.switches || []).filter((x) => t - (Number(x.t) || 0) <= (Number(cfg.rapidCountWindowMs) || 60000)).length,
    typing: { charsPerSec: cfg.charsPerSec, min: cfg.typingMinMs, max: cfg.typingMaxMs },
    switching: { base: cfg.switchBaseMs, max: cfg.switchMaxMs }
  };
}

module.exports = { DEFAULTS, CFG_PATH, dirOf, stateFile, loadCfg, configure, typingMs, switchMs, beginTurn, touch, status };

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === 'typing') {
    for (const s of process.argv.slice(3)) console.log(JSON.stringify({ text: s, ms: typingMs(s) }));
  } else if (cmd === 'switch') {
    console.log(JSON.stringify({ 'p:100000001 → p:100000002': switchMs('p:100000001', 'p:100000002') }));
  } else if (cmd === 'begin') {
    console.log(JSON.stringify(beginTurn(process.argv[3] || 'p:test'), null, 2));
  } else {
    console.log('用法: node scripts/pacing.js [status|typing <文本...>|switch|begin <key>]');
  }
}
