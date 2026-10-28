#!/usr/bin/env node
/**
 * mind.js — 让这个号「像人一样记得、有情绪、会联想」。
 *
 * 设计来自用户那份方案（Obsidian: 繁星的收获/繁星の收获/DSH经验/聊天记忆方案.md），
 * 三层各司其职，关键是「全量痕迹退到最底层，默认回复路径不碰它」：
 *
 *   ① 痕迹层 logs/trace/<slug>.jsonl
 *      原始收发、完整 prompt/response、思考过程、状态更新……append-only，全量。
 *      默认回复路径**不读**它，只在「巩固」和事后审计时用 —— 这就是「全量保存」的优势所在：
 *      人可以忘，我们的底稿永远在；忘了的只是「提取不到的路径」，不是数据。
 *
 *   ② 状态层 logs/mind/<slug>-state.json
 *      瞬时情感 PAD（愉悦 P / 唤醒 A / 控制感 D）+ 二阶惯性（不是每轮覆盖，是带着趋势滑），
 *      关系向量（温暖/信任/亲密/张力，周月尺度缓变）+ 一句「关系种子」。
 *      纯数学，零 token。
 *
 *   ③ 联想层 logs/mind/<slug>-graph.json
 *      记忆图：节点 = 结构化记忆（内容、编码时的情感指纹、显著性、被提取的时间列表），
 *      边 = 语义/时间/情绪/因果的带权连接。
 *      激活用 ACT-R 幂律：B = ln(Σ t_j^-d)，t 是每次被提取距今的时间（天）；
 *      情感显著性调制衰减：d_eff = d·(1-γ·salience) —— 高唤醒的事记得更牢。
 *      检索 = 种子激活（语义 + 情绪一致性）→ 沿边扩散 → 阈值截断 → 少量噪声。
 *      只对激活子图算，成本不随总历史线性增长；只有越阈的少数几条进 prompt。
 *
 * 情感不直接「生成」回复，它调制「想起什么」—— 这是这套设计里最关键的边界。
 *
 * 单独试：
 *   node scripts/mind.js recall p:100000001 "考试考得怎么样"
 *   node scripts/mind.js state p:100000001
 *   node scripts/mind.js graph p:100000001
 *   node scripts/mind.js demo
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.QQMIND_DIR || path.join(ROOT, 'logs', 'mind');
const TRACE_DIR = process.env.QQTRACE_DIR || path.join(ROOT, 'logs', 'trace');
const CFG_PATH = process.env.QMIND_CONFIG || path.join(ROOT, 'config', 'mind.json');

const DEFAULTS = {
  enabled: true,
  // ── 瞬时情感（分钟级）：二阶惯性，别让一句话把人设掀翻
  alpha: 0.3,            // 响应速度
  beta: 0.2,             // 惯性强度（趋势保持）
  // ── 关系层（周/月级）：只在对关系有意义的事件上挪一小步
  relationRate: 0.06,
  // ── 联想层
  decayRate: 0.5,        // ACT-R 的 d（标准 0.5；0.15 更平缓）
  gamma: 0.3,            // 情感显著性对衰减的放大
  hops: 2,               // 扩散跳数（关系深可以给 3）
  threshold: 0.18,       // 越阈才进 prompt
  seedMax: 6,
  injectMax: 5,          // 最多注入几条回忆
  injectChars: 600,      // 回忆总字数上限
  noiseSigma: 0.05,      // 拟人化噪声：别每次都想起一模一样的东西
  mergeSim: 0.82,        // 这么像就并进旧节点，别再长一条
  pruneEdgeBelow: 0.12,  // 只修剪「读取路径」上的低权重边，节点与痕迹不删
  nodesMax: 2000,
  // ── 巩固
  consolidateEvery: 10,  // 攒够这么多轮来消息就巩固一次
  consolidateTurns: 20,  // 巩固时喂给抽取器的最近原文条数
  consolidateIdleMin: 45,
  bootstrapTurns: 3,
  sweepEveryMin: 10, sweepIdleMin: 45,     // 图还是空的：攒够这几轮就先巩固一次
  // ── 痕迹
  trace: true,
  traceMaxBytes: 8 * 1024 * 1024
};

let cfg = { ...DEFAULTS };
function loadCfg() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { /* 缺省即默认 */ }
  return { ...DEFAULTS, ...file };
}
function configure(c) { cfg = { ...DEFAULTS, ...(c || {}) }; return cfg; }
function options() { return { ...cfg }; }
configure(loadCfg());

