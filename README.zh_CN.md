<div align="center">

# @dsh-plugin/dsh-synapse

**在 QQ 和 Discord 里使用 DSH，并为 GitHub 仓库添加自动审查。**

[English](README.md) | 简体中文

</div>

## 能做什么

Synapse 支持分别选择默认聊天模型和默认审查模型，记忆与 Skill 总结子代理继承对应通道的模型路由。留空时使用 DSH 默认模型。

- 在 QQ 群聊、私聊与 Discord 频道中聊天，支持图片、回复引用、表情回应、进度卡片与命令审批，也可以把 QQ 群和 Discord 频道双向连通。
- 处理入群申请、黑名单、欢迎语、戳一戳，支持 GitHub 与 B 站订阅、Minecraft 与 Modrinth 查询、版本跟踪、括号匹配、峰谷提醒和 Markdown 图片渲染。
- 记住群聊和审查中的重要信息，将常用处理步骤保存为可复用的 Skill。
- 为 GitHub Pull Request 提供审查意见，为 Issue 提供分诊建议，并向群里转发仓库和 Release 通知。

## 安装

安装前请准备 DSH `0.1.5` 或更高版本，以及 Node.js `24.9+` 和 `npm`。如果要接入 QQ，需要运行支持 OneBot 11 HTTP 与正向 WebSocket 的客户端，例如 NapCat 或 Snowluma。渲染图片卡片还需要在本机安装 Chrome 或 Chromium。

1. 打开 DSH 插件市场，搜索并安装 `@dsh-plugin/dsh-loader@next` 和 `@dsh-plugin/dsh-synapse@next`。
2. 打开插件设置页面，在配置卡片中按需填写各项设置。如果需要生成图片卡片，请填入本机 Chrome 或 Chromium 的可执行文件路径。
3. 在配置卡片中选择默认聊天模型和默认审查模型，支持选择提供商、模型与推理等级。留空时使用 DSH 默认模型，再按下文接入需要的通道。

## QQ 与 Discord 接入

1. 在“OneBot · NapCat / Snowluma”中填入 HTTP 和正向 WebSocket 地址及访问令牌。
2. 在“QQ / Discord 消息行为”中添加启用的群号和对话管理员。要使用群命令，在“命令入口”中也添加群号；欢迎语在“新人欢迎”中设置。机器人默认关闭，配置好后打开“启用机器人”。
3. 如需连通 Discord，在“Discord 跨平台桥接”中填入 Bot Token、服务器 ID、频道名称、对应的 QQ 群号和转发条件。
4. 在 Discord 开发者后台为机器人开启 `Message Content Intent`；如果需要使用 `/send` 等斜杠命令，邀请机器人时请勾选 `applications.commands` 权限。

## 日常使用与权限

每个 QQ 群和它桥接的 Discord 频道共用同一个长期对话，群友各自的发言身份会保留；QQ 私聊按用户分开，GitHub 审查按仓库分开。同一个对话里的消息会按收到的先后顺序依次处理，前一条回复完再处理下一条。

聊天会话使用 `<profile>/workspace/chat/`，GitHub 审查会话使用 `<profile>/workspace/review/`，目录会自动创建。支持工作区注册表的宿主还会登记工作区及其会话，使其显示在 DSH 工作区列表。恢复已有会话时会更新其当前工作目录并保留历史和权限；宿主要求原始目录匹配工作区，或缺少目录切换能力时，会为目录不符的旧会话创建新绑定，旧会话记录保留。

原生会话已被归档、被其他写入句柄占用，或历史丢失、损坏等原因导致无法恢复时，插件会自动新建会话并更新当前通道的绑定。每条消息处理前都会检查归档状态，已驻留的会话也会替换；旧会话的归档状态、历史和长期记忆保留，新会话从当前消息开始，后续消息及重载继续使用新会话。执行期间归档会话时不会自动重放该任务，避免重复执行工具；下一条消息会新建会话。

