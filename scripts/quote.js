'use strict';
/**
 * quote.js — 引用消息的「上下文感知」
 *
 * 为什么单独一层：QQ 里「引用/回复某条消息」只给出被引用那条的 message_id，
 * 光有 id 模型什么也看不见；而光取回文字也不够——
 *   · 是谁说的（我自己 / TA 自己 / 群里另一个人）决定口气
 *   · 多久以前说的（刚刚 vs 昨天）决定要不要当成「刚说的」来接
 *   · 引用的是图片/表情/语音时，只有 "[图片]" 这类占位符等于没看见
 *   · 被引用的那条本身可能又是一次引用（链）
 *
 * 本模块只做「取回 + 结构化 + 翻成人话」，不调模型（除非调用方要求看图）。
 */
const path = require('path');
const fs = require('fs');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const DIR = () => process.env.QQQUOTE_DIR || path.join(ROOT, 'logs', 'quotes');

const DEFAULTS = {
  enabled: true,
  maxChars: 200,        // 被引用内容最多念多少字
  maxQuotes: 2,         // 一次最多解析几条引用（连发时可能有好几条）
  ttlHours: 48,         // 已取到的引用缓存多久（同一条内容不会变，但别无限存）
  negTtlMin: 10,        // 取不到（撤回/不在历史里）时，负面结果缓存多久
  cacheMax: 400,        // 磁盘缓存文件数上限
  analyzeImage: false,  // 引用里是图片时，要不要调视觉模型描述（有延迟，默认关）
  imageMax: 1,          // 最多描述几张
  longAgoHours: 6       // 超过这个时长算「很久以前的一条」
};

function options(over) { return { ...DEFAULTS, ...(over || {}) }; }
function dirOf(cfg) { return (cfg && cfg.dir) || DIR(); }

