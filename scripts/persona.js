'use strict';
/**
 * 说话风格层（persona.js）：把「某个人的说话风格统计」翻成给模型的一段人话指令。
 *
 * 为什么单独一层：
 *   - style.js 管「能说多亲密」（关系分寸）、habitsOf 管「这个会话固定带哪两条口癖」，
 *     但「句子多长、句尾爱带什么语气词、爱用什么口头禅」属于**语料里的事实**，应该从真实语料统计出来，
 *     而不是我凭感觉写死在 SYSTEM 里。
 *   - 统计结果落 logs/mansui-style.json（由 tools/asr-batch.py 一类脚本产出），本模块只读取 + 翻译。
 *
 * 纪律（来自碎话/口癖调研：不流畅、填充过多会被听成「没把握」）：
 *   - 只描述倾向，不给模型「每句都要加」的硬指令；
 *   - 明确「最多三成的话带语气词」「口癖挑一个偶尔用」；
 *   - 统计缺失/文件损坏时静默禁用，绝不让聊天因为一个统计文件崩掉。
 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const CFG_PATH = process.env.QQPERSONA_CONFIG || path.join(ROOT, 'config', 'persona.json');
const DEFAULT_PROFILE = process.env.QQPERSONA_PROFILE || path.join(ROOT, 'logs', 'mansui-style.json');

const DEFAULTS = {
  enabled: true,
  name: '满穗',
  profileFile: DEFAULT_PROFILE,
  maxHintChars: 420,
  habitMax: 3,
  particleMax: 4,
  minSamples: 20,
  _note: '说话风格层：从真实语音语料统计出的风格特征翻成 prompt 指令；profile 缺失时自动禁用',
};

let cached = { at: 0, file: '', data: null };

function loadCfg(noCache) {
  const j = store.readJson(CFG_PATH, {}) || {};
  const cfg = { ...DEFAULTS, ...j };
  if (!noCache && cached.cfgAt && Date.now() - cached.cfgAt < 5000) return cached.cfg;
  cached.cfg = cfg;
  cached.cfgAt = Date.now();
  return cfg;
}

/** 读统计文件；按 mtime 缓存，坏文件当没有 */
function loadProfile(cfg) {
  const c = cfg || loadCfg();
  const file = c.profileFile || DEFAULT_PROFILE;
  try {
    const st = fs.statSync(file);
    if (cached.data && cached.file === file && cached.at === st.mtimeMs) return cached.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached = { at: st.mtimeMs, file, data };
    return data;
  } catch (e) {
    return null;
  }
}

function pct(n, total) {
  const v = total > 0 ? (n / total) * 100 : 0;
  return Math.round(v * 10) / 10;
}

