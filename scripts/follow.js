/**
 * follow.js —— 群聊「@ 之后的对话跟随」
 *
 * 真实群聊里，一个人 @ 了你之后，接下来几条往往不再 @，但还在跟你说：
 *   「我的昵称 在吗」 → 「问你个事」 → 「你上次说的那个怎么弄」
 * 旧逻辑是「没 @ 就不回」，等于把后半截话全丢给在场感的随机骰子。
 *
 * 这一层的职责：
 *  1. 被 @ 时开一个「跟随会话」（group + 人 + 时间窗）
 *  2. 之后这个人再说话、没 @，用一组信号判断是不是还在对我说
 *  3. 判断为「是」就回，并延长窗口；连着几条都对不上就自然结束
 *
 * 纯本地规则，0 token；判断通过后才交给 brain 生成。
 * 状态落盘 logs/follow/<gid>-<uin>.json（QQFOLLOW_DIR 覆盖），进程重启不清零。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'logs', 'follow');

const DEFAULTS = {
  enabled: true,
  // 被 @ 之后，跟随窗口（分钟）
  windowMin: 8,
  // 我每回一句，窗口续多久（分钟）
  extendMin: 5,
  // 单次跟随最长不超过（分钟）
  maxSessionMin: 40,
  // 一个跟随会话里最多跟几条
  maxTurns: 12,
  // 太短的话不判（「嗯」「？」）
  minChars: 2,
  // 分数达到这个值才算「还在跟我说」
  replyThreshold: 3,
  // 连续几条判不出来就结束会话
  missLimit: 2
};

function loadCfg(force) {
  if (!force && loadCfg._c) return loadCfg._c;
  const o = { ...DEFAULTS };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'follow.json'), 'utf8'));
    for (const k of Object.keys(j)) if (!k.startsWith('_')) o[k] = j[k];
  } catch (e) { /* 没配置用默认 */ }
  loadCfg._c = o;
  return o;
}

function configure(over) {
  loadCfg._c = { ...loadCfg(true), ...(over || {}) };
  return loadCfg._c;
}

function dirOf() { return process.env.QQFOLLOW_DIR || DIR; }
function fileOf(gid, uin) { return path.join(dirOf(), String(gid) + '-' + String(uin) + '.json'); }

function blank(gid, uin) {
  return { key: 'g:' + gid + ':u:' + uin, gid: String(gid), uin: String(uin), at: 0, lastAt: 0, until: 0, turns: 0, misses: 0, nick: '' };
}

function load(gid, uin) {
  const f = fileOf(gid, uin);
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object') return blank(gid, uin);
    return { ...blank(gid, uin), ...j };
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { fs.renameSync(f, f + '.bad-' + Date.now()); } catch (e2) { /* ignore */ }
    }
    return blank(gid, uin);
  }
}

function save(st) {
  const f = fileOf(st.gid, st.uin);
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
          try { fs.appendFileSync(path.join(ROOT, 'logs', 'follow-error.log'), String(Date.now()) + ' ' + (e && e.message) + '\n'); } catch (e4) { /* ignore */ }
          return false;
        }
      }
    }
  }
  return false;
}

/** 名字/别名命中：名单由调用方给（nick.currentNames()） */
function nameHit(text, names) {
  const t = String(text || '');
  if (!t) return null;
  for (const n of (names || [])) {
    const s = String(n || '').trim();
    if (!s || s.length < 2) continue;
    if (t.includes(s)) return s;
  }
  return null;
}

/** 有人在 @ 我：开窗口（或续窗口） */
function open(gid, uin, info = {}) {
  const o = info.cfg || loadCfg();
  const now = Number(info.now) || Date.now();
  const st = load(gid, uin);
  if (!st.at) st.at = now;
  st.lastAt = now;
  st.until = Math.min(st.at + (o.maxSessionMin ?? DEFAULTS.maxSessionMin) * 60e3, now + (o.windowMin ?? DEFAULTS.windowMin) * 60e3);
  st.nick = String(info.nick || st.nick || '');
  save(st);
  return st;
}

/** 当前是否有活跃跟随窗口 */
function active(gid, uin, info = {}) {
  const o = info.cfg || loadCfg();
  if (o.enabled === false) return null;
  const now = Number(info.now) || Date.now();
  const st = load(gid, uin);
  if (!st.until || now > st.until) return null;
  if (st.turns >= (o.maxTurns ?? DEFAULTS.maxTurns)) return null;
  return st;
}

/** 回了一句：延长窗口、轮次 +1、miss 清零 */
function touch(gid, uin, info = {}) {
  const o = info.cfg || loadCfg();
  const now = Number(info.now) || Date.now();
  const st = load(gid, uin);
  st.lastAt = now;
  st.turns = (st.turns || 0) + 1;
  st.misses = 0;
  st.until = Math.min((st.at || now) + (o.maxSessionMin ?? DEFAULTS.maxSessionMin) * 60e3, now + (o.extendMin ?? DEFAULTS.extendMin) * 60e3);
  save(st);
  return st;
}

