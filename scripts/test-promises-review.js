'use strict';
/**
 * test-promises-review.js —— 代码审查提出来的回归点（全离线，不连模型/NapCat）。
 * 覆盖：误报（客套/犹豫被当承诺）、due 空命中、淘汰顺序、群内按人隔离、坏文件恢复。
 * 运行：node scripts/test-promises-review.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-review');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-promises-review-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-promises-review-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-promises-review-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

const promises = require('./promises.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const DIR = process.env.QQPROMISE_DIR;
fs.rmSync(DIR, { recursive: true, force: true });
promises.configure({ enabled: true, maxItems: 30, remindCooldownHours: 6, maxReminders: 2 });

// ① 客套/犹豫/假设不该入库（审查 S2 的实测表）
const notPromises = [
  '晚上好呀朋友们',
  '明天见啦宝贝',
  '我明天可能要加班',
  '明天又要上课了，烦死了',
  '我要睡了，晚安',
  '我要是你就不去了',
  '那我们一起呗',
  '今天好累啊',
  '你看那个新闻了吗？'
];
notPromises.forEach((s, i) => {
  const got = promises.capture('p:1001', { myText: s });
  ok('① 不入库：' + s, got.length === 0, got.map(x => x.text));
});

// ② 真承诺要能入库
const realOnes = ['考完试我陪你去海边，说好了。', '回头把笔记发你。', '明天我帮你带早餐。'];
realOnes.forEach(s => {
  const got = promises.capture('p:1002', { myText: s });
  ok('② 入库：' + s, got.length === 1, got.map(x => x.text));
});

// ③ 只有时间词、没有内容重合 → 不该被勾起（审查 M9）
fs.rmSync(DIR, { recursive: true, force: true });
promises.capture('p:1003', { myText: '明天我帮你带早餐。' });
const weak = promises.findFor('p:1003', '明天见');
ok('③ 只提「明天」不命中', weak.length === 0, weak.map(x => x.text));
const strong = promises.findFor('p:1003', '明天别忘了带早餐啊');
ok('③ 提到「早餐」才命中', strong.length === 1, strong.map(x => x.text));

// ④ 淘汰顺序：先丢已关闭/最老，别丢最新的 open（审查 M1）
fs.rmSync(DIR, { recursive: true, force: true });
promises.configure({ maxItems: 2 });
const a1 = promises.capture('p:1004', { myText: '明天我帮你带早餐。' })[0];
promises.markDone('p:1004', a1.id);
promises.capture('p:1004', { myText: '周末我陪你去买书。' });
promises.capture('p:1004', { myText: '回头把笔记发你。' });
const items = promises.list('p:1004');
ok('④ 条数不超上限', items.length <= 2, items.length);
ok('④ 最新的 open 还在', items.some(x => /笔记/.test(x.text)), items.map(x => x.status + '|' + x.text));
ok('④ 已关闭的先被淘汰', !items.some(x => x.status === 'done'), items.map(x => x.status + '|' + x.text));
promises.configure({ maxItems: 30 });

// ⑤ 群聊：A 的承诺不能提给 B（审查 S3）
fs.rmSync(DIR, { recursive: true, force: true });
promises.capture('g:200000001:u:100', { myText: '明天我把充电宝带给你。' });
ok('⑤ 同群别人不命中', promises.findFor('g:200000001:u:200', '明天到吗，充电宝呢').length === 0);
ok('⑤ 本人能命中', promises.findFor('g:200000001:u:100', '明天到吗，充电宝呢').length === 1);

// ⑥ 坏文件：先备份再从空开始，别把历史清零（审查 M5）
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const key6 = 'p:1006';
const f6 = promises.fileOf(key6);
fs.writeFileSync(f6, '{ this is not json');
ok('⑥ 坏文件读出空账本', promises.load(key6).items.length === 0);
ok('⑥ 留了 .bad-* 备份', fs.readdirSync(DIR).some(f => f.includes('.bad-')), fs.readdirSync(DIR));

// ⑦ 去重：同一件事换个说法不该存第二条（审查建议）
fs.rmSync(DIR, { recursive: true, force: true });
promises.capture('p:1007', { myText: '考完试我陪你去海边，说好了。' });
const dup = promises.capture('p:1007', { myText: '考完试我陪你去海边。' });
ok('⑦ 换个说法不重复入库', dup.length === 0, dup);
ok('⑦ 库里仍只有一条', promises.list('p:1007').length === 1);

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
