# Third-party source

`vendor/gugle-chat-bot` contains Gu-ZT/gugle-chat-bot at commit
`018cd46565149877ee6822968a817932f7390ef8` (AGPL-3.0).
Source: https://github.com/Gu-ZT/gugle-chat-bot
The upstream LICENSE is retained. Its README's ISC label contradicts that file;
this distribution follows the actual AGPL license.

Synapse modifications are recorded by `scripts/build.mjs`: supervise shutdown
and restart through IPC, replace the unauthenticated webhook listener with IPC,
resolve SOUL.md from the active DSH profile and home, and use file polling for
configuration reload to avoid a Windows libuv directory-watcher assertion. All feature modules
remain included. Hermes bridge code includes upstream's attribution to Amorter
and qq-hermes-bridge (MIT); those notices are preserved in source.

Modified distribution: DSH Synapse contributors, 2026, AGPL-3.0-only.
When offering this modified program over a network, offer recipients the
corresponding source under AGPL section 13. Ship this source alongside builds.
