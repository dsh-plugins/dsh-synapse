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
2. 打开插件设置页。首屏只有 **启用机器人**、**聊天模型** 和 **审查模型**，其余设置按用途收在可展开的分组里，每项下方都有说明。
3. 选择聊天模型与审查模型（留空则使用 DSH 默认模型），再按下方步骤接入对应通道。

从旧版本升级时，插件会在首次启动时把原有设置搬到新的分组里，原配置备份为 `<profile>/data/dsh-synapse/config-before-restructure.json`。

## QQ 与 Discord 接入

1. 在 **QQ 连接（OneBot）** 中填入 HTTP 地址、正向 WebSocket 地址和两个访问令牌。如需生成图片卡片，填入本机 Chrome 或 Chromium 可执行文件的完整路径。
2. 点击 **聊天与通知功能** 的编辑按钮，在 **对话行为** 中添加启用对话的 QQ 群和对话管理员；如需使用 `/help` 等群命令，在 **按群启用的功能 → 聊天命令** 中添加群号；在 **新人欢迎** 中设置欢迎语。配置完成后开启 **启用机器人**。
3. 如需连通 Discord，在 **Discord 跨平台桥接** 中填入 Bot Token、服务器 ID、频道名称、关联的 QQ 群号和转发条件。
4. 在 Discord 开发者后台开启机器人的 `Message Content Intent`；若需使用 `/send` 等斜杠命令，邀请机器人时请勾选 `applications.commands` 权限。

## 日常使用与权限

- **会话隔离**：每个 QQ 群及其桥接的 Discord 频道共用同一个持续对话并保留发言人身份；QQ 私聊按用户独立，GitHub 审查按仓库独立。
- **常用命令**：
  - 发送 `停止` 或 `stop`：中断当前回复，继续处理队列中的下一条消息。
  - 发送 `清除上下文`、`新对话` 或 `reset`：清空当前对话上下文并开启新会话（长期记忆会保留）。
  - 发送 `/help`：查看机器人支持的聊天命令。
- **长消息合并**：QQ 消息以至少 2 秒间隔轮流发送。同一会话连续发出的消息若超过合并转发字符阈值（默认 300）、行数阈值（默认 5）或单条最大字符数，会自动打包为合并转发聊天记录（阈值设为 `0` 可关闭）。
- **运行限制与权限**：在 **任务限制与权限** 中可调整单轮超时与单轮最多步骤数（设为 `-1` 表示不限制），并设置新建会话的权限：
  - **仅查看**（默认）
  - **工作区修改**
  - **完全权限**
  - **自动审查**（需在当前 profile 安装并启用 `@deepseek-ai/dsh-experimental-auto-review`）

  修改会话权限对之后新建或重置的对话生效。

## 群聊上下文与主动回复

已启用聊天的 QQ 群会自动保留最近 100 条未触发消息（含缓存图片）作为下次回复的背景参考。

在 **群聊上下文与主动回复** 中点击 **编辑群聊策略**，可配置全局默认参数与分群规则：

- **概率回复**：开启后，除 `@` 和关键词外的普通群消息也有几率触发回复（默认基础概率 3%、上限 10%，消息含群内近期热词时提高概率）。
- **空闲消息**：群内持续无人发言达到随机窗口（默认 15–45 分钟，`Asia/Shanghai` `00:00–09:00` 静默）时，按概率（默认 25%）主动发起话题；发送前若有人发言则自动取消。
- **管理命令**：管理员可在群内使用 `/synapse probability`、`/synapse idle`、`/synapse blockword` 和 `/synapse logs`（例如 `/synapse probability on` 或 `/synapse probability set base 3.25`）。附加 `global` 参数可修改全局配置（仅限 operators）。

概率回复与空闲消息默认关闭，需同时开启全局开关与对应群开关才会生效。

## 语音回复

在 **语音合成（BreezeBlue）** 中点击 **点击获取 API KEY** 打开密钥获取页面，填写 API Key，开启 **允许 Bot 主动发送语音** 后保存。默认音色 ID（`voice_id`）为 `voc_u3nxkd5578wc`，可改为音色库中的其他音色；接口说明见 [BreezeBlue 文档](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech)。

- 模型可以根据对话内容主动选择语音，也可以响应「用语音回复我」这样的请求。QQ 群和私聊收到语音消息，Discord 当前频道收到 MP3 音频附件。
- 默认使用 `breeze-tts-2` 和中文 `zh`，可调整语音模型、语言及默认朗读风格。模型可为单次朗读指定语气与情绪，发送目标固定为当前会话。
- 单条语音默认最多 1000 字符，合成超时默认 60 秒；超过 1000 字符需要服务为账户批准更高额度。合成文本会发送给 BreezeBlue，并按服务规则计费。
- 语音发送沿用 QQ 会话队列及全局间隔。发送成功后可以不附文字；发送失败时模型可以继续用文字回复。停止任务会取消尚未发送的语音，已送出的消息不撤回。

