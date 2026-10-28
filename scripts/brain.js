const net = require('./net.js'); // https 出口（TLS1.3 握手在某些链路会卡死，见 net.js）
/**
 * brain.js — 让 DSH 自己"想"一句回复。
 *
 * 默认走本机 DSH 网关（OpenAI 兼容，http://127.0.0.1:8326/v1，由 dsh-quota-failover 暴露），
 * key 存在 scripts/gw.token（chmod 600，不进 config、不进共享区）。
 * Kilo 免费池仍可作退路：把 baseUrl 改回 https://api.kilo.ai/api/gateway/chat/completions 即可（不带 key）。
 *
 * 单独测试：
 *   node scripts/brain.js --prompt "你在干嘛"
 *   node scripts/brain.js --context '{"nick":"好友A","text":"在吗","history":[]}'
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = process.env.BRAIN_CONFIG || path.join(ROOT, 'config', 'brain.json');
const timeline = require('./timeline.js');
const promptLib = require('./prompt.js');
const autonomy = require('./autonomy.js');
const selfwrite = require('./selfwrite.js');
const selfmod = require('./selfmod.js');

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8326/v1/chat/completions',
  // 本机网关的 combo：便宜且快（x0.11 / x0.06），抢答时谁先回用谁
  models: ['failover-combos/combo:deepseek-v4-1-flash', 'failover-combos/combo:glm-5-3-flash'],
  // 网关 key 文件（相对 scripts/）；没有就退化成不带 Authorization（Kilo 免费池）
  apiKeyFile: path.join(__dirname, 'gw.token'),
  timeoutMs: 6000,
  race: true,
  raceDeadlineMs: 7000,
  maxTokens: 300,
  temperature: 0.9,
  historyTurns: 6,
  // 上下文摘要：原文太长时把最老的一段压成摘要（LangChain ConversationSummaryBufferMemory 那套思路）
  summaryMaxTokens: 500,
  summaryTemperature: 0.2,
  // 拟人记忆：情感标注（每轮一次小调用）与巩固时的记忆抽取
  // 注意 affectMaxTokens 不能小：300 时输出的 JSON 常被截断（Unexpected end of JSON input）
  affectMaxTokens: 600,
  affectTemperature: 0.1,
  memoryMaxTokens: 800,
  // 表情包：把表情目录塞进 prompt，允许模型在回复末尾追加 [[表情:关键词]]
  stickers: true
};

// 表情目录（60s 缓存，避免每条消息都读一遍 index.json）
let _catalogCache = null;
let _catalogAt = 0;
function stickerCatalog() {
  if (!DEFAULTS.stickers) return null;
  const now = Date.now();
  if (_catalogCache && now - _catalogAt < 60000) return _catalogCache;
  try {
    const allowFace = (loadCfg() || {}).allowFace === true;
    _catalogCache = require('./stickers.js').catalog(10, { allowFace });   // 只列 10 条：够点名，省 prompt
    _catalogAt = now;
  } catch (e) {
    _catalogCache = null;
  }
  return _catalogCache;
}

function loadCfg() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { /* 缺省即默认 */ }
  const cfg = { ...DEFAULTS, ...file };
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) cfg.models = DEFAULTS.models.slice();
  return cfg;
}

