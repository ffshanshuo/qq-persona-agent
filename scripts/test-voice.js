'use strict';
/**
 * test-voice.js —— 发语音链路离线自检（真实调用被 __setRunner 打桩，不出网、不真的念）
 * 覆盖：配置默认值 / 文本清理 / edge 合成 / edge 失败回落 SAPI / 指定 sapi /
 *       音色列表解析 / sendVoice 的段格式与临时文件清理 / 私聊与群聊 action
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'logs', 'voice');

const voice = require('./voice.js');
const qq = require('./qq.js');

let pass = 0; const fails = [];
const cases = [];
function ok(name, fn) { cases.push([name, fn]); }

// ── 打桩：模拟 edge-tts 与 PowerShell 两个执行器 ────────────────────────────
let mode = 'edge-ok';   // edge-ok | edge-fail
const seen = [];
function fakeRun(cmd, args, opt) {
  seen.push({ cmd: String(cmd), args: args.slice() });
  if (String(cmd).includes('python')) {
    if (mode === 'edge-fail') throw new Error('edge-tts 网络失败');
    const i = args.indexOf('--write-media');
    if (i >= 0 && args[i + 1]) {
      const f = args[i + 1];
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Buffer.from('ID3fake-mp3'));
      return '';
    }
    if (String(args[0] || '').endsWith('local_vc.py')) {
      const out = args[args.length - 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from('RIFFfake-wav-shifted'));
      return '';
    }
    if (args[0] === '-c') {
      return JSON.stringify([{ name: 'zh-CN-XiaoxiaoNeural', gender: 'Female' }, { name: 'zh-CN-YunxiNeural', gender: 'Male' }]);
    }
    return '';
  }
  if (opt && opt.env && opt.env.TTS_OUT) {
    const f = opt.env.TTS_OUT;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from('RIFFfake-wav'));
    return '';
  }
  return '';
}
voice.__setRunner(fakeRun);

// ── 1. 配置 ────────────────────────────────────────────────────────────────
ok('默认配置走 edge-tts', () => {
  const c = voice.loadCfg();
  assert.ok(['edge', 'rvc', 'gpt-sovits', 'gsv'].includes(String(c.provider)), 'provider 只允许 edge / rvc / gpt-sovits：' + c.provider);
  assert.equal(c.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(c.fallback, 'sapi');
  assert.ok(fs.existsSync(voice.CFG_PATH), 'config/voice.json 应存在');
});
ok('配置能覆盖音色与语速', () => {
  const r = voice.synth('测试一下', { provider: 'edge', voice: 'zh-CN-YunxiNeural', rate: '+15%', maxChars: 40 });
  assert.equal(r.provider, 'edge');
  const call = seen.filter(x => x.args.includes('--voice')).pop();
  assert.ok(call.args.includes('zh-CN-YunxiNeural'), JSON.stringify(call.args));
  assert.ok(call.args.includes('--rate=+15%'));
  try { fs.unlinkSync(r.path); } catch (e) { }
});

// ── 2. 文本清理 ────────────────────────────────────────────────────────────
ok('CQ 码 / markdown / 换行被清掉', () => {
  const s = voice.cleanText('[CQ:face,id=1] 你好**呀**\n第二行');
  assert.ok(!/\[CQ:/.test(s));
  assert.ok(!/\*\*/.test(s));
  assert.ok(!/\n/.test(s));
  assert.ok(s.includes('你好'));
});
ok('超长按句号截断并补省略号', () => {
  const long = '这是一句很长很长的话，'.repeat(12) + '最后一句。';
  const s = voice.cleanText(long, 30);
  assert.ok(s.length <= 31, 'len=' + s.length + ' s=' + s);
  assert.ok(/…$/.test(s));
});
ok('空文本返回空串', () => {
  assert.equal(voice.cleanText('   '), '');
});

// ── 3. 合成 ────────────────────────────────────────────────────────────────
ok('edge 合成返回 mp3 路径与元数据', () => {
  const r = voice.synth('在呢，刚忙完', { provider: 'edge' });
  assert.equal(r.provider, 'edge');
  assert.ok(/\.mp3$/.test(r.path));
  assert.ok(r.bytes > 0);
  assert.ok(typeof r.ms === 'number');
  assert.ok(fs.existsSync(r.path));
  try { fs.unlinkSync(r.path); } catch (e) { }
});
ok('edge 失败自动回落 SAPI（不抛错）', () => {
  mode = 'edge-fail';
  const r = voice.synth('回落测试', { provider: 'edge' });
  assert.equal(r.provider, 'sapi');
  assert.ok(r.fellBack && /网络失败|edge/.test(r.fellBack), '应记录回落原因：' + r.fellBack);
  assert.ok(fs.existsSync(r.path));
  mode = 'edge-ok';
});
ok('provider=sapi 直接走系统音色', () => {
  const r = voice.synth('系统音色', { provider: 'sapi' });
  assert.equal(r.provider, 'sapi');
  assert.equal(r.voice, voice.DEFAULT_VOICE);
});
ok('彻底没文字时报错而不是发空语音', () => {
  let threw = false;
  try { voice.synth('   '); } catch (e) { threw = true; }
  assert.equal(threw, true);
});
ok('中文音色列表能解析', () => {
  const list = voice.listEdgeVoices();
  assert.ok(Array.isArray(list) && list.length >= 1);
  assert.ok(list.some(x => x.name === 'zh-CN-XiaoxiaoNeural'));
});

// ── 4. sendVoice（异步）─────────────────────────────────────────────────────
const sentCalls = [];
qq.call = async (action, params) => { sentCalls.push({ action, params }); return { status: 'ok', retcode: 0, data: { message_id: 123 } }; };

