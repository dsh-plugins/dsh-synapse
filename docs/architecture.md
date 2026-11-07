# 架构与会话机制

本文档说明 `@dsh-plugin/dsh-synapse` 在 DSH 宿主内的会话生命周期、目录结构、规则注入、原生工具与子代理实现。

## 目录与工作区

插件主目录读取 `DSH_HOME` 环境变量，未设置时取当前 profile 目录的上两级目录；当前 profile 路径从宿主运行上下文定位。

- **聊天工作区**：`<profile>/workspace/chat/`
- **审查工作区**：`<profile>/workspace/review/`
- **插件数据目录**：`<profile>/data/dsh-synapse/`
- **Skill 目录**：`<dsh_home>/skills/`（全局继承）与 `<profile>/skills/`（当前 profile 覆盖）

启动会话时会自动创建对应工作区目录。若宿主提供工作区注册表（如 DSH `0.2.2+`），插件会将工作区及会话登记到宿主的可见工作区列表。

## 配置结构与迁移

插件配置保存在 `<profile>/config/dsh-synapse/config.json`，按用途分为以下顶层字段：

| 字段 | 内容 |
| --- | --- |
| `enabled`、`chatModel`、`reviewModel` | 机器人总开关与两个通道的模型 |
| `connection` | OneBot HTTP / WebSocket 地址、两个访问令牌、Chrome 路径、User-Agent、令牌参数前缀与日志级别 |
| `limits` | 新会话权限预设、单轮超时与单轮步骤上限 |
| `github` | Webhook 审查开关、Secret、Token、允许的仓库列表、评论发布与差异长度上限 |
| `memory` | 长期记忆开关、检索条数、记忆库容量、嵌入与重排模型、记忆与 Skill 总结规则 |
| `speech` | BreezeBlue 语音开关、服务地址、API Key、音色、模型、语言、风格、字符上限及合成超时 |
| `modules` | 机器人功能：`chat`（对话行为）、`presentation`（进度、审批与表情回应）、`groupFeatures`（按群启用的五个功能）、`management`、`bili`、`github`、`welcome`、`discord`、`peakValley` |
| `activity`、`mcpServers` | 群聊主动回复策略与 MCP 服务，由自定义面板编辑 |

`feature-config.ts` 中的 `featureFiles` 把 `modules` 翻译为 gugle-chat-bot 读取的功能文件：`chat` 与 `presentation` 按上游字段顺序合并为 `hermes.json`，`groupFeatures` 拆回 `parentheses.json` 等五个文件，峰谷提醒写回 `peak_msg` 等上游键名。`modulesFromFiles` 执行反向翻译，用于「同步聊天命令修改的功能设置」。

`config-migration.ts` 在注册配置前直接读取 `config.json`。检测到平铺布局的旧字段（如 `httpUrl`、`ragEnabled`、`modules.command`）时，逐项搬到上述分组，`repositories` 多行文本拆为 `github.allowedRepositories` 数组，原文件备份为 `<profile>/data/dsh-synapse/config-before-restructure.json`，再以原修订号为前提写入新结构。表单化之前的配置（含 `features`、`mcp`、`botJson` 等字符串字段）先完成同样的搬迁，再解析字符串并合并机器人当前功能文件中由聊天命令写入的设置，备份为 `config-before-forms.json`。已是分组结构的配置不会再次迁移。

## 原生会话绑定与恢复

- **会话划分**：每个 QQ 群及其桥接的 Discord 频道共享同一个原生会话（`chat:group:<groupId>`），消息内保留发言者身份；QQ 私聊按用户独立绑定（`chat:user:<userId>`）；GitHub 审查按仓库独立绑定（`review:github:<owner>/<repo>`）。
- **串行队列**：同一会话内的任务按先进先出顺序串行执行，不同会话并发运行。取消排队中的任务不会中断正在执行的前序任务。
- **会话标题**：群聊与私聊使用群名或昵称及号码命名（如 `【群聊】铁砧工艺交流反馈☕（659356928）`、`【私聊】古镇天Gugle（2308465862）`），审查会话使用仓库与编号命名（如 `【PR 审查】Anvil-Dev/AnvilLib#114`）。
- **标准预设与权限**：新建会话默认挂载宿主 `standard` 预设，继承标准系统提示词、工具、AGENTS.md 加载与上下文管理能力。新建会话在首轮执行前写入配置的权限预设（`read-only`、`workspace-write`、`danger-full-access` 或 `auto`），恢复已有会话时保留其原有历史与权限。
- **聊天绑定与恢复**：群聊与私聊的会话 ID 保存在 `<profile>/data/dsh-synapse/sessions/`，插件重载和宿主重启后按原 ID 读取原生历史。暂时被其他写入句柄占用时，本次请求提示重试，句柄释放后的新消息继续使用原 ID。旧聊天会话保留原工作区归属，有效工作目录由支持切换的宿主更新。
- **新会话**：显式重置、归档或宿主确认历史无法恢复时可开启新会话。自动替换在新会话创建成功后更新绑定。运行中归档会停止当前轮次，下一条消息进入新会话。审查通道也会在写入权冲突或需要迁移工作区、预设时自动替换会话。

