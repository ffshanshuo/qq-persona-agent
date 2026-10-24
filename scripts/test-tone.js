/**
 * test-tone.js —— 语气分寸（对熟的人不能冲）自检
 * 全离线：brain.think 用桩（第一次返回冲的话，第二次返回温和的话），qq.call 用桩，dry 模式。
 * 断言：冲的话不会发出去；重写后的温和版本才会发。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

// 隔离所有状态目录
for (const k of ['QQMIND_DIR', 'QQTRACE_DIR', 'QQCTX_DIR', 'QQPROMISE_DIR', 'QQBOND_DIR', 'QQLONGING_DIR', 'QQGROUP_DIR', 'QQSELF_DIR', 'QQPACING_DIR', 'QQRISK_DIR', 'QQLONGING_DIR']) {
  process.env[k] = path.join(ROOT, 'logs', 'tone-test-' + k.toLowerCase());
}
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-tone-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-tone-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-tone-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-tone-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-tone-test.log');
process.env.AUTOREPLY_STATE = path.join(ROOT, 'logs', 'autoreply-tone-state.json');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.ctx-test.json');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  // 包里还是生产配置，强制打开必要开关（只影响本进程内存）
  const cfgPath = process.env.AUTOREPLY_CONFIG;
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  raw.enabled = true;
  raw.private = Object.assign({}, raw.private, { enabled: true, allowList: [100000001] });
  raw.group = Object.assign({}, raw.group, { enabled: false });
  raw.limits = Object.assign({}, raw.limits, { perContactPerHour: 99, globalPerHour: 99 });
  raw.delayMs = [1, 1];
  raw.mind = Object.assign({}, raw.mind, { enabled: false });
  raw.promises = Object.assign({}, raw.promises, { enabled: false });
  raw.voice = Object.assign({}, raw.voice, { enabled: false });
  raw.stickers = Object.assign({}, raw.stickers, { enabled: false });
  raw.say = Object.assign({}, raw.say, { enabled: true });
  raw.pacing = { enabled: false };
  raw.context = Object.assign({}, raw.context, { warmup: false });
  const tmpCfg = path.join(ROOT, 'logs', 'tone-test-config.json');
  fs.writeFileSync(tmpCfg, JSON.stringify(raw, null, 2));
  process.env.AUTOREPLY_CONFIG = tmpCfg;

  // 拦截 QQ 调用：只记不下发
  const qq = require('./qq.js');
  const calls = [];
  qq.call = async (action, params) => { calls.push({ action, params }); return { status: 'ok', retcode: 0, data: {} }; };

  // brain.think 桩：第一次冲，第二次温和
  const brain = require('./brain.js');
  const replies = ['随便吧。', '在呢，刚忙完手头的事，怎么啦？'];
  let thinkN = 0;
  const prompts = [];
  brain.think = async (ctx) => {
    prompts.push(String((ctx && ctx.note) || ''));
    const reply = replies[Math.min(thinkN, replies.length - 1)];
    thinkN++;
    return { reply, model: 'stub', ms: 1, finish: 'stop', messages: [] };
  };

  // 让关系是"很熟"，走到 close 档
  const mind = require('./mind.js');
  const KEY = 'p:100000001';
  const st = mind.blankState(KEY, 'private', '100000001');
  st.rel = { warmth: 0.8, trust: 0.8, intimacy: 0.75, tension: 0.02 };
  st.pad = { p: 0.1, a: 0.1, d: 0 };
  mind.saveState(st);

  const ar = require('./auto-reply.js');
  const evt = {
    post_type: 'message', message_type: 'private', self_id: 123456789,
    user_id: 100000001, time: Math.floor(Date.now() / 1000), message_id: 7001,
    raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }],
    sender: { user_id: 100000001, nickname: '好友A' }
  };

  try { await ar.handle(evt); } catch (e) { console.log('handle error:', e && e.message); }

  const log = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  const dryLines = log.split(/\n/).filter(l => l.includes('dry-send'));
  const lastDry = dryLines.length ? dryLines[dryLines.length - 1] : '';

  ok('被判定为冲（tone-harsh）', /"event":"tone-harsh"/.test(log), log.split(/\n/).slice(-6).join('\n'));
  ok('重写过（tone-rewrote）', /"event":"tone-rewrote"/.test(log));
  ok('重写提示里要求软一点', prompts.some(p => /太冲|软一点/.test(p)), prompts);
  ok('最终发出去的是温和版本', /在呢，刚忙完/.test(lastDry), lastDry);
  ok('冲的原句没有发出去', !/随便吧/.test(lastDry), lastDry);
  ok('think 被调用两次（原句 + 重写）', thinkN === 2, thinkN);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
