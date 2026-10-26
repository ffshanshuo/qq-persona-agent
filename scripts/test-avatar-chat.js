#!/usr/bin/env node
'use strict';
/**
 * test-avatar-chat.js —— 「聊天里换头像」离线自检（真实图片池版）
 *
 * 语义（2026-10-24 用户改口径后）：
 *   「换个头像」→ 从图片池挑一张（网上找的 / 别人发的）换上，回「换好了，用的是…」
 *   不再有月亮脸款式；次数限制解除（minGapDays/maxPerMonth/cooldownMin 默认 0）
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const T = (p) => path.join(ROOT, 'logs', p);

process.env.QQAVATAR_DIR = T('avatar-chat-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-avatar-chat-test';
process.env.QQAVATAR_OUT = path.join(ROOT, 'assets', 'avatars-chat-test');
process.env.QQAVATAR_SRC_DIR = T('avatar-src-chat-test');
process.env.QQAVATARSRC_STATE_DIR = T('avatar-src-state-chat-test');
process.env.QQAVATAR_CONFIG = path.join(ROOT, 'config', 'avatar.chat-test.json');
process.env.QQRISK_DIR = T('risk-avatar-chat-test');
process.env.QQCTX_DIR = T('context-avatar-chat-test');
process.env.QQMIND_DIR = T('mind-avatar-chat-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-avatar-chat-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-avatar-chat-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-avatar-chat-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQTRACE_DIR = T('trace-avatar-chat-test');
process.env.QQTHEM_DIR = T('them-avatar-chat-test');
process.env.QQECHO_DIR = T('echo-avatar-chat-test');
process.env.QQPROMISE_DIR = T('promises-avatar-chat-test');
process.env.QQLONGING_DIR = T('longing-avatar-chat-test');
process.env.QQGROUP_DIR = T('group-avatar-chat-test');
process.env.QQSELF_DIR = T('self-avatar-chat-test');
process.env.QQPACING_DIR = T('pacing-avatar-chat-test');
process.env.QQBOND_DIR = T('bonds-avatar-chat-test');
process.env.AUTOREPLY_LOG = T('autoreply-avatar-chat-test.log');
process.env.AUTOREPLY_STATE = T('autoreply-avatar-chat-test-state.json');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.avatar-chat-test.json');

const fs = require('fs');
fs.mkdirSync(path.dirname(process.env.QQAVATAR_CONFIG), { recursive: true });
const AR_CFG = (() => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.test.json'), 'utf8'));
  c.selfId = 123456789;
  c.private = { ...(c.private || {}), allowList: [100000001] };
  c.group = { ...(c.group || {}), enabled: false };
  c.limits = { perContactPerHour: 0, globalPerHour: 0 };
  c.delayMs = [10, 20];
  c.llm = { enabled: false };
  c.mind = { enabled: false };
  c.stickers = { enabled: false, analyzeIncoming: false };
  c.voice = { enabled: false };
  c.merge = { enabled: true, windowMs: 200, maxMs: 800, maxMerge: 6 };
  return c;
})();

function cleanup() {
  for (const d of [process.env.QQAVATAR_DIR, process.env.QQAVATAR_OUT, process.env.QQAVATAR_SRC_DIR, process.env.QQAVATARSRC_STATE_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  for (const k of ['QQRISK_DIR', 'QQCTX_DIR', 'QQMIND_DIR', 'QQTRACE_DIR', 'QQTHEM_DIR', 'QQECHO_DIR', 'QQPROMISE_DIR', 'QQLONGING_DIR', 'QQGROUP_DIR', 'QQSELF_DIR', 'QQPACING_DIR', 'QQBOND_DIR']) {
    try { fs.rmSync(process.env[k], { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  for (const f of [process.env.AUTOREPLY_LOG, process.env.AUTOREPLY_STATE, process.env.QQAVATAR_CONFIG, process.env.AUTOREPLY_CONFIG]) {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}
cleanup();
// cleanup 之后再落配置（否则被删掉，handle 读不到白名单）
fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify({
  enabled: false, checkEveryHours: 12, minGapDays: 0, maxPerMonth: 0, size: 256, riskGate: true, source: 'any',
  chat: { enabled: true, cooldownMin: 0 },
}));
fs.writeFileSync(process.env.AUTOREPLY_CONFIG, JSON.stringify(AR_CFG, null, 2));

const avatar = require('./avatar.js');
const asrc = require('./avatar-src.js');
const qq = require('./qq.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '   [' + JSON.stringify(detail).slice(0, 220) + ']' : '')); }
}

// 桩：qq.call
const calls = [];
let avatarOk = true;
qq.call = async (action, params) => {
  calls.push({ action, params });
  if (action === 'set_qq_avatar') return avatarOk ? { status: 'ok', retcode: 0, data: {} } : { status: 'failed', retcode: 120, message: 'nope' };
  if (action === 'send_private_msg') return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  if (action === 'send_group_msg') return { status: 'ok', retcode: 0, data: { message_id: 2 } };
  if (action === 'set_input_status') return { status: 'ok', retcode: 0, data: {} };
  return { status: 'ok', retcode: 0, data: {} };
};

// 桩：图片池（不联网、不跑 Pillow）
function seedPool(nPeer, nWeb) {
  fs.mkdirSync(process.env.QQAVATAR_SRC_DIR, { recursive: true });
  const zlib = require('zlib');
  const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff; for (const b of td) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const make = (tag) => {
    const W = 96, H = 96, raw = Buffer.alloc((W * 4 + 1) * H);
    const t = String(tag).split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
    for (let y = 0; y < H; y++) {
      const off = y * (W * 4 + 1);
      for (let x = 0; x < W; x++) {
        const p = off + 1 + x * 4;
        raw[p] = (x * 3 + t) % 256; raw[p + 1] = (y * 3 + t * 2) % 256; raw[p + 2] = (120 + t) % 256; raw[p + 3] = 255;
      }
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
    const f = path.join(process.env.QQAVATAR_SRC_DIR, 'seed-' + tag + '.png');
    fs.writeFileSync(f, buf);
    return f;
  };
  for (let i = 0; i < nPeer; i++) asrc.register(make('peer' + i), { source: 'peer', from: 'p:100000001' });
  for (let i = 0; i < nWeb; i++) asrc.register(make('web' + i), { source: 'web', url: 'stub://' + i });
}
asrc.prepForAvatar = () => ({ ok: true, file: path.join(process.env.QQAVATAR_OUT, 'prepped.png') });
asrc.search = async () => ({ ok: false, why: 'stub-offline', added: [] });

const DAY = 86400000;
const T0 = new Date(2026, 9, 24, 10, 0, 0).getTime();

console.log('§1 意图识别（parseRequest）');
const hit1 = avatar.parseRequest('换个头像');
ok('「换个头像」命中、来源 any', hit1.hit === true && hit1.source === 'any', hit1);
ok('「头像换一下」命中', avatar.parseRequest('头像换一下').hit === true);
ok('「换成网上找的那张头像」→ web', avatar.parseRequest('换成网上找的那张头像').source === 'web', avatar.parseRequest('换成网上找的那张头像'));
ok('「换成别人发的头像」→ peer', avatar.parseRequest('换成别人发的头像').source === 'peer', avatar.parseRequest('换成别人发的头像'));
ok('「用网图做头像」→ web', avatar.parseRequest('用网图做头像').source === 'web');
ok('「头像挺好看的」不命中', avatar.parseRequest('头像挺好看的').hit === false);
ok('「你在干嘛」不命中', avatar.parseRequest('你在干嘛').hit === false);
ok('超长文本不命中', avatar.parseRequest('头像'.repeat(40)).hit === false);
ok('空文本不命中', avatar.parseRequest('').hit === false);

(async () => {
  console.log('§2 chatTrigger 行为');
  seedPool(1, 1);
  calls.length = 0;
  let r = await avatar.chatTrigger({ key: 'p:100000001', text: '换个头像', now: T0, dry: true });
  ok('dry 返回 dry 且 ok', r.dry === true && r.ok === true && r.changed === false, r);
  ok('dry 不调 set_qq_avatar', calls.filter(c => c.action === 'set_qq_avatar').length === 0);
  ok('dry 文案含「演练」', /演练/.test(avatar.replyText(r)), avatar.replyText(r));

  calls.length = 0;
  r = await avatar.chatTrigger({ key: 'p:100000001', text: '换个头像', now: T0 });
  ok('真换成功 changed=true', r.changed === true && r.ok === true, r);
  const setCall = calls.find(c => c.action === 'set_qq_avatar');
  ok('调了 set_qq_avatar 且带文件', !!setCall && typeof setCall.params.file === 'string', setCall);
  ok('文件是处理过的 png', !!setCall && /prepped\.png$/.test(String(setCall.params.file).replace(/\\/g, '/')), setCall && setCall.params.file);
  ok('来源标签是人话', /网上找的|别人发/.test(String(r.label)), r.label);
  ok('回复文案「换好了，用的是…」', /换好了/.test(avatar.replyText(r)), avatar.replyText(r));
  const st = avatar.loadState();
  ok('记了 chatAt', !!(st.chatAt && st.chatAt['p:100000001'] === T0), st.chatAt);

  // 指定来源：别人发的
  calls.length = 0;
  r = await avatar.chatTrigger({ key: 'p:100000001', text: '换成别人发的头像', source: 'peer', now: T0 + 1000 });
  ok('指定 peer 就挑别人发的', r.changed === true && r.source === 'peer', r);

  // 次数限制：默认 0（不限）→ 立刻再换仍然可以
  r = await avatar.chatTrigger({ key: 'p:100000001', text: '再换个头像', now: T0 + 2000 });
  ok('不限次数：连说两次都能换', r.changed === true, r);

  // 把 cooldownMin 调回 2，验证防抖仍可用
  const c2 = JSON.parse(fs.readFileSync(process.env.QQAVATAR_CONFIG, 'utf8'));
  c2.chat = { enabled: true, cooldownMin: 2 };
  fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify(c2));
  r = await avatar.chatTrigger({ key: 'p:100000001', text: '换个头像', now: T0 + 3000 });
  ok('配了 cooldownMin 就防抖', r.changed === false && /刚换过/.test(r.why || ''), r);
  ok('防抖文案是人话', /刚换过/.test(avatar.replyText(r)), avatar.replyText(r));
  r = await avatar.chatTrigger({ key: 'p:100000001', text: '换个头像', now: T0 + 5 * 60000 });
  ok('过了防抖能再换', r.changed === true, r);
  c2.chat = { enabled: true, cooldownMin: 0 };
  fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify(c2));

  // 发送失败不记账
  avatarOk = false;
  const before = JSON.stringify(avatar.loadState().used || []);
  r = await avatar.chatTrigger({ key: 'p:100000001', text: '换个头像', now: T0 + 30 * 60000 });
  ok('set_qq_avatar 失败时 changed=false', r.changed === false && /失败/.test(r.why || ''), r);
  ok('失败不记账', JSON.stringify(avatar.loadState().used || []) === before);
  avatarOk = true;

  console.log('§3 风控闸门');
  const risk = require('./risk.js');
  risk.noteDrop('t1', Date.now());
  risk.noteDrop('t2', Date.now() + 60000);
  r = await avatar.chatTrigger({ key: 'p:100000001', text: '换个头像', now: Date.now() + 55 * 60000 });
  ok('冷却期拒绝换头像', r.changed === false && /risk:/.test(r.why || ''), r);
  ok('冷却期文案说明是安全闸门', /安全闸门|闸门/.test(avatar.replyText(r)), avatar.replyText(r));

  console.log('§4 handle() 拦截整条链路');
  risk.clear();
  const ar = require('./auto-reply.js');
  const thoughts = [];
  const brain = require('./brain.js');
  brain.think = async (ctx) => { thoughts.push(ctx); return { reply: '这条不该出现', model: 'stub', ms: 1 }; };
  try { fs.rmSync(process.env.QQAVATAR_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  seedPool(2, 2);
  calls.length = 0;
  const evt = {
    post_type: 'message', message_type: 'private', user_id: 100000001, self_id: 123456789,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '换个头像吧' } }],
    raw_message: '换个头像吧',
  };
  await ar.handle(evt);
  const sent = calls.filter(c => c.action === 'send_private_msg');
  ok('确实发了消息', sent.length >= 1, sent.length);
  const text = sent.length ? JSON.stringify(sent[0].params.message) : '';
  ok('发的是「换好了」不是模型那句', /换好了/.test(text) && !/这条不该出现/.test(text), text.slice(0, 160));
  ok('没有走模型（不花 token）', thoughts.length === 0, thoughts.length);
  ok('真的调了 set_qq_avatar', calls.some(c => c.action === 'set_qq_avatar'));

  // 群聊里说同样的话不该触发
  calls.length = 0;
  thoughts.length = 0;
  const arCfg2 = JSON.parse(fs.readFileSync(process.env.AUTOREPLY_CONFIG, 'utf8'));
  arCfg2.group = { ...(arCfg2.group || {}), enabled: true, requireAt: true };
  fs.writeFileSync(process.env.AUTOREPLY_CONFIG, JSON.stringify(arCfg2, null, 2));
  const gear = {
    post_type: 'message', message_type: 'group', group_id: 200000001, user_id: 100000001, self_id: 123456789,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: ' 换个头像吧' } }],
    raw_message: '[CQ:at,qq=123456789] 换个头像吧',
  };
  await ar.handle(gear);
  ok('群聊不触发换头像', calls.filter(c => c.action === 'set_qq_avatar').length === 0);

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
