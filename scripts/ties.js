'use strict';
/**
 * ties.js —— 关系类型层：给「你们现在算什么关系」一个明确答案。
 *
 * 现有的 mind.js 只有四轴数值（warmth/trust/intimacy/tension），bonds.js 只记事件脉冲，
 * 但它们都回答不了三件真事：
 *   1. 关系有「类型」和「唯一性」——恋人同时只能有一个，不能谁表白都答应；
 *   2. 关系会「变冷 → 分手 → 复合」，这是有时间线的过程，不是数值曲线；
 *   3. 不同身份说不同的话——对恋人和对前任，语气、称呼、主动频率都不一样。
 *
 * 设计纪律（都很重要）：
 *   - 恋人只能由**对方明确表达**触发（表白/同意），DSH 绝不自己宣布「我们是恋人了」；
 *   - 全局唯一：`logs/ties/_global.json` 记当前恋人，冲突时**不静默换人**，交回给人处理；
 *   - 分手是过程：先 anger 高 → 冷战(cooling) → 超时或对方明说 → 分手(ex)，中间修复能拉回来；
 *   - 复合要对方明说 + 关系真的回暖，不能靠时间自动复位。
 *
 * 纯本地规则，不调模型。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const store = require('../lib/store.js');
const DIR = path.join(ROOT, 'logs', 'ties');
const CFG_PATH = path.join(ROOT, 'config', 'ties.json');

const TYPES = ['stranger', 'acquaintance', 'friend', 'close', 'lover'];
const LABELS = {
  stranger: '还不熟',
  acquaintance: '认识',
  friend: '朋友',
  close: '很熟',
  lover: '恋人',
  ex: '前任'
};
const RANK = { stranger: 0, acquaintance: 1, friend: 2, close: 3, lover: 4, ex: 4 };

const DEFAULTS = {
  enabled: true,
  // 亲密度 → 普通档位（lover 绝不在这里自动产生）
  tiers: { acquaintance: 0.15, friend: 0.35, close: 0.6 },
  // 恋人门槛：对方表白/答应时，关系得真的到这一步
  loverMinIntimacy: 0.62,
  loverMinTrust: 0.45,
  // 转冷 → 冷战 → 分手
  coolingTension: 0.7,
  coolingHours: 72,
  breakHours: 72,
  repairTension: 0.4,
  // 复合
  reunionMinIntimacy: 0.5,
  reunionMaxTension: 0.4,
  reunionCooldownHours: 24,
  // 记账
  keepHistory: 120,
  maxEvents: 200
};

// ── 意图识别：只认「对方」说的话 ────────────────────────────────────────────
// 表白/确认关系
const RE_PROPOSE = [
  /我们(在一起|交往|试试(吧|看)?|做情侣)(吧|啊|呗|好吗|好不好)?/,
  /做我(的)?(女|男)朋友(吧|好吗)?/,
  /(当我|做我的)(女|男)朋友/,
  /(我)?喜欢你[，,]?\s*(你(呢|怎么说|愿意吗)?)?$/,
  /(咱俩|我们俩)(在一起|处对象|谈恋爱)/
];
// 答应
const RE_ACCEPT = [
  /^(好|行|可以|嗯|愿意|答应你|我同意)[呀啊吧呢。！!~～]*$/,
  /(我)?(也)?(愿意|答应)(和|跟)?你(在一起)?/,
  /(那)?(我们)?(就)?在一起(吧|试试)/
];
// 分手
const RE_BREAK = [/(我们)?分手(吧|了|算了)/, /(还是)?别在一起了/, /(咱俩|我们)算了吧/, /做回朋友吧/];
// 复合
const RE_REUNION = [/(我们)?复合(吧|好不好)?/, /(重新|再)在一起(吧|好不好)?/, /(还能|能不能)(重新)?开始/, /(还)?想和你在一起/];
// 终止词：加了这些就不是在确认关系（避免「我们在一起玩过」这种）
const RE_NOT_ASK = [/玩|吃饭|吃饭吧|上班|上课|作业|复习|考试|打游戏|看电影|逛街/];

function loadCfg() {
  const c = store.readJson(CFG_PATH, {}, { onError: () => { } }) || {};
  const cfg = { ...DEFAULTS, ...c };
  cfg.tiers = { ...DEFAULTS.tiers, ...(c.tiers || {}) };
  return cfg;
}
function configure(over) {
  if (!over || typeof over !== 'object') return options();
  const cur = loadCfg();
  const next = { ...cur, ...over };
  if (over.tiers) next.tiers = { ...cur.tiers, ...over.tiers };
  store.writeJson(CFG_PATH, next);
  return next;
}
let _override = null;
function options() { return { ...loadCfg(), ...(_override || {}) }; }
function __setOptions(o) { _override = o || null; }

function dirOf() { return process.env.QQTIES_DIR || DIR; }
function slugOf(key) { return String(key || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80) || 'unknown'; }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }
function globalFile() { return path.join(dirOf(), '_global.json'); }

function blank(key, uin) {
  const now = Date.now();
  return {
    key: String(key),
    uin: uin != null ? String(uin) : (String(key).split(':').pop() || ''),
    type: 'stranger',
    phase: '',            // '' | 'cooling'
    since: null,          // 当前类型的起始时间（恋人=在一起的时间）
    updatedAt: now,
    createdAt: now,
    coolingSince: null,
    brokenAt: null,       // 最近一次分手时间
    reunions: 0,
    history: [],
    events: [],
    lastAsk: {}           // { proposeAt, acceptAt, breakAt, reunionAt }
  };
}

function load(key, uin) {
  const b = blank(key, uin);
  const raw = store.readJson(fileOf(key), null, { onError: () => { } });
  if (!raw || typeof raw !== 'object') return b;
  return {
    ...b, ...raw,
    type: TYPES.includes(raw.type) || raw.type === 'ex' ? raw.type : 'stranger',
    history: Array.isArray(raw.history) ? raw.history : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    lastAsk: raw.lastAsk && typeof raw.lastAsk === 'object' ? raw.lastAsk : {}
  };
}
function save(t) {
  t.updatedAt = Date.now();
  store.ensureDir(dirOf());
  const ok = store.writeJson(fileOf(t.key), t);
  if (!ok) store.appendText(path.join(ROOT, 'logs', 'ties-error.log'), `${new Date().toISOString()} save-failed ${t.key}\n`);
  return ok;
}

function loadGlobal() {
  const raw = store.readJson(globalFile(), null, { onError: () => { } }) || {};
  return { lover: raw.lover && raw.lover.key ? { key: String(raw.lover.key), uin: String(raw.lover.uin || ''), since: Number(raw.lover.since) || 0 } : null };
}
function saveGlobal(g) {
  store.ensureDir(dirOf());
  return store.writeJson(globalFile(), { lover: g.lover || null, updatedAt: Date.now() });
}

/** 由亲密度/信任推一个普通档位（不含 lover）。 */
function tierFromRel(rel = {}, cfg) {
  const c = (cfg || options()).tiers;
  const it = Number(rel.intimacy) || 0;
  if (it >= c.close) return 'close';
  if (it >= c.friend) return 'friend';
  if (it >= c.acquaintance) return 'acquaintance';
  return 'stranger';
}

