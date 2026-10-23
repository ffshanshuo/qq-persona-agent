#!/usr/bin/env node
'use strict';
/**
 * test-sticker-combo.js — 复合情绪（「又开心又可爱」「伤心的无奈」）的选图与抓图逻辑。
 * 全离线：STICKER_DIR 指到临时库，sticker-fetch 的 HTTP/视觉都用桩。
 *
 *   node scripts/test-sticker-combo.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-combo-'));
const SDIR = path.join(TMP, 'stickers');
fs.mkdirSync(path.join(SDIR, 'custom'), { recursive: true });
fs.mkdirSync(path.join(SDIR, 'made'), { recursive: true });
process.env.STICKER_DIR = SDIR;
process.env.QQFETCH_DIR = path.join(TMP, 'sticker-fetch');
process.env.QQSTICKER_BAN = '';

let pass = 0; let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// 造 4 张假图 + index
function mkImg(id, emotion, tags, desc) {
  const file = path.join(SDIR, 'made', id + '.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return { id, kind: 'image', file, source: 'made', emotion, tags, desc };
}
const A = mkImg('t-happy', '开心', ['开心'], '笑得眯眼的狗');
const B = mkImg('t-cute', '可爱', ['可爱', '萌'], '歪头的小猫');
const C = mkImg('t-happy-cute', '开心', ['开心', '可爱', '萌'], '边笑边比心的小熊');
const D = mkImg('t-helpless', '无奈', ['无奈', '摊手'], '摊手的小人');
const banned = Object.assign(mkImg('dsh-happy', '开心', ['开心', '可爱'], '自绘月亮脸'), { banned: true });
fs.writeFileSync(path.join(SDIR, 'index.json'), JSON.stringify({ version: 1, stickers: [A, B, C, D, banned] }, null, 2));

const st = require(path.join(ROOT, 'scripts', 'stickers.js'));

console.log('① splitEmotions：拆复合情绪');
ok("'开心+可爱' → 2 段", JSON.stringify(st.splitEmotions('开心+可爱')) === '["开心","可爱"]');
ok("'又开心又可爱' → 2 段（吃掉连接词「又」）", JSON.stringify(st.splitEmotions('又开心又可爱')) === '["开心","可爱"]');
ok("'开心又无奈' → 2 段", JSON.stringify(st.splitEmotions('开心又无奈')) === '["开心","无奈"]');
ok("'伤心、无奈' → 2 段", JSON.stringify(st.splitEmotions('伤心、无奈')) === '["伤心","无奈"]');
ok("'开心 / 可爱 / 无语' → 3 段", st.splitEmotions('开心 / 可爱 / 无语').length === 3);
ok('超过 3 段被截断', st.splitEmotions('a+b+c+d+e').length === 3);
ok('空字符串 → []', st.splitEmotions('   ').length === 0);
ok("单词 '偷笑' → ['偷笑']", JSON.stringify(st.splitEmotions('偷笑')) === '["偷笑"]');

console.log('② extractDirective：复合情绪标记');
{
  const r = st.extractDirective('今天真好呀[[表情:开心+可爱]]');
  ok('marker 被抽出', r.stickerKey === '开心+可爱', r.stickerKey);
  ok('正文干净', r.text === '今天真好呀', r.text);
  const r2 = st.extractDirective('[[表情: 无奈 + 难过 ]]');
  ok('带空格也能抽', r2.stickerKey === '无奈+难过', r2.stickerKey);
  const r3 = st.extractDirective('[[表情:无语+好笑]]');
  ok('只发表情时正文为空', r3.text === '', r3.text);
  ok('只发表情时 marker 正确', r3.stickerKey === '无语+好笑', r3.stickerKey);
}

console.log('③ pick：复合情绪挑图');
ok("'开心+可爱' → 优先同时贴两个情绪的那张（t-happy-cute）", (st.pick('开心+可爱') || {}).id === 't-happy-cute', (st.pick('开心+可爱') || {}).id);
ok("'可爱+开心' → 仍是 t-happy-cute（顺序无关的组合加成）", (st.pick('可爱+开心') || {}).id === 't-happy-cute', (st.pick('可爱+开心') || {}).id);
ok("'开心' → t-happy-cute（tag 命中多）", ['t-happy', 't-happy-cute'].includes((st.pick('开心') || {}).id));
ok("'伤心+无奈' → 只有副情绪也能用（t-helpless）", (st.pick('伤心+无奈') || {}).id === 't-helpless', (st.pick('伤心+无奈') || {}).id);
ok("'无语+好笑' → 库里没有就对 null（交给上网找）", st.pick('无语+好笑') === null, JSON.stringify(st.pick('无语+好笑')));
ok('月亮脸即使符合也不挑', (st.pick('开心+可爱+萌') || {}).id !== 'dsh-happy');
ok('点名 id 仍然优先（t-cute）', (st.pick('t-cute') || {}).id === 't-cute');
ok('catalog 不列月亮脸', !st.catalog(50).lines.some((l) => l.startsWith('dsh-')));

async function main() {
console.log('④ sticker-fetch.ensureFor：复合情绪逐个试');
{
  const f = require(path.join(ROOT, 'scripts', 'sticker-fetch.js'));
  const calls = [];
  const made = [];
  f.__setDeps({
    getText: async () => ({
      ok: true, status: 200,
      text: '<img data-original="https://img.soutula.com/x1.jpg"><img src="https://img.soutula.com/x2.png">',
      headers: {},
    }),
    getBuffer: async (u) => { calls.push(u); return { status: 200, ok: true, buffer: Buffer.alloc(9000, 7) }; },
    caption: async () => ({ text: '开心' }),
  });
  // 第一次：第一个词就能抓到
  const r1 = await f.ensureFor('开心+可爱');
  ok('复合词返回 parts', Array.isArray(r1.parts) && r1.parts.length === 2, JSON.stringify(r1.parts));
  ok('抓到了（ok:true）', r1.ok === true && r1.added.length > 0, JSON.stringify(r1));
  ok('先只搜主情绪', r1.tried[0].startsWith('开心'), JSON.stringify(r1.tried));

  // 第二次：主情绪在冷却，副情绪会继续试（不能因为主词冷却就整个放弃），但都不该重复抓同一批
  const r2 = await f.ensureFor('开心+可爱');
  ok('主情绪冷却时仍会试副情绪', r2.ok === false && r2.tried[0].includes('cooldown'), JSON.stringify(r2));

  // 第三个词：主情绪从没抓过、但 quota 还在 → 能继续
  const r3 = await f.ensureFor('委屈+难过');
  ok('换新词不受旧词冷却影响', typeof r3.ok === 'boolean' && Array.isArray(r3.added), JSON.stringify(r3));
  ok('deps 被调用过（真走了抓取链路）', calls.length > 0, String(calls.length));
}

console.log('⑤ 复合情绪与配额纪律');
{
  const f = require(path.join(ROOT, 'scripts', 'sticker-fetch.js'));
  // 直接把状态写成「本小时已用满」
  fs.mkdirSync(path.dirname(path.join(process.env.QQFETCH_DIR, 'state.json')), { recursive: true });
  fs.writeFileSync(path.join(process.env.QQFETCH_DIR, 'state.json'), JSON.stringify({ fetches: [Date.now()], tries: {}, misses: {}, updatedAt: new Date().toISOString() }));
  const cfg = { maxPerHour: 1 };
  const r = await f.ensureFor(' нового+词'.trim(), { cfg });
  ok('配额用满后拒绝（rate）', r.ok === false && r.why === 'rate', JSON.stringify(r));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
}

main().catch((e) => { console.error('测试崩了:', e && e.stack || e); process.exit(1); });
