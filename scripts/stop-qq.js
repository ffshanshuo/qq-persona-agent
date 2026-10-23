#!/usr/bin/env node
// 停止 NapCat（QQ）与事件采集进程
const { execSync } = require('child_process');
const ps =
  'powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\") | Where-Object { $_.CommandLine -like \'*collector*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"';
try {
  execSync(ps, { stdio: 'ignore' });
} catch {}
try {
  execSync('taskkill /F /IM QQ.exe', { stdio: 'ignore' });
} catch {}
console.log('[stop-qq] collector 与 QQ 进程已结束。');
