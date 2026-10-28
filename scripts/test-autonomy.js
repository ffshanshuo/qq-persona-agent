'use strict';
/**
 * test-autonomy.js —— 自主权层（第 1 阶段：反应式自主）离线自检
 *
 * 只测这一层：模型可以提议「不回 / 慢点回 / 很快回 / 引用」，policy 决定批不批。
 * 全离线：模型与 QQ 都是桩；状态目录全隔离（QQAUTONOMY_DIR / QQAUTONOMY_LOG）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-'));
process.env.QQAUTONOMY_DIR = path.join(TMP, 'autonomy');
process.env.QQAUTONOMY_LOG = path.join(TMP, 'autonomy.jsonl');
process.env.QQMIND_DIR = path.join(TMP, 'mind');
process.env.QQCTX_DIR = path.join(TMP, 'context');
process.env.QQTHEM_DIR = path.join(TMP, 'them');
process.env.QQTRACE_DIR = path.join(TMP, 'trace');
process.env.QQBOND_DIR = path.join(TMP, 'bonds');
process.env.QQECHO_DIR = path.join(TMP, 'echo');
process.env.QQMODE_DIR = path.join(TMP, 'mode');
process.env.QQFOLLOW_DIR = path.join(TMP, 'follow');
process.env.QQNICK_DIR = path.join(TMP, 'nick');
process.env.QQQUOTE_DIR = path.join(TMP, 'quotes');
process.env.QQPROMISE_DIR = path.join(TMP, 'promises');
process.env.QQRISK_DIR = path.join(TMP, 'risk');
process.env.QQLONGING_DIR = path.join(TMP, 'longing');
process.env.QQGROUP_DIR = path.join(TMP, 'group');
process.env.QQSELF_DIR = path.join(TMP, 'self');
process.env.QQPACING_DIR = path.join(TMP, 'pacing');
process.env.QQFORWARD_DIR = path.join(TMP, 'forward');
process.env.QQMURMUR_DIR = path.join(TMP, 'murmur');
process.env.QQAVATAR_DIR = path.join(TMP, 'avatar');
process.env.QQAVATARSRC_STATE_DIR = path.join(TMP, 'avatar-src');
// 用临时配置文件（balanced 档）而不是生产 config/autonomy.json —— 否则生产中把档位切到 max 会让这一组断言失效
const TEST_CFG = path.join(TMP, 'autonomy.json');
process.env.AUTONOMY_CONFIG = TEST_CFG;
fs.writeFileSync(TEST_CFG, JSON.stringify({ preset: 'balanced' }, null, 2));

const autonomy = require('../scripts/autonomy.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; fails.push(name); console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

const BASE = {
  enabled: true,
  daily: { skip: 6, slow: 4, quote: 8 },
  perContact: { skipPerDay: 2, skipGapMin: 90, slowPerDay: 2 },
  slowMs: [180000, 900000],
  fastMs: [200, 900],
  urgentRe: '急|在吗|在不在|电话|马上|现在就|救命|快回|赶紧|几点|什么时候|在哪|怎么样了',
  requestRe: '帮我|帮忙|能不能|可以吗|可不可以|求你|拜托|教我|给我|发我|推荐|怎么办|咋办|要不要|该不该|有没有',
  minGapForSkipHours: 6,
  keepDecisions: 200,
};

function resetAll() {
  fs.rmSync(process.env.QQAUTONOMY_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.QQAUTONOMY_LOG, { force: true });
}
const T0 = new Date(2026, 9, 27, 15, 0, 0).getTime();          // 固定基准
const d1 = { key: 'p:100000001', text: '哈哈', target: { type: 'private', id: '100000001' } };
const dAsk = { key: 'p:100000001', text: '你在吗', target: { type: 'private', id: '100000001' } };
const dHelp = { key: 'p:100000001', text: '帮我看看这个怎么弄', target: { type: 'private', id: '100000001' } };
const dGroup = { key: 'g:200000001', text: '在吗', atMe: true, target: { type: 'group', id: '200000001' } };

async function main() {
  // ============ 一、标记解析 ============
  const p1 = autonomy.parseMarkers('在呢 [[不回]]');
  ok('[[不回]] 被识别且正文剥干净', p1.skip === true && p1.text === '在呢', p1);
  ok('[[慢点回]] 被识别', autonomy.parseMarkers('【慢点回】').slow === true);
  ok('[[很快回]] 被识别', autonomy.parseMarkers('[很快回] 好').fast === true);
  ok('[[引用]] 被识别', autonomy.parseMarkers('嗯呢 [[引用]]').quote === true);
  const p2 = autonomy.parseMarkers('[[慢点回]] [[不回]]');
  ok('不回优先于慢点回', p2.skip === true && p2.slow === false, p2);
  ok('全角单方括号也认', autonomy.parseMarkers('［不回］').skip === true);
  ok('普通文本不受影响', (() => { const r = autonomy.parseMarkers('今天挺好的'); return !r.skip && !r.slow && !r.fast && !r.quote && r.text === '今天挺好的'; })());
  ok('stripMarks 只擦标记', autonomy.stripMarks('好 [引用] 的').replace(/\s+/g, '') === '好的');

  // ============ 二、decideSkip ============
  resetAll();
  const s1 = autonomy.decideSkip(d1.key, d1, { cfg: BASE, now: T0 });
  ok('无聊闲聊可以跳', s1.ok === true, s1);
  const st1 = autonomy.load(T0);
  ok('跳过一次已记账', st1.counters.skip === 1 && st1.perKey[d1.key].skip.n === 1, st1.counters);

  ok('问句不许跳', autonomy.decideSkip(dAsk.key, dAsk, { cfg: BASE, now: T0 }).why === 'urgent-or-question');
  ok('求助不许跳', autonomy.decideSkip(dHelp.key, dHelp, { cfg: BASE, now: T0 }).why === 'direct-request');
  ok('@我/群里点我不许跳', autonomy.decideSkip(dGroup.key, dGroup, { cfg: BASE, now: T0 }).why === 'at-or-follow');
  ok('隔很久重新开口的第一句不许跳',
    autonomy.decideSkip(d1.key, d1, { cfg: BASE, now: T0 + 60000, idleMinutes: 400 }).why === 'first-after-long-gap');
  ok('同人 90 分钟内不许再跳',
    autonomy.decideSkip(d1.key, d1, { cfg: BASE, now: T0 + 30 * 60000 }).why === 'contact-gap');
  const s2 = autonomy.decideSkip(d1.key, d1, { cfg: BASE, now: T0 + 100 * 60000 });
  ok('过了间隔可以再跳一次', s2.ok === true, s2);
  ok('同人一天最多跳 2 次',
    autonomy.decideSkip(d1.key, d1, { cfg: BASE, now: T0 + 200 * 60000 }).why === 'contact-cap');
  ok('不能连着跳两次（另一人也是）',
    autonomy.decideSkip('p:999', { ...d1, key: 'p:999' }, { cfg: BASE, now: T0 + 300 * 60000 }).ok === true);
  resetAll();
  const capCfg = { ...BASE, daily: { ...BASE.daily, skip: 1 } };
  ok('全局每天上限', (() => {
    autonomy.decideSkip('p:1', { ...d1, key: 'p:1' }, { cfg: capCfg, now: T0 });
    return autonomy.decideSkip('p:2', { ...d1, key: 'p:2' }, { cfg: capCfg, now: T0 }).why === 'daily-cap';
  })());
  resetAll();
  ok('dry 不记账', (() => {
    const r = autonomy.decideSkip(d1.key, d1, { cfg: BASE, now: T0, dry: true });
    return r.ok === true && autonomy.load(T0).counters.skip === 0;
  })());
  ok('dry 也会写审计行（带 dry:true）', (() => {
    const lines = fs.readFileSync(process.env.QQAUTONOMY_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return lines.some((l) => l.event === 'skip' && l.dry === true);
  })());

  // ============ 三、decideSlow / decideFast ============
  resetAll();
  const sl = autonomy.decideSlow(d1.key, { cfg: BASE, now: T0 });
  ok('慢点回给出区间内的毫秒', sl.ok === true && sl.ms >= 180000 && sl.ms <= 900000, sl);
  const slLow = autonomy.decideSlow(d1.key, { cfg: BASE, now: T0 + 1000, ms: 5 });
  ok('低于下限会被钳住', slLow.ms === 180000, slLow);
  const slHigh = autonomy.decideSlow(d1.key, { cfg: BASE, now: T0 + 2000, ms: 99e9 });
  ok('高于上限会被钳住', slHigh.ms === 900000, slHigh);
  ok('同人慢回每天 2 次上限',
    autonomy.decideSlow(d1.key, { cfg: BASE, now: T0 + 3000 }).why === 'contact-cap');
  const slCapCfg = { ...BASE, daily: { ...BASE.daily, slow: 0 } };
  ok('daily.slow=0 直接关这一档', autonomy.decideSlow('p:x', { cfg: slCapCfg, now: T0 }).why === 'daily-cap');
  const fa = autonomy.decideFast({ key: d1.key, cfg: BASE });
  ok('很快回给的是短延迟（不是 0）', fa.ok === true && fa.ms >= 200 && fa.ms <= 900, fa);
  resetAll();
  const slDry = autonomy.decideSlow(d1.key, { cfg: BASE, now: T0, dry: true });
  ok('慢回 dry 不记账', slDry.ok === true && autonomy.load(T0).counters.slow === 0);

  // ============ 四、allowQuote ============
  resetAll();
  ok('允许引用', autonomy.allowQuote(d1.key, { cfg: BASE, now: T0 }).ok === true);
  ok('已经在引用回复就不重复引', autonomy.allowQuote(d1.key, { cfg: BASE, now: T0, hasQuote: true }).why === 'already-quoting');
  const qCap = { ...BASE, daily: { ...BASE.daily, quote: 0 } };
  ok('引用额度可关', autonomy.allowQuote(d1.key, { cfg: qCap, now: T0 }).why === 'daily-cap');
  ok('status 能给出计数与额度', (() => { const s = autonomy.status(T0); return s.day && s.counters && s.caps && Array.isArray(s.decisions); })());

  // ============ 五、接线：handle 里四种标记都会过 policy ============
  const CFGP = path.join(TMP, 'ar.cfg.json');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'autoreply.test.json'), 'utf8'));
  base.private.allowList = ['100000001'];
  base.group.allowList = ['200000001'];
  base.murmur = { enabled: false };
  base.busy = { enabled: false };
  base.voice = { ...(base.voice || {}), enabled: false };
  base.stickers = { ...(base.stickers || {}), enabled: false };
  base.autonomy = { enabled: true, slowMs: [5, 5], fastMs: [5, 5] };
  fs.writeFileSync(CFGP, JSON.stringify(base, null, 2), 'utf8');
  process.env.AUTOREPLY_CONFIG = CFGP;
  process.env.AUTOREPLY_LOG = path.join(TMP, 'ar.log');
  process.env.AUTOREPLY_STATE = path.join(TMP, 'ar.state.json');
  process.env.AUTOREPLY_DRY = '1';

  const qq = require('../scripts/qq.js');
  let brainReplies = [];
  const sent = [];
  qq.call = async (action, params) => {
    if (action === 'send_private_msg' || action === 'send_group_msg') sent.push({ action, params });
    if (action === 'set_input_status') return { status: 'ok', retcode: 0 };
    if (action === 'get_msg') return { status: 'ok', retcode: 0, data: { message: [{ type: 'text', data: { text: '旧话' } }] } };
    return { status: 'ok', retcode: 0, data: {} };
  };
  const brain = require('../scripts/brain.js');
  brain.think = async () => (brainReplies.shift() || { reply: '在的', stickerKey: '', ms: 1, model: 'stub' });

  const ar = require('../scripts/auto-reply.js');
  const ctxStore = require('../scripts/context.js');
  ctxStore.configure({ enabled: true });
  const evt = (text) => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: base.selfId || 0, user_id: 100000001, time: Math.floor(Date.now() / 1000),
    message_id: 900000 + Math.floor(Math.random() * 100000),
    message: [{ type: 'text', data: { text } }], raw_message: text,
  });
  const evts = () => fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
  const has = (ev) => evts().some((x) => x.event === ev);
  const resetLog = () => { try { fs.rmSync(process.env.AUTOREPLY_LOG, { force: true }); } catch (e) { /* ignore */ } };

  // A) 模型说「不回」，对方只是发了个「哈哈」→ 放行，且真的没发
  resetAll(); resetLog();
  brainReplies = [{ skip: true, reply: '', stickerKey: '', ms: 1, model: 'stub' }];
  await ar.handle(evt('哈哈'));
  ok('模型可以决定不回（放行并有日志）', has('autonomy-skip') && !has('dry-send'));

  // B) 对方在问事 → policy 否决，不能跳（reply 为空会落到 brain-skip）
  resetAll(); resetLog();
  brainReplies = [{ skip: true, reply: '', stickerKey: '', ms: 1, model: 'stub' }];
  await ar.handle(evt('你在吗'));
  ok('问句时不回被否决', has('autonomy-skip-denied') && !has('autonomy-skip'));

  // C) 慢点回：延迟被覆盖（配置里钳成 5ms，便于测试），并且照常发出去
  resetAll(); resetLog();
  brainReplies = [{ reply: '在的，刚忙完', stickerKey: '', slow: true, ms: 1, model: 'stub' }];
  const t0 = Date.now();
  await ar.handle(evt('随便聊聊'));
  const el = Date.now() - t0;
  ok('慢点回被批准并写日志', has('autonomy-slow'));
  ok('慢点回延迟确实生效（>5ms 且没到 3 分钟）', el >= 5 && el < 180000, el);
  ok('慢点回之后还是发出去了', has('dry-send'));

  // D) 引用：挑得到旧话就带上引用段
  resetAll(); resetLog();
  ctxStore.push('p:100000001', { from: 'them', t: Date.now() - 3600e3, speaker: '好友A', text: '下周三考完试想去看海', seq: '12345' });
  brainReplies = [{ reply: '考完就去吧', stickerKey: '', quote: true, ms: 1, model: 'stub' }];
  await ar.handle(evt('考完了，累'));
  ok('模型可以要一条引用（批准并写日志）', has('autonomy-quote'));
  const qs = evts().filter((x) => x.event === 'dry-send').slice(-1)[0];
  ok('发出去的那条确实带了 reply 段', !!(qs && Array.isArray(qs.segs) && qs.segs.some((x) => x.type === 'reply')), qs && qs.segs);

  // E) 对方这条本身就是引用回复 → 不许再叠加引用
  resetAll(); resetLog();
  brainReplies = [{ reply: '嗯呢', stickerKey: '', quote: true, ms: 1, model: 'stub' }];
  const evQ = evt('那你呢');
  evQ.message = [{ type: 'reply', data: { id: '555' } }, { type: 'text', data: { text: '那你呢' } }];
  evQ.raw_message = '那你呢';
  await ar.handle(evQ);
  ok('已经在引用别人时不再叠加引用', has('autonomy-quote-denied'));

  // F) 很快回：短延迟且不占慢回额度
  resetAll(); resetLog();
  brainReplies = [{ reply: '嗯嗯', stickerKey: '', fast: true, ms: 1, model: 'stub' }];
  await ar.handle(evt('早'));
  ok('很快回有日志且照常发送', has('autonomy-fast') && has('dry-send'));
  ok('很快回不占慢回额度', autonomy.load().counters.slow === 0);

  // G) 最高自由档 preset:max —— 硬拦与额度全关，只留安全红线（在 risk.js / SYSTEM）
  resetAll(); resetLog();
  const MAXC = { ...BASE, ...autonomy.PRESETS.max, preset: "max",
    daily: { ...BASE.daily, ...autonomy.PRESETS.max.daily },
    perContact: { ...BASE.perContact, ...autonomy.PRESETS.max.perContact } };
  const atMe = { text: "在吗", atMe: true, target: { type: "group", id: "200000001" } };
  ok("max 档：@ 我也允许不回", autonomy.decideSkip("p:m1", atMe, { cfg: MAXC }).ok === true);
  ok("max 档：问句也允许不回", autonomy.decideSkip("p:m2", { text: "你在干嘛呀？" }, { cfg: MAXC }).ok === true);
  ok("max 档：求助也允许不回", autonomy.decideSkip("p:m3", { text: "帮我看看这个怎么办" }, { cfg: MAXC }).ok === true);
  ok("max 档：久别第一句也允许不回", autonomy.decideSkip("p:m4", { text: "嗨" }, { cfg: MAXC, idleMinutes: 600 }).ok === true);
  let allowed = 0;
  for (let i = 0; i < 6; i++) if (autonomy.decideSkip("p:same", { text: "嗯" }, { cfg: MAXC }).ok) allowed++;
  ok("max 档：同一人连跳 6 次都放行（无额度、无连跳限制）", allowed === 6, allowed);
  resetAll();
  const dryMax = autonomy.decideSkip("p:m5", { text: "嗯" }, { cfg: MAXC, dry: true });
  ok("max 档：dry 放行但不记账", dryMax.ok === true && autonomy.load().counters.skip === 0);
  ok("preset 读取函数可用", typeof autonomy.getPreset === "function" && typeof autonomy.setPreset === "function");
  ok("balanced 档仍然拦 @ 我（默认口径没被改坏）", autonomy.decideSkip("p:m6", atMe, { cfg: BASE }).ok === false);
  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (failed ? '  →  ' + fails.join(' | ') : ''));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
