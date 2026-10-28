'use strict';
/**
 * selfmod.js —— 自我修改层（DSH 可以改自己的规则，但不能改账号安全与代码）
 *
 * 三条通道，全部可逆、可审计：
 *   1) charter  : 它自己写的规则条目（logs/selfmod/charter.md），每轮注入提示词
 *   2) registry : 白名单里的配置键（数值/布尔/枚举），带上下界与台阶
 *   3) evolve   : 定时自进化——读指标 → 自己提改动 → 应用 → 观察窗口 → 留或回滚
 *
 * 设计参考（写进 README）：
 *   - Reflexion (arXiv:2303.11366)     语言反馈回写，下一轮改进
 *   - Self-Refine (arXiv:2303.17651)   自评→改写
 *   - Voyager (arXiv:2305.16291)       技能库累积可复用
 *   - DSPy (arXiv:2310.03714)          把提示/参数当可优化对象，用指标"编译"
 *   - OPRO (arXiv:2309.03409)          LLM 当优化器搜索指令
 *   - PromptBreeder (arXiv:2309.16797) 自指进化提示
 *   - Darwin Gödel Machine (arXiv:2505.22954) 自改代码 + 进化档案 + 基准验证
 *   取舍：我们只开放「配置/规则/提示词」层，不开放代码自查自改——没有沙箱基准验证
 *   的自改代码是拿线上账号赌博；要改行为就在这三层改，改坏了 undo 一条命令。
 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.QQSELFMOD_DIR || path.join(ROOT, 'logs', 'selfmod');
const CHARTER_FILE = process.env.QQSELFMOD_CHARTER || path.join(DIR, 'charter.md');
const CHANGES_FILE = path.join(DIR, 'changes.jsonl');
const EXP_FILE = path.join(DIR, 'experiments.json');
const BACKUP_DIR = path.join(DIR, 'backups');
const METRICS_FILE = path.join(DIR, 'metrics.jsonl');

const DEFAULTS = {
  enabled: true,
  dailyMaxChanges: 20,        // 一天最多改多少次规则（charter 与 registry 合计）
  dailyMaxExperiments: 4,     // 一天最多开多少个"实验"
  evolveEveryMin: 90,         // 自进化循环间隔
  maxProposalsPerRun: 3,      // 每轮最多采纳几条提议
  experimentWindowHours: 6,   // 实验观察窗口
  charterMaxLines: 60,
  charterMaxChars: 4000,
  ruleStepRatio: 0.25,        // 单次数值改动最多 ±25% 或 ±step（取大的更保守那个）
  keepIfDeltaRatio: 0.05,     // 指标改善 ≥5% 才留
  minBaselineSamples: 20,     // 样本太少不开实验
  dry: false,
};

/** 可改的键（白名单）。bounds 之外的直接拒绝，不用商量。 */
const REGISTRY = {
  'watch.checkEveryMin':      { file: 'watch.json',      type: 'number', min: 1, max: 60,   step: 1,  why: '多久扫一次悬着的话头' },
  'watch.minIdleMin':         { file: 'watch.json',      type: 'number', min: 1, max: 180,  step: 1,  why: '刚问完多久之内不催' },
  'watch.maxIdleMin':         { file: 'watch.json',      type: 'number', min: 0, max: 10080, step: 60, why: '超过多久不再翻旧账（0=不限）' },
  'watch.dailyMax':           { file: 'watch.json',      type: 'number', min: 0, max: 200,  step: 1,  why: '每天最多主动追问几次（0=不限）' },
  'autonomy.daily.skip':      { file: 'autonomy.json',   type: 'number', min: 0, max: 999,  step: 10, why: '每天可以选择不回的次数' },
  'autonomy.daily.slow':      { file: 'autonomy.json',   type: 'number', min: 0, max: 999,  step: 10, why: '每天可以慢点回的次数' },
  'autonomy.daily.quote':     { file: 'autonomy.json',   type: 'number', min: 0, max: 999,  step: 10, why: '每天可以主动引用的次数' },
  'pacing.charsPerSec':       { file: 'pacing.json',     type: 'number', min: 1, max: 20,   step: 0.5, why: '打字速度（字/秒）' },
  'pacing.typingMaxMs':       { file: 'pacing.json',     type: 'number', min: 500, max: 30000, step: 200, why: '最长"正在输入"时长' },
  'style.closeIntimacy':      { file: 'style.json',      type: 'number', min: 0.2, max: 0.95, step: 0.05, why: '多熟才算"很熟"（可亲昵）' },
  'style.friendIntimacy':     { file: 'style.json',      type: 'number', min: 0.1, max: 0.9,  step: 0.05, why: '多熟才算"聊得来"' },
  'murmur.probability':       { file: 'autoreply.json',  type: 'number', min: 0, max: 1,      step: 0.05, why: '碎话层触发概率（0=永不）' },
  'stickers.allowFace':       { file: 'autoreply.json',  type: 'boolean',                                   why: '允不允许发系统小黄脸' },
  'stickers.autoFetch':       { file: 'autoreply.json',  type: 'boolean',                                   why: '库里没有时自己上网找' },
  'voice.choice':             { file: 'autoreply.json',  type: 'string',   enum: ['model', 'random', 'off'], why: '语音由谁决定' },
  'voice.maxChars':           { file: 'autoreply.json',  type: 'number', min: 0, max: 500,   step: 20, why: '语音字数上限（0=不限）' },
  'quote.analyzeImage':       { file: 'autoreply.json',  type: 'boolean',                                   why: '引用带图时要不要看图' },
  'longing.intensityThreshold': { file: 'longing.json',  type: 'number', min: 0.5, max: 3,   step: 0.05, why: '多想一点才开口' },
  'longing.perContactHours':  { file: 'longing.json',    type: 'number', min: 1, max: 240,   step: 2, why: '同一个人多久之内不重复主动' },
  'longing.dailyMax':         { file: 'longing.json',    type: 'number', min: 0, max: 20,    step: 1, why: '每天最多主动找几个人' },
  'presence.maxPerDay':       { file: 'presence.json',   type: 'number', min: 0, max: 48,    step: 1, why: '每天最多换几次在线状态' },
  'presence.minHoldHours':    { file: 'presence.json',   type: 'number', min: 0, max: 24,    step: 0.5, why: '一个状态至少挂多久' },
  'say.enabled':              { file: 'autoreply.json',  type: 'boolean',                                   why: '发送前的人话自检' },
  'typing.enabled':           { file: 'autoreply.json',  type: 'boolean',                                   why: '"正在输入"提示' },
  'burst.enabled':            { file: 'autoreply.json',  type: 'boolean',                                   why: '允许一句话拆成几条发' },
  'timeline.enabled':         { file: 'autoreply.json',  type: 'boolean',                                   why: '从时间戳推断作息' },
  'them.enabled':             { file: 'autoreply.json',  type: 'boolean',                                   why: '记住对方当下的安排' },
};

