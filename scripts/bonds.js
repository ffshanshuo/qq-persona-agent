'use strict';
/**
 * bonds.js —— 关系事件层：关系不会只靠每轮情感平滑地爬，真实关系是被「事情」推着走的。
 *
 * - 从一来一回的对话里认里程碑：约好见面、帮了忙、闹别扭、道歉、交心、久别重逢……
 * - 每个事件是一次性「脉冲」，加/减关系四轴（warmth/trust/intimacy/tension），
 *   之后按各自半衰期指数衰减（吵架比帮忙衰减得慢）。
 * - mind 的短期情感仍在按 rate 平滑更新；这里提供 effectiveRel() 把「平滑基线 + 未衰减脉冲」合起来，
 *   是 brain 关系描述、longing 想念节奏共同读取的「当前真实关系」。
 * - 纯本地规则，不调模型。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'logs', 'bonds');
const CFG_PATH = path.join(ROOT, 'config', 'bonds.json');

const DEFAULTS = {
  enabled: true,
  maxEvents: 80,
  maxPulses: 40,
  axisCap: 1,
  scale: 1,           // 全局脉冲倍率（0 等于关掉脉冲）
  minChars: 3,
  absenceHours: 72,   // 这么久没说话再出现 = 久别重逢
  absencePulse: { warmth: 0.06, trust: 0.02, intimacy: 0.05, tension: -0.02 },
  absenceDecayHours: 24,
  absenceCooldownHours: 72
};

/**
 * 关系事件表。pulse 为一次性增量，decayHours 是「半衰感」时间常数（越大记得越久），
 * cooldownHours 防同一件事在几轮对话里被反复计数。
 */
const EVENTS = {
  affection: {
    label: '说了亲昵的话',
    pulse: { warmth: 0.12, trust: 0.04, intimacy: 0.18, tension: -0.04 },
    decayHours: 48, cooldownHours: 12,
    rules: [/喜欢你|爱你|想你|抱抱|亲亲|最好了|在乎你|离不开你/]
  },
  plan_meet: {
    label: '约好要见面/一起做点什么',
    pulse: { warmth: 0.10, trust: 0.06, intimacy: 0.14, tension: -0.05 },
    decayHours: 72, cooldownHours: 24,
    rules: [/见面|约好|一起(去|看|吃|逛|玩)|(我们|咱俩?)(去|一起)|来找我|我请你|带你去|到时候见/]
  },
  help: {
    label: '帮了忙 / 被认真道谢',
    pulse: { warmth: 0.08, trust: 0.14, intimacy: 0.05, tension: -0.03 },
    decayHours: 48, cooldownHours: 12,
    rules: [/帮我|帮了(我|你)|多亏(你|我)|幸好有你|谢谢你|谢啦|太感谢/]
  },
  conflict: {
    label: '闹了别扭',
    pulse: { warmth: -0.12, trust: -0.08, intimacy: -0.04, tension: 0.30 },
    decayHours: 96, cooldownHours: 12,
    rules: [/生气了|生气|不理你|讨厌你|烦死|滚|闭嘴|吵架|失望|别理我/],
    guards: [/别生气|不生气|没生气|对不起|抱歉|我错了/]
  },
  repair: {
    label: '道了歉、把话说开',
    pulse: { warmth: 0.06, trust: 0.08, intimacy: 0.02, tension: -0.28 },
    decayHours: 48, cooldownHours: 12,
    rules: [/对不起|抱歉|是我不好|我错了|原谅我|别往心里去|说开了/]
  },
  heart_talk: {
    label: '说了心里话',
    pulse: { warmth: 0.06, trust: 0.12, intimacy: 0.10, tension: -0.03 },
    decayHours: 72, cooldownHours: 24,
    rules: [/睡不着|想跟你说|从来没跟(人|别人)说过|心里话|有点难受|跟你说说/]
  }
};

let cfgCache = null;
let cfgMtime = 0;

function loadCfg(force) {
  try {
    const st = fs.statSync(CFG_PATH);
    if (!force && cfgCache && st.mtimeMs === cfgMtime) return cfgCache;
    cfgCache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) };
    cfgMtime = st.mtimeMs;
  } catch (e) {
    cfgCache = cfgCache || { ...DEFAULTS };
  }
  return cfgCache;
}
function configure(patch) { cfgCache = { ...(cfgCache || loadCfg()), ...(patch || {}) }; return cfgCache; }
function options() { return loadCfg(); }

