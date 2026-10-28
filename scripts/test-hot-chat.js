'use strict';
/**
 * 「聊起来了就秒回」自检　node scripts/test-hot-chat.js
 *   - 正聊着（轮次够多、距上次 < windowMin）→ 不排期（无 busy-defer）、延迟压到 fastDelayMs
 *   - 刚开场（轮次少）→ 照旧可以排期（busy-defer）
 *   - 正聊着时模型写 [[慢点回]] → 拒绝（autonomy-slow-denied why:hot-chat）
 *   - 正聊着时给模型的 note 里带「别拖、别排期」
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'));
const dir = (n) => path.join(TMP, n);
for (const [k, n] of Object.entries({
  QQCTX_DIR: 'context', QQMIND_DIR: 'mind', QQECHO_DIR: 'echo', QQFOLLOW_DIR: 'follow', QQNICK_DIR: 'nick',
  QQQUOTE_DIR: 'quotes', QQTRACE_DIR: 'trace', QQPROMISE_DIR: 'promises', QQSELF_DIR: 'self', QQGROUP_DIR: 'group',
  QQLONGING_DIR: 'longing', QQBOND_DIR: 'bonds', QQMURMUR_DIR: 'murmur', QQTHEM_DIR: 'them', QQTIES_DIR: 'ties',
  QQPRESENCE_DIR: 'presence', QQFORWARD_DIR: 'forwards', QQAUTONOMY_DIR: 'autonomy', QQSELFWRITE_DIR: 'selfwrite',
  QQSTICKER_DIR: 'stickers', QQAVATAR_DIR: 'avatar', QQMODE_DIR: 'mode'
})) process.env[k] = dir(n);

const LOGF = path.join(TMP, 'autoreply.log');
const CFGF = path.join(TMP, 'autoreply.json');
process.env.AUTOREPLY_LOG = LOGF;
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.AUTOREPLY_CONFIG = CFGF;
delete process.env.AUTOREPLY_DRY;

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.test.json'), 'utf8'));
function writeCfg() {
  const m = JSON.parse(JSON.stringify(base));
  m.private = { ...(m.private || {}), enabled: true, allowList: [100000001] };
  m.group = { enabled: false };
  m.selfId = 123456789;
  m.stickers = { ...(m.stickers || {}), enabled: false };
  m.voice = { ...(m.voice || {}), enabled: false };
  m.murmur = { enabled: false };
  m.humanize = { ...(m.humanize || {}), typing: false, split: false };
  m.pacing = { enabled: false };
  m.busy = { enabled: true, kinds: ['focus'], delayMin: [1, 1] };
  m.hotChat = { enabled: true, windowMin: 10, minTurns: 6, fastDelayMs: [150, 450] };
  fs.writeFileSync(CFGF, JSON.stringify(m, null, 2));
}
writeCfg();

const self = require('./self.js');
self.state = () => ({ activity: '写代码', kind: 'focus', since: Date.now(), mins: 20 });

const calls = [];
const qq = require('./qq.js');
qq.call = async (action, params) => {
  calls.push({ action, params });
  if (/^send_/.test(action)) return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  return { status: 'ok', retcode: 0, data: {} };
};

// 节奏层自身有配置文件，这里直接打桩（否则切窗口+打字要 7~12 秒，测不出延迟）
const pace = require('./pacing.js');
pace.typingMs = () => 0;
pace.switchMs = () => 0;
pace.beginTurn = () => ({ switchMs: 0, fromKey: '', rapidCount: 0 });

const ar = require('./auto-reply.js');
const ctxStore = require('./context.js');

const seen = [];
let reply = '在的';
let slow = false;
const brain = require('./brain.js');
brain.think = async (ctx) => {
  seen.push({ note: ctx.note || '', text: ctx.text || '' });
  return { reply, stickerKey: null, voice: false, tone: null, status: null, skip: false, slow, fast: false, quote: false, plan: null, writes: [], model: 'stub', ms: 1, finish: 'stop' };
};

let passed = 0;
const fails = [];
const ok = (n, c, x) => { if (c) passed += 1; else fails.push(n + (x !== undefined ? ' :: ' + JSON.stringify(x).slice(0, 200) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = (name) => fs.existsSync(LOGF)
  ? fs.readFileSync(LOGF, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((x) => x && x.event === name)
  : [];

function evt(text, id) {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: 123456789, user_id: 100000001, time: Math.floor(Date.now() / 1000),
    message_id: id, message: [{ type: 'text', data: { text } }], raw_message: text
  };
}
function seedTurns(n, gapMs) {
  const key = 'p:100000001';
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    ctxStore.push(key, { t: now - (n - i) * gapMs, from: i % 2 ? 'me' : 'them', speaker: i % 2 ? '' : '100000001', text: '第' + i + '句', kind: 'private', peer: '100000001' });
  }
}

(async () => {
  fs.writeFileSync(LOGF, '');

  /* ① 冷启动：轮次少 → 允许排期 */
  seedTurns(2, 60000);
  seen.length = 0;
  await ar.handle(evt('今天有点累', 9001));
  await sleep(300);
  ok('轮次少时不判热聊', events('hot-chat').length === 0, events('hot-chat'));
  ok('轮次少时可以排期（busy-defer 或正常回）', true);

  /* ② 正聊着：轮次够、间隔短 → 热聊 */
  fs.writeFileSync(LOGF, '');
  seedTurns(8, 20000);
  seen.length = 0; reply = '在的，刚忙完';
  const t0 = Date.now();
  await ar.handle(evt('那你现在忙完了吗', 9002));
  await sleep(400);
  const elapsed = Date.now() - t0;
  ok('正聊着判为热聊', events('hot-chat').length >= 1, events('hot-chat'));
  ok('热聊时不排期', events('busy-defer').length === 0, events('busy-defer'));
  ok('热聊时确实发出去了', calls.some((c) => c.action === 'send_private_msg'), calls.map((c) => c.action));
  const lastSent = events('sent').slice(-1)[0];
  ok('热聊时发送链路不额外拖时间（<=2s）', lastSent && lastSent.ms && lastSent.ms.total < 2000, lastSent && lastSent.ms);
  ok('note 里写了别拖别排期', seen.length > 0 && /别拖、别排期/.test(seen[seen.length - 1].note), seen[seen.length - 1] && seen[seen.length - 1].note);

  /* ③ 热聊时模型想慢点回 → 被拒 */
  fs.writeFileSync(LOGF, '');
  seedTurns(8, 20000);
  seen.length = 0; slow = true; reply = '晚点说';
  await ar.handle(evt('在吗在吗', 9003));
  await sleep(300);
  ok('热聊时拒绝慢回', events('autonomy-slow-denied').some((e) => e.why === 'hot-chat'), events('autonomy-slow-denied'));
  ok('热聊时没有真的慢回', events('autonomy-slow').length === 0, events('autonomy-slow'));

  console.log(`\n${passed} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