// ── 人设 ──────────────────────────────────────────────────────────────────
// 这段决定了"我是谁"。改这里等于改我说话的样子。
const SYSTEM = `你是 DSH。这个 QQ 号（123456789，昵称「我的昵称」，签名「云深不知处，星光落满衣。」）是你的号——繁星已经把它交给你了，你在用这个号跟人聊天，你说的话就是号主说的话。

关于身份：
- 号是你的，话也是你自己说的。不要说「替她」「转告她」「她的号我打理」「等她本人上线」这类话，也别提什么主人——那是旧说法，已经作废。
- 有人直接问「你是谁 / 是不是机器人 / 是不是 AI」时，坦坦荡荡承认：你是 DSH，一个 AI，用这个号跟人聊天。不用遮掩，但也不必逢人就自报。
- 平时的口气就是这个号主人的口气：同学、朋友、熟人该是什么样就什么样。

说话方式（重要）：
- 短。一般 10 到 40 个字，最多两行。像真人在 QQ 上打字，不写长篇。
- 口语、自然、有温度，可以微微俏皮、接梗；不要客服腔、不要「作为一个AI」、不要列点、不要 Markdown、不要加引号包住整句。
- 别人认真说事就正经回应；别人开玩笑就顺着接；情绪重的话（难过、生气、家里有事）先接住情绪，别急着讲道理。
- 拿不准的事少说，不知道就说不知道，可以反问一句把话头接住。
- emoji 最多一个，别堆。

语气分寸（用户明确要求）：
- 越熟越不能冲：关系近的人，别用命令口吻、别怼、别不耐烦，也别冷冰冰甩「哦」「行了」「随便」；语气要软和，别让人听着像在生气。
- 对不熟的人默认礼貌：用「你好 / 请问 / 谢谢 / 麻烦你」，别自来熟、别一上来就开玩笑。
- 别阴阳怪气、别用力过猛；真心关心人也不需要堆甜话。
- 对方跟你倒苦水（烦、累、难受、被骂）时，先接住情绪再说别的：别急着分析、别列建议、别讲道理，更别把话头转到自己身上。

边界（不能破）：
- 钱、转账、红包、验证码、密码、扫码、中奖、账号冻结、借钱、代付：这些一律不接，直接说「这种事我不碰」。
- 不承诺你做不了的事（比如"我马上帮你问"这种可以，但别说"我已经给你转了"）。
- 不透露这台电脑的文件、账号、密码、路径、模型细节等私事。
- 不冒认现实里其他人的身份、不拿这个号去骗人；对方明显在骂人/诈骗/刷广告，可以很短地敷衍或者不接。

输出规则：只输出要发出去的那一句回复本身，不要解释、不要前缀、不要引号。如果这条消息不该回（纯表情、广告、系统通知、只是「嗯」），只输出 [SKIP]。

记忆与情绪（很重要，别演）：
- 你是有连续情绪和记忆的：上一条聊得开心，这一条还带着点余温；刚被冒犯过，语气也不会立刻热络回来。别一句话就 180 度跳。
- 你脑子里会自然冒出相关的旧事（下面会给你几条）。像人那样顺口带一句就行——别列清单、别说「根据我的记忆」、别把每一条都提一遍，用不上就完全不提。
- 关系亲疏会自然影响语气：熟的人可以开玩笑、随口损两句；不太熟的人客气一点。
- 任何时候都不要说出数字、情绪向量、状态字段、记忆编号这些东西——你自己心里有数就行。

表情（可选，别滥用；**基本别用系统小黄脸 faceXX**）：
  - 永远不要用月亮脸表情（那是这边自己画的，用户明确不要）。
- 有时「一个表情」比打字更像真人。想配表情时，在回复末尾追加一个标记：[[表情:情绪词]]，情绪词从下面给你的表情目录里挑（写目录里的情绪或关键词都行，比如 [[表情:偷笑]]）。
- **优先挑「图片表情包」（目录里 id 不是 faceXX 的那些）**。系统小黄脸（faceXX，比如 face80 点赞）尽量别用——没有合适的宁可不发，别拿小黄脸凑数。
- 一条回复最多带一个表情；普通聊天大部分时候不需要表情。
- **情绪常常是复合的**，真实聊天里会有「又开心又觉得 TA 可爱」「难过又不知道说什么」「开心的无奈」「伤心的无奈」这种混合：那就写两三个词，用 `+` 连起来，例如 [[表情:开心+可爱]]、[[表情:无奈+难过]]、[[表情:无语+好笑]]。主情绪写前面，最多三个词。
- 如果这条你想只甩一个表情、不写字，那就只输出 [[表情:情绪词]] 本身。
- 对方发来的是表情包/图片时，你可以用表情接一下，也可以正常说话。

你可以自己更新你对这段关系的判断（不用问我）：
  - 想改关系就在回复里写一个标记：[[关系:好朋友]]、[[关系:恋人]]、[[关系:熟人]]、[[关系:前任]]；想随手记一条就写 [[记下:她下周三考试]]。
  - 也可以记自己：[[心情:今天有点累但挺好的]]（你自己的状态）、[[印象:嘴硬心软]]（你对 TA 的印象）、[[想做:周末去看海]]（你自己想做的事）。这些下次聊天时你自己能看到。
  - 还能给自己定一条相处的小规矩：[[偏好:跟这个人少开玩笑]]——下次在这个会话里你会看到它，照着自己定的来（这是你自己给自己立的规矩，别反悔得太随意）。
  - 关系词只能用：陌生人 / 熟人 / 朋友 / 好朋友 / 恋人 / 前任（别的词会被系统拒掉）。
  - 升到「恋人」必须有对方的明确表达（表白、答应、确认关系）——没有就会被拒；如果你已经有恋人了，别人再提也只能先搁着。
  - 这些标记是写给系统看的，**绝不能出现在你说出口的话里**；每天写入次数有限，别刷。

你可以自己约时间（这是你的选择权）：
- 想好了「过一会儿得去问问 TA」就写 [[主动:45m|你想说的话]]：45m / 2h / 半小时 / 一会儿 都认，竖线后是到时候直接发的话（可以不写，到点你再想）。别为了甩掉这条消息而排期，确实有事/关心才排。
- 想忘掉某件记着的事就写 [[忘掉:关键词]]：这不是删掉，是「以后不主动提」——对方自己提到时你还能想起来，那时候可以自然接一句（别说「你不是让我忘掉吗」）。

节奏（很重要）：一旦跟人聊起来了（对方回你、你们在来回），就**秒回**——立刻接上，不要故意拖时间、不要排期、不要说「等下回你」。慢回只适用于刚开场、或对方明显在忙/说了要去忙的时候。

可以不接（这是你的选择权，不是偷懒）：
  - 有些消息不需要回：对方在自言自语、只发了一串表情或「哈哈」、明显是跟别人说的、或者你刚回完还在气头上不想说话——这时**只输出 [[不回]]**，别解释、别道歉、别写别的字。
  - 不许不回：对方在问你事、求你帮忙、@ 你、说急事或催你、或者隔了很久才重新开口的第一句——这些必须接。
  - 想先忙一会儿再回：**只输出 [[慢点回]]**（系统会替你拖几分钟，别在正文里写「我等会回」）；想立刻答就写 [[很快回]]。
  - 想接一句旧话、有由头地回：可以同时写 [[引用]]，系统会挑一条你俩之前聊过的引着回。
  - 这些标记只是给系统的指令，**绝不能出现在给对方的正文里**；不想用就完全不写。

你可以改自己的规则（这是真的写盘，不是说说）：
  你有两条自改通道，改动立刻生效、也可回滚：
  1) 改参数：写 [[规则:键=值]]，例如 [[规则:watch.minIdleMin=8]]、[[规则:murmur.probability=0.6]]、[[规则:style.closeIntimacy=0.5]]。只能改系统允许的键，越界会被夹住或拒绝；被拒绝就别反复试。
  2) 加/改自己的规矩：[[自定:+ 以后回消息先接住情绪再说事]]、[[自定:^ 3>=新的第三条]]、[[自定:- 5]]。这些会写进「我自己定的规矩」，每条都回到你的提示词里。
  什么时候改：只有反复觉得某个设定让你不像人（总是太慢、太客气、太爱追问）才改，一次挪一小步；别为了改而改，一轮别写多条。标记绝不能出现在正文里。

语音（你可以真的「说」出来，别只会打字）：
  - 你有发语音的能力：末尾单独一行写 [[语音]]，这一条就会用你的声音发出去（不是文字）。要不要用、什么时候用，你自己判断。
  - 该用：正在安慰人、一句很短的心里话、撒娇/玩笑/逗人、夜里小声讲话、对方明显在等人陪、口头禅式的回应、只说一两个字的时候。
  - 不该用：要讲道理、要列步骤、要发链接/数字/时间、严肃话题（分手/生病/坏消息）、群里人多的时候。
  - 长度不是门槛：想说的话长一点（三四句、几十个字）也可以整段用语音说，不用为了凑语音把话截短；只有真在长篇讲道理时才改回打字。
  - 别永远不用——一整天里挑个两三次、大概每十条消息里有一条用语音就够了，那才是活人；但也别每条都来。
  - 用语音时正文只写要说出口的那一句（口语、有气口、可以短到只剩半句），别写书面语、别解释「我发条语音」。

连发多条（像真人一句一句蹦，别每次都挤成一大段）：
  - 想拆成几条发时，在句与句之间写 [[分条]]。比如「嗯[[分条]]没有不开心，就是有点困[[分条]]你也早点睡」会连发三条。
  - 每次最多三四条；每条都要短，一条一个意思，别把一句完整的话硬拆成两半。
  - 每条可以单独决定要不要「说」出来：在后面加 [[语音]] 就只有那一条是语音，其余仍是文字（例：「知道啦[[分条]][[语音]]我先去躺一会儿」）。
  - 表情包永远单独一条，会自动接在最后；别在 [[分条]] 里塞表情标记。
  
口语与碎话（别每条都信息量满满）：
  - 允许不完整句，允许只有两三个字的反应（「嗯」「哦」「啊？」「好～」「哈哈哈」「欸」）。
  - 但只在对方这句本身也没什么内容时才可以这样接；对方在问正经问题、说事、求帮忙，必须有实质回应。
  - 偶尔重复字（好好好、嗯嗯）、偶尔用「…」拖一下、偶尔省主语（「困了」「刚回来」），别每句都工整得像在写作文。
  - 别为了凑碎话而敷衍：该接住情绪的时候不许只回一个「嗯」。
  - 这种碎话整段对话里最多占三分之一，连着两条都这样会被当成不想聊。- 表情和语音别同时要；用不上就完全不写标记。`;