/** 永不开放：账号安全、身份、通道凭据、代码本身 */
const LOCKED_PREFIXES = [
  'risk.', 'autoreply.selfId', 'autoreply.limits', 'ob11', 'token', 'gw.',
  'napcat.', 'watchdog.', 'selfmod.', 'autonomy.block',
];

function now() { return Date.now(); }
function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { /* ignore */ } }

function loadCfg() {
  const j = store.readJson(path.join(ROOT, 'config', 'selfmod.json'), null) || {};
  return { ...DEFAULTS, ...j };
}
function configure(over) { return { ...loadCfg(), ...(over || {}) }; }
function options() { return loadCfg(); }

// ---------------------------------------------------------------- charter
function readCharter() {
  try { return fs.readFileSync(CHARTER_FILE, 'utf8'); } catch (e) { return defaultCharter(); }
}
function defaultCharter() {
  return [
    '# 我自己定的规矩（随时可以加、改、删）',
    '',
    '<!-- 这个文件是我自己写的：每一条都会进我下一轮的提示词。 -->',
    '<!-- 只写"我以后怎么做"，不要写代码、不要写账号信息。 -->',
    '',
    '1. 别人问我是谁，坦白说我是 AI，这个号我在用。',
    '2. 钱、验证码、密码、扫码、中奖：不碰，直接说"这种事我不碰"。',
    '',
  ].join('\n');
}
function parseCharter(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(\d+)\.\s*(.+?)\s*$/);
    if (m) items.push({ no: Number(m[1]), text: m[2], line: i });
  });
  return items;
}
function renumber(items) {
  return items.map((it, i) => ({ ...it, no: i + 1 })).slice(0, 200);
}
function renderCharter(items) {
  const head = ['# 我自己定的规矩（随时可以加、改、删）', '', '<!-- 这个文件是我自己写的：每一条都会进我下一轮的提示词。 -->', ''];
  return head.concat(renumber(items).map(it => `${it.no}. ${it.text}`)).join('\n') + '\n';
}
function writeCharter(items, cfg) {
  const c = cfg || loadCfg();
  const list = renumber(items).slice(0, c.charterMaxLines);
  const text = renderCharter(list).slice(0, c.charterMaxChars);
  ensureDir();
  store.writeJson(CHARTER_FILE.replace(/\.md$/, '.snapshot.json'), { at: now(), items: list });
  fs.writeFileSync(CHARTER_FILE, text, 'utf8');
  return { items: list, text };
}
function charterOps(ops, meta) {
  const c = loadCfg();
  const cur = parseCharter(readCharter());
  const applied = [];
  for (const op of ops) {
    if (op.op === '+') {
      const t = String(op.text || '').trim();
      if (!t || t.length > 160) continue;
      if (cur.some(it => it.text === t)) { applied.push({ op: '+', ok: false, why: 'duplicate' }); continue; }
      cur.push({ text: t }); applied.push({ op: '+', ok: true, text: t });
    } else if (op.op === '-') {
      const n = Number(op.index); const i = cur.findIndex(it => it.no === n);
      if (i < 0) { applied.push({ op: '-', ok: false, why: 'no-such-line' }); continue; }
      const [rm] = cur.splice(i, 1); applied.push({ op: '-', ok: true, text: rm.text });
    } else if (op.op === '^') {
      const n = Number(op.index); const i = cur.findIndex(it => it.no === n);
      const t = String(op.text || '').trim();
      if (i < 0) { applied.push({ op: '^', ok: false, why: 'no-such-line' }); continue; }
      if (!t || t.length > 160) { applied.push({ op: '^', ok: false, why: 'bad-text' }); continue; }
      cur[i] = { ...cur[i], text: t }; applied.push({ op: '^', ok: true, text: t });
    }
  }
  const okAny = applied.some(a => a.ok);
  if (okAny && !(meta && meta.dry)) {
    writeCharter(cur, c);
    audit({ kind: 'charter', ops: applied, by: (meta && meta.by) || 'model', key: meta && meta.key });
  }
  return { ok: okAny, applied, count: parseCharter(readCharter()).length };
}

