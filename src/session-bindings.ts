import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, safePath } from "./files.js";
import type { ChatRoute, RunContext } from "./types.js";

export function chatSessionKey(id: unknown): string {
  // Accept old upstream per-speaker ids too, but bind the whole group together.
  const match =
    typeof id === "string" &&
    id.match(/^(user|group)_(\d+)(?:_user_(?:dc:)?\d+)?(?::v\d+)?$/);
  if (!match)
    throw Object.assign(new Error("聊天请求缺少有效的群聊或私聊会话标识"), {
      status: 400,
    });
  return `chat:${match[1]}:${match[2]}`;
}

/** 校验桥接端的聊天信息，标题使用当前群名或私聊昵称。 */
export function chatRunContext(key: string, value: unknown): RunContext {
  const [, kind, id] = key.split(":");
  const prefix = kind === "group" ? "群聊" : "私聊";
  if (value === undefined) {
    return { title: `【${prefix}】（${id}）` };
  }
  const raw = value as Partial<ChatRoute>;
  if (!raw || typeof raw !== "object" ||
      !["user", "group", "discord"].includes(raw.type) ||
      typeof raw.userId !== "string" || !/^(?:dc:)?\d+$/.test(raw.userId) ||
      (kind === "user" ? raw.type !== "user" || raw.userId !== id
        : raw.type === "user" || raw.groupId !== id)) {
    throw Object.assign(new Error("聊天信息与会话标识不匹配"), { status: 400 });
  }
  const name = typeof raw.name === "string"
    ? raw.name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 256) : "";
  if (raw.channelId !== undefined && (raw.type !== "discord" || typeof raw.channelId !== "string" || !/^\d+$/.test(raw.channelId))) {
    throw Object.assign(new Error("Discord 频道标识无效"), { status: 400 });
  }
  return {
    title: `【${prefix}】${name}（${id}）`,
    route: { type: raw.type, userId: raw.userId, groupId: raw.groupId, ...(raw.channelId ? { channelId: raw.channelId } : {}), name, admin: raw.admin === true },
  };
}

/** Only the binding lives here; the native DSH persistence service owns session history. */
export class SessionBindings {
  constructor(private data: string) {}
  private async file(key: string) {
    return safePath(
      this.data,
      "sessions",
      `${createHash("sha256").update(key).digest("hex")}.json`,
    );
  }
  async get(key: string): Promise<{ id: string; bootstrap: boolean }> {
    const file = await this.file(key);
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (
        value.key !== key ||
        typeof value.id !== "string" ||
        !/^synapse-[a-f0-9-]+$/.test(value.id)
      )
        throw new Error("会话绑定文件无效");
      return { id: value.id, bootstrap: value.bootstrap !== false };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const id = `synapse-${createHash("sha256")
      .update(path.resolve(this.data) + "\0" + key)
      .digest("hex")}`;
    await atomicWrite(file, JSON.stringify({ key, id }));
    return { id, bootstrap: true };
  }
  async reset(key: string, signal?: AbortSignal) {
    const id = `synapse-${randomUUID()}`;
    await atomicWrite(
      await this.file(key),
      JSON.stringify({ key, id, bootstrap: false }),
      signal,
    );
  }
}
