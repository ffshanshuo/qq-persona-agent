'use strict';
/**
 * 「真忙不秒回借口，先搁一会儿」自检　node scripts/test-busy-defer.js
 *   - focus（专注中）：普通消息先排期（日志 busy-defer），不调模型、不发送
 *   - light（在吃饭/散步）：照常立刻回
 *   - 带「急/在吗」等紧急词：不排期，照常回
 *   - busy.enabled=false：不排期
 *   - 同一条消息不会被重复排期
 *   - 注意：前面用例排的 timer 可能在本用例等待窗口内到点，所以「想了没有」用 >=1 断言，别用 ===1
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-'));
const dir = (n) => path.join(TMP, n);
for (const [k, n] of Object.entries({
  QQCTX_DIR: 'context', QQMIND_DIR: 'mind', QQECHO_DIR: 'echo', QQFOLLOW_DIR: 'follow', QQNICK_DIR: 'nick',
  QQQUOTE_DIR: 'quotes', QQTRACE_DIR: 'trace', QQPROMISE_DIR: 'promises', QQSELF_DIR: 'self', QQGROUP_DIR: 'group',
  QQLONGING_DIR: 'longing', QQBOND_DIR: 'bonds', QQMURMUR_DIR: 'murmur', QQTHEM_DIR: 'them', QQTIES_DIR: 'ties',
  QQPRESENCE_DIR: 'presence', QQFORWARD_DIR: 'forwards'
})) process.env[k] = dir(n);

const LOGF = path.join(TMP, 'autoreply.log');
const CFGF = path.join(TMP, 'autoreply.json');
process.env.BRAIN_CONFIG = path.join(__dirname, '..', 'config', 'brain.test-long.json');
process.env.AUTOREPLY_LOG = LOGF;
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.AUTOREPLY_CONFIG = CFGF;
delete process.env.AUTOREPLY_DRY;

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.test.json'), 'utf8'));
function writeCfg(patch) {
  const merged = JSON.parse(JSON.stringify(base));
  merged.private = { ...(merged.private || {}), enabled: true, allowList: [100000001] };
  merged.group = { ...(merged.group || {}), enabled: false };
  merged.selfId = 123456789;
  merged.stickers = { ...(merged.stickers || {}), enabled: false };
  merged.voice = { ...(merged.voice || {}), enabled: false };
  merged.murmur = { enabled: false };
  merged.hotChat = { enabled: false };   // 这个用例专测排期，别被「正聊着就秒回」抢掉
  merged.busy = { enabled: true, kinds: ['focus'], delayMin: [1, 1], urgentRe: "急|在吗|在不在|电话|马上|现在就|救命|快回" };
  for (const [k, v] of Object.entries(patch || {})) merged[k] = { ...(merged[k] || {}), ...v };
  fs.writeFileSync(CFGF, JSON.stringify(merged, null, 2));
}
writeCfg({});

const self = require('./self.js');
const qq = require('./qq.js');
let selfKind = 'focus';
self.state = () => ({ activity: '写代码', kind: selfKind, since: Date.now(), mins: 20 });

const calls = [];
qq.call = async (action, params) => {
  calls.push({ action, params });
  if (/^send_/.test(action)) return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  return { status: 'ok', retcode: 0, data: {} };
};

const ar = require('./auto-reply.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(extra)); }
}
function events(name) {
  try {
    return fs.readFileSync(LOGF, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((x) => x && x.event === name);
  } catch (e) { return []; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 900000;
function evt(text, extra) {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: 123456789, user_id: 100000001, time: Math.floor(Date.now() / 1000),
    message_id: ++seq, message: [{ type: 'text', data: { text } }], raw_message: text,
    ...(extra || {})
  };
}

(async () => {
  const thoughts = [];
  const brain = require('./brain.js');
  const realThink = brain.think;
  brain.think = async (ctx) => { thoughts.push(ctx); return { reply: '在呢。', stickerKey: '', voice: false }; };

  // ① focus 时普通消息 → 只排期
  writeCfg({ busy: { delayMin: [1, 1] } });
  calls.length = 0; thoughts.length = 0;
  let r = await ar.handle(evt('今天好累啊'));
  ok('忙的时候先排期（返回 deferred）', r && r.deferred === true, r);
  ok('排期时没调模型', thoughts.length === 0, thoughts.length);
  ok('排期时没发消息', calls.filter((c) => /^send_/.test(c.action)).length === 0, calls.length);
  const defer = events('busy-defer').slice(-1)[0];
  ok('日志记了 busy-defer 且带时长', defer && defer.mins === 1, defer);

  // ② 同一 message_id 不会再排一次（第二次直接走正常流程）
  const e2 = evt('你今天忙不忙');
  const r2a = await ar.handle(e2);
  ok('第一次排期', r2a && r2a.deferred === true, r2a);
  const r2b = await ar.handle(e2);
  ok('同一条不会重复排期', !(r2b && r2b.deferred), r2b);

  // ③ light（在吃饭/散步）→ 立刻回
  selfKind = 'light';
  calls.length = 0; thoughts.length = 0;
  const r3 = await ar.handle(evt('在干嘛呀'));
  ok('不忙时照常回，不排期', !(r3 && r3.deferred) && thoughts.length >= 1, { r3, thoughts: thoughts.length });
  ok('不忙时确实发出去了', calls.filter((c) => /^send_/.test(c.action)).length >= 1, calls);

  // ④ 紧急词 → 不排期
  selfKind = 'focus';
  thoughts.length = 0;
  const r4 = await ar.handle(evt('在吗，有点急事找你'));
  ok('带紧急词不排期', !(r4 && r4.deferred), r4);
  ok('紧急消息直接想了', thoughts.length >= 1, thoughts.length);

  // ⑤ 开关关掉 → 不排期
  writeCfg({ busy: { enabled: false } });
  thoughts.length = 0;
  const r5 = await ar.handle(evt('随便聊两句'));
  ok('busy.enabled=false 时正常回', !(r5 && r5.deferred) && thoughts.length >= 1, { r5, thoughts: thoughts.length });

  // ⑥ 排期到点后会真的走一遍（1 分钟太久，这里只验证 timer 已挂上：用极短延时再跑一次）
  writeCfg({ busy: { delayMin: [0.005, 0.005] }, hotChat: { enabled: false } }); // ≈0.3s
  calls.length = 0; thoughts.length = 0;
  const r6 = await ar.handle(evt('睡了吗'));
  ok('短延时也先排期', r6 && r6.deferred === true, r6);
  await sleep(3500); // 排期到点 → 思考 → 节奏等待 → 真正发出，给足时间
  ok('到点后真的回了', thoughts.length >= 1, thoughts.length);
  ok('到点后确实发了', calls.filter((c) => /^send_/.test(c.action)).length >= 1, calls.length);

  brain.think = realThink;
  console.log(`\ntest-busy-defer: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('test-busy-defer 崩了：' + ((e && e.stack) || e));
  process.exit(1);
});
