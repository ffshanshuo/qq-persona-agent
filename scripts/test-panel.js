/**
 * test-panel.js —— 控制台（scripts/panel.js）离线自检
 *
 * 覆盖：模块清单完整性、每个状态探针都能跑、聚合接口形状、配置白名单的边界、
 * 静态页面与 HTTP 接口（临时端口，不污染 8787）。
 *
 * 全部只读：不写生产配置、不发消息。（唯一例外是读取生产 logs/ 与 config/）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
process.env.QQPANEL_PORT = '0'; // 不占用真实端口
process.env.QQRISK_DIR = path.join(ROOT, 'logs', 'risk-panel-test');
process.env.QQMODE_DIR = path.join(ROOT, 'logs', 'mode-panel-test');
process.env.AUTOREPLY_STATE = __dirname + '/../logs/autoreply-state-panel-' + process.pid + '.json';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 260) : '')); }
}

function req(port, p) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: buf }));
    });
    r.on('error', (e) => resolve({ status: 0, error: String(e.message) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

async function main() {
  const panel = require('./panel.js');

  // ── ① 模块清单 ─────────────────────────────────────
  ok('模块数量足够', panel.BLOCKS.length >= 30, panel.BLOCKS.length);
  const ids = panel.BLOCKS.map((b) => b.id);
  ok('模块 id 不重复', new Set(ids).size === ids.length);
  ok('每个模块都有中文名与作用', panel.BLOCKS.every((b) => b.name && b.role && b.role.length >= 8));
  ok('每个模块都有所属层', panel.BLOCKS.every((b) => b.layer && b.layer.length >= 2));
  ok('每个模块都有文件与探针', panel.BLOCKS.every((b) => Array.isArray(b.files) && b.files.length && typeof b.probe === 'string'));
  ok('模块引用的文件都真实存在', panel.BLOCKS.every((b) => b.files.every((f) => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p);
  })));
  const layers = [...new Set(panel.BLOCKS.map((b) => b.layer))];
  ok('至少分了 8 层', layers.length >= 8, layers);

  // ── ② 管线 ────────────────────────────────────────
  ok('管线 12 步以上', panel.PIPELINE.length >= 12, panel.PIPELINE.length);
  ok('每步都有名字与说明', panel.PIPELINE.every((s) => s.key && s.name && s.desc));

  // ── ③ 每个探针都能跑 ───────────────────────────────
  const badProbes = [];
  for (const b of panel.BLOCKS) {
    const fn = panel.PROBES[b.probe];
    if (typeof fn !== 'function') { badProbes.push(b.probe + '(缺失)'); continue; }
    let r = null, err = null;
    try { r = fn(); } catch (e) { err = e; }
    if (err || !r || !['ok', 'warn', 'bad', 'idle'].includes(r.badge)) badProbes.push(b.probe + (err ? ': ' + err.message : ': badge 不合法'));
  }
  ok('所有状态探针都能执行', badProbes.length === 0, badProbes);

  const payload = panel.blocksPayload();
  ok('blocksPayload 数量一致', payload.length === panel.BLOCKS.length);
  ok('blocksPayload 带 badge 与 facts', payload.every((b) => ['ok', 'warn', 'bad', 'idle'].includes(b.badge) && b.facts && typeof b.facts === 'object'));

  // ── ④ 聚合接口形状 ─────────────────────────────────
  const sessions = panel.sessionsPayload();
  ok('sessionsPayload 返回数组', Array.isArray(sessions));
  ok('会话项带 key/turns', sessions.length === 0 || sessions.every((s) => typeof s.key === 'string' && typeof s.turns === 'number'));
  if (sessions.length) {
    const d = panel.sessionPayload(sessions[0].key);
    ok('sessionPayload 有 ctx 视图', !!d.view && Array.isArray(d.view.history));
    ok('sessionPayload 有情绪字段', 'state' in d && 'mood' in d && 'bond' in d);
  }
  const ini = panel.initiativePayload();
  ok('initiativePayload 三组都是数组', Array.isArray(ini.list) && Array.isArray(ini.plan) && Array.isArray(ini.follow));

  // ── ⑤ 配置白名单 ───────────────────────────────────
  let rejected = false;
  try { panel.setConfig('autoreply.selfId', 1); } catch (e) { rejected = true; }
  ok('白名单拒绝随意改配置', rejected);
  const cfgOk = Object.keys(panel.CONFIG_WRITES).every((k) => {
    const [file, keys] = panel.CONFIG_WRITES[k];
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', file), 'utf8'));
    let node = j;
    for (const key of keys.slice(0, -1)) node = node && node[key];
    return node && typeof node === 'object' && keys[keys.length - 1] in node;
  });
  ok('白名单里的键都真实存在', cfgOk);
  ok('日志白名单存在', Object.values(panel.LOGS).every((f) => typeof f === 'string'));

  // ── ⑥ HTTP 冒烟（临时端口）────────────────────────
  await new Promise((r) => panel.server.listen(0, '127.0.0.1', r));
  const port = panel.server.address().port;

  const health = await req(port, '/api/health');
  ok('/api/health 200', health.status === 200 && /"ok":\s*true/.test(health.body || ''), health.body);

  const home = await req(port, '/');
  ok('首页返回 HTML', home.status === 200 && /text\/html/.test(home.type) && /QQ 控制台/.test(home.body || ''), home.status);

  const css = await req(port, '/style.css');
  ok('样式表可取', css.status === 200 && /text\/css/.test(css.type));

  const appjs = await req(port, '/app.js');
  ok('前端脚本可取', appjs.status === 200 && /javascript/.test(appjs.type));

  const blocks = await req(port, '/api/blocks');
  ok('/api/blocks 返回模块与管线', blocks.status === 200 && /"blocks"/.test(blocks.body) && /"pipeline"/.test(blocks.body));

  const ov = await req(port, '/api/overview');
  ok('/api/overview 有进程与计数', ov.status === 200 && /"counts"/.test(ov.body) && /"procs"/.test(ov.body));

  const logs = await req(port, '/api/logs?name=autoreply&lines=5');
  ok('/api/logs 能读主循环日志', logs.status === 200 && /"lines"/.test(logs.body));

  const badLog = await req(port, '/api/logs?name=../../etc/passwd');
  ok('日志接口拒绝非白名单名字', badLog.status === 400, badLog.status);

  const sess = await req(port, '/api/sessions');
  ok('/api/sessions 返回数组', sess.status === 200 && /"sessions"/.test(sess.body));

  const noKey = await req(port, '/api/session');
  ok('/api/session 缺 key 返回 400', noKey.status === 400, noKey.status);

  const unknown = await req(port, '/api/whatever');
  ok('未知接口 404', unknown.status === 404, unknown.status);

  await new Promise((r) => panel.server.close(r));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL 异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e));
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
