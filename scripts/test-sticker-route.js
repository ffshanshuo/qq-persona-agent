/**
 * test-sticker-route.js —— 表情「走表情包通道、少发系统小黄脸」自检（全离线）
 *
 * 用户 2026-10-24：「尽量少发 face 表情（不属于偏好），发贴图表情时，最好走表情包的发送途径，而不是图片的。」
 * 对应实现：
 *   - stickers.pick() 默认只在 image 里挑；face 仅当 brain 点名 id 时才发
 *   - stickers.catalog() 默认不把 face 列给模型
 *   - stickers.segmentOf() 给图片段加 sub_type:1 + summary '[表情]'（NapCat → picSubType:1，客户端按表情渲染）
 */
'use strict';
const path = require('path');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-sticker-route-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-sticker-route-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-sticker-route-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

const st = require('./stickers.js');

// 开源快照里 assets/stickers/index.json 是空模板（图片不随仓库分发）→ 与图片相关的断言自动跳过
const IMG_ITEMS = st.allStickers().filter((s) => s.kind === 'image' && !s.banned && !/^dsh-/.test(s.id));
const DASH_ITEMS = st.allStickers().filter((x) => /^dsh-/.test(x.id));
const hasImg = IMG_ITEMS.length > 0;
function okImg(name, cond, extra) {
  if (!hasImg) { pass++; console.log('skip ' + name + '（库里没有图片表情：开源快照不带图片）'); return; }
  ok(name, cond, extra);
}
function okDash(name, cond, extra) {
  if (DASH_ITEMS.length === 0) { pass++; console.log('skip ' + name + '（库里没有自绘月亮脸条目）'); return; }
  ok(name, cond, extra);
}

// ── pick：默认不发小黄脸 ─────────────────────────────────────
const emo = st.pick('开心');
okImg('按情绪挑 → 拿到图片表情', emo && emo.kind === 'image', emo && emo.kind);
for (const q of ['偷笑', '疑惑', '无语', '抱抱', '难过', '加油']) {
  const s = st.pick(q);
  ok(`「${q}」不落到系统小黄脸`, s === null || s.kind === 'image', s && { id: s.id, kind: s.kind });
}
const named = st.pick('face21');
ok('brain 点名 face21 → 照办（用户没说要禁绝）', named && named.kind === 'face' && named.id === 'face21', named && named.id);
const allowed = st.pick('偷笑', { allowFace: true });
ok('allowFace:true 时仍可挑到 face', allowed && (allowed.kind === 'image' || allowed.kind === 'face'), allowed && allowed.kind);
ok('pick 无关键词 → null', st.pick('') === null);
ok('pick 无匹配 → null（不硬凑）', st.pick('qwertyuiop') === null);

// ── 禁用名单：月亮脸 dsh-* 一律不发（用户 2026-10-24「别发这种月亮脸的表情」）──
ok('默认禁用名单以 dsh- 开头', JSON.stringify(st.DEFAULT_BAN) === JSON.stringify(['dsh-']), st.DEFAULT_BAN);
for (const q of ['开心','可爱','疑惑','偷笑','难过','加油','晚安'])
{ const s = st.pick(q); ok('【' + q + '】不会挑到月亮脸 dsh-*', !s || !/^dsh-/.test(s.id), s && s.id); }
ok('点名 dsh-happy 也不发（禁用优先于点名）', st.pick('dsh-happy') === null);
ok('catalog 里没有 dsh-* 行', st.catalog(40).lines.filter(l=>/^dsh-/.test(l)).length === 0);
ok('条目上的 banned 标记让它永久禁用（ban:[] 也放不开）', st.catalog(40,{ban:[]}).lines.filter(l=>/^dsh-/.test(l)).length === 0);
okDash('allStickers 仍保留这 8 张（只是不发）', DASH_ITEMS.length === 8);
// ── catalog：不把 face 列给模型 ──────────────────────────────
const cat = st.catalog(40);
const faceLines = cat.lines.filter(l => /^face\d/.test(l));
ok('默认目录里没有 faceXX 行', faceLines.length === 0, faceLines.slice(0, 3));
okImg('默认目录里有图片表情行', cat.lines.some(l => /^(dsh-|dsc-|fbq-|custom\d)/.test(l)), cat.lines.slice(0, 2));
ok('默认目录不出现「小黄脸兜底」提示行', !cat.lines.some(l => l.includes('兜底')), cat.lines.filter(l => l.includes('兜底')));
const catFace = st.catalog(40, { allowFace: true });
ok('allowFace:true 时目录里有 faceXX', catFace.lines.some(l => /^face\d/.test(l)), catFace.lines.slice(-3));

// ── segmentOf：图片走表情通道 ────────────────────────────────
const seg = hasImg ? st.segmentOf(emo) : null;
okImg('图片段 type=image', seg && seg.type === 'image', seg && seg.type);
okImg('图片段带 sub_type:1（表情而非普通图片）', seg && seg.data && seg.data.sub_type === 1, seg && seg.data);
okImg('图片段带 summary=[表情]', seg && seg.data && seg.data.summary === '[表情]', seg && seg.data && seg.data.summary);
okImg('图片段 file 是绝对路径', seg && path.isAbsolute(String(seg.data.file)), seg && seg.data && seg.data.file);
const plain = hasImg ? st.segmentOf(emo, { asSticker: false }) : null;
okImg('asSticker:false 时退回普通图片（无 sub_type）', plain && plain.data && plain.data.sub_type === undefined, plain && plain.data);
const faceSeg = st.segmentOf(named);
ok('face 段仍然是 face 类型', faceSeg && faceSeg.type === 'face' && faceSeg.data.id === '21', faceSeg);

// ── 与 auto-reply 的接口一致（只检查导出存在，不跑网络） ─────
const ar = require('./auto-reply.js');
ok('auto-reply 导出 buildMessage（表情单独气泡）', typeof ar.buildMessage === 'function');
const msg = ar.buildMessage({ key: 'p:1', target: { type: 'private', id: '1' }, reply: '', stickerSeg: seg, stickerOnly: true, noAt: false });
okImg('stickerOnly 气泡里就是表情段', Array.isArray(msg) && msg.length === 1 && msg[0].type === 'image' && msg[0].data.sub_type === 1, msg);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
