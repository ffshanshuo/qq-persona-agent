'use strict';
/**
 * test-sticker-gif.js —— 动图表情包识别离线自检（2026-10-25 需求「观看分析动图表情包」）
 *   ① sticker_prep.py --anim / --meta 的帧差统计与拆帧
 *   ② stickers.animSheets 缓存
 *   ③ vision.describeAnimation 多图请求 + JSON 解析（桩掉出网）
 *   ④ auto-reply.analyzeIncoming 动图走 describeAnimation、静态图仍走 describeImage
 * 运行：node scripts/test-sticker-gif.js
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const L = (n) => path.join(ROOT, 'logs', n);
process.env.QQSTICKER_DIR = L('stickers-gif-test');
process.env.QQMIND_DIR = L('mind-gif-test');
process.env.QQCTX_DIR = L('context-gif-test');
process.env.QQQUOTE_DIR = L('quotes-gif-test');
process.env.QQTHEM_DIR = L('them-gif-test');
process.env.QQMODE_DIR = L('mode-gif-test');
process.env.QQRISK_DIR = L('risk-gif-test');
process.env.QQFOLLOW_DIR = L('follow-gif-test');
process.env.QQNICK_DIR = L('nick-gif-test');
process.env.QQTIES_DIR = L('ties-gif-test');
process.env.QQPRESENCE_DIR = L('presence-gif-test');
process.env.QQTRACE_DIR = L('trace-gif-test');
process.env.QQBOND_DIR = L('bonds-gif-test');
process.env.QQLONGING_DIR = L('longing-gif-test');
process.env.QQPROMISE_DIR = L('promises-gif-test');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_STATE = L('autoreply-state-gif-' + process.pid + '.json');

const TMP = L('gif-test-work');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const PY = process.env.STICKER_PYTHON || '$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';
const PREP = path.join(ROOT, 'scripts', 'sticker_prep.py');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

// 造一个 8 帧、每帧一个方块往右移的小动图
const GIF = path.join(TMP, 'move.gif');
execFileSync(PY, ['-c', [
  'import math',
  'from PIL import Image',
  'frames = []',
  'for i in range(8):',
  '    im = Image.new("RGB", (120, 120), (255, 255, 255))',
  '    px = im.load()',
  '    cx = int(40 + 40 * math.sin(i / 8.0 * 2 * math.pi))',
  '    for x in range(cx - 18, cx + 18):',
  '        for y in range(42, 78):',
  '            px[x, y] = (255, 120, 60)',
  '    frames.append(im)',
  'frames[0].save(r"' + GIF.replace(/\\/g, '/') + '", save_all=True, append_images=frames[1:], duration=90, loop=0)',
  'print("ok")',
].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
ok('① 造出 8 帧测试动图', fs.existsSync(GIF) && fs.statSync(GIF).size > 200);

// 静态图（用于对照：不该走动图分支）
const PNG = path.join(TMP, 'still.png');
execFileSync(PY, ['-c', [
  'from PIL import Image',
  'im = Image.new("RGB", (100, 100), (200, 220, 250))',
  'im.save(r"' + PNG.replace(/\\/g, '/') + '")',
  'print("ok")',
].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });

(async () => {
  // ── ① 帧差统计（--meta）────────────────────────────────────
  {
    const out = execFileSync(PY, [PREP, GIF, '--meta'], { encoding: 'utf8' }).trim();
    const j = JSON.parse(out.split('\n').pop());
    ok('① 统计出多帧', j.n_frames === 8, j.n_frames);
    ok('① 统计出帧间隔', j.interval_ms === 90, j.interval_ms);
    ok('① 变化占比 > 0', j.changed_ratio > 0.01, j.changed_ratio);
    ok('① 拆帧只取最多 6 帧', Array.isArray(j.picked) && j.picked.length <= 6 && j.picked.length >= 3, j.picked);
    const stillOut = JSON.parse(execFileSync(PY, [PREP, PNG, '--meta'], { encoding: 'utf8' }).trim().split('\n').pop());
    ok('① 静态图 n_frames=1', stillOut.n_frames === 1, stillOut);
  }

  // ── ② stickers.animSheets（拆帧 + 缓存）─────────────────────
  const stickers = require('./stickers.js');
  {
    const a = stickers.animSheets(GIF);
    ok('② 返回 1~2 张拼图', Array.isArray(a.sheets) && a.sheets.length >= 1 && a.sheets.length <= 2, a.sheets);
    ok('② 拼图文件真的存在', a.sheets.every(f => fs.existsSync(f) && fs.statSync(f).size > 500), a.sheets);
    ok('② 带帧差元信息', a.n_frames === 8 && a.interval_ms === 90, { n: a.n_frames, i: a.interval_ms });
    const again = stickers.animSheets(GIF);
    ok('② 第二次走缓存（cached=true）', again.cached === true, again.cached);
    ok('② 缓存也带着 sheets', again.sheets.length === a.sheets.length);
  }

  // ── ③ vision.describeAnimation（桩掉出网，验多图请求）───────
  const net = require('./net.js');
  const vision = require('./vision.js');
  {
    let captured = null;
    const orig = net.postJson;
    net.postJson = async (url, body) => {
      captured = body;
      return {
        ok: true, status: 200, json: {
          choices: [{ message: { content: '{"motion":"橙色方块从左往右移动","emotion":"开心","desc":"表示兴冲冲地跑过来","tags":["开心","跑过来"]}' } }],
        },
      };
    };
    let r = null;
    try { r = await vision.describeAnimation(GIF, { timeoutMs: 5000 }); } catch (e) { console.log('ERR', e.message); }
    net.postJson = orig;
    const parts = captured && captured.messages && captured.messages[0] && captured.messages[0].content;
    const imgs = Array.isArray(parts) ? parts.filter(p => p.type === 'image_url') : [];
    ok('③ 请求里带了多张帧拼图', imgs.length >= 1 && imgs.length <= 2, imgs.length);
    ok('③ 图片是 data:image/png;base64', imgs.every(p => String(p.image_url.url).startsWith('data:image/png;base64,')), imgs.map(p => String(p.image_url.url).slice(0, 30)));
    ok('③ 解析出动作描述', r && r.motion.includes('方块'), r && r.motion);
    ok('③ 解析出情绪', r && r.emotion === '开心', r && r.emotion);
    ok('③ 带回帧差元信息', r && r.meta && r.meta.n_frames === 8, r && r.meta);
    ok('③ 用多图接口（不是 askVision 单图）', r && typeof r.ms === 'number');
  }

  // ── ④ analyzeIncoming：动图走动图分支，静态图仍走原分支 ─────
  {
    const qq = require('./qq.js');
    const origCall = qq.call;
    // localImageOf 会先调 get_image 问 NapCat 要本地路径
    qq.call = async (action, params) => {
      if (action === 'get_image') return { status: 'ok', data: { file: params.file } };
      return { status: 'ok', data: {} };
    };
    const origAnim = vision.describeAnimation;
    const origDesc = vision.describeImage;
    let animCalled = 0, stillCalled = 0;
    vision.describeAnimation = async () => {
      animCalled++;
      return { motion: '一只猫疯狂点头', emotion: '赞同', desc: '疯狂赞同', meta: { n_frames: 12, interval_ms: 80, loops: true }, ms: 1, model: 'stub' };
    };
    vision.describeImage = async () => { stillCalled++; return { desc: '一张风景照', type: '照片', ms: 1, model: 'stub' }; };
    const ar = require('./auto-reply.js');
    const noteAnim = await ar.analyzeIncoming([{ type: 'image', file: GIF }]);
    const noteStill = await ar.analyzeIncoming([{ type: 'image', file: PNG }]);
    const noteMface = await ar.analyzeIncoming([{ type: 'mface', summary: '[开心]' }]);
    vision.describeAnimation = origAnim;
    vision.describeImage = origDesc;
    qq.call = origCall;
    ok('④ 动图走 describeAnimation', animCalled === 1 && stillCalled === 1, { animCalled, stillCalled });
    ok('④ 动图 note 说明帧数与动作', noteAnim.includes('动图') && noteAnim.includes('12 帧') && noteAnim.includes('疯狂点头'), noteAnim);
    ok('④ 动图 note 带情绪', noteAnim.includes('赞同'), noteAnim);
    ok('④ 静态图仍用原描述', noteStill.includes('一张图') && noteStill.includes('风景照'), noteStill);
    ok('④ 商城表情仍按 summary 处理', noteMface.includes('表情包') && noteMface.includes('开心'), noteMface);
  }

  // 清理
  for (const d of Object.keys(process.env)) {
    if (d.startsWith('QQ') && d.endsWith('_DIR')) { try { fs.rmSync(process.env[d], { recursive: true, force: true }); } catch (e) { } }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  try { fs.rmSync(process.env.AUTOREPLY_STATE, { force: true }); } catch (e) { }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
