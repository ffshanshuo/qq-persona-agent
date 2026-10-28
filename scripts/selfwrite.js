'use strict';
/**
 * selfwrite.js —— 让模型「自己写文件」的受控通道（第一批：关系）
 *
 * 模型只能在回复里写标记，真正的落盘由这一层做，并且必须过四道关：
 *   ① 白名单：只允许写 ties（关系）与 note（随手记），别的关键词一律拒绝；
 *   ② 额度：每天最多 dailyMax 次写入（跨天归零），dry（AUTOREPLY_DRY=1）只审计不落盘；
 *   ③ 语义校验：关系类型必须在册；升到「恋人」必须有对方的明确表达
 *      （复用 ties 的 RE_PROPOSE/RE_ACCEPT），且全局唯一位不能被抢；
 *   ④ 可回滚：每次写入都记 before/after 与理由，`node scripts/selfwrite.js undo` 能撤回上一次关系改动。
 *
 * 标记写法（括号宽容：[[ ]] / 【】/ [] / ［］，分隔符 : ： = 都认）：
 *   [[关系:恋人]]  [[关系:好朋友]]  [[关系:前任]]  [[记下:她下周三考试]]
 *
 * 落盘：
 *   logs/selfwrite/state.json  当日计数 + 最近写入（可回滚）
 *   logs/selfwrite.jsonl       审计流水（每条含 dry 标记）
 *   logs/selfwrite/notes.jsonl 「记下」的内容（同时尽力塞进 mind 记忆图）
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const CFG_PATH = process.env.SELFWRITE_CONFIG || path.join(ROOT, 'config', 'selfwrite.json');
const DIR = process.env.QQSELFWRITE_DIR || path.join(ROOT, 'logs', 'selfwrite');
const LOG = process.env.QQSELFWRITE_LOG || path.join(ROOT, 'logs', 'selfwrite.jsonl');

const DEFAULTS = {
  enabled: true,
  preset: 'auto',            // auto = 允许模型写；readonly = 只审计不落盘（临时刹车）
  allow: ['ties', 'note', 'mood', 'tag', 'want', 'pref', 'forget'],
  dailyMax: 20,
  maxNotesPerDay: 10,
  noteMaxChars: 60,
  requireEvidenceForLover: true,
  keepAudit: 200,
  _why: '2026-10-27 用户要求：AI 可自主写入文件（比如关系）。写入是受控的：白名单 + 额度 + 语义校验 + 可回滚。'
};

const TYPES = {
  '陌生人': 'stranger', '生人': 'stranger',
  '熟人': 'acquaintance', '一般': 'acquaintance',
  '朋友': 'friend', '聊得来': 'friend',
  '好朋友': 'close', '亲近': 'close', '很熟': 'close',
  '恋人': 'lover', '对象': 'lover', '女朋友': 'lover', '男朋友': 'lover', '情侣': 'lover',
  '前任': 'ex', '分手': 'ex'
};

const BR = '(?:\\[\\[|［［|【|\\[|［)';
const CL = '(?=\\]\\]|］］|\\】|\\]|］)';
const REL_RE = new RegExp(BR + '\\s*关系\\s*[:：=]\\s*([^\\]\\】］\\n]{1,12})\\s*' + CL + '|' + BR + '\\s*关系\\s*[:：=]\\s*([^\\]\\】］\\n]{1,12})', 'gi');
const REL_LOOSE_RE = new RegExp(BR + '\\s*关系\\s*[:：=]\\s*([^\\]\\】］\\n]{1,12})', 'gi');
const NOTE_RE = new RegExp(BR + '\\s*记下\\s*[:：=]\\s*([^\\]\\】］\\n]{1,80})\\s*(?:\\]\\]|］］|\\】|\\]|］)?', 'gi');
// 自主遗忘：把记着的那件事从记忆图里标成 forgotten（不删文件，可 undo）
const FORGET_RE = new RegExp(BR + '\\s*(?:忘掉|忘记|别再提|删掉记忆)\\s*[:：=]?\\s*([^\\]\\】］\\n]{1,40})\\s*(?:\\]\\]|］］|\\】|\\]|］)?', 'gi');
const MOOD_RE = new RegExp(BR + '\\s*心情\\s*[:：=]\\s*([^\\]\\】］\\n]{1,40})\\s*(?:\\]\\]|］］|\\】|\\]|］)?', 'gi');
const TAG_RE = new RegExp(BR + '\\s*印象\\s*[:：=]\\s*([^\\]\\】］\\n]{1,40})\\s*(?:\\]\\]|］］|\\】|\\]|］)?', 'gi');
const WANT_RE = new RegExp(BR + '\\s*(?:想做|想做的事|想干)\\s*[:：=]\\s*([^\\]\\】］\\n]{1,60})\\s*(?:\\]\\]|］］|\\】|\\]|］)?', 'gi');
const PREF_RE = new RegExp(BR + '\\s*(?:偏好|规矩|原则)\\s*[:：=]\\s*([^\\]\\】］\\n]{1,60})\\s*(?:\\]\\]|］］|\\】|\\]|］)?', 'gi');
const MARK_ANY = new RegExp(BR + '\\s*(?:关系|记下|心情|印象|想做|想做的事|想干|偏好|规矩|原则|忘掉|忘记|别再提)\\s*[:：=][^\\]\\】］\\n]{0,80}(?:\\]\\]|］］|\\】|\\]|］)?', 'gi');

let _cfg = null;

function loadCfg(force) {
  if (_cfg && !force) return _cfg;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { j = null; }
  _cfg = { ...DEFAULTS, ...(j || {}) };
  return _cfg;
}
function configure(over) { _cfg = { ...loadCfg(true), ...(over || {}) }; return _cfg; }

function dayKey(now) { const d = new Date(now || Date.now()); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function stateFile() { return path.join(DIR, 'state.json'); }
function logFile() { return LOG; }
function blank(now) { return { day: dayKey(now), count: 0, notes: 0, recent: [] }; }

function load(now) {
  const st = store.readJson(stateFile(), null);
  if (!st || st.day !== dayKey(now)) return blank(now);
  return { ...blank(now), ...st, day: st.day };
}
function save(st) { store.ensureDir(DIR); return store.writeJson(stateFile(), st); }

function audit(rec) {
  try { store.ensureDir(path.dirname(LOG)); store.appendJsonl(LOG, { t: Date.now(), ...rec }); } catch (e) { /* 审计失败不影响主流程 */ }
}

