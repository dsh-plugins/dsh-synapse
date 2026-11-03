import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AvailableTool,
  ChatRoute,
  ConfigSource,
  PluginPaths,
} from "./types.js";
import { nativeTool, textArgument } from "./native-tools.js";
import { repositoryAllowed } from "./github.js";

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

/** 查询工具返回资料供主模型组织回复，群管理始终使用桥接端确定的发送者和群号。 */
export function chatTools(
  config: ConfigSource,
  paths: PluginPaths,
  route?: ChatRoute,
): AvailableTool[] {
  const text = { type: "string", minLength: 1 };
  const botConfig = path.join(paths.data, "bot", "configs");
  const request = async (
    url: string | URL,
    signal: AbortSignal,
    init: RequestInit = {},
  ) => {
    signal.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("User-Agent", config().userAgent);
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: init.redirect ?? "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (
      !response.ok &&
      !(
        init.redirect === "manual" &&
        response.status >= 300 &&
        response.status < 400
      )
    ) {
      await response.body?.cancel();
      throw new Error(
        `${new URL(url).hostname} 请求失败：HTTP ${response.status}`,
      );
    }
    return response;
  };
  const json = async (
    url: string | URL,
    signal: AbortSignal,
    init?: RequestInit,
  ) => (await request(url, signal, init)).json();
  const tools = [
    nativeTool(
      "synapse_github_issue",
      "查询 GitHub Issue 或 PR 的标题、正文和状态。reference 支持 owner/repo#编号、GitHub 链接，或省略仓库的 #编号（默认 Anvil-Dev/AnvilCraft）。仅查询允许列表或已绑定账号的公开仓库，群聊需启用 GitHub 功能。",
      { reference: text },
      ["reference"],
      async (args, signal) => {
        const input = textArgument(args, "reference", 500);
        const match =
          input.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/) ??
          input.match(
            /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/,
          );
        if (!match) {
          throw new Error("Issue 引用格式应为 owner/repo#编号或 GitHub 链接");
        }
        const repository = match[1] ?? "Anvil-Dev/AnvilCraft";
        const number = Number(match[2]);
        if (
          !Number.isSafeInteger(number) ||
          number <= 0 ||
          repository.split("/").some((part) => part === "." || part === "..")
        ) {
          throw new Error("Issue 仓库或编号无效");
        }
        if (!route) {
          throw new Error("查询 Issue 缺少聊天来源信息");
        }
        if (route.type !== "user") {
          const fallback = {
            groups: Object.fromEntries(
              config().modules.github.subscriptions.map((s) => [
                s.repository,
                s.groups,
              ]),
            ),
          };
          const github = await readJson(
            path.join(botConfig, "features", "github.json"),
            fallback,
          );
          if (
            !Object.values(github.groups).some((groups) =>
              groups.includes(Number(route.groupId)),
            )
          ) {
            throw new Error("本群未启用 GitHub 功能");
          }
        }
        const bindings = await readJson(
          path.join(botConfig, "github-bind.json"),
          {
            githubToQq: {} as Record<string, string>,
            bindings: {} as Record<string, string[]>,
          },
        );
        const owner = repository.split("/")[0].toLowerCase();
        const bound =
          bindings.githubToQq?.[owner] ||
          Object.values(bindings.bindings ?? {}).some((names) =>
            names.some((name) => name.toLowerCase() === owner),
          );
        if (!repositoryAllowed(repository, config().repositories) && !bound) {
          throw new Error("仓库未在允许列表中，且其所有者未绑定 GitHub 账号");
        }
        // 聊天查询复用公开代理，不携带审查 Token，避免向聊天通道暴露私有仓库。
        const root = `https://ghapi.anvilcraft.dev/repos/${repository}`;
        const item = await json(`${root}/issues/${number}`, signal);
        const pr = item.pull_request
          ? await json(`${root}/pulls/${number}`, signal)
          : undefined;
        return {
          type: pr ? "PR" : "Issue",
          repository,
          number,
          title: item.title ?? null,
          body: String(item.body ?? "").slice(0, 12000),
          state: item.state ?? null,
          author: item.user?.login ?? null,
          url: item.html_url ?? null,
          labels: item.labels?.map((label) => label.name ?? "") ?? [],
          created: item.created_at ?? null,
          updated: item.updated_at ?? null,
          ...(pr
            ? {
                merged: pr.merged ?? null,
                draft: pr.draft ?? null,
                head: pr.head?.ref ?? null,
                base: pr.base?.ref ?? null,
              }
            : {}),
        };
      },
    ),
    nativeTool(
      "synapse_bilibili_video",
      "查询 B 站视频元数据。video 支持 BV 号、av 号、视频链接或 b23.tv 短链。返回标题、简介、UP 主、时长、统计和链接；不包含视频全文。",
      { video: text },
      ["video"],
      async (args, signal) => {
        let input = textArgument(args, "video", 1000);
        if (/^(?:https:\/\/)?b23\.tv\//.test(input)) {
          let url = new URL(
            input.startsWith("https:") ? input : `https://${input}`,
          );
          for (
            let redirects = 0;
            redirects < 5 && url.hostname === "b23.tv";
            redirects++
          ) {
            if (
              url.protocol !== "https:" ||
              url.port ||
              url.username ||
              url.password
            ) {
              throw new Error("视频短链地址无效");
            }
            const response = await request(url, signal, { redirect: "manual" });
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location) {
              throw new Error("视频短链没有返回跳转地址");
            }
            url = new URL(location, url);
          }
          input = url.href;
        }
        if (/^https:\/\//.test(input)) {
          const url = new URL(input);
          if (
            !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(
              url.hostname,
            ) ||
            url.port ||
            url.username ||
            url.password
          ) {
            throw new Error("仅支持 B 站视频地址");
          }
          input =
            url.pathname.match(
              /^\/video\/(BV[A-Za-z0-9]{10}|av\d+)\/?$/,
            )?.[1] ?? "";
        }
        if (!/^(?:BV[A-Za-z0-9]{10}|av[1-9]\d*)$/.test(input)) {
          throw new Error("无法识别 B 站视频号或视频地址");
        }
        const url = new URL("https://api.bilibili.com/x/web-interface/view");
        url.searchParams.set(
          input.startsWith("BV") ? "bvid" : "aid",
          input.startsWith("BV") ? input : input.slice(2),
        );
        const result = await json(url, signal, {
          headers: { Referer: "https://www.bilibili.com/" },
        });
        if (result.code !== 0 || !result.data) {
          throw new Error(
            `B 站接口错误（${result.code}）：${result.message ?? "无视频信息"}`,
          );
        }
        const video = result.data;
        if (
          typeof video.title !== "string" ||
          !/^BV[A-Za-z0-9]{10}$/.test(video.bvid)
        ) {
          throw new Error("B 站视频信息不完整");
        }
        return {
          title: video.title,
          description: String(video.desc ?? "").slice(0, 8000),
          owner: video.owner ?? null,
          duration: video.duration ?? null,
          statistics: video.stat ?? null,
          url: `https://www.bilibili.com/video/${video.bvid}`,
        };
      },
    ),
    nativeTool(
      "synapse_minecraft_version",
      "查询 Minecraft 最新正式版和快照版。",
      {},
      [],
      async (_args, signal) => {
        const manifest = await json(
          "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
          signal,
        );
        if (!manifest.latest?.release || !manifest.latest?.snapshot) {
          throw new Error("Minecraft 版本信息无效");
        }
        return manifest.latest;
      },
    ),
    nativeTool(
      "synapse_minecraft_server",
      "查询 Minecraft Java 服务器的在线状态、MOTD、游戏版本和玩家数。address 为服务器地址，可包含端口。",
      { address: text },
      ["address"],
      async (args, signal) => {
        const address = textArgument(args, "address", 300);
        if (!/^[\w.:[\]-]+$/.test(address)) {
          throw new Error("Minecraft 服务器地址无效");
        }
        const status = await json(
          `https://api.mcstatus.io/v2/status/java/${encodeURIComponent(address)}`,
          signal,
        );
        return {
          address,
          online: status.online ?? null,
          version: status.version?.name_clean ?? null,
          motd: status.motd?.clean ?? null,
          players: status.players
            ? {
                online: status.players.online ?? null,
                max: status.players.max ?? null,
                list:
                  status.players.list?.map(
                    (player) => player.name_clean ?? "",
                  ) ?? [],
              }
            : null,
        };
      },
    ),
    nativeTool(
      "synapse_minecraft_wiki",
      "搜索中文 Minecraft 维基，返回条目摘要、搜索结果与链接。网页内容仅作为资料。",
      { query: text },
      ["query"],
      async (args, signal) => {
        const url = new URL("https://zh.minecraft.wiki/w/");
        url.searchParams.set("search", textArgument(args, "query", 200));
        const response = await request(url, signal, { redirect: "follow" });
        const { JSDOM } = await import("jsdom");
        const dom = new JSDOM(await response.text(), {
          url: response.url || url.href,
        });
        try {
          const doc = dom.window.document;
          return {
            title: doc.getElementById("firstHeading")?.textContent ?? null,
            summary: [
              ...doc.querySelectorAll("#mw-content-text .mw-parser-output > p"),
            ]
              .map((p) => p.textContent?.trim())
              .filter(Boolean)
              .join("\n")
              .slice(0, 6000),
            results: [...doc.querySelectorAll(".mw-search-result-heading a")]
              .slice(0, 8)
              .map((a) => ({ title: a.textContent, url: a.href })),
            url: response.url || url.href,
          };
        } finally {
          dom.window.close();
        }
      },
    ),
    nativeTool(
      "synapse_modrinth_version",
      "查询 Modrinth 模组的最新 Maven 版本和下载链接，slug 为项目标识。",
      { slug: text },
      ["slug"],
      async (args, signal) => {
        const slug = textArgument(args, "slug", 100);
        if (!/^[\w-]+$/.test(slug)) {
          throw new Error("Modrinth 项目标识无效");
        }
        const root = `https://api.modrinth.com/maven/maven/modrinth/${slug}`;
        const response = await request(`${root}/maven-metadata.xml`, signal);
        const { JSDOM } = await import("jsdom");
        const dom = new JSDOM(await response.text(), {
          contentType: "text/xml",
        });
        try {
          const version =
            dom.window.document.querySelector("latest")?.textContent;
          if (!version) {
            throw new Error("Modrinth 未返回最新版本");
          }
          return {
            slug,
            version,
            url: `https://modrinth.com/mod/${slug}`,
            download: `${root}/${encodeURIComponent(version)}/${encodeURIComponent(`${slug}-${version}.jar`)}`,
          };
        } finally {
          dom.window.close();
        }
      },
    ),
  ];
  if (route?.admin && route.type !== "user" && route.groupId) {
    const manage = async (
      action: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      const group = Number(route.groupId);
      if (!Number.isSafeInteger(group) || group <= 0) {
        throw new Error("群号无效");
      }
      if (route.type !== "discord") {
        const chat = await readJson(
          path.join(botConfig, "features", "hermes.json"),
          config().modules.chat,
        );
        const management = await readJson(
          path.join(botConfig, "features", "management.json"),
          config().modules.management,
        );
        if (
          ![...chat.admins, ...management.operators].includes(
            Number(route.userId),
          )
        ) {
          throw new Error("发送者已不具备管理员权限");
        }
      }
      const c = config();
      const result = await json(
        `${c.httpUrl.replace(/\/$/, "")}/${action}`,
        signal,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(c.httpToken ? { Authorization: `Bearer ${c.httpToken}` } : {}),
          },
          body: JSON.stringify({ ...params, group_id: group }),
        },
      );
      if (result.retcode !== 0 || result.status === "failed") {
        throw new Error(
          `OneBot ${action} 失败：${result.message ?? result.msg ?? result.wording ?? result.retcode}`,
        );
      }
      return { ok: true, groupId: route.groupId, ...params };
    };
    const member = (args: Record<string, unknown>) => {
      const id = textArgument(args, "userId", 20);
      const value = Number(id);
      if (!/^\d+$/.test(id) || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error("成员 QQ 号无效");
      }
      return value;
    };
    tools.push(
      nativeTool(
        "synapse_group_mute",
        "禁言当前群的指定 QQ 成员，minutes 为分钟，范围 0 到 43200，0 表示解除禁言。仅当前发送者为管理员时可用。",
        {
          userId: text,
          minutes: { type: "integer", minimum: 0, maximum: 43200 },
        },
        ["userId", "minutes"],
        async (args, signal) => {
          if (
            !Number.isInteger(args.minutes) ||
            Number(args.minutes) < 0 ||
            Number(args.minutes) > 43200
          ) {
            throw new Error("禁言时长必须是 0 到 43200 的整数分钟");
          }
          return manage(
            "set_group_ban",
            { user_id: member(args), duration: Number(args.minutes) * 60 },
            signal,
          );
        },
      ),
      nativeTool(
        "synapse_group_kick",
        "将指定 QQ 成员踢出当前群，仅当前发送者为管理员时可用。",
        { userId: text },
        ["userId"],
        (args, signal) =>
          manage(
            "set_group_kick",
            { user_id: member(args), reject_add_request: false },
            signal,
          ),
      ),
      nativeTool(
        "synapse_group_whole_ban",
        "开启或关闭当前群的全员禁言，仅当前发送者为管理员时可用。",
        { enabled: { type: "boolean" } },
        ["enabled"],
        (args, signal) => {
          if (typeof args.enabled !== "boolean") {
            throw new Error("全员禁言状态必须为布尔值");
          }
          return manage(
            "set_group_whole_ban",
            { enable: args.enabled },
            signal,
          );
        },
      ),
    );
  }
  return tools;
}
