/**
 * test-follow.js —— 群聊「@ 之后的对话跟随」自检
 * 全离线：判定规则 + 会话生命周期 + 与 decide 的接线（不真发）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
process.env.AUTOREPLY_DRY = '1';
process.env.QQMODE_DIR = __dirname + '/../logs/mode-follow-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-follow-test';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-follow-test.log');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-follow-test');
process.env.QQFOLLOW_DIR = path.join(ROOT, 'logs', 'follow-follow-test');
process.env.QQNICK_DIR = path.join(ROOT, 'logs', 'nick-follow-test');
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-follow-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-follow-test');
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-follow-test');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-follow-test');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-follow-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-follow-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-follow-test');
process.env.QQTHEM_DIR = path.join(ROOT, 'logs', 'them-follow-test');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-follow-' + process.pid + '.json';
for (const k of ['QQGROUP_DIR', 'QQFOLLOW_DIR', 'QQNICK_DIR', 'QQMIND_DIR', 'QQECHO_DIR', 'QQCTX_DIR', 'QQTRACE_DIR', 'QQPROMISE_DIR', 'QQBOND_DIR', 'QQTHEM_DIR']) {
  fs.rmSync(process.env[k], { recursive: true, force: true });
}
try { fs.rmSync(process.env.AUTOREPLY_LOG, { force: true }); } catch (e) { /* ignore */ }

const follow = require('./follow.js');
const group = require('./group.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const GID = '200000001';
const UIN = '10001';
const SELF = '123456789';
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
const NAMES = ['我的昵称', 'DSH'];

// ── 1) 名字命中
ok('名字命中 我的昵称', follow.nameHit('我的昵称 你在吗', NAMES) === '我的昵称');
ok('名字命中 DSH', follow.nameHit('问下 DSH 这个怎么弄', NAMES) === 'DSH');
ok('没提到名字 → null', follow.nameHit('今天群里有人吗', NAMES) === null);
ok('空文本 → null', follow.nameHit('', NAMES) === null);

// ── 2) 会话生命周期
fs.rmSync(follow.fileOf(GID, UIN), { force: true });
ok('没 @ 过 → 没会话', follow.active(GID, UIN, { now: T0 }) === null);
follow.open(GID, UIN, { now: T0, nick: '小A' });
const s1 = follow.active(GID, UIN, { now: T0 + 60e3 });
ok('被 @ 后开窗', !!s1 && s1.nick === '小A');
ok('窗口 8 分钟后过期', follow.active(GID, UIN, { now: T0 + 9 * 60e3 }) === null);
follow.open(GID, UIN, { now: T0, nick: '小A' });
follow.touch(GID, UIN, { now: T0 + 5 * 60e3 });
ok('回一句后续窗（原窗口 8 分钟已过，续到 +5 分钟）', follow.active(GID, UIN, { now: T0 + 8 * 60e3 }) !== null);
ok('续窗也有尽头（+6 分钟就过期）', follow.active(GID, UIN, { now: T0 + 11 * 60e3 }) === null);
ok('续窗后轮次 +1', follow.load(GID, UIN).turns === 1);
fs.rmSync(follow.fileOf(GID, UIN), { force: true });
follow.open(GID, UIN, { now: T0, nick: '小A' });
follow.miss(GID, UIN, { now: T0 + 30e3 });
ok('第一次 miss 不关窗', !!follow.active(GID, UIN, { now: T0 + 40e3 }));
const m2 = follow.miss(GID, UIN, { now: T0 + 50e3 });
ok('连续两次 miss 关窗', m2.closed === true && follow.active(GID, UIN, { now: T0 + 60e3 }) === null);

// ── 3) judge 打分
const base = { session: { turns: 1, nick: '小A' }, names: NAMES };
const j1 = follow.judge({ ...base, text: '你上次说的那个怎么弄，能再说下吗', lastMine: '那个插件要先装依赖再起服务' });
ok('接着跟我说 → 要回', j1.reply === true, j1);
ok('第二人称加分', j1.why.includes('second-person'));
const j2 = follow.judge({ ...base, text: '我问你一下，那个依赖怎么装', lastMine: '' });
ok('问句+第二人称 → 要回', j2.reply === true, j2);
const j3 = follow.judge({ ...base, text: '@别人 你俩别吵了，今天天气不错', othersAt: ['10002'], lastMine: '' });
ok('@ 了别人 → 不回', j3.reply === false, j3);
ok('@ 别人扣分被记录', j3.why.includes('at-others'));
const j4 = follow.judge({ ...base, text: '嗯' });
ok('太短 → 不回', j4.reply === false && j4.why.includes('too-short'));
const j5 = follow.judge({ ...base, text: '我的昵称 这个你懂吧' });
ok('点了我的名字 + 第二人称 → 要回', j5.reply === true, j5);
ok('名字命中进 why', j5.why.some(w => w.startsWith('call-name')));
const j6 = follow.judge({ ...base, text: '[表情]', session: { turns: 1 } });
ok('纯表情 → 不回', j6.reply === false);
const j7 = follow.judge({ ...base, text: '你们俩那个事弄完了吗', session: { turns: 1 } });
ok('对着别人说（你俩）→ 不回', j7.reply === false, j7);
const aged = follow.judge({ ...base, text: '那个事怎么样了', session: { turns: 10 } });
const fresh = follow.judge({ ...base, text: '那个事怎么样了', session: { turns: 1 } });
ok('跟了很多轮后降权（分数更低）', aged.score < fresh.score, { aged: aged.score, fresh: fresh.score });
const noteJ = follow.judge({ ...base, text: '你这个还在吗' });
ok('要回时给 brain 的 note 提到群聊/没 @', /群聊/.test(noteJ.note) && /@/.test(noteJ.note), noteJ.note);

// ── 4) 与 decide 的接线
group.configure({ ...group.DEFAULTS, probability: 0, myCooldownMin: 0, maxPerHour: 99 });
const ar = require('./auto-reply.js');
fs.rmSync(follow.fileOf(GID, UIN), { force: true });
const evt = (text, withAt) => ({
  post_type: 'message', message_type: 'group', self_id: Number(SELF), group_id: Number(GID),
  user_id: Number(UIN), time: Math.floor(T0 / 1000), message_id: Math.floor(T0 / 1000) + text.length,
  raw_message: text,
  message: withAt
    ? [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' ' + text } }]
    : [{ type: 'text', data: { text } }],
  sender: { user_id: Number(UIN), nickname: '小A', card: '小A' }
});

const d0 = ar.decide(evt('问你个事', true));
ok('被 @ → 回（带 @ 正常回）', d0.action === 'reply' && !d0.chime, d0);
ok('被 @ 后开出跟随会话', !!follow.active(GID, UIN));

const d1 = ar.decide(evt('你上次说的那个插件怎么装，能再讲下吗', false));
ok('@ 之后不 @ 也接着回', d1.action === 'reply', d1);
ok('跟随回复标记 follow', d1.follow === true && d1.chime === true, { follow: d1.follow, chime: d1.chime });
ok('跟随回复不硬 @ 回去', d1.noAt === true);

const d2 = ar.decide(evt('问下 DSH 这个你懂不懂', false));
ok('没 @ 但点了我的名字 → 也判断要不要回', d2.action === 'reply', d2);

const d3 = ar.decide(evt('今天天气不错', false));
ok('完全无关的话 → 不回', d3.action === 'skip', d3.reason);
const d4 = ar.decide(evt('这边新开了一家店', false));
ok('连续无关 → 仍不回', d4.action === 'skip', d4.reason);
ok('无关两条后会话被关掉', follow.active(GID, UIN) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
