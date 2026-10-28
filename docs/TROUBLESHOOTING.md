# 排查手册（TROUBLESHOOTING）

> 这里集中了这套系统开发过程中真实踩过的坑。按「症状 → 原因 → 处理」组织，症状尽量写日志里的原文，方便直接搜。

---

## 1. 通道 / NapCat / OneBot

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `node scripts/status.js` → `未连接：fetch failed` | NapCat 没起 / QQ 没登录 / 端口不对 | `node scripts/start-qq.js`，看 `logs/launch-*.log` 里有没有 `登录成功` |
| `当前账号(xxx)已登录,无法重复登录` | 桌面 QQ 还开着 | 托盘退出 QQ，或用 `stop-qq.js` 再启动 |
| `{"code":-1,"message":"Unauthorized"}` | OneBot token 不对 | `scripts/ob11.token` 与 `napcat/config/onebot11_<uin>.json` 里两处必须一致 |
| WS 连上但收不到消息 | `httpServers` 建了、`websocketServers` 没开 | 两个都要配；或用 `node scripts/enable-ws.js` |
| 发出的消息对方看不到、返回 `retcode 200 / result 120` | 该群没有发言权限 | 先用 `send_group_msg`+`delete_msg` 探测；无权限的群从 `allowList` 去掉 |
| 撤回失败 `recallMsg … c2c custom recall beat` | C2C 撤回窗口只有 **2 分钟** | 超过就撤不回；把这当作「发送前必须自检」的理由 |
| `get_msg` 拿到的 `message_seq` 不对劲 | NapCat 里 `message_seq = message_id`（假值） | 真序号用事件里的 `real_seq`；主动引用就传它 |

---

## 2. 账号与风控（先看这条）

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 手机 QQ 弹「身份验证信息已失效」，快速登录失效 | 第三方客户端（NapCat 注入）触发风控 | 停整栈不要在自动重启上死循环（本仓库 risk.js 会熔断）；由号主在手机官方 QQ 里恢复验证 |
| 反复 5–10 分钟重登后越来越严重 | 反复登录是加重信号 | 掉线冷却（默认 6h）、登录失败冷却 12h，`node scripts/risk.js status` 看状态 |
| 想让它主动找人但怕封号 | 主动动作风险远高于被动回复 | `config/risk.json` 的 `allowProactiveOnClient` 默认 false；真开也把 `longing/watch` 频率留在保守值，先用小号 |

**结论**：这套东西本质是「第三方客户端 + 个人号」，风控是概率问题，不是配置问题。想长期稳定 → 走 QQ 开放平台官方 bot（能力受限，不能改资料/发空间）。

---

## 3. 模型出口

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 所有回复变成沉默，日志 `brain-error` | key 无效 / baseUrl 错 / 429 | `node scripts/brain.js --prompt "在吗"` 直连测 |
| 偶尔回复空、日志 `sent` 的 `reply` 为空 | 某模型返回空内容却抢赢了并发 | 把它从 `models` 拿掉；代码对空答已按失败处理，但 `finish=length` 的截断需要靠调 `maxTokens` |
| `HTTP 400 Reasoning is mandatory` | 个别推理模型强制要 reasoning | 代码会自动去掉该字段重试；也可换模型 |
| 很久才回（10s+） | 免费池抖动 | 开 `race:true`、缩 `timeoutMs`、`models` 只留 2 个快的 |
| 回复像客服/带「根据我的记忆」 | 模型能力不够或 SYSTEM 被删改 | 保留 `scripts/brain.js` 的 SYSTEM 段；`say.js` 只兜一层，不是万能 |

---

## 4. 语音

