#!/usr/bin/env node
/**
 * voice.js —— 用这个 QQ 号「发语音」。
 *
 * 路子：Windows 自带 SAPI 把文字念成 WAV（Microsoft Huihui Desktop，zh-CN 女声）
 *      → 作为 OneBot `record` 段发出去；NapCat 会自己把 WAV 转成 QQ 的 silk/amr
 *        （源码 `createValidSendPttElement` → `Ni.convertToNTSilkTct`，实测 297KB wav → 21KB）。
 *
 * CLI：
 *   node scripts/voice.js say "你好呀" --to 123456789          # 私聊发一条语音
 *   node scripts/voice.js say "开会啦" --to 200000001 --group    # 群里发语音
 *   node scripts/voice.js say "测试" --to 123456789 --delete    # 发完立刻撤回（测试用）
 *   node scripts/voice.js file assets/voice/hello.wav --to 123456789
 *   node scripts/voice.js voices                                # 列出可用中文音色
 *
 * 参数：--rate -10..10（语速）、--voice "<音色名>"、--tone <neutral|warm|comfort|playful|clingy|sleepy|serious|excited>（语气档）、--keep（保留生成的 wav）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'logs', 'voice');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DEFAULT_VOICE = 'Microsoft Huihui Desktop';
const CFG_PATH = path.join(ROOT, 'config', 'voice.json');
const PY = process.env.DSH_PYTHON
  || '$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';

const EDGE_DEFAULTS = {
  provider: 'edge',                       // edge | sapi | rvc（rvc＝先 TTS 再换音色）
  voice: 'zh-CN-XiaoxiaoNeural',          // 晓晓（女）/ 云希（男）/ 晓伊 / 云健 …
  rate: '+8%',
  pitch: '+0Hz',
  volume: '+0%',
  maxChars: 80,
  timeoutMs: 30000,
  fallback: 'sapi'
};
const store = require('../lib/store.js');
const prosody = require('./prosody.js');   // 语气/节奏层（纯算术，见 scripts/prosody.js）
const rvc = require('./rvc.js');

// GPT-SoVITS（零样本克隆）：服务端跑在 vendor/gsv-server.py，见 README §GPT-SoVITS
const GSV_DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:7899',
  voice: 'mansui-001',
  lang: 'zh',
  speed: 1.0,
  timeoutMs: 180000,
  cache: true,
  cacheHours: 24,
  fallback: 'edge',
  refByTone: {},   // 语气 → 参考音频（换参考即换语气，见 tools/build-refs.py）
  speedByTone: {},  // 语气 → 语速（婉转=慢 16%，见 logs/gsv-mansui/TRAINING-REPORT.md §5）
};
const GSV_CACHE = path.join(ROOT, 'logs', 'voice-gsv');
let GSV_IMPL = null;
let CURL_IMPL_GSV = null;
function __setGsv(fn) { GSV_IMPL = fn; }
const LOCAL_VC = process.env.LOCAL_VC || path.join(__dirname, 'local_vc.py');   // 本地轻量变声（numpy 重采样，只改音高/语速）           // RVC 换声渠道（本机只做客户端，见 scripts/rvc.js）

/** 外部可替换的执行器（测试打桩用，别在生产里设） */
let RUNNER = null;
function run(cmd, args, opt) { return (RUNNER || execFileSync)(cmd, args, opt); }
function __setRunner(fn) { RUNNER = fn || null; }

/** 读 config/voice.json（缺文件/坏文件都退回默认值） */
function loadCfg() {
  const c = store.readJson(CFG_PATH, {}, { onError: () => { } }) || {};
  return { ...EDGE_DEFAULTS, ...c };
}

