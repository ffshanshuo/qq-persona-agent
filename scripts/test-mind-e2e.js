#!/usr/bin/env node
/**
 * test-mind-e2e.js — 拟人记忆/情感层的端到端演练（dry 发送，不真发 QQ 消息）。
 *
 * 走真实链路：假事件 → decide → catchup → 上下文落盘 → promptBits（心情/关系/回忆注入）
 *            → brain.think（真调模型）→ dry 发送 → afterTurn（痕迹 + affect + 巩固 + 记忆图）
 *
 * 与生产隔离：QQMIND_DIR / QQTRACE_DIR / QQCTX_DIR 全部指向 *-e2e 目录，
 *             配置文件走 config/autoreply.mind-test.json，AUTOREPLY_DRY=1。
 *
 * 用法：node scripts/test-mind-e2e.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

process.env.AUTOREPLY_CONFIG = process.env.AUTOREPLY_CONFIG || path.join(ROOT, 'config', 'autoreply.mind-test.json');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-e2e');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-e2e');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-e2e');
process.env.QMIND_CONFIG = path.join(ROOT, 'logs', 'mind-e2e-none.json'); // 不读生产 config/mind.json
process.env.AUTOREPLY_DRY = '1';

const SELF = 123456789;
const PEER = 100000001; // 假事件里的对方（dry 模式不会真发出去）
const MIND = process.env.QQMIND_DIR;
const TRACE = process.env.QQTRACE_DIR;
const CTX = process.env.QQCTX_DIR;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 清掉上一轮的测试落盘
for (const dir of [MIND, TRACE, CTX]) {
  try {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  } catch (e) { /* 没有就算了 */ }
}

const mind = require('./mind.js');
const autoReply = require('./auto-reply.js');

function evt(text, i) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: SELF,
    user_id: PEER,
    sender: { user_id: PEER, nickname: '好友A' },
    time: Math.floor(Date.now() / 1000),
    message_id: 900000 + i,
    message: [{ type: 'text', data: { text } }],
    raw_message: text
  };
}

const SCRIPTS = [
  '下周三考完试我想去看海，憋了半年了',
  '我是口腔医学专业的，这周期末考得有点焦虑',
  '好，那考完你陪我去吧'
];

(async () => {
  const started = Date.now();
  for (let i = 0; i < SCRIPTS.length; i++) {
    await autoReply.handle(evt(SCRIPTS[i], i));
    console.log(`  · 第 ${i + 1} 轮处理完（${((Date.now() - started) / 1000).toFixed(1)}s）`);
    await sleep(7000); // 等 mind 链（affect/巩固）跑完：它是异步接在发送之后的
  }
  await sleep(4000);

  // ① 上下文落盘（真实链路走过 ingest/push）
  const ctxFiles = fs.existsSync(CTX) ? fs.readdirSync(CTX) : [];
  ok('产出了上下文文件', ctxFiles.length >= 1, ctxFiles.join(','));
  const ctxRaw = ctxFiles.length ? fs.readFileSync(path.join(CTX, ctxFiles[0]), 'utf8') : '{}';
  const ctxObj = JSON.parse(ctxRaw || '{}');
  ok('上下文里记下了我说的话', (ctxObj.turns || []).some(t => /看海|口腔医学/.test(t.text)), JSON.stringify((ctxObj.turns || []).slice(-3)));

  // ② 痕迹层：原始事件 + 情感 + 巩固
  const traceFiles = fs.existsSync(TRACE) ? fs.readdirSync(TRACE) : [];
  ok('产出了痕迹文件', traceFiles.length >= 1, traceFiles.join(','));
  const lines = traceFiles.length
    ? fs.readFileSync(path.join(TRACE, traceFiles[0]), 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
    : [];
  const types = lines.map(x => x.type);
  ok('痕迹里有原始对话（turn）', types.includes('turn'), types.join(','));
  ok('痕迹里有情感标注（affect）', types.includes('affect'), types.join(','));
  const thinkOf = (x) => (x && x.think) || {};
  ok('痕迹里存了发给模型的部分 prompt（可审计）', lines.some(x => x.type === 'turn' && String(thinkOf(x).prompt || '').length > 0),
    JSON.stringify(lines.filter(x => x.type === 'turn').map(x => String(thinkOf(x).prompt || '').length)));
  ok('痕迹里存了模型回复原文', lines.some(x => x.type === 'turn' && String(x.reply || '').length > 0), JSON.stringify(lines.filter(x => x.type === 'turn').map(x => x.reply).slice(-2)));
  ok('痕迹里有巩固记录（consolidate）', types.includes('consolidate'), types.join(','));

  // ③ 状态层
  const stateFiles = fs.existsSync(MIND) ? fs.readdirSync(MIND).filter(f => f.endsWith('-state.json')) : [];
  ok('产出了状态层文件', stateFiles.length >= 1, stateFiles.join(','));
  const st = stateFiles.length ? JSON.parse(fs.readFileSync(path.join(MIND, stateFiles[0]), 'utf8')) : {};
  ok('状态层累加了轮数', Number(st.msgCount) >= 2, String(st.msgCount));
  ok('状态层记下了情感（pad 非零）', st.pad && (Math.abs(st.pad.p) + Math.abs(st.pad.a) + Math.abs(st.pad.d)) > 0.05, JSON.stringify(st.pad));
  ok('状态层关系有变化（温暖/信任上升）', st.rel && (st.rel.warmth > 0.15 || st.rel.trust > 0.1), JSON.stringify(st.rel));
  ok('巩固写了关系种子', Boolean(st.relSeed), String(st.relSeed));

  // ④ 联想层记忆图
  const graphFiles = fs.existsSync(MIND) ? fs.readdirSync(MIND).filter(f => f.endsWith('-graph.json')) : [];
  ok('产出了记忆图文件', graphFiles.length >= 1, graphFiles.join(','));
  const g = graphFiles.length ? JSON.parse(fs.readFileSync(path.join(MIND, graphFiles[0]), 'utf8')) : { nodes: [] };
  ok('记忆图里有巩固抽出的节点', (g.nodes || []).length >= 1, JSON.stringify((g.nodes || []).map(n => n.text)));
  ok('节点带了情感指纹', (g.nodes || []).some(n => n.pad && (Math.abs(n.pad.p) + Math.abs(n.pad.a)) > 0.05), JSON.stringify((g.nodes || []).map(n => n.pad)));
  ok('记忆图里有边（联想）', (g.edges || []).length >= 1, String((g.edges || []).length));
  ok('记忆图不是空的（说明巩固真的跑过）', (g.nodes || []).length >= 1 && lines.some(x => x.type === 'consolidate'));

  // ⑤ 日志：recall / mind 事件
  const logFile = path.join(ROOT, 'logs', 'autoreply.log');
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-400).join('\n') : '';
  ok('日志里有 mind 事件（状态已更新）', /"event":"mind"/.test(tail));
  ok('日志里没有 mind-error', !/"event":"mind-error"/.test(tail), (tail.match(/"event":"mind-error"[^\n]*/) || [''])[0]);

  // ⑥ 第二轮调用：状态能被读回来（重启不失忆）
  const st2 = mind.loadState(path.basename(stateFiles[0] || 'x.json', '-state.json'));
  ok('状态可重读（重启不失忆）', Number(st2.msgCount) >= 1, String(st2.msgCount));

  const ms = Date.now() - started;
  console.log(`\n${pass} passed, ${fail} failed（用时 ${(ms / 1000).toFixed(1)}s）`);
  if (fail) console.log('排查：logs/autoreply.log 里搜 mind / mind-error / mimic');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('演练崩溃:', e); process.exit(1); });