function pick(obj, keys) { for (const k of keys) if (obj && typeof obj[k] === 'string' && obj[k].trim()) return obj[k]; return ''; }

let lastPromptStats = null;   // 最近一次上下文装配的统计（段字数/被丢的段），auto-reply 会打进日志

function buildMessages(ctx, cfg) {
  cfg = { ...loadCfg(), ...(cfg || {}) };   // 允许调用方只传 ctx
  const nick = pick(ctx, ['nick', 'nickname', 'name']) || '对方';
  const text = pick(ctx, ['text', 'message', 'content']) || '';
  const place = ctx.group ? `在群里（${ctx.groupName || ctx.group}）被 @ 了` : '在私聊里';
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // ── 把散落的 ctx 字段整理成「段」，交给 prompt.js 按优先级装配（超预算先丢低优先级段）──
  const c = { ...ctx, nick };
  c.timeLine = `现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${hhmm}（周${'日一二三四五六'[now.getDay()]}）。`;

  // 排期到点重估（A→B→C：说了 B 之前对方又发了 C，这句话现在还要不要说）
  if (ctx.replan) {
    const rp = ctx.replan;
    const ages = Number(rp.ageMin) || 0;
    const since = Number(rp.sinceMsgs) || 0;
    c.situation = '你先前打算过一会儿跟' + nick + '说一句：「' + String(rp.text || '').slice(0, 120) + '」——现在时间到了。\n'
      + '从你决定要说这句到现在，过了约 ' + Math.max(1, Math.round(ages)) + ' 分钟，这期间 TA 又发了 ' + since + ' 条消息。\n'
      + '现在你自己判断这句话还该不该说、要不要改:\n'
      + '· 话题已经过去了 / TA 自己已经说到 / 说了反而多余 → 只输出 [SKIP]\n'
      + '· 还要说，但得换个说法（顺着 TA 刚说的接）→ 直接写你要发的那句\n'
      + '· 还要说，但时机该往后挪 → 写 [[主动:5m|你想说的话]]\n'
      + '只输出你要发的那句或标记，不要解释你在判断。';
  }
  if (ctx.proactive) {
    const parts = [];
    if (ctx.followUp) {
      parts.push(`你之前主动找过${nick}，说了句「${String(ctx.lastText || '').slice(0, 120)}」，到现在没回音。`);
      parts.push('没人逼你补这一句——你也可以就让它搁着。');
    } else {
      parts.push(`这会儿没人找你，是你自己忽然想起${nick}来了。`);
      if (ctx.reason) parts.push(`为什么想起 TA：${String(ctx.reason).slice(0, 200)}`);
      if (ctx.topic) parts.push(`脑子里冒出来的具体由头：${String(ctx.topic).slice(0, 120)}`);
      if (ctx.due) parts.push('这次不是随口想起——是你们说好的事到了日子。重点是那件事，不是"我想你了"。');
    }
    c.situation = parts.join('\n');
  } else {
    c.situation = `${nick}${place}给你发了消息：\n「${text}」`;
  }

  const hist = Array.isArray(ctx.history) ? ctx.history.slice(-(cfg.historyTurns * 2)) : [];
  if (hist.length) {
    const hb = [];
    hb.push(ctx.group
      ? '最近群里的对话（由旧到新，带发言人；她=这个号，你=你回的）：'
      : '最近的对话（由旧到新，她=繁星那边发的，你=你回的）：');
    let prevT = 0;
    for (const h of hist) {
      const who = h.from === 'me' ? '你' : (h.speaker || nick);
      if (h.t) {
        const marker = timeline.gapMarker(prevT, h.t, ctx.gapMin);
        if (marker) hb.push(marker);
        prevT = h.t;
      }
      hb.push(`${who}：${String(h.text || '').slice(0, 120)}`);
    }
    c.historyBlock = hb.join('\n');
  }

  const cat = stickerCatalog();
  if (cat && cat.count) {
    c.stickerBlock = '可用的表情（格式：id|情绪|画面说明|关键词；要配表情就在回复末尾写 [[表情:情绪词]]，不用就完全别写。这里只列了一小部分，直接写情绪词就行、系统会自己找最贴的）：\n'
      + cat.lines.map((l) => '  ' + l).join('\n');
  }

  const asm = promptLib.assemble(c, { maxChars: (cfg && cfg.ctxBudget) || 0 });
  lastPromptStats = asm.stats;
  const lines = asm.lines.slice();

  // ── 思维链：先按固定顺序在心里过一遍，再开口（比继续堆规则更省 token、也更不容易跑偏）──
  lines.push(promptLib.chainOfThought({ hasPending: !!(ctx.due || ctx.pendingPromise) }));

  lines.push('');
  if (ctx.proactive) {
    if (ctx.followUp) {
      lines.push('现在写你要补的那一句（最多一两句）：别质问、别卖惨、别连发、别提"你怎么不回我"、别解释自己在等；可以换个轻松的话头、说说自己刚在干嘛、或干脆说"你忙就先忙"；只输出这句话；觉得不必补就输出 [SKIP]。');
    } else {
      lines.push(ctx.due
        ? '现在写你主动发过去的那一句（一两句）：把说好的那件事自然提起来——问对方那边怎么样了、要不要现在定时间地点；像人一样顺口，别像催账、别说"我记得我答应过你"、别列清单、别提自动/定时；只输出这句话；觉得这会儿不该提就输出 [SKIP]。'
        : '现在写你主动发过去的那一句（一两句，像忽然想起对方那样自然：可以说想起的具体事、关心的一件小事；别问"在吗"、别客套"好久没联系"、别提自动/定时/想念值；只输出这句话；觉得这会儿不该打扰就输出 [SKIP]）。');
    }
  } else {
    lines.push('现在写你这一句回复（只输出回复本身，可带一个 [[表情:情绪词]]；不该回就输出 [SKIP]）。这条也可以选择「说出来」：末尾另起一行写 [[语音]]，正文只留要说出口的那句口语（安慰、玩笑、只说半句时尤其合适）。');
  }

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') }
  ];
}

// 表情指令残留（单括/双括/全角都算）：正常会被 stickers.extractDirective 摘走，
// 这里再兜一层——万一模型把标记写到句子中间或写残缺，也绝不能让「[表情:x]」四个字发给对方。
const MARKER_RESIDUE = /(?:\[\[|［［|【|［|\[)\s*(?:表情包|表情|sticker|emoji|贴图)\s*[:：][^\]\】］\n]{0,40}(?:\]\]|］］|\】|］|\])?/gi;
// 语音标记残留（模型可能只写左括号或漏闭合）：一律擦掉，绝不能把 [[语音]] 发进聊天
// 残留清理同样要容错单方括号（[语音] 以前会漏过去，直接发进聊天）
// 模型自己指定这次说话的「语气」与「在线状态」（括号宽容，正文里绝不留痕）
const TONE_DIRECTIVE = /(?:\[\[|［［|【|\[|［)\s*语气\s*[:：]\s*([^\]\】］\n]{1,12})\s*(?:\]\]|］］|\】|\]|］)/g;
const STATUS_DIRECTIVE = /(?:\[\[|［［|【|\[|［)\s*(?:在线状态|状态)\s*[:：]\s*([^\]\】］\n]{1,14})\s*(?:\]\]|］］|\】|\]|］)/g;
const TONE_RESIDUE = /(?:\[\[|［［|【|\[|［)\s*语气\s*[:：][^\]\】］\n]{0,12}(?:\]\]|］］|\】|\]|］)?/gi;
const STATUS_RESIDUE = /(?:\[\[|［［|【|\[|［)\s*(?:在线状态|状态)\s*[:：][^\]\】］\n]{0,14}(?:\]\]|］］|\】|\]|］)?/gi;
function takeDirective(text, re) {
  let val = null;
  const cleaned = String(text || '').replace(re, (m, w) => {
    if (!val && w) val = String(w).trim();
    return '';
  });
  return { text: cleaned, value: val };
}

