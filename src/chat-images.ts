import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, safePath } from "./files.js";
import type { ChatState, ImageReference } from "./chat-state.js";
import type { ConfigSource, PluginPaths } from "./types.js";

export const withoutUrls = (text: string): string => text.replace(/(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\s<>]+/gi, " ");
const decodeCQ = (value: string) => value.replaceAll("&#44;", ",").replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&amp;", "&");

function segments(message: unknown): any[] {
  if (Array.isArray(message)) { return message; }
  if (typeof message !== "string") { return []; }
  const result = [];
  let start = 0;
  for (const match of message.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
    result.push({ type: "text", data: { text: decodeCQ(message.slice(start, match.index)) } });
    const data = Object.fromEntries(match[2].split(",").filter(Boolean).map(part => {
      const i = part.indexOf("=");
      return [part.slice(0, i), decodeCQ(part.slice(i + 1))];
    }));
    result.push({ type: match[1], data });
    start = match.index + match[0].length;
  }
  result.push({ type: "text", data: { text: decodeCQ(message.slice(start)) } });
  return result;
}

/** 从原始 QQ 正文提取词频输入与附件引用；引用他人的正文不参与活跃或词频。 */
export function groupContent(message: unknown, selfId: string) {
  const images: ImageReference[] = [];
  const raw: string[] = [];
  const body: string[] = [];
  let ordinaryImage = false, count = 0;
  const visit = (input: unknown, depth = 0) => {
    for (const segment of segments(input)) {
      if (++count > 500 || depth > 3) { break; }
      const data = segment?.data ?? {};
      if (segment?.type === "text") {
        const text = String(data.text ?? "").slice(0, 64000);
        body.push(text);
        if (depth === 0) { raw.push(text); }
      } else if (["image", "mface", "bface"].includes(segment?.type)) {
        const face = segment.type !== "image" || Number(data.sub_type ?? data.subType ?? 0) !== 0;
        const image: ImageReference = { id: randomUUID(), source: String(data.url || data.file || ""), face, state: "pending" };
        images.push(image);
        if (!face && depth === 0) { ordinaryImage = true; }
        body.push(`[${face ? "图片表情" : "图片"}待处理:${image.id}]`);
      } else if (segment?.type === "face") {
        body.push(`[QQ 表情 ${String(data.id ?? "未知")}]`);
      } else if (segment?.type === "at" && String(data.qq) !== selfId) {
        body.push(`@${String(data.qq)}`);
      } else if (segment?.type === "reply") {
        body.push(`[引用消息 ${String(data.id ?? "")}]`);
      } else if (segment?.type === "node") {
        body.push("[引用聊天记录]");
        visit(data.content, depth + 1);
      } else if (segment?.type === "forward") {
        body.push(`[聊天记录 ${String(data.id ?? "")}]`);
      }
    }
  };
  visit(message);
  const rawText = raw.join("").slice(0, 64000).trim();
  const text = body.join("").slice(0, 100000).trim();
  const command = /^[\/!！]/.test(rawText);
  const human = !command && (ordinaryImage || /[\p{L}\p{N}]/u.test(withoutUrls(rawText)));
  return { rawText, text, images, command, human };
}

function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { return "png"; }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { return "jpg"; }
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) { return "gif"; }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") { return "webp"; }
  throw new Error("附件不是标准读图工具支持的 PNG、JPEG、GIF 或 WebP");
}

/** 原始字节缓存避免本机图像解码依赖，所有输入只留下可按需读取的绝对路径。 */
export class ChatImages {
  private tasks = new Map<number, Promise<void>>();
  private shutdown = new AbortController();
  private root: string;
  private files = new Map<string, Promise<unknown>>();
  constructor(private paths: PluginPaths, private state: ChatState, private config: ConfigSource, private now = Date.now) {
    this.root = path.join(paths.data, "temp", "imgs");
  }

