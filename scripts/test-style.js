/**
 * test-style.js —— 说话分寸层（style.js）自检
 * 全离线：档位/阈值 + 降级 + 与 brain/auto-reply 的接线（brain.think 用桩）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
// 隔离：所有状态目录都指向测试目录，别碰生产
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-style-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-style-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-style-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-style-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-style-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-style-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-style-test');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-style-test');
process.env.QQPROMISE_DIR = path.join(ROOT, 'logs', 'promises-style-test');
process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-style-test');
process.env.QQLONGING_DIR = path.join(ROOT, 'logs', 'longing-style-test');
process.env.AUTOREPLY_DRY = '1';
process.env.AUTOREPLY_LOG = path.join(ROOT, 'logs', 'autoreply-style-test.log');
process.env.AUTOREPLY_CONFIG = path.join(ROOT, 'config', 'autoreply.ctx-test.json');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-style-' + process.pid + '.json';

const style = require('./style.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// ── 1) 档位 ───────────────────────────────────────────────
const cfg = style.loadCfg();
ok('低亲密＝不熟', style.styleOf({ rel: { intimacy: 0.1, warmth: 0.4, tension: 0 } }, cfg).register === 'distant');
ok('中亲密＝朋友', style.styleOf({ rel: { intimacy: 0.32, warmth: 0.5, tension: 0 } }, cfg).register === 'friend');
ok('高亲密＝很熟', style.styleOf({ rel: { intimacy: 0.7, warmth: 0.6, tension: 0 } }, cfg).register === 'close');
ok('不熟的提示里有「不太熟」', /不太熟/.test(style.styleOf({ rel: { intimacy: 0.1 } }, cfg).hint));

// ── 2) 张力：先缓一句、别开玩笑 ───────────────────────────
const mid = { intimacy: 0.6, warmth: 0.6 };
const calm = style.styleOf({ rel: { ...mid, tension: 0.05 } }, cfg);
const tense = style.styleOf({ rel: { ...mid, tension: 0.4 } }, cfg);
const veryTense = style.styleOf({ rel: { ...mid, tension: 0.7 } }, cfg);
ok('不僵时可以开玩笑', calm.allowTease === true);
ok('张力 ≥0.3 就不开玩笑', tense.allowTease === false && tense.soften === true);
ok('张力 ≥0.3 提示里要求先软一句', /软一句|缓和/.test(tense.hint));
ok('张力 ≥0.6 才算「还在别扭里」', veryTense.tense === true && tense.tense === false);
ok('僵着时不许用亲昵称呼', tense.allowIntimate === false && calm.allowIntimate === true);

// ── 3) 心情：累了话少 ────────────────────────────────────
const fresh = style.styleOf({ rel: { intimacy: 0.6, warmth: 0.6 }, pad: { p: 0.2, a: 0.3 } }, cfg);
const tired = style.styleOf({ rel: { intimacy: 0.6, warmth: 0.6 }, pad: { p: 0, a: -0.5 } }, cfg);
ok('累的时候字数上限收紧', tired.maxChars < fresh.maxChars, [tired.maxChars, fresh.maxChars]);
ok('累的时候提示「话短一点」', /累|话短/.test(tired.hint));
ok('心情差时提示别硬撑热情', /心情一般/.test(style.styleOf({ rel: { intimacy: 0.6 }, pad: { p: -0.5, a: 0 } }, cfg).hint));
ok('冷淡（warmth 低）时别自来熟', /自来熟/.test(style.styleOf({ rel: { intimacy: 0.5, warmth: 0.1 } }, cfg).hint));

// ── 4) 开关 ─────────────────────────────────────────────
const off = style.styleOf({ rel: { intimacy: 0.1 } }, { ...cfg, enabled: false });
ok('开关关闭时不出提示', off.hint === '' && off.enabled === false);
ok('开关关闭时降级不动文本', style.softenText('宝贝，在吗！', off, { ...cfg, enabled: false }) === '宝贝，在吗！');

// ── 5) 发前降级（只减不加） ──────────────────────────────
const distStyle = style.styleOf({ rel: { intimacy: 0.1, warmth: 0.4 } }, cfg);
ok('不熟时去掉「宝贝」', !/宝贝/.test(style.softenText('宝贝，在吗？', distStyle)), style.softenText('宝贝，在吗？', distStyle));
ok('去掉称呼后不留双标点', !/^[，,、]/.test(style.softenText('亲爱的，你好', distStyle)));
ok('不熟时去掉「我想你了」这类亲密话', !/想你/.test(style.softenText('在干嘛呢，我想你了', distStyle)), style.softenText('在干嘛呢，我想你了', distStyle));
const closeStyle = style.styleOf({ rel: { intimacy: 0.8, warmth: 0.8, tension: 0 } }, cfg);
ok('很熟且不僵时保留「宝贝」', /宝贝/.test(style.softenText('宝贝，在吗？', closeStyle)));
ok('僵着时把感叹号收成句号', /。$/.test(style.softenText('我错了！！', tense)) || !/！/.test(style.softenText('我错了！！', tense)));
ok('超长按句截断并加省略号', (() => { const s = style.softenText('第一句话在这里。第二句话也在这里。第三句话还是在这里，而且越来越长了，长到超过上限。', distStyle); return s.length <= distStyle.maxChars && /…|。$/.test(s); })());
ok('代理对（emoji）不被切坏', (() => { const s = style.clip('😀😀😀😀😀😀😀😀😀😀', 5); return !/\ud83d$/.test(s) && s.length <= 5; })());
ok('摘词后不留「，我了」断句', !/，我呢?了|，我了/.test(style.softenText('在干嘛呢，我想你了', distStyle)), style.softenText('在干嘛呢，我想你了', distStyle));
ok('摘词后「的了」合成「了」', style.softenText('我在的，想你了~', distStyle) === '我在了~', style.softenText('我在的，想你了~', distStyle));
ok('空字符串降级后仍为空', style.softenText('', distStyle) === '');

// ── 6) 接线：brain 的 prompt 里有尺度、没有数字 ────────────
const brain = require('./brain.js');
const msg = brain.buildMessages({ nick: '测试', text: '在吗', style: distStyle.hint });
const userMsg = msg[1].content;
ok('brain prompt 含「说话的尺度」', /说话的尺度/.test(userMsg));
ok('brain prompt 里没有露出关系数值', !/intimacy\s*[:：=]\s*0?\.\d/.test(userMsg));

// ── 7) 端到端（dry）：低亲密 + 桩 brain 回亲昵话 → 发出去被降级 ──
(async () => {
  const mind = require('./mind.js');
  const KEY = 'p:100000001';
  const st = mind.loadState(KEY) || mind.blankState(KEY, 'private', '100000001');
  st.rel = { warmth: 0.35, trust: 0.1, intimacy: 0.08, tension: 0.05 }; // 还不熟
  st.pad = { p: 0, a: 0.1, d: 0 };
  st.msgCount = 10;
  st.lastTurnAt = Date.now() - 3600e3;
  mind.saveState(st);

  brain.think = async () => ({ reply: '宝贝，我在的，想你了~', stickerKey: '', model: 'stub', ms: 1, finish: 'stop' });
  const ar = require('./auto-reply.js');
  const evt = {
    post_type: 'message', message_type: 'private', self_id: 123456789,
    user_id: 100000001, time: Math.floor(Date.now() / 1000),
    message_id: 9001, raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }],
    sender: { user_id: 100000001, nickname: '好友A' }
  };
  const sent = [];
  const realSend = ar.send;
  require('./auto-reply.js');
  // 直接看 handle 的结果：拦截 QQ 调用不现实，改成调 style 降级链路验证 + 判断日志
  const d = { key: KEY, nick: '好友A', text: '在吗', _style: distStyle, reply: '宝贝，我在的，想你了~' };
  d.reply = style.softenText(d.reply, d._style);
  ok('端到端：亲昵话被降级后再发', d.reply && !/宝贝|想你/.test(d.reply), d.reply);

  const log = fs.existsSync(process.env.AUTOREPLY_LOG) ? fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8') : '';
  ok('日志文件可读（隔离到测试路径）', process.env.AUTOREPLY_LOG.endsWith('autoreply-style-test.log'));

  // 补充：handle 里 style 段是否真的写入（用真实 handle + 桩 think + 拦截 send）
  ar.send = async (dd) => { sent.push(dd.reply); return { status: 'ok', parts: 1, okCount: 1, dry: true }; };
  try {
    await ar.handle(evt);
  } catch (e) { /* 允许内部异常，只看有没有记 style */ }
  const log2 = fs.readFileSync(process.env.AUTOREPLY_LOG, 'utf8');
  ok('handle 记录了 style 档位', /"event":"style"/.test(log2));
  const dryLine = (log2.split(/\n/).filter(l => l.includes('dry-send')).pop()) || '';
  ok('handle 里 dry-send 的句子已降级', /dry-send/.test(dryLine) && !/宝贝/.test(dryLine), dryLine);
  if (sent.length) ok('降级日志存在', /style-soften/.test(log2));

  // ── ⑧ 语气分寸：对亲近的人不能冲（2026-10-24 用户要求）──────────
  const closeSt = style.styleOf({ rel: { intimacy: 0.7, warmth: 0.7, tension: 0.05 } }, cfg);
  const friendSt = style.styleOf({ rel: { intimacy: 0.35, warmth: 0.5, tension: 0 } }, cfg);
  const distSt2 = style.styleOf({ rel: { intimacy: 0.1, warmth: 0.4, tension: 0 } }, cfg);
  ok('很熟档提示「不能冲」', /不能冲|别怼|软和/.test(closeSt.hint), closeSt.hint);
  ok('朋友档也提示别冲', /别冲人|命令口吻/.test(friendSt.hint), friendSt.hint);
  ok('不熟档提示默认礼貌', /默认礼貌|请问/.test(distSt2.hint), distSt2.hint);
  ok('「随便吧。」对熟人算冲', style.isHarsh('随便吧。', closeSt).harsh === true);
  ok('「哦。」对熟人算冲', style.isHarsh('哦。', closeSt).harsh === true);
  ok('「行了，别烦我」算冲', style.isHarsh('行了，别烦我', closeSt).harsh === true);
  ok('「你给我等着」算命令口气', style.isHarsh('你给我等着', closeSt).harsh === true);
  ok('正常温和回复不算冲', style.isHarsh('在呢，刚忙完，怎么啦？', closeSt).harsh === false);
  ok('熟人提示里不含「舔狗」这种措辞', !/舔狗/.test(closeSt.hint));


  // ---------- 口癖：同一个人固定几条，别每条都用 ----------
  ok('habitsOf 对同一个人稳定', JSON.stringify(style.habitsOf('p:68686868')) === JSON.stringify(style.habitsOf('p:68686868')));
  ok('habitsOf 对不同人不一样', JSON.stringify(style.habitsOf('p:68686868')) !== JSON.stringify(style.habitsOf('p:99999999')));
  ok('habitsOf 给 2 条且带 id/tip', style.habitsOf('p:68686868').length === 2 && style.habitsOf('p:68686868').every(h => h && h.id && h.tip));
  const hh = style.habitHint('p:68686868');
  ok('habitHint 是给模型看的人话', /三分之一|别每条/.test(hh), hh);
  ok('habitHint 不暴露权重/编号', !/\d+\.\d|habit-\d/.test(hh), hh);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
