'use strict';
/**
 * promises.js —— 记住「我说过要做的」，到点上主动提一句。
 *
 * 为什么要有它：真人聊天最像人的一点不是回得快，而是**说话算数**。
 * 「考完陪你去海边」「回头把笔记发你」这种承诺，人会在几天后自己翻出来兑现；
 * 机器人通常说完就忘了。这一层把承诺从对话里捞出来落盘，等对方再开口时
 * 提醒大脑一句「你之前答应过…」，并且限制提醒次数，免得变成复读机。
 *
 * 数据：logs/promises/<slug>.json（QQPROMISE_DIR 可覆盖，测试用）
 * 结构：{ key, peer, updatedAt, items: [{id,text,kind,keywords,due,status,createdAt,remindedAt,reminders,doneAt}] }
 *
 * 纯本地规则，不调模型（省额度、可测试）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = process.env.QQPROMISE_DIR || path.join(ROOT, 'logs', 'promises');

const DEFAULTS = {
  enabled: true,
  maxItems: 30,           // 每人最多留多少条
  staleDays: 30,          // 超过这么久没兑现也没提过，就当忘了（dropped）
  remindCooldownHours: 6, // 同一条承诺两次提醒之间至少隔多久
  maxReminders: 2,        // 最多提醒几次（提过两次还没动静就别再说）
  maxPerTurn: 1           // 一次回复最多提几条
};

let cfg = { ...DEFAULTS };
function configure(o = {}) { cfg = { ...cfg, ...o }; return cfg; }
function options() { return { ...cfg }; }

// ── 磁盘 ────────────────────────────────────────────────────────────────
function slugOf(key) { return String(key || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120); }
function dirOf() { return process.env.QQPROMISE_DIR || DIR; }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }

function blank(key) { return { key, peer: {}, updatedAt: Date.now(), items: [] }; }

function load(key) {
  const file = fileOf(key);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return blank(key); // 还没有这个文件，正常
  }
  try {
    const c = JSON.parse(raw);
    if (!c || !Array.isArray(c.items)) throw new Error('bad-shape');
    return c;
  } catch (e) {
    // 宁可留个 .bad-* 备份，也别把历史承诺悄悄清零
    try { fs.renameSync(file, file + '.bad-' + Date.now()); } catch (e2) { }
    try {
      fs.appendFileSync(path.join(ROOT, 'logs', 'promises-error.log'),
        new Date().toISOString() + ' corrupt ' + file + ' ' + e.message + '\n');
    } catch (e2) { }
    return blank(key);
  }
}

/** 落盘：E:\ 上 rename 偶发 EIO，保留重试 + 直写兜底（与 context.js 同款策略）。 */
function save(key, data) {
  const file = fileOf(key);
  const body = JSON.stringify({ ...data, key, updatedAt: Date.now() }, null, 2);
  try { fs.mkdirSync(dirOf(), { recursive: true }); } catch (e) { /* 已存在 */ }
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { } };
  for (let i = 0; i < 4; i++) {
    const tmp = `${file}.${process.pid}.${i}.tmp`;
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
      sleep(15 + 25 * i);
    }
  }
  try {
    fs.writeFileSync(file, body);
    return true;
  } catch (e) {
    try { fs.appendFileSync(path.join(ROOT, 'logs', 'promises-error.log'), `${new Date().toISOString()} ${file} ${e.message}\n`); } catch (e2) { }
    return false;
  }
}

// ── 文本工具 ────────────────────────────────────────────────────────────
const STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是', '然后', '现在', '时候',
  '一个', '一下', '有点', '觉得', '真的', '已经', '还是', '因为', '所以', '但是', '不过', '如果',
  '知道', '看到', '听到', '今天', '昨天', '明天', '后天', '周末', '最近', '一起', '不会', '不用',
  '哈哈', '嘿嘿', '好的', '行的', '对吧', '是吧', '我啊', '你啊', '他的', '她的'
]);

