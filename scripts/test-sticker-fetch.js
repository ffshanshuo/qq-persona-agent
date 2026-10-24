/**
 * test-sticker-fetch.js —— 「库里没有就上网找」离线测试（不联网、不调模型）
 *
 * 覆盖：开关/坏关键词/dry、搜索→下载→打标→入库、pick 之后能挑到、
 *       同词冷却、每小时配额、md5 去重、预算内不无限下载、月亮脸禁用不受影响。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'assets', 'stickers-test');
process.env.STICKER_DIR = TMP;
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-sticker-fetch-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-sticker-fetch-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-sticker-fetch-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQFETCH_DIR = path.join(ROOT, 'logs', 'sticker-fetch-test');

// 干净夹具
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'web'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'index.json'), JSON.stringify({
  version: 1,
  stickers: [
    { id: 'dsh-happy', kind: 'image', file: path.join(TMP, 'made', 'dsh-happy.png'), md5: 'x1', source: 'made', emotion: '开心', desc: '月亮脸', tags: ['开心'], banned: true },
    { id: 'dsc-one', kind: 'image', file: path.join(TMP, 'made', 'dsc-one.png'), md5: 'x2', source: 'made', emotion: '开心', desc: '真的开心', tags: ['开心'] },
  ],
}, null, 2));
fs.mkdirSync(path.join(TMP, 'made'), { recursive: true });
// pick 需要文件存在
fs.writeFileSync(path.join(TMP, 'made', 'dsc-one.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(path.join(TMP, 'made', 'dsh-happy.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const fetchMod = require('./sticker-fetch.js');
const stickers = require('./stickers.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 200) : '')); }
}

// ── 假 HTTP / 假视觉 ────────────────────────────────────────────────────
const jpg = (n) => {
  const b = Buffer.alloc(6000 + n, 0x20);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b;
};
let fetched = [];
const calls = { text: 0, buf: 0, caption: 0 };
fetchMod.__setDeps({
  getText: async (url) => {
    calls.text++;
    return {
      ok: true, status: 200,
      text: `<div><img data-original="https://img.soutula.com/bmiddle/a${calls.text}.jpg">` +
        `<img data-original="https://img.soutula.com/bmiddle/b${calls.text}.gif">` +
        `<img src="https://example.com/not-allowed.png"></div>`,
    };
  },
  getBuffer: async (url) => { calls.buf++; fetched.push(url); return { ok: true, status: 200, buffer: jpg(calls.buf) }; },
  caption: async () => { calls.caption++; return { emotion: '委屈', desc: '猫猫耷拉着眼，委屈巴巴', tags: ['委屈', '可怜'] }; },
});

(async () => {
  // ── 闸门 ──
  ok('关掉后直接拒绝', (await fetchMod.ensureFor('委屈', { cfg: { enabled: false } })).why === 'disabled');
  ok('空关键词拒绝', (await fetchMod.ensureFor('  ')).why === 'bad-keyword');
  process.env.STICKER_FETCH_DRY = '1';
  ok('dry 模式不抓', (await fetchMod.ensureFor('委屈')).why === 'dry');
  delete process.env.STICKER_FETCH_DRY;

  // ── 真抓：搜索 → 下载 → 打标 → 入库 ──
  const before = stickers.allStickers().filter((s) => s.source === 'web').length;
  const r1 = await fetchMod.ensureFor('委屈', { maxDownload: 2 });
  ok('第一次抓取成功', r1.ok === true && r1.added.length > 0, r1);
  ok('新增条数 = 2（maxDownload 限制生效）', r1.added.length === 2, r1.added);
  ok('只下载白名单域名（example.com 被过滤）', fetched.every((u) => /soutula|fabiaoqing|aigengtu|qpic/.test(u)), fetched);
  ok('优先试 large 再退回 bmiddle', fetched.some((u) => u.includes('/large/')), fetched.slice(0, 3));
  const web = stickers.allStickers().filter((s) => s.source === 'web');
  ok('库里有 web 来源条目', web.length === before + 2, web.length);
  ok('条目带情绪与描述（视觉打标）', web.every((e) => e.emotion === '委屈' && /委屈/.test(e.desc)), web.map((e) => [e.emotion, e.desc]));
  ok('条目带来源关键词与时间', web.every((e) => e.foundBy === '委屈' && e.fetchedAt), web[0]);
  ok('图片文件真的落盘', web.every((e) => fs.existsSync(e.file)), web.map((e) => e.file));
  ok('pick 之后能挑到新表情', (stickers.pick('委屈') || {}).source === 'web', stickers.pick('委屈'));
  ok('catalog 里能看到新表情', stickers.catalog(80).lines.some((l) => l.startsWith('web-')), null);

  // ── 冷却与配额 ──
  ok('同词很快再抓会被冷却挡住', (await fetchMod.ensureFor('委屈')).why === 'cooldown');
  const r2 = await fetchMod.ensureFor('生气', { maxDownload: 2, cfg: { maxPerHour: 0 } });
  ok('每小时配额用完就拒', r2.why === 'rate', r2);

  // ── md5 去重 ──
  let same = 0;
  const jpg2 = (n) => { const x = Buffer.alloc(7000 + n, 0x41); x[0] = 0xff; x[1] = 0xd8; x[2] = 0xff; x[3] = 0xe0; return x; };
  fetchMod.__setDeps({
    getText: async () => ({ ok: true, status: 200, text: '<img data-original="https://img.soutula.com/bmiddle/dup.jpg">' }),
    getBuffer: async () => { same++; return { ok: true, status: 200, buffer: jpg2(1) }; }, // 永远同一份字节
    caption: async () => ({ emotion: '开心', desc: '重复', tags: [] }),
  });
  const st0 = fetchMod.loadState();
  st0.tries = {}; st0.fetches = [];
  fetchMod.saveState(st0);
  const r3 = await fetchMod.ensureFor('重复测试', { maxDownload: 3 });
  ok('第一次入库成功', r3.ok && r3.added.length === 1, r3);
  const st1 = fetchMod.loadState(); st1.tries = {}; st1.fetches = [];
  fetchMod.saveState(st1);
  const r4 = await fetchMod.ensureFor('重复测试', { maxDownload: 3, cfg: { perKeywordCooldownMin: 0 } });
  ok('同 md5 第二次不入库', r4.ok === false && r4.why === 'all-failed', r4);
  ok('库里没有重复条目', stickers.allStickers().filter((s) => s.source === 'web' && s.md5).length ===
    new Set(stickers.allStickers().filter((s) => s.source === 'web').map((s) => s.md5)).size);

  // ── 月亮脸仍然禁 ──
  ok('月亮脸 dsh-* 依然挑不到（banned 标记生效）', stickers.pick('dsh-happy') === null);
  ok('月亮脸不在 catalog', !stickers.catalog(200).lines.some((l) => /^dsh-/.test(l)));

  // ── 清理 ──
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(process.env.QQFETCH_DIR, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试自身出错:', e && e.message); process.exit(1); });
