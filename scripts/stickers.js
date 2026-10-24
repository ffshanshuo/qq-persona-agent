#!/usr/bin/env node
'use strict';
/**
 * stickers.js — 表情包库：抓取 / 入库 / 描述 / 选图 / 发送。
 *
 * 思路（借鉴 AstrBot 那类「LLM 决定用哪个表情」的做法，但我们不引入 Python 框架）：
 *  1) 号主的「收藏表情」用 NapCat 的 fetch_custom_face 拿到，下载到 assets/stickers/custom/
 *  2) 动图先用 Pillow 转成 2x2 帧拼图 PNG（视觉模型只吃 png/jpeg），再用 Kilo 视觉模型
 *     标注情绪/画面/适用场景 → 存 assets/stickers/index.json
 *  3) 聊天时把「表情目录」压成几行塞进 brain 的 prompt，模型在回复末尾写 [[表情:关键词]]
 *  4) 发送时按关键词匹配到表情，图片走 image 段、系统表情走 face 段（发完可以删）
 *
 * CLI：
 *   node scripts/stickers.js refresh           # 抓收藏表情 → 下载 → 描述 → 入库
 *   node scripts/stickers.js list [--json]     # 看目录
 *   node scripts/stickers.js add <文件...>     # 把本地图片/表情加进库（自动描述）
 *   node scripts/stickers.js pick <关键词>      # 只匹配不发
 *   node scripts/stickers.js send <关键词> [私聊uin|group:gid]  # 真发（默认发给自己）
 */
const fs = require('fs');
const store = require('../lib/store.js');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIR = process.env.STICKER_DIR || path.join(ROOT, 'assets', 'stickers');
const CUSTOM = path.join(DIR, 'custom');
const MADE = path.join(DIR, 'made');
const INDEX = path.join(DIR, 'index.json');
const PREP = path.join(ROOT, 'scripts', 'sticker_prep.py');
const PY = process.env.STICKER_PYTHON || 'C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';

function ensureDirs() { for (const d of [DIR, CUSTOM, MADE]) fs.mkdirSync(d, { recursive: true }); }

function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    if (j && Array.isArray(j.stickers)) return j;
  } catch (_) { /* 空库 */ }
  return { version: 1, updatedAt: null, stickers: [] };
}
function saveIndex(idx) {
  ensureDirs();
  idx.updatedAt = new Date().toISOString();
  if (!store.writeJson(INDEX, idx)) errorLog('index-save-failed', INDEX);
}

// ── 系统表情（QQ face id）：不用下载，直接发 face 段，最像"真人随手发个表情" ──
const FACES = [
  { faceId: '14', emotion: '微笑', tags: ['微笑', '客气', '礼貌'] },
  { faceId: '21', emotion: '偷笑', tags: ['偷笑', '坏笑', '嘿嘿'] },
  { faceId: '13', emotion: '大笑', tags: ['开心', '笑', '大笑', '呲牙'] },
  { faceId: '4', emotion: '得意', tags: ['得意', '骄傲', '炫耀'] },
  { faceId: '23', emotion: '无语', tags: ['无语', '白眼', '嫌弃'] },
  { faceId: '33', emotion: '疑惑', tags: ['疑惑', '问号', '疑问', '不懂'] },
  { faceId: '22', emotion: '卖萌', tags: ['可爱', '卖萌', '乖巧'] },
  { faceId: '50', emotion: '委屈', tags: ['委屈', '可怜', '冤枉'] },
  { faceId: '5', emotion: '难过', tags: ['难过', '流泪', '伤心'] },
  { faceId: '9', emotion: '大哭', tags: ['大哭', '崩溃', '伤心'] },
  { faceId: '79', emotion: '拥抱', tags: ['拥抱', '抱抱', '安慰'] },
  { faceId: '80', emotion: '赞同', tags: ['强', '赞', '赞同', '厉害'] },
  { faceId: '82', emotion: '握手', tags: ['握手', '成交', '约定'] },
  { faceId: '83', emotion: '加油', tags: ['胜利', '加油', '耶'] },
  { faceId: '67', emotion: '爱心', tags: ['爱心', '喜欢', '比心'] },
  { faceId: '76', emotion: '晚安', tags: ['月亮', '晚安', '睡觉'] },
  { faceId: '64', emotion: '道谢', tags: ['玫瑰', '谢谢', '道谢'] },
  { faceId: '8', emotion: '疲惫', tags: ['睡', '困', '疲惫', '晚安'] },
  { faceId: '178', emotion: '大笑', tags: ['笑哭', '斜眼笑', '绷不住'] },
  { faceId: '182', emotion: '无语', tags: ['狗头', '无语', '滑稽'] },
];