/** 列出 edge-tts 的中文音色（懒加载，失败返回空数组） */
function listEdgeVoices() {
  try {
    const out = run(PY, ['-c',
      'import asyncio,json,edge_tts\n' +
      'v=asyncio.run(edge_tts.list_voices())\n' +
      'print(json.dumps([{"name":x["ShortName"],"gender":x.get("Gender","")} for x in v if x["ShortName"].startswith("zh-")],ensure_ascii=False))'
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return JSON.parse(out);
  } catch (e) { return []; }
}

/** edge-tts 合成：直接出 mp3（NapCat 那边会用 ffmpeg 转 silk，不必自己转） */
function speakEdge(text, opts = {}) {
  const cfg = { ...loadCfg(), ...opts };
  const t0 = Date.now();
  const clean = cleanText(text, Number(cfg.maxChars) || 80);
  if (!clean) throw new Error('没有可念的文字');
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
  const out = path.join(DIR, `tts-${stamp}-${process.pid}.mp3`);
  // 语气：外部传了 prosody 就用它覆盖 rate/pitch/volume（同一音色，只变这三轴）
  const ps = cfg.prosody || null;
  const rate = ps ? String(ps.rate) : String(cfg.rate || EDGE_DEFAULTS.rate);
  const pitch = ps ? String(ps.pitch) : String(cfg.pitch || EDGE_DEFAULTS.pitch);
  const volume = ps ? String(ps.volume) : String(cfg.volume || EDGE_DEFAULTS.volume);
  const args = ['-m', 'edge_tts', '--voice', String(cfg.voice || EDGE_DEFAULTS.voice),
    '--rate=' + rate,
    '--pitch=' + pitch,
    '--volume=' + volume,
    '--text', clean, '--write-media', out];
  run(PY, args, { timeout: Number(cfg.timeoutMs) || 30000, windowsHide: true });
  if (!fs.existsSync(out)) throw new Error('edge-tts 没生成文件');
  return {
    path: out, chars: clean.length, bytes: fs.statSync(out).size, ms: Date.now() - t0,
    text: clean, provider: 'edge', voice: cfg.voice,
    tone: (ps && ps.tone) || '', rate, pitch, volume,
    estSec: prosody.estimateSeconds(clean, rate)
  };
}

/**
 * GPT-SoVITS 零样本合成（同步 HTTP，走 curl；voice.synth 是同步 API）。
 * 返回 { path, chars, bytes, ms, text, provider, voice, cached? }；失败抛错由调用方回落。
 */
function gsvRefKey(voice) {
  // 参考音频/转写换了，缓存必须失效：用 wav 与 txt 的 size+mtime 做指纹
  try {
    const dir = path.join(ROOT, 'vendor', 'voices');
    const wav = path.join(dir, String(voice) + '.wav');
    const txt = path.join(dir, String(voice) + '.txt');
    const st1 = fs.statSync(wav), st2 = fs.existsSync(txt) ? fs.statSync(txt) : { size: 0, mtimeMs: 0 };
    return [st1.size, Math.round(st1.mtimeMs), st2.size, Math.round(st2.mtimeMs)].join('-');
  } catch (e) { return 'noref'; }
}

function speakGsv(text, opts = {}) {
  const cfg = { ...loadCfg(), ...opts };
  const g = { ...GSV_DEFAULTS, ...((cfg && cfg.gsv) || {}) };
  const clean = String(text == null ? "" : text).trim();
  if (!clean) throw new Error("gsv: 文本为空");
  // 语气 → 参考音频：GPT-SoVITS 换参考就等于换语气（同一音色不同情绪段），不额外增加推理成本
  const tone = String((opts.prosody && opts.prosody.tone) || opts.tone || "neutral");
  const refByTone = (g.refByTone && typeof g.refByTone === "object") ? g.refByTone : {};
  const refVoice = refByTone[tone] || g.voice;
  if (refVoice && refVoice !== g.voice) g.voice = refVoice;
  // 语气 → 语速（微调权重下也能用：speed 直接透传给 TTS 服务端）
  const speedByTone = (g.speedByTone && typeof g.speedByTone === "object") ? g.speedByTone : {};
  if (speedByTone[tone] != null && Number.isFinite(Number(speedByTone[tone]))) {
    g.speed = Number(speedByTone[tone]);
  }
  g.tone = tone;
  const t0 = Date.now();
  const key = require("crypto").createHash("md5")
    .update([clean, g.voice, String(g.speed), tone, gsvRefKey(g.voice)].join("|"))
    .digest("hex").slice(0, 20);
  const cachePath = path.join(GSV_CACHE, "gsv-" + key + ".wav");
  if (g.cache !== false && fs.existsSync(cachePath)) {
    const st = fs.statSync(cachePath);
    if (Date.now() - st.mtimeMs < Number(g.cacheHours || 24) * 3600e3) {
      return { path: cachePath, chars: clean.length, bytes: st.size, ms: 0, text: clean, provider: "gpt-sovits", voice: "gsv:" + g.voice, cached: true };
    }
  }
  if (GSV_IMPL) {
    const r = GSV_IMPL(clean, g);
    if (!r || !r.path) throw new Error("gsv: 桩没给音频");
    return { path: r.path, chars: clean.length, bytes: fs.statSync(r.path).size, ms: Date.now() - t0, text: clean, provider: "gpt-sovits", voice: "gsv:" + (r.voice || g.voice) };
  }
  try { fs.mkdirSync(GSV_CACHE, { recursive: true }); } catch (e) { /* ignore */ }
  const tmpBody = path.join(GSV_CACHE, "req-" + process.pid + "-" + Date.now() + ".json");
  const tmpOut = path.join(GSV_CACHE, "resp-" + process.pid + "-" + Date.now() + ".json");
  fs.writeFileSync(tmpBody, JSON.stringify({ text: clean, voice: g.voice, lang: g.lang, speed: g.speed }));
  const base = String(g.baseUrl).replace(/\/+$/, "");
  const timeoutSec = Math.max(10, Math.round((Number(g.timeoutMs) || 180000) / 1000));
  const args = ["-s", "--max-time", String(timeoutSec), "-o", tmpOut, "-w", "%{http_code}",
    "-X", "POST", base + "/tts",
    "-H", "Content-Type: application/json",
    "--data-binary", "@" + tmpBody];
  let status = "0";
  const cleanup = () => { for (const f of [tmpBody, tmpOut]) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } } };
  try {
    const runner = CURL_IMPL_GSV || ((bin, a, o) => require("child_process").execFileSync(bin, a, o));
    status = String(runner("curl", args, { timeout: (timeoutSec + 5) * 1000, windowsHide: true }) || "").trim();
  } catch (e) {
    cleanup();
    throw new Error("gsv:curl:" + String((e && e.message) || e).slice(0, 80));
  }
  let j = null;
  try { j = JSON.parse(fs.readFileSync(tmpOut, "utf8")); } catch (e) { j = null; }
  cleanup();
  if (status !== "200" || !j) throw new Error("gsv:status:" + status);
  if (j.status && j.status !== "success") throw new Error("gsv:" + String(j.error || j.status).slice(0, 100));
  const p = j.path || j.file || j.output || j.audio_url;
  if (!p || !fs.existsSync(p)) throw new Error("gsv:no-file");
  const buf = fs.readFileSync(p);
  fs.writeFileSync(cachePath, buf);
  return { path: cachePath, chars: clean.length, bytes: buf.length, ms: Date.now() - t0, text: clean, provider: "gpt-sovits", voice: "gsv:" + (j.voice || g.voice) };
}

