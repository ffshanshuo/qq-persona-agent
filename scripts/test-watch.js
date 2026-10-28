'use strict';
/**
 * test-watch.js —— 「反复盯着消息看」（watch.js）离线自检
 *
 * 覆盖：话头识别（我问了没回 / TA 问了没下文 / 闲聊不算）、闸门（太早/太晚/已追过/冷却/每天上限/免打扰/开关）、
 *       账本落盘、给普通回复用的提示、扫描挑人、以及真正调一次 sendWatchFollowUp（模型/QQ 都是桩）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
const D = (n) => path.join(TMP, n);
for (const k of ['QQWATCH_DIR', 'QQAUTONOMY_DIR', 'QQAUTONOMY_LOG', 'QQMIND_DIR', 'QQCTX_DIR', 'QQTHEM_DIR',
  'QQTRACE_DIR', 'QQBOND_DIR', 'QQECHO_DIR', 'QQMODE_DIR', 'QQFOLLOW_DIR', 'QQNICK_DIR', 'QQQUOTE_DIR',
  'QQPROMISE_DIR', 'QQRISK_DIR', 'QQLONGING_DIR', 'QQGROUP_DIR', 'QQSELF_DIR', 'QQPACING_DIR', 'QQFORWARD_DIR',
  'QQMURMUR_DIR', 'QQAVATAR_DIR', 'QQTIES_DIR', 'QQPRESENCE_DIR', 'QQSELFWRITE_DIR', 'QQSTICKER_DIR']) {
  process.env[k] = D(k);
}
const ARLOG = path.join(TMP, 'autoreply.log');
process.env.AUTOREPLY_LOG = ARLOG;
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
const ARCFG = path.join(TMP, 'autoreply.json');
process.env.AUTOREPLY_CONFIG = ARCFG;
process.env.BRAIN_CONFIG = path.join(__dirname, '..', 'config', 'brain.test-long.json');
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
base.hotChat = { enabled: false };
base.watch = { enabled: true };
fs.writeFileSync(ARCFG, JSON.stringify(base, null, 2));

const watch = require('./watch.js');
const ctxStore = require('./context.js');
const timers = require('./timers.js');

let pass = 0;
const fails = [];
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fails.push(n); console.log('FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 200) : '')); } };
const T0 = new Date(2026, 9, 27, 15, 0, 0).getTime();
const MIN = 60000;

const KEY = 'p:100000001';
const turn = (from, text, at) => ({ t: at, from, text, speaker: from === 'me' ? '' : '100000001', at: new Date(at).toISOString() });

/* ① 话头识别 */
let h = [turn('them', '你吃饭了吗', T0 - 3 * 60 * MIN), turn('me', '其实我想问问你周末有空吗', T0 - 40 * MIN)];
let th = watch.detect(KEY, { history: h });
ok('我问了 TA 没接 → my-q', th && th.kind === 'my-q', th);

h = [turn('me', '早', T0 - 3 * 60 * MIN), turn('them', '你觉得这个应该怎么办呀', T0 - 40 * MIN)];
th = watch.detect(KEY, { history: h });
ok('TA 问了没下文 → their-q', th && th.kind === 'their-q', th);

h = [turn('me', '嗯', T0 - 3 * 60 * MIN), turn('them', '帮我看看这行报错', T0 - 30 * MIN)];
th = watch.detect(KEY, { history: h });
ok('TA 的求助也算悬着的话头', th && th.kind === 'their-q', th);

h = [turn('them', '今天下班好早', T0 - 30 * MIN), turn('me', '挺好，晚上吃点好的', T0 - 29 * MIN)];
ok('闲聊不算话头', watch.detect(KEY, { history: h }) === null, watch.detect(KEY, { history: h }));

h = [turn('them', '好', T0 - 30 * MIN)];
ok('单字/无意义的话不算', watch.detect(KEY, { history: h }) === null);