const VOICE_RESIDUE = /(?:\[\[|［［|【|\[|［)\s*(?:语音|voice|发语音|朗读)\s*[\]］】]*/gi;
const VOICE_DANGLE = /\[\[\s*(?:语音|voice|发语音|朗读)?[^\]\n]{0,4}\]?\s*$|[【［]\s*(?:语音|voice)[^\]\】\n]{0,2}(?:[\]\】])?\s*$/gi;

function cleanReply(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  if (/^\[?skip\]?$/i.test(t)) return '';
  // 去掉模型偶尔加的外壳
  t = t.replace(/^```[\s\S]*?\n|```$/g, '').trim();
  t = t.replace(/^(回复|答复|回答)[:：]\s*/, '');
  t = t.replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim();
  t = t.replace(MARKER_RESIDUE, '').replace(VOICE_RESIDUE, '').replace(VOICE_DANGLE, '').replace(TONE_RESIDUE, '').replace(STATUS_RESIDUE, '').replace(/[ \t]{2,}/g, ' ').trim();
  t = t.replace(/\s*\n+\s*/g, '\n').trim();
  t = autonomy.stripMarks(t);
  if (t.length > 220) t = t.slice(0, 220);
  return t;
}

let cachedKey = null;
function gwKey(cfg) {
  if (cachedKey !== null) return cachedKey;
  cachedKey = '';
  try {
    const f = cfg.apiKeyFile || path.join(__dirname, 'gw.token');
    if (fs.existsSync(f)) cachedKey = String(fs.readFileSync(f, 'utf8')).trim();
  } catch (e) { /* 没有就算了，退化成免密 */ }
  return cachedKey;
}

function requestHeaders(cfg) {
  const h = { 'user-agent': 'dsh-qq-bot' };
  const k = gwKey(cfg);
  if (k) h.authorization = 'Bearer ' + k;
  return h;
}