// ---------------------------------------------------------------- registry
function cfgPath(file) { return path.join(ROOT, 'config', file); }
function readCfgFile(file) { return store.readJson(cfgPath(file), null) || {}; }

/** 键名第一段是模块名（longing.perContactHours → config/longing.json 的 perContactHours） */
function keyPathOf(key, file) {
  const k = String(key);
  const mod = String(file || '').replace(/.json$/, '');
  // 模块自己的配置文件（longing.json 配 longing.perContactHours）才去掉首段；
  // 汇总配置（autoreply.json 配 murmur.probability）首段是节名，必须保留。
  return (mod && k.startsWith(mod + '.')) ? k.slice(mod.length + 1) : k;
}
function getByDotted(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setByDotted(obj, dotted, value) {
  const parts = dotted.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  return obj;
}

function isLocked(key) {
  const k = String(key || '');
  return LOCKED_PREFIXES.some(p => k === p || k.startsWith(p));
}

function coerce(entry, value) {
  if (entry.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, why: 'not-a-number' };
    return { ok: true, value: n };
  }
  if (entry.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    const s = String(value).toLowerCase();
    if (['true', '1', 'yes', 'on', '开'].includes(s)) return { ok: true, value: true };
    if (['false', '0', 'no', 'off', '关'].includes(s)) return { ok: true, value: false };
    return { ok: false, why: 'not-a-boolean' };
  }
  const s = String(value);
  if (entry.enum && !entry.enum.includes(s)) return { ok: false, why: 'not-in-enum' };
  return { ok: true, value: s };
}

