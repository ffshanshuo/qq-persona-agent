# 模型出口怎么接（MODEL）

> 这个仓库**不带任何 key，也不假设你用哪家模型**。所有模型调用都走 `config/brain.json` 里的一个 OpenAI 兼容端点，换供应商只改这个文件。

---

## 1. 配置长什么样

`config/brain.json`（节选，键名与代码一致）：

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:8326/v1/chat/completions",
  "apiKeyFile": "scripts/gw.token",
  "models": ["combo:your-fast-model", "combo:your-backup-model"],
  "timeoutMs": 6000,
  "maxTokens": 300,
  "temperature": 0.9,
  "race": true,
  "raceDeadlineMs": 7000,
  "ctxBudget": 4200
}
```

| 键 | 作用 | 调参建议 |
| --- | --- | --- |
| `baseUrl` | 完整 chat/completions 地址（**不是** base URL） | 云 API 一般是 `https://api.xxx.com/v1/chat/completions` |
| `apiKeyFile` | 存 key 的文件路径（相对项目根），key 不写进 JSON | 文件权限 600；或在你的部署里改成读环境变量 |
| `models` | 候选模型，**按顺序/并发抢答** | 放 2–3 个「快且稳」的；别放会返回空内容的模型（见 §4） |
| `timeoutMs` | 单次请求超时 | 6–10s 适合聊天；本机小模型可 20s |
| `maxTokens` | 单次输出上限 | 300 够聊天；思维模式层会按场景动态传 `ctx.maxTokens` 覆盖 |
| `race` / `raceDeadlineMs` | 多个模型同时发，第一个可用的赢，超过 deadline 整体放弃 | 免费池抖动大时开；单一稳定 API 可 `race:false` |

视觉（看图/表情打标）单独在 `config/voice.json` 无关的 `config/brain.json` 的 `vision` 段或 `scripts/vision.js` 的环境变量里配，见文件头注释。

---

## 2. 三种常见接法

### A. 云 API（最省事）
```bash
echo "sk-xxxx" > scripts/gw.token && chmod 600 scripts/gw.token
# config/brain.json: baseUrl 改云厂商的 chat/completions，models 填其模型 id
curl -s http://127.0.0.1:8787/api/health     # 面板里点「试一句」最快验证
```

### B. 自建网关（把多家模型做故障转移）
任何暴露 OpenAI 兼容接口的网关都行（one-api、LiteLLM、自己的 failover 服务）。好处是：本仓库的 `race` + 网关的 failover 一起用，单家挂了也不至于沉默。

### C. 本地模型（llama.cpp / Ollama）
```bash
# Ollama 自带 OpenAI 兼容层
config/brain.json: baseUrl = "http://127.0.0.1:11434/v1/chat/completions", models = ["qwen2.5:7b"]
```
本地模型延迟高、上下文小，建议 `timeoutMs: 20000`、`ctxBudget: 2000`，并关掉 `race`。

---

## 3. key 放哪里（三种，按你的环境选）

1. `apiKeyFile` 指向一个 600 权限的小文件（仓库默认方式，最简单）
2. 环境变量注入，代码里改成 `process.env.YOUR_KEY`（改 `scripts/brain.js` 的 `requestHeaders`）
3. 网关自己持有 key，本仓库用无鉴权的内网地址（仅限本机/内网）

**永远不要**把 key 写进 `config/*.json` 后提交——仓库的 `.gitignore` 已经挡了 `*.token`，但 JSON 不会拦。

---

## 4. 失败与降级（这套系统怎么处理模型抽风）

| 情况 | 代码里的行为 | 你要知道的 |
| --- | --- | --- |
| 某个模型返回空内容 | **视为失败**，换下一个 | 空答模型（返回 `finish=length` 或空串）会「抢赢」并发请求，导致对方发消息而这边静默——所以必须能识别空答 |
| 全部失败/超时 | 记 `brain-error`，**不发模板套话**（这个仓库故意删掉了「在的，刚看到」这类兜底），75 秒后重投一次，仍失败就静默 | 宁可这条不回，也不要回一句明显是机器人的话 |
| 400 `Reasoning is mandatory` | 自动去掉 `reasoning` 字段重试一次 | 个别推理模型强制要 reasoning，这样兼容 |
| 429 / 402 额度 | 换下一个模型；全挂就等于当天没得用 | 面板「概览」里能看 `brain-error` 计数 |
| 回复太脏/像助手 | `say.js` 扫中英混杂、助手腔、列清单，必要时重写一次 | 重写也算一次调用，别把 `say.retryCodes` 放太宽 |

---

## 5. 省钱与提质的几个旋钮

- `ctxBudget`（默认 4200 字）：prompt 装配层的总预算。穷人套餐可以压到 2500，长对话会先丢「低优先级段」而不是硬截断。
- `race`：能让平均延迟从 6–8s 降到 2–3s，代价是 token 用量翻倍；只在免费池/抖动大时开。
- 表情清单只发 10 条（不是全部 60+）：这是刻意的，省 900+ 字上下文。
- `mode.js` 的 token 预算（deep 500 / quick 180）是「这轮该想多深」的开关，比统一加 maxTokens 省。
- 想看真实用量：`grep '"event":"slow-reply"' logs/autoreply.log`、`grep '"event":"brain-error"'`，以及 `node scripts/selfmod.js metrics 24`。

---

## 6. 自检

```bash
node scripts/brain.js --prompt "在吗"          # 直连模型，看原始输出
node scripts/dryrun.js p:<QQ> "测试一句"        # 走完整链路但不发送
node scripts/test-all.js --only prompt,mode    # 不依赖网络的离线层
```

如果 `brain.js --prompt` 通、`dryrun` 通、但真实消息没回复，问题通常在通道（NapCat/OneBot）而不是模型，去看 `logs/autoreply.log` 的 `ws-open` 与 `skip` 原因。
