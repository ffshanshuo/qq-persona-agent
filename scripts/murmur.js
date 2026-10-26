'use strict';
/**
 * 碎话层（murmur.js）：偶尔回一句「没信息量」的话。
 *
 * 为什么要这一层：真人聊天不是每条都有信息。别人只发「嗯」「哦」「？」「哈哈」时，
 * 真人往往也就「嗯嗯」「啊？」「好～」地接一下——这种回应**不该**花一次模型调用
 * （贵、慢，而且模型容易一本正经地展开），所以单独做一个纯规则层，
 * 在对的时机直接发一句短的，把「有信息量的回复」留给真正需要的消息。
 *
 * 纪律：只在「对方这句话本身没有信息量」时才可能触发；一句话里带内容就绝不用这层。
 */

const path = require('path');
const fs = require('fs');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'logs', 'murmur');

const DEFAULTS = {
  enabled: true,
  probability: 0.45,     // 命中碎话条件后，多大比例真的只回一句短的
  minGapMin: 20,         // 同一个人两次碎话至少隔多久（研究：碎话越多，对方越觉得没聊好）
  perHour: 2,            // 每人每小时最多几次
  perDay: 12,            // 每人每天最多几次（碎话只占发言 15-25%）
  keepKeys: 200,
  maxChars: 6,           // 单条碎话最多 6 个字
  neverTwice: true,      // 连着两条不许都是碎话：上一条是碎话就换实质内容
};

/** 无信息量的短句（去掉标点与 emoji 后判断） */
const FILLER = /^(嗯+|恩+|哦+|喔+|噢+|啊+|诶+|欸+|呃+|额+|哈+|呵+|嘿+|嘻+|好+|好呀|好滴|好的|行+|行吧|可以|收到|ok|OK|okay|是|是啊|对|对啊|不是|没事|没事儿|没什么|在|在的|在呢|你猜|啥|1|11|\d{1,2})$/;

/** 单标点（「？」「…」「。。。」）也算「等你说」 */
const PUNCT_ONLY = /^[?？!！.。~～…\s]{1,4}$/;

/** 对方这句话的「意图」→ 我该接哪一种碎话 */
const KINDS = {
  doubt: ['啊？', '欸？', '嗯？怎么了', '怎么啦'],
  agree: ['嗯嗯', '好～', '行', '好呀', '收到～', '嗯呢'],
  sigh: ['哦哦', '嗯嗯', '唉', '好吧'],
  sighSingle: ['嗯嗯', '哦哦', '嗯？'],
  laugh: ['哈哈哈', '嘿', '嘿嘿', '笑死'],
  poke: ['在呢', '嗯？我在', '干嘛呀', '怎么啦'],
  neutral: ['嗯嗯', '嗯', '哦哦', '诶']
};

function cfgNow(over) { return { ...DEFAULTS, ...(over || {}) }; }
function dirOf() { return process.env.QQMURMUR_DIR || DIR; }
function slugOf(key) { return String(key || 'x').replace(/[^A-Za-z0-9_.-]+/g, '_'); }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }
function blank(key) { return { key, sent: [], lastReply: '', lastKind: '', lastAt: 0, updatedAt: 0 }; }
function load(key) { return store.readJson(fileOf(key), blank(key)); }
function save(key, st) { st.updatedAt = Date.now(); return store.writeJson(fileOf(key), st); }