## 补充规则注入

- 聊天通道读取 `<profile>/SOUL.md`（不存在时回退至 `<dsh_home>/SOUL.md`）。
- 审查通道读取 `<profile>/AGENTS.md`（不存在时回退至 `<dsh_home>/AGENTS.md`）。
- 两处都不存在时，读取插件包 `defaults/` 中的对应模板：聊天使用「大肥鱼」人设，审查使用 PR 操作与评论规则。内置模板不写入用户目录，避免干扰标准预设的 AGENTS.md 扫描；已有自定义文件（包括空文件）优先，读取错误直接返回。

补充规则通过宿主原生的 `renderAgentInstructions` 渲染为带来源路径的用户角色上下文消息，与 `standard` 预设的系统提示词并存。插件按内容去重，仅在文件新增、修改或删除后的下一次请求中追加更新，重启恢复会话时也会识别已注入的内容。

记忆提示词的默认值用于新配置、缺失字段或恢复默认值；已有保存值继续保留。默认规则要求记忆子代理记录相处经历、偏好与约定，并明确标识相关用户，区分群聊或私聊中的不同成员。

## 混合记忆与子代理总结

- **独立推理进程**：向量嵌入（`Xenova/bge-small-zh-v1.5`）与重排（`Xenova/bge-reranker-base`）运行在通过 `child_process.fork` 启动的独立进程中，避免在 Windows 下与宿主的图片处理组件产生 `sharp` 原生动态库冲突。模型下载直连 Hugging Face 失败时自动回退至 `hf-mirror.com`。
- **在线推理**：`memory.embeddingModel` 与 `memory.rerankModel` 分别选择 `local` 或 `online`，默认本地。在线模式配置 Base URL、API Key 与模型名称，默认服务地址为 `https://api.siliconflow.cn/v1`；嵌入默认 `BAAI/bge-m3`，重排默认 `BAAI/bge-reranker-v2-m3`。请求遵循 SiliconFlow 的[嵌入接口](https://api-docs.siliconflow.cn/docs/api/embeddings-post)和[重排接口](https://api-docs.siliconflow.cn/docs/api/rerank-post)，通过 Bearer 鉴权，支持取消与 60 秒超时，响应限制为 2 MB。嵌入使用浮点回执，批量请求按 `index` 恢复顺序；重排按文档 `index` 还原分数。在线路径按原文发送文本，只在选用本地模型时启动本地推理进程。
- **向量索引迁移**：`memory.embeddingModel.dimensions=0` 时采用模型默认维度；服务支持时可指定输出维度（SiliconFlow 的 Qwen3 系列支持此参数）。`sqlite-vec` 支持 1–8192 维向量。索引记录嵌入服务、模型与维度标识；切换模型或维度时按 16 条一批重新计算已有记忆向量，通过宿主日志显示进度，再在单个事务中替换向量表及模型标识。正文、ID、时间、去重和全文索引保留；失败或取消时保留原向量表。嵌入写入与检索串行执行，密钥轮换或单独更换重排模型不会重建向量索引。
- **混合检索**：记忆存储在 `<profile>/data/dsh-synapse/memory.sqlite`，结合 `sqlite-vec` 向量检索与 `FTS5` 分词检索（RRF 融合），可选经过所选重排模型排序。聊天（`chat`）与审查（`review`）通道的记忆严格隔离。在线模式会向所配置的服务发送记忆文本及检索词，密钥通过 loader 的密码字段管理，错误日志只返回状态和本地校验信息。
- **原生子代理委派**：主模型不直接暴露记忆或 Skill 写入工具，而是通过 `synapse_memory_summarize` 与 `synapse_skill_summarize` 调用宿主 `subagents` 服务（`spawn` 提供方）启动子会话。子会话绑定父会话 ID 并继承当前通道的模型路由，仅挂载对应通道的检索、读取与保存工具（`synapse_memory_*` 或 `synapse_skill_*`）。

## 聊天原生工具与 OneBot 接口

- **公开资料查询**：聊天回合挂载 `synapse_github_issue`、`synapse_bilibili_video`、`synapse_minecraft_version`、`synapse_minecraft_server`、`synapse_minecraft_wiki` 与 `synapse_modrinth_version`。GitHub Issue/PR 查询走公开代理并校验允许列表、账号绑定与群开关，不携带审查 Token。
- **群管理与 OneBot 调用**：
  - 群聊挂载 `synapse_get_group_msg_history`，私聊挂载 `synapse_get_friend_msg_history`，目标群号或好友账号由宿主根据当前路由固定，单次可查 1–100 条，支持 NapCat（`message_seq` / `reverseOrder`）与 SnowLuma（`message_id` / `reverse_order`）分页参数。
  - `synapse_onebot_api` 接收相对 `path` 与 JSON `params`，由宿主拼接 OneBot HTTP 地址与 Token 并以 POST 发送（15 秒超时，响应上限 2 MB）。工具说明中注入可信发言者身份与管理员状态，原始 JSON 回执通过自定义 `render` 完整返回给模型。
  - 当发言者具备管理员权限时，群聊额外挂载 `synapse_group_mute`、`synapse_group_kick` 与 `synapse_group_whole_ban`，执行前再次核对实时管理员配置。

## 语音合成与发送

聊天会话在启用 `speech.enabled` 后挂载 `synapse_send_voice`，并注入按需主动使用语音的提示。工具只接受朗读文本与本次风格，发送路由来自网关提供的当前会话；审查和总结子代理不挂载该工具。

`speech.ts` 使用 BreezeBlue 的 `POST /v1/text-to-speech/{voice_id}` 同步接口，以 `xi-api-key` 鉴权，固定请求 MP3。音频完整接收并验证后才交给 Bot；请求支持取消、配置超时和 10 MB 大小上限，错误信息不包含服务回执正文或凭据。音频只在内存中传递，不保存在临时文件中。

宿主通过带唯一 ID 的 IPC 请求向 Bot 子进程发送音频。QQ 使用 `record` 段的 `base64://` 内容，交由现有独立会话队列发送，不与文字合并；NapCat/SnowLuma 负责平台所需的语音转码。Discord 复用已登录客户端的 REST 连接上传 `voice.mp3`，发送前校验缓存频道与 QQ 群的绑定。API Key 始终保留在宿主配置中。

工具只有收到平台消息 ID 才返回 `sent=true`，同时发出 `voice.sent` 事件。原生 Harness 和 Bot 收尾会识别已成功发送的语音，允许模型结束时不附文字。取消信号通过 IPC 传至发送队列和 HTTP 请求；Bot 停止或退出时拒绝所有待确认的语音。未确认的发送可能已经送达，工具提示要求模型先核实，避免重复发送。

## QQ 发送队列与 GitHub 审查队列

- **QQ 发送调度（`QQSendQueue`）**：群聊、私聊与通用操作按各自队列管理，由全局调度器按至少 2 秒间隔轮流发送。某会话等待 OneBot 回执期间，其他会话可继续发送。同一会话待发送的兼容消息会先合并，合并后若超过字符阈值（默认 300）、行数阈值（默认 5）或单条最大长度（默认 1200），自动打包为合并转发聊天记录。含不同引用、桥接来源、Webhook 通知、语音或需单独撤回的私聊回执则保持独立发送。
- **GitHub Webhook 队列（`Reviews`）**：Webhook 投递记录保存在 SQLite `deliveries` 表，按 `X-Hub-Signature-256` 验签并按 `X-GitHub-Delivery` 去重。最多 4 个仓库并发执行，同一仓库内部按 FIFO 顺序处理。PR 审查会核对提交前后的 `head.sha`，若分支已更新则跳过旧提交评论，并通过隐藏 HTML 标记避免重复发布。
