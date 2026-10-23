// 历法感真模型抽样（不入生产数据）
const clock = require('./clock.js');
const brain = require('./brain.js');

const NOTE = clock.noteFor({ now: new Date(2026, 9, 23, 20, 0, 0).getTime(), facts: ['口腔医学专业学生', '正在忙期末考试'] }).note;
console.log('提示:', NOTE, '\n');

const cases = [
  '明天要不要一起出去玩？',
  '周末有空吗，想去看海',
  '今天几号啊',
  '中秋快乐呀'
];

(async () => {
  for (const text of cases) {
    const out = await brain.think({
      kind: 'private',
      nick: '好友A',
      text,
      note: NOTE,
      history: []
    });
    console.log(`对方: ${text}`);
    console.log(`DSH : ${out.reply || '(空)'}   [${out.model} ${out.ms}ms]\n`);
  }
})();
