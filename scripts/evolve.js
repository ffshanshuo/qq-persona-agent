/**
 * evolve.js —— 自进化：让「规则本身」也随真实对话慢慢调整
 *
 * 用户的诉求（2026-10-24）：规则不能写死。比如「抱怨生活烦」在 echo.js 早期会被当成
 * 「回得冷淡」，但从真人角度那是**把心事交给你**，反而是想聊、想被安慰 → 应该算热。
 * 这类误判不该靠我每次手改代码，而应该：
 *   ① 暴露一个「纠错入口」（feedback），人一句话就能把一次误判记下来；
 *   ② 定期从真实记录里统计，把阈值/词表**小步**挪向更贴合的方向；
 *   ③ 所有改动都要有边界（clamp）、有最小样本、有可读理由、可回滚（reset）。
 *
 * 纯本地，0 token。产物：config/tuning.json（各模块读取时叠加，tuning 优先）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TUNING_PATH = process.env.QQTUNING_FILE || path.join(ROOT, 'config', 'tuning.json');
const DIR = process.env.QQEVOLVE_DIR || path.join(ROOT, 'logs', 'evolve');
const ECHO_DIR = process.env.QQECHO_DIR || path.join(ROOT, 'logs', 'echo');

const DEFAULTS = {
  enabled: true,
  everyMin: 360,          // 多久看一次数据（auto-reply 里的定时器）
  apply: true,            // false = 只预览不落盘
  minRecords: 40,         // 样本不足不动手（宁可不调，也别被 3 句话带偏）
  window: 300,            // 只看最近 N 条记录
  step: 0.03,             // 每一轮最多挪多少（阈值）
  maxDrift: 0.18,         // 相对默认值的最大累计漂移
  coldRateHigh: 0.45,     // 冷判定占比过高 → 阈值太严
  coldRateLow: 0.05,      // 冷判定几乎没有 → 阈值太松，往回收
  warmRateLow: 0.12,      // 热判定几乎没有 → 太严
  keepHistory: 30
};

let cfg = { ...DEFAULTS };
function configure(over) { cfg = { ...DEFAULTS, ...(over || {}) }; return cfg; }
function options() { return cfg; }

function dirOf() { return process.env.QQEVOLVE_DIR || DIR; }
function echoDirOf() { return process.env.QQECHO_DIR || ECHO_DIR; }
function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
}
function writeJson(file, obj) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { }
  const text = JSON.stringify(obj, null, 2) + '\n';
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const tmp = file + '.' + process.pid + '.' + i + '.tmp';
    try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); return true; } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (e2) { }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + 25 * i); } catch (e3) { }
    }
  }
  try { fs.writeFileSync(file, text); return true; } catch (e) {
    try { fs.mkdirSync(dirOf(), { recursive: true }); fs.appendFileSync(path.join(dirOf(), 'evolve-error.log'), new Date().toISOString() + ' ' + (lastErr && lastErr.message) + '\n'); } catch (e2) { }
    return false;
  }
}

// ── 记录 ──────────────────────────────────────────────────────────────────
function appendFeedback(entry) {
  const file = path.join(dirOf(), 'feedback.jsonl');
  try { fs.mkdirSync(dirOf(), { recursive: true }); } catch (e) { }
  try { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); return true; } catch (e) { return false; }
}

/** 人工纠错入口：一句话标明「这句其实是想聊 / 不是冷淡」 */
function feedback({ text, intent, note, key, by } = {}) {
  if (!text) return { ok: false, error: '缺少 text' };
  const e = {
    t: Date.now(),
    text: String(text).slice(0, 300),
    intent: intent || 'vent',
    note: note ? String(note).slice(0, 200) : '',
    key: key || '',
    by: by || 'user'
  };
  appendFeedback(e);
  return { ok: true, entry: e };
}

