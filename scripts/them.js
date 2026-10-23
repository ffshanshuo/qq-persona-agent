/**
 * them.js —— 「TA 现在的状态」：别把要去睡觉的人当成在忙
 *
 * 为什么需要它（2026-10-24 用户指出）：对方已说「我去眯一会儿」，回复却是
 *   「好，那你忙你的，七点我准时叫你～」——前后对不上。
 *   根因两层：① 这类"当下安排"躺在最近几轮原文里，短回复时模型容易忽略；
 *   ② 更狠的是上下文紧缩（budgetChars 小的时候）会把那几句压进摘要，
 *      原文就再也看不见了 —— 光读 history 还不够，必须**在消息到达时就记下来**。
 *
 * 做法：
 *   - `note(key, text)`：消息到达即识别「状态/安排」，落盘 `logs/them/<slug>.json`（只留最近几条，按时间淘汰）
 *   - `observe(view, {key})`：先合并"落盘的状态"与"最近原文"，取时间最新的一条
 *   - `conflicts(reply, state)`：回复和状态打架（对着"去睡"说"你忙你的"）→ 触发一次重写
 *
 * 纯本地、零 token。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = process.env.QQTHEM_DIR || path.join(ROOT, 'logs', 'them');

const KINDS = [
  {
    id: 'sleep',
    label: '要睡了 / 去眯一会儿 / 躺下',
    re: /(眯一?会儿|眯一下|睡一会儿|睡一会|去睡|去躺|躺一会儿|躺一下|补觉|午睡|小睡|困了|先睡|要睡了|睡觉去|歇一会儿|休息一下|歇一下)/,
    conflict: /(忙你的|你忙|先忙|忙吧|加班|工作|上班|干活|写作业|弄完|搞完|忙完|辛苦你了?忙)/,
    line: 'TA 刚说要去睡/眯一会儿（现在多半在休息），别再问 TA 忙不忙、也别把 TA 当成在工作。'
  },
  {
    id: 'wash',
    label: '去洗澡 / 洗漱',
    re: /(洗澡|洗个澡|洗漱|冲个澡|洗头)/,
    conflict: /(忙你的|你忙|加班|工作|上班|写作业)/,
    line: 'TA 刚说去洗澡/洗漱，这会儿不在手机边上，别假设 TA 一直在线。'
  },
  {
    id: 'meal',
    label: '去吃饭',
    re: /(去吃饭|吃饭去|吃个饭|做饭|点外卖|下厨|吃口饭)/,
    conflict: /(你忙|先忙|加班|工作|上班|写作业)/,
    line: 'TA 刚说去吃饭，这会儿手上有饭，回得慢很正常。'
  },
  {
    id: 'class',
    label: '上课 / 考试 / 自习',
    re: /(上课|去教室|考试|考试周|自习|复习|图书馆|下课)/,
    conflict: /(睡吧|早点睡|去睡|躺下|休息)/,
    line: 'TA 刚说在上课/考试/自习，这会儿不方便长聊，回得慢别追问。'
  },
  {
    id: 'work',
    label: '上班 / 加班 / 忙工作',
    re: /(上班|加班|在公司|开会|赶工|忙工作|写方案|做实验|值班)/,
    conflict: /(睡吧|早点睡|去睡|躺下)/,
    line: 'TA 刚说在上班/加班/忙正事，「忙」这个说法是成立的。'
  },
  {
    id: 'out',
    label: '出门 / 在路上',
    re: /(出门|路上|在车上|坐车|地铁|公交|骑车|开车|赶过去)/,
    conflict: /(在家|躺在床上|睡着)/,
    line: 'TA 刚说在出门/路上，环境不安静，回得慢是正常。'
  },
  {
    id: 'sick',
    label: '不舒服 / 生病 / 去医院',
    re: /(不舒服|难受|感冒|发烧|头疼|肚子疼|胃疼|去医院|看医生|输液|拉肚子)/,
    conflict: /(早点睡|去睡|休息|多喝热水)/,
    line: 'TA 刚说不舒服/生病了，关心要具体一点，别只丢一句「多喝热水」。'
  }
];

const DEFAULTS = {
  enabled: true,
  scanTurns: 14,      // 往回看多少条原文
  freshMin: 90,       // “刚说过”的有效窗口（分钟）
  keepStates: 6,      // 每个会话保留几条状态记录
  mentionMin: 0
};

// ── 落盘 ─────────────────────────────────────────────────────────────────
function num(x) { return Number.isFinite(Number(x)) ? Number(x) : 0; }
function slugOf(key) { return String(key || '').replace(/[^A-Za-z0-9_-]/g, '_'); }
function dirOf() { return process.env.QQTHEM_DIR || DIR; }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }

function loadState(key) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    if (!Array.isArray(j.states)) return { key, states: [] };
    return j;
  } catch (e) {
    return { key, states: [] };
  }
}

function saveState(key, st) {
  const file = fileOf(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(st, null, 1);
  let ok = false;
  for (let i = 0; i < 4 && !ok; i++) {
    const tmp = file + '.' + process.pid + '.' + i + '.tmp';
    try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); ok = true; }
    catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { } try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + 25 * i); } catch (e3) { } }
  }
  if (!ok) { try { fs.writeFileSync(file, text); ok = true; } catch (e) { } }
  if (!ok) { try { fs.appendFileSync(path.join(ROOT, 'logs', 'them-error.log'), new Date().toISOString() + ' save failed ' + file + '\n'); } catch (e) { } }
  return ok;
}

/** 消息到达时记一笔（幂等：同 kind 同文本 30 秒内不重复） */
function note(key, text, now) {
  const t = String(text || '');
  if (!t) return null;
  const hit = detect(t);
  if (!hit) return null;
  const at = num(now) || Date.now();
  const st = loadState(key);
  const last = st.states[st.states.length - 1];
  if (last && last.id === hit.id && last.text === hit.text && at - num(last.at) < 30000) return last;
  st.key = key;
  st.states.push({ id: hit.id, label: hit.label, text: hit.text, at });
  while (st.states.length > Number(DEFAULTS.keepStates || 6)) st.states.shift();
  st.updatedAt = at;
  saveState(key, st);
  return st.states[st.states.length - 1];
}

