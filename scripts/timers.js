#!/usr/bin/env node
'use strict';
/**
 * timers.js —— auto-reply 的四个后台定时器（空闲巩固 / 想念调度 / 自进化 / 头像）
 *
 * 拆出来之前这四块占了文件末尾九十多行，和「收到一条消息该怎么回」混在一起。
 * 它们的共同点：都跑在 setInterval 里、每次只做一件事、失败只记日志绝不影响回复。
 *
 * 依赖注入而不是直接 require 发送链路：env = { log, send, mindSettings, cfgNow, SELF_ID }，
 * 这样定时器不需要知道 decide/handle 的存在，也不会和 auto-reply 形成循环依赖。
 */

const mind = require('./mind.js');
const ctxStore = require('./context.js');
const brain = require('./brain.js');
const risk = require('./risk.js');
const presence = require('./presence.js');

/** 空闲巩固：聊完就散场的时候也该「反刍」——定时看看有没有没整理完的会话 */
function startSweep(env) {
  const m0 = env.mindSettings();
  if (m0.enabled === false) return null;
  const everyMin = Math.max(2, Number(m0.sweepEveryMin) || 10);
  return setInterval(async () => {
    try {
      const r = await mind.sweep({
        mind: m0,
        turnsOf: (k) => { try { return ctxStore.view(k).history || []; } catch (e) { return []; } },
        extract: (list) => brain.extractMemories(list, { nick: '对方' }),
        idleMin: Number(m0.sweepIdleMin) || undefined
      });
      if (r.skipped) env.log({ event: 'mind-sweep-skip', why: r.skipped });
      else env.log({ event: 'mind-sweep', scanned: r.scanned, swept: (r.swept || []).map(x => ({ key: x.key, pending: x.pending, added: x.added })) },
        (r.swept || []).length ? `空闲巩固：整理了 ${r.swept.length} 个会话` : `空闲巩固：扫了 ${r.scanned} 个会话，没有要整理的`);
    } catch (e) {
      env.log({ event: 'mind-sweep-error', err: String((e && e.message) || e).slice(0, 200) });
    }
  }, everyMin * 60000).unref();
}

/** 想念调度：没人找我时，会不会主动想起谁（间隔与强度由亲密度/关系决定） */
function startLonging(env) {
  const longing = require('./longing.js');
  const l0 = longing.loadCfg(true);
  if (l0.enabled === false) return null;
  const everyMin = Math.max(3, Number(l0.checkEveryMin) || 20);
  return setInterval(async () => {
    try {
      // 风控闸门：主动动作默认必须走手机官方客户端（A 通道），客户端不许主动发
      const gp = risk.gate('proactive');
      if (!gp.ok) { env.log({ event: 'longing-skip', why: 'risk: ' + gp.why }); return; }
      const r = await longing.runOnce({ send: env.send, log: env.log });
      if ((r.sent || []).length) env.log({ event: 'longing-done', n: r.sent.length, keys: r.sent.map(x => x.key) }, '主动找 ' + r.sent.length + ' 个人说了话');
      else if (r.skipped && r.skipped !== 'no-one') env.log({ event: 'longing-skip', why: r.skipped });
      else env.log({ event: 'longing-check', cands: r.cands || 0 });
    } catch (e) {
      env.log({ event: 'longing-error', err: String((e && e.message) || e).slice(0, 200) });
    }
  }, everyMin * 60000).unref();
}

/** 自进化：定期看真实对话，把「判定阈值 / 词表」小步挪向更贴合的方向（写 config/tuning.json） */
function startEvolve(env) {
  const evolve = require('./evolve.js');
  const e0 = { ...evolve.loadCfg(), ...((env.cfgNow().evolve) || {}) };
  if (e0.enabled === false) return null;
  const everyMin = Math.max(30, Number(e0.everyMin) || 360);
  return setInterval(async () => {
    try {
      const r = evolve.runOnce({ apply: e0.apply !== false, minRecords: e0.minRecords });
      if (r.skipped) env.log({ event: 'evolve-skip', why: r.skipped, samples: r.samples });
      else if ((r.applied || []).length || (r.words || []).length) {
        env.log({ event: 'evolve-applied', applied: r.applied, words: (r.words || []).map(x => x.w), samples: r.samples },
          `自进化：调了 ${(r.applied || []).length} 个阈值、补了 ${(r.words || []).length} 个词`);
      } else {
        env.log({ event: 'evolve-check', samples: r.samples, notes: r.notes || [] });
      }
    } catch (e) {
      env.log({ event: 'evolve-error', err: String((e && e.message) || e).slice(0, 200) });
    }
  }, everyMin * 60000).unref();
}

/** 头像：默认 enabled=false（不自动换）。打开后从图片池挑，受 risk('profile') 闸门与间隔限制。 */
function startAvatar(env) {
  const avatar = require('./avatar.js');
  const a0 = avatar.loadCfg();
  if (!a0.enabled) return null;
  const everyMin = Math.max(60, (Number(a0.checkEveryHours) || 12) * 60);
  const tick = async () => {
    try {
      // 用自己这条会话的 PAD 状态挑款式（没有就按常规/时段选）
      let pad = null;
      try {
        const st = mind.loadState('p:' + (env.cfgNow().selfId || env.SELF_ID));
        pad = (st && st.pad) || null;
      } catch (e) { /* 没有状态就按默认 */ }
      const r = await avatar.consider({ pad, dry: process.env.AUTOREPLY_DRY === '1' });
      if (r.changed) env.log({ event: 'avatar-change', variant: r.variant, why: r.why, file: r.file }, `换了头像：${r.variant}（${r.why}）`);
      else if (r.why && r.why !== 'disabled') env.log({ event: 'avatar-skip', why: r.why, variant: r.variant });
    } catch (e) {
      env.log({ event: 'avatar-error', err: String((e && e.message) || e).slice(0, 200) });
    }
  };
  const timer = setInterval(tick, everyMin * 60000).unref();
  const first = setTimeout(tick, 90 * 1000).unref();
  return { timer, first };
}

/** 心情状态：让 QQ 上的在线状态跟着心情/活动走（恋爱中 / 搬砖中 / emo中 / 熬夜中…） */
function startPresence(env) {
  let cfg = {};
  try { cfg = presence.loadCfg(); } catch (e) { cfg = {}; }
  if (cfg.enabled === false) return null;
  const everyMin = Math.max(5, Number(cfg.everyMin) || 30);
  const tick = async () => {
    try {
      const r = await presence.consider({ dry: process.env.AUTOREPLY_DRY === '1', cfg });
      if (r.ok) env.log({ event: 'presence-change', status: r.to.status, ext: r.to.ext, label: r.to.label, why: r.why }, `状态换成「${r.to.label}」（${r.why}）`);
      else if (r.skipped && r.skipped !== 'same') env.log({ event: 'presence-skip', why: r.skipped, detail: r.why });
    } catch (e) {
      env.log({ event: 'presence-error', err: String((e && e.message) || e).slice(0, 200) });
    }
  };
  const timer = setInterval(tick, everyMin * 60000).unref();
  const first = setTimeout(tick, 120 * 1000).unref();
  return { timer, first };
}

/** 一次把四个都挂上；返回句柄，方便测试 clear 或断言「关掉的不会启动」。 */
function startAll(env) {
  return {
    sweep: startSweep(env),
    longing: startLonging(env),
    evolve: startEvolve(env),
    avatar: startAvatar(env),
    presence: startPresence(env)
  };
}

module.exports = { startAll, startSweep, startLonging, startEvolve, startAvatar, startPresence };