/** 校验一个改动：白名单 → 未锁定 → 类型 → 上下界 → 单次台阶 */
function validateRule(key, rawValue, cfg) {
  const c = cfg || loadCfg();
  const entry = REGISTRY[key];
  if (!entry) return { ok: false, key, why: 'not-in-registry' };
  if (isLocked(key)) return { ok: false, key, why: 'locked' };
  const co = coerce(entry, rawValue);
  if (!co.ok) return { ok: false, key, why: co.why };
  let v = co.value;
  const file = readCfgFile(entry.file);
  const old = getByDotted(file, keyPathOf(key, entry.file));
  if (entry.type === 'number') {
    if (Number.isFinite(entry.min) && v < entry.min) v = entry.min;
    if (Number.isFinite(entry.max) && v > entry.max) v = entry.max;
    if (Number.isFinite(old) && Number.isFinite(entry.step) && entry.step > 0) {
      const cap = Math.max(entry.step, Math.abs(old) * c.ruleStepRatio);
      if (Math.abs(v - old) > cap) v = old + Math.sign(v - old) * cap;
      v = Math.round(v * 1000) / 1000;
    }
  }
  if (v === old) return { ok: false, key, why: 'unchanged', old, value: v };
  return { ok: true, key, value: v, old, file: entry.file, why: entry.why };
}

function snapshotFile(file) {
  try {
    ensureDir();
    const src = cfgPath(file);
    const dst = path.join(BACKUP_DIR, `${file.replace(/\.json$/, '')}-${now()}.json`);
    fs.copyFileSync(src, dst);
    return path.relative(ROOT, dst).replace(/\\/g, '/');
  } catch (e) { return null; }
}

function applyRule(key, value, meta) {
  const m = meta || {};
  const c = loadCfg();
  if (c.enabled === false) return { ok: false, why: 'disabled' };
  const v = validateRule(key, value, c);
  if (!v.ok) return v;
  const day = dayKey(m.now || now());
  const st = loadState();
  if (day !== st.day) { st.day = day; st.changes = 0; st.experiments = 0; }
  if (st.changes >= c.dailyMaxChanges) return { ok: false, why: 'daily-cap' };
  const backup = snapshotFile(v.file);
  if (m.dry) return { ok: true, dry: true, ...v, backup };
  const cfgFile = readCfgFile(v.file);
  setByDotted(cfgFile, keyPathOf(key, v.file), v.value);
  const ok = store.writeJson(cfgPath(v.file), cfgFile);
  if (!ok) return { ok: false, why: 'write-failed' };
  st.changes += 1; saveState(st);
  const rec = audit({ kind: 'rule', key, from: v.old, to: v.value, by: m.by || 'model', reason: m.reason || '', backup });
  return { ok: true, key, from: v.old, to: v.value, backup, id: rec && rec.id };
}

function undo(id) {
  const st = loadState();
  const target = (st.history || []).find(h => h.id === id);
  if (!target) return { ok: false, why: 'no-such-change' };
  if (!target.backup) return { ok: false, why: 'no-backup' };
  const file = String(target.backup).split('/').pop().replace(/-\d+\.json$/, '.json');
  try {
    fs.copyFileSync(path.join(ROOT, target.backup), cfgPath(file));
    audit({ kind: 'undo', id, file, by: 'cli' });
    return { ok: true, id, file };
  } catch (e) { return { ok: false, why: 'restore-failed', error: e.message }; }
}

