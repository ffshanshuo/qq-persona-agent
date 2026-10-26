/**
 * panel.js —— 本地可视化控制台（零依赖、只绑 127.0.0.1）
 *
 * 用户 2026-10-24：「做一个可视化控制界面出来，最好简述各个块的功能。」
 *
 * 它不参与聊天链路，只是一个「只读为主的驾驶舱」：把 10 层模块、当前状态、
 * 各条会话的记忆/情绪、主动与承诺、以及一次「试一句」的预演（dry，不发送）集中到一页。
 *
 * 启动：node scripts/panel.js            → http://127.0.0.1:8787
 * 端口：QQPANEL_PORT（默认 8787）；只监听 QQPANEL_HOST（默认 127.0.0.1）
 * 令牌：设了 QQPANEL_TOKEN 时，所有 /api/* 需要 ?token=… 或 header x-panel-token
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(ROOT, 'assets', 'panel');
const PORT = Number(process.env.QQPANEL_PORT || 8787);
const HOST = process.env.QQPANEL_HOST || '127.0.0.1';
const TOKEN = String(process.env.QQPANEL_TOKEN || '');
const T0 = Date.now();

// ══════════════════════════════════════════════════════════════════
//  一、模块清单：界面上每一块卡片的「中文名 + 一句话作用」
//  这是唯一需要人工维护的数据；状态由下方 PROBES 现读。
// ══════════════════════════════════════════════════════════════════
const BLOCKS = [
  {
    'id': 'auto-reply', 'layer': '入口与运维', 'name': '主循环 auto-reply',
    'role': '收到消息后的总调度：判断要不要回 → 串起各层上下文 → 调模型 → 拆分气泡 → 发送并记账。',
    'files': ['scripts/auto-reply.js'], 'cfg': ['autoreply.json'], 'log': 'autoreply.log', 'probe': 'autoReply'
  },
  {
    'id': 'watchdog', 'layer': '入口与运维', 'name': '看门狗 watchdog',
    'role': '每 30 秒探活一次，发现 QQ/主循环掉了就按风控闸门决定是否拉起；冷却期只停下不重登。',
    'files': ['scripts/watchdog.js'], 'cfg': ['risk.json'], 'log': 'watchdog.log', 'probe': 'watchdog'
  },
  {
    'id': 'collector', 'layer': '入口与运维', 'name': '事件收集 collector',
    'role': '把 WebSocket 事件落到 logs/inbox.jsonl，断线自动重连；用于回看「刚才都有谁找过」。',
    'files': ['scripts/collector.js'], 'log': 'inbox.jsonl', 'probe': 'collector'
  },
  {
    'id': 'intercepts', 'layer': '入口与运维', 'name': '即时指令 intercepts',
    'role': '聊天里说「换个头像」「以后叫你星河」这类要求，直接执行并回一句，不经过模型（省时间也省额度）。',
    'files': ['scripts/intercepts.js'], 'cfg': ['avatar.json', 'nick.json'], 'log': 'autoreply.log', 'probe': 'intercepts'
  },
  {
    'id': 'timers', 'layer': '入口与运维', 'name': '后台定时器 timers',
    'role': '四件「没人说话时也要发生的事」：空闲巩固、想念调度、参数进化、头像轮换。',
    'files': ['scripts/timers.js'], 'cfg': ['mind.json', 'longing.json', 'evolve.json', 'avatar.json'], 'log': 'autoreply.log', 'probe': 'timers'
  },
  {
    'id': 'qq', 'layer': '通道与协议', 'name': 'OneBot 客户端 qq.js',
    'role': '调 NapCat 的 HTTP 接口发消息/查资料；所有请求带 5 秒超时，避免挂死发送队列。',
    'files': ['scripts/qq.js'], 'log': 'autoreply.log', 'probe': 'qq'
  },
  {
    'id': 'net', 'layer': '通道与协议', 'name': '网络出口 net.js',
    'role': '统一出口：因 TLS1.3 的 ClientHello 会被链路丢包，默认降到 TLS1.2 才连得上模型网关。',
    'files': ['scripts/net.js'], 'probe': 'net'
  },
  {
    'id': 'phone', 'layer': '通道与协议', 'name': 'A 通道 phone.js',
    'role': '备用方案：用 adb 操作手机上的官方 QQ（发主动消息/改资料）；目前不启用，只留能力。',
    'files': ['scripts/phone.js'], 'probe': 'phone'
  },
  {
    'id': 'brain', 'layer': '模型与多模态', 'name': '思考 brain.js',
    'role': '把上下文拼成 prompt，调本机网关的模型（并发抢答取最快），解析回复与表情标记。',
    'files': ['scripts/brain.js'], 'cfg': ['brain.json'], 'log': 'autoreply.log', 'probe': 'brain'
  },
  {
    'id': 'vision', 'layer': '模型与多模态', 'name': '看图 vision.js',
    'role': '对方发图/表情包时，先转 2×2 帧拼图 PNG，再交给多模态模型描述画面与情绪。',
    'files': ['scripts/vision.js', 'scripts/sticker_prep.py'], 'probe': 'vision'
  },
  {
    'id': 'say', 'layer': '模型与多模态', 'name': '人话自检 say.js',
    'role': '发送前扫一遍：中英混杂、助手口气、列清单、书面腔、太长、表情太多——能就地改的就改，改不掉的重说一次。',
    'files': ['scripts/say.js'], 'cfg': ['autoreply.json'], 'log': 'say-bad.jsonl', 'probe': 'say'
  },
  {
    'id': 'context', 'layer': '上下文与记忆', 'name': '上下文 context.js',
    'role': '每个会话的短期原文窗口 + 滚动摘要 + 长期事实；超预算自动压缩，重启后能从历史补账。',
    'files': ['scripts/context.js'], 'log': 'context/', 'probe': 'context'
  },
  {
    'id': 'quote', 'layer': '上下文与记忆', 'name': '引用理解 quote.js',
    'role': '对方引用某条消息时，主动取回那条内容，判断是「你自己 / TA 自己 / 群里别人」说的、多久以前。',
    'files': ['scripts/quote.js'], 'cfg': ['autoreply.json'], 'log': 'quotes/', 'probe': 'quote'
  },
  {
    'id': 'forward', 'layer': '上下文与记忆', 'name': '合并转发 forward.js',
    'role': '对方转发聊天记录时，调 get_forward_msg 把里面一条条拆开，看清谁说了什么（不是只看到「[合并转发]」四个字）。',
    'files': ['scripts/forward.js'], 'cfg': ['autoreply.json'], 'log': 'forwards/', 'probe': 'forward'
  },
  {
    'id': 'timeline', 'layer': '上下文与记忆', 'name': '时间线 timeline.js',
    'role': '把时间戳读成时间感：上下文里标「(+8 分钟)」，并从「去洗澡→洗完了」这类汇报里算出实际耗时（约 32 分钟）。',
    'files': ['scripts/timeline.js'], 'cfg': ['timeline.json'], 'log': 'timeline/', 'probe': 'timeline'
  },
  {
    'id': 'ties', 'layer': '情绪 · 关系 · 语气', 'name': '关系分档 ties.js',
    'role': '关系是分档的（陌生→认识→朋友→很熟→恋人/前任），恋人全局只允许一个；吵架冷战满 72 小时会自动分手，复合要对方明说 + 关系回暖。',
    'files': ['scripts/ties.js'], 'cfg': ['ties.json'], 'log': 'ties/', 'probe': 'ties'
  },
  {
    'id': 'presence', 'layer': '安全与节奏', 'name': '心情状态 presence.js',
    'role': '自动改 QQ 的在线状态与心情（恋爱中 / emo中 / 学习中 / 熬夜中 / 隐身…），按关系、情绪、当前在做的事挑，3 小时冷却、每天最多 4 次。',
    'files': ['scripts/presence.js'], 'cfg': ['presence.json'], 'log': 'presence.jsonl', 'probe': 'presence'
  },
  {
    'id': 'them', 'layer': '上下文与记忆', 'name': '对方当下状态 them.js',
    'role': '识别「我去眯一会儿 / 在开会 / 生病了」，避免一边说在忙一边约七点叫人这种自相矛盾。',
    'files': ['scripts/them.js'], 'log': 'them/', 'probe': 'them'
  },
  {
    'id': 'mind', 'layer': '情绪 · 关系 · 语气', 'name': '拟人记忆 mind.js',
    'role': '三层记忆：痕迹（原始对话+思考）、状态（心情 PAD + 关系四轴）、联想（带权记忆图，按情绪共鸣召回）。',
    'files': ['scripts/mind.js'], 'cfg': ['mind.json'], 'log': 'mind/ · trace/', 'probe': 'mind'
  },
  {
    'id': 'bonds', 'layer': '情绪 · 关系 · 语气', 'name': '关系事件 bonds.js',
    'role': '约会、帮忙、吵架、道歉、说心里话这类事件会一次性推动关系；久别重逢另有加成，按时间自然衰减。',
    'files': ['scripts/bonds.js'], 'cfg': ['bonds.json'], 'log': 'bonds/', 'probe': 'bonds'
  },
  {
    'id': 'style', 'layer': '情绪 · 关系 · 语气', 'name': '说话分寸 style.js',
    'role': '按关系远近与当前气氛决定称呼、长度、能不能开玩笑；发送前还会把没资格的亲昵词摘掉。',
    'files': ['scripts/style.js'], 'cfg': ['style.json'], 'log': 'autoreply.log', 'probe': 'style'
  },
  {
    'id': 'echo', 'layer': '情绪 · 关系 · 语气', 'name': '回响 echo.js',
    'role': '读对方这几句的语气（热络/敷衍/倒苦水），反过来调自己的语气与心情，但不让冷场真的伤感情。',
    'files': ['scripts/echo.js'], 'cfg': ['echo.json'], 'log': 'echo/', 'probe': 'echo'
  },
  {
    'id': 'mode', 'layer': '情绪 · 关系 · 语气', 'name': '思维模式 mode.js',
    'role': '决定「这轮该怎么想」：是接情绪、给建议、深聊还是开玩笑，并配相应的长度预算；被冷待的说法会自己降权。',
    'files': ['scripts/mode.js'], 'cfg': ['mode.json'], 'log': 'mode/', 'probe': 'mode'
  },
  {
    'id': 'self', 'layer': '情绪 · 关系 · 语气', 'name': '自我线 self.js',
    'role': '给自己一条生活线（写代码/吃饭/看剧），被问在干嘛时照实说，而不是每次都「在呢」。',
    'files': ['scripts/self.js'], 'cfg': ['self.json'], 'log': 'self/', 'probe': 'self'
  },
  {
    'id': 'clock', 'layer': '情绪 · 关系 · 语气', 'name': '历法感 clock.js',
    'role': '知道今天周几、什么节日、现在是早上还是深夜，但绝不主动报日期。',
    'files': ['scripts/clock.js'], 'cfg': ['clock.json'], 'probe': 'clock'
  },
  {
    'id': 'longing', 'layer': '主动与承诺', 'name': '想念调度 longing.js',
    'role': '没人说话时按亲密度决定「多久会想起你」，开口有由头、没回音会补一句、关系僵着不寒暄。',
    'files': ['scripts/longing.js'], 'cfg': ['longing.json'], 'log': 'longing/', 'probe': 'longing'
  },
  {
    'id': 'promises', 'layer': '主动与承诺', 'name': '说话算数 promises.js',
    'role': '记住自己答应过的事；到日子会主动提，而且只在真发出去时才算提醒过。',
    'files': ['scripts/promises.js'], 'cfg': ['autoreply.json'], 'log': 'promises/', 'probe': 'promises'
  },
  {
    'id': 'follow', 'layer': '主动与承诺', 'name': '群聊跟随 follow.js',
    'role': '在群里被 @ 之后，接下来几句即使不 @ 也会判断「是不是还在跟我说」，跟完自动收窗。',
    'files': ['scripts/follow.js'], 'cfg': ['follow.json'], 'log': 'follow/', 'probe': 'follow'
  },
  {
    'id': 'nick', 'layer': '主动与承诺', 'name': '改昵称 nick.js',
    'role': '聊天里可以让它改名，但只听关系够近（或伴侣名单）的人；不熟的要求只记下不执行。',
    'files': ['scripts/nick.js'], 'cfg': ['nick.json'], 'log': 'nick/', 'probe': 'nick'
  },
  {
    'id': 'stickers', 'layer': '表情与头像', 'name': '表情库 stickers.js',
    'role': '挑图/发表情：先点名、再按情绪打分、最后才兜底；图片走 QQ 的「表情」通道，发出去会记账并从被夸/被嫌里学习。',
    'files': ['scripts/stickers.js'], 'cfg': ['autoreply.json'], 'probe': 'stickers'
  },
  {
    'id': 'sticker-fetch', 'layer': '表情与头像', 'name': '上网找表情 sticker-fetch.js',
    'role': '库里没有合适的情绪图时，自动去网上搜一张、审一下、入库；有每小时配额与同词冷却。',
    'files': ['scripts/sticker-fetch.js'], 'cfg': ['autoreply.json'], 'log': 'sticker-fetch/', 'probe': 'stickerFetch'
  },
    {
    'id': 'rvc', 'layer': '表情与头像', 'name': 'RVC 换声 rvc.js（把合成好的语音换成目标音色）',
    'role': '本机没有 GPU/torch，所以只做客户端：把 edge-tts 合成好的 wav 发给跑着 RVC 服务的机器，换音色后再发。默认关闭。',
    'files': ['scripts/rvc.js'], 'cfg': ['rvc.json'], 'log': 'rvc/', 'probe': 'rvc'
  },
  {
    'id': 'gsv', 'layer': '通道与协议', 'name': 'GPT-SoVITS 克隆 gsv-server.py（用参考音频说她的声音）',
    'role': '零样本克隆 TTS：不用底稿，拿 vendor/voices/*.wav 当参考直接生成她的音色（CPU 10~20 秒/句）。voice.js 的 provider=gpt-sovits 走这条，watchdog 保活 7899 端口。',
    'files': ['scripts/voice.js', 'vendor/gsv-server.py'], 'cfg': ['voice.json'], 'log': 'gsv-server.log', 'probe': 'gsv'
  },
  {
    'id': 'voice', 'layer': '表情与头像', 'name': '语音 voice.js（edge-tts 优先，SAPI 兜底）',
    'role': '用系统 TTS 合成语音，交给 NapCat 转成 AMR 发出；默认关，可在配置里按概率开启。',
    'files': ['scripts/voice.js'], 'cfg': ['autoreply.json'], 'probe': 'voice'
  },
  {
    'id': 'avatar', 'layer': '表情与头像', 'name': '头像 avatar.js',
    'role': '从「别人发来的图 / 网上找的图」里挑一张做头像；可被聊天里的一句话触发，风控冷却时自动拒绝。',
    'files': ['scripts/avatar.js', 'scripts/avatar-src.js', 'scripts/avatar_prep.py'], 'cfg': ['avatar.json'], 'log': 'avatar/', 'probe': 'avatar'
  },
  {
    'id': 'risk', 'layer': '安全与节奏', 'name': '风控闸门 risk.js',
    'role': '按动作风险分级放行：被动回复可以，改资料/主动找人更谨慎；掉线熔断后进入冷却，不再反复重登。',
    'files': ['scripts/risk.js'], 'cfg': ['risk.json'], 'log': 'risk/', 'probe': 'risk'
  },
  {
    'id': 'pacing', 'layer': '安全与节奏', 'name': '节奏 pacing.js',
    'role': '打字时长按字数算、换人要先「切窗口」；配合「正在输入」提示，让节奏像人。',
    'files': ['scripts/pacing.js'], 'cfg': ['pacing.json'], 'log': 'pacing/', 'probe': 'pacing'
  },
  {
    'id': 'group', 'layer': '安全与节奏', 'name': '群聊在场 group.js',
    'role': '群里没被叫到时，判断该不该插一句（有人求助/话题正好/不刷屏），插嘴也有冷却。',
    'files': ['scripts/group.js'], 'cfg': ['group.json'], 'log': 'group/', 'probe': 'group'
  },
  {
    'id': 'evolve', 'layer': '自进化', 'name': '参数进化 evolve.js',
    'role': '从真实对话统计「判冷是不是判太狠」，按小步长自动调阈值与词表；改动有边界、有历史、可一键回滚。',
    'files': ['scripts/evolve.js'], 'cfg': ['evolve.json', 'tuning.json'], 'log': 'evolve/', 'probe': 'evolve'
  },
  {
    'id': 'store', 'layer': '共享基础', 'name': '原子落盘 store.js',
    'role': '所有模块共用的 JSON 读写：临时文件 + rename，失败重试并退回直写；坏文件先改名留证再重建。',
    'files': ['lib/store.js'], 'probe': 'store'
  },
  {
    'id': 'arch', 'layer': '共享基础', 'name': '架构守门 arch.js',
    'role': '从代码现读生成 ARCHITECTURE.md，并检查「新脚本没归类 / 测试没注册 / 配置没人读 / 补丁残留」。',
    'files': ['scripts/arch.js'], 'log': '—', 'probe': 'arch'
  },
  {
    'id': 'panel', 'layer': '共享基础', 'name': '控制台 panel.js（本页）',
    'role': '就是你现在看的这个页面：聚合状态、看会话、试一句（不发送）、看日志。',
    'files': ['scripts/panel.js', 'scripts/dryrun.js', 'assets/panel/'], 'probe': 'panel'
  }
];

// 一次回复经过的层（界面上画成流水线）
const PIPELINE = [
  { 'key': 'dispatch', 'name': '连发合并', 'desc': '一个人连发几条 → 合成一件事，只回一次' },
  { 'key': 'catchup', 'name': '离线补账', 'desc': '不在线时漏掉的消息，重启后从历史补进来' },
  { 'key': 'quote', 'name': '引用理解', 'desc': 'TA 在回复哪一条、是谁说的、多久以前' },
  { 'key': 'forward', 'name': '合并转发', 'desc': '转发的聊天记录要拆开看，不能只留四个字' },
  { 'key': 'them', 'name': '对方状态', 'desc': '「去眯一会儿」这类安排，别自相矛盾' },
  { 'key': 'echo', 'name': '回响', 'desc': '读 TA 的冷热，反过来调自己的语气' },
  { 'key': 'mind', 'name': '拟人记忆', 'desc': '此刻心情、关系远近、由什么想起哪段旧事' },
  { 'key': 'mode', 'name': '思维模式', 'desc': '这轮该接情绪、给建议、深聊还是玩笑' },
  { 'key': 'style', 'name': '说话分寸', 'desc': '称呼、长度、能不能开玩笑' },
  { 'key': 'promises', 'name': '承诺', 'desc': '说好的事到日子要提；没提过的别硬提' },
  { 'key': 'self', 'name': '自我线', 'desc': '自己在干嘛（被问时照实说）' },
  { 'key': 'clock', 'name': '历法感', 'desc': '周几、什么点、什么节日（不说出来）' },
  { 'key': 'brain', 'name': '思考', 'desc': '拼 prompt → 模型并发抢答 → 取最快' },
  { 'key': 'say', 'name': '人话自检', 'desc': '中英混杂/助手腔/列清单 → 就地改或重说' },
  { 'key': 'sticker', 'name': '挑表情', 'desc': '按情绪挑图；没有就上网找一张' },
  { 'key': 'pacing', 'name': '节奏', 'desc': '按字数等打字时长、换人先切窗口' },
  { 'key': 'send', 'name': '发送', 'desc': '拆分气泡、挂操作记录、从 TA 的反应里学习' }
];

// ══════════════════════════════════════════════════════════════════
//  二、状态读取（每个都包一层 try，坏掉只影响一张卡片）
// ══════════════════════════════════════════════════════════════════
function safe(fn, fallback = null) {
  try { return fn(); } catch (e) { return fallback; }
}
function mod(name) { return safe(() => require('./' + name + '.js'), null); }
function readJson(file, fallback = null) {
  return safe(() => JSON.parse(fs.readFileSync(file, 'utf8')), fallback);
}
function exists(p) { return safe(() => fs.existsSync(p), false); }
function dirCount(dir, suffix = '') {
  return safe(() => fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(suffix)).length, 0);
}
function mtimeAgo(file) {
  const full = path.join(ROOT, file);
  const st = safe(() => fs.statSync(full), null);
  if (!st) return null;
  return Math.round((Date.now() - st.mtimeMs) / 1000);
}
function tail(file, lines = 120) {
  const full = path.join(ROOT, file);
  if (!exists(full)) return [];
  const txt = safe(() => fs.readFileSync(full, 'utf8'), '');
  return txt.trim().split('\n').slice(-lines);
}
function busy(name) {
  // 最近 N 秒内这条日志有没有新行 —— 用来判断「进程还活着」
  const ago = mtimeAgo('logs/' + name);
  return ago !== null && ago <= 600;
}

let procCache = { 'at': 0, 'value': null };
function procs() {
  const now = Date.now();
  if (procCache.value && now - procCache.at < 8000) return procCache.value;
  const value = { 'qq': 0, 'autoReply': [], 'watchdog': [], 'collector': [], 'panel': [], 'error': null };
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'QQ.exe' } | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress";
  const file = require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { 'encoding': 'utf8', 'timeout': 8000 });
  const list = JSON.parse(file || '[]');
  const arr = Array.isArray(list) ? list : [list];
  for (const p of arr) {
    if (p.Name === 'QQ.exe') { value.qq++; continue; }
    const cmd = String(p.CommandLine || '');
    if (cmd.includes('auto-reply')) value.autoReply.push(p.ProcessId);
    else if (cmd.includes('watchdog')) value.watchdog.push(p.ProcessId);
    else if (cmd.includes('collector')) value.collector.push(p.ProcessId);
    else if (cmd.includes('panel')) value.panel.push(p.ProcessId);
  }
  for (const k of ['autoReply', 'watchdog', 'collector', 'panel']) value[k] = [...new Set(value[k])];
  if (!value.panel.length) value.panel.push(process.pid);
  procCache = { 'at': now, value };
  return value;
}

async function qqStatus() {
  try {
    const qq = mod('qq');
    if (!qq) return { 'ok': false, 'why': 'qq.js 未加载' };
    const st = await qq.call('get_status', {}, { 'timeoutMs': 3000 });
    if (!st || st.status !== 'ok') return { 'ok': false, 'why': 'NapCat 未响应' };
    const me = await qq.call('get_login_info', {}, { 'timeoutMs': 3000 });
    const gl = await qq.call('get_group_list', {}, { 'timeoutMs': 3000 });
    return {
      'ok': true,
      'online': !!(st.data && st.data.online),
      'good': !!(st.data && st.data.good),
      'uin': me && me.data ? me.data.user_id : null,
      'nick': me && me.data ? me.data.nickname : '',
      'groups': (gl && gl.data ? gl.data.length : 0)
    };
  } catch (e) {
    return { 'ok': false, 'why': String((e && e.message) || e).slice(0, 120) };
  }
}

const PROBES = {
  autoReply() {
    const t = tail('logs/autoreply.log', 400).map((l) => safe(() => JSON.parse(l), null)).filter(Boolean);
    const last = t[t.length - 1] || null;
    const sent24 = t.filter((e) => e.event === 'sent' && Date.now() - e.t < 86400000).length;
    return {
      'badge': busy('autoreply.log') ? 'ok' : 'warn',
      'facts': {
        '最近事件': last ? last.event : '—',
        '24小时发送': sent24 + ' 条',
        '日志': (mtimeAgo('logs/autoreply.log') ?? '?') + ' 秒前'
      }
    };
  },
  watchdog() {
    const lines = tail('logs/watchdog.log', 6);
    const alive = safe(() => procs().watchdog.length > 0, false);
    return { 'badge': alive ? 'ok' : 'bad', 'facts': { '进程': alive ? '在跑' : '不在了', '最后一行': lines[lines.length - 1] || '—' } };
  },
  collector() {
    const n = dirCount('logs', '.jsonl');
    const ago = mtimeAgo('logs/inbox.jsonl');
    return { 'badge': ago !== null && ago < 86400 ? 'ok' : 'warn', 'facts': { '收件箱': (tail('logs/inbox.jsonl', 1)[0] || '空').slice(0, 80) } };
  },
  intercepts() {
    const t = tail('logs/autoreply.log', 600).map((l) => safe(() => JSON.parse(l), null)).filter(Boolean);
    const n = t.filter((e) => e.event === 'nick-chat' || e.event === 'avatar-chat').length;
    return { 'badge': 'ok', 'facts': { '近期即时指令': n + ' 次' } };
  },
  timers() {
    const names = ['mind-sweep', 'longing-check', 'evolve-check', 'avatar-skip'];
    const t = tail('logs/autoreply.log', 800).map((l) => safe(() => JSON.parse(l), null)).filter(Boolean);
    const seen = {};
    for (const n of names) {
      const ev = t.filter((e) => e.event === n).pop();
      seen[n] = ev ? Math.round((Date.now() - ev.t) / 60000) + ' 分钟前' : '未见';
    }
    return { 'badge': 'ok', 'facts': seen };
  },
  qq() {
    const idx = readJson(path.join(ROOT, 'assets', 'stickers', 'index.json'));
    return { 'badge': exists('scripts/ob11.token') ? 'ok' : 'warn', 'facts': { 'OneBot 令牌': exists('scripts/ob11.token') ? '已配置' : '缺失' } };
  },
  net() { return { 'badge': exists('scripts/gw.token') ? 'ok' : 'warn', 'facts': { '模型网关令牌': exists('scripts/gw.token') ? '已配置' : '缺失', 'TLS': '默认限制 TLS1.2' } }; },
  phone() { return { 'badge': 'idle', 'facts': { '状态': '备用通道，未启用' } }; },
  brain() {
    const cfg = readJson(path.join(ROOT, 'config', 'brain.json'), {});
    return {
      'badge': 'ok',
      'facts': { '模型': (cfg.models || []).join(' / ') || '—', '超时': (cfg.timeoutMs || '?') + 'ms', '抢答上限': (cfg.raceDeadlineMs || '?') + 'ms' }
    };
  },
  vision() { return { 'badge': 'ok', 'facts': { '预处理': 'gif/webp → 2×2 帧拼图 PNG', '出口': '本机网关多模态 combo' } }; },
  say() {
    const bad = dirCount('logs', 'say-bad.jsonl');
    return { 'badge': 'ok', 'facts': { '兜底样本': (tail('logs/say-bad.jsonl', 1).length ? '有' : '暂无') } };
  },
  context() {
    const ctx = mod('context');
    const list = ctx ? safe(() => ctx.list(), []) : [];
    return { 'badge': 'ok', 'facts': { '会话数': list.length, '原文最多': (ctx && ctx.DEFAULTS ? ctx.DEFAULTS.budgetChars : '?') + ' 字符', '保留最近': ctx && ctx.DEFAULTS ? ctx.DEFAULTS.keepRecent + ' 条' : '?' } };
  },
  forward() {
    const n = dirCount('logs/forwards', '.json');
    return { 'badge': 'ok', 'facts': { '缓存条目': n, '开关': '开' } };
  },
  quote() {
    const n = dirCount('logs/quotes', '.json');
    const cfg = readJson(path.join(ROOT, 'config', 'autoreply.json'), {});
    return { 'badge': 'ok', 'facts': { '缓存条目': n, '看图': cfg.quote && cfg.quote.analyzeImage ? '开' : '关' } };
  },
  ties() {
    const t = mod('ties');
    const rows = t ? safe(() => t.list(), []) : [];
    const lover = (rows || []).find((r) => r.type === 'lover');
    const cooling = (rows || []).filter((r) => r.phase === 'cooling').length;
    return {
      'badge': rows.length ? 'ok' : 'idle',
      'facts': {
        '有档案的人': (rows || []).length,
        '恋人': lover ? (lover.nick || lover.key) : '没有',
        '冷战/前任': cooling + ' / ' + (rows || []).filter((r) => r.type === 'ex').length
      }
    };
  },
  presence() {
    const p = mod('presence');
    const st = p ? safe(() => p.status(), null) : null;
    if (!st) return { 'badge': 'idle', 'facts': { '状态': '没装' } };
    return {
      'badge': st.paused ? 'warn' : (st.current ? 'ok' : 'idle'),
      'facts': {
        '当前': st.current ? (st.current.label || st.current.id) : '还没设过',
        '保持': st.minutesSince == null ? '-' : st.minutesSince + ' 分钟',
        '今天改了几次': st.todayCount == null ? '-' : st.todayCount,
        '暂停': st.paused ? '是（连续失败）' : '否'
      }
    };
  },
  rvc() {
    const r = mod('rvc');
    if (!r) return { badge: 'idle', facts: {} };
    const st = r.status();
    const probe = r.probe ? null : null;
    return {
      badge: st.enabled ? 'ok' : 'idle',
      facts: { '渠道': st.enabled ? '开' : '关', '服务端': st.baseUrl, '音色模型': st.model || '（未指定）', '换声缓存': st.cached + ' 个' }
    };
  },
  gsv() {
    const v = mod('voice');
    const cfg = v ? safe(() => v.loadCfg(), {}) : {};
    const g = cfg.gsv || {};
    const dir = path.join(ROOT, 'vendor', 'voices');
    const wavs = safe(() => fs.readdirSync(dir).filter(f => /\.wav$/i.test(f)), []);
    const port = (String(g.baseUrl || '').match(/:(\d{2,5})/) || [null, '?'])[1];
    return {
      'badge': g.enabled === true ? 'ok' : 'idle',
      'facts': {
        '服务端': '127.0.0.1:' + port,
        '当前音色': g.voice || '（未指定）',
        '参考音频': wavs.length + ' 个',
        '当前 provider': cfg.provider || 'edge',
        '语速': String(g.speed || 1) + ' · 缓存 ' + String(g.cacheHours || 24) + 'h'
      }
    };
  },
  voice() {
    const v = mod('voice');
    const cfg = v ? safe(() => v.loadCfg(), {}) : {};
    const n = dirCount('logs/voice', '.mp3') + dirCount('logs/voice', '.wav');
    return {
      'badge': 'ok',
      'facts': { '合成通道': cfg.provider || 'sapi', '音色': cfg.voice || '系统默认', '留下的音频': n }
    };
  },
  them() { return { 'badge': 'ok', 'facts': { '有记录的会话': dirCount('logs/them', '.json') } }; },
  timeline() {
    const tl = mod('timeline');
    const rows = tl ? safe(() => tl.list(), []) : [];
    const last = rows.map((r) => r.last).filter(Boolean).sort((a, b) => b.endAt - a.endAt)[0] || null;
    return {
      'badge': rows.length ? 'ok' : 'idle',
      'facts': {
        '会话数': rows.length,
        '间隔条数': rows.reduce((n, r) => n + (r.spans || 0), 0),
        '最近一条': last ? `${last.label} 约 ${last.minutes} 分钟` : '还没有'
      }
    };
  },
  mind() {
    const mind = mod('mind');
    const keys = mind ? safe(() => mind.allKeys(), []) : [];
    return { 'badge': 'ok', 'facts': { '有记忆的会话': keys.length, '记忆图': 'logs/mind/*-graph.json' } };
  },
  bonds() {
    const bonds = mod('bonds');
    const list = bonds ? safe(() => bonds.list('p:0'), null) : null;
    return { 'badge': 'ok', 'facts': { '事件类型': bonds ? Object.keys(bonds.EVENTS || {}).length + ' 类' : '?', '账本': dirCount('logs/bonds', '.json') + ' 个会话' } };
  },
  style() {
    const cfg = readJson(path.join(ROOT, 'config', 'style.json'), {});
    return { 'badge': 'ok', 'facts': { '不熟阈值': (cfg.friendIntimacy ?? '?') + ' / 很熟 ' + (cfg.closeIntimacy ?? '?'), '太长会截断': '是' } };
  },
  echo() {
    const echo = mod('echo');
    const list = echo ? safe(() => echo.list(), []) : [];
    const warm = list.filter((x) => x.lastKind === 'warm').length;
    const cold = list.filter((x) => x.lastKind === 'cold').length;
    return { 'badge': 'ok', 'facts': { '会话数': list.length, '最近热络': warm, '最近冷淡': cold } };
  },
  mode() {
    const mode = mod('mode');
    const list = mode ? safe(() => mode.list(), []) : [];
    const byMode = {};
    for (const it of list) for (const [k, v] of Object.entries(it.byMode || {})) byMode[k] = (byMode[k] || 0) + v.n;
    return { 'badge': 'ok', 'facts': { '会话数': list.length, '各模式次数': Object.entries(byMode).map(([k, v]) => k + ':' + v).join(' ') || '—' } };
  },
  self() {
    const self = mod('self');
    const st = self ? safe(() => self.state(), null) : null;
    return { 'badge': 'ok', 'facts': { '此刻在': st ? (st.activity || st.label || '—') : '—', '已持续': st && st.since ? Math.round((Date.now() - st.since) / 60000) + ' 分钟' : '—' } };
  },
  clock() {
    const clock = mod('clock');
    const info = clock ? safe(() => clock.noteFor({}).info, null) : null;
    return { 'badge': 'ok', 'facts': { '今天': info ? info.weekday + ' · ' + info.phase : '—', '节日': info && info.holiday && info.holiday.name ? info.holiday.name : '无' } };
  },
  longing() {
    const lg = mod('longing');
    const list = lg ? safe(() => lg.list(), []) : [];
    const plan = lg ? safe(() => lg.plan(), []) : [];
    const follow = lg ? safe(() => lg.followUpCandidates(), []) : [];
    return {
      'badge': plan.length ? 'warn' : 'ok',
      'facts': { '会话数': list.length, '现在该开口': plan.length, '该补一句': follow.length }
    };
  },
  promises() {
    const n = dirCount('logs/promises', '.json');
    return { 'badge': 'ok', 'facts': { '有承诺的会话': n } };
  },
  follow() {
    const f = mod('follow');
    const list = f ? safe(() => f.list(), []) : [];
    return { 'badge': 'ok', 'facts': { '开着的窗口': list.length } };
  },
  nick() {
    const n = mod('nick');
    const cur = n ? safe(() => n.currentNames(), []) : [];
    return { 'badge': 'ok', 'facts': { '现用名': cur.slice(0, 3).join(' / ') || '—', '待定要求': dirCount('logs/nick', '.json') } };
  },
  stickers() {
    const st = mod('stickers');
    const all = st ? safe(() => st.allStickers(), []) : [];
    const imgs = all.filter((x) => x.kind === 'image');
    const banned = all.filter((x) => x.banned || /^dsh-/.test(x.id)).length;
    const learned = all.filter((x) => Number(x.learnScore) > 0).length;
    return {
      'badge': 'ok',
      'facts': { '图片表情': imgs.length + ' 张', '系统小黄脸': (all.length - imgs.length) + ' 个', '已禁用': banned, '被夸过的': learned }
    };
  },
  stickerFetch() {
    const cfg = readJson(path.join(ROOT, 'config', 'autoreply.json'), {});
    return { 'badge': 'ok', 'facts': { '自动上网找': cfg.stickers && cfg.stickers.autoFetch === false ? '关' : '开', '每小时上限': 6 } };
  },
  voice() {
    const cfg = readJson(path.join(ROOT, 'config', 'autoreply.json'), {});
    return { 'badge': 'idle', 'facts': { '自动发语音': cfg.voice && cfg.voice.enabled ? '开' : '关', '概率': cfg.voice ? cfg.voice.probability : '—' } };
  },
  avatar() {
    const asrc = mod('avatar-src');
    const st = asrc ? safe(() => asrc.status(), null) : null;
    const cfg = readJson(path.join(ROOT, 'config', 'avatar.json'), {});
    return { 'badge': 'ok', 'facts': { '图池': st ? st.total + ' 张（网图 ' + st.web + ' / 别人发 ' + st.peer + '）' : '—', '自动换': cfg.enabled ? '开' : '关' } };
  },
  risk() {
    const r = mod('risk');
    const st = r ? safe(() => r.status(), null) : null;
    return {
      'badge': st && st.level !== 'normal' ? 'bad' : 'ok',
      'facts': {
        '档位': st ? st.level : '—',
        '冷却剩': st && st.coolingLeftMin ? st.coolingLeftMin + ' 分钟' : '无',
        '今日': st ? '登录 ' + st.today.login + ' / 重启 ' + st.today.restart : '—',
        'C通道主动': safe(() => (r.loadCfg().allowProactiveOnClient ? '允许' : '仅 A 通道'))
      }
    };
  },
  pacing() {
    const p = mod('pacing');
    const st = p ? safe(() => p.status(), null) : null;
    return { 'badge': 'ok', 'facts': { '打字速度': st ? st.typing.charsPerSec + ' 字/秒' : '—', '切换窗口': st ? st.switching.base + '–' + st.switching.max + 'ms' : '—' } };
  },
  group() {
    const g = mod('group');
    const cfg = g ? safe(() => g.loadCfg(), {}) : {};
    return { 'badge': 'ok', 'facts': { '被@后跟随': cfg.follow === false ? '关' : '开', '提到名字': cfg.allowNameMention === false ? '不插话' : '会判断', '插话冷却': (cfg.myCooldownMin ?? '?') + ' 分钟' } };
  },
  evolve() {
    const e = mod('evolve');
    const rows = e ? safe(() => e.collectRecords(), []) : [];
    const tune = readJson(path.join(ROOT, 'config', 'tuning.json'), null);
    return {
      'badge': 'ok',
      'facts': { '样本量': rows.length + ' 条', '最近调参': tune && tune.updatedAt ? new Date(tune.updatedAt).toLocaleString('zh-CN') : '还没调过' }
    };
  },
  store() { return { 'badge': 'ok', 'facts': { '策略': '临时文件 + rename，4 次重试后退回直写' } }; },
  arch() {
    const out = safe(() => require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'arch.js'), '--check'], { 'encoding': 'utf8', 'timeout': 30000 }), '');
    return { 'badge': /通过/.test(out) ? 'ok' : 'warn', 'facts': { '检查': /通过/.test(out) ? '一致性通过' : '有不一致（见 ARCHITECTURE.md）' } };
  },
  panel() { return { 'badge': 'ok', 'facts': { '端口': PORT, '已运行': Math.round((Date.now() - T0) / 60000) + ' 分钟' } }; }
};

function blocksPayload() {
  return BLOCKS.map((b) => {
    const probe = safe(() => PROBES[b.probe](), { 'badge': 'warn', 'facts': { '状态': '读取失败' } }) || { 'badge': 'warn', 'facts': {} };
    return { ...b, 'badge': probe.badge || 'ok', 'facts': probe.facts || {} };
  });
}

async function overviewPayload() {
  const qq = await qqStatus();
  const p = safe(() => procs(), { 'qq': 0, 'autoReply': [], 'watchdog': [], 'collector': [], 'panel': [], 'error': 'ps 失败' });
  const risk = safe(() => mod('risk').status(), null);
  const selfSt = safe(() => mod('self').state(), null);
  const clockInfo = safe(() => mod('clock').noteFor({}).info, null);
  const ctxList = safe(() => mod('context').list(), []);
  return {
    'now': Date.now(),
    'panelUptimeMin': Math.round((Date.now() - T0) / 60000),
    qq,
    'procs': p,
    risk,
    'self': selfSt,
    'clock': clockInfo,
    'counts': {
      '会话': ctxList.length,
      '记忆': safe(() => mod('mind').allKeys().length, 0),
      '表情图': safe(() => mod('stickers').allStickers().filter((x) => x.kind === 'image').length, 0),
      '头像池': safe(() => mod('avatar-src').status().total, 0),
      '承诺': dirCount('logs/promises', '.json'),
      '群窗口': safe(() => mod('follow').list().length, 0)
    },
    'fresh': { 'autoreply': mtimeAgo('logs/autoreply.log'), 'watchdog': mtimeAgo('logs/watchdog.log') }
  };
}

function sessionsPayload() {
  const ctx = mod('context');
  const list = ctx ? safe(() => ctx.list(), []) : [];
  const mind = mod('mind');
  const echo = mod('echo');
  const mode = mod('mode');
  const bonds = mod('bonds');
  return list.map((c) => {
    const key = c.key;
    const st = mind ? safe(() => mind.loadState(key), null) : null;
    const rel = st ? safe(() => (bonds ? bonds.effectiveRel(key, st.rel, Date.now()) : st.rel), null) : null;
    const ec = echo ? safe(() => echo.list().find((x) => x.key === key), null) : null;
    const md = mode ? safe(() => mode.list().find((x) => x.key === key), null) : null;
    return {
      key,
      'kind': c.kind,
      'turns': c.turns,
      'chars': c.chars,
      'idleMin': c.idleMin,
      'updatedAt': c.updatedAt,
      'pad': st ? st.pad : null,
      rel,
      'moodText': st && mind ? safe(() => mind.describeMood(st).text, '') : '',
      'bondText': st && mind ? safe(() => mind.describeBond(st).text, '') : '',
      'echoKind': ec ? ec.lastKind : null,
      'echoEma': ec ? ec.ema : null,
      'modeBias': md ? Object.fromEntries(Object.entries(md.byMode || {}).map(([k, v]) => [k, Math.round(v.bias * 100) / 100])) : null
    };
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function sessionPayload(key) {
  const ctx = mod('context');
  const mind = mod('mind');
  const bonds = mod('bonds');
  const echo = mod('echo');
  const mode = mod('mode');
  const them = mod('them');
  const promises = mod('promises');
  const follow = mod('follow');
  const tl = mod('timeline');

  const view = ctx ? safe(() => ctx.view(key), null) : null;
  const st = mind ? safe(() => mind.loadState(key), null) : null;
  const rel = st ? safe(() => bonds.effectiveRel(key, st.rel, Date.now()), st.rel) : null;
  const bits = mind ? safe(() => mind.promptBits(key, ''), null) : null;
  return {
    key,
    view,
    'state': st,
    rel,
    'mood': st && mind ? safe(() => mind.describeMood(st), null) : null,
    'bond': st && mind ? safe(() => mind.describeBond(st), null) : null,
    bits,
    'echo': echo ? safe(() => echo.status(key), null) : null,
    'mode': mode ? safe(() => mode.list().find((x) => x.key === key), null) : null,
    'them': them ? safe(() => them.loadState(key), null) : null,
    'promises': promises ? safe(() => promises.list(key), null) : null,
    'follow': follow ? safe(() => follow.list().find((x) => x.key === key), null) : null,
    'bondEvents': bonds ? safe(() => bonds.list(key), null) : null,
    // 时间线：从时间戳里算出来的「去洗澡→洗完了 约 32 分钟」
    'timeline': tl ? safe(() => tl.noteFor(key), { note: '', spans: [] }) : null
  };
}

function initiativePayload() {
  const lg = mod('longing');
  return {
    'list': lg ? safe(() => lg.list(), []) : [],
    'plan': lg ? safe(() => lg.plan(), []) : [],
    'follow': lg ? safe(() => lg.followUpCandidates(), []) : [],
    'global': lg ? safe(() => lg.loadGlobal(), null) : null,
    'cfg': lg ? safe(() => lg.loadCfg(), {}) : {}
  };
}

const LOGS = {
  'autoreply': 'logs/autoreply.log',
  'watchdog': 'logs/watchdog.log',
  'watchdog-console': 'logs/watchdog-console.log',
  'inbox': 'logs/inbox.jsonl',
  'say-bad': 'logs/say-bad.jsonl',
  'autoreply-console': 'logs/auto-reply-console.log'
};

// 「试一句」：起一个独立子进程跑 dryrun（隔离目录，绝不发送）
function dryRun(key, text, allowFetch) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'dryrun.js'), key, text];
    const env = { ...process.env };
    if (!allowFetch) env.STICKER_FETCH_DISABLED = '1';
    execFile(process.execPath, args, { env, 'timeout': 90000, 'maxBuffer': 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const lines = String(stdout || '').trim().split('\n');
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { parsed = JSON.parse(lines[i]); break; } catch (e) { /* 继续往前找 */ }
      }
      if (!parsed) {
        resolve({ 'ok': false, 'why': String((err && err.message) || '子进程没有返回结果').slice(0, 300), 'stderr': String(stderr || '').slice(-500) });
        return;
      }
      resolve(parsed);
    });
  });
}

