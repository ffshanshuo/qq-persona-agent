#!/usr/bin/env node
// 启动 NapCat（QQ 123456789）+ 事件采集。幂等：已在线则只补 collector。
const fs = require('fs');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const NAPCAT = path.join(ROOT, 'napcat');
const LOGS = path.join(ROOT, 'logs');
const BASE = 'http://127.0.0.1:3000';
const TOKEN = fs.readFileSync(path.join(__dirname, 'ob11.token'), 'utf8').trim();
if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS);

function alive() {
  return new Promise((res) => {
    const req = http.request(
      BASE + '/get_status',
      {
        method: 'POST',
        timeout: 1500,
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
        },
      },
      (r) => {
        r.resume();
        res(r.statusCode === 200);
      },
    );
    req.on('error', () => res(false));
    req.on('timeout', () => {
      req.destroy();
      res(false);
    });
    req.end('{}');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collectorRunning() {
  const ps =
    'powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\") | Where-Object { $_.CommandLine -like \'*collector*\' } | Measure-Object | Select-Object -ExpandProperty Count"';
  try {
    const out = execSync(ps, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseInt(out.trim(), 10) > 0;
  } catch {
    return false;
  }
}

function startCollector() {
  const out = fs.openSync(path.join(LOGS, 'collector.log'), 'a');
  const p = spawn('node', [path.join(__dirname, 'collector.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: ROOT,
  });
  p.unref();
  console.log('[start-qq] collector 已启动 pid=' + p.pid);
}

(async () => {
  if (await alive()) {
    console.log('[start-qq] 已在线，跳过启动。');
  } else {
    console.log('[start-qq] 结束旧 QQ 进程...');
    try {
      execSync('taskkill /F /IM QQ.exe', { stdio: 'ignore' });
    } catch {}
    await sleep(2000);
    console.log('[start-qq] 启动 NapCat（-q 123456789）...');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const launchLog = path.join(LOGS, 'launch-' + stamp + '.log');
    let out;
    try {
      out = fs.openSync(launchLog, 'a');
    } catch (e) {
      out = fs.openSync(path.join(LOGS, 'launch-latest.log'), 'a');
    }
    console.log('[start-qq] 本次日志：' + launchLog);
    const p = spawn('cmd', ['/c', 'launcher-user.bat', '-q', '123456789'], {
      cwd: NAPCAT,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    p.unref();
    let ok = false;
    for (let i = 0; i < 45; i++) {
      await sleep(3000);
      if (await alive()) {
        ok = true;
        break;
      }
      process.stdout.write('.');
    }
    console.log(
      ok
        ? '\n[start-qq] OneBot HTTP 就绪 127.0.0.1:3000'
        : '\n[start-qq] 超时：登录未完成，可能需要手机扫码（WebUI 6099）',
    );
    if (!ok) process.exit(3);
  }
  if (collectorRunning()) console.log('[start-qq] collector 已在运行。');
  else startCollector();
  try {
    execFileSync('node', [path.join(__dirname, 'status.js')], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  } catch {}
})();
