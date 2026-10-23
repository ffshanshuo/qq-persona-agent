'use strict';
/**
 * test-merge-live.js —— 真模型抽样：连发合并 + 引用消息（dry 不真发）
 *
 * 用真实 NapCat 历史里的一条消息当「被引用的那条」，验证：
 *   1) 引用内容确实被取回并进了 note
 *   2) 连发 3 条只思考一次、只回一条
 *   3) 回复过了人话自检（没有英文残留/不是助手口气）
 *
 * 目录全部隔离；不写生产上下文、不发消息。
 * 运行：node scripts/test-merge-live.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'autoreply-merge-live.log');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = LOG;
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.merge-test.json');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-merge-live');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-merge-live');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-merge-live');

process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-merge-live');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-merge-live');

const { call } = require('./qq.js');
const ar = require('./auto-reply.js');
const say = require('./say.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra != null ? '  ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try { fs.unlinkSync(LOG); } catch (e) { }
const logLines = () => {
  try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
};
async function waitFor(pred, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(400);
  }
  return pred();
}

(async () => {
  const uid = 100000001;

  // 从真实历史里挑一条有文字的消息，当「被引用」的原文
  let quoted = null;
  try {
    const h = await call('get_friend_msg_history', { user_id: uid, count: 40 });
    const msgs = (h && h.data && h.data.messages) || [];
    const txt = (m) => (Array.isArray(m.message) ? m.message.filter(s => s.type === 'text').map(s => (s.data && s.data.text) || '').join('') : '').trim();
    const pool = msgs.filter(m => txt(m).length >= 4);
    const pick = pool.slice().reverse().find(m => String(m.user_id) !== '123456789') || pool.slice(-1)[0];
    if (pick) quoted = { id: String(pick.message_id), text: txt(pick), from: String(pick.user_id) === '123456789' ? 'me' : 'them' };
  } catch (e) { console.log('（取历史失败：' + String(e.message).slice(0, 80) + '）'); }
  if (!quoted) { console.log('历史里没有可用文本，改用直接调用 get_msg 验证'); }
  if (quoted) console.log('被引用的那条（' + quoted.from + '）：' + quoted.text.slice(0, 50));
  ok('取到一条真实历史消息当引用源', !!quoted, quoted);

  // ---- 场景一：引用消息 ----
  if (quoted) {
    const got = await ar.fetchQuote(quoted.id, 160);
    console.log('fetchQuote 取回：', String(got).slice(0, 50));
    ok('引用内容取回非空', !!got && got.length >= 2, got);

    await ar.handle({
      post_type: 'message', message_type: 'private', user_id: uid, self_id: 123456789,
      message_id: 9001, sender: { nickname: '好友A' },
      message: [{ type: 'reply', data: { id: quoted.id } }, { type: 'text', data: { text: '你说这事儿怎么办' } }]
    });
    await waitFor(() => logLines().some(x => x.event === 'dry-send' || x.event === 'skip'), 90000);
    const qNote = logLines().filter(x => x.event === 'quote').slice(-1)[0];
    const dryQuote = logLines().filter(x => x.event === 'dry-send').slice(-1)[0];
    ok('日志确认是引用', !!qNote, qNote);
    ok('引用回复非空', !!dryQuote && String(dryQuote.reply || '').length >= 2, dryQuote && dryQuote.reply);
    ok('引用回复没有英文残留', dryQuote && !/[A-Za-z]{3,}/.test(String(dryQuote.reply || '')), dryQuote && dryQuote.reply);
    console.log('  引用场景回复：', dryQuote && dryQuote.reply);
  }

  // ---- 场景二：连发三条（一件事） ----
  const first = logLines().length;
  const mk = (text, id) => ({
    post_type: 'message', message_type: 'private', user_id: uid, self_id: 123456789,
    message_id: id, sender: { nickname: '好友A' }, message: [{ type: 'text', data: { text } }]
  });
  ar.dispatch(mk('我今天考完试了', 9002));
  await sleep(120);
  ar.dispatch(mk('感觉考得一般', 9003));
  await sleep(120);
  ar.dispatch(mk('不过总算结束了', 9004));
  await waitFor(() => logLines().slice(first).some(x => x.event === 'dry-send' || x.event === 'skip'), 90000);
  const tail = logLines().slice(first);
  const merges = tail.filter(x => x.event === 'merge');
  const drys = tail.filter(x => x.event === 'dry-send');
  const thoughts = tail.filter(x => x.event === 'thought');
  ok('三条合并成一次', merges.length === 1 && merges[0].n === 3, merges);
  ok('只思考一次', thoughts.length === 1, thoughts.length);
  ok('只发一条回复', drys.length === 1, drys.length);
  const mergedReply = drys[0] && drys[0].reply;
  console.log('  连发场景回复：', mergedReply);
  ok('回复是人话（过自检）', mergedReply && say.inspect(mergedReply).issues.length === 0, mergedReply && say.inspect(mergedReply).issues);
  ok('没有英文残留', mergedReply && !/[A-Za-z]{3,}/.test(String(mergedReply || '')), mergedReply);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('演练崩了:', e); process.exit(1); });
