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
 * 参数：--rate -10..10（语速，默认 0）、--voice "<音色名>"、--keep（保留生成的 wav）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'logs', 'voice');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DEFAULT_VOICE = 'Microsoft Huihui Desktop';

/** 去掉念不出来的东西：CQ 码、markdown 符号、纯 emoji；超长按句号截断 */
function cleanText(s, maxChars = 120) {
  let t = String(s || '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/[`*_>#~|]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > maxChars) {
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
    execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
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
    generated = speakToWav(text, opts);
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
    if (generated && !opts.keep) { try { fs.unlinkSync(generated.path); } catch (e) { /* 忽略 */ } try { fs.unlinkSync(generated.path.replace(/\.wav$/, '.txt')); } catch (e) { /* 忽略 */ } }
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
    const r = await sendVoice({ kind: flags.group ? 'group' : 'private', id: flags.to, text, opts: { rate: flags.rate, voice: flags.voice, keep: flags.keep } });
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

module.exports = { speakToWav, sendVoice, cleanText, listVoices, DEFAULT_VOICE };

if (require.main === module) {
  main().catch(e => { console.error('[voice] 出错：' + (e && e.message)); process.exit(1); });
}
