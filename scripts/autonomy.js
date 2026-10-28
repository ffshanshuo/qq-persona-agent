'use strict';
/**
 * autonomy.js —— 自主权层（第 1 阶段：反应式自主）
 *
 * 现状：用词完全自主，但「要不要回 / 什么时候回 / 引不引旧话」全由规则定。
 * 这一层把这三件事的决定权交给模型，但**只让它提议**：
 *
 *   模型在回复里写标记  →  policy 审批（红线/预算/关系/上下文）  →  执行或降级
 *
 * 支持的标记（都会从正文里剥掉，绝不让它们发进聊天框）：
 *   [[不回]]    这次先不接（对方只是自言自语/刷屏/纯表情）
 *   [[慢点回]]  我先忙，过几分钟再说（3~15 分钟，policy 钳上限）
 *   [[很快回]]  立刻回（覆盖题库里的随机延迟）
 *   [[引用]]    挑一条接得上的旧消息引用着回
 *
 * 红线（无论模型怎么提议都不放行）：
 *   · 对方在问事/求助/催（`urgentRe`/`requestRe`/问号结尾）→ 不许 [[不回]]
 *   · 群里点名/@ 我 → 不许不回
 *   · 刚恢复联系的第一条（静默 ≥ minGapForSkipHours 小时）→ 不许不回
 *   · 同一人一天最多跳 2 次、两次之间 ≥ skipGapMin、不能连着跳两次
 *   · 全局每天 skip 6 / slow 4 / quote 8（可配）
 *
 * 纪律：`AUTOREPLY_DRY=1` 或 dry 参数一律**不记账**（审计行会带 dry:true），
 * 否则一次演练就把当天的自主额度吃掉。
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store.js');

const ROOT = path.join(__dirname, '..');
const CFG_PATH = process.env.AUTONOMY_CONFIG || path.join(ROOT, 'config', 'autonomy.json');

const PRESETS = {
  // 保守档：现在的默认口径（问事/求助/@我/催/久别第一句不许不回，有额度）
  balanced: {},
  // 最高自由档：只留安全红线（风控闸门仍在 risk.js；涉钱/验证码/隐私红线在 SYSTEM），回不回、什么时候回全交给模型
  max: {
    daily: { skip: 999, slow: 999, quote: 999 },
    perContact: { skipPerDay: 999, skipGapMin: 0, slowPerDay: 999 },
    minGapForSkipHours: 0,
    blockDirect: false,
    blockUrgent: false,
    blockRequest: false,
    blockLongGap: false,
    noDoubleSkip: false
  }
};

const DEFAULTS = {
  enabled: true,
  daily: { skip: 6, slow: 4, quote: 8 },
  perContact: { skipPerDay: 2, skipGapMin: 90, slowPerDay: 2 },
  slowMs: [180000, 900000],          // [[慢点回]] 的 3~15 分钟
  fastMs: [200, 900],                // [[很快回]] 也要像人（不是 0）
  urgentRe: '急|在吗|在不在|电话|马上|现在就|救命|快回|赶紧|几点|什么时候|在哪|怎么样了',
  requestRe: '帮我|帮忙|能不能|可以吗|可不可以|求你|拜托|教我|给我|发我|推荐|怎么办|咋办|要不要|该不该|有没有',
  minGapForSkipHours: 6,
  // 下面四项是「硬拦」。默认全开（balanced）；preset:'max' 会把它们全关掉，交回模型自己判断
  blockDirect: true,
  blockUrgent: true,
  blockRequest: true,
  blockLongGap: true,
  noDoubleSkip: true,
  keepDecisions: 200,
};

let cfgCache = null;
function loadCfg(force) {
  if (cfgCache && !force) return cfgCache;
  const j = store.readJson(CFG_PATH, null, { onError: () => {} });
  const p = (j && j.preset && PRESETS[j.preset]) ? PRESETS[j.preset] : null;
  const c = { ...DEFAULTS, ...(p || {}), ...(j || {}) };
  if (p) {
    c.daily = { ...DEFAULTS.daily, ...((p && p.daily) || {}), ...((j && j.daily) || {}) };
    c.perContact = { ...DEFAULTS.perContact, ...((p && p.perContact) || {}), ...((j && j.perContact) || {}) };
    c.preset = j.preset;
  }
  c.daily = { ...DEFAULTS.daily, ...((j && j.daily) || {}) };
  c.perContact = { ...DEFAULTS.perContact, ...((j && j.perContact) || {}) };
  cfgCache = c;
  return c;
}
function configure(over) { cfgCache = { ...loadCfg(true), ...(over || {}) }; return cfgCache; }
function options() { return loadCfg(); }

function dirOf() { return process.env.QQAUTONOMY_DIR || path.join(ROOT, 'logs', 'autonomy'); }
function stateFile() { return path.join(dirOf(), 'state.json'); }
function logFile() { return process.env.QQAUTONOMY_LOG || path.join(ROOT, 'logs', 'autonomy.jsonl'); }
function dayKey(now) { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function blank(now) {
  return { day: dayKey(now || Date.now()), counters: { skip: 0, slow: 0, quote: 0 },
    plans: [], perKey: {}, decisions: [] };
}
function load(now) {
  const st = store.readJson(stateFile(), null, { onError: () => {} });
  const b = blank(now);
  if (!st || typeof st !== 'object') return b;
  const out = { ...b, ...st };
  out.counters = { ...b.counters, ...(st.counters || {}) };
  out.perKey = st.perKey && typeof st.perKey === 'object' ? st.perKey : {};
  out.decisions = Array.isArray(st.decisions) ? st.decisions : [];
  // 跨天：计数归零（perKey 里的每日量也清）
  if (out.day !== b.day) { out.day = b.day; out.counters = { skip: 0, slow: 0, quote: 0 }; out.perKey = {}; }
  return out;
}
function save(st) {
  try { store.ensureDir(dirOf()); } catch (e) { /* ignore */ }
  return store.writeJson(stateFile(), st);
}
function audit(line) {
  try {
    store.ensureDir(path.dirname(logFile()));
    store.appendJsonl(logFile(), line);
  } catch (e) { /* ignore */ }
}
function note(st, line, keep) {
  st.decisions.push(line);
  const max = Number(keep) || DEFAULTS.keepDecisions;
  while (st.decisions.length > max) st.decisions.shift();
}