ok('私聊发语音：record 段 + 私聊 action + 临时文件被删', async () => {
  const r = await voice.sendVoice({ kind: 'private', id: 100000001, text: '这条是模块测试语音', opts: { provider: 'edge' } });
  const c = sentCalls.pop();
  assert.equal(c.action, 'send_private_msg');
  assert.equal(c.params.user_id, 100000001);
  assert.equal(c.params.message[0].type, 'record');
  assert.ok(/\.mp3$/.test(c.params.message[0].data.file));
  assert.equal(r.resp.status, 'ok');
  assert.equal(fs.existsSync(r.generated.path), false, '发完应删临时文件');
});
ok('群聊发语音：群 action + 段格式一致', async () => {
  const r = await voice.sendVoice({ kind: 'group', id: 200000001, text: '群里的语音测试', opts: { provider: 'edge' } });
  const c = sentCalls.pop();
  assert.equal(c.action, 'send_group_msg');
  assert.equal(c.params.group_id, 200000001);
  assert.equal(c.params.message[0].type, 'record');
  assert.equal(fs.existsSync(r.generated.path), false);
});
ok('keep=true 时保留临时文件', async () => {
  const r = await voice.sendVoice({ kind: 'private', id: 1, text: '保留一下', opts: { provider: 'edge', keep: true } });
  sentCalls.pop();
  assert.equal(fs.existsSync(r.generated.path), true);
  try { fs.unlinkSync(r.generated.path); } catch (e) { }
});
ok('给 file 就不合成，直接发已有文件', async () => {
  const f = path.join(TMP, 'given.mp3');
  fs.writeFileSync(f, 'x');
  const r = await voice.sendVoice({ kind: 'private', id: 1, file: f });
  const c = sentCalls.pop();
  assert.equal(c.params.message[0].data.file.replace(/\\/g, '/'), f.replace(/\\/g, '/'));
  assert.equal(r.generated, null);
});
ok('文件不存在时报错', async () => {
  let threw = false;
  try { await voice.sendVoice({ kind: 'private', id: 1, file: path.join(TMP, 'nope.mp3') }); } catch (e) { threw = true; }
  assert.equal(threw, true);
});
ok('SAPI 路径会顺手清掉同名 txt', async () => {
  const r = await voice.sendVoice({ kind: 'private', id: 1, text: '系统音色测试', opts: { provider: 'sapi' } });
  sentCalls.pop();
  assert.equal(fs.existsSync(r.generated.path), false);
  assert.equal(fs.existsSync(r.generated.path.replace(/\.wav$/, '.txt')), false);
});

// ── GPT-SoVITS（零样本克隆）───────────────────────────────────────────────
ok('provider=gpt-sovits 走 GPT-SoVITS 桩 → 返回 gsv 音色', () => {
  const out = path.join(TMP, 'gsv-ok.wav');
  fs.writeFileSync(out, Buffer.from('RIFFfake-gsv'));
  voice.__setGsv((text, g) => { assert.ok(text.length > 0); assert.ok(g.voice); return { path: out, voice: g.voice }; });
  const r = voice.synth('这句用满穗的声音说', { provider: 'gpt-sovits', gsv: { enabled: true, voice: 'mansui-001', cache: false } });
  voice.__setGsv(null);
  assert.equal(r.provider, 'gpt-sovits');
  assert.ok(String(r.voice).startsWith('gsv:'));
  assert.equal(fs.existsSync(r.path), true);
});
ok('provider=gpt-sovits 桩报错 → 回落 edge（gsv->edge）', () => {
  voice.__setGsv(() => { throw new Error('服务端挂了'); });
  const r = voice.synth('回落测试', { provider: 'gpt-sovits', gsv: { enabled: true, cache: false } });
  voice.__setGsv(null);
  assert.equal(r.provider, 'edge');
  assert.equal(r.fellBack, 'gsv->edge');
  assert.ok(String(r.gsvWhy || '').includes('服务端挂了'), String(r.gsvWhy));
});
ok('gsv.enabled=false → 直接用 edge，不碰服务端', () => {
  let hit = false;
  voice.__setGsv(() => { hit = true; return { path: '/nope.wav' }; });
  const r = voice.synth('关掉的时候别调服务端', { provider: 'gpt-sovits', gsv: { enabled: false } });
  voice.__setGsv(null);
  assert.equal(hit, false);
  assert.equal(r.provider, 'edge');
});
ok('provider=rvc 且服务端不可用 + localShift 开 → 本地变声（rvc->local）', async () => {
  const r = await voice.synth('本地变声测试', { provider: 'rvc', rvc: { enabled: true, baseUrl: 'http://127.0.0.1:9', cache: false, timeoutMs: 4000 }, localShift: { enabled: true, pitch: 1.12 } });
  assert.equal(r.provider, 'local-shift');
  assert.equal(r.fellBack, 'rvc->local');
  assert.ok(fs.existsSync(r.path), '应该真的落了文件');
  assert.ok(String(r.path).endsWith('-shift.wav'), '文件名带 -shift：' + r.path);
});
ok('localShift 关掉 → 按 fallback 回落 edge', async () => {
  const r = await voice.synth('回落测试', { provider: 'rvc', rvc: { enabled: true, baseUrl: 'http://127.0.0.1:9', cache: false, timeoutMs: 4000 }, localShift: { enabled: false } });
  assert.equal(r.provider, 'edge');
  assert.equal(r.fellBack, 'rvc->edge');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); pass++; }
    catch (e) { fails.push(name + ' :: ' + (e && e.message)); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { }
  voice.__setRunner(null);
  console.log(`\ntest-voice: ${pass} passed, ${fails.length} failed`);
  if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
})();
