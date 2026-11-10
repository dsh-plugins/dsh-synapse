import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { Routes, type Client } from "discord.js";
import { lookup } from "mime-types";
import type { QQSegment, QQSendOptions } from "./qq-send-queue.js";

const discordNoncePrefix = "synapse-file-";
const maxQqBytes = 64 * 1024 * 1024;
const maxDiscordBytes = 20_000_000;
const discordMediaTypes = new Set([
  "image/png", "image/apng", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/x-m4v", "video/quicktime", "video/webm",
]);
const mediaType = /^(image|video)\//;
const svgRoot = /^(?:\s|<\?xml[^?]*\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)*<svg(?:\s|\/?>)/i;

/** 已读取的交付文件，发送端据媒体类型选择聊天消息格式。 */
export interface Deliverable {
  name: string;
  contentType: string;
  data: Buffer;
}

interface QQBot {
  sendGroupMsg(id: string, message: QQSegment[], options: QQSendOptions): Promise<number | undefined>;
  sendPrivateMsg(id: string, message: QQSegment[], options: QQSendOptions): Promise<number | undefined>;
  uploadSynapseFile(type: "group" | "private", id: string, file: string, name: string, signal: AbortSignal): Promise<boolean>;
}

/** 从本轮交付事件给出的本地路径读取普通文件，限制单次读入的字节数。 */
export async function readDeliverable(file: string, platform: "qq" | "discord", signal: AbortSignal): Promise<Deliverable> {
  signal.throwIfAborted();
  if (!isAbsolute(file)) { throw new Error("交付文件路径无效"); }
  const entry = await lstat(file);
  if (!entry.isFile()) { throw new Error("交付路径已不再指向普通文件"); }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) { throw new Error("交付文件在打开前发生变化"); }
    const limit = platform === "discord" ? maxDiscordBytes : maxQqBytes;
    if (stat.size > limit) { throw new Error(`交付文件超过 ${platform === "discord" ? "20 MB" : "64 MiB"}`); }
    data = Buffer.allocUnsafe(stat.size);
    for (let offset = 0; offset < data.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) { throw new Error("交付文件在读取时发生变化"); }
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) { throw new Error("交付文件在读取时发生变化"); }
  } finally {
    await handle.close();
  }
  signal.throwIfAborted();
  const { fileTypeFromBuffer } = await import("file-type");
  const detected = await fileTypeFromBuffer(data);
  let name = basename(file);
  const inferred = lookup(name);
  const isSvg = (!detected || detected.mime === "application/xml") && svgRoot.test(data.toString("utf8", 0, 4096));
  const contentType = isSvg ? "image/svg+xml" : detected?.mime || inferred || "application/octet-stream";
  if (platform === "discord" && detected && mediaType.test(contentType) && inferred !== contentType && extname(name).toLowerCase() !== `.${detected.ext}`) {
    name += `.${detected.ext}`;
  }
  return { name, contentType, data };
}

/** 普通文件使用 OneBot 上传动作，图片和视频使用当前会话的媒体消息段。 */
export async function sendQQDeliverable(bot: QQBot, type: "group" | "private", id: string, file: Deliverable, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const payload = `base64://${file.data.toString("base64")}`;
  const media = mediaType.exec(file.contentType)?.[1];
  if (!media) {
    if (!await bot.uploadSynapseFile(type, id, payload, file.name, signal)) { throw new Error("OneBot 未确认文件上传成功"); }
    return;
  }
  const message = [{ type: media, data: { file: payload } }];
  const options = { localOnly: true, merge: false, signal };
  const messageId = type === "group" ? await bot.sendGroupMsg(id, message, options) : await bot.sendPrivateMsg(id, message, options);
  if (messageId === undefined) { throw new Error("OneBot 未确认媒体消息发送成功"); }
}

/** 使用原 Discord 频道发送原生媒体或普通附件，标记供桥接事件识别。 */
export async function sendDiscordDeliverable(rest: Pick<Client["rest"], "post">, channelId: string, file: Deliverable, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (mediaType.test(file.contentType) && !discordMediaTypes.has(file.contentType)) {
    throw new Error(`Discord 聊天媒体不支持 ${file.contentType}`);
  }
  const message = await rest.post(Routes.channelMessages(channelId), {
    body: { allowed_mentions: { parse: [] }, nonce: discordNoncePrefix + randomBytes(6).toString("hex"), enforce_nonce: true },
    files: [{ data: file.data, name: file.name, contentType: file.contentType }],
    signal,
  }) as { id?: string };
  if (!message.id) { throw new Error("Discord 未确认交付消息发送成功"); }
}

/** Discord 的自发消息回推可能早于发送回执，使用消息 nonce 阻止镜像。 */
export function isDiscordDeliverable(nonce: string | number | null): boolean {
  return typeof nonce === "string" && nonce.startsWith(discordNoncePrefix);
}
