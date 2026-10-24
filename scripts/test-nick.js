/**
 * test-nick.js —— 聊天里改昵称（nick.js）自检
 * 全离线：意图识别 + 关系授权 + 真改（桩 qq.call）+ 与 handle 的接线
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-nick-test.log');
process.env.QQNICK_DIR = path.join(ROOT, 'logs', 'nick-nick-test');
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-nick-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-nick-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-nick-test');
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-nick-test');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-nick-test');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-nick-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-nick-test');
process.env.QQTHEM_DIR = path.join(ROOT, 'logs', 'them-nick-test');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-nick-test');
process.env.QQFOLLOW_DIR = path.join(ROOT, 'logs', 'follow-nick-test');
process.env.QQRISK_DIR = path.join(ROOT, 'logs', 'risk-nick-test');
for (const k of ['QQNICK_DIR', 'QQMIND_DIR', 'QQBOND_DIR', 'QQECHO_DIR', 'QQCTX_DIR', 'QQTRACE_DIR', 'QQPROMISE_DIR', 'QQTHEM_DIR', 'QQGROUP_DIR', 'QQFOLLOW_DIR', 'QQRISK_DIR']) {
  fs.rmSync(process.env[k], { recursive: true, force: true });
}
try { fs.rmSync(process.env.AUTOREPLY_LOG, { force: true }); } catch (e) { /* ignore */ }

const nick = require('./nick.js');
const mind = require('./mind.js');

// handle 接线用独立配置：私聊全放开、限流关掉、其余层全部静音
const CFGP = path.join(ROOT, 'config', 'autoreply.nick-test.json');
fs.writeFileSync(CFGP, JSON.stringify({
  enabled: true, selfId: 123456789,
  private: { enabled: true, allowList: [], denyList: [] },
  group: { enabled: false },
  limits: { perContactPerHour: 0, globalPerHour: 0 },
  delayMs: [0, 0],
  merge: { enabled: false }, quote: { enabled: false }, context: { enabled: false, warmup: false },
  mind: { enabled: false }, echo: { enabled: false }, promises: { enabled: false },
  stickers: { enabled: false, allowFace: false, autoFetch: false },
  voice: { enabled: false }, humanize: { typing: false, split: false }, pacing: { enabled: false },
  say: { enabled: false }, them: { enabled: false }, clock: { enabled: false }, self: { enabled: false },
  follow: { enabled: false }, group2: {}, risk: {}
}, null, 1));
process.env.AUTOREPLY_CONFIG = CFGP;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const SELF = '123456789';
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);

// ── 1) 意图识别
const P = nick.parseRequest;
ok('「改名吧，叫星河」→ 星河', P('改名吧，叫星河').hit === true && P('改名吧，叫星河').next === '星河', P('改名吧，叫星河'));
ok('「昵称改成 阿光」→ 阿光', P('昵称改成 阿光').next === '阿光', P('昵称改成 阿光'));
ok('「你以后就叫小满」→ 小满', P('你以后就叫小满').next === '小满', P('你以后就叫小满'));
ok('「把名字改成「我的别名」」→ 我的别名', P('把名字改成「我的别名」').next === '我的别名', P('把名字改成「我的别名」'));
ok('带句号也认（去掉尾标点）', P('改名叫星河。').next === '星河', P('改名叫星河。'));
ok('夸名字 ≠ 改名', P('你名字真好听').hit === false, P('你名字真好听'));
ok('问「改叫什么好」不算（是来问建议）', P('改名叫什么好').hit === false, P('改名叫什么好'));
ok('闲聊不算', P('今天天气不错').hit === false);
ok('超长文本不算', P('改名' + '啊'.repeat(100)).hit === false);

// ── 2) 关系授权
function seedRel(key, rel) {
  const st = mind.blankState(key, 'private', key.replace(/^p:/, ''));
  st.rel = { warmth: 0.5, trust: 0.5, intimacy: 0.2, tension: 0, ...rel };
  mind.saveState(st);
}
seedRel('p:10001', { intimacy: 0.2, trust: 0.3, warmth: 0.4 });
const low = nick.canSuggest('p:10001');
ok('关系一般 → 不授权', low.ok === false, low);
ok('不授权原因 not-close-enough', low.why === 'not-close-enough');

seedRel('p:10002', { intimacy: 0.6, trust: 0.7, warmth: 0.6 });
const high = nick.canSuggest('p:10002');
ok('亲密度/信任都够 → 授权', high.ok === true, high);

seedRel('p:10003', { intimacy: 0.1, trust: 0.1, warmth: 0.2 });
nick.configure({ ...nick.loadCfg(true), partners: ['10003'] });
const partner = nick.canSuggest('p:10003');
ok('特殊关系（伴侣名单）→ 即使不熟也授权', partner.ok === true && partner.partner === true, partner);
nick.configure({});

seedRel('p:10004', { intimacy: 0.58, trust: 0.2, warmth: 0.5 });
const special = nick.canSuggest('p:10004');
ok('关系特殊（亲密度高+温暖）→ 授权', special.ok === true && special.partner === true, special);

