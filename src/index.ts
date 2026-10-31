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
import { Reviews } from "./github.js";
import { json, body, browserAuthorized } from "./http.js";
import type { SynapseContext, SynapseConfig, ErrorSink } from "./types.js";
export const name = "@dsh-plugin/dsh-synapse";
export const inject = ["dshLoader"];
export { template };
export async function createService(
  ctx: SynapseContext,
  c: SynapseConfig,
  onError: ErrorSink,
) {
  validateConfig(c);
  const paths = pathsFor(ctx, c);
  await safePath(paths.profile, "data", "dsh-synapse");
  await mkdir(paths.data, { recursive: true });
  const config = () => c,
    inference = new Inference(paths.data),
    skills = new SkillStore(paths);
  const memory = new Memory(
      path.join(paths.data, "memory.sqlite"),
      inference,
      config,
    ),
    mcp = new McpManager(config);
  const agent = new Agent({
      loader: ctx.dshLoader,
      config,
      paths,
      memory,
      skills,
      mcp,
      onError,
    }),
    gateway = new Gateway(agent, config, onError);
  const bot = new Bot(paths, config, gateway, onError),
    reviews = new Reviews(memory.db, agent, config, bot, onError);
  const close = async () => {
    const results = await Promise.allSettled([
      reviews.close(),
      bot.stop(),
      gateway.close(),
      agent.close(),
      mcp.close(),
      inference.close(),
    ]);
    for (const result of results)
      if (result.status === "rejected") onError(result.reason);
    memory.close();
  };
  try {
    await gateway.start();
    await bot.start();
    void reviews.drain();
    if (c.enabled && c.ragEnabled)
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
  const reconfigure = (value) =>
    enqueue(async () => {
      if (disposed) return;
      validateConfig(value);
      pathsFor(ctx, value);
      if (service) {
        const old = service;
        service = null;
        await old.close();
      }
      service = await createService(ctx, value, onError);
      lastError = "";
    });
  const off = handle.watch(
    ({ value }) => void reconfigure(value).catch(() => {}),
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
            if (!service.config().ragEnabled) throw new Error("请先启用 RAG");
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
    void enqueue(async () => {
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