/** 判不出来：记一次 miss，够了就关窗 */
function miss(gid, uin, info = {}) {
  const o = info.cfg || loadCfg();
  const now = Number(info.now) || Date.now();
  const st = load(gid, uin);
  st.misses = (st.misses || 0) + 1;
  if (st.misses >= (o.missLimit ?? DEFAULTS.missLimit)) {
    st.until = 0;
    st.at = 0;
    st.turns = 0;
    st.misses = 0;
    save(st);
    return { closed: true, state: st, at: now };
  }
  save(st);
  return { closed: false, state: st, at: now };
}

function close(gid, uin) {
  const st = blank(gid, uin);
  save(st);
  return st;
}

function bigramsOf(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

const SECOND_PERSON = /你|您|你们|咱俩|我们俩|@?一[身生]仙气/;
const TALK_TO_OTHER = /你俩|你们俩|你们几个|楼上|楼下|l楼/;

/**
 * 判断这句话是不是还在跟我说。
 * @param {object} p {text, session, names, othersAt, isQuestion, now}
 * @returns {{reply:boolean, score:number, why:string[], note?:string}}
 */
function judge(p = {}) {
  const o = p.cfg || loadCfg();
  const text = String(p.text || '').trim();
  const why = [];
  let score = 0;

  if (text.length < (o.minChars ?? DEFAULTS.minChars)) {
    return { reply: false, score: -99, why: ['too-short'] };
  }

  // @ 了别人（且不是我）→ 明显不是跟我说
  const othersAt = Array.isArray(p.othersAt) ? p.othersAt.filter(Boolean) : [];
  if (othersAt.length) {
    score -= 6;
    why.push('at-others');
  }

  const named = nameHit(text, p.names);
  if (named) {
    score += 4;
    why.push('call-name:' + named);
  }

  if (SECOND_PERSON.test(text)) {
    score += 2.5;
    why.push('second-person');
  }

  if (TALK_TO_OTHER.test(text)) {
    score -= 2;
    why.push('talk-to-others');
  }

  const q = p.isQuestion != null ? !!p.isQuestion : /[?？]\s*$/.test(text);
  if (q) {
    score += 2;
    why.push('question');
  }

  // 跟上一轮我的话有内容重合 → 像在接着聊
  if (p.lastMine) {
    const a = bigramsOf(text);
    const b = bigramsOf(p.lastMine);
    let hit = 0;
    for (const g of a) if (b.has(g)) hit += 1;
    const rate = a.size ? hit / a.size : 0;
    if (rate >= 0.2) {
      score += 2;
      why.push('topic-continue:' + rate.toFixed(2));
    }
  }

  if (text.length >= 6) {
    score += 1;
    why.push('long-enough');
  }

  // 已经跟了几轮还看不出来 → 逐步降权，让它自然凉下来
  const turns = (p.session && p.session.turns) || 0;
  if (turns >= 4) {
    score -= Math.min(3, (turns - 3) * 0.5);
    why.push('session-aged:' + turns);
  }

  // 纯表情/纯符号不算
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)) {
    return { reply: false, score: -99, why: ['no-text'] };
  }

  const reply = score >= (o.replyThreshold ?? DEFAULTS.replyThreshold);
  const nick = (p.session && p.session.nick) || 'TA';
  let note = '';
  if (reply) {
    const bits = [];
    bits.push(`这是群聊。刚才${nick} @ 过你，现在这几句虽然没 @，但看着还是接着跟你说的。`);
    bits.push('就顺着这个话头回，一句就够；别突然换话题，也别把话聊成私聊腔。');
    if (named) bits.push('TA 点到了你的名字。');
    note = bits.join('');
  }
  return { reply, score, why, note };
}

function list() {
  try {
    const d = dirOf();
    const files = fs.readdirSync(d).filter(f => f.endsWith('.json') && !f.includes('.bad-'));
    const out = [];
    const now = Date.now();
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        out.push({ key: j.key, nick: j.nick, turns: j.turns, misses: j.misses, leftMin: Math.max(0, Math.round((j.until - now) / 60e3)) });
      } catch (e) { /* skip */ }
    }
    return out;
  } catch (e) { return []; }
}

module.exports = {
  DEFAULTS, loadCfg, configure, dirOf, fileOf, blank, load, save,
  nameHit, open, active, touch, miss, close, judge, list,
  SECOND_PERSON, TALK_TO_OTHER
};

if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  if (a === 'list') {
    const l = list();
    if (!l.length) console.log('（没有活跃的跟随会话）');
    else l.forEach(x => console.log(`${x.nick || x.key}  跟了 ${x.turns} 轮  还剩 ${x.leftMin} 分钟`));
  } else if (a === 'sim' && b) {
    const r = judge({ text: b, names: ['我的昵称', 'DSH'], session: { turns: 1, nick: '某个人' }, lastMine: '你要问的是那个吧' });
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log('用法：node scripts/follow.js list | sim "<一句群消息>"');
  }
}
