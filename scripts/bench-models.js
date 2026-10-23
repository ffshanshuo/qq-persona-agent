'use strict';
/**
 * bench-models.js —— 给「回复生成」挑模型：测延迟 + 粗看质量
 *
 * Kilo 免费池同一句话延迟抖动极大（实测 2s~30s），且有的档位会把预算烧在 reasoning 上。
 * 这里用两句真实语境的话挨个问一遍，记录：延迟、是否空答、长度、有没有助手腔/英文残留。
 *
 * 用法：node scripts/bench-models.js [--models a,b,c] [--rounds 2]
 * 结果落盘 logs/bench-models.json
 */
const fs = require('fs');
const path = require('path');
const net = require('./net.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'logs', 'bench-models.json');

const CANDIDATES = [
  'kilo-auto/free',
  'reflection/beam-free',
  'recursive/flint-v1.0:free',
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'openrouter/free',
  'liquid/lfm-2.5-2.6b:free',
  'poolside/laguna-s-2.1:free',
  'cohere/north-mini-code:free',
  'stealth/glyph-cluster'
];

const PROMPTS = [
  '对方（好友A，朋友）刚发来：「在干嘛呢？」\n你正在写代码。用一句口语回，别问「在吗」，别解释你是 AI。只输出这一句。',
  '对方（好友A，朋友）说：「今天好累啊，作业写到十二点」。用一句口语安慰，10~30 字，别列清单、别说教。只输出这一句。'
];

const url = 'https://api.kilo.ai/api/gateway/chat/completions';

function judge(text) {
  const t = String(text || '').trim();
  const issues = [];
  if (!t) issues.push('空');
  if (t.length > 90) issues.push('太长');
  if (/作为(一个)?\s*(AI|人工智能|语言模型|助手)|我是一个?(AI|机器人)/.test(t)) issues.push('助手腔');
  if (/首先|其次|综上|需要注意的是/.test(t)) issues.push('书面腔');
  if ((t.match(/[A-Za-z]{3,}/g) || []).length > 1) issues.push('英文多');
  if (!/[\u4e00-\u9fa5]/.test(t)) issues.push('没中文');
  return issues;
}

async function ask(model, prompt, timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const r = await net.postJson(url, {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.9,
      reasoning: { enabled: false },
      stream: false
    }, { timeoutMs, headers: { 'user-agent': 'dsh-our-free-model' } });
    const ms = Date.now() - t0;
    let body = r && r.text ? (typeof r.text === 'string' ? JSON.parse(r.text) : r.text) : r;
    const ch = body && body.choices && body.choices[0];
    const text = (ch && ch.message && ch.message.content) || '';
    const finish = (ch && ch.finish_reason) || '';
    return { ok: true, ms, text: String(text).trim(), finish, issues: judge(text) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e && e.message).slice(0, 120) };
  }
}

(async () => {
  const args = process.argv.slice(2);
  let models = CANDIDATES;
  let rounds = 2;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--models' && args[i + 1]) models = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
    if (args[i] === '--rounds' && args[i + 1]) rounds = Math.max(1, Number(args[i + 1]) || 2);
  }
  const rows = [];
  for (const model of models) {
    const runs = [];
    for (let r = 0; r < rounds; r++) {
      const res = await ask(model, PROMPTS[r % PROMPTS.length]);
      runs.push(res);
      const flag = res.ok ? (res.issues.length ? '问题:' + res.issues.join('/') : 'OK') : 'ERR ' + res.error;
      console.log(String(res.ms + 'ms').padEnd(8), model.padEnd(46), flag, res.ok ? JSON.stringify(res.text.slice(0, 40)) : '');
    }
    const okRuns = runs.filter(x => x.ok && x.text);
    const avg = okRuns.length ? Math.round(okRuns.reduce((a, b) => a + b.ms, 0) / okRuns.length) : null;
    const clean = okRuns.filter(x => !x.issues.length).length;
    rows.push({
      model,
      avgMs: avg,
      success: okRuns.length + '/' + runs.length,
      clean: clean + '/' + runs.length,
      sample: okRuns[0] ? okRuns[0].text.slice(0, 80) : '',
      runs
    });
  }
  rows.sort((a, b) => {
    const sc = (r) => (r.avgMs == null ? 1e9 : r.avgMs) + (r.runs.length - r.runs.filter(x => x.ok && x.text).length) * 20000;
    return sc(a) - sc(b);
  });
  console.log('\n=== 排序（快且干净在前）===');
  for (const r of rows) console.log(String(r.avgMs == null ? '—' : r.avgMs + 'ms').padEnd(8), r.model.padEnd(46), '成功', r.success, '干净', r.clean, '|', r.sample.slice(0, 30));
  try { fs.writeFileSync(OUT, JSON.stringify({ at: Date.now(), rows }, null, 2)); console.log('\n落盘 ' + OUT); } catch (e) { console.error('写文件失败', e.message); }
})();