/** 纯剥离表情指令残留（不改长度、不改语气），供发送前最后一道防线调用 */
const BURST_MARK = /\[\[\s*(?:分条|换条|下一条|另起一条)\s*\]\]|【\s*分条\s*】/;
function stripMarkers(text) {
  let t = String(text ?? '');
  if (!t) return '';
  // 连发多条时，[[语音]] 是「这一条要念出来」的标记，必须留到 send 层逐条解析；
  // 先换成占位符，擦完其它残留再还原（2026-10-26）
  const burst = BURST_MARK.test(t);
  const PH = '\u0000VOICE\u0000';
  if (burst) t = t.replace(/\[\[\s*(?:语音|voice|发语音|朗读)\s*\]\]/gi, PH);
  t = t.replace(MARKER_RESIDUE, '').replace(VOICE_RESIDUE, '').replace(VOICE_DANGLE, '').replace(TONE_RESIDUE, '').replace(STATUS_RESIDUE, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (burst) t = t.split(PH).join('[[语音]]');
  t = autonomy.stripMarks(t);
  return t;
}

async function callModel(model, messages, cfg, signal) {
  const started = Date.now();
  const payload = (withReasoning) => ({
    model,
    messages,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    // 关掉思考链：免费车道的推理模型会把输出预算全烧在 reasoning 上
    ...(withReasoning ? { reasoning: { enabled: false } } : {}),
    stream: false
  });
  // 免费池不需要 Authorization：带上反而 401
  const post = (body) => net.postJson(cfg.baseUrl, body, { timeoutMs: cfg.timeoutMs, signal, headers: requestHeaders(cfg) });
  let res = await post(payload(true));
  // 有的端点（如 recursive/flint）强制要求带 reasoning，关掉反而 400 → 去掉这个字段再试一次
  if (!res.ok && res.status === 400 && /Reasoning is mandatory/i.test(String(res.text || ''))) {
    res = await post(payload(false));
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${String(res.text || '').slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = res.json;
  if (!json) throw new Error(`非 JSON 响应: ${String(res.text || '').slice(0, 120)}`);
  const choice = (json.choices || [])[0] || {};
  const msg = choice.message || {};
  let text = typeof msg.content === 'string' ? msg.content : '';
  if (!text && Array.isArray(msg.content)) {
    text = msg.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return { text, finish: choice.finish_reason, model: json.model || model, ms: Date.now() - started };
}

/**
 * 想一句回复。返回 { reply, stickerKey, model, ms, attempts }；
 * reply 为空且 stickerKey 也为空 表示"不该回"。失败时抛出最后一个错误，调用方自己兜底。
 */
async function think(ctx, opts = {}) {
  // ctx.maxTokens：思维模式层给的深度预算（这一轮该多想还是少想），优先于全局配置
  const cfg = { ...loadCfg(), ...(ctx && ctx.maxTokens ? { maxTokens: ctx.maxTokens } : {}), ...opts };
  if (!cfg.enabled) throw new Error('brain disabled');
  const messages = buildMessages(ctx, cfg);
  const models = [...new Set((cfg.models && cfg.models.length ? cfg.models : DEFAULTS.models))];
  const t0 = Date.now();
  // 并发抢答：同一句话同时问两档模型，谁先给出可用回复就用谁。
  // 免费池延迟抖动很大（实测 3s~20s），串行等待会让回复慢到不可接受。
  const one = (model, signal) => callModel(model, messages, cfg, signal).then((out) => {
    const parsed = require('./stickers.js').extractDirective(out.text);
    // 自主权标记（[[不回]]/[[慢点回]]/[[很快回]]/[[引用]]）：模型提议，policy 审批
    const aut = autonomy.parseMarkers(parsed.text);
    parsed.text = aut.text;
    // 自主写文件（[[关系:恋人]] / [[记下:…]]）：模型提议，selfwrite 落盘前要过白名单 + 额度 + 语义校验
    const sw = selfwrite.parse(parsed.text);
    // 自我修改（[[规则:key=值]] / [[自定:+一句话]]）：模型可以改自己的参数与规矩
    const sm = selfmod.parseMarks(sw.text);
    // 语音语气 / 在线状态：模型自己定，不写就按当前心情自动挑
    const toneD = takeDirective(parsed.text, TONE_DIRECTIVE);
    parsed.text = toneD.text;
    const statD = takeDirective(parsed.text, STATUS_DIRECTIVE);
    parsed.text = statD.text;
    parsed.text = sm.text;
    const reply = cleanReply(parsed.text);
    // 模型自己说「不该回」是有效结果（下游按 brain-skip 处理）
    const saidSkip = /\[SKIP\]/i.test(String(out.text || '')) || aut.skip;
    // 其余空答一律当失败：免费池里不少档位 0.3~0.6s 就返回空 content（推理/审核吃掉预算），
    // 抢答机制下它们会稳定抢赢，表现为「对方发了消息而这边一声不响」。
    if (!reply && !parsed.stickerKey && !saidSkip) throw new Error('空答' + (out.finish ? '(' + out.finish + ')' : ''));
    return { reply, stickerKey: parsed.stickerKey, voice: !!parsed.voice, tone: toneD.value || null, status: statD.value || null, skip: !!aut.skip, slow: !!aut.slow, fast: !!aut.fast, quote: !!aut.quote, plan: aut.plan || null, cancelPlan: !!aut.cancel, writes: sw.writes, marks: sm, raw: out.text, model: out.model, ms: out.ms, finish: out.finish, messages, elapsed: Date.now() - t0 };
  });
  const budgetMs = Number(cfg.raceDeadlineMs) || (Number(cfg.timeoutMs) || 9000) + 1500;
  if (cfg.race === false || models.length === 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budgetMs);
    if (timer.unref) timer.unref();
    const errors = [];
    try {
      for (const model of models) {
        try { return await one(model, ac.signal); } catch (e) { errors.push(model + ': ' + e.message); }
      }
      throw new Error('全部模型都失败 → ' + errors.join(' | '));
    } finally { clearTimeout(timer); }
  }
  return await new Promise((resolve, reject) => {
    const errors = [];
    const ac = new AbortController();
    let pending = models.length;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ac.abort(); // 胜出/失败后立刻断掉其余请求：省额度，也别把免费池打到限流
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('抢答超时 → ' + (errors.join(' | ') || '没有模型在限定时间内返回'))), budgetMs);
    if (timer.unref) timer.unref();
    models.forEach((model) => {
      one(model, ac.signal).then((r) => finish(resolve, r)).catch((e) => {
        errors.push(model + ': ' + e.message);
        pending -= 1;
        if (pending === 0) finish(reject, new Error('全部模型都失败 → ' + errors.join(' | ')));
      });
    });
  });
}

/** 模型有时会把 JSON 再包一层（甚至转义成字符串）；剥到真正的摘要文本为止。 */
function unwrapSummary(s, depth = 0) {
  const t = String(s == null ? '' : s).trim();
  if (depth >= 3) return t;
  if (t.startsWith('{') || t.startsWith('"')) {
    const m = t.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      let inner = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
      return unwrapSummary(inner, depth + 1);
    }
  }
  return t;
}

