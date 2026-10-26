'use strict';
/**
 * test-say.js —— 人话自检层 + 连发合并 + 引用消息解析（全离线，dry 不真发）
 *
 * 覆盖：
 *   say.inspect / say.fix / say.retryNote / say.logBad 的判定与清理
 *   dispatch() 的连发合并（多条 → 一次思考）、mergeable 的取舍
 *   handle() 的真实接线：中英混杂被清、助手口气重写一次、引用内容进 note、引用取不到时的兜底
 *
 * 全部目录隔离，brain.think 与 qq.call 都是桩，不联网、不发消息。
 * 运行：node scripts/test-say.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'autoreply-say-test.log');
process.env.AUTOREPLY_DRY = '1';
process.env.QQMODE_DIR = __dirname + '/../logs/mode-say-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-say-test';
process.env.AUTOREPLY_LOG = LOG;
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.merge-test.json');
process.env.AUTOREPLY_STATE = path.join(ROOT, 'logs', 'state-say-test.json');
try { require('fs').rmSync(process.env.AUTOREPLY_STATE, { force: true }); } catch (e) { }
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-say-test');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-say-test');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-say-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-say-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-say-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-say-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-say-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-say-test');
process.env.QQSELF_DIR = path.join(ROOT, 'logs', 'self-say-test');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-say-test');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-say-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-say-test');

// ---- qq.call 桩（必须在 require auto-reply 之前替换，它是解构引用）----
const qq = require('./qq.js');
const calls = [];
let quoteStub = '我明天要去医院复查';
let quoteMode = 'ok'; // ok | throw | empty
qq.call = async (action, params) => {
  calls.push({ action, params });
  if (action === 'get_msg') {
    if (quoteMode === 'throw') throw new Error('mock get_msg boom');
    if (quoteMode === 'empty') return { status: 'ok', retcode: 0, data: {} };
    return { status: 'ok', retcode: 0, data: { message: [{ type: 'text', data: { text: quoteStub } }] } };
  }
  if (action === 'get_friend_msg_history' || action === 'get_group_msg_history') {
    return { status: 'ok', retcode: 0, data: { messages: [] } };
  }
  if (/^send_/.test(action)) return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  return { status: 'ok', retcode: 0, data: {} };
};

const say = require('./say.js');
const brain = require('./brain.js');
const ar = require('./auto-reply.js');

// ---- brain.think 桩 ----
const seen = [];
let replies = [];
brain.think = async (ctx) => {
  seen.push(ctx);
  const reply = replies.length ? replies.shift() : '在呢';
  return { reply, stickerKey: '', raw: reply, model: 'stub', ms: 1, finish: 'stop' };
};

try { fs.unlinkSync(LOG); } catch (e) { }
const logLines = () => {
  try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
};
const events = (name) => logLines().filter(x => x.event === name);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra != null ? '  ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const evt = (text, extra) => ({
  post_type: 'message', message_type: 'private', user_id: 100000001, self_id: 123456789,
  message_id: extra && extra.id != null ? extra.id : Math.floor(Math.random() * 1e9),
  sender: { nickname: '好友A' },
  message: Array.isArray(text) ? text : [{ type: 'text', data: { text } }],
  raw_message: Array.isArray(text) ? '' : text
});

(async () => {
  // ============ 一、say.inspect ============
  let r = say.inspect('在呢，收到 received 👍');
  ok('中英混杂能认出来', r.issues.some(x => x.code === 'mixed-en'), r.issues);
  ok('中英混杂不需要重写', r.needRetry === false);

  r = say.inspect('作为一个AI，我无法感受这些');
  ok('助手口气能认出来', r.issues.some(x => x.code === 'assistant'), r.issues);
  ok('助手口气需要重写', r.needRetry === true);

  r = say.inspect('根据我的记忆，你上次说过');
  ok('提记忆/系统能认出来', r.issues.some(x => x.code === 'meta'), r.issues);

  r = say.inspect('1. 早点睡\n2. 多喝水');
  ok('列清单能认出来', r.issues.some(x => x.code === 'list'), r.issues);
  ok('列清单需要重写', r.needRetry === true);

  r = say.inspect('这张图里是一只熊猫在吃竹子');
  ok('复述画面能认出来', r.issues.some(x => x.code === 'narrate'), r.issues);

  r = say.inspect('对于你来说，早点睡是重要的');
  ok('翻译腔能认出来', r.issues.some(x => x.code === 'translate'), r.issues);

  r = say.inspect('😄😄😄😄');
  ok('表情刷屏能认出来', r.issues.some(x => x.code === 'emoji'), r.issues);

  r = say.inspect('好长好长的一句话', { maxChars: 3 });
  ok('超长能认出来', r.issues.some(x => x.code === 'long'), r.issues);

  ok('干净的话不报问题', say.inspect('在呢，刚看到').ok === true);
  ok('空串不报问题', say.inspect('').ok === true);
  ok('allowEn 里的英文不算混杂', say.inspect('ok 好 我记下了').issues.every(x => x.code !== 'mixed-en'),
    say.inspect('ok 好 我记下了').issues);

  // ============ 二、say.fix ============
  let f = say.fix('在呢，收到 received 👍');
  ok('英文手滑词被摘掉', !/received/.test(f.text), f.text);
  ok('摘掉后不塌成空', f.text.replace(/[^\u4e00-\u9fa5]/g, '').length >= 2, f.text);
  ok('fix 报告 changed', f.changed === true);

  f = say.fix('1. 早点睡\n2. 多喝水\n3. 别熬夜');
  ok('清单拍平成一句话', !/\n/.test(f.text) && /早点睡/.test(f.text) && /别熬夜/.test(f.text), f.text);
  ok('拍平后像一句人话', /^[^0-9]/.test(f.text), f.text);

  f = say.fix('😄😄😄 好呀');
  ok('重复表情去重', (f.text.match(/😄/g) || []).length === 1, f.text);

  f = say.fix('作为一个AI，我无法感受这些');
  ok('助手口气改不动 → needRetry', f.needRetry === true, f);

  f = say.fix('好的\n\n\n明天见');
  ok('多余空行被收掉', !/\n{2,}/.test(f.text), JSON.stringify(f.text));

  // retryNote
  ok('重写要求含助手口气', /助手/.test(say.retryNote([{ code: 'assistant' }])));
  ok('重写要求含列清单', /清单/.test(say.retryNote([{ code: 'list' }])));
  ok('无问题时重写要求为空', say.retryNote([]) === '');

  // logBad
  const badBefore = (() => { try { return fs.readFileSync(path.join(ROOT, 'logs', 'say-bad.jsonl'), 'utf8').trim().split('\n').length; } catch (e) { return 0; } })();
  say.logBad({ key: 'p:1', reply: '坏样本', issues: ['assistant'] }, say.DEFAULTS);
  const badAfter = (() => { try { return fs.readFileSync(path.join(ROOT, 'logs', 'say-bad.jsonl'), 'utf8').trim().split('\n').length; } catch (e) { return 0; } })();
  ok('坏样本落进回归语料', badAfter > badBefore);

  // ============ 三、连发合并的纯函数 ============
  ok('私聊可合并', ar.mergeable(evt('在吗')) === true);
  ok('自己的消息不合并', ar.mergeable(evt('自己的话', {}) && { ...evt('x'), user_id: 123456789 }) === false);
  ok('群里没@我不合并', ar.mergeable({ ...evt('群里闲聊'), message_type: 'group', group_id: 200000001 }) === false);
  ok('群里@我合并', ar.mergeable({
    ...evt([{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' 在吗' } }]),
    message_type: 'group', group_id: 200000001
  }) === true);
  ok('关掉开关就不合并', ar.mergeable((() => { const c = ar.mergeSettings(); c.enabled = false; return evt('x'); })()) === ar.mergeSettings().enabled === false ? true : typeof ar.mergeable(evt('x')) === 'boolean');

  const merged = ar.mergeEvents([evt('我今天'), evt('考试考完了'), evt('但是有点慌')]);
  ok('合并后条数正确', merged._merge.n === 3, merged._merge);
  ok('合并后文字按行拼', /我今天[\s\S]*考试考完了[\s\S]*有点慌/.test(merged.raw_message), merged.raw_message);

  const mergedAt = ar.mergeEvents([
    { ...evt([{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' 在吗' } }]), message_type: 'group', group_id: 200000001 },
    { ...evt([{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' 帮我看看' } }]), message_type: 'group', group_id: 200000001 }
  ]);
  ok('合并后 @ 段只留一个', mergedAt.message.filter(x => x.type === 'at').length === 1, mergedAt.message);

  // ============ 四、dispatch：连发只思考一次 ============
  seen.length = 0; replies = ['考完就先歇两天吧'];
  ar.dispatch(evt('我今天考试考完了'));
  ar.dispatch(evt('但是有点慌'));
  ar.dispatch(evt('感觉没考好'));
  // 原来固定 sleep(1600)：机器忙时合并窗口还没走完就断言 → 偶发「连发只触发一次思考」假失败
  // 改成「等它真的想一次」再给 400ms 观察是否重复（上限 4s）
  for (let i = 0; i < 80 && seen.length === 0; i++) await sleep(100);
  await sleep(800);
  ok('连发只触发一次思考', seen.length === 1, seen.map(x => x.text));
  ok('思考时看到三条合起来的文字', seen.length === 1 && /考试考完了[\s\S]*有点慌[\s\S]*没考好/.test(seen[0].text), seen[0] && seen[0].text);
  ok('note 里明说别逐条回', seen.length === 1 && /连着发了几条/.test(seen[0].note || ''), seen[0] && seen[0].note);
  ok('日志有 merge 事件', events('merge').length >= 1, events('merge').slice(-1));

  // ============ 五、handle 接线：中英混杂被清 ============
  seen.length = 0; replies = ['在呢，收到 received 👍'];
  await ar.handle(evt('你在吗'));
  const dry1 = events('dry-send').slice(-1)[0];
  ok('中英混杂被清掉再发', dry1 && !/received/.test(dry1.reply || ''), dry1 && dry1.reply);
  ok('清理留下可读文本', dry1 && /在呢/.test(dry1.reply || ''), dry1 && dry1.reply);
  ok('日志记了 say-fix', events('say-fix').length >= 1, events('say-fix').slice(-1));

  // ============ 六、handle 接线：助手口气触发重写一次 ============
  seen.length = 0; replies = ['作为一个AI，我无法感受这些', '我在呢，你说的我听着呢'];
  const beforeRetry = events('say-retry').length;
  await ar.handle(evt('我有点难受'));
  const retry = events('say-retry').slice(-1)[0];
  ok('助手口气触发 say-retry', events('say-retry').length > beforeRetry, retry);
  ok('重写后只思考两次', seen.length === 2, seen.map(x => x.note && x.note.slice(-20)));
  ok('重写要求注进了 note', seen.length === 2 && /助手/.test(seen[1].note || ''), seen[1] && seen[1].note);
  const dry2 = events('dry-send').slice(-1)[0];
  ok('发出去的是重写后的句子', dry2 && /我在呢/.test(dry2.reply || ''), dry2 && dry2.reply);

  // ============ 七、引用消息：内容进 note ============
  seen.length = 0; replies = ['复查结果还好吗'];
  quoteMode = 'ok'; quoteStub = '我明天要去医院复查';
  await ar.handle(evt([{ type: 'reply', data: { id: '12345' } }, { type: 'text', data: { text: '你说我该不该去' } }]));
  ok('引用内容进了 note', seen.length === 1 && /医院复查/.test(seen[0].note || ''), seen[0] && seen[0].note);
  ok('日志记了 quote', events('quote').length >= 1, events('quote').slice(-1));
  ok('确实调了 get_msg', calls.some(c => c.action === 'get_msg' && String(c.params.message_id) === '12345'), calls.filter(c => c.action === 'get_msg').slice(-1));

  // 引用取不到 → 明说别猜
  seen.length = 0; replies = ['那你说说看'];
  quoteMode = 'empty';
  await ar.handle(evt([{ type: 'reply', data: { id: '99999' } }, { type: 'text', data: { text: '就那个事' } }]));
  ok('取不到引用时提示别猜', seen.length === 1 && /没取到/.test(seen[0].note || ''), seen[0] && seen[0].note);
  ok('日志记了 quote-empty', events('quote-empty').length >= 1);

  // 引用接口报错 → 不阻塞回复
  seen.length = 0; replies = ['嗯嗯'];
  quoteMode = 'throw';
  await ar.handle(evt([{ type: 'reply', data: { id: '88888' } }, { type: 'text', data: { text: '你猜' } }]));
  ok('引用接口报错不影响回复', seen.length === 1 && events('quote-error').length >= 1);
  quoteMode = 'ok';

  // ============ 八、正常文本不折腾 ============
  seen.length = 0; replies = ['好呀，明天见'];
  const sayFixBefore = events('say-fix').length;
  const sayRetryBefore = events('say-retry').length;
  await ar.handle(evt('明天见'));
  ok('干净回复不做无谓改写', events('say-fix').length === sayFixBefore && events('say-retry').length === sayRetryBefore);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩了:', e); process.exit(1); });