function ensureDir(cfg) {
  const d = dirOf(cfg);
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  return d;
}
function fileOf(id, cfg) {
  return path.join(dirOf(cfg), String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}

// ---------- 解析 ----------
function kindsOf(msg) {
  if (typeof msg === 'string') return ['text'];
  if (!Array.isArray(msg)) return [];
  const out = [];
  for (const s of msg) {
    if (!s || !s.type) continue;
    if (s.type === 'face' || s.type === 'mface') { if (!out.includes('mface')) out.push('mface'); continue; }
    if (s.type === 'reply') { if (!out.includes('reply')) out.push('reply'); continue; }
    if (!out.includes(s.type)) out.push(s.type);
  }
  return out;
}

function textOfSegs(msg) {
  if (typeof msg === 'string') return String(msg).trim();
  if (!Array.isArray(msg)) return '';
  const parts = [];
  for (const s of msg) {
    if (!s) continue;
    if (s.type === 'text') { const t = String((s.data && s.data.text) || '').trim(); if (t) parts.push(t); }
    else if (s.type === 'image') parts.push('[图片]');
    else if (s.type === 'mface' || s.type === 'face') parts.push('[表情]');
    else if (s.type === 'record') parts.push('[语音]');
    else if (s.type === 'video') parts.push('[视频]');
    else if (s.type === 'file') parts.push('[文件' + (s.data && s.data.name ? ':' + s.data.name : '') + ']');
    else if (s.type === 'forward') parts.push('[合并转发]');
  }
  return parts.join('').trim();
}

function imageFilesOf(msg) {
  if (!Array.isArray(msg)) return [];
  return msg.filter(s => s && s.type === 'image' && s.data)
    .map(s => ({ file: String(s.data.file || ''), url: String(s.data.url || ''), summary: String(s.data.summary || '') }))
    .filter(x => x.file || x.url);
}

/**
 * 把 get_msg 的返回解析成结构化引用。
 * @param {object} data get_msg 的 data
 * @param {{selfId?:string|number, now?:number}} opts
 */
function parse(data, opts) {
  const o = options(opts);
  const now = Number(opts && opts.now) || Date.now();
  const d = data || {};
  const sender = d.sender || {};
  const uin = String(d.user_id != null ? d.user_id : (sender.user_id != null ? sender.user_id : ''));
  const selfId = opts && opts.selfId != null ? String(opts.selfId) : '';
  const at = Number(d.time || 0) * (Number(d.time || 0) > 1e12 ? 1 : 1000);
  const msg = d.message != null ? d.message : (d.raw_message != null ? d.raw_message : '');
  const kinds = kindsOf(msg);
  const text = textOfSegs(msg).slice(0, o.maxChars);
  return {
    id: d.message_id != null ? String(d.message_id) : '',
    uin,
    isSelf: !!(uin && selfId && uin === selfId),
    name: String(sender.card || sender.nickname || ''),
    at: at || 0,
    agoMin: at ? Math.max(0, Math.round((now - at) / 60000)) : null,
    text,
    kinds,
    images: imageFilesOf(msg),
    isReplyTo: kinds.includes('reply'),
    empty: !text
  };
}

// ---------- 缓存 ----------
function readCache(id, cfg, now) {
  const o = options(cfg);
  const f = fileOf(id, cfg);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  if (!j || typeof j !== 'object') return null;
  const age = Math.max(0, now - Number(j.savedAt || 0));
  const hit = j.info && !j.info.empty
    ? age < o.ttlHours * 3600e3
    : age < o.negTtlMin * 60e3;
  if (!hit) return null;
  return j.info;
}

function writeCache(info, cfg, now) {
  ensureDir(cfg);
  try { store.writeJson(fileOf(info.id || 'x', cfg), { savedAt: now, info }); } catch (e) { }
  trimCache(cfg);
}

function trimCache(cfg) {
  const o = options(cfg);
  try {
    const files = fs.readdirSync(dirOf(cfg)).filter(f => f.endsWith('.json'));
    if (files.length <= o.cacheMax) return;
    const items = files.map(f => {
      const p = path.join(dirOf(cfg), f);
      let t = 0;
      try { t = fs.statSync(p).mtimeMs; } catch (e) { }
      return { p, t };
    }).sort((a, b) => a.t - b.t);
    for (const it of items.slice(0, files.length - o.cacheMax)) { try { fs.unlinkSync(it.p); } catch (e) { } }
  } catch (e) { }
}

/** 取一条引用（先看磁盘缓存，再问 NapCat），失败返回 {empty:true} 结构 */
async function fetchOne(id, opts) {
  const o = options(opts && opts.cfg);
  const now = Number(opts && opts.now) || Date.now();
  const key = String(id || '');
  if (!key) return { id: '', empty: true, text: '', kinds: [] };
  const cached = readCache(key, opts && opts.cfg, now);
  if (cached) return cached;
  let data = null;
  try {
    const r = await opts.call('get_msg', { message_id: key });
    data = (r && r.data) || null;
    if (r && r.status && r.status !== 'ok' && !data) data = null;
  } catch (e) {
    return { id: key, empty: true, text: '', kinds: [], threw: true, error: String((e && e.message) || e).slice(0, 160) };
  }
  if (!data) {
    const miss = { id: key, empty: true, text: '', kinds: [] };
    writeCache(miss, opts && opts.cfg, now);   // 短期记住「取不到」，别每轮都去问
    return miss;
  }
  const info = parse(data, { selfId: opts && opts.selfId, now });
  if (!info.id) info.id = key;
  writeCache(info, opts && opts.cfg, now);
  return info;
}

/** 一批引用 id → 结构化数组（去重、按发生顺序，最多 maxQuotes 条） */
async function collect(ids, opts) {
  const o = options(opts && opts.cfg);
  const list = [];
  const seen = new Set();
  for (const raw of (ids || [])) {
    const id = String(raw || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  const take = list.slice(-Math.max(1, o.maxQuotes));
  const out = [];
  for (const id of take) out.push(await fetchOne(id, opts));
  return out;
}

// ---------- 翻成人话 ----------
function whenText(agoMin, cfg) {
  const o = options(cfg);
  if (agoMin == null) return '';
  if (agoMin < 2) return '刚刚';
  if (agoMin < 60) return agoMin + ' 分钟前';
  if (agoMin < 60 * 24) return Math.round(agoMin / 60) + ' 小时前';
  return Math.round(agoMin / (60 * 24)) + ' 天前';
}

function whoText(info, opts) {
  const viewerIsSender = !!(opts && opts.senderUin && info.uin && String(opts.senderUin) === String(info.uin));
  if (info.isSelf) return '你自己';
  if (viewerIsSender) return 'TA 自己';
  const nm = info.name || (info.uin ? String(info.uin) : '另一个人');
  return '群里另一个人（' + nm + '）';
}

/**
 * 一条引用 → 一句中文说明。返回 '' 表示这条不该单独说。
 */
function describe(info, opts) {
  const o = options(opts && opts.cfg);
  if (!info) return '';
  const who = whoText(info, opts);
  const when = whenText(info.agoMin, o);
  const head = when ? `${who} ${when}` : who;
  if (info.empty) return `对方引用的那条消息没取到（可能撤回了或太旧），别猜它具体内容。`;
  const hasMedia = info.kinds.some(k => k === 'image' || k === 'mface' || k === 'record' || k === 'video' || k === 'file');
  const onlyMedia = hasMedia && !info.text.replace(/\[(图片|表情|语音|视频|文件[^\]]*|合并转发)\]/g, '').trim();
  let body;
  if (onlyMedia) {
    const kinds = info.kinds.map(k => ({ image: '图片', mface: '表情包', face: '表情', record: '语音', video: '视频', file: '文件' }[k] || '')).filter(Boolean);
    const what = Array.from(new Set(kinds)).join('、') || '一条消息';
    body = `对方引用的是一条${what}${opts && opts.imageDesc ? '（' + opts.imageDesc + '）' : ''}`;
  } else {
    body = `对方引用的是${head}说的：「${info.text}」`;
  }
  const tail = [];
  if (info.agoMin != null && info.agoMin > o.longAgoHours * 60) tail.push('这是挺久以前的一条，别当成刚说的话来接');
  if (info.isSelf) tail.push('TA 是在接你之前说的那句');
  if (info.isReplyTo) tail.push('这条本身也是在回更早的一条');
  return body + (tail.length ? '（' + tail.join('；') + '）' : '') + '。';
}

/** 多条引用 → 拼成一段 note */
function noteFor(infos, opts) {
  const o = options(opts && opts.cfg);
  const parts = [];
  for (const info of (infos || [])) {
    const s = describe(info, { ...opts, cfg: o });
    if (s) parts.push(s);
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return 'TA 这次引用了 ' + parts.length + ' 条消息：' + parts.join(' ');
}

function state() {
  const cfg = options();
  let n = 0;
  try { n = fs.readdirSync(dirOf(cfg)).filter(f => f.endsWith('.json')).length; } catch (e) { n = 0; }
  return { dir: dirOf(cfg), files: n, ...cfg };
}

function clearCache(cfg) {
  const d = dirOf(cfg);
  let n = 0;
  try {
    for (const f of fs.readdirSync(d)) { if (f.endsWith('.json')) { try { fs.unlinkSync(path.join(d, f)); n++; } catch (e) { } } }
  } catch (e) { }
  return n;
}

/** 字符二元组（粗比较「话头像不像」，不依赖分词） */
function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 主动引用：从这段关系最近的对话里，挑一条「值得被接上」的旧消息。
 * 排除：自己说的、没有真 seq 的、太短的、纯媒体、吵架/负面、太久以前的。
 * @returns {{seq:string,text:string,at:number,score:number,why:string}|null}
 */
function pickForQuote(key, opts = {}) {
  const o = { ...DEFAULTS, ...(opts.cfg || {}) };
  if (o.enabled === false) return null;
  const maxAgeDays = Number(opts.maxAgeDays || 7);
  const minChars = Number(opts.minChars || 6);
  const now = Number(opts.now) || Date.now();
  const topic = bigrams(opts.topic || '');
  let history = [];
  try { history = require('./context.js').view(key, { now }).history || []; } catch (e) { return null; }
  const NEG = /滚|闭嘴|别烦|讨厌|生气|吵架|失望|不理你|分手|懒得|烦死/;
  const cands = [];
  for (const h of history) {
    if (!h || h.from === 'me') continue;
    const seq = h.seq != null ? String(h.seq) : '';
    if (!seq) continue;
    const text = String(h.text || '').trim();
    if (text.length < minChars) continue;
    if (/^\[(图片|表情包|语音|视频|文件|合并转发)/.test(text)) continue;
    if (NEG.test(text)) continue;
    const ageH = (now - Number(h.t || 0)) / 3600e3;
    if (!(ageH >= 0) || ageH > maxAgeDays * 24) continue;
    let score = 0;
    if (topic.size) {
      const b = bigrams(text);
      let hit = 0;
      for (const x of topic) if (b.has(x)) hit++;
      score += hit * 2;
    }
    if (/答应|说好|约好|一起|下次|回头|到时候|周末|明天|考完/.test(text)) score += 3;
    if (text.length >= 10) score += 1;
    score += Math.max(0, 3 - ageH / 48);
    cands.push({ seq, text: text.slice(0, 200), at: Number(h.t) || 0, score: Math.round(score * 100) / 100 });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score || b.at - a.at);
  const best = cands[0];
  best.why = topic.size ? '跟这次的话头对得上' : '最近说过的一句';
  return best;
}

module.exports = {
  pickForQuote, bigrams,
  DEFAULTS, options, DIR, dirOf, fileOf, ensureDir,
  kindsOf, textOfSegs, imageFilesOf, parse, fetchOne, collect,
  whenText, whoText, describe, noteFor, state, clearCache
};
