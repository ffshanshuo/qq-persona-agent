'use strict';
/**
 * test-quote-out.js —— 主动引用（quote-out）离线自检
 *   ① context 存真实 seq（real_seq）   ② pickForQuote 挑旧消息与排除规则
 *   ③ buildMessage 头插 reply 段（仅私聊） ④ pushCtxTurn 记 real_seq
 *   ⑤ longing.runOnce 带上引用   ⑥ 引用发送失败自动降级重发   ⑦ 开关关掉不引
 * 运行：node scripts/test-quote-out.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const L = (n) => path.join(ROOT, 'logs', n);

process.env.QQMIND_DIR = L('mind-quote-out-test');
process.env.QQMODE_DIR = L('mode-quote-out-test');
process.env.QQRISK_DIR = L('risk-quote-out-test');
process.env.QQCTX_DIR = L('context-quote-out-test');
process.env.QQLONGING_DIR = L('longing-quote-out-test');
process.env.QQPROMISE_DIR = L('promises-quote-out-test');
process.env.QQBOND_DIR = L('bonds-quote-out-test');
process.env.QQTRACE_DIR = L('trace-quote-out-test');
process.env.QQFOLLOW_DIR = L('follow-quote-out-test');
process.env.QQNICK_DIR = L('nick-quote-out-test');
process.env.QQQUOTE_DIR = L('quotes-quote-out-test');
process.env.QQTHEM_DIR = L('them-quote-out-test');
process.env.QQTIES_DIR = L('ties-quote-out-test');
process.env.QQPRESENCE_DIR = L('presence-quote-out-test');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_STATE = L('autoreply-state-quote-out-' + process.pid + '.json');
for (const d of [process.env.QQMIND_DIR, process.env.QQCTX_DIR, process.env.QQLONGING_DIR, process.env.QQPROMISE_DIR, process.env.QQBOND_DIR, process.env.QQTRACE_DIR, process.env.QQQUOTE_DIR]) {
  fs.rmSync(d, { recursive: true, force: true });
}

const mind = require('./mind.js');
const context = require('./context.js');
const quote = require('./quote.js');
const longing = require('./longing.js');
const ar = require('./auto-reply.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const H = 3600e3;
const NOW = new Date(2026, 9, 25, 15, 0, 0).getTime();

function seedCtx(key, turns) {
  fs.mkdirSync(process.env.QQCTX_DIR, { recursive: true });
  fs.writeFileSync(context.fileOf(key), JSON.stringify({
    key, kind: 'private', peer: { uin: Number(key.slice(2)) },
    createdAt: NOW - 86400e3, updatedAt: NOW, sessionStartedAt: NOW - 86400e3,
    turns, summary: '', facts: [], dropped: 0
  }));
}
function seedMind(key, { intimacy = 0.9, warmth = 0.7, trust = 0.7, tension = 0, msgs = 20, idleHours = 12, salience = 0.3, nick = '阿星' } = {}) {
  const st = mind.blankState(key, 'private', { uin: Number(key.slice(2)) });
  st.rel = { warmth, trust, intimacy, tension };
  st.msgCount = msgs;
  st.lastTurnAt = NOW - idleHours * H;
  st.lastAffect = { pad: { p: 0, a: 0, d: 0 }, salience, at: st.lastTurnAt };
  fs.mkdirSync(process.env.QQMIND_DIR, { recursive: true });
  fs.writeFileSync(mind.stateFile(key), JSON.stringify(st));
  return st;
}

/** 把「刚主动过」的痕迹清干净（全局额度 + 每人冷却 + 会话状态），让下一轮一定会有候选 */
function resetLonging(key) {
  const g = longing.loadGlobal(); g.sent = []; longing.saveGlobal(g);
  const c = longing.load(key);
  c.lastOutAt = 0; c.count = 0; c.followUps = 0; c.items = [];
  longing.save(key, c);
  const st = mind.loadState(key);
  st.lastTurnAt = NOW - 14 * H;
  mind.saveState(st);
}

