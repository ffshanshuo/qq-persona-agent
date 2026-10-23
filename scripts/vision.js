'use strict';
/**
 * vision.js — 用 Kilo AI 免费池的视觉模型「看」图片（表情包 / 对方发来的图）。
 *
 * 关键事实（实测）：
 *  - POST https://api.kilo.ai/api/gateway/chat/completions，不带 Authorization 头
 *  - 必须带 reasoning:{enabled:false}
 *  - 只吃 png / jpeg（image/gif 会被上游拒：415 Unsupported Media Type）
 *    → 动图先用 scripts/sticker_prep.py 转成 2x2 帧拼图 PNG
 *
 * 导出：
 *   captionSticker(pngPath) -> {emotion, desc, tags[], text}
 *   describeImage(pngPath)  -> {desc, text}
 *   VISION_MODELS
 */
const fs = require('fs');
const path = require('path');

// 默认走本机网关（多模态 combo），key 与 brain.js 共用 scripts/gw.token
// 2026-10-24：Kilo 免费池 429 后整体切到本机 DSH 网关 8326，模型名也要换成 combo 名
const ENDPOINT = process.env.VISION_ENDPOINT || 'http://127.0.0.1:8326/v1/chat/completions';
const GW_TOKEN_FILE = process.env.VISION_TOKEN_FILE || path.join(__dirname, 'gw.token');
const VISION_MODELS = [
  'failover-combos/combo:nemotron-3-5-super-vl',
  'failover-combos/combo:multimodal-image-kimi-k2-5',
  'failover-combos/combo:deepseek-v4-flash-vision-exp',
];

let cachedToken = null;
function gwToken() {
  if (cachedToken !== null) return cachedToken;
  try {
    cachedToken = fs.readFileSync(GW_TOKEN_FILE, 'utf8').trim();
  } catch (_) {
    cachedToken = '';
  }
  return cachedToken;
}

const STICKER_PROMPT = [
  '这是一个 QQ 聊天表情包，可能是动图（用 2x2 的 4 帧拼图展示，#1~#4 是帧序号）。',
  '请只输出一行 JSON，不要任何解释，格式：',
  '{"emotion":"一个中文情绪词","desc":"20字内说明画面和它在聊天里表达什么","tags":["2到5个适合什么场合用的中文短词"]}',
  'emotion 从这些里选最贴近的一个：开心/大笑/偷笑/得意/无语/白眼/疑惑/震惊/委屈/难过/生气/尴尬/害怕/疲惫/敷衍/赞同/拒绝/道谢/打招呼/晚安/加油/卖萌/吃瓜/催促。',
].join('\n');

const IMAGE_PROMPT = [
  '这是别人在 QQ 聊天里发来的一张图片/表情包。',
  '请只输出一行 JSON，不要解释，格式：',
  '{"desc":"40字内说明图里是什么、表达了什么情绪或意思","type":"表情包|照片|截图|文字图|其它"}',
].join('\n');

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function parseJsonLoose(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch (_) {
    return null;
  }
}

async function askVision(file, prompt, { timeoutMs = 45000, maxTokens = 300 } = {}) {
  const mime = mimeOf(file);
  if (!mime) throw new Error(`不支持的图片类型（视觉模型只吃 png/jpeg）：${file}`);
  const b64 = fs.readFileSync(file).toString('base64');
  const errors = [];
  const net = require('./net.js'); // 走自建 https 出口（TLS1.3 握手在部分链路上会卡死）
  for (const model of VISION_MODELS) {
    const t0 = Date.now();
    try {
      const res = await net.postJson(ENDPOINT, {
        model,
        reasoning: { enabled: false },
        stream: false,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          },
        ],
      }, { timeoutMs, headers: gwToken() ? { authorization: 'Bearer ' + gwToken() } : {} });
      const j = res.json || {};
      if (j.error) {
        errors.push(`${model}: ${j.error.message || JSON.stringify(j.error).slice(0, 120)}`);
        continue;
      }
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status} ${String(res.text || '').slice(0, 120)}`);
        continue;
      }
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text) {
        errors.push(`${model}: empty content`);
        continue;
      }
      return { text: String(text).trim(), model, ms: Date.now() - t0 };
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }
  throw new Error(`视觉模型全部失败：${errors.join(' | ')}`);
}

async function captionSticker(pngFile, opts = {}) {
  const r = await askVision(pngFile, STICKER_PROMPT, opts);
  const j = parseJsonLoose(r.text) || {};
  return {
    emotion: (j.emotion || '').trim(),
    desc: (j.desc || '').trim() || r.text.slice(0, 60),
    tags: Array.isArray(j.tags) ? j.tags.map((s) => String(s).trim()).filter(Boolean).slice(0, 6) : [],
    text: r.text,
    model: r.model,
    ms: r.ms,
  };
}

async function describeImage(pngFile, opts = {}) {
  const r = await askVision(pngFile, IMAGE_PROMPT, opts);
  const j = parseJsonLoose(r.text) || {};
  return {
    desc: (j.desc || '').trim() || r.text.slice(0, 80),
    type: (j.type || '').trim() || '其它',
    text: r.text,
    model: r.model,
    ms: r.ms,
  };
}

module.exports = { captionSticker, describeImage, askVision, VISION_MODELS, ENDPOINT };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/vision.js <图片.png|.jpg> [--describe]');
    process.exit(2);
  }
  const fn = process.argv.includes('--describe') ? describeImage : captionSticker;
  fn(file)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('失败:', e.message);
      process.exit(1);
    });
}