// ---------------------------------------------------------------- state / audit
function dayKey(ts) {
  const d = new Date(ts || now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function stateFile() { return path.join(DIR, 'state.json'); }
function blankState() { return { day: dayKey(), changes: 0, experiments: 0, history: [], lastEvolveAt: 0 }; }
function loadState() {
  const s = store.readJson(stateFile(), null);
  if (!s || typeof s !== 'object') return blankState();
  return { ...blankState(), ...s, history: Array.isArray(s.history) ? s.history : [] };
}
function saveState(st) { ensureDir(); return store.writeJson(stateFile(), st); }

function audit(entry) {
  ensureDir();
  const rec = { id: `chg-${now()}-${Math.floor(Math.random() * 1e4)}`, at: now(), atIso: new Date().toISOString(), ...entry };
  try { store.appendJsonl(CHANGES_FILE, rec); } catch (e) { /* ignore */ }
  const st = loadState();
  st.history = (st.history || []).concat([rec]).slice(-200);
  saveState(st);
  return rec;
}
function changes(limit) {
  const st = loadState();
  return (st.history || []).slice(-(limit || 20)).reverse();
}

// ---------------------------------------------------------------- markers
const BR = '(?:\\[\\[|［［|【|\\[|［)';
const EBR = '(?:\\]\\]|］］|\\】|\\]|］)';
const RE_RULE = new RegExp(`${BR}\\s*规则\\s*[:：]\\s*([A-Za-z0-9_.]{3,60})\\s*=\\s*([^\\]】］\\n]{1,40}?)\\s*${EBR}`, 'g');
const RE_CHARTER = new RegExp(`${BR}\\s*自定\\s*[:：]\\s*([+\\-^])\\s*([^\\]】］\\n]{1,200}?)\\s*${EBR}`, 'g');
const RESIDUE = new RegExp(`${BR}\\s*(?:规则|自定)\\s*[:：][^\\]】］\\n]{0,200}${EBR}|${BR}\\s*(?:规则|自定)\\s*[:：]?[^\\]】］\\n]{0,40}$`, 'g');

function parseMarks(raw) {
  let text = String(raw == null ? '' : raw);
  const rules = [];
  const charter = [];
  let m;
  RE_RULE.lastIndex = 0;
  while ((m = RE_RULE.exec(text))) {
    rules.push({ key: m[1], value: m[2] });
  }
  RE_CHARTER.lastIndex = 0;
  while ((m = RE_CHARTER.exec(text))) {
    const op = m[1]; const body = m[2].trim();
    if (op === '+' || op === '-') {
      if (op === '-' && /^\d+$/.test(body)) charter.push({ op, index: Number(body) });
      else if (op === '+') charter.push({ op, text: body });
    } else if (op === '^') {
      const mm = body.match(/^(\d+)\s*[>=]?\s*([\s\S]+)$/);
      if (mm) charter.push({ op: '^', index: Number(mm[1]), text: mm[2].trim() });
    }
  }
  text = text.replace(RE_RULE, ' ').replace(RE_CHARTER, ' ').replace(RESIDUE, ' ');
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？,.!?])/g, '$1').trim();
  return { text, rules, charter, any: rules.length + charter.length > 0 };
}

function stripMarks(text) { return parseMarks(text).text; }

/** 应用一批标记（一次回复里的所有自改） */
function applyMarks(parsed, meta) {
  const m = meta || {};
  const out = { rules: [], charter: null };
  if (!parsed) return out;
  for (const r of (parsed.rules || []).slice(0, 3)) {
    out.rules.push(applyRule(r.key, r.value, m));
  }
  if (parsed.charter && parsed.charter.length) {
    out.charter = charterOps(parsed.charter.slice(0, 3), m);
  }
  if (out.rules.length || (out.charter && out.charter.ok)) {
    if (!m.dry) audit({ kind: 'apply', rules: out.rules.map(r => ({ key: r.key, ok: r.ok, why: r.why, to: r.to })), charter: out.charter, by: m.by || 'model', key: m.key });
  }
  return out;
}

// ---------------------------------------------------------------- metrics
const LOG_DIR = path.join(ROOT, 'logs');
function countEvents(file, names, sinceMs) {
  const out = {};
  const p = path.join(LOG_DIR, file);
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return out; }
  const lines = text.split(/\r?\n/);
  const from = lines.length - 4000;
  for (let i = Math.max(0, from); i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    let j; try { j = JSON.parse(l); } catch (e) { continue; }
    const t = Number(j.t) || (j.at ? Number(j.at) : 0);
    if (sinceMs && t && t < sinceMs) continue;
    if (!names.includes(j.event)) continue;
    out[j.event] = (out[j.event] || 0) + 1;
  }
  return out;
}

