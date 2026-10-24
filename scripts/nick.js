/**
 * nick.js —— 聊天里改昵称（跟换头像同一套口径）
 *
 * 用户 2026-10-24：「增加一个聊天，可以改自己昵称的功能，就跟换头像一样。
 * 不过一般来说，只听亲密度比较高的人的意见。或者说关系比较特殊的，比如伴侣。」
 *
 * 所以这里有两道门：
 *  1. 意图识别 —— 必须明确在说「改昵称」，路过夸一句名字不算
 *  2. 关系授权 —— 亲密度/信任度够高，或者被手工列为「特殊关系」（伴侣等）
 *     不够的人开口，不当场改，记进待定清单（logs/nick/state.json 的 pending）
 *
 * 改完把旧昵称收进 aliases，群聊里提到旧名字照样能认出是在叫我。
 * 状态落盘 logs/nick/state.json（QQNICK_DIR 覆盖），配置 config/nick.json。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'nick.json');
const DIR = path.join(ROOT, 'logs', 'nick');

const DEFAULTS = {
  enabled: true,
  // 准入门槛：亲密度与信任度都要到线
  minIntimacy: 0.45,
  minTrust: 0.55,
  // 特殊关系（伴侣之类）的白名单：写 key（p:<uin> / g:<gid>:u:<uin>）或直接写 uin
  partners: [],
  // 昵称长度上限（QQ 昵称上限约 36 字节，这里保守）
  maxLen: 16,
  // 改完保留多少个旧名字做别名
  aliasesKeep: 6,
  // 冷却（分钟），0 = 不限制
  cooldownMin: 0,
  // 自动换昵称（不通过聊天）默认关：改资料属高风险动作
  autoEnabled: false
};

function loadCfg(force) {
  if (!force && loadCfg._c) return loadCfg._c;
  const o = { ...DEFAULTS };
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    for (const k of Object.keys(j)) if (!k.startsWith('_')) o[k] = j[k];
  } catch (e) { /* 用默认 */ }
  loadCfg._c = o;
  return o;
}

function configure(over) {
  loadCfg._c = { ...loadCfg(true), ...(over || {}) };
  return loadCfg._c;
}

function dirOf() { return process.env.QQNICK_DIR || DIR; }
function stateFile() { return path.join(dirOf(), 'state.json'); }

function blank() {
  return { current: '', aliases: [], lastAt: 0, history: [], pending: [] };
}

function load() {
  const f = stateFile();
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object') return blank();
    const b = blank();
    return {
      ...b, ...j,
      aliases: Array.isArray(j.aliases) ? j.aliases : [],
      history: Array.isArray(j.history) ? j.history : [],
      pending: Array.isArray(j.pending) ? j.pending : []
    };
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { fs.renameSync(f, f + '.bad-' + Date.now()); } catch (e2) { /* ignore */ }
    }
    return blank();
  }
}

function save(st) {
  const f = stateFile();
  try { fs.mkdirSync(dirOf(), { recursive: true }); } catch (e) { /* ignore */ }
  const body = JSON.stringify(st, null, 1);
  for (let i = 0; i < 4; i++) {
    try {
      const tmp = f + '.' + process.pid + '.' + i + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, f);
      return true;
    } catch (e) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + 25 * i); } catch (e2) { /* ignore */ }
      if (i === 3) {
        try { fs.writeFileSync(f, body); return true; } catch (e3) {
          try { fs.appendFileSync(path.join(ROOT, 'logs', 'nick-error.log'), String(Date.now()) + ' ' + (e && e.message) + '\n'); } catch (e4) { /* ignore */ }
          return false;
        }
      }
    }
  }
  return false;
}

const NAME_CH = '[^\\s「」“”"\'，,。.！!？?、]{1,20}';