/** 解析回复里的写入标记；返回 {text, writes} */
function parse(raw) {
  const src = String(raw == null ? '' : raw);
  const writes = [];
  let m;
  REL_RE.lastIndex = 0;
  while ((m = REL_RE.exec(src))) {
    const word = (m[1] || m[2] || '').trim();
    if (word) writes.push({ kind: 'ties', value: word });
  }
  if (!writes.some((w) => w.kind === 'ties')) {
    REL_LOOSE_RE.lastIndex = 0;
    while ((m = REL_LOOSE_RE.exec(src))) {
      const word = String(m[1] || '').trim();
      if (word) writes.push({ kind: 'ties', value: word });
    }
  }
  FORGET_RE.lastIndex = 0;
  while ((m = FORGET_RE.exec(src))) {
    const kw = String(m[1] || '').trim();
    if (kw) writes.push({ kind: 'forget', value: kw });
  }
  NOTE_RE.lastIndex = 0;
  while ((m = NOTE_RE.exec(src))) {
    const note = String(m[1] || '').trim();
    if (note) writes.push({ kind: 'note', value: note });
  }
  for (const [kind, re, cap] of [['mood', MOOD_RE, 40], ['tag', TAG_RE, 40], ['want', WANT_RE, 60], ['pref', PREF_RE, 60]]) {
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const v = String(m[1] || '').trim().slice(0, cap);
      if (v) writes.push({ kind, value: v });
    }
  }
  return { text: stripWrites(src), writes };
}
function stripWrites(text) {
  return String(text == null ? '' : text).replace(MARK_ANY, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 关系词 → 类型 id */
function typeOf(word) {
  const w = String(word || '').trim().replace(/[的了呀啊吧呢~～\s]/g, '');
  if (TYPES[w]) return TYPES[w];
  const keys = Object.keys(TYPES);
  const hit = keys.find((k) => w.includes(k));
  return hit ? TYPES[hit] : null;
}

function writeNote(value, ctx) {
  const cfg = loadCfg();
  const text = String(value).slice(0, cfg.noteMaxChars);
  store.ensureDir(DIR);
  store.appendJsonl(path.join(DIR, 'notes.jsonl'), { t: Date.now(), key: ctx.key || '', text, by: ctx.by || 'model' });
  // 尽力塞进记忆图（失败不影响「写下来了」这件事）
  let graph = false;
  try {
    const mind = require('./mind.js');
    const g = mind.loadGraph(ctx.key, ctx.kind || 'private', ctx.uin);
    const r = mind.addNode(g, { text, kind: 'fact', importance: 0.55, salience: 0.5, source: 'selfwrite' });
    if (r && r.added) { mind.saveGraph(g); graph = true; }
  } catch (e) { graph = false; }
  return { ok: true, kind: 'note', text, graph };
}

/** 记自己的状态/心情：落 mood.jsonl，最新一条会被拼进下一轮 prompt */
function writeMood(value, ctx) {
  const text = String(value).slice(0, 40);
  store.ensureDir(DIR);
  store.appendJsonl(path.join(DIR, 'mood.jsonl'), { t: Date.now(), key: ctx.key || '', text });
  return { ok: true, kind: 'mood', text };
}

/** 记对这个人的印象/标签：落 tags.jsonl，同时塞进记忆图（kind=fact） */
function writeTag(value, ctx) {
  const text = String(value).slice(0, 40);
  store.ensureDir(DIR);
  store.appendJsonl(path.join(DIR, 'tags.jsonl'), { t: Date.now(), key: ctx.key || '', text });
  let graph = false;
  try {
    const mind = require('./mind.js');
    const g = mind.loadGraph(ctx.key, ctx.kind || 'private', ctx.uin);
    const r = mind.addNode(g, { text: '（印象）' + text, kind: 'fact', importance: 0.5, salience: 0.45, source: 'selfwrite-tag' });
    if (r && r.added) { mind.saveGraph(g); graph = true; }
  } catch (e) { graph = false; }
  return { ok: true, kind: 'tag', text, graph };
}

/** 给自己排「想做的事」：落 wants.jsonl（longing 可以拿它当开口由头） */
function writeWant(value, ctx) {
  const text = String(value).slice(0, 60);
  store.ensureDir(DIR);
  store.appendJsonl(path.join(DIR, 'wants.jsonl'), { t: Date.now(), key: ctx.key || '', text });
  return { ok: true, kind: 'want', text };
}

/** 给自己定一条说话/相处的小规矩：落 prefs.jsonl，会注入下一轮 prompt */
function writePref(value, ctx) {
  const text = String(value).slice(0, 60);
  store.ensureDir(DIR);
  store.appendJsonl(path.join(DIR, 'prefs.jsonl'), { t: Date.now(), key: ctx.key || '', text });
  return { ok: true, kind: 'pref', text };
}

function writeTies(value, ctx) {
  const cfg = loadCfg();
  const type = typeOf(value);
  if (!type) return { ok: false, why: 'bad-relation-word', word: value };
  const ties = require('./ties.js');
  const before = ties.load(ctx.key, ctx.uin);
  const r = ties.setType(ctx.key, type, {
    uin: ctx.uin,
    text: ctx.text || '',
    reason: ctx.reason || ('模型自己写的：' + value),
    by: ctx.by || 'model',
    force: ctx.force === true
  });
  return { ...r, kind: 'ties', word: value, type, before: before.type };
}

/**
 * 落盘一批写入。ctx: {key, uin, kind, text, dry, by, reason, force}
 * dry（演练）只审计不落盘，与其它层口径一致。
 */
function apply(writes, ctx = {}) {
  const cfg = loadCfg();
  const now = ctx.now || Date.now();
  const dry = !!ctx.dry;
  const list = Array.isArray(writes) ? writes : [];
  const out = { applied: [], skipped: [], texts: [] };
  if (cfg.enabled === false) return { ...out, disabled: true };
  if (!list.length) return out;

  const st = load(now);
  for (const w of list) {
    const kind = w && w.kind;
    if (!cfg.allow.includes(kind)) { out.skipped.push({ kind, why: 'not-allowed' }); continue; }
    if (kind === 'note' && st.notes >= Number(cfg.maxNotesPerDay)) { out.skipped.push({ kind, why: 'notes-cap' }); continue; }
    if (st.count >= Number(cfg.dailyMax)) { out.skipped.push({ kind, why: 'daily-cap' }); continue; }
    let r;
    if (cfg.preset === 'readonly' || dry) {
      r = { ok: true, kind, dry: true, would: kind === 'ties' ? typeOf(w.value) : String(w.value).slice(0, cfg.noteMaxChars) };
    } else if (kind === 'ties') {
      r = writeTies(w.value, ctx);
    } else if (kind === 'mood') {
      r = writeMood(w.value, ctx);
    } else if (kind === 'tag') {
      r = writeTag(w.value, ctx);
    } else if (kind === 'want') {
      r = writeWant(w.value, ctx);
    } else if (kind === 'forget') {
      r = writeForget(w.value, ctx);
    } else if (kind === 'pref') {
      r = writePref(w.value, ctx);
    } else {
      r = writeNote(w.value, ctx);
    }
    if (r.ok) {
      if (!r.dry) {
        st.count += 1;
        if (kind === 'note') st.notes += 1;
        st.byKind = st.byKind || {};
        st.byKind[kind] = (st.byKind[kind] || 0) + 1;
        if (kind === 'ties') st.recent.push({ t: now, kind, key: ctx.key || '', from: r.before || '', to: r.type, why: ctx.reason || 'model-write' });
        if (st.recent.length > Number(cfg.keepAudit)) st.recent = st.recent.slice(-Number(cfg.keepAudit));
        save(st);
      }
      out.applied.push(r);
      if (kind === 'note') out.texts.push(r.text);
    } else {
      out.skipped.push({ kind, why: r.why, word: w.value });
    }
    audit({ event: 'selfwrite', kind, ok: !!r.ok, why: r.why || 'ok', dry: !!r.dry, key: ctx.key || '', value: String(w.value).slice(0, 60), from: r.before || '', to: r.type || '' });
  }
  return out;
}

/** 撤回上一次关系写入（把它改回 from） */
/** 「忘掉」不是删除：把匹配关键词的节点标成 muted（平时不主动提，TA 自己提到时还能想起），返回命中数 */
function writeForget(keyword, ctx = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, kind: 'forget', why: 'empty' };
  const mind = require('./mind.js');
  const g = mind.loadGraph(ctx.key);
  const ids = [];
  for (const n of (g.nodes || [])) {
    if (!n || !n.text) continue;
    if (String(n.text).includes(kw)) { n.muted = true; n.muteKeyword = kw; n.mutedAt = ctx.now || Date.now(); ids.push(n.id); }
  }
  if (ids.length) mind.saveGraph(ctx.key, g);
  return { ok: ids.length > 0, kind: 'forget', keyword: kw, ids, why: ids.length ? 'muted' : 'no-match' };
}

function undo(now) {
  const st = load(now || Date.now());
  const rec = [...st.recent].reverse().find((x) => x.kind === 'ties');
  if (!rec) return { ok: false, why: 'nothing-to-undo' };
  const ties = require('./ties.js');
  const r = ties.setType(rec.key, rec.from, { reason: 'undo by selfwrite', by: 'undo', force: true, now: now || Date.now() });
  st.recent = st.recent.filter((x) => x !== rec);
  save(st);
  audit({ event: 'selfwrite-undo', key: rec.key, back: rec.from, ok: !!r.ok, why: r.why });
  return { ok: !!r.ok, why: r.why, key: rec.key, back: rec.from, result: r };
}

/** 撤销上一次「忘掉」：把标过的节点恢复 */
function undoForget(now) {
  const st = load(now || Date.now());
  const rec = [...st.recent].reverse().find((x) => x.kind === 'forget' && Array.isArray(x.ids) && x.ids.length);
  if (!rec) return { ok: false, why: 'nothing-to-undo' };
  const mind = require('./mind.js');
  const g = mind.loadGraph(rec.key);
  let n = 0;
  for (const node of (g.nodes || [])) {
    if (node && rec.ids.includes(node.id)) { delete node.muted; delete node.muteKeyword; delete node.mutedAt; delete node.forgotten; delete node.forgottenAt; n += 1; }
  }
  if (n) mind.saveGraph(rec.key, g);
  st.recent = st.recent.filter((x) => x !== rec);
  save(st);
  audit({ event: 'selfwrite-undo-forget', key: rec.key, keyword: rec.value, restored: n });
  return { ok: n > 0, restored: n, keyword: rec.value };
}

/** 读回最近记下的东西，供 prompt 注入（最多 max 条，最新在前） */
function selfNotes(key, opts = {}) {
  const max = Number(opts.max) || 3;
  const out = [];
  const read = (file, label) => {
    try {
      const lines = fs.readFileSync(path.join(DIR, file), 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean);
      const mine = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((x) => x && (!key || x.key === key));
      for (const it of mine.slice(-2).reverse()) out.push({ label, text: it.text, t: it.t });
    } catch (e) { /* 没有就没有 */ }
  };
  read('mood.jsonl', '你自己给自己记的心情');
  read('tags.jsonl', '你记下的对 TA 的印象');
  read('wants.jsonl', '你自己想做的事');
  read('prefs.jsonl', '你自己定过的小规矩');
  return out.sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, max);
}