// ── 文件 ──────────────────────────────────────────────────────────────────
function slugOf(key) { return String(key).replace(/[^0-9a-zA-Z_.-]+/g, '_').slice(0, 80); }
const stateFile = (key) => path.join(DIR, slugOf(key) + '-state.json');
const graphFile = (key) => path.join(DIR, slugOf(key) + '-graph.json');
const traceFile = (key) => path.join(TRACE_DIR, slugOf(key) + '.jsonl');

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 忽略 */ }
}

/** 原子写 + 重试（E:\ 上 rename 偶发 EIO；context.js 同款兜底，宁可短暂非原子也不能丢）。 */
function writeAtomic(file, data) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const tmp = `${file}.${process.pid}.${i}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
      sleepMs(15 + 25 * i);
    }
  }
  try { fs.writeFileSync(file, data); return true; } catch (e) { lastErr = e; }
  try {
    fs.appendFileSync(path.join(ROOT, 'logs', 'mind-error.log'),
      JSON.stringify({ t: Date.now(), file, err: String(lastErr && lastErr.message) }) + '\n');
  } catch (e2) { /* 忽略 */ }
  return false;
}

function readJson(file, def) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : def;
  } catch (e) { return def; }
}

// ── 痕迹层：全量，append-only ─────────────────────────────────────────────
function appendTrace(key, rec) {
  if (!cfg.trace) return;
  const file = traceFile(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 太大就轮转，别让一个文件无限长（轮转不等于删除：旧文件留着可审计）
    try {
      const st = fs.statSync(file);
      if (st.size > (cfg.traceMaxBytes || 8 * 1024 * 1024)) {
        fs.renameSync(file, file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
      }
    } catch (e) { /* 文件还不存在 */ }
    fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...rec }) + '\n');
  } catch (e) { /* 痕迹丢了不影响聊天 */ }
}

// ── 状态层 ────────────────────────────────────────────────────────────────
const clamp1 = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

function blankState(key, kind, peer) {
  const now = Date.now();
  return {
    key, kind: kind || 'private', peer: peer || {},
    createdAt: now, updatedAt: now, firstSeen: now, lastSeen: now,
    pad: { p: 0, a: 0, d: 0 },
    padPrev: { p: 0, a: 0, d: 0 },
    rel: { warmth: 0.15, trust: 0.1, intimacy: 0.05, tension: 0 },
    msgCount: 0, pendingConsolidate: 0,
    lastConsolidateAt: 0, lastTurnAt: 0,
    relSeed: '', relSeedAt: 0,
    lastAffect: null
  };
}

function loadState(key, kind, peer) {
  const s = readJson(stateFile(key), null);
  if (!s) return blankState(key, kind, peer);
  const b = blankState(key, kind, peer);
  return {
    ...b, ...s,
    pad: { ...b.pad, ...(s.pad || {}) },
    padPrev: { ...b.padPrev, ...(s.padPrev || {}) },
    rel: { ...b.rel, ...(s.rel || {}) }
  };
}
function saveState(st) {
  st.updatedAt = Date.now();
  return writeAtomic(stateFile(st.key), JSON.stringify(st));
}

/**
 * 瞬时情感：二阶更新（指数平滑 + 动量）
 *   E_t = E_{t-1} + α(E_ext - E_{t-1}) + β(E_{t-1} - E_{t-2})
 * 结果里有"趋势保持"：正在变好时继续偏一点好，正在变差时也不会被一句话瞬间拉回。
 */
function updatePad(st, ext, o = cfg) {
  const a = Number(o.alpha ?? 0.3);
  const b = Number(o.beta ?? 0.2);
  const target = {
    p: clamp1(ext && ext.pad ? ext.pad.p : 0),
    a: clamp1(ext && ext.pad ? ext.pad.a : 0),
    d: clamp1(ext && ext.pad ? ext.pad.d : 0)
  };
  const prev = { ...st.pad };
  const out = {};
  for (const k of ['p', 'a', 'd']) {
    const momentum = prev[k] - (st.padPrev ? st.padPrev[k] : 0);
    out[k] = clamp1(prev[k] + a * (target[k] - prev[k]) + b * momentum);
  }
  st.padPrev = prev;
  st.pad = { p: round3(out.p), a: round3(out.a), d: round3(out.d) };
  st.lastAffectAt = Date.now();
  return st.pad;
}

// 关系事件 → 关系向量的小步移动（只在对关系有意义的事件上）
const REL_RULES = {
  'self-disclosure': { warmth: 0.7, trust: 1.0, intimacy: 0.6 },
  shared: { warmth: 0.6, intimacy: 0.8, trust: 0.3 },
  affection: { warmth: 1.0, intimacy: 0.9, trust: 0.4 },
  plan: { warmth: 0.4, trust: 0.3, intimacy: 0.3 },
  conflict: { tension: 1.0, warmth: -0.5, trust: -0.3 },
  repair: { tension: -1.2, warmth: 0.8, trust: 0.8 },
  request: { warmth: 0.2, trust: 0.1 },
  withdrawal: { tension: 0.6, warmth: -0.3 }
};

/** 关系层：慢、有下限保护（一次负面交互不能把信任清零）。 */
function updateRelation(st, events, o = cfg) {
  const rate = Number(o.relationRate ?? 0.06);
  const list = Array.isArray(events) ? events : [];
  let moved = 0;
  for (const ev of list) {
    const rule = REL_RULES[String(ev || '').trim()] || null;
    if (!rule) continue;
    for (const [k, delta] of Object.entries(rule)) {
      const before = Number(st.rel[k] || 0);
      st.rel[k] = round3(clamp1(before + rate * delta));
      if (k !== 'tension') st.rel[k] = Math.max(-0.6, st.rel[k]);
      if (Math.abs(st.rel[k] - before) > 0) moved++;
    }
  }
  // 张力自己会松（不记仇，但也记得发生过）
  st.rel.tension = round3(clamp1(Number(st.rel.tension || 0) * 0.97));
  // 四轴永远落在 0~1：repair/conflict 反复叠加后不能出现负数（否则想念公式里 (1+1.2×tension) 会小于 1）
  for (const k of ['warmth', 'trust', 'intimacy', 'tension']) st.rel[k] = round3(Math.max(0, Math.min(1, Number(st.rel[k]) || 0)));
  st.relUpdatedAt = Date.now();
  return { moved, rel: st.rel };
}

// ── 把数字翻译成人话（绝不给模型看向量） ────────────────────────────────
function describeMood(st) {
  const p = st && st.pad ? Number(st.pad.p) || 0 : 0;
  const a = st && st.pad ? Number(st.pad.a) || 0 : 0;
  const d = st && st.pad ? Number(st.pad.d) || 0 : 0;
  const mood = p > 0.35 ? '挺高兴' : p > 0.12 ? '心情不错' : p > -0.12 ? '比较平静' : p > -0.35 ? '有点闷' : '有点低落';
  const energy = a > 0.35 ? '精神头足、话可能多一点' : a > 0.1 ? '状态还行' : a > -0.2 ? '有点懒' : '有点累、懒得打字';
  const grip = d > 0.3 ? '心里比较有底' : d > -0.25 ? '' : '有点没把握';
  const parts = [mood, energy]; // mood 自己就带「心情」前缀，别再叠一层（曾经拼出「心情心情不错」）
  if (grip) parts.push(grip);
  const tone = p > 0.25 && a > 0.15 ? '语气可以更放得开、带点笑' : p < -0.25 ? '语气收着点，别硬撑着热闹' : '正常聊天就行，别刻意';
  return { mood, energy, tone, text: `${parts.join('，')}（${tone}）` };
}

function describeBond(st) {
  const r = (st && st.rel) || {};
  const w = Number(r.warmth) || 0, t = Number(r.trust) || 0, i = Number(r.intimacy) || 0, x = Number(r.tension) || 0;
  const degree = w + t + i >= 1.2 ? '关系挺近的熟人' : w + t + i >= 0.6 ? '聊得来的朋友' : w + t + i >= 0.25 ? '认识、还有点客气' : '不太熟';
  const bits = [];
  if (t > 0.5) bits.push('TA 挺愿意跟你说心里话，你也别端着');
  if (i > 0.45) bits.push('你们之间有点亲昵，可以随便一点');
  if (w > 0.55 && t <= 0.5) bits.push('你对 TA 挺有好感、愿意多聊两句');
  if (x > 0.25) bits.push('最近有点别扭/小摩擦没完全过去，别装没事，也别急着道歉');
  if (st && st.relSeed) bits.push(`这层关系最近的底色：${st.relSeed}`);
  return { degree, text: `${degree}${bits.length ? '；' + bits.join('；') : ''}` };
}

function describe(st) {
  return { mood: describeMood(st), bond: describeBond(st) };
}

// ── 联想层 ────────────────────────────────────────────────────────────────
function blankGraph(key, kind, peer) {
  return { key, kind: kind || 'private', peer: peer || {}, createdAt: Date.now(), updatedAt: Date.now(), nodes: [], edges: [] };
}
function loadGraph(key, kind, peer) {
  const g = readJson(graphFile(key), null);
  if (!g) return blankGraph(key, kind, peer);
  const b = blankGraph(key, kind, peer);
  return { ...b, ...g, nodes: Array.isArray(g.nodes) ? g.nodes : [], edges: Array.isArray(g.edges) ? g.edges : [] };
}
function saveGraph(g) {
  g.updatedAt = Date.now();
  return writeAtomic(graphFile(g.key), JSON.stringify(g));
}

function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (!out.size && t) out.add(t);
  return out;
}
/** 廉价语义相似度：字符二元组 Jaccard（不调模型、不建向量库，够用且零成本）。 */
function sim(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 情绪一致性：当前情感与记忆编码时的情感指纹有多"同调"（0..1，0.6 = 中性）。 */
function congruence(pad, fp) {
  if (!fp || typeof fp !== 'object') return 0.6;
  const cur = { p: Number(pad && pad.p) || 0, a: Number(pad && pad.a) || 0, d: Number(pad && pad.d) || 0 };
  const dp = Math.abs(cur.p - (Number(fp.p) || 0));
  const da = Math.abs(cur.a - (Number(fp.a) || 0)) * 0.5;
  const dd = Math.abs(cur.d - (Number(fp.d) || 0)) * 0.3;
  return clamp01(1 - (dp + da + dd) / 1.8);
}

/** ACT-R 基础激活：B = ln(Σ t_j^-d_eff)，t 用「天」（下限 30 分钟防止爆炸）。 */
function activation(node, now = Date.now(), o = cfg) {
  const acc = Array.isArray(node.accesses) && node.accesses.length ? node.accesses : [node.t || now];
  const dEff = Math.max(0.05, Math.min(0.9, Number(o.decayRate ?? 0.5) * (1 - Number(o.gamma ?? 0) * clamp01(node.salience))));
  let sum = 0;
  for (const ts of acc) {
    const days = Math.max(0.02, (now - (Number(ts) || now)) / 86400000);
    sum += Math.pow(days, -dEff);
  }
  return sum > 0 ? Math.log(sum) : -10;
}
const normAct = (base) => clamp01((Number(base) + 2.5) / 5);

function idOf(text, t) {
  let h = 0;
  const s = String(text) + '|' + String(t);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'm' + h.toString(36);
}

function link(g, a, b, type, w, now = Date.now()) {
  if (a === b) return null;
  const hit = g.edges.find(e => e.type === type && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));
  if (hit) { hit.w = Math.min(1, Math.max(hit.w, w)); hit.at = now; return hit; }
  const e = { a, b, type, w: Math.max(0.05, Math.min(1, w)), at: now };
  g.edges.push(e);
  return e;
}

/** 加一个记忆节点；太像的就并进旧的（认知上这叫"同一个记忆被再次唤醒"）。 */
function addNode(g, node, o = cfg) {
  const text = String(node && node.text || '').trim().slice(0, 240);
  if (!text) return { added: false, node: null };
  const now = node.t || Date.now();
  const hit = g.nodes.find(n => n && n.text && sim(n.text, text) > Number(o.mergeSim ?? 0.82));
  if (hit) {
    hit.accesses = Array.isArray(hit.accesses) ? hit.accesses : [hit.t || now];
    hit.accesses.push(now);
    hit.salience = Math.max(Number(hit.salience) || 0, Number(node.salience) || 0);
    hit.importance = Math.max(Number(hit.importance) || 0, Number(node.importance) || 0);
    hit.lastAccess = now;
    return { added: false, node: hit };
  }
  const n = {
    id: idOf(text, now), text, kind: node.kind || 'event', t: now,
    accesses: [now], lastAccess: now,
    salience: clamp01(node.salience ?? 0.4),
    importance: clamp01(node.importance ?? 0.5),
    pad: node.pad ? { p: clamp1(node.pad.p), a: clamp1(node.pad.a), d: clamp1(node.pad.d) } : null,
    src: node.src || 'turn'
  };
  g.nodes.push(n);

  // 连边：语义最近的 3 条 + 时间上最近的那条 + 情绪上最同调的那条
  const others = g.nodes.filter(x => x.id !== n.id);
  const bySem = others.map(x => ({ x, s: sim(x.text, text) })).sort((a, b) => b.s - a.s);
  let linked = 0;
  for (const c of bySem.slice(0, 3)) {
    if (c.s >= 0.18) { link(g, n.id, c.x.id, 'semantic', c.s, now); linked++; }
  }
  const byTime = others.slice().sort((a, b) => Math.abs((a.t || 0) - now) - Math.abs((b.t || 0) - now))[0];
  if (byTime) { link(g, n.id, byTime.id, 'temporal', 0.5, now); linked++; }
  if (n.pad) {
    const byMood = others
      .filter(x => x.pad)
      .map(x => ({ x, c: congruence(n.pad, x.pad) }))
      .sort((a, b) => b.c - a.c)[0];
    if (byMood && byMood.c > 0.7) { link(g, n.id, byMood.x.id, 'emotional', 0.45, now); linked++; }
  }
  return { added: true, node: n, linked };
}

function gauss() {
  // Box-Muller；一次调用够用
  const u = Math.max(1e-9, Math.random());
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 检索：种子激活 → 沿边扩散 → 阈值截断。
 * 只读图（几百个节点），不做全量历史扫描；成本与「越阈节点数」成正比。
 */
function recall(key, query, opts = {}) {
  const o = { ...cfg, ...opts };
  if (!o.enabled) return { memories: [], ids: [], state: null, mood: '', bond: '' };
  const st0 = loadState(key);
  // 关系事件脉冲（吵架/帮忙/约见面…）会衰减，这里把「平滑基线 + 还没散掉的情绪」合成当下的关系
  const st = (() => {
    try { const bonds = require('./bonds.js'); return { ...st0, rel: bonds.effectiveRel(key, st0.rel) }; }
    catch (e) { return st0; }
  })();
  const g = loadGraph(key);
  // 「忘掉」＝不主动提（muted）：默认跳过；opts.includeMuted（被提醒）时才参与召回
  const _all = (g.nodes || []).filter((n) => !(n && n.forgotten));
  const _kept = o.includeMuted === true ? _all : _all.filter((n) => !(n && n.muted));
  const _ids = new Set(_kept.map((n) => n.id));
  g.nodes = _kept;
  g.edges = (g.edges || []).filter((e) => e && _ids.has(e.a) && _ids.has(e.b));
  const now = Date.now();
  const q = String(query || '');
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  if (!g.nodes.length) {
    return { memories: [], ids: [], state: st, mood: describeMood(st).text, bond: describeBond(st).text, seeds: 0 };
  }

  // ① 种子：语义像 + 情绪同调 + 本来就有底子（激活高）
  const act = new Map();
  for (const n of g.nodes) act.set(n.id, activation(n, now, o));
  const seeds = [];
  for (const n of g.nodes) {
    const s = 0.62 * sim(q, n.text) + 0.23 * congruence(st.pad, n.pad) + 0.15 * normAct(act.get(n.id));
    if (s > 0.12) seeds.push({ n, s });
  }
  seeds.sort((a, b) => b.s - a.s);
  const cur = new Map();
  for (const s of seeds.slice(0, o.seedMax)) cur.set(s.n.id, s.s);

  // ② 扩散：spread = 当前激活 × 边权 × 情绪一致性
  const adj = new Map();
  for (const e of g.edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push({ to: e.b, w: e.w });
    adj.get(e.b).push({ to: e.a, w: e.w });
  }
  for (let hop = 0; hop < (o.hops ?? 2); hop++) {
    const add = new Map();
    for (const [id, v] of cur) {
      for (const { to, w } of adj.get(id) || []) {
        const n2 = byId.get(to);
        if (!n2) continue;
        const contrib = v * w * congruence(st.pad, n2.pad) * 0.8;
        if (contrib > (add.get(to) || 0)) add.set(to, contrib);
      }
    }
    for (const [id, v] of add) if (v > (cur.get(id) || 0)) cur.set(id, v);
  }

  // ③ 情感加成 + 拟人噪声 + 阈值
  const scored = [];
  for (const [id, v] of cur) {
    const n = byId.get(id);
    if (!n) continue;
    const score = v * (1 + 0.5 * congruence(st.pad, n.pad)) + gauss() * Number(o.noiseSigma ?? 0);
    if (score >= (o.threshold ?? 0.18)) scored.push({ n, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // ④ 条数与字数双上限
  const picked = [];
  let chars = 0;
  for (const s of scored) {
    if (picked.length >= (o.injectMax ?? 5)) break;
    const len = String(s.n.text).length;
    if (chars + len > (o.injectChars ?? 600)) continue;
    picked.push(s);
    chars += len;
  }

  // ⑤ 被想起来 = 又被提取了一次 → 记进 accesses，这条记忆以后衰减得更慢
  if (picked.length) {
    for (const p of picked) {
      p.n.accesses = Array.isArray(p.n.accesses) ? p.n.accesses : [p.n.t || now];
      p.n.accesses.push(now);
      p.n.lastAccess = now;
      if (p.n.accesses.length > 40) p.n.accesses = p.n.accesses.slice(-40);
    }
    saveGraph(g);
  }
  const pickedMemories = picked.map(p => ({ id: p.n.id, text: p.n.text, kind: p.n.kind, score: round3(p.score) }));
  appendTrace(key, { type: 'recall', q: String(q).slice(0, 200), seeds: seeds.length, picked: pickedMemories.map(m => m.id) });
  return {
    memories: pickedMemories.map(m => m.text),
    picked: pickedMemories,
    ids: pickedMemories.map(m => m.id),
    state: st,
    mood: describeMood(st).text,
    bond: describeBond(st).text,
    seeds: seeds.length
  };
}

/**
 * 巩固：唯一读写痕迹层的窗口。
 * 从最近原文里抽出结构化节点写进图、更新关系种子、修剪低权重边（只剪读取路径）。
 */
async function consolidate(key, opts = {}) {
  const o = { ...cfg, ...(opts.mind || {}) };
  const st = opts.state || loadState(key);
  const g = loadGraph(key);
  const now = Date.now();
  const turns = Array.isArray(opts.turns) ? opts.turns : [];
  let added = 0, merged = 0, seed = st.relSeed || '';
  let extracted = null;
  if (typeof opts.extract === 'function' && turns.length) {
    try { extracted = await opts.extract(turns.slice(-(o.consolidateTurns ?? 20))); }
    catch (e) {
      appendTrace(key, { type: 'consolidate-error', err: String(e && e.message).slice(0, 200) });
      throw e;
    }
    for (const n of (extracted && extracted.nodes) || []) {
      const r = addNode(g, {
        text: n.text,
        kind: n.kind || 'event',
        t: now,
        salience: n.salience ?? 0.4,
        importance: n.importance ?? 0.5,
        pad: n.pad || st.pad,
        src: 'consolidate'
      }, o);
      if (r.added) added++; else if (r.node) merged++;
    }
    if (extracted && extracted.seed) { st.relSeed = String(extracted.seed).slice(0, 160); st.relSeedAt = now; seed = st.relSeed; }
  } else if (!seed) {
    st.relSeed = `${describeBond(st).degree}，聊了 ${st.msgCount || 0} 轮`;
    st.relSeedAt = now;
    seed = st.relSeed;
  }

  // 修剪：只剪边（读取路径），不删节点、更不删痕迹
  const before = g.edges.length;
  g.edges = g.edges.filter(e => Number(e.w) >= Number(o.pruneEdgeBelow ?? 0.12) || (now - (Number(e.at) || 0)) < 3 * 86400000);
  const pruned = before - g.edges.length;

  // 节点上限：按激活值留最强的（超出的节点仍在痕迹层里，随时可重建）
  if (g.nodes.length > (o.nodesMax ?? 2000)) {
    const keep = g.nodes.map(n => ({ n, a: activation(n, now, o) })).sort((x, y) => y.a - x.a).slice(0, o.nodesMax).map(x => x.n);
    const ids = new Set(keep.map(n => n.id));
    g.nodes = keep;
    g.edges = g.edges.filter(e => ids.has(e.a) && ids.has(e.b));
  }

  g.updatedAt = now;
  saveGraph(g);
  st.lastConsolidateAt = now;
  st.pendingConsolidate = 0;
  st.relSeed = seed;
  saveState(st);
  appendTrace(key, {
    type: 'consolidate', added, merged, pruned,
    nodes: g.nodes.length, edges: g.edges.length, seed: String(seed).slice(0, 160)
  });
  return { added, merged, pruned, nodes: g.nodes.length, edges: g.edges.length, seed };
}

/**
 * 一轮聊完后的状态更新（异步调用，不挡回复）：
 * 记痕迹 → 估情感（一次小调用）→ 更新 PAD/关系 → 到时巩固。
 *
 * info: { evt, text, reply, nick, kind, peer, trace, affect():Promise<ext>, extract(turns):Promise<out>, turns, forceConsolidate }
 */
async function afterTurn(key, info = {}) {
  const o = { ...cfg, ...(info.mind || {}) };
  if (!o.enabled) return null;
  const now = Date.now();

  // ① 痕迹：原始事件 + 我看到的/回出去的（全量，读的时候不碰）
  if (o.trace) {
    appendTrace(key, {
      type: 'turn',
      kind: info.kind, peer: info.peer,
      nick: info.nick || '',
      text: String(info.text || '').slice(0, 500),
      reply: String(info.reply || '').slice(0, 500),
      evt: info.evt ? { message_id: info.evt.message_id, time: info.evt.time, sender: info.evt.sender && { user_id: info.evt.sender.user_id, card: info.evt.sender.card, nickname: info.evt.sender.nickname }, message: info.evt.message } : undefined,
      think: info.trace || undefined
    });
  }

  const st = loadState(key, info.kind, info.peer);
  if (info.kind) st.kind = info.kind;
  if (info.peer && (info.peer.uin || info.peer.gid)) st.peer = { ...st.peer, ...info.peer };
  st.msgCount = (st.msgCount || 0) + 1;
  st.lastSeen = now;
  st.lastTurnAt = now;
  st.pendingConsolidate = (st.pendingConsolidate || 0) + 1;

  // ② 情感：只估一次，纯状态更新，不参与这次回复的生成
  let ext = null;
  if (typeof info.affect === 'function') {
    try {
      ext = await info.affect();
      if (ext && ext.pad) {
        updatePad(st, ext, o);
        updateRelation(st, ext.relationEvents || [], o);
        st.lastAffect = { pad: { ...st.pad }, salience: clamp01(ext.salience ?? 0.3), at: now };
        appendTrace(key, { type: 'affect', pad: ext.pad, salience: ext.salience, relationEvents: ext.relationEvents || [], mood: ext.mood || '' });
      }
    } catch (e) {
      appendTrace(key, { type: 'affect-error', err: String(e && e.message).slice(0, 200) });
    }
  }

  // ③ 到点就巩固（关系种子也在这里更新）
  const g = loadGraph(key);
  const idleMin = st.lastConsolidateAt ? (now - st.lastConsolidateAt) / 60000 : Infinity;
  const need = Boolean(info.forceConsolidate) ||
    st.pendingConsolidate >= (o.consolidateEvery ?? 10) ||
    (g.nodes.length === 0 && st.pendingConsolidate >= (o.bootstrapTurns ?? 3)) ||
    (idleMin >= (o.consolidateIdleMin ?? 45) && st.pendingConsolidate >= 2);
  let cons = null;
  if (need && typeof info.extract === 'function') {
    try {
      cons = await consolidate(key, { ...info, state: st, mind: o });
      if (cons) st.pendingConsolidate = 0;
    } catch (e) {
      appendTrace(key, { type: 'consolidate-fail', err: String(e && e.message).slice(0, 200) });
    }
  }

  saveState(st);
  return { state: st, affect: ext, consolidate: cons };
}

// ── 便捷：给 brain 的 ctx 里塞的那几段 ───────────────────────────────────
/** 被提醒检查：TA 这句话里提到了我「不主动提」的哪几条记忆 */
function mutedMatches(key, text) {
  const q = String(text || '');
  if (!q) return [];
  let g;
  try { g = loadGraph(key); } catch (e) { return []; }
  const out = [];
  for (const n of (g.nodes || [])) {
    if (!n || !n.muted || !n.text) continue;
    const kw = String(n.muteKeyword || '').trim();
    if (!kw) continue;
    if (q.includes(kw)) out.push({ id: n.id, text: String(n.text).slice(0, 120), keyword: kw });
  }
  return out;
}

function promptBits(key, query, opts = {}) {
  // 被提醒：TA 自己提到那个关键词时，才把 muted 的记忆取回来（只是不主动提，不是删掉）
  let reminded = [];
  let o = opts;
  try {
    const hit = mutedMatches(key, query);
    if (hit.length) { reminded = hit; o = { ...opts, includeMuted: true }; }
  } catch (e) { /* 忽略，退回普通召回 */ }
  const rec = recall(key, query, o);
  const st = rec.state;
  return {
    mood: rec.mood || (st ? describeMood(st).text : ''),
    bond: rec.bond || (st ? describeBond(st).text : ''),
    memories: rec.memories || [],
    picked: rec.picked || [],
    reminded,
    state: st
  };
}

// ── 空闲巩固：没有新消息时也会「反刍」 ───────────────────────────────────
/** 列出磁盘上所有会话的 key（扫 logs/mind/*-state.json）。 */
function allKeys() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('-state.json')); } catch (e) { return []; }
  const keys = [];
  for (const f of files) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (st && st.key) keys.push(st.key);
    } catch (e) { /* 坏文件跳过 */ }
  }
  return keys;
}

/**
 * 空闲巩固：挑出「还有没整理的轮次 + 已经静了一会儿」的会话，替它们做一次巩固。
 *
 * 为什么要它：afterTurn 只在**有新消息**时才会检查巩固，所以「聊完就各自忙去了」这种
 * 最该反刍的场景反而永远不触发；真人不是这样的，安静下来才会回想。
 *
 * opts: { extract(turns):Promise<{nodes,seed}>, turnsOf(key):turns[], idleMin, minPending, maxSessions, now }
 * 返回 { scanned, swept: [{key,pending,added,merged,seed}], skipped }
 */
async function sweep(opts = {}) {
  const o = { ...cfg, ...(opts.mind || {}), ...opts };
  if (!o.enabled) return { scanned: 0, swept: [], skipped: 'disabled' };
  if (typeof opts.extract !== 'function') return { scanned: 0, swept: [], skipped: 'no-extract' };
  const now = Number(opts.now) || Date.now();
  const idleMin = Number(opts.idleMin != null ? opts.idleMin : (o.consolidateIdleMin != null ? o.consolidateIdleMin : 45));
  const minPending = Number(opts.minPending != null ? opts.minPending : 1);
  const maxSessions = Number(opts.maxSessions != null ? opts.maxSessions : 2);
  const keys = allKeys();
  const swept = [];
  for (const key of keys) {
    if (swept.length >= maxSessions) break;
    const st = loadState(key);
    const pending = Number(st.pendingConsolidate) || 0;
    if (pending < minPending) continue;
    const sinceTurn = st.lastTurnAt ? (now - st.lastTurnAt) / 60000 : Infinity;
    if (sinceTurn < idleMin) continue;                                  // 还在聊，别打断
    if (st.lastSweepAt && now - st.lastSweepAt < 10 * 60000) continue;   // 别反复扫同一个人
    let turns = [];
    try { turns = typeof opts.turnsOf === 'function' ? (opts.turnsOf(key) || []) : []; } catch (e) { turns = []; }
    if (!turns.length) continue;                                        // 巩固要喂原文，没有就跳过
    try {
      const cons = await consolidate(key, { turns, extract: opts.extract, mind: o, state: st });
      st.lastSweepAt = now;
      saveState(st);
      appendTrace(key, { type: 'sweep', pending, idleMin: Math.round(sinceTurn), added: cons && cons.added, seed: cons && cons.seed });
      // 整理过就算一次（抽不出新节点也是有价值的判断：这几轮没有值得长期留的东西）
      swept.push({ key, pending, added: (cons && cons.added) || 0, merged: (cons && cons.merged) || 0, seed: (cons && cons.seed) || '' });
    } catch (e) {
      appendTrace(key, { type: 'sweep-fail', err: String(e && e.message).slice(0, 200) });
    }
  }
  return { scanned: keys.length, swept, skipped: null };
}

/**
 * 外部反拨：给状态层加一点点（有界）。
 * 回响层 echo.js 用——对话本身的反馈（回得快慢/长短/冷暖）不该由模型自己猜，
 * 但也不能像 bonds 事件那样一下推很多；这里只做「小步走」。
 */
function nudge(key, delta) {
  const st = loadState(key);
  const d = delta || {};
  const dp = d.pad || {};
  for (const k of ['p', 'a', 'd']) {
    if (Number.isFinite(Number(dp[k]))) st.pad[k] = clamp1(Number(st.pad[k] || 0) + Number(dp[k]));
  }
  const dr = d.rel || {};
  for (const k of ['warmth', 'trust', 'intimacy', 'tension']) {
    if (Number.isFinite(Number(dr[k]))) st.rel[k] = clamp01(Number(st.rel[k] || 0) + Number(dr[k]));
  }
  st.updatedAt = Date.now();
  saveState(st);
  return st;
}

module.exports = {
  DEFAULTS, configure, options, loadCfg,
  slugOf, stateFile, graphFile, traceFile,
  appendTrace,
  loadState, saveState, blankState, updatePad, updateRelation, describeMood, describeBond, describe,
  loadGraph, saveGraph, blankGraph, activation, congruence, sim, addNode, link, recall,
  consolidate, afterTurn, promptBits, allKeys, sweep, nudge,
  REL_RULES
};

// ── 命令行 ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const key = argv[1];
  const rest = argv.slice(2).join(' ');
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'state') out(loadState(key));
  else if (cmd === 'graph') {
    const g = loadGraph(key);
    out({ nodes: g.nodes.length, edges: g.edges.length, sample: g.nodes.slice(-8).map(n => ({ text: n.text, kind: n.kind, salience: n.salience, act: round3(activation(n)) })) });
  } else if (cmd === 'recall') out(recall(key, rest));
  else if (cmd === 'trace') {
    try { console.log(fs.readFileSync(traceFile(key), 'utf8').split('\n').slice(-8).join('\n')); } catch (e) { console.log('(没有痕迹)'); }
  } else if (cmd === 'demo') {
    const k = 'demo:user';
    process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-demo');
    process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-demo');
    const st = loadState(k);
    for (const x of [{ p: 0.6, a: 0.4, d: 0.1 }, { p: 0.2, a: -0.3, d: 0 }, { p: -0.5, a: -0.2, d: -0.1 }]) {
      updatePad(st, { pad: x }, cfg);
      console.log('PAD →', st.pad);
    }
    updateRelation(st, ['shared', 'affection'], cfg);
    console.log('关系 →', st.rel);
    console.log('心情 →', describeMood(st));
    console.log('关系 →', describeBond(st));
  } else if (cmd === 'sweep') {
    const ctx = require('./context.js');
    const brain = require('./brain.js');
    sweep({
      turnsOf: (k) => { try { return ctx.view(k).history || []; } catch (e) { return []; } },
      extract: (list) => brain.extractMemories(list, { nick: '对方' }),
      idleMin: Number(rest) || undefined
    }).then(r => out(r)).catch(e => { console.error('巩固失败:', e.message); process.exit(1); });
  } else {
    console.log('用法: node scripts/mind.js <state|graph|recall|trace|sweep|demo> [key] [query]');
  }
}