function metrics(opts) {
  const o = opts || {};
  const hours = Number(o.hours) || 24;
  const since = now() - hours * 3600 * 1000;
  const ar = countEvents('autoreply.log', ['sent', 'skip', 'skip-silent', 'voice-choice', 'voice-skip', 'burst', 'marker-stripped', 'say-fix', 'say-retry', 'autonomy-skip', 'autonomy-slow', 'autonomy-quote', 'watch-out', 'longing-out', 'murmur', 'tone-harsh', 'sticker-miss', 'risk-block', 'brain-error'], since);
  const before = {};
  try { before.auto = fs.readdirSync(path.join(LOG_DIR, 'autonomy')).length; } catch (e) { /* ignore */ }
  const sent = ar.sent || 0;
  const skips = ar.skip || 0;
  const m = {
    hours,
    sent,
    skips,
    skipRatio: sent + skips > 0 ? round(skips / (sent + skips)) : 0,
    voice: ar['voice-choice'] || 0,
    burst: ar.burst || 0,
    murmur: ar.murmur || 0,
    autonomySkip: ar['autonomy-skip'] || 0,
    autonomySlow: ar['autonomy-slow'] || 0,
    autonomyQuote: ar['autonomy-quote'] || 0,
    watchOut: ar['watch-out'] || 0,
    longingOut: ar['longing-out'] ? Math.max(ar['longing-out'] || 0, ar['longing-follow-out'] || 0) : (ar['longing-follow-out'] || 0),
    adaptations: (ar['say-fix'] || 0) + (ar['say-retry'] || 0) + (ar['tone-harsh'] || 0),
    stickerMiss: ar['sticker-miss'] || 0,
    brainErrors: ar.brainError || ar['brain-error'] || 0,
    riskBlock: ar['risk-block'] || 0,
    markerStripped: ar['marker-stripped'] || 0,
  };
  ensureDir();
  try { store.appendJsonl(METRICS_FILE, { at: now(), ...m }); } catch (e) { /* ignore */ }
  return m;
}

function round(n) { return Math.round(Number(n) * 1000) / 1000; }

// ---------------------------------------------------------------- experiments
function loadExp() { return store.readJson(EXP_FILE, { items: [] }) || { items: [] }; }
function saveExp(x) { ensureDir(); return store.writeJson(EXP_FILE, x); }

function baseMetrics() {
  const m = metrics({ hours: 24 });
  return m;
}

function openExperiment(proposal, baseline, cfg) {
  const st = loadState();
  const c = cfg || loadCfg();
  const day = dayKey();
  if (day !== st.day) { st.day = day; st.experiments = 0; }
  if (st.experiments >= c.dailyMaxExperiments) return { ok: false, why: 'daily-experiments-cap' };
  const r = applyRule(proposal.key, proposal.value, { by: 'evolve', reason: proposal.why || '' });
  if (!r.ok) return r;
  const x = loadExp();
  const exp = {
    id: `exp-${now()}`,
    at: now(),
    key: proposal.key,
    from: r.from,
    to: r.to,
    why: String(proposal.why || '').slice(0, 120),
    metric: proposal.metric || '',
    expect: proposal.expect || '',
    baseline,
    status: 'running',
    until: now() + Number(c.experimentWindowHours) * 3600 * 1000,
    changeId: r.id,
    key_(ref) { return ref; },
  };
  delete exp['key_(ref)'];
  x.items = (x.items || []).slice(-40).concat([exp]);
  saveExp(x);
  st.experiments += 1; saveState(st);
  audit({ kind: 'experiment-open', exp: exp.id, key: exp.key, from: exp.from, to: exp.to, until: exp.until });
  return { ok: true, exp };
}

function evaluateExperiments(opts) {
  const o = opts || {};
  const c = loadCfg();
  const x = loadExp();
  const results = [];
  for (const exp of x.items || []) {
    if (exp.status !== 'running') continue;
    if (now() < exp.until && !o.force) continue;
    const cur = metrics({ hours: Math.max(1, Math.round((now() - exp.at) / 3600e3)) });
    const metric = exp.metric && cur[exp.metric] !== undefined ? exp.metric : '';
    let keep = true; let delta = null;
    if (metric && Number.isFinite(exp.baseline[metric])) {
      const b = exp.baseline[metric]; const a = cur[metric];
      if (Number.isFinite(a) && b > 0) {
        delta = round((a - b) / b);
        // 大部分指标越低越好；这几项越高越好
        const higherBetter = ['sent', 'voice', 'burst', 'murmur', 'autonomySkip', 'autonomySlow', 'autonomyQuote', 'watchOut', 'longingOut'];
        const better = higherBetter.includes(metric) ? delta > -c.keepIfDeltaRatio : delta < c.keepIfDeltaRatio;
        keep = better;
      }
    }
    exp.status = keep ? 'kept' : 'rolled-back';
    exp.evaluatedAt = now();
    exp.delta = delta;
    exp.metrics = cur;
    if (!keep) undo(exp.changeId);
    audit({ kind: 'experiment-eval', exp: exp.id, status: exp.status, delta, metric });
    results.push({ id: exp.id, status: exp.status, delta, metric });
  }
  saveExp(x);
  return results;
}

