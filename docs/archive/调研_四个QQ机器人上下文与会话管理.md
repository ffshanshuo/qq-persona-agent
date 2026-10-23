# 调研：四个成熟 LLM QQ/IM 机器人的上下文与会话管理

> 调研方式：GitHub raw/blob 直取源码（web_search 不可用；GitHub code search 未认证 401）。抓不到的写「未验证」。
> 结论：**没有一个只用"滑窗截断"**——成熟做法都是「多段隔离键 + 双阈值（轮数/token）+ 软清空游标 + 被裁内容先摘要进长期记忆」，历史一律落盘，进程内只留热会话。

## 0. 两处更正
- `zhayujie/chatgpt-on-wechat` 已改名 `zhayujie/CowAgent`（47.5k star）。`bot/chat_channel.py` 在 master 上 404，现为 `channel/chat_channel.py`。
- `SingleChatMemory` 不存在；`common/memory.py` 只有 `USER_IMAGE_CACHE = ExpiredDict(60*3)`（图片缓存 3 分钟）。真正的会话记忆是 `SessionManager` + `Session`。

## 1. LangBot（原 QChatGPT）
实抓：`src/langbot/pkg/provider/session/sessionmgr.py`(437 行)、`src/langbot/pkg/agent/runner/context_reset.py`(74 行)、`transcript_store.py`、`alembic/versions/0040_session_summaries.py`

- **隔离键 6 元组**：`SessionKey = (instance_uuid, workspace_uuid, placement_generation, bot_uuid, launcher_type.value, launcher_id)`；reset 用 conversation_id 拼 `person_<QQ>` / `group_<群号>`。
- 结构：`_session_index: dict[SessionKey, Session]` + 过期最小堆 `_session_expiry_heap`（`(last_accessed, revision, key)`），惰性清理。
- 时间衰减：`idle_ttl_seconds` 默认 **86400**；容量 `max_entries` **2000**、`max_entries_per_workspace` **200**。
- 裁剪 `trim_conversation_messages(conversation, max_rounds)`：从尾部倒着数 **user 轮**凑够即停，再 `[-max_messages:]`（默认 **100**）；保留消息的 `image_base64`/`file_base64` 置 `None`。`max_conversations_per_session` 默认 **20**。
- **/reset 是软重置**：插 `runner_id='__langbot_context_reset__'` + 新 generation uuid，`active_history_condition()` 只取 marker 之后的行 → 可审计、可回滚。
- 重启：`initialize()` 是 `pass`（进程内会话丢），历史在 Transcript 表（SQLAlchemy，append-only + seq），可 `get_legacy_provider_messages()` 重建。
- 长期记忆：主链路没有；`0040_session_summaries` 是面板摘要列，不注入上下文。

可借鉴：① 多段隔离键（缺 bot 维度真会串，它做了 `0023_bot_scoped_sessions` 迁移）；② reset 用 generation marker 而非 DELETE；③ trim 时剥 base64。

## 2. CowAgent（原 chatgpt-on-wechat）
实抓：`channel/chat_channel.py`、`models/session_manager.py`、`models/chatgpt/chat_gpt_session.py`、`config.py`、`common/expired_dict.py`、`agent/memory/conversation_store.py`(3171 行)、`manager.py`、`summarizer.py`

- 隔离：私聊 `session_id = other_user_id`；群聊先过群名白名单，通过后 `group_shared_session` **默认 True → session_id = group_id（整群共享一套）**，置 False 才按 `actual_user_id`。
- 裁剪：`while cur_tokens > max_tokens: self.messages.pop(1)` —— **永远保住 `messages[0]` 的 system**，从最早用户发言逐条丢。`conversation_max_tokens` 默认 **1000**，但 `config.py:99` 注释是 "max characters"，非 tiktoken 模型走 `len(content)` 累加 → 实际是 1000 字符。
- `ExpiredDict(expires_in_seconds)` 默认 **3600**（1 小时不说话会话消失）。
- 持久化（`agent/memory/conversation_store.py`，SQLite `<workspace>/memory/long-term/index.db`）：
  - `sessions(agent_id, session_id, channel_type, title, context_start_seq, created_at, last_active, msg_count, pinned, context_usage)`，PK `(agent_id, session_id)`；
  - `messages(..., seq, role, content, created_at, extras)` append-only，UNIQUE `(agent_id, session_id, seq)`；
  - `clear_context()` 只写 `context_start_seq = latest_seq`，**不删行**；`load_messages` 只读 `seq >= context_start_seq`。
- 长期记忆：`memory/YYYY-MM-DD.md`（日记）、`memory/users/<uid>/...`、`MEMORY.md`（常青，每次注入 system）。`MemoryFlushManager`（`summarizer.py:196`）三触发：trim 丢旧轮（reason=`trim`）、API context 溢出（`overflow`）、日终 `daily_summary`；两套内容 hash 集合防重复写（`_trim_flushed_hashes`/`_daily_flushed_hashes`）。**Deep Dream** 定期把日记蒸馏进 `MEMORY.md`。
- 检索时间衰减只在**检索**层：日期日记按天衰减，`MEMORY.md`/knowledge 一律 multiplier=1.0。

可借鉴：① 被裁内容先摘要进日记再丢；② `context_start_seq` 软清空游标；③ system 固定 `messages[0]`、只 `pop(1)`；④ 摘要按 hash 去重。
坑：群聊默认整群共享会串味；token 实为字符数；`ExpiredDict` 惰性过期；trim 后不同步模型侧会重复触发。