// 配置开关（白名单，只允许这些布尔/数字项，避免误改结构性配置）
const CONFIG_WRITES = {
  'echo.enabled': ['autoreply.json', ['echo', 'enabled']],
  'mode.enabled': ['autoreply.json', ['mode', 'enabled']],
  'say.enabled': ['autoreply.json', ['say', 'enabled']],
  'stickers.enabled': ['autoreply.json', ['stickers', 'enabled']],
  'stickers.analyzeIncoming': ['autoreply.json', ['stickers', 'analyzeIncoming']],
  'stickers.autoFetch': ['autoreply.json', ['stickers', 'autoFetch']],
  'quote.analyzeImage': ['autoreply.json', ['quote', 'analyzeImage']],
  'voice.enabled': ['autoreply.json', ['voice', 'enabled']],
  'mind.enabled': ['autoreply.json', ['mind', 'enabled']],
  'risk.allowProactiveOnClient': ['risk.json', ['allowProactiveOnClient']],
  'avatar.enabled': ['avatar.json', ['enabled']],
  'longing.enabled': ['longing.json', ['enabled']],
  'evolve.apply': ['evolve.json', ['apply']]
};

function setConfig(pathStr, value) {
  const spec = CONFIG_WRITES[pathStr];
  if (!spec) throw new Error('不允许修改这个配置项：' + pathStr);
  const [file, keys] = spec;
  const full = path.join(ROOT, 'config', file);
  const json = readJson(full);
  if (!json) throw new Error('读不到 ' + file);
  let node = json;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  const store = mod('..' + path.sep + 'lib' + path.sep + 'store');
  const ok = store ? store.writeJson(full, json) : false;
  if (!ok) { fs.writeFileSync(full, JSON.stringify(json, null, 2), 'utf8'); }
  return { 'ok': true, file, 'path': pathStr, value };
}