/**
 * 统一合成入口：认 provider，失败按 fallback 回落。
 * @returns {{path:string, chars:number, bytes:number, ms:number, text:string, provider:string, voice?:string, fellBack?:string}}
 */
function synth(text, opts = {}) {
  const cfg = { ...loadCfg(), ...opts };
  const provider = String(cfg.provider || 'edge').toLowerCase();

  // GPT-SoVITS：零样本克隆（直接生成她的音色；CPU 上 10~20s/句，适合偶尔说一句）
  if (provider === 'gpt-sovits' || provider === 'gsv' || provider === 'gpt_sovits') {
    const g = { ...GSV_DEFAULTS, ...((cfg && cfg.gsv) || {}) };
    if (g.enabled !== false) {
      try {
        const s = speakGsv(text, cfg);
        return { ...s, baseProvider: undefined };
      } catch (e) {
        const fb = String(g.fallback || 'edge');
        const w = baseSynth(text, { ...cfg, provider: fb === "sapi" ? "sapi" : "edge" });
        return { ...w, fellBack: 'gsv->' + fb, gsvWhy: String((e && e.message) || e).slice(0, 120) };
      }
    }
    return baseSynth(text, { ...cfg, provider: "edge" });
  }

  // RVC：先用基础 TTS 把人声说出来（语气/节奏在这一步定型），再把 wav 送去换音色
  if (provider === 'rvc') {
    const base = baseSynth(text, { ...cfg, provider: String(cfg.rvcBase || 'edge').toLowerCase() });
    const r = rvc.convertSync(base.path, { cfg: { ...rvc.loadCfg(), ...(cfg.rvc || {}) }, model: cfg.rvc && cfg.rvc.model });
    if (r && r.ok) {
      return { path: r.path, chars: base.chars, bytes: r.bytes, ms: base.ms + r.ms, text: base.text, provider: 'rvc', voice: 'rvc:' + (r.model || ''), baseProvider: base.provider, converted: true };
    }
    // 换声失败：如果开了 localShift，就先做本地变声（听起来和默认音色不同），否则按 fallback 回落
    if (cfg.localShift && cfg.localShift.enabled !== false) {
      try {
        const s = shiftLocal(text, cfg);
        return { ...s, fellBack: 'rvc->local', rvcWhy: (r && r.why) || 'failed' };
      } catch (e) { /* 本地变声也失败就继续往回落 */ }
    }
    // 换声失败就回落（默认 edge）：宁可音色没换，也别把这条语音吞掉
    const fb = String((cfg.rvc && cfg.rvc.fallback) || 'edge');   // 换声失败默认回落 edge（voice.fallback 是 edge→sapi 的兜底，别混用）
    const w = baseSynth(text, { ...cfg, provider: fb === 'sapi' ? 'sapi' : 'edge' });
    return { ...w, fellBack: 'rvc->' + fb, rvcWhy: (r && r.why) || 'failed' };
  }

  return baseSynth(text, cfg);
}

