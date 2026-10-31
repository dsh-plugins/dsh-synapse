import { build } from "esbuild";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
await mkdir("lib", { recursive: true });
// Remove artifacts from the former standalone configuration UI on incremental builds.
for (const file of [
  "lib/client.js",
  "lib/host/client.js",
  "lib/host/client.js.map",
  "lib/host/client.d.ts",
  "lib/host/panel.html",
  "lib/host/panel.js",
  "lib/host/panel.js.map",
  "lib/host/panel.d.ts",
])
  await rm(file, { force: true });
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")], {
  stdio: "inherit",
});
const vendor = path.resolve("vendor/gugle-chat-bot");
// Patches are applied at build time, keeping the pinned source auditable.
await build({
  entryPoints: [`${vendor}/src/index.ts`],
  outfile: "lib/bot.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  packages: "external",
  tsconfig: `${vendor}/tsconfig.json`,
  sourcemap: true,
  plugins: [
    {
      name: "synapse-adapter",
      setup(b) {
        b.onLoad({ filter: /\.ts$/ }, async ({ path: file }) => {
          let contents = (await readFile(file, "utf8")).replaceAll(
            "\r\n",
            "\n",
          );
          if (file.endsWith(path.join("config", "manager.ts"))) {
            // Poll files to avoid the Windows libuv directory watcher assertion on
            // redirected profile/temp folders. Preserve ConfigStore hot reload.
            contents = contents
              .replace(
                "private watcher: fs.FSWatcher | undefined",
                "private watcher: { close(): void } | undefined",
              )
              .replace(
                "this.watcher = fs.watch(dir, (_event, changedFile) => {",
                "const listener = () => { const changedFile = filename;",
              )
              .replace(
                "    });\n  }\n\n  /** 停止文件监听 */",
                "    };\n    fs.watchFile(resolved, { interval: 1000 }, listener);\n    this.watcher = { close: () => fs.unwatchFile(resolved, listener) };\n  }\n\n  /** 停止文件监听 */",
              );
          }
          if (file === path.join(vendor, "src", "index.ts"))
            contents = contents.replace(
              "github.start(botConfig.githubPort);",
              `
        process.on('message', (message: any) => {
          if (message?.type === 'github') void github.post('github-' + message.event, bot, message.payload);
        });
        process.on('disconnect', () => process.exit(0));
        process.send?.({ type: 'ready' });`,
            );
          if (file.endsWith(path.join("src", "custom.ts")))
            contents = contents.replace(
              "const result = await restartApplication();",
              "process.send?.({ type: 'restart' }); return; const result = await restartApplication();",
            );
          if (file.endsWith(path.join("hermes", "index.ts")))
            contents = contents.replace(
              "const soulPath = path.resolve(process.cwd(), 'configs', 'SOUL.md');",
              "const soulPath = [process.env.SYNAPSE_PROFILE, process.env.SYNAPSE_HOME].filter(Boolean).map(dir => path.join(dir!, 'SOUL.md')).find(file => fs.existsSync(file)) || path.resolve(process.cwd(), 'configs', 'SOUL.md');",
            );
          if (file.endsWith(path.join("hermes", "index.ts"))) {
            const replace = (from, to) => {
              if (!contents.includes(from))
                throw new Error(
                  `Upstream session adapter anchor missing: ${from}`,
                );
              contents = contents.replaceAll(from, to);
            };
            replace(
              "`group_${route.groupId}_user_${route.userId}`",
              "`group_${route.groupId}`",
            );
            replace(
              "const hermesSessionId = sessionVersion > 0 ? `${hermesSessionBase}:v${sessionVersion}` : hermesSessionBase;",
              "const hermesSessionId = hermesSessionBase;",
            );
            replace(
              "private clearSession(route: RouteInfo): number {",
              "private async clearSession(route: RouteInfo): Promise<number> {\n    await this.hermes.resetSession(route.type === 'user' ? `user_${route.userId}` : `group_${route.groupId}`);",
            );
            replace(
              "const newVersion = this.clearSession(route);",
              "const newVersion = await this.clearSession(route);",
            );
            // Serialize preparation/submission too, so slow image downloads cannot
            // overtake earlier messages. Native execution is queued in the host.
            replace(
              "private readonly sessions = new Map<string, Session>();",
              `private readonly sessions = new Map<string, Session>();
  private readonly synapseIngress = new Map<string, Promise<void>>();
  private queueSynapse(route: RouteInfo, work: () => Promise<void>): Promise<void> {
    const key = this.getSessionKey(route);
    const task = (this.synapseIngress.get(key) || Promise.resolve()).then(work);
    const tail = task.catch(() => {}).finally(() => { if (this.synapseIngress.get(key) === tail) this.synapseIngress.delete(key); });
    this.synapseIngress.set(key, tail);
    return task;
  }
  private synapseControl(route: RouteInfo, text: string): boolean {
    return isStopCommand(text) || (Boolean(parseApprovalChoice(text)) && this.isRouteAdmin(route) && [...this.pendingApprovals.values()].some(a => this.routeMatches(route, a.route)));
  }`,
            );
            replace(
              "private async handleMessageSafe(bot: QQBot, msg: GroupMessageWSMSG | PrivateMessageWSMSG): Promise<void>",
              "private async handleMessageSafe(bot: QQBot, msg: GroupMessageWSMSG | PrivateMessageWSMSG, synapseQueued = false): Promise<void>",
            );
            replace(
              "const rawText = this.extractText(msg.message);",
              "const rawText = this.extractText(msg.message);\n    if (!synapseQueued && !this.synapseControl(route, rawText)) return this.queueSynapse(route, () => this.handleMessageSafe(bot, msg, true));",
            );
            replace(
              "private async handleDiscordMessageSafe(bot: QQBot, message: DiscordMessage, params: DiscordChatParams): Promise<void>",
              "private async handleDiscordMessageSafe(bot: QQBot, message: DiscordMessage, params: DiscordChatParams, synapseQueued = false): Promise<void>",
            );
            replace(
              "const rawText = this.plainDiscordText(message, params.botUserId);",
              "const rawText = this.plainDiscordText(message, params.botUserId);\n    if (!synapseQueued && !this.synapseControl(route, rawText)) return this.queueSynapse(route, () => this.handleDiscordMessageSafe(bot, message, params, true));",
            );
          }
          if (file.endsWith(path.join("hermes", "client.ts"))) {
            const anchor = "export class HermesClient {";
            if (!contents.includes(anchor))
              throw new Error("Upstream Hermes client anchor missing");
            contents = contents.replace(
              anchor,
              `${anchor}
  public async resetSession(sessionId: string): Promise<void> {
    const response = await fetch(this.baseUrl + '/v1/sessions/reset', { method: 'POST', headers: this.headers(), body: JSON.stringify({ session_id: sessionId }) });
    if (!response.ok) throw new Error('DSH 会话重置失败: ' + response.status);
  }
`,
            );
          }
          return { contents, loader: "ts" };
        });
      },
    },
  ],
});
await writeFile(
  "lib/build.json",
  JSON.stringify({ upstream: "018cd46565149877ee6822968a817932f7390ef8" }),
);
