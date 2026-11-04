<div align="center">

# @dsh-plugin/dsh-synapse

**Use DSH in QQ and Discord, and add automated reviews to your GitHub repositories.**

English | [简体中文](README.zh_CN.md)

</div>

## What It Does

Synapse uses the default model selected in DSH for chats and GitHub reviews:

- Chat in QQ groups, direct messages, and Discord channels with support for images, reply quotes, emoji reactions, progress cards, and command approvals, plus two-way bridging between QQ groups and Discord channels.
- Manage group join requests, blocklists, welcome messages, and pokes, alongside GitHub and Bilibili subscriptions, Minecraft and Modrinth queries, version tracking, bracket matching, peak/off-peak reminders, and Markdown image rendering.
- Remember key details from chats and reviews, and turn recurring workflows into reusable Skills.
- Get review comments for GitHub pull requests, triage suggestions for issues, and repository and release notifications in your groups.

## Installation

Requires DSH `0.1.5` or newer, Node.js `24.9+`, and `npm`. For QQ, run a OneBot 11 client with HTTP and forward WebSocket support, such as NapCat or Snowluma. Image cards also require a local Chrome or Chromium installation.

1. Open the DSH Plugin Marketplace, search for, and install `@dsh-plugin/dsh-loader@next` and `@dsh-plugin/dsh-synapse@next`.
2. Open the plugin settings page and fill out the configuration cards as needed. To generate image cards, enter the path to your local Chrome or Chromium executable.
3. Select a default model in DSH's model settings, then connect the channels you want to use below.

## Connecting QQ & Discord

1. Under "OneBot · NapCat / Snowluma", enter the HTTP and forward WebSocket URLs and access tokens.
2. Add group IDs and conversation admins under "QQ / Discord Message Behavior". Add group IDs under "Command Entry" to enable group commands; set welcome messages under "New Member Welcome". The bot is off by default: turn on "Enable Bot" after configuring it.
3. To bridge Discord, fill in the Bot Token, Guild ID, channel name, linked QQ group ID, and forwarding rules under "Discord Cross-Platform Bridge".
4. Enable `Message Content Intent` in the Discord Developer Portal. For slash commands such as `/send`, include the `applications.commands` scope when inviting the bot.

## Daily Use & Permissions

Each QQ group and its bridged Discord channel share a single ongoing conversation while keeping track of who said what. QQ direct messages are kept separate for each user, and GitHub reviews are kept separate for each repository. Messages within the same conversation are handled one by one in the order they arrive.

QQ 发送按群聊和私聊独立排队，由全局调度器以至少 2 秒间隔轮流发送；一个会话等待回执时，其他会话可继续发送。同一会话待发的兼容消息先合并，合并后超过现有字符阈值、行数阈值或单条最大字符数时转为聊天记录。阈值默认 300 字符或 5 行，`0` 关闭对应阈值；不同引用、消息来源、语音保持分开，桥接消息与可撤回回执保留独立消息 ID。

Send `stop` or `停止` to cancel the current reply and let the next queued message proceed. Send `reset`, `新对话`, or `清除上下文` to cancel active and queued tasks and start a new conversation, keeping saved long-term memory. Use `/help` to see available commands; management commands for reloading, restarting, and shutting down require the appropriate admin permissions.

“任务运行限制”中的“单次任务超时（秒）”和“单次任务最大步骤数”均支持 `-1`，分别取消聊天与 GitHub 审查的 Synapse 自动超时和步骤上限。默认值为 120 秒和 6 步，有限值范围为 0–600 秒和 0–20 步，`0` 分别表示立即超时和禁止执行步骤；手动停止和插件关闭仍会取消任务。

When session persistence is enabled in DSH, reloading can restore the conversation. Unfinished chat messages must be sent again after a reload.

会话被归档后，Synapse 会在下一条消息到来时新建会话并保存新绑定，保留旧会话的归档状态与历史。DSH `0.2.2` 的工作区及会话也会显式登记到宿主工作区列表。执行期间归档会话时不会自动重放工具操作，下一条消息会使用新会话。

You can adjust conversation permissions under "Task Execution Limits → Permissions for all new Synapse sessions":

- **Read Only** (default)
- **Workspace Write**
- **Full Access**
- **Auto Review**: DSH reviews tool operations before deciding whether to allow them. Requires `@deepseek-ai/dsh-experimental-auto-review` to be installed and enabled in the current profile.

Changes apply only to new or reset conversations. Existing and restored conversations keep their permissions. The MCP allowlist below still determines which tools can be called.

## 群聊上下文与主动回复

已启用聊天的 QQ 群独立持久化最近 100 条未触发消息，原生输入事件与持久化确认后清理批次。图片、图片表情及引用图片按内容哈希缓存到 `<profile>/data/dsh-synapse/temp/imgs/`，输入保留路径，模型按需调用标准读图工具；默认保留 7 天，并保护待提交和执行中的引用。

设置页新增群聊策略编辑器、运行状态表和可按群、类型、时间筛选的日志表。概率回复与空闲消息都默认关闭，需要全局与逐群同时启用，支持继承全局参数、群级自定义和不中断回复的热更新。默认概率 3%，词云按 48 小时窗口与 18 小时半衰期加权，加成最多 200%；空闲窗口为 15–45 分钟，25% 概率命中后延迟 30–80 秒，真人消息会取消延迟事件。两类功能均受冷却、额度与群忙碌状态约束，空闲消息默认在上海时间 00:00–09:00 静默。

