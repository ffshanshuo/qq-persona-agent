/**
 * style.js —— 说话的分寸：关系与心情反过来决定「怎么说」
 *
 * 为什么要有它：mind.js 已经知道关系四轴（warmth/trust/intimacy/tension）和心情（PAD），
 * longing.js 也知道「想不想找人」。但这两个都还没影响**说话本身**——不熟的人被叫「宝贝」、
 * 刚吵完架还在开玩笑、心情很差还连发三条，都是真人不会做的事。
 *
 * 这一层只做两件事：
 *   1) styleOf()：把数字翻译成「说话的尺度」，一句话交给模型（不给数字）
 *   2) softenText()：发出去之前做保守降级（去掉还没资格用的称呼、太长就截短），
 *      只做「减」不做「加」，绝不改写语义
 *
 * 纯本地、零 token。开关 config/style.json 的 enabled。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'style.json');
const TUNING_PATH = process.env.QQTUNING_FILE || path.join(ROOT, 'config', 'tuning.json');

const DEFAULTS = {
  enabled: true,
  // 关系档位：intimacy 到多少算「朋友」「很熟」
  friendIntimacy: 0.28,
  closeIntimacy: 0.55,
  // 熟到什么程度才可以开玩笑/起外号
  teaseIntimacy: 0.45,
  // 张力高到这个程度就算「还别扭着」：别开玩笑、先缓一句
  softenTension: 0.3,
  // 张力到这个程度：明显僵着，先低头
  tenseTension: 0.6,
  // 亲近的人也别一次说太长；不熟的人更短
  maxChars: { distant: 45, friend: 80, close: 120 },
  // 心情能量低时收紧上限（懒得打字）
  lowEnergyFactor: 0.7,
  // 还没到那么熟时，这些称呼一律换掉
  petNames: ['宝贝', '亲爱的', '宝宝', '老婆', '老公', '宝', '亲亲', '么么'],
  // 不熟时不许出现的过于亲密的说法
  intimateWords: ['想你', '抱抱', '亲亲', '么么', '爱你'],
  // ── 语气分寸（2026-10-24 用户要求：对亲近的人不能冲，对陌生人默认礼貌）──
  warmClose: true,
  politeDistant: true
};

function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    // 自进化覆盖层（evolve.js 写；没有就当不存在）
    let tune = {};
    try { tune = JSON.parse(fs.readFileSync(TUNING_PATH, 'utf8')).style || {}; } catch (e) { tune = {}; }
    const o = { ...DEFAULTS };
    const merged = { ...j, ...tune };
    for (const k of Object.keys(merged)) {
      if (k.startsWith('_')) continue;
      if (k === 'maxChars' && merged[k] && typeof merged[k] === 'object') o.maxChars = { ...DEFAULTS.maxChars, ...merged[k] };
      else o[k] = merged[k];
    }
    return o;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, num(x)));

/** 关系档位：distant 不熟 / friend 聊得来 / close 很熟 */
function registerOf(rel, o) {
  const it = clamp01(rel && rel.intimacy);
  if (it >= (o.closeIntimacy ?? DEFAULTS.closeIntimacy)) return 'close';
  if (it >= (o.friendIntimacy ?? DEFAULTS.friendIntimacy)) return 'friend';
  return 'distant';
}

/**
 * 把关系四轴 + PAD 翻译成一份「说话尺度」。
 * @returns {{register, allowTease, allowIntimate, soften, tense, maxChars, emojiMax, sleepy, hint}}
 */