DSH 会话列表显示群名、私聊昵称和号码，审查会话显示仓库与 Issue/PR 编号，例如 `【群聊】铁砧工艺交流反馈☕（659356928）`、`【私聊】古镇天Gugle（2308465862）`、`【PR 审查】Anvil-Dev/AnvilLib#114`。

发送 `停止` 或 `stop` 可以中断当前回复，下一条排队消息会继续处理。发送 `清除上下文`、`新对话` 或 `reset` 会取消当前和排队中的任务，开始新对话，已保存的长期记忆会保留。使用 `/help` 查看可用命令；重载、重启和关闭等管理命令需要相应管理员权限。

DSH 启用会话持久化时，重载后可以继续原来的对话；重载前尚未完成的聊天消息需要重新发送。

你可以在“任务运行限制 → 全部 Synapse 新会话的权限”里调整对话权限：

- **仅查看**（默认）
- **工作区修改**
- **完全权限**
- **自动审查**：由 DSH 在工具执行前判断是否允许操作，需在当前 profile 安装并启用 `@deepseek-ai/dsh-experimental-auto-review`。

修改只影响之后新建或 reset 后的对话，已有和重载恢复的对话保留原权限。可调用的 MCP 工具仍由下文的允许列表决定。

## 人设、记忆与 Skill

主目录读取 `DSH_HOME` 环境变量，当前 profile 从宿主运行上下文定位。未设置 `DSH_HOME` 时，主目录使用 profile 的上两级目录。

`<dsh_home>/SOUL.md` 设置默认聊天人设，`<dsh_home>/AGENTS.md` 设置 GitHub 审查规则。在 `<dsh_home>/profiles/<profile>/` 下放入同名文件，就会优先使用当前 profile 的版本。修改后在下一次请求中生效，无需重启。

聊天记忆和审查记忆分开保存。同一个 profile 下的 QQ 和 Discord 共享聊天记忆；需要隔离记忆的群组应使用不同 profile。在“RAG / Skill 自总结”中点击“导入 Hermes 记忆”，在弹窗粘贴 Markdown 并选择分类，右上角可切换 Markdown 预览，底部点击“确认导入”。导入期间可显式取消请求，草稿会保留；导入结果显示新增与重复条数。已保存的记忆可在“记忆检索”中查询。

主模型主动判断哪些事实与已验证步骤值得保留，通过 `synapse_memory_summarize` 或 `synapse_skill_summarize` 委派原生 sub-agent，并等待结果后继续回复。子代理关联当前父会话，分别只获得当前通道的记忆或 Skill 检索、去重和写入工具；主模型可直接检索和读取。普通闲聊无需创建总结任务。

在“RAG / Skill 自总结”中，分别点击“编辑记忆提示词”和“编辑 Skill 提示词”打开弹窗，保存后对下一次请求生效。两段提示词分别跟随“总结重要事项到长期记忆”和“自动总结 Skill”开关，用于主模型的委派判断及对应子代理的总结规则；关闭本地混合记忆时也会停用记忆提示词与记忆工具。留空可停止注入对应提示词。需要启用宿主原生 sub-agent 服务及 `spawn` 提供方；服务不可用时总结工具会返回明确错误。

聊天模型可直接调用 Issue/PR、B 站视频、Minecraft 版本与服务器、中文 Minecraft 维基和 Modrinth 版本查询工具，将结果与链接组织进同一次回复。Issue 查询沿用仓库允许列表、GitHub 账号绑定和群功能开关；查询公开资料时不使用审查 Token。管理员还可通过原生工具禁言、解除禁言、踢出成员和设置全员禁言，操作范围限定为当前群。