/** 去掉标点/空白/emoji，用于判断「这句话有没有内容」 */
function bare(text) {
  return String(text || '')
    .replace(/\[[^\]]{0,12}\]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[\s，,。.、!！?？~～…；;：:'"“”‘’()（）]/g, '')
    .trim();
}

/** 这句话是不是「没有信息量」（纯附和 / 纯标点 / 很短的应答） */
function isFiller(text) {
  const raw = String(text || '').trim();
  if (!raw) return { filler: false };
  if (PUNCT_ONLY.test(raw)) return { filler: true, kind: 'doubt', why: '只有一个标点，像是在等你说' };
  const b = bare(raw);
  if (!b) return { filler: true, kind: 'neutral', why: '只有表情/符号' };
  if (b.length > 4) return { filler: false };
  if (!FILLER.test(b)) return { filler: false };
  if (/^[?？]*$/.test(b)) return { filler: true, kind: 'doubt', why: '纯标点' };
  if (/^(哈|呵|嘿|嘻)+$/.test(b)) return { filler: true, kind: 'laugh', why: '在笑' };
  if (/^(好|行|可以|收到|ok|OK|okay|是|是啊|对|对啊)$/.test(b)) return { filler: true, kind: 'agree', why: '在应你' };
  if (/^(嗯|恩|哦|喔|噢|呃|额)+$/.test(b)) {
    // 「哦」单用容易被读成敷衍/不满（调研结论），统一走「哦哦/嗯嗯」
    return { filler: true, kind: b.length > 1 ? 'sigh' : 'sighSingle', why: '在附和' };
  }
  if (/^(在|在的|在呢|干嘛|你猜|啥)$/.test(b)) return { filler: true, kind: 'poke', why: '在问你' };
  if (/^(啊|诶|欸)+$/.test(b)) return { filler: true, kind: 'doubt', why: '在疑惑' };
  return { filler: true, kind: 'neutral', why: '很短的应答' };
}

function pick(list, notThis, random) {
  const pool = (list || []).filter(x => x !== notThis);
  const arr = pool.length ? pool : (list || ['嗯']);
  const r = typeof random === 'function' ? random() : Math.random();
  return arr[Math.floor(r * arr.length) % arr.length];
}

/**
 * 要不要用「碎话」直接回一句（跳过模型）。
 * @param {{text:string,key:string,now?:number,random?:Function,cfg?:object,isGroup?:boolean}} s
 * @returns {{ok:boolean, reply?:string, kind?:string, why:string}}
 */
function decide(s) {
  const o = s || {};
  const cfg = cfgNow(o.cfg);
  if (cfg.enabled === false) return { ok: false, why: 'disabled' };
  const hit = isFiller(o.text);
  if (!hit.filler) return { ok: false, why: 'has-content' };
  const now = Number(o.now) || Date.now();
  const key = String(o.key || '');
  const st = load(key);
  const sent = Array.isArray(st.sent) ? st.sent : [];
  const recent = sent.filter(t => now - t < 3600e3);
  if (recent.length >= Number(cfg.perHour || 2)) return { ok: false, why: 'hour-cap', kind: hit.kind };
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const today = sent.filter(t => t >= dayStart.getTime());
  if (today.length >= Number(cfg.perDay || 12)) return { ok: false, why: 'day-cap', kind: hit.kind };
  const last = sent.length ? Math.max.apply(null, sent) : 0;
  if (last && now - last < Number(cfg.minGapMin || 6) * 60000) return { ok: false, why: 'too-soon', kind: hit.kind };
  // 连着两条都是碎话会把对话聊死：上一条我发的是碎话、这中间我又没说过实质内容 → 这条必须回实质
  if (cfg.neverTwice !== false && st.lastKind === 'murmur') return { ok: false, why: 'no-twice', kind: hit.kind };
  const r = typeof o.random === 'function' ? o.random() : Math.random();
  if (r > Number(cfg.probability == null ? 0.5 : cfg.probability)) return { ok: false, why: 'dice', kind: hit.kind };
  let reply = pick(KINDS[hit.kind] || KINDS.neutral, st.lastReply, o.random);
  reply = String(reply).slice(0, Number(cfg.maxChars) || 12);
  return { ok: true, reply, kind: hit.kind, why: hit.why };
}

/** 记一笔（真发成功后才调用，dry 不记账） */
function note(key, reply, now) {
  const st = load(key);
  st.sent = (Array.isArray(st.sent) ? st.sent : []).concat([Number(now) || Date.now()]).slice(-50);
  st.lastReply = String(reply || '');
  st.lastKind = 'murmur';
  // 注：实质回复由 auto-reply 调 markSubstantive() 清掉 lastKind
  st.lastAt = Number(now) || Date.now();
  save(key, st);
  return st;
}

function list(now) {
  const dir = dirOf();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  return files.map(f => {
    const st = store.readJson(path.join(dir, f), null);
    if (!st) return null;
    const sent = Array.isArray(st.sent) ? st.sent : [];
    return { key: st.key, count: sent.length, lastAt: sent.length ? Math.max.apply(null, sent) : 0, lastReply: st.lastReply || '' };
  }).filter(Boolean);
}

/** 发过一条实质回复：允许下一次再来碎话（连两条的闸门要清掉） */
function markSubstantive(key, now) {
  const st = load(key);
  st.lastKind = '';
  st.lastAt = Number(now) || Date.now();
  save(key, st);
  return st;
}

module.exports = { DEFAULTS, FILLER, KINDS, cfgNow, dirOf, fileOf, blank, load, save, bare, isFiller, decide, note, markSubstantive, list, pick };

if (require.main === module) {
  const arg = process.argv[2] || 'demo';
  if (arg === 'demo') {
    const cases = ['嗯', '嗯嗯', '哦', '？', '哈哈', '好的', '在吗', '今天好累啊', '我到家了', '好的明天见'];
    for (const c of cases) console.log(JSON.stringify({ text: c, ...isFiller(c) }));
  } else if (arg === 'list') console.log(JSON.stringify(list(), null, 2));
}