/**
 * 本地轻量变声：SAPI 出 wav → local_vc.py 重采样改音高/语速。
 * 只是「听起来不一样」的占位，真换音色仍然要 RVC。
 */
function shiftLocal(text, cfg) {
  const w = speakToWav(text, cfg);
  const pitch = Number((cfg && cfg.localShift && cfg.localShift.pitch) || 1.12);
  const out = String(w.path).replace(/\.wav$/i, '') + '-shift.wav';
  const t0 = Date.now();
  run(PY, [LOCAL_VC, '--pitch', String(pitch), w.path, out], { timeout: Number(cfg && cfg.timeoutMs) || 30000, windowsHide: true });
  if (!fs.existsSync(out)) throw new Error('local_vc.py 没生成文件');
  return { path: out, chars: w.chars, bytes: fs.statSync(out).size, ms: (w.ms || 0) + (Date.now() - t0), text: w.text, provider: 'local-shift', voice: 'local:' + pitch, baseProvider: 'sapi' };
}

/** 不带 RVC 的基础合成（edge → 失败回落 sapi） */
function baseSynth(text, opts = {}) {
  const cfg = { ...loadCfg(), ...opts };
  const provider = String(cfg.provider || 'edge').toLowerCase();
  if (provider === 'sapi') return { ...speakToWav(text, cfg), provider: 'sapi', voice: DEFAULT_VOICE };
  try {
    return speakEdge(text, cfg);
  } catch (e) {
    if (String(cfg.fallback || 'sapi') !== 'sapi') throw e;
    const w = speakToWav(text, cfg);
    return { ...w, provider: 'sapi', voice: DEFAULT_VOICE, fellBack: String(e && e.message).slice(0, 120) };
  }
}

/** 去掉念不出来的东西：CQ 码、markdown 符号、纯 emoji；超长按句号截断 */
function cleanText(s, maxChars = 0) {
  let t = String(s || '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/[`*_>#~|]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 节奏：把书面符号换成会让 TTS 停顿的标点（波浪号→省略号、顿号→逗号、去掉括号补充）
  t = prosody.paceText(t);
  const limit = Number(maxChars);
  if (Number.isFinite(limit) && limit > 0 && t.length > limit) {
    const cut = t.slice(0, maxChars);
    const dot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'));
    t = (dot > maxChars * 0.4 ? cut.slice(0, dot) : cut) + '…';
  }
  return t;
}

function listVoices() {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + " | " + $_.VoiceInfo.Culture }'
  ].join('; ');
  const out = execFileSync(PS, ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return out.trim().split(/\r?\n/).filter(Boolean);
}

/**
 * 文字 → WAV（用 System.Speech）。返回 {path, chars, ms}
 * 中文文本写文件再读，避免命令行编码/引号问题。
 */
function speakToWav(text, opts = {}) {
  const clean = cleanText(text, opts.maxChars || 120);
  if (!clean) throw new Error('没有可念的文字（全是表情/符号？）');
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const wav = path.join(DIR, `tts-${stamp}.wav`);
  const txtFile = path.join(DIR, `tts-${stamp}.txt`);
  const ps1 = path.join(DIR, `tts-${stamp}.ps1`);
  fs.writeFileSync(txtFile, clean, 'utf8');
  fs.writeFileSync(ps1, [
    'Add-Type -AssemblyName System.Speech',
    '$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$sp.SelectVoice($env:TTS_VOICE)`,
    '$sp.Rate = [int]$env:TTS_RATE',
    '$sp.Volume = 100',
    '$sp.SetOutputToWaveFile($env:TTS_OUT)',
    '$sp.Speak([IO.File]::ReadAllText($env:TTS_TXT, [Text.Encoding]::UTF8))',
    '$sp.Dispose()'
  ].join('\r\n'), 'utf8');
  const started = Date.now();
  try {
    run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      env: { ...process.env, TTS_TXT: txtFile, TTS_OUT: wav, TTS_VOICE: opts.voice || DEFAULT_VOICE, TTS_RATE: String(opts.rate ?? 0) },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000
    });
  } finally {
    try { fs.unlinkSync(ps1); } catch (e) { /* 忽略 */ }
  }
  const size = fs.statSync(wav).size;
  if (!size) throw new Error('TTS 生成的 wav 是空的');
  return { path: wav, chars: clean.length, bytes: size, ms: Date.now() - started, text: clean };
}

