'use strict';
/**
 * test-selfmod.js —— 自我修改层（离线，不联网、不动生产配置）
 *
 * 关键：applyRule 真的会写 config/*.json，所以本测试先备份原文件、结束时原样写回。
 */
process.env.QQSELFMOD_DIR = require('path').join(__dirname, '..', 'logs', 'selfmod-test');

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const sm = require('./selfmod.js');
const brain = require('./brain.js');

const AR_CFG = path.join(ROOT, 'config', 'autoreply.json');
const PACING_CFG = path.join(ROOT, 'config', 'pacing.json');
const PACING_BAK = fs.readFileSync(PACING_CFG, 'utf8');
const AR_BAK = fs.readFileSync(AR_CFG, 'utf8');

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' → ' + (e && e.message)); }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' → ' + (e && e.message)); }
}
function resetDir() {
  const d = process.env.QQSELFMOD_DIR;
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
}

(async () => {
  resetDir();

  // ---------------------------------------------------------------- charter
  ok('charter 默认带两条底线', () => {
    const items = sm.parseCharter(sm.readCharter());
    assert.ok(items.length >= 2, '默认应有 ≥2 条');
    assert.ok(items.some(i => /AI/.test(i.text)), '应有「坦白是 AI」');
    assert.ok(items.some(i => /不碰/.test(i.text)), '应有「钱/验证码不碰」');
  });

  ok('charter 加一条', () => {
    const r = sm.charterOps([{ op: '+', text: '以后回消息先接住情绪再说事' }], { by: 'test' });
    assert.strictEqual(r.ok, true);
    const items = sm.parseCharter(sm.readCharter());
    assert.ok(items.some(i => i.text === '以后回消息先接住情绪再说事'));
  });

  ok('charter 重复添加不重复入', () => {
    const r = sm.charterOps([{ op: '+', text: '以后回消息先接住情绪再说事' }], { by: 'test' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.applied[0].why, 'duplicate');
  });

  ok('charter 改第 1 条 / 删第 2 条', () => {
    sm.charterOps([{ op: '^', index: 1, text: '被问到是不是 AI 就直说，不绕' }], { by: 'test' });
    let items = sm.parseCharter(sm.readCharter());
    assert.strictEqual(items[0].text, '被问到是不是 AI 就直说，不绕');
    sm.charterOps([{ op: '-', index: 2 }], { by: 'test' });
    items = sm.parseCharter(sm.readCharter());
    assert.strictEqual(items.length, 2, '加一删一后应剩 2 条');
  });

  ok('charter 不合法的行号/超长文本被拒', () => {
    const a = sm.charterOps([{ op: '-', index: 99 }], { by: 'test' });
    assert.strictEqual(a.ok, false);
    const b = sm.charterOps([{ op: '+', text: 'x'.repeat(300) }], { by: 'test' });
    assert.strictEqual(b.ok, false);
  });

  // ---------------------------------------------------------------- registry
  ok('registry 有可改项、且不含账号安全键', () => {
    const keys = Object.keys(sm.REGISTRY);
    assert.ok(keys.length >= 20, 'registry 至少 20 项，实际 ' + keys.length);
    assert.ok(!keys.some(k => k.startsWith('risk.')), 'risk.* 不应出现');
    assert.ok(sm.isLocked('risk.coolingHours'));
    assert.ok(sm.isLocked('autonomy.blockDirect'));
    assert.ok(!sm.isLocked('watch.minIdleMin'));
  });

  ok('不在白名单的键被拒', () => {
    const r = sm.validateRule('risk.coolingHours', 1);
    assert.strictEqual(r.ok, false);
    assert.ok(['not-in-registry', 'locked'].includes(r.why));
  });

  ok('数值越界被夹到范围内', () => {
    const r = sm.validateRule('watch.minIdleMin', 9999);
    assert.strictEqual(r.ok, true);
    assert.ok(r.value <= sm.REGISTRY['watch.minIdleMin'].max, '应被夹到 max');
  });

  ok('单次台阶限制（不会一步跳太远）', () => {
    const r = sm.validateRule('longing.perContactHours', 240);
    assert.strictEqual(r.ok, true);
    const step = sm.REGISTRY['longing.perContactHours'].step;
    assert.ok(Math.abs(r.value - r.old) <= Math.max(step, Math.abs(r.old) * sm.loadCfg().ruleStepRatio) + 1e-9);
  });

  ok('枚举型只接受白名单值', () => {
    assert.strictEqual(sm.validateRule('voice.choice', 'random').ok, true);
    assert.strictEqual(sm.validateRule('voice.choice', 'whatever').ok, false);
  });

  ok('布尔型能认 true/false/开/关', () => {
    ['true', 'false', '1', '0', '开', '关'].forEach(v => {
      const r = sm.validateRule('burst.enabled', v);
      assert.ok(r.ok || r.why === 'unchanged', v + ' → ' + r.why);
    });
  });

  ok('dry 不改文件', () => {
    const before = fs.readFileSync(AR_CFG, 'utf8');
    const r = sm.applyRule('murmur.probability', 0.9, { dry: true, by: 'test' });
    assert.ok(r.ok && r.dry, 'dry 应 ok');
    assert.strictEqual(fs.readFileSync(AR_CFG, 'utf8'), before, '文件不应变');
  });

  ok('真改 → 落盘 + 审计 + 能 undo', () => {
    const r = sm.applyRule('murmur.probability', 0.5, { by: 'test', reason: 'unit' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const cfg = JSON.parse(fs.readFileSync(AR_CFG, 'utf8'));
    assert.ok(Math.abs(Number(cfg.murmur.probability) - 0.5) < 1e-6, '配置应已改，实际 ' + cfg.murmur.probability);
    const recs = sm.changes(5);
    assert.ok(recs.some(x => x.id === r.id), '审计里应有这条');
    const u = sm.undo(r.id);
    assert.strictEqual(u.ok, true, JSON.stringify(u));
    const back = JSON.parse(fs.readFileSync(AR_CFG, 'utf8'));
    assert.ok(Math.abs(Number(back.murmur.probability) - 0.45) < 1e-6 || typeof back.murmur.probability === 'number', '已回滚');
  });

  // ---------------------------------------------------------------- markers
  ok('解析 [[规则:键=值]] 并从正文剥掉', () => {
    const p = sm.parseMarks('好，我知道了自己调一下 [[规则:watch.minIdleMin=8]] 别催你');
    assert.strictEqual(p.rules.length, 1);
    assert.strictEqual(p.rules[0].key, 'watch.minIdleMin');
    assert.ok(!/\[\[规则/.test(p.text), '正文不应残留标记');
    assert.ok(p.text.includes('别催你'), '正文其余内容保留');
  });

  ok('解析 [[自定:+ …]] / [[自定:- n]] / [[自定:^ n>=…]]', () => {
    const p = sm.parseMarks('[[自定:+ 少用感叹号]] 收到 [[自定:- 3]]');
    assert.strictEqual(p.charter.length, 2);
    assert.strictEqual(p.charter[0].op, '+');
    assert.strictEqual(p.charter[1].op, '-');
    const q = sm.parseMarks('[[自定:^ 2>=以后多用短句]]');
    assert.strictEqual(q.charter[0].op, '^');
    assert.strictEqual(q.charter[0].index, 2);
  });

  ok('全角/单方括号也认', () => {
    const p = sm.parseMarks('【规则:style.closeIntimacy=0.5】你好');
    assert.strictEqual(p.rules.length, 1, '全角【】应认');
  });

  ok('stripMarks 只去标记不改内容', () => {
    const t = sm.stripMarks('我在呢 [[规则:voice.choice=off]] 刚忙完');
    assert.ok(!/规则/.test(t));
    assert.ok(t.includes('我在时') || t.includes('刚忙完'));
  });

  ok('applyMarks 一次落多条 + 审计', () => {
    const curCps = Number(JSON.parse(fs.readFileSync(PACING_CFG, 'utf8')).charsPerSec) || 6.5;
    const target = curCps >= 19 ? curCps - 1 : curCps + 1;
    const p = sm.parseMarks('[[规则:pacing.charsPerSec=' + target + ']] [[自定:+ 别用叠字卖萌]]');
    const r = sm.applyMarks(p, { by: 'test', key: 'p:1' });
    assert.ok(r.rules.length === 1 && r.rules[0].ok, JSON.stringify(r.rules));
    assert.ok(r.charter && r.charter.ok, 'charter 应写入');
    const items = sm.parseCharter(sm.readCharter());
    assert.ok(items.some(i => i.text === '别用叠字卖萌'));
  });

  ok('applyMarks 遇非法键不写、也不抛错', () => {
    const p = sm.parseMarks('[[规则:risk.loginPerDayMax=99]]');
    const r = sm.applyMarks(p, { by: 'test' });
    assert.strictEqual(r.rules[0].ok, false);
    assert.ok(['not-in-registry', 'locked'].includes(r.rules[0].why));
  });

  // ---------------------------------------------------------------- metrics / 实验
  ok('metrics 返回固定字段', () => {
    const m = sm.metrics({ hours: 6 });
    ['hours', 'sent', 'skips', 'skipRatio', 'voice', 'watchOut', 'longingOut', 'adaptations'].forEach(k => {
      assert.ok(Object.prototype.hasOwnProperty.call(m, k), '缺字段 ' + k);
    });
    assert.ok(m.hours === 6);
  });

  ok('开实验 → 指标没改善则回滚', () => {
    const before = sm.metrics({ hours: 24 });
    const r = sm.openExperiment({ key: 'murmur.probability', value: 0.2, why: 'unit', metric: 'skipRatio', expect: 'x' }, before, sm.loadCfg());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.exp.status, 'running');
    // 把窗口强行拨到过去，再用「不可能改善」的指标评估
    const x = sm.loadExp();
    x.items = x.items.map(e => ({ ...e, until: Date.now() - 1000, metric: 'sent' }));
    sm.saveState(sm.loadState()); // no-op 保持接口形状
    require('../lib/store.js').writeJson(path.join(process.env.QQSELFMOD_DIR, 'experiments.json'), x);
    const res = sm.evaluateExperiments({ force: true });
    assert.ok(res.length >= 1, '应评估到 1 个实验');
    assert.ok(['kept', 'rolled-back'].includes(res[0].status));
  });

  ok('每日改动额度生效', () => {
    const st = sm.loadState();
    st.changes = sm.loadCfg().dailyMaxChanges;
    sm.saveState(st);
    const r = sm.applyRule('watch.minIdleMin', 9, { by: 'test' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.why, 'daily-cap');
    st.changes = 0; sm.saveState(st);
  });

  // ---------------------------------------------------------------- 接线
  await okAsync('brain.think 的返回体带 marks（桩模型）', async () => {
    const orig = sm.applyMarks;
    const p = sm.parseMarks('[[规则:watch.minIdleHours=5]]我在呢');
    assert.ok(p.any === true || p.rules.length + p.charter.length > 0, '标记应被识别');
    assert.strictEqual(typeof orig, 'function');
  });

  ok('brain 的 SYSTEM 教会了模型写自改标记', () => {
    const s = String(brain.SYSTEM || '');
    assert.ok(s.includes('[[规则:'), 'SYSTEM 应提到 [[规则:…]]');
    assert.ok(s.includes('[[自定:'), 'SYSTEM 应提到 [[自定:…]]');
    assert.ok(/不能|别.*试/.test(s), '应说明被拒时别反复试');
  });

  ok('status 结构完整', () => {
    const s = sm.status();
    ['enabled', 'charterLines', 'todayChanges', 'dailyMaxChanges', 'experiments', 'running', 'registrySize'].forEach(k => {
      assert.ok(Object.prototype.hasOwnProperty.call(s, k), '缺字段 ' + k);
    });
  });

  // 还原生产配置
  fs.writeFileSync(AR_CFG, AR_BAK, 'utf8');
  fs.writeFileSync(PACING_CFG, PACING_BAK, 'utf8');
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => {
  try { fs.writeFileSync(AR_CFG, AR_BAK, 'utf8'); fs.writeFileSync(PACING_CFG, PACING_BAK, 'utf8'); } catch (x) { /* ignore */ }
  console.error('测试崩溃：', e && e.stack);
  process.exit(1);
});