function faceStickers() {
  return FACES.map((f) => ({
    id: `face${f.faceId}`,
    kind: 'face',
    faceId: f.faceId,
    emotion: f.emotion,
    desc: `QQ 系统表情：${f.emotion}`,
    tags: f.tags,
    source: 'system',
  }));
}

// ── 动图 → PNG 拼图（视觉模型只吃 png/jpeg） ──────────────────────────────
function isVisionReady(file) { return /\.(png|jpe?g)$/i.test(file); }

function prepWithPython(file) {
  const out = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.sheet.png');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) return out;
  const { execFileSync } = require('child_process');
  execFileSync(PY, [PREP, file, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

/** 把任意图片整理成能喂视觉模型的文件（gif/webp → sheet.png；png/jpg 原样） */
function visionFile(file) {
  if (isVisionReady(file)) return file;
  return prepWithPython(file);
}

// ── 抓号主的收藏表情 ──────────────────────────────────────────────────────
async function download(url, destBase) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const ext = detectExt(buf);
  const file = `${destBase}-${md5.slice(0, 10)}.${ext}`;
  fs.writeFileSync(path.join(CUSTOM, file), buf);
  return { file: path.join(CUSTOM, file), md5, bytes: buf.length };
}

function detectExt(b) {
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.slice(8, 12).toString() === 'WEBP') return 'webp';
  return 'bin';
}

async function refresh({ caption = true, quiet = false } = {}) {
  ensureDirs();
  const { call } = require('./qq.js');
  const r = await call('fetch_custom_face', {});
  const urls = Array.isArray(r && r.data) ? r.data : [];
  if (!urls.length) throw new Error('fetch_custom_face 没有返回收藏表情（号主没收藏过表情？）');
  const idx = loadIndex();
  const byFile = new Map(idx.stickers.filter((s) => s.file).map((s) => [path.basename(s.file), s]));
  const added = [];
  for (let i = 0; i < urls.length; i++) {
    const { file, md5 } = await download(urls[i], `custom${String(i).padStart(2, '0')}`);
    const base = path.basename(file);
    if (byFile.has(base)) continue;
    // 同 md5 已入库（不同序号命中的同一张）
    if (idx.stickers.some((s) => s.md5 === md5)) { fs.unlinkSync(file); continue; }
    const entry = { id: base.replace(/\.[^.]+$/, ''), kind: 'image', file, md5, source: 'custom', emotion: '', desc: '', tags: [] };
    if (caption) {
      try {
        const vf = visionFile(file);
        entry.sheet = vf !== file ? vf : undefined;
        const c = require('./vision.js');
        const cap = await c.captionSticker(vf);
        entry.emotion = cap.emotion || '其他';
        entry.desc = cap.desc || '';
        entry.tags = cap.tags && cap.tags.length ? cap.tags : [cap.emotion].filter(Boolean);
        entry.captionModel = cap.model;
        if (!quiet) console.log(`  ✓ ${base} → ${entry.emotion}｜${entry.desc}`);
      } catch (e) {
        entry.emotion = entry.emotion || '其他';
        entry.desc = entry.desc || '（未标注）';
        if (!quiet) console.error(`  ! ${base} 标注失败：${e.message}`);
      }
    }
    idx.stickers.push(entry);
    added.push(entry);
  }
  saveIndex(idx);
  return { total: idx.stickers.length, added: added.length, files: added.map((a) => path.basename(a.file)) };
}

// ── 本地新增 ──────────────────────────────────────────────────────────────
async function addLocal(files, { caption = true } = {}) {
  ensureDirs();
  const idx = loadIndex();
  const added = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    const buf = fs.readFileSync(abs);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (idx.stickers.some((s) => s.md5 === md5)) continue;
    const dest = path.join(MADE, path.basename(abs));
    if (path.resolve(dest) !== abs) fs.copyFileSync(abs, dest);
    const entry = { id: path.basename(dest).replace(/\.[^.]+$/, ''), kind: 'image', file: dest, md5, source: 'made', emotion: '', desc: '', tags: [] };
    if (caption) {
      try {
        const vf = visionFile(dest);
        entry.sheet = vf !== dest ? vf : undefined;
        const cap = await require('./vision.js').captionSticker(vf);
        entry.emotion = cap.emotion || '其他';
        entry.desc = cap.desc || '';
        entry.tags = cap.tags && cap.tags.length ? cap.tags : [cap.emotion].filter(Boolean);
      } catch (e) {
        entry.emotion = '其他';
        entry.desc = '（未标注）';
        console.error(`! ${path.basename(dest)} 标注失败：${e.message}`);
      }
    }
    idx.stickers.push(entry);
    added.push(entry);
  }
  saveIndex(idx);
  return added;
}

