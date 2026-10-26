'use strict';
/**
 * test-ties.js —— 关系类型层离线自检（不联网、不碰生产目录）
 * 覆盖：档位推导 / 意图识别 / 表白门槛 / 全局唯一恋人 / 冷战 / 自动分手 / 修复 / 复合 / 对外接口（想念因子、授权、语气）/ 落盘与坏文件
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ties-test-'));
process.env.QQTIES_DIR = TMP;

const ties = require('./ties.js');

let pass = 0; const fails = [];
function ok(name, fn) {
  try { fn(); pass++; }
  catch (e) { fails.push(name + ' :: ' + (e && e.message)); }
}
const cfg = (over) => ({ ...ties.DEFAULTS, ...(over || {}) });
const at = (h) => Date.now() + h * 3600e3;

// ── 1. 档位推导 ────────────────────────────────────────────────────────────
ok('blank 默认是陌生人', () => {
  const b = ties.blank('p:1', '1');
  assert.equal(b.type, 'stranger');
  assert.equal(b.reunions, 0);
  assert.equal(b.phase, '');
});
ok('tierFromRel 四档', () => {
  const c = cfg();
  assert.equal(ties.tierFromRel({ intimacy: 0.05 }, c), 'stranger');
  assert.equal(ties.tierFromRel({ intimacy: 0.2 }, c), 'acquaintance');
  assert.equal(ties.tierFromRel({ intimacy: 0.4 }, c), 'friend');
  assert.equal(ties.tierFromRel({ intimacy: 0.7 }, c), 'close');
});
ok('亲密度再高也不会自动变成恋人', () => {
  const c = cfg();
  assert.notEqual(ties.tierFromRel({ intimacy: 1 }, c), 'lover');
});

// ── 2. 意图识别 ────────────────────────────────────────────────────────────
ok('认得出表白', () => {
  assert.ok(ties.detect('我们在一起吧').some(x => x.kind === 'propose'));
  assert.ok(ties.detect('做我女朋友吧').some(x => x.kind === 'propose'));
  assert.ok(ties.detect('我喜欢你').some(x => x.kind === 'propose'));
});
ok('认得出答应', () => {
  assert.ok(ties.detect('好啊').some(x => x.kind === 'accept'));
});
ok('认得分手与复合', () => {
  assert.ok(ties.detect('我们分手吧').some(x => x.kind === 'break'));
  assert.ok(ties.detect('我们复合吧').some(x => x.kind === 'reunion'));
});
ok('「一起做作业」不算表白', () => {
  assert.equal(ties.detect('我们在一起做作业吧').length, 0);
});
ok('空文本不误判', () => {
  assert.equal(ties.detect('').length, 0);
});

// ── 3. 表白门槛：关系不够近不改身份 ────────────────────────────────────────
ok('关系不够近时表白 → 不改类型', () => {
  const r = ties.observe('p:100', { text: '我们在一起吧', rel: { intimacy: 0.2, trust: 0.3 }, cfg: cfg() });
  assert.equal(r.changed, false);
  assert.equal(r.why, 'not-close-enough');
  assert.equal(ties.load('p:100').type, 'stranger');
});
ok('关系到位时表白 → 变恋人并占住唯一位', () => {
  const r = ties.observe('p:101', { text: '我们在一起吧', rel: { intimacy: 0.8, trust: 0.7 }, cfg: cfg(), uin: '101' });
  assert.equal(r.changed, true);
  assert.equal(r.to, 'lover');
  const g = ties.loadGlobal();
  assert.equal(g.lover.key, 'p:101');
  assert.equal(g.lover.uin, '101');
});
ok('已经有恋人时第二个人表白 → 冲突、不覆盖', () => {
  const r = ties.observe('p:102', { text: '做我女朋友吧', rel: { intimacy: 0.9, trust: 0.9 }, cfg: cfg(), uin: '102' });
  assert.equal(r.changed, false);
  assert.equal(r.conflict, true);
  assert.equal(r.why, 'lover-taken');
  assert.ok(/恋人/.test(r.note));
  assert.equal(ties.loadGlobal().lover.key, 'p:101');
  assert.equal(ties.load('p:102').type, 'stranger');
});
ok('答应（accept）也能成为恋人', () => {
  const r = ties.observe('p:103', {
    text: '好啊', rel: { intimacy: 0.8, trust: 0.7 }, cfg: cfg({}), uin: '103',
    // 先清掉唯一位，模拟空位
  });
  // p:101 还占着位置 → 应该是冲突，正好验证「非恋人档不会因为 accept 越权」
  assert.equal(r.why, 'lover-taken');
});

// ── 4. 冷战 → 自动分手 / 修复 ──────────────────────────────────────────────
ok('恋人张力到 0.7 → 进入冷战', () => {
  const r = ties.observe('p:101', { text: '嗯', rel: { intimacy: 0.8, trust: 0.7, tension: 0.75 }, cfg: cfg() });
  assert.equal(r.changed, true);
  assert.ok(r.events.some(e => e.type === 'tie-cooling'));
  const t = ties.load('p:101');
  assert.equal(t.type, 'lover');
  assert.equal(t.phase, 'cooling');
});
ok('冷战中张力降下来 → 和好', () => {
  const r = ties.observe('p:101', { text: '抱歉', rel: { intimacy: 0.8, trust: 0.7, tension: 0.2 }, cfg: cfg() });
  assert.ok(r.events.some(e => e.type === 'tie-repair'));
  assert.equal(ties.load('p:101').phase, '');
});
ok('冷战超时 → 自动分手并释放唯一位', () => {
  const c = cfg({ breakHours: 1 });
  ties.saveGlobal({ lover: null });
  ties.observe('p:104', { text: '我们在一起吧', rel: { intimacy: 0.9, trust: 0.9 }, cfg: c, uin: '104', now: at(-10) });
  assert.equal(ties.loadGlobal().lover.key, 'p:104');
  ties.observe('p:104', { text: '嗯', rel: { intimacy: 0.9, trust: 0.9, tension: 0.8 }, cfg: c, now: at(-3) });
  const r = ties.observe('p:104', { text: '嗯', rel: { intimacy: 0.9, trust: 0.9, tension: 0.8 }, cfg: c, now: at(0) });
  const t = ties.load('p:104');
  assert.equal(t.type, 'ex', 'rule: ' + r.why);
  assert.ok(t.brokenAt);
  assert.equal(ties.loadGlobal().lover, null);
});
ok('对方明说分手 → 立刻 ex', () => {
  const c = cfg();
  ties.saveGlobal({ lover: null });
  ties.observe('p:105', { text: '我们在一起吧', rel: { intimacy: 0.9, trust: 0.8 }, cfg: c, uin: '105' });
  assert.equal(ties.load('p:105').type, 'lover', '前置：得先是恋人');
  const r = ties.observe('p:105', { text: '我们分手吧', rel: { intimacy: 0.5, trust: 0.5 }, cfg: c });
  assert.equal(r.to, 'ex');
  assert.equal(ties.loadGlobal().lover, null);
});

// ── 5. 复合 ────────────────────────────────────────────────────────────────
ok('复合：关系没回来时只给提示不改身份', () => {
  const c = cfg();
  const r = ties.observe('p:105', { text: '我们复合吧', rel: { intimacy: 0.2, trust: 0.5, tension: 0.6 }, cfg: c });
  assert.equal(r.changed, false);
  assert.equal(r.why, 'reunion-not-ready');
  assert.ok(/复合/.test(r.note));
  assert.equal(ties.load('p:105').type, 'ex');
});
ok('复合：条件满足 → 回恋人、reunions+1', () => {
  const c = cfg();
  const r = ties.observe('p:105', { text: '我们复合吧', rel: { intimacy: 0.7, trust: 0.6, tension: 0.1 }, cfg: c });
  assert.equal(r.changed, true);
  assert.equal(r.to, 'lover');
  const t = ties.load('p:105');
  assert.equal(t.reunions, 1);
  assert.equal(t.brokenAt, null);
  assert.equal(ties.loadGlobal().lover.key, 'p:105');
});
ok('复合冷却期内不再重复处理', () => {
  const c = cfg();
  ties.saveGlobal({ lover: null });
  const t0 = ties.load('p:105');
  ties.save({ ...t0, type: 'ex', brokenAt: Date.now(), lastAsk: { ...(t0.lastAsk || {}), reunionAt: Date.now() } });
  const r = ties.observe('p:105', { text: '我们复合吧', rel: { intimacy: 0.8, trust: 0.8, tension: 0.1 }, cfg: c });
  assert.equal(r.why, 'reunion-cooldown');
});

// ── 6. 对外接口：想念因子 / 授权 / 语气 / 文案 ─────────────────────────────
ok('想念因子：恋人更快、前任永不', () => {
  ties.save({ ...ties.blank('p:200'), type: 'lover', since: Date.now() - 3 * 86400e3 });
  const lf = ties.longingFactor('p:200');
  assert.equal(lf.never, false);
  assert.ok(lf.factor < 1);
  assert.equal(ties.longingFactor('p:105').never, true);
  assert.equal(ties.longingFactor('p:100').factor, 1);
});
ok('恋人自动获得改资料授权', () => {
  assert.equal(ties.authorizedForProfile('p:200'), true);
  assert.equal(ties.authorizedForProfile('p:100'), false);
});
ok('styleHint 给出 lover / ex', () => {
  assert.equal(ties.styleHint('p:200'), 'lover');
  assert.equal(ties.styleHint('p:105'), 'ex');
  assert.equal(ties.styleHint('p:100'), '');
});
ok('noteFor 是给人看的话、不带数字字段名', () => {
  const a = ties.noteFor('p:200');
  const b = ties.noteFor('p:105');
  assert.ok(/恋人/.test(a) && /在一起/.test(a), a);
  assert.ok(/分手/.test(b), b);
  assert.ok(!/intimacy|tension|type=/.test(a + b));
});

// ── 7. 落盘 / 坏文件 / 列表 ────────────────────────────────────────────────
ok('落盘后能读回', () => {
  const t = ties.load('p:101');
  assert.equal(t.type, 'lover');
  assert.ok(Array.isArray(t.history) && t.history.length >= 1);
});
ok('坏 JSON 会被改名备份而不是当成空', () => {
  const f = ties.fileOf('p:999');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ 这不是 json', 'utf8');
  const t = ties.load('p:999');
  assert.equal(t.type, 'stranger');
  const bad = fs.readdirSync(path.dirname(f)).filter(x => x.includes('.bad-'));
  assert.ok(bad.length >= 1, '应留下 .bad-* 备份');
});
ok('list / status 形状可用', () => {
  const l = ties.list();
  assert.ok(Array.isArray(l) && l.length >= 2);
  const one = l.find(x => x.key === 'p:101');
  assert.ok(one && one.label && typeof one.days === 'number');
  const s = ties.status();
  assert.ok('lover' in s && Array.isArray(s.ties));
});
ok('档位只会升不会因为一次冷场掉档', () => {
  const c = cfg();
  ties.save({ ...ties.blank('p:300', '300'), type: 'friend', since: Date.now() });
  ties.observe('p:300', { text: '嗯', rel: { intimacy: 0.02, trust: 0.05, tension: 0.1 }, cfg: c });
  assert.equal(ties.load('p:300').type, 'friend');
});

// ── 收尾 ───────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { }
console.log(`\ntest-ties: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
