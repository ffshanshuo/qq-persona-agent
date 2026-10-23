'use strict';
/**
 * lib/store.js —— 统一的 JSON 落盘工具（本项目所有模块共用的那一套「原子写」）
 *
 * 为什么需要它：Windows / 网络盘 / 同步盘上 `rename` 会偶发 EIO / EBUSY / EPERM，
 * 直接 `writeFileSync` 又可能写一半断电。最初每个模块各写一份重试逻辑，
 * 结果是一个坑要修 N 次。这里收口成一份：
 *
 *   1. 先写临时文件（同目录，名字带 pid + 序号，避免并发撞名）；
 *   2. `fs.renameSync` 原子替换；
 *   3. 失败重试 4 次（每次换临时名，同步睡 15/25/35/45ms 退避）；
 *   4. 仍失败则退回「直接覆盖写」，并在返回 false 的情况下让调用方记日志；
 *   5. 读：坏 JSON 先改名 `<file>.bad-<ts>` 再返回 fallback —— 绝不把坏文件当「没问题」。
 *
 * 用法：
 *   const store = require('./lib/store.js');
 *   const st = store.readJson(file, () => blankState());   // fallback 可以是值或工厂
 *   store.writeJson(file, st);
 */
const fs = require('fs');
const path = require('path');

const MAX_TRIES = 4;
const BACKOFF_MS = [15, 25, 35, 45];

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 已存在 */ }
}

/** 同步小睡（不引入 async 传染；这些调用点本来就在同步路径里） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {
    const end = Date.now() + ms; while (Date.now() < end) { /* spin */ }
  }
}

function isEnoent(e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'); }

/**
 * 读 JSON。
 * @param {string} file
 * @param {*} fallback 值或工厂函数（`() => ({...})`）
 * @param {{onError?: Function}} [opts] onError(err, file) —— 一般传模块自己的 errorLog 写手
 */
function readJson(file, fallback, opts) {
  const o = opts || {};
  const fb = () => (typeof fallback === 'function' ? fallback() : fallback);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (!isEnoent(e) && typeof o.onError === 'function') { try { o.onError(e, file); } catch (_) {} }
    return fb();
  }
  try {
    const v = JSON.parse(raw);
    return v == null ? fb() : v;
  } catch (e) {
    // 坏文件：留证据再重建，别静默吞掉
    try { fs.renameSync(file, file + '.bad-' + Date.now()); } catch (_) {}
    if (typeof o.onError === 'function') { try { o.onError(e, file); } catch (_) {} }
    return fb();
  }
}

/**
 * 原子写 JSON。返回 true/false（false 表示连直写都失败，调用方应打日志）。
 * @param {string} file
 * @param {*} obj
 */
function writeJson(file, obj) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const text = JSON.stringify(obj, null, 2) + '\n';
  const base = path.basename(file);
  for (let i = 0; i < MAX_TRIES; i++) {
    const tmp = path.join(dir, base + '.' + process.pid + '.' + i + '.tmp');
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
      return true;
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (__) {}
      sleepSync(BACKOFF_MS[i] || 45);
    }
  }
  // 兜底：直接覆盖写（不原子，但总比丢数据强）
  try { fs.writeFileSync(file, text); return true; } catch (_) { return false; }
}

/** 追加一行 JSON（JSONL 日志用） */
function appendJsonl(file, obj) {
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    return true;
  } catch (_) { return false; }
}

/** 追加文本（带目录创建） */
function appendText(file, text) {
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, text);
    return true;
  } catch (_) { return false; }
}

/** 超阈值轮转：超过 maxBytes 时改名保留一份旧文件（日志/痕迹用） */
function rotateIfBig(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return false;
    fs.renameSync(file, file + '.' + Date.now() + '.old');
    return true;
  } catch (_) { return false; }
}

module.exports = { readJson, writeJson, appendJsonl, appendText, rotateIfBig, ensureDir, sleepSync, MAX_TRIES };