// ── 3) 真的改（桩 call）
let calls = [];
const fakeCall = async (action, params) => {
  calls.push({ action, params });
  if (action === 'set_qq_profile') return { status: 'ok', retcode: 0 };
  if (action === 'get_login_info') return { status: 'ok', data: { nickname: params && params.expect ? params.expect : '星河' } };
  return { status: 'ok' };
};
const verify = async () => '星河';

(async () => {
  fs.rmSync(nick.stateFile(), { force: true });
  const r1 = await nick.suggest({ key: 'p:10001', text: '改名叫星河', now: T0, call: fakeCall, verify });
  ok('不授权的人 → 不改', r1.ok === false && r1.pending === true, r1);
  const st1 = nick.load();
  ok('不授权的请求进了待定清单', st1.pending.length === 1 && st1.pending[0].want === '星河');
  ok('不授权时没有真的调 set_qq_profile', calls.filter(c => c.action === 'set_qq_profile').length === 0);

  calls = [];
  const r2 = await nick.suggest({ key: 'p:10002', text: '昵称改成星河', now: T0, call: fakeCall, verify });
  ok('授权的人 → 真的改了', r2.ok === true && r2.changed === true && r2.name === '星河', r2);
  ok('调用了 set_qq_profile', calls.some(c => c.action === 'set_qq_profile' && c.params.nickname === '星河'));
  const st2 = nick.load();
  ok('状态里记下新昵称', st2.current === '星河');
  ok('历史里有一条改动记录', st2.history.length === 1 && st2.history[0].to === '星河');

  const r3 = await nick.suggest({ key: 'p:10002', text: '改名叫阿光', now: T0 + 1000, call: fakeCall, verify });
  ok('再改一次 → 旧昵称进别名', r3.changed === true && nick.load().aliases.includes('星河'), nick.load().aliases);
  const names = nick.currentNames();
  ok('currentNames 含当前与旧昵称', names.includes('阿光') && names.includes('星河'), names);
  ok('currentNames 始终含 DSH 兜底', names.includes('DSH'));

  fs.rmSync(nick.stateFile(), { force: true });
  const r4 = await nick.suggest({ key: 'p:10002', text: '改名叫星河', now: T0, dry: true, call: fakeCall, verify });
  ok('dry 不发请求', r4.dry === true && r4.changed === false);
  ok('dry 后状态没变', nick.load().current === '');

  // 同名
  const r5 = await nick.suggest({ key: 'p:10002', text: '改名叫星河', now: T0, call: fakeCall, verify });
  const r6 = await nick.suggest({ key: 'p:10002', text: '改名叫星河', now: T0 + 10, call: fakeCall, verify });
  ok('改成同名 → 识别 same-name', r6.changed === false && r6.why === 'same-name', r6);

  // 回复文案
  ok('改成功的文案', /以后我叫「星河」/.test(nick.replyText({ changed: true, name: '星河' })));
  ok('待定文案提到只听很熟的人', /很熟/.test(nick.replyText({ ok: false, pending: true, why: 'not-close-enough' })));
  ok('同名文案', /现在就叫/.test(nick.replyText({ ok: true, changed: false, why: 'same-name', name: '星河' })));

  // ── 4) 与 handle 的接线
  fs.rmSync(nick.stateFile(), { force: true });
  const ar = require('./auto-reply.js');
  let thinkCalls = 0;
  const brain = require('./brain.js');
  const origThink = brain.think;
  // handle 内部是引用 brain.think（解构前是模块属性），直接替换模块属性有效
  brain.think = async () => { thinkCalls++; return { reply: '模型不该被调用', stickerKey: '', model: 'stub' }; };

  let mid = 0;
  const evt = (text, uin) => ({
    post_type: 'message', message_type: 'private', self_id: Number(SELF), user_id: Number(uin),
    time: Math.floor(T0 / 1000), message_id: 9000 + (++mid),
    raw_message: text, message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(uin), nickname: '小A' }
  });
  seedRel('p:10002', { intimacy: 0.6, trust: 0.7, warmth: 0.6 });
  seedRel('p:10001', { intimacy: 0.15, trust: 0.2, warmth: 0.3 });
  const lastReply = () => {
    const lines = fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j.event === 'dry-send' || j.event === 'sent') return j.reply || '';
      } catch (e) { /* skip */ }
    }
    return '';
  };
  await ar.handle(evt('改名叫星河', 10002));
  const rep7 = lastReply();
  ok('handle：够近的人说改名 → 回「以后我叫…」（演练模式为「会把昵称改成」）', /星河/.test(rep7) && /(以后我叫|会把昵称改成)/.test(rep7), rep7);
  ok('handle：改名不走模型', thinkCalls === 0);
  await ar.handle(evt('改名叫阿光', 10001));
  const rep8 = lastReply();
  ok('handle：关系一般的人说改名 → 委婉拒绝', /很熟/.test(rep8), rep8);
  ok('handle：拒绝也不走模型', thinkCalls === 0);
  ok('handle：一般关系那次的请求进了待定清单', nick.load().pending.some(p => p.want === '阿光'));
  brain.think = origThink;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e && e.stack || e); process.exit(1); });
