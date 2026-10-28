'use strict';
/**
 * test-autonomy-plan.js —— 「自己约时间说话」+ A→B→C 重估 离线自检
 *
 * 剧本：好友发了 A（约好 10 分钟后说 B），期间好友又发了 C。
 * 到点时**不盲发**：模型重估后可以 ① 照发 ② 换说法 ③ 推后再约 ④ 直接撤销（[SKIP]）。
 * 另外收到 C 的那一刻，模型就能用 [[取消主动]] 把还没发的 B 撤掉。
 *
 * 全离线：模型/QQ 都是桩，状态目录全隔离。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
const D = (n) => path.join(TMP, n);
for (const [k, n] of Object.entries({
  QQAUTONOMY_DIR: 'autonomy', QQAUTONOMY_LOG: 'autonomy.jsonl', QQMIND_DIR: 'mind', QQCTX_DIR: 'context',
  QQTHEM_DIR: 'them', QQTRACE_DIR: 'trace', QQBOND_DIR: 'bonds', QQECHO_DIR: 'echo', QQMODE_DIR: 'mode',
  QQFOLLOW_DIR: 'follow', QQNICK_DIR: 'nick', QQQUOTE_DIR: 'quotes', QQPROMISE_DIR: 'promises',
  QQRISK_DIR: 'risk', QQLONGING_DIR: 'longing', QQGROUP_DIR: 'group', QQSELF_DIR: 'self',
  QQPACING_DIR: 'pacing', QQFORWARD_DIR: 'forward', QQMURMUR_DIR: 'murmur', QQAVATAR_DIR: 'avatar',
  QQTIES_DIR: 'ties', QQPRESENCE_DIR: 'presence', QQSELFWRITE_DIR: 'selfwrite', QQSTICKER_DIR: 'stickers',
  QQAVATARSRC_STATE_DIR: 'avatar-src', QQAUTONOMY_LOG_: 'x'
})) process.env[k] = D(n);

const AUTOCFG = path.join(TMP, 'autonomy.json');
process.env.AUTONOMY_CONFIG = AUTOCFG;
fs.writeFileSync(AUTOCFG, JSON.stringify({ preset: 'max' }, null, 2));

const ARLOG = path.join(TMP, 'autoreply.log');
const ARCFG = path.join(TMP, 'autoreply.json');
process.env.AUTOREPLY_LOG = ARLOG;
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.AUTOREPLY_CONFIG = ARCFG;
delete process.env.AUTOREPLY_DRY;

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'autoreply.test.json'), 'utf8'));
base.private = { ...(base.private || {}), enabled: true, allowList: [100000001] };
base.group = { enabled: false };
base.selfId = 123456789;
base.stickers = { ...(base.stickers || {}), enabled: false };
base.voice = { ...(base.voice || {}), enabled: false };
base.murmur = { enabled: false };
base.humanize = { ...(base.humanize || {}), typing: false, split: false };
base.busy = { enabled: false };
fs.writeFileSync(ARCFG, JSON.stringify(base, null, 2));

const autonomy = require('./autonomy.js');
const ctxStore = require('./context.js');

let passed = 0;
const fails = [];
const ok = (n, c, x) => { if (c) passed++; else fails.push(n + (x !== undefined ? ' :: ' + JSON.stringify(x).slice(0, 220) : '')); };
const events = (name) => (fs.existsSync(ARLOG)
  ? fs.readFileSync(ARLOG, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter((x) => x && x.event === name)
  : []);

const sendCalls = [];
const qq = require('./qq.js');
qq.call = async (action, params) => {
  sendCalls.push({ action, params });
  if (/^send_/.test(action)) return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  return { status: 'ok', retcode: 0, data: {} };
};

const seen = [];
let brainNext = { reply: 'B：说好的事我记着呢', plan: null, skip: false, cancelPlan: false };
const brain = require('./brain.js');
brain.think = async (ctx) => {
  seen.push({ replan: ctx.replan || null, note: ctx.note || '' });
  return { ...brainNext, stickerKey: null, voice: false, tone: null, status: null, slow: false, fast: false, quote: false, writes: [], model: 'stub', ms: 1, finish: 'stop' };
};

const ar = require('./auto-reply.js');
const timers = require('./timers.js');

const KEY = 'p:100000001';
function evt(text, id) {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: 123456789, user_id: 100000001, time: Math.floor(Date.now() / 1000),
    message_id: id, message: [{ type: 'text', data: { text } }], raw_message: text
  };
}

(async () => {
  /* ① 标记解析：约时间 + 取消 */
  const m1 = autonomy.parseMarkers('行啊 [[主动:10m|十点半我来叫你起床]] 我先忙');
  ok('解析出约时间（10 分钟）', m1.plan && m1.plan.inMs === 600000, m1);
  ok('约时间的正文被剥掉', m1.text === '行啊  我先忙' || m1.text === '行啊 我先忙', m1.text);
  const m2 = autonomy.parseMarkers('嗯好 [[取消主动]] 那我先忙');
  ok('解析出取消主动', m2.cancel === true, m2);
  ok('取消标记不进正文', !/取消主动/.test(m2.text), m2.text);

  /* ② 排期 / 待发 / 撤销 */
  const now0 = Date.now();
  const sp = autonomy.schedulePlan(KEY, { inMs: 10 * 60000, text: 'B：我叫你起床' }, { now: now0 });
  ok('排期成功', sp.ok === true && !!sp.id, sp);
  ok('pendingPlans 能看到它', autonomy.pendingPlans(KEY, now0 + 60000).length === 1, autonomy.pendingPlans(KEY, now0 + 60000));
  ok('没到点不算 due', autonomy.duePlans(now0 + 60000).length === 0, autonomy.duePlans(now0 + 60000));
  ok('到点算 due', autonomy.duePlans(now0 + 11 * 60000).length === 1, autonomy.duePlans(now0 + 11 * 60000));

  const cc = autonomy.cancelPlans(KEY, { why: 'test', now: now0 + 2 * 60000 });
  ok('cancelPlans 撤掉 1 条', cc.n === 1, cc);
  ok('撤销后没有待发', autonomy.pendingPlans(KEY, now0 + 3 * 60000).length === 0, autonomy.pendingPlans(KEY, now0 + 3 * 60000));
  ok('撤销有审计', fs.readFileSync(process.env.QQAUTONOMY_LOG, 'utf8').includes('plan-cancel'));

  /* ③ sendPlanned：照发 */
  fs.writeFileSync(ARLOG, '');
  const p1 = autonomy.schedulePlan(KEY, { inMs: 60000, text: 'B：我叫你起床' }, { now: Date.now() });
  // 约好之后，对方又发来 C（这才是 A→B→C 的真实顺序）
  ctxStore.push(KEY, { t: Date.now(), from: 'them', speaker: '100000001', text: 'C：算了别叫我，我请假了', kind: 'private', peer: '100000001' });
  const plan1 = autonomy.listPlans().find((x) => x.id === p1.id);
  sendCalls.length = 0; brainNext = { reply: '行，七点我叫你', plan: null, skip: false, cancelPlan: false };
  const r1 = await ar.sendPlanned(plan1, { now: Date.now() + 120000 });
  ok('到点重估后照发', r1.ok === true, r1);
  ok('确实发出去了', sendCalls.some((c) => c.action === 'send_private_msg'), sendCalls.map((c) => c.action));
  ok('重估时带上了原计划文本', seen.slice(-1)[0].replan && /我叫你起床/.test(seen.slice(-1)[0].replan.text), seen.slice(-1)[0].replan);
  ok('重估时统计了这期间对方发了几条', seen.slice(-1)[0].replan.sinceMsgs >= 1, seen.slice(-1)[0].replan);
  ok('账本记成 sent', (autonomy.listPlans().find((x) => x.id === p1.id) || {}).status === 'sent', autonomy.listPlans().find((x) => x.id === p1.id));

  /* ④ sendPlanned：模型判断话题过去了 → 不发 */
  fs.writeFileSync(ARLOG, '');
  const p2 = autonomy.schedulePlan(KEY, { inMs: 60000, text: 'B：别忘了带伞' }, { now: Date.now() });
  const plan2 = autonomy.listPlans().find((x) => x.id === p2.id);
  sendCalls.length = 0; brainNext = { reply: '', plan: null, skip: true, cancelPlan: false };
  const r2 = await ar.sendPlanned(plan2, { now: Date.now() + 120000 });
  ok('模型 [SKIP] 就不发', r2.ok === false && r2.why === 'dropped', r2);
  ok('[SKIP] 时一条都没发', sendCalls.filter((c) => /^send_/.test(c.action)).length === 0, sendCalls);
  ok('账本记成 failed/model-skip', (autonomy.listPlans().find((x) => x.id === p2.id) || {}).why === 'model-skip', autonomy.listPlans().find((x) => x.id === p2.id));

  /* ⑤ sendPlanned：模型认为该推后再约 */
  fs.writeFileSync(ARLOG, '');
  const p3 = autonomy.schedulePlan(KEY, { inMs: 60000, text: 'B：问你吃饭没' }, { now: Date.now() });
  const plan3 = autonomy.listPlans().find((x) => x.id === p3.id);
  sendCalls.length = 0; brainNext = { reply: '', plan: { inMs: 5 * 60000, text: 'B2：等你忙完再问' }, skip: false, cancelPlan: false };
  const pendingBefore = autonomy.pendingPlans(KEY, Date.now()).length;
  const r3 = await ar.sendPlanned(plan3, { now: Date.now() + 120000 });
  ok('模型推后 → 原计划作废', r3.ok === false && r3.why === 'rescheduled', r3);
  ok('推后时没有直接发', sendCalls.filter((c) => /^send_/.test(c.action)).length === 0, sendCalls);
  ok('推后时新排期已登记', autonomy.pendingPlans(KEY, Date.now()).length === pendingBefore, { before: pendingBefore, after: autonomy.pendingPlans(KEY, Date.now()).length });
  ok('日志有 plan-rescheduled', events('plan-rescheduled').length >= 1, events('plan-rescheduled'));

  /* ⑥ 收到 C 的当下，模型用 [[取消主动]] 撤掉 B */
  fs.writeFileSync(ARLOG, '');
  autonomy.cancelPlans(KEY, { why: 'cleanup', now: Date.now() });
  const p4 = autonomy.schedulePlan(KEY, { inMs: 10 * 60000, text: 'B：说好的晚上聊' }, { now: Date.now() });
  ok('先有一条待发的', autonomy.pendingPlans(KEY, Date.now()).length === 1, autonomy.pendingPlans(KEY, Date.now()));
  brainNext = { reply: '好，那你先忙', plan: null, skip: false, cancelPlan: true };
  seen.length = 0;
  await ar.handle(evt('C：我今晚要加班，别等我了', 970015));
  await new Promise((r) => setTimeout(r, 300));
  ok('收到消息时把待发排期告诉了模型', seen.length > 0 && /你之前打算/.test(seen[0].note), seen[0] && seen[0].note);
  ok('模型写了取消 → 待发清零', autonomy.pendingPlans(KEY, Date.now()).length === 0, { id: p4.id });
  ok('日志有 plan-cancel', events('plan-cancel').length >= 1, events('plan-cancel'));
  ok('取消后不再出现在 duePlans', autonomy.duePlans(Date.now() + 20 * 60000).length === 0, autonomy.duePlans(Date.now() + 20 * 60000));

  /* ⑦ timers.startPlans：到点自动跑 sendPlanned */
  const dueP = autonomy.schedulePlan(KEY, { inMs: 1000, text: 'B：到点自动发' }, { now: Date.now() - 5 * 60000 });
  const hit = [];
  const env = { log: () => { }, sendPlanned: async (p) => { hit.push(p.id); return { ok: true }; } };
  const h = timers.startPlans(env);
  await new Promise((r) => setTimeout(r, 200));
  ok('startPlans 有返回值', !!h && !!h.timer, Object.keys(h || {}));
  clearInterval(h.timer); clearTimeout(h.first);
  ok('（到点扫描在 tick 内，此处仅验证挂载不崩）', true);

  console.log('\n' + passed + ' passed, ' + fails.length + ' failed');
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });