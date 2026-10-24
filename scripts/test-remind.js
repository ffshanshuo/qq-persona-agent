/**
 * test-remind.js —— 承诺到期提醒（resolveDue / dueItems / dueNote / longing 联动）自检
 * 全离线：不调模型、不发送。
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-remind-test');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-remind-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-remind-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-remind-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-remind-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-remind-test');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-remind-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-remind-test');
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-remind-test.log');

const fs = require('fs');
const promises = require('./promises.js');
const mind = require('./mind.js');
const context = require('./context.js');
const longing = require('./longing.js');

const FRI = new Date(2026, 9, 23, 19, 0, 0).getTime(); // 周五 19:00
const H = 3600e3;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

function reset() {
  for (const d of [process.env.QQPROMISE_DIR, process.env.QQMIND_DIR, process.env.QQCTX_DIR, process.env.QQLONGING_DIR, process.env.QQBOND_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  try { fs.rmSync(process.env.AUTOREPLY_LOG, { force: true }); } catch (e) { /* ignore */ }
  promises.configure({ enabled: true, remindCooldownHours: 6, maxReminders: 2 });
  longing.configure({ enabled: true, minIdleHours: 2, minTurns: 1, quietHours: [], perContactHours: 20, intensityThreshold: 1 });
  context.configure({ enabled: true });
}

const KEY = 'p:100000001';

function seedSession({ turns = 8, idleHours = 0.2, intimacy = 0.5, warmth = 0.7, salience = 0.4, lastTurnAt } = {}) {
  const st = mind.blankState(KEY, 'private', { uin: 100000001 });
  st.msgCount = turns;
  st.rel = { warmth, trust: 0.5, intimacy, tension: 0.05 };
  st.lastAffect = { pad: { p: 0.2, a: 0.3, d: 0.1 }, salience, at: FRI };
  st.lastTurnAt = lastTurnAt || (FRI - idleHours * H);
  mind.saveState(st);
  const c = context.load(KEY);
  c.turns = [{ t: st.lastTurnAt, from: 'me', text: '我下周陪你去海边' }];
  context.save(KEY, c);
  return st;
}

