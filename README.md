# qq-persona-agent

> 把 QQ 变成一个「有人格、记得住、会算关系、能自己找表情」的助手。
>
> 基于 [NapCat](https://github.com/NapNeko/NapCatQQ) + OneBot v11 的 Node.js 实现，零 Python、零数据库，所有状态都是可读的 JSON / JSONL。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

---

## 这个项目想解决什么

大多数「QQ 机器人」止步于**关键词回复**或**把消息甩给大模型**。结果对方一眼就能看出不对：它记不住三天前说过的事、分不清跟你熟不熟、永远秒回、表情包永远是那几个、吵架了还能乐呵呵、连你刚说「去眯一会儿」它都接不住。

这个项目把「像个人」拆成**可以单独测试的十几层**，每层只做一件事，层与层之间只通过 prompt 里的一段人话、或者一个 JSON 文件交互：

| 层 | 文件 | 解决什么 | 成本 |
| --- | --- | --- | --- |
| 上下文 | `context.js` | 短期原文 + 滚动摘要 + 长期事实；重启不失忆、离线漏的消息能补账 | 0 token |
| 拟人记忆 | `mind.js` | 情感 PAD 状态、关系四轴、联想记忆图（ACT-R 式激活衰减） | 1 次轻量调用 / N 轮 |
| 关系事件 | `bonds.js` | 见面 / 吵架 / 道歉 / 深夜倾诉这类**里程碑**一次性推动关系，而不是平滑爬 | 0 token |
| 说话的分寸 | `style.js` | 关系远近决定称呼、长度、能不能开玩笑；刚吵完自动变软 | 0 token |
| 语气分寸 | `style.js` `isHarsh()` | 越熟越不能冲；太冲就重写一句 | 0–1 次调用 |
| 回响层 | `echo.js` | 从对方的回复反推「热络 / 敷衍 / 诉苦」，反过来调情绪与语气 | 0 token |
| 承诺 | `promises.js` | 说好的事记下来，对方提能接上，到日子会主动提 | 0 token |
| 想念调度 | `longing.js` | 不是定时群发：多久想起你，由亲密度/信任/张力决定 | 1 次调用 |
| 群聊在场感 | `group.js` | 群里被问事会插一句，但不抢话、不刷屏 | 0 token |
| 自我线 | `self.js` | 「在干嘛」有真实答案；不装睡也不秒回 | 0 token |
| 历法感 | `clock.js` | 知道今天周几、什么节、现在几点，但不会张口报日期 | 0 token |
| 表情包 | `stickers.js` | 复合情绪（`开心+可爱`）、贴图优先、单独一条气泡、笑不笑从反应里学 | 0 token |
| 表情采集 | `sticker-fetch.js` | 库里没有合适表情就上网找一张，抓回来打标入库 | 0 token（视觉 1 次） |
| 人话自检 | `say.js` | 发送前扫中英混杂、助手腔、列清单、复述画面，太脏就重写 | 0–1 次调用 |
| 节奏 | `pacing.js` | 打字时长按字数、换人有「切窗口」延迟 | 0 token |
| 风控闸门 | `risk.js` | 掉线熔断、登录/重启额度、动作分级（被动回复 vs 主动动作） | 0 token |
| 自进化 | `evolve.js` | 从真实对话里统计「判冷太频繁」，自己把阈值往回调 | 0 token |

一次回复会依次经过：**连发合并 → 补账 → 回响 → 记忆召回 → 承诺 → 分寸 → 自我/历法 → 拼 prompt → 模型（并发抢答）→ 人话自检 → 太冲重写 → 表情挑选 → 打字节奏 → 发送**。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 为什么「所有规则都可进化」

这是本项目和普通 prompt 工程最不一样的地方，也是用户提的需求原话：

> 现在用的各种规则，都保持"进化"，不断调整。比如抱怨生活烦，不一定是对你的"冷"，反而是想寻求你的安慰…反而是热。

具体落成三条机制：

1. **意图优先于字数**：`echo.js` 先判 `intent`（hostile / vent / neutral）。「烦死了，今天被老板骂了」→ **vent（在求安慰）→ 算热**；只有「滚」「别烦我」才是 hostile。
2. **阈值自己会动**：`evolve.js` 每小时统计最近 N 条判定，如果「判冷」的比例超过 45%，就把 `coldScore` 往回调 0.03（上限 ±0.18），写到 `config/tuning.json`，各层读取时叠加。
3. **人工纠错入口**：`node scripts/evolve.js feedback "<原话>" vent` 会把这句话里的词学进词表，下一轮就认得。

表情同理：发出去之后 15 分钟内看对方怎么回，「哈哈哈好可爱」+1 分、「别发这种了」−4 分，分数参与挑选打权，被嫌弃到 −3 的图不再自动挑（点名仍发）。

## 快速开始

### 1. 前置

- Node.js ≥ 20（本机实测 24.x）
- 一个**你自己能登录**的 QQ 号，以及 [NapCat](https://github.com/NapNeko/NapCatQQ) 跑起来的 OneBot v11 HTTP/WS 端口
- 一个 OpenAI 兼容的模型出口（本机网关 / 官方 API / 中转都可以）

### 2. 装

```bash
git clone https://github.com/ffshanshuo/qq-persona-agent.git
cd qq-persona-agent
node -e "require('./scripts/brain.js')"   # 只验证语法与依赖
```

没有 `npm install` —— **本项目零第三方依赖**，只用 Node 内置模块。

### 3. 配

```bash
cp .env.example .env          # 填 OneBot 端口、token、模型地址
# 按自己的情况改 config/*.json（每份都有 _note 字段解释每个参数）
```

最小配置示例（`config/autoreply.json` 里需要改的几项）：

```json
{
  "selfId": 123456789,
  "private": { "enabled": true, "allowList": [100000001] },
  "group":   { "enabled": true, "requireAt": true, "allowList": [200000001] },
  "limits":  { "perContactPerHour": 0, "globalPerHour": 0 }
}
```

`0` = 不限制。默认配置里**白名单是空的**——不填就谁都回，请务必填。

### 4. 跑

```bash
node scripts/auto-reply.js        # 主循环（WS 事件驱动）
node scripts/auto-reply.js --self-test   # 10 项自检，不需要 QQ
AUTOREPLY_DRY=1 node scripts/auto-reply.js   # 演练：只决策和拼段，不真发
```

## 常用命令

```bash
node scripts/test-all.js              # 24 组离线自检（不需要 QQ / 模型）
node scripts/test-all.js --all        # 连在线用例一起（需要 NapCat + 模型）

node scripts/qq.js send <uin> "在吗"          # 直接发一条私聊
node scripts/qq.js moments "今天风很大"        # 发说说
node scripts/qq.js profile --sign "…"        # 改签名
node scripts/stickers.js list                 # 看表情库
node scripts/stickers.js pick 委屈             # 试试会挑哪张
node scripts/sticker-fetch.js fetch 委屈       # 上网抓几张回来入库
node scripts/longing.js list                  # 谁「该被想起」了
node scripts/risk.js status                   # 风控闸门当前状态
node scripts/mind.js graph p:100000001        # 看这个人的联想记忆图
```

## 目录结构

```
lib/store.js          统一的原子 JSON 落盘（tmp+rename 4 次重试 + 直写兜底）
scripts/*.js          各层实现 + 每层自己的 test-*.js
config/*.json         全部参数（每个都有 _note 解释）
assets/stickers/      表情库（库里不附带图片）
logs/                 运行态：上下文、记忆图、痕迹、发送日志（JSONL，可读可删）
docs/                 架构、风控合规、路线图、历史调研
```

## 测试

```bash
node scripts/test-all.js
```

24 组、700+ 断言，覆盖：分层上下文与补账、记忆图与巩固、关系事件脉冲衰减、想念公式单调性、承诺准入与到期、分寸降级、语气判定、回响打分、矛盾检测、历法、群聊闸门、自我线、自调参、风控熔断、adb 解析、表情路由/复合/采集/学习。

在线用例（`--all`）会真调模型、真读 NapCat 历史，但**永远 dry 发送**。

## ⚠️ 合规与风险（务必先读）

用**个人号**挂第三方客户端有真实风险。本项目开发过程中就踩过一次：手机端弹出「你的账号身份验证信息已失效」，快速登录凭据作废。原因不是「主动发了条消息」，而是**非官方客户端的客户端指纹 + 频繁重登**。

所以项目内置了 `risk.js`：

- 被动回复（`reply`）与主动动作（`proactive` / `qzone` / `profile` / `friend`）分级，后者默认拦截；
- 30 分钟内两次掉线 → 自动冷却 6 小时；登录失败 → 冷却 12 小时，**绝不反复重登**；
- 每日登录 / 重启额度（3 / 2 次）与最小间隔（10 分钟）。

**建议**：小号试水；只做被动回复；不要群发、不要批量加好友、不要用主号。想要零封号风险就走官方 QQ 开放平台（但那套不能发说说、不能改资料、不能主动私聊陌生人）。

细节见 [docs/RISK-AND-COMPLIANCE.md](docs/RISK-AND-COMPLIANCE.md)。

## 设计上的几个「反直觉」决定

- **情感不进 prompt 当标签**。给它一段「你现在心情不错」它就会演；改成让情感只影响「先想起哪条旧事」，语气是自然带出来的。
- **数字、权重、编号一律不进 prompt**。模型只看到人话（「你俩挺熟的」），否则它会把 `intimacy=0.62` 念出来。
- **冷场不记仇**。对方回得冷淡只降情绪、不降信任，避免一次忙碌把关系永久打低。
- **演练与失败一律不记账**。否则一次测试就会把真实节奏（想念冷却、承诺提醒）吃掉。
- **表情单独一条气泡**。QQ 里带图的消息和纯文字观感不同，混在一起不像真人。

## Roadmap

见 [docs/ROADMAP.md](docs/ROADMAP.md)。近期方向：学习分随时间衰减、把「今天发生的事」编成日记式摘要、多人群聊的人物建模。

## License

[MIT](LICENSE)。表情库、聊天记录、账号信息均不随仓库分发。

---

**免责**：本项目仅用于学习与研究。使用它操作任何账号的风险由使用者自行承担；请遵守腾讯的服务条款与当地法律。
