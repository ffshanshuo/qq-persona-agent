# 架构总览（自动生成，请勿手改）

> 由 `node scripts/arch.js` 从磁盘现读生成；改代码后重跑一次即可同步。
> 生成时间 2026-10-24 12:40:16 · 52 个模块 · 13262 行 · 43 组自检 · 25 份配置

## 一句话架构

一条消息进来 → 合并/补账 → 读场景（引用、对方状态、群聊跟随）→ 读情绪与关系（回响、事件脉冲、分寸）
→ 拼 prompt（记忆/状态/时间/尺度）→ 本机网关抢答 → 人话自检（语气/矛盾/标记）→ 拟人化发送（打字、拆条、表情单发）

## 一次回复的真实管线

```
WS 事件
  → dispatch        连发合并（窗口 1.2s / 上限 3.5s）
  → decide          私聊/群聊闸门（白名单、@ 跟随、沉默窗、插话骰子）
  → catchupOnce     离线补账（拉历史、去重、missed 提示）
  → echo            对方上一句落地得怎么样（暖/冷/诉苦/敌意）→ 调 PAD
  → them / quote    对方此刻在干嘛 / 这条引用的是哪句话
  → mind.promptBits 状态、关系、联想召回（人话段）
  → promises        有没有到日子的约定
  → style           关系与心情决定尺度（档位、字数、禁玩笑）
  → self / clock    此刻在做什么 / 今天是什么日子
  → brain.think     本机网关 8326 并发抢答（2 个 combo，deadline 7s）
  → say / tone / them-retry  人话自检 → 太冲/矛盾/夹英文就重写一次
  → stripMarkers    表情指令绝不允许漏进聊天框
  → send            输入中状态 → 打字时长 → 拆条 → 表情单独一条 → 记账
  → afterSend      承诺/表情反馈/关系脉冲/记忆巩固（异步，不影响回复）
```

## 分层

### 入口与运维（进程怎么起、怎么活、怎么停）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `auto-reply.js` | 1546 | 把一条长回复拆成 2 条（像人打字时想到一半就发）。 | 27 个内部模块 | 有 |
| `arch.js` | 312 | 架构清点器：把「这套系统现在到底有哪些层、谁依赖谁、测没测」从代码里真读出来 | — | — |
| `watchdog.js` | 191 | （无说明） | 1 个内部模块 | — |
| `start-qq.js` | 115 | （无说明） | — | — |
| `setup-http.js` | 31 | （无说明） | — | — |
| `status.js` | 24 | （无说明） | — | — |
| `collector.js` | 24 | （无说明） | — | — |
| `enable-ws.js` | 22 | （无说明） | — | — |
| `stop-qq.js` | 13 | （无说明） | — | — |

### 请求编排（从 auto-reply 里拆出来的两块：不过模型的即时指令、后台定时器）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `timers.js` | 120 | auto-reply 的四个后台定时器（空闲巩固 / 想念调度 / 自进化 / 头像） | 7 个内部模块 | — |
| `intercepts.js` | 83 | 聊天里「一句话直接执行」的指令（换头像 / 改昵称） | 2 个内部模块 | — |

### 通道与协议（OneBot 收发、网络、语音、空间、A 通道）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `phone.js` | 336 | （无说明） | 1 个内部模块 | 有 |
| `voice.js` | 174 | 用这个 QQ 号「发语音」 | 1 个内部模块 | — |
| `net.js` | 91 | 统一出口（https 请求） | — | — |
| `qq.js` | 90 | （无说明） | — | 有 |
| `qzone-feed.js` | 42 | （无说明） | 1 个内部模块 | — |
| `wc.js` | 27 | （无说明） | — | — |
| `qr-render.js` | 18 | （无说明） | 1 个内部模块 | — |

