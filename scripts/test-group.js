/**
 * test-group.js —— 群聊在场感（group.js）自检
 * 全离线：判断规则 + 落盘 + 与 decide/handle 的接线（不真发）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-group-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-group-test';
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-group-test.log');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-group-test');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-group-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-group-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-group-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-group-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-group-test');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-group-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-group-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-group-test');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-group-' + process.pid + '.json';
fs.rmSync(process.env.QQGROUP_DIR, { recursive: true, force: true });
try { fs.rmSync(process.env.AUTOREPLY_LOG, { force: true }); } catch (e) { /* ignore */ }

const group = require('./group.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const GID = '200000001';
const SELF = '123456789';
const now = Date.UTC(2026, 9, 23, 12, 0, 0);
const cfg = { ...group.DEFAULTS, probability: 1, maxPerHour: 2, myCooldownMin: 10, hotCount: 12, pairMinTurns: 4 };

function seed(msgs, extra = {}) {
  fs.rmSync(group.fileOf(GID), { force: true });
  for (const m of msgs) group.observe(GID, { ...m, now: m.now || now, selfId: SELF });
  if (extra.myLastAt || extra.chimes) {
    const st = group.load(GID);
    if (extra.myLastAt) st.myLastAt = extra.myLastAt;
    if (extra.chimes) st.chimes = extra.chimes;
    group.save(st);
  }
}

// ── 1) 被 @ 一律该回
seed([{ uin: '10001', nick: 'A', text: '今天天气不错' }]);
ok('被 @ 时一定该回', group.shouldChime(GID, { atMe: true, text: '在吗', selfId: SELF }, cfg).reason === 'at-me');

// ── 2) 没有任何触发点 → 不插
ok('普通闲聊不插话', group.shouldChime(GID, { text: '今天天气不错', nick: 'A', uin: '10001', selfId: SELF, now }, cfg).reason === 'no-cue');

// ── 3) 有人在群里问事 → 可以插
seed([{ uin: '10001', nick: 'A', text: '有没有人知道这个怎么弄' }, { uin: '10002', nick: 'B', text: '我也在等答案' }]);
const q = group.shouldChime(GID, { text: '有没有人知道这个怎么弄', nick: 'A', uin: '10001', selfId: SELF, now }, cfg);
ok('群里问事 → 该插', q.ok && q.reason === 'group-question', q);
ok('插话理由里点明是群聊和说话者', /群聊/.test(q.note || '') && /A/.test(q.note || ''), q.note);
ok('群里不止两人时提醒别聊成私聊', /不止你们两个/.test(q.note || ''), q.note);

// ── 4) 提到我的名字 → called
seed([{ uin: '10001', nick: 'A', text: '我的昵称今天怎么没上线' }]);
const c = group.shouldChime(GID, { text: '我的昵称今天怎么没上线', nick: 'A', uin: '10001', selfId: SELF, now }, cfg);
ok('提到昵称 → called', c.ok && c.reason === 'called', c);
ok('called 的理由里说可以接一句', /提到了你/.test(c.note || ''), c.note);

// ── 5) 我刚说过话 → 冷却
seed([{ uin: '10001', nick: 'A', text: '有人吗' }], { myLastAt: now - 60e3 });
ok('刚说过话不接话', group.shouldChime(GID, { text: '有人吗', nick: 'A', uin: '10001', selfId: SELF, now }, cfg).reason === 'my-cooldown');
ok('冷却过了就能接', group.shouldChime(GID, { text: '有人吗', nick: 'A', uin: '10001', selfId: SELF, now: now + 11 * 60e3 }, cfg).ok);

// ── 6) 每小时上限
seed([{ uin: '10001', nick: 'A', text: '有人吗' }], { chimes: [now - 20 * 60e3, now - 40 * 60e3] });
ok('一小时两次后不再插', group.shouldChime(GID, { text: '有人吗', nick: 'A', uin: '10001', selfId: SELF, now }, cfg).reason === 'chime-hourly-cap');

// ── 7) 两个人在你来我往 → 不插
seed(Array.from({ length: 7 }, (_, i) => ({ uin: String(10001 + (i % 2)), nick: i % 2 ? 'B' : 'A', text: i % 2 ? '嗯嗯' : '在干嘛' })).concat([{ uin: '10001', nick: 'A', text: '没事我随便看看' }]));
ok('两人正在聊不插话', group.shouldChime(GID, { text: '没事我随便看看', nick: 'A', uin: '10001', selfId: SELF, now }, cfg).reason === 'pair-talking');

// ── 7b) 两人在聊，但最后一句是在问全群 → 可以插
seed(Array.from({ length: 6 }, (_, i) => ({ uin: String(10001 + (i % 2)), nick: i % 2 ? 'B' : 'A', text: i % 2 ? '嗯嗯' : '有人吗' })).concat([{ uin: '10002', nick: 'B', text: '有没有人知道怎么坐车过去' }]));
ok('两人聊着但向全群求助时可以插', group.shouldChime(GID, { text: '有没有人知道怎么坐车过去', nick: 'B', uin: '10002', selfId: SELF, now }, cfg).ok);

// ── 8) 刷屏 → 不插
seed(Array.from({ length: 13 }, (_, i) => ({ uin: String(10010 + i), nick: 'M' + i, text: '哈哈哈' })));
ok('刷屏时不插话', group.shouldChime(GID, { text: '有没有人知道', nick: 'M0', uin: '10010', selfId: SELF, now }, { ...cfg, pairMinTurns: 99 }).reason === 'too-hot');

// ── 9) 随机门槛
seed([{ uin: '10001', nick: 'A', text: '有人吗' }]);
ok('骰子没中就不插', group.shouldChime(GID, { text: '有人吗', nick: 'A', uin: '10001', selfId: SELF, now }, { ...cfg, probability: 0 }).reason === 'dice');

// ── 10) 开关
ok('开关关闭时不插话', group.shouldChime(GID, { text: '有人吗', selfId: SELF, now }, { ...cfg, enabled: false }).reason === 'group-chime-disabled');

// ── 11) markSpoke / observe 落盘
seed([{ uin: '10001', nick: 'A', text: '有人吗' }]);
group.markSpoke(GID, now);
const st = group.load(GID);
ok('markSpoke 记下我说话时间', st.myLastAt === now);
ok('markSpoke 计入插话次数', st.chimes.includes(now));
ok('消息落盘且有昵称', st.msgs.length === 1 && st.msgs[0].nick === 'A');
ok('list 能读回来', group.list(GID).msgs === 1);

// ── 12) keepMessages 截断
fs.rmSync(group.fileOf(GID), { force: true });
for (let i = 0; i < 70; i++) group.observe(GID, { uin: '10001', nick: 'A', text: 'm' + i, now: now + i });
ok('消息数按上限截断', group.load(GID).msgs.length <= 60, group.load(GID).msgs.length);

// ── 13) 坏文件自愈
fs.writeFileSync(group.fileOf(GID), '{坏的 json');
const bad = group.load(GID);
ok('坏文件返回空账本', bad.msgs.length === 0);
ok('坏文件被改名成 .bad-*', fs.readdirSync(process.env.QQGROUP_DIR).some(f => f.includes('.bad-')));

// ── 14) 与 decide 的接线：群聊问句 → chime，普通闲聊 → skip
group.configure({ ...cfg, probability: 1 });
const ar = require('./auto-reply.js');
const evtOf = (text, withAt) => ({
  post_type: 'message', message_type: 'group', self_id: 123456789, group_id: 200000001,
  user_id: 10001, time: Math.floor(now / 1000), message_id: 7000 + text.length,
  raw_message: text,
  message: withAt
    ? [{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' ' + text } }]
    : [{ type: 'text', data: { text } }],
  sender: { user_id: 10001, nickname: 'A', card: 'A' }
});
const d1 = ar.decide(evtOf('有没有人知道这个怎么弄', false));
ok('decide：群聊问句 → reply 且标记 chime', d1.action === 'reply' && d1.chime === true, d1 && d1.reason);
ok('decide：插话不带 @', d1.noAt === true);
ok('decide：插话理由进入 note 来源', /群聊/.test(d1.chimeNote || ''), d1.chimeNote);
const d2 = ar.decide(evtOf('今天天气不错', false));
ok('decide：普通闲聊 → skip', d2.action === 'skip', d2.reason);
const d3 = ar.decide(evtOf('在吗', true));
ok('decide：被 @ → reply 且不算 chime', d3.action === 'reply' && !d3.chime);
group.configure({});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
