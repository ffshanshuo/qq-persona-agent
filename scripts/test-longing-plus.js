'use strict';
/**
 * test-longing-plus.js —— 主动发消息的「完善」部分离线自检：
 *   ① 话题由头（topicOf）   ② 关系僵时不寒暄   ③ 想起时机带抖动
 *   ④ 主动了没回音 → 追一句  ⑤ 追一句不吃每日主动配额   ⑥ runOnce 接线   ⑦ brain 提示词
 * 运行：node scripts/test-longing-plus.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const L = (n) => path.join(ROOT, 'logs', n);
process.env.QQMIND_DIR = L('mind-longingplus-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-longing-plus-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-longing-plus-test';
process.env.QQCTX_DIR = L('context-longingplus-test');
process.env.QQLONGING_DIR = L('longing-longingplus-test');
process.env.QQPROMISE_DIR = L('promises-longingplus-test');
process.env.QQBOND_DIR = L('bonds-longingplus-test');
process.env.QQTRACE_DIR = L('trace-longingplus-test');
process.env.QQFOLLOW_DIR = L('follow-longingplus-test');
process.env.QQNICK_DIR = L('nick-longingplus-test');
process.env.QQQUOTE_DIR = L('quotes-longingplus-test');
process.env.QQTHEM_DIR = L('them-longingplus-test');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-longing-plus-' + process.pid + '.json';
for (const d of [process.env.QQMIND_DIR, process.env.QQCTX_DIR, process.env.QQLONGING_DIR, process.env.QQPROMISE_DIR, process.env.QQBOND_DIR, process.env.QQTRACE_DIR]) {
  fs.rmSync(d, { recursive: true, force: true });
}

const mind = require('./mind.js');
const context = require('./context.js');
const promises = require('./promises.js');
const longing = require('./longing.js');
const brain = require('./brain.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const H = 3600e3;
const NOW = new Date(2026, 9, 23, 11, 0, 0).getTime(); // 周五上午，固定基准

function seed(key, { intimacy = 0.9, warmth = 0.6, trust = 0.6, tension = 0, msgs = 20, idleHours = 9, salience = 0.3, nick = '阿星', mineText = '我周末要去爬山' } = {}) {
  const kind = 'private';
  const uin = Number(key.slice(2));
  const st = mind.blankState(key, kind, { uin });
  st.rel = { warmth, trust, intimacy, tension };
  st.msgCount = msgs;
  st.lastTurnAt = NOW - idleHours * H;
  st.lastAffect = { pad: { p: 0, a: 0, d: 0 }, salience, at: st.lastTurnAt };
  fs.mkdirSync(process.env.QQMIND_DIR, { recursive: true });
  fs.writeFileSync(mind.stateFile(key), JSON.stringify(st));
  const turns = [
    { t: st.lastTurnAt - 120e3, from: 'them', speaker: nick, text: '今天累死了' },
    { t: st.lastTurnAt - 60e3, from: 'me', speaker: '', text: mineText }
  ];
  fs.mkdirSync(process.env.QQCTX_DIR, { recursive: true });
  fs.writeFileSync(context.fileOf(key), JSON.stringify({
    key, kind, peer: { uin }, createdAt: NOW - 86400e3, updatedAt: NOW,
    sessionStartedAt: NOW - 86400e3, turns, summary: '', facts: [], dropped: 0
  }));
  return st;
}

// ── ① 话题由头 ────────────────────────────────────────────────
seed('p:2001', { nick: '阿星' });
const t1 = longing.topicOf('p:2001', { due: { text: '周末一起去看海' } }, NOW);
ok('① 有约好的事 → 用它当由头', t1 && t1.kind === 'due' && t1.text.includes('看海'), t1);
const t2 = longing.topicOf('p:2001', {}, NOW);
ok('① 没约好就用「我上次说的那句」', t2 && t2.kind === 'mine-last' && t2.text.includes('爬山'), t2);
ok('① 由头不会无限长', (t2.text || '').length <= 60, t2.text);

// ── ② 关系僵的时候不主动寒暄 ───────────────────────────────────
seed('p:2002', { nick: '闹掰的', tension: 0.7, idleHours: 20 });
ok('② tension 0.7 时不主动', !longing.plan({ now: NOW }).some(x => x.key === 'p:2002'));
// 但有「说好的事」照样提
promises.capture('p:2002', { myText: '明天我陪你去海边' });
{
  const p = promises.load('p:2002');
  p.items.forEach(it => { it.dueAt = NOW; });
  promises.save('p:2002', p);
}
const withDue = longing.plan({ now: NOW }).filter(x => x.key === 'p:2002');
ok('② 关系僵但有约好的事 → 照样提', withDue.length === 1 && Boolean(withDue[0].due), withDue.map(x => x.due));

// ── ③ 想起时机带抖动 ──────────────────────────────────────────
// 注意：intimacyDecay 传 0 会被 expectedHours 的 `|| 2.4` 吃掉，用极小值等效关闭
longing.configure({ intensityThreshold: 1.15, jitterRatio: 0.12, baseHours: 10, intimacyDecay: 0.0001, perContactHours: 100, minIdleHours: 1, tensionBlock: 1 });
// 关系分档之后：这个人得「够熟」，否则根本进不了候选（这里只测抖动）
seed('p:2003', { nick: '卡在阈值上', intimacy: 0.9, warmth: 0, tension: 0, salience: 0, idleHours: 11.6 });
const nearA = longing.plan({ now: NOW, random: () => 0 }).some(x => x.key === 'p:2003');   // 阈值下浮 → 想起
const nearB = longing.plan({ now: NOW, random: () => 1 }).some(x => x.key === 'p:2003');   // 阈值上浮 → 还没到
ok('③ 抖动低的时候想起来了', nearA === true);
ok('③ 抖动高的时候还没到点', nearB === false);
longing.configure({ intensityThreshold: 1.15, jitterRatio: 0.12, baseHours: 36, intimacyDecay: 2.4, perContactHours: 24, minIdleHours: 3, tensionBlock: 0.6 });

// ── ④ 主动了没回音 → 可以补一句 ─────────────────────────────────
function seedOut(key, { outAgoH = 4, replied = false, followUps = 0, tension = 0, msgs = 20 } = {}) {
  seed(key, { nick: '没回音的', msgs, tension, idleHours: replied ? 0.2 : outAgoH });
  const c = longing.load(key);
  const lastOutAt = NOW - outAgoH * H;
  c.lastOutAt = lastOutAt;
  c.followUps = followUps;
  c.items = [{ t: lastOutAt, kind: 'remember', intensity: 1.2, hours: 9, text: '在干嘛呢' }];
  longing.save(key, c);
  const st = mind.loadState(key);
  st.lastTurnAt = replied ? NOW - 1 * H : NOW - (outAgoH + 2) * H;
  mind.saveState(st);
  return c;
}
seedOut('p:2101', { outAgoH: 4 });                       // 该补
seedOut('p:2102', { outAgoH: 4, replied: true });        // 回了 → 不补
seedOut('p:2103', { outAgoH: 4, followUps: 1 });         // 已补过一次 → 不补
seedOut('p:2104', { outAgoH: 40 });                      // 太久 → 不翻旧账
seedOut('p:2105', { outAgoH: 4, tension: 0.7 });         // 僵着 → 不补
seedOut('p:2106', { outAgoH: 1 });                       // 才 1 小时 → 再等等
const fu = longing.followUpCandidates({ now: NOW }).map(x => x.key);
ok('④ 4 小时没回音 → 可以补一句', fu.includes('p:2101'), fu);
ok('④ 对方回过了 → 绝不追问', !fu.includes('p:2102'), fu);
ok('④ 已经补过一次 → 不再补', !fu.includes('p:2103'), fu);
ok('④ 隔太久 → 不翻旧账', !fu.includes('p:2104'), fu);
ok('④ 关系僵着 → 不补', !fu.includes('p:2105'), fu);
ok('④ 才过一小时 → 再等等', !fu.includes('p:2106'), fu);
const f2101 = longing.followUpCandidates({ now: NOW }).find(x => x.key === 'p:2101');
ok('④ 候选带「上次说了什么」', f2101 && String(f2101.lastText).includes('在干嘛'), f2101 && f2101.lastText);
ok('④ 理由里说明「没回音」', String(longing.reasonOf(f2101)).includes('没回音'), longing.reasonOf(f2101));

// ── ⑤ 追一句不吃每日主动配额 ───────────────────────────────────
{
  // 今天已经主动找过 3 个人（都发生在 3 小时前，避开「全局 2 小时间隔」这条闸门）
  const g = longing.loadGlobal();
  g.sent = [3, 4, 5].map(i => ({ t: NOW - i * H, key: 'p:9999', intensity: 1.2 }));
  longing.saveGlobal(g);
}
ok('⑤ 今日主动额度用满 → 正常开口被拦', longing.canOutNow({ now: NOW }).ok === false && longing.canOutNow({ now: NOW }).why === 'daily-cap', longing.canOutNow({ now: NOW }));
ok('⑤ 但「补一句」仍然允许（不占名额）', longing.canOutNow({ now: NOW, forFollow: true }).ok === true, longing.canOutNow({ now: NOW, forFollow: true }));
{
  // 刚主动过 20 分钟：连补一句也要等，别连着刷
  const g = longing.loadGlobal();
  g.sent = [{ t: NOW - 20 * 60e3, key: 'p:9999', intensity: 1.2 }];
  longing.saveGlobal(g);
}
ok('⑤ 刚主动过 20 分钟 → 补一句也要等（全局间隔仍生效）', longing.canOutNow({ now: NOW, forFollow: true }).why === 'global-gap', longing.canOutNow({ now: NOW, forFollow: true }));
{
  const g = longing.loadGlobal(); g.sent = []; longing.saveGlobal(g);
}

// ── ⑥ runOnce 接线：dry 不记账、真发记 follow ────────────────────
(async () => {
  let captured = null;
  const logs = [];
  const send = async () => ({ status: 'ok' });
  const r1 = await longing.runOnce({
    now: NOW, dry: true, send, log: (o) => logs.push(o),
    think: async (ctx) => { captured = ctx; return { reply: '刚忙完，你那边呢？' }; }
  });
  ok('⑥ dry 演练会走「补一句」分支', captured && captured.followUp === true, captured && Object.keys(captured));
  ok('⑥ dry 时提示里带上「上次说了什么」', captured && String(captured.lastText).includes('在干嘛'), captured && captured.lastText);
  ok('⑥ dry 返回里标记 follow', (r1.sent || []).some(x => x.follow === true), r1.sent);
  ok('⑥ dry 不记账（followUps 仍 0）', (longing.load('p:2101').followUps || 0) === 0, longing.load('p:2101').followUps);

  const r2 = await longing.runOnce({
    now: NOW + 60e3, dry: false, send, log: (o) => logs.push(o),
    think: async (ctx) => ({ reply: '刚忙完，你那边呢？' })
  });
  const c2 = longing.load('p:2101');
  ok('⑥ 真发之后记了 followUps=1', (c2.followUps || 0) === 1, c2.followUps);
  ok('⑥ 记账里 kind=follow', (c2.items || []).some(x => x.kind === 'follow'), c2.items);
  ok('⑥ 日志事件名是 longing-follow-out', logs.some(l => l.event === 'longing-follow-out'), logs.map(l => l.event));
  ok('⑥ 返回结果 follow=1', r2.follow === 1, r2);

  // 补过一次之后，下轮不该再补
  const again = await longing.runOnce({
    now: NOW + 120e3, dry: true, send: async () => ({ status: 'ok', dry: true }),
    think: async () => ({ reply: '不该再补' }), log: (o) => logs.push(o)
  });
  ok('⑥ 补过一次后不再补同一个人', !(again.sent || []).some(x => x.key === 'p:2101'), again.sent);

  // ── ⑦ brain 提示词 ──────────────────────────────────────────
  const pFollow = brain.buildMessages({ nick: '阿星', proactive: true, followUp: true, lastText: '在干嘛呢' })[1].content;
  ok('⑦ 追一句的提示说明「没回音」', pFollow.includes('没回音'), pFollow.slice(0, 200));
  ok('⑦ 追一句禁止质问/卖惨', pFollow.includes('别质问') && pFollow.includes('别卖惨'));
  ok('⑦ 追一句允许放弃', pFollow.includes('[SKIP]'));
  const pTopic = brain.buildMessages({ nick: '阿星', proactive: true, topic: '周末要去爬山' })[1].content;
  ok('⑦ 主动开场带具体由头', pTopic.includes('具体由头') && pTopic.includes('爬山'), pTopic.slice(0, 240));
  const pOut = brain.buildMessages({ nick: '阿星', proactive: true, due: true, reason: '说好的事' })[1].content;
  ok('⑦ 到日子仍然优先进那件事', pOut.includes('说好的事到了日子'));

  // ── ⑧ 关系分档：一般关系的人不会「思念」（用户 2026-10-24 要求） ──
  {
    const KEY_FAR = 'p:900000001';    // 关系一般
    const KEY_MID = 'p:900000002';    // 一般偏熟
    const KEY_NEAR = 'p:900000003';   // 熟人（对照）
    seed(KEY_FAR, { intimacy: 0.12, warmth: 0.2, trust: 0.2, idleHours: 200, nick: '路人甲' });
    seed(KEY_MID, { intimacy: 0.45, warmth: 0.4, trust: 0.4, idleHours: 20, nick: '同事乙' });
    seed('p:900000006', { intimacy: 0.6, warmth: 0.4, trust: 0.4, idleHours: 20, nick: '聊得来但不熟' });
    seed(KEY_NEAR, { intimacy: 0.9, warmth: 0.7, trust: 0.7, idleHours: 12, nick: '老朋友' });
    seed('p:900000007', { intimacy: 0.6, warmth: 0.4, trust: 0.4, idleHours: 200, nick: '久没联系的一般朋友' });

    const p1 = longing.plan({ now: NOW });
    const keys = p1.map(x => x.key);
    ok('关系一般的人静了 200 小时也不主动', !keys.includes(KEY_FAR), keys);
    ok('不熟（0.45）静 20 小时也不主动', !keys.includes(KEY_MID), keys);
    ok('刚够熟（0.6）静 20 小时仍不主动（间隔被放大 6 倍）', !keys.includes('p:900000006'), keys);
    ok('够熟的人同一时刻会被想起', keys.includes(KEY_NEAR), keys);
    ok('一般偏熟静 200 小时才可能被想起', keys.includes('p:900000007'), keys);

    const rowFar = longing.list({ now: NOW }).find(r => r.key === KEY_FAR);
    ok('list 里关系一般的人标记 tooFar', rowFar && rowFar.tooFar === true, rowFar && rowFar.tooFar);
    ok('list 里 tooFar 的人想念强度记 0', rowFar && rowFar.intensity === 0, rowFar && rowFar.intensity);
    const rowMid = longing.list({ now: NOW }).find(r => r.key === 'p:900000006');
    ok('刚够熟的档位是 acquaintance', rowMid && rowMid.tier === 'acquaintance', rowMid && rowMid.tier);
    const rowFar045 = longing.list({ now: NOW }).find(r => r.key === KEY_MID);
    ok('0.45 的人也算 tooFar（不熟绝不主动）', rowFar045 && rowFar045.tooFar === true, rowFar045 && rowFar045.tooFar);

    // 关系一般但有「说好的事」→ 照样提（承诺比分档优先）
    promises.capture(KEY_FAR, { myText: '明天我给你带那本书' });
    const items = promises.load(KEY_FAR).items || [];
    if (items[0]) items[0].dueAt = NOW - 60e3;
    promises.save(KEY_FAR, { items });
    const p2 = longing.plan({ now: NOW });
    const dueCand = p2.find(x => x.key === KEY_FAR);
    ok('关系一般但说好的事到日子，照样开口', Boolean(dueCand && dueCand.due), p2.map(x => x.key));

    // 补一句只对够熟的人：关系一般的不追
    const KEY_MID2 = 'p:900000004';
    seed(KEY_MID2, { intimacy: 0.45, warmth: 0.4, trust: 0.4, idleHours: 6, nick: '同事丙' });
    longing.markOut(KEY_MID2, { at: NOW - 5 * H, intensity: 1.3, hours: 6, text: '在忙啥呢' });
    const followsMid = longing.followUpCandidates({ now: NOW }).map(x => x.key);
    ok('不熟的人没回音也不追一句', !followsMid.includes(KEY_MID2), followsMid);

    const KEY_NEAR2 = 'p:900000005';
    seed(KEY_NEAR2, { intimacy: 0.8, warmth: 0.6, trust: 0.6, idleHours: 6, nick: '老朋友二号' });
    longing.markOut(KEY_NEAR2, { at: NOW - 5 * H, intensity: 1.3, hours: 6, text: '在忙啥呢' });
    const followsNear = longing.followUpCandidates({ now: NOW }).map(x => x.key);
    ok('够熟的人没回音才会补一句', followsNear.includes(KEY_NEAR2), followsNear);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
