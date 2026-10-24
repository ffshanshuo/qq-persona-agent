#!/usr/bin/env node
'use strict';
/**
 * avatar.js —— 自己的头像：生成 / 挑选 / 更换
 *
 * 纯 Node 手写 PNG（无第三方依赖），不联网。头像 = 「月夜 + 月亮脸 + 当天的情绪配色」。
 *
 * 用法：
 *   node scripts/avatar.js variants            # 有哪些款式
 *   node scripts/avatar.js preview             # 全部渲染到 assets/avatars/（不改线上）
 *   node scripts/avatar.js render <款> [尺寸]   # 只渲染一张
 *   node scripts/avatar.js plan                # 按当前情绪/季节推荐一款（不执行）
 *   node scripts/avatar.js apply [款]           # 渲染并真的换上去（走 risk 闸门）
 *   node scripts/avatar.js status              # 上次换的时间、本月次数
 *
 * 自动换：config/avatar.json 的 enabled 默认 false。打开后 auto-reply 每 12h 检查一次，
 * 满足「距上次 ≥ minGapDays 天、本月 ≤ maxPerMonth 次」且 risk 闸门放行才会真换。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.QQAVATAR_DIR || path.join(ROOT, 'logs', 'avatar');
const OUTDIR = process.env.QQAVATAR_OUT || path.join(ROOT, 'assets', 'avatars');
const CFG_PATH = process.env.QQAVATAR_CONFIG || path.join(ROOT, 'config', 'avatar.json');

const DEFAULTS = {
  enabled: false,        // 自动换默认关：等用户点头再开
  checkEveryHours: 12,
  minGapDays: 0,         // 0 = 不限（用户 2026-10-24：「解除换头像次数限制」）
  maxPerMonth: 0,        // 0 = 不限
  size: 512,
  riskGate: true,        // 走 risk.gate('profile')，风控冷却期一律不动资料
  source: 'any',         // 从哪挑：any | web（网上找的）| peer（别人发的）
};
// 款式：同一套「月夜 + 月亮脸」，换的是色调与表情
const VARIANTS = [
  { id: 'calm',    label: '平静夜',   sky: [[14, 18, 52], [42, 40, 88]],  moon: [252, 248, 226], eye: 'dot',     mouth: 'flat',   blush: 0.10, prop: 'stars' },
  { id: 'happy',   label: '开心夜',   sky: [[22, 20, 62], [78, 52, 104]],  moon: [255, 250, 226], eye: 'crescent', mouth: 'smile',  blush: 0.22, prop: 'stars' },
  { id: 'dusk',    label: '黄昏暖',   sky: [[46, 26, 62], [148, 84, 92]],  moon: [255, 240, 208], eye: 'dot',     mouth: 'smile',  blush: 0.26, prop: 'cloud' },
  { id: 'rain',    label: '雨天灰绿', sky: [[22, 36, 44], [54, 74, 82]],   moon: [232, 236, 228], eye: 'line',    mouth: 'flat',   blush: 0.06, prop: 'rain' },
  { id: 'sleepy',  label: '困困夜',   sky: [[18, 16, 44], [52, 44, 86]],   moon: [246, 240, 220], eye: 'closed',  mouth: 'small',  blush: 0.16, prop: 'zzz' },
  { id: 'think',   label: '想事情',   sky: [[16, 22, 56], [36, 52, 96]],   moon: [250, 246, 226], eye: 'dot',     mouth: 'tiny',   blush: 0.08, prop: 'moon' },
];
const byId = (id) => VARIANTS.find(v => v.id === id) || null;

// ───────────────────────── PNG ─────────────────────────
const CRC_TBL = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const b of td) crc = CRC_TBL[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const c = Buffer.alloc(4);
  c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, c]);
}

function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ───────────────────────── 绘制 ─────────────────────────
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const lerp = (a, b, t) => a + (b - a) * t;

/** 画一张头像，返回 RGBA Buffer */
function render(variantId, size = 512, seed = 20261024) {
  const v = byId(variantId) || VARIANTS[0];
  const S = size;
  const buf = Buffer.alloc(S * S * 4);
  const rnd = mulberry(seed + v.id.length * 977);
  const cx = S / 2, cy = S / 2;
  const faceR = S * 0.30;
  const fx = S * 0.5, fy = S * 0.47;

  // 星点
  const stars = [];
  for (let i = 0; i < Math.round(150 * (S / 512) ** 2 + 60); i++) {
    stars.push({ x: rnd() * S, y: rnd() * S * 0.82, r: 0.4 + rnd() * 1.5, a: 0.25 + rnd() * 0.6 });
  }
  // 云
  const clouds = v.prop === 'cloud' ? [
    { x: S * 0.22, y: S * 0.70, r: S * 0.16, a: 0.10 },
    { x: S * 0.72, y: S * 0.78, r: S * 0.20, a: 0.08 },
  ] : [];
  // 雨丝
  const rains = v.prop === 'rain' ? Array.from({ length: 70 }, () => ({
    x: rnd() * S, y: rnd() * S, len: S * (0.03 + rnd() * 0.05), a: 0.10 + rnd() * 0.14,
  })) : [];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const t = y / S;
      let r = lerp(v.sky[0][0], v.sky[1][0], t);
      let g = lerp(v.sky[0][1], v.sky[1][1], t);
      let b = lerp(v.sky[0][2], v.sky[1][2], t);

      // 星
      for (const s of stars) {
        const d = Math.hypot(x - s.x, y - s.y);
        if (d < s.r * 2.4) {
          const k = Math.max(0, 1 - d / (s.r * 2.4)) * s.a;
          r += 220 * k; g += 222 * k; b += 240 * k;
        }
      }
      // 云
      for (const c of clouds) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < c.r * 1.8) {
          const k = Math.max(0, 1 - d / (c.r * 1.8)) * c.a;
          r += 200 * k; g += 180 * k; b += 190 * k;
        }
      }
      // 雨丝
      for (const rr of rains) {
        if (Math.abs(x - rr.x) < 1.2 && y > rr.y && y < rr.y + rr.len) {
          r += 190 * rr.a; g += 200 * rr.a; b += 210 * rr.a;
        }
      }

      // 光晕
      const dm = Math.hypot(x - fx, y - fy);
      const glow = Math.max(0, 1 - dm / (S * 0.62));
      r += v.moon[0] * 0.22 * glow * glow;
      g += v.moon[1] * 0.22 * glow * glow;
      b += v.moon[2] * 0.26 * glow * glow;

      // 月盘
      if (dm < faceR) {
        const edge = Math.min(1, (faceR - dm) / 1.8);
        // 淡淡的下侧阴影，显得是个球
        const shade = 1 - 0.10 * Math.max(0, (y - fy) / faceR);
        // 环形山
        let crater = 1;
        const c1 = Math.hypot(x - (fx - faceR * 0.42), y - (fy - faceR * 0.30));
        if (c1 < faceR * 0.17) crater = 0.93;
        const c2 = Math.hypot(x - (fx + faceR * 0.5), y - (fy + faceR * 0.18));
        if (c2 < faceR * 0.12) crater = 0.95;
        const mr = v.moon[0] * shade * crater;
        const mg = v.moon[1] * shade * crater;
        const mb = v.moon[2] * shade * crater;
        r = lerp(r, mr, edge); g = lerp(g, mg, edge); b = lerp(b, mb, edge);
      }
      // 腮红
      const bl = v.blush;
      if (bl > 0) {
        for (const sx of [-1, 1]) {
          const bx = fx + sx * faceR * 0.52, by = fy + faceR * 0.22;
          const d = Math.hypot((x - bx) / 1.25, y - by);
          if (d < faceR * 0.20) {
            const k = Math.max(0, 1 - d / (faceR * 0.20)) * bl;
            r = lerp(r, 255, k * 0.75); g = lerp(g, 168, k * 0.55); b = lerp(b, 178, k * 0.55);
          }
        }
      }

      // 眼睛
      const eyeY = fy - faceR * 0.12;
      const eyeDx = faceR * 0.36;
      const eyeR = faceR * 0.085;
      for (const sx of [-1, 1]) {
        const ex = fx + sx * eyeDx;
        if (v.eye === 'dot') {
          const d = Math.hypot(x - ex, y - eyeY);
          if (d < eyeR) { const k = Math.min(1, (eyeR - d) / 1.5); r = lerp(r, 58, k); g = lerp(g, 52, k); b = lerp(b, 66, k); }
        } else if (v.eye === 'line' || v.eye === 'closed') {
          const dy = v.eye === 'line' ? 0 : Math.abs(x - ex) * 0.35;
          if (Math.abs(x - ex) < eyeR * 1.7 && Math.abs(y - (eyeY + dy)) < faceR * 0.022) {
            r = lerp(r, 58, 0.9); g = lerp(g, 52, 0.9); b = lerp(b, 66, 0.9);
          }
        } else if (v.eye === 'crescent') {
          const d1 = Math.hypot(x - ex, y - eyeY);
          const d2 = Math.hypot(x - ex, y - (eyeY + eyeR * 0.75));
          if (d1 < eyeR && d2 > eyeR * 0.95) { r = lerp(r, 58, 0.85); g = lerp(g, 52, 0.85); b = lerp(b, 66, 0.85); }
        }
      }

      // 嘴
      const my = fy + faceR * 0.30;
      if (v.mouth === 'smile') {
        const d = Math.abs(Math.hypot(x - fx, y - (my - faceR * 0.12)) - faceR * 0.20);
        if (y > my && y < my + faceR * 0.16 && d < faceR * 0.028) { r = lerp(r, 58, 0.8); g = lerp(g, 52, 0.8); b = lerp(b, 66, 0.8); }
      } else if (v.mouth === 'flat') {
        if (Math.abs(x - fx) < faceR * 0.13 && Math.abs(y - my) < faceR * 0.022) { r = lerp(r, 58, 0.75); g = lerp(g, 52, 0.75); b = lerp(b, 66, 0.75); }
      } else if (v.mouth === 'small') {
        const d = Math.hypot((x - fx) / 1.1, y - my);
        if (d < faceR * 0.045) { r = lerp(r, 58, 0.8); g = lerp(g, 52, 0.8); b = lerp(b, 66, 0.8); }
      } else if (v.mouth === 'tiny') {
        const d = Math.hypot(x - (fx + faceR * 0.04), y - my);
        if (d < faceR * 0.028) { r = lerp(r, 58, 0.8); g = lerp(g, 52, 0.8); b = lerp(b, 66, 0.8); }
      }

      // 暗角
      const vig = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / (S * 0.78));
      const vk = 0.62 + 0.38 * vig;
      buf[i] = clamp255(r * vk);
      buf[i + 1] = clamp255(g * vk);
      buf[i + 2] = clamp255(b * vk);
      buf[i + 3] = 255;
    }
  }
  drawZzz(buf, S, v, fx, fy, faceR);
  return buf;
}

