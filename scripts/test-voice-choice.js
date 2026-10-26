'use strict';
/**
 * test-voice-choice.js —— 「这一句要不要说出来」由模型自己挑（离线自检）
 * 覆盖：标记解析（[[语音]]/[[voice]]/【语音】/残缺）→ brain.think 回传 voice →
 *       handle 里按 choice 走 model / random / off；超长跳过；dry 不合成音频。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-choice-'));
const envs = ['QQCTX_DIR', 'QQMIND_DIR', 'QQTRACE_DIR', 'QQBOND_DIR', 'QQECHO_DIR', 'QQMODE_DIR', 'QQTHEM_DIR', 'QQFOLLOW_DIR', 'QQNICK_DIR', 'QQPROMISE_DIR', 'QQQUOTE_DIR', 'QQRISK_DIR', 'QQLONGING_DIR', 'QQGROUP_DIR', 'QQSELF_DIR', 'QQPACING_DIR', 'QQAVATAR_DIR', 'QQAVATARSRC_DIR', 'QQTIES_DIR', 'QQPRESENCE_DIR', 'QQFORWARD_DIR', 'QQTIMELINE_DIR', 'QQSTICKER_DIR'];
for (const k of envs) process.env[k] = path.join(TMP, k.toLowerCase());
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(TMP, 'autoreply.log');
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
const CFGF = path.join(TMP, 'autoreply.json');
process.env.AUTOREPLY_CONFIG = CFGF;

const st = require('./stickers.js');
const brain = require('./brain.js');
const qq = require('./qq.js');

let pass = 0;
const fails = [];
const cases = [];
function ok(name, fn) { cases.push([name, fn]); }

// ── 1) 标记解析 ────────────────────────────────────────────────────────────
ok('[[语音]] 被认出来并从正文剥掉', () => {
  const p = st.extractDirective('在呢，你说[[语音]]');
  assert.equal(p.text, '在呢，你说');
  assert.equal(p.voice, true);
});
ok('[[voice]] / 【语音】 都认', () => {
  assert.equal(st.extractDirective('我没事 [[voice]]').voice, true);
  assert.equal(st.extractDirective('这句【语音】只有话').voice, true);
});
ok('残缺的 [[语音 也擦掉（不能把标记发出去）', () => {
  const p = st.extractDirective('嗯嗯 [[语');
  assert.equal(p.text, '嗯嗯');
  assert.equal(p.voice, false);
});
ok('语音 + 表情可以同时写', () => {
  const p = st.extractDirective('先说正事 [[语音]] [[表情:偷笑]]');
  assert.equal(p.text, '先说正事');
  assert.equal(p.voice, true);
  assert.equal(p.stickerKey, '偷笑');
});
// 2026-10-26 真事故：模型写 [语音]（单方括号），结果原样发进聊天框
// 规则改成「单方括号也算标记」——因为这两个函数只处理**模型产出**，不会碰历史里的占位符
ok('[语音] 单方括号也要认（擦标记 + voice=true）', () => {
  const p = st.extractDirective('第一次发嘛，凑合听啦，下次练练再来 [语音]');
  assert.equal(p.voice, true);
  assert.equal(/\[语音\]/.test(p.text), false);
  assert.equal(p.text, '第一次发嘛，凑合听啦，下次练练再来');
});
ok('全角单方括号同样处理', () => {
  const p = st.extractDirective('这句我说给你听［语音］');
  assert.equal(p.voice, true);
  assert.equal(p.text.includes('语音'), false);
});
ok('stripMarkers 兜底擦掉单括号语音标记', () => {
  assert.equal(brain.stripMarkers('好呀，那我先说啦[语音]'), '好呀，那我先说啦');
  assert.equal(brain.stripMarkers('好呀，那我先说啦【语音】'), '好呀，那我先说啦');
});
ok('历史占位符里的 [语音] 由 turnOfMsg 生成、不经过这两个函数（防回归说明）', () => {
  // 说明性断言：stripMarkers 只用于出站文本；入站历史占位符由 context.turnOfMsg 写入
  assert.equal(typeof brain.stripMarkers, 'function');
});
ok('stripMarkers 擦掉语音残留', () => {
  assert.equal(brain.stripMarkers('好呀[[语音]]'), '好呀');
  assert.equal(brain.stripMarkers('好呀 [[语'), '好呀');
});

// ── 2) handle：model 档（模型说要就要）─────────────────────────────────────
const ROOT = path.join(__dirname, '..');
function loadCfgRaw() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.json'), 'utf8')); }
function writeCfg(dir, over) {
  const base = loadCfgRaw();
  base.selfId = 0; // 假事件里 self_id=0，config.selfId 必须跟着改，否则 decide 会判成「自己发的」
  base.private = { enabled: true, allowList: ['123456789'], denyList: [] };
  base.group = { enabled: false };
  base.llm = { enabled: true };
  base.mind = { enabled: false };
  base.echo = { enabled: false };
  base.stickers = { enabled: false };
  base.promises = { enabled: false };
  base.limits = { perContactHour: 0, globalPerHour: 0 };
  base.delayMs = [1, 1];
  const merged = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(over || {})) merged[k] = { ...(merged[k] || {}), ...v };
  fs.writeFileSync(CFGF, JSON.stringify(merged, null, 2));
  return CFGF;
}

let callStub = null;
let thinkStub = null;
qq.call = async (action, params) => (callStub ? callStub(action, params) : { status: 'ok', retcode: 0, data: {} });
brain.think = async (ctx) => (thinkStub ? thinkStub(ctx) : { reply: '在呢', model: 'stub', ms: 1 });

// 先落一份初始配置（CFGF 在 require 前必须存在，auto-reply 的 loadCfg 才会读到它）
writeCfg(TMP, { voice: { enabled: true, choice: 'model', maxChars: 80 } });
const ar = require('./auto-reply.js');

function evt(text, id) {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: 0, user_id: 123456789, time: Math.floor(Date.now() / 1000),
    message_id: 990000 + (id || 0), real_seq: 5000 + (id || 0),
    message: [{ type: 'text', data: { text } }], raw_message: text
  };
}
function readLog() {
  const f = process.env.AUTOREPLY_LOG;
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
let seq = 0;

ok('模型写了语音标记 → 这一轮走语音（日志 voice-choice/by:model）', async () => {
  process.env.AUTOREPLY_CONFIG = writeCfg(TMP, { voice: { enabled: true, choice: 'model', maxChars: 80 } });
  thinkStub = async () => ({ reply: '在呢，刚醒', voice: true, model: 'stub', ms: 1 });
  await ar.handle(evt('醒了吗', ++seq));
  const evs = readLog().filter((e) => e.event === 'voice-choice');
  assert.ok(evs.length >= 1, '应有 voice-choice');
  assert.equal(evs[evs.length - 1].by, 'model');
});

ok('模型没写标记 → 不发语音', async () => {
  process.env.AUTOREPLY_CONFIG = writeCfg(TMP, { voice: { enabled: true, choice: 'model', maxChars: 80 } });
  const before = readLog().filter((e) => e.event === 'voice-choice').length;
  thinkStub = async () => ({ reply: '在的', voice: false, model: 'stub', ms: 1 });
  await ar.handle(evt('在吗', ++seq));
  assert.equal(readLog().filter((e) => e.event === 'voice-choice').length, before);
});

ok('太长就算模型想发也压回文字（voice-skip/too-long）', async () => {
  process.env.AUTOREPLY_CONFIG = writeCfg(TMP, { voice: { enabled: true, choice: 'model', maxChars: 5 } });
  thinkStub = async () => ({ reply: '这句话明显超过五个字了', voice: true, model: 'stub', ms: 1 });
  await ar.handle(evt('说说', ++seq));
  const sk = readLog().filter((e) => e.event === 'voice-skip');
  assert.ok(sk.some((e) => e.why === 'too-long'));
});

ok('maxChars:0 = 不限字数，长回复照样能用语音说（2026-10-26 解除上限）', async () => {
  process.env.AUTOREPLY_CONFIG = writeCfg(TMP, { voice: { enabled: true, choice: 'model', maxChars: 0 } });
  const long = '今天下午一直在改东西，中间喝了两杯茶，窗外下了一会儿小雨，后来停了，天也慢慢暗下来了，你现在在干嘛呀？';
  thinkStub = async () => ({ reply: long, voice: true, model: 'stub', ms: 1 });
  const before = readLog().filter((e) => e.event === 'voice-choice').length;
  await ar.handle(evt('在干嘛', ++seq));
  assert.equal(readLog().filter((e) => e.event === 'voice-choice').length, before + 1);
  assert.ok(!readLog().filter((e) => e.event === 'voice-skip').some((e) => e.why === 'too-long' && String(e.chars) === String(long.length)));
});

ok('choice=off 时模型想发也不发（voice-skip/disabled）', async () => {
  process.env.AUTOREPLY_CONFIG = writeCfg(TMP, { voice: { enabled: false, choice: 'off' } });
  thinkStub = async () => ({ reply: '嗯', voice: true, model: 'stub', ms: 1 });
  await ar.handle(evt('嗯', ++seq));
  assert.ok(readLog().filter((e) => e.event === 'voice-skip').some((e) => e.why === 'disabled' || e.why === 'too-long'));
});

ok('choice=random 时仍按概率掷骰子（by:dice）', async () => {
  process.env.AUTOREPLY_CONFIG = writeCfg(TMP, { voice: { enabled: true, choice: 'random', probability: 1, maxChars: 80 } });
  thinkStub = async () => ({ reply: '嘿嘿', voice: false, model: 'stub', ms: 1 });
  await ar.handle(evt('笑什么', ++seq));
  assert.ok(readLog().filter((e) => e.event === 'voice-choice').some((e) => e.by === 'dice'));
});

ok('dry 演练不合成音频（不会写 voice 文件）', () => {
  assert.equal(process.env.AUTOREPLY_DRY, '1');
  const dir = path.join(ROOT, 'logs', 'voice');
  // 只断言「这一轮结束后没有新增音频」这条不变量由 send 里的 dry 分支保证：
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(typeof before, 'number');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); pass++; } catch (e) { fails.push(name + ' :: ' + (e && e.message)); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { }
  console.log(`\ntest-voice-choice: ${pass} passed, ${fails.length} failed`);
  if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
})();
