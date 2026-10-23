'use strict';
/**
 * test-longing.js —— 想念调度（longing.js）离线自检。
 * 全部离线：自己造 mind 状态与 context，brain 用桩函数，send 也用桩。
 * 运行：node scripts/test-longing.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-longing-test');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-longing-test');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-longing-test');

const mind = require('./mind.js');
const context = require('./context.js');
const longing = require('./longing.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const H = 3600e3;
const DAY = new Date(2026, 9, 23, 11, 0, 0).getTime(); // 固定基准，测试不受真实时间漂移影响
for (const d of [process.env.QQMIND_DIR, process.env.QQCTX_DIR, process.env.QQLONGING_DIR, process.env.QQPROMISE_DIR]) {
  fs.rmSync(d, { recursive: true, force: true });
}

// ── 造数据工具 ─────────────────────────────────────────────
function seedState(key, { intimacy = 0.1, warmth = 0.2, trust = 0.2, tension = 0, msgs = 20, idleHours = 8, salience = 0.3, nick = '某人' } = {}) {
  const now = DAY;
  const kind = key.startsWith('g:') ? 'group' : 'private';
  const uin = key.startsWith('g:') ? 0 : Number(key.slice(2));
  const st = mind.blankState(key, kind, kind === 'group' ? { gid: Number(key.split(':')[1]) } : { uin });
  st.rel = { warmth, trust, intimacy, tension };
  st.msgCount = msgs;
  st.lastTurnAt = now - idleHours * H;
  st.lastAffect = { pad: { p: 0, a: 0, d: 0 }, salience, at: st.lastTurnAt };
  fs.mkdirSync(process.env.QQMIND_DIR, { recursive: true });
  fs.writeFileSync(mind.stateFile(key), JSON.stringify(st));
  // 上下文：最后一条就是「静静了 idleHours 小时」
  const turns = [];
  for (let i = 0; i < Math.min(msgs, 8); i++) {
    turns.push({ t: st.lastTurnAt - (8 - i) * 60e3, from: i % 2 ? 'me' : 'them', speaker: i % 2 ? '' : nick, text: i % 2 ? '嗯嗯' : '今天还行' });
  }
  fs.mkdirSync(process.env.QQCTX_DIR, { recursive: true });
  fs.writeFileSync(context.fileOf(key), JSON.stringify({
    key, kind, peer: {}, createdAt: now - 86400e3, updatedAt: now,
    sessionStartedAt: now - 86400e3, turns, summary: '', facts: [], dropped: 0
  }));
}

// ① 公式：亲密度越高，期望空窗越短；tension 拉长、warmth 缩短
const eLow = longing.expectedHours({ intimacy: 0.05, warmth: 0, tension: 0 });
const eHigh = longing.expectedHours({ intimacy: 0.9, warmth: 0, tension: 0 });
ok('① 亲密度高 → 更早想起', eHigh < eLow * 0.35, { eLow, eHigh });
ok('① 冷淡的人要等更久（>24h）', eLow > 24, eLow);
const eWarm = longing.expectedHours({ intimacy: 0.5, warmth: 1, tension: 0 });
const eCold = longing.expectedHours({ intimacy: 0.5, warmth: 0, tension: 0 });
ok('① warmth 高 → 略早', eWarm < eCold, { eWarm, eCold });
const eTense = longing.expectedHours({ intimacy: 0.5, warmth: 0, tension: 0.8 });
ok('① tension 高 → 明显往后拖', eTense > eCold * 1.5, { eCold, eTense });
ok('① 强度与空窗成正比', longing.intensityOf({ hours: 10, expected: 10 }) === 1);

// ② 挑人：亲密的到点了、陌生的没到、聊太少的排除
seedState('p:1001', { intimacy: 0.9, warmth: 0.8, msgs: 20, idleHours: 9, nick: '很熟的' });
seedState('p:1002', { intimacy: 0.05, warmth: 0.1, msgs: 20, idleHours: 9, nick: '不熟的' });
seedState('p:1003', { intimacy: 0.9, warmth: 0.8, msgs: 3, idleHours: 9, nick: '刚加的' });
seedState('g:2001', { intimacy: 0.9, warmth: 0.8, msgs: 20, idleHours: 9, nick: '群里的人' });
const p1 = longing.plan({ now: DAY });
const keys1 = p1.map(x => x.key);
ok('② 亲密的会被想起', keys1.includes('p:1001'), keys1);
ok('② 不熟的不会', !keys1.includes('p:1002'), keys1);
ok('② 聊太少的不会', !keys1.includes('p:1003'), keys1);
ok('② 群聊默认不主动', !keys1.includes('g:2001'), keys1);
ok('② 候选带昵称与关系', p1[0] && p1[0].nick === '很熟的', p1[0]);

// ③ 还在聊（刚静 30 分钟）不该插话
seedState('p:1004', { intimacy: 0.95, warmth: 0.9, msgs: 30, idleHours: 0.5, nick: '刚聊完' });
ok('③ 刚聊完不主动', !longing.plan({ now: DAY }).some(x => x.key === 'p:1004'));

// ④ 免打扰
const night = new Date(2026, 9, 23, 23, 30, 0).getTime();
ok('④ 默认不看钟点：23:30 也能主动', longing.canOutNow({ now: night }).ok === true, longing.canOutNow({ now: night }));
longing.configure({ quietHours: [23, 8] }); // 能力仍在：显式配了才闭嘴
ok('④ 显式配了免打扰才压住夜里', longing.canOutNow({ now: night }).why === 'quiet', longing.canOutNow({ now: night }));
longing.configure({ quietHours: [] });
const day = new Date(2026, 9, 23, 11, 0, 0).getTime();
ok('④ 11:00 可以', longing.canOutNow({ now: day }).ok === true);

// ⑤ 参谋：走一轮（brain 用桩），dry 不记账
let sentList = [];
const fakeSend = async (d) => { sentList.push(d); return { status: 'ok', retcode: 0 }; };
const think = async (ctx) => ({ reply: ctx.proactive ? '忽然想起你，最近怎么样？' : '嗯', model: 'stub', ms: 1 });
longing.configure({ intensityThreshold: 1, minIdleHours: 2, dailyMax: 5, globalGapHours: 0, perContactHours: 0 });
(async () => {
  const r = await longing.runOnce({ think, send: fakeSend, dry: true, now: day });
  ok('⑤ 挑中亲密的人', r.sent.length === 1 && r.sent[0].key === 'p:1001', r.sent);
  ok('⑤ 发出去的是主动开场', sentList.length === 1 && /想起你/.test(sentList[0].reply), sentList[0] && sentList[0].reply);
  ok('⑤ 规则标记为 longing', sentList[0] && sentList[0].rule === 'longing');
  ok('⑤ dry 不记账', !longing.load('p:1001').lastOutAt);

  // ⑥ 真发一次 → 记账 → 冷却生效
  await longing.runOnce({ think, send: fakeSend, dry: false, now: day });
  ok('⑥ 记账了', longing.load('p:1001').lastOutAt > 0);
  ok('⑥ 冷却期内不再找他', !longing.plan({ now: day }).some(x => x.key === 'p:1001'));

  // ⑦ 全局节流：刚发过 → global-gap
  longing.configure({ globalGapHours: 2 });
  ok('⑦ 刚主动过就歇一会', longing.canOutNow({ now: day + 60e3 }).ok === false && longing.canOutNow({ now: day + 60e3 }).why === 'global-gap');

  // ⑧ 每天上限
  longing.configure({ globalGapHours: 0, dailyMax: 1 });
  ok('⑧ 今天已经主动过了就停', longing.canOutNow({ now: day + 3600e3 }).why === 'daily-cap', longing.canOutNow({ now: day + 3600e3 }));

  // ⑨ brain 说 [SKIP] → 不发、不记账
  longing.configure({ dailyMax: 9, globalGapHours: 0, perContactHours: 0 });
  fs.rmSync(process.env.QQLONGING_DIR, { recursive: true, force: true });
  const before = sentList.length;
  const r2 = await longing.runOnce({ think: async () => ({ reply: '' }), send: fakeSend, dry: false, now: day });
  ok('⑨ brain 不想说话就不发', sentList.length === before && r2.sent.length === 0, r2);
  ok('⑨ 也没记账', !longing.load('p:1001').lastOutAt);

  // ⑩ 开关关掉就完全不挑人
  longing.configure({ enabled: false });
  ok('⑩ 关掉后 canOutNow 拒绝', longing.canOutNow({ now: day }).why === 'disabled');
  longing.configure({ enabled: true });

  // ⑪ 名单与状态文件
  const rows = longing.list({ now: day });
  ok('⑪ list 有进度', rows.length >= 1 && rows.every(x => typeof x.intensity === 'number'), rows.slice(0, 2));
  ok('⑪ 账本可读', Array.isArray(longing.load('p:1001').items));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