// ── 目录 & 选图 ───────────────────────────────────────────────────────────
function allStickers() {
  const idx = loadIndex();
  const faces = faceStickers();
  // 系统表情放前面（最常用），图片表情后置
  return [...faces, ...idx.stickers];
}

/** 给 brain 看的压缩目录：id|情绪|一句话|关键词（图片表情在前，系统小黄脸兜底） */
function catalog(limit = 40, { allowFace = false, ban } = {}) {
  const prefixes = banPrefixesOf({ ban });
  const arr = allStickers().filter((s) => !isBanned(s, prefixes));
  const faces = allowFace ? arr.filter((s) => s.kind === 'face') : [];
  const images = arr.filter((s) => s.kind === 'image' && s.desc && s.desc !== '（未标注）');
  const picked = [...images.slice(0, limit), ...faces.slice(0, 12)];
  const lines = [];
  const imgCount = Math.min(images.length, limit);
  picked.forEach((s, i) => {
    if (i === imgCount && faces.length) lines.push('（下面这些是系统小黄脸，只在没有合适的图片表情时兜底）');
    const tags = (s.tags || []).slice(0, 4).join('、');
    lines.push(`${s.id}|${s.emotion || '其他'}|${String(s.desc || '').slice(0, 40)}${tags ? '|' + tags : ''}`);
  });
  return { lines, count: picked.length, hasImages: images.length > 0 };
}

// ── 禁用名单：用户明确点名不要的表情（2026-10-24「别发这种月亮脸」）──────────
// 默认禁掉自绘的月亮脸 dsh-*（assets/stickers/made/dsh-*.png）；
// 需要临时放开：环境变量 QQSTICKER_BAN='' 或调用时传 { ban: [] }。
const DEFAULT_BAN = ['dsh-'];
function banPrefixesOf(opts = {}) {
  const env = String(process.env.QQSTICKER_BAN || '').trim();
  const raw = (opts && Array.isArray(opts.ban)) ? opts.ban : (env ? env.split(',') : DEFAULT_BAN);
  return raw.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
}
/** 这张是否被禁用：单条 banned 标记，或 id 命中禁用前缀 */
function isBanned(s, prefixes) {
  if (!s) return false;
  if (s.banned === true) return true;
  const id = norm(s.id);
  return (prefixes || []).some((pre) => id.startsWith(pre));
}
function norm(s) { return String(s || '').trim().toLowerCase(); }

// ── 复合情绪（2026-10-24 用户：真实聊天常是「又开心又可爱」「伤心的无奈」）──
// brain 可以写 [[表情:开心+可爱]]、[[表情:难过+无奈]]，用 + 、 / 又 分隔，最多三个词。
const EMO_SPLIT = /[+＋/\\、,，·・&|｜]+/;
const COMBO_BONUS = 10;
const COMBO_WEIGHTS = [1, 0.7, 0.5];

/** 拆复合情绪：'开心+可爱' → ['开心','可爱']；单词返回 [word] */
function splitEmotions(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  // 「又开心又可爱」「开心又无奈」里的连接词也当分隔符
  const stripped = raw.replace(/^[又且并]+|[又且并]+$/g, '');
  const normalized = stripped
    .replace(/([\u4e00-\u9fa5])又(?=[\u4e00-\u9fa5])/g, '$1+')
    .replace(/([\u4e00-\u9fa5])且(?=[\u4e00-\u9fa5])/g, '$1+');
  const out = [];
  for (const part of normalized.split(EMO_SPLIT)) {
    const p = norm(part).replace(/[\s~～]+/g, '');
    if (!p || p.length > 12) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= 3) break;
  }
  return out;
}

/** 单个情绪词对某张表情的匹配分（不含 id 全等，那层在 pick 里先判） */
function scorePart(s, part) {
  if (!part) return 0;
  let sc = 0;
  if (norm(s.emotion) === part) sc += 60;
  if (norm(s.emotion).includes(part) || part.includes(norm(s.emotion))) sc += 25;
  for (const t of s.tags || []) {
    const nt = norm(t);
    if (nt === part) sc += 40;
    else if (nt.includes(part) || part.includes(nt)) sc += 18;
  }
  if (norm(s.desc).includes(part)) sc += 10;
  return sc;
}

