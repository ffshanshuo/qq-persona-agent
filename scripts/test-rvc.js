'use strict';
/**
 * test-rvc.js —— RVC 换声渠道自检（全离线，HTTP 与 TTS 都打桩）
 * 覆盖：探活/列模型、multipart 字段、音频字节落盘与缓存、JSON 路径响应、失败回落、
 *       voice.synth 的 rvc provider（先 TTS 再换声）与失败时回落 edge。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-'));
process.env.QQRVC_DIR = DIR;
process.env.QQVOICE_DIR = DIR;
process.env.VOICE_DIR = DIR;
process.env.RVC_ENABLED = '1';
process.env.RVC_MODEL = 'test-model';

const store = require('../lib/store.js');
const rvc = require('../scripts/rvc.js');
const voice = require('../scripts/voice.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.message)); }
}
const eq = (a, b, m) => assert.strictEqual(a, b, m || (String(a) + ' !== ' + String(b)));
const ok = (v, m) => assert.ok(v, m);

// voice.js 的输出目录固定是 <ROOT>/logs/voice，测试里先建好（不然写文件会 ENOENT）
try { fs.mkdirSync(path.join(__dirname, '..', 'logs', 'voice'), { recursive: true }); } catch (e) { }

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64, 7)]);
const IN = path.join(DIR, 'in.wav'); fs.writeFileSync(IN, WAV);

// ---- 假 HTTP ----
let calls = [];
let handler = null;
rvc.__setHttp((req) => { calls.push(req); return Promise.resolve(handler ? handler(req) : { ok: false, why: 'no-handler' }); });
function reset() { calls = []; rvc.clearProbe(); }

// 一、探活
t('探活：/models 返回数组 → ok 且带上模型列表', async () => { });
(async () => {
  handler = (req) => ({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(['m1', 'm2', 'test-model'])) });
  reset();
  let v = await rvc.probe();
  ok(v.ok); eq(v.models.length, 3); eq(v.model, 'test-model');
  t('探活结果有缓存（60 秒内不再发请求）', () => { eq(calls.length, 1); });
  await rvc.probe();
  t('缓存期内第二次探活不再发请求', () => { eq(calls.length, 1); });

  // /models 不通 → 退一步 /docs
  reset();
  handler = (req) => (String(req.url).endsWith('/models') ? { ok: false, status: 404 } : { ok: true, status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>docs</html>') });
  v = await rvc.probe();
  ok(v.ok); eq(v.why, 'health-only'); eq(calls.length, 2);
  t('/models 不通时退到 /docs 判活', () => { ok(true); });

  // 都不通
  reset();
  handler = () => ({ ok: false, why: 'net:ECONNREFUSED' });
  v = await rvc.probe();
  eq(v.ok, false); ok(/ECONNREFUSED/.test(v.why), v.why);
  t('服务端根本不在 → ok:false 且带原因', () => { ok(true); });

  // 二、转换
  reset();
  handler = (req) => {
    const body = String(req.body);
    if (!/name="model_name"/.test(body) || !/name="f0_up_key"/.test(body) || !/name="index_rate"/.test(body)) return { ok: false, status: 400 };
    if (!/filename="in\.wav"/.test(body)) return { ok: false, status: 400 };
    return { ok: true, status: 200, headers: { 'content-type': 'audio/wav' }, body: WAV };
  };
  let r = await rvc.convert(IN, {});
  ok(r.ok, r.why); ok(r.path && fs.existsSync(r.path)); eq(r.bytes, WAV.length);
  t('转换请求是 multipart 且字段名对得上 RVC WebUI', () => { ok(calls.some(c => /multipart\/form-data/.test(c.headers['content-type']))); eq(calls[0].method, 'POST'); ok(String(calls[0].url).endsWith('/voice2voice')); });
  t('返回的音频字节被落盘成缓存文件', () => { ok(r.path.endsWith('.wav')); });

  reset();
  handler = () => ({ ok: false, status: 500 });
  r = await rvc.convert(IN, {});
  t('同一输入第二次走缓存（不再发请求）', () => { eq(r.ok, true); eq(r.cached, true); eq(calls.length, 0); });

  // 换一个输入 → 服务 500
  const IN2 = path.join(DIR, 'in2.wav'); fs.writeFileSync(IN2, Buffer.concat([WAV, Buffer.from('x')]));
  reset();
  handler = () => ({ ok: false, status: 500 });
  r = await rvc.convert(IN2, {});
  eq(r.ok, false); ok(/status:500/.test(r.why), r.why);
  t('服务端 500 → ok:false（不写坏缓存）', () => { ok(!fs.existsSync(path.join(DIR, require('crypto').createHash('md5').update(fs.readFileSync(IN2)).digest('hex') + '.wav'))); });

  // JSON 里给本地路径
  const OUT = path.join(DIR, 'out.wav'); fs.writeFileSync(OUT, WAV);
  const IN3 = path.join(DIR, 'in3.wav'); fs.writeFileSync(IN3, Buffer.concat([WAV, Buffer.from('y')]));
  reset();
  handler = () => ({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ path: OUT })) });
  r = await rvc.convert(IN3, {});
  ok(r.ok, r.why); eq(r.bytes, WAV.length);
  t('服务端返回 JSON {path} 时也能拿回音频', () => { ok(true); });

  // 没有模型名
  reset();
  r = await rvc.convert(IN, { cfg: { model: '' }, model: '' });
  eq(r.why, 'no-model');
  t('没配模型时直接拒绝（不发请求）', () => { eq(calls.length, 0); });

  // 三、voice.synth 的 rvc provider
  let ttsCount = 0;
  let curlStatus = '200';
  const curlAudio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(80, 9)]);
  rvc.__setCurl((bin, args) => {
    const i = (args || []).indexOf('-o');
    if (i >= 0 && args[i + 1]) fs.writeFileSync(args[i + 1], curlAudio);
    return curlStatus;
  });
  voice.__setRunner((cmd, args, opt) => {
    // 假装 edge-tts 生成了音频：--write-media 后面的路径就是输出文件
    const i = (args || []).findIndex(a => a === '--write-media' || String(a).startsWith('--write-media='));
    let out = '';
    if (i >= 0) out = String(args[i]).includes('=') ? String(args[i]).split('=')[1] : args[i + 1];
    if (!out && opt && opt.env && opt.env.TTS_OUT) out = opt.env.TTS_OUT;
    if (out) fs.writeFileSync(out, Buffer.concat([WAV, Buffer.from(String(++ttsCount))]));
    return Buffer.from('');
  });
  const base = voice.baseSynth('在呢', { provider: 'edge' });
  t('baseSynth 走 edge（桩）能产出文件', () => { ok(base.path && fs.existsSync(base.path)); eq(base.provider, 'edge'); });

  reset();
  handler = () => ({ ok: true, status: 200, headers: { 'content-type': 'audio/wav' }, body: WAV });
  const s = voice.synth('在呢，刚忙完', { provider: 'rvc' });
  t('voice.synth(provider:rvc) 先 TTS 再换声', () => { eq(s.provider, 'rvc'); ok(String(s.voice).indexOf('rvc:') === 0); eq(s.converted, true); });
  t('换声后返回的是换过的那份文件', () => { ok(fs.existsSync(s.path)); ok(s.bytes > 0); });

  // 换声失败 → 回落 edge（先清缓存：缓存按输入内容寻址，重复的音频会直接命中）
  rvc.resetCache();
  reset();
  curlStatus = '502';
  handler = () => ({ ok: false, status: 502 });
  const s2 = voice.synth('再试一句', { provider: 'rvc' });
  t('换声失败时回落基础 TTS（不吞掉这条语音）', () => { eq(s2.provider, 'edge'); ok(/^rvc->/.test(s2.fellBack), s2.fellBack); });
  voice.__setRunner(null);

  // 四、状态
  const st = rvc.status();
  t('status 给出 baseUrl/缓存数/未启用说明', () => { ok(st.baseUrl); ok(typeof st.cached === 'number'); ok(typeof st.enabled === 'boolean'); });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('  ✗ 运行异常: ' + (e && e.stack));
  process.exit(1);
});