/* ② 闸门 */
h = [turn('me', '你周末有空吗', T0 - 5 * MIN)];
ok('刚问 5 分钟（minIdleMin:20）→ 太早', watch.due(KEY, { history: h, now: T0, cfg: { minIdleMin: 20 } }).why === 'too-soon', watch.due(KEY, { history: h, now: T0, cfg: { minIdleMin: 20 } }));
ok('minIdleMin:5 + 悬 5 分钟 → 可以动', watch.due(KEY, { history: h, now: T0, cfg: { minIdleMin: 5, perKeyCooldownMin: 0, dailyMax: 0, maxTriesPerItem: 0 } }).ok === true, watch.due(KEY, { history: h, now: T0, cfg: { minIdleMin: 5 } }));
h = [turn('me', '你周末有空吗', T0 - 30 * MIN)];
ok('问完 30 分钟没动静 → 可以追', watch.due(KEY, { history: h, now: T0 }).ok === true, watch.due(KEY, { history: h, now: T0 }));
h = [turn('me', '你周末有空吗', T0 - 48 * 60 * MIN)];
ok('隔了两天 + maxIdleMin:720 → 太晚，不翻旧账', watch.due(KEY, { history: h, now: T0, cfg: { maxIdleMin: 720 } }).why === 'too-late', watch.due(KEY, { history: h, now: T0, cfg: { maxIdleMin: 720 } }));
ok('maxIdleMin:0 → 多久都还能追', watch.due(KEY, { history: h, now: T0, cfg: { maxIdleMin: 0, perKeyCooldownMin: 0, dailyMax: 0, maxTriesPerItem: 0 } }).ok === true, watch.due(KEY, { history: h, now: T0, cfg: { maxIdleMin: 0 } }));

const d1 = watch.due(KEY, { history: h_ok(), now: T0 });
ok('可追时会带上 idleMin', d1.ok && d1.item.idleMin >= 20, d1);
watch.markFollowed(KEY, d1.item, { now: T0 });
ok('追过之后（maxTriesPerItem:1）不再追同一条', watch.due(KEY, { history: h_ok(), now: T0 + 10 * MIN, cfg: { maxTriesPerItem: 1, perKeyCooldownMin: 0, dailyMax: 0 } }).why === 'already-followed', watch.due(KEY, { history: h_ok(), now: T0 + 10 * MIN, cfg: { maxTriesPerItem: 1 } }));
ok('maxTriesPerItem:0 → 同一条还能再追', watch.due(KEY, { history: h_ok(), now: T0 + 10 * MIN, cfg: { maxTriesPerItem: 0, perKeyCooldownMin: 0, dailyMax: 0 } }).ok === true, watch.due(KEY, { history: h_ok(), now: T0 + 10 * MIN, cfg: { maxTriesPerItem: 0 } }));

// 冷却：换一个新话头，但刚追过
const h2 = [turn('me', '那你后来去成海边了吗', T0 - 25 * MIN)];
const d2 = watch.due(KEY, { history: h2, now: T0 + 20 * MIN });
ok('同会话冷却中不追（perKeyCooldownMin:180）', watch.due(KEY, { history: h2, now: T0 + 20 * MIN, cfg: { perKeyCooldownMin: 180 } }).why === 'cooldown', d2);
ok('perKeyCooldownMin:0 → 不受冷却限制', watch.due(KEY, { history: h2, now: T0 + 20 * MIN, cfg: { perKeyCooldownMin: 0, dailyMax: 0, maxTriesPerItem: 0 } }).ok === true);

// 免打扰
const h3 = [turn('me', '你睡了吗', T0 - 40 * MIN)];
const dq = watch.due(KEY, { history: h3, now: new Date(2026, 9, 28, 2, 0, 0).getTime(), cfg: { quietHours: [23, 8] } });
ok('配了免打扰就压住', dq.why === 'quiet', dq);

// 每天上限
const stUp = watch.load(KEY);
stUp.dayKey = '2026-10-27';
stUp.dayCount = 99;
watch.save(KEY, stUp);
ok('每天上限到了就停（dailyMax:8）', watch.due(KEY, { history: h3, now: T0 + 5 * 60 * MIN, cfg: { dailyMax: 8, perKeyCooldownMin: 0 } }).why === 'daily-cap', watch.due(KEY, { history: h3, now: T0 + 5 * 60 * MIN, cfg: { dailyMax: 8 } }));
ok('dailyMax:0 → 不设每日上限', watch.due(KEY, { history: h3, now: T0 + 5 * 60 * MIN, cfg: { dailyMax: 0, perKeyCooldownMin: 0, maxTriesPerItem: 0 } }).ok === true, watch.due(KEY, { history: h3, now: T0 + 5 * 60 * MIN, cfg: { dailyMax: 0 } }));

ok('总开关关掉', watch.due(KEY, { history: h3, now: T0 + 5 * 60 * MIN, cfg: { enabled: false } }).why === 'disabled');

function h_ok() { return [turn('me', '你周末有空吗', T0 - 40 * MIN)]; }

/* ③ 账本落盘 */
const st = watch.load(KEY);
ok('账本落盘了（有已追过的条目）', st.items.some(x => x.followed), st.items);
watch.reset(KEY);
ok('reset 清空账本', watch.load(KEY).items.length === 0);

