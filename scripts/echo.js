/**
 * echo.js —— 回响层：根据「对话本身」反过来调整语气与情绪
 *
 * 为什么需要它：
 *   mind.js 的 affect() 只看「对方这一句说了什么」，bonds.js 只看「里程碑事件」。
 *   但真实聊天里还有一层反馈：**我刚说的那句，在对方那儿有没有落地**——
 *   回得快不快、话多不多、冷不冷、有没有接我的话题、有没有追问我。
 *   这些信号不该由模型自己猜，而应该由本地规则算出来，然后
 *   ① 反推一点情绪（PAD）与关系（warmth/trust）；
 *   ② 直接改接下来这一句的语气尺度（冷场就收着说，热络可以放松）。
 *
 * 纯本地规则，零 token，不调模型。落盘 logs/echo/<slug>.json。
 */
'use strict';
const fs = require('fs');
const store = require('../lib/store.js');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'echo.json');
// 自进化：evolve.js 依据真实对话把「小幅调参」写到这里，读取时叠加（tuning 优先）
const TUNING_PATH = process.env.QQTUNING_FILE || path.join(ROOT, 'config', 'tuning.json');
const DIR = process.env.QQECHO_DIR || path.join(ROOT, 'logs', 'echo');

const DEFAULTS = {
  enabled: true,
  // 回复间隔（毫秒）：秒回算热、隔太久算冷
  warmLatencyMs: 90000,
  coldLatencyMs: 6 * 3600 * 1000,
  // 字数比（对方字数 / 我上次字数）
  warmLenRatio: 0.8,
  coldLenRatio: 0.3,
  // 冷/热词
  warmWords: ['谢谢', '哈哈', '开心', '好呀', '好啊', '太好了', '笑死', '嘿嘿', '嘻嘻', '想你', '抱抱', '爱你', '么么', '不错', '喜欢'],
  // 注意：'烦' 不在这里——它属于 ventWords。抱怨生活 ≠ 对你冷淡，反而是想被安慰。
  coldWords: ['哦', '喔', '嗯', '行吧', '知道了', '随便', '算了', '没事', '不用', '再说吧', '不想说', '没空'],
  // 诉苦/求安慰：把心事交给你，按「想聊」算，不按冷算
  ventWords: ['烦', '烦死', '好烦', '真烦', '累死', '好累', '太累', '难受', '不开心', '郁闷', '委屈', '压力大', '压力好大', '想哭', '心累', '焦虑', '失眠', '睡不着', '熬夜', '加班', '被骂', '吵架', '崩溃', '倒霉', '无语', '离谱', 'emo', '好丧', '不想上班', '不想上学', '好难', '好惨', '撑不住', '顶不住'],
  // 真冲你来的火气（这些才该按冷/敌意算）
  hostileWords: ['滚', '闭嘴', '别烦我', '烦不烦你', '不想理你', '讨厌你', '别给我发', '拉黑', '少来这套', '你有病'],
  // 判定阈值与平滑
  warmScore: 0.3,
  coldScore: -0.3,
  emaAlpha: 0.4,
  // 连续几次才算「一直在冷场 / 一直聊得开」
  streakForHint: 2,
  // 情绪反拨幅度（小步走，避免一句话把心情推翻）
  padWarm: 0.06,
  padCold: -0.1,
  arousalWarm: 0.05,
  arousalCold: -0.04,
  relWarmth: 0.02,
  relTrust: 0.015,
  keepRecords: 50,
  // 意图权重：诉苦给正分（想聊），敌意给负分
  ventScore: 0.45,
  hostileScore: -0.6,
  ventLenMin: 12,
  ventLenBonus: 0.1
};

let cfg = { ...DEFAULTS };

function configure(over) { cfg = { ...DEFAULTS, ...(over || {}) }; return cfg; }
function options() { return cfg; }

function loadCfg(reload) {
  if (!reload && loadCfg._c) return loadCfg._c;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { raw = null; }
  let tune = null;
  try { tune = JSON.parse(fs.readFileSync(TUNING_PATH, 'utf8')); } catch (e) { tune = null; }
  cfg = { ...DEFAULTS, ...(raw || {}), ...((tune && tune.echo) || {}) };
  loadCfg._c = cfg;
  return cfg;
}

