'use strict';
/**
 * avatar-src.js —— 头像图片池（网上找的 + 别人发的那张）
 *
 * 背景（用户 2026-10-24）：「不要换月亮脸头像 换成别人发的，或者自己去互联网找，解除换头像次数限制」
 *   → 头像不再用 avatar.js 手绘的月亮脸，改成真实图片：优先「别人发给我的图」，其次上网找。
 *
 * 池目录：assets/avatar-src/（env QQAVATAR_SRC_DIR 可覆盖）
 * 状态：logs/avatar-src/state.json（env QQAVATAR_SRC_DIR 同目录下 state.json；QQAVATARSRC_STATE 可覆盖）
 *
 * CLI：
 *   node scripts/avatar-src.js list                  # 看池里有什么
 *   node scripts/avatar-src.js fetch [n]             # 上网找 n 张（默认 4）
 *   node scripts/avatar-src.js add <文件…>           # 手动塞图（source=peer）
 *   node scripts/avatar-src.js pick [web|peer|any]   # 看会挑哪张
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('./net.js');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = process.env.QQAVATAR_SRC_DIR || path.join(ROOT, 'assets', 'avatar-src');
const STATE_DIR = process.env.QQAVATARSRC_STATE_DIR || path.join(ROOT, 'logs', 'avatar-src');
const STATE = path.join(STATE_DIR, 'state.json');
const INDEX = path.join(SRC_DIR, 'index.json');

const DEFAULTS = {
  enabled: true,
  provider: 'lolicon',            // 目前只接 lolicon（公开 API，返回 pixiv 直链）
  endpoint: 'https://api.lolicon.app/setu/v2',
  perFetch: 4,
  r18: 0,                          // 只要全年龄
  excludeAI: true,
  size: 'regular',
  minBytes: 15000,
  maxBytes: 8 * 1024 * 1024,
  referer: 'https://www.pixiv.net/',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  timeoutMs: 25000,
  poolMax: 40,                     // 池子上限，超了删最老的
  searchCooldownMin: 3,
  extOk: /\.(jpe?g|png|webp|gif)$/i,
};

function cfg(over) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'avatar.json'), 'utf8')).src || {}; } catch (e) { /* ignore */ }
  return { ...DEFAULTS, ...file, ...(over || {}) };
}

function blank() { return { fetchedAt: 0, seq: 0 }; }
function loadState() {
  const st = store.readJson(STATE, blank()) || blank();
  return { ...blank(), ...st };
}
function saveState(st) { return store.writeJson(STATE, st); }

function index() {
  const idx = store.readJson(INDEX, { items: [] }) || { items: [] };
  if (!Array.isArray(idx.items)) idx.items = [];
  return idx;
}
function saveIndex(idx) { return store.writeJson(INDEX, idx); }

/** 池里的可用图（文件存在） */
function list() {
  const idx = index();
  return idx.items.filter(it => it && it.file && fs.existsSync(it.file));
}

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

/** 把一张图登记进池（同 md5 不重复） */
function register(file, meta = {}) {
  const idx = index();
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  const h = md5(buf);
  const old = idx.items.find(it => it.md5 === h);
  if (old) return old;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(file) || '.jpg').toLowerCase();
  const target = path.join(SRC_DIR, 'src-' + h.slice(0, 12) + ext);
  try {
    if (path.resolve(file) !== path.resolve(target)) fs.renameSync(file, target);
  } catch (e) {
    try { fs.copyFileSync(file, target); } catch (e2) { return null; }
  }
  const it = {
    id: 'src-' + h.slice(0, 12), file: target, md5: h, bytes: buf.length,
    source: meta.source || 'web', url: meta.url || '', from: meta.from || '',
    width: meta.width || 0, height: meta.height || 0,
    addedAt: Date.now(), used: 0, lastUsedAt: 0,
  };
  idx.items.push(it);
  // 池子上限：删最老的、且没用过的
  const c = cfg();
  if (idx.items.length > c.poolMax) {
    idx.items.sort((a, b) => (a.lastUsedAt || a.addedAt) - (b.lastUsedAt || b.addedAt));
    const dropped = idx.items.splice(0, idx.items.length - c.poolMax);
    for (const d of dropped) { try { fs.unlinkSync(d.file); } catch (e) { /* ignore */ } }
  }
  saveIndex(idx);
  return it;
}