### 模型与多模态（说话与看图都从这里出）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `brain.js` | 529 | 让 DSH 自己"想"一句回复 | 3 个内部模块 | 有 |
| `vision.js` | 162 | 用 Kilo AI 免费池的视觉模型「看」图片（表情包 / 对方发来的图） | 1 个内部模块 | — |
| `bench-models.js` | 111 | 给「回复生成」挑模型：测延迟 + 粗看质量 | 1 个内部模块 | — |

### 上下文与记忆（记得住、接得上、分得清场景）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `mind.js` | 761 | 让这个号「像人一样记得、有情绪、会联想」 | 3 个内部模块 | 有 |
| `context.js` | 340 | 原子写。E:\ 上 rename 偶发 EIO/EPERM（杀软或同步盘占着句柄），所以： | — | 有 |
| `follow.js` | 306 | 群聊「@ 之后的对话跟随」 | — | 有 |
| `quote.js` | 273 | 引用消息的「上下文感知」 | 1 个内部模块 | 有 |
| `them.js` | 226 | 「TA 现在的状态」：别把要去睡觉的人当成在忙 | 1 个内部模块 | 有 |
| `timeline.js` | 217 | 从对话时间戳里读「时间感」 | 2 个内部模块 | 有 |
| `group.js` | 214 | 群聊在场感：什么时候该插话、该接谁的话 | — | 有 |

### 情绪 · 关系 · 语气（同一件事，用什么态度说）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `echo.js` | 332 | 回响层：根据「对话本身」反过来调整语气与情绪 | 1 个内部模块 | 有 |
| `bonds.js` | 286 | 关系事件层：关系不会只靠每轮情感平滑地爬，真实关系是被「事情」推着走的 | — | 有 |
| `mode.js` | 284 | 思维模式（这轮该「怎么想」，而不只是「用什么语气」） | 1 个内部模块 | — |
| `style.js` | 255 | 说话的分寸：关系与心情反过来决定「怎么说」 | 1 个内部模块 | 有 |
| `self.js` | 195 | 自我线：这个号也有自己的事在忙 | — | 有 |
| `say.js` | 165 | 发送前的「人话自检」 | — | 有 |
| `clock.js` | 164 | 历法感：知道今天是哪天、周几、什么时段、有没有节日 | — | 有 |

### 主动与承诺（没人说话时它会不会开口、说到做不做）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `longing.js` | 534 | 想念调度：没人找我时，我什么时候会主动想起某个人 | 8 个内部模块 | 有 |
| `promises.js` | 446 | 记住「我说过要做的」，到点上主动提一句 | — | 有 |
| `nick.js` | 302 | 聊天里改昵称（跟换头像同一套口径） | 3 个内部模块 | 有 |

### 表情与头像（图片那一半的表达）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `avatar.js` | 512 | 自己的头像：生成 / 挑选 / 更换 | 3 个内部模块 | 有 |
| `stickers.js` | 454 | 表情包库：抓取 / 入库 / 描述 / 选图 / 发送 | 3 个内部模块 | 有 |
| `sticker-fetch.js` | 289 | 「库里没有合适的，就自己上网找一张」 | 3 个内部模块 | 有 |
| `make-stickers.py` | 253 | （无说明） | — | — |
| `avatar-src.js` | 246 | 头像图片池（网上找的 + 别人发的那张） | 2 个内部模块 | 有 |
| `make-avatar.js` | 131 | （无说明） | — | — |
| `sticker_prep.py` | 83 | （无说明） | — | — |
| `avatar_prep.py` | 67 | （无说明） | — | — |

### 安全与节奏（别被封、别像机器）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `risk.js` | 287 | （无说明） | — | 有 |
| `pacing.js` | 182 | 一轮开始的节奏：返回 { switchMs, typingMs, fromKey, rapidCount } | — | 有 |

### 自进化（参数自己调，不靠人改配置）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `evolve.js` | 308 | 自进化：让「规则本身」也随真实对话慢慢调整 | — | 有 |