/** 认出「改昵称」这个请求；返回 {hit, next} */
function parseRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return { hit: false };
  if (!/昵称|名字|改名|叫什么|就叫|改叫|叫你/.test(t)) return { hit: false };
  // 只是夸/问，不是改
  if (/^(你|这|那个)?(的)?(名字|昵称)(真|挺|好|很|太|不错|好听|好看)/.test(t)) return { hit: false };
  const pats = [
    new RegExp('(?:改名|昵称|名字)(?:吧|了|啊|呗)?[，,\\s]*(?:改成|改叫|换成|改为|改成叫|设成|设|叫)\\s*[「“"\']?(' + NAME_CH + ')[」”"\']?'),
    new RegExp('(?:你就|以后|之后|往后)(?:你)?(?:就)?叫\\s*[「“"\']?(' + NAME_CH + ')[」”"\']?'),
    new RegExp('(?:把|给)(?:你的?)?(?:昵称|名字)(?:改成|换成)\\s*[「“"\']?(' + NAME_CH + ')[」”"\']?')
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m && m[1]) {
      let next = m[1].trim().replace(/[了吧呀啊。，,\s]+$/, '');
      if (!next) continue;
      if (/^(什么|啥|哪个|谁|多少|怎样|怎么)/.test(next)) return { hit: false };
      if (next.length > 20) return { hit: false };
      return { hit: true, next };
    }
  }
  return { hit: false };
}

/** 关系够不够改我的名字 */
function canSuggest(key, opts = {}) {
  const o = opts.cfg || loadCfg();
  if (o.enabled === false) return { ok: false, why: 'nick-disabled' };
  let rel = { warmth: 0, trust: 0, intimacy: 0, tension: 0 };
  try {
    const mind = require('./mind.js');
    const st = mind.loadState(key);
    rel = (st && st.rel) || rel;
  } catch (e) { /* 没 mind 数据就用 0 */ }
  try {
    const bonds = require('./bonds.js');
    rel = bonds.effectiveRel(key, rel, opts.now);
  } catch (e) { /* ignore */ }
  const uin = String(key || '').replace(/^.*u:/, '').replace(/^p:/, '');
  const partners = (o.partners || []).map(String);
  const isPartner = partners.includes(String(key)) || partners.includes(String(uin));
  const intimacy = Number(rel.intimacy) || 0;
  const trust = Number(rel.trust) || 0;
  const warmth = Number(rel.warmth) || 0;
  const close = intimacy >= (o.minIntimacy ?? DEFAULTS.minIntimacy) && trust >= (o.minTrust ?? DEFAULTS.minTrust);
  const special = isPartner || (intimacy >= 0.55 && warmth >= 0.45);
  return {
    ok: !!(close || special),
    partner: !!(isPartner || special),
    why: (close || special) ? (isPartner ? 'partner' : (special ? 'special' : 'close-enough')) : 'not-close-enough',
    rel: { warmth: +warmth.toFixed(3), trust: +trust.toFixed(3), intimacy: +intimacy.toFixed(3), tension: +(Number(rel.tension) || 0).toFixed(3) }
  };
}

function currentNames(cfg) {
  const o = cfg || loadCfg();
  const st = load();
  const base = ['DSH', 'dsh', '我的昵称'];
  const names = [];
  for (const n of [st.current].concat(st.aliases || [], o.extraNames || [], base)) {
    const s = String(n || '').trim();
    if (s && s.length >= 2 && !names.includes(s)) names.push(s);
  }
  return names;
}

/**
 * 处理一次「改昵称」请求。
 * opts: {key, text, now, dry, call, verify, by, cfg}
 */