/** 发一条语音。kind: 'private'|'group'；text 或 file 二选一。 */
async function sendVoice({ kind = 'private', id, text, file, opts = {} }) {
  const { call } = require('./qq.js');
  let wav = file;
  let generated = null;
  if (text) {
    generated = synth(text, opts);
    wav = generated.path;
  }
  if (!wav) throw new Error('要么给 text，要么给 file');
  const abs = path.resolve(wav);
  if (!fs.existsSync(abs)) throw new Error('语音文件不存在：' + abs);
  const seg = { type: 'record', data: { file: abs.replace(/\\/g, '/') } };
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const params = kind === 'group' ? { group_id: Number(id), message: [seg] } : { user_id: Number(id), message: [seg] };
  let resp;
  try {
    resp = await call(action, params);
  } finally {
    if (generated && !opts.keep) {
      try { fs.unlinkSync(generated.path); } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(generated.path.replace(/\.(wav|mp3)$/, '.txt')); } catch (e) { /* 忽略 */ }
    }
  }
  return { resp, generated };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.flags.to = argv[++i];
    else if (a === '--group') out.flags.group = true;
    else if (a === '--delete') out.flags.delete = true;
    else if (a === '--keep') out.flags.keep = true;
    else if (a === '--rate') out.flags.rate = Number(argv[++i]);
    else if (a === '--voice') out.flags.voice = argv[++i];
    else if (a === '--tone') out.flags.tone = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const { call } = require('./qq.js');
  const { _: argv, flags } = parseArgs(process.argv.slice(2));
  const cmd = argv[0];
  if (cmd === 'voices') {
    console.log(listVoices().join('\n'));
    return;
  }
  if (cmd === 'say') {
    const text = argv.slice(1).join(' ');
    if (!text) throw new Error('用法：node scripts/voice.js say "要说的话" --to <QQ号|群号> [--group]');
    if (!flags.to) throw new Error('缺 --to（私聊填 QQ 号，群聊填群号并加 --group）');
    const r = await sendVoice({ kind: flags.group ? 'group' : 'private', id: flags.to, text, opts: { rate: flags.rate, voice: flags.voice, tone: flags.tone, keep: flags.keep } });
    const ok = r.resp && r.resp.status === 'ok';
    console.log(`[voice] ${ok ? '已发送' : '失败'} message_id=${(r.resp && r.resp.data && r.resp.data.message_id) || '-'} ` +
      `文本「${r.generated ? r.generated.text : '-'}」 ${r.generated ? r.generated.bytes + 'B/' + r.generated.ms + 'ms' : ''}`);
    if (!ok) console.log(JSON.stringify(r.resp).slice(0, 400));
    if (ok && flags.delete) {
      const mid = r.resp.data.message_id;
      const del = await call('delete_msg', { message_id: Number(mid) });
      console.log('[voice] 已撤回：' + JSON.stringify(del).slice(0, 200));
    }
    return;
  }
  if (cmd === 'file') {
    const file = argv[1];
    if (!file || !flags.to) throw new Error('用法：node scripts/voice.js file <音频路径> --to <QQ号|群号> [--group]');
    const r = await sendVoice({ kind: flags.group ? 'group' : 'private', id: flags.to, file });
    const ok = r.resp && r.resp.status === 'ok';
    console.log(`[voice] ${ok ? '已发送' : '失败'} message_id=${(r.resp && r.resp.data && r.resp.data.message_id) || '-'}`);
    if (!ok) console.log(JSON.stringify(r.resp).slice(0, 400));
    if (ok && flags.delete) console.log('[voice] 已撤回：' + JSON.stringify(await call('delete_msg', { message_id: Number(r.resp.data.message_id) })).slice(0, 200));
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].trim());
}

module.exports = {
  speakGsv,
  __setGsv,
  GSV_DEFAULTS,
  shiftLocal,
  baseSynth, __setRunner, utter: synth, speakToWav, speakEdge, synth, sendVoice, cleanText, listVoices, listEdgeVoices, loadCfg, EDGE_DEFAULTS, DEFAULT_VOICE, CFG_PATH, PY, prosody, prosodyFor: prosody.prosodyFor, paceText: prosody.paceText };

if (require.main === module) {
  main().catch(e => { console.error('[voice] 出错：' + (e && e.message)); process.exit(1); });
}