/* ---------------- 标记解析 ---------------- */

// 宽容括号：双/单/全角都能认（模型常写单方括号，别再让标记漏到聊天框）
const MK = (name) => new RegExp(`(?:\\[\\[|［［|【|\\[|［)\\s*(?:${name})\\s*(?:\\]\\]|］］|\\】|\\]|］)`, 'i');
const RE_SKIP = MK('不回|先不回|这次不回|不接');
const RE_SLOW = MK('慢点回|晚点回|等会回|稍后回|过会儿回');
const RE_FAST = MK('很快回|马上回|立刻回|现在就回');
const RE_QUOTE = MK('引用|引一下|接那句');
const RE_CANCEL = MK('取消主动|撤销主动|别主动|不用主动|算了别说|不主动了');
// [[主动:45m|想说啥]]：让模型自己约一个「过一会儿我去找 TA」的时间（相对时间）
const RE_PLAN = /(?:\[\[|［［|【|\[|［)\s*(?:主动|稍后|过会|回头)\s*[:：]\s*([0-9]+\s*(?:s|m|h|秒|分钟|分|小时|钟头)?|半(?:个)?小时|一?会儿)\s*(?:[|｜]\s*([^\]】］\n]{1,120}))?\s*(?:\]\]|］］|\】|\]|］)/gi;
const MARK_ANY = new RegExp(`(?:\\[\\[|［［|【|\\[|［)\\s*(?:不回|先不回|这次不回|不接|慢点回|晚点回|等会回|稍后回|过会儿回|很快回|马上回|立刻回|现在就回|引用|引一下|接那句|取消主动|撤销主动|别主动|不用主动|算了别说|不主动了)\\s*(?:\\]\\]|］］|\\】|\\]|］)`, 'gi');