/** 认意图（只接受「对方」的文本）。 */
function detect(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const hits = [];
  const push = (kind, list) => {
    for (const re of list) {
      const m = s.match(re);
      if (m) { hits.push({ kind, evidence: String(m[0]).slice(0, 24) }); return; }
    }
  };
  if (!RE_NOT_ASK.some(re => re.test(s))) push('propose', RE_PROPOSE);
  push('accept', RE_ACCEPT);
  push('break', RE_BREAK);
  push('reunion', RE_REUNION);
  return hits;
}

/** 想升级到恋人时，够不够格。 */
function canBeLover(rel = {}, cfg) {
  const o = cfg || options();
  const it = Number(rel.intimacy) || 0;
  const tr = Number(rel.trust) || 0;
  if (it < o.loverMinIntimacy) return { ok: false, why: `还不够近（亲密度 ${it.toFixed(2)} < ${o.loverMinIntimacy}）` };
  if (tr < o.loverMinTrust) return { ok: false, why: `还不太信得过（信任 ${tr.toFixed(2)} < ${o.loverMinTrust}）` };
  return { ok: true, why: '' };
}

function noteFor(key, opts = {}) {
  const o = opts.cfg || options();
  const t = opts.tie || load(key);
  const now = Number(opts.now) || Date.now();
  const relation = String(opts.rel || '');
  if (t.type === 'lover') {
    const days = t.since ? Math.max(1, Math.floor((now - t.since) / 86400e3)) : 0;
    if (t.phase === 'cooling') {
      return `你们现在是恋人（在一起 ${days} 天），但这两天闹得很僵，正冷着——别装没事，也别硬黏，语气软一点。`;
    }
    return `你们现在是恋人（在一起 ${days} 天）。可以更亲一点，但也别腻。`;
  }
  if (t.type === 'ex') {
    const days = t.brokenAt ? Math.floor((now - t.brokenAt) / 86400e3) : 0;
    return `你们已经分手${days ? `（${days} 天前）` : ''}。别当没事，别撒娇，也别纠缠；礼貌但不亲昵。`;
  }
  if (t.type === 'close') return '你们关系挺近的，说话可以随意些。';
  if (t.type === 'friend') return '你们是聊得来的朋友。';
  if (t.type === 'acquaintance') return '你们认识不久，客气一点。';
  return relation || '你们还不熟。';
}

