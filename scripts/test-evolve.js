/**
 * test-evolve.js —— 自进化层（evolve.js）离线测试
 *
 * 全离线：造回响记录 + 人工纠错，验证「统计 → 建议 → 边界 → 落盘 → 各模块读取生效 → 回滚」。
 * 隔离：QQEVOLVE_DIR / QQECHO_DIR / QQTUNING_FILE 三处都在 logs/*-test 下。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
process.env.QQEVOLVE_DIR = path.join(ROOT, 'logs', 'evolve-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-evolve-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-evolve-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-evolve-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-evolve-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-evolve-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-evolve-test');
process.env.QQTUNING_FILE = path.join(ROOT, 'logs', 'tuning-evolve-test.json');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-evolve-' + process.pid + '.json';

for (const d of [process.env.QQEVOLVE_DIR, process.env.QQECHO_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } }
try { fs.unlinkSync(process.env.QQTUNING_FILE); } catch (e) { }

const evolve = require('./evolve.js');
const echo = require('./echo.js');
const style = require('./style.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) { ok(name + '（' + JSON.stringify(a) + '）', a === b, { got: a, want: b }); }

// 造回响记录：把 40 条里 30 条判成冷（coldRate 0.75 > coldRateHigh 0.45）
function seedEcho(cold, warm, neutral) {
  const dir = process.env.QQECHO_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const recs = [];
  let t = Date.now() - 3600e3;
  for (let i = 0; i < cold; i++) { recs.push({ t: t += 60000, kind: 'cold', score: -0.6, intent: 'neutral', gapMs: 300000, theirLen: 2, myLen: 20 }); }
  for (let i = 0; i < warm; i++) { recs.push({ t: t += 60000, kind: 'warm', score: 0.7, intent: 'neutral', gapMs: 30000, theirLen: 18, myLen: 12 }); }
  for (let i = 0; i < neutral; i++) { recs.push({ t: t += 60000, kind: 'neutral', score: 0.1, intent: 'neutral', gapMs: 60000, theirLen: 8, myLen: 12 }); }
  fs.writeFileSync(path.join(dir, 'p_test.json'), JSON.stringify({ key: 'p:test', ema: 0, streakWarm: 0, streakCold: 0, records: recs }, null, 2));
  return recs.length;
}

console.log('\n① 人工纠错入口');
{
  const r = evolve.feedback({ text: '烦死了，今天被老板骂了，好难受', intent: 'vent', note: '抱怨生活=想被安慰' });
  ok('写入成功', r.ok === true);
  const list = evolve.feedbackList();
  eq('列表长度', list.length, 1);
  eq('意图记对', list[0].intent, 'vent');
  ok('误判词表已能认出这句', (() => {
    const e = echo.observe('p:fb', { mineText: '在吗', theirsText: '烦死了，今天被老板骂了，好难受', mineAt: Date.now() - 60000, theirsAt: Date.now() });
    return e.intent === 'vent' && e.kind === 'warm';
  })());
}

console.log('\n② 样本不足不动手');
{
  try { fs.rmSync(process.env.QQEVOLVE_DIR, { recursive: true, force: true }); } catch (e) { }
  seedEcho(2, 1, 0);
  const p = evolve.preview();
  eq('skipped', p.skipped, 'not-enough-records');
  eq('建议数为 0', (p.suggestions || []).length, 0);
  const a = evolve.apply();
  eq('apply 不写盘', a.reason, 'nothing-to-tune');
}

console.log('\n③ 冷判定过多 → 建议把阈值往下挪（更难判冷）');
{
  seedEcho(30, 6, 4);
  const p = evolve.preview();
  ok('样本足够', !p.skipped && p.samples >= 40, { samples: p.samples });
  const s = (p.suggestions || []).find(x => x.param === 'coldScore');
  ok('有 coldScore 建议', !!s);
  ok('方向是往下（更难判冷）', s && s.to < s.from, s);
  ok('理由是人话且带数字依据', !!(s && /冷|阈值/.test(s.why)));
}

console.log('\n④ 边界：多轮累加不超过 maxDrift');
{
  for (let i = 0; i < 20; i++) evolve.apply();
  const tune = evolve.loadTuning();
  const cold = Number(tune.echo && tune.echo.coldScore);
  ok('coldScore 有落盘', Number.isFinite(cold), tune.echo);
  ok('未突破下界 -0.48', cold >= -0.48 - 1e-9, cold);
  ok('累计变化有历史', Array.isArray(tune.history) && tune.history.length > 0);
}

console.log('\n⑤ 落盘后 echo / style 立刻读到（tuning 优先）');
{
  echo.loadCfg._c = null;
  const c = echo.loadCfg(true);
  eq('echo.coldScore 来自 tuning', c.coldScore, evolve.loadTuning().echo.coldScore);
  fs.writeFileSync(process.env.QQTUNING_FILE, JSON.stringify({ style: { closeIntimacy: 0.42 } }, null, 2));
  const st = style.loadCfg();
  eq('style.closeIntimacy 来自 tuning', st.closeIntimacy, 0.42);
}

console.log('\n⑥ 词表学习：把纠错里的新说法补进 ventWords');
{
  try { fs.unlinkSync(process.env.QQTUNING_FILE); } catch (e) { }
  fs.rmSync(process.env.QQEVOLVE_DIR, { recursive: true, force: true });
  evolve.feedback({ text: '这两天心里堵得慌，什么事都没劲', intent: 'vent' });
  seedEcho(30, 6, 4);
  const a = evolve.apply();
  ok('补进了词', (a.words || []).length > 0, a.words);
  const tune = evolve.loadTuning();
  ok('ventWords 落盘', Array.isArray(tune.echo.ventWords) && tune.echo.ventWords.length > 0);
  echo.loadCfg._c = null;
  const c = echo.loadCfg(true);
  ok('新词能生效', (c.ventWords || []).some(w => tune.echo.ventWords.includes(w)));
}

console.log('\n⑦ 只预览不落盘');
{
  const before = JSON.stringify(evolve.loadTuning());
  const r = evolve.runOnce({ apply: false });
  eq('applied 为空', (r.applied || []).length, 0);
  eq('tuning 未变', JSON.stringify(evolve.loadTuning()), before);
}

console.log('\n⑧ 回滚');
{
  const r = evolve.reset();
  ok('删除成功', r.ok === true);
  eq('文件已不在', fs.existsSync(process.env.QQTUNING_FILE), false);
  echo.loadCfg._c = null;
  eq('echo 回到默认阈值', echo.loadCfg(true).coldScore, echo.DEFAULTS.coldScore);
}

console.log('\n⑨ 诉苦不算冷（回归）');
{
  const a = echo.judge(echo.signals({ mineText: '在干嘛', theirsText: '累死了，不想说话，烦', mineAt: Date.now() - 60000, theirsAt: Date.now() }));
  eq('intent', a.intent, 'vent');
  ok('判定为热而非冷', a.kind === 'warm', a);
  ok('理由说明是在找你', a.why.some(w => /诉苦|找你/.test(w)), a.why);
  const b = echo.judge(echo.signals({ mineText: '在吗', theirsText: '滚，别烦我', mineAt: Date.now() - 60000, theirsAt: Date.now() }));
  eq('敌方意图', b.intent, 'hostile');
  ok('判为冷', b.kind === 'cold', b);
}

// 清理
for (const d of [process.env.QQEVOLVE_DIR, process.env.QQECHO_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } }
try { fs.unlinkSync(process.env.QQTUNING_FILE); } catch (e) { }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