/** 「45m / 2h / 半小时 / 一会儿 / 90s」→ 毫秒（认不出返回 null） */
function parseDelay(word) {
  const s = String(word == null ? '' : word).trim().toLowerCase();
  if (!s) return null;
  if (/^半(?:个)?小时$/.test(s)) return 30 * 60 * 1000;
  if (/^一?会儿$/.test(s)) return 20 * 60 * 1000;
  const m = s.match(/^([0-9]+)\s*(s|m|h|秒|分钟|分|小时|钟头)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || 'm';
  const mul = unit === 's' || unit === '秒' ? 1000
    : unit === 'h' || unit === '小时' || unit === '钟头' ? 3600 * 1000
    : 60 * 1000;
  return n * mul;
}

function parseMarkers(raw) {
  const t = String(raw == null ? '' : raw);
  const out = { skip: RE_SKIP.test(t), slow: RE_SLOW.test(t), fast: RE_FAST.test(t), quote: RE_QUOTE.test(t), cancel: RE_CANCEL.test(t), plan: null };
  RE_PLAN.lastIndex = 0;
  const pm = RE_PLAN.exec(t);
  if (pm) {
    const inMs = parseDelay(pm[1]);
    if (inMs) out.plan = { inMs, text: String(pm[2] || '').trim() };
  }
  out.text = t.replace(MARK_ANY, '').replace(RE_PLAN, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (out.skip) { out.slow = false; out.fast = false; }   // 不回优先，别的没意义
  return out;
}
function stripMarks(text) {
  return String(text == null ? '' : text).replace(MARK_ANY, '').replace(RE_PLAN, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/* ---------------- 自主排期：模型自己约「过一会儿再来说」 ---------------- */

const PLAN_DEFAULTS = { maxPerDay: 6, maxHorizonDays: 7, keepPlans: 40 };

function schedulePlan(key, plan, opts = {}) {
  const cfg = { ...DEFAULTS, ...loadCfg() };
  const now = opts.now || Date.now();
  if (cfg.enabled === false) return { ok: false, why: 'disabled' };
  if (!plan || !Number.isFinite(Number(plan.inMs)) || Number(plan.inMs) <= 0) return { ok: false, why: 'bad-delay' };
  const at = now + Number(plan.inMs);
  const horizon = (Number(cfg.maxHorizonDays) || PLAN_DEFAULTS.maxHorizonDays) * 24 * 3600 * 1000;
  if (at - now > horizon) return { ok: false, why: 'too-far' };
  const st = load(now);
  st.plans = Array.isArray(st.plans) ? st.plans : [];
  const today = st.plans.filter((p) => String(p.createdDay || '') === dayKey(now));
  if (today.length >= (Number(cfg.maxPlansPerDay) || PLAN_DEFAULTS.maxPerDay)) return { ok: false, why: 'daily-cap' };
  const item = {
    id: 'pl_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    key: String(key || ''),
    at,
    text: String((plan.text || '')).slice(0, 120),
    createdAt: now,
    createdDay: dayKey(now),
    status: 'pending'
  };
  st.plans.push(item);
  if (st.plans.length > PLAN_DEFAULTS.keepPlans) st.plans = st.plans.slice(-PLAN_DEFAULTS.keepPlans);
  save(st);
  audit({ t: now, event: 'plan-add', key: item.key, at, inMs: Number(plan.inMs), id: item.id, text: item.text.slice(0, 60) });
  return { ok: true, id: item.id, at };
}

function listPlans(now) {
  const st = load(now || Date.now());
  return Array.isArray(st.plans) ? st.plans.slice(-20) : [];
}

/** 到点的排期（顺手把 24 小时前的未发项标 expired，避免堆积） */
function duePlans(now) {
  const t = now || Date.now();
  const st = load(t);
  const plans = Array.isArray(st.plans) ? st.plans : [];
  const due = [];
  let dirty = false;
  for (const p of plans) {
    if (!p || p.status !== 'pending') continue;
    if (p.at <= t) {
      if (t - p.at > 24 * 3600 * 1000) { p.status = 'expired'; dirty = true; continue; }
      due.push(p);
    }
  }
  if (dirty) save(st);
  return due;
}

/** 撤销某人所有还没发出去的排期（模型收到新消息后自己决定「这话不用说了」） */
function cancelPlans(key, opts = {}) {
  const now = opts.now || Date.now();
  const st = load(now);
  const plans = Array.isArray(st.plans) ? st.plans : [];
  let n = 0;
  for (const p of plans) {
    if (!p || p.status !== 'pending') continue;
    if (String(p.key) !== String(key)) continue;
    p.status = 'cancelled';
    p.cancelledAt = now;
    p.why = String(opts.why || 'model-cancel').slice(0, 80);
    n++;
  }
  if (n) {
    save(st);
    audit({ t: now, event: 'plan-cancel', key: String(key), n, why: opts.why || 'model-cancel' });
  }
  return { ok: true, n };
}

/** 某人还没到点的排期（用来在输入时提醒模型「你还有句话没发」） */
function pendingPlans(key, now) {
  const t = now || Date.now();
  const st = load(t);
  return (Array.isArray(st.plans) ? st.plans : [])
    .filter((p) => p && p.status === 'pending' && String(p.key) === String(key) && p.at > t - 24 * 3600 * 1000);
}

function markPlanSent(id, info = {}) {
  const st = load(info.now || Date.now());
  const p = (st.plans || []).find((x) => x && x.id === id);
  if (!p) return { ok: false, why: 'not-found' };
  p.status = info.ok === false ? 'failed' : 'sent';
  p.sentAt = info.now || Date.now();
  if (info.why) p.why = String(info.why).slice(0, 120);
  save(st);
  audit({ t: p.sentAt, event: 'plan-sent', id, ok: info.ok !== false, why: info.why || '' });
  return { ok: true, status: p.status };
}

/* ---------------- policy ---------------- */

function looksUrgent(d, cfg) {
  const text = String((d && d.text) || '');
  const re = new RegExp(cfg.urgentRe || DEFAULTS.urgentRe);
  return re.test(text) || /[?？]\s*$/.test(text.trim());
}
function looksRequest(d, cfg) {
  const text = String((d && d.text) || '');
  return new RegExp(cfg.requestRe || DEFAULTS.requestRe).test(text);
}
function isDirect(d) {
  return !!(d && (d.atMe || d.follow || (d.target && d.target.type === 'group' && d.mentioned)));
}

/**
 * 该不该让模型这次不回。
 * d: compose() 的返回（含 text/key/target/atMe/idleMin/questions...）
 * 返回 {ok, why}；ok 时会**自动记账**（除非 dry 或 record:false）
 */
function decideSkip(key, d, opts = {}) {
  const cfg = opts.cfg || loadCfg();
  const now = opts.now || Date.now();
  const dry = !!opts.dry;
  const st = load(now);
  if (cfg.enabled === false) return { ok: false, why: 'disabled' };
  if (cfg.blockDirect !== false && isDirect(d)) return { ok: false, why: 'at-or-follow' };
  if (cfg.blockUrgent !== false && looksUrgent(d, cfg)) return { ok: false, why: 'urgent-or-question' };
  if (cfg.blockRequest !== false && looksRequest(d, cfg)) return { ok: false, why: 'direct-request' };
  const gapH = Number(opts.idleMinutes) / 60;
  const gapLimit = Number.isFinite(Number(cfg.minGapForSkipHours)) ? Number(cfg.minGapForSkipHours) : DEFAULTS.minGapForSkipHours;
  if (cfg.blockLongGap !== false && gapLimit > 0 && Number.isFinite(gapH) && gapH >= gapLimit) return { ok: false, why: 'first-after-long-gap' };

  const cap = Number((cfg.daily || {}).skip);
  if (Number.isFinite(cap) && cap >= 0 && st.counters.skip >= cap) return { ok: false, why: 'daily-cap' };

  const pk = st.perKey[key] || {};
  const sk = pk.skip || { n: 0, lastAt: 0 };
  const perDay = Number((cfg.perContact || {}).skipPerDay);
  if (Number.isFinite(perDay) && sk.n >= perDay) return { ok: false, why: 'contact-cap' };
  const gapMin = Number((cfg.perContact || {}).skipGapMin);
  if (Number.isFinite(gapMin) && gapMin > 0 && sk.lastAt && (now - sk.lastAt) < gapMin * 60000) return { ok: false, why: 'contact-gap' };
  // 不能连着跳两次（同一人最近两次决定都是跳）
  const mine = st.decisions.filter((x) => x.key === key).slice(-2);
  if (cfg.noDoubleSkip !== false && mine.length === 2 && mine.every((x) => x.action === 'skip')) return { ok: false, why: 'twice-in-a-row' };

  if (!dry) {
    st.counters.skip += 1;
    pk.skip = { n: sk.n + 1, lastAt: now };
    st.perKey[key] = pk;
    note(st, { t: now, key, action: 'skip', why: opts.reason || 'model-chose' });
    save(st);
  }
  audit({ t: now, event: 'skip', key, dry, reason: opts.reason || 'model-chose', text: String((d && d.text) || '').slice(0, 60) });
  return { ok: true, why: 'ok' };
}

/** 模型要求慢点回：返回毫秒（不记账），不许就返回 null */
function decideSlow(key, opts = {}) {
  const cfg = opts.cfg || loadCfg();
  const now = opts.now || Date.now();
  const dry = !!opts.dry;
  const st = load(now);
  if (cfg.enabled === false) return { ok: false, why: 'disabled', ms: null };
  const [lo, hi] = Array.isArray(cfg.slowMs) ? cfg.slowMs : DEFAULTS.slowMs;
  let ms = opts.ms != null ? Number(opts.ms) : (lo + Math.random() * Math.max(1, hi - lo));
  ms = Math.max(Number(lo) || 60000, Math.min(Number(hi) || 900000, Math.round(ms)));
  const cap = Number((cfg.daily || {}).slow);
  if (Number.isFinite(cap) && cap >= 0 && st.counters.slow >= cap) return { ok: false, why: 'daily-cap', ms };
  const pk = st.perKey[key] || {};
  const sl = pk.slow || { n: 0, lastAt: 0 };
  const perDay = Number((cfg.perContact || {}).slowPerDay);
  if (Number.isFinite(perDay) && sl.n >= perDay) return { ok: false, why: 'contact-cap', ms };
  if (!dry) {
    st.counters.slow += 1;
    pk.slow = { n: sl.n + 1, lastAt: now };
    st.perKey[key] = pk;
    note(st, { t: now, key, action: 'slow', ms });
    save(st);
  }
  audit({ t: now, event: 'slow', key, dry, ms });
  return { ok: true, why: 'ok', ms };
}

/** 立刻回：只是一档更短的延迟，不占额度 */
function decideFast(opts = {}) {
  const cfg = opts.cfg || loadCfg();
  const [lo, hi] = Array.isArray(cfg.fastMs) ? cfg.fastMs : DEFAULTS.fastMs;
  const ms = Math.max(0, Math.round(Number(lo) + Math.random() * Math.max(1, Number(hi) - Number(lo))));
  audit({ t: opts.now || Date.now(), event: 'fast', key: opts.key || '', dry: !!opts.dry, ms });
  return { ok: true, ms };
}

/** 能不能引用旧话：已经是引用回复 / 额度用尽 → 不许 */
function allowQuote(key, opts = {}) {
  const cfg = opts.cfg || loadCfg();
  const now = opts.now || Date.now();
  const dry = !!opts.dry;
  const st = load(now);
  if (cfg.enabled === false) return { ok: false, why: 'disabled' };
  if (opts.hasQuote) return { ok: false, why: 'already-quoting' };
  const cap = Number((cfg.daily || {}).quote);
  if (Number.isFinite(cap) && cap >= 0 && st.counters.quote >= cap) return { ok: false, why: 'daily-cap' };
  if (!dry) {
    st.counters.quote += 1;
    note(st, { t: now, key, action: 'quote' });
    save(st);
  }
  audit({ t: now, event: 'quote', key, dry, seq: opts.seq || null });
  return { ok: true, why: 'ok' };
}

function status(now) {
  const st = load(now || Date.now());
  const cfg = loadCfg();
  return {
    enabled: cfg.enabled !== false,
    day: st.day,
    counters: st.counters,
    caps: cfg.daily,
    decisions: st.decisions.slice(-8).reverse(),
    keys: Object.keys(st.perKey).length,
  };
}
function list(now) { return load(now || Date.now()); }

/** 读/写「自由度档位」：balanced（默认口径）或 max（最高自由，只留安全红线） */
function getPreset() {
  try { const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); return j.preset || 'balanced'; } catch (e) { return 'balanced'; }
}
function setPreset(name) {
  if (!PRESETS[name]) throw new Error('未知档位：' + name + '（可用：' + Object.keys(PRESETS).join(' / ') + '）');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { j = {}; }
  j.preset = name;
  j._presetNote = 'balanced=问事/求助/@我/催/久别第一句不许不回且有限额；max=这些硬拦与额度全关，回不回由模型自己判断（风控与涉钱红线仍在 risk.js 与 SYSTEM）';
  store.writeJson(CFG_PATH, j);
  return { preset: name, cfg: loadCfg(true) };
}
function reset(now) { save(blank(now || Date.now())); audit({ t: Date.now(), event: 'reset' }); return true; }

module.exports = {
  DEFAULTS, PRESETS, CFG_PATH, loadCfg, configure, options,
  dirOf, stateFile, logFile, dayKey, blank, load, save,
  parseMarkers, stripMarks, MARK_ANY, parseDelay,
  schedulePlan, duePlans, markPlanSent, listPlans, cancelPlans, pendingPlans, PLAN_DEFAULTS,
  decideSkip, decideSlow, decideFast, allowQuote, looksUrgent, looksRequest,
  status, list, reset, getPreset, setPreset,
};

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') console.log(JSON.stringify(status(), null, 2));
  else if (cmd === 'reset') { reset(); console.log('autonomy: reset'); }
  else if (cmd === 'parse') console.log(JSON.stringify(parseMarkers(process.argv.slice(3).join(' ')), null, 2));
  else if (cmd === 'preset') {
    const want = process.argv[3];
    if (!want) console.log(JSON.stringify({ current: getPreset(), available: Object.keys(PRESETS) }, null, 2));
    else { const r = setPreset(want); console.log('自主权档位 → ' + r.preset + '（重启 auto-reply 或等配置热读生效）'); }
  }
  else console.log('用法: node scripts/autonomy.js [status|reset|parse "文本…"|preset [balanced|max]]');
}
