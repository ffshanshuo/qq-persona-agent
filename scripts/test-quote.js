'use strict';
/**
 * test-quote.js —— 引用消息的上下文感知（全离线）
 *
 * 覆盖：
 *   ① quote.parse：文本/自己说的/群里另一个人/含图片表情/时间距离
 *   ② quote.describe：谁说的 + 多久前 + 只有图时的说法 + 很久以前 + 引用链
 *   ③ quote.collect：去重、上限、顺序
 *   ④ 磁盘缓存：第二次不再问 NapCat；取不到的结果短期缓存
 *   ⑤ noteFor：单条 / 多条
 *   ⑥ 接线：连发合并时引用不丢（compose.quoted 带 _merge.quotes）、handle 把引用写进 note
 * 运行：node scripts/test-quote.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'autoreply-quote-test.log');
process.env.AUTOREPLY_DRY = '1';
process.env.QQMODE_DIR = __dirname + '/../logs/mode-quote-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-quote-test';
process.env.AUTOREPLY_LOG = LOG;
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.merge-test.json');
process.env.AUTOREPLY_STATE = path.join(ROOT, 'logs', 'state-quote-test.json');
process.env.QQQUOTE_DIR = path.join(ROOT, 'logs', 'quotes-test');
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-quote-test');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-quote-test');
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-quote-test');
process.env.QQTHEM_DIR = path.join(ROOT, 'logs', 'them-quote-test');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-quote-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-quote-test');
process.env.QQSELF_DIR = path.join(ROOT, 'logs', 'self-quote-test');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-quote-test');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-quote-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-quote-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-quote-test';
process.env.QQNICK_DIR = __dirname + '/../logs/nick-quote-test';

const quote = require('./quote.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  <= ' + JSON.stringify(extra) : '')); }
}
function cleanup() {
  for (const k of Object.keys(process.env)) {
    if (!/^QQ[A-Z]+_DIR$/.test(k)) continue;
    try { fs.rmSync(process.env[k], { recursive: true, force: true }); } catch (e) { }
  }
  try { fs.rmSync(LOG, { force: true }); } catch (e) { }
  try { fs.rmSync(process.env.AUTOREPLY_STATE, { force: true }); } catch (e) { }
}
cleanup();

const SELF = '123456789';
const FRIEND = '100000001';
const NOW = Date.UTC(2026, 9, 24, 4, 0, 0); // 固定基准，别用 Date.now()

function dataOf(over) {
  return {
    message_id: 900001,
    self_id: Number(SELF),
    user_id: Number(FRIEND),
    time: Math.floor(NOW / 1000) - 60,
    sender: { user_id: Number(FRIEND), nickname: '好友A' },
    message: [{ type: 'text', data: { text: '我明天要去医院复查' } }],
    ...over
  };
}

(async function main() {
  // ---------- ① parse ----------
  {
    const p = quote.parse(dataOf(), { selfId: SELF, now: NOW });
    ok('parse 取到文字', p.text === '我明天要去医院复查', p.text);
    ok('parse 不是我自己说的', p.isSelf === false);
    ok('parse 时间距离 1 分钟', p.agoMin === 1, p.agoMin);
    ok('parse kinds 有 text', p.kinds.includes('text'), p.kinds);

    const mine = quote.parse(dataOf({ user_id: Number(SELF), sender: { user_id: Number(SELF), nickname: '我' }, time: Math.floor(NOW / 1000) - 3600 }), { selfId: SELF, now: NOW });
    ok('parse 认出是我自己说的', mine.isSelf === true);
    ok('parse 1 小时前', mine.agoMin === 60, mine.agoMin);

    const img = quote.parse(dataOf({ message: [{ type: 'image', data: { file: 'abc.jpg', url: 'http://x/abc.jpg' } }] }), { selfId: SELF, now: NOW });
    ok('parse 图片 kinds', img.kinds.includes('image'), img.kinds);
    ok('parse 图片文字是占位符', img.text === '[图片]', img.text);
    ok('parse 收下图片文件', img.images.length === 1 && img.images[0].file === 'abc.jpg', img.images);

    const face = quote.parse(dataOf({ message: [{ type: 'mface', data: { summary: '[表情]' } }, { type: 'text', data: { text: '笑死' } }] }), { selfId: SELF, now: NOW });
    ok('parse 表情包 + 文字', face.kinds.includes('mface') && face.text === '[表情]笑死', { kinds: face.kinds, text: face.text });

    const chain = quote.parse(dataOf({ message: [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '对对' } }] }), { selfId: SELF, now: NOW });
    ok('parse 认出引用链', chain.isReplyTo === true);

    const grp = quote.parse(dataOf({ user_id: 100000004, sender: { user_id: 100000004, nickname: '好友C' } }), { selfId: SELF, senderUin: FRIEND, now: NOW });
    ok('parse 群里另一个人', grp.isSelf === false && grp.name === '好友C', grp.name);
  }

  // ---------- ② describe ----------
  {
    const p = quote.parse(dataOf({ time: Math.floor(NOW / 1000) - 180 }), { selfId: SELF, now: NOW });
    const s = quote.describe(p, { senderUin: FRIEND, cfg: { longAgoHours: 6 } });
    ok('describe 提到 TA 自己 3 分钟前', s.includes('TA 自己 3 分钟前') && s.includes('我明天要去医院复查'), s);

    const mine = quote.parse(dataOf({ user_id: Number(SELF), sender: { user_id: Number(SELF) }, time: Math.floor(NOW / 1000) - 7200 }), { selfId: SELF, now: NOW });
    const sm = quote.describe(mine, { senderUin: FRIEND, cfg: { longAgoHours: 6 } });
    ok('describe 引用我的话会说「你自己 2 小时前」', sm.includes('你自己 2 小时前'), sm);
    ok('describe 引用我的话带一句「在接你之前说的那句」', sm.includes('接你之前说的那句'), sm);

    const old = quote.parse(dataOf({ time: Math.floor(NOW / 1000) - 86400 * 2 }), { selfId: SELF, now: NOW });
    const so = quote.describe(old, { senderUin: FRIEND, cfg: { longAgoHours: 6 } });
    ok('describe 很久以前会提醒别当刚说的', so.includes('挺久以前') || so.includes('别当成刚说的话'), so);

    const img = quote.parse(dataOf({ message: [{ type: 'image', data: { file: 'a.jpg' } }] }), { selfId: SELF, now: NOW });
    const si = quote.describe(img, { senderUin: FRIEND, imageDesc: '一只橘猫在打哈欠', cfg: {} });
    ok('describe 只有图时说「一条图片」并带画面', si.includes('一条图片') && si.includes('橘猫'), si);

    const miss = { id: '5', empty: true, text: '', kinds: [] };
    ok('describe 取不到时别猜', quote.describe(miss, {}).includes('没取到'));

    const grp = quote.parse(dataOf({ user_id: 100000004, sender: { user_id: 100000004, nickname: '好友C' } }), { selfId: SELF, now: NOW });
    ok('describe 群里另一人带名字', quote.describe(grp, { senderUin: FRIEND }).includes('群里另一个人（好友C）'), quote.describe(grp, { senderUin: FRIEND }));
  }

  // ---------- ③ collect + ④ 缓存 ----------
  {
    let calls = 0;
    const call = async (action, params) => {
      calls++;
      if (action !== 'get_msg') return { status: 'ok', data: {} };
      return { status: 'ok', data: dataOf({ message_id: Number(params.message_id) }) };
    };
    const infos = await quote.collect(['11', '11', '12'], { call, selfId: SELF, now: NOW, cfg: { maxQuotes: 2 } });
    ok('collect 去重且受 maxQuotes 限制', infos.length === 2, infos.length);

    const n1 = calls;
    await quote.collect(['11'], { call, selfId: SELF, now: NOW + 1000, cfg: {} });
    ok('collect 第二次走磁盘缓存不再问 NapCat', calls === n1, { calls, n1 });

    await quote.collect(['11'], { call, selfId: SELF, now: NOW + 49 * 3600e3, cfg: { ttlHours: 48 } });
    ok('collect 缓存过期后会重新取', calls === n1 + 1, { calls, n1 });

    let missCalls = 0;
    const callMiss = async () => { missCalls++; return { status: 'failed', data: null }; };
    const m1 = await quote.fetchOne('77', { call: callMiss, selfId: SELF, now: NOW, cfg: {} });
    const m2 = await quote.fetchOne('77', { call: callMiss, selfId: SELF, now: NOW + 60e3, cfg: {} });
    ok('取不到时返回 empty 结构', m1.empty === true && m2.empty === true);
    ok('取不到的负面结果短期缓存（不再重复问）', missCalls === 1, missCalls);
    await quote.fetchOne('77', { call: callMiss, selfId: SELF, now: NOW + 30 * 60e3, cfg: { negTtlMin: 10 } });
    ok('负面缓存过期后会再试一次', missCalls === 2, missCalls);

    let thrown = 0;
    const callThrow = async () => { thrown++; throw new Error('boom'); };
    const e1 = await quote.fetchOne('88', { call: callThrow, selfId: SELF, now: NOW, cfg: {} });
    ok('取回抛错时不崩、返回 empty', e1.empty === true && thrown === 1);
  }

  // ---------- ⑤ noteFor ----------
  {
    const a = quote.parse(dataOf({ message_id: 21, time: Math.floor(NOW / 1000) - 120 }), { selfId: SELF, now: NOW });
    const b = quote.parse(dataOf({ message_id: 22, message: [{ type: 'text', data: { text: '你记得带伞' } }] }), { selfId: SELF, now: NOW });
    const one = quote.noteFor([a], { senderUin: FRIEND, cfg: {} });
    ok('noteFor 单条就是那句话', one.includes('引用') && one.includes('医院'), one);
    const two = quote.noteFor([a, b], { senderUin: FRIEND, cfg: {} });
    ok('noteFor 多条会说要引用两条', two.includes('引用了 2 条'), two);
    ok('noteFor 空数组返回空串', quote.noteFor([], {}) === '');
  }

  // ---------- ⑥ 接线（连发合并 + handle） ----------
  {
    const qq = require('./qq.js');
    const qcalls = [];
    qq.call = async (action, params) => {
      qcalls.push({ action, params });
      if (action === 'get_msg') {
        const id = String(params.message_id);
        if (id === '5555') return { status: 'ok', data: dataOf({ message_id: 5555, time: Math.floor(NOW / 1000) - 600, message: [{ type: 'text', data: { text: '周末那家店订了吗' } }] }) };
        return { status: 'ok', data: dataOf({ message_id: Number(id) }) };
      }
      if (action === 'set_input_status') return { status: 'ok' };
      return { status: 'ok', data: {} };
    };
    const brain = require('./brain.js');
    const captured = [];
    brain.think = async (ctx) => { captured.push(ctx); return { reply: '订了，周六下午两点', stickerKey: '', raw: '订了，周六下午两点', model: 'stub', ms: 1, finish: 'stop' }; };

    const ar = require('./auto-reply.js');
    const evt = (mid, text, extra) => ({
      post_type: 'message', message_type: 'private', user_id: Number(FRIEND), self_id: Number(SELF),
      time: Math.floor(NOW / 1000), message_id: mid,
      sender: { user_id: Number(FRIEND), nickname: '好友A' },
      message: [...(extra || []), { type: 'text', data: { text } }]
    });

    // 连发两条，第一条带引用：合并后引用不能丢
    const merged = ar.mergeEvents([
      evt(1001, '对了', [{ type: 'reply', data: { id: '5555' } }]),
      evt(1002, '就是你说的那家')
    ]);
    const dd = ar.decide(merged);
    ok('合并后引用 id 不丢', Array.isArray(dd.quoted) && dd.quoted.includes('5555'), dd.quoted);

    await ar.handle(evt(2001, '你还记得吗', [{ type: 'reply', data: { id: '5555' } }]));
    const note = (captured[captured.length - 1] || {}).note || '';
    ok('handle 把引用内容写进 note', note.includes('周末那家店订了吗'), note);
    ok('handle 的 note 说明了是谁说的', note.includes('TA 自己'), note);
    const quoteLog = fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').includes('"event":"quote"');
    ok('handle 打了 quote 日志', !!quoteLog);
  }

  const allOk = fail === 0;
  cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (!allOk) process.exitCode = 1;
})().catch((e) => {
  console.error('测试自身出错：', e && e.stack || e);
  process.exitCode = 1;
});
