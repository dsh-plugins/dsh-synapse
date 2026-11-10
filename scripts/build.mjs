import { build } from "esbuild";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { activityAdapter } from "./activity-adapter.mjs";
import { speechAdapter } from "./speech-adapter.mjs";
import { muteAdapter } from "./mute-adapter.mjs";
import { deliverablesAdapter } from "./deliverables-adapter.mjs";
const require = createRequire(import.meta.url);
const tsdownCli = path.join(
  path.dirname(require.resolve("tsdown/package.json")),
  "dist",
  "run.mjs",
);
await mkdir("lib", { recursive: true });
// Remove artifacts from the former standalone configuration UI on incremental builds.
for (const file of [
  "lib/host/panel.html",
  "lib/host/panel.js",
  "lib/host/panel.js.map",
  "lib/host/panel.d.ts",
])
  await rm(file, { force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")], {
  stdio: "inherit",
});
// Client bundle: tsdown wraps the ESM source in the __ModuleLoader__ shell.
execFileSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.client.json"],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [tsdownCli, "--config", "tsdown.client.config.mjs"],
  { stdio: "inherit" },
);
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
          if (file === path.join(vendor, "src", "index.ts")) {
            const replace = (from, to) => {
              if (!contents.includes(from)) {
                throw new Error(`QQ 发送队列适配锚点缺失：${from}`);
              }
              contents = contents.replace(from, to);
            };
            const replaceSection = (from, until, replacement) => {
              const start = contents.indexOf(from);
              const end = contents.indexOf(until, start + from.length);
              if (start < 0 || end < 0) {
                throw new Error(`QQ 发送队列适配区间缺失：${from}`);
              }
              contents = contents.slice(0, start) + replacement + contents.slice(end);
            };
            contents = `import { QQSendQueue } from ${JSON.stringify(path.resolve("src/qq-send-queue.ts"))};\nimport { getHermesConfig } from '@/features/hermes/config';\nimport { getGithubSubscribers } from '@/config/features';\n${contents}`;
            replace("  private operationQueue: (() => void)[] = [];", "  private readonly synapseSendQueue: QQSendQueue;");
            replace("  private lastOperationHandle = -1;\n", "");
            replace("    setInterval(() => this.handlerOperationQueue(this), 2000);", `    this.synapseSendQueue = new QQSendQueue({
      request: async (action, payload, signal, deliverable) => {
        const response = await this.axiosInstance.post('/' + action, payload, { signal, ...(deliverable ? { timeout: 120000 } : {}) });
        if (deliverable && (response.data?.status === 'failed' || String(response.data?.retcode) !== '0')) {
          throw new Error('OneBot 未确认交付发送成功：' + action);
        }
        if (response.data?.retcode && response.data.retcode !== 0) {
          throw new Error('OneBot 发送失败：' + (response.data.wording || response.data.message || response.data.retcode));
        }
        return response.data?.data?.message_id;
      },
      limits: () => getHermesConfig(),
      identity: () => this.getLoginInfo(),
      sent: event => this.notifyGroupMessageSent(event as GroupMessageSentEvent),
      onError: error => this.logger?.error('[Synapse] QQ 发送失败：' + String(error)),
    });`);
            replaceSection("  private handlerOperationQueue(", "  public listen<", `  private operation(func: () => void) {
    this.synapseSendQueue.operation(func);
  }

`);
            replaceSection("  public sendPrivateMsg(", "  /** 把调用方的 ForwardNode", `  public sendPrivateMsg(userID: string | number, message: SentMessage, options?: { merge?: boolean }): Promise<number | undefined> {
    return this.synapseSendQueue.send('private', userID, message, options);
  }

  public sendGroupMsg(groupId: string | number, message: SentMessage, options?: SendGroupMsgOptions): Promise<number | undefined> {
    return this.synapseSendQueue.send('group', groupId, message, options);
  }

  public sendGroupForwardMsg(groupId: string | number, nodes: ForwardNode[], options?: SendGroupMsgOptions): Promise<number | undefined> {
    return this.synapseSendQueue.send('group', groupId, nodes.map(node => QQBot.toForwardNodeMessage(node)), options);
  }

`);
            replace("  public stop(): QQBot {\n    this.stopping = true;", "  public stop(): QQBot {\n    this.stopping = true;\n    this.synapseSendQueue.close();");
            contents = contents.replace(
              "github.start(botConfig.githubPort);",
              `
        process.on('message', (message: any) => {
          if (message?.type === 'github') {
            if (getGithubSubscribers(message.payload.repository.full_name).length) {
              void github.post('github-' + message.event, bot, message.payload).catch(error => bot.logger?.error(error));
            }
          }
        });
        process.on('disconnect', () => process.exit(0));
        process.send?.({ type: 'ready' });`,
            );
          }
          if (file === path.join(vendor, "src", "config", "features.ts")) {
            const subscriberLookup = "  return getGithubConfig().groups[repository] || [];";
            if (!contents.includes(subscriberLookup)) {
              throw new Error("GitHub 仓库订阅查找适配锚点缺失");
            }
            contents = contents.replace(subscriberLookup, `  const key = repository.toLowerCase();
  const subscribers = Object.entries(getGithubConfig().groups)
    .filter(([name]) => name.toLowerCase() === key)
    .flatMap(([, groups]) => groups);
  return [...new Set(subscribers)];`);
          }
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
            const replaceSection = (from, until, replacement = "") => {
              const start = contents.indexOf(from);
              const end = contents.indexOf(until, start + from.length);
              if (start < 0 || end < 0) {
                throw new Error(`查询工具适配锚点缺失：${from}`);
              }
              contents = contents.slice(0, start) + replacement + contents.slice(end);
            };
            replaceSection("  /**\n   * 把一段发送任务挂到会话的串行链上", "  /** 等待串行链上全部发送完成", `  /** 同步提交发送任务，保存完成屏障以便本轮收尾等待。 */
  private enqueueSend(run: RunState | undefined, task: () => Promise<void>): Promise<void> {
    const next = task();
    if (run) {
      // QQ 队列负责发送顺序，此处等待本轮所有已提交的消息完成。
      run.sendChain = Promise.allSettled([run.sendChain, next]).then(() => undefined);
    }
    return next;
  }

`);
            replace("  /** 等待串行链上全部发送完成（finishRun 收尾与测试用） */", "  /** 等待本轮已提交的全部发送完成。 */");
            replaceSection("  /**\n   * 批量发送回复单元：整批作为串行链上的", "  private async sendReplyUnits(", "  /** 同步提交整批回复单元，由 QQ 会话队列保持顺序并合并待发消息。 */\n");
            replace("  /** 单条单元的实际发送（不做排队，仅供串行链内部调用） */", "  /** 提交单条回复单元，发送顺序由 QQ 会话队列保证。 */");
            replace("    // 整批入链（内部按序发完），避免与后续 flush 交错", "    // 同步提交整批单元，后续输出在 QQ 会话队列中继续合并。");
            replace("            // 整批入链，避免被随后到达的 delta flush 插队", "            // 同步提交整批文本，顺序由 QQ 会话队列保证。");
            replace(
              "      for (const unit of units) {\n        await this.sendSingleUnit(route, unit, replyMsgId, run);\n      }",
              "      await Promise.all(units.map(unit => this.sendSingleUnit(route, unit, replyMsgId, run)));",
            );
            replace(
              "    for (const chunk of chunks) {\n      if (route.type === 'group') {\n        await this.bot.sendGroupMsg(route.groupId!, [{ type: 'text', data: { text: chunk } }]);\n      } else {\n        await this.bot.sendPrivateMsg(route.userId, [{ type: 'text', data: { text: chunk } }]);\n      }\n    }",
              "    await Promise.all(chunks.map(chunk => route.type === 'group'\n      ? this.bot!.sendGroupMsg(route.groupId!, [{ type: 'text', data: { text: chunk } }])\n      : this.bot!.sendPrivateMsg(route.userId, [{ type: 'text', data: { text: chunk } }])));",
            );
            replace(
              "      for (const chunk of chunks) {\n        await this.bot.sendGroupMsg(route.groupId!, [\n          { type: 'reply', data: { id: userMsgId } },\n          { type: 'text', data: { text: chunk } }\n        ]);\n      }",
              "      await Promise.all(chunks.map(chunk => this.bot!.sendGroupMsg(route.groupId!, [\n        { type: 'reply', data: { id: userMsgId } },\n        { type: 'text', data: { text: chunk } }\n      ])));",
            );
            replace(
              "    // 无论发送成功与否都置位：避免失败时每条单元都重复贴引用\n    if (run && attachReply) run.replySent = true;\n",
              "",
            );
            replace(
              "    if (route.type === 'group') {\n      await this.bot.sendGroupMsg(route.groupId!, segments);",
              "    if (run && attachReply) { run.replySent = true; }\n    if (route.type === 'group') {\n      await this.bot.sendGroupMsg(route.groupId!, segments);",
            );
            replace(
              "        { type: 'text', data: { text: config.privateReceiptText } }\n      ]);",
              "        { type: 'text', data: { text: config.privateReceiptText } }\n      ], { merge: false });",
            );
            replace("import { SkillManager } from '@/features/hermes/skills';\n", "");
            replace("  private readonly skillManager = new SkillManager();\n", "");
            replace("import { Github } from '@/features/github';\n", "");
            replace("import { isGithubEnabledGroup } from '@/config/features';\n", "");
            replace("  GroupAdminApi,\n", "");
            replace(
              "buildConversationHistory, buildGroupContext, appendAutoCardNote",
              "buildConversationHistory, buildGroupContext",
            );
            replace("const RESERVED_LABEL_RE = /\\[SKILL:|MEDIA:/;", "const RESERVED_LABEL_RE = /MEDIA:/;");
            replaceSection(" * - 技能系统", " * - 触发 AI", " * - 查询与群管理使用 DSH 原生工具，模型在同一回合内组织工具结果；\n");
            replaceSection("  /** 查询技能结果回喂的最大轮数", "  /** 对话会话");
            replaceSection("  /**\n   * 统计消息中会被消息管道自动渲染卡片", "  /** 发送者展示名");
            replaceSection("  /** 技能执行用的群管理 API 门面 */", "  /** 解析群成员名称");
            replace(
              "const text = appendAutoCardNote(formatted.text, this.countAutoCardReferences(formatted.text, route));",
              "const text = formatted.text;",
            );
            contents = contents.replace(/^    \/\/ .*自动.*卡片.*(?:加注记|避免技能重复发卡).*\n/gm, "");
            replaceSection(
              "  /**\n   * 组装提示词、提交 Hermes 运行",
              "  private async startHermesRun(",
              "  /** 表情回应与回执保持到原生工具调用和最终回复全部结束。 */\n",
            );
            replace("      msg.message_id,\n      0,\n", "      msg.message_id,\n");
            replace("label, 0, 0, reactionKey", "label, 0, reactionKey");
            replace("    feedbackDepth: number = 0,\n", "");
            replace("    const isFeedback = feedbackDepth > 0;\n", "");
            replace("isFeedback || route.type === 'user'", "route.type === 'user'");
            replace("        feedbackDepth,\n", "");
            replace("    const skillsPrompt = this.skillManager.buildPrompt();\n", "");
            replace("[baseSystem, groupContext, skillsPrompt]", "[baseSystem, groupContext]");
            replace("    const sessionVersion = session.sessionVersion || 0;\n", "");
            replace("    // Hermes sessionId 按人区分；群聊/频道日志仍按群共享", "    // 群聊与桥接频道共用原生会话，私聊按用户区分。");
            replace("    // 组装系统提示词：configs/SOUL.md > systemPrompt > 空 + 群聊上下文 + 技能列表。", "    // 人设和当前对话者信息随本轮请求发送，工具定义由宿主注册。");
            replace("    // 构建用户提示词（私聊与回喂轮不带发言人前缀）", "    // 私聊直接使用正文，群聊标注当前发言人。");
            replaceSection("    // 回喂轮（工具数据）与私聊", "    const historyContent");
            replace("  /** 处理运行完成：发送最终回复，执行技能标签，处理 MEDIA 标签 */", "  /** 工具回合完成后发送最终回复并处理媒体。 */");
            replaceSection(
              "    // 「处理中」表情回应默认随本轮结束摘除",
              "  /** handleRunComplete 主体",
              `    try {
      await this.finishRun(run);
    } finally {
      if (run.reactionKey) {
        await this.removeReaction(run.reactionKey, run.route).catch(error => {
          this.bot?.logger?.warn('[Synapse] 移除表情回应失败: ' + (error as Error).message);
        });
      }
    }
  }

`,
            );
            replaceSection(
              "  /** handleRunComplete 主体",
              "  /** finishRun 主体",
              `  private async finishRun(run: RunState): Promise<void> {
    try {
      await this.finishRunBody(run);
    } finally {
      await this.recallReceiptOnce(run);
    }
  }

`,
            );
            replace("private async finishRunBody(run: RunState, markKeepReaction: () => void)", "private async finishRunBody(run: RunState)");
            replaceSection("    // 执行技能标签", "    // 记录回复对象");
            replace(
              "`group_${route.groupId}_user_${route.userId}`",
              "`group_${route.groupId}`",
            );
            replace(
              "private getSessionKey(route: RouteInfo): string {",
              `private async synapseContext(route: RouteInfo, label: string): Promise<Record<string, unknown>> {
    let name = label.endsWith(' (' + route.userId + ')') ? label.slice(0, -route.userId.length - 3) : label;
    if (route.type !== 'user') {
      name = '';
      try {
        const info = await this.callApi<{ group_name?: string }>('get_group_info', { group_id: Number(route.groupId) });
        name = info.group_name || '';
      } catch (error) {
        this.bot?.logger?.warn('[Synapse] 获取群名失败（' + route.groupId + '）: ' + (error as Error).message);
      }
    }
    return { type: route.type, userId: route.userId, groupId: route.groupId, name, admin: this.isRouteAdmin(route) };
  }
  private getSessionKey(route: RouteInfo): string {`,
            );
            replace(
              "sessionId: hermesSessionId,",
              "sessionId: hermesSessionId,\n        context: await this.synapseContext(route, senderLabel),",
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
            contents = contents
              .replace("interface SubmitRunParams {", "interface SubmitRunParams {\n  context?: Record<string, unknown>;")
              .replace("systemPrompt, conversationHistory }: SubmitRunParams", "systemPrompt, conversationHistory, context }: SubmitRunParams")
              .replace("if (sessionId) body.session_id = sessionId;", "if (sessionId) body.session_id = sessionId;\n    if (context) body.context = context;");
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
          contents = activityAdapter(contents, file, vendor);
          contents = speechAdapter(contents, file, vendor);
          contents = muteAdapter(contents, file, vendor);
          contents = deliverablesAdapter(contents, file, vendor);
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