function dirOf() { return process.env.QQBOND_DIR || DIR; }
function slugOf(key) { return String(key || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80) || 'unknown'; }
function fileOf(key) { return path.join(dirOf(), slugOf(key) + '.json'); }

function blank(key) {
  return { key, createdAt: Date.now(), updatedAt: Date.now(), events: [], pulses: [], lastByType: {} };
}
function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; }
}
function load(key) {
  const raw = readJson(fileOf(key), null);
  const b = blank(key);
  if (!raw) return b;
  return {
    ...b, ...raw,
    events: Array.isArray(raw.events) ? raw.events : [],
    pulses: Array.isArray(raw.pulses) ? raw.pulses : [],
    lastByType: raw.lastByType && typeof raw.lastByType === 'object' ? raw.lastByType : {}
  };
}
function save(c) {
  c.updatedAt = Date.now();
  const f = fileOf(c.key);
  const txt = JSON.stringify(c);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const tmp = f + '.' + process.pid + '.' + i + '.tmp';
    try { fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f); return true; }
    catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (_) { }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + 25 * i); } catch (_) { }
    }
  }
  try { fs.writeFileSync(f, txt); return true; }
  catch (e) {
    try { fs.appendFileSync(path.join(ROOT, 'logs', 'bonds-error.log'), `${new Date().toISOString()} ${String(e && e.message)}\n`); } catch (_) { }
    return false;
  }
}

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 从对话文本里认出里程碑事件（纯规则）。 */
function detect(text, reply) {
  const cfg = loadCfg();
  const src = [text || '', reply || ''].join(' \n ');
  if (String(src).trim().length < cfg.minChars) return [];
  const hits = [];
  for (const [type, def] of Object.entries(EVENTS)) {
    if (!def.rules.some(re => re.test(src))) continue;
    if (def.guards && def.guards.some(re => re.test(src))) continue;
    const m = def.rules.map(re => (src.match(re) || [])[0]).filter(Boolean)[0];
    hits.push({ type, label: def.label, evidence: String(m || '').slice(0, 20) });
  }
  return hits;
}

/** 记一次事件：写入脉冲并记账（同一类型在冷却期内不重复计）。 */
function apply(key, hit, opts = {}) {
  const cfg = loadCfg();
  if (cfg.enabled === false) return null;
  const def = EVENTS[hit.type];
  if (!def) return null;
  const now = Number(opts.now) || Date.now();
  const b = load(key);
  const last = Number(b.lastByType[hit.type]) || 0;
  if (last && now - last < def.cooldownHours * 3600e3) return { skipped: 'cooldown', type: hit.type };
  const scale = Number(opts.scale != null ? opts.scale : cfg.scale);
  if (scale > 0) {
    const pulse = {};
    for (const [k, v] of Object.entries(def.pulse)) pulse[k] = Number((v * scale).toFixed(4));
    b.pulses.push({ type: hit.type, t0: now, decayHours: def.decayHours, amount: pulse, label: def.label });
    if (b.pulses.length > cfg.maxPulses) b.pulses = b.pulses.slice(-cfg.maxPulses);
  }
  b.events.push({ type: hit.type, label: def.label, t: now, evidence: hit.evidence || '' });
  if (b.events.length > cfg.maxEvents) b.events = b.events.slice(-cfg.maxEvents);
  b.lastByType[hit.type] = now;
  save(b);
  return { applied: hit.type, label: def.label, pulse: def.pulse, decayHours: def.decayHours };
}