function slugOf(key) {
  return String(key || 'x').replace(/[^a-zA-Z0-9_-]+/g, '_');
}
function dirOf() { return process.env.QQECHO_DIR || DIR; }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
}
function writeAtomic(file, text) {
  // 统一走 lib/store.js：tmp+rename 4 次重试 + 直写兜底（同一个坑只修一次）
  try {
    const obj = JSON.parse(text);
    if (!store.writeJson(file, obj)) {
      errorLog('write-failed', file);
      return false;
    }
    return true;
  } catch (e) {
    errorLog(String(e && e.message), file);
    return false;
  }
}

/** 错误日志：不抛错、不影响主流程 */
function errorLog(err, file) {
  try {
    const line = JSON.stringify({ t: Date.now(), file, err: String(err) }) + '\n';
    fs.appendFileSync(path.join(ROOT, 'logs', 'echo-error.log'), line);
  } catch (e2) { /* 日志失败就算了 */ }
}

function blank(key) {
  return { key, ema: 0, streakWarm: 0, streakCold: 0, lastKind: 'neutral', lastScore: 0, turns: 0, updatedAt: 0, records: [] };
}

function load(key) {
  const f = fileOf(key);
  const s = readJson(f, null);
  if (!s || typeof s !== 'object') return blank(key);
  return { ...blank(key), ...s, records: Array.isArray(s.records) ? s.records : [] };
}
function save(st) {
  st.updatedAt = Date.now();
  if (Array.isArray(st.records) && st.records.length > (cfg.keepRecords || 50)) st.records = st.records.slice(-cfg.keepRecords);
  return writeAtomic(fileOf(st.key), JSON.stringify(st));
}

// ── 文本信号 ──────────────────────────────────────────────────────────────
const STOP = new Set(['我们', '你们', '他们', '这个', '那个', '就是', '什么', '怎么', '可以', '一个', '现在', '今天']);
function bigrams(text) {
  const t = String(text || '').replace(/\[[^\]]{1,8}\]/g, '').replace(/[\s，。！？、,.!?:：;；~～"']/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (!STOP.has(g)) out.add(g);
  }
  return out;
}
function overlapOf(mine, theirs) {
  const b = bigrams(theirs);
  if (!b.size) return 0;
  const a = bigrams(mine);
  let hit = 0;
  for (const g of b) if (a.has(g)) hit++;
  return hit / b.size;
}

/** 抽出可判断的信号（不做判定，方便单测与日志） */
function signals({ mineText, theirsText, mineAt, theirsAt }) {
  const mine = String(mineText || '');
  const theirs = String(theirsText || '');
  const gapMs = mineAt && theirsAt ? Math.max(0, Number(theirsAt) - Number(mineAt)) : 0;
  const myLen = mine.length;
  const theirLen = theirs.length;
  const lenRatio = myLen ? theirLen / myLen : (theirLen ? 1 : 0);
  const warmHit = (cfg.warmWords || []).filter(w => theirs.includes(w));
  const coldHit = (cfg.coldWords || []).filter(w => theirs === w || theirs.startsWith(w) || theirs.endsWith(w));
  const ventHit = (cfg.ventWords || []).filter(w => theirs.includes(w));
  const hostileHit = (cfg.hostileWords || []).filter(w => theirs.includes(w));
  const asks = /[?？]/.test(theirs) || /(吗|呢|什么|怎么|为啥|哪儿|哪里|谁)/.test(theirs);
  return {
    gapMs,
    myLen,
    theirLen,
    lenRatio,
    warmHit,
    coldHit,
    asks,
    overlap: overlapOf(mine, theirs),
    ventHit,
    hostileHit,
    coldShort: theirLen > 0 && theirLen <= 3 && myLen >= 12,
    onlyEmoji: !theirs.replace(/\[[^\]]{1,8}\]/g, '').trim()
  };
}