/**
 * 观察一句「对方说的话」，推动关系类型。
 * @returns {{changed:boolean, from:string, to:string, why:string, conflict?:boolean, note:string, events:Array}}
 */
function observe(key, opts = {}) {
  const o = opts.cfg || options();
  const now = Number(opts.now) || Date.now();
  const theirText = String(opts.text || '');
  const rel = opts.rel || {};
  if (o.enabled === false) return { changed: false, from: '', to: '', why: 'disabled', note: '', events: [] };

  const t = load(key, opts.uin);
  const from = t.type;
  const events = [];
  let changed = false;
  let why = '';
  let conflict = false;
  const intents = detect(theirText);
  const kinds = new Set(intents.map(x => x.kind));

  const setType = (to, reason) => {
    if (to === t.type) return;
    t.history.push({ at: now, from: t.type, to, why: reason });
    if (t.history.length > o.keepHistory) t.history = t.history.slice(-o.keepHistory);
    t.type = to;
    t.since = to === 'lover' ? now : (to === 'ex' ? t.since : now);
    changed = true;
    why = reason;
    events.push({ type: 'tie-change', from, to, why: reason, at: now });
  };

  // 1) 分手 / 复合 / 表白 的显式意图优先
  if (kinds.has('break') && (t.type === 'lover' || t.type === 'close')) {
    const g = loadGlobal();
    if (g.lover && g.lover.key === t.key) saveGlobal({ lover: null });
    t.brokenAt = now;
    t.phase = '';
    t.coolingSince = null;
    t.lastAsk.breakAt = now;
    setType('ex', '对方明说「' + (intents.find(i => i.kind === 'break') || {}).evidence + '」');
  } else if (kinds.has('reunion') && t.type === 'ex') {
    const lastAt = Number(t.lastAsk.reunionAt) || 0;
    if (now - lastAt < o.reunionCooldownHours * 3600e3) {
      return { changed: false, from, to: from, why: 'reunion-cooldown', note: '', events };
    }
    const it = Number(rel.intimacy) || 0;
    const te = Number(rel.tension) || 0;
    if (it < o.reunionMinIntimacy || te > o.reunionMaxTension) {
      return {
        changed: false, from, to: from, why: 'reunion-not-ready',
        note: '对方提复合了，但你们现在还没回到那一步（要么还不够近，要么还没消气）——别急着答应，也别一口回绝。',
        events
      };
    }
    const g = loadGlobal();
    if (g.lover && g.lover.key !== t.key) {
      return { changed: false, from, to: from, why: 'lover-taken', conflict: true, note: '', events };
    }
    saveGlobal({ lover: { key: t.key, uin: t.uin, since: now } });
    t.reunions = (Number(t.reunions) || 0) + 1;
    t.brokenAt = null;
    t.lastAsk.reunionAt = now;
    setType('lover', '对方提复合，关系也回来了（第 ' + t.reunions + ' 次）');
  } else if ((kinds.has('propose') || kinds.has('accept')) && t.type !== 'lover') {
    const gate = canBeLover(rel, o);
    if (!gate.ok) {
      t.lastAsk.proposeAt = now;
      // 还不够近：只记事件，不改类型（DSH 不会因为对方一句表白就自封恋人）
      t.events.push({ type: 'tie-ask', kind: kinds.has('accept') ? 'accept' : 'propose', at: now, why: gate.why });
      if (t.events.length > o.maxEvents) t.events = t.events.slice(-o.maxEvents);
      save(t);
      return { changed: false, from, to: from, why: 'not-close-enough', note: '', events, gate };
    }
    const g = loadGlobal();
    if (g.lover && g.lover.key !== t.key) {
      t.events.push({ type: 'tie-conflict', at: now, other: g.lover.key });
      save(t);
      return {
        changed: false, from, to: from, why: 'lover-taken', conflict: true,
        note: '对方在跟你提这件事，可你这边已经有一个恋人了——不能说谎，也不能瞒着，' +
          '就说「这事我得先跟现在的对象说清楚」，然后把话头收住，别当场答应。',
        events
      };
    }
    saveGlobal({ lover: { key: t.key, uin: t.uin, since: now } });
    t.lastAsk.proposeAt = now;
    setType('lover', (kinds.has('accept') ? '答应了对方' : '对方表白，关系也到位了'));
  }

  // 2) 恋人档的「转冷 → 冷战 → 分手」链条
  if (t.type === 'lover') {
    const te = Number(rel.tension) || 0;
    if (t.phase !== 'cooling' && te >= o.coolingTension) {
      t.phase = 'cooling';
      t.coolingSince = now;
      changed = true;
      why = why || `张力 ${te.toFixed(2)} ≥ ${o.coolingTension}，进入冷战`;
      events.push({ type: 'tie-cooling', at: now, tension: te });
    } else if (t.phase === 'cooling') {
      if (te <= o.repairTension) {
        t.phase = '';
        t.coolingSince = null;
        changed = true;
        why = `张力降到 ${te.toFixed(2)}，和好了`;
        events.push({ type: 'tie-repair', at: now, tension: te });
      } else if (now - (Number(t.coolingSince) || now) >= o.breakHours * 3600e3) {
        const coldHours = Math.round((now - (Number(t.coolingSince) || now)) / 3600e3);
        const g = loadGlobal();
        if (g.lover && g.lover.key === t.key) saveGlobal({ lover: null });
        t.phase = '';
        t.coolingSince = null;
        t.brokenAt = now;
        setType('ex', `冷了 ${coldHours} 小时没缓过来，分手`);
      }
    }
  } else if (t.type !== 'lover' && t.type !== 'ex') {
    // 3) 普通档位跟着关系数值走（区间内才不会来回跳）
    const tier = tierFromRel(rel, o);
    if (RANK[tier] > RANK[t.type]) setType(tier, '关系变近（亲密度到位）');
    // 注意：不自动降档（降档只由分手触发），避免一次冷场就打回陌生人
  }

  if (changed || events.length) {
    t.events = (t.events || []).concat(events);
    if (t.events.length > o.maxEvents) t.events = t.events.slice(-o.maxEvents);
    save(t);
  }
  return { changed, from, to: t.type, why, conflict, note: noteFor(key, { tie: t, now, rel: opts.relText }), events };
}