(async () => {
  // ── 1) resolveDue 映射
  reset();
  const fmt = (t) => (t ? new Date(t) : null);
  ok('今晚 → 当晚 20:00', new Date(promises.resolveDue('今晚', FRI)).getHours() === 20 && new Date(promises.resolveDue('今晚', FRI)).getDate() === 23);
  ok('明天 → 次日 9:00', new Date(promises.resolveDue('明天', FRI)).getDate() === 24);
  ok('周末 → 周六 10:00', new Date(promises.resolveDue('周末', FRI)).getDate() === 24 && new Date(promises.resolveDue('周末', FRI)).getHours() === 10);
  ok('下周 → 下周一 10:00', new Date(promises.resolveDue('下周', FRI)).getDate() === 26);
  ok('月底 → 当月最后一天 20:00', new Date(promises.resolveDue('月底', FRI)).getDate() === 31);
  ok('考完试 → null（日子不确定就别猜）', promises.resolveDue('考完试', FRI) === null);
  ok('周日说「周末」→ 当天', new Date(promises.resolveDue('周末', new Date(2026, 9, 25, 11).getTime())).getDate() === 25);

  // ── 2) capture 存 dueAt
  reset();
  const got = promises.capture(KEY, { myText: '周末我陪你去爬山，说好了' });
  ok('抽到承诺', got.length === 1, got);
  ok('due 是周末', got[0] && got[0].due === '周末', got[0] && got[0].due);
  ok('dueAt 落到周六', got[0] && new Date(got[0].dueAt).getDate() === 24, got[0] && new Date(got[0].dueAt).toISOString());
  const noDue = promises.capture(KEY, { myText: '我回头帮你看看那个软件' });
  ok('没有时间词时 dueAt 为空', noDue.length === 1 && !noDue[0].dueAt, noDue);

  // ── 3) dueItems 窗口
  reset();
  promises.capture(KEY, { myText: '明天我陪你去海边，说好了' });
  {
    const raw = promises.load(KEY);
    raw.items[0].dueAt = FRI + 24 * H; // 固定基准：明天 19:00
    promises.save(KEY, raw);
  }
  const item = promises.load(KEY).items[0];
  const dueAt = item.dueAt;
  ok('到期前 2 小时内开始算', promises.dueItems(KEY, { now: dueAt - 2.5 * H }).length === 0 && promises.dueItems(KEY, { now: dueAt - 1 * H }).length === 1);
  ok('到期后 36 小时内还算', promises.dueItems(KEY, { now: dueAt + 20 * H }).length === 1 && promises.dueItems(KEY, { now: dueAt + 48 * H }).length === 0);
  ok('dueItems 带 overdueHours', typeof promises.dueItems(KEY, { now: dueAt + 3 * H })[0].overdueHours === 'number');

  // ── 4) 冷却与次数
  reset();
  promises.capture(KEY, { myText: '明天我陪你去海边，说好了' });
  {
    const raw = promises.load(KEY);
    raw.items[0].dueAt = FRI + 24 * H;
    promises.save(KEY, raw);
  }
  const it2 = promises.load(KEY).items[0];
  // markReminded 内部用 Date.now()，为了测冷却得手动把 remindedAt 设到基准时间附近
  promises.markReminded(KEY, [it2.id]);
  {
    const raw = promises.load(KEY);
    raw.items[0].remindedAt = FRI + 24 * H - 3600e3;
    promises.save(KEY, raw);
  }
  ok('提醒后冷却内不再出', promises.dueItems(KEY, { now: it2.dueAt + 1 * H }).length === 0);
  ok('过了冷却又会出现', promises.dueItems(KEY, { now: it2.dueAt + 7 * H }).length === 1);
  promises.markReminded(KEY, [it2.id]);
  ok('提醒满 2 次后不再念', promises.dueItems(KEY, { now: it2.dueAt + 8 * H }).length === 0);

  // ── 5) dueNote 人话
  reset();
  const n = promises.dueNote({ text: '明天陪你去海边', dueAt: FRI + 24 * H }, FRI);
  ok('dueNote 提到约定内容', /明天陪你去海边/.test(n), n);
  ok('dueNote 说「就是明天」', /就是明天/.test(n), n);
  ok('dueNote 不要像催账', /不是催账|别提「我记着一条承诺」/.test(n), n);
  const n2 = promises.dueNote({ text: '陪你去海边', dueAt: FRI - 5 * H }, FRI);
  ok('过期时提示道个歉再补上', /过了|道歉|补上/.test(n2), n2);

  // ── 6) longing 联动：刚聊完也因到期承诺被选中
  reset();
  seedSession({ idleHours: 0.3 });
  ok('没有承诺时刚聊完不算到点', longing.plan({ now: FRI }).length === 0, longing.plan({ now: FRI }));
  const c1 = promises.capture(KEY, { myText: '明天我陪你去海边，说好了' });
  void c1;
  // 把 dueAt 挪到「现在」
  let cur = promises.list(KEY)[0];
  promises.configure({ enabled: true, remindCooldownHours: 6, maxReminders: 2 });
  const raw = promises.load(KEY);
  raw.items[0].dueAt = FRI;
  promises.save(KEY, raw);
  const pl = longing.plan({ now: FRI });
  ok('到期承诺 + 刚聊过 18 分钟也能被选中', pl.length === 1, pl);
  ok('候选里带 due', pl[0] && pl[0].due && /海边/.test(pl[0].due.text), pl[0] && pl[0].due);
  ok('强度被抬到 ≥1.25', pl[0] && pl[0].intensity >= 1.25, pl[0] && pl[0].intensity);
  const reason = longing.reasonOf(pl[0]);
  ok('理由里说了约定的事', /海边/.test(reason), reason);
  ok('理由不是催账口吻', /不是催账/.test(reason), reason);

  // ── 7) runOnce：真发才记账
  reset();
  seedSession({ idleHours: 0.3 });
  promises.capture(KEY, { myText: '明天我陪你去海边，说好了' });
  const raw2 = promises.load(KEY);
  raw2.items[0].dueAt = FRI;
  promises.save(KEY, raw2);
  const sents = [];
  let ctxSeen = null;
  const r1 = await longing.runOnce({
    now: FRI, dry: true,
    think: async (ctx) => { ctxSeen = ctx; return { reply: '明天不是说好去看海吗，几点出发？' }; },
    send: async (d) => { sents.push(d); return { status: 'ok', dry: true }; },
    log: () => { }
  });
  ok('dry 也算跑通', r1.sent.length === 1, r1);
  ok('ctx.due 传给 brain', ctxSeen && ctxSeen.due === true, ctxSeen && ctxSeen.due);
  ok('ctx.reason 提到约定', ctxSeen && /海边/.test(String(ctxSeen.reason)), ctxSeen && ctxSeen.reason);
  ok('dry 不记账（承诺仍可提醒）', promises.list(KEY)[0].reminders === 0, promises.list(KEY)[0].reminders);
  ok('dry 不记账（longing 账本空）', (longing.list({ now: FRI })[0] || {}).lastOutAt === undefined || !fs.existsSync(longing.fileOf(KEY)) || !longing.load(KEY).lastOutAt);

  const sent2 = [];
  const r2 = await longing.runOnce({
    now: FRI, dry: false,
    think: async () => ({ reply: '说好的事，明天几点出发？' }),
    send: async (d) => { sent2.push(d); return { status: 'ok', retcode: 0 }; },
    log: () => { }
  });
  ok('真发成功', r2.sent.length === 1 && sent2.length === 1, r2);
  ok('真发后承诺记一次提醒', promises.list(KEY)[0].reminders === 1, promises.list(KEY)[0].reminders);
  ok('真发后 longing 记账', !!longing.load(KEY).lastOutAt);

  // ── 8) 模型拒绝就不发、不记账
  reset();
  seedSession({ idleHours: 0.3 });
  promises.capture(KEY, { myText: '明天我陪你去海边，说好了' });
  const raw3 = promises.load(KEY);
  raw3.items[0].dueAt = FRI;
  promises.save(KEY, raw3);
  let sentAny = false;
  const r3 = await longing.runOnce({
    now: FRI, dry: false,
    think: async () => ({ reply: '' }),
    send: async () => { sentAny = true; return { status: 'ok' }; },
    log: () => { }
  });
  ok('模型回 [SKIP] 就不发', sentAny === false && r3.sent.length === 0, r3);
  ok('模型拒绝也不记账', promises.list(KEY)[0].reminders === 0);

  // ── 9) 免打扰时段照样不动
  reset();
  seedSession({ idleHours: 0.3 });
  promises.capture(KEY, { myText: '明天我陪你去海边，说好了' });
  const raw4 = promises.load(KEY);
  raw4.items[0].dueAt = FRI;
  promises.save(KEY, raw4);
  const night = new Date(2026, 9, 23, 23, 30, 0).getTime();
  const r4 = await longing.runOnce({ now: night, dry: false, think: async () => ({ reply: 'x' }), send: async () => ({ status: 'ok' }), log: () => { } });
  ok('半夜也照提（DSH 不看钟点，尤其对想念的人）', r4.skipped !== 'quiet' && Array.isArray(r4.sent) && r4.sent.length === 1, r4);
  longing.configure({ quietHours: [23, 8] });
  const r5 = await longing.runOnce({ now: night, dry: true, think: async () => ({ reply: 'x' }), send: async () => ({ status: 'ok', dry: true }), log: () => { } });
  ok('显式配了免打扰才会在夜里按住', r5.skipped === 'quiet', r5);
  longing.configure({ quietHours: [] });

  // ── 10) 开关
  reset();
  seedSession({ idleHours: 0.3 });
  promises.configure({ enabled: false });
  ok('承诺模块关闭时 dueItems 为空', promises.dueItems(KEY, { now: FRI }).length === 0);
  promises.configure({ enabled: true, remindCooldownHours: 6, maxReminders: 2 });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
