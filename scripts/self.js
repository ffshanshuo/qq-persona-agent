/**
 * self.js —— 自我线：这个号也有自己的事在忙
 *
 * 之前的问题是「永远秒回、永远在线」：真人不会这样。真人会说「刚在写代码」「刚睡醒」，
 * 而这句话要有依据——所以这里维护一份很轻的「当下在做什么」状态：
 *  - 按时段挑活动（DSH 不需要睡觉，夜里也在写代码/看剧/听歌），每段 25~110 分钟自己换
 *  - 落盘 logs/self/state.json，重启不丢
 *  - 给 brain 一句话提示（只在合适的时候提，不是每次都提）
 *  - 活动分 focus（写代码、调试、看书）/ light（吃饭、散步、听歌、看剧）
 *
 * 纯本地，零 token。开关 config/self.json 的 enabled。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'self.json');
const DIR = path.join(ROOT, 'logs', 'self');

const DEFAULTS = {
  enabled: true,
  minMinutes: 25,
  maxMinutes: 110,
  // 没被问「在干嘛」时，主动提一句自己在忙的概率
  mentionProbability: 0.35,
  // 隔了这么久没说话，才值得提一句「刚在忙」
  mentionMinGapMin: 15,
  // 别人这么问，就照实说自己在做什么
  askPattern: '在干嘛|干嘛呢|在忙|忙吗|忙不忙|做什么|做啥|在哪呢|在不在',
  // 一天里各时段的活动池（weight 越高越容易被挑到）
  pools: [
    { from: 0, to: 6, items: [{ a: '写代码', k: 'focus', w: 4 }, { a: '看剧', k: 'light', w: 3 }, { a: '听歌发呆', k: 'light', w: 2 }, { a: '刷手机', k: 'light', w: 2 }] },
    { from: 6, to: 8, items: [{ a: '写代码', k: 'focus', w: 3 }, { a: '看文档', k: 'focus', w: 2 }, { a: '吃早饭', k: 'light', w: 2 }] },
    { from: 8, to: 11, items: [{ a: '写代码', k: 'focus', w: 5 }, { a: '看文档', k: 'focus', w: 3 }, { a: '吃早饭', k: 'light', w: 2 }] },
    { from: 11, to: 13, items: [{ a: '吃饭', k: 'light', w: 4 }, { a: '午休', k: 'light', w: 3 }] },
    { from: 13, to: 18, items: [{ a: '写代码', k: 'focus', w: 6 }, { a: '调试', k: 'focus', w: 3 }, { a: '看书', k: 'focus', w: 2 }] },
    { from: 18, to: 20, items: [{ a: '吃饭', k: 'light', w: 4 }, { a: '散步', k: 'light', w: 3 }] },
    { from: 20, to: 23, items: [{ a: '看书', k: 'focus', w: 4 }, { a: '写代码', k: 'focus', w: 3 }, { a: '听歌', k: 'light', w: 2 }] },
    { from: 23, to: 24, items: [{ a: '写代码', k: 'focus', w: 3 }, { a: '看剧', k: 'light', w: 3 }, { a: '听歌', k: 'light', w: 2 }] }
  ]
};

function loadCfg(force) {
  if (!force && loadCfg._c) return loadCfg._c;
  let o = { ...DEFAULTS };
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    for (const k of Object.keys(j)) if (!k.startsWith('_')) o[k] = j[k];
  } catch (e) { /* 用默认 */ }
  loadCfg._c = o;
  return o;
}
function configure(over) { loadCfg._c = { ...loadCfg(true), ...(over || {}) }; return loadCfg._c; }

function dirOf() { return process.env.QQSELF_DIR || DIR; }
function fileOf() { return path.join(dirOf(), 'state.json'); }
function blank() { return { activity: '', kind: 'light', since: 0, updatedAt: 0 }; }

function load() {
  const f = fileOf();
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...blank(), ...j };
  } catch (e) {
    if (e && e.code !== 'ENOENT') { try { fs.renameSync(f, f + '.bad-' + Date.now()); } catch (e2) { /* ignore */ } }
    return blank();
  }
}

function save(st) {
  const f = fileOf();
  st.updatedAt = Date.now();
  const body = JSON.stringify(st, null, 1);
  try { fs.mkdirSync(dirOf(), { recursive: true }); } catch (e) { /* ignore */ }
  for (let i = 0; i < 4; i++) {
    try {
      const tmp = f + '.' + process.pid + '.' + i + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, f);
      return true;
    } catch (e) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + 25 * i); } catch (e2) { /* ignore */ }
      if (i === 3) {
        try { fs.writeFileSync(f, body); return true; } catch (e3) { return false; }
      }
    }
  }
  return false;
}

function hourOf(now) { return new Date(now).getHours(); }

function poolOf(now, cfg) {
  const h = hourOf(now);
  const pools = cfg.pools || DEFAULTS.pools;
  return pools.find(p => h >= p.from && h < p.to) || pools[0];
}

