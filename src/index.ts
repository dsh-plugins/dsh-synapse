import { mkdir } from "node:fs/promises";
import path from "node:path";
import { template, validateConfig } from "./config.js";
import { registerConfig } from "./config-migration.js";
import { registerOperations } from "./operations.js";
import { modulesFromFiles } from "./feature-config.js";
import { pathsFor, SkillStore, safePath } from "./files.js";
import { Inference } from "./runtime.js";
import { Memory, parseHermes } from "./memory.js";
import { McpManager } from "./mcp.js";
import { Agent } from "./agent.js";
import { Gateway } from "./gateway.js";
import { Bot } from "./bot.js";
import { ChatActivity, type ActivityWriter } from "./chat-activity.js";
import { ChatState } from "./chat-state.js";
import { ChatImages } from "./chat-images.js";
import { AsyncWordCloud } from "./word-cloud.js";
import { Reviews } from "./github.js";
import { json, body, browserAuthorized } from "./http.js";
import { abortable } from "./abort.js";
import type { SynapseContext, SynapseConfig, ErrorSink } from "./types.js";
export const name = "@dsh-plugin/dsh-synapse";
export const inject = ["dshLoader"];
export { template };
/** 主动策略与 AI 忽略名单可以原位更新，其他功能沿用完整重配流程。 */
export function activityOnlyChange(previous: SynapseConfig, next: SynapseConfig): boolean {
  const stable = (value: SynapseConfig) => {
    const copy = structuredClone(value);
    delete copy.activity;
    delete copy.modules.chat.blockedUsers;
    return JSON.stringify(copy);
  };
  return stable(previous) === stable(next);
}
export async function createService(
  ctx: SynapseContext,
  c: SynapseConfig,
  onError: ErrorSink,
  writer?: (...args: [...Parameters<ActivityWriter>, AbortSignal]) => Promise<void>,
) {
  validateConfig(c);
  const paths = pathsFor(ctx);
  await safePath(paths.profile, "data", "dsh-synapse");
  await mkdir(paths.data, { recursive: true });
  const config = () => c,
    inference = new Inference(paths.data, config),
    skills = new SkillStore(paths);
  const memory = new Memory(
      path.join(paths.data, "memory.sqlite"),
      inference,
      config,
      (completed, total) => ctx.logger?.info?.(`[synapse] 记忆向量重建：${completed}/${total}`),
    ),
    mcp = new McpManager(config);
  const agent = new Agent({
      loader: ctx.dshLoader,
      config,
      paths,
      memory,
      skills,
      mcp,
      sendVoice: (route, audio, signal) => bot.sendVoice(route, audio, signal),
      checkGroupSend: (groupId, signal) => bot.canSendGroup(groupId, signal),
    });
  const state = new ChatState(path.join(paths.data, "chat-state.sqlite"));
  const images = new ChatImages(paths, state, config);
  const shutdown = new AbortController();
  const activity = new ChatActivity({ state, images, cloud: new AsyncWordCloud(path.join(paths.data, "chat-state.sqlite")), config, onError,
    busy: groupId => agent.busy(`chat:group:${groupId}`), writer: writer && ((...args) => {
      shutdown.signal.throwIfAborted();
      return abortable(writer(...args, shutdown.signal), shutdown.signal);
    }) });
  const gateway = new Gateway(agent, config, onError, activity);
  const bot = new Bot(paths, config, gateway, onError),
    reviews = new Reviews(memory.db, agent, config, bot, onError);
  activity.activate = event => bot.activate(event);
  activity.available = () => bot.state === "running";
  let closing: Promise<void>;
  const close = () => closing ??= (async () => {
    shutdown.abort(new Error("Synapse 正在关闭"));
    const results = await Promise.allSettled([
      reviews.close(),
      bot.close(),
      gateway.close(),
      agent.close(),
      mcp.close(),
      inference.close(),
    ]);
    for (const result of results)
      if (result.status === "rejected") onError(result.reason);
    await activity.close();
    memory.close();
  })();
  try {
    await activity.recover((sessionId, messageId, batchId) => agent.harness.hasInput(sessionId, messageId, batchId));
    await gateway.start();
    await bot.start();
    activity.start();
    void reviews.drain();
    if (c.enabled && c.memory.enabled)
      void inference.embed("初始化记忆模型").catch(onError);
  } catch (e) {
    await close();
    throw e;
  }
  return {
    paths,
    config,
    inference,
    skills,
    memory,
    mcp,
    agent,
    gateway,
    bot,
    reviews,
    activity,
    async updateActivity(value: SynapseConfig, source: string, revision?: number) {
      validateConfig(value);
      const previous = c; c = value;
      bot.updateActivity();
      await activity.configure(previous, source, revision);
    },
    close,
  };
}
export async function apply(ctx: SynapseContext) {
  const handle = await registerConfig(ctx);
  let service,
    disposed = false,
    lastError = "",
    queue: Promise<unknown> = Promise.resolve();
  const onError = (e) => {
    lastError = e.message;
    ctx.logger?.warn?.(`[synapse] ${e.message}`);
  };
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    queue = result.catch(onError);
    return result;
  };
  const reconfigure = (value, revision?: number) =>
    enqueue(async () => {
      if (disposed) return;
      if (revision !== undefined && handle.get().revision !== revision) { return; }
      validateConfig(value);
      pathsFor(ctx);
      if (service && activityOnlyChange(service.config(), value)) {
        if (JSON.stringify(service.config()) !== JSON.stringify(value)) { await service.updateActivity(value, "设置页", revision); }
        return;
      }
      if (service) {
        const old = service;
        service = null;
        await old.close();
      }
      service = await createService(ctx, value, onError, (activity, source, previous, signal) => enqueue(async () => {
        // 重配和关闭会等待旧网关退出。网关停止等待后，旧实例的命令仍可能排在配置队列里。
        if (signal.aborted) { return; }
        const current = handle.get();
        if (JSON.stringify(current.value.activity) !== JSON.stringify(previous)) { throw new Error("群聊策略已变更，请重新执行命令"); }
        validateConfig({ ...current.value, activity });
        const saved = await handle.update({ activity }, current.revision);
        if (service) { await service.updateActivity(saved.value, source, saved.revision); }
      }));
      lastError = "";
    });
  const off = handle.watch(
    ({ value, revision }) => void reconfigure(value, revision).catch(() => {}),
  );
  registerOperations(
    handle,
    (work) =>
      enqueue(async () => {
        if (disposed || !service) throw new Error(lastError || "服务尚未就绪");
        return work(service);
      }),
    () =>
      lastError
        ? `需要处理：${lastError}`
        : `机器人：${service?.bot.state || "stopped"}`,
  );
  const manage = async (req, res) => {
    try {
      if (!browserAuthorized(ctx, req, res)) return;
      const url = new URL(req.url, "http://localhost");
      const action = url.pathname.slice("/api/dsh-synapse/".length);
      if (action === "status")
        return json(res, {
          running: Boolean(service),
          bot: service?.bot.state || "stopped",
          lastError,
        });
      if (!service)
        return json(res, { error: lastError || "服务尚未就绪" }, 503);
      // Serialize management with configuration changes; no writes into a closing DB.
      await enqueue(async () => {
        if (!service) throw new Error("服务正在重载");
        if (req.method === "GET" && action === "skills")
          return json(res, await service.skills.list());
        if (req.method === "GET" && action === "reviews")
          return json(res, service.reviews.list());
        if (req.method === "GET" && action === "memory")
          return json(
            res,
            service.memory.list(url.searchParams.get("channel") || "chat"),
          );
        if (req.method === "POST") {
          const data = JSON.parse((await body(req)).toString() || "{}");
          if (action === "features/refresh") {
            const current = handle.get();
            if (current.revision !== data.expectedRevision)
              return json(res, { error: "配置已变更，请重新载入后同步" }, 409);
            const modules = modulesFromFiles(
              current.value.modules,
              await service.bot.liveFeatures(),
            );
            validateConfig({ ...current.value, modules });
            await handle.update({ modules }, current.revision);
            return json(res, { ok: true });
          }
          if (action === "skills/save")
            return json(
              res,
              await service.skills.save(data.name, data.content, data.revision),
            );
          if (action === "skills/delete") {
            await service.skills.remove(data.name, data.revision);
            return json(res, { ok: true });
          }
          if (action === "mcp/tools")
            return json(res, await service.mcp.list(data.name));
          if (action === "memory/import") {
            if (!service.config().memory.enabled) throw new Error("请先启用长期记忆");
            const items = parseHermes(data.markdown, data.channel);
            return json(
              res,
              data.preview ? { items } : await service.memory.addMany(items),
            );
          }
          if (action === "memory/search")
            return json(
              res,
              await service.memory.search(String(data.query), data.channel),
            );
          if (action === "reviews/retry") {
            service.reviews.retry(data.id);
            return json(res, { ok: true });
          }
        }
        json(res, { error: "Not found" }, 404);
      });
    } catch (e) {
      if (!res.headersSent) json(res, { error: e.message }, e.status || 400);
    }
  };
  const routes = [];
  ctx.effect(() => () => {
    disposed = true;
    off();
    for (const release of routes) release();
    return enqueue(async () => {
      await service?.close();
      service = null;
    });
  });
  routes.push(ctx.dshLoader.web.register("/api/dsh-synapse/", manage));
  routes.push(
    ctx.dshLoader.web.post("/hooks/dsh-synapse/github", (req, res) => {
      void enqueue(async () => {
        if (!service) return json(res, { error: "服务尚未就绪" }, 503);
        await service.reviews.webhook(req, res);
      }).catch((e) => {
        if (!res.headersSent) json(res, { error: e.message }, e.status || 400);
      });
    }),
  );
  await reconfigure(handle.get().value).catch(() => {});
}
