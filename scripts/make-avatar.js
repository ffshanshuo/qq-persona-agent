#!/usr/bin/env node
// 生成头像/配图：纯 Node 手写 PNG（无第三方依赖）
// 用法: node scripts/make-avatar.js [输出路径] [尺寸]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = writePng._tbl || (writePng._tbl = (() => {
      const t = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })());
    let crc = 0xffffffff;
    for (const b of td) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const c = Buffer.alloc(4);
    c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]));
}

// 确定性伪随机，保证多次生成一致
let seed = 20261023;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function make(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  // 月亮
  const moonX = size * 0.63, moonY = size * 0.33, moonR = size * 0.155;
  // 星点
  const stars = [];
  for (let i = 0; i < 220; i++) {
    stars.push({ x: rnd() * size, y: rnd() * size, r: 0.4 + rnd() * 1.6, a: 0.35 + rnd() * 0.65, tw: rnd() * 6.3 });
  }
  // 远山剪影（两层）
  const hills = [];
  for (let l = 0; l < 2; l++) {
    const base = size * (0.78 + l * 0.09);
    const amp = size * (0.055 - l * 0.02);
    const pts = [];
    for (let x = 0; x <= size; x += 4) {
      const y = base - Math.sin((x / size) * Math.PI * (1.6 + l * 0.8) + l * 1.7) * amp * (0.7 + 0.3 * Math.sin(x / 37));
      pts.push([x, y]);
    }
    hills.push(pts);
  }
  const hillColor = [[38, 34, 74], [26, 23, 55]];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 背景：深夜蓝 → 紫罗兰渐变
      const t = y / size;
      let r = 12 + 44 * t + 10 * Math.sin((x / size) * Math.PI);
      let g = 14 + 20 * t;
      let b = 46 + 62 * t;
      // 月亮光晕
      const dm = Math.hypot(x - moonX, y - moonY);
      const glow = Math.max(0, 1 - dm / (size * 0.5));
      r += 120 * glow * glow * 0.85;
      g += 112 * glow * glow * 0.85;
      b += 130 * glow * glow * 0.9;
      // 月盘
      if (dm < moonR) {
        const edge = Math.min(1, (moonR - dm) / 2.5);
        const moonShade = 1 - 0.12 * Math.max(0, Math.sin(Math.atan2(y - moonY, x - moonX) * 2 + 1));
        const mr = 255 * moonShade, mg = 249 * moonShade, mb = 224 * moonShade;
        r = r + (mr - r) * edge; g = g + (mg - g) * edge; b = b + (mb - b) * edge;
      }
      // 星点
      for (const s of stars) {
        const d = Math.hypot(x - s.x, y - s.y);
        if (d < s.r * 2.6) {
          const k = Math.max(0, 1 - d / (s.r * 2.6)) * s.a;
          r += 235 * k; g += 232 * k; b += 250 * k;
        }
      }
      // 山
      for (let l = 0; l < hills.length; l++) {
        const pts = hills[l];
        const idx = Math.min(pts.length - 1, Math.floor(x / 4));
        const hy = pts[idx][1];
        if (y > hy) {
          const c = hillColor[l];
          const fade = Math.min(1, (y - hy) / (size * 0.04) + 0.35);
          r = r * (1 - fade) + c[0] * fade;
          g = g * (1 - fade) + c[1] * fade;
          b = b * (1 - fade) + c[2] * fade;
        }
      }
      // 暗角
      const vig = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / (size * 0.72));
      const vk = 0.55 + 0.45 * vig;
      r *= vk; g *= vk; b *= vk;
      buf[i] = Math.max(0, Math.min(255, Math.round(r)));
      buf[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      buf[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      buf[i + 3] = 255;
    }
  }
  return buf;
}

const out = process.argv[2] || path.join(__dirname, '..', 'assets', 'avatar.png');
const size = Number(process.argv[3] || 512);
fs.mkdirSync(path.dirname(out), { recursive: true });
writePng(out, size, size, make(size));
console.log('[make-avatar] wrote', out, size + 'x' + size, fs.statSync(out).size + ' bytes');