// ══════════════════════════════════════════════════════════════════
//  三、HTTP
// ══════════════════════════════════════════════════════════════════
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(buf);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  // 静态资源
  if (p === '/' || p === '/index.html') {
    const html = safe(() => fs.readFileSync(path.join(UI_DIR, 'index.html')), null);
    if (!html) return send(res, 500, 'assets/panel/index.html 不存在');
    return send(res, 200, html, MIME['.html']);
  }
  if (/^\/(app\.js|style\.css)$/.test(p)) {
    const file = path.join(UI_DIR, p.slice(1));
    const buf = safe(() => fs.readFileSync(file), null);
    if (!buf) return send(res, 404, 'not found');
    return send(res, 200, buf, MIME[path.extname(file)] || 'text/plain');
  }

  if (!p.startsWith('/api/')) return send(res, 404, { 'ok': false, 'why': 'not found' });
  if (TOKEN) {
    const got = u.searchParams.get('token') || req.headers['x-panel-token'];
    if (got !== TOKEN) return send(res, 401, { 'ok': false, 'why': 'token 不对' });
  }

  try {
    if (p === '/api/overview') return send(res, 200, await overviewPayload());
    if (p === '/api/blocks') return send(res, 200, { 'blocks': blocksPayload(), 'pipeline': PIPELINE });
    if (p === '/api/sessions') return send(res, 200, { 'sessions': sessionsPayload() });
    if (p === '/api/session') {
      const key = u.searchParams.get('key') || '';
      if (!key) return send(res, 400, { 'ok': false, 'why': '缺 key' });
      return send(res, 200, sessionPayload(key));
    }
    if (p === '/api/initiative') return send(res, 200, initiativePayload());
    if (p === '/api/logs') {
      const name = u.searchParams.get('name') || 'autoreply';
      const lines = Math.min(500, Math.max(20, Number(u.searchParams.get('lines') || 150)));
      const file = LOGS[name];
      if (!file) return send(res, 400, { 'ok': false, 'why': '没有这个日志' });
      return send(res, 200, { name, file, 'lines': tail(file, lines) });
    }
    if (p === '/api/dry' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.key || !body.text) return send(res, 400, { 'ok': false, 'why': '需要 key 与 text' });
      const r = await dryRun(body.key, String(body.text).slice(0, 500), !!body.allowFetch);
      return send(res, 200, r);
    }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, setConfig(body.path, body.value));
    }
    if (p === '/api/health') return send(res, 200, { 'ok': true, 'uptimeMin': Math.round((Date.now() - T0) / 60000) });
    return send(res, 404, { 'ok': false, 'why': '没有这个接口：' + p });
  } catch (e) {
    return send(res, 500, { 'ok': false, 'why': String((e && e.message) || e) });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('[panel] 控制台已启动 http://' + HOST + ':' + PORT + (TOKEN ? '/?token=…' : ''));
  });
}

module.exports = { server, BLOCKS, PIPELINE, PROBES, blocksPayload, overviewPayload, sessionsPayload, sessionPayload, initiativePayload, setConfig, CONFIG_WRITES, LOGS, dryRun };