/** 困困夜的 zzz（简单几十个像素的斜线，够表意了） */
function drawZzz(buf, S, v, fx, fy, faceR) {
  if (v.prop !== 'zzz') return;
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = ((y | 0) * S + (x | 0)) * 4;
    buf[i] = 250; buf[i + 1] = 250; buf[i + 2] = 240; buf[i + 3] = 255;
  };
  for (let k = 0; k < 3; k++) {
    const oy = fy - faceR * (1.15 + k * 0.30);
    const ox = fx + faceR * (0.55 + k * 0.34);
    const len = faceR * (0.24 - k * 0.05);
    for (let t = 0; t < len; t++) {
      put(ox + t, oy - t * 0.9); // 斜杠
    }
    for (let t = 0; t < len * 0.8; t++) { put(ox + t, oy); put(ox + t, oy + len * 0.6); } // 上下两横
  }
}

// ───────────────────────── 状态 / 配置 ─────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function loadCfg() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { cfg = {}; }
  return { ...DEFAULTS, ...cfg };
}
function stateFile() { return path.join(DIR, 'state.json'); }
function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return { lastAt: 0, used: [], history: [], ...st };
  } catch (e) {
    return { lastAt: 0, used: [], history: [] };
  }
}
function saveState(st) {
  ensureDir(DIR);
  const tmp = stateFile() + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, stateFile());
  } catch (e) {
    try { fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2)); } catch (e2) { }
  }
}

