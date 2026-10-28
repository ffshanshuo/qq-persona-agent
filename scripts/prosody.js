'use strict';
/**
 * 语音的「语气 / 节奏」层（纯算术，0 依赖、0 网络）。
 *
 * 为什么是这三个旋钮：edge-tts 只开放 `--rate` / `--pitch` / `--volume`
 * （微软服务端禁止自定义 SSML），换音色又会破坏「同一个人」的身份感，
 * 所以语气 = 语速 + 音高 + 音量的组合，而不是换声音。
 *
 * 节奏靠标点：TTS 只在标点处停顿，所以把「写给人看」的句子改成「念出来顺口」的句子
 * （波浪号→省略号、顿号→逗号、去掉括号补充、句尾补句号）。
 */

const PROSODY = {
  neutral: { rate: 0, pitch: 0, volume: 0 },
  warm: { rate: -3, pitch: 1, volume: 0 },       // 温和、平常关心
  comfort: { rate: -8, pitch: -2, volume: -4 },  // 安慰/心疼：慢、低、轻
  playful: { rate: 8, pitch: 4, volume: 2 },     // 玩笑、逗人：快、亮
  clingy: { rate: 5, pitch: 6, volume: 0 },      // 撒娇：软、偏高
  sleepy: { rate: -12, pitch: -5, volume: -8 },  // 困、夜里：很慢、低、轻
  serious: { rate: -4, pitch: -1, volume: 0 },   // 认真/坏消息：稳
  excited: { rate: 12, pitch: 5, volume: 3 }     // 特别高兴
};

function fmtPct(n) { const x = Math.round(Number(n) || 0); return (x >= 0 ? '+' : '') + x + '%'; }
function fmtHz(n) { const x = Math.round(Number(n) || 0); return (x >= 0 ? '+' : '') + x + 'Hz'; }
function clampNum(n, lo, hi) { const x = Number(n) || 0; return Math.max(lo, Math.min(hi, x)); }

/**
 * 挑语气档 + 少量抖动（真人每次说话都不会一模一样）。
 * @param {{mood?:string,pad?:{p:number,a:number},mode?:string,echo?:object,tie?:string,hour?:number,random?:Function,text?:string}} s
 * @returns {{tone:string,rate:string,pitch:string,volume:string,why:string}}
 */
// 模型可以自己指定语气（[[语气:温柔]] 之类）：进来就照它的来，不再由规则替它挑
const TONE_WORDS = {
  温柔: 'comfort', 安慰: 'comfort', 关心: 'comfort', 心疼: 'comfort', 哄: 'comfort',
  开心: 'playful', 逗: 'playful', 俏皮: 'playful', 玩笑: 'playful', 打趣: 'playful',
  撒娇: 'clingy', 黏: 'clingy', 亲昵: 'clingy',
  困: 'sleepy', 疲惫: 'sleepy', 累: 'sleepy', 低声: 'sleepy', 小声: 'sleepy',
  认真: 'serious', 严肃: 'serious', 正经: 'serious', 郑重: 'serious',
  兴奋: 'excited', 激动: 'excited', 高兴: 'excited',
  温暖: 'warm', 暖: 'warm', 平常: 'neutral', 平静: 'neutral', 正常: 'neutral'
};
function toneOfWord(w) {
  const k = String(w || '').trim();
  if (!k) return null;
  return PROSODY[k] ? k : (TONE_WORDS[k] || null);
}
function byTone(w) {
  const t = toneOfWord(w);
  if (!t) return null;
  return { ...PROSODY[t], tone: t, by: "model" };
}