见 [VOICE.md §5](VOICE.md#5-排查清单语音不出声--声音不对)。这里只补三条最容易忽略的：

- **换了参考音频但声音没变** → 缓存 key 没包含参考文件指纹，清 `logs/voice-gsv/`
- **长句要等 1 分钟** → CPU 合成约 0.3–0.5s/字；把 `voice.maxChars` 设回 40–80
- **合成成功但没发出去** → `voice.choice: model` 下模型得写 `[[语音]]` 才会发；`random` 才是概率触发

---

## 5. 文件、路径、编码（Windows 特有）

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `ReplaceFileW EIO (Win32 1175)` / `file no longer exists` | E:\ 等盘上的原子 rename 偶发失败（云占位属性/杀软） | 代码里 `lib/store.js` 已 4 次重试 + 直写兜底；改代码时用「读→edit」而非盲写 |
| `.cmd` 里中文乱码、报「不是内部或外部命令」 | cmd 用 GBK，含 UTF-8 中文注释会烂行 | 启动脚本一律**纯 ASCII + CRLF** |
| `timeout /t` 报 `invalid time interval '/t'` | PATH 里 MSYS/Cygwin 的 `timeout` 抢先 | 用 `powershell Start-Sleep` 或 `ping -n` 代替 |
| 路径带中文/空格后子进程报错 | `spawn`/Python 参数编码 | 装到纯 ASCII 无空格路径；所有脚本已用 `%~dp0`/`__dirname` |
| `git` 报 `unable to unlink .git/index.lock: Invalid argument` | 目录带云占位属性（OneDrive/同步盘） | 换到本地非同步目录再 git |
| bash 里 `node -e` 中文/模板字符串报错 | 引号与反引号被 shell 抢先解析 | 中文多行改动写成 `.cjs` 脚本再 `node` 跑 |

---

## 6. 进程、端口、单实例

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 同一条消息被回两遍 | 起了两个 auto-reply（手工起 + watchdog 拉） | 只保留 watchdog 那个：按命令行杀 `*auto-reply.js*` 后让它拉起 |
| 8787 / 3000 / 3001 / 6099 被占 | 旧进程/别的软件 | `netstat -ano | findstr :8787` → 按 PID 处理；`panel.js` 检测到占用会跳过启动 |
| 定时器像没跑（没有日志） | 很多定时器**只在有动作时写日志** | 看每小时心跳（如 `watch-tick`）、`longing-check`；或直接看面板卡片 |
| 改了 config 不生效 | 配置多在启动时读一次，或读取路径不同 | 多数模块按 mtime 热加载；改完跑 `node scripts/panel.js` 面板或重启 auto-reply 确认 |
| `memories/.memory.lock` 报 EPERM/timeout | 孤儿锁（持锁进程已死但主进程还活着） | 删掉该 lock 文件即可（本仓库不依赖它的一致性） |

---

## 7. 数据与隐私

- `logs/` 里是**明文聊天 + 画像**：`context/`（原文与摘要）、`mind/`（情感与关系图）、`trace/`（完整 prompt 与输出）、`selfwrite/`（它自己记的东西）。
- 想「让它忘掉某人」：删对应 `logs/context/<会话>.json`、`logs/mind/<会话>*`，再重启 auto-reply。
- 想「重置全部记忆」：清空 `logs/`（保留 `logs/*.log` 无所谓），会连表情反馈学习一起重置。
- **分享/备份前**必须处理：`logs/`、`scripts/ob11.token`、`scripts/gw.token`、`vendor/voices/`（音色）、`assets/stickers` 里来源不明的图。

---

## 8. 自检与回归

```bash
node scripts/test-all.js                 # 全部离线自检（不联网、不发消息）
node scripts/test-all.js --only say,mode # 只跑指定几组
node scripts/arch.js --check             # 架构一致性（新脚本有没有归类/注册）
```

常见假失败：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 单跑全绿、整套偶红 | 测试之间共享 `logs/` 或限流状态 | 每个测试都该设自己的 `QQ*_DIR` 与 `AUTOREPLY_STATE`；仓库已按此约定 |
| 时间相关断言偶红 | 用 `Date.now()` 做固定基准 | 测试里把基准时间固定（`new Date(2026,9,23,11,0,0)`） |
| 在线组全红 | 机器负载高、模型超时 | 用 `config/brain.test-long.json`（timeout 20s）跑测试 |
| `test-context` 报「失败且无输出」 | 输出超默认 1MB 缓冲 | `test-all.js` 已设 `maxBuffer: 64MB`；自己写 runner 要注意 |