### 控制台（不参与聊天链路：看状态、看会话、预演一句）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `panel.js` | 760 | 本地可视化控制台（零依赖、只绑 127.0.0.1） | — | 有 |
| `dryrun.js` | 209 | 「试一句」：拿真实记忆预演一次回复，但**绝不发送** | 1 个内部模块 | — |

### 共享基础（所有模块共用的落盘工具）

| 模块 | 行数 | 作用 | 依赖 | 自检 |
| --- | --- | --- | --- | --- |
| `lib/store.js` | 120 | 统一的 JSON 落盘工具（本项目所有模块共用的那一套「原子写」） | — | — |

## 依赖关系（谁 require 了谁）

| 模块 | 依赖 |
| --- | --- |
| `auto-reply.js` | `qq.js` `stickers.js` `vision.js` `context.js` `style.js` `echo.js` `mode.js` `risk.js` `group.js` `self.js` `clock.js` `say.js` `them.js` `timeline.js` `promises.js` `mind.js` `follow.js` `nick.js` `quote.js` `intercepts.js` `timers.js` `brain.js` `pacing.js` `voice.js` `bonds.js` `avatar-src.js` `sticker-fetch.js` |
| `avatar-src.js` | `net.js` `lib/store.js` |
| `avatar.js` | `risk.js` `avatar-src.js` `qq.js` |
| `bench-models.js` | `net.js` |
| `brain.js` | `net.js` `timeline.js` `stickers.js` |
| `dryrun.js` | `auto-reply.js` |
| `echo.js` | `lib/store.js` |
| `intercepts.js` | `avatar.js` `nick.js` |
| `longing.js` | `mind.js` `context.js` `brain.js` `promises.js` `clock.js` `bonds.js` `stickers.js` `auto-reply.js` |
| `mind.js` | `bonds.js` `context.js` `brain.js` |
| `mode.js` | `lib/store.js` |
| `nick.js` | `mind.js` `bonds.js` `qq.js` |
| `phone.js` | `pacing.js` |
| `qr-render.js` | `qrcode.js` |
| `quote.js` | `lib/store.js` |
| `qzone-feed.js` | `qq.js` |
| `sticker-fetch.js` | `net.js` `stickers.js` `vision.js` |
| `stickers.js` | `lib/store.js` `qq.js` `vision.js` |
| `style.js` | `mind.js` |
| `them.js` | `context.js` |
| `timeline.js` | `lib/store.js` `context.js` |
| `timers.js` | `mind.js` `context.js` `brain.js` `risk.js` `longing.js` `evolve.js` `avatar.js` |
| `vision.js` | `net.js` |
| `voice.js` | `qq.js` |
| `watchdog.js` | `risk.js` |

## 配置（config/*.json）

