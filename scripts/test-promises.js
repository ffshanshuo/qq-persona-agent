'use strict';
/**
 * test-promises.js —— 承诺层 + 拟人化（打字/拆条）的自检，全离线（不碰网络/模型）。
 * 目录隔离：QQPROMISE_DIR=logs/promises-test，避免写脏生产。
 * 运行：node scripts/test-promises.js
 */
process.env.QQPROMISE_DIR = process.env.QQPROMISE_DIR || require('path').join(__dirname, '..', 'logs', 'promises-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-promises-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-promises-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-promises-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

const fs = require('fs');
const path = require('path');
const promises = require('./promises.js');
const ar = require('./auto-reply.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra != null ? '  ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }

const K = 'p:100000001';

// 清干净
try { fs.rmSync(promises.DIR, { recursive: true, force: true }); } catch (e) { }
promises.configure({ enabled: true, remindCooldownHours: 6, maxReminders: 2, staleDays: 30 });
ar.promiseSettings(); // 让 auto-reply 也读到同一份默认

// ① 抽取：我许的承诺会被记下
let added = promises.capture(K, { myText: '考完试我陪你去海边，说好了。' });
ok('① 承诺被抽到', added.length === 1 && /海边/.test(added[0].text), added);
eq('① 类型 promise', added[0].kind, 'promise');
eq('① due 识别', added[0].due, '考完试');

// ② 对方说的话不会被当承诺
eq('② 对方的话不算承诺', promises.capture(K, { myText: '我今天好累啊，你呢？' }).length, 0);

// ③ 重复承诺去重
eq('③ 同一句不重复入库', promises.capture(K, { myText: '考完试我陪你去海边，说好了。' }).length, 0);
eq('③ 库里仍 1 条', promises.list(K).length, 1);

// ④ 第二条承诺能进
const a2 = promises.capture(K, { myText: '回头把笔记发你。' });
ok('④ 第二条承诺入库', a2.length === 1, a2);

// ⑤ 匹配：对方提到相关的事就勾起来
let hits = promises.findFor(K, '我下周考完了');
ok('⑤ 提到考完能勾起来', hits.length === 1 && /海边/.test(hits[0].text), hits);
ok('⑤ 记录命中关键词', hits[0] && hits[0]._hit.length > 0, hits[0] && hits[0]._hit);

// ⑥ 无关的话不勾
eq('⑥ 无关内容不提醒', promises.findFor(K, '今天食堂的饭好难吃').length, 0);

// ⑦ 提醒过会进冷却
promises.markReminded(K, hits.map(h => h.id));
eq('⑦ 冷却期内不再提醒', promises.findFor(K, '我下周考完了').length, 0);
ok('⑦ 提醒次数 +1', promises.list(K).find(x => x.text.includes('海边')).reminders === 1);

// ⑧ 冷却过了可以再提一次
const later = Date.now() + 7 * 3600e3;
hits = promises.findFor(K, '我考完啦', { now: later });
ok('⑧ 冷却后重新可提醒', hits.length === 1, hits);

// ⑨ 提醒次数到上限就闭嘴
promises.markReminded(K, hits.map(h => h.id));
const later2 = Date.now() + 48 * 3600e3;
eq('⑨ 提过两次不再提', promises.findFor(K, '我考完啦', { now: later2 }).length, 0);

// ⑩ 给模型的一句人话
const note = promises.noteOf(promises.findFor(K, '我考完啦', { now: Date.now() + 60 * 3600e3 }).map(x => x));
ok('⑩ note 是自然语言', typeof note === 'string');

// ⑪ 兑现
const done = promises.markDone(K, promises.list(K).find(x => x.text.includes('海边')).id);
ok('⑪ 标记兑现', done && done.status === 'done');
eq('⑪ 兑现后不再提醒', promises.findFor(K, '我考完啦').filter(x => x.text.includes('海边')).length, 0);

// ⑫ 落盘可读回
const raw = JSON.parse(fs.readFileSync(promises.fileOf(K), 'utf8'));
ok('⑫ 磁盘文件结构正确', Array.isArray(raw.items) && raw.items.some(i => i.status === 'done'));

// ⑬ 太久没兑现的被清理（dropped），不删痕迹
promises.capture(K, { myText: '下周末我带你去爬山，说好了。' });
const old = Date.now() + 40 * 86400e3;
const dropped = promises.sweepStale(K, { now: old, staleDays: 30 });
ok('⑬ 过期承诺被标记', dropped >= 1, dropped);
ok('⑬ 痕迹仍在文件里', promises.list(K).some(x => x.status === 'dropped'));

// ⑭ 开关
promises.configure({ enabled: false });
eq('⑭ 关掉后不抽取', promises.capture(K, { myText: '我明天给你带早餐。' }).length, 0);
eq('⑭ 关掉后不提醒', promises.findFor(K, '我考完啦').length, 0);
promises.configure({ enabled: true });

// ⑮ 拆条：长句拆两条、短句不拆
const long = '今天好累啊，我从早上八点一直忙到晚上九点，中间连饭都没顾上吃，现在只想躺平了。';
const parts = ar.splitReply(long);
ok('⑮ 长句拆成两条', parts.length === 2, parts);
ok('⑮ 拆完不丢字', parts.join('').replace(/\s/g, '') === long.replace(/\s/g, ''), parts);
eq('⑮ 短句不拆', ar.splitReply('在吗').length, 1);
eq('⑮ 只有一句感叹不拆', ar.splitReply('累死了').length, 1);
const three = ar.splitReply('好呀！那明天见！记得带伞！');
ok('⑮ 最多两条', three.length <= 2, three);

// ⑯ 拟人化配置可覆盖
const h = ar.humanizeSettings();
ok('⑯ 默认开打字与拆条', h.typing === true && h.split === true, h);

// ⑰ buildMessage：私聊气泡 / 群聊第二条不再重复 @
const segsPrivate = ar.buildMessage({ target: { type: 'private', id: '1' }, reply: '好' });
eq('⑰ 私聊只有文本段', segsPrivate, [{ type: 'text', data: { text: '好' } }]);
const segsGroup1 = ar.buildMessage({ target: { type: 'group', id: '2', at: '99' }, reply: '好' });
ok('⑰ 群聊首条 @', segsGroup1[0].type === 'at', segsGroup1);
const segsGroup2 = ar.buildMessage({ target: { type: 'group', id: '2', at: '99' }, reply: '好', noAt: true });
ok('⑰ 群聊续条不 @', segsGroup2[0].type === 'text', segsGroup2);

// 清空测试目录
try { fs.rmSync(promises.DIR, { recursive: true, force: true }); } catch (e) { }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