/** 想念调度用：恋人更快想起，前任永不主动。 */
function longingFactor(key, opts = {}) {
  const t = opts.tie || load(key);
  if (t.type === 'ex') return { factor: Infinity, never: true, why: '已分手' };
  if (t.type === 'lover') return { factor: t.phase === 'cooling' ? 2 : 0.6, never: false, why: t.phase === 'cooling' ? '冷战期反而更容易想起，但别黏' : '恋人' };
  return { factor: 1, never: false, why: '' };
}

/** 改资料（昵称/头像）的授权：恋人不用再手填白名单。 */
function authorizedForProfile(key) {
  const t = load(key);
  return t.type === 'lover';
}

/** 语气尺度：交给 style.js 用。 */
function styleHint(key) {
  const t = load(key);
  if (t.type === 'lover') return t.phase === 'cooling' ? 'ex-cooling' : 'lover';
  if (t.type === 'ex') return 'ex';
  return '';
}

function list(opts = {}) {
  const dir = dirOf();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')); } catch (_) { return []; }
  const now = Number(opts.now) || Date.now();
  return files.map(f => {
    const raw = store.readJson(path.join(dir, f), null, { onError: () => { } });
    if (!raw || !raw.key) return null;
    const t = { ...blank(raw.key, raw.uin), ...raw };
    return {
      key: t.key, uin: t.uin, type: t.type, label: LABELS[t.type] || t.type,
      phase: t.phase, since: t.since, days: t.since ? Math.floor((now - t.since) / 86400e3) : 0,
      coolingHours: t.coolingSince ? Math.round((now - t.coolingSince) / 3600e3) : 0,
      brokenDays: t.brokenAt ? Math.floor((now - t.brokenAt) / 86400e3) : 0,
      reunions: t.reunions || 0
    };
  }).filter(Boolean).sort((a, b) => RANK[b.type] - RANK[a.type]);
}