function prosodyFor(s) {
  const o = s || {};
  if (o.tone && PROSODY[o.tone]) return { ...PROSODY[o.tone], tone: o.tone, by: 'model', why: o.why || '模型自己挑的语气' };
  const pad = o.pad || {};
  const mood = String(o.mood || '');
  const mode = String(o.mode || '');
  const echo = o.echo || {};
  const hour = Number.isFinite(o.hour) ? o.hour : new Date().getHours();
  let tone = 'neutral';
  let why = '平常';

  if (mode === 'comfort' || echo.intent === 'vent' || Number(pad.p) <= -0.25) {
    tone = 'comfort';
    why = mode === 'comfort' ? '这轮在接情绪' : (echo.intent === 'vent' ? '对方在诉苦' : '心情偏低');
  } else if (mode === 'serious') {
    tone = 'serious'; why = '严肃话题';
  } else if (mode === 'banter' || (echo.kind === 'warm' && Number(echo.score) >= 0.6)) {
    tone = 'playful'; why = '在开玩笑';
  } else if (o.tie === 'lover' && (mode === 'quick' || mood.indexOf('撒娇') >= 0)) {
    tone = 'clingy'; why = '恋人在撒娇';
  } else if (mood.indexOf('困') >= 0 || mood.indexOf('累') >= 0 || hour >= 23 || hour < 6) {
    tone = 'sleepy'; why = '困了 / 夜里';
  } else if (mode === 'deep' || mode === 'advice') {
    tone = 'serious'; why = '在讲正经的';
  } else if (echo.kind === 'warm') {
    tone = 'warm'; why = '对方挺热络';
  }

  const base = PROSODY[tone] || PROSODY.neutral;
  const rnd = typeof o.random === 'function' ? o.random : Math.random;
  const j = () => rnd() * 2 - 1;   // -1 .. 1
  return {
    tone,
    rate: fmtPct(clampNum(base.rate + j() * 2, -18, 18)),
    pitch: fmtHz(clampNum(base.pitch + j() * 1, -8, 8)),
    volume: fmtPct(clampNum(base.volume + j() * 1, -12, 6)),
    why
  };
}

/**
 * 念出来顺口：把书面符号换成会让 TTS 停顿的标点。
 * @param {string} s
 * @returns {string}
 */
function paceText(s) {
  let t = String(s == null ? '' : s)
    .replace(/[～~]+/g, '…')
    .replace(/[（(][^）)]{0,20}[）)]/g, '')
    .replace(/[「」“”"']/g, '')
    .replace(/[、]/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (!/[。！？…]$/.test(t)) t += '。';
  return t;
}

/** 一句「念出来」大概多少秒（中文约 4.5 字/秒，再按语速百分比缩放）——只用于日志估算，不做硬判断 */
function estimateSeconds(text, rate) {
  const chars = String(text || '').replace(/\s/g, '').length;
  const pct = Number(String(rate || '0').replace('%', '')) || 0;
  const speed = 4.5 * (1 + pct / 100);
  return Math.round((chars / Math.max(1, speed)) * 10) / 10;
}

// ---- 音色多样性：同一副人设偶尔换个「嗓子」，别每次都一个调 ----
// 主音色是身份（晓晓）；只在玩笑/兴奋时小概率换活泼的晓伊，安慰/严肃/困时绝不换。
const VOICE_POOL = {
  primary: 'zh-CN-XiaoxiaoNeural',
  lively: 'zh-CN-XiaoyiNeural',
  accent: 'zh-CN-liaoning-XiaobeiNeural'
};

/**
 * 挑这一条的嗓音。
 * @param {{tone?:string,cfg?:object,random?:Function}} s
 * @returns {{voice:string,switched:boolean,why:string}}
 */
function voiceFor(s) {
  const o = s || {};
  const cfg = o.cfg || {};
  // 调研结论：身份一致靠「音色固定 + 韵律变化」，换声只在玩笑/模仿时极小概率出现，且不换方言
  const pool = Array.isArray(cfg.voicePool) && cfg.voicePool.length ? cfg.voicePool : [VOICE_POOL.primary, VOICE_POOL.lively];
  const base = cfg.voiceSwitchProbability == null ? 0.04 : Number(cfg.voiceSwitchProbability);
  const rnd = typeof o.random === 'function' ? o.random : Math.random;
  const tone = String(o.tone || 'neutral');
  let boost = 1;
  if (tone === 'playful' || tone === 'excited') boost = 2.2;
  else if (tone === 'clingy') boost = 1.5;
  else if (tone === 'comfort' || tone === 'serious' || tone === 'sleepy') boost = 0;
  const p = Math.max(0, Math.min(1, base * boost));
  if (pool.length < 2 || rnd() >= p) return { voice: pool[0], switched: false, why: '保持主音色' };
  const idx = 1 + Math.floor(rnd() * (pool.length - 1));
  const v = pool[idx] || pool[0];
  return { voice: v, switched: v !== pool[0], why: v === pool[0] ? '保持主音色' : '换个嗓音，别每次一个调' };
}
module.exports = { PROSODY, TONE_WORDS, VOICE_POOL, toneOfWord, byTone, prosodyFor, voiceFor, paceText, fmtPct, fmtHz, estimateSeconds, clampNum };
