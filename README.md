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

Send `stop` or `停止` to cancel the current reply and let the next queued message proceed. Send `reset`, `新对话`, or `清除上下文` to cancel active and queued tasks and start a new conversation, keeping saved long-term memory. Use `/help` to see available commands; management commands for reloading, restarting, and shutting down require the appropriate admin permissions.

When session persistence is enabled in DSH, reloading can restore the conversation. Unfinished chat messages must be sent again after a reload.

You can adjust conversation permissions under "Task Execution Limits → Permissions for all new Synapse sessions":

- **Read Only** (default)
- **Workspace Write**
- **Full Access**
- **Auto Review**: DSH reviews tool operations before deciding whether to allow them. Requires `@deepseek-ai/dsh-experimental-auto-review` to be installed and enabled in the current profile.

Changes apply only to new or reset conversations. Existing and restored conversations keep their permissions. The MCP allowlist below still determines which tools can be called.

## Persona, Memory & Skills

`<dsh_home>/SOUL.md` sets the default chat persona, and `<dsh_home>/AGENTS.md` sets GitHub review guidelines. A file with the same name in `<dsh_home>/profiles/<profile>/` takes precedence for that profile. Edits take effect on the next request without a restart.

Chat and review memories are stored separately. QQ and Discord share chat memory within a profile; use separate profiles for groups whose memories need to stay separate. To import existing Hermes memories, paste Markdown in "Hermes Memory Import & Search", choose chat or review, preview the entries, then import the batch.

With automatic summarization enabled, Synapse can turn useful experience into Skills for similar tasks later. Skills contain reusable instructions and are not run as scripts. In "Skill Management", paste Markdown to create a Skill, or edit, preview, and delete existing entries. Saving an inherited home Skill creates an override for the current profile and leaves the original file in place.

## MCP

For external tools, add a server under "MCP Servers", choose `stdio`, `Streamable HTTP`, or `SSE`, and fill in the relevant command arguments or URL, environment variables, and headers. After saving, select the server in "MCP Tool Preview" to see its tools. `stdio` servers run with your current OS user's permissions.

Add the tool names you want to use under "Tool names allowed for automatic invocation". Chat sessions can call only the listed tools; an empty list enables no MCP calls. GitHub reviews do not use MCP.

## GitHub Reviews

Add a Webhook in your GitHub repository or organization. Set the Payload URL to `https://<your-dsh-domain>/hooks/dsh-synapse/github`, choose `application/json` as the Content type, set a Secret, and select `Pull requests`, `Issues`, and `Releases` events.

Under "GitHub Webhook" in the plugin settings, enter the same Secret, a GitHub Token with repository read access, and the allowed repositories, such as `owner/repo` or `owner/*`. Turn on "Enable Webhook Review".

PR review comments and issue triage notes are saved locally by default. Read results or retry failed tasks under "GitHub Review Tasks". To publish results to GitHub, grant the Token `Issues` and `Pull requests` write permissions and turn on "Automatically publish review comments". Publishing posts comments; it does not approve or merge PRs.

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
