/**
 * say.js —— 发送前的「人话自检」
 *
 * 真实对话里抓到的毛病（2026-10-23 好友B那段）：
 *   「在呢在呢，刚没看手机～收到 received 👍」  ← 中英混杂
 *   还有一类常见的：助手口气（"作为一个AI…"）、复述画面（"这张图里…"）、列清单、翻译腔。
 *
 * 这一层只做两件事：
 *   1) inspect() 找出毛病（给日志/回归用）
 *   2) fix() 能改的直接改（安全的字符串清理），改不动的标 needRetry 让上层重写一次
 *
 * 不做的事：不改意思、不加内容、不因为"不像人"就把话删空。
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  // 允许出现的英文（缩写/型号/常见外号），其余中英混杂里的英文单词会被摘掉
  allowEn: ['ok', 'dsh', 'qq', 'ai', 'k', 'emmm', 'awsl', 'yyds', 'xswl', 'jpg', 'png', 'gif', 'wc', 'hhh', 'hh', 'mm', 'cm', 'km', 'gb', 'mb', 'b', 'g'],
  // 英文 → 中文的常用替换（常见的模型手滑词）
  enMap: {
    received: '', okay: '好', yes: '嗯', no: '不', sorry: '抱歉', thanks: '谢啦', thank: '谢',
    hello: '嘿', hi: '嘿', bye: '先这样', lgtm: '好', pls: '请', please: '请', sir: '你',
    really: '', very: '', so: '', and: '', but: ''
  },
  assistantRe: '作为(一个)?\\s*(AI|人工智能|大模型|语言模型|智能助手|AI助手|助手)|我是一个?(AI|人工智能|语言模型|机器人)|我只是(一个)?(AI|模型)|我作为(一个)?(AI|助手)|AI助手|智能助手|自动回复机器人',
  metaRe: '根据(我的)?(记忆|记录|数据库)|我的数据库|我没有(情感|感情|情绪)|我无法(感受|理解情感)|检索到|知识库|系统提示|prompt',
  listRe: '(^|\\n)\\s*(\\d+[.、)）]|[-*•·])\\s*\\S',
  narrateRe: '这张图(片)?(里|中|上)|画面(中|里)|图片上|图中(有|是)|从图片',
  translateRe: '的话，|进行一个|对于.{1,8}来说，.{0,6}是|首先.{0,30}其次|总而言之|综上所述|需要注意的是',
  // 长度上限的宽容倍数（超过 style.maxChars 这个倍数才判超长）
  overLongFactor: 1.6,
  emojiMax: 2,
  // 需要重写（字符串清不干净）的问题
  retryCodes: ['assistant', 'meta', 'list', 'translate'],
  logBad: true,
  badFile: 'logs/say-bad.jsonl'
};

const EN_WORD = /([A-Za-z][A-Za-z'’]{1,15})/g;

function loadCfg(over) { return { ...DEFAULTS, ...(over || {}) }; }

function countEmoji(s) {
  const m = String(s || '').match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu);
  return m ? m.length : 0;
}

/** 摘掉中英混杂里的英文单词（保留 allowEn 与数字型号） */
function stripStrayEn(text, cfg) {
  const allow = new Set((cfg.allowEn || []).map((x) => String(x).toLowerCase()));
  const map = cfg.enMap || {};
  return String(text || '').replace(EN_WORD, (w) => {
    const low = w.toLowerCase();
    if (allow.has(low)) return w;
    if (map[low] !== undefined) return map[low];
    return ''; // 直接摘掉
  }).replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？~～、；：])/g, '$1').replace(/^[ \t]+|[ \t]+$/gm, '');
}

/** 列表 → 一句话（"1. 早点睡 2. 多喝水" → "早点睡，多喝水"） */
function flattenList(text) {
  const lines = String(text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (lines.length <= 1) {
    return String(text || '').replace(/^(\d+[.、)）]|[-*•·])\s*/gm, '');
  }
  const parts = lines.map((l) => l.replace(/^(\d+[.、)）]|[-*•·])\s*/, '').replace(/[。；;]$/, ''));
  let s = parts.join('，');
  s = s.replace(/，{2,}/g, '，').replace(/，。$/, '。');
  if (!/[。！？~～]$/.test(s)) s += '。';
  return s;
}

/** 去重连续 emoji（😄😄😄 → 😄），并限制数量 */
function trimEmoji(text, max) {
  let s = String(text || '').replace(/([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])\1+/gu, '$1');
  const all = s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
  if (all.length > max) {
    let n = 0;
    s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, (c) => (++n <= max ? c : ''));
    s = s.replace(/[ \t]{2,}/g, ' ').trim();
  }
  return s;
}