## 3. AstrBot
实抓：`astrbot/core/conversation_mgr.py`(443 行)、`astrbot/core/agent/context/truncator.py`(202 行)、`astrbot/core/astr_main_agent.py`(2039 行)、`astrbot/core/db/po.py`、`builtin_commands/commands/conversation.py`

- **两级模型**：会话（session）= 对话窗口；对话（conversation）= LLM 上下文，一个会话下多条可切换/删除。会话 ID = `unified_msg_origin`，格式 `platform_name:message_type:session_id`，DB 里当 `user_id`。
- 存储：`conversations` 表（`ConversationV2`）`content: list[dict]`（OpenAI 格式 JSON 列）、`title`、`persona_id`、`token_usage`；「当前用哪条」= `session_conversations` 内存 + `sp.session_put(umo,"sel_conv_id",cid)` 落 shared_preferences → 重启恢复。
- 裁剪三策略（`truncator.py`，都先 `_split_system_rest` 拎出 system）：`truncate_by_turns(keep_most_recent_turns, drop_turns)`、`truncate_by_dropping_oldest_turns(drop_turns)`、`truncate_by_halving()`；裁完必过 `_ensure_user_message`（system 后强制紧跟 user）+ `fix_messages`（修 assistant(tool_calls)/tool 配对）。
- 默认（`astr_main_agent.py:215-229`）：`context_limit_reached_strategy="truncate_by_turns"`、`max_context_length: 50`、`dequeue_context_length: 10`、`fallback_max_context_tokens: 128000`；`llm_compress` 策略另有 `llm_compress_keep_recent_ratio: 0.15` + `llm_compress_provider_id`（可用便宜模型专做压缩）。
- `/reset`（清空当前，`update_conversation(history=[])` + `stop_all`）vs `/new`（新建，旧的不删）。
- 群聊分人：`_append_system_reminders` 把 `User ID: {user_id}, Nickname: {nickname}` 写进 **system**（`identifier` 开关），另有 `Group name:`、时间；引用消息包 `<Quoted Message>`。每人共用一个 conversation，靠 system 标注区分。
- 长期记忆：主仓库无实现（只有前端页 `LongTermMemory.vue`），走插件；仓内是 `knowledge_base`（RAG）。

可借鉴：① 会话/对话两级 + `/new` 分区；② 多策略可配；③ `_ensure_user_message`+`fix_messages` 这类 API 兼容修补必须抄；④ 压缩用独立便宜模型 + 保留最近 15% 原文。

## 4. NoneBot 生态
- `KroMiose/nonebot_plugin_naturel_gpt`：按 `chat_key` 隔离，每 chat 一个 json（`config.NG_DATA_PATH`，pkl→json 兼容 + `.bak` 轮转）→ 重启不丢。裁剪+摘要（`chat.py:51-68`）：`len(history) > CHAT_MEMORY_MAX_LENGTH(16)` 且 `CHAT_ENABLE_SUMMARY_CHAT` → LLM 压成 `chat_summarized`，再保留 `[-CHAT_MEMORY_SHORT_LENGTH(8):]`；`CHAT_MAX_SUMMARY_TOKENS=512`、`CHAT_SUMMARY_INTERVAL=10`。用户画像 `chat_impressions[userid]` 每 `USER_MEMORY_SUMMARY_THRESHOLD(12)` 条更新。**坑：`CHAT_ENABLE_SUMMARY_CHAT` 默认 False → 开箱是纯截断。**
- `lanxinmob/nonebot-plugin-memory`：`chat_histories` 内存 + Redis 可选（ping 失败退内存）；`MAX_HISTORY_TURNS=50`（写回 `[-100:]`）；群聊分人靠 `【昵称_id】：内容`；22:00 cron 把 24h 日志按 user 聚合成 `user_profile:<uid>`。坑：无 Redis 重启全丢、无摘要 token 直涨。
- `A-kirami/nonebot-plugin-chatgpt`：Playwright 驱动网页版 chatgpt，无自有裁剪/持久化，别参考错。

## 5. 可直接照抄（按性价比）
1. 隔离键做多段：`(平台, bot/账号, 会话类型, 会话id)`。
2. 软清空游标：`/reset` 只写 `context_start_seq` 或 generation marker，历史不删。
3. 裁剪两件事：system 不动 + system 后紧跟 user；顺带修 tool 配对。
4. 丢之前先摘要：写进当日记忆（hash 去重），日终蒸馏常青记忆。
5. 双阈值：轮数 + token/字符上限，任一触发即裁。
6. 历史剥 base64：只留 URL/文本。
7. 群聊分人靠 prompt 标注（`User ID/Nickname` 或 `【昵称_id】`），不给每人单开上下文。
8. 常青与衰减分开：常青 multiplier=1.0，日期记忆按天衰减。

## 6. 已知坑（有源码出处）
群聊默认整群共享会串味；「1000 token」在非 tiktoken 实现里其实是字符数；LangBot `initialize()` 为空、纯内存实现重启丢上下文，AstrBot（DB+sp）与 CowAgent（sqlite）才稳；trim 不同步模型侧会重复触发；摘要不去重会一天写十遍；`ExpiredDict` 惰性过期只读不写会一直占内存。
