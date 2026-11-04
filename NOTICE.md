# Third-party source

`vendor/gugle-chat-bot` contains Gu-ZT/gugle-chat-bot at commit
`018cd46565149877ee6822968a817932f7390ef8` (AGPL-3.0).
Source: https://github.com/Gu-ZT/gugle-chat-bot
The upstream LICENSE is retained. Its README's ISC label contradicts that file;
this distribution follows the actual AGPL license.

Synapse modifications are recorded by `scripts/build.mjs`: supervise shutdown
and restart through IPC, replace the unauthenticated webhook listener with IPC,
resolve SOUL.md from the active DSH profile and home, and use file polling for
configuration reload to avoid a Windows libuv directory-watcher assertion.
The adapter also shares native sessions by group/private chat,
serializes incoming message preparation, and forwards context resets to DSH. All feature modules
remain included. Hermes bridge code includes upstream's attribution to Amorter
and qq-hermes-bridge (MIT); those notices are preserved in source.

`src/qq-send-queue.ts` 实现按 QQ 会话合并、全局轮流限速及超长消息转聊天记录。`scripts/build.mjs` 将其接入上游公开发送方法，并让逐句回复先提交完整批次，发送完成后再结束本轮；私聊可撤回回执保持独立。上游源文件保留原样。

`scripts/activity-adapter.mjs` 将 QQ 群的 AI 输入接到宿主统一状态模块，保存未触发背景、异步缓存图片，并处理概率回复、空闲事件、管理命令与发送完成通知。策略通过 IPC 热更新；空闲事件保留系统来源和非管理员权限。原生命令、自动卡片、私聊与 Discord 的其他处理钩子继续使用上游实现。

Modified distribution: DSH Synapse contributors, 2026, AGPL-3.0-only.
When offering this modified program over a network, offer recipients the
corresponding source under AGPL section 13. Ship this source alongside builds.
