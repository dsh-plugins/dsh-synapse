import path from "node:path";

/** 语音发送复用 Bot 连接和 QQ 队列，构建时接入固定上游源码。 */
export function speechAdapter(contents, file, vendor) {
  const replace = (from, to) => {
    if (!contents.includes(from)) { throw new Error(`语音适配锚点缺失：${from}`); }
    contents = contents.replace(from, to);
  };
  if (file === path.join(vendor, "src", "index.ts")) {
    contents = `import { attachSpeech } from ${JSON.stringify(path.resolve("src/bot-speech.ts"))};\nimport { DiscordBridge as SynapseDiscordBridge } from '@/features/discord-bridge';\n${contents}`;
    replace("await synapseActivity.attach(bot);", "await synapseActivity.attach(bot);\n        attachSpeech(bot, (route, audio, signal) => SynapseDiscordBridge.getInstance().synapseVoice(route, audio, signal));");
    replace("options?: { merge?: boolean }", "options?: { merge?: boolean; signal?: AbortSignal }");
    replace("export interface SendGroupMsgOptions {", "export interface SendGroupMsgOptions {\n  merge?: boolean;\n  signal?: AbortSignal;");
  }
  if (file.endsWith(path.join("discord-bridge", "index.ts"))) {
    contents = `import { sendDiscordVoice } from ${JSON.stringify(path.resolve("src/bot-speech.ts"))};\nimport type { ChatRoute } from ${JSON.stringify(path.resolve("src/types.ts"))};\n${contents}`;
    replace("  private constructor() {}", `  /** 使用当前频道与群绑定发送语音附件。 */
  public async synapseVoice(route: ChatRoute, audio: Buffer, signal: AbortSignal) {
    return sendDiscordVoice(this.client, route, audio, signal, (guildId, name) => this.resolveByChannel(guildId, name)?.entry.group);
  }

  private constructor() {}`);
  }
  if (file.endsWith(path.join("hermes", "index.ts"))) {
    replace("groupId: route.groupId, name, admin:", "groupId: route.groupId, channelId: route.channelId, name, admin:");
    replace("        'run.completed': ev => {", "        'voice.sent': () => { runState.synapseVoiceSent = true; },\n        'run.completed': ev => {");
    replace("    if (!output?.trim()) {", "    if (run.synapseVoiceSent && !output?.trim()) { await this.recallReceiptOnce(run); return; }\n    if (!output?.trim()) {");
    contents = contents.replaceAll("(!run.finalOutput && !run.messageDelta)", "(!run.finalOutput && !run.messageDelta && !run.synapseVoiceSent)");
  }
  if (file.endsWith(path.join("hermes", "types.ts"))) {
    replace("export interface RunState {", "export interface RunState {\n  synapseVoiceSent?: boolean;");
    replace("export interface HermesEventCallbacks {", "export interface HermesEventCallbacks {\n  'voice.sent'?: (event: Record<string, unknown>) => void;");
  }
  return contents;
}
