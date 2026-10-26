'use strict';
/**
 * test-presence.js —— 心情状态层离线自检（不联网、不真的改 QQ 状态）
 * 覆盖：状态表完整性 / 映射优先级 / 节流（同状态、挂够时长、每日上限）/ dry 不记账 /
 *       真调接口的参数与记账 / 连续失败自动暂停 / 手动指定 / 状态查询
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-test-'));
process.env.QQPRESENCE_DIR = TMP;

const presence = require('./presence.js');

let pass = 0; const fails = [];
const queue = [];
// consider()/setById() 是 async（内部 await 接口调用），用例按队列串行跑
function ok(name, fn) { queue.push([name, fn]); }
const cfg = (over) => ({ ...presence.DEFAULTS, ...(over || {}) });
const calls = [];
function stubCall(action, params) {
  calls.push({ action, params });
  return { status: 'ok', retcode: 0, data: {} };
}
function fresh() {
  presence.reset();
  calls.length = 0;
}
const HOUR = 3600e3;
// 固定基准：2026-10-25 15:00 本地时间（下午，避开深夜/追剧时段）
const T0 = new Date(2026, 9, 25, 15, 0, 0).getTime();

// ── 1. 状态表 ──────────────────────────────────────────────────────────────
ok('基础状态与心情状态表齐备', async () => {
  assert.equal(presence.BASE.online.status, 10);
  assert.equal(presence.BASE.invisible.status, 40);
  assert.equal(presence.MOODS.inLove.ext, 1051);
  assert.equal(presence.MOODS.emo.ext, 1401);
  assert.equal(presence.MOODS.working.ext, 2023);
  assert.ok(Object.keys(presence.MOODS).length >= 15);
});
ok('状态 id 不重复', async () => {
  const ids = [...Object.keys(presence.BASE), ...Object.keys(presence.MOODS)];
  assert.equal(new Set(ids).size, ids.length);
});

// ── 2. 映射优先级 ──────────────────────────────────────────────────────────
ok('风控冷却 → 隐身', async () => {
  const r = presence.mapStatus({ riskLevel: 'cooling', hour: 15 }, cfg());
  assert.equal(r.status, 40);
  assert.equal(r.id, 'invisible');
});
ok('有恋人 + 心情正常 → 恋爱中', async () => {
  const r = presence.mapStatus({ lover: true, pad: { p: 0.2 }, hour: 15 }, cfg());
  assert.equal(r.ext, 1051);
  assert.equal(r.status, 10);
});
ok('有恋人但心情很差 → 不显示恋爱中', async () => {
  const r = presence.mapStatus({ lover: true, pad: { p: -0.5 }, hour: 15 }, cfg());
  assert.equal(r.ext, 1401);
});
ok('心情低谷 → emo中', async () => {
  const r = presence.mapStatus({ pad: { p: -0.4 }, hour: 15 }, cfg());
  assert.equal(r.ext, 1401);
  assert.ok(/低落/.test(r.why));
});
ok('对方连着冷 → emo中', async () => {
  const r = presence.mapStatus({ echoColdStreak: 2, hour: 15 }, cfg());
  assert.equal(r.ext, 1401);
});
ok('专注写代码 → 搬砖中', async () => {
  const r = presence.mapStatus({ selfKind: 'focus', selfActivity: '写代码', hour: 15 }, cfg());
  assert.equal(r.ext, 2023);
});
ok('专注调试 → 肝作业 / 看书 → 学习中', async () => {
  assert.equal(presence.mapStatus({ selfKind: 'focus', selfActivity: '调试', hour: 15 }, cfg()).ext, 2012);
  assert.equal(presence.mapStatus({ selfKind: 'focus', selfActivity: '看书', hour: 15 }, cfg()).ext, 1018);
});
ok('深夜 → 熬夜中；困 → 睡觉中', async () => {
  assert.equal(presence.mapStatus({ hour: 2 }, cfg()).ext, 1032);
  assert.equal(presence.mapStatus({ hour: 2, mood: '很困' }, cfg()).ext, 1016);
});
ok('22 点后 → 追剧中', async () => {
  assert.equal(presence.mapStatus({ hour: 23 }, cfg()).ext, 1021);
});
ok('闲着（light）→ 摸鱼中', async () => {
  assert.equal(presence.mapStatus({ selfKind: 'light', selfActivity: '吃饭', hour: 15 }, cfg()).ext, 1300);
});
ok('什么都没有 → 在线', async () => {
  const r = presence.mapStatus({ hour: 15 }, cfg());
  assert.equal(r.status, 10);
  assert.equal(r.ext, 0);
});
ok('overrides 能改表', async () => {
  const r = presence.mapStatus({ lover: true, pad: { p: 0.2 }, hour: 15 }, cfg({ overrides: { inLove: { status: 10, ext: 9999, label: '热恋' } } }));
  assert.equal(r.ext, 9999);
  assert.equal(r.label, '热恋');
});

// ── 3. 节流 ────────────────────────────────────────────────────────────────
ok('总开关关着就不动', async () => {
  fresh();
  const r = await presence.consider({ dry: true, cfg: cfg({ enabled: false }), signals: { hour: 15 } });
  assert.equal(r.skipped, 'disabled');
});
ok('dry 不下发、不记账，但返回目标', async () => {
  fresh();
  const r = await presence.consider({ dry: true, force: true, cfg: cfg(), signals: { hour: 15, selfKind: 'focus', selfActivity: '写代码' }, call: stubCall, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.dry, true);
  assert.equal(r.to.ext, 2023);
  assert.equal(calls.length, 0);
  assert.equal(presence.loadState(T0).current, null);
});
ok('真调接口参数正确并记账', async () => {
  fresh();
  const r = await presence.consider({ force: true, cfg: cfg(), signals: { hour: 15, selfKind: 'focus', selfActivity: '写代码' }, call: stubCall, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'set_online_status');
  assert.equal(calls[0].params.status, 10);
  assert.equal(calls[0].params.ext_status, 2023);
  assert.equal(calls[0].params.battery_status, 0);
  const st = presence.loadState(T0);
  assert.equal(st.current.ext, 2023);
  assert.equal(st.today.count, 1);
});
ok('同状态下一次检查不动', async () => {
  const r = await presence.consider({ cfg: cfg(), signals: { hour: 15, selfKind: 'focus', selfActivity: '写代码' }, call: stubCall, now: T0 + 10 * 60e3 });
  assert.equal(r.skipped, 'same');
});
ok('3 小时内状态变了也不换（挂够时长）', async () => {
  const r = await presence.consider({ cfg: cfg(), signals: { hour: 15, selfKind: 'light', selfActivity: '吃饭' }, call: stubCall, now: T0 + 1 * HOUR });
  assert.equal(r.skipped, 'hold');
  assert.ok(/3 小时/.test(r.why));
});
ok('挂够 3 小时后可以换', async () => {
  const r = await presence.consider({ cfg: cfg(), signals: { hour: 15, selfKind: 'light', selfActivity: '吃饭' }, call: stubCall, now: T0 + 4 * HOUR });
  assert.equal(r.ok, true);
  assert.equal(r.to.ext, 1300);
});
ok('一天换满 4 次后不再换', async () => {
  fresh();
  const sig = (i) => ({ hour: 15, selfKind: i % 2 ? 'light' : 'focus', selfActivity: i % 2 ? '吃饭' : '写代码' });
  // 全部落在同一天（T0 是 15:00，每次只前进 5 分钟；force 越过「挂够时长」但累计额度过不了）
  for (let i = 0; i < 4; i++) {
    const r = await presence.consider({ force: true, cfg: cfg(), signals: sig(i), call: stubCall, now: T0 + i * 5 * 60000 });
    assert.equal(r.ok, true, '第 ' + (i + 1) + ' 次应该成功：' + r.why);
  }
  assert.equal(presence.loadState(T0).today.count, 4);
  const r5 = await presence.consider({ cfg: cfg(), signals: { hour: 15, pad: { p: -0.9 } }, call: stubCall, now: T0 + 4 * HOUR });
  assert.equal(r5.skipped, 'daily-cap');
});
ok('跨天后额度重置', async () => {
  const nextDay = new Date(2026, 9, 26, 10, 0, 0).getTime();
  const r = await presence.consider({ cfg: cfg(), signals: { hour: 10, selfKind: 'focus', selfActivity: '看书' }, call: stubCall, now: nextDay });
  assert.equal(r.ok, true);
  assert.equal(presence.loadState(nextDay).today.count, 1);
});
ok('force 可以越过节流', async () => {
  const r = await presence.consider({ force: true, cfg: cfg(), signals: { hour: 10, pad: { p: -0.6 } }, call: stubCall, now: new Date(2026, 9, 26, 10, 5, 0).getTime() });
  assert.equal(r.ok, true);
});

// ── 4. 失败与暂停 ──────────────────────────────────────────────────────────
ok('设置失败不记账、连续两次自动暂停', async () => {
  fresh();
  const bad = () => ({ status: 'failed', error: 'boom' });
  const r1 = await presence.consider({ force: true, cfg: cfg(), signals: { hour: 15 }, call: bad, now: T0 });
  assert.equal(r1.ok, false);
  assert.equal(r1.skipped, 'failed');
  assert.equal(presence.loadState(T0).current, null);
  const r2 = await presence.consider({ force: true, cfg: cfg(), signals: { hour: 15, selfKind: 'focus', selfActivity: '写代码' }, call: bad, now: T0 + 60000 });
  assert.equal(r2.ok, false);
  const st = presence.loadState(T0);
  assert.equal(st.paused, true);
  const r3 = await presence.consider({ force: true, cfg: cfg(), signals: { hour: 15 }, call: stubCall, now: T0 + 120000 });
  assert.equal(r3.skipped, 'paused');
});
ok('reset 能解除暂停', async () => {
  presence.reset();
  assert.equal(presence.loadState(T0).paused, false);
});

// ── 5. 手动指定与查询 ──────────────────────────────────────────────────────
ok('手动设心情档', async () => {
  fresh();
  const r = await presence.setById('inLove', { call: stubCall, now: T0, cfg: cfg() });
  assert.equal(r.ok, true);
  assert.equal(calls[0].params.ext_status, 1051);
  assert.equal(presence.loadState(T0).current.label, '恋爱中');
});
ok('手动设基础档', async () => {
  const r = await presence.setById('busy', { call: stubCall, now: T0 + 60000, cfg: cfg() });
  assert.equal(r.ok, true);
  assert.equal(calls[1].params.status, 50);
});
ok('未知状态被拒', async () => {
  const r = await presence.setById('不存在的状态', { call: stubCall, cfg: cfg() });
  assert.equal(r.ok, false);
});
ok('status() 给出当前/今日/信号与目标', async () => {
  const s = presence.status({ now: T0 + 120000, cfg: cfg(), signals: { hour: 15, selfKind: 'focus', selfActivity: '写代码' } });
  assert.equal(s.enabled, true);
  assert.ok(s.current && s.current.label);
  assert.equal(typeof s.todayCount, 'number');
  assert.ok(s.want && s.want.ext === 2023);
  assert.ok(s.signals && typeof s.signals.hour === 'number');
});
ok('日志写了 jsonl（变化/失败/暂停都留痕）', async () => {
  const f = presence.logFile();
  assert.ok(fs.existsSync(f), '应有 presence.jsonl');
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 2);
  const kinds = lines.map(l => { try { return JSON.parse(l).event; } catch (e) { return ''; } });
  assert.ok(kinds.includes('presence-change'));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; } catch (e) { fails.push(name + ' :: ' + (e && e.message)); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { }
  console.log(`
test-presence: ${pass} passed, ${fails.length} failed`);
  if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
})();
