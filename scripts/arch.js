#!/usr/bin/env node
'use strict';
/**
 * arch.js —— 架构清点器：把「这套系统现在到底有哪些层、谁依赖谁、测没测」从代码里真读出来
 *
 * 为什么需要它：脚本已经四十多个，README 靠手工维护必然漂移。这个脚本每次从磁盘现读
 * （标题、导出、require 边、环境变量、配置、日志目录、测试注册），生成 ARCHITECTURE.md，
 * 并用 --check 报出「没分层 / 测试没注册 / 注册了没文件 / 残留补丁脚本」这几类不一致。
 *
 *   用法：
 *     node scripts/arch.js            # 重新生成 ARCHITECTURE.md 并打印摘要
 *     node scripts/arch.js --check    # 只检查一致性（有问题 exit 1）
 *     node scripts/arch.js --json     # 输出机器可读清单
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CONFIG = path.join(ROOT, 'config');
const OUT = path.join(ROOT, 'ARCHITECTURE.md');

// 分层是唯一的「人工维护」部分：新增模块要在这里归一次类，arch --check 会提醒。
const LAYERS = [
  { id: 'entry', name: '入口与运维', why: '进程怎么起、怎么活、怎么停', files: [
    'auto-reply.js', 'watchdog.js', 'start-qq.js', 'stop-qq.js', 'status.js', 'collector.js', 'setup-http.js', 'enable-ws.js', 'arch.js'] },
  { id: 'orchestrate', name: '请求编排', why: '从 auto-reply 里拆出来的两块：不过模型的即时指令、后台定时器', files: [
    'intercepts.js', 'timers.js', 'autonomy.js', 'selfwrite.js'] },
  { id: 'channel', name: '通道与协议', why: 'OneBot 收发、网络、语音、空间、A 通道', files: [
    'qq.js', 'net.js', 'voice.js', 'rvc.js', 'prosody.js', 'local_vc.py', 'qzone-feed.js', 'phone.js', 'wc.js', 'qr-render.js'] },
  { id: 'model', name: '模型与多模态', why: '说话与看图都从这里出', files: [
    'brain.js', 'vision.js', 'bench-models.js'] },
  { id: 'context', name: '上下文与记忆', why: '记得住、接得上、分得清场景', files: [
    'context.js', 'mind.js', 'them.js', 'quote.js', 'forward.js', 'follow.js', 'group.js', 'timeline.js'] },
  { id: 'persona', name: '情绪 · 关系 · 语气', why: '同一件事，用什么态度说', files: [
    'echo.js', 'bonds.js', 'ties.js', 'style.js', 'say.js', 'self.js', 'clock.js', 'mode.js', 'prompt.js', 'presence.js', 'murmur.js', 'persona.js'] },
  { id: 'initiative', name: '主动与承诺', why: '没人说话时它会不会开口、说到做不做', files: ['watch.js', 
    'longing.js', 'promises.js', 'nick.js'] },
  { id: 'expression', name: '表情与头像', why: '图片那一半的表达', files: [
    'stickers.js', 'sticker-fetch.js', 'avatar.js', 'avatar-src.js', 'make-avatar.js',
    'sticker_prep.py', 'avatar_prep.py', 'make-stickers.py'] },
  { id: 'safety', name: '安全与节奏', why: '别被封、别像机器', files: [
    'risk.js', 'pacing.js'] },
  { id: 'evolve', name: '自进化', why: '参数自己调、规则自己改、改完自己评估（改坏了能回滚）', files: [
    'evolve.js', 'selfmod.js'] },
  { id: 'console', name: '控制台', why: '不参与聊天链路：看状态、看会话、预演一句', files: [
    'panel.js', 'dryrun.js'] },
  { id: 'base', name: '共享基础', why: '所有模块共用的落盘工具', files: [
    'lib/store.js'] },
];

const ENTRY = new Set(['auto-reply.js', 'watchdog.js', 'collector.js', 'panel.js']);
const CLI_ONLY = new Set(['start-qq.js', 'stop-qq.js', 'status.js', 'setup-http.js', 'enable-ws.js',
  'wc.js', 'qr-render.js', 'qzone-feed.js', 'bench-models.js', 'make-avatar.js', 'voice.js', 'rvc.js', 'local_vc.py',
  'stickers.js', 'sticker-fetch.js', 'avatar.js', 'avatar-src.js', 'mind.js', 'longing.js',
  'promises.js', 'nick.js', 'follow.js', 'echo.js', 'evolve.js', 'risk.js', 'pacing.js',
  'bonds.js', 'style.js', 'quote.js', 'them.js', 'group.js', 'self.js', 'clock.js', 'say.js',
  'context.js', 'arch.js', 'dryrun.js', 'panel.js']);

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function titleOf(src, name) {
  const m = src.match(/^\s*\*\s*([^\n]*?\.(?:js|py))\s*(?:[—–-]{1,2}\s*)([^\n]*)$/m);
  if (m && m[2]) return m[2].trim().replace(/\s*[。.]$/, '');
  const m2 = src.match(/^\s*\*\s*([^\n]{4,80})$/m);
  return m2 ? m2[1].replace(/^\s*[^\s]*\.(json|md)\s*[—–-]*\s*/, '').trim() : '（无说明）';
}

