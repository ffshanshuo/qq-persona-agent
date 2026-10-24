'use strict';
/**
 * test-promise-e2e.js —— 承诺层的端到端演练（真实 brain，dry 不真发）。
 * 验证链路：种下承诺 → 对方的话把承诺勾起来 → brain 在回复里接上 →
 *           记一次提醒 → 不重复存同一件事 → 上下文里留下这两条来回。
 *
 * 全部目录隔离，不会碰生产上下文/记忆/承诺库，也不会真的发消息。
 * 运行：node scripts/test-promise-e2e.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
process.env.AUTOREPLY_DRY = '1';
 process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-+extra+-test.log');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.ctx-test.json');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-promise-e2e');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-promise-e2e');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-promise-e2e');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-promise-e2e-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-promise-e2e-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-promise-e2e-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-promise-e2e');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-promise-e2e');

const ar = require('./auto-reply.js');
const promises = require('./promises.js');
const ctxStore = require('./context.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra != null ? '  ' + JSON.stringify(extra) : '')); }
};

const KEY = 'p:100000001';
const logFile = process.env.AUTOREPLY_LOG;

function readLog(fromIdx) {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    return lines.slice(fromIdx).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function logCount() {
  try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').length; } catch (e) { return 0; }
}

(async () => {
  for (const d of [process.env.QQCTX_DIR, process.env.QQMIND_DIR, process.env.QQTRACE_DIR, process.env.QQPROMISE_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { }
  }
  promises.configure({ enabled: true });
  ar.promiseSettings();

  // ① 种下一条承诺
  const seeded = promises.capture(KEY, { myText: '考完试我陪你去海边，说好了。' });
  ok('① 承诺入库', seeded.length === 1 && /海边/.test(seeded[0].text), seeded);

  // ② 对方说一句会勾起它的话（真实 brain 生成回复，dry 发送）
  const mark = logCount();
  const evt = {
    post_type: 'message',
    message_type: 'private',
    user_id: 100000001,
    message_id: 990000000 + Math.floor(Math.random() * 100000),
    time: Math.floor(Date.now() / 1000),
    raw_message: '我下周三考完了，然后就没课了',
    message: [{ type: 'text', data: { text: '我下周三考完了，然后就没课了，感觉整个人都空了' } }],
    sender: { user_id: 100000001, nickname: '好友A' }
  };
  await ar.handle(evt);
  const logs = readLog(mark);

  ok('② 命中承诺', logs.some(l => l.event === 'promise-hit' && l.n >= 1), logs.filter(l => l.event === 'promise-hit'));
  const thought = logs.find(l => l.event === 'thought');
  ok('② brain 给出了回复', thought && thought.reply && thought.reply.length > 0, thought && thought.reply);
  ok('② 演练发送成功', logs.some(l => l.event === 'dry-send'), logs.filter(l => l.event === 'dry-send').length);
  // 演练模式不记账：提醒次数与库内容都不该动
  ok('② 演练不记提醒', logs.some(l => l.event === 'promise-skip' && l.reason === 'dry'), logs.filter(l => l.event === 'promise-skip'));

  // ③ 库里的状态：提醒次数 +1，且没有把「复述」存成第二条
  const items = promises.list(KEY);
  ok('③ 提醒次数没被演练动过', items.every(x => (x.reminders || 0) === 0), items);
  ok('③ 没有重复承诺', items.length === 1, items.map(x => x.text));

  // ④ 上下文里有这一来一回
  const view = ctxStore.view(KEY);
  const them = view.history.filter(t => t.from === 'them');
  ok('④ 上下文记下了对方的话', them.some(t => /考完/.test(t.text)), view.history.length);
  ok('④ 上下文记下了我的回复', view.history.some(t => t.from === 'me'), view.history.slice(-3));

  // ⑤ 再来一轮：演练不记账，所以还是会命中；但库里绝不能多出条目
  const mark2 = logCount();
  await ar.handle({ ...evt, message_id: evt.message_id + 1, time: Math.floor(Date.now() / 1000) });
  const logs2 = readLog(mark2);
  ok('⑤ 第二轮仍能命中（dry 不消耗提醒次数）', logs2.some(l => l.event === 'promise-hit'), logs2.filter(l => l.event === 'promise-hit'));
  ok('⑤ 两轮之后库里仍只有一条', promises.list(KEY).length === 1, promises.list(KEY).map(x => x.text));

  // 清理隔离目录
  for (const d of [process.env.QQCTX_DIR, process.env.QQMIND_DIR, process.env.QQTRACE_DIR, process.env.QQPROMISE_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
