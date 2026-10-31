<div align="center">

# @dsh-plugin/dsh-synapse

**Persistent DSH sessions for QQ and Discord chat, GitHub review, and local memory.**

English | [简体中文](README.zh_CN.md)

</div>

A TypeScript plugin built on the **dsh-loader 2.0 API**. It preserves gugle-chat-bot's QQ, Discord, group management, and notification modules while adding declarative configuration, automated GitHub review, local hybrid memory, and automatic Skill summarization.

## Installation and startup

Requires Node.js **24.9+**, npm, dsh-loader 2.0, and a OneBot 11 HTTP/forward WebSocket service. Use NapCat or Snowluma with equivalent OneBot API support. Image cards also require a local Chrome/Chromium installation; enter its executable path in the configuration card.

```sh
git clone https://github.com/dsh-plugins/dsh-synapse.git
cd dsh-synapse
npm ci
npm run build
npm pack
```

Install `@dsh-plugin/dsh-loader@next` and the locally generated `dsh-plugin-dsh-synapse-0.1.0.tgz` in the target DSH profile, then load them through DSH's bundle installation flow. This repository provides `cordis.patch.yml`. The configuration card's operation panels require loader **2.0.0-dev.41151102394 or a newer compatible version**. The development dependency is pinned to that version, with a peer range of `^2.0.0-dev.41151102394`.

Enter the OneBot addresses and access tokens in DSH's plugin configuration, then enable the bot. Chat, GitHub review, and Skill summarization use **the DSH host's native Agent and current default model**. Model selection belongs to DSH's own model settings. Synapse registers a configuration template, and dsh-loader mounts its card on the corresponding plugin page without an extra navigation entry or standalone configuration page. If automatic profile detection fails, enter the profile's absolute path in the card.

The bot and GitHub publishing are disabled by default. RAG installs its runtime and downloads models on first use; enabling the bot also warms up the embedding model. For offline use, populate the runtime and model caches with the same directory structure beforehand. Download failures produce explicit errors; random vectors are never substituted for the local model.

## QQ, Discord, and upstream features

