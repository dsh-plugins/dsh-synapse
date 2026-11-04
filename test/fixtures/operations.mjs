import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../node_modules/@dsh-plugin/dsh-loader/dist/services/config.js";
import { template } from "../../lib/host/config.js";
import { registerOperations } from "../../lib/host/operations.js";
import { SkillStore } from "../../lib/host/files.js";
import { Memory } from "../../lib/host/memory.js";
import { ChatState } from "../../lib/host/chat-state.js";
import { ChatActivity } from "../../lib/host/chat-activity.js";

export async function operationFixture({ serviceAvailable = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-operations-"));
  const profile = path.join(home, "profiles", "test");
  const paths = {
    home,
    profile,
    skills: path.join(profile, "skills"),
    data: path.join(profile, "data", "dsh-synapse"),
  };
  await mkdir(paths.data, { recursive: true });
  const store = new ConfigStore(profile),
    handle = await store.register(null, template);
  const config = () => handle.get().value;
  const activity = new ChatActivity({ state: new ChatState(path.join(paths.data, "chat-state.sqlite")), config,
    images: { start: async () => {}, process: async () => {}, collect: async () => {}, close: async () => {} },
    cloud: { message: async () => ({ boost: 0, words: [] }), removeUsers: async () => {}, close: async () => {} } });
  const service = {
    config,
    activity,
    paths,
    skills: new SkillStore(paths),
    memory: new Memory(
      path.join(paths.data, "memory.sqlite"),
      {
        embed: async () => [1, ...Array(511).fill(0)],
        rerank: async (_query, docs) => docs.map(() => 1),
      },
      config,
    ),
    mcp: {
      list: async (name) => {
        if (!config().mcpServers.some((s) => s.name === name && s.enabled))
          throw new Error("MCP 服务未启用");
        return [
          {
            name: "lookup",
            description: "Lookup documents",
            inputSchema: { type: "object" },
          },
        ];
      },
    },
    reviews: { list: () => [], retry() {} },
    bot: { liveFeatures: async () => [] },
  };
  let queue = Promise.resolve();
  registerOperations(
    handle,
    (work) => {
      const result = queue.then(() => {
        if (!serviceAvailable) { throw new Error("服务尚未就绪"); }
        return work(service);
      });
      queue = result.catch(() => {});
      return result;
    },
    () => "机器人：stopped",
  );
  return {
    store,
    handle,
    service,
    paths,
    invoke: (id, input = {}, resource, signal) =>
      store.invoke(
        "dsh-synapse",
        id,
        { input, ...(resource ? { resource } : {}) },
        signal,
      ),
    async close() {
      handle.dispose();
      await queue;
      await activity.close();
      service.memory.close();
      store.dispose();
      const target = path.resolve(home);
      if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("synapse-operations-")) {
        throw new Error("临时配置目录不在预期范围内");
      }
      await rm(target, { recursive: true, force: true });
    },
  };
}
