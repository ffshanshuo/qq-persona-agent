'use strict';
// 自检：模型自主指定「语音语气」与「在线状态」（两轮自主优化）
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqtone-'));
const LOG = path.join(tmp, 'autoreply.log');

// 隔离所有会落盘的模块目录
const dirs = {
  QQAUTONOMY_DIR: 'autonomy', QQAUTONOMY_LOG: 'autonomy.jsonl',
  QQPROMISE_DIR: 'promises', QQECHO_DIR: 'echo', QQTHEM_DIR: 'them', QQQUOTE_DIR: 'quotes',
  QQFOLLOW_DIR: 'follow', QQNICK_DIR: 'nick', QQTRACK_DIR: 'track',
  QQMURMUR_DIR: 'murmur', QQSELFWRITE_DIR: 'selfwrite', QQSELFWRITE_LOG: 'selfwrite.jsonl',
  QQMODE_DIR: 'mode', QQGROUP_DIR: 'group', QQCONTEXT_DIR: 'context', QQMIND_DIR: 'mind',
  QQTRACE_DIR: 'trace', QQBOND_DIR: 'bonds', QQLONGING_DIR: 'longing', QQSELF_DIR: 'self',
  QQPACING_DIR: 'pacing', QQSTYLE_DIR: 'style', QQFORWARD_DIR: 'forward', QQPRESENCE_DIR: 'presence',
  QQSTICKER_DIR: 'stickers', QQAVATAR_DIR: 'avatar', QQTOKEN_DIR: 'token'
};
for (const [k, sub] of Object.entries(dirs)) {
  const d = path.join(tmp, sub);
  fs.mkdirSync(d, { recursive: true });
  process.env[k] = k.endsWith('.jsonl') || k.endsWith('_LOG') ? path.join(d, sub) : d;
}
process.env.BRAIN_CONFIG = path.join(__dirname, '..', 'config', 'brain.test-long.json');
process.env.AUTOREPLY_LOG = LOG;
process.env.AUTOREPLY_STATE = path.join(tmp, 'state.json');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.test.json');

let bad = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('PASS', name);
  else { bad++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
};

(async () => {
  // ============ 一、语气词映射（prosody） ============
  const V = require(path.join(ROOT, 'scripts', 'prosody.js'));
  ok('温柔→comfort', V.toneOfWord('温柔') === 'comfort');
  ok('困→sleepy', V.toneOfWord('困') === 'sleepy');
  ok('认真→serious', V.toneOfWord('认真') === 'serious');
  ok('英文档位也认', V.toneOfWord('playful') === 'playful');
  ok('乱写的词不认', V.toneOfWord('乱七八糟') === null);
  ok('byTone 带 by:model 与三轴', (() => {
    const r = V.byTone('撒娇');
    return r && r.tone === 'clingy' && r.by === 'model' && typeof r.rate === 'number';
  })());
  ok('prosodyFor 显式 tone 直接照办（不被规则覆盖）', (() => {
    const r = V.prosodyFor({ tone: 'excited', mood: '困', hour: 3 });
    return r.tone === 'excited';
  })());
  ok('不传 tone 时仍按规则挑', V.prosodyFor({ mood: '困', hour: 3 }).tone === 'sleepy');

  // ============ 二、在线状态词映射（presence） ============
  const P = require(path.join(ROOT, 'scripts', 'presence.js'));
  ok('emo中→emo', P.statusOfWord('emo中') === 'emo');
  ok('恋爱中→inLove', P.statusOfWord('恋爱中') === 'inLove');
  ok('隐身→invisible', P.statusOfWord('隐身') === 'invisible');
  ok('摸鱼中→slacking', P.statusOfWord('摸鱼中') === 'slacking');
  ok('乱写的状态不认', P.statusOfWord('飞天') === null);
  const pw = await P.setByLabel('乱写的状态');
  ok('未知状态词被拒且有理由', pw.ok === false && /未知状态词/.test(pw.why || ''), pw);
  const pd = await P.setByLabel('emo中', { dry: true });
  ok('dry 下可以点名设置（不真发请求）', pd.ok === true, pd);

  // ============ 三、brain 解析与擦除 ============
  const brain = require(path.join(ROOT, 'scripts', 'brain.js'));
  const t1 = brain.takeDirective('好呀 [[语气:撒娇]] 那我先睡啦', brain.TONE_DIRECTIVE);
  ok('解析出语气并剥离', t1.value === '撒娇' && !/语气/.test(t1.text), t1);
  const t2 = brain.takeDirective(t1.text + ' [[状态:熬夜中]]', brain.STATUS_DIRECTIVE);
  ok('解析出状态并剥离', t2.value === '熬夜中' && !/状态/.test(t2.text), t2);
  ok('全角单方括号也认', (() => {
    const r = brain.takeDirective('晚安【语气:温柔】', brain.TONE_DIRECTIVE);
    return r.value === '温柔' && !/语气/.test(r.text);
  })());
  ok('cleanReply 擦掉残缺标记', !/语气|状态/.test(brain.cleanReply('在呢 [[语气:温')), brain.cleanReply('在呢 [[语气:温'));
  ok('正常括号内容不受影响', brain.cleanReply('我说的是「状态」两个字') === '我说的是「状态」两个字');

  // ============ 四、handle 接线：状态被设、语气被记 ============
  const ar = require(path.join(ROOT, 'scripts', 'auto-reply.js'));
  const qq = require(path.join(ROOT, 'scripts', 'qq.js'));
  const calls = [];
  qq.call = async (action, params) => {
    calls.push({ action, params });
    if (action === 'set_online_status') return { status: 'ok', retcode: 0, data: {} };
    if (action === 'get_stranger_info') return { status: 'ok', data: { nickname: '测试' } };
    return { status: 'ok', retcode: 0, data: { message_id: 1 } };
  };
  brain.think = async () => ({ reply: '在呢，刚忙完', tone: '撒娇', status: 'emo中', stickerKey: null, voice: false, writes: [] });

  const evt = (text) => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 0,
    user_id: 123456789, time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e9), message: [{ type: 'text', data: { text } }], raw_message: text
  });
  await ar.handle(evt('在吗'));
  const raw = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => {
    try { return JSON.parse(l); } catch (e) { return {}; }
  }) : [];
  ok('日志里出现 presence-model', raw.some((x) => x.event === 'presence-model'), raw.slice(-4));
  ok('模型点的状态被当真（want=emo中）', raw.some((x) => x.event === 'presence-model' && x.want === 'emo中'));
  ok('dry 演练下也走 presence 路径且不报错', !raw.some((x) => x.event === 'presence-model-error'), raw.filter((x) => /presence/.test(x.event)));
  ok('回复本身没有被标记污染', !/\[\[|语气|状态/.test(String((raw.find((x) => x.event === 'dry-send') || {}).reply || '在呢')), null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad === 0 ? 'ALL PASS' : bad + ' FAILED');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('THREW', e && e.message); process.exit(1); });
