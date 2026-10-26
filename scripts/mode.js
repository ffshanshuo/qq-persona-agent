#!/usr/bin/env node
'use strict';
/**
 * mode.js —— 思维模式（这轮该「怎么想」，而不只是「用什么语气」）
 *
 * 为什么需要这一层：echo.js 管的是「TA 这几句热不热」、style.js 管「话说多重」，
 * 但同样一句「今天好烦」，对方要的是**先被接住**，而「这两个方案怎么选」要的是
 * **可执行的比较**。语气对了、思路错了，一样不像人。
 *
 * 借鉴与取舍（实现时刻意只取能落地、不增加模型调用的部分）：
 *  - 双过程理论（Kahneman System 1 / 2）→ 用「深度预算」近似：闲聊给 180 token，
 *    技术/决策问题给 500，而不是一律同一套长度。
 *  - 沟通适应理论（Communication Accommodation）→ 不模仿用词，只适应「信息密度」：
 *    对方一句短问就一句短答，对方在铺背景就允许展开。
 *  - OCC 评价模型（事件 → 目标 → 情绪）→ 只借「先判断这是情绪事件还是任务事件」这一点，
 *    不建完整评价树（那需要额外模型调用，延迟不划算）。
 *  - Reflexion / Self-Refine → 只保留已有的一轮重写（say.js / tone.js 的重试），
 *    不做多轮自我辩论：一轮已经够救回口吻，多轮只会更慢更像机器。
 *  - Anthropic 式 thinking budget → 映射到 maxTokens，不额外要一次「思考」调用。
 * 被放弃的方案：每条消息都让模型先分类（多 1–3s、多一份额度，收益不抵）；
 *   multi-agent 讨论；把推理链写进回复（用户要的是人话，不是解题过程）。
 *
 * 「反向调节」在这里的落点：每次发完，下一句对方的反应（热/冷，来自 echo.js 的判定）
 * 会回头修改**这个模式下**的深度偏好——长篇被冷处理就少展开，短答被追问就多给信息。
 * 调的是「这一层选多深」，不是「模型是谁」。
 */

const path = require('path');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.QQMODE_DIR || path.join(ROOT, 'logs', 'mode');
const CFG_PATH = process.env.QQMODE_CONFIG || path.join(ROOT, 'config', 'mode.json');

const DEFAULTS = {
  enabled: true,
  deepTokens: 500,
  adviceTokens: 360,
  comfortTokens: 300,
  normalTokens: 300,
  quickTokens: 180,
  banterTokens: 200,
  deepChars: 160,
  normalChars: 90,
  quickChars: 40,
  biasStep: 0.15,
  biasCap: 1.5,
  biasSwitchAt: 1.0,
  shortLen: 4,
  keepModes: 40,
  learnFromReaction: true,
  lateNightComfort: true
};

// 判断顺序即优先级：越靠前越不能被后面的词抢走
// 「分手/住院」这类严肃话题必须先于「哈哈」判定，否则一句「哈哈我妈住院了」会被当成玩笑
const SERIOUS = /分手|离婚|去世|人走了|(?:他|她|爷爷|奶奶|外婆|外公|姥姥|姥爷)走了|住院|手术|确诊|癌症|抑郁|自杀|绝症|丧事|葬礼|车祸|进医院/;
const VENT = /烦|累死|难受|不开心|郁闷|委屈|压力|想哭|心累|焦虑|失眠|睡不着|加班|被骂|被说|崩溃|倒霉|好丧|好难|撑不住|顶不住|烦死/;
const ADVICE = /帮我|帮忙|能不能|可以吗|建议|求推荐|推荐个|推荐一下|有什么推荐|怎么办|咋办|求推荐|拜托|你帮我|给点意见|怎么处理|要不要|该不该|值不值/;
const DEEP = /为什么|为何|如何|怎么实现|怎么做到|原理|区别|优缺点|算法|架构|方案|怎么选|思路|逻辑|分析/;
const BANTER = /哈哈|嘿嘿|嘻嘻|笑死|笑不活|666|草|🌿|乐死|绷不住/;
const GREET = /^(在吗|在不在|在嘛|在么|早|早啊|早上好|中午好|晚安|你好|您好|在干嘛|干嘛呢|嗨|hi|hello|哈喽)[。！？!?~～\s]*$/i;
const QUESTION = /[?？]|吗$|呢$|么$/;

function loadCfg(force) {
  let j = {};
  try {
    j = JSON.parse(require('fs').readFileSync(CFG_PATH, 'utf8'));
  } catch (e) { j = {}; }
  return { ...DEFAULTS, ...(j || {}) };
}

