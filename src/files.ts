import type { PluginPaths, Skill } from "./types.js";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
export const ID = "dsh-synapse";
export function pathsFor(ctx, c) {
  let profile = c.profileDir;
  const url =
    ctx.baseUrl ??
    ctx.get?.("loader")?.ctx?.baseUrl ??
    ctx.get?.("loader")?.config?.baseUrl;
  if (!profile && typeof url === "string" && url.startsWith("file:"))
    profile = fileURLToPath(new URL(".", url));
  if (!profile || !path.isAbsolute(profile))
    throw new Error("无法定位当前 profile；请填写 profileDir 绝对路径");
  const home = c.homeDir || path.resolve(profile, "../..");
  if (!path.isAbsolute(home)) throw new Error("homeDir 必须是绝对路径");
  return {
    profile,
    home,
    data: path.join(profile, "data", ID),
    skills: path.join(profile, "skills"),
  };
}
export async function safePath(root, ...parts) {
  const target = path.resolve(root, ...parts),
    relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("路径越界");
  // System ancestors may be symlinks (macOS /var -> /private/var).
  // The configured root itself and every path inside it must stay link-free.
  let current = path.resolve(root);
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("不允许符号链接路径");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return target;
}
export async function atomicWrite(file, content, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal,
    });
    signal?.throwIfAborted();
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export async function promptFor(paths, channel) {
  const name = channel === "review" ? "AGENTS.md" : "SOUL.md";
  for (const root of [paths.profile, paths.home]) {
    try {
      return await readFile(await safePath(root, name), "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return channel === "review"
    ? "Review changes for concrete defects. Explain evidence and actionable fixes."
    : "你是一位友善、准确的聊天助手。";
}
export function skillName(name) {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)
  )
    throw new Error("Skill 名称无效");
  return name;
}
export const revisionOf = (text) =>
  createHash("sha256").update(text).digest("hex");
export class SkillStore {
  paths: PluginPaths;
  queue: Promise<unknown>;

  constructor(paths: PluginPaths) {
    this.paths = paths;
    this.queue = Promise.resolve();
  }
  async list() {
    const found = new Map<string, Skill>();
    for (const root of [
      path.join(this.paths.home, "skills"),
      this.paths.skills,
    ]) {
      let names;
      try {
        names = await readdir(await safePath(root));
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      for (const entry of names) {
        const name = entry.endsWith(".md") ? entry.slice(0, -3) : entry;
        try {
          skillName(name);
        } catch {
          continue;
        }
        const file = await safePath(
          root,
          entry,
          ...(entry.endsWith(".md") ? [] : ["SKILL.md"]),
        );
        try {
          const content = await readFile(file, "utf8");
          found.set(name, {
            name,
            content,
            revision: revisionOf(content),
            inherited: root !== this.paths.skills,
          });
        } catch (e) {
          if (!["ENOENT", "EISDIR", "ENOTDIR"].includes(e.code)) throw e;
        }
      }
    }
    return [...found.values()];
  }
  mutate<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  save(name, content, revision = null, signal?: AbortSignal) {
    return this.mutate(async () => {
      signal?.throwIfAborted();
      skillName(name);
      if (
        typeof content !== "string" ||
        !content.trim() ||
        content.length > 200000
      )
        throw new Error("Skill 文档为空或过大");
      const current = (await this.list()).find((x) => x.name === name);
      if ((current?.revision ?? null) !== revision)
        throw Object.assign(new Error("Skill 已变更，请重新载入"), {
          status: 409,
        });
      const flat = await safePath(this.paths.skills, `${name}.md`);
      const useFlat = await lstat(flat).then(
        () => true,
        (e) => {
          if (e.code === "ENOENT") return false;
          throw e;
        },
      );
      await atomicWrite(
        useFlat ? flat : await safePath(this.paths.skills, name, "SKILL.md"),
        content,
        signal,
      );
      return { name, revision: revisionOf(content) };
    });
  }
  remove(name, revision, signal?: AbortSignal) {
    return this.mutate(async () => {
      signal?.throwIfAborted();
      skillName(name);
      const current = (await this.list()).find((x) => x.name === name);
      if (!current || current.inherited)
        throw new Error("只能删除当前 profile 的 Skill");
      if (current.revision !== revision)
        throw Object.assign(new Error("Skill 已变更"), { status: 409 });
      for (const parts of [[name, "SKILL.md"], [`${name}.md`]]) {
        const file = await safePath(this.paths.skills, ...parts);
        signal?.throwIfAborted();
        await unlink(file).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
    });
  }
  async retrieve(query, channel) {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
    return (await this.list())
      .filter(
        (x) =>
          !x.name.startsWith("auto-") || x.name.startsWith(`auto-${channel}-`),
      )
      .map((x) => ({
        ...x,
        score: terms.reduce(
          (n, t) => n + (x.content.toLowerCase().includes(t) ? 1 : 0),
          0,
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }
}
