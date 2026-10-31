import { ConfigError } from "@dsh-plugin/dsh-loader/config";
import type {
  ConfigHandle,
  ConfigOperationContext,
  ConfigOperationResult,
} from "@dsh-plugin/dsh-loader/config";
import type { SynapseConfig } from "./types.js";
import type { createService } from "./index.js";
import { parseHermes } from "./memory.js";
import { modulesFromFiles } from "./feature-config.js";
import { validateConfig } from "./config.js";

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
  const operations: Record<string, Operation> = {
    "skills.list": async (s) => ({
      value: {
        items: (await s.skills.list()).map((x) => ({
          name: x.name,
          label: `${x.name}${x.inherited ? " · Home" : ""}`,
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
    "skills.new": () => emptyEditor(),
    "skills.preview": (_s, { input }) => ({ value: input.content }),
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
    // Do not bind the saved mcpServers array directly: it contains secret fields.
    "mcp.servers": (s) => ({
      value: {
        items: s
          .config()
          .mcpServers.filter((x) => x.enabled)
          .map(({ name }) => ({ name })),
      },
    }),
    "mcp.tools": async (s, { input, signal }) => ({
      value: { tools: await s.mcp.list(input.name, signal) },
    }),
    "memory.preview": (_s, { input }) => ({
      value: {
        items: parseHermes(String(input.markdown), String(input.channel)),
      },
    }),
    "memory.import": async (s, { input, signal }) => {
      if (!s.config().ragEnabled)
        throw new ConfigError("validation", "请先在配置中启用 RAG");
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
            label: `${x.event} · ${x.state} · ${x.id}`,
          })),
      },
    }),
    "reviews.read": (s, { input }) => {
      const job = s.reviews.list().find((x) => x.id === input.id);
      return {
        value: job
          ? `${job.state}\n${job.error || job.result || "等待处理"}`
          : "请选择任务",
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
  for (const [id, operation] of Object.entries(operations))
    handle.registerOperation(id, (request) =>
      withService(async (service) => {
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
      }),
    );
  handle.registerOperation("status.read", () => ({ value: status() }));
}
