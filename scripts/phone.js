#!/usr/bin/env node
'use strict';
// 手机官方客户端通道（A 通道，phone.js）
// 为什么要有它：NapCat（C 通道）是注入官方客户端，能被动收消息但「主动发」和「改资料」风险最高。
// A 通道全程操作的是手机上**真正的官方 QQ**：不注入、不改包、不伪造协议，风控特征只剩「操作节奏」。
//
// 用法（手机需连上电脑，USB 调试或 adb tcpip）：
//   node scripts/phone.js probe                      # 自检：设备 / QQ 是否在前台 / 抓一屏结构
//   node scripts/phone.js ui                         # 打印当前界面可点节点
//   node scripts/phone.js send <名字或QQ号> "内容"    # 搜索会话 → 打开 → 输入 → 发送（人性化节奏）
//   node scripts/phone.js open <名字>                # 只打开会话
//   node scripts/phone.js read                       # 读当前会话最近的文字（先 open 再用）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADB = process.env.ADB_PATH || 'adb';
const QQ_PKG = process.env.QQ_PKG || 'com.tencent.mobileqq';
const DUMP = '/sdcard/dsh-ui.xml';
const LOG = path.join(ROOT, 'logs', 'phone.log');

const DEFAULTS = {
  serial: process.env.ANDROID_SERIAL || '',
  // 人性化节奏（毫秒）：命令之间随机停顿，避免"机器手速"
  stepGap: [350, 900],
  charGap: [60, 160],
  chunkSize: 6,
  sendGap: [600, 1400],
  adbTimeout: 20000
};

// 可注入执行器：测试时用 __setExec 换成桩，避免真跑 adb
let ADB_EXEC = null;
function __setExec(fn) { ADB_EXEC = fn; }

function log(item, human) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(Object.assign({ t: Date.now() }, item)) + '\n');
  } catch (e) { }
  if (process.stdout.isTTY) console.log(human || JSON.stringify(item));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rand([a, b]) { return a + Math.floor(Math.random() * Math.max(1, b - a)); }

function adb(args, opts) {
  const o = opts || {};
  const full = [];
  if (DEFAULTS.serial) full.push('-s', DEFAULTS.serial);
  full.push(...args);
  if (ADB_EXEC) {
    return ADB_EXEC(full, o);
  }
  try {
    const out = execFileSync(ADB, full, { encoding: 'utf8', timeout: o.timeout || DEFAULTS.adbTimeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 400), stderr: String((e && e.stderr) || '').slice(0, 400) };
  }
}
function shell(cmd, opts) { return adb(['shell', cmd], opts); }

function devices() {
  const r = adb(['devices']);
  if (!r.ok) return { ok: false, list: [], error: r.error };
  const list = r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [id, state] = l.split(/\s+/);
    return { id, state };
  });
  return { ok: true, list };
}
function requireDevice() {
  const d = devices();
  if (!d.ok) throw new Error('adb 不可用：' + d.error);
  const ready = d.list.filter((x) => x.state === 'device');
  if (!ready.length) throw new Error('没有已授权且在线设备（adb devices 里没有 state=device）');
  if (!DEFAULTS.serial && ready.length > 1) throw new Error('有多个设备，请用 ANDROID_SERIAL 指定一个');
  if (!DEFAULTS.serial) DEFAULTS.serial = ready[0].id;
  return ready[0];
}

// ---------- UI 抓取与解析 ----------
function dumpXml() {
  requireDevice();
  const d = shell('uiautomator dump ' + DUMP);
  if (!d.ok) throw new Error('uiautomator dump 失败：' + (d.error || d.stderr));
  const cat = shell('cat ' + DUMP);
  if (!cat.ok) throw new Error('读取 dump 失败：' + (cat.error || cat.stderr));
  return cat.out;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : '';
}
function parseBounds(s) {
  const m = String(s).match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x1, y1, x2, y2, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), w: x2 - x1, h: y2 - y1 };
}
// 解析 uiautomator dump：只留"有点用"的节点（有文字/描述，或可点）
function parseUi(xml) {
  const nodes = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const text = attr(tag, 'text');
    const desc = attr(tag, 'content-desc');
    const cls = attr(tag, 'class');
    const clickable = attr(tag, 'clickable') === 'true';
    const bounds = parseBounds(attr(tag, 'bounds'));
    if (!text && !desc && !clickable) continue;
    nodes.push({ text, desc, cls, clickable, bounds, id: attr(attr(tag, 'resource-id'), '') || attr(tag, 'resource-id') });
  }
  return nodes;
}
function label(n) { return (n.text || '') + ' ' + (n.desc || ''); }
function find(nodes, { text, desc, contains, cls, clickable }) {
  return nodes.filter((n) => {
    if (text !== undefined && n.text !== text) return false;
    if (desc !== undefined && n.desc !== desc) return false;
    if (contains && !label(n).includes(contains)) return false;
    if (cls && !String(n.cls).includes(cls)) return false;
    if (clickable !== undefined && n.clickable !== clickable) return false;
    return true;
  });
}

