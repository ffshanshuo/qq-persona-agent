/**
 * timeline.js —— 从对话时间戳里读「时间感」
 *
 * 人聊天时天然带着时间：02 分说「我去洗澡」，12 分说「洗完了」，
 * 对面立刻知道「大概洗了十分钟」。模型没有这个能力（它只看到一串文字），
 * 所以这一层做两件事：
 *   ① 给上下文补上相对时间（几秒前 / 几分钟前 / 昨天 21:12），
 *   ② 从「状态变化对」里算出间隔（去洗澡→洗完了、出门→到了、开会→开完了…），
 *      把「中间约 9 分钟」这种常识写进 prompt，并且落盘留痕。
 *
 * 纯本地规则，0 token；只读 context 的原文窗口，不写别人的状态。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../lib/store.js');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'logs', 'timeline');

const DEFAULTS = {
  enabled: true,
  maxHours: 8,          // 一对「开始/结束」最多隔多久还算同一次（超过就是两次不同的事）
  minMinutes: 1,        // 少于 1 分钟不报（同一口气说的「去洗澡…洗完了」是玩笑）
  lookbackHours: 72,    // 只关心近 3 天的
  maxItems: 3,          // prompt 里最多提几条
  gapMin: 5,            // 相邻两句隔多久才在上下文里标时间（更短的标了反而吵）
  keepSpans: 80,
  onlyThem: true        // 只认对方自己的汇报；我这边的叮嘱（「洗完早点睡」）不算状态变化
};

// 「去做什么」→「做完了」的状态对。宁缺勿滥：只收闭合明确、真人真的会汇报的。
const PAIRS = [
  { id: 'shower', label: '洗澡', unit: '分钟', start: /(?:去)?洗(?:个)?澡|冲个澡|冲凉|去冲(?:个)?澡/, end: /洗(?:完|好)(?:了|啦)?|洗完澡/ },
  { id: 'sleep', label: '睡觉', unit: '分钟', start: /去睡(?:觉)?|睡了|睡觉了|躺下|眯(?:一)?会|睡(?:一)?会/, end: /睡(?:醒|完)(?:了|啦)?|醒了|醒过来|起床了?|起来了/ },
  { id: 'meal', label: '吃饭', unit: '分钟', start: /去吃饭|吃饭去|先吃(?:饭)?|去吃了|外卖到了|做饭去/, end: /吃(?:完|好)(?:了|啦)?|吃过了/ },
  { id: 'out', label: '出门', unit: '分钟', start: /出(?:了)?门|出发|我走了|我过去/, end: /到了|到家了?|回来了?|到公司|到学校|到楼下/ },
  { id: 'work', label: '上班/上课', unit: '分钟', start: /去上班|上班了|去公司|去上课|上课了|去教室|去实验室/, end: /下班了?|放学了?|下课了?|回宿舍/ },
  { id: 'meeting', label: '开会', unit: '分钟', start: /去开会|开会了?|进会|有个会/, end: /开完会|会开完|散会|会结束/ },
  { id: 'run', label: '跑步', unit: '分钟', start: /去跑(?:步)?|跑步去|出去跑/, end: /跑完(?:了)?|跑回来/ },
  { id: 'study', label: '学习/复习', unit: '分钟', start: /去自习|去复习|看书去|背单词|写作业/, end: /复习完|背完了|写完作业|看完了/ },
  { id: 'game', label: '打游戏', unit: '分钟', start: /来一局|开黑|打游戏去|上号/, end: /打完了?|不玩了|下线了?|下了/ },
  { id: 'call', label: '打电话', unit: '分钟', start: /去接(?:个)?电话|打个电话|通个话/, end: /挂了|打完电话|通话结束/ }
];

const HOUR = 3600000;
const MIN = 60000;

function cfg(over) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'timeline.json'), 'utf8')); } catch (e) { file = {}; }
  return { ...DEFAULTS, ...file, ...(over || {}) };
}

function dirOf() { return process.env.QQTIMELINE_DIR || DIR; }

function slugOf(key) {
  return String(key || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }

/** 2 位补零 */
function p2(n) { return String(n).padStart(2, '0'); }