/** 控制台用：全局恋人 + 所有关系。 */
function status(opts = {}) {
  const g = loadGlobal();
  const now = Number(opts.now) || Date.now();
  return {
    lover: g.lover ? { ...g.lover, days: g.lover.since ? Math.floor((now - g.lover.since) / 86400e3) : 0 } : null,
    ties: list({ now }),
    enabled: options().enabled !== false
  };
}

function main() {
  const [cmd, key, ...rest] = process.argv.slice(2);
  if (cmd === 'list' || cmd === 'status') {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === 'show') {
    const t = load(key);
    console.log(JSON.stringify({ ...t, note: noteFor(key), factor: longingFactor(key), label: LABELS[t.type] }, null, 2));
  } else if (cmd === 'sim') {
    const text = rest.join(' ');
    const rel = { intimacy: Number(rest[0]) || 0.7, trust: 0.6, tension: 0.1 };
    const r = observe(key, { text, rel, now: Date.now() });
    console.log(JSON.stringify({ intents: detect(text), result: r }, null, 2));
  } else {
    console.log('用法: node scripts/ties.js <list|status> | show <key> | sim <key> "<对方说的话>"');
  }
}
if (require.main === module) main();

module.exports = {
  DEFAULTS, TYPES, LABELS, RANK, RE_PROPOSE, RE_ACCEPT, RE_BREAK, RE_REUNION,
  loadCfg, configure, options, __setOptions, CFG_PATH, dirOf, slugOf, fileOf, globalFile,
  blank, load, save, loadGlobal, saveGlobal, tierFromRel, detect, canBeLover,
  noteFor, observe, longingFactor, authorizedForProfile, styleHint, list, status
};