// ── 表情反馈学习：从对方的反应里学「这个表情到底好不好笑」──────────────────
// 2026-10-24：用户要求各种规则持续进化；表情也一样——发出去后对方笑了就加分，被嫌弃就减分。
const REACTION_NEG = /别发(这个|这种|这些)?|不好(看|笑)|不喜欢|别再发|换一个|这是(啥|什么)|太丑|幼稚/;
const REACTION_POS = /哈哈+|笑死|好可爱|可爱|好好笑|好笑|好玩|这个好|喜欢|萌|爱了|绝了/;
const LEARN = { likeScore: 1, dislikeScore: 2, autoBanAt: -3, biasPerPoint: 6, biasMax: 18, biasMin: -24 };

/** 对方下一句话是对表情的反应吗：positive / negative / neutral（只看词，不调模型） */
function judgeReaction(text) {
  const t = String(text || '');
  if (!t) return 'neutral';
  if (REACTION_NEG.test(t)) return 'negative';
  if (REACTION_POS.test(t)) return 'positive';
  return 'neutral';
}
function learnScore(s) { return Number((s && s.learnScore) || 0); }
/** 学习分转成选图时的加减分（限幅，避免一次反应就翻盘） */
function biasOf(s) { return Math.max(LEARN.biasMin, Math.min(LEARN.biasMax, learnScore(s) * LEARN.biasPerPoint)); }
/** 被嫌弃到一定程度的图不再自动挑（点名 id 仍然照办） */
function isAutoBanned(s) { return s && s.kind === 'image' && learnScore(s) <= LEARN.autoBanAt; }

function updateSticker(id, fn) {
  const idx = loadIndex();
  const s = (idx.stickers || []).find((x) => x.id === id);
  if (!s) return null;
  fn(s);
  s.learnUpdatedAt = new Date().toISOString();
  saveIndex(idx);
  return s;
}
/** 发出去了（只统计真发成功的那次） */
function noteSent(id, now = Date.now()) {
  return updateSticker(id, (s) => { s.sent = (Number(s.sent) || 0) + 1; s.lastSentAt = now; });
}
/** 对方有反应：positive 加分、negative 减分、neutral 只记一次回复 */
function noteOutcome(id, outcome) {
  return updateSticker(id, (s) => {
    s.replied = (Number(s.replied) || 0) + 1;
    if (outcome === 'positive') { s.likes = (Number(s.likes) || 0) + 1; s.learnScore = learnScore(s) + LEARN.likeScore; }
    else if (outcome === 'negative') { s.dislikes = (Number(s.dislikes) || 0) + 1; s.learnScore = learnScore(s) - LEARN.dislikeScore; }
  });
}
/** 明显嫌弃（「别发这个」「这个不好笑」）：一次算两次嫌 */
function noteDislike(id) {
  return updateSticker(id, (s) => {
    s.dislikes = (Number(s.dislikes) || 0) + 1;
    s.learnScore = learnScore(s) - LEARN.dislikeScore * 2;
  });
}

/** 按 id / 情绪（可复合）/ 标签 / 描述 找最合适的一个（返回 null 表示没有合适的）
 *  优先级：① brain 点名某张（id 完全一致）照办 → ② 图片表情包（用户要求：贴图优先于系统小黄脸）→ ③ 系统小黄脸兜底 */
