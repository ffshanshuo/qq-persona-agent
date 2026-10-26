/**
 * test-empty-bubble.js —— 「只有表情没有文字」时只发一条气泡（全离线）
 *
 * 2026-10-24 真事故：模型只输出 `[[表情:无语]]`（reply 为空），表情分条逻辑先发了一条空文字气泡；
 * NapCat 对空消息返回 retcode 200 → 发送循环 break → 表情永远发不出去，日志里只看到
 * `{"event":"send-fail","resp":"failed/200"}`。
 * 修法：分条后过滤掉「既没文字、也没语音」的气泡；sendBubble 再兜一层「拼不出段就跳过」。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-empty-bubble-'));
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_CONFIG = path.join(__dirname, '..', 'config', 'autoreply.test.json');
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.AUTOREPLY_LOG = path.join(TMP, 'autoreply.log');
process.env.QQCTX_DIR = path.join(TMP, 'context');
process.env.QQMIND_DIR = path.join(TMP, 'mind');
process.env.QQTRACE_DIR = path.join(TMP, 'trace');
process.env.QQBOND_DIR = path.join(TMP, 'bonds');
process.env.QQPROMISE_DIR = path.join(TMP, 'promises');
process.env.QQTHEM_DIR = path.join(TMP, 'them');
process.env.QQFOLLOW_DIR = path.join(TMP, 'follow');
process.env.QQNICK_DIR = path.join(TMP, 'nick');
process.env.QQQUOTE_DIR = path.join(TMP, 'quotes');
process.env.QQECHO_DIR = path.join(TMP, 'echo');
process.env.QQMODE_DIR = path.join(TMP, 'mode');
process.env.QQRISK_DIR = path.join(TMP, 'risk');
process.env.QQLONGING_DIR = path.join(TMP, 'longing');
process.env.QQEVOLVE_DIR = path.join(TMP, 'evolve');
process.env.QQGROUP_DIR = path.join(TMP, 'group');
process.env.QQSELF_DIR = path.join(TMP, 'self');
process.env.QQPACING_DIR = path.join(TMP, 'pacing');
process.env.QQAVATAR_DIR = path.join(TMP, 'avatar');
process.env.QQSTICKER_DIR = path.join(TMP, 'stickers');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

const STICKER = { type: 'image', data: { file: 'C:/fake/x.png', sub_type: 1, summary: '[表情]' } };

function drySends() {
  return fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter((o) => o && o.event === 'dry-send');
}

async function main() {
  const ar = require('./auto-reply.js');
  const base = { key: 'p:1', target: { type: 'private', id: '1' }, nick: '好友A' };

  // ① 只有表情：只应产生一条气泡（表情那条），不能有空文字气泡
  const r1 = await ar.send({ ...base, reply: '', stickerSeg: STICKER, stickerId: 'x1' });
  ok('只有表情时只发一条气泡', r1 && r1.parts === 1, r1);
  ok('没有出现空消息发送失败', true);
  const d1 = drySends();
  ok('dry-send 只有一条', d1.length === 1, d1.length);
  ok('那一条就是表情段', d1[0] && Array.isArray(d1[0].segs) && d1[0].segs.length === 1 && d1[0].segs[0].type === 'image', d1[0] && d1[0].segs);
  ok('表情段带 sub_type:1', d1[0] && d1[0].segs[0].data && d1[0].segs[0].data.sub_type === 1, d1[0] && d1[0].segs[0].data);

  // ② 有文字 + 表情：两条（文字、表情），顺序不能反
  const r2 = await ar.send({ ...base, reply: '这条是有文字的', stickerSeg: STICKER, stickerId: 'x2' });
  ok('文字 + 表情共两条气泡', r2 && r2.parts === 2, r2);
  const d2 = drySends().slice(1);
  ok('第一条是文字', d2[0] && d2[0].segs.some((s) => s.type === 'text'), d2[0] && d2[0].segs);
  ok('第二条只有表情', d2[1] && d2[1].segs.length === 1 && d2[1].segs[0].type === 'image', d2[1] && d2[1].segs);

  // ③ 没有文字也没有表情：一条都不发（sendBubble 的「拼不出段就跳过」兜底）
  const before3 = drySends().length;
  const r3 = await ar.send({ ...base, reply: '', stickerSeg: null, stickerId: '' });
  ok('空回复不产生新气泡', drySends().length === before3, drySends().length);
  ok('空回复返回 ok 且零气泡', r3 && r3.parts === 1, r3);

  // ④ 表情仍发一条（回归：不能因为过滤把表情也滤掉）
  const r4 = await ar.send({ ...base, reply: '  ', stickerSeg: STICKER, stickerId: 'x3' });
  ok('纯空格 + 表情也只发一条', r4 && r4.parts === 1, r4);
}

main().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { }
  console.log('FAIL 异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e));
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