async function suggest(req = {}) {
  const o = req.cfg || loadCfg();
  const key = String(req.key || '');
  const now = Number(req.now) || Date.now();
  const dry = !!req.dry;
  const parsed = req.next ? { hit: true, next: String(req.next) } : parseRequest(req.text);
  if (!parsed.hit) return { ok: false, changed: false, why: 'no-request' };
  const next = parsed.next.slice(0, o.maxLen ?? DEFAULTS.maxLen);

  const perm = canSuggest(key, { cfg: o, now });
  if (!perm.ok) {
    const st = load();
    st.pending.push({ t: now, key, want: next, rel: perm.rel, by: String(req.by || '') });
    if (st.pending.length > 30) st.pending = st.pending.slice(-30);
    save(st);
    return { ok: false, changed: false, why: perm.why, perm, want: next, pending: true };
  }

  const st0 = load();
  if (o.cooldownMin > 0 && st0.lastAt && now - st0.lastAt < o.cooldownMin * 60e3) {
    return { ok: false, changed: false, why: 'cooldown', perm, want: next };
  }
  const cur = st0.current || '';
  if (cur && cur === next) return { ok: true, changed: false, why: 'same-name', name: next, perm };

  const call = req.call || ((action, params) => require('./qq.js').call(action, params));
  if (dry) return { ok: true, changed: false, dry: true, why: 'dry', name: next, from: cur, perm };

  let res;
  try {
    res = await call('set_qq_profile', { nickname: next });
  } catch (e) {
    return { ok: false, changed: false, why: 'call-failed: ' + (e && e.message), perm };
  }
  const okSend = res && (res.status === 'ok' || res.retcode === 0);
  if (!okSend) {
    return { ok: false, changed: false, why: 'set_qq_profile 失败: ' + JSON.stringify(res && (res.message || res.wording || res.retcode)), perm };
  }

  // 回读确认（失败不致命，只记下来）
  let confirmed = null;
  try {
    const verify = req.verify || (async () => {
      const r = await call('get_login_info', {});
      return (r && r.data && r.data.nickname) || null;
    });
    confirmed = await verify();
  } catch (e) { /* ignore */ }

  const st = load();
  if (cur && cur !== next) {
    st.aliases = [cur].concat(st.aliases || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, o.aliasesKeep ?? DEFAULTS.aliasesKeep);
  }
  st.current = next;
  st.lastAt = now;
  st.history.push({ t: now, key, from: cur, to: next, confirmed: confirmed || '', by: String(req.by || '') });
  if (st.history.length > 30) st.history = st.history.slice(-30);
  save(st);
  return { ok: true, changed: true, name: next, from: cur, confirmed, perm };
}

function replyText(r) {
  if (!r) return '这事没成。';
  if (r.dry) return `（演练模式）这会儿会把昵称改成「${r.name}」。`;
  if (r.changed) return `行，以后我叫「${r.name}」了。`;
  if (r.why === 'same-name') return `我现在就叫「${r.name}」呀。`;
  if (r.why === 'cooldown') return '刚改过名字，过阵子再说吧。';
  if (r.pending) return '名字这事……我得再想想。（这种要求我只听很熟的人）';
  if (r.why === 'nick-disabled') return '这会儿不方便改名字。';
  return '没改成：' + String(r.why || '不知道为啥').slice(0, 60);
}

function status(now = Date.now()) {
  const o = loadCfg();
  const st = load();
  return {
    enabled: o.enabled !== false,
    current: st.current || '(未记录)',
    aliases: st.aliases || [],
    lastAt: st.lastAt,
    lastAtText: st.lastAt ? new Date(st.lastAt).toLocaleString('zh-CN') : '',
    pending: (st.pending || []).length,
    history: (st.history || []).slice(-3),
    minIntimacy: o.minIntimacy,
    minTrust: o.minTrust,
    partners: o.partners || [],
    now
  };
}

module.exports = {
  DEFAULTS, CFG_PATH, loadCfg, configure, dirOf, stateFile, blank, load, save,
  parseRequest, canSuggest, currentNames, suggest, replyText, status
};

if (require.main === module) {
  (async () => {
    const cmd = process.argv[2];
    if (cmd === 'current' || !cmd) {
      const s = status();
      console.log(`当前昵称：${s.current}`);
      console.log(`别名：${(s.aliases || []).join(' / ') || '（无）'}`);
      console.log(`上次修改：${s.lastAtText || '（没改过）'}`);
      console.log(`待定请求：${s.pending} 条   门槛：亲密度≥${s.minIntimacy} 且 信任≥${s.minTrust}   特殊关系：${(s.partners || []).join(',') || '（无）'}`);
    } else if (cmd === 'names') {
      console.log(currentNames().join('\n'));
    } else if (cmd === 'set') {
      const next = process.argv[3];
      if (!next) return console.log('用法：node scripts/nick.js set <新昵称> [--force]');
      const force = process.argv.includes('--force');
      const r = await suggest({ key: force ? 'p:__manual__' : 'p:__manual__', next, by: 'cli', cfg: force ? { ...loadCfg(true), enabled: true } : loadCfg(true) });
      console.log(JSON.stringify(r, null, 1));
    } else if (cmd === 'sim') {
      const key = process.argv[3];
      const text = process.argv.slice(4).join(' ');
      const p = parseRequest(text);
      console.log('意图：', JSON.stringify(p));
      console.log('权限：', JSON.stringify(canSuggest(key)));
    } else {
      console.log('用法：node scripts/nick.js current | names | sim <key> "<话>" | set <新昵称> [--force]');
    }
  })().catch(e => { console.error(e && e.message); process.exit(1); });
}