// ───────────────────────── 选款 ─────────────────────────
/** 按情绪/时段/季节挑一款（纯规则，可测） */

// ---- 聊天里触发换头像（用户 2026-10-24：「通过聊天对话可以触发挑选头像更换」）----
const CHAT_VERB = /(换|改|更新|变|挑|选|弄|来|用|做|设|设置)(一?下|一个|一张|个|张|副)?/;
const CHAT_NOUN = /头像/;

/** 从一句话里判出来源偏好：别人发的 / 网上找的 / 随便 */
function sourceOfWord(txt) {
  const t = String(txt || '');
  if (/别人发|他发|她发|TA发|淘发的|你发的|聊天里|对象发/.test(t)) return 'peer';
  if (/网上|联网|找一张|搜一张|搜个|动漫|二次元|图片|网图|随便找/.test(t)) return 'web';
  return 'any';
}

/** 是不是在让我换头像；说了来源就带上 source */
function parseRequest(text) {
  const t = String(text || '');
  if (!t || t.length > 60) return { hit: false, source: null };
  if (!CHAT_NOUN.test(t)) return { hit: false, source: null };
  if (!CHAT_VERB.test(t)) return { hit: false, source: null };
  // 「头像挺好看」这类夸赞不算
  if (/(好看|不错|喜欢|可爱|帅|漂亮)/.test(t) && !/(换|改|更新|变)/.test(t)) return { hit: false, source: null };
  return { hit: true, source: sourceOfWord(t) };
}