/** 信号 → 一次反馈分（-1 冷 … +1 热）+ 人话理由 */
function judge(sig) {
  const why = [];
  let score = 0;
  const vh = sig.ventHit || [];
  const hh = sig.hostileHit || [];
  const intent = hh.length ? 'hostile' : (vh.length ? 'vent' : 'neutral');
  if (sig.warmHit.length) { score += 0.5; why.push('用了亲热/开心的词：' + sig.warmHit.slice(0, 2).join('、')); }
  if (sig.coldHit.length && intent === 'neutral') { score -= 0.5; why.push('回得有点冷淡：' + sig.coldHit.slice(0, 2).join('、')); }
  if (intent === 'hostile') {
    score += (cfg.hostileScore ?? -0.6);
    why.push('这句是冲你来的火气：' + hh.slice(0, 2).join('、'));
  } else if (intent === 'vent') {
    // 抱怨/诉苦不是冷：TA 把心事交给你，是想聊、想被安慰
    score += (cfg.ventScore ?? 0.45);
    why.push('TA 在跟你诉苦（' + vh.slice(0, 2).join('、') + '），是在找你，不是冷你');
    if (sig.theirLen >= (cfg.ventLenMin ?? 12)) { score += (cfg.ventLenBonus ?? 0.1); why.push('而且说了一大段，愿意跟你讲'); }
  }
  if (sig.asks) { score += 0.2; why.push('反问了你，说明还在聊'); }
  if (sig.coldShort && intent === 'neutral') { score -= 0.4; why.push('你说了挺长一段，TA 只回了几个字'); }
  if (sig.lenRatio >= (cfg.warmLenRatio ?? 0.8)) { score += 0.15; why.push('回得比你话还多'); }
  else if (intent === 'neutral' && sig.lenRatio > 0 && sig.lenRatio < (cfg.coldLenRatio ?? 0.3)) { score -= 0.15; why.push('回得比你短很多'); }
  if (sig.gapMs > 0) {
    if (sig.gapMs <= (cfg.warmLatencyMs ?? 90000)) { score += 0.1; why.push('回得很快'); }
    else if (sig.gapMs >= (cfg.coldLatencyMs ?? 6 * 3600e3)) { score -= 0.2; why.push('隔了很久才回'); }
  }
  if (sig.overlap >= 0.25) { score += 0.1; why.push('接住了你说的话'); }
  score = Math.max(-1, Math.min(1, Number(score.toFixed(3))));
  const kind = score >= (cfg.warmScore ?? 0.3) ? 'warm' : (score <= (cfg.coldScore ?? -0.3) ? 'cold' : 'neutral');
  return { score, kind, why, intent };
}

/** 观察一条「我上次说 → TA 这次回」，更新平滑值、连续计数，落盘，并给人话提示 */
function observe(key, { mineText, theirsText, mineAt, theirsAt, now } = {}) {
  const st = load(key);
  const sig = signals({ mineText, theirsText, mineAt, theirsAt });
  const j = judge(sig);
  const a = Number(cfg.emaAlpha ?? 0.4);
  st.ema = Number((st.ema * (1 - a) + j.score * a).toFixed(3));
  st.streakWarm = j.kind === 'warm' ? st.streakWarm + 1 : 0;
  st.streakCold = j.kind === 'cold' ? st.streakCold + 1 : 0;
  st.lastKind = j.kind;
  st.lastIntent = j.intent || 'neutral';
  st.lastScore = j.score;
  st.turns = (st.turns || 0) + 1;
  st.records.push({ t: now || Date.now(), kind: j.kind, score: j.score, intent: j.intent || 'neutral', gapMs: sig.gapMs, theirLen: sig.theirLen, myLen: sig.myLen });
  save(st);
  return { ...j, sig, ema: st.ema, streakWarm: st.streakWarm, streakCold: st.streakCold, note: noteFor(st, j) };
}

/** 给模型的一句话（人话、不含数字），说明「TA 这会儿的状态」，顺带给出应对口径 */
function noteFor(st, j) {
  const s = j || { kind: st.lastKind, score: st.lastScore };
  const n = cfg.streakForHint ?? 2;
  if (s.intent === 'vent') {
    return 'TA 在跟你倒苦水——这不是冷淡，是把心事交给你。先接住情绪（“听着就累”“换我也烦”），别马上讲道理、别急着出主意，也别把话头转到自己身上。';
  }
  if (s.intent === 'hostile') {
    return 'TA 这句带着火气，可能是真不高兴了。别急着解释、别顶回去，先软一点问一句：是不是我哪儿让你不舒服了。';
  }
  if (st.streakCold >= n) {
    return 'TA 这几句回得很短、有点敷衍，像是忙或者不太想聊。你别黏、别追问、别连着撒娇，话少一点、留点余地，问一句能接不接都行。';
  }
  if (st.streakWarm >= n) {
    return 'TA 这几句回得挺热络，还主动接话。可以放松一点，但别一下子过火。';
  }
  if (s.kind === 'cold') return 'TA 刚回得比较简短，可能手头有事。别多想，也别一下子发很长。';
  if (s.kind === 'warm') return 'TA 刚回得挺积极，可以顺着聊下去。';
  return '';
}

