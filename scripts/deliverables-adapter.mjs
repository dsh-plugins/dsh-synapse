import path from "node:path";

/** 接入当前聊天路由，并在本轮收尾时发送 DSH 确认交付的文件。 */
export function deliverablesAdapter(contents, file, vendor) {
  const replace = (from, to) => {
    if (!contents.includes(from)) { throw new Error(`交付适配锚点缺失：${from}`); }
    contents = contents.replaceAll(from, to);
  };
  const sender = JSON.stringify(path.resolve("src/bot-deliverables.ts"));
  if (file === path.join(vendor, "src", "index.ts")) {
    replace("  public sendPrivateMsg(", `  public uploadSynapseFile(type: 'group' | 'private', id: string, file: string, name: string, signal: AbortSignal): Promise<boolean> {
    return this.synapseSendQueue.upload(type, id, file, name, signal);
  }

  public sendPrivateMsg(`);
  }
  if (file.endsWith(path.join("hermes", "types.ts"))) {
    contents = `import type { Deliverable } from ${sender};\n${contents}`;
    replace("  sendImage(base64: string): Promise<void>;", "  sendImage(base64: string): Promise<void>;\n  sendDeliverable(file: Deliverable, signal: AbortSignal): Promise<void>;");
    replace("  finalOutput: string;", "  finalOutput: string;\n  synapsePresented?: string[];\n  synapseDelivery?: AbortController;");
    replace("  output: string;\n}", "  output: string;\n  presented?: string[];\n}");
    replace("  error: string;\n}", "  error: string;\n  presented?: string[];\n}");
  }
  if (file.endsWith(path.join("discord-bridge", "index.ts"))) {
    contents = `import { isDiscordDeliverable, sendDiscordDeliverable } from ${sender};\n${contents}`;
    replace("        sendImage: async base64 => {", `        sendDeliverable: (file, signal) => sendDiscordDeliverable(channel.client.rest, channel.id, file, signal),
        sendImage: async base64 => {`);
    replace("private async handleOwnDiscordMessage(message: DiscordMessage, bridge: ResolvedBridge): Promise<void> {", "private async handleOwnDiscordMessage(message: DiscordMessage, bridge: ResolvedBridge): Promise<void> {\n    if (isDiscordDeliverable(message.nonce)) { return; }");
  }
  if (file.endsWith(path.join("hermes", "index.ts"))) {
    contents = `import { readDeliverable, sendQQDeliverable } from ${sender};\n${contents}`;
    replace("          runState.synapseTerminal = true;", "          runState.synapseTerminal = true;\n          runState.synapsePresented = ev.presented;");
    replace("(!run.finalOutput && !run.messageDelta && !run.synapseVoiceSent)", "(!run.finalOutput && !run.messageDelta && !run.synapseVoiceSent && !run.synapsePresented?.length)");
    replace("    if (run.synapseVoiceSent && !output?.trim())", "    if ((run.synapseVoiceSent || run.synapsePresented?.length) && !output?.trim())");
    replace("    if (!run) return;\n    this.activeRuns.delete(runId);", `    if (!run || run.synapseDelivery) { return; }
    if (run.synapsePresented?.length) { run.synapseDelivery = new AbortController(); }
    else { this.activeRuns.delete(runId); }`);
    replace("      if (run.synapseRunId)", "      this.activeRuns.delete(runId);\n      if (run.synapseRunId)");
    replace("    if (!run || run.sendingProgress) return;", "    if (!run || run.sendingProgress || run.synapseDelivery) { return; }");
    replace("        await this.hermes.stopRun(runId);\n        await this.sendReply(route,", `        if (run.synapseDelivery) { run.synapseDelivery.abort(); }
        else { await this.hermes.stopRun(runId); }
        await this.sendReply(route,`);
    replace("      await this.recallReceiptOnce(run);\n    }\n  }\n\n  /** finishRun 主体", `      try { await this.sendPresented(run); }
      finally { await this.recallReceiptOnce(run); }
    }
  }

  private async sendPresented(run: RunState): Promise<void> {
    const bot = this.bot;
    const route = run.route;
    if (!run.synapsePresented?.length || !bot || !run.synapseDelivery) { return; }
    const delivery = route.synapseSignal ? AbortSignal.any([run.synapseDelivery.signal, route.synapseSignal]) : run.synapseDelivery.signal;
    let failed = 0;
    for (const file of run.synapsePresented) {
      if (delivery.aborted) { run.synapseSendFailed = true; return; }
      const signal = AbortSignal.any([delivery, AbortSignal.timeout(120000)]);
      try {
        const item = await readDeliverable(file, route.type === 'discord' ? 'discord' : 'qq', signal);
        if (route.type === 'discord') {
          await route.discord!.sendDeliverable(item, signal);
        } else {
          const type = route.type === 'group' ? 'group' : 'private';
          await sendQQDeliverable(bot, type, route.type === 'group' ? route.groupId! : route.userId, item, signal);
        }
      } catch (error) {
        if (delivery.aborted) { run.synapseSendFailed = true; return; }
        failed++;
        bot.logger?.warn('[Synapse] 交付文件发送失败（' + route.type + '）：' + (error as Error).message);
      }
    }
    if (failed) {
      run.synapseSendFailed = true;
      await this.sendReplyWithMention(route, '有 ' + failed + ' 个交付文件发送失败。', run.userMsgId);
    }
  }

  /** finishRun 主体`);
  }
  return contents;
}