function chatCfg() {
  const c = loadCfg() || {};
  const cc = c.chat || {};
  return { enabled: true, cooldownMin: 0, ...cc };   // 0 = 不防抖（用户要求解除限制）
}

/**
 * 聊天触发的换头像：force=true（明确要求，不受间隔约束），风控闸门照旧。
 * cooldownMin=0 时不防抖。
 */
async function chatTrigger({ key, text, source = null, variant = null, now = Date.now(), dry = false } = {}) {
  const cc = chatCfg();
  if (cc.enabled === false) return { ok: false, changed: false, why: 'chat-trigger-disabled' };
  const st = loadState();
  const lastChat = (st.chatAt && st.chatAt[key]) || 0;
  const gapMin = Number(cc.cooldownMin) || 0;
  if (!dry && gapMin > 0 && now - lastChat < gapMin * 60000) {
    return { ok: false, changed: false, why: '刚换过，缓一会儿' };
  }
  const prefer = source || (variant ? sourceOfWord(variant) : null);
  const r = await consider({ now, force: true, dry, source: prefer });
  if (!dry && r.changed) {
    const st2 = loadState();
    st2.chatAt = { ...(st2.chatAt || {}), [key]: now };
    st2.lastSource = r.source || null;
    saveState(st2);
  }
  return { ...r, ok: Boolean(r.changed || r.dry) };
}

