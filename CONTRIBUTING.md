# 贡献指南

感谢你愿意帮忙。这个项目的边界很清楚：**「像不像真人」是可以被拆解和测试的工程问题**，不是玄学。所以贡献也围绕这条线。

## 最有价值的贡献

1. **新的「不像人」的具体例子**。比功能请求有用一百倍。请贴出：上下文（大概聊了什么）+ 它说了什么 + 你觉得哪里不对 + 你期望它说什么。我会尝试把它变成一个可断言的行为，然后写测试。
2. **某一层在真实语料上的误判**。比如 `echo.js` 把「我今天好累」判成冷漠、`them.js` 没识别出「我去洗个澡」。
3. **测试用例**。尤其是「边界样本」：反讽、方言、纯表情、跨天对话、群聊里插话被无视。

## 提 PR 的约定

- **零第三方依赖**。只用 Node 内置模块；如果你的实现需要依赖，请先开 issue 讨论。
- **每层可单独测**：新增行为请同时加 `scripts/test-<layer>.js` 用例，并保证：
  - 全离线：模型 / OneBot / HTTP / adb 用注入桩；
  - 状态目录用 `QQ*_DIR` 环境变量隔离到 `logs/*-test/`（**这条最重要**，否则会污染真实会话状态）；
  - 跑 `node scripts/test-all.js` 全绿。
- **不要往 prompt 里塞数字**。权重、分数、节点编号一律留在代码里，模型只看人话。它会把 `intimacy=0.62` 念出来。
- **模块间不互相 `require` 状态文件**。要读别人状态就调对方的函数（比如 `bonds.effectiveRel()`），否则会出现「两个地方各记一份关系分」。
- **副作用层必须遵守「演练/失败不记账」**（承诺提醒、想念开口、表情学习）。
- 新参数请写进 `config/*.json` 并带 `_note` 解释「为什么是这个值」，不要硬编码在代码里。

## 不要做的事

- 提交任何真实的 QQ 号、群号、手机号、聊天记录、访问令牌；
- 提交有版权的表情图片（`assets/stickers/` 里图片默认被 `.gitignore` 排除）；
- 加入群发、批量加好友、绕过风控之类的功能 —— 见 [RISK-AND-COMPLIANCE](RISK-AND-COMPLIANCE.md)。

## 开发流程

```bash
node scripts/auto-reply.js --self-test      # 10 项基础自检
AUTOREPLY_DRY=1 node scripts/auto-reply.js  # 演练模式，不真发
node scripts/test-all.js                    # 24 组离线回归
```

调试某一层时，优先用它的 CLI：

```bash
node scripts/echo.js sim "我今天好累" "累就早点睡"
node scripts/stickers.js pick 开心+可爱
node scripts/longing.js sim p:100000001
node scripts/risk.js gate proactive
node scripts/evolve.js preview
```

## 提交信息

```
feat(stickers): 支持复合情绪打分
fix(echo): 把「诉苦」从冷漠里改判为求安慰
test(them): 补 3 个当前状态的边界用例
docs(readme): 补风控截图说明
```

行内注释请写**为什么**（尤其那些看起来多余的防御代码），别写「做了什么」。