/** 观察一来一回：认事件、再按「多久没说话」补一个久别重逢。 */
function observe(key, info = {}) {
  const cfg = loadCfg();
  if (cfg.enabled === false) return { applied: [], skipped: 'disabled' };
  const now = Number(info.now) || Date.now();
  const applied = [];
  for (const hit of detect(info.text, info.reply)) {
    const r = apply(key, hit, { now, scale: info.scale });
    if (r && r.applied) applied.push(r);
    else if (r && r.skipped) applied.push({ type: hit.type, skipped: r.skipped });
  }
  const gapH = Number(info.gapHours) || 0;
  if (gapH >= cfg.absenceHours) {
    const r = apply(key, { type: '__absence' }, { now, scale: cfg.scale });
    // __absence 没有事件表定义，单独处理
    if (r === null) {
      const b = load(key);
      const last = Number(b.lastByType.absence) || 0;
      if (!last || now - last >= cfg.absenceCooldownHours * 3600e3) {
        const amount = {};
        for (const [k, v] of Object.entries(cfg.absencePulse)) amount[k] = Number((v * (Number(info.scale) || 1)).toFixed(4));
        b.pulses.push({ type: 'absence', t0: now, decayHours: cfg.absenceDecayHours, amount, label: '久别重逢' });
        if (b.pulses.length > cfg.maxPulses) b.pulses = b.pulses.slice(-cfg.maxPulses);
        b.events.push({ type: 'absence', label: '久别重逢', t: now, evidence: gapH.toFixed(0) + 'h 没说话' });
        if (b.events.length > cfg.maxEvents) b.events = b.events.slice(-cfg.maxEvents);
        b.lastByType.absence = now;
        save(b);
        applied.push({ applied: 'absence', label: '久别重逢', gapHours: gapH });
      }
    }
  }
  return { applied };
}

/** 当前仍在生效的脉冲总量（各自指数衰减后相加）。 */
function boost(key, now) {
  const cfg = loadCfg();
  if (cfg.enabled === false) return { warmth: 0, trust: 0, intimacy: 0, tension: 0 };
  const t = Number(now) || Date.now();
  const b = load(key);
  const out = { warmth: 0, trust: 0, intimacy: 0, tension: 0 };
  for (const p of b.pulses) {
    const ageH = Math.max(0, (t - Number(p.t0 || 0)) / 3600e3);
    const decay = Math.exp(-ageH / Math.max(1, Number(p.decayHours) || 48));
    if (decay < 0.02) continue;
    for (const [k, v] of Object.entries(p.amount || {})) {
      if (out[k] == null) continue;
      out[k] += Number(v) * decay;
    }
  }
  for (const k of Object.keys(out)) out[k] = Number(out[k].toFixed(3));
  return out;
}

/** 平滑基线 + 未衰减脉冲 = 此刻的关系。 */
function effectiveRel(key, baseRel, now) {
  const base = baseRel || {};
  const add = boost(key, now);
  const cap = Number(loadCfg().axisCap) || 1;
  const out = {};
  for (const k of ['warmth', 'trust', 'intimacy', 'tension']) {
    out[k] = Number(Math.min(cap, Math.max(0, (Number(base[k]) || 0) + (add[k] || 0))).toFixed(3));
  }
  return out;
}

function list(key, opts = {}) {
  const b = load(key);
  const n = opts.limit || 8;
  return {
    key,
    events: b.events.slice(-n).reverse(),
    boost: boost(key, opts.now),
    count: b.events.length
  };
}

/** 给人看的一句话：这段时间关系发生了什么。 */
function noteOf(key, now) {
  const b = load(key);
  const t = Number(now) || Date.now();
  const recent = b.events.filter(e => t - e.t < 7 * 24 * 3600e3).slice(-3);
  if (!recent.length) return '';
  return recent.map(e => '「' + e.label + '」').join('、');
}

/** CLI：list / sim / detect */
function main() {
  const [cmd, key, ...rest] = process.argv.slice(2);
  if (cmd === 'list') {
    const k = key;
    const r = list(k);
    console.log(JSON.stringify({ key: k, count: r.count, boost: r.boost, events: r.events }, null, 2));
  } else if (cmd === 'sim') {
    const now = Date.now();
    const r = boost(key, now);
    console.log(JSON.stringify({ key, boost: r, note: noteOf(key, now) }, null, 2));
  } else if (cmd === 'detect') {
    console.log(JSON.stringify(detect(key, rest.join(' ')), null, 2));
  } else {
    console.log('用法: node scripts/bonds.js <list|sim|detect> <key 或 文本>');
  }
}
if (require.main === module) main();

module.exports = {
  DEFAULTS, EVENTS, loadCfg, configure, options, CFG_PATH, dirOf, slugOf, fileOf,
  blank, load, save, detect, apply, observe, boost, effectiveRel, list, noteOf,
  AXES: ['warmth', 'trust', 'intimacy', 'tension']
};