/** 换完回一句人话（自己说，不过模型，避免它把「换了头像」说成别的事） */
function replyText(r) {
  if (r && r.dry) return '（演练模式）这会儿会换成' + (r.label || '新头像') + '。';
  if (r && r.changed) return '换好了，用的是' + (r.label || '新图') + '，你看下。';
  const why = (r && r.why) || '没换成';
  if (/risk:/.test(why)) return '这会儿换不了头像（账号安全闸门在冷却），等会儿再说。';
  if (/刚换过/.test(why)) return '刚换过没一会儿，先让这个挂一阵子。';
  if (/没图可用/.test(why)) return '我这边还没攒到合适的图，先发我一张，或者我上网找找。';
  return '这次没换成功：' + why;
}
function choose({ pad, mood, now = Date.now(), used = [] } = {}) {
  const p = pad && typeof pad.p === 'number' ? pad.p : 0;
  const a = pad && typeof pad.a === 'number' ? pad.a : 0;
  const m = String(mood || '');
  const hour = new Date(now).getHours();
  const month = new Date(now).getMonth() + 1;
  const why = [];

  let id = 'calm';
  if (a < -0.2 || /困|累|疲/.test(m)) { id = 'sleepy'; why.push('状态偏困'); }
  else if (/雨|阴|闷/.test(m) || p < -0.25) { id = 'rain'; why.push('有点低落'); }
  else if (p > 0.25) { id = 'happy'; why.push('心情不错'); }
  else if (hour >= 17 && hour <= 20) { id = 'dusk'; why.push('天刚暗'); }
  else if (/想|琢磨|纠结/.test(m)) { id = 'think'; why.push('在想事情'); }

  // 季节兜底：秋冬偏暖色
  if (id === 'calm' && (month === 11 || month === 12 || month <= 2)) { id = 'dusk'; why.push('天冷了'); }

  // 最近用过就换一个，避免连换两次一样
  if (used.includes(id)) {
    const alt = VARIANTS.map(v => v.id).find(x => x !== id && !used.slice(-3).includes(x));
    why.push('上次就是这款');
    id = alt || id;
  }
  return { id, why: why.join('、') || '常规' };
}

// ───────────────────────── 换头像 ─────────────────────────
function renderTo(variantId, size = 512) {
  const v = byId(variantId) || VARIANTS[0];
  const file = path.join(OUTDIR, `avatar-${v.id}.png`);
  writePng(file, size, size, render(v.id, size));
  return file;
}

/** risk 闸门：冷却期/额度用完时不碰资料 */
function riskOk() {
  try {
    const g = require('./risk.js').gate('profile');
    return { ok: g.ok, why: g.why || '' };
  } catch (e) {
    return { ok: true, why: 'risk 不可用（跳过检查）' };
  }
}

/**
 * 决定要不要换，并（可选）换上。
 * @returns {{changed:boolean, variant?:string, file?:string, why?:string}}
 */
/**
 * 决定要不要换，并（可选）换上。
 * 图片来源：assets/avatar-src 图片池（别人发的 peer / 网上找的 web），不再用月亮脸。
 */
