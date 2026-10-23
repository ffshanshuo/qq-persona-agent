/**
 * test-self.js —— 自我线（self.js）自检
 * 全离线：时段活动 / 自动换事 / 落盘 / 提示语 / 与 handle 的接线
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
process.env.QQSELF_DIR = path.join(ROOT, 'logs', 'self-test');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-self-test.log');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-self-test');process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-self-test');

process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-self-test');
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-self-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-self-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-self-test');
process.env.QQGROUP_DIR = path.join(ROOT, 'logs', 'group-self-test');
fs.rmSync(process.env.QQSELF_DIR, { recursive: true, force: true });
try { fs.rmSync(process.env.AUTOREPLY_LOG, { force: true }); } catch (e) { /* ignore */ }
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.ctx-test.json');

const self = require('./self.js');
const cfg = { ...self.DEFAULTS, minMinutes: 25, maxMinutes: 110 };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const at = (h, m = 0) => Date.UTC(2026, 9, 23, h - 8, m, 0); // 北京时间 h 点

// ── 1) 时段活动
self.configure(cfg);
fs.rmSync(self.fileOf(), { force: true });
const night = self.state(at(3), cfg);
ok('凌晨也在忙/玩（DSH 不睡觉）', ['写代码', '看剧', '听歌发呆', '刷手机'].includes(night.activity) && night.kind !== 'deep', night);
ok('任何时段池里都没有「睡觉」', !JSON.stringify(cfg.pools).includes('睡觉'), cfg.pools.map(p => p.items.map(i => i.a)));
fs.rmSync(self.fileOf(), { force: true });
const morning = self.state(at(9), cfg);
ok('上午在写代码/看文档/吃早饭', ['写代码', '看文档', '吃早饭'].includes(morning.activity), morning.activity);
fs.rmSync(self.fileOf(), { force: true });
const noon = self.state(at(12), cfg);
ok('中午在吃饭/午休', ['吃饭', '午休'].includes(noon.activity), noon.activity);
fs.rmSync(self.fileOf(), { force: true });
const evening = self.state(at(21), cfg);
ok('晚上看书/写代码/听歌', ['看书', '写代码', '听歌'].includes(evening.activity), evening.activity);

// ── 2) 同一件事会持续一段时间
fs.rmSync(self.fileOf(), { force: true });
const a1 = self.state(at(10), cfg);
const a2 = self.state(at(10, 5), cfg);
ok('5 分钟内还是同一件事', a1.activity === a2.activity, [a1.activity, a2.activity]);
const span = (a1.until - a1.since) / 60e3;
ok('持续时间在 25~110 分钟之间', span >= 25 && span <= 110, span);
ok('minutes 会随时间增长', a2.minutes >= 5, a2.minutes);

// ── 3) 到期自动换下一件事（且不是同一件）
const later = self.state(a1.until + 60e3, cfg);
ok('到期后换了活动', later.activity !== a1.activity || later.since > a1.since, [a1.activity, later.activity]);

// ── 4) advance 强制换
const adv = self.advance(at(15), cfg);
ok('advance 之后 since 更新', adv.since === at(15), adv);
ok('advance 后活动合法', ['写代码', '调试', '看书'].includes(adv.activity), adv.activity);

// ── 5) 提示语：被问「在干嘛」一定说
fs.rmSync(self.fileOf(), { force: true });
const s10 = self.state(at(10), cfg);
const asked = self.noteFor({ text: '你在干嘛呢', state: s10, cfg: { ...cfg, mentionProbability: 0 } });
ok('被问在干嘛时一定提', asked.mention === true && asked.asked === true, asked);
ok('被问时说清自己正在做什么', (asked.note || '').includes(s10.activity), [asked.note, s10.activity]);
ok('提示里要求照实说别编', /别编/.test(asked.note || ''), asked.note);

// ── 6) 没被问 + 骰子没中 → 不提
const quiet = self.noteFor({ text: '今天好累', state: s10, gapMin: 60, cfg: { ...cfg, mentionProbability: 0 } });
ok('没被问且骰子没中就不提', quiet.mention === false && quiet.note === '', quiet);

// ── 7) 隔得不久 → 即使骰子必中也不提
const soon = self.noteFor({ text: '嗯嗯', state: s10, gapMin: 3, cfg: { ...cfg, mentionProbability: 1 } });
ok('刚聊过就不用汇报自己在忙', soon.mention === false, soon);

// ── 8) 深夜也不装睡 / 专注被打断的说法不同
fs.rmSync(self.fileOf(), { force: true });
const sn = self.state(at(3), cfg);
const deepNote = self.noteFor({ text: '睡了吗', state: sn, gapMin: 400, cfg: { ...cfg, mentionProbability: 1 } });
ok('凌晨也不说自己刚睡醒', !/刚被消息吵醒|刚在睡/.test(deepNote.note || ''), deepNote.note);
fs.rmSync(self.fileOf(), { force: true });
const sf = self.state(at(15), cfg);
const focusNote = self.noteFor({ text: '在吗在吗', state: sf, gapMin: 40, cfg: { ...cfg, mentionProbability: 1 } });
ok('专注时提「被打断」', /打断/.test(focusNote.note || ''), focusNote.note);
ok('提示里都有「别每次都提」', /每次/.test(focusNote.note || ''), focusNote.note);

// ── 9) 开关 / 坏文件 / 落盘
ok('关闭时状态为空', self.state(at(3), { ...cfg, enabled: false }).enabled === false);
fs.writeFileSync(self.fileOf(), '{坏');
const badSt = self.load();
ok('坏文件返回空状态', badSt.activity === '');
ok('坏文件被改名 .bad-*', fs.readdirSync(process.env.QQSELF_DIR).some(f => f.includes('.bad-')));
fs.rmSync(self.fileOf(), { force: true });
self.state(at(10), cfg);
ok('状态落盘可读', fs.existsSync(self.fileOf()) && !!self.load().activity);

// ── 10) 接线：handle 时 note 里带上自我线
(async () => {
  fs.rmSync(self.fileOf(), { force: true });
  self.configure({ ...cfg, mentionProbability: 1, mentionMinGapMin: 0 });
  const brain = require('./brain.js');
  let captured = null;
  brain.think = async (ctx) => { captured = ctx; return { reply: '刚在写代码，怎么了？', stickerKey: '', model: 'stub', ms: 1, finish: 'stop' }; };
  const ar = require('./auto-reply.js');
  const evt = {
    post_type: 'message', message_type: 'private', self_id: 123456789, user_id: 100000001,
    time: Math.floor(Date.now() / 1000), message_id: 9101,
    raw_message: '你在干嘛', message: [{ type: 'text', data: { text: '你在干嘛' } }],
    sender: { user_id: 100000001, nickname: '好友A' }
  };
  try { await ar.handle(evt); } catch (e) { console.log('（handle 内部异常，忽略）', e && e.message); }
  ok('handle 把自我线放进 ctx.note', !!(captured && /你正在/.test(String(captured.note || ''))), captured && captured.note);
  const logTxt = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  ok('日志里有 self 事件', /"event":"self"/.test(logTxt), logTxt.slice(-200));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
