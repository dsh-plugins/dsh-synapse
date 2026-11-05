import type { ChatRoute, VoiceReceipt, VoiceSender } from "./types.js";
import { Routes, type Client } from "discord.js";

/** 复用 Discord 已登录的 REST 连接，频道缓存和群绑定共同限制发送目标。 */
export async function sendDiscordVoice(client: Client | undefined, route: ChatRoute, audio: Buffer, signal: AbortSignal, groupForChannel: (guildId: string, name: string) => string | undefined): Promise<VoiceReceipt> {
  signal.throwIfAborted();
  if (!client?.isReady()) { throw new Error("Discord 客户端尚未就绪"); }
  const channel = client.channels.cache.get(route.channelId);
  if (!channel || !("guildId" in channel) || !("name" in channel)) { throw new Error("Discord 频道不可用"); }
  if (groupForChannel(channel.guildId, channel.name) !== route.groupId) { throw new Error("Discord 频道与群聊绑定不匹配"); }
  const message = await client.rest.post(Routes.channelMessages(route.channelId), {
    body: { allowed_mentions: { parse: [] } },
    files: [{ data: audio, name: "voice.mp3", contentType: "audio/mpeg" }], signal,
  }) as { id?: string };
  if (!message.id) { throw new Error("Discord 未返回消息 ID"); }
  return { platform: "discord", messageId: message.id };
}

/** 子进程通过已有 QQ 队列或 Discord 连接发送音频，不接收任意文件路径或 URL。 */
export async function deliverVoice(bot: any, route: ChatRoute, base64: string, signal: AbortSignal, discord?: VoiceSender): Promise<VoiceReceipt> {
  signal.throwIfAborted();
  if (typeof base64 !== "string" || base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("语音音频数据无效");
  }
  const audio = Buffer.from(base64, "base64");
  if (!audio.length || audio.length > 10 * 1024 * 1024) { throw new Error("语音音频大小无效"); }
  const validId = (id: unknown) => typeof id === "string" && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  if (!route || !["group", "user", "discord"].includes(route.type)) { throw new Error("语音发送路由无效"); }
  if (route.type === "discord") {
    if (!discord || !route.channelId || !/^\d+$/.test(route.channelId) || !validId(route.groupId)) { throw new Error("Discord 语音频道不可用"); }
    try { return await discord(route, audio, signal); }
    catch { signal.throwIfAborted(); throw new Error("Discord 未确认音频发送，请检查 Bot 日志；请求可能已送达，勿直接重试"); }
  }
  const id = route.type === "group" ? route.groupId : route.userId;
  if (!validId(id)) { throw new Error("语音发送目标无效"); }
  const message = [{ type: "record", data: { file: `base64://${base64}` } }];
  const options = { merge: false, signal };
  const messageId = route.type === "group"
    ? await bot.sendGroupMsg(Number(id), message, options)
    : await bot.sendPrivateMsg(Number(id), message, options);
  signal.throwIfAborted();
  if (!Number.isSafeInteger(messageId)) { throw new Error("OneBot 未确认语音发送，请检查 Bot 日志；请求可能已送达，勿直接重试"); }
  return { platform: "qq", messageId };
}

/** IPC 取消同时覆盖排队与发送；进程退出由 Bot 生命周期统一处理。 */
export function attachSpeech(bot: any, discord: VoiceSender): void {
  const tasks = new Map<string, AbortController>();
  const reply = (payload: object) => {
    if (process.connected) { process.send?.(payload, error => { if (error) { bot.logger?.warn("[Synapse] 语音发送回执的 IPC 通知失败"); } }); }
  };
  process.on("message", (message: any) => {
    if (message?.type === "voice-cancel") { tasks.get(message.id)?.abort(new Error("语音发送已取消")); }
    if (message?.type !== "voice-send" || typeof message.id !== "string" || tasks.has(message.id)) { return; }
    const controller = new AbortController();
    tasks.set(message.id, controller);
    void deliverVoice(bot, message.route, message.audio, controller.signal, discord).then(
      receipt => reply({ type: "voice-result", id: message.id, receipt }),
      error => {
        bot.logger?.warn(`[Synapse] 语音发送失败：${error instanceof Error ? error.message : "未知错误"}`);
        reply({ type: "voice-result", id: message.id, error: "语音未确认发送成功，请检查 Bot 日志；请求可能已送达，勿直接重试" });
      },
    ).finally(() => tasks.delete(message.id));
  });
}