function detect(text) {
  const s = String(text || '');
  for (const k of KINDS) {
    if (!k.re.test(s)) continue;
    const m = s.match(k.re);
    return { id: k.id, label: k.label, text: s.slice(0, 60), word: m ? m[0] : '' };
  }
  return null;
}

function minutesAgo(t, now) { return Math.max(0, Math.round((now - num(t)) / 60000)); }

/**
 * 找 TA 当前状态：落盘记录 + 最近原文，取最新一条。
 * @param {{history?:Array<{t:number,from:string,text:string}>}} view
 * @param {{now?:number,cfg?:object,key?:string}} [opts]
 */
function observe(view, opts = {}) {
  const o = { ...DEFAULTS, ...(opts.cfg || {}) };
  if (o.enabled === false) return { hit: null, line: '', kind: '' };
  const now = num(opts.now) || Date.now();
  const fresh = Number(o.freshMin || 90) * 60000;
  const key = opts.key || (view && view.key);
  let best = null;

  // ① 落盘状态（抗摘要压缩）
  if (key) {
    const st = loadState(key);
    for (const s of st.states || []) {
      if (now - num(s.at) > fresh) continue;
      if (!best || num(s.at) > best.at) best = { id: s.id, label: s.label, text: s.text, at: num(s.at) };
    }
  }
  // ② 最近原文（没记过的老会话靠这个兜底）
  const turns = ((view && view.history) || []).filter(x => x && x.from === 'them').slice(-Number(o.scanTurns || 14));
  for (const t of turns) {
    const text = String(t.text || '');
    if (!text || now - num(t.t) > fresh) continue;
    const hit = detect(text);
    if (!hit) continue;
    if (!best || num(t.t) >= best.at) best = { ...hit, at: num(t.t) };
  }

  // ③ 摘要兜底：原文被压进摘要时，状态词还在摘要里
  if (!best && view && view.summary) {
    const hit = detect(String(view.summary));
    if (hit) best = { ...hit, at: now - 5 * 60000, fromSummary: true };
  }

  if (!best) return { hit: null, line: '', kind: '' };
  best.minAgo = minutesAgo(best.at, now);
  const kind = KINDS.find(k => k.id === best.id);
  const when = best.minAgo <= 1 ? '刚才' : (best.minAgo < 60 ? `${best.minAgo} 分钟前` : `${Math.round(best.minAgo / 60)} 小时前`);
  const line = `${kind.line}（TA 原话：「${best.text}」，${when}）`;
  return { hit: best, line, kind: best.id };
}

/** 回复与状态是否打架 */
function conflicts(reply, state) {
  const r = String(reply || '');
  if (!state || !state.hit || !r) return { bad: false, kind: '', why: '', fix: '' };
  const kind = KINDS.find(k => k.id === state.hit.id);
  if (!kind) return { bad: false, kind: '', why: '', fix: '' };
  const m = r.match(kind.conflict);
  if (!m) return { bad: false, kind: '', why: '', fix: '' };
  return {
    bad: true,
    kind: kind.id,
    why: `TA 刚说的是「${String(kind.label).split(' / ')[0]}」，你这句里出现了「${m[0]}」，前后对不上。`,
    fix: '重说一句：要接住 TA 刚说的那件事，别用和它矛盾的词（比如人家说要去睡，就别说「你忙你的」）。只输出这一句。'
  };
}

module.exports = { DEFAULTS, KINDS, note, detect, observe, conflicts, minutesAgo, dirOf, fileOf, loadState, saveState, slugOf };

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const ctxStore = require('./context.js');
  const [, , cmd, key, ...rest] = process.argv;
  if (cmd === 'check' && key) {
    console.log(JSON.stringify(observe(ctxStore.view(key), { key }), null, 2));
  } else if (cmd === 'conflict' && key) {
    const st = observe(ctxStore.view(key), { key });
    console.log(JSON.stringify({ state: st.hit, verdict: conflicts(rest.join(' '), st) }, null, 2));
  } else if (cmd === 'saved' && key) {
    console.log(JSON.stringify(loadState(key), null, 2));
  } else {
    console.log('用法：node scripts/them.js check <key>            # 看 TA 当前状态提示');
    console.log('      node scripts/them.js saved <key>            # 看落盘的状态记录');
    console.log('      node scripts/them.js conflict <key> "<回复>" # 检查回复是否矛盾');
  }
}