function styleOf(input = {}, cfg) {
  const o = cfg || loadCfg();
  if (o.enabled === false) return { enabled: false, register: 'friend', hint: '', maxChars: 200, emojiMax: 1, allowTease: true, allowIntimate: true, soften: false, tense: false, sleepy: false };
  const rel = input.rel || {};
  const pad = input.pad || {};
  const register = registerOf(rel, o);
  const tension = clamp01(rel.tension);
  const warmth = clamp01(rel.warmth);
  const intimacy = clamp01(rel.intimacy);
  const soften = tension >= (o.softenTension ?? DEFAULTS.softenTension);
  const tense = tension >= (o.tenseTension ?? DEFAULTS.tenseTension);
  const allowTease = intimacy >= (o.teaseIntimacy ?? DEFAULTS.teaseIntimacy) && !soften;
  let allowIntimate = register === 'close' && !soften;
  // 回响层（echo.js）：TA 这几句回得冷/热，会直接改这一句的尺度
  const echo = input.echo || null;
  const tie = String(input.tie || ''); // lover / ex-cooling / ex / ''
  const streakCold = Number(echo && echo.streakCold) || 0;
  const streakWarm = Number(echo && echo.streakWarm) || 0;
  const echoCold = streakCold >= 2;
  const echoWarm = !echoCold && streakWarm >= 2;

  const energy = Number.isFinite(Number(pad.a)) ? Number(pad.a) : 0;
  const sleepy = energy < -0.25;
  let maxChars = (o.maxChars && o.maxChars[register]) || 80;
  if (echoCold) allowIntimate = false;
  if (sleepy) maxChars = Math.round(maxChars * (o.lowEnergyFactor ?? 0.7));
  if (echoCold) maxChars = Math.round(maxChars * 0.7);
  const emojiMax = register === 'distant' ? 0 : (allowTease ? 1 : 1);

  const parts = [];
  if (register === 'distant') {
    parts.push('你俩还不太熟：客气、简短，别开玩笑、别起外号、别问私事，也不要叫得太亲。');
    if (o.politeDistant !== false) {
      parts.push('默认礼貌：用「你好 / 请问 / 谢谢 / 麻烦你」这种说法，别自来熟、别一上来就热络，语气平实一点。');
    }
  } else if (register === 'friend') {
    parts.push('你俩聊得比较来：可以随口一点、偶尔开个小玩笑，语气放松但不失礼貌。');
    parts.push('聊得来也别冲人：别用命令口吻、别怼、别不耐烦地打发。');
  } else {
    parts.push('你俩很熟：可以放松、用短句和语气词，可以开点小玩笑' + (allowIntimate ? '，称呼可以亲近些。' : '。'));
    if (o.warmClose !== false) {
      parts.push('越熟越不能冲：熟归熟，别用命令口吻、别怼人、别冷冰冰地甩「哦」「行了」「随便」；语气要软和，别让人听着像在生气。');
    }
  }
  if (soften) parts.push('最近气氛有点僵：别开玩笑、别调侃，也别急着讲道理；对方要是在气头上，先软一句、认一下自己那份。');
  if (tense) parts.push('现在明显还在别扭里：这一句以缓和为主，短一点，承认感受比辩解有用。');
  if (warmth < 0.3) parts.push('对方对你还比较淡：别自来熟、别一次说太多。');
  if (sleepy) parts.push('你现在有点累：话短一点，别连发。');
  if (pad && Number(pad.p) < -0.25) parts.push('你现在心情一般：语气平一点，不用硬撑热情，也别把情绪倒给对方。');
  if (echoCold) parts.push('TA 这几句回得短、有点敷衍，像在忙或者不想聊：别黏、别追问、别连着撒娇，话少一点、留点余地。');
  else if (echoWarm) parts.push('TA 这几句回得挺热络、还主动接话：可以放松些，但别一下子过火。');
  else if (echo && echo.lastKind === 'cold') parts.push('TA 刚回得比较简短，可能手头有事：别多想，也别一下子发一大段。');
  // 关系类型（ties.js）：恋人和前任说的不是同一套话
  if (tie === 'lover') parts.push('你们是恋人：可以更亲一点（称呼、语气都可以），但别腻、别每句都撒娇。');
  else if (tie === 'ex-cooling') parts.push('你们还在冷战：别装没事，也别追问「我们到底算什么」，语气先软下来，一句就够。');
  else if (tie === 'ex') parts.push('已经是前任了：礼貌但不亲昵，别撒娇、别用以前那些称呼、也别翻旧账。');

  if (register === 'distant') parts.push('整句尽量控制在 45 字以内。');
  else if (sleepy) parts.push('一句话就够，别超过四五十字。');

  return { enabled: true, register, allowTease, allowIntimate, soften, tense, maxChars, emojiMax, sleepy, echoCold, echoWarm, echoShift: echoCold ? 'cold' : (echoWarm ? 'warm' : ''), hint: parts.join('') };
}