function feedbackList() {
  try {
    return fs.readFileSync(path.join(dirOf(), 'feedback.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// ── 统计 ──────────────────────────────────────────────────────────────────
function collectRecords() {
  let names = [];
  try { names = fs.readdirSync(echoDirOf()).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const st = readJson(path.join(echoDirOf(), n), null);
    if (!st || !Array.isArray(st.records)) continue;
    for (const r of st.records) out.push({ key: st.key || n.replace(/\.json$/, ''), ...r });
  }
  out.sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
  return out;
}

function stats(records) {
  const n = records.length;
  const byKind = { warm: 0, cold: 0, neutral: 0 };
  const byIntent = { vent: 0, hostile: 0, neutral: 0 };
  let gapSum = 0, gapN = 0;
  for (const r of records) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    byIntent[r.intent || 'neutral'] = (byIntent[r.intent || 'neutral'] || 0) + 1;
    if (Number(r.gapMs) > 0) { gapSum += Number(r.gapMs); gapN++; }
  }
  return {
    n,
    warmRate: n ? byKind.warm / n : 0,
    coldRate: n ? byKind.cold / n : 0,
    neutralRate: n ? byKind.neutral / n : 0,
    ventRate: n ? byIntent.vent / n : 0,
    hostileRate: n ? byIntent.hostile / n : 0,
    avgGapMin: gapN ? Math.round(gapSum / gapN / 60000) : 0,
    byKind, byIntent
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round3 = v => Math.round(v * 1000) / 1000;

/**
 * 从数据推出「该往哪挪」。只输出建议，不写盘。
 * 目前只调 echo 的两个判定阈值——它们直接决定「一句话算冷还是算热」，
 * 也是唯一能从记录里客观看出偏差的参数（冷判定过多＝把中性/诉苦误判成冷）。
 */
function propose(tune, records, extra) {
  const st = stats(records);
  const base = tune && tune.echo ? tune.echo : {};
  const D = { warmScore: 0.3, coldScore: -0.3 };
  const cur = {
    warmScore: Number(base.warmScore ?? D.warmScore),
    coldScore: Number(base.coldScore ?? D.coldScore)
  };
  const out = [];
  const min = Number(cfg.minRecords || 40);
  if (st.n < min) {
    return { samples: st.n, need: min, suggestions: [], skipped: 'not-enough-records', stats: st };
  }
  const step = Number(cfg.step);
  const drift = Number(cfg.maxDrift);
  const mk = (param, want, why) => {
    const lo = param === 'coldScore' ? D[param] - drift : D[param] - drift;
    const hi = param === 'coldScore' ? D[param] + drift : D[param] + drift;
    let to = clamp(round3(cur[param] + (want > cur[param] ? step : -step)), lo, hi);
    if (Math.abs(to - cur[param]) < 0.001) return;
    out.push({ param, from: cur[param], to, why, samples: st.n });
  };
  // 冷判定太多 → 太容易把「回得短/回得慢/在诉苦」当成冷 → 阈值往下挪（更难判冷）
  if (st.coldRate > Number(cfg.coldRateHigh)) {
    mk('coldScore', cur.coldScore - step,
      `近 ${st.n} 轮里 ${Math.round(st.coldRate * 100)}% 判成冷（超过 ${Math.round(cfg.coldRateHigh * 100)}%），阈值偏严`);
  } else if (st.coldRate < Number(cfg.coldRateLow)) {
    mk('coldScore', cur.coldScore + step,
      `近 ${st.n} 轮里几乎不判冷（${Math.round(st.coldRate * 100)}%），阈值偏松，往回收一点`);
  }
  // 热判定几乎没有 → 阈值太高，降一点，让「热络」更容易被认出来
  if (st.warmRate < Number(cfg.warmRateLow)) {
    mk('warmScore', cur.warmScore - step,
      `近 ${st.n} 轮里只有 ${Math.round(st.warmRate * 100)}% 判成热（低于 ${Math.round(cfg.warmRateLow * 100)}%），太不容易认出来`);
  }
  // 诉苦占比很高但仍有不少冷判 → 说明词表还不够，提示补词（不自动改词，避免误伤）
  const notes = [];
  if (st.ventRate > 0.15 && st.coldRate > 0.3) {
    notes.push(`诉苦占 ${Math.round(st.ventRate * 100)}%、冷判仍 ${Math.round(st.coldRate * 100)}%：建议 ` +
      `node scripts/evolve.js feedback "<那句原话>" vent —— 把新的诉苦说法补进词表`);
  }
  return { samples: st.n, need: min, suggestions: out, notes, stats: st };
}

/** 把反馈里出现的新说法补进词表（只扩词，不改判分逻辑） */
function learnWords(tune, fb) {
  const base = (tune && tune.echo) || {};
  const vent = new Set(base.ventWords || []);
  const cold = new Set(base.coldWords || []);
  const seen = new Set([...vent, ...cold]);
  const added = [];
  const push = (list, w) => {
    if (w.length < 2 || w.length > 6) return;
    if (seen.has(w)) return;
    if (/^[0-9a-zA-Z]/.test(w)) return;
    if (added.length >= 10) return;
    seen.add(w); (list === 'coldWords' ? cold : vent).add(w); added.push({ list, w });
  };
  for (const f of fb) {
    const text = String(f.text || '');
    if (!text) continue;
    const chunks = text.replace(/[^一-龥]{1,}/g, ' ').split(/s+/).filter(Boolean);
    for (const c of chunks) {
      if (c.length <= 6) { push(f.intent === 'cold' ? 'coldWords' : 'ventWords', c); continue; }
      // 长句：只取开头一小段 + 头几个二元组，避免出现「今天被老」这种半截词
      push(f.intent === 'cold' ? 'coldWords' : 'ventWords', c.slice(0, 4));
      for (let i = 0; i < Math.min(4, c.length - 1); i++) push(f.intent === 'cold' ? 'coldWords' : 'ventWords', c.slice(i, i + 2));
    }
  }
  return { added, ventWords: [...vent], coldWords: [...cold] };
}

function loadTuning() { return readJson(TUNING_PATH, {}) || {}; }

/** 预览（不写盘） */
function preview() {
  const tune = loadTuning();
  const all = collectRecords();
  const recent = all.slice(-Number(cfg.window || 300));
  const p = propose(tune, recent, {});
  const fb = feedbackList().slice(-50);
  const learned = learnWords(tune, fb);
  return { ...p, feedback: fb.length, learn: { added: learned.added }, tuningPath: TUNING_PATH };
}

/** 落盘（带边界与历史） */
function apply() {
  const tune = loadTuning();
  const all = collectRecords();
  const recent = all.slice(-Number(cfg.window || 300));
  const p = propose(tune, recent, {});
  const fb = feedbackList().slice(-50);
  const learned = learnWords(tune, fb);
  if (!p.suggestions.length && !learned.added.length) {
    return { applied: [], reason: 'nothing-to-tune', samples: p.samples };
  }
  const echo = { ...(tune.echo || {}) };
  for (const s of p.suggestions) echo[s.param] = s.to;
  if (learned.added.length) { echo.ventWords = learned.ventWords; echo.coldWords = learned.coldWords; }
  const hist = Array.isArray(tune.history) ? tune.history : [];
  hist.push({
    t: Date.now(),
    samples: p.samples,
    changes: p.suggestions,
    words: learned.added,
    stats: p.stats
  });
  const next = {
    _note: 'evolve.js 自动生成的调参覆盖层：各模块读取配置时叠加此文件（tuning 优先于 config/*.json）。可随时删掉本文件回到默认。',
    updatedAt: Date.now(),
    echo,
    history: hist.slice(-Number(cfg.keepHistory || 30))
  };
  const ok = writeJson(TUNING_PATH, next);
  return { ok, applied: p.suggestions, words: learned.added, samples: p.samples, path: TUNING_PATH };
}

/** 回滚到默认（删掉 tuning.json） */
function reset() {
  try { fs.unlinkSync(TUNING_PATH); return { ok: true, removed: TUNING_PATH }; } catch (e) { return { ok: false, error: e.message }; }
}

/** 定时器入口：预览 +（可选）落盘，返回一行可日志的摘要 */
function runOnce(opts = {}) {
  const o = { ...cfg, ...(opts || {}) };
  if (o.enabled === false) return { skipped: 'disabled' };
  const view = preview();
  if (view.skipped) return view;
  if (!o.apply) return { ...view, applied: [] };
  const res = apply();
  return { ...view, ...res };
}

module.exports = {
  DEFAULTS, TUNING_PATH, configure, options, dirOf, echoDirOf,
  feedback, feedbackList, collectRecords, stats, propose, learnWords,
  loadTuning, preview, apply, reset, runOnce, writeJson
};

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === 'preview' || !cmd) {
    console.log(JSON.stringify(preview(), null, 2));
  } else if (cmd === 'apply') {
    console.log(JSON.stringify(apply(), null, 2));
  } else if (cmd === 'reset') {
    console.log(JSON.stringify(reset(), null, 2));
  } else if (cmd === 'feedback') {
    console.log(JSON.stringify(feedback({ text: a1, intent: a2 || 'vent', by: 'cli' }), null, 2));
  } else if (cmd === 'list') {
    const fb = feedbackList();
    if (!fb.length) { console.log('[evolve] 还没有人工纠错记录'); process.exit(0); }
    for (const f of fb) console.log(`${new Date(f.t).toLocaleString()}  ${f.intent}  ${f.text.slice(0, 40)}`);
  } else if (cmd === 'stats') {
    const all = collectRecords();
    console.log(JSON.stringify(stats(all.slice(-Number(cfg.window || 300))), null, 2));
  } else {
    console.log('用法：node scripts/evolve.js [preview|apply|reset|stats]');
    console.log('      node scripts/evolve.js feedback "<那句原话>" [vent|cold|warm]   # 人工纠错');
    console.log('      node scripts/evolve.js list');
  }
}