/** 从对方的聊天图片收一张进池 */
function addPeer(file, meta = {}) {
  if (!file || !fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  if (buf.length < cfg().minBytes) return null;
  return register(file, { source: 'peer', from: meta.from || '', url: meta.url || '' });
}

/** 上网找图：lolicon API → 逐张下载 → 入池 */
async function search({ count = 0, cfg: over } = {}) {
  const c = cfg(over);
  if (!c.enabled) return { ok: false, why: 'disabled', added: [] };
  const st = loadState();
  const coolMs = Number(c.searchCooldownMin) * 60000;
  if (coolMs > 0 && st.fetchedAt && Date.now() - st.fetchedAt < coolMs) {
    return { ok: false, why: 'cooldown', added: [], leftMs: coolMs - (Date.now() - st.fetchedAt) };
  }
  const n = Math.max(1, Math.min(12, Number(count) || c.perFetch));
  const url = c.endpoint + '?r18=' + (Number(c.r18) || 0) + '&num=' + n + '&size=' + encodeURIComponent(c.size) + (c.excludeAI ? '&excludeAI=true' : '');
  let json;
  try {
    const res = await net.request(url, { method: 'GET', timeoutMs: c.timeoutMs, headers: { 'user-agent': c.userAgent, accept: 'application/json' } });
    if (!res.ok) return { ok: false, why: 'api-http-' + res.status, added: [] };
    json = JSON.parse(res.text);
  } catch (e) {
    return { ok: false, why: 'api-error: ' + (e && e.message ? e.message : String(e)), added: [] };
  }
  const data = Array.isArray(json.data) ? json.data : [];
  if (!data.length) return { ok: false, why: 'no-result', added: [] };

  const added = [];
  for (const d of data) {
    if (added.length >= n) break;
    const link = (d.urls && (d.urls.regular || d.urls.original || d.urls.small)) || '';
    if (!link || !c.extOk.test(link)) continue;
    try {
      const r2 = await net.getBuffer(link, { timeoutMs: c.timeoutMs, headers: { 'user-agent': c.userAgent, referer: c.referer } });
      if (!r2.ok || !r2.buffer) continue;
      if (r2.buffer.length < c.minBytes || r2.buffer.length > c.maxBytes) continue;
      const tmp = path.join(SRC_DIR, 'tmp-' + Date.now() + '-' + added.length + path.extname(new URL(link).pathname || '.jpg'));
      fs.mkdirSync(SRC_DIR, { recursive: true });
      fs.writeFileSync(tmp, r2.buffer);
      const it = register(tmp, { source: 'web', url: link, width: d.width, height: d.height });
      if (it) added.push(it);
    } catch (e) { /* 单张失败继续 */ }
  }
  st.fetchedAt = Date.now();
  saveState(st);
  return { ok: added.length > 0, added, why: added.length ? '' : 'download-failed' };
}

/** 挑一张：prefer=web|peer|any；avoidUsed 时优先没用过的 */
function pickOne({ prefer = 'any', count = 0, cfg: over } = {}) {
  const c = cfg(over);
  const all = list();
  let cands = all;
  if (prefer === 'peer') cands = all.filter(i => i.source === 'peer');
  if (prefer === 'web') cands = all.filter(i => i.source === 'web');
  if (!cands.length && prefer !== 'any') cands = all; // 退回到全池
  if (!cands.length) return null;
  // 优先没被用过的；都用了就挑最久没用的
  const fresh = cands.filter(i => !i.used);
  const pool = fresh.length ? fresh : cands.slice().sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  const pick = pool[Math.floor(Math.random() * pool.length)] || pool[0];
  const idx = index();
  const hit = idx.items.find(i => i.id === pick.id);
  if (hit) { hit.used = (hit.used || 0) + 1; hit.lastUsedAt = Date.now(); saveIndex(idx); }
  return pick;
}

/** 把图转成 512 方形 PNG（Pillow），返回文件路径 */
const PY_CANDIDATES = [
  process.env.AVATAR_PY,
  'C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  'python', 'python3',
].filter(Boolean);

function prepForAvatar(file, size = 512) {
  const py = path.join(__dirname, 'avatar_prep.py');
  const out = path.join(ROOT, 'assets', 'avatars', 'avatar-src-' + Date.now() + '.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { spawnSync } = require('child_process');
  let lastErr = '';
  for (const exe of PY_CANDIDATES) {
    try {
      const r = spawnSync(exe, [py, file, out, String(size)], { encoding: 'utf8', timeout: 60000 });
      if (r.status === 0 && fs.existsSync(out)) return { ok: true, file: out, py: exe };
      lastErr = (r.stderr || r.stdout || '').trim().slice(0, 200) || ('exit ' + r.status);
    } catch (e) { lastErr = e.message; }
  }
  return { ok: false, file: '', why: '图像处理失败: ' + lastErr };
}

function status() {
  const all = list();
  const web = all.filter(i => i.source === 'web').length;
  const peer = all.filter(i => i.source === 'peer').length;
  const st = loadState();
  return { total: all.length, web, peer, fetchedAt: st.fetchedAt, dir: SRC_DIR };
}

module.exports = {
  DEFAULTS, SRC_DIR, STATE, INDEX,
  cfg, list, register, addPeer, search, pickOne, prepForAvatar, status, loadState, saveState,
};

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const log = (...a) => console.log(...a);
  (async () => {
    if (cmd === 'list') {
      const all = list();
      log('池内 ' + all.length + ' 张（' + SRC_DIR + '）');
      for (const it of all.slice(-20)) {
        log(' ' + it.id + '  ' + (it.source === 'peer' ? '别人发的' : '网上找的') + '  ' + Math.round(it.bytes / 1024) + 'KB  used=' + (it.used || 0));
      }
    } else if (cmd === 'fetch') {
      const r = await search({ count: Number(rest[0]) || 0 });
      log(JSON.stringify({ ok: r.ok, why: r.why || '', added: (r.added || []).map(a => a.id) }, null, 0));
    } else if (cmd === 'add') {
      const out = [];
      for (const f of rest) { const it = addPeer(f); if (it) out.push(it.id); }
      log('加入 ' + out.length + ' 张: ' + out.join(', '));
    } else if (cmd === 'pick') {
      const p = pickOne({ prefer: rest[0] || 'any' });
      log(p ? (p.id + '  ' + p.file + '  ' + (p.source === 'peer' ? '别人发的' : '网上找的')) : '池子是空的');
    } else if (cmd === 'prep') {
      const r = prepForAvatar(rest[0], Number(rest[1]) || 512);
      log(JSON.stringify(r));
    } else if (cmd === 'status') {
      log(JSON.stringify(status(), null, 2));
    } else {
      log('用法: node scripts/avatar-src.js list|fetch [n]|add <文件…>|pick [web|peer|any]|prep <文件>|status');
    }
  })().catch(e => { console.error('ERR', e); process.exit(1); });
}