/** 取最近「想做的事」（longing 用它当开口由头） */
function wantsFor(key, opts = {}) {
  const max = Number(opts.max) || 1;
  const days = Number(opts.maxAgeDays) || 30;
  const min = Date.now() - days * 86400000;
  try {
    const lines = fs.readFileSync(path.join(DIR, 'wants.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean);
    return lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter((x) => x && x.text && (!key || x.key === key) && (x.t || 0) >= min)
      .slice(-max).reverse();
  } catch (e) { return []; }
}

function status(now) {
  const st = load(now || Date.now());
  const cfg = loadCfg();
  return {
    enabled: cfg.enabled !== false && cfg.preset !== 'readonly',
    preset: cfg.preset,
    allow: cfg.allow,
    day: st.day,
    count: st.count,
    notes: st.notes,
    caps: { dailyMax: cfg.dailyMax, maxNotesPerDay: cfg.maxNotesPerDay },
    recent: st.recent.slice(-8).reverse()
  };
}

module.exports = {
  undoForget, writeForget,
  DEFAULTS, CFG_PATH, DIR, LOG, TYPES,
  loadCfg, configure, options: () => loadCfg(),
  dayKey, stateFile, logFile, blank, load, save,
  parse, stripWrites, typeOf, writeNote, writeTies, writeMood, writeTag, writeWant, writePref, selfNotes, wantsFor, apply, undo, status, audit,
  MARK_ANY
};

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') console.log(JSON.stringify(status(), null, 2));
  else if (cmd === 'parse') console.log(JSON.stringify(parse(process.argv.slice(3).join(' ')), null, 2));
  else if (cmd === 'undo') console.log(JSON.stringify(undo(), null, 2));
  else if (cmd === 'recent') console.log(JSON.stringify(load().recent.slice(-10).reverse(), null, 2));
  else console.log('用法: node scripts/selfwrite.js [status|parse "文本…"|recent|undo]');
}
