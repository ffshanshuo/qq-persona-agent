#!/usr/bin/env node
'use strict';
/**
 * sticker-fetch.js —— 「库里没有合适的，就自己上网找一张」
 *
 * 用户 2026-10-24：「没有合适表情包的话，就自己上网寻找」。
 * 所以 pick() 没命中时，这里负责：搜 → 下载 → 视觉打标 → 入 index.json，再让 pick() 挑一次。
 *
 * 设计纪律（都很重要）：
 *  1) **有预算**：一次最多等 budgetMs（默认 15s），下载条数上限 maxDownload，超时就用手上已有的；
 *  2) **有配额**：每小时最多 maxPerHour 次抓取、同一关键词 perKeywordCooldownMin 分钟内不重复抓（避免刷对方网站、也避免拖慢回复）；
 *  3) **去重**：按 md5 与库里已有的比对，重复的不再入库；
 *  4) **永不阻塞回复**：所有异常都在这里吞掉并返回 {ok:false, why}，调用方拿不到就按「这次不发」处理；
 *  5) drY：`STICKER_FETCH_DRY=1` 时只搜不下载（测试/排查用）。
 *
 * CLI：
 *   node scripts/sticker-fetch.js search 委屈        # 只搜，打印候选 URL
 *   node scripts/sticker-fetch.js fetch 委屈         # 真抓并入库
 *   node scripts/sticker-fetch.js state             # 看配额与冷却
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STICKER_DIR = process.env.STICKER_DIR || path.join(ROOT, 'assets', 'stickers');
const WEB = path.join(STICKER_DIR, 'web');
const STATE_DIR = process.env.QQFETCH_DIR || path.join(ROOT, 'logs', 'sticker-fetch');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const DEFAULTS = {
  enabled: true,
  maxPerHour: 6,
  perKeywordCooldownMin: 360,
  budgetMs: 15000,
  maxDownload: 4,
  maxAdded: 6,
  minBytes: 4000,
  maxBytes: 3 * 1024 * 1024,
  sources: ['fabiaoqing'],
  referer: 'https://fabiaoqing.com/',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

// ── 可注入依赖（测试用） ────────────────────────────────────────────────
let DEPS = null;
function __setDeps(d) { DEPS = d; }
function deps() {
  if (DEPS) return DEPS;
  return {
    getText: async (url, opts) => {
      const net = require('./net.js');
      let u = url;
      for (let hop = 0; hop < 4; hop++) {
        const r = await net.request(u, { method: 'GET', ...(opts || {}) });
        const loc = r && r.headers && r.headers.location;
        if (r && r.status >= 300 && r.status < 400 && loc) { u = loc.startsWith('http') ? loc : new URL(loc, u).href; continue; }
        return r;
      }
      throw new Error('too many redirects');
    },
    getBuffer: async (url, opts) => require('./net.js').getBuffer(url, opts),
    caption: async (file) => {
      const st = require('./stickers.js');
      const vf = st.visionFile(file);
      const cap = await require('./vision.js').captionSticker(vf);
      return { ...cap, sheet: vf !== file ? vf : undefined };
    },
  };
}

// ── 状态 ────────────────────────────────────────────────────────────────
function blankState() { return { fetches: [], tries: {}, misses: {}, updatedAt: null }; }
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && typeof j === 'object') return { ...blankState(), ...j };
  } catch (_) { /* 空状态 */ }
  return blankState();
}
function saveState(st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  st.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  } catch (e) {
    try { fs.appendFileSync(path.join(ROOT, 'logs', 'sticker-fetch-error.log'), `${new Date().toISOString()} save: ${e.message}\n`); } catch (_) { }
  }
}

function prune(st, now) {
  const hourAgo = now - 3600e3;
  st.fetches = (st.fetches || []).filter((t) => Number(t) > hourAgo);
  for (const [k, t] of Object.entries(st.tries || {})) {
    if (now - Number(t) > 40 * 24 * 3600e3) delete st.tries[k];
  }
  return st;
}

// ── 搜索 ────────────────────────────────────────────────────────────────
const UA = () => DEFAULTS.userAgent;

