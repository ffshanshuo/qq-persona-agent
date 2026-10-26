'use strict';
/**
 * test-murmur.js —— 碎话层自检（全离线）
 * 覆盖：什么算「没信息量」、不同意图给的候选、冷却/频次/日上限/不许连两条、
 *       真发才记账、群里没点我们不发、配置开关。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'murmur-'));
process.env.QQMURMUR_DIR = DIR;

const M = require('../scripts/murmur.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.message)); }
}
const eq = (a, b, m) => assert.strictEqual(a, b, m || (String(a) + ' !== ' + String(b)));
const ok = (v, m) => assert.ok(v, m);

const NOW = new Date(2026, 9, 25, 15, 0, 0).getTime();

// ---------- 一、判定「有没有信息量」 ----------
t('单字「嗯」算碎话（且是单字附和，走温和候选）', () => {
  const r = M.isFiller('嗯');
  ok(r.filler); eq(r.kind, 'sighSingle');
});
t('「嗯嗯」算碎话（双字附和）', () => { const r = M.isFiller('嗯嗯'); ok(r.filler); eq(r.kind, 'sigh'); });
t('「哦」算碎话但不直接回「哦」（避免像敷衍）', () => {
  const r = M.isFiller('哦');
  ok(r.filler);
  ok(M.KINDS.sighSingle.every(x => x !== '哦' && x !== '哦。'));
});
t('「？」单独一个算碎话（在等你说话）', () => { const r = M.isFiller('？'); ok(r.filler); eq(r.kind, 'doubt'); });
t('「哈哈哈」算碎话里的笑', () => { const r = M.isFiller('哈哈哈'); ok(r.filler); eq(r.kind, 'laugh'); });
t('「好的」算应答', () => { const r = M.isFiller('好的'); ok(r.filler); eq(r.kind, 'neutral'); });
t('「在吗」不算碎话（要模型回）', () => eq(M.isFiller('在吗').filler, false));
t('「今天好累啊」不算碎话', () => eq(M.isFiller('今天好累啊').filler, false));
t('「我到家了」不算碎话（有信息）', () => eq(M.isFiller('我到家了').filler, false));
t('「好的明天见」不算（超出短应答）', () => eq(M.isFiller('好的明天见').filler, false));
t('只有表情标记也算碎话但走中性候选', () => { const r = M.isFiller('[表情]'); ok(r.filler); });

// ---------- 二、decide：概率 / 冷却 / 限额 ----------
const KEY = 'p:100000001';
function fresh() { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { } }

t('命中候选但掷骰子没中就不发', () => {
  fresh();
  const r = M.decide({ text: '嗯嗯', key: KEY, now: NOW, random: () => 0.99 });
  eq(r.ok, false); eq(r.why, 'dice');
});
t('掷骰子中 → 给一句 ≤6 字', () => {
  fresh();
  const r = M.decide({ text: '嗯嗯', key: KEY, now: NOW, random: () => 0 });
  eq(r.ok, true);
  ok(r.reply.length > 0 && r.reply.length <= 6, r.reply);
});
t('「？」回的是疑问类而不是「嗯」', () => {
  fresh();
  const r = M.decide({ text: '？', key: KEY, now: NOW, random: () => 0 });
  eq(r.ok, true); eq(r.kind, 'doubt');
  ok(/啊|欸|怎么|嗯\?|嗯？/.test(r.reply), r.reply);
});
t('有内容的消息永远不走碎话', () => {
  fresh();
  const r = M.decide({ text: '明天几点集合', key: KEY, now: NOW, random: () => 0 });
  eq(r.ok, false); eq(r.why, 'has-content');
});
t('开关关掉就完全不发', () => {
  fresh();
  const r = M.decide({ text: '嗯', key: KEY, now: NOW, random: () => 0, cfg: { enabled: false } });
  eq(r.ok, false); eq(r.why, 'disabled');
});
t('刚发过碎话（20 分钟内）不再发', () => {
  fresh();
  M.note(KEY, '嗯嗯', NOW);
  const r = M.decide({ text: '嗯', key: KEY, now: NOW + 3 * 60000, random: () => 0 });
  eq(r.ok, false); eq(r.why, 'too-soon');
});
t('过了 20 分钟、中间说过实质内容 → 可以再发', () => {
  fresh();
  M.note(KEY, '嗯嗯', NOW);
  M.markSubstantive(KEY, NOW + 10 * 60000);   // 中间回了一条正经的
  const r = M.decide({ text: '哈哈', key: KEY, now: NOW + 21 * 60000, random: () => 0 });
  eq(r.ok, true);
});
t('过了 20 分钟但中间没说过别的 → 仍然不许连着碎话', () => {
  fresh();
  M.note(KEY, '嗯嗯', NOW);
  const r = M.decide({ text: '哈哈', key: KEY, now: NOW + 21 * 60000, random: () => 0 });
  eq(r.ok, false); eq(r.why, 'no-twice');
});
t('每小时上限 2 条', () => {
  fresh();
  M.note(KEY, '嗯嗯', NOW);
  M.note(KEY, '好～', NOW + 21 * 60000);
  const r = M.decide({ text: '哦', key: KEY, now: NOW + 45 * 60000, random: () => 0 });
  eq(r.ok, false); eq(r.why, 'hour-cap');
});
t('每天上限（同一天内已有 3 条，perDay=3 就拦住）', () => {
  fresh();
  for (let i = 0; i < 3; i++) M.note(KEY, '嗯', NOW + i * 60000);
  const r = M.decide({ text: '哦', key: KEY, now: NOW + 5 * 60000, random: () => 0, cfg: { perHour: 99, perDay: 3 } });
  eq(r.ok, false); eq(r.why, 'day-cap');
});
t('上一条已经是碎话时不连着发第二条', () => {
  fresh();
  M.note(KEY, '嗯嗯', NOW);
  // 绕过 20 分钟间隔（sent 清空），只测「连着两条」这条闸门
  const st = M.load(KEY);
  st.sent = [];
  M.save(KEY, st);
  const r = M.decide({ text: '哦', key: KEY, now: NOW, random: () => 0 });
  eq(r.ok, false); eq(r.why, 'no-twice');
});
t('不同人之间额度互不影响', () => {
  fresh();
  M.note('p:1', '嗯', NOW);
  const r = M.decide({ text: '嗯', key: 'p:2', now: NOW, random: () => 0 });
  eq(r.ok, true);
});

// ---------- 三、记账 ----------
t('note 记账会写 lastKind/lastAt 并落盘', () => {
  fresh();
  M.note(KEY, '嗯嗯', NOW);
  const st = M.load(KEY);
  eq(st.lastKind, 'murmur'); eq(st.lastAt, NOW); eq(st.lastReply, '嗯嗯');
  const list = M.list();
  eq(list.length, 1); eq(list[0].count, 1);
});
t('碎话不发同样长的句子（候选都在 8 字内）', () => {
  for (const k of Object.keys(M.KINDS)) {
    for (const v of M.KINDS[k]) ok(String(v).length <= 8, k + ':' + v);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
process.exit(failed ? 1 : 0);