| 文件 | 大小 | 顶层键 | 谁在读 |
| --- | --- | --- | --- |
| `autoreply.bond-test.json` | 1243B | enabled, selfId, private, group, quietHours, limits, delayMs, rules … | `test-bond-e2e.js` |
| `autoreply.ctx-test.json` | 924B | enabled, selfId, private, group, quietHours, limits, delayMs, rules … | `test-clock.js` `test-context.js` `test-promise-e2e.js` `test-self.js` `test-style.js` `test-them.js` `test-tone.js` |
| `autoreply.json` | 4398B | enabled, selfId, private, group, quietHours, limits, delayMs, rules … | `auto-reply.js` `dryrun.js` `panel.js` |
| `autoreply.merge-test.json` | 1228B | enabled, selfId, private, group, quietHours, limits, delayMs, rules … | `test-merge-live.js` `test-quote.js` `test-say.js` `test-typing.js` |
| `autoreply.mind-test.json` | 1168B | enabled, selfId, private, group, quietHours, limits, delayMs, rules … | `test-mind-e2e.js` |
| `autoreply.nick-test.json` | 882B | enabled, selfId, private, group, limits, delayMs, merge, quote … | `test-nick.js` |
| `autoreply.offline-test.json` | 637B | enabled, selfId, private, group, quietHours, limits, delayMs, llm … | `test-offline.js` |
| `autoreply.test.json` | 3580B | enabled, selfId, private, group, quietHours, limits, delayMs, rules … | `test-avatar-chat.js` `test-empty-bubble.js` `test-mode.js` `test-timeline.js` |
| `avatar.json` | 757B | enabled, checkEveryHours, minGapDays, maxPerMonth, size, riskGate, source, chat | `avatar-src.js` `avatar.js` `panel.js` |
| `bonds.json` | 444B | enabled, scale, axisCap, minChars, maxEvents, maxPulses, absenceHours, absenceDecayHours … | `bonds.js` |
| `brain.json` | 683B | enabled, baseUrl, models, timeoutMs, maxTokens, temperature, historyTurns, affectMaxTokens … | `brain.js` `panel.js` |
| `clock.json` | 494B | enabled, includeDate, forbidReadOut, holidays | `clock.js` |
| `echo.json` | 559B | enabled, warmLatencyMs, coldLatencyMs, warmLenRatio, coldLenRatio, warmScore, coldScore, emaAlpha … | `echo.js` |
| `evolve.json` | 398B | enabled, everyMin, apply, minRecords, window, step, maxDrift, coldRateHigh … | `evolve.js` |
| `follow.json` | 374B | enabled, windowMin, extendMin, maxSessionMin, maxTurns, minChars, replyThreshold, missLimit | `follow.js` |
| `group.json` | 337B | enabled, allowList, follow, allowNameMention | `group.js` |
| `longing.json` | 1015B | enabled, checkEveryMin, maxPerCheck, intensityThreshold, minIdleHours, minTurns, perContactHours, perContactDaily … | `longing.js` |
| `mind.json` | 728B | enabled, alpha, beta, relationRate, decayRate, gamma, hops, threshold … | `mind.js` |
| `mode.json` | 934B | enabled, deepTokens, adviceTokens, comfortTokens, normalTokens, quickTokens, banterTokens, deepChars … | `mode.js` |
| `nick.json` | 415B | enabled, minIntimacy, minTrust, partners, maxLen, aliasesKeep, cooldownMin, autoEnabled | `nick.js` |
| `pacing.json` | 864B | enabled, charsPerSec, typingBaseMs, typingMinMs, typingMaxMs, jitter, switchBaseMs, switchMaxMs … | `pacing.js` |
| `risk.json` | 500B | enabled, loginPerDayMax, restartPerDayMax, loginGapMin, dropWindowMin, dropThreshold, coolingHours, coolingHoursAfterLoginFail … | `risk.js` |
| `self.json` | 2763B | enabled, minMinutes, maxMinutes, mentionProbability, mentionMinGapMin, askPattern, pools | `self.js` |
| `style.json` | 469B | enabled, friendIntimacy, closeIntimacy, teaseIntimacy, softenTension, tenseTension, maxChars, lowEnergyFactor … | `panel.js` `style.js` |
| `timeline.json` | 535B | enabled, maxHours, minMinutes, lookbackHours, maxItems, gapMin, keepSpans, onlyThem | `timeline.js` |

## 环境变量

