'use strict';
/**
 * 语音的「语气 / 节奏」层自检（全离线，不联网、不出声）
 * 覆盖：语气档单调性、挑档优先级、抖动边界、节奏改写、时长估算、args 真的带上 rate/pitch/volume
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prosody-'));
process.env.QQVOICE_DIR = DIR;
process.env.VOICE_DIR = DIR;

const P = require('../scripts/prosody.js');
const V = require('../scripts/voice.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
}
const mid = () => 0.5;   // 抖动归零
const low = () => 0;     // 抖动 -1
const high = () => 1;    // 抖动 +1

console.log('语气层（prosody.js）');

t('八档语气都在表里', () => {
  const keys = Object.keys(P.PROSODY).sort();
  assert.deepStrictEqual(keys, ['clingy', 'comfort', 'excited', 'neutral', 'playful', 'serious', 'sleepy', 'warm']);
});

t('安慰比平常慢、比平常低', () => {
  assert.ok(P.PROSODY.comfort.rate < P.PROSODY.neutral.rate);
  assert.ok(P.PROSODY.comfort.pitch < P.PROSODY.neutral.pitch);
});

t('兴奋比玩笑更快更高', () => {
  assert.ok(P.PROSODY.excited.rate > P.PROSODY.playful.rate);
  assert.ok(P.PROSODY.excited.pitch > P.PROSODY.playful.pitch);
});

t('困倦是最慢最轻的一档', () => {
  const slowest = Object.keys(P.PROSODY).reduce((a, b) => (P.PROSODY[a].rate <= P.PROSODY[b].rate ? a : b));
  assert.strictEqual(slowest, 'sleepy');
  assert.ok(P.PROSODY.sleepy.volume < 0);
});

t('mode=comfort → comfort（接情绪优先）', () => {
  assert.strictEqual(P.prosodyFor({ mode: 'comfort', random: mid }).tone, 'comfort');
});

t('对方诉苦（echo.intent=vent）→ comfort', () => {
  assert.strictEqual(P.prosodyFor({ echo: { intent: 'vent' }, random: mid }).tone, 'comfort');
});

t('心情很低（pad.p=-0.4）→ comfort', () => {
  assert.strictEqual(P.prosodyFor({ pad: { p: -0.4, a: 0 }, random: mid }).tone, 'comfort');
});

t('严肃 > 玩笑（同时命中时听严肃的）', () => {
  assert.strictEqual(P.prosodyFor({ mode: 'serious', echo: { kind: 'warm', score: 0.9 }, random: mid }).tone, 'serious');
});

t('mode=banter → playful', () => {
  assert.strictEqual(P.prosodyFor({ mode: 'banter', random: mid }).tone, 'playful');
});

t('对方热络(score≥0.6) → playful', () => {
  assert.strictEqual(P.prosodyFor({ echo: { kind: 'warm', score: 0.7 }, random: mid }).tone, 'playful');
});

t('恋人 + 一口气的短句 → clingy', () => {
  assert.strictEqual(P.prosodyFor({ tie: 'lover', mode: 'quick', random: mid }).tone, 'clingy');
});

t('困 / 深夜 → sleepy', () => {
  assert.strictEqual(P.prosodyFor({ mood: '有点困', hour: 15, random: mid }).tone, 'sleepy');
  assert.strictEqual(P.prosodyFor({ hour: 2, random: mid }).tone, 'sleepy');
});

t('讲原理/给建议 → serious', () => {
  assert.strictEqual(P.prosodyFor({ mode: 'deep', hour: 15, random: mid }).tone, 'serious');
  assert.strictEqual(P.prosodyFor({ mode: 'advice', hour: 15, random: mid }).tone, 'serious');
});

t('什么都没命中 → neutral', () => {
  assert.strictEqual(P.prosodyFor({ hour: 15, random: mid }).tone, 'neutral');
});

t('抖动：中值等于基准，上下限被夹住', () => {
  const base = P.prosodyFor({ mode: 'comfort', random: mid });
  assert.strictEqual(base.rate, '-8%');
  const lo = P.prosodyFor({ mode: 'comfort', random: low });
  const hi = P.prosodyFor({ mode: 'comfort', random: high });
  assert.notStrictEqual(lo.rate, hi.rate);
  const num = (s) => Number(String(s).replace('%', ''));
  assert.ok(num(lo.rate) >= -18 && num(hi.rate) <= 18, '语速被夹在 ±18% 内');
  assert.ok(num(base.rate) < num(hi.rate));
});

t('返回格式带正负号（edge-tts 要求 +N% / -NHz）', () => {
  const r = P.prosodyFor({ mode: 'comfort', random: mid });
  assert.ok(/^[+-]\d+%$/.test(r.rate), r.rate);
  assert.ok(/^[+-]\d+Hz$/.test(r.pitch), r.pitch);
  assert.ok(/^[+-]\d+%$/.test(r.volume), r.volume);
  assert.ok(r.why.length > 0);
});

console.log('节奏层（paceText）');

t('波浪号变成省略号（会真的停顿）', () => {
  assert.ok(P.paceText('在呢～').indexOf('…') >= 0);
});

t('顿号变逗号、括号补充删掉、引号去掉', () => {
  const out = P.paceText('油条、豆浆（热的）「好」');
  assert.strictEqual(out, '油条，豆浆好。');
});

t('句尾没标点会补句号', () => {
  assert.ok(P.paceText('在呢').endsWith('。'));
  assert.ok(P.paceText('在呢？').endsWith('？'));
});

t('空字符串仍然是空', () => {
  assert.strictEqual(P.paceText(''), '');
  assert.strictEqual(P.paceText(null), '');
});

t('cleanText 走同一条节奏规则', () => {
  const out = V.cleanText('在呢～刚刚在忙(改代码)，你呢、吃饭了吗', 120);
  assert.ok(out.indexOf('～') < 0 && out.indexOf('…') >= 0, out);
  assert.ok(out.indexOf('、') < 0, out);
});

t('时长估算：语速越慢估算越长', () => {
  const a = P.estimateSeconds('在呢，刚忙完，怎么啦', '+8%');
  const b = P.estimateSeconds('在呢，刚忙完，怎么啦', '-12%');
  assert.ok(b > a, a + ' vs ' + b);
});

console.log('真参数拼装（打桩，不出网）');

t('synth 把 prosody 的三轴原样塞进 edge-tts 参数', () => {
  const seen = [];
  V.__setRunner((cmd, args) => {
    seen.push(args.slice());
    const i = args.indexOf('--write-media');
    fs.writeFileSync(args[i + 1], Buffer.alloc(2048));
    return '';
  });
  const pr = { tone: 'comfort', rate: '-8%', pitch: '-2Hz', volume: '-4%' };
  const r = V.synth('在呢，刚忙完，怎么啦', { provider: 'edge', prosody: pr });
  V.__setRunner(null);
  const args = seen[0] || [];
  assert.ok(args.indexOf('--rate=-8%') >= 0, args.join(' '));
  assert.ok(args.indexOf('--pitch=-2Hz') >= 0);
  assert.ok(args.indexOf('--volume=-4%') >= 0);
  assert.strictEqual(r.tone, 'comfort');
  assert.strictEqual(r.rate, '-8%');
  assert.ok(r.estSec > 0);
});

t('不传 prosody 时用配置文件里的默认三轴', () => {
  const seen = [];
  V.__setRunner((cmd, args) => {
    seen.push(args.slice());
    const i = args.indexOf('--write-media');
    fs.writeFileSync(args[i + 1], Buffer.alloc(1024));
    return '';
  });
  V.synth('在呢', { provider: 'edge' });   // 显式走 edge：config 默认可能已被改成 gpt-sovits
  V.__setRunner(null);
  const args = (seen[0] || []).join(' ');
  assert.ok(/--rate=[+-]\d+%/.test(args), args);
  assert.ok(/--pitch=[+-]\d+Hz/.test(args), args);
});


// ---------- voiceFor：偶尔换个嗓子（一致性优先，只在合适场合） ----------
t('voiceFor 默认用主音色', () => {
  const v = P.voiceFor({ tone: 'neutral', cfg: {}, random: () => 0.9 });
  assert.strictEqual(v.voice, P.VOICE_POOL.primary);
  assert.ok('why' in v);
});
t('voiceFor 安慰/严肃/困的时候绝不换嗓子', () => {
  for (const tone of ['comfort', 'serious', 'sleepy']) {
    for (const r of [0, 0.001, 0.5]) {
      const v = P.voiceFor({ tone, cfg: {}, random: () => r });
NaN
    }
  }
});
t('voiceFor 兴奋/玩笑时会偶尔换成活泼音色', () => {
  const hits = [0.01, 0.02].map(r => P.voiceFor({ tone: 'excited', cfg: {}, random: () => r }));
  assert.ok(hits.some(h => h.voice !== P.VOICE_POOL.primary), JSON.stringify(hits));
});
t('voiceFor 概率调高到 1 就必换（但仍是池里的音色）', () => {
  const v = P.voiceFor({ tone: 'playful', cfg: { voiceSwitchProbability: 1 }, random: () => 0.5 });
  assert.notStrictEqual(v.voice, P.VOICE_POOL.primary);
  assert.ok(Object.values(P.VOICE_POOL).includes(v.voice), v.voice);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
process.exit(failed ? 1 : 0);
