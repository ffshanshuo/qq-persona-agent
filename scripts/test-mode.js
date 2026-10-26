'use strict';
// 思维模式层（mode.js）离线自检：分类 / 预算 / 反向调节 / prompt 注入 / 接线
// 全部离线：不打网络、不调模型；目录用临时文件夹隔离，跑完删掉
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqmode-'));
process.env.QQMURMUR_DIR = __dirname + '/../logs/murmur-mode-test';
process.env.QQMODE_DIR = path.join(TMP, 'mode');
process.env.QQMODE_CONFIG = path.join(TMP, 'mode.json');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_CONFIG = path.join(__dirname, '..', 'config', 'autoreply.test.json');
process.env.AUTOREPLY_LOG = path.join(TMP, 'autoreply-mode-test.log');
process.env.AUTOREPLY_STATE = path.join(TMP, 'autoreply-state.json');
process.env.QQCTX_DIR = path.join(TMP, 'context');
process.env.QQMIND_DIR = path.join(TMP, 'mind');
process.env.QQTRACE_DIR = path.join(TMP, 'trace');
process.env.QQBOND_DIR = path.join(TMP, 'bonds');
process.env.QQECHO_DIR = path.join(TMP, 'echo');
process.env.QQTHEM_DIR = path.join(TMP, 'them');
process.env.QQQUOTE_DIR = path.join(TMP, 'quotes');
process.env.QQFOLLOW_DIR = path.join(TMP, 'follow');
process.env.QQNICK_DIR = path.join(TMP, 'nick');
process.env.QQPROMISE_DIR = path.join(TMP, 'promises');
process.env.QQLONGING_DIR = path.join(TMP, 'longing');
process.env.QQRISK_DIR = path.join(TMP, 'risk');
process.env.QQSELF_DIR = path.join(TMP, 'self');
process.env.QQPACING_DIR = path.join(TMP, 'pacing');
process.env.QQGROUP_DIR = path.join(TMP, 'group');
process.env.QQAVATAR_DIR = path.join(TMP, 'avatar');
process.env.QQAVATARSRC_STATE_DIR = path.join(TMP, 'avatar-src');
process.env.QQSTICKER_BAN = '';