  async start() {
    await safePath(this.paths.profile, "data", "dsh-synapse", "temp", "imgs");
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(name)) { continue; }
      const file = await safePath(this.root, name);
      if (!this.state.hasImage(file)) { this.state.registerImage(file, (await stat(file)).mtimeMs); }
    }
    for (const item of this.state.allMessages()) {
      void this.process(item.seq).catch(() => {
        if (!this.shutdown.signal.aborted) { this.state.log({ groupId: item.groupId, type: "failure", reason: "恢复群聊图片处理失败", time: this.now() }); }
      });
    }
  }

  process(seq: number): Promise<void> {
    const existing = this.tasks.get(seq);
    if (existing) { return existing; }
    const task = this.downloadMessage(seq).finally(() => this.tasks.delete(seq));
    this.tasks.set(seq, task);
    return task;
  }

  private async downloadMessage(seq: number) {
    let item = this.state.message(seq);
    if (!item) { return; }
    if (!item.expanded) {
      const expanded = await this.expand(item.message, item.groupId);
      if (expanded) {
        const content = groupContent(expanded, item.selfId);
        this.state.updateMessage(seq, content.text, content.images, true);
      } else { this.state.updateMessage(seq, item.text, item.attachments, true); }
      item = this.state.message(seq);
      if (!item) { return; }
    }
    for (const image of item.attachments) {
      if (image.state !== "pending") { continue; }
      try {
        const bytes = await this.bytes(image.source);
        const name = `${createHash("sha256").update(bytes).digest("hex")}.${imageExtension(bytes)}`;
        const file = path.join(this.root, name);
        await this.withFile(file, async () => {
          await safePath(this.root, name);
          await atomicWrite(file, bytes, this.shutdown.signal);
          image.state = "ready"; image.path = file;
          this.state.registerImage(file, this.now());
        });
      } catch (cause) {
        if (this.shutdown.signal.aborted) { return; }
        image.state = "failed";
        // 下载异常可能带有带签名的 URL，日志只保存错误类别。
        image.error = cause instanceof Error ? cause.name : "DownloadError";
        this.state.log({ groupId: item.groupId, type: "failure", reason: "群聊图片下载失败", details: { messageId: item.messageId, imageId: image.id, error: image.error }, time: this.now() });
      }
      const fresh = this.state.message(seq);
      if (!fresh) { return; }
      const attachments = fresh.attachments.map(entry => entry.id === image.id ? image : entry);
      const marker = new RegExp(`\\[(?:图片|图片表情)待处理:${image.id}\\]`, "g");
      const reference = image.path ? `[${image.face ? "图片表情" : "图片"}: ${image.path}]` : `[图片下载失败:${image.id}]`;
      this.state.updateMessage(seq, fresh.text.replace(marker, reference), attachments);
      item = this.state.message(seq);
    }
  }

  private withFile<T>(file: string, work: () => Promise<T>): Promise<T> {
    const task = (this.files.get(file) ?? Promise.resolve()).then(work);
    const tail = task.catch(() => {}).finally(() => { if (this.files.get(file) === tail) { this.files.delete(file); } });
    this.files.set(file, tail);
    return task;
  }

  private async api(action: string, input: object): Promise<any> {
    const c = this.config();
    const response = await fetch(new URL(action, c.httpUrl.replace(/\/?$/, "/")), {
      method: "POST", signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000)]),
      headers: { "Content-Type": "application/json", ...(c.httpToken ? { Authorization: `Bearer ${c.httpToken}` } : {}) }, body: JSON.stringify(input),
    });
    if (!response.ok) { throw new Error("OneBot 引用查询失败"); }
    const result: any = await response.json();
    if (result.retcode && result.retcode !== 0) { throw new Error("OneBot 引用查询失败"); }
    return result.data;
  }

  private async expand(input: unknown, groupId: string): Promise<any[] | undefined> {
    const initial = segments(input);
    if (!initial.some(segment => ["reply", "forward", "node"].includes(segment?.type))) { return undefined; }
    let count = 0, requests = 0;
    const seen = new Set<string>();
    const visit = async (source: unknown, depth = 0): Promise<any[]> => {
      const result = [];
      for (const segment of segments(source)) {
        if (++count > 500 || depth > 2) { result.push({ type: "text", data: { text: "[引用内容超过展开限制]" } }); break; }
        const data = segment?.data ?? {};
        if (segment?.type === "node") {
          result.push({ type: "node", data: { content: await visit(data.content, depth + 1) } });
        } else if (["reply", "forward"].includes(segment?.type)) {
          const key = `${segment.type}:${String(data.id)}`;
          if (seen.has(key) || ++requests > 20) { result.push({ type: "text", data: { text: "[重复引用或超过查询限制]" } }); continue; }
          seen.add(key);
          try {
            const value = await this.api(segment.type === "reply" ? "get_msg" : "get_forward_msg", segment.type === "reply" ? { message_id: data.id } : { message_id: String(data.id) });
            const nodes = segment.type === "reply" ? [value] : value.messages || [];
            for (const node of nodes) {
              const content = node.message || node.content;
              const label = `${node.sender?.card || node.sender?.nickname || "引用消息"} (${node.sender?.user_id || node.user_id || "未知"})`;
              result.push({ type: "node", data: { content: [{ type: "text", data: { text: `[${label}] ` } }, ...await visit(content, depth + 1)] } });
            }
          } catch (cause) {
            if (this.shutdown.signal.aborted) { throw cause; }
            result.push({ type: "text", data: { text: "[引用消息获取失败]" } });
            this.state.log({ groupId, type: "failure", reason: "QQ 引用消息展开失败", details: { action: segment.type === "reply" ? "get_msg" : "get_forward_msg" }, time: this.now() });
          }
        } else { result.push(segment); }
      }
      return result;
    };
    return visit(initial);
  }

  private async bytes(source: string): Promise<Buffer> {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000)]);
    if (source.startsWith("base64://")) {
      if (source.length > 28000000) { throw new Error("图片超过大小上限"); }
      return Buffer.from(source.slice(9), "base64");
    }
    let url: URL;
    try { url = new URL(source); } catch { /* OneBot file 标识需要先解析。 */ }
    if (!url || !["http:", "https:"].includes(url.protocol)) {
      const c = this.config();
      const response = await fetch(new URL("get_image", c.httpUrl.replace(/\/?$/, "/")), {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", ...(c.httpToken ? { Authorization: `Bearer ${c.httpToken}` } : {}) },
        body: JSON.stringify({ file: source }),
      });
      if (!response.ok) { throw new Error("图片标识解析失败"); }
      const result: any = await response.json();
      url = new URL(result.data?.url);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) { throw new Error("图片来源无效"); }
    const response = await fetch(url, { signal });
    if (!response.ok || Number(response.headers.get("content-length")) > 20000000) { throw new Error("图片下载失败或超过大小上限"); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { break; }
        size += value.length;
        if (size > 20000000) { throw new Error("图片超过大小上限"); }
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }

  async collect(days: number) {
    const before = this.now() - days * 86400000;
    for (const file of this.state.expiredImages(before)) {
      await this.withFile(file, async () => {
        const safe = await safePath(this.root, path.basename(file));
        if (safe !== file) { throw new Error("图片缓存路径越界"); }
        if (!this.state.imageExpired(file, before)) { return; }
        try { await unlink(safe); }
        catch (cause) { if (cause.code !== "ENOENT") { throw cause; } }
        this.state.forgetImage(file);
      });
    }
  }

  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.tasks.values());
  }
}
