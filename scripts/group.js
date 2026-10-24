/**
 * group.js —— 群聊在场感：什么时候该插话、该接谁的话
 *
 * 私聊的规则是「对方说了我就回」；群聊不是。真人进群不会每条都接：
 *  - 有人 @ 我 → 一定要回（这条由 auto-reply 的 requireAt 管）
 *  - 有人在群里问事（「有没有人知道…」「怎么选」）→ 可以搭一句
 *  - 两个人正在你来我往 → 插进去很没眼力
 *  - 群里刷屏刷得飞快 → 别凑热闹
 *  - 我刚说过话 → 别连续输出
 *
 * 这一层只做判断（纯本地规则），不生成文本；判断通过后才交给 brain。
 * 状态落盘 logs/group/<gid>.json（QQGROUP_DIR 覆盖），进程重启不清零。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'group.json');
const DIR = path.join(ROOT, 'logs', 'group');

const DEFAULTS = {
  enabled: true,
  // 插话的随机门槛（判断通过后再掷一次，避免每次都冒头）
  probability: 0.45,
  // 我上次在这个群说话后的静默期（分钟）
  myCooldownMin: 10,
  // 每小时最多插几次
  maxPerHour: 2,
  // 统计「是不是两个人在聊」的窗口
  windowCount: 8,
  // 窗口里参与者 ≤2 且来回 ≥4 条 → 判定为两人在聊，不插
  pairMinTurns: 4,
  // 最近 2 分钟超过这么多条 → 算刷屏，不插
  hotWindowMin: 2,
  hotCount: 12,
  // 只在「有人在群里问事」或「提到我」时才考虑插话
  cuePattern: '有没有人|有人吗|有人在吗|谁知道|谁懂|求推荐|求个|怎么选|怎么办|咋办|有没有.*(推荐|建议)|请问|大佬|帮忙看|求助',
  // 提到这些词也算在叫我
  aliasPattern: '我的昵称|我的别名|DSH|dsh',
  keepMessages: 60
};

function loadCfg(force) {
  if (!force && loadCfg._c) return loadCfg._c;
  let o = { ...DEFAULTS };
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    for (const k of Object.keys(j)) if (!k.startsWith('_')) o[k] = j[k];
  } catch (e) { /* 没配置就用默认 */ }
  loadCfg._c = o;
  return o;
}

/** 运行时覆盖配置（测试/调试用；不写回配置文件） */
function configure(over) {
  loadCfg._c = { ...loadCfg(true), ...(over || {}) };
  return loadCfg._c;
}

function dirOf() { return process.env.QQGROUP_DIR || DIR; }
function fileOf(gid) { return path.join(dirOf(), String(gid) + '.json'); }
function blank(gid) { return { gid: String(gid), msgs: [], myLastAt: 0, chimes: [], updatedAt: 0 }; }

function load(gid) {
  const f = fileOf(gid);
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object') return blank(gid);
    return { ...blank(gid), ...j, msgs: Array.isArray(j.msgs) ? j.msgs : [], chimes: Array.isArray(j.chimes) ? j.chimes : [] };
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { fs.renameSync(f, f + '.bad-' + Date.now()); } catch (e2) { /* ignore */ }
    }
    return blank(gid);
  }
}

function save(st) {
  const f = fileOf(st.gid);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (e) { /* ignore */ }
  st.updatedAt = Date.now();
  const body = JSON.stringify(st, null, 1);
  for (let i = 0; i < 4; i++) {
    try {
      fs.mkdirSync(dirOf(), { recursive: true });
      const tmp = f + '.' + process.pid + '.' + i + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, f);
      return true;
    } catch (e) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + 25 * i); } catch (e2) { /* ignore */ }
      if (i === 3) {
        try { fs.writeFileSync(f, body); return true; } catch (e3) {
          try { fs.appendFileSync(path.join(ROOT, 'logs', 'group-error.log'), String(Date.now()) + ' ' + (e && e.message) + '\n'); } catch (e4) { /* ignore */ }
          return false;
        }
      }
    }
  }
  return false;
}

/** 记一条群消息（无论回不回都记：判断要靠它） */
function observe(gid, info = {}) {
  const o = loadCfg();
  const st = load(gid);
  const now = Number(info.now) || Date.now();
  const text = String(info.text || '').slice(0, 120);
  st.msgs.push({ uin: String(info.uin || ''), nick: String(info.nick || '').slice(0, 24), t: now, text, atMe: !!info.atMe });
  if (st.msgs.length > (o.keepMessages || DEFAULTS.keepMessages)) st.msgs = st.msgs.slice(-(o.keepMessages || DEFAULTS.keepMessages));
  save(st);
  return st;
}

/** 我发了话：记 myLastAt + 计数 */
function markSpoke(gid, now = Date.now()) {
  const st = load(gid);
  st.myLastAt = now;
  st.chimes.push(now);
  st.chimes = st.chimes.filter(t => now - t < 3600e3).slice(-20);
  save(st);
  return st;
}

const isQuestion = (t) => /[?？]\s*$/.test(String(t || '').trim());

/**
 * 该不该插话。
 * @returns {{ok:boolean, reason:string, note?:string, cues?:object}}
 */
