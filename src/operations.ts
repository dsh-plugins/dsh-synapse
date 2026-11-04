import { ConfigError } from "@dsh-plugin/dsh-loader/config";
import type {
  ConfigHandle,
  ConfigOperationContext,
  ConfigOperationResult,
  ConfigValue,
} from "@dsh-plugin/dsh-loader/config";
import type { SynapseConfig } from "./types.js";
import type { createService } from "./index.js";
import { parseHermes } from "./memory.js";
import { modulesFromFiles } from "./feature-config.js";
import { validateConfig } from "./config.js";
import { McpManager } from "./mcp.js";
import type { McpSpec } from "./types.js";

type Service = Awaited<ReturnType<typeof createService>>;
type Operation = (
  service: Service,
  request: ConfigOperationContext<SynapseConfig>,
) => Promise<ConfigOperationResult> | ConfigOperationResult;
const emptyEditor = () => ({
  value: {
    selected: "",
    name: "",
    content: "",
    confirmDelete: false,
    origin: "",
  },
  resource: null,
});
const editor = (skill) => ({
  value: {
    selected: skill.name,
    name: skill.name,
    content: skill.content,
    confirmDelete: false,
    origin: skill.inherited
      ? "继承自 Home；保存将创建 profile 覆盖，不能删除 Home 文件。"
      : "当前 profile",
  },
  resource: { id: `skill:${skill.name}`, revision: skill.revision },
});