/** 某个时刻的「钟点」文本：同一天给 HH:MM，跨天给 M-D HH:MM */
function clockOf(t, now) {
  const d = new Date(t);
  const n = new Date(now || Date.now());
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  return same ? hm : (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm;
}

/** 相对时间标签：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M-D HH:MM */
function relativeLabel(t, now) {
  const n = now || Date.now();
  if (!t) return '';
  const gap = Math.max(0, n - t);
  if (gap < MIN) return '刚刚';
  if (gap < HOUR) return Math.round(gap / MIN) + ' 分钟前';
  if (gap < 6 * HOUR) return Math.round(gap / HOUR) + ' 小时前';
  const d = new Date(t), nd = new Date(n);
  const dayDiff = Math.floor((new Date(nd.getFullYear(), nd.getMonth(), nd.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (dayDiff === 1) return '昨天 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  if (dayDiff === 0) return p2(d.getHours()) + ':' + p2(d.getMinutes());
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

/** 相邻两句的间隔标记；太短的返回 ''（不打扰模型） */
function gapMarker(prevT, t, gapMin) {
  const g = Number(gapMin || DEFAULTS.gapMin);
  if (!prevT || !t) return '';
  const gap = t - prevT;
  if (gap < g * MIN) return '';
  if (gap < HOUR) return '(+' + Math.round(gap / MIN) + ' 分钟)';
  if (gap < 12 * HOUR) return '(+' + Math.round((gap / HOUR) * 10) / 10 + ' 小时)';
  return '(隔了 ' + Math.round(gap / 86400000) + ' 天)';
}

/** 把 turns 里所有「开始/结束」事件抽出来（按时间升序） */
function events(turns, options) {
  const o = cfg(options);
  const out = [];
  for (const t of turns || []) {
    const text = String(t.text || '');
    if (!text) continue;
    // 只认对方自己的汇报
    if (o.onlyThem !== false && t.from === 'me') continue;
    // 问句不算状态汇报：「到了吗/洗完了吗」是在问，不是在说
    if (/[?？]s*$/.test(text) || /(?:吗|么|呢|没)s*[。！!~～]?$/.test(text)) continue;
    // 叮嘱/假设/否定也不是：「快点去洗」「是不是没洗」「洗完早点睡」
    if (/(?:是不是|万一|如果|要是|别|不用|快去|快点|早点|记得|说一声|跟我说|告诉我)/.test(text)) continue;
    for (const p of PAIRS) {
      if (p.start.test(text)) out.push({ pair: p.id, label: p.label, unit: p.unit, kind: 'start', t: t.t, text: text.slice(0, 60), from: t.from });
      if (p.end.test(text)) out.push({ pair: p.id, label: p.label, unit: p.unit, kind: 'end', t: t.t, text: text.slice(0, 60), from: t.from });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * 配对：每个 start 找它之后、同一 pair 的**第一个** end；
 * 中间如果又出现一个 start，说明上一次没交代就过去了，丢弃旧的。
 */
function spans(turns, options) {
  const o = cfg(options);
  const evs = events(turns, options);
  const openByPair = new Map();
  const out = [];
  for (const e of evs) {
    if (e.kind === 'start') { openByPair.set(e.pair, e); continue; }
    const start = openByPair.get(e.pair);
    if (!start) continue;
    const minutes = Math.round((e.t - start.t) / MIN);
    if (minutes < o.minMinutes) continue;
    if (e.t - start.t > o.maxHours * HOUR) { openByPair.delete(e.pair); continue; }
    out.push({
      pair: e.pair, label: e.label, unit: e.unit,
      startAt: start.t, endAt: e.t, minutes,
      startText: start.text, endText: e.text,
      from: start.from, startFrom: start.from, endFrom: e.from
    });
    openByPair.delete(e.pair);
  }
  return out;
}

/** 一段间隔说成人话 */
function describe(span, now) {
  const n = now || Date.now();
  const mins = Number(span.minutes) || 0;
  let dur;
  if (mins < 60) dur = '约 ' + mins + ' 分钟';
  else {
    const h = Math.floor(mins / 60), m = mins % 60;
    dur = m ? '约 ' + h + ' 小时 ' + m + ' 分钟' : '约 ' + h + ' 小时';
  }
  return `${span.label}：${clockOf(span.startAt, n)} 说「${span.startText}」→ ${clockOf(span.endAt, n)} 说「${span.endText}」，中间${dur}`;
}

/** 读回落盘的间隔，并按当前规则清洗（我这边的话、太短的、过期的都不要） */
function storedSpans(key, options) {
  const o = cfg(options);
  const now = Number(o.now) || Date.now();
  const data = store.readJson(fileOf(key), { spans: [] }, { onError: () => {} });
  return (data.spans || [])
    .filter(s => s && s.pair && s.endAt)
    .filter(s => (o.onlyThem === false || (s.from !== 'me' && s.endFrom !== 'me')))
    .filter(s => (Number(s.minutes) || 0) >= (Number(o.minMinutes) || 1))
    .filter(s => now - s.endAt <= o.lookbackHours * HOUR)
    .sort((a, b) => a.endAt - b.endAt);
}

/**
 * 给 prompt 用的一段「时间线」。
 *
 * 两个来源合并：① 当前原文窗口里能算出来的；② 之前算过、落在 logs/timeline 的留痕
 * （原文窗口会被摘要压缩掉，19:44→20:16 这种一小时前的对话很快就看不见了，
 *  留痕是它唯一的去处）。同一对以「刚算出来的」为准。
 */
function noteFor(key, options) {
  const o = cfg(options);
  if (!o.enabled) return { note: '', spans: [] };
  const now = Number(o.now) || Date.now();
  const ctx = require('./context.js');
  let turns = [];
  try { turns = (ctx.load(key) || {}).turns || []; } catch (e) { turns = []; }
  const recent = turns.filter(t => t && t.t && now - t.t <= o.lookbackHours * HOUR);
  const fresh = spans(recent, o).filter(s => now - s.endAt <= o.lookbackHours * HOUR);
  const freshSig = new Set(fresh.map(s => s.pair + '|' + s.startAt));
  const merged = [...fresh, ...storedSpans(key, o).filter(s => !freshSig.has(s.pair + '|' + s.startAt))]
    .sort((a, b) => a.endAt - b.endAt);
  const picked = merged.slice(-o.maxItems).reverse();
  if (!picked.length) return { note: '', spans: [] };
  const lines = picked.map(s => '- ' + describe(s, now));
  const note = '从你们的聊天时间戳里能算出来的（当常识用，别直接念时间）：\n' + lines.join('\n');
  return { note, spans: picked };
}

/** 落盘留痕（每会话保留最近 keepSpans 条，带 ISO 时间） */
function remember(key, list, now) {
  const o = cfg();
  const n = now || Date.now();
  const file = fileOf(key);
  const data = store.readJson(file, { key, spans: [], updatedAt: 0 }, { onError: () => {} });
  // 旧条目可能是我这边的话或按旧规则算出来的，写入时顺手清洗
  const keptOld = (data.spans || []).filter(x => x && (o.onlyThem === false || (x.from !== 'me' && x.endFrom !== 'me')) && (Number(x.minutes) || 0) >= (Number(o.minMinutes) || 1));
  const seen = new Set(keptOld.map(s => s.startAt + '|' + s.pair));
  const fresh = [];
  for (const s of list || []) {
    const sig = s.startAt + '|' + s.pair;
    if (seen.has(sig)) continue;
    seen.add(sig);
    fresh.push({ ...s, at: new Date(n).toISOString(), endIso: new Date(s.endAt).toISOString() });
  }
  if (!fresh.length) return data;
  const next = { key, updatedAt: n, updatedAtIso: new Date(n).toISOString(), spans: [...(data.spans || []), ...fresh].slice(-Number(o.keepSpans || 80)) };
  store.writeJson(file, next);
  return next;
}

function list() {
  const d = dirOf();
  let names = [];
  try { names = fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  return names.map(f => {
    const data = store.readJson(path.join(d, f), null, { onError: () => {} });
    const spans = (data && data.spans) || [];
    return { key: (data && data.key) || f.replace(/\.json$/, ''), spans: spans.length, updatedAt: (data && data.updatedAt) || 0, last: spans[spans.length - 1] || null };
  }).filter(Boolean);
}

module.exports = {
  DEFAULTS, PAIRS, cfg, dirOf, slugOf, fileOf,
  clockOf, relativeLabel, gapMarker, events, spans, describe, noteFor, storedSpans, remember, list
};
