'use strict';
/**
 * test-persona.js —— 说话风格层（persona.js）离线自检
 * 全离线：风格统计文件是临时造的，不碰真实语料、不发任何网络请求。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
const PROFILE = path.join(tmp, 'style.json');
const CFG = path.join(tmp, 'persona.json');
process.env.QQPERSONA_PROFILE = PROFILE;
process.env.QQPERSONA_CONFIG = CFG;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

const persona = require('../scripts/persona.js');

function writeProfile(obj) {
  fs.writeFileSync(PROFILE, JSON.stringify(obj), 'utf8');
}
function writeCfg(obj) {
  fs.writeFileSync(CFG, JSON.stringify(obj), 'utf8');
}

const FIXTURE = {
  count: 120,
  avgChars: 14.9,
  avgDurSec: 4.8,
  charsPerSec: 3.1,
  p50: 13,
  p90: 30,
  particles: { 吧: 0.42, 嗯: 0.34, 呢: 0.25, 啊: 0.17, 呀: 0.08 },
  endings: { 好的呀: 6, 我们吧: 4, 呢: 3 },
  fillers: [{ word: '哼哼', count: 3, example: '哼哼，也是。' }, { word: '什么', count: 5 }],
  selfRef: { 我: 49, 我们: 10 },
  addressTerms: { 你: 18, 梁爷: 9 },
  punctuation: { question: 0.16, exclaim: 0.06, ellipsis: 0, comma: 1.18 },
  summary: '句短、语气词少、称呼直接。',
};

(async () => {
  console.log('persona.js 说话风格层');

  // 1. 没有统计文件
  try { fs.unlinkSync(PROFILE); } catch (e) {}
  let r = persona.note();
  ok('无统计文件时安静禁用', r.enabled === false && r.why === 'no-profile');

  // 2. 样本太少不启用
  writeProfile({ ...FIXTURE, count: 3 });
  r = persona.note();
  ok('样本少于 minSamples 时不启用', r.enabled === false && r.why === 'not-enough-samples');

  // 3. 正常出提示
  writeProfile(FIXTURE);
  r = persona.note();
  ok('正常出提示', r.enabled === true && r.hint.length > 20, JSON.stringify(r).slice(0, 120));
  ok('提示含句长', r.hint.includes('14') || r.hint.includes('字'));
  ok('提示含语气词', r.hint.includes('吧') || r.hint.includes('语气词'));
  ok('提示含口癖', r.hint.includes('哼哼') || r.hint.includes('口头禅'));
  ok('提示含「别硬套」纪律', r.hint.includes('别') && (r.hint.includes('硬') || r.hint.includes('正常说话')));
  ok('提示不含统计术语', !/particles|fillers|count/i.test(r.hint));

  // 4. 特征挑拣上限
  const f = persona.features(FIXTURE);
  ok('语气词最多取 particleMax 个', f.particles.length <= 4, JSON.stringify(f.particles));
  ok('句尾最多取 3 条', f.endings.length <= 3);
  ok('口癖最多取 habitMax 个', f.habits.length <= 3, JSON.stringify(f.habits));
  ok('自称取最高频', f.selfRef === '我');

  // 5. maxHintChars 生效
  writeCfg({ enabled: true, name: '满穗', profileFile: PROFILE, maxHintChars: 60, minSamples: 10 });
  const short = persona.note(null, persona.loadCfg(true));
  ok('maxHintChars 截断', short.hint.length <= 60, String(short.hint.length));

  // 6. 关闭开关
  writeCfg({ enabled: false, profileFile: PROFILE, minSamples: 10 });
  ok('enabled:false 直接禁用', persona.note(null, persona.loadCfg(true)).enabled === false);

  // 7. mtime 变化后重新读（换统计文件不用重启）
  writeCfg({ enabled: true, profileFile: PROFILE, minSamples: 10 });
  writeProfile({ ...FIXTURE, particles: { 呀: 9.9 } });
  const st = persona.status(persona.loadCfg(true));
  ok('改文件后重新统计', st.particles.includes('呀'), JSON.stringify(st.particles));

  // 8. 坏文件不崩
  fs.writeFileSync(PROFILE, '{ 这不是 json', 'utf8');
  ok('坏 JSON 当没有', persona.note(null, persona.loadCfg(true)).enabled === false);

  // 9. brain.buildMessages 注入
  writeProfile(FIXTURE);
  const brain = require('../scripts/brain.js');
  const prompt = brain.buildMessages({ nick: '梁爷', text: '在吗', history: [], personaNote: '说话像满穗：句子短，句尾常带语气词。' }, brain.loadCfg());
  const joined = Array.isArray(prompt.history) || typeof prompt === 'string' ? JSON.stringify(prompt) : JSON.stringify(prompt);
  ok('prompt 含说话风格段', /说话风格/.test(joined));
  ok('prompt 含风格内容', /句子短/.test(joined));

  // 10. auto-reply 暴露 personaSettings
  process.env.AUTOREPLY_DRY = '1';
  const ar = require('../scripts/auto-reply.js');
  ok('auto-reply 暴露 personaSettings', typeof ar.personaSettings === 'function' && ar.personaSettings().enabled !== undefined);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