/**
 * 找出这句话的毛病。
 * @returns {{ok:boolean, issues:Array<{code:string,label:string,hit:string}>, needRetry:boolean, chars:number}}
 */
function inspect(text, opts = {}) {
  const cfg = loadCfg(opts.cfg);
  const s = String(text || '').trim();
  const issues = [];
  if (!s) return { ok: true, issues, needRetry: false, chars: 0 };

  const add = (code, label, hit) => issues.push({ code, label, hit: String(hit || '').slice(0, 40) });

  // 中英混杂（去掉 allowEn 与 enMap 后还剩英文才算出问题）
  const allow = new Set((cfg.allowEn || []).map((x) => String(x).toLowerCase()));
  const rest = (s.match(EN_WORD) || []).filter((w) => !allow.has(w.toLowerCase()));
  if (rest.length) add('mixed-en', '中英混杂', rest.join(','));

  if (new RegExp(cfg.assistantRe).test(s)) add('assistant', '助手口气', (s.match(new RegExp(cfg.assistantRe)) || [])[0]);
  if (new RegExp(cfg.metaRe).test(s)) add('meta', '提记忆/系统', (s.match(new RegExp(cfg.metaRe)) || [])[0]);
  if (new RegExp(cfg.listRe).test(s)) add('list', '列清单', s.split(/\n/)[0]);
  if (new RegExp(cfg.narrateRe).test(s)) add('narrate', '复述画面', (s.match(new RegExp(cfg.narrateRe)) || [])[0]);
  if (new RegExp(cfg.translateRe).test(s)) add('translate', '翻译腔', (s.match(new RegExp(cfg.translateRe)) || [])[0]);

  const max = Number(opts.maxChars) || 0;
  if (max && s.length > max * (cfg.overLongFactor || 1.6)) add('long', '太长', `${s.length}>${max}`);
  if (countEmoji(s) > (cfg.emojiMax || 2)) add('emoji', '表情太多', String(countEmoji(s)));
  if (/\n{2,}/.test(s)) add('blank', '多余空行', 'double-newline');

  const needRetry = issues.some((x) => (cfg.retryCodes || []).includes(x.code));
  return { ok: issues.length === 0, issues, needRetry, chars: s.length };
}

/**
 * 尽量就地修好（安全清理）；清不掉的仍然返回 needRetry。
 * @returns {{text:string, changed:boolean, needRetry:boolean, issues:Array}}
 */
function fix(text, opts = {}) {
  const cfg = loadCfg(opts.cfg);
  let s = String(text || '');
  const before = s;
  const rep = inspect(s, opts);

  s = stripStrayEn(s, cfg);
  if (rep.issues.some((x) => x.code === 'list')) s = flattenList(s);
  s = trimEmoji(s, Number(cfg.emojiMax) || 2);
  s = s.replace(/\n{2,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  // 中英混杂被摘掉后可能留下"收到  👍 "这种空隙
  s = s.replace(/\s+([，。！？~～、；：])/g, '$1').replace(/[，、]\s*([。！？~～])/g, '$1');

  // 助手口气/翻译腔/提记忆：清不干净，交给上层重写
  const after = inspect(s, opts);
  return { text: s, changed: s !== before, needRetry: after.needRetry, issues: rep.issues, after };
}

/** 重写时给 brain 的追加要求 */
function retryNote(issues) {
  const codes = new Set((issues || []).map((x) => x.code));
  const bits = [];
  if (codes.has('assistant')) bits.push('别用助手/客服口气，别说自己是 AI 或模型');
  if (codes.has('meta')) bits.push('别说什么"根据我的记忆""我无法感受"');
  if (codes.has('list')) bits.push('别列清单、别分条，就像打字聊天一样说一两句');
  if (codes.has('translate')) bits.push('别用"的话，""对于…来说"这种书面腔，说口语');
  if (codes.has('mixed-en')) bits.push('别夹英文单词');
  if (codes.has('narrate')) bits.push('别解说画面内容，直接给反应');
  return bits.length ? `刚才那句不合格：${bits.join('；')}。重写一句，只输出这一句。` : '';
}

function logBad(entry, cfg) {
  if ((cfg || DEFAULTS).logBad === false) return;
  try {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '..', (cfg || DEFAULTS).badFile || 'logs/say-bad.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
  } catch (e) { /* 日志失败不影响发送 */ }
}

module.exports = { DEFAULTS, loadCfg, inspect, fix, retryNote, stripStrayEn, flattenList, trimEmoji, countEmoji, logBad };
