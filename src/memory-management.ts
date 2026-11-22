import { ConfigError, type ConfigOperationContext, type ConfigOperationResult } from "@dsh-plugin/dsh-loader/config";
import { Memory, parseHermes } from "./memory.js";
import type { Channel, ConfigSource, SynapseConfig } from "./types.js";

type Request = ConfigOperationContext<SynapseConfig>;
type Handler = (service: { memory: Memory; config: ConfigSource }, request: Request) => ConfigOperationResult | Promise<ConfigOperationResult>;
function id(request: Request) {
  const id = Number(request.input.memoryId);
  if (!Number.isSafeInteger(id) || id < 1) throw new ConfigError("validation", "记忆 ID 无效");
  return id;
}
function revision(request: Request) {
  if (request.resource?.id !== `memory:${id(request)}` || typeof request.resource.revision !== "string") throw new ConfigError("conflict", "请重新打开这条记忆");
  return request.resource.revision;
}
function documentResult(row: ReturnType<Memory["document"]>): ConfigOperationResult {
  const { revision, ...doc } = row;
  return { value: doc, resource: { id: `memory:${row.id}`, revision } };
}

export const memoryOperations: Record<string, Handler> = {
  "memory.page": (s, { input }) => ({ value: s.memory.page(String(input.scope), String(input.query), Number(input.page), Number(input.pageSize)) }),
  "memory.load": (s, request) => {
    const row = s.memory.document(id(request));
    if (!row) throw new ConfigError("not-found", "这条记忆已删除，请刷新列表");
    return documentResult(row);
  },
  "memory.update": async (s, request) => documentResult(await s.memory.updateDocument(id(request), revision(request), request.input.channel as Channel, String(request.input.text), request.signal)),
  "memory.delete": async (s, request) => {
    if (!request.input.confirmDelete) throw new ConfigError("validation", "请确认删除记忆");
    await s.memory.deleteDocument(id(request), revision(request), request.signal);
    return { value: "已删除记忆", resource: null };
  },
  "memory.preview": (_s, { input }) => ({ value: { items: parseHermes(String(input.markdown), String(input.channel)) } }),
  "memory.import": async (s, { input, signal }) => {
    if (!s.config().memory.enabled) throw new ConfigError("validation", "请先在配置中启用长期记忆");
    const items = parseHermes(String(input.markdown), String(input.channel));
    const excluded = new Set(input.excluded as number[]);
    for (const index of excluded) {
      if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new ConfigError("validation", "条目已变更，请重新预览");
    }
    const selected = items.filter((_, index) => !excluded.has(index));
    if (!selected.length) throw new ConfigError("validation", "请选择至少一条记忆");
    const result = await s.memory.addMany(selected, signal);
    return { value: { ...result, summary: `新增 ${result.inserted} 条，重复 ${result.duplicates} 条。` } };
  },
  "memory.search": async (s, { input, signal }) => ({ value: { items: await s.memory.search(String(input.query), String(input.channel), signal) } }),
  "memory.recent": (s, { input }) => ({ value: { items: s.memory.list(input.channel).map(row => ({ ...row })) } }),
};