export function registerOperations(
  handle: ConfigHandle<SynapseConfig>,
  withService: (
    work: (service: Service) => Promise<ConfigOperationResult>,
  ) => Promise<ConfigOperationResult>,
  status: () => string,
) {
  if (!handle.registerOperation)
    throw new Error("请升级 dsh-loader 到支持配置卡片操作区的版本");
  const mcpSnapshot = (resource) => {
    const current = handle.get();
    if (resource?.id !== "mcp-servers" || resource.revision !== current.revision) {
      throw new ConfigError("conflict", "MCP 配置已变更，请关闭弹窗后重新编辑");
    }
    return current;
  };
  const operations: Record<string, Operation> = {
    "activity.load": () => {
      const current = handle.get();
      return { value: { settings: current.value.activity as unknown as ConfigValue }, resource: { id: "chat-activity", revision: current.revision } };
    },
    "activity.save": async (_s, { input, resource, signal }) => {
      const current = handle.get();
      if (resource?.id !== "chat-activity" || current.revision !== resource.revision) { throw new ConfigError("conflict", "配置已变更，请关闭弹窗后重新载入"); }
      const activity = input.settings as unknown as SynapseConfig["activity"];
      validateConfig({ ...current.value, activity });
      signal.throwIfAborted();
      const saved = await handle.update({ activity }, current.revision);
      return { value: { settings: saved.value.activity as unknown as ConfigValue }, resource: { id: "chat-activity", revision: saved.revision } };
    },
    "activity.status": s => ({ value: { items: s.activity.status() } }),
    "activity.logs": (s, { input }) => {
      const date = (value: unknown) => {
        if (!value) { return undefined; }
        const result = Date.parse(String(value));
        if (!Number.isFinite(result)) { throw new ConfigError("validation", "日志查询时间无效"); }
        return result;
      };
      return { value: { items: s.activity.state.logs({ groupId: String(input.groupId || ""), type: String(input.type || ""), from: date(input.from), to: date(input.to), beforeId: Number(input.beforeId) || undefined }) } };
    },
    "skills.list": async (s) => ({
      value: {
        items: (await s.skills.list()).map((x) => ({
          name: x.name,
          revision: x.revision,
          inherited: x.inherited,
        })),
      },
    }),
    "skills.load": async (s, { input }) => {
      if (!input.selected) return emptyEditor();
      const skill = (await s.skills.list()).find(
        (x) => x.name === input.selected,
      );
      if (!skill)
        throw new ConfigError("not-found", "Skill 不存在，请刷新列表");
      return editor(skill);
    },
    "skills.create": async (s, { input, signal }) => {
      const saved = await s.skills.save(
        input.name,
        input.content,
        null,
        signal,
      );
      return editor({ ...saved, content: input.content, inherited: false });
    },
    "skills.save": async (s, { input, resource, signal }) => {
      if (resource?.id !== `skill:${input.name}`)
        throw new ConfigError(
          "conflict",
          "名称与已加载的 Skill 不一致；请重新加载，或使用创建按钮",
        );
      const saved = await s.skills.save(
        input.name,
        input.content,
        resource.revision,
        signal,
      );
      return editor({ ...saved, content: input.content, inherited: false });
    },
    "skills.delete": async (s, { input, resource, signal }) => {
      if (!input.confirmDelete)
        throw new ConfigError("validation", "请先勾选删除确认", {
          confirmDelete: "需要确认",
        });
      if (
        input.selected !== input.name ||
        resource?.id !== `skill:${input.name}`
      )
        throw new ConfigError(
          "conflict",
          "删除目标与已加载的 Skill 不一致，请重新加载",
        );
      await s.skills.remove(input.name, resource.revision, signal);
      return emptyEditor();
    },
    "mcp.test": async (_s, { input, config: current, signal }) => {
      const server = { ...(input.server as unknown as McpSpec), enabled: true };
      const config = validateConfig({ ...current.value, mcpServers: [server] });
      const test = new McpManager(() => config);
      try {
        await test.connect(server.name, signal);
        return { value: { tools: await test.list(server.name, signal) } };
      } finally {
        await test.close();
      }
    },
    "mcp.save": async (_s, { input, resource, signal }) => {
      const current = mcpSnapshot(resource), name = String(input.originalName);
      const server = input.server as unknown as McpSpec;
      const index = current.value.mcpServers.findIndex(item => item.name === name);
      if (name && index < 0 || current.value.mcpServers.some(item => item.name === server.name && item.name !== name)) {
        throw new ConfigError("conflict", "MCP 名称已存在或原服务已删除");
      }
      const mcpServers = name
        ? current.value.mcpServers.map((item, i) => i === index ? server : item)
        : [...current.value.mcpServers, server];
      validateConfig({ ...current.value, mcpServers });
      signal.throwIfAborted();
      const saved = await handle.update({ mcpServers }, current.revision);
      return { value: { name: server.name }, resource: { id: "mcp-servers", revision: saved.revision } };
    },
    "mcp.delete": async (_s, { input, resource, signal }) => {
      const current = mcpSnapshot(resource);
      if (!input.confirmDelete || !current.value.mcpServers.some(item => item.name === input.originalName)) {
        throw new ConfigError("validation", "请确认删除已加载的 MCP 服务");
      }
      const mcpServers = current.value.mcpServers.filter(item => item.name !== input.originalName);
      validateConfig({ ...current.value, mcpServers });
      signal.throwIfAborted();
      const saved = await handle.update({ mcpServers }, current.revision);
      return { value: "已删除", resource: { id: "mcp-servers", revision: saved.revision } };
    },
    "memory.preview": (_s, { input }) => ({
      value: {
        items: parseHermes(String(input.markdown), String(input.channel)),
      },
    }),
    "memory.import": async (s, { input, signal }) => {
      if (!s.config().memory.enabled)
        throw new ConfigError("validation", "请先在配置中启用长期记忆");
      const result = await s.memory.addMany(
        parseHermes(String(input.markdown), String(input.channel)),
        signal,
      );
      return {
        value: {
          ...result,
          summary: `新增 ${result.inserted} 条，重复 ${result.duplicates} 条。`,
        },
      };
    },
    "memory.search": async (s, { input, signal }) => ({
      value: {
        items: await s.memory.search(
          String(input.query),
          String(input.channel),
          signal,
        ),
      },
    }),
    "memory.recent": (s, { input }) => ({
      value: { items: s.memory.list(input.channel).map((row) => ({ ...row })) },
    }),
    "reviews.list": (s) => ({
      value: {
        items: s.reviews
          .list()
          .map((x) => ({
            id: x.id,
            event: x.event,
            state: x.state,
            attempts: x.attempts,
            updated: x.updated,
            target: x.target,
          })),
      },
    }),
    "reviews.read": (s, { input }) => {
      const job = s.reviews.list().find((x) => x.id === input.id);
      return {
        value: job
          ? { state: job.state, content: job.error || job.result || "等待处理", target: job.target }
          : { state: "missing", content: "任务不存在", target: "" },
      };
    },
    "reviews.retry": (s, { input, signal }) => {
      if (
        !s.reviews.list().some((x) => x.id === input.id && x.state === "failed")
      )
        throw new ConfigError("validation", "请选择失败任务");
      signal.throwIfAborted();
      s.reviews.retry(input.id);
      return { value: "已重新排队" };
    },
    "features.refresh": async (s, { config, signal }) => {
      const current = handle.get();
      if (current.revision !== config.revision)
        throw new ConfigError("conflict", "配置已变更，请重新同步");
      const modules = modulesFromFiles(
        current.value.modules,
        await s.bot.liveFeatures(),
      );
      validateConfig({ ...current.value, modules });
      signal.throwIfAborted();
      await handle.update({ modules }, current.revision);
      return { value: "已同步" };
    },
  };
  for (const [id, operation] of Object.entries(operations)) {
    handle.registerOperation(id, (request) => {
      const invoke = async (service?: Service) => {
        request.signal.throwIfAborted();
        try {
          const result = await operation(service, request);
          request.signal.throwIfAborted();
          return result;
        } catch (error) {
          if (error.status === 409)
            throw new ConfigError("conflict", error.message);
          throw error;
        }
      };
      // MCP 草稿测试与配置修复不能被机器人启动失败阻塞。
      return id.startsWith("mcp.") || ["activity.load", "activity.save"].includes(id) ? invoke() : withService(invoke);
    });
  }
  handle.registerOperation("status.read", () => ({ value: status() }));
}