function shouldChime(gid, info = {}, cfg) {
  const o = cfg || loadCfg();
  if (o.enabled === false) return { ok: false, reason: 'group-chime-disabled' };
  const st = info.state || load(gid);
  const now = Number(info.now) || Date.now();
  const text = String(info.text || '');
  if (info.atMe) return { ok: true, reason: 'at-me' };

  // 我刚说过话
  if (st.myLastAt && now - st.myLastAt < (o.myCooldownMin ?? DEFAULTS.myCooldownMin) * 60e3)
    return { ok: false, reason: 'my-cooldown' };
  // 每小时上限
  const recentChimes = (st.chimes || []).filter(t => now - t < 3600e3);
  if (recentChimes.length >= (o.maxPerHour ?? DEFAULTS.maxPerHour)) return { ok: false, reason: 'chime-hourly-cap' };

  const msgs = (st.msgs || []).slice(-(o.windowCount ?? DEFAULTS.windowCount));
  // 先算触发点：有人在问全群，就不算「两人私聊」——那是在向所有人求助
  const cueRe0 = new RegExp(o.cuePattern || DEFAULTS.cuePattern);
  const aliasRe0 = new RegExp(o.aliasPattern || DEFAULTS.aliasPattern, 'i');
  const asked0 = cueRe0.test(text) || isQuestion(text);
  const called0 = aliasRe0.test(text);
  // 上一条就是我自己
  const last = (st.msgs || [])[st.msgs.length - 1];
  if (last && last.uin === String(info.selfId || '') && info.selfId) return { ok: false, reason: 'last-was-me' };

  // 两个人正在聊
  const others = msgs.filter(m => !info.selfId || m.uin !== String(info.selfId));
  const speakers = [...new Set(others.map(m => m.uin))];
  if (!asked0 && speakers.length <= 2 && others.length >= (o.pairMinTurns ?? DEFAULTS.pairMinTurns))
    return { ok: false, reason: 'pair-talking', cues: { speakers: speakers.length, turns: others.length } };

  // 刷屏
  const hot = (st.msgs || []).filter(m => now - m.t <= (o.hotWindowMin ?? DEFAULTS.hotWindowMin) * 60e3).length;
  if (hot >= (o.hotCount ?? DEFAULTS.hotCount)) return { ok: false, reason: 'too-hot', cues: { hot } };

  // 触发点：有人在群里问事，或提到我
  const cueRe = new RegExp(o.cuePattern || DEFAULTS.cuePattern);
  const aliasRe = new RegExp(o.aliasPattern || DEFAULTS.aliasPattern, 'i');
  const asked = cueRe.test(text) || isQuestion(text);
  const called = aliasRe.test(text);
  if (!asked && !called) return { ok: false, reason: 'no-cue' };

  // 掷一次骰子（可以配 probability: 1 关掉随机）
  if (Math.random() > (o.probability ?? DEFAULTS.probability)) return { ok: false, reason: 'dice' };

  const speaker = info.nick || (last && last.nick) || '群里的人';
  const others2 = speakers.filter(u => u !== String(info.uin || '')).length;
  const bits = [];
  bits.push(`这是群聊，刚说话的是${speaker}。`);
  if (called) bits.push('TA 提到了你（或你的名字），可以自然接一句。');
  else bits.push('TA 像是在群里问事，你要是知道就简短答一句，不知道就别硬接。');
  if (others2 > 0) bits.push('群里不止你们两个，别把话聊成私聊、也别重复别人说过的。');
  bits.push('一句就够，别 @ 所有人。');

  return { ok: true, reason: called ? 'called' : 'group-question', note: bits.join(''), cues: { speakers: speakers.length, hot, asked, called } };
}

function list(gid) {
  const st = load(gid);
  return { gid: st.gid, msgs: st.msgs.length, myLastAt: st.myLastAt, chimes: (st.chimes || []).length, last: (st.msgs || []).slice(-5) };
}

module.exports = { DEFAULTS, CFG_PATH, loadCfg, configure, dirOf, fileOf, blank, load, save, observe, markSpoke, shouldChime, list };

if (require.main === module) {
  const gid = process.argv[2];
  if (!gid) {
    console.log('用法：node scripts/group.js <群号>              # 看这个群最近的记录');
    console.log('      node scripts/group.js <群号> --test "有没有人知道这个怎么弄"  # 试一次判断');
    process.exit(0);
  }
  const ti = process.argv.indexOf('--test');
  if (ti > 0) {
    const text = process.argv[ti + 1] || '';
    observe(gid, { uin: '10000', nick: '试探的人', text });
    console.log(JSON.stringify(shouldChime(gid, { text, nick: '试探的人', uin: '10000' }), null, 1));
  } else {
    const r = list(gid);
    console.log(`[group] ${r.gid}  消息 ${r.msgs} 条  我上次说话 ${r.myLastAt ? new Date(r.myLastAt).toLocaleString('zh-CN') : '无'}  近一小时插话 ${r.chimes} 次`);
    for (const m of r.last) console.log(`  ${new Date(m.t).toLocaleTimeString('zh-CN')} ${m.nick || m.uin}: ${m.text}`);
  }
}