function pick(query, { allowImage = true, allowFace = false, ban } = {}) {
  const q = norm(query);
  if (!q) return null;
  const parts = splitEmotions(query);
  const prefixes = banPrefixesOf({ ban });
  const arrAll = allStickers().filter((s) => !isBanned(s, prefixes));
  const arr = arrAll.filter((s) => !isAutoBanned(s));
  const usable = (s) => s.kind !== 'image' || fs.existsSync(s.file);

  // 复合：主情绪权重 1，副情绪递减；同时命中多个情绪再加分（这样「开心+可爱」会优先选两者都贴的图）
  const scoreEntry = (s) => {
    const bias = biasOf(s);
    if (parts.length <= 1) return scorePart(s, q) + bias;
    let total = 0;
    let matches = 0;
    parts.forEach((p, i) => {
      const sc = scorePart(s, p);
      if (sc >= 18) matches += 1;
      total += (COMBO_WEIGHTS[i] || 0.4) * sc;
    });
    if (matches > 1) total += COMBO_BONUS * (matches - 1);
    return total + bias;
  };
  const bestOf = (pool, threshold) => {
    let best = null;
    let bestScore = 0;
    for (const s of pool) {
      if (!usable(s)) continue;
      const sc = scoreEntry(s);
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return bestScore >= threshold ? best : null;
  };
  // ① 点名要某一张
  // 点名照办：学习分拉黑只影响「自动挑」，不影响点名（用户级 ban 仍然拦）
  const exact = arrAll.find((s) => norm(s.id) === q && usable(s));
  if (exact) return exact;
  // ② 图片表情包优先
  if (allowImage) {
    const img = bestOf(arr.filter((s) => s.kind === 'image'), 18);
    if (img) return img;
  }
  // ③ 系统小黄脸：用户要求「尽量少发」，默认不挑（只有 brain 点名 id 时上面 ① 已返回）
  if (!allowFace) return null;
  return bestOf(arr.filter((s) => s.kind === 'face'), 18);
}

/**
 * 转成 OneBot 消息段。
 * 图片表情不再走「普通图片」：带 sub_type:1 → NapCat 的 createValidSendPicElement 里 picSubType=1，
 * 在 QQ 里渲染/归档为「表情」，而不是一张图片。
 */
function segmentOf(s, { asSticker = true } = {}) {
  if (!s) return null;
  if (s.kind === 'face') return { type: 'face', data: { id: String(s.faceId) } };
  const data = { file: path.resolve(s.file) };
  if (asSticker) { data.sub_type = 1; data.summary = '[表情]'; }
  return { type: 'image', data };
}

/** 从 brain 原始输出里抽出 [[表情:xxx]] 指令 */
function extractDirective(raw) {
  let t = String(raw ?? '');
  let key = '';
  const re = /\[\[\s*(?:表情|sticker|emoji)\s*[:：]\s*([^\]\n]{1,30})\s*\]\]/gi;
  const m = re.exec(t);
  if (m) {
    // 复合情绪里手写的空格要收掉：'无奈 + 难过' → '无奈+难过'
    key = m[1].replace(/\s*([+＋/\\、,，·・&|｜])\s*/g, '$1').replace(/\s+/g, ' ').trim();
  }
  t = t.replace(re, '').trim();
  return { text: t, stickerKey: key };
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  (async () => {
    if (cmd === 'refresh') {
      const r = await refresh({ quiet: argv.includes('--quiet') });
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'list') {
      if (argv.includes('--json')) return console.log(JSON.stringify(allStickers(), null, 2));
      const c = catalog(200);
      console.log(`${c.count} 个表情（形象 ${c.hasImages ? '有' : '无'}）：`);
      console.log(c.lines.join('\n'));
    } else if (cmd === 'add') {
      const added = await addLocal(rest);
      console.log(JSON.stringify(added.map((a) => ({ id: a.id, emotion: a.emotion, desc: a.desc, tags: a.tags })), null, 2));
    } else if (cmd === 'pick') {
      const s = pick(rest.join(' '));
      console.log(s ? JSON.stringify(s, null, 2) : '没有匹配的表情');
    } else if (cmd === 'send') {
      const key = rest[0];
      const target = rest[1] || String(process.env.SELF_UIN || '123456789');
      const s = pick(key);
      if (!s) { console.error('没有匹配的表情：' + key); process.exit(1); }
      const { call } = require('./qq.js');
      const seg = segmentOf(s);
      const r = target.startsWith('group:')
        ? await call('send_group_msg', { group_id: Number(target.slice(6)), message: [seg] })
        : await call('send_private_msg', { user_id: Number(target), message: [seg] });
      console.log(JSON.stringify({ sticker: s.id, target, resp: { status: r.status, retcode: r.retcode, message_id: r.data && r.data.message_id } }, null, 2));
      if (argv.includes('--delete') && r && r.data && r.data.message_id) {
        await call('delete_msg', { message_id: r.data.message_id });
        console.log('已撤回');
      }
    } else {
      console.log('用法: node scripts/stickers.js refresh|list|add <文件...>|pick <关键词>|send <关键词> [私聊uin|group:gid]');
    }
  })().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}

module.exports = { splitEmotions, scorePart, judgeReaction, noteSent, noteOutcome, noteDislike, learnScore, biasOf, isAutoBanned, LEARN, refresh, addLocal, loadIndex, saveIndex, allStickers, catalog, pick, segmentOf, extractDirective, visionFile, faceStickers, FACES, DEFAULT_BAN, banPrefixesOf, isBanned };
