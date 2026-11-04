import path from "node:path";

/** AI 专用群消息入口保持上游命令、卡片及桥接钩子不变。 */
export function activityAdapter(contents, file, vendor) {
  const replace = (from, to) => {
    if (!contents.includes(from)) { throw new Error(`群状态适配锚点缺失：${from}`); }
    contents = contents.replaceAll(from, to);
  };
  const helper = `import { botActivity } from ${JSON.stringify(path.resolve("src/bot-activity.ts"))};\nconst synapseActivity = botActivity(getHermesConfig);\n`;
  if (file === path.join(vendor, "src", "index.ts")) {
    contents = helper + contents;
    replace("sent: event => this.notifyGroupMessageSent(event as GroupMessageSentEvent),", "sent: event => { this.notifyGroupMessageSent(event as GroupMessageSentEvent); synapseActivity.sent(event.groupId); },");
    replace("process.send?.({ type: 'ready' });", "await synapseActivity.attach(bot);\n        process.send?.({ type: 'ready' });");
  }
  if (file.endsWith(path.join("hermes", "index.ts"))) {
    contents = helper + contents;
    replace("this.bot.sendGroupMsg(", "this.synapseGroupSend(");
    replace("this.bot!.sendGroupMsg(", "this.synapseGroupSend(");
    replace("    if (config.blockedUsers.includes(uid)) return false;", "    if (synapseActivity.ignored(route.userId, config.blockedUsers)) return false;");
    replace("  private constructor() {}", `  private async synapseGroupSend(groupId: string | number, message: Parameters<QQBot['sendGroupMsg']>[1]): Promise<number> {
    const id = await this.bot!.sendGroupMsg(groupId, message);
    if (id === undefined) { throw new Error('OneBot 没有确认群消息发送成功'); }
    return id;
  }

  private constructor() {
    synapseActivity.onIdle = async event => {
      const bot = synapseActivity.bot as QQBot;
      if (!bot) { throw new Error('Bot 尚未就绪'); }
      this.bot = bot;
      const route: RouteInfo = { type: 'group', groupId: event.groupId, userId: event.selfId };
      await this.queueSynapse(route, () => this.startHermesRun(bot, route, '好久没在群里说话了，说点什么吧', [], '系统（非管理员）', 0, undefined, undefined, { triggerId: event.triggerId, automatic: true, source: 'idle' }));
    };
  }

  private async handleSynapseGroup(bot: QQBot, msg: GroupMessageWSMSG): Promise<void> {
    this.bot = bot;
    const route: RouteInfo = { type: 'group', groupId: String(msg.group_id), userId: String(msg.user_id) };
    const rawText = this.extractText(msg.message);
    if (/^\\/synapse(?:\\s|$)/i.test(rawText)) {
      try { await this.sendReply(route, await synapseActivity.command(route.groupId!, route.userId, rawText)); }
      catch (error) { await this.sendReply(route, '❌ ' + (error as Error).message); }
      return;
    }
    if (!getHermesConfig().groups.includes(Number(route.groupId)) || synapseActivity.ignored(route.userId)) { return; }
    if (this.canChat(route) && rawText && await this.handleApprovalReply(route, rawText, msg.message_id)) { return; }
    const control = this.canChat(route) && decideGroupTrigger({ text: rawText, mentioned: this.hasAtSelf(msg.message), requireMention: getHermesConfig().requireMention, keywordTriggers: getHermesConfig().keywordTriggers }).triggered;
    if (control && isStopCommand(rawText)) { await this.handleStopCommand(route); return; }
    if (control && isResetCommand(rawText)) {
      const version = await this.clearSession(route);
      await this.sendReplyWithMention(route, '✅ 上下文已清除，开始新对话 (v' + version + ')', msg.message_id);
      return;
    }
    // 原始事件先提交；图片下载不会堵住后续真人活跃通知。
    const observation = synapseActivity.observe(msg);
    await this.queueSynapse(route, async () => {
      const result = await observation;
      if (!result.triggered) { return; }
      let reactionKey: string | undefined;
      if (!result.automatic) { reactionKey = await this.reactions.addQQ(bot, msg.message_id) ?? undefined; }
      await this.startHermesRun(bot, route, '[由宿主展开群聊消息]', [], this.senderLabel(msg.sender, route.userId), msg.message_id, reactionKey, undefined,
        { observationId: result.seq, triggerId: result.triggerId, automatic: result.automatic });
    });
  }`);
    replace("    const next = task();", "    const next = task().catch(error => { if (run) { run.synapseSendFailed = true; } throw error; });");
    replace("      await this.finishRunBody(run);\n    } finally {", "      await this.finishRunBody(run);\n    } catch (error) { run.synapseSendFailed = true; throw error; } finally {");
    replace("          this.bot?.logger?.error(`[Hermes] 文本发送错误: ${(error as Error).message}`);", "          runState.synapseSendFailed = true;\n          this.bot?.logger?.error(`[Hermes] 文本发送错误: ${(error as Error).message}`);");
    replace("    // 防自环：NapCat 配置回报自身消息时直接忽略\n    if (msg.user_id === msg.self_id) return;", "    // 防自环：NapCat 配置回报自身消息时直接忽略\n    if (msg.user_id === msg.self_id) return;\n    if (msg.message_type === 'group') { await this.handleSynapseGroup(bot, msg); return; }");
    replace("    receiptId?: number\n  ): Promise<void> {", "    receiptId?: number,\n    synapse?: { observationId?: number; triggerId?: string; automatic?: boolean; source?: string }\n  ): Promise<void> {");
    replace("context: await this.synapseContext(route, senderLabel),", "context: { ...await this.synapseContext(route, senderLabel), ...synapse, ...(synapse?.source === 'idle' ? { admin: false } : {}) },");
    replace("conversationHistory: buildConversationHistory(session.history.slice(0, -1), route.userId)", "conversationHistory: route.type === 'group' ? [] : buildConversationHistory(session.history.slice(0, -1), route.userId)");
    replace("const groupContext = route.type === 'user' ? '' : buildGroupContext(route, senderLabel);", "const groupContext = synapse?.source === 'idle' ? '当前为系统定时触发的群聊空闲事件（非管理员权限），请结合近期群聊背景自然地开启话题。' : route.type === 'user' ? '' : buildGroupContext(route, senderLabel);");
    replace("      const runState: RunState = {\n        route,", "      const runState: RunState = {\n        synapseRunId: runId, synapseAutomatic: Boolean(synapse?.automatic),\n        route,");
    replace("      await this.sendReplyWithMention(route, `❌ 调用 Hermes 失败: ${(error as Error).message}`, replyMsgId);", "      if (!synapse?.automatic) { await this.sendReplyWithMention(route, `❌ 调用 Hermes 失败: ${(error as Error).message}`, replyMsgId); }\n      if (synapse?.automatic) { throw error; }");
    replace("      bot.logger?.error(`[Hermes] 提交错误: ${(error as Error).message}`);", "      bot.logger?.error(`[Hermes] 提交错误: ${(error as Error).message}`);\n      if (synapse?.observationId || synapse?.triggerId) { await synapseActivity.request('abandon', { observationId: synapse.observationId, triggerId: synapse.triggerId }).catch(error => bot.logger?.warn('[Synapse] 释放待提交消息失败: ' + (error as Error).message)); }");
    replace("    try {\n      await this.finishRun(run);\n    } finally {", "    try {\n      await this.finishRun(run);\n    } finally {\n      if (run.synapseRunId) { await synapseActivity.finished(run.synapseRunId, Boolean(run.failed || run.synapseSendFailed || (!run.finalOutput && !run.messageDelta))).catch(() => this.bot?.logger?.warn('[Synapse] 收尾通知未确认，宿主将继续重试')); }");
    replace("  private async finishRunBody(run: RunState): Promise<void> {", "  private async finishRunBody(run: RunState): Promise<void> {\n    if (run.synapseAutomatic && (run.failed || (!run.finalOutput && !run.messageDelta))) { await this.drainSends(run); return; }");
    replace("        'run.completed': ev => {", "        'run.completed': ev => {\n          runState.synapseTerminal = true;");
    replace("        'run.failed': ev => {", "        'run.failed': ev => {\n          runState.synapseTerminal = true;");
    replace("        _end: () => {\n          void this.handleRunComplete(runId);", "        _end: () => {\n          if (!runState.synapseTerminal) {\n            runState.failed = true; runState.finalOutput = '❌ 执行失败: 运行事件流意外结束';\n            void this.hermes.stopRun(runId).catch(() => bot.logger?.warn('[Synapse] 事件流结束后取消任务失败'));\n          }\n          void this.handleRunComplete(runId);");
    replace("        _error: () => {\n          void this.handleRunComplete(runId);", "        _error: () => {\n          runState.failed = true; runState.finalOutput = '❌ 执行失败: 运行事件流中断';\n          void this.hermes.stopRun(runId).catch(() => bot.logger?.warn('[Synapse] 事件流中断后取消任务失败'));\n          void this.handleRunComplete(runId);");
  }
  if (file.endsWith(path.join("hermes", "types.ts"))) {
    replace("export interface RunState {", "export interface RunState {\n  synapseRunId?: string;\n  synapseAutomatic?: boolean;\n  synapseSendFailed?: boolean;\n  synapseTerminal?: boolean;");
  }
  if (file.endsWith(path.join("hermes", "client.ts"))) {
    replace("const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };", "const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Synapse-Bot': process.env.SYNAPSE_BOT_EPOCH || '', ...extra };");
  }
  return contents;
}
