/**
 * test-echo.js —— 回响层（echo.js）自检
 * 全离线：本地规则 + 状态落盘 + 与 mind.nudge / style.styleOf 的联动
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
process.env.QQECHO_DIR = path.join(ROOT, 'logs', 'echo-test');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-echo-test');
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-echo-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-echo-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-echo-test';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
process.env.QQTRACE_DIR = path.join(ROOT, 'logs', 'trace-echo-test');

const echo = require('./echo.js');
const mind = require('./mind.js');
const style = require('./style.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
try { fs.rmSync(process.env.QQECHO_DIR, { recursive: true, force: true }); } catch (e) { }
echo.configure();

const KEY = 'p:100000001';
const KEY2 = 'p:100000002';
const NOW = new Date(2026, 9, 24, 5, 0, 0).getTime();

// ── 1) 信号与判定 ──────────────────────────────────────────
const warm = { mineText: '今天有点累，早点睡吧，明天我陪你去图书馆', theirsText: '好呀好呀！那我明天八点叫你，别睡过头哈哈', mineAt: NOW - 60000, theirsAt: NOW };
const cold = { mineText: '今天有点累，早点睡吧，明天我陪你去图书馆', theirsText: '哦', mineAt: NOW - 60000, theirsAt: NOW };
const sw = echo.signals(warm), sc = echo.signals(cold);
ok('信号：算出了字数与间隔', sw.myLen === 20 && sw.gapMs === 60000, sw);
ok('信号：热词命中', sw.warmHit.includes('好呀') || sw.warmHit.includes('哈哈'), sw.warmHit);
ok('信号：冷词命中', sc.coldHit.includes('哦'), sc.coldHit);
ok('信号：冷淡短句识别', sc.coldShort === true, sc);
const jw = echo.judge(sw), jc = echo.judge(sc);
ok('热络回法判 warm', jw.kind === 'warm' && jw.score > 0.5, jw);
ok('冷淡回法判 cold', jc.kind === 'cold' && jc.score < -0.5, jc);
ok('理由是人话（含具体词）', jc.why.join(' ').includes('哦'), jc.why);

// 久回 → 扣分
const slow = echo.judge(echo.signals({ mineText: '在吗', theirsText: '嗯，刚才在忙', mineAt: NOW - 8 * 3600e3, theirsAt: NOW }));
ok('隔很久才回会被扣分', slow.score < 0, slow);
// 反问 → 加分
const asks = echo.judge(echo.signals({ mineText: '我今天吃了面', theirsText: '好吃吗？在哪家', mineAt: NOW - 30000, theirsAt: NOW }));
ok('对方反问算还在聊', asks.score > 0, asks);

// ── 2) 平滑与连续计数 ──────────────────────────────────────
const r1 = echo.observe(KEY, cold);
ok('第一次冷：streakCold=1', r1.streakCold === 1 && r1.kind === 'cold', r1);
const r2 = echo.observe(KEY, cold);
ok('第二次冷：streakCold=2', r2.streakCold === 2, r2);
ok('连续冷给的提示是「别黏、别追问」', /别黏|别追问/.test(r2.note), r2.note);
ok('平滑值向负走', r2.ema < 0, r2.ema);

const w1 = echo.observe(KEY2, warm);
ok('另一人独立记账（热）', w1.streakWarm === 1 && w1.streakCold === 0, w1);
const w2 = echo.observe(KEY2, warm);
ok('连续两次热：提示「热络」', w2.streakWarm === 2 && /热络/.test(w2.note), w2.note);
ok('热的时候 ema 为正', w2.ema > 0, w2.ema);

// 冷热交替会清零连续计数
const after = echo.observe(KEY, warm);
ok('转热后 streakCold 归零', after.streakCold === 0 && after.streakWarm === 1, after);

// ── 3) 落盘与列表 ──────────────────────────────────────────
const st = echo.load(KEY);
ok('状态已落盘可重读', st.key === KEY && st.turns >= 3, st);
ok('记录保留了最近几条', Array.isArray(st.records) && st.records.length >= 3, st.records && st.records.length);
const rows = echo.list();
ok('list 能列出多个人', rows.length >= 2, rows);

// ── 4) 情绪反拨（affectDelta）─────────────────────────────
const dw = echo.affectDelta({ kind: 'warm' });
const dc = echo.affectDelta({ kind: 'cold' });
ok('热 → 愉悦度向上', dw.pad.p > 0 && dw.rel.warmth > 0, dw);
ok('冷 → 愉悦度向下、关系只轻微回撤', dc.pad.p < 0 && dc.rel.warmth <= 0, dc);
ok('冷不给 trust 负值（不记仇）', !(dc.rel.trust < 0), dc);
ok('中性 → 什么都不变', (() => { const d = echo.affectDelta({ kind: 'neutral' }); return d.pad.p === 0 && d.rel.warmth === 0; })());

// ── 5) mind.nudge：有界小步 ────────────────────────────────
const mk = 'p:999000001';
const st0 = mind.blankState(mk, 'private', '999000001');
st0.pad = { p: 0.95, a: 0, d: 0 };
st0.rel = { warmth: 0.02, trust: 0.5, intimacy: 0.5, tension: 0 };
mind.saveState(st0);
const nudged = mind.nudge(mk, { pad: { p: 0.3 }, rel: { warmth: 0.2 } });
ok('nudge 把 PAD 夹在 1 以内', nudged.pad.p <= 1, nudged.pad);
ok('nudge 把关系夹在 0 以上', nudged.rel.warmth >= 0, nudged.rel);

// ── 6) 与 style 的联动：冷场就收着说，热络可以放松 ─────────
const rel = { intimacy: 0.7, warmth: 0.7, tension: 0.05 };
const base = style.styleOf({ rel, pad: { a: 0.2 } });
const coldStyle = style.styleOf({ rel, pad: { a: 0.2 }, echo: { streakCold: 2, streakWarm: 0, lastKind: 'cold' } });
const warmStyle = style.styleOf({ rel, pad: { a: 0.2 }, echo: { streakCold: 0, streakWarm: 2, lastKind: 'warm' } });
ok('冷场时字数上限收紧', coldStyle.maxChars < base.maxChars, { cold: coldStyle.maxChars, base: base.maxChars });
ok('冷场时不再用亲昵称呼', coldStyle.allowIntimate === false, coldStyle.allowIntimate);
ok('冷场提示里要求别黏', /别黏/.test(coldStyle.hint), coldStyle.hint);
ok('热络时提示可以放松', /放松/.test(warmStyle.hint), warmStyle.hint);
ok('没有 echo 时不提冷场', !/别黏/.test(base.hint), base.hint);
ok('echoShift 标出方向', coldStyle.echoShift === 'cold' && warmStyle.echoShift === 'warm', [coldStyle.echoShift, warmStyle.echoShift]);

// ── 7) 开关：关闭时 observe 不被调用（由调用方判断），模块本身仍可工作
echo.configure({ enabled: false });
ok('关闭后仍能算（无副作用）', typeof echo.observe === 'function' && echo.options().enabled === false);
echo.configure();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