function hostOk(u) {
  return /^https?:\/\//i.test(u) && /(soutula|fabiaoqing|aigengtu|qpic)\./i.test(new URL(u).hostname);
}

/** fabiaoqing 搜索页：抓 data-original / src 里的图片直链 */
async function searchFabiaoqing(keyword) {
  const d = deps();
  const url = `https://fabiaoqing.com/search/bqb/keyword/${encodeURIComponent(keyword)}/type/bq/page/1.html`;
  const r = await d.getText(url, { headers: { 'user-agent': UA(), referer: DEFAULTS.referer }, timeoutMs: 8000 });
  if (!r || !r.ok) throw new Error(`搜索失败 HTTP ${r && r.status}`);
  const html = String(r.text || '');
  const urls = [];
  const push = (u) => {
    let s = String(u || '').trim();
    if (!s || s.startsWith('data:')) return;
    if (s.startsWith('//')) s = 'https:' + s;
    if (!hostOk(s)) return;
    if (!/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(s)) return;
    if (!urls.includes(s)) urls.push(s);
  };
  for (const m of html.matchAll(/data-original=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) push(m[1]);
  return urls;
}

async function search(keyword, { sources } = {}) {
  const list = Array.isArray(sources) && sources.length ? sources : DEFAULTS.sources;
  const out = [];
  for (const s of list) {
    try {
      if (s === 'fabiaoqing') {
        const u = await searchFabiaoqing(keyword);
        for (const x of u) if (!out.includes(x)) out.push(x);
      }
    } catch (e) {
      // 单个源失败不影响其他源
    }
  }
  return out;
}

// ── 下载 + 入库 ─────────────────────────────────────────────────────────
function detectExt(b) {
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.slice(8, 12).toString() === 'WEBP') return 'webp';
  return 'bin';
}

async function grab(url, keyword) {
  const d = deps();
  // fabiaoqing 列表给的是 bmiddle 缩略图，优先换 large（原图），失败再退回缩略图
  const cands = Array.from(new Set([url.replace('/bmiddle/', '/large/'), url]));
  let buf = null, lastErr = null;
  for (const cu of cands) {
    try {
      const r = await d.getBuffer(cu, { headers: { 'user-agent': UA(), referer: DEFAULTS.referer }, timeoutMs: 8000 });
      if (r && r.ok && r.buffer) { buf = r.buffer; break; }
      lastErr = new Error(`下载失败 HTTP ${r && r.status}`);
    } catch (e) { lastErr = e; }
  }
  if (!buf) throw lastErr || new Error('下载失败');
  if (buf.length < DEFAULTS.minBytes) throw new Error(`太小 ${buf.length}B`);
  if (buf.length > DEFAULTS.maxBytes) throw new Error(`太大 ${buf.length}B`);
  const st = require('./stickers.js');
  const idx = st.loadIndex();
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  if ((idx.stickers || []).some((s) => s.md5 === md5)) throw new Error('已存在(md5)');
  fs.mkdirSync(WEB, { recursive: true });
  const ext = detectExt(buf);
  const file = path.join(WEB, `web-${keyword}-${md5.slice(0, 10)}.${ext}`);
  fs.writeFileSync(file, buf);
  let cap = { emotion: '其他', desc: '（未标注）', tags: [] };
  try {
    cap = await d.caption(file);
  } catch (_) { /* 标注失败也入库，之后可 _recaption */ }
  const entry = {
    id: path.basename(file).replace(/\.[^.]+$/, ''),
    kind: 'image',
    file,
    md5,
    source: 'web',
    emotion: cap.emotion || '其他',
    desc: cap.desc || '',
    tags: Array.from(new Set([...(cap.tags || []), keyword, cap.emotion].filter(Boolean))).slice(0, 8),
    foundBy: keyword,
    fetchedAt: new Date().toISOString(),
    sheet: cap.sheet,
  };
  idx.stickers = idx.stickers || [];
  idx.stickers.push(entry);
  st.saveIndex(idx);
  return entry;
}

/**
 * 库里没有合适的就上网找。返回 {ok, added:[ids], why}
 * 调用方（auto-reply）拿 added.length>0 后再 pick() 一次。
 */
