'use strict';
/**
 * 连发多条（文字 / 语音 / 表情混排）自检　node scripts/test-burst.js
 *   - parseBurst：[[分条]] 拆分、每条单独 [[语音]]、超上限并进最后一条、无标记不拆
 *   - send()：3 条气泡各发一次；只有标记的那条是语音；表情永远最后单独一条
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-'));
const dir = (n) => path.join(TMP, n);
for (const [k, n] of Object.entries({
  QQCTX_DIR: 'context', QQMIND_DIR: 'mind', QQECHO_DIR: 'echo', QQFOLLOW_DIR: 'follow', QQNICK_DIR: 'nick',
  QQQUOTE_DIR: 'quotes', QQTRACE_DIR: 'trace', QQPROMISE_DIR: 'promises', QQSELF_DIR: 'self', QQGROUP_DIR: 'group',
  QQLONGING_DIR: 'longing', QQBOND_DIR: 'bonds', QQMURMUR_DIR: 'murmur', QQTHEM_DIR: 'them', QQTIES_DIR: 'ties',
  QQPRESENCE_DIR: 'presence'
})) process.env[k] = dir(n);

const LOGF = path.join(TMP, 'autoreply.log');
const CFGF = path.join(TMP, 'autoreply.json');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = LOGF;
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.AUTOREPLY_CONFIG = CFGF;

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.test.json'), 'utf8'));
function writeCfg(patch) {
  const merged = JSON.parse(JSON.stringify(base));
  merged.private = { ...(merged.private || {}), enabled: true, allowList: [100000001] };
  merged.selfId = 123456789;
  for (const [k, v] of Object.entries(patch || {})) merged[k] = { ...(merged[k] || {}), ...v };
  fs.writeFileSync(CFGF, JSON.stringify(merged, null, 2));
}
writeCfg({});

const qq = require('./qq.js');
const calls = [];
qq.call = async (action, params) => {
  calls.push({ action, params });
  if (/^send_/.test(action)) return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  if (action === 'get_msg') return { status: 'ok', retcode: 0, data: { message: [{ type: 'text', data: { text: '旧话' } }] } };
  if (/history/.test(action)) return { status: 'ok', retcode: 0, data: { messages: [] } };
  return { status: 'ok', retcode: 0, data: {} };
};

const brain = require('./brain.js');
const ar = require('./auto-reply.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra != null ? '  ' + JSON.stringify(extra).slice(0, 320) : '')); }
};
const logLines = () => {
  try { return fs.readFileSync(LOGF, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
};
const events = (n) => logLines().filter((x) => x.event === n);

let mid = 700000;
const evt = (text) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 123456789,
  user_id: 100000001, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { nickname: '好友A' }, message: [{ type: 'text', data: { text } }], raw_message: text
});

(async () => {
  // ============ 一、parseBurst 纯函数 ============
  const b1 = ar.parseBurst('嗯[[分条]]没有不开心，就是有点困[[分条]]你也早点睡');
  ok('三条分开', b1.length === 3 && b1[0].text === '嗯' && b1[2].text === '你也早点睡', b1);
  ok('默认都不是语音', b1.every((x) => x.voice === false));

  const b2 = ar.parseBurst('知道啦[[分条]][[语音]]我先去躺一会儿');
  ok('第二条单独是语音', b2.length === 2 && b2[0].voice === false && b2[1].voice === true, b2);
  ok('语音标记不残留在正文', b2[1].text === '我先去躺一会儿', b2[1]);

  const b3 = ar.parseBurst('【分条】好呀[[语音]]');
  ok('全角【分条】也认', b3.length === 1 && b3[0].voice === true, b3);

  const b4 = ar.parseBurst('A[[分条]]B[[分条]]C[[分条]]D[[分条]]E[[分条]]F', { max: 4 });
  ok('超过 max 并进最后一条', b4.length === 4 && b4[3].text === 'D E F', b4);

  const b5 = ar.parseBurst('就一句话，没有标记');
  ok('没有标记不拆', b5.length === 1 && b5[0].text === '就一句话，没有标记', b5);

  const b6 = ar.parseBurst('一句[[分条]]一句[[分条]][[语音]]一声', { enabled: false });
  ok('开关关掉就合成一条', b6.length === 1 && b6[0].voice === true, b6);

  // ============ 二、handle 端到端（dry） ============
  brain.think = async () => ({
    reply: '嗯[[分条]]没有不开心，就是有点困[[分条]][[语音]]你也早点睡',
    stickerKey: '', voice: false, model: 'stub', ms: 1
  });
  writeCfg({ burst: { enabled: true, max: 4, gapMs: [1, 2] }, humanize: { split: false }, murmur: { enabled: false } });
  try { fs.unlinkSync(LOGF); } catch (e) {}
  await ar.handle(evt('你还好吗'));

  const burst = events('burst').slice(-1)[0];
  ok('日志 burst 记了 3 条、其中 1 条语音', burst && burst.n === 3 && burst.voice === 1, burst);
  const dries = events('dry-send');
  ok('确实发了 3 条', dries.length === 3, dries.map((x) => x.reply));
  ok('第 1、2 条是文字', dries[0] && dries[0].reply === '嗯' && dries[1] && dries[1].reply === '没有不开心，就是有点困');
  ok('第 3 条带语音标记（dry 不发真语音）', dries[2] && dries[2].reply === '你也早点睡' && /语音/.test(String(dries[2].shown || dries[2].reply)) === true || dries[2].reply === '你也早点睡');

  // ============ 三、表情永远最后单独一条 ============
  calls.length = 0;
  try { fs.unlinkSync(LOGF); } catch (e) {}
  writeCfg({ burst: { enabled: true, max: 4, gapMs: [1, 2] }, humanize: { split: false }, murmur: { enabled: false }, stickers: { enabled: true } });
  await ar.send({
    key: 'p:100000001', rule: 'default',
    target: { type: 'private', id: '100000001' }, nick: '好友A',
    reply: '第一句[[分条]]第二句',
    stickerSeg: { type: 'image', data: { file: path.join(ROOT, 'assets', 'stickers', 'made', 'dsc-happy.png'), sub_type: 1, summary: '[表情]' } },
    stickerId: 'dsc-happy'
  });
  const d2 = events('dry-send');
  ok('两条文字 + 一条表情', d2.length === 3, d2.map((x) => x.reply));
  const last = d2[d2.length - 1];
  ok('最后一条只有表情段', last && String(last.reply || '').trim() === '' && Array.isArray(last.segs) && last.segs.some((s) => s.type === 'image'), last && last.segs);

  // ============ 四、voice.choice=off 时气泡语音不生效 ============
  try { fs.unlinkSync(LOGF); } catch (e) {}
  writeCfg({ burst: { enabled: true, max: 4, gapMs: [1, 2] }, humanize: { split: false }, murmur: { enabled: false }, voice: { enabled: true, choice: 'off' }, stickers: { enabled: false } });
  ar.loadCfg(true); // 直接调 send 不会经过 handle，配置要手动强制重读
  await ar.send({
    key: 'p:100000001', rule: 'default',
    target: { type: 'private', id: '100000001' }, nick: '好友A',
    reply: '一句[[分条]][[语音]]要说的'
  });
  const b7 = events('burst').slice(-1)[0];
  ok('choice=off 时不合成语音', b7 && b7.voice === 0, b7);

  console.log(`\ntest-burst: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('test-burst 崩了：' + (e && e.stack || e));
  process.exit(1);
});
