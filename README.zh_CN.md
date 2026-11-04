<div align="center">

# @dsh-plugin/dsh-synapse

**在 QQ 和 Discord 里使用 DSH，并为 GitHub 仓库添加自动审查。**

[English](README.md) | 简体中文

</div>

## 功能概览

- **QQ 与 Discord 聊天**：支持在 QQ 群聊、私聊与 Discord 频道中对话，支持读图、回复引用、表情回应、进度卡片、工具审批，以及 QQ 群与 Discord 频道双向桥接。
- **群务与资讯订阅**：处理入群申请、黑名单、欢迎语和戳一戳，内置 GitHub 与 B 站订阅、Minecraft 与 Modrinth 查询、版本跟踪、括号匹配和峰谷定时提醒。
- **群聊背景与主动回复**：自动保留近期群聊消息作为上下文，支持按群配置词云加权的概率回复与空闲暖场消息。
- **长期记忆与 Skill**：记录对话和审查中的重要事实与偏好，将验证过的操作流程整理为可复用的 Skill。
- **GitHub 自动审查**：为 Pull Request 生成审查意见，为 Issue 提供分诊建议，并向群内推送仓库动态与 Release 通知。

## 安装与准备

需要 DSH `0.1.5+`、Node.js `24.9+` 和 `npm`。接入 QQ 需运行支持 OneBot 11 HTTP 与正向 WebSocket 的客户端（如 NapCat 或 Snowluma）；渲染图片卡片需在本机安装 Chrome 或 Chromium。

1. 打开 DSH 插件市场，搜索并安装 `@dsh-plugin/dsh-loader@next` 和 `@dsh-plugin/dsh-synapse@next`。
2. 打开插件设置页，按需填写各配置分组。如需生成图片卡片，请填入本机 Chrome 或 Chromium 的可执行文件路径。
3. 在插件卡片中选择默认聊天模型与默认审查模型（留空则使用 DSH 默认模型），再按下方步骤接入对应通道。

## QQ 与 Discord 接入

1. 在 **OneBot · NapCat / Snowluma** 中填入 HTTP 地址、正向 WebSocket 地址和访问令牌。
2. 在 **聊天与通知功能 → QQ / Discord 消息行为** 中添加启用的 QQ 群号和对话管理员；如需使用群命令，在 **命令入口** 中添加群号；在 **新人欢迎** 中设置欢迎语。配置完成后开启 **启用机器人**。
3. 如需连通 Discord，在 **Discord 跨平台桥接** 中填入 Bot Token、服务器 ID、频道名称、关联的 QQ 群号和转发条件。
4. 在 Discord 开发者后台开启机器人的 `Message Content Intent`；若需使用 `/send` 等斜杠命令，邀请机器人时请勾选 `applications.commands` 权限。

## 日常使用与权限

- **会话隔离**：每个 QQ 群及其桥接的 Discord 频道共用同一个持续对话并保留发言人身份；QQ 私聊按用户独立，GitHub 审查按仓库独立。
- **常用命令**：
  - 发送 `停止` 或 `stop`：中断当前回复，继续处理队列中的下一条消息。
  - 发送 `清除上下文`、`新对话` 或 `reset`：清空当前对话上下文并开启新会话（长期记忆会保留）。
  - 发送 `/help`：查看机器人支持的聊天命令。
- **长消息合并**：QQ 消息以至少 2 秒间隔轮流发送。同一会话连续发出的消息若超过合并转发字符阈值（默认 300）、行数阈值（默认 5）或单条最大字符数，会自动打包为合并转发聊天记录（阈值设为 `0` 可关闭）。
- **运行限制与权限**：在 **任务运行限制** 中可调整单次超时与最大步骤数（设为 `-1` 表示不限制），并设置新建会话的权限：
  - **仅查看**（默认）
  - **工作区修改**
  - **完全权限**
  - **自动审查**（需在当前 profile 安装并启用 `@deepseek-ai/dsh-experimental-auto-review`）

  修改会话权限对之后新建或重置的对话生效。

## 群聊上下文与主动回复

已启用聊天的 QQ 群会自动保留最近 100 条未触发消息（含缓存图片）作为下次回复的背景参考。

在 **群聊上下文与主动回复** 中点击 **编辑群聊策略**，可配置全局默认参数与分群规则：

- **概率回复**：开启后，除 `@` 和关键词外的普通群消息也有几率触发回复（默认基础概率 3%、上限 10%，并根据群内近期高频词动态加成）。
- **空闲消息**：群内持续无人发言达到随机窗口（默认 15–45 分钟，`Asia/Shanghai` `00:00–09:00` 静默）时，按概率（默认 25%）主动发起话题；发送前若有人发言则自动取消。
- **管理命令**：管理员可在群内使用 `/synapse probability`、`/synapse idle`、`/synapse blockword` 和 `/synapse logs`（例如 `/synapse probability on` 或 `/synapse probability set base 3.25`）。附加 `global` 参数可修改全局配置（仅限 operators）。

