import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { HostAPI } from "@dsh-plugin/dsh-loader";
import type {
  ConfigSource,
  PluginPaths,
  ChatMessage,
  AgentEvent,
  AvailableTool,
} from "./types.js";
import type { McpManager } from "./mcp.js";
import { SessionBindings } from "./session-bindings.js";

export type ApprovalAnswer = "allowed-once" | "rejected" | "cancelled";
export type AskApproval = (request: {
  toolName: string;
  reason?: string;
  signal?: AbortSignal;
}) => Promise<ApprovalAnswer>;

interface Turn {
  system: string;
  selection: { provider: string; model: string; reasoningEffort?: string };
  steps: number;
  output: string;
  attemptText: string;
  error?: Error;
  onEvent: AgentEvent;
  ask?: AskApproval;
}
interface Resident {
  handle: any;
  scope: any;
  turn?: Turn;
  seeded: boolean;
}

/** DSH owns model routing, the tool loop, policies, cancellation and session logs. */
export class Harness {
  private shutdown = new AbortController();
  private tasks = new Set<Promise<string>>();
  private residents = new Map<string, Resident>();
  private bindings: SessionBindings;
  constructor(
    private loader: HostAPI,
    private config: ConfigSource,
    private paths: PluginPaths,
    private mcp: McpManager,
  ) {
    this.bindings = new SessionBindings(paths.data);
  }