const mode = require('../scripts/mode.js');
const brain = require('../scripts/brain.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}
function eq(name, got, want) { ok(name + '（' + JSON.stringify(got) + '）', JSON.stringify(got) === JSON.stringify(want), { got, want }); }
const NOW = new Date(2026, 9, 24, 20, 0, 0); // 晚上八点，避开凌晨规则

console.log('\n① 分类：这句话要的是「接住」还是「方案」');
eq('倒苦水 → comfort', mode.classify({ text: '今天好烦啊，被老板骂了', now: NOW }).id, 'comfort');
eq('求助 → advice', mode.classify({ text: '这两个offer该选哪个，帮我看看', now: NOW }).id, 'advice');
eq('问原理 → deep', mode.classify({ text: '为什么快手和抖音的推荐算法差这么多', now: NOW }).id, 'deep');
eq('打招呼 → quick', mode.classify({ text: '在吗', now: NOW }).id, 'quick');
eq('笑 → banter', mode.classify({ text: '哈哈哈哈', now: NOW }).id, 'banter');
eq('闲聊 → normal', mode.classify({ text: '今天下午去海边走了走，风挺大的', now: NOW }).id, 'normal');
eq('严肃话题压过玩笑', mode.classify({ text: '哈哈我妈下周要住院做手术', now: NOW }).id, 'serious');

console.log('\n② 上下文修正');
eq('上一句在诉苦 → 即使问句也先接情绪', mode.classify({ text: '你说我该怎么办', now: NOW, echo: { intent: 'vent' } }).id, 'comfort');
eq('情绪很低 → advice 改 comfort', mode.classify({ text: '帮我看看这个怎么弄', now: NOW, pad: { p: -0.6 } }).id, 'comfort');
eq('还不熟 → banter 降 normal', mode.classify({ text: '哈哈哈笑死', now: NOW, rel: { intimacy: 0.1 } }).id, 'normal');
 eq('不知道亲密度就不瞎降', mode.classify({ text: '哈哈哈笑死', now: NOW }).id, 'banter');
eq('凌晨讲原理 → 降成 normal', mode.classify({ text: '为什么会有潮汐锁定', now: new Date(2026, 9, 24, 3, 0, 0) }).id, 'normal');
eq('严肃话题不受凌晨影响', mode.classify({ text: '我爸住院了', now: new Date(2026, 9, 24, 3, 0, 0) }).id, 'serious');

console.log('\n③ 深度预算');
const k = 'p:100000001';
ok('deep 比 quick 给得多', mode.tokensOf('deep') > mode.tokensOf('quick'), { deep: mode.tokensOf('deep'), quick: mode.tokensOf('quick') });
ok('quick 的字数上限最小', mode.charsOf('quick') < mode.charsOf('normal') && mode.charsOf('normal') < mode.charsOf('deep'));

console.log('\n④ 反向调节：冷淡就收、热络就深');
mode.save(mode.blank(k));
const b0 = mode.budgetOf('deep', mode.load(k));
for (let i = 0; i < 7; i++) mode.learn(k, { mode: 'deep', kind: 'cold' });
const stCold = mode.load(k);
const bCold = mode.budgetOf('deep', stCold);
ok('连冷 7 次后 deep 的偏好变负', stCold.byMode.deep.bias < 0, stCold.byMode.deep);
ok('整档下调（deep → normal）', bCold.mode === 'normal', bCold);
ok('预算随之收缩', bCold.maxTokens < b0.maxTokens, { before: b0.maxTokens, after: bCold.maxTokens });
ok('bias 被夹在 biasCap 内', Math.abs(stCold.byMode.deep.bias) <= mode.DEFAULTS.biasCap + 1e-9, stCold.byMode.deep.bias);

mode.save(mode.blank('p:100000002'));
for (let i = 0; i < 8; i++) mode.learn('p:100000002', { mode: 'normal', kind: 'warm' });
const bWarm = mode.budgetOf('normal', mode.load('p:100000002'));
ok('连热 8 次后 normal 上调 deep', bWarm.mode === 'deep', bWarm);

console.log('\n⑤ 学习纪律');
eq('neutral 不学', mode.learn(k, { mode: 'deep', kind: 'neutral' }).ok, false);
eq('没有模式不学', mode.learn(k, { mode: '', kind: 'warm' }).ok, false);
eq('关掉开关不学', mode.learn(k, { mode: 'deep', kind: 'cold' }, { learnFromReaction: false }).ok, false);
ok('学习落盘', fs.existsSync(mode.fileOf(k)));
ok('list 能列出来', mode.list().length >= 2, mode.list().length);
eq('不同模式分别记账', Object.keys(mode.load('p:100000002').byMode).join(','), 'normal');

console.log('\n⑥ noteFor：一句人话 + 一个预算');
const n1 = mode.noteFor(k, { text: '今天好烦啊', now: NOW }, {});
ok('comfort 的提示要求先接情绪', /先接住情绪/.test(n1.note), n1.note);
ok('带上 maxTokens', n1.budget.maxTokens >= 120, n1.budget);
const n2 = mode.noteFor('p:100000003', { text: '这两个offer怎么选，帮我看看', now: NOW }, {});
ok('advice 的提示要求给明确倾向', /明确倾向/.test(n2.note), n2.note);
const n3 = mode.noteFor(k, { text: '在吗', now: NOW }, {});
ok('quick 的提示要求一句就够', /一句话就够/.test(n3.note), n3.note);
eq('总开关关掉就不干预', mode.noteFor(k, { text: '今天好烦' }, { enabled: false }).enabled, false);

console.log('\n⑦ 注入模型 prompt（buildMessages 不露模式名）');
const msgs = brain.buildMessages({ nick: '小星', text: '今天好烦啊，被老板骂了', modeNote: n1.note, history: [] }, { ...brain.loadCfg(), models: ['x'] });
const flat = JSON.stringify(msgs);
ok('prompt 里有「这轮怎么想」', flat.indexOf('这轮怎么想') >= 0);
ok('prompt 里没有模式代号', !/comfort|"mode"/.test(flat), flat.slice(0, 200));

console.log('\n⑧ 接线：handle() 会打 mode 日志、并把预算交给 brain');
(async () => {
  const ar = require('../scripts/auto-reply.js');
  const seen = [];
  const stub = global.__brainStub = true;
  const calls = [];
  const orig = require('../scripts/brain.js');
  // 桩：不发网络，记录拿到的 ctx
  require('../scripts/brain.js').think = async (ctx) => {
    calls.push({ modeNote: ctx.modeNote, maxTokens: ctx.maxTokens });
    return { reply: '听着就累，先歇会儿吧。', stickerKey: '', model: 'stub', ms: 1 };
  };
  const evt = {
    post_type: 'message', message_type: 'private', self_id: 0, user_id: 123456789, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '今天好烦啊，被老板骂了' } }], raw_message: '今天好烦啊，被老板骂了'
  };
  await ar.handle(evt);
  ok('brain.think 拿到了 modeNote', !!calls[0] && /先接住情绪/.test(String(calls[0].modeNote)), calls[0] && String(calls[0].modeNote).slice(0, 40));
  ok('brain.think 拿到了这一轮的 token 预算', !!calls[0] && calls[0].maxTokens >= 120, calls[0] && calls[0].maxTokens);
  const logTxt = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  ok('日志里有 mode 事件', /"event":"mode"/.test(logTxt));

  // 第二轮：上一轮是 comfort，这次对方回得很冷淡 → 应该出现 mode-learn
  const evt2 = { ...evt, message: [{ type: 'text', data: { text: '嗯' } }], raw_message: '嗯', time: Math.floor(Date.now() / 1000) };
  await ar.handle(evt2);
  const logTxt2 = fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8');
  ok('冷静的回应触发了 mode-learn', /"event":"mode-learn"/.test(logTxt2), logTxt2.split('\n').filter(l => l.includes('mode-learn')).slice(-1)[0] || '');

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('ERR', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { }
  process.exit(1);
});
