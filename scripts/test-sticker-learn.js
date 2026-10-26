#!/usr/bin/env node
'use strict';
/**
 * test-sticker-learn.js — 表情反馈学习（好不好笑，从对方反应里学）。
 * 全离线：临时 STICKER_DIR + 桩 qq.call / 桩 brain.think。
 *
 *   node scripts/test-sticker-learn.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-learn-'));
const SDIR = path.join(TMP, 'stickers');
fs.mkdirSync(path.join(SDIR, 'made'), { recursive: true });
process.env.STICKER_DIR = SDIR;
process.env.QQMODE_DIR = __dirname + '/../logs/mode-sticker-learn-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-sticker-learn-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-sticker-learn-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-sticker-learn-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-sticker-learn-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQSTICKER_BAN = '';
['QQCTX_DIR', 'QQMIND_DIR', 'QQLONGING_DIR', 'QQPROMISE_DIR', 'QQBOND_DIR', 'QQECHO_DIR', 'QQTHEM_DIR', 'QQPACING_DIR', 'QQSELF_DIR', 'QQGROUP_DIR']
  .forEach((k) => { process.env[k] = path.join(TMP, k.toLowerCase()); });
// 用生产配置做底，但关掉「忙时延迟回复」——否则 daytime 常在 focus 状态，handle 只会排期不会发
const _cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.json'), 'utf8'));
_cfg.busy = { enabled: false };
_cfg.private = { ...(_cfg.private || {}), enabled: true, allowList: [] };
fs.writeFileSync(path.join(TMP, 'autoreply.json'), JSON.stringify(_cfg, null, 2));
process.env.AUTOREPLY_CONFIG = path.join(TMP, 'autoreply.json');
process.env.AUTOREPLY_LOG = path.join(TMP, 'autoreply-learn.log');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-sticker-learn-' + process.pid + '.json';
delete process.env.AUTOREPLY_DRY;

let pass = 0; let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function mk(id, emotion, tags, desc) {
  const file = path.join(SDIR, 'made', id + '.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return { id, kind: 'image', file, source: 'made', emotion, tags, desc };
}
const LIKED = mk('l-liked', '偷笑', ['偷笑', '开心'], '贱兮兮偷笑');
const NEUTRAL = mk('l-neutral', '偷笑', ['偷笑'], '普通偷笑');
const HATED = mk('l-hated', '偷笑', ['偷笑'], '别人都嫌弃的偷笑');
fs.writeFileSync(path.join(SDIR, 'index.json'), JSON.stringify({ version: 1, stickers: [LIKED, NEUTRAL, HATED] }, null, 2));

const st = require(path.join(ROOT, 'scripts', 'stickers.js'));

console.log('① judgeReaction：从一句话判断对方对表情的反应');
ok("'哈哈哈笑死，太可爱了' → positive", st.judgeReaction('哈哈哈笑死，太可爱了') === 'positive');
ok("'这个好玩' → positive", st.judgeReaction('这个好玩') === 'positive');
ok("'别发这种了' → negative", st.judgeReaction('别发这种了') === 'negative');
ok("'不好笑' → negative", st.judgeReaction('不好笑') === 'negative');
ok("'这是啥啊' → negative", st.judgeReaction('这是啥啊') === 'negative');
ok("'在吗' → neutral", st.judgeReaction('在吗') === 'neutral');
ok("'' → neutral（对方没说话/纯图）", st.judgeReaction('') === 'neutral');

console.log('② noteSent / noteOutcome：记账');
{
  const before = st.allStickers().find((s) => s.id === 'l-liked');
  ok('初始没有学习分', !before.learnScore && !before.sent);
  st.noteSent('l-liked');
  const a = st.allStickers().find((s) => s.id === 'l-liked');
  ok('sent 记了一次', a.sent === 1);
  ok('lastSentAt 落了时间', typeof a.lastSentAt === 'number');
  st.noteOutcome('l-liked', 'positive');
  st.noteOutcome('l-liked', 'positive');
  const b = st.allStickers().find((s) => s.id === 'l-liked');
  ok('两次好评 → likes=2、learnScore=2', b.likes === 2 && b.learnScore === 2, JSON.stringify({ likes: b.likes, learnScore: b.learnScore }));
  ok('replied 也记了', b.replied === 2);
  ok('biasOf 加分（2×6=12）', st.biasOf(b) === 12, String(st.biasOf(b)));
  st.noteOutcome('l-liked', 'neutral');
  const c = st.allStickers().find((s) => s.id === 'l-liked');
  ok('中性不改变 learnScore', c.learnScore === 2, String(c.learnScore));
}

console.log('③ noteDislike：明显嫌弃（一次算两次）');
{
  st.noteDislike('l-hated');
  const h = st.allStickers().find((s) => s.id === 'l-hated');
  ok('learnScore 掉到 -4', h.learnScore === -4, String(h.learnScore));
  ok('dislikes=1', h.dislikes === 1);
  ok('biasOf 限幅到 -24', st.biasOf(h) === -24, String(st.biasOf(h)));
  ok('被嫌弃到阈值 → isAutoBanned', st.isAutoBanned(h) === true);
  st.noteSent('l-hated');
  ok('被拉黑的图 pick 不再自动挑（点名仍可）', st.pick('偷笑') === null || st.pick('偷笑').id !== 'l-hated', JSON.stringify(st.pick('偷笑') && st.pick('偷笑').id));
  ok('点名 l-hated 仍然照办', (st.pick('l-hated') || {}).id === 'l-hated');
}

console.log('④ pick 会被学习分影响排序');
{
  // l-liked 已经被夸两次（+12），l-neutral 没有分 → 同情绪下应该挑 l-liked
  const pick1 = st.pick('偷笑');
  ok('夸过的图优先（l-liked）', pick1 && pick1.id === 'l-liked', pick1 && pick1.id);
  // 再给 neutral 猛加分，看看能不能反超
  for (let i = 0; i < 4; i++) st.noteOutcome('l-neutral', 'positive');
  const pick2 = st.pick('偷笑');
  ok('被夸更多的那张反超（l-neutral）', pick2 && pick2.id === 'l-neutral', pick2 && pick2.id);
  ok('bias 限幅不超过 +18', st.biasOf(st.allStickers().find((s) => s.id === 'l-neutral')) === 18, String(st.biasOf(st.allStickers().find((s) => s.id === 'l-neutral'))));
}

async function main() {
  console.log('⑤ handle() 端到端：发完表情 → 对方反应 → 记账');
  {
    const brain = require(path.join(ROOT, 'scripts', 'brain.js'));
    const qq = require(path.join(ROOT, 'scripts', 'qq.js'));
    const sent = [];
    qq.call = async (action, params) => {
      sent.push({ action, params });
      return { status: 'ok', retcode: 0, data: { message_id: 1000 + sent.length } };
    };
    let call = 0;
    brain.think = async () => {
      call += 1;
      return { reply: '嘿嘿', stickerKey: call === 1 ? '偷笑' : '', ms: 1, model: 'stub', finish: 'stop' };
    };
    const ar = require(path.join(ROOT, 'scripts', 'auto-reply.js'));
    const base = {
      post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 100000001,
      sender: { user_id: 100000001, nickname: '好友A' },
    };
    const t0 = Math.floor(Date.now() / 1000);

    // 第一轮：回复 + 表情
    await ar.handle({ ...base, time: t0, message_id: 1, message: [{ type: 'text', data: { text: '在干嘛' } }], raw_message: '在干嘛' });
    const idx1 = JSON.parse(fs.readFileSync(path.join(SDIR, 'index.json'), 'utf8'));
    const sentRec = idx1.stickers.filter((s) => s.sent > 0);
    ok('发出去的表情被记账（sent>0）', sentRec.length >= 1, JSON.stringify(sentRec.map((s) => ({ id: s.id, sent: s.sent }))));
    const pending = ar.lastStickerSent.get('p:100000001');
    const sentEntry = pending ? idx1.stickers.find((s) => s.id === pending.id) : null;
    ok('记住了「等对方反应」且这次选的图确实发出去过', Boolean(pending) && sentEntry && sentEntry.sent >= 1, JSON.stringify({ pending, sent: sentEntry && sentEntry.sent }));

    // 第二轮：对方夸这个表情
    await ar.handle({ ...base, time: t0 + 30, message_id: 2, message: [{ type: 'text', data: { text: '哈哈哈这个好可爱' } }], raw_message: '哈哈哈这个好可爱' });
    const idx2 = JSON.parse(fs.readFileSync(path.join(SDIR, 'index.json'), 'utf8'));
    const after = idx2.stickers.find((s) => s.id === pending.id);
    ok('对方夸了 → likes+1 / learnScore 上升', after.likes >= 1 && after.learnScore > 0, JSON.stringify({ likes: after.likes, learnScore: after.learnScore }));
    ok('处理完就清掉 pending', !ar.lastStickerSent.get('p:100000001'));

    // 第三轮：再发一张，这次对方嫌弃
    call = 0;
    await ar.handle({ ...base, time: t0 + 60, message_id: 3, message: [{ type: 'text', data: { text: '再来一个' } }], raw_message: '再来一个' });
    const p2 = ar.lastStickerSent.get('p:100000001');
    ok('第二次也记住了 pending', Boolean(p2), JSON.stringify(p2 || null));
    const idx3Before = JSON.parse(fs.readFileSync(path.join(SDIR, 'index.json'), 'utf8'));
    const beforeScore = p2 ? (idx3Before.stickers.find((s) => s.id === p2.id) || {}).learnScore || 0 : 0;
    await ar.handle({ ...base, time: t0 + 90, message_id: 4, message: [{ type: 'text', data: { text: '别发这种了' } }], raw_message: '别发这种了' });
    const idx3 = JSON.parse(fs.readFileSync(path.join(SDIR, 'index.json'), 'utf8'));
    const hated = p2 ? idx3.stickers.find((s) => s.id === p2.id) : null;
    ok('对方嫌弃 → learnScore 掉 4 分', hated && hated.learnScore === beforeScore - 4, JSON.stringify({ id: hated && hated.id, before: beforeScore, after: hated && hated.learnScore }));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('测试崩了:', (e && e.stack) || e); process.exit(1); });