概率回复与空闲消息默认关闭，需同时开启全局开关与对应群开关才会生效。

## 人设、记忆、Skill 与工具

- **人设与补充规则**：在 `<profile>/` 或 `$DSH_HOME/` 下放置 `SOUL.md` 可自定义聊天人设，放置 `AGENTS.md` 可自定义审查规则（`<profile>/` 优先），保存后对下一次请求生效。
- **记忆与 Skill**：聊天与审查记忆相互独立。可在 **Hermes 记忆导入** 中粘贴 Markdown 批量导入，在 **记忆检索** 中搜索已有记忆，或在 **Skill 管理** 中预览、新增和编辑 Skill。
- **嵌入与重排模型**：在 **RAG / Skill 自总结** 中分别选择本地或在线运行。在线模式填写服务 Base URL、API Key 与模型名称；SiliconFlow 地址为 `https://api.siliconflow.cn/v1`。重排需同时开启 **启用重排**。嵌入输出维度默认 `0`，由模型决定；模型切换后会重建向量索引并保留记忆正文。在线服务会接收记忆文本和检索词，并可能产生调用费用。
- **内置工具与 MCP**：聊天模型可直接查询 GitHub Issue/PR、B 站视频、Minecraft 版本与服务器状态、中文 Minecraft 维基、Modrinth 模组版本及当前会话的 QQ 聊天记录，也可在核对发言者权限后调用 OneBot API 或执行群管理操作。在 **MCP 管理** 中可配置并测试 `stdio`、`Streamable HTTP` 或 `SSE` 服务，勾选允许聊天模型自动调用的工具。

## GitHub 审查接入

1. 在 GitHub 仓库或组织设置中添加 Webhook：
   - **Payload URL**：`https://<你的DSH域名>/hooks/dsh-synapse/github`
   - **Content type**：`application/json`
   - **Secret**：自定义密钥
   - **事件**：勾选 `Pull requests`、`Issues` 和 `Releases`
2. 在插件设置的 **GitHub Webhook** 中填入相同的 Secret、具备仓库读取权限的 GitHub Token 以及允许的仓库（如 `owner/repo` 或 `owner/*`），开启 **启用 Webhook 审查**。
3. 在 **GitHub 审查任务** 表格中可查看结果或重试失败任务。如需将评论自动发回 GitHub，请为 Token 授予 `Issues` 与 `Pull requests` 写权限，并开启 **自动发布审查评论**。

## 常见问题

**为什么开启机器人后群里说话没反应？**

请检查是否已开启 **启用机器人**、OneBot 连接地址与令牌是否正确，以及 **QQ / Discord 消息行为** 中是否已添加该群号。群聊默认需要 `@` 机器人或命中触发关键词才会回复；群命令还需在 **命令入口** 中添加群号。Discord 请检查频道映射与 `Message Content Intent`。

**第一次打开记忆功能时为什么会卡住或报错？**

首次使用本地嵌入或重排时需要下载对应模型，直连失败时会自动通过 `hf-mirror.com` 重试。如需配置代理，请在启动 DSH 前设置 `HTTPS_PROXY` 环境变量（Node.js 24 可配合 `NODE_USE_ENV_PROXY=1`）。也可在 **RAG / Skill 自总结** 中选择在线模型并填写服务配置。

**Windows 发送图片时出现 `sharp` 的 `ERR_DLOPEN_FAILED` 怎么办？**

更新插件后请完全退出并重新启动 DSH，以清理旧进程中已加载的原生动态库。

**为什么改了会话权限，当前群聊里还是老样子？**

新会话权限仅在创建会话时写入。在群里发送 `reset` 或 `清除上下文` 开启新对话后即可生效。

**在聊天里用命令改了设置，为什么网页表单里没变？**

在 **运行状态与配置同步** 中点击 **同步聊天命令修改的功能设置**，即可将聊天命令修改的配置读回网页表单并保存。

## 技术文档与许可证

- 内部实现说明：[架构与会话机制](docs/architecture.md) · [群聊背景窗口与主动回复机制](docs/group-activity.md)
- 问题反馈与源码：[GitHub Issues](https://github.com/dsh-plugins/dsh-synapse/issues) · [GitHub 仓库](https://github.com/dsh-plugins/dsh-synapse)

本项目基于 [Gu-ZT/gugle-chat-bot](https://github.com/Gu-ZT/gugle-chat-bot) 开发，以 `AGPL-3.0-only` 许可证发布。上游开源许可、作者致谢与修改说明请参阅 [`NOTICE.md`](NOTICE.md)。