| 变量 | 用途方 |
| --- | --- |
| `ADB_PATH` | `phone.js` |
| `ANDROID_SERIAL` | `phone.js` |
| `AUTOREPLY_CONFIG` | `auto-reply.js` |
| `AUTOREPLY_DRY` | `auto-reply.js` `dryrun.js` `longing.js` `timers.js` |
| `AUTOREPLY_INCOMING` | `auto-reply.js` |
| `AUTOREPLY_KEEP_WAV` | `auto-reply.js` |
| `AUTOREPLY_LOG` | `auto-reply.js` `dryrun.js` |
| `AUTOREPLY_STATE` | `auto-reply.js` `dryrun.js` |
| `AVATAR_PY` | `avatar-src.js` |
| `BRAIN_CONFIG` | `brain.js` |
| `OB11_BASE` | `qq.js` |
| `OB11_TIMEOUT_MS` | `qq.js` |
| `OB11_TOKEN` | `auto-reply.js` `qq.js` `setup-http.js` |
| `OB11_WS` | `auto-reply.js` |
| `QMIND_CONFIG` | `mind.js` |
| `QQAVATARSRC_STATE_DIR` | `avatar-src.js` |
| `QQAVATAR_CONFIG` | `avatar.js` |
| `QQAVATAR_DIR` | `avatar.js` `dryrun.js` |
| `QQAVATAR_OUT` | `avatar.js` |
| `QQAVATAR_SRC_DIR` | `avatar-src.js` |
| `QQBOND_DIR` | `bonds.js` `dryrun.js` |
| `QQCTX_DIR` | `context.js` `dryrun.js` |
| `QQECHO_DIR` | `dryrun.js` `echo.js` `evolve.js` |
| `QQEVOLVE_CONFIG` | `evolve.js` |
| `QQEVOLVE_DIR` | `dryrun.js` `evolve.js` |
| `QQFETCH_DIR` | `sticker-fetch.js` |
| `QQFOLLOW_DIR` | `dryrun.js` `follow.js` |
| `QQGROUP_DIR` | `dryrun.js` `group.js` |
| `QQLONGING_DIR` | `dryrun.js` `longing.js` |
| `QQMIND_DIR` | `dryrun.js` `mind.js` |
| `QQMODE_CONFIG` | `mode.js` |
| `QQMODE_DIR` | `dryrun.js` `mode.js` |
| `QQNICK_DIR` | `nick.js` |
| `QQPACING_DIR` | `dryrun.js` `pacing.js` |
| `QQPANEL_HOST` | `panel.js` |
| `QQPANEL_PORT` | `panel.js` |
| `QQPANEL_TOKEN` | `panel.js` |
| `QQPROMISE_DIR` | `dryrun.js` `promises.js` |
| `QQQUOTE_DIR` | `dryrun.js` `quote.js` |
| `QQRISK_DIR` | `dryrun.js` `risk.js` |
| `QQSELF_DIR` | `dryrun.js` `self.js` |
| `QQSTICKER_BAN` | `stickers.js` |
| `QQTHEM_DIR` | `dryrun.js` `them.js` |
| `QQTIMELINE_DIR` | `timeline.js` |
| `QQTRACE_DIR` | `dryrun.js` `mind.js` |
| `QQTUNING_FILE` | `echo.js` `evolve.js` `style.js` |
| `QQ_PKG` | `phone.js` |
| `S` | `voice.js` |
| `SELF_UIN` | `auto-reply.js` `dryrun.js` `stickers.js` |
| `STICKER_DIR` | `sticker-fetch.js` `stickers.js` |
| `STICKER_FETCH_DISABLED` | `sticker-fetch.js` |
| `STICKER_FETCH_DRY` | `sticker-fetch.js` |
| `STICKER_PYTHON` | `stickers.js` |
| `VISION_ENDPOINT` | `vision.js` |
| `VISION_TOKEN_FILE` | `vision.js` |

## 落盘目录（logs/）

| 目录/文件 | 写入方 |
| --- | --- |
| `logs/autoreply.log` | `panel.js` |
| `logs/bonds` | `panel.js` |
| `logs/inbox` | `panel.js` |
| `logs/mind` | `panel.js` |
| `logs/quotes` | `panel.js` |
| `logs/say-bad` | `panel.js` `say.js` |
| `logs/them` | `panel.js` |
| `logs/watchdog.log` | `panel.js` |

## 自检矩阵

共 43 组：离线 43 组、在线 0 组（在线需要 NapCat + 模型）。

