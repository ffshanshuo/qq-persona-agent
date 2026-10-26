'use strict';
// pacing.js 离线测试：node scripts/test-pacing.js
const path = require('path');
process.env.QQPACING_DIR = path.join(__dirname, '..', 'logs', 'pacing-test');
process.env.QQMODE_DIR = __dirname + '/../logs/mode-pacing-test';
process.env.QQRISK_DIR = __dirname + '/../logs/risk-pacing-test';
process.env.QQFOLLOW_DIR = __dirname + '/../logs/follow-pacing-test';process.env.QQNICK_DIR = __dirname + '/../logs/nick-pacing-test';
process.env.QQQUOTE_DIR = __dirname + '/../logs/quotes-pacing-test';
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-pacing-' + process.pid + '.json';
try { require('fs').rmSync(process.env.QQQUOTE_DIR, { recursive: true, force: true }); } catch (e) { }
const fs = require('fs');
try { fs.rmSync(process.env.QQPACING_DIR, { recursive: true, force: true }); } catch (e) { }
const pace = require('./pacing.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  <= ' + JSON.stringify(extra) : '')); }
}

pace.configure({ enabled: true, charsPerSec: 3.2, typingBaseMs: 650, typingMinMs: 900, typingMaxMs: 12000, jitter: 0.25, switchBaseMs: 1800, switchMaxMs: 6500, switchJitter: 0.35, recentWindowMs: 20000, recentExtraMs: [200, 900], rapidCountWindowMs: 60000, rapidPenaltyMs: 700 });

// ① 打字时长与字数正相关
const t0 = pace.typingMs('');
const t1 = pace.typingMs('在');
const t2 = pace.typingMs('在的，怎么了这是');
const t3 = pace.typingMs('今天下午我打算去图书馆把那两本书还了，然后顺便去操场跑两圈，你要不要一起？');
ok('空文本也有底时（>=min）', t0 >= 900, t0);
ok('短句 > 空文本', t1 > t0 - 1, [t0, t1]);
ok('长句显著更久', t3 > t2 && t2 > t1, [t1, t2, t3]);
ok('长句不超过 typingMaxMs', t3 <= 12000, t3);
ok('极长文本仍被钳住', pace.typingMs('字'.repeat(2000)) <= 12000);

// ② 抖动：多次采样都落在 [min,max] 内，且不是常数
const samples = Array.from({ length: 120 }, () => pace.typingMs('这句话用来测抖动，长度固定')); 
const allInRange = samples.every((v) => v >= 900 && v <= 12000);
const uniq = new Set(samples).size;
ok('抖动采样都落在区间内', allInRange, samples.slice(0, 3));
ok('抖动不是固定值', uniq > 10, uniq);

// ③ 表情标记和空白不算打字时间
const withMark = pace.typingMs('[[表情:偷笑]]');
const withMarkText = pace.typingMs('[[表情:偷笑]]好呀');
ok('纯表情标记接近底时', withMark <= 1200, withMark);
ok('表情标记不计入字数', withMarkText < pace.typingMs('一二三四五六七八九十一二'), [withMarkText, pace.typingMs('一二三四五六七八九十一二')]);
ok('空白不计入', pace.typingMs('   \n  ') <= 1200);

// ④ 关掉节奏 = 0
pace.configure({ enabled: false });
ok('关闭后打字时长为 0', pace.typingMs('一二三四五') === 0);
ok('关闭后切换时长为 0', pace.switchMs('p:a', 'p:b') === 0);
pace.configure({ enabled: true });

// ⑤ 切换窗口成本
pace.configure({ enabled: true, switchBaseMs: 1800, switchMaxMs: 6500, switchJitter: 0.35, recentWindowMs: 20000, switchJitterMin: 0 });
try { fs.rmSync(process.env.QQPACING_DIR, { recursive: true, force: true }); } catch (e) { }
ok('同一个会话不产生切换等待', pace.switchMs('p:a', 'p:a') === 0);
ok('不同会话有切换等待', pace.switchMs('p:a', 'p:b') > 0);
ok('切换等待 >= 300ms', pace.switchMs('p:a', 'p:b') >= 300);
ok('切换等待 <= switchMaxMs', pace.switchMs('p:a', 'p:b') <= 6500);

// ⑥ beginTurn 记账：谁上一条、什么时候
const now0 = 1792700000000;
const b1 = pace.beginTurn('p:a', { now: now0 });
ok('首次没有上一条 → 无切换等待', b1.switchMs === 0 && b1.fromKey === '', b1);
const b2 = pace.beginTurn('p:a', { now: now0 + 1000 });
ok('同一个人再说话 → 无切换', b2.switchMs === 0 && b2.fromKey === 'p:a', b2);
const b3 = pace.beginTurn('p:b', { now: now0 + 2000 });
ok('换人 → 有切换等待', b3.switchMs > 0 && b3.fromKey === 'p:a', b3);
ok('状态文件记录了最后说话的人', pace.status(now0 + 2000).lastKey === 'p:b');

// ⑦ 一分钟内频繁换人 → 越切越慢
try { fs.rmSync(process.env.QQPACING_DIR, { recursive: true, force: true }); } catch (e) { }
const base = [];
for (let i = 0; i < 5; i++) {
  base.push(pace.beginTurn('p:k' + i, { now: now0 + i * 500 }).switchMs);
}
ok('第 1 次切换最短', base[0] <= base[base.length - 1], base);
ok('第 3 次起叠加惩罚', base[2] > base[0], base);
ok('频繁切换不超过上限', base.every((v) => v <= 6500), base);

// ⑧ touch 只记账不等待
try { fs.rmSync(process.env.QQPACING_DIR, { recursive: true, force: true }); } catch (e) { }
ok('touch 返回 key', pace.touch('p:zzz', now0) === 'p:zzz');
ok('touch 后上一条是这个会话', pace.status(now0).lastKey === 'p:zzz');

// ⑨ status 结构
const st = pace.status(now0 + 60000);
ok('status.enabled 是布尔', typeof st.enabled === 'boolean');
ok('status 有打字与切换参数', st.typing && st.typing.charsPerSec > 0 && st.switching && st.switching.base > 0, st);

// ⑩ 状态坏了也不崩
try { fs.writeFileSync(path.join(process.env.QQPACING_DIR, 'state.json'), '{bad json'); } catch (e) { }
ok('坏状态文件不抛错', (() => { try { pace.status(Date.now()); return true; } catch (e) { return false; } })());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