async function fetchOne(kw, { o, st, now, budgetMs, maxDownload }) {
  const last = Number((st.tries || {})[kw] || 0);
  if (last && now - last < o.perKeywordCooldownMin * 60e3) return { ok: false, why: 'cooldown', added: [] };
  if ((st.fetches || []).length >= o.maxPerHour) return { ok: false, why: 'rate', added: [] };

  const deadline = now + (budgetMs || o.budgetMs);
  let urls = [];
  try {
    urls = await search(kw);
  } catch (e) {
    st.tries[kw] = now;
    saveState(st);
    return { ok: false, why: 'search-failed:' + e.message, added: [] };
  }
  st.tries[kw] = now;
  if (!urls.length) {
    st.misses[kw] = (Number(st.misses[kw]) || 0) + 1;
    saveState(st);
    return { ok: false, why: 'no-result', added: [] };
  }

  const added = [];
  for (const u of urls.slice(0, maxDownload || o.maxDownload)) {
    if (Date.now() > deadline) break;
    if (added.length >= o.maxAdded) break;
    try {
      const e = await grab(u, kw);
      added.push(e.id);
    } catch (_) { /* 单张失败继续下一张 */ }
  }
  st.fetches = [...(st.fetches || []), now];
  if (!added.length) st.misses[kw] = (Number(st.misses[kw]) || 0) + 1;
  saveState(st);
  return { ok: added.length > 0, added, tried: urls.length, why: added.length ? '' : 'all-failed' };
}

/**
 * 确保库里有「这个词」对应的表情；没有就上网抓。
 * 复合情绪（'开心+可爱'）按主情绪优先逐个试，抓到一张就停（别为组合词浪费配额）。
 */
async function ensureFor(keyword, { now = Date.now(), budgetMs, maxDownload, cfg } = {}) {
  const o = { ...DEFAULTS, ...(cfg || {}) };
  if (!o.enabled || String(process.env.STICKER_FETCH_DISABLED || '') === '1') return { ok: false, why: 'disabled', added: [] };
  if (String(process.env.STICKER_FETCH_DRY || '') === '1') return { ok: false, why: 'dry', added: [] };
  const _stk = require('./stickers.js');
  const parts = (typeof _stk.splitEmotions === 'function' ? _stk.splitEmotions(keyword) : [String(keyword || '').trim()]).filter(Boolean);
  if (!parts.length) return { ok: false, why: 'bad-keyword', added: [] };

  const st = prune(loadState(), now);
  const tried = [];
  let added = [];
  let lastWhy = '';
  let allSkippedByCooldown = true;
  for (const kw of parts) {
    if (kw.length > 20) { tried.push(kw + ':bad'); allSkippedByCooldown = false; continue; }
    const r = await fetchOne(kw, { o, st, now, budgetMs, maxDownload });
    if (r.why !== 'cooldown') allSkippedByCooldown = false;
    tried.push(kw + (r.ok ? ':ok' : ':' + (r.why || 'failed')));
    if (r.ok && r.added.length) { added = r.added; lastWhy = ''; break; }
    lastWhy = r.why || 'all-failed';
    if (/^(rate|disabled|dry)$/.test(lastWhy)) break;
  }
  const why = added.length ? '' : (allSkippedByCooldown ? 'cooldown' : (lastWhy || 'all-failed'));
  return { ok: added.length > 0, added, tried, why, parts };
}

// ── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const kw = rest.filter((x) => !x.startsWith('--')).join(' ');
  (async () => {
    if (cmd === 'search') {
      const urls = await search(kw);
      console.log(urls.length ? urls.slice(0, 20).join('\n') : '没搜到');
    } else if (cmd === 'fetch') {
      const r = await ensureFor(kw);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'state') {
      console.log(JSON.stringify(loadState(), null, 2));
    } else {
      console.log('用法: node scripts/sticker-fetch.js search|fetch <关键词> | state');
    }
  })().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}

module.exports = { DEFAULTS, __setDeps, STICKER_DIR, WEB, STATE_FILE, blankState, loadState, saveState, searchFabiaoqing, search, grab, ensureFor, detectExt };