function dirOf() { return DIR; }
function slugOf(key) { return String(key || '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'unknown'; }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }

function blank(key) { return { key: String(key || ''), byMode: {}, bias: 0, turns: 0, updatedAt: 0 }; }

function load(key) {
  const b = blank(key);
  const j = store.readJson(fileOf(key), null);
  if (!j || typeof j !== 'object') return b;
  return { ...b, ...j, byMode: j.byMode && typeof j.byMode === 'object' ? j.byMode : {} };
}

function save(st) {
  st.updatedAt = Date.now();
  return store.writeJson(fileOf(st.key), st);
}

/** 判断这轮属于哪种「想」的方式。纯规则，0 token、0 网络。 */
function classify(input = {}, cfg = DEFAULTS) {
  const text = String(input.text || '').trim();
  const len = text.length;
  const why = [];
  let id = 'normal';

  if (SERIOUS.test(text)) { id = 'serious'; why.push('严肃话题'); }
  else if (VENT.test(text)) { id = 'comfort'; why.push('在倒苦水'); }
  else if (ADVICE.test(text)) { id = 'advice'; why.push('在求助/要建议'); }
  else if (DEEP.test(text)) { id = 'deep'; why.push('在问原理/要比较'); }
  else if (BANTER.test(text)) { id = 'banter'; why.push('在开玩笑'); }
  else if (GREET.test(text)) { id = 'quick'; why.push('只是打招呼'); }
  else if (len <= (Number(cfg.shortLen) || 4)) { id = 'quick'; why.push('话很短'); }

  // 深夜（0–6 点）：非任务类话题压一档深度，别在这种时候给人讲课
  const hour = input.now instanceof Date ? input.now.getHours() : new Date(Number(input.now) || Date.now()).getHours();
  const lateNight = hour >= 0 && hour < 6;
  if (lateNight && (id === 'normal' || id === 'deep') && cfg.lateNightComfort !== false) {
    why.push('凌晨了');
    if (id === 'deep') { id = 'normal'; }
  }

  // 对方刚在倒苦水 / 情绪低时，即使是问句也先接情绪
  const echoIntent = input.echo && input.echo.intent;
  if (echoIntent === 'vent' && id !== 'serious') { id = 'comfort'; why.push('上一句在诉苦'); }
  const pad = input.pad || null;
  if (pad && Number(pad.p) <= -0.35 && (id === 'normal' || id === 'advice') && id !== 'serious') {
    id = 'comfort'; why.push('情绪偏低');
  }

  // 关系还没熟到能开玩笑时，banter 降成 normal
  const rel = input.rel || {};
  if (id === 'banter' && rel && typeof rel.intimacy === 'number' && rel.intimacy < 0.3) { id = 'normal'; why.push('还不熟，别太贫'); }

  return { id, why, lateNight, question: QUESTION.test(text) && text.length > (Number(cfg.shortLen) || 4) };
}

function tokensOf(mode, cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  switch (mode) {
    case 'deep': return Number(c.deepTokens) || 500;
    case 'advice': return Number(c.adviceTokens) || 360;
    case 'comfort': return Number(c.comfortTokens) || 300;
    case 'serious': return Number(c.comfortTokens) || 300;
    case 'banter': return Number(c.banterTokens) || 200;
    case 'quick': return Number(c.quickTokens) || 180;
    default: return Number(c.normalTokens) || 300;
  }
}

function charsOf(mode, cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  if (mode === 'deep' || mode === 'advice') return Number(c.deepChars) || 160;
  if (mode === 'quick' || mode === 'banter') return Number(c.quickChars) || 40;
  return Number(c.normalChars) || 90;
}

/** 每个模式给模型的一句「怎么想」，全部是行为指令，不出现模式名。 */
const DIRECTIVES = {
  serious: '这轮别开玩笑、别轻描淡写，先确认对方现在怎么样，再问一句需不需要你做什么；宁可短，别乱出主意。',
  comfort: '对方在跟你倒苦水。先接住情绪（一句「听着就累」比什么都强），别急着分析原因、别列建议、别讲道理，也别把话头转到自己身上；可以问一句具体发生了什么。',
  advice: '对方在求助。先给一个明确倾向（别模棱两可），再给两三个能落地的选项和各自的代价；缺关键信息就先问一句最要紧的，别一次问一堆。',
  deep: '对方在问原理/要比较。先给结论，再展开两三点理由；可以有结构，但别说成提纲或分条清单，用说话的方式讲清楚。',
  banter: '这轮是玩笑，顺着走就行：可以自嘲、可以接梗，别解释笑点、别突然正经，一两句收。',
  quick: '一句话就够：回得轻松自然，可以反问他一句，别铺陈、别总结、别发长篇。',
  normal: '正常聊天：接住对方的话，别硬拽话题、别总结陈词，长度跟对方的话差不多。'
};

function directiveOf(mode) { return DIRECTIVES[mode] || DIRECTIVES.normal; }

/**
 * 结合这个人在这个模式上学到的偏好，给出最终的「深度预算」与是否有必要换档。
 * bias > 0 表示「对方吃这一套，可以更深」；< 0 表示「这个模式之前被冷处理过，收一点」。
 */
function budgetOf(mode, st, cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const perMode = (st && st.byMode && st.byMode[mode]) || {};
  const bias = Math.max(-(Number(c.biasCap) || 1.5), Math.min(Number(c.biasCap) || 1.5, Number(perMode.bias) || 0));
  let base = tokensOf(mode, c);
  let chars = charsOf(mode, c);
  let finalMode = mode;

  if (bias <= -(Number(c.biasSwitchAt) || 1)) {
    // 对方对这个模式的长回答持续冷淡 → 降一档
    if (mode === 'deep' || mode === 'advice') { finalMode = 'normal'; }
    else if (mode === 'normal') { finalMode = 'quick'; }
    base = tokensOf(finalMode, c);
    chars = charsOf(finalMode, c);
  } else if (bias >= (Number(c.biasSwitchAt) || 1)) {
    if (mode === 'normal') { finalMode = 'deep'; base = tokensOf('deep', c); chars = charsOf('deep', c); }
  }

  const scale = 1 + Math.max(-0.4, Math.min(0.4, bias * 0.25));
  return {
    mode: finalMode,
    requested: mode,
    bias,
    maxTokens: Math.max(120, Math.round(base * scale)),
    maxChars: Math.max(24, Math.round(chars * scale))
  };
}

/** 学：对方的反应回头修正「这个模式」的深度偏好。reaction 取 echo 的 kind。 */
function learn(key, info = {}, cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  if (c.learnFromReaction === false) return { ok: false, why: 'disabled' };
  const mode = String(info.mode || '');
  const kind = String(info.kind || 'neutral');
  if (!mode || kind === 'neutral') return { ok: false, why: 'neutral-or-no-mode' };

  const st = load(key);
  const slot = st.byMode[mode] || { n: 0, good: 0, bad: 0, bias: 0 };
  slot.n = (Number(slot.n) || 0) + 1;
  const step = Number(c.biasStep) || 0.15;
  if (kind === 'warm') { slot.good = (Number(slot.good) || 0) + 1; slot.bias = (Number(slot.bias) || 0) + step; }
  else if (kind === 'cold') { slot.bad = (Number(slot.bad) || 0) + 1; slot.bias = (Number(slot.bias) || 0) - step; }

  const cap = Number(c.biasCap) || 1.5;
  slot.bias = Math.max(-cap, Math.min(cap, Number(slot.bias) || 0));
  st.byMode[mode] = slot;
  st.turns = (Number(st.turns) || 0) + 1;

  // byMode 只留最近 keepModes 个模式
  const keys = Object.keys(st.byMode);
  if (keys.length > (Number(c.keepModes) || 40)) {
    keys.slice(0, keys.length - (Number(c.keepModes) || 40)).forEach(k => { delete st.byMode[k]; });
  }
  save(st);
  return { ok: true, mode, kind, bias: slot.bias, n: slot.n, good: slot.good, bad: slot.bad };
}

/** 一次调用的入口：分类 + 查偏好 + 出预算 + 出「怎么想」的提示。 */
function noteFor(key, input = {}, cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return { enabled: false, mode: 'normal', budget: { mode: 'normal', maxTokens: tokensOf('normal', c), maxChars: charsOf('normal', c) }, note: '', why: ['disabled'] };
  const cls = classify(input, c);
  const st = load(key);
  const budget = budgetOf(cls.id, st, c);
  return {
    enabled: true,
    mode: budget.mode,
    requested: cls.id,
    why: cls.why,
    lateNight: cls.lateNight,
    question: cls.question,
    bias: budget.bias,
    budget: { maxTokens: budget.maxTokens, maxChars: budget.maxChars },
    note: directiveOf(budget.mode)
  };
}

function list() {
  const fs = require('fs');
  let files = [];
  try { files = fs.readdirSync(dirOf()).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  return files.map(f => {
    const j = store.readJson(path.join(dirOf(), f), null) || {};
    return { key: j.key || f.replace(/\.json$/, ''), turns: j.turns || 0, byMode: j.byMode || {}, updatedAt: j.updatedAt || 0 };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

function reset(key) {
  try { require('fs').unlinkSync(fileOf(key)); return true; } catch (e) { return false; }
}

module.exports = {
  DEFAULTS, CFG_PATH, loadCfg, dirOf, fileOf, slugOf, blank, load, save,
  classify, directiveOf, budgetOf, learn, noteFor, list, reset, tokensOf, charsOf,
  DIRECTIVES, SERIOUS, VENT, ADVICE, DEEP, BANTER, GREET
};

// ---- CLI ----
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'list') { console.log(JSON.stringify(list(), null, 2)); process.exit(0); }
  if (cmd === 'sim') {
    const text = rest.join(' ') || '今天好烦啊';
    const cls = classify({ text });
    const st = load('__sim__');
    const b = budgetOf(cls.id, st);
    console.log(JSON.stringify({ text, classify: cls, budget: b, note: directiveOf(b.mode) }, null, 2));
    process.exit(0);
  }
  if (cmd === 'why') {
    const key = rest[0];
    const text = rest.slice(1).join(' ') || '在吗';
    console.log(JSON.stringify(noteFor(key, { text }), null, 2));
    process.exit(0);
  }
  if (cmd === 'reset') { console.log(reset(rest[0]) ? '已清空 ' + rest[0] : '没有这个文件'); process.exit(0); }
  console.log('用法: node scripts/mode.js <list|sim "<话>"|why <key> "<话>"|reset <key>>');
}
