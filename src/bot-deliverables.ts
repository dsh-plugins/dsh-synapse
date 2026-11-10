import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { isAxiosError, type AxiosInstance } from "axios";
import { Routes, type Client } from "discord.js";
import { lookup } from "mime-types";
import type { QQDelivery, QQDeliveryReceipt } from "./qq-send-queue.js";

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
  deliverSynapseFile(type: "group" | "private", id: string, delivery: QQDelivery, signal: AbortSignal): Promise<QQDeliveryReceipt>;
}

/** OneBot 的明确成功回执足以确认交付，连接中断或异步处理只说明结果未知。 */
export async function sendOneBotDeliverable(api: Pick<AxiosInstance, "post">, action: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<QQDeliveryReceipt> {
  signal.throwIfAborted();
  let response;
  try {
    response = await api.post(`/${action}`, payload, { signal, timeout: 120000, maxRedirects: 0, validateStatus: () => true });
  } catch (error) {
    const code = isAxiosError(error) && /^[A-Z0-9_]+$/.test(error.code ?? "") ? `（${error.code}）` : "";
    return { status: "unconfirmed", reason: `OneBot ${action} 未收到完整回执${code}` };
  }
  if (response.status < 200 || response.status >= 300) {
    const status = response.status >= 400 && response.status < 500 && response.status !== 408 ? "failed" : "unconfirmed";
    return { status, reason: `OneBot ${action} 返回 HTTP ${response.status}` };
  }
  const data = response.data;
  const rawCode = data?.retcode;
  const code = typeof rawCode === "string" && /^-?\d+$/.test(rawCode) ? Number(rawCode) : rawCode;
  const status = data?.status;
  const reason = `OneBot ${action} 回执${Number.isSafeInteger(code) ? `（retcode ${code}）` : ""}`;
  if ((status === "ok" && (code === 0 || rawCode === undefined)) || (status === undefined && code === 0)) {
    return { status: "sent" };
  }
  const wording = [data?.message, data?.wording];
  const unclear = wording.some(value => typeof value === "string" && /timeout|timed out|超时|EventChecker Failed/i.test(value));
  if (unclear || code === 1200 || code === 1 || status === "async" || status === "ok" || code === 0) {
    return { status: "unconfirmed", reason: `${reason}未确认送达` };
  }
  if (status === "failed" || (status === undefined && Number.isSafeInteger(code))) {
    return { status: "failed", reason: `${reason}拒绝发送` };
  }
  return { status: "unconfirmed", reason: `${reason}缺少有效状态` };
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
export async function sendQQDeliverable(bot: QQBot, type: "group" | "private", id: string, file: Deliverable, signal: AbortSignal): Promise<QQDeliveryReceipt> {
  signal.throwIfAborted();
  const payload = `base64://${file.data.toString("base64")}`;
  const media = mediaType.exec(file.contentType)?.[1];
  const delivery: QQDelivery = media === "image" || media === "video" ? { type: media, file: payload } : { type: "file", file: payload, name: file.name };
  return bot.deliverSynapseFile(type, id, delivery, signal);
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
