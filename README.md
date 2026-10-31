# @dsh-plugin/dsh-synapse

基于 **dsh-loader 2.0 API** 的 TypeScript 插件：完整保留 gugle-chat-bot 的 QQ、Discord、群管理及通知模块，提供声明式配置、GitHub 自动审查、本地混合记忆与 Skill 自总结。

## 安装与启动

要求 Node.js **24.9+**、npm、dsh-loader 2.0、OneBot 11 HTTP/正向 WebSocket 服务。可接入 NapCat 或提供同等 OneBot API 的 Snowluma。图片卡片功能还需要本机 Chrome/Chromium；在配置卡片填写可执行文件路径。

```sh
git clone https://github.com/dsh-plugins/dsh-synapse.git
cd dsh-synapse
npm ci
npm run build
npm pack
```

在目标 DSH profile 安装 `@dsh-plugin/dsh-loader@next` 和本地生成的 `dsh-plugin-dsh-synapse-0.1.0.tgz`，然后按 DSH 的 bundle 安装流程加载。仓库提供 `cordis.patch.yml`。配置卡片操作区要求 loader **2.0.0-dev.41151102394 或更新的兼容版本**；开发依赖固定到该版本，peer range 为 `^2.0.0-dev.41151102394`。

在 DSH 插件配置中填写 OneBot 地址、访问令牌，并启用机器人。聊天、GitHub 审查和 Skill 自总结直接使用 **DSH 宿主的原生 Agent 和当前默认模型**，模型由 DSH 自身的模型设置管理。Synapse 只注册配置模板，由 dsh-loader 在对应插件页面自动挂载配置卡片，不额外注册导航入口或独立配置页面。自动 profile 定位失败时，在配置卡片中填写 profile 绝对路径即可恢复。

默认不开启机器人或 GitHub 发布操作。RAG 在首次实际使用时安装运行时并下载模型；启用机器人后会预热嵌入模型。无网络时，可预先填充相同目录结构的运行时和模型缓存。下载失败会明确报错，不会以随机向量代替本地模型。

## QQ、Discord 与上游功能

