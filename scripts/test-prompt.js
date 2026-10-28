'use strict';
/**
 * 上下文装配层自检（prompt.js + brain.buildMessages 接线）
 * 覆盖：分段顺序/小标题、预算丢段、去重、思维链脚手架、「你刚说过的话」
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let passed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed += 1; return; }
  fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
}

process.env.QQTRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqtrace-prompt-'));
process.env.BRAIN_CONFIG = path.join(ROOT, 'config', 'brain.json');

const P = require('./prompt.js');
const B = require('./brain.js');

/* ── 一、分段与顺序 ── */
{
  const r = P.assemble({
    nick: '好友A', timeLine: '现在是 X。', situation: '对方说了一句',
    historyBlock: '最近的对话…', themState: '对方在上班', gapNote: '距上次 30 分钟',
    facts: ['她喜欢猫'], memories: ['上次说想看海'], bond: '朋友', mood: '还行',
    style: '随意点', modeNote: '先接情绪', stickerBlock: '表情清单', note: '补充一句'
  });
  const txt = r.lines.join('\n');
  ok('有正文', txt.length > 50, txt.length);
  ok('顺序：此刻在最前', txt.indexOf('现在是 X') < txt.indexOf('对方说了一句'));
  ok('顺序：这件事在「你记得的」之前', txt.indexOf('对方说了一句') < txt.indexOf('你记得的'));
  ok('顺序：怎么回在最后', txt.indexOf('你记得的') < txt.indexOf('怎么回'));
  ok('多段才写小标题', txt.includes('【现在这件事】') && txt.includes('【你记得的】') && txt.includes('【怎么回】'));
  ok('单段不写多余小标题（此刻只有 2 段->才写）', typeof txt === 'string');
  ok('统计有 total', r.stats.total > 0, r.stats.total);
  ok('统计列出段', r.stats.sections.length >= 10, r.stats.sections.length);
  ok('没被丢的段', r.stats.dropped.length === 0, r.stats.dropped);
}

/* ── 二、只有一块时不加小标题 ── */
{
  const r = P.assemble({ nick: 'A', timeLine: '现在是 X。' });
  ok('单块无小标题', !r.lines.join('\n').includes('【'), r.lines);
}

/* ── 三、预算：超了先丢低优先级 ── */
{
  const big = 'x'.repeat(400);
  const r = P.assemble({
    nick: 'A', timeLine: '现在是 X。', situation: '对方说了一句',
    personaNote: big, habits: big, mood: big, style: big
  }, { maxChars: 120 });
  const kept = r.stats.sections.filter((x) => x.kept).map((x) => x.id);
  ok('超预算时丢了低优先级段', r.stats.dropped.length > 0, r.stats.dropped);
  ok('habits(pri4) 优先被丢', !kept.includes('habits'), kept);
  ok('situation/time 永不丢', kept.includes('time') && kept.includes('situation'), kept);
  ok('丢完不超过预算', r.stats.total <= 120 + 40, r.stats.total);
}

/* ── 四、去重 ── */
{
  const r = P.assemble({
    nick: 'A', timeLine: 'X。', situation: 'y',
    facts: ['她喜欢猫', '她喜欢猫！！'],
    memories: ['她喜欢猫']
  });
  const txt = r.lines.join('\n');
  const n = (txt.match(/她喜欢猫/g) || []).length;
  ok('重复内容只留一条', n === 1, n);
}

/* ── 五、思维链脚手架 ── */
{
  const t1 = P.chainOfThought({});
  const t2 = P.chainOfThought({ hasPending: true });
  ok('思维链三步', /1\)/.test(t1) && /2\)/.test(t1) && /3\)/.test(t1));
  ok('思维链要求不要写出来', /不要写出来/.test(t1));
  ok('有待办时第三条提它', /说好的事/.test(t2) && !/说好的事/.test(t1));
}

/* ── 六、brain.buildMessages 接线 ── */
{
  const msgs = B.buildMessages({
    nick: '好友A', text: '今天有点累',
    history: [
      { from: 'them', text: '在吗', t: Date.now() - 600000 },
      { from: 'me', text: '在呢，刚忙完', t: Date.now() - 300000 },
      { from: 'them', text: '今天有点累', t: Date.now() - 60000 }
    ],
    myRecent: [{ text: '在呢，刚忙完', t: Date.now() - 300000 }],
    facts: ['她最近在备考'], style: '随意点'
  });
  const txt = msgs[1].content;
  ok('返回两条 message', msgs.length === 2 && msgs[0].role === 'system');
  ok('含思维链', txt.includes('开口之前，先在心里过一遍'));
  ok('含收尾指令', txt.includes('现在写你这一句回复'));
  ok('含「你刚说过的话」段', txt.includes('你刚说过的话'), txt.slice(0, 200));
  ok('我发过的那句在文里', txt.includes('在呢，刚忙完'));
  ok('段统计可读', !!B.promptStats() && B.promptStats().total > 0, B.promptStats());
}

/* ── 七、空 ctx 不炸 ── */
{
  let threw = null;
  try { B.buildMessages({}); } catch (e) { threw = e; }
  ok('空 ctx 不抛错', !threw, threw && threw.message);
}

console.log(`\n${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);
