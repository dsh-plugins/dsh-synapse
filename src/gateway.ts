import type { ConfigSource, ErrorSink } from "./types.js";
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { body, json, equalSecret } from "./http.js";
interface Run {
  created: number;
  events: any[];
  listeners: Set<(event: any) => void>;
  done: boolean;
  controller: AbortController;
  task?: Promise<void>;
}
export class Gateway {
  agent: import("./agent.js").Agent;
  config: ConfigSource;
  onError: ErrorSink;
  token: string;
  runs: Map<string, Run>;
  external: Map<string, { input: any; created: number }>;
  controllers: Set<AbortController>;
  closed: boolean;
  server: import("node:http").Server;
  url: string;
  gc: NodeJS.Timeout;
  background = new Set<Promise<unknown>>();
  shutdown = new AbortController();

  constructor(
    agent: import("./agent.js").Agent,
    config: ConfigSource,
    onError: ErrorSink,
  ) {
    Object.assign(this, { agent, config, onError });
    this.token = randomBytes(32).toString("hex");
    this.runs = new Map();
    this.external = new Map();
    this.controllers = new Set();
    this.closed = false;
  }
  async start() {
    this.server = createServer((req, res) => {
      const task = this.handle(req, res).catch((e) => {
        this.onError(e);
        if (!res.headersSent) json(res, { error: e.message }, e.status || 500);
        else res.end();
      });
      this.background.add(task);
      void task.finally(() => this.background.delete(task));
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.url = `http://127.0.0.1:${(this.server.address() as import("node:net").AddressInfo).port}`;
    this.gc = setInterval(() => {
      for (const [id, run] of this.runs)
        if (run.done && Date.now() - run.created > 600000) this.runs.delete(id);
      for (const [id, run] of this.external)
        if (Date.now() - run.created > 3600000) this.external.delete(id);
    }, 60000).unref();
  }
  async handle(req, res) {
    if (!equalSecret(req.headers.authorization, `Bearer ${this.token}`))
      return json(res, { error: "Unauthorized" }, 401);
    const url = new URL(req.url, "http://localhost");
    if (
      !/^\/v1\/runs(?:\/[a-zA-Z0-9_-]+\/(?:events|approval|stop))?$/.test(
        url.pathname,
      )
    )
      return json(res, { error: "Not found" }, 404);
    const c = this.config();
    if (c.externalHermes) return this.proxy(req, res, url.pathname, c);
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      if (
        [...this.runs.values()].filter((r) => !r.done).length >= 16 ||
        this.runs.size >= 500
      )
        return json(res, { error: "运行队列已满" }, 429);
      const data = JSON.parse((await body(req)).toString());
      const id = randomUUID(),
        controller = new AbortController();
      const run: Run = {
        created: Date.now(),
        events: [],
        listeners: new Set(),
        done: false,
        controller,
      };
      this.runs.set(id, run);
      const emit = (event, payload) => {
        const item = {
          event,
          run_id: id,
          timestamp: Date.now() / 1000,
          ...payload,
        };
        run.events.push(item);
        for (const listener of run.listeners) listener(item);
      };
      json(res, { run_id: id, status: "running" }, 202);
      run.task = this.agent
        .run(
          data.input,
          "chat",
          data.conversation_history || [],
          controller.signal,
          emit,
          data.instructions || "",
        )
        .then(
          (output) => emit("run.completed", { output }),
          (e) => emit("run.failed", { error: e.message }),
        )
        .finally(() => {
          run.done = true;
        });
      return;
    }
    const [, , , id, action] = url.pathname.split("/");
    const run = this.runs.get(id);
    if (!run) return json(res, { error: "Unknown run" }, 404);
    if (action === "events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const send = (event) => {
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
        if (["run.completed", "run.failed"].includes(event.event)) res.end();
      };
      for (const event of run.events) send(event);
      if (!run.done && !res.writableEnded) {
        run.listeners.add(send);
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          15000,
        );
        res.on("close", () => {
          run.listeners.delete(send);
          clearInterval(heartbeat);
        });
      } else if (!res.writableEnded) res.end();
      return;
    }
    if (action === "stop" && req.method === "POST") {
      run.controller.abort();
      return json(res, { ok: true });
    }
    return json(
      res,
      { error: "本地模式仅执行管理员允许的 MCP 工具，无待审批请求" },
      409,
    );
  }
  async proxy(req, res, pathname, c) {
    let payload;
    const controller = new AbortController();
    this.controllers.add(controller);
    res.on("close", () => controller.abort());
    try {
      if (req.method === "POST")
        payload = JSON.parse((await body(req)).toString() || "{}");
      const input = payload?.input;
      if (pathname === "/v1/runs")
        payload.instructions =
          (await this.agent.context(input, "chat")) +
          "\n\n" +
          (payload.instructions || "");
      const upstream = await fetch(c.hermesUrl.replace(/\/$/, "") + pathname, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.hermesKey}`,
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(c.timeoutSec * 1000),
        ]),
      });
      if (pathname === "/v1/runs") {
        const result = await upstream.json();
        if (upstream.ok)
          this.external.set(result.run_id || result.id, {
            input,
            created: Date.now(),
          });
        return json(res, result, upstream.status);
      }
      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      });
      if (pathname.endsWith("/events") && upstream.ok) {
        let buffer = "",
          eventName = "";
        const decoder = new StringDecoder("utf8");
        const id = pathname.split("/")[3];
        for await (const chunk of Readable.fromWeb(
          upstream.body as unknown as import("node:stream/web").ReadableStream,
        )) {
          res.write(chunk);
          buffer += decoder.write(chunk);
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
              continue;
            }
            if (!line.startsWith("data:")) continue;
            let event;
            try {
              event = JSON.parse(line.slice(5));
            } catch {
              continue;
            }
            if (
              event.event === "run.completed" ||
              event.type === "run.completed" ||
              eventName === "run.completed"
            ) {
              const run = this.external.get(id);
              this.external.delete(id);
              if (run) {
                const task = this.agent
                  .learn(
                    typeof run.input === "string"
                      ? run.input
                      : JSON.stringify(run.input),
                    event.output || "",
                    "chat",
                    this.shutdown.signal,
                  )
                  .catch(this.onError);
                this.background.add(task);
                void task.finally(() => this.background.delete(task));
              }
            }
            eventName = "";
          }
        }
        res.end();
      } else
        await pipeline(
          Readable.fromWeb(
            upstream.body as unknown as import("node:stream/web").ReadableStream,
          ),
          res,
        );
    } finally {
      this.controllers.delete(controller);
    }
  }
  async close() {
    this.closed = true;
    this.shutdown.abort();
    clearInterval(this.gc);
    for (const run of this.runs.values()) {
      run.controller.abort();
    }
    for (const c of this.controllers) c.abort();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    await Promise.allSettled([...this.runs.values()].map((r) => r.task));
    await Promise.allSettled(this.background);
  }
}
