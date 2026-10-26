'use strict';
/**
 * test-avatar.js —— 头像（真实图片池版）
 *
 * 语义（2026-10-24 用户改口径后）：
 *   - 头像来源＝assets/avatar-src 图片池（web 网上找 / peer 别人发），不再用月亮脸
 *   - 次数限制解除：minGapDays=0 / maxPerMonth=0 表示不限
 *   - 风控闸门 risk.gate('profile') 照旧；dry 与失败都不记账
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-avatar-'));

process.env.QQAVATAR_DIR = path.join(TMP, 'logs-avatar');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-avatar-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-avatar-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-avatar-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-avatar-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQAVATAR_OUT = path.join(TMP, 'out');
process.env.QQAVATAR_SRC_DIR = path.join(TMP, 'src');
process.env.QQAVATAR_CONFIG = path.join(TMP, 'avatar.json');
process.env.QQAVATARSRC_STATE_DIR = path.join(TMP, 'src-state');
process.env.QQRISK_DIR = path.join(TMP, 'risk');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-avatar-' + process.pid + '.json';

fs.mkdirSync(process.env.QQAVATAR_SRC_DIR, { recursive: true });
fs.writeFileSync(path.join(TMP, 'avatar.json'), JSON.stringify({
  enabled: false, checkEveryHours: 12, minGapDays: 0, maxPerMonth: 0, size: 512, riskGate: true, source: 'any',
}));

const avatar = require('./avatar.js');
const src = require('./avatar-src.js');
const risk = require('./risk.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const b of td) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, c]);
}
function makePng(file, tint) {
  tint = tint || 0;
  const W = 128, H = 128;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    const off = y * (W * 4 + 1);
    for (let x = 0; x < W; x++) {
      const p = off + 1 + x * 4;
      raw[p] = (x * 2 + tint) % 256; raw[p + 1] = (y * 2 + tint * 3) % 256; raw[p + 2] = (200 - ((x + y) % 90) + tint * 7) % 256; raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return file;
}

function resetAll() {
  fs.rmSync(process.env.QQAVATAR_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(process.env.QQAVATAR_SRC_DIR, 'index.json'), { force: true });
  fs.rmSync(process.env.QQAVATARSRC_STATE_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.QQRISK_DIR, { recursive: true, force: true });
  fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify({ enabled: false, minGapDays: 0, maxPerMonth: 0, size: 512, riskGate: true, source: 'any' }));
  try { risk.clear(); } catch (e) { /* ignore */ }
}

(async () => {
  const calls = [];
  const qq = require('./qq.js');
  qq.call = async (action, params) => { calls.push({ action, params }); return { status: 'ok', retcode: 0 }; };

  // 图像处理打桩（真跑 Pillow 太慢，与逻辑无关）
  src.prepForAvatar = () => ({ ok: true, file: path.join(TMP, 'out', 'prepped.png') });
  // 上网找图打桩（不联网）
  src.search = async () => {
    const f = makePng(path.join(process.env.QQAVATAR_SRC_DIR, 'stub-web-' + Date.now() + '.png'));
    const it = src.register(f, { source: 'web', url: 'stub://web' });
    return { ok: true, added: it ? [it] : [] };
  };

  console.log('§1 图片池与来源');
  resetAll();
  ok('池子初始为空', src.list().length === 0);
  const peerIt = src.addPeer(makePng(path.join(TMP, 'peer.png')), { from: 'p:100000001' });
  ok('别人发的一张能进池', !!peerIt && fs.existsSync(peerIt.file));
  ok('进池后 source=peer', peerIt && peerIt.source === 'peer');
  ok('同一张不重复入池', (src.addPeer(peerIt.file), src.list().length === 1));
  const webIt = src.register(makePng(path.join(TMP, 'web.png'), 40), { source: 'web', url: 'u' });
  ok('网上找的也能进池', !!webIt && webIt.source === 'web');
  ok('prefer=peer 只挑 peer', (src.pickOne({ prefer: 'peer' }) || {}).source === 'peer');
  ok('prefer=web 只挑 web', (src.pickOne({ prefer: 'web' }) || {}).source === 'web');
  ok('status 统计正确', src.status().total === 2 && src.status().peer === 1 && src.status().web === 1, src.status());

  console.log('§2 真的换（真实图片，不是月亮脸）');
  resetAll();
  calls.length = 0;
  let r = await avatar.consider({ force: true });
  ok('池空时会去上网找 → 然后真换', r.changed === true, r);
  ok('真换调了 set_qq_avatar', calls.some(c => c.action === 'set_qq_avatar'));
  ok('返回带来源标签（人话）', typeof r.label === 'string' && r.label.length > 0, r.label);
  ok('记账写了 lastAt', (avatar.loadState().lastAt || 0) > 0);
  ok('没有回落到月亮脸（无 variant 字段）', r.variant === undefined, r.variant);

  console.log('§3 次数限制已解除');
  resetAll();
  fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify({ enabled: true, minGapDays: 0, maxPerMonth: 0, size: 512, riskGate: true }));
  await avatar.consider({ force: true });
  const imm = await avatar.consider({ force: false });
  ok('不限间隔：上一秒换过现在还能换', imm.changed === true, imm);
  fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify({ enabled: true, minGapDays: 10, maxPerMonth: 3, size: 512, riskGate: true }));
  const gap = await avatar.consider({ force: false });
  ok('把间隔调回 10 天就拦住', gap.changed === false && /还差/.test(gap.why || ''), gap);
  fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify({ enabled: true, minGapDays: 0, maxPerMonth: 1, size: 512, riskGate: true }));
  const cap1 = await avatar.consider({ force: false });   // 本月第 1 次（reset 后 used 里已有 1 次）
  const cap2 = await avatar.consider({ force: false });
  ok('把月度上限调回 1 就拦住', cap1.changed === false || cap2.changed === false, [cap1.why, cap2.why]);
  fs.writeFileSync(process.env.QQAVATAR_CONFIG, JSON.stringify({ enabled: false, minGapDays: 0, maxPerMonth: 0, size: 512, riskGate: true }));
  const off = await avatar.consider({ force: false });
  ok('自动换关着时 non-force 不动', off.changed === false && off.why === 'disabled', off);

  console.log('§4 风控闸门');
  resetAll();
  const T0 = Date.now();
  risk.noteDrop('t1', T0); risk.noteDrop('t2', T0 + 60000);
  const cool = await avatar.consider({ force: true });
  ok('冷却期拒绝换头像', cool.changed === false && /risk:/.test(cool.why || ''), cool);
  risk.clear();
  const afterClear = await avatar.consider({ force: true });
  ok('解除冷却后可以换', afterClear.changed === true, afterClear);

  console.log('§5 演练与失败不记账');
  resetAll();
  const dry = await avatar.consider({ force: true, dry: true });
  ok('dry 返回 dry:true 且 changed=false', dry.dry === true && dry.changed === false, dry);
  ok('dry 之后 lastAt 仍是 0', (avatar.loadState().lastAt || 0) === 0);
  qq.call = async () => ({ status: 'failed', retcode: 200, message: 'boom' });
  const bad = await avatar.consider({ force: true });
  ok('发送失败 changed=false', bad.changed === false, bad);
  ok('发送失败不记账', (avatar.loadState().lastAt || 0) === 0);

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) { /* ignore */ } process.exit(1); });
