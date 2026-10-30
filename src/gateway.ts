import type { ConfigSource, ErrorSink } from "./types.js";
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { body, json, equalSecret } from "./http.js";
import type { ApprovalAnswer } from "./harness.js";
interface Run {
  created: number;
  events: any[];
  listeners: Set<(event: any) => void>;
  done: boolean;
  controller: AbortController;
  task?: Promise<void>;
  approval?: (answer: ApprovalAnswer) => void;
  approvalQueue: Promise<unknown>;
}
export class Gateway {
  agent: import("./agent.js").Agent;
  config: ConfigSource;
  onError: ErrorSink;
  token: string;
  runs: Map<string, Run>;
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
        approvalQueue: Promise.resolve(),
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
          c.modules.chat.approvalEnabled
            ? (request) => this.askApproval(run, request, emit)
            : undefined,
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
    if (action === "approval" && req.method === "POST") {
      const { choice } = JSON.parse((await body(req)).toString());
      if (!["once", "deny"].includes(choice))
        return json(
          res,
          { error: "DSH 审批仅对本次操作生效，请选择 once 或 deny" },
          400,
        );
      if (!run.approval) return json(res, { error: "当前没有待审批请求" }, 409);
      run.approval(choice === "once" ? "allowed-once" : "rejected");
      return json(res, { ok: true });
    }
    return json(res, { error: "Method not allowed" }, 405);
  }
  private askApproval(run: Run, request, emit): Promise<ApprovalAnswer> {
    const task = run.approvalQueue.then(
      () =>
        new Promise<ApprovalAnswer>((resolve) => {
          const signal = AbortSignal.any([
            run.controller.signal,
            ...(request.signal ? [request.signal] : []),
          ]);
          if (signal.aborted) return resolve("cancelled");
          let timer: NodeJS.Timeout;
          const finish = (answer: ApprovalAnswer) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            if (run.approval === finish) run.approval = undefined;
            resolve(answer);
          };
          const abort = () => finish("cancelled");
          run.approval = finish;
          signal.addEventListener("abort", abort, { once: true });
          const seconds = this.config().modules.chat.approvalTimeoutSec;
          if (seconds > 0)
            timer = setTimeout(() => finish("rejected"), seconds * 1000);
          emit("approval.request", {
            command: request.toolName,
            description: `${request.reason || "DSH 工具操作"}（仅支持本次允许 once / 拒绝 deny）`,
          });
        }),
    );
    run.approvalQueue = task.catch(() => {});
    return task;
  }
  async close() {
    this.closed = true;
    this.shutdown.abort();
    clearInterval(this.gc);
    for (const run of this.runs.values()) {
      run.controller.abort();
    }
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    await Promise.allSettled([...this.runs.values()].map((r) => r.task));
    await Promise.allSettled(this.background);
  }
}