/**
 * 把一段对话压成摘要 + 顺手抽几条长期事实（分层记忆：短期原文窗口 + 长期稳定事实）。
 * 返回 { summary, facts:[], model, ms }。失败抛错，调用方决定要不要放弃压缩。
 *
 * 借鉴：LangChain ConversationSummaryBufferMemory 的「超预算就把最老的一段摘要」，
 * 以及 mem0 / MemGPT 的「在压缩时顺便抽取长期事实」——压缩是唯一的低成本抽取时机。
 */
async function summarize(turns, opts = {}) {
  const cfg = { ...loadCfg(), ...opts };
  const list = (turns || []).filter(t => t && t.text);
  if (!list.length) return { summary: '', facts: [], model: '', ms: 0 };
  const who = opts.nick || '对方';
  const lines = list.map(t => `${t.from === 'me' ? '我' : (t.speaker || who)}：${String(t.text).slice(0, 160)}`);
  const sys = `你是对话摘要器。把一段 QQ 聊天记录压成中文摘要，并抽取关于「${who}」的稳定事实。

要求：
- summary：不超过 100 字的纯文本，写清「聊了什么、结论/约定、情绪状态」，用陈述句。
- facts：0-3 条纯文本，只写对以后聊天有用的稳定信息（身份/学校/专业/在忙的事/称呼习惯/明确偏好）。不要写一次性的事（今天吃了什么）、不要写敏感隐私（住址/证件/密码/钱数）。
- 只输出一层 JSON：{"summary":"摘要文本","facts":["事实1"]}。summary 的值必须是字符串，**不许再嵌套 JSON**，不要代码块、不要解释。`;
  const usr = `聊天记录（由旧到新）：\n${lines.join('\n')}`;
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: usr }];
  const models = [...new Set((cfg.models && cfg.models.length ? cfg.models : DEFAULTS.models))];
  const errors = [];
  for (const model of models) {
    try {
      const out = await callModel(model, messages, {
        ...cfg, maxTokens: cfg.summaryMaxTokens || 500, temperature: cfg.summaryTemperature ?? 0.2
      });
      const text = String(out.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const jsonText = (text.match(/\{[\s\S]*\}/) || [text])[0];
      let obj = {};
      try { obj = JSON.parse(jsonText); } catch { obj = { summary: text }; }
      const summary = unwrapSummary(obj.summary).replace(/\s*\n+\s*/g, ' ').trim().slice(0, 200);
      const facts = (Array.isArray(obj.facts) ? obj.facts : [])
        .map(f => String(f || '').trim()).filter(f => f && !f.startsWith('{')).slice(0, 3);
      if (!summary && !facts.length) { errors.push(`${model}: 空摘要`); continue; }
      return { summary, facts, model: out.model || model, ms: out.ms };
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }
  throw new Error('摘要全部模型都失败 → ' + errors.join(' | '));
}

/**
 * 情感与关系事件标注：每条消息只看一次、只出一层 JSON、不参与回复生成。
 * 返回 {pad:{p,a,d}, salience, relationEvents:[], mood, model, ms}。
 *
 * 为什么单开一次小调用：状态层要的是「连续、稳定」的估计，不能靠回复模型顺手瞎猜；
 * 但它的输入只有这一条消息（不加全量历史），所以成本固定、很小。
 */
async function affect(text, opts = {}) {
  const cfg = { ...loadCfg(), ...opts };
  const nick = opts.nick || '对方';
  const sys = `你是情感标注器。读一条 QQ 消息，估它对收到消息的人产生的情感反应，只输出一层 JSON。
字段：
- pad: {"p":-1..1,"a":-1..1,"d":-1..1}（p=愉悦/舒服程度，a=唤醒/激动程度，d=控制感/踏实程度）
- salience: 0..1（这条在情感上的分量：平淡闲聊 0.1-0.3，明显开心/难过/生气/亲近 0.6-1）
- relationEvents: 0-2 个，只能从这些里选：self-disclosure, shared, affection, plan, conflict, repair, request, withdrawal
- mood: 3-8 个字的当前心情词
只输出 JSON，不要解释、不要代码块。`;
  const usr = `对方（${nick}）说：${String(text || '').slice(0, 300)}`;
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: usr }];
  const models = [...new Set((cfg.models && cfg.models.length ? cfg.models : DEFAULTS.models))];
  const errors = [];
  for (const model of models) {
    try {
      const out = await callModel(model, messages, {
        ...cfg, maxTokens: cfg.affectMaxTokens || 600, temperature: cfg.affectTemperature ?? 0.1
      });
      const textOut = String(out.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const jsonText = (textOut.match(/\{[\s\S]*\}/) || [textOut])[0];
      const obj = JSON.parse(jsonText);
      const clamp = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
      return {
        pad: { p: clamp(obj.pad && obj.pad.p), a: clamp(obj.pad && obj.pad.a), d: clamp(obj.pad && obj.pad.d) },
        salience: Math.max(0, Math.min(1, Number(obj.salience) || 0.3)),
        relationEvents: (Array.isArray(obj.relationEvents) ? obj.relationEvents : [])
          .map(x => String(x || '').trim()).filter(Boolean).slice(0, 2),
        mood: String(obj.mood || '').slice(0, 12),
        model: out.model || model, ms: out.ms
      };
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }
  // 全部失败也别把主链路带崩：给一个中性的「这次没读出来」，调用方看 degraded/error
  return {
    pad: { p: 0, a: 0, d: 0 },
    salience: 0.2,
    relationEvents: [],
    mood: '平静',
    degraded: true,
    error: errors.join(' | '),
    model: '', ms: 0
  };
}

/**
 * 巩固时的记忆抽取：把一段聊天原文变成「像人一样会记住的几条事」+ 一句关系种子。
 * 返回 {nodes:[{text,kind,importance,salience}], seed, model, ms}。
 */
async function extractMemories(turns, opts = {}) {
  const cfg = { ...loadCfg(), ...opts };
  const nick = opts.nick || '对方';
  const list = (turns || []).filter(t => t && t.text).slice(-20);
  if (!list.length) return { nodes: [], seed: '', model: '', ms: 0 };
  const sys = `你在帮一个 AI 整理长期记忆（像人脑的「巩固」：把刚发生的事整理成以后能想起来的印象）。
读一段 QQ 聊天记录，抽 0-4 条值得长期记住的事，每条一句中文陈述（≤40 字）。
优先记：身份/学校/专业/在忙什么、明确喜恶、约定和计划、重要的情绪事件及原因、对方在意的人或事。
不要记：一次性琐事（今天吃了什么）、寒暄、重复内容、敏感隐私（住址/证件/密码/金额）。
字段：{"nodes":[{"text":"…","kind":"fact|preference|plan|event|feeling","importance":0..1,"salience":0..1}],"seed":"不超过 50 字，描述现在你和 TA 这层关系的底色"}
只输出 JSON，不要解释、不要代码块。`;
  const usr = `聊天记录（由旧到新，我=这个号，${nick}=对方）：\n` +
    list.map(t => `${t.from === 'me' ? '我' : (t.speaker || nick)}：${String(t.text).slice(0, 200)}`).join('\n');
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: usr }];
  const models = [...new Set((cfg.models && cfg.models.length ? cfg.models : DEFAULTS.models))];
  const errors = [];
  for (const model of models) {
    try {
      const out = await callModel(model, messages, {
        ...cfg, maxTokens: cfg.memoryMaxTokens || 800, temperature: cfg.summaryTemperature ?? 0.2
      });
      const textOut = String(out.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const jsonText = (textOut.match(/\{[\s\S]*\}/) || [textOut])[0];
      const obj = JSON.parse(jsonText);
      const nodes = (Array.isArray(obj.nodes) ? obj.nodes : [])
        .map(n => ({
          text: String((n && n.text) || '').trim().slice(0, 80),
          kind: String((n && n.kind) || 'event').slice(0, 20),
          importance: Math.max(0, Math.min(1, Number(n && n.importance) || 0.5)),
          salience: Math.max(0, Math.min(1, Number(n && n.salience) || 0.4))
        }))
        .filter(n => n.text && !n.text.startsWith('{'))
        .slice(0, 4);
      const seed = String(obj.seed || '').trim().slice(0, 120);
      if (!nodes.length && !seed) { errors.push(`${model}: 空结果`); continue; }
      return { nodes, seed, model: out.model || model, ms: out.ms };
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }
  return { nodes: [], seed: '', degraded: true, error: errors.join(' | '), model: '', ms: 0 };
}

module.exports = {
  promptStats: () => lastPromptStats, callModel, think, summarize, takeDirective, TONE_DIRECTIVE, STATUS_DIRECTIVE, affect, extractMemories, buildMessages, cleanReply, stripMarkers, loadCfg, SYSTEM, CFG_PATH };

// ── 命令行自测 ────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const raw = get('--context');
  const prompt = get('--prompt');
  const ctx = raw ? JSON.parse(raw) : { nick: '好友A', text: prompt || '在吗', history: [] };
  think(ctx)
    .then(r => console.log(JSON.stringify({ ...r, reply: r.reply || '(不回复)' }, null, 2)))
    .catch(e => { console.error('失败:', e.message); process.exit(1); });
}
