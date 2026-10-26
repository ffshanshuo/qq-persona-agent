/**
 * test-timeline.js —— 时间线层离线自检
 *
 * 覆盖：钟点/相对时间标签、间隔标记、状态对识别、配对规则（未被交代的开始丢弃、
 * 超时丢弃、太短不报）、人话描述、prompt 注入、落盘留痕、开关、以及
 * 「全量保存的聊天记录里同时有毫秒 t 与 ISO at」。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
process.env.QQTIMELINE_DIR = path.join(TMP, 'timeline');
process.env.QQCTX_DIR = path.join(TMP, 'context');
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.AUTOREPLY_LOG = path.join(TMP, 'autoreply.log');
process.env.QQMIND_DIR = path.join(TMP, 'mind');
process.env.QQTRACE_DIR = path.join(TMP, 'trace');
process.env.QQBOND_DIR = path.join(TMP, 'bonds');
process.env.QQECHO_DIR = path.join(TMP, 'echo');
process.env.QQMODE_DIR = path.join(TMP, 'mode');
process.env.QQTHEM_DIR = path.join(TMP, 'them');
process.env.QQFOLLOW_DIR = path.join(TMP, 'follow');
process.env.QQNICK_DIR = path.join(TMP, 'nick');
process.env.QQPROMISE_DIR = path.join(TMP, 'promises');
process.env.QQQUOTE_DIR = path.join(TMP, 'quotes');
process.env.QQRISK_DIR = path.join(TMP, 'risk');
process.env.QQLONGING_DIR = path.join(TMP, 'longing');
process.env.QQGROUP_DIR = path.join(TMP, 'group');
process.env.QQSELF_DIR = path.join(TMP, 'self');
process.env.QQPACING_DIR = path.join(TMP, 'pacing');
process.env.QQAVATAR_DIR = path.join(TMP, 'avatar');
process.env.QQEVOLVE_DIR = path.join(TMP, 'evolve');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.test.json');

const timeline = require('./timeline.js');
const context = require('./context.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

// 固定基准：2026-10-24 14:00
const T0 = new Date(2026, 9, 24, 14, 0, 0).getTime();
const M = 60000;

function turns(list) {
  return list.map(([minAgoOrAbs, from, text], i) => ({ t: minAgoOrAbs, from, speaker: from === 'me' ? '我' : '好友A', text, at: new Date(minAgoOrAbs).toISOString() }));
}

async function main() {
  // ── ① 时间标签 ───────────────────────────────────
  ok('刚刚', timeline.relativeLabel(T0 - 10 * 1000, T0) === '刚刚');
  ok('N 分钟前', timeline.relativeLabel(T0 - 8 * M, T0) === '8 分钟前');
  ok('N 小时前', timeline.relativeLabel(T0 - 3 * 3600000, T0) === '3 小时前');
  ok('昨天带钟点', /^昨天 \d{2}:\d{2}$/.test(timeline.relativeLabel(T0 - 24 * 3600000, T0)), timeline.relativeLabel(T0 - 24 * 3600000, T0));
  ok('跨天给 月-日 钟点', /^\d{1,2}-\d{1,2} \d{2}:\d{2}$/.test(timeline.relativeLabel(T0 - 5 * 86400000, T0)));
  ok('同日钟点', timeline.clockOf(new Date(2026, 9, 24, 2, 3).getTime(), T0) === '02:03');

  // ── ② 间隔标记 ───────────────────────────────────
  ok('短间隔不标', timeline.gapMarker(T0 - 2 * M, T0, 5) === '');
  ok('长间隔标分钟', timeline.gapMarker(T0 - 8 * M, T0, 5) === '(+8 分钟)');
  ok('小时级标小时', timeline.gapMarker(T0 - 3 * 3600000, T0, 5) === '(+3 小时)');
  ok('天级标天', timeline.gapMarker(T0 - 2 * 86400000, T0, 5) === '(隔了 2 天)');
  ok('没有上一条时不标', timeline.gapMarker(0, T0, 5) === '');

  // ── ③ 事件识别 ───────────────────────────────────
  const evs = timeline.events(turns([
    [T0 - 18 * M, 'them', '我洗澡去了'],
    [T0 - 8 * M, 'them', '洗完了'],
    [T0 - 5 * M, 'them', '出门了'],
    [T0 - 1 * M, 'me', '到了吗']
  ]));
  ok('认出洗澡的开始与结束', evs.filter(e => e.pair === 'shower').length === 2, evs.map(e => e.pair + ':' + e.kind));
  ok('认出出门的开始', evs.some(e => e.pair === 'out' && e.kind === 'start'));

  // ── ④ 配对与分钟数 ───────────────────────────────
  const sp = timeline.spans(turns([
    [T0 - 18 * M, 'them', '我洗澡去了'],
    [T0 - 8 * M, 'them', '洗完了']
  ]));
  ok('洗澡间隔 10 分钟', sp.length === 1 && sp[0].minutes === 10, sp);
  ok('间隔带起止原话', sp[0].startText.includes('洗澡') && sp[0].endText.includes('洗完'));

  const orphan = timeline.spans(turns([[T0 - 30 * M, 'them', '洗完了']]));
  ok('只有结束没有开始 → 不算', orphan.length === 0);

  const twice = timeline.spans(turns([
    [T0 - 40 * M, 'them', '洗澡去了'],
    [T0 - 35 * M, 'them', '洗澡去了'],
    [T0 - 30 * M, 'them', '洗完了']
  ]));
  ok('连续两个开始取最后一个', twice.length === 1 && twice[0].minutes === 5, twice);

  const tooLong = timeline.spans(turns([
    [T0 - 20 * 3600000, 'them', '开会去了'],
    [T0 - 30 * M, 'them', '开完会了']
  ]), { maxHours: 8 });
  ok('超过 maxHours 丢弃', tooLong.length === 0);

  const tooShort = timeline.spans(turns([
    [T0 - 60000, 'them', '去洗澡'],
    [T0 - 30000, 'me', '洗完没']
  ]), { minMinutes: 1 });
  ok('太短不报', tooShort.length === 0);

  const meal = timeline.spans(turns([
    [T0 - 60 * M, 'them', '先去吃饭了'],
    [T0 - 25 * M, 'them', '吃完了，好饱']
  ]));
  ok('吃饭 35 分钟', meal.length === 1 && meal[0].minutes === 35, meal);

  const outc = timeline.spans(turns([
    [T0 - 50 * M, 'them', '出门了'],
    [T0 - 20 * M, 'them', '到了到了']
  ]));
  ok('出门到到达 30 分钟', outc.length === 1 && outc[0].minutes === 30, outc);

  // ── ⑤ 人话描述 ───────────────────────────────────
  const desc = timeline.describe(sp[0], T0);
  ok('描述含「约 10 分钟」', /约 10 分钟/.test(desc), desc);
  ok('描述含起止钟点', /\d{2}:\d{2} 说「.*」→ \d{2}:\d{2}/.test(desc), desc);
  const long = timeline.describe({ label: '上班/上课', startAt: T0 - 190 * M, endAt: T0, minutes: 190, startText: '去上课了', endText: '下课了' }, T0);
  ok('超过 1 小时说成小时+分钟', /约 3 小时 10 分钟/.test(long), long);

  // ── ⑥ 落盘与读取 ─────────────────────────────────
  // 用真实 context 存三段对话（验证全量保存带时间戳）
  const KEY = 'p:100000001';
  for (const [t, from, text] of [
    [T0 - 18 * M, 'them', '我洗澡去了'],
    [T0 - 8 * M, 'them', '洗完了'],
    [T0 - 2 * M, 'me', '好快']
  ]) {
    context.push(KEY, { t, from, speaker: from === 'me' ? '我' : '好友A', text, kind: 'private', peer: { uin: '100000001', name: '好友A' } });
  }
  const file = context.__fileOf ? context.__fileOf(KEY) : null; // 没导出就用 view 验证
  const raw = context.load(KEY);
  ok('保存的每条都带 t（毫秒）', raw.turns.every(t => typeof t.t === 'number' && t.t > 0));
  ok('保存的每条都带 at（ISO）', raw.turns.every(t => typeof t.at === 'string' && /\d{4}-\d{2}-\d{2}T/.test(t.at)), raw.turns.map(t => t.at));
  const v = context.view(KEY);
  ok('view 把 t/at 交给 brain', v.history.every(h => h.t && h.at));

  const note = timeline.noteFor(KEY, { now: T0 });
  ok('noteFor 提到洗澡这件事', /洗澡/.test(note.note), note.note);
  ok('noteFor 说「约 10 分钟」', /约 10 分钟/.test(note.note), note.note);
  ok('noteFor 提示别念时间', /别直接念时间/.test(note.note));

  timeline.remember(KEY, note.spans, T0);
  const saved = JSON.parse(fs.readFileSync(timeline.fileOf(KEY), 'utf8'));
  ok('留痕含 ISO 字段', /T/.test(saved.updatedAtIso) && saved.spans.every(s => /T/.test(s.at)));
  timeline.remember(KEY, note.spans, T0);
  ok('重复留痕不重复计', JSON.parse(fs.readFileSync(timeline.fileOf(KEY), 'utf8')).spans.length === saved.spans.length);
  ok('list 能列出会话', timeline.list().some(x => x.key === KEY));

  // 太久以前的不报
  const oldNote = timeline.noteFor(KEY, { now: T0 + 100 * 3600000 });
  ok('超出 lookback 不报', oldNote.note === '');

  // ── ⑦ prompt 注入 ────────────────────────────────
  const brain = require('./brain.js');
  const msgs = brain.buildMessages({
    nick: '好友A', text: '洗完了', kind: 'private',
    history: v.history.slice(-4),
    timelineNote: note.note,
    gapMin: 5
  }, brain.loadCfg());
  const all = JSON.stringify(msgs);
  ok('prompt 里带时间线', /时间戳里能算出来/.test(all));
  ok('prompt 里带间隔标记', /\(\+\d+ 分钟\)/.test(all), (all.match(/\(\+\d+ 分钟\)/g) || []).slice(0, 3));
  ok('prompt 不露毫秒时间戳', !/\d{13}/.test(all));

  // ── ⑦b 原文窗口被压缩后，仍能从留痕里报出间隔（留痕兜底） ──
  {
    // 模拟「压缩后原文没了」：用一个空的上下文目录去问同一个 key
    const ctxMod = require('./context.js');
    const stash = ctxMod.fileOf(KEY);
    const backup = fs.readFileSync(stash, 'utf8');
    fs.writeFileSync(stash, JSON.stringify({ ...JSON.parse(backup), turns: [] }));
    const fromStored = timeline.noteFor(KEY, { now: T0 });
    fs.writeFileSync(stash, backup);
    ok('窗口里没原文时靠留痕仍能报出洗澡', /洗澡/.test(fromStored.note), fromStored.note);
    ok('留痕兜底时同一段只报一次', fromStored.spans.filter(x => x.pair === 'shower').length === 1, JSON.stringify(fromStored.spans.map(x => x.pair + '@' + x.startAt)));
  }

  // ── ⑦c endFrom 过滤：结束那句是我说的（叮嘱「洗完早点睡」）不算 ──
  {
    timeline.remember(KEY, [{
      pair: 'shower', label: '洗澡', unit: '分钟',
      startAt: T0 - 40 * 60000, endAt: T0 - 30 * 60000, minutes: 10,
      startText: '我去洗澡了', endText: '洗完早点睡',
      from: 'them', startFrom: 'them', endFrom: 'me'
    }], T0);
    const left = timeline.storedSpans(KEY, { now: T0 });
    ok('结束那句是我说的留痕被清洗掉', !left.some(s => s.endFrom === 'me'), JSON.stringify(left.map(s => s.endText)));
  }

  // ── ⑧ 开关 ───────────────────────────────────────
  const off = timeline.noteFor(KEY, { now: T0, enabled: false });
  ok('关闭后不产生 note', off.note === '' && off.spans.length === 0);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('FAIL 异常：' + (e && e.stack || e)); process.exit(1); });
