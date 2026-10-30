import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, safePath } from "./files.js";

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
  async reset(key: string) {
    const id = `synapse-${randomUUID()}`;
    await atomicWrite(
      await this.file(key),
      JSON.stringify({ key, id, bootstrap: false }),
    );
  }
}