function exportsOf(src) {
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
  if (m) return m[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean);
  const m2 = src.match(/module\.exports\s*=\s*(\w+)/);
  return m2 ? [m2[1]] : [];
}

function uniq(a) { return [...new Set(a)]; }

function scanModules() {
  const stats = new Map();
  for (const p of walk(SCRIPTS).concat(walk(path.join(ROOT, 'lib')))) {
    if (!/\.(js|py)$/.test(p)) continue;
    const name = path.basename(p);
    const dir = path.basename(path.dirname(p));
    const key = dir === 'lib' ? 'lib/' + name : name;
    const src = fs.readFileSync(p, 'utf8');
    const reqs = uniq([...src.matchAll(/require\(['"]\.{1,2}\/([\w./-]+?)(?:\.js)?['"]\)/g)]
      .map(m => {
        const raw = m[1];
        const base = path.basename(raw);
        return raw.startsWith('lib') || raw.startsWith('../lib') ? 'lib/' + path.basename(raw) + '.js' : base + '.js';
      }));
    stats.set(key, {
      key, name, dir, file: rel(p), lines: src.split('\n').length,
      title: titleOf(src, name),
      exports: exportsOf(src),
      requires: reqs.filter(r => r !== key),
      envs: uniq([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1])),
      configs: uniq([
        ...[...src.matchAll(/['"]([\w./-]*config\/[\w.-]+\.json)['"]/g)].map(m => path.basename(m[1])),
        ...[...src.matchAll(/['"]config['"]\s*,\s*['"]([\w.-]+\.json)['"]/g)].map(m => m[1]),
      ]),
      logs: uniq([...src.matchAll(/['"]logs\/([\w.-]+)/g)].map(m => m[1].replace(/\.jsonl?$/, ''))).slice(0, 8),
      hasTest: false, isTest: /^test-/.test(name) || name === 'test-all.js',
    });
  }
  return stats;
}

function scanTests(stats) {
  const tests = new Map();
  for (const p of walk(SCRIPTS)) {
    const name = path.basename(p);
    if (!/^test-.*\.js$/.test(name) || name === 'test-all.js') continue;
    const src = fs.readFileSync(p, 'utf8');
    const targets = uniq([...src.matchAll(/require\(['"]\.\/([\w-]+?)(?:\.js)?['"]\)/g)].map(m => m[1] + '.js'))
      .filter(t => stats.has(t) && !t.startsWith('test-'));
    tests.set(name, { name, file: rel(p), targets, src });
    for (const t of targets) { if (stats.has(t)) stats.get(t).hasTest = true; }
  }
  return tests;
}

function scanRegistry() {
  const p = path.join(SCRIPTS, 'test-all.js');
  const src = fs.readFileSync(p, 'utf8');
  const entries = [...src.matchAll(/\[\s*'([\w-]+)'\s*,\s*'([\w.-]+)'(?:\s*,\s*'[^']*')?\s*\]/g)]
    .map(m => ({ group: m[1], file: m[2] }));
  const onlineBlock = src.slice(src.indexOf('ONLINE'), src.indexOf('OFFLINE'));
  const onlineGroups = new Set([...onlineBlock.matchAll(/\[\s*'([\w-]+)'/g)].map(m => m[1]));
  return { entries, onlineGroups };
}

function scanConfigs(stats) {
  const out = [];
  for (const name of fs.readdirSync(CONFIG).filter(f => f.endsWith('.json')).sort()) {
    const src = fs.readFileSync(path.join(CONFIG, name), 'utf8');
    let keys = [];
    try { keys = Object.keys(JSON.parse(src)); } catch (e) { keys = ['（JSON 解析失败）']; }
    const usedBy = [...stats.values()].filter(s => s.configs.includes(name)).map(s => s.key);
    out.push({ name, keys: keys.filter(k => !k.startsWith('_')), usedBy, bytes: src.length });
  }
  return out;
}

function issues(stats, tests, reg, configs) {
  const out = [];
  const layered = new Set(LAYERS.flatMap(l => l.files));
  for (const l of LAYERS) for (const f of l.files) if (!stats.has(f)) out.push({ kind: 'layer-missing', detail: `分层「${l.name}」列了 ${f}，但磁盘上没有` });
  for (const s of stats.values()) {
    if (s.isTest) continue;
    if (!layered.has(s.key)) out.push({ kind: 'unlayered', detail: `${s.key} 没有归入任何层` });
  }
  const regFiles = new Set(reg.entries.map(e => e.file));
  for (const t of tests.values()) {
    if (!regFiles.has(t.name)) out.push({ kind: 'test-unregistered', detail: `${t.name} 没在 test-all.js 注册` });
  }
  for (const e of reg.entries) {
    if (!fs.existsSync(path.join(SCRIPTS, e.file))) out.push({ kind: 'registry-broken', detail: `test-all.js 注册了 ${e.file}，但文件不存在` });
  }
  const requiredBy = new Map();
  for (const s of stats.values()) for (const r of s.requires) requiredBy.set(r, (requiredBy.get(r) || 0) + 1);
  for (const s of stats.values()) {
    if (s.isTest || ENTRY.has(s.key) || CLI_ONLY.has(s.name) || s.key.startsWith('lib/') || /.py$/.test(s.name)) continue;
    if (!requiredBy.get(s.key)) out.push({ kind: 'orphan-module', detail: `${s.key} 没有被任何模块 require（可能只剩 CLI 用途，确认后可加进 CLI_ONLY）` });
  }
  for (const p of walk(SCRIPTS)) {
    if (/_[\w-]*\.cjs$/.test(p)) out.push({ kind: 'leftover-patch', detail: `残留一次性补丁脚本 ${rel(p)}` });
  }
  for (const c of configs) {
    if (!c.usedBy.length) out.push({ kind: 'config-unused', detail: `config/${c.name} 没有被任何脚本引用` });
  }
  return out;
}

function buildMarkdown(stats, tests, reg, configs, list) {
  const L = [];
  const mods = [...stats.values()].filter(s => !s.isTest);
  const totalLines = mods.reduce((n, s) => n + s.lines, 0);
  const testGroups = reg.entries.length;
  L.push('# 架构总览（自动生成，请勿手改）', '');
  L.push('> 由 `node scripts/arch.js` 从磁盘现读生成；改代码后重跑一次即可同步。');
  L.push(`> 生成时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · ${mods.length} 个模块 · ${totalLines} 行 · ${testGroups} 组自检 · ${configs.length} 份配置`, '');
  L.push('## 一句话架构', '');
  L.push('一条消息进来 → 合并/补账 → 读场景（引用、对方状态、群聊跟随）→ 读情绪与关系（回响、事件脉冲、分寸）');
  L.push('→ 拼 prompt（记忆/状态/时间/尺度）→ 本机网关抢答 → 人话自检（语气/矛盾/标记）→ 拟人化发送（打字、拆条、表情单发）', '');
  L.push('## 一次回复的真实管线', '');
  L.push('```');
  L.push('WS 事件');
  L.push('  → dispatch        连发合并（窗口 1.2s / 上限 3.5s）');
  L.push('  → decide          私聊/群聊闸门（白名单、@ 跟随、沉默窗、插话骰子）');
  L.push('  → catchupOnce     离线补账（拉历史、去重、missed 提示）');
  L.push('  → echo            对方上一句落地得怎么样（暖/冷/诉苦/敌意）→ 调 PAD');
  L.push('  → them / quote    对方此刻在干嘛 / 这条引用的是哪句话');
  L.push('  → mind.promptBits 状态、关系、联想召回（人话段）');
  L.push('  → promises        有没有到日子的约定');
  L.push('  → style           关系与心情决定尺度（档位、字数、禁玩笑）');
  L.push('  → self / clock    此刻在做什么 / 今天是什么日子');
  L.push('  → brain.think     本机网关 8326 并发抢答（2 个 combo，deadline 7s）');
  L.push('  → say / tone / them-retry  人话自检 → 太冲/矛盾/夹英文就重写一次');
  L.push('  → stripMarkers    表情指令绝不允许漏进聊天框');
  L.push('  → send            输入中状态 → 打字时长 → 拆条 → 表情单独一条 → 记账');
  L.push('  → afterSend      承诺/表情反馈/关系脉冲/记忆巩固（异步，不影响回复）');
  L.push('```', '');
  L.push('## 分层', '');
  for (const layer of LAYERS) {
    const rows = layer.files.filter(f => stats.has(f)).map(f => stats.get(f));
    if (!rows.length) continue;
    L.push(`### ${layer.name}（${layer.why}）`, '');
    L.push('| 模块 | 行数 | 作用 | 依赖 | 自检 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const s of rows.sort((a, b) => b.lines - a.lines)) {
      const dep = s.requires.length ? s.requires.length + ' 个内部模块' : '—';
      L.push(`| \`${s.key}\` | ${s.lines} | ${s.title} | ${dep} | ${s.hasTest ? '有' : '—'} |`);
    }
    L.push('');
  }
  L.push('## 依赖关系（谁 require 了谁）', '');
  L.push('| 模块 | 依赖 |');
  L.push('| --- | --- |');
  for (const s of mods.filter(m => m.requires.length).sort((a, b) => a.key.localeCompare(b.key))) {
    L.push(`| \`${s.key}\` | ${s.requires.map(r => '`' + r + '`').join(' ')} |`);
  }
  L.push('');
  L.push('## 配置（config/*.json）', '');
  L.push('| 文件 | 大小 | 顶层键 | 谁在读 |');
  L.push('| --- | --- | --- | --- |');
  for (const c of configs) {
    L.push(`| \`${c.name}\` | ${c.bytes}B | ${c.keys.slice(0, 8).join(', ')}${c.keys.length > 8 ? ' …' : ''} | ${c.usedBy.map(u => '`' + u + '`').join(' ') || '—'} |`);
  }
  L.push('');
  L.push('## 环境变量', '');
  const envMap = new Map();
  for (const s of mods) for (const e of s.envs) envMap.set(e, [...(envMap.get(e) || []), s.key]);
  L.push('| 变量 | 用途方 |');
  L.push('| --- | --- |');
  for (const [e, who] of [...envMap.entries()].sort()) L.push(`| \`${e}\` | ${who.slice(0, 4).map(w => '`' + w + '`').join(' ')} |`);
  L.push('');
  L.push('## 落盘目录（logs/）', '');
  const logMap = new Map();
  for (const s of mods) for (const d of s.logs) logMap.set(d, [...new Set([...(logMap.get(d) || []), s.key])]);
  L.push('| 目录/文件 | 写入方 |');
  L.push('| --- | --- |');
  for (const [d, who] of [...logMap.entries()].sort()) L.push(`| \`logs/${d}\` | ${who.slice(0, 3).map(w => '`' + w + '`').join(' ')} |`);
  L.push('');
  L.push('## 自检矩阵', '');
  L.push(`共 ${reg.entries.length} 组：离线 ${reg.entries.filter(e => !reg.onlineGroups.has(e.group)).length} 组、在线 ${reg.entries.filter(e => reg.onlineGroups.has(e.group)).length} 组（在线需要 NapCat + 模型）。`, '');
  L.push('| 组 | 文件 | 覆盖模块 |');
  L.push('| --- | --- | --- |');
  for (const e of reg.entries) {
    const t = tests.get(e.file);
    L.push(`| \`${e.group}\` | \`${e.file}\` | ${(t ? t.targets : []).map(x => '`' + x + '`').join(' ') || '—'} |`);
  }
  L.push('');
  L.push('## 一致性检查', '');
  if (!list.length) L.push('✅ 无问题：分层完整、每个测试都注册了、没有残留补丁脚本、每份配置都有人读。');
  else {
    L.push(`发现 ${list.length} 项：`, '');
    L.push('| 类型 | 说明 |');
    L.push('| --- | --- |');
    for (const i of list) L.push(`| ${i.kind} | ${i.detail} |`);
  }
  L.push('');
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const stats = scanModules();
  const tests = scanTests(stats);
  const reg = scanRegistry();
  const configs = scanConfigs(stats);
  const list = issues(stats, tests, reg, configs);

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      modules: [...stats.values()].filter(s => !s.isTest),
      tests: [...tests.keys()],
      registry: reg.entries,
      configs,
      issues: list,
    }, null, 2));
    return;
  }
  if (args.includes('--check')) {
    if (!list.length) { console.log('[arch] ✅ 架构一致性检查通过'); return; }
    console.log(`[arch] 发现 ${list.length} 项不一致：`);
    for (const i of list) console.log('  - [' + i.kind + '] ' + i.detail);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(OUT, buildMarkdown(stats, tests, reg, configs, list));
  const mods = [...stats.values()].filter(s => !s.isTest);
  console.log(`[arch] 已生成 ${rel(OUT)}：${mods.length} 个模块 / ${mods.reduce((n, s) => n + s.lines, 0)} 行 / ${reg.entries.length} 组自检 / ${configs.length} 份配置`);
  if (list.length) {
    console.log(`[arch] 但也有 ${list.length} 项不一致：`);
    for (const i of list) console.log('  - [' + i.kind + '] ' + i.detail);
  }
}

main();
