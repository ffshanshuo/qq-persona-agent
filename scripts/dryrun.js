/**
 * dryrun.js —— 「试一句」：拿真实记忆预演一次回复，但**绝不发送**
 *
 * 用法：node scripts/dryrun.js p:<uin> "对方说的话"
 *      node scripts/dryrun.js g:<群号>:u:<uin> "对方说的话"   （按群聊语境预演）
 *
 * 做法：把该会话的生产记忆（context / mind / bonds / echo / mode / them）复制到
 * 一个临时目录，然后按 `AUTOREPLY_DRY=1` 跑一次 handle()——思考、语境、拣表情都真的走，
 * 只有最后一步发送被跳过。生产文件一个都不动。
 *
 * 输出：最后一行是 JSON（面板/脚本可直接解析）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEY = (process.argv[2] || '').trim();
const TEXT = process.argv.slice(3).join(' ').trim();

function out(obj) {
  console.log(JSON.stringify(obj));
}

if (!KEY || !TEXT) {
  out({ ok: false, why: '用法：node scripts/dryrun.js <p:uin | g:gid:u:uin> "<对方说的话>"' });
  process.exit(1);
}

let keyInfo;
try {
  keyInfo = parseKey(KEY);
} catch (e) {
  out({ ok: false, why: e.message });
  process.exit(1);
}

function parseKey(key) {
  let m = /^p:(\d+)$/.exec(key);
  if (m) return { key, kind: 'private', uin: m[1], gid: null };
  m = /^g:(\d+):u:(\d+)$/.exec(key);
  if (m) return { key, kind: 'group', gid: m[1], uin: m[2] };
  throw new Error('key 形状不对，应该是 p:<uin> 或 g:<群号>:u:<uin>');
}

const T0 = Date.now();
const TMP = path.join(ROOT, 'logs', 'dryrun', String(T0));
const DIRS = {
  context: path.join(TMP, 'context'),
  mind: path.join(TMP, 'mind'),
  trace: path.join(TMP, 'trace'),
  bonds: path.join(TMP, 'bonds'),
  echo: path.join(TMP, 'echo'),
  mode: path.join(TMP, 'mode'),
  them: path.join(TMP, 'them'),
  follow: path.join(TMP, 'follow'),
  promises: path.join(TMP, 'promises'),
  quotes: path.join(TMP, 'quotes'),
  risk: path.join(TMP, 'risk'),
  longing: path.join(TMP, 'longing'),
  group: path.join(TMP, 'group'),
  self: path.join(TMP, 'self'),
  pacing: path.join(TMP, 'pacing'),
  avatar: path.join(TMP, 'avatar'),
  evolve: path.join(TMP, 'evolve')
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(TMP, 'autoreply.log');
process.env.AUTOREPLY_STATE = path.join(TMP, 'state.json');
process.env.QQCTX_DIR = DIRS.context;
process.env.QQMIND_DIR = DIRS.mind;
process.env.QQTRACE_DIR = DIRS.trace;
process.env.QQBOND_DIR = DIRS.bonds;
process.env.QQECHO_DIR = DIRS.echo;
process.env.QQMODE_DIR = DIRS.mode;
process.env.QQTHEM_DIR = DIRS.them;
process.env.QQFOLLOW_DIR = DIRS.follow;
process.env.QQPROMISE_DIR = DIRS.promises;
process.env.QQQUOTE_DIR = DIRS.quotes;
process.env.QQRISK_DIR = DIRS.risk;
process.env.QQLONGING_DIR = DIRS.longing;
process.env.QQGROUP_DIR = DIRS.group;
process.env.QQSELF_DIR = DIRS.self;
process.env.QQPACING_DIR = DIRS.pacing;
process.env.QQAVATAR_DIR = DIRS.avatar;
process.env.QQEVOLVE_DIR = DIRS.evolve;

// ── 把这条会话的真实记忆搬进临时目录（生产文件只读不写） ─────────────
function copyMatching(fromDir, toDir, needles) {
  const copied = [];
  if (!fs.existsSync(fromDir)) return copied;
  for (const name of fs.readdirSync(fromDir)) {
    const full = path.join(fromDir, name);
    if (!fs.statSync(full).isFile()) continue;
    let txt = '';
    try { txt = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    if (!needles.some((n) => txt.includes(n))) continue;
    fs.writeFileSync(path.join(toDir, name), txt, 'utf8');
    copied.push(name);
  }
  return copied;
}

const NEEDLES = [`"key":"${KEY}"`, `"key": "${KEY}"`];
const copied = {};
copied.context = copyMatching(path.join(ROOT, 'logs', 'context'), DIRS.context, NEEDLES);
copied.mind = copyMatching(path.join(ROOT, 'logs', 'mind'), DIRS.mind, NEEDLES);
copied.trace = copyMatching(path.join(ROOT, 'logs', 'trace'), DIRS.trace, NEEDLES);
copied.bonds = copyMatching(path.join(ROOT, 'logs', 'bonds'), DIRS.bonds, NEEDLES);
copied.echo = copyMatching(path.join(ROOT, 'logs', 'echo'), DIRS.echo, NEEDLES);
copied.mode = copyMatching(path.join(ROOT, 'logs', 'mode'), DIRS.mode, NEEDLES);
copied.them = copyMatching(path.join(ROOT, 'logs', 'them'), DIRS.them, NEEDLES);
copied.follow = copyMatching(path.join(ROOT, 'logs', 'follow'), DIRS.follow, NEEDLES);
copied.promises = copyMatching(path.join(ROOT, 'logs', 'promises'), DIRS.promises, NEEDLES);

// ── 造一个「对方刚发了这句话」的事件 ────────────────────────────────
function selfIdOf() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'autoreply.json'), 'utf8'));
    return String(cfg.selfId || process.env.SELF_UIN || '123456789');
  } catch (e) {
    return String(process.env.SELF_UIN || '123456789');
  }
}

const SELF = selfIdOf();
const evt = keyInfo.kind === 'private'
  ? {
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      self_id: Number(SELF), user_id: Number(keyInfo.uin), time: Math.floor(Date.now() / 1000),
      message_id: 900000 + (T0 % 100000),
      message: [{ type: 'text', data: { text: TEXT } }], raw_message: TEXT,
      sender: { user_id: Number(keyInfo.uin), nickname: '' }
    }
  : {
      post_type: 'message', message_type: 'group', sub_type: 'normal',
      self_id: Number(SELF), user_id: Number(keyInfo.uin), group_id: Number(keyInfo.gid),
      time: Math.floor(Date.now() / 1000), message_id: 900000 + (T0 % 100000),
      message: [{ type: 'text', data: { text: TEXT } }], raw_message: TEXT,
      sender: { user_id: Number(keyInfo.uin), nickname: '', card: '' }
    };

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

async function main() {
  const ar = require('./auto-reply.js');
  const before = readEvents(process.env.AUTOREPLY_LOG).length;
  const tStart = Date.now();
  let error = null;
  try {
    await ar.handle(evt);
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const events = readEvents(process.env.AUTOREPLY_LOG).slice(before);
  const sent = events.filter((e) => e.event === 'dry-send').pop();
  const skip = events.filter((e) => e.event === 'skip').pop();
  const modeEv = events.filter((e) => e.event === 'mode').pop();
  const echoEv = events.filter((e) => e.event === 'echo').pop();
  const styleEv = events.filter((e) => e.event === 'style').pop();
  const sayFix = events.filter((e) => e.event === 'say-fix').pop();
  const sayRetry = events.filter((e) => e.event === 'say-retry').pop();
  const tone = events.filter((e) => e.event === 'tone-harsh').pop();
  const themEv = events.filter((e) => e.event === 'them-state').pop();
  const recallEv = events.filter((e) => e.event === 'recall').pop();
  const stickerFetch = events.filter((e) => e.event === 'sticker-fetch').pop();
  const risky = events.filter((e) => e.event === 'risk-block').pop();

  out({
    ok: !error && !!sent,
    ms: Date.now() - tStart,
    key: KEY,
    text: TEXT,
    error,
    reply: sent ? sent.reply : '',
    sticker: sent ? sent.sticker || '' : '',
    segs: sent ? sent.segs : [],
    thinkingMs: sent && sent.ms ? sent.ms.think : null,
    skipped: skip ? skip.reason : (risky ? 'risk-block: ' + risky.why : ''),
    mode: modeEv ? { mode: modeEv.mode, want: modeEv.want, why: modeEv.why, tokens: modeEv.tokens, bias: modeEv.bias } : null,
    echo: echoEv ? { kind: echoEv.kind, score: echoEv.score, ema: echoEv.ema, why: echoEv.why } : null,
    style: styleEv ? { register: styleEv.register, echo: styleEv.echo } : null,
    themState: themEv ? themEv.state || themEv.why : null,
    recall: recallEv ? recallEv.n : null,
    adjusted: {
      sayFix: !!sayFix, sayRetry: !!sayRetry, toneRetry: !!tone,
      fetchedSticker: stickerFetch ? stickerFetch.added : null
    },
    events: events.map((e) => e.event),
    copied
  });
}

main().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  process.exit(0);
}).catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { }
  out({ ok: false, why: String((e && e.message) || e), stack: String((e && e.stack) || '').split('\n').slice(0, 5) });
  process.exit(1);
});