// ---------- 基础操作 ----------
async function tap(x, y) {
  const r = shell('input tap ' + Math.round(x) + ' ' + Math.round(y));
  await sleep(rand(DEFAULTS.stepGap));
  return r;
}
async function tapNode(n) {
  if (!n || !n.bounds) throw new Error('节点没有坐标');
  return tap(n.bounds.x, n.bounds.y);
}
async function tapText(txt, opts) {
  const nodes = parseUi(dumpXml());
  const hits = find(nodes, Object.assign({ text: txt }, opts || {}));
  if (!hits.length) throw new Error('界面上找不到文字「' + txt + '」');
  return tapNode(hits[0]);
}
async function tapContains(sub, opts) {
  const nodes = parseUi(dumpXml());
  const hits = find(nodes, Object.assign({ contains: sub }, opts || {}));
  if (!hits.length) throw new Error('界面上找不到包含「' + sub + '」的节点');
  return tapNode(hits[0]);
}
async function back() { shell('input keyevent KEYCODE_BACK'); await sleep(rand(DEFAULTS.stepGap)); }

function hasAdbKeyboard() {
  const r = shell('pm list packages | grep -i adbkeyboard');
  return r.ok && String(r.out).includes('adbkeyboard');
}
// 中文输入：优先 ADBKeyboard 广播（input text 不支持中文）；纯 ASCII 用 input text
async function inputText(text) {
  const t = String(text == null ? '' : text);
  const ascii = /^[\x20-\x7e]*$/.test(t);
  if (hasAdbKeyboard()) {
    const escaped = t.replace(/'/g, "'\\''");
    const r = shell("am broadcast -a ADB_INPUT_TEXT --es msg '" + escaped + "'");
    await sleep(rand(DEFAULTS.stepGap));
    return { ok: r.ok, via: 'adbkeyboard' };
  }
  if (!ascii) {
    throw new Error('当前设备没装 ADBKeyboard，input text 不支持中文。装法：adb install ADBKeyboard.apk 后把输入法切到 ADBKeyboard');
  }
  const escaped = t.replace(/(["'$`\\])/g, '\\$1');
  const r = shell('input text "' + escaped + '"');
  await sleep(rand(DEFAULTS.stepGap));
  return { ok: r.ok, via: 'input' };
}
// 逐段输入 + 随机停顿：模拟真人打字（一次 broadcast 整段是最容易被看出机器的地方之一）
async function typeHuman(text, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const t = String(text || '');
  // 若调用方给了 totalMs（来自 pacing.typingMs），就按「总打字时长」摊到每个输入块，
  // 而不是固定 charGap —— 这样手机上呈现出的「输入中」时长跟字数成正比。
  if (o.totalMs && t.length) {
    const chunks = Math.max(1, Math.ceil(t.length / Math.max(1, o.chunkSize)));
    const per = Math.max(50, Math.round(o.totalMs / chunks));
    for (let i = 0; i < t.length; i += o.chunkSize) {
      await inputText(t.slice(i, i + o.chunkSize));
      const j = 0.7 + Math.random() * 0.6;
      await sleep(Math.round(per * j));
    }
    await sleep(rand(o.sendGap));
    return { ok: true, via: 'paced', chunks };
  }
  if (t.length <= o.chunkSize) {
    const r = await inputText(t);
    await sleep(rand(o.sendGap));
    return r;
  }
  for (let i = 0; i < t.length; i += o.chunkSize) {
    await inputText(t.slice(i, i + o.chunkSize));
    await sleep(rand(o.charGap));
  }
  await sleep(rand(o.sendGap));
  return { ok: true, via: 'chunked' };
}

// ---------- 业务动作 ----------
async function foreground() {
  const r = shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
  return r.ok ? String(r.out).trim() : '';
}
async function launchQQ() {
  shell('monkey -p ' + QQ_PKG + ' -c android.intent.category.LAUNCHER 1');
  await sleep(2200);
}
async function ensureQQ() {
  const fg = await foreground();
  if (!fg.includes(QQ_PKG)) await launchQQ();
}
// 搜索并打开会话（QQ 首页顶部搜索框 → 输入名字/QQ号 → 点第一个结果）
async function openChat(name) {
  requireDevice();
  await ensureQQ();
  const nodes = parseUi(dumpXml());
  const search = find(nodes, { contains: '搜索' })[0] || find(nodes, { cls: 'EditText' })[0];
  if (!search) throw new Error('QQ 首页找不到搜索框（界面结构变了？先用 ui 看一屏）');
  await tapNode(search);
  await typeHuman(String(name), { chunkSize: 20 });
  await sleep(1200);
  // 结果列表里优先点"联系人/群聊"标题下的第一行
  const res = parseUi(dumpXml());
  const cand = find(res, { contains: String(name) }).filter((n) => n.bounds && n.bounds.h > 30 && n.bounds.y > 200);
  if (!cand.length) throw new Error('搜索结果里没找到「' + name + '」');
  await tapNode(cand[0]);
  await sleep(1500);
  log({ event: 'open-chat', name }, '已打开会话：' + name);
  return true;
}
async function sendMessage(text, opts) {
  const o = opts || {};
  const nodes = parseUi(dumpXml());
  const box = find(nodes, { cls: 'EditText' }).sort((a, b) => b.bounds.y - a.bounds.y)[0];
  if (!box) throw new Error('当前界面找不到输入框（是不是没在会话页？）');
  await tapNode(box);
  await typeHuman(String(text || ''), { totalMs: o.totalMs });
  const after = parseUi(dumpXml());
  const btn = find(after, { text: '发送' })[0] || find(after, { contains: '发送' })[0];
  if (btn) { await tapNode(btn); }
  else { shell('input keyevent KEYCODE_ENTER'); await sleep(rand(DEFAULTS.stepGap)); }
  log({ event: 'sent', chars: String(text || '').length }, '已发送 ' + String(text || '').length + ' 字');
  return { ok: true };
}
async function sendTo(name, text) {
  const pace = require('./pacing.js');
  const key = 'p:' + name;
  // 换人要时间：上一条如果是发给别人的，先「退出会话、回列表、重新点进去」那么久
  try {
    const tb = pace.beginTurn(key);
    if (tb.switchMs > 0) {
      log({ event: 'pace-switch', via: 'phone', to: name, from: tb.fromKey, ms: tb.switchMs });
      await sleep(tb.switchMs);
    }
  } catch (e) { log({ event: 'pace-error', phase: 'switch', err: String(e && e.message).slice(0, 160) }); }
  await openChat(name);
  const totalMs = pace.typingMs(String(text || ''));
  log({ event: 'pace-typing', via: 'phone', to: name, chars: String(text || '').length, ms: totalMs });
  const r = await sendMessage(text, { totalMs });
  return Object.assign({ to: name }, r);
}
// 读当前会话页的文字（从上到下），供 A 通道的被动回复用
async function readChat() {
  const nodes = parseUi(dumpXml());
  const texts = nodes
    .filter((n) => n.text && n.bounds && n.bounds.h > 20)
    .sort((a, b) => a.bounds.y - b.bounds.y)
    .map((n) => ({ text: n.text, y: n.bounds.y }));
  return texts;
}
async function probe() {
  const d = devices();
  if (!d.ok) return { ok: false, step: 'adb', error: d.error };
  if (!d.list.length) return { ok: false, step: 'device', error: '没有设备（adb devices 为空）', list: d.list };
  requireDevice();
  const fg = await foreground();
  const xml = dumpXml();
  const nodes = parseUi(xml);
  const inputs = nodes.filter((n) => String(n.cls).includes('EditText'));
  const interesting = nodes.filter((n) => n.text || n.desc).slice(0, 20).map((n) => ({ text: n.text, desc: n.desc, cls: String(n.cls).split('.').pop(), at: n.bounds ? [n.bounds.x, n.bounds.y] : null }));
  return {
    ok: true,
    device: DEFAULTS.serial,
    foreground: fg,
    qqForeground: fg.includes(QQ_PKG),
    adbKeyboard: hasAdbKeyboard(),
    editTexts: inputs.length,
    nodes: nodes.length,
    sample: interesting
  };
}

module.exports = {
  __setExec,
  DEFAULTS, devices, requireDevice, dumpXml, parseUi, find, label, tap, tapText, tapContains, back,
  inputText, typeHuman, hasAdbKeyboard, foreground, launchQQ, ensureQQ, openChat, sendMessage, sendTo, readChat, probe, shell, adb
};

// ---------- CLI ----------
if (require.main === module) {
  (async () => {
    const cmd = process.argv[2] || 'probe';
    const rest = process.argv.slice(3);
    try {
      if (cmd === 'probe') {
        console.log(JSON.stringify(await probe(), null, 2));
      } else if (cmd === 'ui') {
        const nodes = parseUi(dumpXml());
        for (const n of nodes.filter((x) => x.text || x.desc)) {
          console.log([n.bounds ? n.bounds.x + ',' + n.bounds.y : '-', String(n.cls).split('.').pop(), JSON.stringify(n.text || n.desc)].join('  '));
        }
        console.log('共 ' + nodes.length + ' 个节点');
      } else if (cmd === 'open') {
        console.log(JSON.stringify(await openChat(rest[0]), null, 2));
      } else if (cmd === 'send') {
        console.log(JSON.stringify(await sendTo(rest[0], rest.slice(1).join(' ')), null, 2));
      } else if (cmd === 'read') {
        console.log(JSON.stringify(await readChat(), null, 2));
      } else {
        console.log('用法: node scripts/phone.js [probe|ui|open <名字>|send <名字> <内容>|read]');
      }
    } catch (e) {
      console.error('[phone] ' + ((e && e.message) || e));
      process.exit(1);
    }
  })();
}
