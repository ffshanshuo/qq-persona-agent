#!/usr/bin/env node
/**
 * test-mind.js — 拟人记忆/情感/联想层的离线自检（纯数学 + 注入式抽取器，不需要 NapCat）。
 *
 * 覆盖：
 *   ① 瞬时情感二阶惯性（α/β 的确切数值）
 *   ② 关系层「慢、有下限」
 *   ③ 人话描述里不许出现数字
 *   ④ ACT-R 激活：近的比远的强；高显著性衰减更慢
 *   ⑤ 情绪一致性 / 字符二元组相似度
 *   ⑥ 语义种子检索、情感调制、带权扩散、条数与字数上限、空图无结果
 *   ⑦ 太像的记忆合并成同一个节点（重复唤醒）
 *   ⑧ afterTurn：痕迹落盘、状态累加、到点巩固（注入假抽取器）
 *   ⑨ 巩固修剪只剪边、不删节点；关系种子写回
 *   ⑩ 落盘可重读
 *   ⑪ 空闲巩固 sweep：静下来才整理、刚还在聊不打断、无抽取器跳过
 *
 * 用法：node scripts/test-mind.js
 */
'use strict';

process.env.QQMIND_DIR = process.env.QQMIND_DIR || require('path').join(__dirname, '..', 'logs', 'mind-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-mind-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-mind-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-mind-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQTRACE_DIR = process.env.QQTRACE_DIR || require('path').join(__dirname, '..', 'logs', 'trace-test');
process.env.QMIND_CONFIG = process.env.QMIND_CONFIG || require('path').join(__dirname, '..', 'logs', 'mind-test-none.json');

const fs = require('fs');
const path = require('path');
const mind = require('./mind.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); }
}
function near(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }
function fresh(key) {
  for (const f of [mind.stateFile(key), mind.graphFile(key), mind.traceFile(key)]) {
    try { fs.unlinkSync(f); } catch (e) { /* 没有就算了 */ }
  }
}

(async () => {
  mind.configure({ alpha: 0.3, beta: 0.2, noiseSigma: 0.05, threshold: 0.18, injectMax: 5, injectChars: 600 });

  // ① 二阶惯性
  {
    const key = 't:inertia';
    fresh(key);
    const st = mind.loadState(key);
    mind.updatePad(st, { pad: { p: 1, a: 0.5, d: 0 } });
    ok('PAD 第一拍：E1 = 0 + 0.3*(1-0) = 0.3', near(st.pad.p, 0.3), JSON.stringify(st.pad));
    mind.updatePad(st, { pad: { p: 1, a: 0.5, d: 0 } });
    ok('PAD 第二拍含动量：0.3+0.3*0.7+0.2*0.3 = 0.57', near(st.pad.p, 0.57), JSON.stringify(st.pad));
    for (let i = 0; i < 20; i++) mind.updatePad(st, { pad: { p: 1, a: 1, d: 1 } });
    ok('PAD 有上界（clamp 到 1）', st.pad.p <= 1 && st.pad.a <= 1, JSON.stringify(st.pad));
    // 反向：从高值往下掉，不会一瞬间归零（惯性）
    mind.updatePad(st, { pad: { p: -1, a: -1, d: -1 } });
    // α=0.3 ⇒ 一句强烈反向的话最多拉回 0.6 的差距（1 → 0.4），但不会瞬间翻到负值
    ok('PAD 惯性能抗住一句反向消息（仍在正值区）', st.pad.p > 0.3, JSON.stringify(st.pad));
  }

  // ② 关系层：慢 + 下限
  {
    const key = 't:rel';
    fresh(key);
    const st = mind.loadState(key);
    const before = { ...st.rel };
    mind.updateRelation(st, ['self-disclosure']);
    const dW = st.rel.warmth - before.warmth;
    ok('关系层一小步（≈0.042，远小于瞬时情感 0.3）', dW > 0 && dW < 0.1, String(dW));
    ok('自我披露让信任上升', st.rel.trust > before.trust, JSON.stringify(st.rel));
    for (let i = 0; i < 60; i++) mind.updateRelation(st, ['conflict']);
    ok('关系有下限：一次/多次负面事件不会把温暖清到 -1 以下', st.rel.warmth >= -0.6, JSON.stringify(st.rel));
    ok('冲突会抬高张力', st.rel.tension > 0, JSON.stringify(st.rel));
    for (let i = 0; i < 5; i++) mind.updateRelation(st, ['repair']);
    ok('和好能降张力', st.rel.tension >= 0, JSON.stringify(st.rel));
  }

  // ③ 人话里不许出现数字
  {
    const key = 't:desc';
    fresh(key);
    const st = mind.loadState(key);
    st.pad = { p: 0.6, a: 0.4, d: 0.3 };
    st.rel = { warmth: 0.6, trust: 0.55, intimacy: 0.5, tension: 0.1 };
    const mood = mind.describeMood(st).text;
    const bond = mind.describeBond(st).text;
    ok('心情描述是中文人话', /高兴|不错|平静|闷|低落/.test(mood) && mood.length > 4, mood);
    ok('心情/关系描述里没有数字', !/\d/.test(mood) && !/\d/.test(bond), mood + ' | ' + bond);
    ok('关系描述体现亲近', /熟|亲近|亲昵|朋友/.test(bond), bond);
  }

  // ④ ACT-R 激活
  {
    const now = Date.now();
    const recent = { text: 'x', t: now - 3600 * 1000, accesses: [now - 3600 * 1000], salience: 0.3 };
    const old = { text: 'x', t: now - 30 * 86400000, accesses: [now - 30 * 86400000], salience: 0.3 };
    ok('刚说过的比一个月前的更容易被想起', mind.activation(recent, now) > mind.activation(old, now));
    const vivid = { text: 'y', t: now - 30 * 86400000, accesses: [now - 30 * 86400000], salience: 1 };
    const plain = { text: 'y', t: now - 30 * 86400000, accesses: [now - 30 * 86400000], salience: 0 };
    ok('情感显著性高的记得更牢（衰减更慢）', mind.activation(vivid, now) > mind.activation(plain, now));
    const repeated = { text: 'z', t: now - 20 * 86400000, accesses: [now - 20 * 86400000, now - 10 * 86400000, now - 86400000], salience: 0.3 };
    const once = { text: 'z', t: now - 86400000, accesses: [now - 86400000], salience: 0.3 };
    ok('被反复想起的记忆基础激活更高', mind.activation(repeated, now) > mind.activation(once, now) - 0.01);
  }

  // ⑤ 相似度与情绪一致性
  {
    ok('同一句话相似度=1', near(mind.sim('下周三考完去看海', '下周三考完去看海'), 1));
    ok('不相关的话相似度低', mind.sim('下周三考完去看海', '优惠猫群发红包') < 0.15);
    ok('情绪一致 → 一致性接近 1', mind.congruence({ p: 0.5, a: 0.2, d: 0 }, { p: 0.5, a: 0.2, d: 0 }) > 0.95);
    ok('情绪相反 → 一致性很低', mind.congruence({ p: 0.7, a: 0.5, d: 0.3 }, { p: -0.7, a: -0.5, d: -0.3 }) < 0.35);
    ok('没有指纹按中性 0.6 算', near(mind.congruence({ p: 1, a: 1, d: 1 }, null), 0.6));
  }

  // ⑥ 语义种子检索
  {
    const key = 't:recall';
    fresh(key);
    const g = mind.loadGraph(key);
    mind.addNode(g, { text: '好友A下周三考完口腔医学，想去看海', kind: 'plan', salience: 0.8, pad: { p: 0.6, a: 0.4, d: 0.1 } });
    mind.addNode(g, { text: '她昨天在食堂吃了牛肉面', kind: 'event', salience: 0.1, pad: { p: 0.1, a: 0, d: 0 } });
    mind.addNode(g, { text: '她说过喜欢蓝色和海边', kind: 'preference', salience: 0.5, pad: { p: 0.3, a: 0.1, d: 0 } });
    mind.saveGraph(g);

    const r1 = mind.recall(key, '考试考得怎么样');
    ok('查「考试」能想起考试/看海那条', r1.memories.some(m => /考试|口腔医学|看海/.test(m)), JSON.stringify(r1.memories));
    const r2 = mind.recall(key, '牛肉面好吃吗');
    ok('查吃的能想起牛肉面那条', r2.memories.some(m => /牛肉面/.test(m)), JSON.stringify(r2.memories));
    const r3 = mind.recall(key, '海底世界');
    ok('联想扩散：问「海」也能带出写着「海」的偏好', r3.memories.length > 0, JSON.stringify(r3.memories));
    ok('注入条数受限', r1.memories.length <= 5, String(r1.memories.length));
    ok('注入有上限字数（大纲）', r1.memories.join('').length <= 600, String(r1.memories.join('').length));

    const caps = mind.recall(key, '考试', { injectMax: 1 });
    ok('injectMax 生效', caps.memories.length === 1, JSON.stringify(caps.memories));
    const tiny = mind.recall(key, '考试', { injectChars: 5 });
    ok('injectChars 生效（放不下就不放）', tiny.memories.length === 0 || tiny.memories.join('').length <= 5, JSON.stringify(tiny.memories));

    const empty = mind.recall('t:nonexistent', '随便问问');
    ok('空图不会硬凑回忆', Array.isArray(empty.memories) && empty.memories.length === 0);
    ok('空图也给得出心情/关系描述', typeof empty.mood === 'string' && empty.mood.length > 0);
  }

  // ⑦ 情感调制：同样的语义相关度，情绪同调的那条更容易被想起
  {
    const key = 't:mood';
    fresh(key);
    const g = mind.loadGraph(key);
    mind.addNode(g, { text: '上次一起去看海那天很开心', kind: 'event', salience: 0.6, pad: { p: 0.8, a: 0.5, d: 0.2 } });
    mind.addNode(g, { text: '上次一起去看海那天吵起来了', kind: 'event', salience: 0.6, pad: { p: -0.8, a: 0.6, d: -0.2 } });
    mind.saveGraph(g);
    const st = mind.loadState(key);
    st.pad = { p: 0.7, a: 0.4, d: 0.2 };
    st.padPrev = { p: 0.7, a: 0.4, d: 0.2 };
    mind.saveState(st);
    let pos = 0, neg = 0;
    for (let i = 0; i < 40; i++) {
      const r = mind.recall(key, '看海那天');
      const first = (r.memories[0] || '');
      if (/开心/.test(first)) pos++;
      if (/吵起来/.test(first)) neg++;
    }
    ok('心情好时更容易先想起开心的旧事', pos > neg, `开心 ${pos} : 吵架 ${neg}`);
  }

  // ⑧ 带权扩散：直接语义不相关、但图上有边的节点也能被带出来
  {
    const key = 't:spread';
    fresh(key);
    const g = mind.loadGraph(key);
    const a = mind.addNode(g, { text: '她养了一只叫团子的猫', kind: 'fact', salience: 0.7 });
    const b = mind.addNode(g, { text: '她讨厌别人说猫会掉毛', kind: 'preference', salience: 0.6 });
    mind.link(g, a.node.id, b.node.id, 'causal', 0.9);
    mind.saveGraph(g);
    const r = mind.recall(key, '团子今天怎么样', { hops: 2 });
    ok('沿边扩散能带出间接相关的记忆', r.memories.length >= 1 && r.memories.some(m => /猫|掉毛/.test(m)), JSON.stringify(r.memories));
    const r0 = mind.recall(key, '团子今天怎么样', { hops: 0 });
    ok('hops=0 只留种子（不扩散也能找到直接那条）', r0.memories.some(m => /团子|猫/.test(m)), JSON.stringify(r0.memories));
  }

  // ⑨ 太像的记忆合并 + 重复唤醒
  {
    const key = 't:merge';
    fresh(key);
    const g = mind.loadGraph(key);
    const r1 = mind.addNode(g, { text: '她下周三考口腔医学' });
    const r2 = mind.addNode(g, { text: '她下周三考口腔医学。' });
    ok('近乎重复的记忆合并成一条', g.nodes.length === 1 && r1.added && !r2.added, 'nodes=' + g.nodes.length);
    ok('合并时记录了一次新的唤醒（accesses 变长）', g.nodes[0].accesses.length === 2, String(g.nodes[0].accesses.length));
    const before = g.nodes[0].salience;
    mind.addNode(g, { text: '她下周三考口腔医学', salience: 0.9 });
    ok('合并取更高的显著性', g.nodes[0].salience >= before && g.nodes[0].salience === 0.9, String(g.nodes[0].salience));
  }

  // ⑩ afterTurn：痕迹、状态、巩固（注入假抽取器）
  {
    const key = 't:turn';
    fresh(key);
    mind.configure({ consolidateEvery: 2, bootstrapTurns: 2, trace: true });
    const turns = [
      { from: 'them', text: '下周三考完就解放了', t: Date.now() - 60000 },
      { from: 'me', text: '考完带你去看海', t: Date.now() - 50000 }
    ];
    let extractCalls = 0;
    const extract = async () => {
      extractCalls++;
      return { nodes: [{ text: '她下周三考完口腔医学课', kind: 'plan', importance: 0.8, salience: 0.8 }], seed: '聊得来的朋友，最近一起盼着考完去看海' };
    };
    const r1 = await mind.afterTurn(key, {
      text: '下周三考完就解放了', reply: '考完带你去看海', nick: '好友A', kind: 'private', peer: { uin: 100000001 }, turns,
      affect: async () => ({ pad: { p: 0.6, a: 0.5, d: 0.2 }, salience: 0.8, relationEvents: ['plan', 'shared'], mood: '期待' }),
      extract
    });
    ok('afterTurn 更新了状态层', r1 && r1.state && r1.state.msgCount === 1, JSON.stringify(r1 && r1.state && r1.state.pad));
    ok('afterTurn 记下了情感（pad 已非零）', Math.abs(r1.state.pad.p) > 0.1, JSON.stringify(r1.state.pad));
    ok('关系事件生效（温暖/亲密上升）', r1.state.rel.warmth > 0.15 && r1.state.rel.intimacy > 0.05, JSON.stringify(r1.state.rel));
    const r2 = await mind.afterTurn(key, {
      text: '到时候别忘了', reply: '', nick: '好友A', kind: 'private', peer: { uin: 100000001 }, turns,
      affect: async () => ({ pad: { p: 0.4, a: 0.2, d: 0.1 }, salience: 0.5, relationEvents: [], mood: '期待' }),
      extract
    });
    ok('攒够轮数触发巩固', extractCalls >= 1 && r2.consolidate && r2.consolidate.added >= 1, JSON.stringify(r2.consolidate));
    ok('巩固写回关系种子', Boolean(r2.state.relSeed), String(r2.state.relSeed));
    ok('巩固后 pendingConsolidate 归零', r2.state.pendingConsolidate === 0, String(r2.state.pendingConsolidate));
    const trace = fs.readFileSync(mind.traceFile(key), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    ok('痕迹层记下了原始一条 + 情感 + 巩固', trace.some(x => x.type === 'turn') && trace.some(x => x.type === 'affect') && trace.some(x => x.type === 'consolidate'), trace.map(x => x.type).join(','));
    ok('痕迹里存了发出去的原文', trace.some(x => x.type === 'turn' && /看海/.test(x.text + x.reply)));
    const g2 = mind.loadGraph(key);
    ok('记忆图里有巩固抽出来的节点', g2.nodes.length >= 1 && g2.nodes.some(n => /口腔医学/.test(n.text)), JSON.stringify(g2.nodes.map(n => n.text)));
    const st2 = mind.loadState(key);
    ok('状态层可从磁盘重读（重启不失忆）', st2.msgCount === 2 && Math.abs(st2.pad.p) > 0.1, JSON.stringify(st2.pad));
  }

  // ⑪ 巩固修剪：只剪边，不删节点
  {
    const key = 't:prune';
    fresh(key);
    const g = mind.loadGraph(key);
    const a = mind.addNode(g, { text: '话题甲' });
    const b = mind.addNode(g, { text: '话题乙' });
    // 注意：link 对同类型同端点的边是「取较大权重」合并，所以低权重边要用另一种类型才建得出来
    const low = mind.link(g, a.node.id, b.node.id, 'causal', 0.05);
    low.at = Date.now() - 10 * 86400000;
    mind.saveGraph(g);
    const r = await mind.consolidate(key, { turns: [], extract: null });
    ok('低权重老边被修剪（读取路径变干净）', r.pruned >= 1, JSON.stringify(r));
    ok('节点没被删（痕迹层与记忆都还在）', mind.loadGraph(key).nodes.length === 2, String(mind.loadGraph(key).nodes.length));
  }

  // ⑫ promptBits：给模型的三段
  {
    const key = 't:bits';
    fresh(key);
    const g = mind.loadGraph(key);
    mind.addNode(g, { text: '她下周三考完口腔医学', kind: 'plan', salience: 0.8, pad: { p: 0.5, a: 0.3, d: 0.1 } });
    mind.saveGraph(g);
    const st = mind.loadState(key);
    st.pad = { p: 0.5, a: 0.3, d: 0.1 };
    st.relSeed = '聊得来的朋友，最近一起盼着考完';
    mind.saveState(st);
    const bits = mind.promptBits(key, '考试准备得怎么样');
    ok('promptBits 给得出心情', Boolean(bits.mood) && !/\d/.test(bits.mood), bits.mood);
    ok('promptBits 给得出关系', Boolean(bits.bond) && /朋友|熟|关系/.test(bits.bond), bits.bond);
    ok('promptBits 给得出回忆', Array.isArray(bits.memories) && bits.memories.some(m => /考试|口腔/.test(m)), JSON.stringify(bits.memories));
  }

  // ⑬ 空闲巩固 sweep：聊完散场后也会整理（脏数据不整理、没抽取器就跳过）
  {
    const store = require('./context.js');

    // 情况 A：「还有两轮没整理 + 已经静了 90 分钟」→ 该整理
    const key = 't:sweep';
    fresh(key);
    {
      const st = mind.blankState(key);
      st.pendingConsolidate = 2;
      st.lastTurnAt = Date.now() - 90 * 60000;
      mind.saveState(st);
    }
    // 情况 B：「刚还在聊」→ 别打断
    const busy = 't:sweep-busy';
    fresh(busy);
    {
      const st = mind.blankState(busy);
      st.pendingConsolidate = 3;
      st.lastTurnAt = Date.now() - 60 * 1000;
      mind.saveState(st);
    }
    const turnsOf = (k) => (k === key
      ? [
        { t: Date.now() - 100 * 60000, from: 'them', speaker: '她', text: '我下周三考完想去看海' },
        { t: Date.now() - 99 * 60000, from: 'me', speaker: '你', text: '考完就去，海风等着你' },
        { t: Date.now() - 95 * 60000, from: 'them', speaker: '她', text: '最近总失眠，口腔医学太卷了' },
        { t: Date.now() - 92 * 60000, from: 'me', speaker: '你', text: '早点睡，别熬太狠' }
      ]
      : []);
    const fakeExtract = async () => ({
      nodes: [
        { text: '她下周三考完想去看海', kind: 'plan', importance: 0.8, salience: 0.7 },
        { text: '她最近总失眠', kind: 'feeling', importance: 0.6, salience: 0.6 }
      ],
      seed: '约好考后去看海，她最近失眠'
    });

    const r1 = await mind.sweep({ extract: fakeExtract, turnsOf, idleMin: 45, maxSessions: 5 });
    ok('空闲巩固扫到了静下来的会话', r1.swept.some(x => x.key === key), JSON.stringify(r1));
    ok('巩固后待整理轮次清零', mind.loadState(key).pendingConsolidate === 0, String(mind.loadState(key).pendingConsolidate));
    ok('巩固抽出了记忆节点', mind.loadGraph(key).nodes.length >= 2, String(mind.loadGraph(key).nodes.length));
    ok('关系种子写回状态', /看海|失眠/.test(mind.loadState(key).relSeed || ''), mind.loadState(key).relSeed);
    let tr = '';
    try { tr = fs.readFileSync(mind.traceFile(key), 'utf8'); } catch (e) { tr = ''; }
    ok('痕迹里记下这次反刍', /"type":"sweep"/.test(tr), tr.split('\n').slice(-2).join(' | '));
    ok('正在聊的会话没被打断', !r1.swept.some(x => x.key === busy), JSON.stringify(r1.swept.map(x => x.key)));
    ok('正在聊的会话待整理轮次还在', mind.loadState(busy).pendingConsolidate === 3, String(mind.loadState(busy).pendingConsolidate));

    // 情况 C：没有抽取器 → 直接跳过，不做半截巩固
    const r2 = await mind.sweep({ turnsOf, idleMin: 45 });
    ok('没有抽取器就跳过（不写脏状态）', r2.skipped === 'no-extract', JSON.stringify(r2));
    // 情况 D：总开关关掉 → 完全不干活
    const r3 = await mind.sweep({ extract: fakeExtract, turnsOf, enabled: false });
    ok('关掉开关后巩固不跑', r3.skipped === 'disabled', JSON.stringify(r3));
    void store;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
