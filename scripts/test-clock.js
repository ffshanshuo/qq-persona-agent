/**
 * test-clock.js —— 历法感（clock.js）自检（全离线）
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const clock = require('./clock.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// 北京时间 -> Date
const bj = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi, 0);

// ── 1) 周几 / 周末
ok('2026-10-23 是周五', clock.weekdayOf(bj(2026, 10, 23)) === 5, clock.weekdayOf(bj(2026, 10, 23)));
ok('周五不算周末', clock.isWeekend(bj(2026, 10, 23)) === false);
ok('周六算周末', clock.isWeekend(bj(2026, 10, 24)) === true);
ok('周日算周末', clock.isWeekend(bj(2026, 10, 25)) === true);

// ── 2) 时段
const phase = (h) => clock.phaseOf(bj(2026, 10, 23, h));
ok('3 点是深夜', phase(3) === '深夜', phase(3));
ok('7 点是早上', phase(7) === '早上');
ok('10 点是上午', phase(10) === '上午');
ok('12 点是中午', phase(12) === '中午');
ok('15 点是下午', phase(15) === '下午');
ok('18 点是傍晚', phase(18) === '傍晚');
ok('20 点是晚上', phase(20) === '晚上');
ok('23 点又是深夜', phase(23) === '深夜');

// ── 3) 节日
ok('10-01 是国庆节', clock.holidayOf(bj(2026, 10, 1)).name === '国庆节');
ok('09-25 是中秋节', clock.holidayOf(bj(2026, 9, 25)).name === '中秋节');
ok('02-17 是春节', clock.holidayOf(bj(2026, 2, 17)).name === '春节');
ok('普通日子没有节日', clock.holidayOf(bj(2026, 10, 23)).isHoliday === false);
ok('节日前一天能识别「明天是X」', clock.holidayOf(bj(2026, 9, 30)).tomorrow === '国庆节');
ok('节日后一天能识别「昨天是X」', clock.holidayOf(bj(2026, 10, 2)).yesterday === '国庆节');
ok('没配的年份不会乱猜', clock.holidayOf(bj(2030, 10, 1)).isHoliday === false);

// ── 4) 相对日
const now = bj(2026, 10, 23, 20);
ok('今天/昨天/明天/前天/后天', [
  clock.dayWordFor(now.getTime(), now.getTime()), clock.dayWordFor(bj(2026, 10, 22).getTime(), now.getTime()),
  clock.dayWordFor(bj(2026, 10, 24).getTime(), now.getTime()), clock.dayWordFor(bj(2026, 10, 21).getTime(), now.getTime()),
  clock.dayWordFor(bj(2026, 10, 25).getTime(), now.getTime())
].join('/') === '今天/昨天/明天/前天/后天');
ok('更远的日子给日期', /月/.test(clock.dayWordFor(bj(2026, 11, 5).getTime(), now.getTime())), clock.dayWordFor(bj(2026, 11, 5).getTime(), now.getTime()));

// ── 5) 提示语
const r1 = clock.noteFor({ now: bj(2026, 10, 23, 20).getTime() });
ok('提示里有日期与周几', /10 月 23 日/.test(r1.note) && /周五/.test(r1.note), r1.note);
ok('提示里有「明天就周末」', /明天就周末/.test(r1.note), r1.note);
ok('提示里禁止念日期', /别报日期/.test(r1.note), r1.note);
const r2 = clock.noteFor({ now: bj(2026, 10, 24, 10).getTime() });
ok('周末提示里有「是周末」', /是周末/.test(r2.note), r2.note);
const r3 = clock.noteFor({ now: bj(2026, 10, 1, 10).getTime() });
ok('节日当天点名节日', /今天是国庆节/.test(r3.note), r3.note);
const r4 = clock.noteFor({ now: bj(2026, 9, 30, 10).getTime() });
ok('节日前提一句明天', /明天是国庆节/.test(r4.note), r4.note);

// ── 6) 学生作息推断（只说可能性，不断言）
const r5 = clock.noteFor({ now: bj(2026, 10, 23, 10).getTime(), facts: ['口腔医学专业学生', '期末考完想去看海'] });
ok('学生 + 工作日上午 → 提示可能在上课', /可能在上课/.test(r5.note), r5.note);
ok('提示里要求别断言', /别断言/.test(r5.note), r5.note);
const r6 = clock.noteFor({ now: bj(2026, 10, 24, 10).getTime(), facts: ['口腔医学专业学生'] });
ok('周末不推断在上课', !/可能在上课/.test(r6.note), r6.note);
const r7 = clock.noteFor({ now: bj(2026, 10, 23, 10).getTime(), facts: ['喜欢爬山'] });
ok('不是学生就不提上课', !/可能在上课/.test(r7.note), r7.note);

// ── 7) 开关与 info
const off = clock.noteFor({ now: Date.now(), cfg: { ...clock.loadCfg(), enabled: false } });
ok('关闭时不给提示', off.note === '');
ok('关闭时 info 仍然有', !!off.info.weekday);
const info = clock.noteFor({ now: bj(2026, 10, 23, 20).getTime() }).info;
ok('info 字段齐全', info.iso === '2026-10-23' && info.phase === '晚上' && info.weekend === false, info);
ok('tomorrowWeekday 是周六', info.tomorrowWeekday === '周六', info.tomorrowWeekday);

// ── 8) 与 auto-reply 接线：ctx.note 里有历法提示
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-clock-test.log');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-clock-test');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-clock-test');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-clock-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-clock-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-clock-test');
process.env.QQSELF_DIR = path.join(ROOT, 'logs', 'self-clock-test');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-clock-test');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.ctx-test.json');
const fs = require('fs');
try { fs.rmSync(process.env.AUTOREPLY_LOG, { force: true }); } catch (e) { /* ignore */ }

(async () => {
  const brain = require('./brain.js');
  let captured = null;
  brain.think = async (ctx) => { captured = ctx; return { reply: '嗯嗯', stickerKey: '', model: 'stub', ms: 1, finish: 'stop' }; };
  const ar = require('./auto-reply.js');
  const evt = {
    post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 100000001,
    time: Math.floor(Date.now() / 1000), message_id: 9201,
    raw_message: '明天下课要不要一起去看海', message: [{ type: 'text', data: { text: '明天下课要不要一起去看海' } }],
    sender: { user_id: 100000001, nickname: '好友A' }
  };
  try { await ar.handle(evt); } catch (e) { console.log('（handle 内部异常，忽略）', e && e.message); }
  ok('handle 把历法提示放进 ctx.note', !!(captured && /现在是什么时候|别报日期/.test(String(captured.note || ''))), captured && captured.note);
  const logTxt = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  ok('日志里有 clock 事件', /"event":"clock"/.test(logTxt), logTxt.slice(-200));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
