'use strict';
/**
 * rvc.js —— RVC（Retrieval-based Voice Conversion）渠道客户端
 *
 * 定位：本机没有 GPU / torch，跑不了 RVC 推理（模型 + hubert + rmvpe 需要 torch + 几个 GB 权重），
 * 所以这里只做**【换声客户端】**：把 edge-tts/SAPI 合成好的 wav 传给一台跑着 RVC 服务的机器，
 * 拿回「同一个说话人、换成目标音色」的音频，再由 NapCat 转 silk 发出去。
 * 也就是说：语气/节奏/停顿仍由 prosody 控制（换声不会改语速语调，只改音色），这正是 RVC 的好处。
 *
 * 兼容的三种服务端（都能用，路径/字段名可配）：
 *  1. RVC-Project/Retrieval-based-Voice-Conversion-WebUI（api_240604.py 的 FastAPI 皮）：POST /voice2voice
 *     multipart: files(音频) + model_name + index_rate + f0_up_key + protect + method + format
 *  2. Applio（`python app.py --api`）：多数学术分支也是 /voice2voice 或 /voice_changer
 *  3. 任何自建服务：把 convertPath / fields / responseType 配成自己的约定即可
 *
 * 设计纪律：
 *  - 一律**不阻塞主链路**：probe 2.5s、convert 默认 60s 超时；失败就让 voice.js 回落 edge-tts。
 *  - 结果按输入文件 md5 缓存到 logs/rvc/，同一句话重复合成不再跑一遍（演练也会命中缓存）。
 *  - 只读不写远端：除了 POST 转换请求，不做任何远端状态修改。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const store = require('../lib/store.js');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = process.env.RVC_CONFIG || path.join(ROOT, 'config', 'rvc.json');
const DEFAULTS = {
  enabled: false,                       // 默认关：必须先有一台跑着 RVC 的机器（或本机装了 torch）
  baseUrl: 'http://127.0.0.1:7897',     // RVC WebUI 的 api_240604.py 默认端口 7897
  convertPath: '/voice2voice',
  modelsPath: '/models',
  healthPath: '/docs',                  // FastAPI 的文档页，只要 200 就算活着
  model: '',                            // 目标音色模型名（服务端 assets/weights 里的 xxx.pth 去掉后缀）
  indexRate: 0.75,
  f0UpKey: 0,                           // 男转女常 +12，女转男 -12
  protect: 0.33,
  method: 'rmvpe',
  format: 'wav',
  timeoutMs: 60000,
  probeMs: 2500,
  cache: true,
  cacheHours: 72,
  maxInputBytes: 35 * 1024 * 1024,
  fallback: 'edge',                     // 失败时 voice.js 回落到谁
  _note: 'RVC 换声渠道：把合成好的 wav 发到 RVC 服务端换音色。本机无 GPU，默认关。'
};

function loadCfg() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { j = {}; }
  const merged = { ...DEFAULTS, ...(j || {}) };
  // 环境变量优先（便于临时试另一台机器）
  if (process.env.RVC_BASE_URL) merged.baseUrl = process.env.RVC_BASE_URL;
  if (process.env.RVC_MODEL) merged.model = process.env.RVC_MODEL;
  if (process.env.RVC_ENABLED === '1') merged.enabled = true;
  if (process.env.RVC_DISABLED === '1') merged.enabled = false;
  return merged;
}

function dirOf() { return process.env.QQRVC_DIR || path.join(ROOT, 'logs', 'rvc'); }
function ensureDir() { const d = dirOf(); fs.mkdirSync(d, { recursive: true }); return d; }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

// ---------- 注入点：测试里换成假 HTTP，生产用真 http/https ----------
let HTTP_IMPL = null;
let CURL_IMPL = null;   // 测试打桩：同步转换走的 curl
function __setHttp(fn) { HTTP_IMPL = fn; }
function __setCurl(fn) { CURL_IMPL = fn; }

function rawRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = 20000 }) {
  if (typeof HTTP_IMPL === 'function') return HTTP_IMPL({ method, url, headers, body, timeoutMs });
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, why: 'bad-url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, why: 'net:' + (e && e.message) }));
    if (body) req.write(body);
    req.end();
  });
}

// ---------- 探活 / 列模型 ----------
let _probeCache = { at: 0, value: null };
function probe(now) {
  const cfg = loadCfg();
  const t = Number(now) || Date.now();
  if (_probeCache.value && t - _probeCache.at < 60000) return Promise.resolve(_probeCache.value);
  if (!cfg.enabled) {
    const v = { ok: false, why: 'disabled', baseUrl: cfg.baseUrl, models: [] };
    _probeCache = { at: t, value: v };
    return Promise.resolve(v);
  }
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  return rawRequest({ url: base + cfg.modelsPath, timeoutMs: cfg.probeMs }).then((r) => {
    if (r && r.ok && r.body) {
      let models = [];
      try {
        const j = JSON.parse(String(r.body));
        if (Array.isArray(j)) models = j.map((x) => (typeof x === 'string' ? x : x && (x.name || x.model_name))).filter(Boolean);
        else if (j && Array.isArray(j.models)) models = j.models.map((x) => (typeof x === 'string' ? x : x && (x.name || x.model_name))).filter(Boolean);
      } catch (e) { /* 服务端可能直接返回 HTML，探测只当活着 */ }
      const v = { ok: true, baseUrl: base, models, model: models.indexOf(cfg.model) >= 0 ? cfg.model : (models[0] || cfg.model), ms: 0 };
      _probeCache = { at: t, value: v };
      return v;
    }
    // /models 不通就退一步看 /docs（FastAPI 一定有）
    return rawRequest({ url: base + cfg.healthPath, timeoutMs: cfg.probeMs }).then((r2) => {
      const v = r2 && r2.ok
        ? { ok: true, baseUrl: base, models: [], model: cfg.model, why: 'health-only' }
        : { ok: false, baseUrl: base, models: [], why: (r && r.why) || (r2 && r2.why) || ('status:' + (r2 && r2.status)) };
      _probeCache = { at: t, value: v };
      return v;
    });
  });
}
function clearProbe() { _probeCache = { at: 0, value: null }; }

