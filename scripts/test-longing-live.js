'use strict';
/**
 * test-longing-live.js —— 想念调度的真模型演练（dry，不真发）。
 * 用生产的 mind/context 只读数据，让 brain 真的写一句「忽然想起你」的开场，
 * 检查口吻像不像人、有没有犯忌（问"在吗"、说"好久没联系"、提自动/想念值）。
 * 运行：QQLONGING_DIR=logs/longing-live node scripts/test-longing-live.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
process.env.QQLONGING_DIR = process.env.QQLONGING_DIR || path.join(ROOT, 'logs', 'longing-live');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-longing-live-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-longing-live-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-longing-live-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

const longing = require('./longing.js');
const mind = require('./mind.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

(async () => {
  fs.rmSync(process.env.QQLONGING_DIR, { recursive: true, force: true });
  // 放松节流，只看「写得好不好」
  longing.configure({ dailyMax: 9, globalGapHours: 0, perContactHours: 0, minIdleHours: 0, intensityThreshold: 0.2 });

  const rows = longing.list();
  ok('① 有可推算的会话', rows.length > 0, rows.length);
  const top = rows[0];
  console.log('    候补：', top.nick, '静了', top.idleHours, 'h / 期望', top.expectedHours, 'h / 强度', top.intensity, '关系', JSON.stringify(top.rel));

  const sent = [];
  // 用「48 小时后的时间点」制造想念，send 为桩（dry，不真发）
  const later = Date.now() + 48 * 3600e3;
  const r = await longing.runOnce({
    now: later,
    dry: true,
    send: async (d) => { sent.push(d); return { status: 'ok', dry: true }; }
  });
  ok('② 挑中了一个人', r.sent.length === 1, r);
  const reply = (sent[0] && sent[0].reply) || '';
  console.log('    开场白：', reply);
  ok('③ 有话可说（≥4 字）', reply.length >= 4, reply);
  ok('④ 没问「在吗」', !/在吗|在不在|在么/.test(reply), reply);
  ok('⑤ 没客套「好久没联系」', !/好久没联系|好久不见|许久未见/.test(reply), reply);
  ok('⑥ 没暴露机制（自动/定时/想念值/系统）', !/自动|定时|想念值|系统|AI提示|程序/.test(reply), reply);
  ok('⑦ 没自称助手', !/助手|替她|替繁星/.test(reply), reply);
  ok('⑧ 长度像人（≤60 字）', reply.length <= 60, reply.length);
  ok('⑨ dry 没记账', !longing.load(top.key).lastOutAt, longing.load(top.key).lastOutAt);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
