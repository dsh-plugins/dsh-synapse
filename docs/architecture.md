# 架构与会话机制

本文档说明 `@dsh-plugin/dsh-synapse` 在 DSH 宿主内的会话生命周期、目录结构、规则注入、原生工具与子代理实现。

## 目录与工作区

插件主目录读取 `DSH_HOME` 环境变量，未设置时取当前 profile 目录的上两级目录；当前 profile 路径从宿主运行上下文定位。

- **聊天工作区**：`<profile>/workspace/chat/`
- **审查工作区**：`<profile>/workspace/review/`
- **插件数据目录**：`<profile>/data/dsh-synapse/`
- **Skill 目录**：`<dsh_home>/skills/`（全局继承）与 `<profile>/skills/`（当前 profile 覆盖）

启动会话时会自动创建对应工作区目录。若宿主提供工作区注册表（如 DSH `0.2.2+`），插件会将工作区及会话登记到宿主的可见工作区列表。

## 原生会话绑定与恢复

- **会话划分**：每个 QQ 群及其桥接的 Discord 频道共享同一个原生会话（`chat:group:<groupId>`），消息内保留发言者身份；QQ 私聊按用户独立绑定（`chat:user:<userId>`）；GitHub 审查按仓库独立绑定（`review:github:<owner>/<repo>`）。
- **串行队列**：同一会话内的任务按先进先出顺序串行执行，不同会话并发运行。取消排队中的任务不会中断正在执行的前序任务。
- **会话标题**：群聊与私聊使用群名或昵称及号码命名（如 `【群聊】铁砧工艺交流反馈☕（659356928）`、`【私聊】古镇天Gugle（2308465862）`），审查会话使用仓库与编号命名（如 `【PR 审查】Anvil-Dev/AnvilLib#114`）。
- **标准预设与权限**：新建会话默认挂载宿主 `standard` 预设，继承标准系统提示词、工具、AGENTS.md 加载与上下文管理能力。新建会话在首轮执行前写入配置的权限预设（`read-only`、`workspace-write`、`danger-full-access` 或 `auto`），恢复已有会话时保留其原有历史与权限。
- **自动替换与恢复**：每次处理消息前均会检查会话状态。当原绑定会话被归档、被其他写入句柄占用、历史文件丢失或损坏，或因宿主升级需要切换工作区目录与预设时，插件会自动生成新绑定并保留旧会话历史。若会话在单轮执行期间被归档，当前轮次直接终止而不重放工具调用，下一条消息自动使用新会话。

## 补充规则注入

- 聊天通道读取 `<profile>/SOUL.md`（不存在时回退至 `<dsh_home>/SOUL.md`）。
- 审查通道读取 `<profile>/AGENTS.md`（不存在时回退至 `<dsh_home>/AGENTS.md`）。

补充规则通过宿主原生的 `renderAgentInstructions` 渲染为带来源路径的用户角色上下文消息，与 `standard` 预设的系统提示词并存。插件按内容去重，仅在文件新增、修改或删除后的下一次请求中追加更新，重启恢复会话时也会识别已注入的内容。

## 本地混合记忆与子代理总结

- **独立推理进程**：向量嵌入（`Xenova/bge-small-zh-v1.5`）与重排（`Xenova/bge-reranker-base`）运行在通过 `child_process.fork` 启动的独立进程中，避免在 Windows 下与宿主的图片处理组件产生 `sharp` 原生动态库冲突。模型下载直连 Hugging Face 失败时自动回退至 `hf-mirror.com`。
- **混合检索**：记忆存储在 `<profile>/data/dsh-synapse/memory.sqlite`，结合 `sqlite-vec` 向量检索与 `FTS5` 分词检索（RRF 融合），可选经过本地重排模型排序。聊天（`chat`）与审查（`review`）通道的记忆严格隔离。
- **原生子代理委派**：主模型不直接暴露记忆或 Skill 写入工具，而是通过 `synapse_memory_summarize` 与 `synapse_skill_summarize` 调用宿主 `subagents` 服务（`spawn` 提供方）启动子会话。子会话绑定父会话 ID 并继承当前通道的模型路由，仅挂载对应通道的检索、读取与保存工具（`synapse_memory_*` 或 `synapse_skill_*`）。

## 聊天原生工具与 OneBot 接口

- **公开资料查询**：聊天回合挂载 `synapse_github_issue`、`synapse_bilibili_video`、`synapse_minecraft_version`、`synapse_minecraft_server`、`synapse_minecraft_wiki` 与 `synapse_modrinth_version`。GitHub Issue/PR 查询走公开代理并校验允许列表、账号绑定与群开关，不携带审查 Token。
- **群管理与 OneBot 调用**：
  - 群聊挂载 `synapse_get_group_msg_history`，私聊挂载 `synapse_get_friend_msg_history`，目标群号或好友账号由宿主根据当前路由固定，单次可查 1–100 条，支持 NapCat（`message_seq` / `reverseOrder`）与 SnowLuma（`message_id` / `reverse_order`）分页参数。
  - `synapse_onebot_api` 接收相对 `path` 与 JSON `params`，由宿主拼接 OneBot HTTP 地址与 Token 并以 POST 发送（15 秒超时，响应上限 2 MB）。工具说明中注入可信发言者身份与管理员状态，原始 JSON 回执通过自定义 `render` 完整返回给模型。
  - 当发言者具备管理员权限时，群聊额外挂载 `synapse_group_mute`、`synapse_group_kick` 与 `synapse_group_whole_ban`，执行前再次核对实时管理员配置。

## QQ 发送队列与 GitHub 审查队列

- **QQ 发送调度（`QQSendQueue`）**：群聊、私聊与通用操作按各自队列管理，由全局调度器按至少 2 秒间隔轮流发送。某会话等待 OneBot 回执期间，其他会话可继续发送。同一会话待发送的兼容消息会先合并，合并后若超过字符阈值（默认 300）、行数阈值（默认 5）或单条最大长度（默认 1200），自动打包为合并转发聊天记录。含不同引用、桥接来源、Webhook 通知、语音或需单独撤回的私聊回执则保持独立发送。
- **GitHub Webhook 队列（`Reviews`）**：Webhook 投递记录保存在 SQLite `deliveries` 表，按 `X-Hub-Signature-256` 验签并按 `X-GitHub-Delivery` 去重。最多 4 个仓库并发执行，同一仓库内部按 FIFO 顺序处理。PR 审查会核对提交前后的 `head.sha`，若分支已更新则跳过旧提交评论，并通过隐藏 HTML 标记避免重复发布。
