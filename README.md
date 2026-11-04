<div align="center">

# @dsh-plugin/dsh-synapse

**Use DSH in QQ and Discord, and add automated reviews to your GitHub repositories.**

English | [简体中文](README.zh_CN.md)

</div>

## Features

- **QQ & Discord Chat**: Chat in QQ groups, private messages, and Discord channels with image reading, reply quotes, emoji reactions, progress cards, tool approvals, and two-way bridging between QQ groups and Discord channels.
- **Group Assistant & Subscriptions**: Handle group join requests, blocklists, welcome messages, and pokes, with built-in GitHub and Bilibili subscriptions, Minecraft and Modrinth queries, version tracking, bracket matching, and scheduled reminders.
- **Proactive Group Replies**: Keep recent group messages as context and configure word-cloud weighted probabilistic replies and idle check-ins per group.
- **Memory & Skills**: Remember important facts and preferences from conversations and reviews, and summarize verified workflows into reusable Skills.
- **GitHub Reviews**: Review Pull Requests, triage Issues, and forward repository and Release updates to your groups.

## Installation

Requires DSH `0.1.5+`, Node.js `24.9+`, and `npm`. To connect QQ, run a OneBot 11 client with HTTP and forward WebSocket support (such as NapCat or Snowluma). Rendering image cards requires a local Chrome or Chromium installation.

