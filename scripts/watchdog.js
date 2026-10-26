#!/usr/bin/env node
// NapCat 看门狗（带风控闸门）
// 每 30 秒探活；连续 2 次失败 → 问 risk.js 能不能重启（每日额度 / 冷却期），能才重启。
// 2026-10-23 教训：旧版无脑重启，一天重启十几次，直接把账号送进风控。
// 现在的纪律：
//   · 掉线先记一笔（risk.noteDrop）；30 分钟内掉 2 次 → 自动进入 6 小时冷却
//   · 冷却期：不重启、不拉起 auto-reply / collector，只写日志等人工确认
//   · 每天自动重启上限 2 次、登录上限 3 次、两次登录间隔 ≥10 分钟
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execSync, execFileSync } = require('child_process');
const risk = require('./risk.js');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'watchdog.log');
const TOKEN = fs.readFileSync(path.join(__dirname, 'ob11.token'), 'utf8').trim();
const INTERVAL = 30 * 1000;

function log(msg) {
  const line = new Date().toLocaleString('zh-CN', { hour12: false }) + ' ' + msg;
  for (let i = 0; i < 5; i++) {
    try {
      fs.appendFileSync(LOG, line + '\n');
      break;
    } catch (e) {
      if (i === 4) {
        try {
          fs.appendFileSync(LOG.replace(/watchdog\.log$/, 'watchdog-fallback.log'), line + '\n');
        } catch { }
        break;
      }
      const until = Date.now() + 200 * (i + 1);
      while (Date.now() < until) { }
    }
  }
  if (process.stdout.isTTY) console.log(line);
}

function alive() {
  return new Promise((res) => {
    const req = http.request(
      'http://127.0.0.1:3000/get_status',
      { method: 'POST', timeout: 3000, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } },
      (r) => { r.resume(); res(r.statusCode === 200); },
    );
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end('{}');
  });
}

function nodePids(pattern) {
  try {
    const ps =
      'powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\") | Where-Object { $_.CommandLine -like \'*' + pattern + '*\' } | Select-Object -ExpandProperty ProcessId"';
    return execSync(ps, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\s+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}
function procRunning(pattern) { return nodePids(pattern).length > 0; }

function killByPattern(pattern) {
  const pids = nodePids(pattern);
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch (e) { }
  }
  return pids;
}

function spawnDetached(args, logName) {
  const out = fs.openSync(path.join(ROOT, 'logs', logName), 'a');
  // --tls-max-v1.2：Node 24 的 TLS1.3 ClientHello 在部分链路上会被丢弃（见 scripts/net.js）
  const p = spawn('node', ['--tls-max-v1.2', ...args], { detached: true, stdio: ['ignore', out, out], cwd: ROOT });
  p.unref();
  return p;
}


// ---- 本地 RVC 换声服务端（vendor/rvc-server.py）----
const RVC_SERVER = path.join(ROOT, 'vendor', 'rvc-server.py');
const RVC_PY = path.join(ROOT, 'vendor', 'rvc', 'Scripts', 'python.exe');

function rvcConf() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config', 'rvc.json'), 'utf8');
    const c = JSON.parse(raw);
    if (!c || c.enabled !== true) return null;
    const m = /:(\d{2,5})/.exec(String(c.baseUrl || ''));
    return { port: m ? Number(m[1]) : 7898, model: c.model || '' };
  } catch (e) { return null; }
}

