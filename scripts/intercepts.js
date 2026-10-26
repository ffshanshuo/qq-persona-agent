#!/usr/bin/env node
'use strict';
/**
 * intercepts.js —— 聊天里「一句话直接执行」的指令（换头像 / 改昵称）
 *
 * 为什么单独一层：这两件事都不需要模型——听懂了就做，做完直接回执。
 * 它们原先各占 handle() 二十多行，夹在「思考 → 自检 → 发送」的管线中间，
 * 让人读不出主流程。拆出来以后 auto-reply 只剩「命中了吗 → 命中就发 → return」。
 *
 * 这一层只做三件事：认意图 → 执行 → 组织回执。
 * 发送、输入提示、限流记账、写进记忆（mindAfterTurn）仍由调用方负责，
 * 免得这一层反向依赖发送链路。
 *
 * 只看私聊：群里说「换个头像」不该动号主的资料（那是公开场合的玩笑）。
 */

const avatar = require('./avatar.js');
const nick = require('./nick.js');
const murmur = require('./murmur.js');

function parseNick(d) {
  if (!(d && d.target && d.target.type === 'private')) return null;
  if (nick.loadCfg().enabled === false) return null;
  const req = nick.parseRequest(d.text || '');
  return req && req.hit ? req : null;
}

function parseAvatar(d) {
  if (!(d && d.target && d.target.type === 'private')) return null;
  const req = avatar.parseRequest(d.text || '');
  return req && req.hit ? req : null;
}

/**
 * 认一下这条消息是不是「直接执行」类指令；是就执行。
 * @returns {Promise<{model:string, reply:string}|null>}
 */
async function run(d, opts = {}) {
  const key = opts.key;
  const dry = opts.dry === true;
  const log = typeof opts.log === 'function' ? opts.log : () => { };

  const nReq = parseNick(d);
  if (nReq) {
    try {
      const r = await nick.suggest({ key, text: d.text, next: nReq.next, dry, by: 'chat' });
      log({ event: 'nick-chat', key, want: nReq.next, ok: r.ok, changed: r.changed, why: r.why, perm: r.perm && r.perm.why, rel: r.perm && r.perm.rel },
        r.changed ? ('改了昵称：' + r.name) : ('没改：' + (r.why || '')));
      return { model: 'nick-chat', reply: nick.replyText(r) };
    } catch (e) {
      log({ event: 'nick-chat-error', key, err: String((e && e.message) || e).slice(0, 160) });
      return null;
    }
  }

  const aReq = parseAvatar(d);
  if (aReq) {
    try {
      const r = await avatar.chatTrigger({ key, text: d.text, variant: aReq.variant, dry });
      log({ event: 'avatar-chat', key, want: aReq.variant, ok: r.ok, changed: r.changed, variant: r.variant, why: r.why },
        r.changed ? ('换了头像：' + r.variant) : ('没换：' + (r.why || '')));
      return { model: 'avatar-chat', reply: avatar.replyText(r) };
    } catch (e) {
      log({ event: 'avatar-chat-error', key, err: String((e && e.message) || e).slice(0, 160) });
      return null;
    }
  }

  // 碎话：对方这句本身没内容（「嗯」「哦」「？」「哈哈」）时直接回一句短的，不花模型调用
  try {
    const mm = parseMurmur(d, opts);
    if (mm && mm.ok) {
      if (!dry) { try { murmur.note(key, mm.reply); } catch (e) { /* ignore */ } }
      log({ event: 'murmur', key, kind: mm.kind, reply: mm.reply, why: mm.why }, '只回了一句：' + mm.reply);
      return { model: 'murmur-chat', reply: mm.reply };
    }
  } catch (e) {
    log({ event: 'murmur-error', key, err: String((e && e.message) || e).slice(0, 160) });
  }

  return null;
}

/**
 * 碎话判定：私聊、或群里点到了我们时；只有纯填充词才可能命中。
 * @returns {{ok:boolean, reply?:string, kind?:string, why:string}}
 */
function parseMurmur(d, opts) {
  const o = opts || {};
  if (!(d && d.target)) return { ok: false, why: 'no-target' };
  // 引用了消息 / 转发了聊天记录 = 有具体所指，不能当「没信息量的应和」直接打发
  // （2026-10-26 修：否则「（引用某条）你猜」会被碎话层回一句「在呢」，模型看不到被引用的内容）
  if ((Array.isArray(d.quoted) && d.quoted.length) || (Array.isArray(d.forwards) && d.forwards.length)) {
    return { ok: false, why: 'has-quote' };
  }
  const isGroup = d.target.type === 'group';
  if (isGroup && !(d.chime || d.follow)) return { ok: false, why: 'group-not-addressed' };
  return murmur.decide({ text: d.text, key: o.key, cfg: o.murmur, random: o.random, now: o.now });
}
/** 和 run() 一样，但保证不抛（解析层出问题也不该影响正常回复）。 */
async function tryRun(d, opts = {}) {
  try {
    return await run(d, opts);
  } catch (e) {
    const log = typeof opts.log === 'function' ? opts.log : () => { };
    log({ event: 'intercept-error', key: opts.key, err: String((e && e.message) || e).slice(0, 160) });
    return null;
  }
}

module.exports = { run, tryRun, parseNick, parseAvatar, parseMurmur };