1. Open the DSH Plugin Marketplace and install `@dsh-plugin/dsh-loader@next` and `@dsh-plugin/dsh-synapse@next`.
2. Open the plugin settings page and fill in the configuration sections you need. If you use image cards, set the path to your local Chrome or Chromium executable.
3. Choose default chat and review models in the plugin card (or leave them blank to use DSH's default model), then connect your channels below.

## Connecting QQ & Discord

1. Under **OneBot · NapCat / Snowluma**, enter the HTTP URL, forward WebSocket URL, and access tokens.
2. Under **Chat & Notification Features → QQ / Discord Message Behavior**, add the enabled QQ group IDs and conversation admins. Add group IDs under **Command Entry** to enable group commands, and set welcome messages under **New Member Welcome**. Turn on **Enable Bot** when ready.
3. To bridge Discord, fill in the Bot Token, Guild ID, channel name, linked QQ group ID, and forwarding rules under **Discord Cross-Platform Bridge**.
4. In the Discord Developer Portal, enable `Message Content Intent` for your bot, and include the `applications.commands` scope when inviting the bot if you use slash commands such as `/send`.

## Daily Use & Permissions

- **Conversations**: Each QQ group and its bridged Discord channel share one ongoing conversation while preserving each speaker's identity. QQ private chats are separate per user, and GitHub reviews are separate per repository.
- **Chat Commands**:
  - Send `stop` or `停止` to cancel the current reply and move to the next queued message.
  - Send `reset`, `新对话`, or `清除上下文` to clear the current context and start a fresh conversation while keeping long-term memory.
  - Send `/help` to view available bot commands.
- **Long Message Merging**: Outgoing QQ messages are spaced at least 2 seconds apart. Consecutive messages that exceed the character threshold (default 300), line threshold (default 5), or maximum single-message length are automatically packed into a forward-message card (set a threshold to `0` to disable it).
- **Limits & Permissions**: Under **Task Execution Limits**, you can set the per-turn timeout and step limit (`-1` disables the limit), and choose the permission preset for new conversations:
  - **Read Only** (default)
  - **Workspace Write**
  - **Full Access**
  - **Auto Review** (requires `@deepseek-ai/dsh-experimental-auto-review` enabled in the current profile)

  Permission changes apply to newly created or reset conversations.

## Group Context & Proactive Replies

Enabled QQ groups automatically keep the latest 100 untriggered messages (including cached images) as background context for the next reply.

Under **Group Context & Proactive Replies**, click **Edit Group Policy** to configure global defaults and per-group rules:

- **Probabilistic Replies**: Replies to ordinary group messages by probability (default 3% base, up to 10%, boosted by recurring topics in the group word cloud), while `@` mentions and keyword triggers continue to work as usual.
- **Idle Messages**: Sends a topic starter when a group stays quiet for a randomized window (default 15–45 minutes, 25% chance, muted during `00:00–09:00` `Asia/Shanghai`). If a member speaks during the pre-send delay, the idle reply is cancelled.
- **Admin Commands**: Group admins can run `/synapse probability`, `/synapse idle`, `/synapse blockword`, and `/synapse logs` in the group (for example, `/synapse probability on` or `/synapse probability set base 3.25`). Adding `global` edits global defaults and requires operator permissions.

Both probabilistic replies and idle messages are off by default and require both the global switch and the per-group switch to be enabled.

## Persona, Memory, Skills & Tools

- **Persona & Rules**: Put `SOUL.md` in `<profile>/` or `$DSH_HOME/` to customize the chat persona, and `AGENTS.md` to customize review rules (files in `<profile>/` take precedence). Changes take effect on the next request.
- **Memory & Skills**: Chat and review memories are stored separately. You can import Markdown notes under **Hermes Memory Import**, search saved entries under **Memory Search**, and preview or edit Skills under **Skill Management**.
- **Built-in Tools & MCP**: In chat, the model can query GitHub Issues/PRs, Bilibili videos, Minecraft versions/servers, the Chinese Minecraft Wiki, Modrinth versions, and recent QQ chat history, or call configured OneBot APIs after checking sender permissions. Under **MCP Management**, you can add `stdio`, `Streamable HTTP`, or `SSE` servers, test them, and select which tools the chat model may call automatically.

## GitHub Reviews

1. Add a Webhook in your GitHub repository or organization:
   - **Payload URL**: `https://<your-dsh-domain>/hooks/dsh-synapse/github`
   - **Content type**: `application/json`
   - **Secret**: Your webhook secret
   - **Events**: `Pull requests`, `Issues`, and `Releases`
2. Under **GitHub Webhook** in the plugin settings, enter the same Secret, a GitHub Token with repository read access, and the allowed repositories (`owner/repo` or `owner/*`), then enable **Enable Webhook Review**.
3. View or retry tasks under **GitHub Review Tasks**. To post review comments back to GitHub, grant your Token write access to `Issues` and `Pull requests` and turn on **Publish Review Comments Automatically**.

## FAQ

**Why isn't the bot replying in my group chat?**

Check that **Enable Bot** is on, the OneBot URLs and tokens are valid, and the group ID is listed under **QQ / Discord Message Behavior**. By default, group chat requires an `@` mention or a keyword trigger. Group commands also require the group ID to be added under **Command Entry**. For Discord, verify the channel mapping and `Message Content Intent`.

**Why does enabling memory take a long time or fail the first time?**

The first run downloads local embedding and reranker models, and automatically falls back to `hf-mirror.com` if Hugging Face is unreachable. If you use a proxy, set `HTTPS_PROXY` before starting DSH (with `NODE_USE_ENV_PROXY=1` on Node.js 24).

**What should I do if sending images on Windows fails with `sharp` `ERR_DLOPEN_FAILED`?**

Fully quit and restart DSH after updating the plugin so previously loaded native DLLs are cleared.

**Why didn't changing session permissions affect my current group chat?**

Permission presets apply when a conversation is created. Send `reset` or `清除上下文` in the chat to start a new conversation with the updated permissions.

**Why don't settings changed via chat commands appear in the web form?**

Under **Runtime Status & Configuration Sync**, click **Sync feature settings modified by chat commands** to read live command changes back into the settings form.

## Documentation & License

- Technical details: [Architecture & Session Lifecycle](docs/architecture.md) · [Group Context & Proactive Replies](docs/group-activity.md)
- Issues & source code: [GitHub Issues](https://github.com/dsh-plugins/dsh-synapse/issues) · [GitHub Repository](https://github.com/dsh-plugins/dsh-synapse)

Built upon [Gu-ZT/gugle-chat-bot](https://github.com/Gu-ZT/gugle-chat-bot) and released under the `AGPL-3.0-only` license. See [`NOTICE.md`](NOTICE.md) for upstream licenses, credits, and modification notes.