## 文件交付

模型在 QQ 群、QQ 私聊或 Discord 频道中成功调用 `present` 后，Synapse 会在本轮结束时把文件发回发起会话。QQ 将图片和视频作为聊天消息发送，普通文件使用群文件或私聊文件上传。Discord 在原频道显示受支持的聊天媒体，例如 PNG、JPEG、GIF、MP4。每个文件独立发送，格式不支持、平台拒绝接收或文件无法读取时会在原会话提示失败数量。

Synapse 单个文件的上限为 QQ 64 MiB、Discord 20 MB，平台或 OneBot 实现可能有更低的上限。

## 人设、记忆、Skill 与工具

- **人设与补充规则**：默认使用内置的「大肥鱼」聊天人设与 PR 审查规则。在 `<profile>/` 或 `$DSH_HOME/` 下放置 `SOUL.md` 可自定义聊天人设，放置 `AGENTS.md` 可自定义审查规则（`<profile>/` 优先），保存后对下一次请求生效。自定义文件会覆盖对应内置规则；空文件表示关闭该段规则。
- **记忆与 Skill**：聊天与审查记忆相互独立。可在 **长期记忆与 Skill → 从 Hermes 导入记忆** 中粘贴 Markdown 批量导入，在 **记忆检索** 中搜索已有记忆，或在 **Skill 管理** 中预览、新增和编辑 Skill。
- **嵌入与重排模型**：在 **长期记忆与 Skill** 中分别选择本机运行或在线服务。在线模式填写服务地址、API Key 与模型名称；SiliconFlow 地址为 `https://api.siliconflow.cn/v1`。开启 **检索后重新排序** 后才会显示并使用重排模型。嵌入输出维度默认 `0`，由模型决定；模型切换后会重建向量索引并保留记忆正文。在线服务会接收记忆文本和检索词，并可能产生调用费用。
- **内置工具与 MCP**：聊天模型可直接查询 GitHub Issue/PR、B 站视频、Minecraft 版本与服务器状态、中文 Minecraft 维基、Modrinth 模组版本及当前会话的 QQ 聊天记录，也可在核对发言者权限后调用 OneBot API 或执行群管理操作。在 **MCP 管理** 中可配置并测试 `stdio`、`Streamable HTTP` 或 `SSE` 服务，勾选允许聊天模型自动调用的工具。

## GitHub Webhook 接入

1. 在 GitHub 仓库或组织设置中添加 Webhook：
   - **Payload URL**：`https://<你的DSH域名>/hooks/dsh-synapse/github`
   - **Content type**：`application/json`
   - **Secret**：审查和分诊需要自定义密钥。仅发送卡片时可以留空。
   - **事件**：勾选 `Pull requests`、`Issues` 和 `Releases`
2. 在插件设置的 **GitHub Webhook → 管理仓库连接** 添加 `owner/repo` 或 `owner/*`。每行可以分别勾选 **PR 审查**、**Issue 分诊** 和 **生成与发送卡片**，默认只勾选卡片。单个仓库的配置优先于组织规则。
3. 开启 **启用 GitHub Webhook**。仅发送卡片时，可开启 **允许无密钥 Webhook 发送卡片**，并在 **聊天与通知功能 → GitHub 仓库通知** 为仓库配置订阅的 QQ 群。无密钥卡片以纯文本渲染正文和外部资源引用。
4. 启用审查或分诊时，填入与 GitHub 一致的 Webhook Secret 和具备对应仓库读取权限的 GitHub Token。Issue 分诊可以从仓库已有标签中挑选并追加标签，追加需要 `Issues` 写权限。在 **GitHub 审查任务** 可查看结果或重试失败任务。需要自动发回评论时，开启 **把审查结果发布为评论** 并授予对应的 `Issues` 或 `Pull requests` 写权限。

## 常见问题

**为什么开启机器人后群里说话没反应？**

请检查是否已开启 **启用机器人**、**QQ 连接（OneBot）** 中的地址与令牌是否正确，以及 **对话行为** 中是否已添加该群号。群聊默认需要 `@` 机器人或命中触发关键词才会回复；群命令还需在 **按群启用的功能 → 聊天命令** 中添加群号。Discord 请检查频道映射与 `Message Content Intent`。

**第一次打开记忆功能时为什么会卡住或报错？**

首次使用本地嵌入或重排时需要下载对应模型，直连失败时会自动通过 `hf-mirror.com` 重试。如需配置代理，请在启动 DSH 前设置 `HTTPS_PROXY` 环境变量（Node.js 24 可配合 `NODE_USE_ENV_PROXY=1`）。也可在 **长期记忆与 Skill** 中选择在线服务并填写服务配置。

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