Pinned upstream commit: [`018cd46565149877ee6822968a817932f7390ef8`](https://github.com/Gu-ZT/gugle-chat-bot/tree/018cd46565149877ee6822968a817932f7390ef8). All upstream TypeScript source is in `vendor/gugle-chat-bot`. The build applies only the explicitly listed adapter patches; see `NOTICE.md` and `scripts/build.mjs`.

| Upstream module | Synapse integration |
| --- | --- |
| QQ group chat, private chat, and OneBot events | Runs the complete QQBot in a separate child process |
| Bidirectional Discord bridge, image attachments, reply mapping, `/send`, and slash commands | Preserves the original module; configure server, channel, and QQ group mappings in the form |
| Hermes multimodal messages, conversation history, reactions, progress cards, and approvals | An internal runs/SSE adapter connects to DSH's native Agent; images use the host attachment service, and approvals support allowing once or rejecting |
| GitHub subscriptions, rich-text references, bindings, and allowlists | Verified Webhooks reach the original module through IPC |
| Group management, blocklists, join requests, welcome messages, and pokes | Preserves the original modules and configuration |
| Bilibili subscriptions, Minecraft queries, Modrinth, and version tracking | Preserves the original modules, including upstream behavior for tasks not scheduled by default |
| Parenthesis matching, peak/valley reminders, and Markdown image rendering | Preserves the original modules; peak/valley settings are also editable in the configuration card |
| `/help`, `/reload`, `/reboot`, and `/shutdown` | Preserves permission checks; the parent process handles restarts, and shutdown affects only the bot process |

dsh-loader generates individual form fields from the template. QQ group IDs, administrators, welcome messages, GitHub subscriptions, Discord mappings, message behavior, and peak/valley reminders are edited separately. Lists support adding and removing entries, while switches and time ranges use their corresponding controls. Passwords are stored using credential placeholders without revealing their values, and configuration revision conflicts preserve the draft.

For QQ, add enabled group IDs under features such as Command Entry (命令入口) and QQ / Discord Message Behavior (QQ / Discord 消息行为). For Discord, enter the Bot Token under Cross-platform Bridging (跨平台桥接), then add the server ID, channel name, QQ group ID, and forwarding conditions for each mapping.

Upgrades automatically migrate legacy JSON configuration into the forms, merge effective values from upstream configuration files, and retain a backup at `<profile>/data/dsh-synapse/config-before-forms.json` (which may contain old credentials). Later changes made through chat commands can be read back into the form using Sync Feature Settings Changed by Chat Commands (同步聊天命令修改的功能设置). This updates the saved configuration and reconnects the channels.

Discord bots require the Message Content Intent; slash commands require `applications.commands`. Bridged groups use upstream shared-session behavior, and QQ/Discord share the same long-term chat memory database. Upstream code continues to enforce message gating and administrator identities for OneBot private/group chat and Discord.

Synapse binds conversations to persistent DSH Agents. Each QQ group and its bridged Discord channel share one session, private chats are bound by QQ user, and GitHub reviews are bound by repository. Different speakers in a group enter the same session, with speaker identifiers retained in messages. Each run reads DSH's current default model and refreshes the prompt, memory, and Skills while retaining native conversation history. DSH handles tool calls, policy checks, cancellation, and session lifecycle. The upstream Hermes message protocol is used only in the local adapter; the plugin has no additional model API or external harness configuration.

The configuration card's Task Limits → Permissions for All New Synapse Sessions (任务运行限制 → 全部 Synapse 新会话的权限) setting applies native permissions to new group, private, GitHub repository, and summarization sessions: Read Only (default), Workspace Write, Full Access, or Auto Review. Auto Review requires `@deepseek-ai/dsh-experimental-auto-review` to be installed and enabled in the current profile; otherwise, an explicit error is returned. The plugin sets presets through the host permission service, while DSH enforces sandbox and approval rules. Changes affect only sessions created afterward, including sessions created after clearing context. Existing resident or resumed sessions retain their persisted permissions. This does not change defaults for other DSH sessions or the MCP tool allowlist.

Messages in the same session run in arrival order. Retrieval, inference, and summarization finish before the next message is processed; separate sessions progress independently. Image downloads and submission are also serialized by chat session to preserve message order. Cancelling a waiting task does not interrupt earlier tasks. Stop cancels the current task and lets the remaining queue continue. Clear Context / New Conversation / `reset` cancels active and waiting tasks for that session and switches to a new native session without affecting long-term memory. The host continues to retain old DSH session logs.

Session bindings are stored under `sessions/` in the plugin data directory. When the host provides `sessionPersistence`, reloads resume the same session through the native restore API. Without that service, persistence is guaranteed only during the current process lifetime. Plugin reloads cancel active and waiting chat tasks; the chat queue is not replayed across restarts. The GitHub queue is durable, and unfinished tasks are requeued on reload. Legacy bot history is imported only once when a native session is first created, rather than being injected on every turn. Summarization uses a separate temporary Agent so its prompt does not enter the chat or repository conversation.

## Prompts, memory, and Skills

```text
<dsh_home>/SOUL.md                         Default chat persona
<dsh_home>/AGENTS.md                       Default review instructions
<dsh_home>/profiles/<profile>/SOUL.md       Chat override
<dsh_home>/profiles/<profile>/AGENTS.md     Review override
<profile>/config/dsh-synapse/config.json   Loader configuration
<profile>/skills/<name>/SKILL.md           Manual and generated Skills
<profile>/data/dsh-synapse/
  memory.sqlite                           Memory and review queue
  runtime/                                Dynamically installed inference dependencies
  models/                                 Hugging Face model cache
  sessions/                               Persistent channel-to-DSH-session-ID bindings
  bot/configs/                            Effective upstream configuration
  bot/data/                               Upstream history and runtime state
  bot/logs/                               Upstream logs
```

Prompts are read for each request, with profile files taking precedence, so edits do not require a restart. Home Skills are inherited, and profile Skills with the same name override them. The card supports selecting a Skill, creating one by pasting Markdown, editing, safe preview, saving, and confirmed deletion. Saving an inherited Home Skill creates a profile override without changing the Home file; deletion is limited to the current profile. Revision hashes prevent concurrent overwrites. Automatically generated `auto-chat-*` and `auto-review-*` Skills use the same directory and apply to their respective channels. Skill invocation means retrieving relevant procedures and adding them to the current reasoning context; arbitrary scripts in documents are not executed.

Chat and review memories are partitioned into `chat` and `review`. After answering, a native DSH Agent can summarize important facts and extract reusable Skills; ordinary small talk may produce nothing. Generated content can be inspected in the card. Chat memory is shared among QQ/Discord channels in the current profile. Deploy user groups that require isolation into separate profiles.

Hermes import supports ordinary Markdown, frontmatter, heading sections, code fences, and chunking of long paragraphs. Paste a document in the card, select the chat or review category, preview it, then import it in bulk. The batch is committed transactionally only after all embeddings succeed, with duplicates removed by category and content. Cancellation does not commit an unfinished batch; shared model downloads or inference may continue to populate the cache. Unknown private Hermes dialects are preserved as ordinary Markdown rather than guessing undocumented fields.

Both regular configuration and operation panels are generated by dsh-loader from the template. Synapse contains no client entry point or standalone page. Skill, MCP, memory, and task operations register host handlers through `registerOperation`. Temporary documents and query results are not written to configuration files and do not trigger regular configuration saves. The existing `/api/dsh-synapse/` management API remains available with host browser authentication.

## Local RAG and inference isolation

- The main plugin embeds `better-sqlite3` + `sqlite-vec`. FTS5 tokenizes Chinese text by character, and RRF combines vector KNN and full-text rankings.
- The initial recall count defaults to 50, followed by the configured result limit. When reranking is enabled, a local cross-encoder scores candidate `(query, document)` pairs.
- Embedding: `Xenova/bge-small-zh-v1.5`, an ONNX conversion of the corresponding BAAI model, using q8/int8, 512 dimensions, CLS pooling, and normalization.
- Reranking: `Xenova/bge-reranker-base` with `AutoModelForSequenceClassification` and paired tokenization, ranked by sigmoid(logit).
- `@huggingface/transformers@3.8.1` is installed dynamically only in the current profile's `runtime/`. The Worker resolves dependencies there; the main plugin dependency tree does not include it.
- Model loading first tries `huggingface.co`, then retries through `hf-mirror.com` on failure. Inference runs serially in a Worker, with bounded download/inference queues and timeouts.

For model sources and usage, see the [embedding model card](https://huggingface.co/Xenova/bge-small-zh-v1.5), [reranker model card](https://huggingface.co/Xenova/bge-reranker-base), and [sqlite-vec Node.js documentation](https://alexgarcia.xyz/sqlite-vec/js.html). If a proxy is needed, set `HTTPS_PROXY` before starting DSH. Node 24 can also use `NODE_USE_ENV_PROXY=1`.

## MCP

The configuration card supports stdio, Streamable HTTP, and SSE services. Arguments are entered individually; environment variables and HTTP headers use persistent name/value fields. After saving, select an enabled service in the operation panel to preview its actual tool list and read-only parameter schemas, including pagination. Service options return names only and do not expose credentials from environment variables or headers. Only tools added by an administrator to Allowed Tool Names for Automatic Invocation (允许自动调用的工具名称) are registered in the corresponding DSH Agent's scope and called through the host tool executor. An empty list enables no automatic tool calls. External chats do not inherit global host tools, and GitHub review does not execute MCP tools.

stdio services run with the current user's permissions. By default, their environment inherits only PATH / SystemRoot and explicitly configured values. MCP and automatically learned Skills are independent: a Skill cannot expand the tool allowlist.

## Automated GitHub review

Webhook URL: `https://<DSH域名>/hooks/dsh-synapse/github`. Configure `application/json`, the same Webhook Secret, and PR, Issue, and Release events. The allowlist supports `owner/repo` and `owner/*`. The API Token needs read access to target repositories; publishing also requires the corresponding Issues / Pull requests write permissions.

The plugin verifies HMAC-SHA256 over the raw request body, deduplicates by delivery ID, and persists tasks. For PRs, it fetches paginated file diffs and pins the head SHA, then checks the head again before publishing; stale events are skipped. Diffs exceeding the configured limit are explicitly marked as truncated. Issues receive triage suggestions. Results are saved by default and can be inspected by selecting a task in the card. Enabling Automatically Publish Review Comments (自动发布审查评论) creates a PR COMMENT review or Issue comment; it does not approve or merge. Each comment includes a delivery marker, and retries check remote markers to avoid duplicate publication.

PRs and Issues in the same repository share a native session and are reviewed serially. Up to four repositories run concurrently. Failed tasks retain their errors and can be retried from the card; tasks that were running are recovered on restart. Webhook notifications also reach the upstream GitHub subscription feature. The old upstream unauthenticated listener port is disabled.

## Development and verification

```sh
npm run typecheck
npm test
npm pack --dry-run
# Optional: download actual models; the resulting .runtime-test is ignored by Git
node scripts/model-smoke.mjs --rerank
# Optional: verify the native Agent using installed DSH components (model output is stubbed in memory)
node scripts/host-smoke.mjs /path/to/installed/dsh/package.json
```

Automated tests use real SQLite/vec, a simulated OneBot, an actual MCP stdio service, and loader configuration storage. They do not send messages to real accounts. Cross-platform CI covers Windows, Linux, and macOS. Live QQ/Discord, GitHub publishing, and browser image rendering still require deployment credentials and a browser for integration testing.

## Automated npm publishing

The workflow is `.github/workflows/npm-publish.yml`, following the release conventions of the other DSH plugins:

- PRs and manual runs perform type checking, builds, tests, and package inspection on Linux, Windows, and macOS.
- Pushing `main` publishes `X.Y.Z-dev.<GitHub run ID>` to npm's `next` tag after all three platforms pass. Rerunning a version that is already published skips publication.
- Pushing `vX.Y.Z` requires an exact match with the stable version in `package.json`. After checks pass, the workflow publishes to `latest`, writes npm metadata into `npm-latest.json`, and commits it back to `main`. If registry processing is delayed, it retries every 30 seconds, up to 10 times, and checks the target version.

Development versions modify `package.json` and the lockfile only in the publishing job's temporary checkout; the repository keeps a stable `X.Y.Z` base version. Before a stable release, update the version in both files, then push the corresponding Git tag.

Publishing uses npm Trusted Publishing with GitHub OIDC and provenance, without `NPM_TOKEN`. Configure the npm package's Trusted Publisher with organization `dsh-plugins`, repository `dsh-synapse`, and workflow filename **`npm-publish.yml`**. This workflow does not use a GitHub Environment and runs `npm publish` directly; the publisher configuration must allow that action. Node.js 24 provides npm 11 with OIDC support. See the [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/) for configuration requirements.

After a development release, install `@dsh-plugin/dsh-synapse@next` in the target DSH profile.

AGPL-3.0-only. The upstream license, author attribution, and complete corresponding source are retained; see `NOTICE.md`.
