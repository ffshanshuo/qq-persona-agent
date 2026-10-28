#!/usr/bin/env node
'use strict';
/**
 * scripts/test-all.js —— 一把跑完全部自检
 *
 *   node scripts/test-all.js            # 默认只跑「离线」用例（不需要 QQ/NapCat/模型）
 *   node scripts/test-all.js --all      # 连「在线」用例一起跑（需要 NapCat 在线 + 模型可用）
 *   node scripts/test-all.js --only say,typing   # 只跑名字里含这些词的
 *
 * 每个用例都是独立进程：一个崩了不影响其它，退出码表示「有失败」。
 * 输出末尾是一张汇总表，方便贴进 PR / issue。
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const OFFLINE = [
  ['context', 'test-context.js'],
  ['mind', 'test-mind.js'],
  ['bonds', 'test-bonds.js'],
  ['ties', 'test-ties.js'],
  ['presence', 'test-presence.js'],
  ['voice', 'test-voice.js'],
  ['rvc', 'test-rvc.js'],
  ['voice-choice', 'test-voice-choice.js'],
  ['burst', 'test-burst.js'],
  ['busy-defer', 'test-busy-defer.js'],
    ['hot-chat', 'test-hot-chat.js'],
  ['prosody', 'test-prosody.js'],
  ['longing', 'test-longing.js'],
  ['longing-plus', 'test-longing-plus.js'],
  ['promises', 'test-promises.js'],
  ['promises-review', 'test-promises-review.js'],
  ['say', 'test-say.js'],
  ['typing', 'test-typing.js'],
  ['pacing', 'test-pacing.js'],
  ['style', 'test-style.js'],
  ['tone', 'test-tone.js'],
  ['mode', 'test-mode.js'],
  ['persona', 'test-persona.js'],
  ['murmur', 'test-murmur.js'],
  ['echo', 'test-echo.js'],
  ['them', 'test-them.js'],
  ['clock', 'test-clock.js'],
  ['remind', 'test-remind.js'],
  ['group', 'test-group.js'],
  ['self', 'test-self.js'],
  ['autonomy', 'test-autonomy.js'],
    ['autonomy-plan', 'test-autonomy-plan.js'],
    ['watch', 'test-watch.js'],
    ['selfmod', 'test-selfmod.js'],
    ['prompt', 'test-prompt.js'],
  ['autonomy-tone', 'test-autonomy-tone.js'],
    ['selfwrite', 'test-selfwrite.js'],
  ['evolve', 'test-evolve.js'],
  ['risk', 'test-risk.js'],
  ['quote', 'test-quote.js'],
  ['quote-out', 'test-quote-out.js'],
  ['sticker-gif', 'test-sticker-gif.js'],
  ['forward', 'test-forward.js'],
  ['timeline', 'test-timeline.js'],
  ['phone', 'test-phone.js'],
  ['sticker-route', 'test-sticker-route.js'],
  ['empty-bubble', 'test-empty-bubble.js'],
  ['panel', 'test-panel.js'],
  ['sticker-combo', 'test-sticker-combo.js'],
  ['sticker-fetch', 'test-sticker-fetch.js'],
  ['sticker-learn', 'test-sticker-learn.js'],
  ['avatar', 'test-avatar.js'],
  ['avatar-chat', 'test-avatar-chat.js'],
  ['follow', 'test-follow.js'],
  ['nick', 'test-nick.js'],
];

const ONLINE = [
  ['offline-catchup', 'test-offline.js', '需要 NapCat 在线（读真实历史）'],
  ['merge-live', 'test-merge-live.js', '需要 NapCat + 模型'],
  ['longing-live', 'test-longing-live.js', '需要模型（真思考）'],
  ['remind-live', 'test-remind-live.js', '需要模型（真思考）'],
  ['clock-live', 'test-clock-live.js', '需要模型（真思考）'],
  ['promise-e2e', 'test-promise-e2e.js', '需要模型（dry 发送）'],
  ['bond-e2e', 'test-bond-e2e.js', '需要模型（dry 发送）'],
  ['mind-e2e', 'test-mind-e2e.js', '需要模型（dry 发送）'],
  ['sweep-live', 'test-sweep-live.js', '需要模型（真巩固）'],
];

function parseNumber(out) {
  // 各测试脚本的收尾行格式不完全一致，抓 "N/N passed" / "N passed" / "M passed, K failed"
  const slash = out.match(/(\d+)\s*\/\s*(\d+)\s*passed/i);
  if (slash) return { passed: Number(slash[1]), total: Number(slash[2]) };
  const m = out.match(/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i);
  if (!m) return null;
  return { passed: Number(m[1]), total: Number(m[1]) + Number(m[2] || 0) };
}

function runOne(label, file, args) {
  const target = path.join(SCRIPTS, file);
  if (!fs.existsSync(target)) return { label, file, status: 'missing', note: '脚本不存在' };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [target].concat(args || []), {
    cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const ms = Date.now() - t0;
  const out = String(r.stdout || '') + String(r.stderr || '');
  const passLine = out.trim().split('\n').reverse().find((l) => /passed/i.test(l)) || '';
  const stat = parseNumber(passLine) || { passed: null, total: null };
  const okExit = r.status === 0;
  return { label, file, ms, status: okExit ? 'ok' : 'fail', passed: stat.passed, total: stat.total, tail: passLine.trim().slice(0, 120) };
}

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 && argv[onlyIdx + 1] ? argv[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;

  const list = [...OFFLINE.map((x) => ({ label: x[0], file: x[1], online: false })),
    ...(all ? ONLINE.map((x) => ({ label: x[0], file: x[1], online: true, note: x[2] })) : [])]
    .filter((x) => !only || only.some((k) => x.label.includes(k) || x.file.includes(k)));

  console.log(`跑 ${list.length} 组自检${all ? '（含在线用例）' : '（仅离线）'}\n`);
  const results = [];
  for (const item of list) {
    process.stdout.write('  … ' + item.label.padEnd(18) + '\r');
    const r = runOne(item.label, item.file);
    results.push({ ...r, online: item.online });
    const mark = r.status === 'ok' ? '✓' : r.status === 'missing' ? '·' : '✗';
    const num = r.total ? `${r.passed}/${r.total}` : '';
    console.log(`  ${mark} ${item.label.padEnd(18)} ${String(r.ms).padStart(6)}ms  ${num}  ${r.status === 'ok' ? '' : r.tail || ''}`);
  }

  // 架构一致性（分层完整 / 每个测试都注册了 / 没有残留补丁脚本 / 每份配置都有人读）
  let archOk = true;
  if (!only) {
    const arch = spawnSync(process.execPath, [path.join(SCRIPTS, 'arch.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    archOk = arch.status === 0;
    console.log(`
  架构检查  ${archOk ? '✓ 通过' : '✗ 有不一致'}`);
    if (!archOk) {
      const lines = String(arch.stdout || '').trim().split(/\r?\n/).slice(0, 8);
      console.log(lines.join('\n'));
    }
  }

  const bad = results.filter((r) => r.status === 'fail');
  const ok = results.filter((r) => r.status === 'ok');
  const sumPassed = results.reduce((n, r) => n + (r.passed || 0), 0);
  const sumTotal = results.reduce((n, r) => n + (r.total || 0), 0);

  console.log('\n' + '─'.repeat(64));
  console.log(`汇总：${ok.length}/${results.length} 组通过 · 断言 ${sumPassed}/${sumTotal}${bad.length ? ` · 失败 ${bad.length} 组` : ''}`);
  if (bad.length) {
    console.log('\n失败：');
    for (const r of bad) console.log(`  - ${r.label} (${r.file})\n    ${r.tail || '(无输出)'}`);
  }
  process.exit(bad.length || !archOk ? 1 : 0);
}

main();