/* ④ 给普通回复用的提示 */
const hist = [turn('them', '我到家了', T0 - 50 * MIN), turn('me', '路上顺利吗', T0 - 45 * MIN), turn('them', '挺快的', T0 - 44 * MIN)];
ok('我问的话已被回答 → 不提示', watch.noteFor(KEY, { history: hist, now: T0 }) === null, watch.noteFor(KEY, { history: hist, now: T0 }));
const hist2 = [turn('me', '你周末有空吗', T0 - 45 * MIN), turn('them', '嗯嗯', T0 - 44 * MIN)];
const n2 = watch.noteFor(KEY, { history: hist2, now: T0 });
ok('TA 只是应了一声 → 提示把话接回来', !!n2 && /你之前问过/.test(n2), n2);

/* ⑤ 扫描挑人 */
const sessions = [
  { key: KEY, idleMin: 45 },
  { key: 'g:200000001', idleMin: 45 },
  { key: 'p:100000001', idleMin: 3 }
];
const sc = watch.scan({
  sessions, now: T0, 
  historyOf: (k) => (k === KEY ? [turn('me', '你周末有空吗', T0 - 45 * MIN)] : (k === 'g:200000001' ? [turn('me', '有人吗？', T0 - 45 * MIN)] : [turn('me', '在吗', T0 - 3 * MIN)]))
});
ok('扫描只挑私聊里到点的那个', sc.list.length === 1 && sc.list[0].key === KEY, sc.list);

/* ⑥ 真正追一次（模型/QQ 都是桩） */
const sendCalls = [];
const qq = require('./qq.js');
qq.call = async (action, params) => {
  sendCalls.push({ action, params });
  if (/^send_/.test(action)) return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  if (action === 'get_stranger_info') return { status: 'ok', data: { nickname: '好友A' } };
  return { status: 'ok', retcode: 0, data: {} };
};
const brain = require('./brain.js');
let seenCtx = null;
brain.think = async (ctx) => { seenCtx = ctx; return { reply: '那周末到底去不去海边，你说个准话', stickerKey: '', voice: false, model: 'stub', ms: 1 }; };
const ar = require('./auto-reply.js');

const item = { kind: 'my-q', text: '你周末有空吗', idleMin: 45, at: T0 - 45 * MIN, id: 'my-q|你周末有空吗' };

(async () => {
  const r = await ar.sendWatchFollowUp(KEY, item, { dry: true });
  ok('dry 下也能走通', r.ok === true && r.dry === true, r);
  ok('dry 不记账', watch.load(KEY).items.filter(x => x.followed).length === 0, watch.load(KEY).items);
  ok('提示词里带了原话与别催的纪律', !!seenCtx && /你周末有空吗/.test(seenCtx.note) && /别质问/.test(seenCtx.note), seenCtx && seenCtx.note.slice(0, 120));

  sendCalls.length = 0;
  const r2 = await ar.sendWatchFollowUp(KEY, item, { dry: false });
  ok('真发成功', r2.ok === true && r2.dry === false, r2);
  ok('确实调了发送', sendCalls.some(c => c.action === 'send_private_msg'), sendCalls.map(c => c.action));
  ok('真发之后记账', watch.load(KEY).items.some(x => x.followed && x.why === 'sent'), watch.load(KEY).items);

  // 模型回 [SKIP] → 不发但记账（不反复催）
  watch.reset(KEY);
  brain.think = async () => ({ reply: '', stickerKey: '', voice: false });
  sendCalls.length = 0;
  const r3 = await ar.sendWatchFollowUp(KEY, { ...item, id: 'my-q|别的' }, { dry: false });
  ok('模型说 [SKIP] 就不发', r3.ok === false && r3.why === 'model-skip', r3);
  ok('[SKIP] 也记账（别反复催）', watch.load(KEY).items.some(x => x.followed && x.why === 'model-skip'), watch.load(KEY).items);

  // timers 挂载
  const hdl = timers.startWatch({ log: () => { }, watchSettings: () => ({ enabled: true, checkEveryMin: 5 }), sendWatchFollowUp: async () => ({ ok: true }) });
  ok('startWatch 返回定时器', !!hdl && typeof hdl === 'object', Object.keys(hdl || {}));
  if (hdl && hdl.timer) clearInterval(hdl.timer);

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) console.log('失败项：' + fails.join(' / '));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  process.exit(fails.length ? 1 : 0);
})();
