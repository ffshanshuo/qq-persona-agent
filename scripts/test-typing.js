'use strict';
/**
 * test-typing.js —— 「对方正在输入」会话管理（全离线）
 *
 * 背景与演进：
 *   v1（m03516 后）：把 push/pop 放在 sendOnce 里 —— 只覆盖「发送期」，
 *      同一个人隔 2s 再发一条时，上一轮排的 1.4s 熄灭正好落在下一轮的思考期里，
 *      手机上仍然会看到「灭 → 亮」跳一下（只读审查 A1 指出的就是这个）。
 *   v2（现在）：push/pop 上移到 handle()，从「决定要回」一直持有到「说完」，
 *      整段包含 1~10s 的思考时间；send() 只负责排队串行。
 *
 * 本测试用桩替换 qq.call / brain.think，只断言 set_input_status 的调用序列。
 * 运行：node scripts/test-typing.js
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-typing-test.log');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-typing-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-typing-test';
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.merge-test.json');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-typing-test');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-typing-test');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-typing-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-typing-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-typing-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-typing-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-typing-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-typing-test');
process.env.QQSELF_DIR = path.join(ROOT, 'logs', 'self-typing-test');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-typing-test');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-typing-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-typing-test');
process.env.QQPACING_DIR = path.join(ROOT, 'logs', 'pacing-typing-test');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-typing-' + process.pid + '.json';
delete process.env.AUTOREPLY_DRY;

const qq = require('./qq.js');
const events = [];
let sendCount = 0;
qq.call = async (action, params) => {
  if (action === 'set_input_status') {
    events.push({ t: Date.now(), action, uin: params && params.user_id, event: params && params.event_type });
    return { status: 'ok', retcode: 0 };
  }
  if (action === 'send_private_msg' || action === 'send_group_msg') {
    sendCount++;
    events.push({ t: Date.now(), action: 'send', uin: params && (params.user_id || params.group_id) });
    return { status: 'ok', retcode: 0, data: { message_id: 1000 + sendCount } };
  }
  if (action === 'get_msg') return { status: 'ok', retcode: 0, data: { message: [], raw_message: '' } };
  if (action === 'get_friend_msg_history' || action === 'get_group_msg_history') return { status: 'ok', retcode: 0, data: { messages: [] } };
  return { status: 'ok', retcode: 0, data: {} };
};

const brain = require('./brain.js');
brain.think = async () => ({ reply: '好', stickerKey: '', model: 'stub', ms: 120 });

const ar = require('./auto-reply.js');
const pacing = require('./pacing.js');
const realTypingMs = pacing.typingMs;
pacing.typingMs = () => 300;
pacing.switchMs = () => 250;

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   << ' + (extra || '')));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ons = () => events.filter(e => e.action === 'set_input_status' && e.event === 1);
const offs = () => events.filter(e => e.action === 'set_input_status' && e.event === 0);

function evt(text, uin = '100000001') {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 123456789,
    user_id: Number(uin),
    time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e9),
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(uin), nickname: '好友A' }
  };
}

(async () => {
  // ── ① 引用计数：两次 push 只亮一次，两次 pop 之后才灭一次 ──
  events.length = 0;
  await ar.typingPush('100000001');
  await ar.typingPush('100000001');
  ok('两次 push 只亮一次', ons().length === 1, 'on=' + ons().length);
  ar.typingPop('100000001');
  await sleep(1700);
  ok('还有引用时不灭', offs().length === 0, 'off=' + offs().length);
  ar.typingPop('100000001');
  await sleep(1700);
  ok('引用归零后灭一次', offs().length === 1, 'off=' + offs().length);
  ok('灭的时候只发过 1 次 on', ons().length === 1, 'on=' + ons().length);

  // ── ② 不同人各自开会话 ──
  events.length = 0;
  await ar.typingPush('100000001');
  await ar.typingPush('100000002');
  ok('两个人各亮一次（各自会话）', new Set(ons().map(e => e.uin)).size === 2, ons().map(e => e.uin).join(','));
  ar.typingPop('100000001');
  ar.typingPop('100000002');
  await sleep(1700);

  // ── ③ 群聊不挂输入提示（NapCat chatType 写死 C2C）──
  events.length = 0;
  const gk = ar.typingTargetOf({ key: 'g:200000001:u:100000001', target: { type: 'group', id: '200000001', at: '100000001' } });
  ok('群聊 typingTargetOf 返回 null', gk === null, String(gk));
  await ar.typingPush(gk);
  ok('群聊 push(null) 不发任何 set_input_status', events.filter(e => e.action === 'set_input_status').length === 0);

  // ── ④ 长打字期间每 4s 刷新一次 ──
  events.length = 0;
  await ar.typingPush('100000001');
  await sleep(8600);
  ok('长打字有刷新（>=2 次 on）', ons().length >= 2, 'ons=' + ons().length);
  ar.typingPop('100000001');
  await sleep(1700);
  ok('长打字结束后仍然只灭一次', offs().length === 1, 'offs=' + offs().length);

  // ── ⑤ handle() 端到端：从决定要回到发完，整段只亮一次 ──
  events.length = 0;
  pacing.typingMs = () => 300;
  await ar.handle(evt('在干嘛呢'));
  ok('handle 发了一条消息', sendCount >= 1, 'sendCount=' + sendCount);
  const onT = ons()[0] && ons()[0].t;
  const sendT = events.find(e => e.action === 'send') && events.find(e => e.action === 'send').t;
  ok('提示在发送之前就亮了（覆盖思考时间）', onT && sendT && onT < sendT, 'on=' + onT + ' send=' + sendT);
  await sleep(1700);
  ok('一轮对话只亮一次、只灭一次', ons().length === 1 && offs().length === 1, 'on=' + ons().length + ' off=' + offs().length);

  // ── ⑥ 同一个人连发两条（隔 1.5s）：跨两轮思考仍只有一次 on ──
  events.length = 0;
  const h1 = ar.handle(evt('今天好累'));
  await sleep(1500);
  const h2 = ar.handle(evt('作业写到十二点'));
  await Promise.all([h1, h2]);
  ok('连发两条只亮一次（v2 的关键修复）', ons().length === 1, 'on=' + ons().length);
  await sleep(1700);
  ok('两条都发完后只灭一次', offs().length === 1, 'off=' + offs().length);

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('FATAL', (e && e.stack) || e);
  process.exit(1);
});