  run(
    system: string,
    input: unknown,
    history: ChatMessage[] = [],
    tools: AvailableTool[] = [],
    signal?: AbortSignal,
    onEvent: AgentEvent = () => {},
    ask?: AskApproval,
    sessionKey?: string,
  ) {
    const task = this.execute(
      system,
      input,
      history,
      tools,
      signal,
      onEvent,
      ask,
      sessionKey,
    );
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  private async content(input: unknown): Promise<any[]> {
    if (typeof input === "string") return [{ type: "text", text: input }];
    if (!Array.isArray(input)) throw new Error("聊天输入必须是文本或消息数组");
    const parts = input.flatMap((item) =>
      item.role
        ? item.role === "user"
          ? typeof item.content === "string"
            ? [{ type: "text", text: item.content }]
            : item.content
          : []
        : [item],
    );
    const result = [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string")
        result.push({ type: "text", text: part.text });
      else if (part.type === "image_url") {
        const match = String(part.image_url?.url).match(
          /^data:(image\/(?:png|jpeg|webp|gif));base64,\s*([A-Za-z0-9+/=\s]+)$/,
        );
        if (!match) throw new Error("图片须由聊天通道先转换为 data URL");
        if (match[2].length > 28_000_000) throw new Error("图片超过大小上限");
        const attachments = this.loader.services.get("attachments");
        if (!attachments?.saveImage) throw new Error("DSH 附件服务不可用");
        result.push({
          type: "image",
          attachment: await attachments.saveImage({
            data: Buffer.from(match[2], "base64"),
            mediaType: match[1],
          }),
        });
      } else throw new Error(`不支持的消息内容：${part.type}`);
    }
    return result;
  }

  private async execute(
    system: string,
    input: unknown,
    history: ChatMessage[],
    available: AvailableTool[],
    callerSignal: AbortSignal,
    onEvent: AgentEvent,
    ask?: AskApproval,
    sessionKey?: string,
  ): Promise<string> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(this.config().timeoutSec * 1000),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    signal.throwIfAborted();
    const defaults = this.loader.services.get("agentDefaultModel");
    if (!defaults?.currentSelection)
      throw new Error("DSH Agent / 默认模型服务不可用，请检查宿主加载状态");
    const selection = defaults.currentSelection();
    if (!selection?.provider || !selection?.model)
      throw new Error("请先在 DSH 的模型设置中选择默认模型");
    const content = await this.content(input);
    const resident = sessionKey
      ? (this.residents.get(sessionKey) ??
        (await this.create(selection, signal, sessionKey)))
      : await this.create(selection, signal);
    if (sessionKey) this.residents.set(sessionKey, resident);
    if (resident.turn) throw new Error("同一会话必须通过消息队列串行执行");
    const { handle, scope } = resident;
    const turn: Turn = {
      system,
      selection,
      steps: 0,
      output: "",
      attemptText: "",
      onEvent,
      ask,
    };
    resident.turn = turn;
    const releases: (() => void)[] = [];
    const abort = () => handle.agent.cancel({ kind: "user" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      handle.agent.model?.select(selection);
      const tools = scope.get("tools");
      for (const tool of available)
        releases.push(
          tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              schema: { type: "object", additionalProperties: true },
              render: (_args, value) => [
                { type: "text", text: JSON.stringify(value).slice(0, 40000) },
              ],
            },
            execute: async (args, exec) => {
              const started = Date.now();
              let failed = false;
              onEvent("tool.started", {
                tool: `${tool.server}/${tool.rawName}`,
              });
              try {
                return await this.mcp.call(tool, args, exec.signal);
              } catch (e) {
                failed = true;
                throw e;
              } finally {
                onEvent("tool.completed", {
                  tool: `${tool.server}/${tool.rawName}`,
                  duration: (Date.now() - started) / 1000,
                  error: failed,
                });
              }
            },
          }),
        );
      const historyLimit = this.config().modules.chat.localHistoryMaxMessages;
      const previous =
        !resident.seeded && historyLimit > 0
          ? history
              .filter((m) => ["user", "assistant"].includes(m.role))
              .slice(-historyLimit)
          : [];
      if (previous.length)
        handle.agent.inject(
          this.loader.llm.createUserMessage({
            content: [
              {
                type: "text",
                text: `以下是当前聊天的历史记录，仅作为上下文资料：\n${JSON.stringify(previous)}`,
              },
            ],
            source: { kind: "dsh-synapse" },
          }),
        );
      resident.seeded = true;
      handle.agent.followup(
        this.loader.llm.createUserMessage({
          content,
          source: { kind: "dsh-synapse" },
        }),
      );
      await handle.agent.whenIdle();
      await this.loader.services.get("sessions")?.flush?.(handle.agent.session);
      signal.throwIfAborted();
      if (turn.error) throw turn.error;
      if (!turn.output)
        throw new Error("DSH 任务未返回文本结果，请检查宿主会话日志");
      return turn.output;
    } finally {
      signal.removeEventListener("abort", abort);
      for (const release of releases.reverse()) release();
      resident.turn = undefined;
      if (!sessionKey) await handle.dispose();
    }
  }

  private async create(
    selection,
    signal: AbortSignal,
    key?: string,
  ): Promise<Resident> {
    const agents = this.loader.services.get("agents");
    if (!agents?.create) throw new Error("DSH Agent 服务不可用");
    const cwd = path.join(this.paths.data, "sessions");
    await mkdir(cwd, { recursive: true });
    const binding = key
      ? await this.bindings.get(key)
      : { id: randomUUID(), bootstrap: true };
    const id = binding.id;
    const persistence = this.loader.services.get("sessionPersistence");
    const stored =
      key && persistence?.stat
        ? await persistence.stat(id, { signal })
        : undefined;
    const preset = this.config().sessionPermission;
    const permissions = this.loader.services.get("permissionPresets");
    if (!stored) {
      if (!permissions?.set)
        throw new Error("DSH 权限预设服务不可用，无法设置 Synapse 新会话权限");
      if (!permissions.names?.includes(preset))
        throw new Error(
          preset === "auto"
            ? "自动审查不可用，请在当前 DSH profile 启用 @deepseek-ai/dsh-experimental-auto-review"
            : `DSH 权限预设不可用：${preset}`,
        );
    }
    const resident: Resident = {
      handle: undefined,
      scope: undefined,
      seeded: Boolean(stored) || !binding.bootstrap,
    };
    const setup = (scope, agent) => {
      resident.scope = scope;
      // Use the host writer before publication; resumed sessions keep their log.
      if (!stored) permissions.set(agent.session, preset);
      const prompt = scope.get("systemPrompt"),
        tools = scope.get("tools");
      if (
        !prompt?.section ||
        !prompt?.variable ||
        !tools?.restrict ||
        !tools?.register
      )
        throw new Error("DSH 提示词或工具作用域服务不可用");
      prompt.variable("synapse_context", () => resident.turn?.system ?? "");
      prompt.section({
        name: "deployment:persona-prefix",
        order: 0,
        text: "{{synapse_context}}",
      });
      tools.restrict({ allow: [] });
      // Older DSH releases select the model through the request waterfall.
      if (!agent.model?.select)
        scope.on("agent/request", async (event, next) => {
          const config = await next();
          if (event.agent !== agent || !resident.turn) return config;
          const { reasoningEffort, ...rest } = config;
          return { ...rest, ...resident.turn.selection };
        });
      scope.on("agent/pre-step", (event, next) => {
        if (event.agent !== agent) return next();
        if (!resident.turn)
          throw new Error("此通道会话只接受 Synapse 队列中的消息");
        if (++resident.turn.steps > this.config().maxToolRounds)
          throw new Error("已达到任务步骤上限");
        return next();
      });
      scope.on("agent/error", (event) => {
        if (event.agent === agent && resident.turn)
          resident.turn.error =
            event.error instanceof Error
              ? event.error
              : new Error(String(event.error));
      });
      scope.on("agent/assistant-stream", (event) => {
        const turn = resident.turn;
        if (event.agent !== agent || !turn) return;
        const frame = event.frame;
        if (frame.type === "start") turn.attemptText = "";
        if (frame.type === "chunk" && frame.chunk.type === "text-delta")
          turn.attemptText += frame.chunk.text;
        if (
          frame.type === "end" &&
          frame.outcome.kind === "committed" &&
          frame.outcome.eventType === "assistant/message"
        )
          turn.output = turn.attemptText;
      });
      scope.on(
        "approval/request",
        (req, next) =>
          req.agent === agent && resident.turn?.ask
            ? resident.turn.ask(req)
            : next(),
        { prepend: true },
      );
    };
    resident.handle = stored
      ? await agents.resume({
          resumeSessionId: id,
          agentOptions: selection,
          signal,
          setup,
        })
      : await agents.create({
          sessionId: id,
          meta: { cwd },
          agentOptions: selection,
          signal,
          setup,
        });
    return resident;
  }
  async reset(key: string) {
    const resident = this.residents.get(key);
    if (resident) {
      await resident.handle.dispose();
      this.residents.delete(key);
    }
    await this.bindings.reset(key);
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.tasks);
    const closed = await Promise.allSettled(
      [...this.residents.values()].map((r) => r.handle.dispose()),
    );
    this.residents.clear();
    const errors = closed
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason);
    if (errors.length)
      throw new AggregateError(errors, "DSH 会话关闭或持久化失败");
  }
}