固定上游提交：[`018cd46565149877ee6822968a817932f7390ef8`](https://github.com/Gu-ZT/gugle-chat-bot/tree/018cd46565149877ee6822968a817932f7390ef8)。全部 TypeScript 源码位于 `vendor/gugle-chat-bot`，构建时只应用明确列出的适配补丁，详见 `NOTICE.md` 与 `scripts/build.mjs`。

| 上游模块 | Synapse 接入方式 |
| --- | --- |
| QQ 群聊、私聊、OneBot 事件 | 独立子进程运行完整 QQBot |
| Discord 双向桥、图片附件、回复映射、`/send`、斜杠命令 | 保留原模块，在表单中添加服务器、频道与 QQ 群映射 |
| Hermes 多模态、会话历史、表情回应、进度卡片、审批 | 内部 runs/SSE 适配层连接 DSH 原生 Agent；图片使用宿主附件服务，审批支持本次允许或拒绝 |
| GitHub 订阅、富文本引用、绑定/白名单 | 签名通过的 Webhook 经 IPC 转发原模块 |
| 群管理、黑名单、入群请求、欢迎语、戳一戳 | 保留原模块和配置 |
| B 站订阅、Minecraft 查询、Modrinth、版本跟踪 | 保留原模块（上游默认未调度的任务保持原行为） |
| 括号匹配、峰谷提醒、Markdown 图片渲染 | 保留原模块；峰谷配置也可从配置卡片修改 |
| `/help`、`/reload`、`/reboot`、`/shutdown` | 保留权限检查；重启交给父进程；关闭仅作用于机器人进程 |

dsh-loader 根据模板生成逐项表单。群号、管理员、欢迎语、GitHub 订阅、Discord 映射、消息行为和峰谷提醒分别展开编辑；列表支持添加与删除，开关与时段使用对应控件。密码以不回显的凭据占位符保存，配置修订冲突会保留草稿。

QQ 需在「命令入口」「QQ / Discord 消息行为」等功能下添加启用的群号。Discord 在「跨平台桥接」下填写 Bot Token，并逐条添加服务器 ID、频道名称、QQ 群号和转发条件。

升级时自动将旧 JSON 配置迁移到表单，合并上游配置文件中的生效值，并在 `<profile>/data/dsh-synapse/config-before-forms.json` 保留迁移前备份（可能包含旧凭据）。之后通过聊天命令调整的设置，可使用卡片中的「同步聊天命令修改的功能设置」读回表单；该操作会更新已保存配置并重连通道。

Discord Bot 需要 Message Content Intent；斜杠命令需要 `applications.commands`。桥接群使用上游共享会话逻辑，QQ/Discord 使用同一聊天长期记忆库。OneBot 私聊/群聊和 Discord 的门控、管理员身份仍由上游执行。

Synapse 按会话绑定长期驻留的 DSH Agent：每个 QQ 群与其桥接的 Discord 频道共用一个会话，私聊按 QQ 用户绑定，GitHub 审查按仓库绑定。群内不同发言人进入同一会话，消息保留发言人标识。每次执行读取 DSH 当前默认模型，并更新提示词、记忆与 Skill；原生会话历史持续保留。工具调用、策略检查、取消和会话生命周期由 DSH 执行。上游 Hermes 的消息协议仅在本机适配层使用；插件不提供额外的模型 API 或外部 harness 配置。

同一会话按接收顺序排队，检索、推理和自总结完成后才处理下一条；不同会话独立推进。图片下载和提交阶段也按聊天会话串行，避免消息插队。取消等待中的任务不会中断前面的任务；“停止”取消当前任务，后续队列继续。“清除上下文 / 新对话 / reset”会取消本会话当前和等待任务，切换到新的原生会话，长期记忆不受影响。旧 DSH 会话日志仍由宿主保管。

会话绑定保存在插件数据目录的 `sessions/`。宿主提供 `sessionPersistence` 服务时，重载后通过原生恢复接口继续同一会话；未启用该服务时，只保证当前运行期间驻留。插件重载会取消聊天执行中和等待中的任务，聊天队列不跨重启重放；GitHub 队列持久化，重载时未完成的任务重新排队。旧机器人历史只在首次新建原生会话时导入一次，不在每轮重复注入。自总结使用独立的临时 Agent，避免总结提示词混入聊天或仓库会话。

## 提示词、记忆与 Skill

```text
<dsh_home>/SOUL.md                         聊天默认人设
<dsh_home>/AGENTS.md                       审查默认规则
<dsh_home>/profiles/<profile>/SOUL.md       聊天覆盖
<dsh_home>/profiles/<profile>/AGENTS.md     审查覆盖
<profile>/config/dsh-synapse/config.json   loader 配置
<profile>/skills/<name>/SKILL.md           手动与自动 Skill
<profile>/data/dsh-synapse/
  memory.sqlite                           记忆及审查队列
  runtime/                                动态安装的推理依赖
  models/                                 Hugging Face 模型缓存
  sessions/                               通道与 DSH 会话 ID 的持久化绑定
  bot/configs/                            上游生效配置
  bot/data/                               上游历史与运行状态
  bot/logs/                               上游日志
```

提示词每次请求读取，profile 文件优先，支持无需重启修改。Home 的 Skill 作为继承项，profile 同名项覆盖它。卡片内可选择 Skill、粘贴 Markdown 创建、编辑、安全预览、保存和确认删除。保存 Home 继承项会创建当前 profile 覆盖，不修改 Home 文件；删除仅限当前 profile。写入使用修订摘要防止并发覆盖。自动生成的 `auto-chat-*` 和 `auto-review-*` Skill 使用相同目录，分别用于对应通道。Skill 调用表现为检索适用操作步骤并加入当前推理上下文，不执行文档中任意脚本。

聊天与审查记忆按 `chat` / `review` 分区。完成回答后可通过 DSH 原生 Agent 总结重要事项并提炼可复用 Skill，普通闲聊允许不生成内容；生成结果可在卡片内检查。聊天记忆在当前 profile 的 QQ/Discord 通道间共享，请将需要彼此隔离的用户群部署到不同 profile。

Hermes 导入支持普通 Markdown、frontmatter、标题分节、代码块和长段分块。在卡片内粘贴文档、选择聊天或审查分类，预览后批量导入。批量嵌入成功后以事务提交，相同分类和内容去重；取消时不提交未完成批次，共用的模型下载或推理可能继续完成缓存。未知 Hermes 私有方言作为普通 Markdown 保留，不会猜测不存在的结构字段。

普通配置和操作区均由 dsh-loader 从模板生成，Synapse 不包含客户端入口或独立页面。Skill、MCP、记忆与任务操作通过 `registerOperation` 注册宿主处理器，临时文档和查询结果不写入配置文件，也不触发普通配置保存。旧 `/api/dsh-synapse/` 管理 API 保留，继续使用宿主浏览器认证。

## 本地 RAG 与推理隔离

- 主插件内置 `better-sqlite3` + `sqlite-vec`，FTS5 对中文文本做字符分词，向量 KNN 与全文排名使用 RRF 融合。
- 默认初步召回 50 条，再截取配置数量；启用重排时，对候选 `(query, document)` 做本地交叉编码评分。
- 嵌入：`Xenova/bge-small-zh-v1.5`（BAAI 对应模型的 ONNX 转换，q8/int8、512 维、CLS pooling、归一化）。
- 重排：`Xenova/bge-reranker-base`，`AutoModelForSequenceClassification` + 配对 tokenizer，按 sigmoid(logit) 排序。
- `@huggingface/transformers@3.8.1` 只动态安装到当前 profile 的 `runtime/`，Worker 从此处解析依赖，主插件依赖树不包含它。
- 模型加载先访问 `huggingface.co`，失败后自动以 `hf-mirror.com` 重试。推理在 Worker 中串行执行，下载/推理队列有上限和超时。

模型来源和使用方式参见 [嵌入模型卡](https://huggingface.co/Xenova/bge-small-zh-v1.5)、[重排模型卡](https://huggingface.co/Xenova/bge-reranker-base)、[sqlite-vec Node.js 文档](https://alexgarcia.xyz/sqlite-vec/js.html)。需要代理时，在启动 DSH 前设置 `HTTPS_PROXY`，Node 24 可配合 `NODE_USE_ENV_PROXY=1`。

## MCP

配置卡片支持 stdio、Streamable HTTP、SSE 服务，参数逐项填写，环境变量和请求头使用名称/值表单并持久化。保存配置后可在操作区选择启用的服务，预览实际工具列表及只读参数 Schema（含分页）。服务选项只返回名称，不暴露环境变量或请求头中的凭据。只有管理员在「允许自动调用的工具名称」列表中添加的工具会注册到对应 DSH Agent 的作用域，由宿主工具执行器调用。空列表不自动调用任何工具；外部聊天不继承宿主全局工具。GitHub 审查不执行 MCP 工具。

stdio 服务以当前用户权限运行，其环境默认仅继承 PATH / SystemRoot 及显式配置值。MCP 与自动学习的 Skill 相互独立：Skill 不能扩大工具允许列表。

## GitHub 自动审查

Webhook URL：`https://<DSH域名>/hooks/dsh-synapse/github`。配置 `application/json`、相同的 Webhook Secret，以及 PR、Issue、Release 事件。允许列表支持 `owner/repo` 或 `owner/*`。API Token 需要目标仓库读取权限；开启发布时还需相应 Issues / Pull requests 写权限。

插件验证原始请求体 HMAC-SHA256，按 delivery ID 去重并持久化任务。PR 抓取分页文件差异、固定 head SHA，发布前再次核对 head；过期事件跳过。超过差异上限会明确标记截断。Issue 生成分诊建议。默认仅保存结果，可在卡片内选择任务查看；启用「自动发布审查评论」后创建 PR 的 COMMENT review 或 Issue comment，不自动 approve 或 merge。每条评论带 delivery 标记，重试前检查远程标记以避免重复发布。

同一仓库的 PR / Issue 共用原生会话并串行审查，不同仓库最多并行处理四个。失败任务保留错误，可在卡片内重试；重启恢复运行中的任务。Webhook 通知同时转发上游 GitHub 订阅功能。旧上游未认证监听端口被禁用。

## 开发与验证

```sh
npm run typecheck
npm test
npm pack --dry-run
# 可选：实际下载模型，产生的 .runtime-test 被 Git 忽略
node scripts/model-smoke.mjs --rerank
# 可选：使用已安装的 DSH 组件验证原生 Agent（模型输出使用内存测试桩）
node scripts/host-smoke.mjs /path/to/installed/dsh/package.json
```

自动测试使用真实 SQLite/vec、模拟 OneBot、实际 MCP stdio 服务和 loader 配置存储，测试不向真实账号发送消息。跨平台 CI 覆盖 Windows、Linux、macOS。真实 QQ/Discord、GitHub 发布以及浏览器图片渲染仍需部署者提供凭据和浏览器后联调。

## npm 自动发布

工作流为 `.github/workflows/npm-publish.yml`，沿用其他 DSH 插件的发布约定：

- PR 和手动运行：执行 Linux、Windows、macOS 的类型检查、构建、测试与打包检查。
- 推送 `main`：三平台检查全部成功后，将 `X.Y.Z-dev.<GitHub run ID>` 发布到 npm 的 `next` 标签；重跑已发布的同一版本会跳过发布。
- 推送 `vX.Y.Z` 标签：必须与 `package.json` 的稳定版本号完全一致，检查成功后发布到 `latest`，并将 npm 元数据写入 `npm-latest.json`、提交回 `main`；遇到 registry 处理延迟时，每 30 秒重试，最多重试 10 次，并核对目标版本。

开发版只在发布任务的临时检出中修改 `package.json` 和锁文件；仓库保持稳定的 `X.Y.Z` 基础版本。正式发布前先更新两个文件中的版本号，再推送对应 Git 标签。

使用 npm Trusted Publishing 的 GitHub OIDC 身份和 provenance，无需 `NPM_TOKEN`。npm 包的 Trusted Publisher 应配置组织 `dsh-plugins`、仓库 `dsh-synapse`、工作流文件名 **`npm-publish.yml`**；本工作流未使用 GitHub Environment，并执行直接 `npm publish`，对应配置需允许该发布动作。Node.js 24 提供支持 OIDC 的 npm 11。配置要求参见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

开发版发布后，可在目标 DSH profile 中安装 `@dsh-plugin/dsh-synapse@next`。

AGPL-3.0-only。保留上游许可证、作者说明与完整对应源码，详见 `NOTICE.md`。
