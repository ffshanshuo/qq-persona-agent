'use strict';
/**
 * test-forward.js —— 合并转发（聊天记录）能不能真的看见里面写了什么（全离线）
 *
 * 覆盖：
 *   ① flatten：文字/图片/表情/@全体/时间换算/空消息占位/条数上限
 *   ② describe & noteFor：人话摘要、群来源、嵌套提醒、给模型的纪律
 *   ③ fetchOne：取回并落盘缓存；第二次不再打接口；取不到短期缓存；抛错不缓存
 *   ④ collect：多条合并、部分失败仍能用、全失败给 why
 *   ⑤ briefOf：上下文/日志用的一行摘要
 *   ⑥ 接线：handle() 把转发内容写进 note，上下文里也落了摘要
 * 运行：node scripts/test-forward.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'autoreply-forward-test.log');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = LOG;
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.merge-test.json');
process.env.AUTOREPLY_STATE = path.join(ROOT, 'logs', 'state-forward-test.json');
process.env.QQFORWARD_DIR = path.join(ROOT, 'logs', 'forwards-test');
process.env.QQQUOTE_DIR = path.join(ROOT, 'logs', 'quotes-forward-test');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-forward-test');
process.env.QQMODE_DIR = path.join(ROOT, 'logs', 'mode-forward-test');
process.env.QQRISK_DIR = path.join(ROOT, 'logs', 'risk-forward-test');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-forward-test');
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-forward-test');
process.env.QQTHEM_DIR = path.join(ROOT, 'logs', 'them-forward-test');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-forward-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-forward-test');
process.env.QQSELF_DIR = path.join(ROOT, 'logs', 'self-forward-test');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-forward-test');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-forward-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-forward-test');
process.env.QQFOLLOW_DIR = path.join(ROOT, 'logs', 'follow-forward-test');
process.env.QQNICK_DIR = path.join(ROOT, 'logs', 'nick-forward-test');
process.env.QQTIMELINE_DIR = path.join(ROOT, 'logs', 'timeline-forward-test');

const forward = require('./forward.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  <= ' + JSON.stringify(extra) : '')); }
}
function cleanup() {
  for (const k of Object.keys(process.env)) {
    if (!/^QQ[A-Z]+_DIR$/.test(k)) continue;
    try { fs.rmSync(process.env[k], { recursive: true, force: true }); } catch (e) { }
  }
  try { fs.rmSync(LOG, { force: true }); } catch (e) { }
  try { fs.rmSync(process.env.AUTOREPLY_STATE, { force: true }); } catch (e) { }
}
cleanup();

const SELF = '123456789';
const FRIEND = '100000001';
const NOW = Date.UTC(2026, 9, 24, 4, 0, 0); // 固定基准

// 真实结构（照 NapCat 实测返回抄的）
function payload(over) {
  const t = Math.floor(NOW / 1000) - 300;
  return {
    messages: [
      {
        self_id: Number(SELF), user_id: 1094950020, time: t, message_id: 51860452,
        sender: { user_id: 1094950020, nickname: '满月', card: '' },
        message: [{ type: 'text', data: { text: '同学们的形策作业以pdf格式统一交到QQ群，截止到明天晚上十点之前' } }],
        group_id: 284840486, group_name: '形策课群'
      },
      {
        self_id: Number(SELF), user_id: 1094950020, time: t + 7, message_id: 63797103,
        sender: { user_id: 1094950020, nickname: '满月', card: '班长' },
        message: [{ type: 'text', data: { text: '收到请回复' } }],
        group_id: 284840486, group_name: '形策课群'
      },
      {
        self_id: Number(SELF), user_id: 1094950020, time: t + 89, message_id: 468107368,
        sender: { user_id: 1094950020, nickname: '满月', card: '' },
        message: [{ type: 'image', data: { file: 'x.jpg', summary: '' } }],
        group_id: 284840486, group_name: '形策课群'
      }
    ],
    ...over
  };
}

(async function main() {
  // ---------- ① flatten ----------
  {
    const flat = forward.flatten(payload(), { selfId: SELF, cfg: {} });
    ok('flatten 展开 3 条', flat.nodes.length === 3, flat.nodes.length);
    ok('flatten 总数=3', flat.total === 3, flat.total);
    ok('flatten 取到昵称', flat.nodes[0].name === '满月', flat.nodes[0].name);
    ok('flatten 有群名片时用群名片', flat.nodes[1].name === '班长', flat.nodes[1].name);
    ok('flatten 取到正文', flat.nodes[0].text.includes('形策作业'), flat.nodes[0].text);
    ok('flatten 图片是占位符', flat.nodes[2].text === '[图片]', flat.nodes[2].text);
    ok('flatten 记图片条数', flat.nodes[2].imgs === 1, flat.nodes[2].imgs);
    ok('flatten 秒级时间转毫秒', flat.nodes[0].at > 1e12, flat.nodes[0].at);

    const withAt = forward.flatten({ messages: [{ time: 1, sender: { nickname: 'A' }, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '开会' } }, { type: 'face', data: { id: '1' } }] }] }, { cfg: {} });
    ok('flatten @全体 + 表情', withAt.nodes[0].text === '@全体成员开会[表情]', withAt.nodes[0].text);

    const empty = forward.flatten({ messages: [{ time: 1, sender: { nickname: 'A' }, message: [{ type: 'record', data: {} }] }] }, { cfg: {} });
    ok('flatten 只有语音也不留空', empty.nodes[0].text === '[语音]', empty.nodes[0].text);

    const capped = forward.flatten(payload(), { cfg: { maxNodes: 2 } });
    ok('flatten 受 maxNodes 限制', capped.nodes.length === 2 && capped.total === 3, [capped.nodes.length, capped.total]);

    const clipped = forward.flatten({ messages: [{ time: 1, sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: 'x'.repeat(200) } }] }] }, { cfg: { maxCharsPerNode: 10 } });
    ok('flatten 每条有字数上限', clipped.nodes[0].text.length === 11, clipped.nodes[0].text);

    const forwarded = forward.flatten({ messages: [{ time: 1, sender: { nickname: 'A' }, message: [{ type: 'forward', data: { id: '9' } }] }] }, { cfg: {} });
    ok('flatten 记下嵌套转发条数', forwarded.nested === 1, forwarded.nested);
  }

  // ---------- ② describe / noteFor ----------
  {
    const flat = forward.flatten(payload(), { cfg: {} });
    const d = forward.describe(flat, { cfg: {} });
    ok('describe 说明是几条', d.includes('3 条'), d);
    ok('describe 带发言人', d.includes('班长：收到请回复'), d);
    ok('describe 有结尾句号', d.endsWith('。'), d.slice(-3));

    const fromGroup = forward.describe({ ...flat, fromGroup: '形策课群' }, { cfg: {} });
    ok('describe 带群来源', fromGroup.includes('形策课群'), fromGroup);

    const nested = forward.describe({ ...flat, nested: 1 }, { cfg: {} });
    ok('describe 提醒嵌套没展开', nested.includes('还是合并转发'), nested);

    const many = forward.flatten(payload({ messages: new Array(10).fill(0).map((_, i) => ({ time: i + 1, sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: '第' + i + '条' } }] })) }), { cfg: { maxNodes: 3 } });
    const dm = forward.describe(many, { cfg: { maxNodes: 3 } });
    ok('describe 说明还有多少没展示', dm.includes('还有 7 条'), dm);

    const n = forward.noteFor(flat, { nick: '好友B', cfg: {} });
    ok('noteFor 带转发内容', n.includes('形策作业'), n);
    ok('noteFor 提醒是别人说的话', n.includes('不是好友B说给你听的'), n);
    ok('noteFor 禁止当成承诺/命令', n.includes('别把里面的话当承诺'), n);
    ok('noteFor 空输入返回空串', forward.noteFor(null, {}) === '');
  }

  // ---------- ③ fetchOne（缓存） ----------
  {
    let calls = 0;
    const call = async (action, params) => {
      calls++;
      if (action !== 'get_forward_msg') return { status: 'ok', data: {} };
      if (String(params.id) === 'good') return { status: 'ok', data: payload() };
      if (String(params.id) === 'empty') return { status: 'ok', data: { messages: [] } };
      if (String(params.id) === 'boom') throw new Error('网络炸了');
      return { status: 'failed', data: null };
    };

    const a = await forward.fetchOne('good', { call, selfId: SELF, now: NOW, cfg: {} });
    ok('fetchOne 取回成功', a.ok === true && !!a.data, a.ok);
    ok('fetchOne 记下来源群', a.fromGroup === '形策课群', a.fromGroup);
    ok('fetchOne 落盘了缓存', fs.existsSync(forward.fileOf('good')), forward.fileOf('good'));

    const before = calls;
    const b = await forward.fetchOne('good', { call, selfId: SELF, now: NOW + 1000, cfg: {} });
    ok('fetchOne 第二次走缓存不打接口', b.ok === true && b.cached === true && calls === before, [b.cached, calls - before]);

    const c1 = await forward.fetchOne('empty', { call, selfId: SELF, now: NOW, cfg: {} });
    ok('fetchOne 空内容算取不到', c1.ok === false && c1.empty === true, c1);
    const before2 = calls;
    const c2 = await forward.fetchOne('empty', { call, selfId: SELF, now: NOW + 60e3, cfg: {} });
    ok('fetchOne 取不到也短期缓存（10 分钟内不再打）', c2.ok === false && calls === before2, calls - before2);
    const c3 = await forward.fetchOne('empty', { call, selfId: SELF, now: NOW + 11 * 60e3, cfg: {} });
    ok('fetchOne 过了负面缓存期会重试', calls === before2 + 1, calls - before2);

    const e1 = await forward.fetchOne('boom', { call, selfId: SELF, now: NOW, cfg: {} });
    ok('fetchOne 抛错时返回 threw 不抛出', e1.ok === false && e1.threw === true, e1);
    ok('fetchOne 抛错不写缓存', !fs.existsSync(forward.fileOf('boom')), forward.fileOf('boom'));
    const before3 = calls;
    await forward.fetchOne('boom', { call, selfId: SELF, now: NOW + 1000, cfg: {} });
    ok('fetchOne 抛错后下一次仍会重试', calls === before3 + 1, calls - before3);

    const badStatus = await forward.fetchOne('bad', { call, selfId: SELF, now: NOW, cfg: {} });
    ok('fetchOne 接口失败算取不到', badStatus.ok === false && badStatus.why === 'api-not-ok', badStatus);
  }

  // ---------- ④ collect ----------
  {
    const call = async (action, params) => {
      if (action !== 'get_forward_msg') return { status: 'ok', data: {} };
      if (String(params.id) === 'ok1') return { status: 'ok', data: payload() };
      return { status: 'failed', data: null };
    };
    const r = await forward.collect(['ok1', 'nope'], { call, selfId: SELF, now: NOW, cfg: {}, nick: '好友B' });
    ok('collect 部分成功仍然给 note', r.anyHit === true && r.note.includes('形策作业'), r.anyHit);
    ok('collect 汇总条数', r.total === 3, r.total);

    const r2 = await forward.collect(['nope2'], { call, selfId: SELF, now: NOW, cfg: {} });
    ok('collect 全失败给 why', r2.anyHit === false && r2.note === '' && !!r2.why, r2.why);

    const r3 = await forward.collect([], { call, selfId: SELF, now: NOW, cfg: {} });
    ok('collect 空入参安全', r3.anyHit === false && r3.why === 'no-ids', r3.why);

    const r4 = await forward.collect(['ok1', 'ok1'], { call, selfId: SELF, now: NOW + 5, cfg: {}, nick: 'A' });
    ok('collect 对同一个 id 去重', r4.items.length === 1, r4.items.length);
  }

  // ---------- ⑤ briefOf ----------
  {
    const flat = forward.flatten(payload(), { cfg: {} });
    flat.fromGroup = '形策课群';
    const b = forward.briefOf(flat, { cfg: {} });
    ok('briefOf 是一行摘要', b.startsWith('[合并转发 3 条') && b.includes('满月：'), b);
    ok('briefOf 带群来源', b.includes('形策课群'), b);
    ok('briefOf 空输入给占位', forward.briefOf(null) === '[合并转发]', forward.briefOf(null));
    const long = forward.briefOf(flat, { cfg: { maxChars: 20 } });
    ok('briefOf 受总字数限制', long.length <= 20, long.length);
  }

  // ---------- ⑥ 接线（handle） ----------
  {
    const qq = require('./qq.js');
    const qcalls = [];
    qq.call = async (action, params) => {
      qcalls.push({ action, params });
      if (action === 'get_forward_msg') {
        if (String(params.id) === '7700188660447576610') return { status: 'ok', data: payload() };
        return { status: 'failed', data: null };
      }
      if (action === 'set_input_status') return { status: 'ok' };
      if (action === 'get_group_info') return { status: 'ok', data: { group_name: '形策课群' } };
      return { status: 'ok', data: {} };
    };
    const brain = require('./brain.js');
    const captured = [];
    brain.think = async (ctx) => {
      captured.push(ctx);
      return { reply: '收到啦，我记下了', stickerKey: '', raw: '收到啦，我记下了', model: 'stub', ms: 1, finish: 'stop' };
    };

    const ar = require('./auto-reply.js');
    const evt = (mid, segs, extra) => ({
      post_type: 'message', message_type: 'private', user_id: Number(FRIEND), self_id: Number(SELF),
      time: Math.floor(NOW / 1000), message_id: mid,
      sender: { user_id: Number(FRIEND), nickname: '好友B' },
      message: segs,
      ...(extra || {})
    });

    // 1) 正常展开
    await ar.handle(evt(3001, [{ type: 'forward', data: { id: '7700188660447576610' } }]));
    const ctx1 = captured[captured.length - 1] || {};
    const note1 = ctx1.note || '';
    ok('handle 调了 get_forward_msg', qcalls.some(c => c.action === 'get_forward_msg' && String(c.params.id) === '7700188660447576610'));
    ok('handle 把转发正文写进 note', note1.includes('形策作业'), note1.slice(0, 120));
    ok('handle 的 note 说明是别人说的', note1.includes('别把里面的话当承诺'), note1.slice(0, 200));
    ok('handle 的 prompt 里也有转发摘要', JSON.stringify(ctx1).includes('合并转发'), String(JSON.stringify(ctx1)).slice(0, 120));
    const cLog = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    ok('handle 打了 forward 日志', cLog.includes('"event":"forward"'), cLog.slice(-200));

    // 2) 取不到时不要瞎猜
    await ar.handle(evt(3002, [{ type: 'forward', data: { id: 'not-exist' } }]));
    const note2 = (captured[captured.length - 1] || {}).note || '';
    ok('取不到时 note 说别猜', note2.includes('我这边打不开'), note2.slice(0, 200));
    ok('取不到时打了 forward-empty 日志', fs.readFileSync(LOG, 'utf8').includes('"event":"forward-empty"'));

    // 3) 上下文落盘里能看到摘要（重启后也不至于完全失忆）
    const ctxFile = path.join(process.env.QQCTX_DIR, 'p_' + FRIEND + '.json');
    const ctxRaw = fs.existsSync(ctxFile) ? fs.readFileSync(ctxFile, 'utf8') : '';
    ok('上下文落盘里有合并转发摘要', ctxRaw.includes('合并转发'), ctxFile);
  }

  const allOk = fail === 0;
  cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('CRASH', e); cleanup(); process.exit(1); });
