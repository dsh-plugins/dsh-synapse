import type { ConfigSource, ErrorSink } from "./types.js";
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { body, json, equalSecret } from "./http.js";
import type { ApprovalAnswer } from "./harness.js";
import { chatSessionKey, chatRunContext } from "./session-bindings.js";
import type { ChatActivity } from "./chat-activity.js";
interface Run {
  created: number;
  events: any[];
  listeners: Set<(event: any) => void>;
  done: boolean;
  controller: AbortController;
  task?: Promise<void>;
  approval?: (answer: ApprovalAnswer) => void;
  approvalQueue: Promise<unknown>;
  groupId?: string;
  muteGeneration?: number;
  batchId?: string;
  triggerId?: string;
  failed?: boolean;
  delivered?: boolean;
  submissionKey?: string;
  finishing?: Promise<void>;
  finishRequested?: boolean;
  finishFailed?: boolean;
  execution?: Promise<void>;
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
  private preparing = new Map<string, { groupId: string; muteGeneration: number; controller: AbortController; done: Promise<void> }>();
  private mutedGenerations = new Map<string, number>();
  botEpoch?: string;
  private disconnecting?: Promise<void>;

  constructor(
    agent: import("./agent.js").Agent,
    config: ConfigSource,
    onError: ErrorSink,
    public activity?: ChatActivity,
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
      for (const [id, run] of this.runs) {
        if (run.finishRequested && !run.delivered && !run.finishing) { void this.finishDelivery(id, run.finishFailed).catch(this.onError); }
        if (run.done && (!run.groupId || run.delivered) && Date.now() - run.created > 600000) { this.runs.delete(id); }
      }
    }, 60000).unref();
  }
  async handle(req, res) {
    if (!equalSecret(req.headers.authorization, `Bearer ${this.token}`))
      return json(res, { error: "Unauthorized" }, 401);
    const epoch = this.botEpoch;
    if (epoch && req.headers["x-synapse-bot"] !== epoch) { return json(res, { error: "Bot 进程已更换" }, 409); }
    const url = new URL(req.url, "http://localhost");
    if (this.activity && url.pathname.startsWith("/v1/activity/") && req.method === "POST") {
      const data = JSON.parse((await body(req)).toString());
      if (epoch !== this.botEpoch) { return json(res, { error: "Bot 进程已更换" }, 409); }
      const action = url.pathname.slice("/v1/activity/".length);
      if (action === "observe") {
        if (epoch !== this.botEpoch) { return json(res, { error: "Bot 进程已更换" }, 409); }
        const observed = await this.activity.observe(data);
        if (epoch !== this.botEpoch) { this.activity.abandon(observed.seq, "Bot 在消息判定期间已重启"); return json(res, { error: "Bot 进程已更换" }, 409); }
        return json(res, observed);
      }
      if (action === "identity") { this.activity.identity(data.selfId); return json(res, { ok: true }); }
      if (action === "muted") { await this.groupMuted(String(data.groupId), data.throughGeneration); return json(res, { ok: true }); }
      if (action === "sent") { this.activity.sent(data.groupId, data.eventId); return json(res, { ok: true }); }
      if (action === "command") { return json(res, { text: await this.activity.command(String(data.groupId), String(data.userId), String(data.line)) }); }
      if (action === "abandon") {
        const key = data.triggerId ? `trigger:${data.triggerId}` : `observation:${data.observationId}`;
        const preparation = this.preparing.get(key);
        if (preparation) { preparation.controller.abort(new Error("Bot 已放弃提交")); await preparation.done; }
        for (const [id, run] of this.runs) {
          if (run.submissionKey === key && !run.delivered) {
            run.controller.abort(new Error("Bot 没有接收到运行 ID")); await run.task;
            await this.finishDelivery(id, true);
          }
        }
        this.activity.abandon(Number(data.observationId), "Bot 未能提交群聊消息");
        return json(res, { ok: true });
      }
      if (action === "finished") {
        await this.finishDelivery(data.runId, data.failed === true);
        return json(res, { ok: true });
      }
      return json(res, { error: "Not found" }, 404);
    }
    if (url.pathname === "/v1/sessions/reset" && req.method === "POST") {
      const data = JSON.parse((await body(req)).toString());
      if (epoch !== this.botEpoch) { return json(res, { error: "Bot 进程已更换" }, 409); }
      const key = chatSessionKey(data.session_id);
      await this.agent.reset(key);
      if (key.startsWith("chat:group:")) { this.activity?.reset(key.split(":")[2]); }
      return json(res, { ok: true });
    }
    if (
      !/^\/v1\/runs(?:\/[a-zA-Z0-9_-]+\/(?:events|approval|stop))?$/.test(
        url.pathname,
      )
    )
      return json(res, { error: "Not found" }, 404);
    const c = this.config();
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let releasePreparation: (() => void) | undefined;
      try {
      const data = JSON.parse((await body(req)).toString());
      if (epoch !== this.botEpoch) { return json(res, { error: "Bot 进程已更换" }, 409); }
      if (this.runs.size >= 500) {
        this.activity?.abandon(Number(data.context?.observationId), "运行队列已满");
        return json(res, { error: "运行队列已满" }, 429);
      }
      const sessionKey = chatSessionKey(data.session_id);
      const context = chatRunContext(sessionKey, data.context);
      let presented: string[] | undefined;
      if (context.route) { context.onPresented = files => { presented = files; }; }
      const muteGeneration = Number.isSafeInteger(data.context?.muteGeneration) && data.context.muteGeneration >= 0 ? data.context.muteGeneration : 0;
      if (context.route?.type === "group" && muteGeneration <= (this.mutedGenerations.get(context.route.groupId) ?? -1)) {
        this.activity?.abandon(Number(data.context?.observationId), "禁言前的旧回复已取消");
        return json(res, { error: "禁言前的旧回复已取消" }, 409);
      }
      if (this.activity && context.route?.type === "user" && [...c.modules.chat.blockedUsers, ...c.activity.botUsers].includes(Number(context.route.userId))) { return json(res, { error: "此用户在 AI 忽略名单中" }, 403); }
      let input = data.input;
      let groupId: string;
      let triggerId: string;
      let submissionKey: string;
      if (this.activity && context.route?.type === "group") {
        groupId = context.route.groupId;
        triggerId = data.context?.triggerId;
        submissionKey = triggerId ? `trigger:${triggerId}` : `observation:${data.context?.observationId}`;
        if (this.preparing.has(submissionKey)) { return json(res, { error: "消息正在准备提交" }, 409); }
        const preparation = new AbortController();
        let finish: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        this.preparing.set(submissionKey, { groupId, muteGeneration, controller: preparation, done });
        releasePreparation = () => { this.preparing.delete(submissionKey); finish(); };
        const submission = await this.activity.submission(groupId, Number(data.context?.observationId || 0), triggerId, AbortSignal.any([preparation.signal, this.shutdown.signal]));
        preparation.signal.throwIfAborted();
        input = submission.input; context.submission = submission.submission;
        context.route.userId = submission.actorId;
        if (submission.source === "idle") {
          context.route.admin = false;
        } else {
          const c = this.config();
          context.route.admin = [...c.modules.chat.admins, ...c.modules.management.operators].includes(Number(submission.actorId));
        }
      }
      const id = randomUUID(),
        controller = new AbortController();
      const run: Run = {
        created: Date.now(),
        events: [],
        listeners: new Set(),
        done: false,
        controller,
        approvalQueue: Promise.resolve(),
        groupId, muteGeneration, triggerId, submissionKey, batchId: context.submission?.batchId,
      };
      this.runs.set(id, run);
      if (groupId) { this.activity.delivery(id, groupId, triggerId, context.submission?.batchId); }
      const emit = (event, payload) => {
        if (event === "run.started") { run.execution = Promise.resolve().then(() => this.agent.whenCurrentSettled?.(sessionKey)); }
        const item = {
          event,
          run_id: id,
          timestamp: Date.now() / 1000,
          ...payload,
        };
        run.events.push(item);
        for (const listener of run.listeners) listener(item);
      };
      emit("run.queued", { session: sessionKey });
      json(res, { run_id: id, status: "queued" }, 202);
      run.task = this.agent
        .run(
          input,
          "chat",
          groupId ? [] : data.conversation_history || [],
          controller.signal,
          emit,
          data.instructions || "",
          c.modules.presentation.approvalEnabled
            ? (request) => this.askApproval(run, request, emit)
            : undefined,
          sessionKey,
          context,
        )
        .then(
          (output) => emit("run.completed", { output, ...(presented?.length ? { presented } : {}) }),
          (e) => { run.failed = true; emit("run.failed", { error: e.message, ...(presented?.length && !controller.signal.aborted ? { presented } : {}) }); },
        )
        .finally(() => {
          run.done = true;
        });
      return;
      } finally { releasePreparation?.(); }
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
          const seconds = this.config().modules.presentation.approvalTimeoutSec;
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
    await Promise.allSettled([...this.runs.values()].map(run => run.execution));
    await Promise.allSettled(this.background);
    await Promise.allSettled([...this.runs.values()].map(run => run.finishing));
  }
  /** 只有 SQLite 收尾成功才确认投递完成，并发通知共用同一个处理过程。 */
  finishDelivery(id: string, failed = false): Promise<void> {
    const run = this.runs.get(id);
    if (!run?.groupId || run.delivered) { return Promise.resolve(); }
    run.finishRequested = true; run.finishFailed ||= failed || run.failed;
    if (!run.finishing) {
      if (!run.done) { run.finishFailed = true; run.controller.abort(new Error("回复通道提前结束，取消未完成的原生任务")); }
      run.finishing = (async () => {
        await run.task;
        await run.execution;
        await this.activity.finished(id, run.batchId, run.finishFailed, run.triggerId);
        run.delivered = true;
      })().finally(() => { run.finishing = undefined; });
    }
    return run.finishing;
  }
  botDisconnected(): Promise<void> {
    if (!this.disconnecting) {
      this.disconnecting = this.disconnectBot().finally(() => { this.disconnecting = undefined; });
    }
    return this.disconnecting;
  }
  /** 禁言只取消目标 QQ 群的准备、执行和排队任务，保留原生会话历史。 */
  async groupMuted(groupId: string, throughGeneration: number): Promise<void> {
    if (!/^[1-9]\d*$/.test(groupId) || !Number.isSafeInteger(throughGeneration) || throughGeneration < 0) { throw new Error("禁言通知群号或回复代次无效"); }
    if (throughGeneration <= (this.mutedGenerations.get(groupId) ?? -1)) { return; }
    this.mutedGenerations.set(groupId, throughGeneration);
    const reason = new Error(`QQ 群 ${groupId} 中 Bot 已被禁言`);
    const preparations = [...this.preparing.values()].filter(item => item.groupId === groupId && item.muteGeneration <= throughGeneration);
    for (const item of preparations) { item.controller.abort(reason); }
    const runs = [...this.runs.entries()].filter(([, run]) => run.groupId === groupId && run.muteGeneration <= throughGeneration && !run.delivered);
    for (const [, run] of runs) { run.controller.abort(reason); }
    await Promise.allSettled(preparations.map(item => item.done));
    await Promise.all(runs.map(async ([id, run]) => {
      await run.task;
      await run.execution;
      await this.finishDelivery(id, true);
    }));
  }
  private async disconnectBot() {
    this.botEpoch = randomUUID();
    this.mutedGenerations.clear();
    const preparations = [...this.preparing.values()];
    for (const preparation of preparations) { preparation.controller.abort(new Error("Bot 连接已断开")); }
    await Promise.allSettled(preparations.map(preparation => preparation.done));
    for (const run of this.runs.values()) {
      if (!run.delivered) { run.controller.abort(new Error("Bot 连接已断开")); }
    }
    for (const [id, run] of this.runs) {
      if (run.delivered) { continue; }
      await run.task;
      await run.execution;
      if (run.groupId) { await this.finishDelivery(id, true).catch(this.onError); }
      else { run.delivered = true; }
    }
    this.activity?.disconnected();
  }
}