启用自动总结后，主模型可委派 Skill 子代理把已验证的经验整理为 Skill，供以后处理相似问题时参考。Skill 记录可复用的操作步骤，不直接作为脚本执行。“Skill 管理”以表格列出名称和来源，点击“编辑”先打开 Markdown 预览，再通过右上角“编辑”进入编辑模式，完成后点击右上角“保存”返回预览。也可新增 Skill，或在弹窗确认后删除当前 profile 条目；保存从主目录继承的条目会创建当前 profile 覆盖，主目录原文件保留。

## MCP

“MCP 管理”以表格显示服务名称、传输方式和启用状态。点击“新增 MCP”或行内“编辑”打开弹窗，选择 `stdio`、`Streamable HTTP` 或 `SSE`，填写启动参数或 URL、环境变量和请求头。点击“测试并获取工具”会测试当前草稿，工具与参数 Schema 显示在弹窗底部；测试不会先保存配置。右上角“保存”后生效，服务启动失败时也可通过此面板修复配置。`stdio` 服务以当前系统用户的权限运行。

在“允许自动调用的工具”中填写工具名称，或在测试结果表格中勾选。聊天会话只能调用该列表中的工具；留空时不调用任何 MCP 工具。GitHub 审查不使用 MCP。

## GitHub 审查

在 GitHub 仓库或组织中添加 Webhook。Payload URL 填写 `https://<你的DSH域名>/hooks/dsh-synapse/github`，Content type 选择 `application/json`，设置 Secret，并选择 `Pull requests`、`Issues` 和 `Releases` 事件。

在插件的“GitHub Webhook”中填写相同的 Secret、具备仓库读取权限的 GitHub Token，以及允许的仓库（如 `owner/repo` 或 `owner/*`），打开“启用 Webhook 审查”。

PR 审查意见和 Issue 分诊结果默认保存在本地。“GitHub 审查任务”使用可滚动表格显示目标、类型、状态和更新时间，可查看结果或重试失败任务。要把结果发回 GitHub，为 Token 添加 `Issues` 和 `Pull requests` 写权限，并打开“自动发布审查评论”。发布内容是评论，不会自动 approve 或 merge PR。

## 常见问题

**为什么开启机器人后群里说话没反应？**

检查“启用机器人”、OneBot 连接和“QQ / Discord 消息行为”中的群号。群聊默认需要 @机器人，也可设置触发关键词；群命令还需在“命令入口”启用。Discord 则检查频道映射和 `Message Content Intent`。

**第一次打开记忆功能时为什么会卡住或报错？**

首次使用需要下载本地模型，耗时取决于网络。连接失败时会自动通过 `hf-mirror.com` 重试。需要代理时，在启动 DSH 前设置 `HTTPS_PROXY`；Node.js 24 可配合 `NODE_USE_ENV_PROXY=1`。

**Windows 发送图片时出现 `sharp` 的 `ERR_DLOPEN_FAILED` 怎么办？**

RAG 推理与 DSH 图片附件可能使用不同版本的 `sharp`，插件通过独立推理进程隔离原生 DLL。更新插件后需完全退出并重新启动 DSH，以清除已加载的旧 DLL。暂时无法更新时，可先关闭“启用本地混合记忆”，再完全重启 DSH。

**为什么改了会话权限，当前群聊里还是老样子？**

新会话权限不修改已有对话。发送 `reset` 或 `清除上下文` 开始新对话后生效。

**在聊天里用命令改了设置，为什么网页表单里没变？**

点击“运行状态与配置同步”中的“同步聊天命令修改的功能设置”，将改动读回表单。同步会保存配置并重连通道。

## 反馈与许可证

问题和建议可提交到 [Issues](https://github.com/dsh-plugins/dsh-synapse/issues)，源码见 [GitHub 仓库](https://github.com/dsh-plugins/dsh-synapse)。

本项目基于 [Gu-ZT/gugle-chat-bot](https://github.com/Gu-ZT/gugle-chat-bot) 开发，以 `AGPL-3.0-only` 许可证发布。上游开源许可、作者致谢与修改说明请参阅 [`NOTICE.md`](NOTICE.md)。
