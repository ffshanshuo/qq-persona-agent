'use strict';
/**
 * test-bond-e2e.js —— 关系事件层的端到端演练（dry，不真发、不调模型）。
 * 验证链路：对方说了一句带「关系事件」的话 → auto-reply 的 mindAfterTurn 里
 *           bonds.observe 认出来 → 落盘脉冲 → mind 的 bond 描述与 longing 的节奏跟着变。
 * 运行：node scripts/test-bond-e2e.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
process.env.AUTOREPLY_DRY = '1';
 process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-+extra+-test.log');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.bond-test.json');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-bond-e2e');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-bond-e2e');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-bond-e2e');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-bond-e2e-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-bond-e2e-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-bond-e2e-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }

process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-bond-e2e');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-bond-e2e');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-bond-e2e');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-bond-e2e');

const ar = require('./auto-reply.js');
const bonds = require('./bonds.js');
const mind = require('./mind.js');
const longing = require('./longing.js');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } };
const KEY = 'p:100000001';
const logFile = process.env.AUTOREPLY_LOG;
const logCount = () => { try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').length; } catch (e) { return 0; } };
const readLog = (from) => {
  try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(from).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
};

let seq = 1000;
function evtOf(text) {
  return {
    post_type: 'message', message_type: 'private', self_id: 123456789,
    user_id: 100000001, message_id: ++seq, time: Math.floor(Date.now() / 1000),
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: 100000001, nickname: '好友A' }
  };
}

(async () => {
  for (const d of [process.env.QQCTX_DIR, process.env.QQMIND_DIR, process.env.QQTRACE_DIR, process.env.QQPROMISE_DIR, process.env.QQBOND_DIR, process.env.QQLONGING_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { }
  }

  // ① 先聊一句普通的话，攒出基线
  let mark = logCount();
  await ar.handle(evtOf('今天上课上得有点累'));
  ok('① 普通一句话不产生关系事件', bonds.load(KEY).pulses.length === 0, bonds.load(KEY).pulses);

  // ② 一句「说好了要见面」→ plan_meet
  mark = logCount();
  await ar.handle(evtOf('说好了周末一起去爬山的，我带你去看日出'));
  const logs2 = readLog(mark);
  ok('② 记了关系事件', logs2.some(l => l.event === 'bond' && (l.applied || []).some(x => x === 'plan_meet')), logs2.filter(l => l.event === 'bond'));
  ok('② 落盘有 plan_meet 脉冲', bonds.load(KEY).pulses.some(p => p.type === 'plan_meet'), bonds.load(KEY).pulses);

  // ③ 闹别扭 → tension 上来
  mark = logCount();
  await ar.handle(evtOf('你昨天怎么不回我，我有点生气了'));
  const afterConflict = bonds.effectiveRel(KEY, mind.loadState(KEY).rel);
  ok('③ 吵架被认出来', bonds.load(KEY).pulses.some(p => p.type === 'conflict'), bonds.load(KEY).pulses);
  ok('③ 关系里出现紧张', afterConflict.tension > (mind.loadState(KEY).rel.tension || 0), afterConflict);

  // ④ mind 的关系描述跟着变（promptBits 读的是有效关系）
  const bits = mind.promptBits(KEY, '还生气吗');
  ok('④ bond 描述提到别扭', /别扭|摩擦/.test(bits.bond), bits.bond);

  // ⑤ 道歉 → tension 回落
  mark = logCount();
  await ar.handle(evtOf('对不起嘛，昨天是我不好，别生气'));
  const afterRepair = bonds.effectiveRel(KEY, mind.loadState(KEY).rel);
  ok('⑤ 道歉被认出来', bonds.load(KEY).pulses.some(p => p.type === 'repair'), bonds.load(KEY).pulses.map(p => p.type));
  ok('⑤ 道完歉没那么绷着了', afterRepair.tension < afterConflict.tension, { before: afterConflict.tension, after: afterRepair.tension });

  // ⑥ 想念节奏跟着关系走：现在的有效关系 vs 裸基线
  const base = mind.loadState(KEY).rel;
  const sal = Number(mind.loadState(KEY).lastAffect && mind.loadState(KEY).lastAffect.salience) || 0;
  const far = longing.expectedHours(base, sal);
  const near = longing.expectedHours(bonds.effectiveRel(KEY, base), sal);
  ok('⑥ 有好感事件后想念来得更早', near <= far, { base: Math.round(far * 10) / 10, eff: Math.round(near * 10) / 10 });

  // ⑦ 事件可读回、有给人看的说法
  const l = bonds.list(KEY);
  ok('⑦ 事件列表可读', l.count >= 3, l);
  ok('⑦ 有中文说法', typeof bonds.noteOf(KEY) === 'string', bonds.noteOf(KEY));

  // ⑧ 冷却：同一类事件连着说两遍只记一次
  const before = bonds.load(KEY).pulses.length;
  await ar.handle(evtOf('说好了下次我们去看海，我请你'));
  const after = bonds.load(KEY).pulses.length;
  ok('⑧ 同类事件冷却内不重复计', after === before, { before, after });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