/** 从统计结果里挑出「适合抄进 prompt」的少数特征 */
function features(profile, cfg) {
  const c = cfg || loadCfg();
  const p = profile || {};
  const out = { ok: false, chars: 0, charsPerSec: 0, particles: [], endings: [], habits: [], selfRef: '', address: '', samples: 0 };
  if (!p || typeof p !== 'object') return out;
  const count = Number(p.count) || 0;
  if (count < (c.minSamples || 20)) return out;

  out.ok = true;
  out.samples = count;
  out.chars = Math.round(Number(p.avgChars) || 0);
  out.charsPerSec = Math.round((Number(p.charsPerSec) || 0) * 10) / 10;

  const particles = p.particles || {};
  out.particles = Object.keys(particles)
    .map((k) => ({ k, v: Number(particles[k]) || 0 }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, c.particleMax || 4)
    .map((x) => x.k);

  const endings = p.endings || {};
  // 只挑「功能词收尾」——像「报仇」「人了」这种是台词内容，不是说话习惯，抄进 prompt 会把话题带偏
  const tail = /[的了啊吧呢呀嘛哦啦嗯么吗]$/;
  out.endings = Object.keys(endings)
    .filter((k) => tail.test(k))
    .map((k) => ({ k, v: Number(endings[k]) || 0 }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.k);

  const fill = p.fillers || p.habits || [];
  out.habits = (Array.isArray(fill) ? fill : [])
    .map((x) => (typeof x === 'string' ? x : x && (x.word || x.text || x.k)))
    .filter(Boolean)
    .slice(0, c.habitMax || 3);

  const sr = p.selfRef || {};
  const srTop = Object.keys(sr).sort((a, b) => (Number(sr[b]) || 0) - (Number(sr[a]) || 0))[0];
  out.selfRef = srTop || '我';
  const ad = p.addressTerms || {};
  const adTop = Object.keys(ad).sort((a, b) => (Number(ad[b]) || 0) - (Number(ad[a]) || 0))[0];
  out.address = adTop || '你';
  return out;
}

/** 把特征翻成一段人话指令（给 prompt 用，绝不能出现数字统计以外的术语） */
function buildHint(profile, cfg) {
  const c = cfg || loadCfg();
  const f = features(profile, cfg);
  if (!f.ok) return '';
  const lines = [];
  const who = c.name || '她';
  lines.push(`说话方式尽量像${who}本人：`);
  if (f.chars) lines.push(`- 句子偏${f.chars <= 12 ? '短' : f.chars >= 26 ? '长一点' : '中等'}，一条消息大概 ${f.chars} 字上下，别动不动一大段。`);
  // 语气词按实测密度说人话：密度低就别鼓励「常带」，否则模型会突然变成撒娇腔
  const density = Number(f.particleDensity) || 0;
  if (f.particles.length && density >= 6) {
    lines.push(`- 常带 ${f.particles.map((x) => `「${x}」`).join('')} 这类语气词，最多三成的话带，带成习惯就假了。`);
  } else if (f.particles.length && density >= 2) {
    lines.push(`- 偶尔带一两个语气词（她偏 ${f.particles.map((x) => `「${x}」`).join('')}），大部分句子是干脆收住的。`);
  } else if (f.particles.length) {
    lines.push(`- 她**很少用语气词**（实测每百字不到两个），句子收得干脆；别为了「像」硬加呀啦呢哦。`);
  }
  if (f.endings.length) lines.push(`- 收尾常见「${f.endings.join('」「')}」。`);
  if (f.habits.length) lines.push(`- 口头禅可以有 ${f.habits.map((x) => `「${x}」`).join('')}，挑一个偶尔用，别每句都挂。`);
  if (f.selfRef && f.selfRef !== '我') lines.push(`- 自称有时用「${f.selfRef}」。`);
  if (f.address) lines.push(`- 称呼直接用「${f.address}」，不用「您」这种敬语。`);
  // 台词腔 ≠ 聊天腔：语料是剧里的台词，风格基线可以学，戏腔不要搬
  if (c.avoidStageTone !== false) {
    lines.push('- 学的是她的说话**习惯**（句长、收尾、用词直白），别把她戏里的古装腔/正剧腔搬进日常聊天。');
  }
  lines.push('- 情绪别用力过猛：不撒糖、不喊口号、不用书面腔和感叹号堆叠。');
  lines.push('- 这些是「倾向」，不是模板：别为了像而硬套，正常说话就行。');
  const text = lines.join('\n');
  return text.slice(0, c.maxHintChars || 420);
}

function note(profile, cfg) {
  const c = cfg || loadCfg();
  if (c.enabled === false) return { enabled: false, hint: '', why: 'disabled' };
  const p = profile || loadProfile(c);
  if (!p) return { enabled: false, hint: '', why: 'no-profile' };
  const hint = buildHint(p, c);
  if (!hint) return { enabled: false, hint: '', why: 'not-enough-samples' };
  return { enabled: true, hint, why: 'ok', samples: Number(p.count) || 0, name: c.name };
}

function status(cfg) {
  const c = cfg || loadCfg();
  const p = loadProfile(c);
  const f = features(p, c);
  return {
    enabled: c.enabled !== false,
    name: c.name,
    profileFile: c.profileFile,
    profileFound: !!p,
    samples: f.samples,
    avgChars: f.chars,
    charsPerSec: f.charsPerSec,
    particles: f.particles,
    habits: f.habits,
    summary: (p && p.summary) || '',
  };
}

function main(argv) {
  const cmd = argv[0] || 'show';
  if (cmd === 'show') {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === 'hint') {
    const r = note();
    console.log(r.hint || `（没有风格指令：${r.why}）`);
  } else if (cmd === 'build') {
    const c = loadCfg(true);
    const p = loadProfile(c);
    const f = features(p, c);
    console.log(JSON.stringify({ profile: c.profileFile, found: !!p, features: f, hint: buildHint(p, c) }, null, 2));
  } else {
    console.log('用法: node scripts/persona.js [show|hint|build]');
  }
}

module.exports = { DEFAULTS, CFG_PATH, DEFAULT_PROFILE, loadCfg, loadProfile, features, buildHint, note, status };

if (require.main === module) main(process.argv.slice(2));
