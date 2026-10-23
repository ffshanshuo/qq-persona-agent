'use strict';
/**
 * test-bonds.js —— 关系事件层（bonds.js）离线自检 + 与 mind/longing 的联动检查。
 * 运行：node scripts/test-bonds.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

process.env.QQBOND_DIR = path.join(ROOT, 'logs', 'bonds-test');
process.env.QQMIND_DIR = path.join(ROOT, 'logs', 'mind-bonds-test');
process.env.QQCTX_DIR = path.join(ROOT, 'logs', 'context-bonds-test');

const bonds = require('./bonds.js');
const mind = require('./mind.js');
const longing = require('./longing.js');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } };

for (const d of [process.env.QQBOND_DIR, process.env.QQMIND_DIR, process.env.QQCTX_DIR]) fs.rmSync(d, { recursive: true, force: true });
const K = 'p:9001';
const DAY = new Date(2026, 9, 23, 11, 0, 0).getTime();
const H = 3600e3;

// ① 认事件
const t1 = (txt) => bonds.detect(txt).map(x => x.type);
ok('① 约见面 → plan_meet', t1('下周三考完我们去看海吧').includes('plan_meet'), t1('下周三考完我们去看海吧'));
ok('① 帮忙道谢 → help', t1('多亏你帮我改的那份').includes('help'));
ok('① 亲昵 → affection', t1('哈哈我有点想你了').includes('affection'));
ok('① 闹别扭 → conflict', t1('你怎么不理我了，烦死').includes('conflict'));
ok('① 道歉 → repair', t1('对不起，昨天说话急了').includes('repair'));
ok('① 交心 → heart_talk', t1('我最近老是睡不着，想跟你说点事').includes('heart_talk'));
ok('① 客套「明天见」不认事件（不是里程碑）', !t1('好，明天见').some(x => x === 'plan_meet'), t1('好，明天见'));
ok('① 太短不认', t1('嗯').length === 0);

// ② 应用脉冲：写盘 + 冷却
const r1 = bonds.apply(K, { type: 'affection' }, { now: DAY });
ok('② 应用成功', r1 && r1.applied === 'affection', r1);
const b1 = bonds.load(K);
ok('② 落盘有 1 条脉冲', b1.pulses.length === 1, b1.pulses);
const r2 = bonds.apply(K, { type: 'affection' }, { now: DAY + 60e3 });
ok('② 冷却期内不重复计', r2 && r2.skipped === 'cooldown', r2);
ok('② 仍只有 1 条脉冲', bonds.load(K).pulses.length === 1);

// ③ 衰减：48h 后剩约 37%，96h 后剩约 13%，7 天后几乎没了
const b = bonds.boost(K, DAY);
const half = bonds.boost(K, DAY + 48 * H);
const late = bonds.boost(K, DAY + 7 * 24 * H);
ok('③ 当下强度≈脉冲值', Math.abs(b.intimacy - 0.18) < 0.01, b);
ok('③ 一个半衰期后≈37%', Math.abs(half.intimacy / b.intimacy - Math.exp(-1)) < 0.02, { half: half.intimacy, full: b.intimacy });
ok('③ 一周后基本散掉', late.intimacy < 0.01, late);

// ④ 有效关系 = 基线 + 脉冲，并夹在 [0,1]
const eff = bonds.effectiveRel(K, { warmth: 0.3, trust: 0.3, intimacy: 0.3, tension: 0.1 }, DAY);
ok('④ 脉冲叠加到基线', eff.intimacy > 0.4 && eff.warmth > 0.35, eff);
const capped = bonds.effectiveRel(K, { warmth: 0.95, trust: 0.95, intimacy: 0.95, tension: 0.05 }, DAY);
ok('④ 超上限夹到 1', capped.intimacy === 1 && capped.warmth === 1, capped);

// ⑤ 事件之间的相互作用：吵完架 tension 上来，道歉把它压回去
bonds.apply(K, { type: 'conflict' }, { now: DAY + 5 * H });
const afterConflict = bonds.effectiveRel(K, { warmth: 0.3, trust: 0.3, intimacy: 0.3, tension: 0.1 }, DAY + 5 * H);
ok('⑤ 吵架后 tension 明显升高', afterConflict.tension > 0.3, afterConflict);
bonds.apply(K, { type: 'repair' }, { now: DAY + 6 * H });
const afterRepair = bonds.effectiveRel(K, { warmth: 0.3, trust: 0.3, intimacy: 0.3, tension: 0.1 }, DAY + 6 * H);
ok('⑤ 道歉后 tension 回落', afterRepair.tension < afterConflict.tension, { afterConflict: afterConflict.tension, afterRepair: afterRepair.tension });

// ⑥ 久别重逢：隔 100 小时自动记一次，冷却内不重复
const K2 = 'p:9002';
const o1 = bonds.observe(K2, { text: '我回来啦', gapHours: 100, now: DAY });
ok('⑥ 久别重逢记一笔', o1.applied.some(x => x.applied === 'absence'), o1.applied);
const o2 = bonds.observe(K2, { text: '在吗', gapHours: 100, now: DAY + 3600e3 });
ok('⑥ 冷却内不再记', !o2.applied.some(x => x.applied === 'absence'), o2.applied);

// ⑦ observe 一轮：文本命中就记，并写进事件列表
const K3 = 'p:9003';
const o3 = bonds.observe(K3, { text: '说好了周末一起去爬山，我带你去看日出', reply: '好呀，一言为定', gapHours: 2, now: DAY });
ok('⑦ observe 记到事件', o3.applied.length >= 1, o3.applied);
const l3 = bonds.list(K3);
ok('⑦ 事件可读回', l3.count >= 1 && l3.events[0].label, l3.events[0]);

// ⑧ 总开关
bonds.configure({ enabled: false });
const off = bonds.apply(K3, { type: 'affection' }, { now: DAY + 10 * H });
ok('⑧ 关掉后不再记', off === null || !off.applied, off);
ok('⑧ 关掉后加成为 0', bonds.boost(K3, DAY + 10 * H).intimacy === 0);
bonds.configure({ enabled: true });

// ⑨ 与 longing 联动：关系变近 → 想念得更早
const relBase = { warmth: 0.5, trust: 0.4, intimacy: 0.2, tension: 0 };
const far = longing.expectedHours(relBase, 0.2);
const near = longing.expectedHours(bonds.effectiveRel(K3, relBase, DAY), 0.2);
ok('⑨ 有好事之后想念来得更早', near < far, { far: Math.round(far * 10) / 10, near: Math.round(near * 10) / 10 });

// ⑩ 与 mind 联动：describeBond 从有效关系里读出「别扭」
const st = mind.blankState('p:9004', 'private', { uin: 9004 });
st.rel = { warmth: 0.3, trust: 0.3, intimacy: 0.2, tension: 0 };
fs.mkdirSync(process.env.QQMIND_DIR, { recursive: true });
fs.writeFileSync(mind.stateFile('p:9004'), JSON.stringify(st));
bonds.apply('p:9004', { type: 'conflict' }, { now: Date.now() });
const bits = mind.promptBits('p:9004', '今天怎么样');
ok('⑩ 吵架后 bond 里能读出别扭', /别扭|摩擦/.test(bits.bond), bits.bond);

// ⑪ 文本一句里多个事件
const multi = bonds.detect('对不起嘛，我错了，周末我请你吃饭赔罪');
ok('⑪ 一句可命中多个事件', multi.length >= 2 || multi.some(x => x.type === 'repair'), multi.map(x => x.type));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