/** 承诺线索：我说的话里带「将来要给 TA 做点什么」的意思。 */
const PROMISE_CUES = /(我|咱)(会|要|来|去|陪|帮|给|带|请|教|等|找|发|告诉|回头|晚点|下次|到时候)|答应|说好了|一言为定|包在我身上|记着|回头(把|给|发|帮|告诉)|晚点(给|发|帮|告诉)|下次(给|发|带|陪)/;
/** 约定线索：双方约在某事之后/某时。 */
const PLAN_CUES = /(考完|考完试|周末|放假|下周|明天|后天|晚上|等我|到时候|下次|约好|一起)/;
const TIME_WORDS = ['考完试', '考完', '周末', '下周', '明天', '后天', '今晚', '晚上', '放假', '下个月', '月底'];

function keywordOf(text) {
  const s = String(text || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\[\s*(图片|表情包|语音|表情)\s*\]/g, ' ')
    .replace(/[，。！？、,.!?~～…；;：:\s"'「」（）()]+/g, ' ')
    .trim();
  const out = [];
  for (const w of s.split(' ')) {
    if (!w) continue;
    // 中文按 2-4 字切片粗取关键词；英文/数字整词保留
    if (/^[a-zA-Z0-9]{2,}$/.test(w)) { out.push(w.toLowerCase()); continue; }
    for (let len = 4; len >= 2; len--) {
      for (let i = 0; i + len <= w.length && out.length < 40; i++) {
        const t = w.slice(i, i + len);
        if (STOP.has(t)) continue;
        if (/^(.)\1+$/.test(t)) continue;
        out.push(t);
      }
    }
  }
  return [...new Set(out)].slice(0, 12);
}

/**
 * 把「明天/周末/下周」这类词解析成具体时间点（用许下承诺的那一刻做基准）。
 * 解析不出来的（考完试、放假）返回 null —— 宁可不提醒，也别猜错日子。
 */
function resolveDue(word, baseTs) {
  const w = String(word || '');
  const base = new Date(Number(baseTs) || Date.now());
  if (!w) return null;
  const at = (d, h = 10) => { const t = new Date(d); t.setHours(h, 0, 0, 0); return t.getTime(); };
  if (w === '今晚' || w === '晚上') {
    const t = new Date(base);
    if (t.getHours() < 20) { t.setHours(20, 0, 0, 0); return t.getTime(); }
    t.setDate(t.getDate() + 1); t.setHours(20, 0, 0, 0); return t.getTime();
  }
  if (w === '明天') { const t = new Date(base); t.setDate(t.getDate() + 1); return at(t, 9); }
  if (w === '后天') { const t = new Date(base); t.setDate(t.getDate() + 2); return at(t, 9); }
  if (w === '周末') {
    const t = new Date(base);
    const dow = t.getDay(); // 0 周日 6 周六
    const delta = dow === 6 ? 0 : (dow === 0 ? 0 : 6 - dow);
    t.setDate(t.getDate() + delta);
    return at(t, 10);
  }
  if (w === '下周') {
    const t = new Date(base);
    const dow = t.getDay();
    const delta = dow === 1 ? 7 : (8 - dow) % 7 || 7;
    t.setDate(t.getDate() + delta);
    return at(t, 10);
  }
  if (w === '下个月') {
    const t = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    return at(t, 10);
  }
  if (w === '月底') {
    const t = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return at(t, 20);
  }
  return null; // 考完试 / 放假：日子不确定
}

function dueOf(text) {
  const s = String(text || '');
  for (const w of TIME_WORDS) if (s.includes(w)) return w;
  return '';
}

function normText(s) {
  return String(s || '').replace(/\[CQ:[^\]]+\]/g, '').replace(/\s+/g, '').slice(0, 60);
}

function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 两条文本的相似度（bigram Jaccard）：用来判断「这不是新承诺，是同一件事换个说法」。 */
function similar(a, b) {
  const A = bigramsOf(a), B = bigramsOf(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── 抽取 ────────────────────────────────────────────────────────────────
/** 否定/不确定/假设：出现这些就说明不是在许愿。 */
const NEG = /我不会|我不一定|我可能|我也许|我尽量|看情况|说不定|要是|如果|算了|随便|不用|别指望|不一定|不敢保证/;
/** 具体动作词：承诺得有个「做什么」。 */
const ACT = /给|帮|发|带|陪|教|请|找|买|弄|做|送|接|告诉|安排|搞定|准备/;
/** 时间/时机词。 */
const TIME = /明天|后天|今晚|晚上|周末|下周|下个月|月底|放假|考完|回头|晚点|等会|过两天|下次|到时候/;
/** 明确约定措辞：有它就更像承诺。 */
const CUE = /答应|说好了|一言为定|包在我身上|回头(把|给|发|帮|告诉)|晚点(给|发|帮|告诉)|下次(给|发|带|陪)/;

/** 这句话像不像「我许了个愿」。宁缺勿滥：把客套当承诺，比漏掉更糟。 */
function isPromiseLike(s) {
  const t = String(s || '').trim();
  if (t.length < 6) return false;
  if (NEG.test(t)) return false;
  if (/[?？]\s*$/.test(t)) return false;
  if (CUE.test(t)) return true;
  const hasAct = ACT.test(t), hasTime = TIME.test(t);
  const selfAct = /(?:我|咱)[^。！？]{0,12}(?:给|帮|发|带|陪|教|请|找|买|弄|做|送|接|告诉|安排|搞定|准备|会|来|去)/.test(t);
  if (!selfAct) return false;
  // 「我…动作词」还得配上时机，否则「我会做饭」也会被当成承诺
  return hasAct && hasTime;
}
/**
 * 从这一轮里捞承诺。只看「我」说的话（承诺必须是号主自己许的）。
 * 返回新增的条目数组（可能为空）。
 */
function capture(key, info = {}) {
  if (cfg.enabled === false) return [];
  const my = String(info.myText || '').trim();
  if (!my || my.length < 6) return [];
  if (/^\s*\[?(语音|表情)/.test(my)) return [];
  // 太长的话只留最像承诺的那一句；句子必须过 isPromiseLike
  const sentences = my.split(/(?<=[。！？!?~～；;])/).map(s => s.trim()).filter(Boolean);
  const pick = sentences.find(isPromiseLike);
  if (!pick) return [];
  const text = pick.slice(0, 80);
  const kind = (CUE.test(text) || PROMISE_CUES.test(text)) ? 'promise' : 'plan';

  const c = load(key);
  const n = normText(text);
  // 去重：完全同句，或者「同一件事换个说法」（bigram 相似度 ≥ 0.45）
  const dup = c.items.some(it => it.status !== 'dropped' && (
    normText(it.text) === n || similar(it.text, text) >= 0.45
  ));
  if (dup) return [];

  const item = {
    id: rid(),
    text,
    kind,
    keywords: keywordOf(text),
    due: dueOf(text),
    dueAt: (() => { const w = dueOf(text); return w ? resolveDue(w, Date.now()) : null; })(),
    status: 'open',
    createdAt: Date.now(),
    remindedAt: 0,
    reminders: 0,
    doneAt: 0
  };
  c.items.push(item);
  while (c.items.length > cfg.maxItems) {
    // 先丢「已关闭」里最老的，再丢最老的；永远别把刚许下的新承诺丢掉
    let i = c.items.findIndex(it => it.status !== 'open');
    if (i < 0) i = 0;
    c.items.splice(i, 1);
  }
  save(key, c);
  return [item];
}


/** 中文按二元组比相似度：比整词命中稳，'考完' 能对上 '考完试'。 */
const STOP_BIGRAM = new Set(['我们', '你们', '他们', '什么', '这个', '那个', '就是', '可以', '然后', '现在',
  '时候', '一个', '一下', '有点', '觉得', '真的', '已经', '还是', '因为', '所以', '但是', '不过', '如果',
  '知道', '看到', '听到', '今天', '昨天', '明天', '后天', '周末', '最近', '一起', '不会', '不用', '哈哈',
  '嘿嘿', '好的', '行的', '对吧', '是吧', '不是', '没有', '这么', '那么', '我去', '你去', '我在', '你在']);

function bigramsOf(text) {
  const s0 = String(text || '')
    .replace(/[CQ:[^]]+]/g, ' ')
    .replace(/[，。！？、,.!?~～…；;：:s"'「」（）()]+/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= s0.length; i++) set.add(s0.slice(i, i + 2));
  return set;
}

function matchScore(item, incomingText) {
  const A = bigramsOf(item.text), B = bigramsOf(incomingText);
  const hit = [];
  for (const b of B) if (A.has(b) && !STOP_BIGRAM.has(b)) hit.push(b);
  let score = hit.length;
  // 只管时间词不算命中：必须有内容 bigram 重合，due 才加分
  if (hit.length && item.due) {
    const dueB = bigramsOf(item.due);
    const dueHit = String(incomingText || '').includes(item.due) || [...dueB].some(b => B.has(b));
    if (dueHit) score += 2;
  }
  return { score, hit: [...new Set(hit)] };
}

// ── 提醒 ────────────────────────────────────────────────────────────────

/**
 * 对方这句话，勾起了哪条还没兑现的承诺？
 * 返回最多 cfg.maxPerTurn 条（不含冷却中、提醒次数已满、以及太老的）。
 */
function findFor(key, incomingText, opts = {}) {
  if (cfg.enabled === false) return [];
  const now = Number(opts.now) || Date.now();
  const c = load(key);
  const cands = [];
  for (const it of c.items) {
    if (it.status !== 'open') continue;
    if (it.reminders >= cfg.maxReminders) continue;
    if (it.remindedAt && now - it.remindedAt < cfg.remindCooldownHours * 3600e3) continue;
    const m = matchScore(it, incomingText);
    if (m.score < 2) continue; // 至少一个内容重合（带 due 时 3 分）
    cands.push({ it, score: m.score, hit: m.hit });
  }
  cands.sort((a, b) => b.score - a.score || a.it.createdAt - b.it.createdAt);
  return cands.slice(0, Math.max(1, cfg.maxPerTurn || 1)).map(x => ({ ...x.it, _hit: x.hit, _score: x.score }));
}

/**
 * 到期（或快到）的承诺：用于「主动提醒」而不是等对方先提起。
 * 窗口：dueAt 前 earlyHours 小时 ~ 之后 lateHours 小时；冷却与次数沿用 findFor 的规矩。
 */
function dueItems(key, opts = {}) {
  if (cfg.enabled === false) return [];
  const now = Number(opts.now) || Date.now();
  const early = Number(opts.earlyHours ?? 2) * 3600e3;
  const late = Number(opts.lateHours ?? 36) * 3600e3;
  const c = load(key);
  const out = [];
  for (const it of c.items || []) {
    if (it.status !== 'open') continue;
    if (!it.dueAt) continue;
    if (it.reminders >= cfg.maxReminders) continue;
    if (it.remindedAt && now - it.remindedAt < cfg.remindCooldownHours * 3600e3) continue;
    if (now < Number(it.dueAt) - early) continue;
    if (now > Number(it.dueAt) + late) continue;
    const overdueH = Math.round(((now - Number(it.dueAt)) / 3600e3) * 10) / 10;
    out.push({ ...it, overdueHours: overdueH, days: Math.round((Number(it.dueAt) - now) / 864e5) });
  }
  out.sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
  return out;
}

/** 给 brain 的提醒理由（人话，别像催账） */
function dueNote(item, now) {
  if (!item) return '';
  const t = Number(now) || Date.now();
  const due = Number(item.dueAt) || 0;
  const dayDiff = Math.round((due - t) / 864e5);
  const lateH = (t - due) / 3600e3;
  const when = lateH > 3
    ? '时间已经过了（别装没事，提一句、或者道个歉再补上）'
    : (dayDiff <= 0 ? '就是今天' : (dayDiff === 1 ? '就是明天' : `还有 ${dayDiff} 天`));
  return `你之前答应过 TA：「${item.text}」，约定的时候${when}——不是催账，是自然地提起：问问 TA 那边怎么样、要不要现在定具体安排；别提「我记着一条承诺」这种话`;
}

function markReminded(key, ids) {
  const c = load(key);
  const now = Date.now();
  const arr = Array.isArray(ids) ? ids : [ids];
  let n = 0;
  for (const it of c.items) {
    if (arr.includes(it.id)) { it.remindedAt = now; it.reminders = (it.reminders || 0) + 1; n++; }
  }
  if (n) save(key, c);
  return n;
}

/** 兑现/关闭：手动或由调用方判断。 */
function markDone(key, id, how = 'manual') {
  const c = load(key);
  const it = c.items.find(x => x.id === id || normText(x.text).includes(String(id)));
  if (!it) return null;
  it.status = 'done';
  it.doneAt = Date.now();
  it.how = how;
  save(key, c);
  return it;
}

function markDropped(key, id) {
  const c = load(key);
  const it = c.items.find(x => x.id === id);
  if (!it) return null;
  it.status = 'dropped';
  save(key, c);
  return it;
}

/** 清理：太老又没提醒过的当作「说过就忘」，标 dropped（保留痕迹，不删）。 */
function sweepStale(key, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const days = Number(opts.staleDays || cfg.staleDays);
  const c = load(key);
  let n = 0;
  for (const it of c.items) {
    if (it.status !== 'open') continue;
    if (!it.remindedAt && now - it.createdAt > days * 86400e3) { it.status = 'dropped'; it.droppedAt = now; n++; }
    if (it.reminders >= cfg.maxReminders && now - it.remindedAt > days * 86400e3) { it.status = 'dropped'; it.droppedAt = now; n++; }
  }
  if (n) save(key, c);
  return n;
}

/** 给 brain 的一句人话（不要罗列 id/分数）。 */
function noteOf(items) {
  if (!items || !items.length) return '';
  const one = items[0];
  return `你之前答应过 TA：「${one.text}」${one.due ? `（${one.due}）` : ''}——如果这会儿接得上，可以自然地提一句；接不上就别硬提，别提「我记着一条承诺」这种话`;
}

function list(key) {
  const c = load(key);
  return c.items.map(it => ({
    id: it.id, status: it.status, kind: it.kind, text: it.text, due: it.due,
    reminders: it.reminders || 0,
    ageDays: Math.round((Date.now() - it.createdAt) / 86400e3)
  }));
}

module.exports = {
  DEFAULTS, configure, options, DIR,
  slugOf, fileOf, load, save, blank,
  capture, findFor, markReminded, markDone, markDropped, sweepStale, noteOf, list,
  keywordOf, dueOf, resolveDue, dueItems, dueNote, normText, similar, matchScore, isPromiseLike, dirOf
};

// ── 命令行 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const key = argv[1];
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'list') out(list(key));
  else if (cmd === 'add') { out(capture(key, { myText: argv.slice(2).join(' ') })); }
  else if (cmd === 'done') out(markDone(key, argv[2]));
  else if (cmd === 'drop') out(markDropped(key, argv[2]));
  else if (cmd === 'find') out(findFor(key, argv.slice(2).join(' ')));
  else if (cmd === 'sweep') out({ dropped: sweepStale(key) });
  else if (cmd === 'due') out(dueItems(key, { now: argv[2] ? Number(argv[2]) : undefined }));
  else if (cmd === 'demo') {
    process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-demo');
    const k = 'p:10001';
    capture(k, { myText: '考完试我陪你去海边，说好了。' });
    capture(k, { myText: '回头把笔记发你。' });
    console.log('列表：'); out(list(k));
    console.log('对方说「我下周考完了」→'); out(findFor(k, '我下周考完了'));
  } else {
    console.log('用法: node scripts/promises.js <list|add|done|drop|find|sweep|due|demo> [key] [文本]');
  }
}