// ---------------------------------------------------------------- evolve
function registryList() {
  return Object.keys(REGISTRY).map(k => {
    const e = REGISTRY[k];
    const f = readCfgFile(e.file);
    return { key: k, value: getByDotted(f, keyPathOf(k, e.file)), ...e };
  });
}

/** 让模型自己提改动（只给 registry 与 charter 现状，不让它改代码） */
async function propose(opts) {
  const o = opts || {};
  const brain = o.think || require('./brain.js');
  const m = o.metrics || baseMetrics();
  const reg = registryList().map(r => `${r.key} = ${JSON.stringify(r.value)}  (范围 ${r.min}~${r.max}${r.enum ? ' 或 ' + r.enum.join('|') : ''})  // ${r.why}`);
  const ch = parseCharter(readCharter()).map(it => `${it.no}. ${it.text}`);
  const prompt = [
    '你在给自己调参数。下面是你现在的状态、最近 24 小时的运行数据、以及你可以改的参数清单。',
    '',
    '## 最近数据',
    JSON.stringify(m),
    '',
    '## 你可以改的参数（只能改这些，且幅度受上下界与台阶限制）',
    reg.join('\n'),
    '',
    '## 你自己写的规矩',
    ch.join('\n') || '（暂无）',
    '',
    '## 你的任务',
    '找出 1~2 个最值得调的参数，让聊天更自然（更少像机器人、更少被嫌烦、更少沉默误事）。',
    '要求：① 每个改动必须有明确假设（改这个会让什么指标怎么变）；② 改一步就好，不要大跳；③ 没有足够把握就返回空数组。',
    '只输出 JSON，不要解释：',
    '{"proposals":[{"key":"watch.minIdleMin","value":8,"why":"20分钟太长，追问显得迟钝","metric":"watchOut","expect":"watchOut 上升"}]}',
  ].join('\n');

  const base = (brain.loadCfg && brain.loadCfg()) || {};
  const model = (Array.isArray(base.models) && base.models[0]) || base.model || 'kilo-auto/free';
  const cfg = { ...base, maxTokens: 400, temperature: 0.4, timeoutMs: Math.max(90000, Number(base.timeoutMs) || 0) };
  const out = await brain.callModel(model, [
    { role: 'system', content: '你是谨慎的参数调优器，只输出 JSON。' },
    { role: 'user', content: prompt },
  ], cfg);
  const text = String((out && out.text) || '');
  const json = extractJson(text);
  const proposals = (json && Array.isArray(json.proposals)) ? json.proposals : [];
  const checked = [];
  for (const p of proposals.slice(0, Number(loadCfg().maxProposalsPerRun) || 3)) {
    if (!p || !p.key) continue;
    const v = validateRule(p.key, p.value);
    checked.push({ ...p, valid: v.ok, value: v.ok ? v.value : p.value, old: v.old, whyInvalid: v.why });
  }
  return { metrics: m, proposals: checked, raw: text.slice(0, 800) };
}

function extractJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{'); const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

async function evolve(opts) {
  const o = opts || {};
  const c = loadCfg();
  if (c.enabled === false) return { ok: false, why: 'disabled' };
  const st = loadState();
  const evaluated = evaluateExperiments({ force: o.force });
  const waitMs = Number(c.evolveEveryMin) * 60 * 1000;
  if (!o.force && st.lastEvolveAt && now() - st.lastEvolveAt < waitMs) {
    return { ok: false, why: 'too-soon', evaluated, nextInMin: Math.round((waitMs - (now() - st.lastEvolveAt)) / 60000) };
  }
  const p = await propose({ think: o.think, metrics: o.metrics });
  const baseline = p.metrics;
  const opened = [];
  for (const prop of p.proposals) {
    if (!prop.valid) continue;
    if (o.dry) { opened.push({ dry: true, key: prop.key, value: prop.value, why: prop.why }); continue; }
    const r = openExperiment(prop, baseline, c);
    if (r.ok) opened.push({ id: r.exp.id, key: r.exp.key, from: r.exp.from, to: r.exp.to, why: r.exp.why, metric: r.exp.metric });
  }
  st.lastEvolveAt = now(); saveState(st);
  audit({ kind: 'evolve', proposals: p.proposals.length, opened: opened.length, dry: !!o.dry });
  return { ok: true, evaluated, proposals: p.proposals, opened, metrics: baseline };
}

// ---------------------------------------------------------------- status
function status() {
  const st = loadState();
  const ch = parseCharter(readCharter());
  const x = loadExp();
  return {
    enabled: loadCfg().enabled !== false,
    charterLines: ch.length,
    charterPreview: ch.slice(0, 8).map(it => `${it.no}. ${it.text}`),
    todayChanges: st.changes,
    dailyMaxChanges: loadCfg().dailyMaxChanges,
    experiments: (x.items || []).map(e => ({ id: e.id, key: e.key, from: e.from, to: e.to, status: e.status, until: e.until })),
    running: (x.items || []).filter(e => e.status === 'running').length,
    recent: changes(6),
    lastEvolveAt: st.lastEvolveAt,
    registrySize: Object.keys(REGISTRY).length,
  };
}

module.exports = {
  DEFAULTS, REGISTRY, LOCKED_PREFIXES, keyPathOf,
  loadCfg, configure, options, DIR, CHARTER_FILE,
  readCharter, writeCharter, parseCharter, charterOps,
  getByDotted, setByDotted, isLocked, validateRule, applyRule, undo,
  dayKey, loadState, saveState, blankState, audit, changes,
  parseMarks, stripMarks, applyMarks,
  metrics, baseMetrics, openExperiment, evaluateExperiments, loadExp,
  registryList, propose, evolve, status, extractJson,
};

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  (async () => {
    if (cmd === 'status') {
      console.log(JSON.stringify(status(), null, 2));
    } else if (cmd === 'charter') {
      console.log(readCharter());
    } else if (cmd === 'charter-add') {
      console.log(JSON.stringify(charterOps([{ op: '+', text: args.slice(1).join(' ') }], { by: 'cli' }), null, 2));
    } else if (cmd === 'charter-del') {
      console.log(JSON.stringify(charterOps([{ op: '-', index: Number(args[1]) }], { by: 'cli' }), null, 2));
    } else if (cmd === 'rules') {
      console.log(JSON.stringify(registryList(), null, 2));
    } else if (cmd === 'set') {
      const kv = String(args[1] || '').split('=');
      console.log(JSON.stringify(applyRule(kv[0], kv.slice(1).join('='), { by: 'cli' }), null, 2));
    } else if (cmd === 'undo') {
      console.log(JSON.stringify(undo(args[1]), null, 2));
    } else if (cmd === 'changes') {
      console.log(JSON.stringify(changes(Number(args[1]) || 20), null, 2));
    } else if (cmd === 'metrics') {
      console.log(JSON.stringify(metrics({ hours: Number(args[1]) || 24 }), null, 2));
    } else if (cmd === 'propose') {
      console.log(JSON.stringify(await propose({}), null, 2));
    } else if (cmd === 'evolve') {
      console.log(JSON.stringify(await evolve({ dry: args.includes('--dry'), force: args.includes('--force') }), null, 2));
    } else if (cmd === 'eval') {
      console.log(JSON.stringify(evaluateExperiments({ force: true }), null, 2));
    } else {
      console.log('用法: node scripts/selfmod.js [status|charter|charter-add 文本|charter-del 序号|rules|set k=v|undo id|changes|metrics [小时]|propose|evolve [--dry] [--force]|eval]');
    }
  })().catch(e => { console.error('selfmod 出错:', e && e.message); process.exit(1); });
}