/** 反拨情绪：这次对话给 PAD 与关系带来的一点点变化（有界，绝不与 bonds 事件叠加成跳变） */
function affectDelta(res) {
  const out = { pad: { p: 0, a: 0 }, rel: { warmth: 0, trust: 0 } };
  if (!res) return out;
  const kind = res.kind || 'neutral';
  if (res.intent === 'vent') {
    // 被倾诉＝被信任：不降温，反而稳一点、有心气一点
    out.pad.p = 0.02;
    out.pad.a = 0.03;
    out.rel.warmth = cfg.relWarmth ?? 0.02;
    out.rel.trust = cfg.relTrust ?? 0.015;
    return out;
  }
  if (res.intent === 'hostile') {
    out.pad.p = -0.08;
    out.pad.a = 0.05;
    out.rel.warmth = -((cfg.relWarmth ?? 0.02) / 2);
    out.rel.trust = 0;
    return out;
  }
  if (kind === 'warm') {
    out.pad.p = cfg.padWarm ?? 0.06;
    out.pad.a = cfg.arousalWarm ?? 0.05;
    out.rel.warmth = cfg.relWarmth ?? 0.02;
    out.rel.trust = cfg.relTrust ?? 0.015;
  } else if (kind === 'cold') {
    out.pad.p = cfg.padCold ?? -0.1;
    out.pad.a = cfg.arousalCold ?? -0.04;
    // 冷不是「关系变差」，只是这一下没接上：关系只给极小回撤，且不给负值
    out.rel.warmth = -((cfg.relWarmth ?? 0.02) / 2);
    out.rel.trust = 0;
  }
  return out;
}

function status(key) {
  const st = load(key);
  return { key, ema: st.ema, streakWarm: st.streakWarm, streakCold: st.streakCold, lastKind: st.lastKind, turns: st.turns, note: noteFor(st), updatedAt: st.updatedAt };
}

function list() {
  let names = [];
  try { names = fs.readdirSync(dirOf()).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  return names.map(f => {
    const s = readJson(path.join(dirOf(), f), null);
    return s ? { key: s.key, ema: s.ema, streakWarm: s.streakWarm, streakCold: s.streakCold, lastKind: s.lastKind, turns: s.turns } : null;
  }).filter(Boolean);
}

function reset(key) {
  const st = blank(key);
  save(st);
  return st;
}

module.exports = {
  DEFAULTS, CFG_PATH, configure, options, loadCfg, dirOf, fileOf, slugOf,
  blank, load, save, signals, judge, observe, noteFor, affectDelta,
  bigrams, overlapOf, status, list, reset
};

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2);
  const c = loadCfg(true);
  if (cmd === 'list') {
    const rows = list();
    if (!rows.length) { console.log('[echo] 还没有记录'); process.exit(0); }
    for (const r of rows) {
      const streak = r.streakCold >= 2 ? `连续冷 ${r.streakCold}` : (r.streakWarm >= 2 ? `连续热 ${r.streakWarm}` : '');
      console.log(`${r.key}  对话 ${String(r.turns).padStart(3)} 轮  平滑 ${r.ema >= 0 ? '+' : ''}${r.ema}  最近 ${r.lastKind}  ${streak}`);
    }
  } else if (cmd === 'status' && a1) {
    console.log(JSON.stringify(status(a1), null, 2));
  } else if (cmd === 'sim') {
    // node scripts/echo.js sim <我上次说的> <TA 回的>
    const res = observe('__sim__', { mineText: a1 || '', theirsText: a2 || '', mineAt: Date.now() - 60000, theirsAt: Date.now() });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'reset' && a1) {
    reset(a1);
    console.log('[echo] 已重置 ' + a1);
  } else {
    console.log('用法：node scripts/echo.js list | status <key> | sim "<我说的>" "<TA回的>" | reset <key>');
    console.log('参数：enabled, warmLatencyMs, coldLatencyMs, warmLenRatio, coldLenRatio, emaAlpha, streakForHint, padWarm, padCold …');
  }
}
