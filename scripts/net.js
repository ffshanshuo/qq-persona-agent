'use strict';
/**
 * net.js —— 统一出口（https 请求）
 *
 * 为什么不用全局 fetch：
 *   2026-10-23 晚实测，Node 24 的全局 fetch 连 api.kilo.ai 会在 TLS 握手阶段卡死
 *   （TCP 69ms 通，TLS 直接超时；curl 通、TLSv1.2 强制后也通）。
 *   原因基本是 TLS1.3 的 PQ 混合密钥让 ClientHello 变大，被链路 MTU 丢掉 ——
 *   典型表现就是 fetch 报 `fetch failed` / `UND_ERR_CONNECT_TIMEOUT`，而 curl 一切正常。
 *   所以这里自己发请求，默认把 maxVersion 压到 TLSv1.2；失败再退回默认（换网络环境时更稳）。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 25000, maxVersion = 'TLSv1.2', signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { ...headers },
      timeout: timeoutMs
    };
    if (maxVersion) opts.maxVersion = maxVersion;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, headers: res.headers });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout after ' + timeoutMs + 'ms')); });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** POST JSON → {status, ok, json, text}；maxVersion 失败时自动退回默认再试一次 */
async function postJson(url, body, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  let res;
  try {
    res = await request(url, { ...opts, method: 'POST', headers, body });
  } catch (e) {
    if (opts.maxVersion === false) throw e;
    res = await request(url, { ...opts, method: 'POST', headers, body, maxVersion: null });
  }
  let json = null;
  try { json = JSON.parse(res.text); } catch (e) { /* 保留原始文本给调用方判断 */ }
  return { status: res.status, ok: res.ok, text: res.text, json };
}

/** GET 文本（下载图片/网页用）；返回 Buffer 的版本见 getBuffer */
async function getText(url, opts = {}) {
  const res = await request(url, { ...opts, method: 'GET' });
  return res.text;
}

async function getBuffer(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const opts2 = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { ...(opts.headers || {}) },
      timeout: opts.timeoutMs || 25000,
      maxVersion: opts.maxVersion === false ? null : 'TLSv1.2'
    };
    const req = mod.request(opts2, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, buffer: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout after ' + (opts.timeoutMs || 25000) + 'ms')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { request, postJson, getText, getBuffer };