(async () => {
  {
    const KEY = 'p:3001';
    context.push(KEY, { t: NOW - 60e3, from: 'them', speaker: '阿星', text: '周末一起去爬山吧，我把车订好了', seq: 778899 });
    const v = context.view(KEY);
    const turn = (v.history || []).find(x => x.text.includes('爬山'));
    ok('① 落盘的 turn 带上 seq（字符串）', turn && turn.seq === '778899', turn && turn.seq);
    const v2 = context.view(KEY);
    ok('① view 也把 seq 交给上层', (v2.history || [])[0].seq === '778899');
  }

  // ── ② pickForQuote ──────────────────────────────────────────
  {
    // 没有 seq 的一律不引（老数据/我自己说的）
    seedCtx('p:3002', [
      { t: NOW - 3600e3, from: 'them', speaker: '阿星', text: '这条老数据没有 seq 字段' }
    ]);
    ok('② 旧数据没有 seq → 不引', quote.pickForQuote('p:3002', { now: NOW }) === null);

    seedCtx('p:3003', [
      { t: NOW - 7200e3, from: 'me', speaker: '', text: '我周末要去爬山，说好了带你', seq: '11' },
      { t: NOW - 7000e3, from: 'them', speaker: '阿星', text: '好', seq: '12' },
      { t: NOW - 6800e3, from: 'them', speaker: '阿星', text: '[表情包]', seq: '13' },
      { t: NOW - 6600e3, from: 'them', speaker: '阿星', text: '滚，别烦我', seq: '14' },
      { t: NOW - 6400e3, from: 'them', speaker: '阿星', text: '我周末也想去爬山，你哪天有空？', seq: '15' },
      { t: NOW - 30 * 24 * H, from: 'them', speaker: '阿星', text: '一个月前说的爬山计划还行不行啊', seq: '16' }
    ]);
    const q = quote.pickForQuote('p:3003', { now: NOW, topic: '周末 爬山 有空' });
    ok('② 挑到的是对方说的、有 seq 的那条', q && q.seq === '15', q);
    ok('② 排除我自己说的 / 太短 / 纯表情 / 负面 / 超期', q && !['11', '12', '13', '14', '16'].includes(q.seq), q && q.seq);
    ok('② 带引用理由', q && typeof q.why === 'string' && q.why.length > 0, q && q.why);

    // 话题对得上会加分：给两条都不错的消息，话题只命中一条
    seedCtx('p:3004', [
      { t: NOW - 3 * H, from: 'them', speaker: '阿星', text: '今天食堂的麻辣烫太咸了', seq: '21' },
      { t: NOW - 4 * H, from: 'them', speaker: '阿星', text: '周末爬香山要不要一起，早上七点出发', seq: '22' }
    ]);
    const q2 = quote.pickForQuote('p:3004', { now: NOW, topic: '爬香山 一起 出发' });
    ok('② 话题对得上的优先', q2 && q2.seq === '22', q2);
    // 没有话题时按新鲜度/计划词挑
    const q3 = quote.pickForQuote('p:3004', { now: NOW });
    ok('② 没话题时也能挑出一条（不为空）', q3 && typeof q3.seq === 'string', q3);
    // 全被排除时返回 null
    seedCtx('p:3005', [{ t: NOW - H, from: 'them', speaker: '阿星', text: '分手吧', seq: '31' }]);
    ok('② 全是负面 → 不引', quote.pickForQuote('p:3005', { now: NOW }) === null);
  }

  // ── ③ buildMessage 头插 reply 段（仅私聊）────────────────────
  {
    const priv = ar.buildMessage({ key: 'p:3006', target: { type: 'private', id: '3006' }, reply: '你还记得这事吗', quoteSeq: '778899' });
    ok('③ 私聊：第一条就是 reply 段', priv[0] && priv[0].type === 'reply', priv[0]);
    ok('③ reply 段的 seq 是字符串', priv[0] && priv[0].data && priv[0].data.seq === '778899', priv[0] && priv[0].data);
    const grp = ar.buildMessage({ key: 'g:9001', target: { type: 'group', id: '9001', at: '3006' }, reply: '群里不引用', quoteSeq: '778899', noAt: true });
    ok('③ 群聊不出引用段', !grp.some(s => s.type === 'reply'), grp);
    const noQuote = ar.buildMessage({ key: 'p:3006', target: { type: 'private', id: '3006' }, reply: '普通回复' });
    ok('③ 没有 quoteSeq 就不插段', !noQuote.some(s => s.type === 'reply'), noQuote);
  }

  // ── ④ pushCtxTurn 记 real_seq ───────────────────────────────
  {
    const KEY = 'p:3007';
    fs.rmSync(context.fileOf(KEY), { force: true });
    const d = { key: KEY, target: { type: 'private', id: '3007' }, nick: '阿星', rule: 'test', reply: '嗯嗯' };
    ar.pushCtxTurn(d, 'them', '我七点下班', { real_seq: 4321, message_seq: 999, message_id: 999 });
    const v = context.view(KEY);
    const turn = (v.history || []).find(x => x.text.includes('七点'));
    ok('④ 用 real_seq 而不是 message_seq', turn && turn.seq === '4321', turn && turn.seq);
  }

  // ── ⑤ longing.runOnce 带上引用 ───────────────────────────────
  {
    const KEY = 'p:3008';
    seedMind(KEY, { intimacy: 0.95, idleHours: 14, nick: '阿星' });
    seedCtx(KEY, [
      { t: NOW - 14 * H - 3 * H, from: 'them', speaker: '阿星', text: '周末一起去爬山吧，我把车都订好了', seq: '5151' },
      { t: NOW - 14 * H, from: 'me', speaker: '', text: '行，那就周六早上' }
    ]);
    const g = longing.loadGlobal(); g.sent = []; longing.saveGlobal(g);

    let sentD = null;
    const logs = [];
    const r = await longing.runOnce({
      now: NOW, dry: true,
      send: async (d) => { sentD = d; return { status: 'ok', dry: true }; },
      think: async () => ({ reply: '周六爬山那事还去吗？' }),
      log: (o) => logs.push(o)
    });
    ok('⑤ dry 演练也带上了引用', sentD && String(sentD.quoteSeq) === '5151', sentD && sentD.quoteSeq);
    ok('⑤ sent 里记了 quoted', (r.sent || []).some(x => String(x.quoted) === '5151'), r.sent);
    ok('⑤ 日志 longing-out 带 quoted', logs.some(l => l.event === 'longing-out' && String(l.quoted) === '5151'), logs.map(l => l.event + ':' + l.quoted));

    // ── ⑥ 引用发送失败 → 自动降级重发（不带引用）────────────────
    {
      resetLonging(KEY);
      const calls = [];
      const logs2 = [];
      const r2 = await longing.runOnce({
        now: NOW, dry: false,
        send: async (d) => {
          calls.push({ seq: d.quoteSeq || null });
          if (calls.length === 1) return { status: 'failed', retcode: 200 };   // 第一次（带引用）失败
          return { status: 'ok', retcode: 0 };
        },
        think: async () => ({ reply: '周六爬山别忘了哈' }),
        log: (o) => logs2.push(o)
      });
      ok('⑥ 第一次带引用、失败后第二次不带引用重发', calls.length === 2 && calls[0].seq === '5151' && !calls[1].seq, calls);
      ok('⑥ 降级日志 quote-out-fallback', logs2.some(l => l.event === 'quote-out-fallback'), logs2.map(l => l.event));
      ok('⑥ 最终算发送成功', (r2.sent || []).length === 1, r2.sent);
      ok('⑥ 降级后不虚报引用', (r2.sent || [])[0] && !(r2.sent || [])[0].quoted, (r2.sent || [])[0]);
    }

    // ── ⑦ 关掉就不引 ──────────────────────────────────────────
    {
      resetLonging(KEY);
      let sentD3 = null;
      await longing.runOnce({
        now: NOW, dry: true, noQuote: true,
        send: async (d) => { sentD3 = d; return { status: 'ok', dry: true }; },
        think: async () => ({ reply: '在忙什么呢' }),
        log: () => { }
      });
      ok('⑦ noQuote 时不带引用', sentD3 && !sentD3.quoteSeq, sentD3 && sentD3.quoteSeq);
      ok('⑦ 依然能正常开口（引用关掉不影响发送）', Boolean(sentD3 && sentD3.reply));
    }
  }

  // 收尾清理
  for (const d of [process.env.QQMIND_DIR, process.env.QQCTX_DIR, process.env.QQLONGING_DIR, process.env.QQPROMISE_DIR, process.env.QQBOND_DIR, process.env.QQTRACE_DIR, process.env.QQQUOTE_DIR, process.env.QQTIES_DIR, process.env.QQPRESENCE_DIR, process.env.QQMODE_DIR, process.env.QQRISK_DIR, process.env.QQFOLLOW_DIR, process.env.QQNICK_DIR, process.env.QQTHEM_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { }
  }
  try { fs.rmSync(process.env.AUTOREPLY_STATE, { force: true }); } catch (e) { }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
