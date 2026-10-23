#!/usr/bin/env node
/**
 * 离线补账专项测试（真实 NapCat 历史，只 dry 不真发）。
 *
 * 场景：进程停了几个小时，期间对方发了几条 —— 这些消息没有 WS 事件，本地上下文里没有。
 * 做法：从真实历史里取「最后一条对方消息」当断点，造一个只到断点前的上下文，然后喂一条新消息进来，
 * 看 catchupOnce 是否从 get_friend_msg_history 里把中间那几条捞回来、并且告诉大脑。
 *
 * 用法：node scripts/test-offline.js
 * 依赖：NapCat 在线（HTTP 127.0.0.1:3000）、config/autoreply.offline-test.json
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 测试上下文写独立目录，别污染生产会话（logs/context/）
process.env.QQCTX_DIR = process.env.QQCTX_DIR || path.join(ROOT, 'logs', 'context-test');
process.env.AUTOREPLY_CONFIG = process.env.AUTOREPLY_CONFIG || 'config/autoreply.offline-test.json';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'offline-test.log');
process.env.AUTOREPLY_STATE = path.join(ROOT, 'logs', 'offline-test-state.json');
process.env.AUTOREPLY_DRY = '1';
try { fs.unlinkSync(process.env.AUTOREPLY_LOG); } catch (e) { /* 没有就算了 */ }
try { fs.unlinkSync(process.env.AUTOREPLY_STATE); } catch (e) { /* 同上 */ }

const ctx = require('./context.js');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, process.env.AUTOREPLY_CONFIG), 'utf8'));
const SELF = cfg.selfId || 123456789;
const PEER = (cfg.private && cfg.private.allowList && cfg.private.allowList[0]) || 100000001;
const KEY = `p:${PEER}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('ok  - ' + name); }
  else { fail++; console.log('FAIL - ' + name, extra ? JSON.stringify(extra).slice(0, 400) : ''); }
};

(async () => {
  ctx.configure({ ...(cfg.context || {}), summarize: false });

  // 断点不能写死成「6 小时前」——对话静了几天，最近 6 小时可能一条对方消息都没有。
  // 改成从真实历史里找：以「最后一条对方消息」为分界，本地只留到它前面一刻，
  // 这样「离线期间 TA 说过几句」是客观存在的，测试不再随时间漂移。
  const { call } = require('./qq.js');
  const hist = await call('get_friend_msg_history', { user_id: PEER, count: 20 });
  const msgs = ((hist && hist.data && hist.data.messages) || []).slice();
  const theirs = msgs.filter(m => m.user_id !== SELF);
  if (!theirs.length) { console.error('这个好友没有任何对方消息，没法测离线补账'); process.exit(1); }
  const lastTheirs = theirs[theirs.length - 1];
  const cutoff = lastTheirs.time * 1000 - 1;                       // 断点：最后一条对方消息之前
  const expectMissed = msgs.filter(m => m.time * 1000 > cutoff && m.user_id !== SELF).length;

  ctx.save({ key: KEY, kind: 'private', peer: { uin: PEER, nick: '好友A' }, updatedAt: 0, sessionStartedAt: 0,
    turns: [{ t: cutoff, from: 'me', speaker: '', text: '（断点前我说的最后一句）' }],
    summary: '', summaryAt: 0, facts: [], dropped: 0 });

  const ar = require('./auto-reply.js');
  const evt = {
    post_type: 'message', message_type: 'private', user_id: PEER, self_id: SELF,
    time: Math.floor(Date.now() / 1000), message_id: 950001,
    message: [{ type: 'text', data: { text: '在吗？刚给你发了几条' } }], raw_message: '在吗？刚给你发了几条',
    sender: { nickname: '好友A' }
  };
  await ar.handle(evt);

  const log = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  const lines = log.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const catchup = lines.find(l => l.event === 'catchup');
  const missed = lines.find(l => l.event === 'offline-missed');
  const c = ctx.load(KEY);

  ok('catchup 发生了', !!catchup, catchup);
  ok('catchup 捞回了离线期间的对方消息（missed 与历史一致）', !!catchup && catchup.missed === expectMissed, { got: catchup && catchup.missed, expect: expectMissed });
  ok('打了 offline-missed 事件', !!missed, missed);
  ok('离线消息已进上下文（条数 > 1）', c.turns.length > 1, { n: c.turns.length });
  ok('上下文按时间有序', c.turns.every((t, i) => i === 0 || c.turns[i - 1].t <= t.t));
  ok('大脑被叫过（thought 或 dry-send 有记录）', lines.some(l => l.event === 'thought' || l.event === 'dry-send'));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (catchup) console.log('catchup:', JSON.stringify(catchup));
  if (missed) console.log('offline-missed:', JSON.stringify(missed));
  const text = lines.find(l => l.event === 'thought');
  if (text) console.log('thought.reply:', text.reply);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩了:', e && e.message); process.exit(1); });