function spawnPython(script, args, logName) {
  const out = fs.openSync(path.join(ROOT, 'logs', logName), 'a');
  const env = { ...process.env };
  const bin = path.join(ROOT, 'vendor', 'bin');
  env.PATH = bin + path.pathsep + (env.PATH || '');
  env.HF_ENDPOINT = env.HF_ENDPOINT || 'https://hf-mirror.com';
  const p = spawn(RVC_PY, [script, ...args], { detached: true, stdio: ['ignore', out, out], cwd: ROOT, env });
  p.unref();
  return p;
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { try { sock.destroy(); } catch (e) { } resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

async function ensureRvc() {
  const c = rvcConf();
  if (!c) return;
  if (!fs.existsSync(RVC_PY) || !fs.existsSync(RVC_SERVER)) return;
  if (await portOpen(c.port)) return;
  spawnPython(RVC_SERVER, ['--host', '127.0.0.1', '--port', String(c.port)], 'rvc-server.log');
  log('[watchdog] RVC 服务端不在，已拉起（端口 ' + c.port + (c.model ? '，模型 ' + c.model : '') + '）');
}

// ---- 本地 GPT-SoVITS 零样本克隆服务端（vendor/gsv-server.py）----
const GSV_SERVER = path.join(ROOT, 'vendor', 'gsv-server.py');
const GSV_PY = path.join(ROOT, 'vendor', 'gsv310', 'Scripts', 'python.exe');
// 唯一权威启动脚本：里面写死了用哪套权重（当前 D 组合＝官方 s2 + 我方微调 s1）。
// 2026-10-26 事故：watchdog 以前直接 spawn python 且不设 GSV_S1/GSV_S2G，
// 一旦它重启服务端就会变成「纯官方 A」，与人工启动的 D 不一致 —— 必须走同一个脚本。
const GSV_LAUNCHER = path.join(ROOT, 'vendor', 'start-gsv.cmd');

function gsvConf() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config', 'voice.json'), 'utf8');
    const c = JSON.parse(raw);
    const g = (c && c.gsv) || {};
    if (g.enabled !== true) return null;
    const m = /:(\d{2,5})/.exec(String(g.baseUrl || ''));
    return { port: m ? Number(m[1]) : 7899, voice: g.voice || '' };
  } catch (e) { return null; }
}

async function ensureGsv() {
  const c = gsvConf();
  if (!c) return;
  if (!fs.existsSync(GSV_PY) || !fs.existsSync(GSV_SERVER)) return;
  if (await portOpen(c.port)) return;
  // 模型首次加载要 10s 左右，先把进程拉起来，前端请求自己会等
  const out = fs.openSync(path.join(ROOT, 'logs', 'gsv-server.log'), 'a');
  const env = { ...process.env };
  const bin = path.join(ROOT, 'vendor', 'bin');
  env.PATH = bin + path.pathsep + (env.PATH || '');
  env.HF_ENDPOINT = env.HF_ENDPOINT || 'https://hf-mirror.com';
  env.NO_PROXY = '*';
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  // 优先走 start-gsv.cmd（权重组合的唯一来源）；脚本不存在才退回裸 python（退化为纯官方权重）
  const useLauncher = fs.existsSync(GSV_LAUNCHER);
  const p = useLauncher
    ? spawn('cmd.exe', ['/c', GSV_LAUNCHER], { detached: true, stdio: ['ignore', out, out], cwd: ROOT, env })
    : spawn(GSV_PY, [GSV_SERVER, '--host', '127.0.0.1', '--port', String(c.port)], { detached: true, stdio: ['ignore', out, out], cwd: ROOT, env });
  p.unref();
  log('[watchdog] GPT-SoVITS 服务端不在，已拉起（端口 ' + c.port + (c.voice ? '，音色 ' + c.voice : '') + '，启动器 ' + (useLauncher ? 'start-gsv.cmd' : 'python') + '）');
}

let fails = 0;
let lastState = null;
let coolingActive = false;

function enterCoolingMode(why) {
  if (coolingActive) return;
  coolingActive = true;
  log('[watchdog] 进入冷却：' + why);
  // 冷却期把自动化全停掉，只留人工
  const killed = [].concat(killByPattern('auto-reply'), killByPattern('collector'));
  if (killed.length) log('[watchdog] 冷却期已停止自动化进程 ' + killed.join(','));
}