const SENT_END = /[。！？!?…~～\n]/;

/** 按句截断（保留标点，不切坏代理对） */
function clip(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  let out = '';
  for (const ch of t) {
    if ((out + ch).length > max) break;
    out += ch;
    if (SENT_END.test(ch) && out.length >= Math.min(max, 12)) break;
  }
  out = out.trim();
  if (!SENT_END.test(out.slice(-1))) out = out.replace(/[，,、；;：:\s]+$/, '') + '…';
  return out;
}

/**
 * 语气分寸（2026-10-24 用户要求）：**对亲近的人更不能冲**——熟归熟，别怼、别冷冰冰、
 * 别用命令口吻；对不熟的人默认礼貌。
 * 返回 { harsh, why, hit }：harsh=true 时调用方应该让模型软一句重说。
 */
const HARSH_WORDS = [
  '随便', '随你', '爱咋咋地', '别烦', '烦不烦', '懒得', '自己看着办', '管我什么事',
  '关我什么事', '少来', '别闹', '够了', '不想说', '没空理', '你爱信不信',
  '你要这么想我也没办法', '呵呵', '哦。', '恩。', '嗯。'
];
// 冷淡短句：整句就是这种"打发人"的回应（只在熟人/朋友语境里算冲）
const COLD_SHORT = /^(哦|喔|嗯|恩|行|好|知道了|是吗|这样啊|随便|呵呵)[。！!.~～]?$/;

function isHarsh(text, style) {
  const t = String(text || '').trim();
  if (!t) return { harsh: false, why: '', hit: [] };
  const st = style || {};
  const hit = [];
  for (const w of HARSH_WORDS) if (t.includes(w)) hit.push(w);
  const close = st.register === 'close' || st.register === 'friend';
  if (close && COLD_SHORT.test(t)) hit.push('冷淡短句');
  // 熟人场景下的命令口吻：句首「你给我 / 你去 / 别给我」
  if (close && /^(你给我|你去|赶紧|少废话|闭嘴)/.test(t)) hit.push('命令口气');
  if (!hit.length) return { harsh: false, why: '', hit };
  const why = close
    ? '这句对很熟的人太冲了（像在生气、不耐烦，或者打发人）。你们关系近，好好说，语气软一点。'
    : '这句有点冲。对方跟你不熟，客气一点说。';
  return { harsh: true, why, hit };
}

/**
 * 发出去之前的保守降级：只做「减」，不改语义。
 * - 不熟/别扭时：去掉还没资格用的称呼与过于亲密的词
 * - 太长：按句截断
 */
function softenText(reply, style, cfg) {
  const o = cfg || loadCfg();
  if (o.enabled === false) return String(reply || '');
  let t = String(reply || '');
  const st = style || styleOf({}, o);
  if (!st.enabled) return t;
  if (!st.allowIntimate) {
    for (const w of (o.petNames || DEFAULTS.petNames)) {
      // 「宝贝」→ 去掉，别留半个逗号
      t = t.replace(new RegExp(`[，,、\\s]*${w}[，,、\\s]*`, 'g'), (m, off) => (off === 0 ? '' : '，'))
             .replace(new RegExp(`^${w}`), '');
    }
    if (st.register === 'distant') {
      for (const w of (o.intimateWords || DEFAULTS.intimateWords)) {
        t = t.replace(new RegExp(`[，,、\\s]*${w}[，,、\\s]*`, 'g'), (m, off) => (off === 0 ? '' : '，'));
      }
    }
  }
  if (st.soften) {
    // 别扭时别用感叹号连轰
    t = t.replace(/！{2,}/g, '！').replace(/[!！]{1}/g, '。');
  }
  // 摘词之后可能留下「，了」这种残句：把语气词前的逗号吃掉
  t = t.replace(/[，,、]\s*(?=[了呀啊嘛呢吧哦嘿嗯～~]+)/g, '');
  t = t.replace(/[～~]{2,}/g, '～');
  // 「我在的了~」这种：摘掉「想你」后剩下的「的了」合成「了」
  t = t.replace(/的了(?=[～~。！？!?，,\s]|$)/g, '了');
  // 摘掉「想你」后只剩「在干嘛呢，我了」这种断句：把整个后半截去掉
  t = t.replace(/[，,][^，,。！？!?]{0,3}[我你他她它]{1,2}(?:了|的)?[了的呀啊嘛呢吧哦嘿嗯～~]*$/g, '');
  t = t.replace(/^[，,、。\s]+/, '').replace(/[，,、\s]+$/, '').trim();
  if (!t) return '';
  if (st.maxChars && t.length > st.maxChars) t = clip(t, st.maxChars);
  return t;
}