| 组 | 文件 | 覆盖模块 |
| --- | --- | --- |
| `context` | `test-context.js` | `context.js` `auto-reply.js` `brain.js` |
| `mind` | `test-mind.js` | `mind.js` `context.js` |
| `bonds` | `test-bonds.js` | `bonds.js` `mind.js` `longing.js` |
| `longing` | `test-longing.js` | `mind.js` `context.js` `longing.js` |
| `longing-plus` | `test-longing-plus.js` | `mind.js` `context.js` `promises.js` `longing.js` `brain.js` |
| `promises` | `test-promises.js` | `promises.js` `auto-reply.js` |
| `promises-review` | `test-promises-review.js` | `promises.js` |
| `say` | `test-say.js` | `qq.js` `say.js` `brain.js` `auto-reply.js` |
| `typing` | `test-typing.js` | `qq.js` `brain.js` `auto-reply.js` `pacing.js` |
| `pacing` | `test-pacing.js` | `pacing.js` |
| `style` | `test-style.js` | `style.js` `brain.js` `mind.js` `auto-reply.js` |
| `tone` | `test-tone.js` | `qq.js` `brain.js` `mind.js` `auto-reply.js` |
| `mode` | `test-mode.js` | — |
| `echo` | `test-echo.js` | `echo.js` `mind.js` `style.js` |
| `them` | `test-them.js` | `them.js` `qq.js` `context.js` `brain.js` `auto-reply.js` |
| `clock` | `test-clock.js` | `clock.js` `brain.js` `auto-reply.js` |
| `remind` | `test-remind.js` | `promises.js` `mind.js` `context.js` `longing.js` |
| `group` | `test-group.js` | `group.js` `auto-reply.js` |
| `self` | `test-self.js` | `self.js` `brain.js` `auto-reply.js` |
| `evolve` | `test-evolve.js` | `evolve.js` `echo.js` `style.js` |
| `risk` | `test-risk.js` | `risk.js` |
| `quote` | `test-quote.js` | `quote.js` `qq.js` `brain.js` `auto-reply.js` |
| `timeline` | `test-timeline.js` | `timeline.js` `context.js` `brain.js` |
| `phone` | `test-phone.js` | `phone.js` `pacing.js` |
| `sticker-route` | `test-sticker-route.js` | `stickers.js` `auto-reply.js` |
| `empty-bubble` | `test-empty-bubble.js` | `auto-reply.js` |
| `panel` | `test-panel.js` | `panel.js` |
| `sticker-combo` | `test-sticker-combo.js` | `brain.js` |
| `sticker-fetch` | `test-sticker-fetch.js` | `sticker-fetch.js` `stickers.js` |
| `sticker-learn` | `test-sticker-learn.js` | — |
| `avatar` | `test-avatar.js` | `avatar.js` `avatar-src.js` `risk.js` `qq.js` |
| `avatar-chat` | `test-avatar-chat.js` | `avatar.js` `avatar-src.js` `qq.js` `risk.js` `auto-reply.js` `brain.js` |
| `follow` | `test-follow.js` | `follow.js` `group.js` `auto-reply.js` |
| `nick` | `test-nick.js` | `nick.js` `mind.js` `auto-reply.js` `brain.js` |
| `offline-catchup` | `test-offline.js` | `context.js` `qq.js` `auto-reply.js` |
| `merge-live` | `test-merge-live.js` | `qq.js` `auto-reply.js` `say.js` |
| `longing-live` | `test-longing-live.js` | `longing.js` `mind.js` |
| `remind-live` | `test-remind-live.js` | `mind.js` `context.js` `promises.js` `longing.js` |
| `clock-live` | `test-clock-live.js` | `clock.js` `brain.js` |
| `promise-e2e` | `test-promise-e2e.js` | `auto-reply.js` `promises.js` `context.js` |
| `bond-e2e` | `test-bond-e2e.js` | `auto-reply.js` `bonds.js` `mind.js` `longing.js` |
| `mind-e2e` | `test-mind-e2e.js` | `mind.js` `auto-reply.js` |
| `sweep-live` | `test-sweep-live.js` | `mind.js` `brain.js` |

## 一致性检查

✅ 无问题：分层完整、每个测试都注册了、没有残留补丁脚本、每份配置都有人读。
