/**
 * test-them.js —— 「TA 现在的状态」自检（全离线）
 *
 * 背景（用户 2026-10-24 指出）：对方已说「我去眯一会儿」，回复却是
 *   「好，那你忙你的，七点我准时叫你～」—— 前后对不上。
 *
 * 覆盖：
 *   A. 状态识别：睡/洗澡/吃饭/上课/上班/出门/生病、时间窗、取最近一条
 *   B. 矛盾判定：对「去睡」说「你忙你的」= 矛盾；对「在加班」说「你忙你的」= 不矛盾
 *   C. 接线：note 里带上状态；矛盾命中 → 重写一次 → 发出去的是重写版
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

for (const k of ['QQMIND_DIR', 'QQTRACE_DIR', 'QQCTX_DIR', 'QQPROMISE_DIR', 'QQBOND_DIR', 'QQLONGING_DIR', 'QQGROUP_DIR', 'QQSELF_DIR', 'QQPACING_DIR', 'QQRISK_DIR']) {
  process.env[k] = path.join(ROOT, 'logs', 'them-test-' + k.toLowerCase());
}
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-them-test');
process.env.QQTHEM_DIR = path.join(ROOT, 'logs', 'them-them-test');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-them-test.log');
process.env.AUTOREPLY_STATE = path.join(ROOT, 'logs', 'autoreply-them-state.json');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const now = Date.now();
const mk = (text, minAgo = 2) => ({ t: now - minAgo * 60000, from: 'them', text });

(async () => {
  const them = require('./them.js');

  // ── A. 状态识别 ───────────────────────────────────────────────
  const a1 = them.observe({ history: [mk('我去眯一会儿，困了')] }, { now });
  ok('去睡 → kind=sleep', a1.hit && a1.hit.id === 'sleep', a1.hit);
  ok('提示里说在休息、别当成在工作', /休息|睡/.test(a1.line) && /别.*忙/.test(a1.line), a1.line);
  ok('提示带原话', /眯一会儿/.test(a1.line), a1.line);

  ok('去洗澡 → wash', them.observe({ history: [mk('我去洗个澡')] }, { now }).hit.id === 'wash');
  ok('去吃饭 → meal', them.observe({ history: [mk('先去吃饭了')] }, { now }).hit.id === 'meal');
  ok('上课 → class', them.observe({ history: [mk('等下上课，先不聊')] }, { now }).hit.id === 'class');
  ok('加班 → work', them.observe({ history: [mk('今天加班到十点')] }, { now }).hit.id === 'work');
  ok('出门 → out', them.observe({ history: [mk('出门了，在路上')] }, { now }).hit.id === 'out');
  ok('生病 → sick', them.observe({ history: [mk('今天头疼得厉害')] }, { now }).hit.id === 'sick');

  const none = them.observe({ history: [mk('哈哈哈哈')] }, { now });
  ok('没有状态词 → 不提示', none.hit === null && none.line === '', none);

  const stale = them.observe({ history: [mk('我去眯一会儿', 200)] }, { now });
  ok('2 小时前说的 → 过期不提示（freshMin 90）', stale.hit === null, stale.hit);

  const multi = them.observe({ history: [mk('我去洗澡', 30), mk('洗完啦，我眯一会儿', 3)] }, { now });
  ok('多条时取最近一条', multi.hit.id === 'sleep' && multi.hit.minAgo <= 3, multi.hit);

  const mine = them.observe({ history: [{ t: now, from: 'me', text: '我去眯一会儿' }] }, { now });
  ok('我自己说要睡 → 不当作 TA 的状态', mine.hit === null, mine.hit);

  const fromSum = them.observe({ history: [], summary: '她说明天要早起，八点出门上班。' }, { now });
  ok('原文被摘要吞掉 → 从 summary 里兜底认出状态', fromSum.hit && fromSum.hit.id === 'out' || fromSum.hit && fromSum.hit.id === 'work', fromSum.hit);

  const off = them.observe({ history: [mk('我去眯一会儿')] }, { now, cfg: { enabled: false } });
  ok('开关关闭 → 不提示', off.hit === null, off);

  // ── B. 矛盾判定 ───────────────────────────────────────────────
  const c1 = them.conflicts('好，那你忙你的，七点我准时叫你～', a1);
  ok('对「去睡」说「你忙你的」→ 矛盾', c1.bad === true, c1);
  ok('矛盾说明指出具体词', /你忙你的|忙/.test(c1.why), c1.why);
  ok('纠正提示要求只输出一句', /只输出这一句/.test(c1.fix), c1.fix);

  const work = them.observe({ history: [mk('今天加班到十点')] }, { now });
  const c2 = them.conflicts('好，那你忙你的，弄完早点休息', work);
  ok('对「在加班」说「你忙你的」→ 不矛盾', c2.bad === false, c2);

  const c3 = them.conflicts('行，那你眯一会儿，我七点叫你', a1);
  ok('顺着睡的回复 → 不矛盾', c3.bad === false, c3);

  const c4 = them.conflicts('随便吧。', a1);
  ok('无关回复 → 不误判', c4.bad === false, c4);

  // ── C. 接线：note 注入 + 矛盾重写 ─────────────────────────────
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.ctx-test.json'), 'utf8'));
  raw.enabled = true;
  raw.private = Object.assign({}, raw.private, { enabled: true, allowList: [100000001] });
  raw.group = Object.assign({}, raw.group, { enabled: false });
  raw.limits = { perContactPerHour: 0, globalPerHour: 0 };
  raw.delayMs = [1, 1];
  raw.mind = Object.assign({}, raw.mind, { enabled: false });
  raw.promises = Object.assign({}, raw.promises, { enabled: false });
  raw.voice = Object.assign({}, raw.voice, { enabled: false });
  raw.stickers = Object.assign({}, raw.stickers, { enabled: false });
  raw.pacing = { enabled: false };
  raw.context = Object.assign({}, raw.context, { warmup: false, idleMinutes: 0 });
  raw.them = { enabled: true };
  const tmpCfg = path.join(ROOT, 'logs', 'them-test-config.json');
  fs.writeFileSync(tmpCfg, JSON.stringify(raw, null, 2));
  process.env.AUTOREPLY_CONFIG = tmpCfg;

  const qq = require('./qq.js');
  const calls = [];
  qq.call = async (action, params) => { calls.push({ action, params }); return { status: 'ok', retcode: 0, data: {} }; };

  const ctxStore = require('./context.js');
  const KEY = 'p:100000001';
  // 上下文里先有对方「去眯一会儿」
  ctxStore.push(KEY, { t: now - 4 * 60000, from: 'them', speaker: '好友A', text: '我去眯一会儿，七点还得起来' });
  ctxStore.push(KEY, { t: now - 2 * 60000, from: 'me', text: '行' });

  // 模拟真实链路：对方那句到的时候，them.note 就已经把它记下来了（抗摘要压缩）
  them.note(KEY, '我去眯一会儿，七点还得起来', now - 4 * 60000);

  const brain = require('./brain.js');
  const replies = ['好，那你忙你的，七点我准时叫你～', '行，那你眯一会儿，七点我准时叫你～'];
  let thinkN = 0;
  const notes = [];
  const themStates = [];
  brain.think = async (ctx) => {
    notes.push(String((ctx && ctx.note) || ''));
    themStates.push(String((ctx && ctx.themState) || ''));
    const reply = replies[Math.min(thinkN, replies.length - 1)];
    thinkN++;
    return { reply, model: 'stub', ms: 1, finish: 'stop', messages: [] };
  };

  const ar = require('./auto-reply.js');
  const evt = {
    post_type: 'message', message_type: 'private', self_id: 123456789,
    user_id: 100000001, time: Math.floor(Date.now() / 1000), message_id: 7101,
    raw_message: '起来叫我哈', message: [{ type: 'text', data: { text: '起来叫我哈' } }],
    sender: { user_id: 100000001, nickname: '好友A' }
  };

  try { await ar.handle(evt); } catch (e) { console.log('handle error:', e && e.stack); }

  const log = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  const dry = log.split(/\n/).filter(l => l.includes('dry-send'));
  const lastDry = dry.length ? dry[dry.length - 1] : '';

  ok('识别到状态（them-state 日志）', /"event":"them-state"/.test(log), log.slice(-400));
  ok('状态进了 prompt（ctx.themState）', themStates.some(s => /眯一会儿|休息/.test(s)), themStates);
  ok('矛盾被拦下（them-retry）', /"event":"them-retry"/.test(log));
  ok('重写了（them-rewrote）', /"event":"them-rewrote"/.test(log));
  ok('think 被调用两次', thinkN === 2, thinkN);
  ok('发出去的是重写版（含「眯一会儿」）', /眯一会儿/.test(lastDry), lastDry);
  ok('矛盾的「你忙你的」没有发出去', !/你忙你的/.test(lastDry), lastDry);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
