# 从零搭建（SETUP）

> 这份文档面向「想在自己的号上跑一套类似东西」的人。仓库**只提供代码与方法**，不提供账号、模型通道、音色模型、聊天记录、表情图片。
>
> 全程 Windows（Linux 可行但需要自己改路径与 NapCat 部署方式）。总耗时约 40–90 分钟，其中大部分是装 QQ 与配模型。

---

## 0. 你需要先有的东西

| 类别 | 必需 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11 x64 | 脚本大量使用 `cmd`、`%~dp0`、`Get-CimInstance`；Linux 需自行替换进程管理部分 |
| QQ | QQ NT 客户端（9.9.x） | **必须已登录**，NapCat 是「注入已登录的 QQ」，不是独立协议实现 |
| 机器人框架 | [NapCatQQ](https://github.com/NapNeko/NapCatQQ) Shell 版 | 无头注入，暴露 OneBot v11 HTTP/WS |
| 运行时 | Node.js ≥ 20（推荐 22/24） | 需要全局 `fetch` 与 `AbortSignal.timeout` |
| 模型出口 | 任意 OpenAI 兼容 `POST /v1/chat/completions` | 云 API、自建网关、本地 llama.cpp 都行，见 [MODEL.md](MODEL.md) |
| 语音（可选） | Python 3.10 + ffmpeg | 只有想发语音/克隆音色才需要，见 [VOICE.md](VOICE.md) |
| 账号 | **建议小号** | 第三方客户端有风控风险，见 [RISK-AND-COMPLIANCE.md](RISK-AND-COMPLIANCE.md) |

**目录要求**：装到纯 ASCII、无空格的路径（例如 `C:\qqbot`）。中文路径 + 空格会让 `cmd`、Python 子进程、`spawn` 在不同地方出问题。

---

## 1. 装 QQ 并登录

1. 安装 QQ NT（官网最新 9.9.x 即可），**用你要用的号登录一次**，确认能收发消息。
2. 关掉 QQ（托盘退出），后面由 NapCat 接管启动。

> 同一个号不要「桌面 QQ 和 NapCat 同时在线」：会互相抢登录。

---

## 2. 放 NapCat

1. 从 NapCat Releases 下 `NapCat.Shell.zip`，解压到 `<项目>/napcat/`（应能看到 `launcher-user.bat`、`napcat.mjs`、`config/`）。
2. 复制一份 `scripts/ob11.token.example` → `scripts/ob11.token`，填一个随机串（32 位 hex 即可），这是 OneBot 的访问令牌。
3. 把同一个 token 写进 `napcat/config/onebot11_<你的QQ号>.json` 的 `httpServers[].token` 与 `websocketServers[].token`，端口默认 `3000`（HTTP）与 `3001`（WS）。

> 如果第一次跑还没生成 `onebot11_*.json`，先启动一次 NapCat（见第 4 步），它会生成模板，再回来改。

---

## 3. 配置项目

```bash
cp .env.example .env          # 用编辑器打开，按注释填
cp -r config.example config   # 如果没有 config.example，就基于仓库里的 config/*.json 改
```

最少要改的四处：

| 文件 | 键 | 填什么 |
| --- | --- | --- |
| `config/autoreply.json` | `selfId` | 你的 QQ 号 |
| `config/autoreply.json` | `private.allowList` / `group.allowList` | 允许它回的人/群（留空 = 谁都不回，这是安全默认） |
| `config/brain.json` | `baseUrl` / `models` | 模型出口，见 [MODEL.md](MODEL.md) |
| `config/voice.json` | `provider` | `edge` / `sapi` / `gpt-sovits` / `rvc`，见 [VOICE.md](VOICE.md) |

`config/risk.json` 里 `allowProactiveOnClient` 默认 **false**：想让它主动找人（想念调度、追话头）再打开，建议先观察一周被动回复的日志。

---

## 4. 启动顺序（第一次手动，看清楚每一步）

```bash
# 1) 注入启动 QQ + NapCat，并等 OneBot HTTP 就绪
node scripts/start-qq.js

# 2) 确认通道通了（应打印 online=true 与昵称/群数）
node scripts/status.js

# 3) 常驻看门狗：保 auto-reply、collector、语音服务（如果配了）
node scripts/watchdog.js

# 4) 控制台（另开一个窗口）
node scripts/panel.js        # http://127.0.0.1:8787
```

之后日常用 `start-bot.cmd`（Windows）：它会按顺序做上面 1/3/4，等 QQ 上线后打印状态并打开面板。
`start-bot.cmd check` 只校验文件，不启进程；`stop` 只停自动化、保留 QQ。

---

## 5. 第一次对话前先做个 dry 演练

不要一上来就让它真发。用 dry 模式走完整链路（含模型、人格、表情选择），但**不发送、不记账**：

```bash
node scripts/dryrun.js p:<对方QQ> "在吗，今天好累啊"
```

输出里能看到：选中的思维模式（mode）、语气档位（prosody）、是否挑表情、回响判断（echo）、最终会发的那句话。
满意了再去掉 `AUTOREPLY_DRY=1`，把 `private.allowList` 加进你的号。

---

## 6. 上线检查清单

- [ ] `node scripts/status.js` → `online=true`，uin/昵称正确
- [ ] `node scripts/panel.js` 打开后「概览」显示 NapCat 在线、auto-reply 进程在
- [ ] `dryrun.js` 能出一句像样的回复
- [ ] `logs/autoreply.log` 里出现 `ws-open`
- [ ] `node scripts/test-all.js`（离线部分）全绿——用来确认你改的配置没破坏结构
- [ ] 想开主动功能：先看 README「主动与承诺」一节，把 `longing.js`/`watch.js` 的额度留在保守值

---

## 7. 目录约定

```
config/          所有可调参数（JSON，热加载，改完不必重启）
logs/            运行数据：上下文、记忆、表情账本、各层审计（可随时清空，会失忆）
assets/          表情库索引与图片、头像池
napcat/          NapCat 本体（不进版本库）
vendor/          可选第三方：Python venv、ffmpeg、语音服务（不进版本库）
```

`logs/` 里全部是**明文聊天内容与画像**，既是失忆开关也是隐私风险，备份/分享前务必处理。