async function consider({ now = Date.now(), dry = false, force = false, cfg, source = null } = {}) {
  const c = cfg || loadCfg();
  const st = loadState();
  const day = 86400000;
  const src = require('./avatar-src.js');
  const prefer = source || c.source || 'any';

  if (!force) {
    if (!c.enabled) return { changed: false, why: 'disabled' };
    const gap = Number(c.minGapDays) || 0;
    if (gap > 0 && st.lastAt && now - st.lastAt < gap * day) {
      const left = Math.ceil((gap * day - (now - st.lastAt)) / day);
      return { changed: false, why: '距上次还差 ' + left + ' 天' };
    }
    const cap = Number(c.maxPerMonth) || 0;
    if (cap > 0) {
      const monthUsed = (st.used || []).filter(t => now - t < 30 * day).length;
      if (monthUsed >= cap) return { changed: false, why: '本月次数已用完' };
    }
  }

  if (c.riskGate !== false) {
    const r = riskOk();
    if (!r.ok) return { changed: false, why: 'risk: ' + r.why };
  }

  let cand = src.pickOne({ prefer });
  if (!cand) {
    const f = await src.search({ count: 2 });
    cand = src.pickOne({ prefer });
    if (!cand) return { changed: false, why: '没图可用（' + ((f && f.why) || '池子是空的') + '）' };
  }

  const prep = src.prepForAvatar(cand.file, c.size);
  if (!prep.ok) return { changed: false, why: prep.why, srcFile: cand.file };

  const label = cand.source === 'peer' ? '别人发我的那张' : '网上找的一张';
  if (dry) return { changed: false, dry: true, source: cand.source, label, file: prep.file, why: '演练' };

  const res = await require('./qq.js').call('set_qq_avatar', { file: prep.file });
  const ok = res && res.status === 'ok';
  if (!ok) return { changed: false, source: cand.source, file: prep.file, why: 'set_qq_avatar 失败: ' + JSON.stringify(res).slice(0, 160) };

  st.lastAt = now;
  st.used = [...(st.used || []), now].slice(-20);
  st.history = [...(st.history || []), { at: now, source: cand.source, srcId: cand.id, file: prep.file }].slice(-30);
  saveState(st);
  return { changed: true, source: cand.source, label, file: prep.file, why: '换好了' };
}
// ───────────────────────── CLI ─────────────────────────
async function applyOne(prefer, force) {
  return consider({ force: force !== false, source: prefer || null });
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const src = require('./avatar-src.js');
  if (cmd === 'variants' || cmd === 'legacy') {
    console.log('（月亮脸款式已停用；现在头像是真实图片，来源见下表）');
    for (const v of VARIANTS) console.log('  旧款 ' + v.id.padEnd(8) + v.label + '（不再使用）');
    return;
  }
  if (cmd === 'preview' || cmd === 'render') {
    console.log('月亮脸只保留在 assets/avatars/ 里当历史，不再参与换头像。');
    return;
  }
  if (cmd === 'plan') {
    const st = loadState(), c = loadCfg();
    const p = src.pickOne({ prefer: c.source || 'any' });
    console.log('池子：' + JSON.stringify(src.status()));
    console.log(p ? '会挑：' + p.id + '（' + (p.source === 'peer' ? '别人发的' : '网上找的') + '）' : '池子是空的，需要先 fetch');
    console.log('自动换：' + (c.enabled ? '已开' : '关着') + ' · 间隔 ' + (Number(c.minGapDays) || 0) + ' 天（0=不限）· 月度上限 ' + (Number(c.maxPerMonth) || 0));
    console.log('上次更换：' + (st.lastAt ? new Date(st.lastAt).toLocaleString('zh-CN') : '从未'));
    return;
  }
  if (cmd === 'apply') {
    const arg = process.argv.slice(3).find(a => !a.startsWith('--'));
    const prefer = arg ? (/'peer'|'web'|'any'/.test(arg) ? arg : sourceOfWord(arg)) : null;
    const r = await applyOne(prefer, true);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'status') {
    const c = loadCfg(), st = loadState(), day = 86400000;
    const s3 = src.status();
    console.log('图片来源：' + s3.total + ' 张池子（网上找的 ' + s3.web + ' · 别人发的 ' + s3.peer + '）');
    console.log('自动换头像：' + (c.enabled ? '已开' : '关着'));
    console.log('上次更换：' + (st.lastAt ? new Date(st.lastAt).toLocaleString('zh-CN') : '从未'));
    console.log('近 30 天次数：' + (st.used || []).filter(t => Date.now() - t < 30 * day).length + '（上限 ' + (Number(c.maxPerMonth) || 0) + '，0=不限）');
    console.log('间隔：' + (Number(c.minGapDays) || 0) + ' 天（0=不限）· 尺寸 ' + c.size + ' · 优先来源 ' + (c.source || 'any'));
    if (st.history && st.history.length) {
      console.log('历史：');
      for (const h of st.history.slice(-5)) console.log('  ', new Date(h.at).toLocaleString('zh-CN'), h.source || '', String(h.srcId || ''));
    }
    return;
  }
  console.error('用法: node scripts/avatar.js [plan|apply [peer|web|any]|status|variants]');
  process.exit(2);
}

module.exports = { DEFAULTS, VARIANTS, loadCfg, choose, render, renderTo, consider, applyOne, loadState, saveState, parseRequest, chatTrigger, replyText, chatCfg, sourceOfWord };

if (require.main === module) main().catch(e => { console.error((e && e.message) || e); process.exit(1); });