AI 忽略名单只影响 AI 流程，命令、自动卡片与 Discord 转发保留。支持 `/synapse probability`、`/synapse idle`、`/synapse blockword` 和 `/synapse logs` 管理命令，全局修改仅限 operators。完整参数和恢复规则见[群聊功能说明](README.zh_CN.md#群聊上下文与主动回复)。

## Persona, Memory & Skills

聊天与审查均继承宿主 `standard` 预设的系统提示词、工具及原生 AGENTS.md 加载机制。`<dsh_home>/SOUL.md` 提供聊天补充规则，`<dsh_home>/AGENTS.md` 提供审查补充规则，profile 下的同名文件优先。这些文件通过宿主渲染器作为带来源路径的用户角色规则上下文注入，标准系统提示词保留；修改、删除和恢复去重均在后续请求中生效。

聊天与审查记忆分开保存，同一 profile 下的 QQ 与 Discord 共享聊天记忆。导入 Hermes 记忆时，在“RAG / Skill 自总结”点击“导入 Hermes 记忆”，在弹窗粘贴文本，点击右上角预览 Markdown，再点击底部“确认导入”。

“Skill 管理”通过表格列出名称与来源，点击“编辑”先预览 Markdown，再通过右上角“编辑”和“保存”修改内容。支持新增和删除 profile 条目；保存继承的 Home Skill 会创建 profile 覆盖，保留原文件。模型主动委派原生 sub-agent 总结 Skill 与重要记忆，详见[中文文档](README.zh_CN.md#人设记忆与-skill)。

## OneBot 历史与通用调用

聊天模型在群聊中获得 `synapse_get_group_msg_history`，在 QQ 私聊中获得 `synapse_get_friend_msg_history`，目标由当前会话绑定，默认读取 20 条，最多 100 条。NapCat 使用 `message_seq` / `reverseOrder`，SnowLuma 使用 `message_id` / `reverse_order`，省略时采用后端默认值。

`synapse_onebot_api` 接受相对 `path` 与 JSON `params`，自动复用已配置地址、前缀和访问令牌，通过 POST 转发给 OneBot。通用工具向聊天模型开放，说明中注入可信发言者与管理员状态，要求模型自行核对调用权限。结果包含 HTTP 状态及原始回执，保留业务失败与异步状态；回执完整进入工具结果，最大 2 MB，支持取消和 15 秒超时。详见[完整说明](README.zh_CN.md#onebot-历史与通用调用)。

## MCP

“MCP 管理”通过表格列出服务，点击新增或编辑后在弹窗设置 `stdio`、`Streamable HTTP` 或 `SSE`。点击“测试并获取工具”测试当前草稿，工具列表与参数 Schema 显示在弹窗底部，无需提前保存；右上角保存后生效。`stdio` 服务以当前系统用户权限运行。

本面板的 MCP 服务提供给聊天会话，只有允许列表内的工具可供调用，留空时停用这些服务的调用。宿主标准预设提供的工具按宿主配置向聊天与审查会话开放。

## GitHub Reviews

Add a Webhook in your GitHub repository or organization. Set the Payload URL to `https://<your-dsh-domain>/hooks/dsh-synapse/github`, choose `application/json` as the Content type, set a Secret, and select `Pull requests`, `Issues`, and `Releases` events.

Under "GitHub Webhook" in the plugin settings, enter the same Secret, a GitHub Token with repository read access, and the allowed repositories, such as `owner/repo` or `owner/*`. Turn on "Enable Webhook Review".

审查结果默认保存在本地。“GitHub 审查任务”通过可滚动表格列出目标、类型、状态与更新时间，支持查看结果和重试失败任务。聊天与审查会话分别使用 `<profile>/workspace/chat/` 和 `<profile>/workspace/review/`，目录自动创建。发布审查评论需要 Token 的 `Issues` 和 `Pull requests` 写权限，并启用自动发布；不会自动 approve 或 merge PR。

## FAQ

**Why isn't the bot replying in my group chat?**

Check "Enable Bot", the OneBot connection, and the group ID under "QQ / Discord Message Behavior". Group chat requires an @mention by default; keyword triggers are also available. Group commands require the group to be enabled under "Command Entry". For Discord, check the channel mapping and `Message Content Intent`.

**Why does enabling memory take a long time or fail the first time?**

The first use downloads local models, so the time depends on your connection. Failed connections are retried through `hf-mirror.com`. If you need a proxy, set `HTTPS_PROXY` before starting DSH; Node.js 24 can also use `NODE_USE_ENV_PROXY=1`.

**Why didn't changing session permissions affect my current group chat?**

New-session permissions do not change an existing conversation. Send `reset` or `清除上下文` to start a new conversation with the new permissions.

**Why don't settings changed via chat commands show up in the web form?**

Under "Runtime Status & Configuration Sync", click "Sync feature settings modified by chat commands" to read the changes back into the form. Syncing saves the configuration and reconnects the channels.

## Feedback & License

Report problems and suggestions in [Issues](https://github.com/dsh-plugins/dsh-synapse/issues). Source code is available on [GitHub](https://github.com/dsh-plugins/dsh-synapse).

This project builds upon [Gu-ZT/gugle-chat-bot](https://github.com/Gu-ZT/gugle-chat-bot) and is released under the `AGPL-3.0-only` license. See [`NOTICE.md`](NOTICE.md) for upstream licenses, author credits, and modification notes.
