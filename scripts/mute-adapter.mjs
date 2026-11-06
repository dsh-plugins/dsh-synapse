import path from "node:path";

/** 固定上游通过构建接入禁言缓存、连接清理与回复取消信号。 */
export function muteAdapter(contents, file, vendor) {
  const replace = (from, to) => {
    if (!contents.includes(from)) { throw new Error(`禁言适配锚点缺失：${from}`); }
    contents = contents.replaceAll(from, to);
  };
  if (file === path.join(vendor, "src", "index.ts")) {
    contents = `import { QQMute } from ${JSON.stringify(path.resolve("src/qq-mute.ts"))};\n${contents}`;
    replace("  private readonly synapseSendQueue: QQSendQueue;", "  private readonly synapseSendQueue: QQSendQueue;\n  public readonly synapseMute: QQMute;");
    replace("    this.synapseSendQueue = new QQSendQueue({", `    this.synapseMute = new QQMute({
      identity: () => this.getLoginInfo(),
      request: async (action, params, signal) => {
        const response = await this.axiosInstance.post('/' + action, params, { signal });
        if (response.data?.status === 'failed' || Number(response.data?.retcode || 0) !== 0) {
          throw new Error('OneBot 禁言查询失败：' + action);
        }
        return response.data?.data;
      },
      changed: (groupId, blocked) => {
        this.logger?.info('[Synapse] 群 ' + groupId + (blocked ? ' 禁言生效，取消当前回复与待发消息' : ' 已解除禁言'));
      },
      cancel: (groupId, throughGeneration) => { this.synapseSendQueue.discardAbortedGroup(groupId); synapseActivity.muted(groupId, throughGeneration); },
    });
    this.synapseSendQueue = new QQSendQueue({
      canSendGroup: groupId => this.synapseMute.canSend(groupId),`);
    replace("      canSendGroup: groupId => this.synapseMute.canSend(groupId),", "      canSendGroup: groupId => this.synapseMute.canSend(groupId),\n      groupSignal: groupId => this.synapseMute.replySignal(groupId),");
    replace("bot.ws.on('open', () => {", "bot.ws.on('open', () => {\n      bot.synapseMute.clear();");
    replace("bot.ws.on('error', (error: Error) => {", "bot.ws.on('error', (error: Error) => {\n      bot.synapseMute.clear();");
    replace("bot.ws.on('close', (code: number, reason: Buffer) => {", "bot.ws.on('close', (code: number, reason: Buffer) => {\n      bot.synapseMute.clear();");
    replace("    let eventName = 'unknown-event';", `    if (msg.post_type === 'notice') {
      void bot.synapseMute.notice(msg).catch(error => bot.logger?.warn('[Synapse] 禁言事件处理失败：' + (error as Error).message));
    }
    let eventName = 'unknown-event';`);
    replace("    this.synapseSendQueue.close();", "    this.synapseMute.close();\n    this.synapseSendQueue.close();");
    replace("if (message?.type === 'github')", `if (message?.type === 'group-send-check') {
            void Promise.resolve().then(() => bot.synapseMute.canSend(String(message.groupId))).then(
              allowed => process.send?.({ type: 'group-send-result', id: message.id, allowed }),
              () => process.send?.({ type: 'group-send-result', id: message.id, error: 'OneBot 禁言状态查询失败' }),
            );
          }
          if (message?.type === 'github')`);
  }
  if (file.endsWith(path.join("hermes", "types.ts"))) {
    replace("export interface RouteInfo {", "export interface RouteInfo {\n  synapseSignal?: AbortSignal;\n  synapseGeneration?: number;");
  }
  if (file.endsWith(path.join("hermes", "index.ts"))) {
    replace("private async synapseGroupSend(groupId: string | number,", "private async synapseGroupSend(route: RouteInfo,");
    replace("this.bot!.sendGroupMsg(groupId, message);", "this.bot!.sendGroupMsg(route.groupId!, message, { signal: route.synapseSignal });");
    replace("this.synapseGroupSend(route.groupId!,", "this.synapseGroupSend(route,");
    replace("{ name: getHermesConfig().botName, uin: login.user_id, content: text }\n    ]);", "{ name: getHermesConfig().botName, uin: login.user_id, content: text }\n    ], { signal: route.synapseSignal });");
    replace("    const key = this.getSessionKey(route);\n    const task = (this.synapseIngress", "    if (route.type === 'group') { route.synapseSignal = this.bot!.synapseMute.replySignal(route.groupId!); route.synapseGeneration = this.bot!.synapseMute.replyGeneration(route.groupId!); }\n    const key = this.getSessionKey(route);\n    const task = (this.synapseIngress");
    replace("return { type: route.type, userId: route.userId,", "return { muteGeneration: route.synapseGeneration, type: route.type, userId: route.userId,");
    replace("    try {\n      const { runId } = await this.hermes.submitRun({", `    try {
      if (route.type === 'group') {
        if (!await bot.synapseMute.canSend(route.groupId!)) { throw new Error('Bot 当前被禁言'); }
        route.synapseSignal?.throwIfAborted();
      }
      const { runId } = await this.hermes.submitRun({
        signal: route.synapseSignal,`);
    replace("      bot.logger?.info(`[Hermes] run 已提交: ${runId}`);", `      if (route.synapseSignal?.aborted) { await this.hermes.stopRun(runId); throw route.synapseSignal.reason; }
      bot.logger?.info('[Hermes] run 已提交: ' + runId);`);
    replace("if (!synapse?.automatic) { await this.sendReplyWithMention", "if (!synapse?.automatic && !route.synapseSignal?.aborted) { await this.sendReplyWithMention");
    replace("  private async finishRunBody(run: RunState): Promise<void> {", "  private async finishRunBody(run: RunState): Promise<void> {\n    if (run.route.synapseSignal?.aborted) { run.synapseSendFailed = true; await this.drainSends(run); return; }");
    replace("        'message.delta': ev => {", "        'message.delta': ev => {\n          if (route.synapseSignal?.aborted) { return; }");
  }
  if (file.endsWith(path.join("hermes", "client.ts"))) {
    replace("interface SubmitRunParams {", "interface SubmitRunParams {\n  signal?: AbortSignal;");
    replace("conversationHistory, context }: SubmitRunParams", "conversationHistory, context, signal }: SubmitRunParams");
    replace("fetch(`${this.baseUrl}/v1/runs`, {", "fetch(`${this.baseUrl}/v1/runs`, {\n      signal,");
  }
  return contents;
}
