# 架构：一次回复会经过什么

```
                        ┌──────────────── 收到一条 WS 事件 ────────────────┐
                        │                                                 │
                   dispatch()  连发合并窗口（默认 2.2s，最多 6 条）
                        │        「他连发三条其实在说一件事」→ 合成一条处理
                        ▼
                   handle()
                        │
        ┌───────────────┼─────────────────────────────────────────────┐
        │ 1 catchupOnce │ 每会话每进程一次：拉历史补离线漏的消息         │
        │ 2 echo        │ 上一轮我那句 → 对方这句：热络/敷衍/诉苦(+意图)  │
        │ 3 them        │ 识别「去眯一会儿/在上课/在加班」等当前状态      │
        │ 4 mind        │ promptBits: mood / bond / memories（联想召回）  │
        │ 5 promises    │ 命中历史承诺 → 一句话提示（别像催账）           │
        │ 6 style       │ 关系远近 + 心情 + 回响 → 尺度与 hint            │
        │ 7 self/clock  │ 「我正在写代码」+「今天周五晚上」               │
        └───────────────┼─────────────────────────────────────────────┘
                        ▼
                 brain.think()   拼 prompt → 多模型并发抢答（2–3s）
                        │         空答视为失败（否则免费模型会「稳赢但沉默」）
                        ▼
                 say.inspect()   中英混杂 / 助手腔 / 列清单 / 复述画面 → 只清可清的
                        │         需要重写的（assistant/meta）重来一次
                        ▼
                 style.isHarsh() 太冲 → 带上「软一点」重写一次（对熟的人尤其）
                        ▼
                 them.conflicts() 与对方当前状态矛盾（人家说去睡，你说「七点叫你」）→ 重写
                        ▼
                 style.softenText() 摘掉没资格的称呼、收感叹号、超长截断
                        ▼
                 stickers.pick()  复合情绪打分 + 学习分 → 表情单独一条气泡
                        ▼
                 pacing          按字数算「正在输入」时长（先延迟再亮提示）
                        ▼
                 send()          拆条（≤2）、串行排队、失败即停、记账给学习层
```

## 层与文件的对应

| 文件 | 职责 | 落盘 |
| --- | --- | --- |
| `lib/store.js` | 所有 JSON 的原子读写（tmp+rename，4 次重试，坏文件改名 `.bad-*`） | — |
| `scripts/qq.js` | OneBot HTTP 客户端（5s 超时；`send_private_msg` / `get_msg` / `set_input_status` …） | — |
| `scripts/net.js` | HTTPS 请求封装（**不使用全局 fetch**，见下节） | — |
| `scripts/context.js` | 分层上下文：原文窗口 + 滚动摘要 + facts；`ingest()` 补账 | `logs/context/<slug>.json` |
| `scripts/mind.js` | 情感 PAD（二阶惯性）、关系四轴、联想记忆图、巩固与空闲反刍 | `logs/mind/*-state.json`、`*-graph.json`、`logs/trace/*.jsonl` |
| `scripts/bonds.js` | 关系里程碑脉冲（见面/吵架/道歉/倾诉/久别重逢），读取时叠加衰减 | `logs/bonds/<slug>.json` |
| `scripts/echo.js` | 从对方回复反推热络/敷衍/诉苦；两路反拨（情绪 + 关系） | `logs/echo/<slug>.json` |
| `scripts/style.js` | 关系→说话的尺度；`softenText()` 降级；`isHarsh()` 判定 | — |
| `scripts/promises.js` | 承诺抽取/命中/到期（`resolveDue` → `dueItems` → `dueNote`） | `logs/promises/<slug>.json` |
| `scripts/longing.js` | 想念调度：`expectedHours` 由亲密度/信任/张力/显著性决定 | `logs/longing/*.json` |
| `scripts/group.js` | 群聊插话闸门（被@ / 有人求助 / 不是两人私聊 / 不刷屏） | `logs/group/<gid>.json` |
| `scripts/self.js` | 按时段的「我在做什么」，缓存在进程内 | `logs/self/state.json` |
| `scripts/clock.js` | 周几/节日/时段，缓存 60s | — |
| `scripts/them.js` | 对方当前状态（7 类）+ 矛盾检测 | `logs/them/<slug>.json` |
| `scripts/say.js` | 发送前的人话自检（9 类问题） | `logs/say-bad.jsonl` |
| `scripts/stickers.js` | 表情库、复合情绪打分、`sub_type:1` 表情段、反馈学习 | `assets/stickers/index.json` |
| `scripts/sticker-fetch.js` | 库里没有就上网找（fabiaoqing），视觉打标后入库 | `logs/sticker-fetch/state.json` |
| `scripts/pacing.js` | 打字时长 / 切窗口时长 | `logs/pacing/state.json` |
| `scripts/voice.js` | SAPI → wav → `record` 段（NapCat 自己转 silk） | `logs/voice/` |
| `scripts/risk.js` | 风控闸门：分级动作、掉线熔断、登录额度 | `logs/risk/state.json` |
| `scripts/evolve.js` | 自调参：统计判冷比例，写 `config/tuning.json` | `logs/evolve/feedback.jsonl` |
| `scripts/phone.js` | A 通道：adb 操作手机官方 QQ（备用，不在主链路） | `logs/phone.log` |

## 两条重要工程决定

### 1. 不用全局 fetch（Node 24 + 某些网络的 TLS 坑）

实测过一种奇怪故障：`curl` 请求模型 API 正常 0.8s，但 Node 的 `fetch` 一直 `UND_ERR_CONNECT_TIMEOUT`。定位到 `net.connect` 到 IP:443 只要 69ms，而 `tls.connect({servername})` 超时；加上 `maxVersion: 'TLSv1.2'` 后 268ms 握手成功 —— TLS 1.3 的 PQ 混合密钥让 ClientHello 变大，被链路 MTU 丢弃。

所以 `scripts/net.js` 默认用 TLS 1.2 发起请求，失败再退回默认重试；子进程用 `node --tls-max-v1.2` 启动。

### 2. 状态全部是「可读、可删、可重算」的 JSON

没有数据库、没有二进制快照。删掉 `logs/` 就等于重置记忆（上下文、记忆图、关系、承诺、表情学习分都是独立文件）；把某个文件拷到另一台机器，记忆就跟着走。写入统一走 `lib/store.js`，因为它踩过 Windows 上 `rename` 偶发 `EIO` 的坑 —— 静默丢写比写失败更可怕。

## 数据流里的「不记账」纪律

几乎所有副作用层（承诺提醒、想念开口、表情学习）都遵守同一句话：

> **演练（`AUTOREPLY_DRY=1`）与发送失败，一律不记账。**

否则跑一次测试就会把真实节奏吃掉：承诺被标记「已提醒」、想念冷却被推后 20 小时、表情学习分被演练的假对话污染。

## 测试策略

- 每层一个 `test-<layer>.js`，**全离线**：外部依赖（模型、OneBot、HTTP、adb）用注入桩替换，状态目录用 `QQ*_DIR` 环境变量隔离到 `logs/*-test/`；
- 需要真东西的用例单独放 `test-*-live.js`，只做「抽样看口吻/延迟」，不做断言密集回归；
- `test-all.js` 把 24 组离线用例串起来跑，`--all` 才带在线用例。

隔离目录这件事是血的教训：早期有测试忘了设 `QQECHO_DIR`，把假对话写进了生产回响状态，导致真实会话的语气被带歪。
