/**
 * test-remind-live.js —— 承诺到期提醒的真模型抽样（隔离目录，不发真消息）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-remind-live');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-reecho-live');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-remind-live-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-remind-live-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-remind-live-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-remind-live');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-remind-live');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-remind-live');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-remind-live');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-remind-live');
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-remind-live.log');

const mind = require('./mind.js');
const context = require('./context.js');
const promises = require('./promises.js');
const longing = require('./longing.js');

const KEY = 'p:100000001';
const NOW = Date.now();
const H = 3600e3;
const NICK = '好友A';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

for (const d of [process.env.QQMIND_DIR, process.env.QQCTX_DIR, process.env.QQPROMISE_DIR, process.env.QQLONGING_DIR, process.env.QQBOND_DIR, process.env.QQTRACE_DIR]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// 造一段真实感的对话：约好周末去爬香山
const st = mind.blankState(KEY, 'private', { uin: 100000001 });
st.msgCount = 24;
st.rel = { warmth: 0.72, trust: 0.6, intimacy: 0.5, tension: 0.02 };
st.lastAffect = { pad: { p: 0.35, a: 0.3, d: 0.15 }, salience: 0.5, at: NOW - 20 * 60e3 };
st.lastTurnAt = NOW - 35 * 60e3;
st.pendingConsolidate = 0;
mind.saveState(st);

const c = context.load(KEY);
c.turns = [
  { t: NOW - 3 * 864e5, from: 'them', speaker: NICK, text: '这周考完就解放了' },
  { t: NOW - 3 * 864e5 + 60e3, from: 'me', text: '那周末去爬香山吧，我陪你，说好了' },
  { t: NOW - 3 * 864e5 + 120e3, from: 'them', speaker: NICK, text: '好呀，说定了！' },
  { t: NOW - 35 * 60e3, from: 'them', speaker: NICK, text: '今天累死了，先睡' }
];
context.save(KEY, c);

const caught = promises.capture(KEY, { myText: '这周末我陪你去爬香山，说好了' });
console.log('捕获承诺:', caught.map(x => `${x.text} [due=${x.due}]`).join(' / '));
const raw = promises.load(KEY);
raw.items[0].dueAt = NOW - 40 * 60e3; // 约定时间：40 分钟前（就像"周末到了"）
raw.items[0].createdAt = NOW - 3 * 864e5;
promises.save(KEY, raw);

longing.configure({ enabled: true, minIdleHours: 2, minTurns: 6, quietHours: [], intensityThreshold: 1, perContactHours: 20 });

(async () => {
  const sent = [];
  const logs = [];
  const r = await longing.runOnce({
    now: NOW,
    dry: true,
    send: async (d) => { sent.push(d); return { status: 'ok', dry: true }; },
    log: (o) => { logs.push(o); console.log('  log:', JSON.stringify(o)); }
  });

  ok('真模型跑通且发出一条（dry）', r.sent.length === 1 && sent.length === 1, { sent: r.sent, skipped: r.skipped });
  const reply = (r.sent[0] && r.sent[0].reply) || (sent[0] && sent[0].reply) || '';
  console.log('\n开场白:', reply, '\n');

  ok('提到了约定的事（爬/香山）', /爬|香山|山/.test(reply), reply);
  ok('没问「在吗」', !/在吗|在不在|在么/.test(reply), reply);
  ok('没提自动/定时', !/自动|定时|机器人|助手/.test(reply), reply);
  ok('没说「我记得我答应过你」式的机械话', !/我记得我答应|我答应过你的/.test(reply), reply);
  ok('长度像人话（≤80 字）', reply.length <= 80, reply.length);
  ok('日志里有 due 记账的 dry 记录或 longing-out', logs.some(x => x.event === 'longing-out' || x.event === 'due-skip'), logs.map(x => x.event));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