function describe(key) {
  const mind = require('./mind.js');
  const st = mind.loadState(key);
  const rel = st && st.rel ? st.rel : {};
  const pad = st && st.pad ? st.pad : {};
  const style = styleOf({ rel, pad });
  return { key, rel, pad, style };
}

// ---- 说话的习惯（口癖）：每个会话固定 1-2 条，换会话才变，免得像每次在演 ----
const HABITS = [
  { id: 'tail', tip: '句尾偶尔带「啦」「啊」「嘛」，别每句都带' },
  { id: 'repeat', tip: '偶尔把词重复一下（好好好、嗯嗯、行行），像随口应' },
  { id: 'ellipsis', tip: '想事情或没说完时用「…」拖一下，别每句都工整' },
  { id: 'filler', tip: '偶尔用「就」「反正」「其实」这类口头填充词' },
  { id: 'nosubject', tip: '有时省主语（「困了」「饿了」「刚回来」），不用每句都带「我」' },
  { id: 'bracket', tip: '偶尔用括号补一句心里话（像打字时顺手补的）' },
  { id: 'laugh', tip: '被逗到时用「哈哈哈」或「笑死」，别用「很有趣」这种书面说法' },
  { id: 'dialect', tip: '极偶尔带一点方言味儿（「整半天」「老好使了」），一点点就够' }
];

function hashOf(s) {
  const t = String(s == null ? '' : s);
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i) & 0xff; h = (h * 16777619) >>> 0; }
  return h >>> 0;
}

/**
 * 这个会话固定的口癖（同一 key 永远一样）。
 * @param {string} key
 * @param {number} [count] 1-3，默认 2
 * @returns {Array<{id:string,tip:string}>}
 */
function habitsOf(key, count) {
  const n = Math.max(1, Math.min(3, count == null ? 2 : Number(count) || 2));
  const h = hashOf(key || 'x');
  const out = [];
  for (let i = 0; i < n; i++) {
    const it = HABITS[(h + i * 7) % HABITS.length];
    if (!out.some(x => x.id === it.id)) out.push(it);
  }
  return out;
}

/** 拼成给模型的一句人话（不提规则名、不提「习惯」以外的元信息） */
function habitHint(key, count) {
  const tips = habitsOf(key, count).map(x => x.tip).join('；');
  return '你（DSH）跟 TA 说话有这些个人习惯（自然带出来就行：最多三分之一的话带一点，别每条都用，也别解释自己在这么做）：' + tips;
}
module.exports = { DEFAULTS, CFG_PATH, loadCfg, registerOf, styleOf, softenText, isHarsh, HARSH_WORDS, clip, describe, HABITS, habitsOf, habitHint, hashOf };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg || arg === '--help') {
    console.log('用法：node scripts/style.js <key>            # 看某个会话的档位与提示');
    console.log('      node scripts/style.js <key> --text "宝贝，在吗？"   # 试降级效果');
    process.exit(0);
  }
  const ti = process.argv.indexOf('--text');
  const d = describe(arg);
  console.log(`[style] ${arg}`);
  console.log(`  rel: warmth=${d.rel.warmth ?? '-'} trust=${d.rel.trust ?? '-'} intimacy=${d.rel.intimacy ?? '-'} tension=${d.rel.tension ?? '-'}`);
  console.log(`  档位: ${d.style.register}  可开玩笑=${d.style.allowTease}  可亲昵=${d.style.allowIntimate}  需缓和=${d.style.soften}  上限=${d.style.maxChars}字`);
  console.log(`  提示: ${d.style.hint || '（开关关闭）'}`);
  if (ti > 0) {
    const raw = process.argv[ti + 1] || '';
    console.log(`  原文: ${raw}`);
    console.log(`  发出: ${softenText(raw, d.style)}`);
  }
}
