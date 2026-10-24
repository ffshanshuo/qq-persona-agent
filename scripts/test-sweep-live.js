#!/usr/bin/env node
// test-sweep-live.js — 用**真模型**跑一次空闲巩固（隔离目录，不碰生产）
// 用法：node scripts/test-sweep-live.js
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-sweep-live');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-sweep-live-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-sweep-live-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-sweep-live-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-sweep-live');
process.env.QMIND_CONFIG = path.join(ROOT, 'logs', 'mind-sweep-live-none.json');

const mind = require('./mind.js');
const brain = require('./brain.js');

const KEY = 'live:sweep';
for (const f of [mind.stateFile(KEY), mind.graphFile(KEY), mind.traceFile(KEY)]) {
  try { fs.unlinkSync(f); } catch (e) { /* 没有就算了 */ }
}

const now = Date.now();
const st = mind.blankState(KEY, 'private', { id: 100000001, nick: '好友A' });
st.pendingConsolidate = 2;
st.lastTurnAt = now - 70 * 60000;   // 70 分钟前聊完，人已经去做别的事了
mind.saveState(st);

const turns = [
  { t: now - 72 * 60000, from: 'them', speaker: '好友A', text: '我下周三口腔医学考完，想去海边走走，憋太久了' },
  { t: now - 71 * 60000, from: 'me', speaker: '你', text: '考完就去，海风等你。到时候我陪你去' },
  { t: now - 70 * 60000, from: 'them', speaker: '好友A', text: '最近老失眠，一闭眼就想复习进度' },
  { t: now - 69 * 60000, from: 'me', speaker: '你', text: '别熬太狠，睡前一小时别看题了' }
];

(async () => {
  const t0 = Date.now();
  const r = await mind.sweep({
    turnsOf: () => turns,
    extract: (list) => brain.extractMemories(list, { nick: '好友A' }),
    idleMin: 45,
    now
  });
  const ms = Date.now() - t0;
  const g = mind.loadGraph(KEY);
  const s2 = mind.loadState(KEY);
  console.log(JSON.stringify({
    swept: r.swept, nodes: g.nodes.map(n => ({ text: n.text, kind: n.kind, salience: n.salience })),
    edges: g.edges.length, relSeed: s2.relSeed, pendingAfter: s2.pendingConsolidate, ms
  }, null, 2));
  const tr = fs.readFileSync(mind.traceFile(KEY), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  console.log('痕迹类型:', tr.map(x => x.type).join(','));
  const okAll = r.swept.length === 1 && g.nodes.length >= 1 && s2.pendingConsolidate === 0;
  console.log(okAll ? '\nLIVE SWEEP OK（真模型抽出 ' + g.nodes.length + ' 条记忆，耗时 ' + ms + 'ms）' : '\nLIVE SWEEP FAIL');
  process.exit(okAll ? 0 : 1);
})().catch(e => { console.error('崩了:', e); process.exit(1); });
