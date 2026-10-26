#!/usr/bin/env node
/**
 * test-context.js — 上下文子系统的离线 + 在线（dry）自检。
 *
 * 离线部分：context.js 的落盘/裁剪/压缩计划/合并/回填（不碰网络）。
 * 在线部分：真实 NapCat 历史接口回填 + brain 摘要 + dry 发送（不会真的发 QQ 消息）。
 *
 * 用法：node scripts/test-context.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'logs', 'context-test');
process.env.QQCTX_DIR = TMP;
process.env.QQMODE_DIR = __dirname + '/../logs/mode-context-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-context-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-context-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-context-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-context-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.ctx-test.json');
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'context-test.log');
process.env.AUTOREPLY_STATE = path.join(ROOT, 'logs', 'context-test-state.json');
process.env.AUTOREPLY_DRY = '1';

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
for (const f of ['context-test.log', 'context-test-state.json']) {
  try { fs.unlinkSync(path.join(ROOT, 'logs', f)); } catch (e) { }
}

const ctx = require('./context.js');
let pass = 0; let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + JSON.stringify(extra).slice(0, 200) : '')); }
}

(async () => {
  // ── 1. 落盘与视图 ──
  ctx.configure({ budgetChars: 40, keepRecent: 2, maxTurns: 12 });
  const K = 'p:999001';
  for (let i = 0; i < 6; i++) {
    ctx.push(K, { t: 1700000000000 + i * 1000, from: i % 2 ? 'me' : 'them', speaker: i % 2 ? '' : '小测', text: '第' + i + '条' + '啊'.repeat(5) });
  }
  const l1 = ctx.load(K);
  ok('落盘 6 条', l1.turns.length === 6, l1.turns.length);
  const v1 = ctx.view(K);
  const chars = v1.history.reduce((n, t) => n + t.text.length, 0);
  ok('view 受 budgetChars 约束', chars <= 40 + 12, { chars });
  ok('view 由旧到新', v1.history.length > 1 ? v1.history[v1.history.length - 1].text.startsWith('第5条') : false, v1.history.map(h => h.text.slice(0, 3)));

  // ── 2. 压缩计划 + 应用 ──
  const plan = ctx.planCompaction(K);
  ok('超预算触发压缩', plan.need === true && plan.old.length > 0, { need: plan.need, old: plan.old && plan.old.length });
  ctx.applyCompaction(K, { ...plan, summary: '小测问了六件事，我逐条记下。', facts: ['昵称小测', '在忙搬家'] });
  const l2 = ctx.load(K);
  ok('压缩后原文变短', l2.turns.length < 6, l2.turns.length);
  ok('压缩后摘要写入', l2.summary.includes('小测'), l2.summary);
  ok('事实写入并去重上限', l2.facts.length <= 4 && l2.facts.includes('昵称小测'), l2.facts);
  ok('dropped 计数', l2.dropped > 0, l2.dropped);

  // 二次压缩：摘要应合并而不是覆盖（把预算再压低，保证触发）
  ctx.configure({ budgetChars: 24, keepRecent: 2, maxTurns: 20 });
  ctx.push(K, { from: 'them', speaker: '小测', text: '又聊了两句'.repeat(6) });
  const plan2 = ctx.planCompaction(K);
  if (plan2.need) {
    ctx.applyCompaction(K, { ...plan2, summary: '后来又说要去买纸箱。', facts: ['昵称小测'] });
    const l3 = ctx.load(K);
    ok('摘要合并保留旧内容', l3.summary.includes('小测') && l3.summary.includes('纸箱'), l3.summary);
    ok('事实不重复', l3.facts.filter(f => f === '昵称小测').length === 1, l3.facts);
  } else { ok('二次压缩触发', false, plan2); }

  // ── 3. 回填（注入式 fetchHistory）──
  const KW = 'p:999002';
  const fakeMsgs = [
    { user_id: 999002, time: 1700000100, message: [{ type: 'text', data: { text: '早上好' } }], sender: { nickname: '阿回' } },
    { user_id: 123456789, time: 1700000110, message: [{ type: 'text', data: { text: '早' } }], sender: {} },
    { user_id: 999002, time: 1700000120, message: [{ type: 'image', data: { file: 'x' } }], sender: { nickname: '阿回' } }
  ];
  const wr = await ctx.warmup(KW, 'private', 999002, async () => fakeMsgs, { selfId: 123456789 });
  const lw = ctx.load(KW);
  ok('回填成功', wr.ok === true && lw.turns.length === 3, { wr, n: lw.turns.length });
  ok('回填区分 me/them', lw.turns[0].from === 'them' && lw.turns[1].from === 'me', lw.turns.map(t => t.from));
  ok('回填把图片变成 [图片]', lw.turns[2].text === '[图片]', lw.turns[2].text);
  ok('回填后 view 有 gapNote 字段', typeof ctx.view(KW).gapNote === 'string');

  // ── 3.5 对账 ingest：补旧 + 离线补账 + 去重 + 排序 ──
  const KI = 'p:999003';
  const mk = (uid, sec, text) => ({ user_id: uid, time: sec, message: [{ type: 'text', data: { text } }], sender: { nickname: '阿账' } });
  const oldMsgs = [mk(999003, 1700000200, '老消息一'), mk(123456789, 1700000210, '老回复'), mk(999003, 1700000220, '老消息二')];
  const ri1 = ctx.ingest(KI, 'private', { uin: 999003 }, oldMsgs, { selfId: 123456789 });
  ok('ingest 冷启动灌入', ri1.ok === true && ri1.added === 3 && ri1.missed.length === 0, ri1);
  const ri2 = ctx.ingest(KI, 'private', { uin: 999003 }, oldMsgs, { selfId: 123456789 });
  ok('ingest 重复灌入不重复', ri2.added === 0 && ctx.load(KI).turns.length === 3, ri2);
  // 本地最新是 1700000220；再来一批包含「更早的」和「更新且对方发的」
  const newMsgs = [
    mk(999003, 1700000190, '更早的旧账'),
    mk(999003, 1700000300, '你不在的时候我发了句'),   // 离线漏掉的（对方）
    mk(123456789, 1700000310, '这是我后来回的'),        // 自己发的，不算 missed
    mk(999003, 1700000200, '老消息一')                    // 完全重复
  ];
  const ri3 = ctx.ingest(KI, 'private', { uin: 999003 }, newMsgs, { selfId: 123456789 });
  const turns3 = ctx.load(KI).turns;
  ok('ingest 补旧 + 补漏 + 去重', ri3.added === 3, ri3);
  ok('ingest 按时间排序', turns3.map(t => t.t).join(',') === [...turns3.map(t => t.t)].sort((a, b) => a - b).join(','), turns3.map(t => t.text));
  ok('ingest 标出离线漏掉的（只算对方的）',
    ri3.missed.length === 1 && ri3.missed[0].text === '你不在的时候我发了句', ri3.missed);

  // 开源快照里没有 ob11.token / gw.token → 在线用例自动跳过（否则新克隆跑全套必红）
  const hasNapcat = (() => { try { return fs.readFileSync(path.join(__dirname, 'ob11.token'), 'utf8').trim().length > 0; } catch (e) { return false; } })();
  const hasModelKey = (() => { try { return fs.readFileSync(path.join(__dirname, 'gw.token'), 'utf8').trim().length > 0; } catch (e) { return false; } })();
  if (!hasNapcat || !hasModelKey) {
    pass++; console.log('skip 在线用例（缺 ob11.token / gw.token，开源快照属正常）');
  } else {
  // ── 4. 在线：真实 NapCat 历史 + brain 摘要 + dry 发送 ──
  const ar = require('./auto-reply.js');
  const brain = require('./brain.js');
  const KEY = 'p:100000001';
  const evt = (text, id) => ({
    post_type: 'message', message_type: 'private', user_id: 100000001, self_id: 123456789,
    time: Math.floor(Date.now() / 1000), message_id: id || (700000 + Math.floor(Math.random() * 100000)),
    message: [{ type: 'text', data: { text } }], raw_message: text, sender: { nickname: '好友A' }
  });

  await ar.handle(evt('上下文联测第一条：我今天有点累', 900001));
  const c1 = ctx.load(KEY);
  ok('在线：回填 + 本轮都进上下文', c1.turns.length >= 2, { n: c1.turns.length });
  ok('在线：带发言人', c1.turns.some(t => t.from === 'them' && t.speaker), c1.turns.slice(0, 2));

  // 重启模拟：清 require 缓存后重新加载 auto-reply（模块内 warmed 集合重置）
  Object.keys(require.cache).forEach(k => { if (/scripts[\\/](context|auto-reply|brain)\.js$/.test(k)) delete require.cache[k]; });
  const ar2 = require('./auto-reply.js');
  const persisted = ctx.load(KEY); // 新模块从磁盘读：内存 Map 时代这里必丢
  ok('重启后上下文仍在（磁盘读回）', persisted.turns.length >= 2 || !!persisted.summary, { n: persisted.turns.length, hasSummary: !!persisted.summary });
  await ar2.handle(evt('上下文联测第二条：我们刚才聊到哪了？', 900002));
  const c2 = ctx.load(KEY);
  // 注意：小预算下 handle 内部可能立刻压缩，条数不一定变多，所以看「痕迹」而不是条数
  const trace = c2.turns.some(t => /刚才聊到哪/.test(t.text)) || /聊到|上下文/.test(c2.summary || '');
  ok('重启后接着聊，旧上下文仍参与（原文或摘要里有痕迹）', trace, { n: c2.turns.length, summary: String(c2.summary || '').slice(0, 60) });

  // 压缩：把预算压到很小，多推几条逼出真实摘要调用
  ctx.configure({ budgetChars: 20, keepRecent: 2, maxTurns: 20 });
  for (let i = 0; i < 6; i++) {
    ctx.push(KEY, { from: i % 2 ? 'me' : 'them', speaker: i % 2 ? '' : '好友A', text: '补历史第' + i + '条，内容长一点好超预算' });
  }
  const plan3 = ctx.planCompaction(KEY);
  ok('在线：小预算下压缩可触发', plan3.need === true, plan3.need);
  const s = await brain.summarize(plan3.old, { nick: '好友A' });
  ok('在线：brain.summarize 出摘要', !!s.summary && s.summary.length > 4, s);
  ctx.applyCompaction(KEY, { ...plan3, summary: s.summary, facts: s.facts });
  const c3 = ctx.load(KEY);
  ok('在线：压缩后摘要非空、原文变短', !!c3.summary && c3.turns.length < c2.turns.length + 6, { summary: c3.summary.slice(0, 40), turns: c3.turns.length });

  // 压缩后下一轮仍能用（view 带 summary/facts 交给 brain）
  await ar2.handle(evt('上下文联测第三条：那你还记得我刚才说了什么吗', 900003));
  const logTxt = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  ok('在线：dry 发送发生过', /dry-send/.test(logTxt));
  ok('在线：日志里有对账或压缩事件', /"event":"(catchup|compact|offline-missed)"/.test(logTxt), logTxt.split('\n').slice(-4).join('\n'));

  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('上下文文件：');
  console.log(JSON.stringify(ctx.list(), null, 2));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e && e.stack || e); process.exit(1); });