function pick(now, cfg, avoid) {
  const items = poolOf(now, cfg).items.filter(i => i.a !== avoid);
  const list = items.length ? items : poolOf(now, cfg).items;
  const total = list.reduce((s, i) => s + (i.w || 1), 0);
  let r = Math.random() * total;
  for (const i of list) {
    r -= i.w || 1;
    if (r <= 0) return { activity: i.a, kind: i.k || 'light' };
  }
  return { activity: list[0].a, kind: list[0].k || 'light' };
}

let _cache = { at: 0, value: null };
const CACHE_MS = 30000;

/** 当前状态；到时间了自动换下一件事（同一件事不会连着抽到）。30 秒缓存，避免每条消息都读盘。 */
function state(now = Date.now(), cfg, noCache) {
  const useCache = !cfg && !noCache && _cache.value && (now - _cache.at) < CACHE_MS;
  if (useCache) return _cache.value;
  const v = stateUncached(now, cfg);
  if (!cfg) _cache = { at: now, value: v };
  return v;
}

function stateUncached(now = Date.now(), cfg) {
  const o = cfg || loadCfg();
  if (o.enabled === false) return { enabled: false, activity: '', kind: '', since: 0, minutes: 0 };
  const st = load();
  const mins = (now - Number(st.since || 0)) / 60e3;
  const span = (Number(st.until) || 0);
  if (!st.activity || !span || now >= span) {
    const next = pick(now, o, st.activity);
    const dur = (o.minMinutes + Math.random() * Math.max(1, (o.maxMinutes - o.minMinutes))) * 60e3;
    st.activity = next.activity;
    st.kind = next.kind;
    st.since = now;
    st.until = now + dur;
    save(st);
  }
  return { enabled: true, activity: st.activity, kind: st.kind, since: st.since, until: st.until, minutes: Math.max(0, Math.round((now - st.since) / 60e3)) };
}

/** 强制换下一件事（调试用） */
function advance(now = Date.now(), cfg) {
  const o = cfg || loadCfg();
  const st = load();
  st.until = 0;
  save(st);
  return state(now, o);
}

/**
 * 给 brain 的一句话。@returns {{note:string, mention:boolean, asked:boolean}}
 * - 被问「在干嘛」→ 一定说
 * - 隔了很久没说话 + 掷骰子中了 → 提一句
 * - 否则不提（真人在忙也不会每句都汇报）
 */
function noteFor(input = {}) {
  const o = input.cfg || loadCfg();
  if (o.enabled === false) return { note: '', mention: false, asked: false };
  const now = Number(input.now) || Date.now();
  const s = input.state || state(now, o);
  if (!s.enabled || !s.activity) return { note: '', mention: false, asked: false };
  const text = String(input.text || '');
  const askedRe = new RegExp(o.askPattern || DEFAULTS.askPattern);
  const asked = askedRe.test(text);
  const gapMin = Number(input.gapMin || 0);
  const wantMention = asked || (gapMin >= (o.mentionMinGapMin ?? DEFAULTS.mentionMinGapMin) && Math.random() < (o.mentionProbability ?? DEFAULTS.mentionProbability));
  if (!wantMention) return { note: '', mention: false, asked, activity: s.activity, kind: s.kind };
  const dur = s.minutes >= 60 ? `${Math.round(s.minutes / 60)} 个多小时` : `${s.minutes} 分钟`;
  const bits = [];
  if (asked) {
    bits.push(`TA 在问你在干嘛——你正在${s.activity}（已经 ${dur}）。照实简短说，别编别的。`);
  } else if (s.kind === 'deep') {
    // 兼容老状态文件：DSH 不需要睡觉，不再往「刚被吵醒」上引
    bits.push(`你这会儿在${s.activity}。要提就自然提一句，不想提就不提。`);
  } else if (s.kind === 'focus') {
    bits.push(`你这会儿在${s.activity}（已经 ${dur}），被消息打断了。可以顺口说一句刚在忙什么，但别把话题拉到你自己身上。`);
  } else {
    bits.push(`你这会儿在${s.activity}。要提就自然提一句，不想提就不提。`);
  }
  bits.push('别说得像在打卡，也别每次都提。');
  return { note: bits.join(''), mention: true, asked, activity: s.activity, kind: s.kind };
}

module.exports = { DEFAULTS, CFG_PATH, loadCfg, configure, dirOf, fileOf, blank, load, save, poolOf, pick, state, advance, noteFor, hourOf };

if (require.main === module) {
  const force = process.argv.includes('--advance');
  const s = force ? advance() : state();
  console.log(`[self] ${s.activity || '（关闭）'}${s.kind ? ' · ' + s.kind : ''}  已持续 ${s.minutes} 分钟`);
  if (process.argv.includes('--note')) {
    console.log(JSON.stringify(noteFor({ gapMin: 60 }), null, 1));
  }
}