// ---------- 转换 ----------
function multipart(fields, file) {
  const boundary = '----rvc' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v == null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name || 'input.wav'}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

function cacheFileOf(inputBuf, cfg) { return path.join(ensureDir(), md5(inputBuf) + '.' + (cfg.format || 'wav')); }

/**
 * convert(filePath, opts) -> { ok, path, bytes, ms, model, cached } | { ok:false, why }
 */
function convert(filePath, opts) {
  const o = opts || {};
  const cfg = { ...loadCfg(), ...(o.cfg || {}) };
  const model = o.model || cfg.model;
  if (!cfg.enabled) return Promise.resolve({ ok: false, why: 'disabled' });
  if (!model) return Promise.resolve({ ok: false, why: 'no-model' });
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (e) { return Promise.resolve({ ok: false, why: 'no-input' }); }
  if (buf.length > Number(cfg.maxInputBytes)) return Promise.resolve({ ok: false, why: 'input-too-big' });
  const cachePath = cacheFileOf(buf, cfg);
  if (cfg.cache !== false && fs.existsSync(cachePath)) {
    const st = fs.statSync(cachePath);
    if (Date.now() - st.mtimeMs < Number(cfg.cacheHours || 72) * 3600e3) {
      return Promise.resolve({ ok: true, path: cachePath, bytes: st.size, ms: 0, model, cached: true });
    }
  }
  const fields = {
    model_name: model,
    index_rate: cfg.indexRate,
    f0_up_key: cfg.f0UpKey,
    protect: cfg.protect,
    method: cfg.method,
    format: cfg.format
  };
  if (o.fields) Object.assign(fields, o.fields);
  const mp = multipart(fields, { name: path.basename(filePath), buffer: buf });
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const t0 = Date.now();
  return rawRequest({
    method: 'POST', url: base + (o.convertPath || cfg.convertPath),
    headers: { 'content-type': mp.contentType, 'content-length': String(mp.body.length) },
    body: mp.body, timeoutMs: Number(cfg.timeoutMs) || 60000
  }).then((r) => {
    const ms = Date.now() - t0;
    if (!r || !r.ok) return { ok: false, why: (r && r.why) || ('status:' + (r && r.status)), ms };
    const ct = String((r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '');
    // 情况一：直接回音频字节流
    if (/audio|octet-stream/.test(ct) || isRiff(r.body) || isFtypOrOgg(r.body)) {
      fs.writeFileSync(cachePath, r.body);
      return { ok: true, path: cachePath, bytes: r.body.length, ms, model };
    }
    // 情况二：回 JSON（{path: '...'} 之类），把路径当本地文件读；读不到算失败
    try {
      const j = JSON.parse(String(r.body));
      const p = j && (j.path || j.file || j.output || j.audio);
      if (p && fs.existsSync(p)) {
        const b = fs.readFileSync(p);
        fs.writeFileSync(cachePath, b);
        return { ok: true, path: cachePath, bytes: b.length, ms, model };
      }
      return { ok: false, why: 'json-no-file', ms };
    } catch (e) {
      // 兜底：有些服务不带 content-type 但确实是 wav
      if (r.body && r.body.length > 44 && isRiff(r.body)) {
        fs.writeFileSync(cachePath, r.body);
        return { ok: true, path: cachePath, bytes: r.body.length, ms, model };
      }
      return { ok: false, why: 'not-audio', ms };
    }
  });
}

function isRiff(b) { return b && b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WAVE'; }
function isFtypOrOgg(b) { if (!b || b.length < 12) return false; const h = b.slice(0, 4).toString(); return h === 'OggS' || b.slice(4, 8).toString() === 'ftyp'; }

function status() {
  const cfg = loadCfg();
  return {
    enabled: cfg.enabled, baseUrl: cfg.baseUrl, model: cfg.model,
    cacheDir: dirOf(), cached: (() => { try { return fs.readdirSync(dirOf()).length; } catch (e) { return 0; } })(),
    note: cfg.enabled ? '' : '未启用（本机无 GPU/torch，需要一台跑着 RVC 服务的机器）'
  };
}
function resetCache() {
  const d = dirOf();
  try { for (const f of fs.readdirSync(d)) fs.unlinkSync(path.join(d, f)); } catch (e) { /* ignore */ }
  return { ok: true };
}


/**
 * convertSync(filePath, opts) —— 同步版（voice.synth 是同步 API，不能改成 async）
 * 用系统 curl 发 multipart，避免把整条语音链路改成异步。
 * 返回 { ok, path, bytes, ms, model, cached } | { ok:false, why }
 */
function convertSync(filePath, opts) {
  const o = opts || {};
  const cfg = { ...loadCfg(), ...(o.cfg || {}) };
  const model = o.model || cfg.model;
  if (!cfg.enabled) return { ok: false, why: 'disabled' };
  if (!model) return { ok: false, why: 'no-model' };
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (e) { return { ok: false, why: 'no-input' }; }
  if (buf.length > Number(cfg.maxInputBytes)) return { ok: false, why: 'input-too-big' };
  const cachePath = cacheFileOf(buf, cfg);
  if (cfg.cache !== false && fs.existsSync(cachePath)) {
    const st = fs.statSync(cachePath);
    if (Date.now() - st.mtimeMs < Number(cfg.cacheHours || 72) * 3600e3) {
      return { ok: true, path: cachePath, bytes: st.size, ms: 0, model, cached: true };
    }
  }
  const outTmp = path.join(ensureDir(), 'resp-' + process.pid + '-' + Date.now() + '.' + (cfg.format || 'wav'));
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const timeoutSec = Math.max(5, Math.round((Number(cfg.timeoutMs) || 60000) / 1000));
  const args = ['-s', '--max-time', String(timeoutSec), '-o', outTmp, '-w', '%{http_code}',
    '-F', 'model_name=' + model,
    '-F', 'index_rate=' + cfg.indexRate,
    '-F', 'f0_up_key=' + cfg.f0UpKey,
    '-F', 'protect=' + cfg.protect,
    '-F', 'method=' + cfg.method,
    '-F', 'format=' + (cfg.format || 'wav'),
    '-F', 'files=@' + filePath,
    base + (o.convertPath || cfg.convertPath)];
  const t0 = Date.now();
  let status = '0';
  try {
    const runner = CURL_IMPL || ((bin, a, o) => require('child_process').execFileSync(bin, a, o));
    status = String(runner('curl', args, { timeout: (timeoutSec + 5) * 1000, windowsHide: true }) || '').trim();
  } catch (e) {
    return { ok: false, why: 'curl:' + String((e && e.message) || e).slice(0, 80), ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  let got = null;
  try { got = fs.readFileSync(outTmp); } catch (e) { got = null; }
  const cleanup = () => { try { fs.unlinkSync(outTmp); } catch (e) { /* ignore */ } };
  if (status !== '200' || !got || !got.length) { cleanup(); return { ok: false, why: 'status:' + status, ms }; }
  if (isRiff(got) || isFtypOrOgg(got)) {
    fs.writeFileSync(cachePath, got); cleanup();
    return { ok: true, path: cachePath, bytes: got.length, ms, model };
  }
  try {
    const j = JSON.parse(String(got));
    const p = j && (j.path || j.file || j.output || j.audio);
    cleanup();
    if (p && fs.existsSync(p)) {
      const b = fs.readFileSync(p);
      fs.writeFileSync(cachePath, b);
      return { ok: true, path: cachePath, bytes: b.length, ms, model };
    }
    return { ok: false, why: 'json-no-file', ms };
  } catch (e) {
    cleanup();
    return { ok: false, why: 'not-audio', ms };
  }
}

module.exports = {
  DEFAULTS, CFG_PATH, loadCfg, dirOf, ensureDir, probe, clearProbe, convert, status, resetCache,
  multipart, isRiff, __setHttp, __setCurl, rawRequest, convertSync
};

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  (async () => {
    if (cmd === 'status') console.log(JSON.stringify(status(), null, 2));
    else if (cmd === 'probe') console.log(JSON.stringify(await probe(), null, 2));
    else if (cmd === 'convert') {
      const f = args[1];
      if (!f) { console.log('用法: node scripts/rvc.js convert <音频文件> [--model 名字]'); process.exit(1); }
      const i = args.indexOf('--model');
      const r = await convert(f, { model: i >= 0 ? args[i + 1] : undefined });
      console.log(JSON.stringify(r));
    } else if (cmd === 'reset') console.log(JSON.stringify(resetCache()));
    else console.log('用法: node scripts/rvc.js [status|probe|convert <文件> [--model 名]|reset]');
  })().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message) })); process.exit(1); });
}