async function tick() {
  const st = risk.status();
  if (st.level === 'cooling') {
    if (!coolingActive) enterCoolingMode(st.coolingWhy + '（剩余 ' + st.coolingLeftMin + ' 分钟）');
    fails = 0;
    return;
  }
  if (coolingActive && st.level !== 'cooling') {
    coolingActive = false;
    log('[watchdog] 冷却结束，恢复探活');
  }

  const ok = await alive();
  if (ok) {
    if (lastState !== 'up') log('[watchdog] NapCat 在线');
    lastState = 'up';
    fails = 0;
    if (!procRunning('collector')) {
      spawnDetached([path.join(__dirname, 'collector.js')], 'collector.log');
      log('[watchdog] collector 不在，已拉起');
    }
    if (!procRunning('auto-reply')) {
      // stdout 走单独文件：auto-reply.js 自己写 logs/autoreply.log，同文件双写会 EBUSY
      spawnDetached([path.join(__dirname, 'auto-reply.js')], 'auto-reply-console.log');
      log('[watchdog] auto-reply 不在，已拉起');
    }
    // 语音换声服务端（懒启动：config/rvc.json 没开就跳过）
    try { await ensureRvc(); } catch (e) { log('[watchdog] RVC 检查失败：' + e.message); }
    try { await ensureGsv(); } catch (e) { log('[watchdog] GPT-SoVITS 检查失败：' + e.message); }
    return;
  }

  fails++;
  log('[watchdog] 探活失败 ' + fails + '/2');
  if (fails < 2) return;

  fails = 0;
  lastState = 'down';

  // 1) 先记掉线，可能直接触发熔断
  const drop = risk.noteDrop('探活连续失败');
  if (drop.cooled) {
    enterCoolingMode(drop.state.coolingWhy);
    return;
  }

  // 2) 问闸门：今天还能重启吗
  const can = risk.canRestart();
  if (!can.ok) {
    log('[watchdog] 不自动重启：' + can.why + '（保持离线，等人工确认）');
    return;
  }

  log('[watchdog] 判定离线，开始重启（今日第 ' + (risk.status().today.restart + 1) + ' 次）…');
  try {
    risk.recordRestart();
    execFileSync('node', [path.join(__dirname, 'start-qq.js')], {
      cwd: ROOT,
      stdio: ['ignore', fs.openSync(path.join(ROOT, 'logs', 'watchdog-start.log'), 'a'), fs.openSync(path.join(ROOT, 'logs', 'watchdog-start.log'), 'a')],
      timeout: 5 * 60 * 1000,
    });
    log('[watchdog] 重启流程执行完毕');
  } catch (e) {
    log('[watchdog] 重启失败：' + (e.message || e).toString().slice(0, 200));
  }

  // 3) 重启后仍然不通 → 说明登录没成，标记登录失败（直接冷却，别反复试）
  const again = await alive();
  if (!again) {
    const st2 = risk.loginFailed('重启后仍未恢复（可能需要扫码/验证）');
    log('[watchdog] 重启后仍离线 → 进入 ' + Math.round((st2.coolingUntil - Date.now()) / 3600000) + ' 小时冷却，请人工处理');
    enterCoolingMode(st2.coolingWhy);
  }
}

// 单实例保护：已有其它 watchdog 在跑则退出（防开机自启与手动启动叠出双看门狗）
function anotherWatchdog() {
  try {
    return nodePids('watchdog').filter((n) => n !== process.pid).length > 0;
  } catch {
    return false;
  }
}
if (anotherWatchdog()) {
  console.log('[watchdog] 已有实例在运行，退出');
  process.exit(0);
}

if (process.argv.includes('--once')) {
  tick().then(() => {
    console.log(JSON.stringify(risk.status(), null, 2));
    process.exit(0);
  });
} else {
  log('[watchdog] 启动，间隔 ' + INTERVAL / 1000 + 's（风控闸门已启用）');
  tick();
  setInterval(tick, INTERVAL);
}
