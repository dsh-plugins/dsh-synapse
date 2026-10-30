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

export type ApprovalAnswer = "allowed-once" | "rejected" | "cancelled";
export type AskApproval = (request: {
  toolName: string;
  reason?: string;
  signal?: AbortSignal;
}) => Promise<ApprovalAnswer>;

/** DSH owns model routing, the tool loop, policies, cancellation and session logs. */
export class Harness {
  private shutdown = new AbortController();
  private tasks = new Set<Promise<string>>();
  constructor(
    private loader: HostAPI,
    private config: ConfigSource,
    private paths: PluginPaths,
    private mcp: McpManager,
  ) {}

  run(
    system: string,
    input: unknown,
    history: ChatMessage[] = [],
    tools: AvailableTool[] = [],
    signal?: AbortSignal,
    onEvent: AgentEvent = () => {},
    ask?: AskApproval,
  ) {
    const task = this.execute(
      system,
      input,
      history,
      tools,
      signal,
      onEvent,
      ask,
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
  ): Promise<string> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(this.config().timeoutSec * 1000),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    signal.throwIfAborted();
    const agents = this.loader.services.get("agents");
    const defaults = this.loader.services.get("agentDefaultModel");
    if (!agents?.create || !defaults?.currentSelection)
      throw new Error("DSH Agent / 默认模型服务不可用，请检查宿主加载状态");
    const selection = defaults.currentSelection();
    if (!selection?.provider || !selection?.model)
      throw new Error("请先在 DSH 的模型设置中选择默认模型");
    const content = await this.content(input);
    const cwd = path.join(this.paths.data, "sessions");
    await mkdir(cwd, { recursive: true });
    let error: Error;
    let output = "",
      attemptText = "";
    let steps = 0;
    const handle = await agents.create({
      sessionId: randomUUID(),
      meta: { cwd },
      agentOptions: selection,
      signal,
      setup: (scope, agent) => {
        const prompt = scope.get("systemPrompt"),
          tools = scope.get("tools");
        if (
          !prompt?.section ||
          !prompt?.variable ||
          !tools?.restrict ||
          !tools?.register
        )
          throw new Error("DSH 提示词或工具作用域服务不可用");
        prompt.variable("synapse_context", () => system);
        prompt.section({
          name: "deployment:persona-prefix",
          order: 0,
          text: "{{synapse_context}}",
        });
        // Preserve the existing channel boundary: only explicitly allowed MCP tools.
        // Actual calls still pass through the DSH executor and permission policies.
        tools.restrict({ allow: [] });
        for (const tool of available)
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
          });
        scope.on("agent/pre-step", (event, next) => {
          if (event.agent !== agent) return next();
          if (++steps > this.config().maxToolRounds)
            throw new Error("已达到任务步骤上限");
          return next();
        });
        scope.on("agent/error", (event) => {
          if (event.agent === agent)
            error =
              event.error instanceof Error
                ? event.error
                : new Error(String(event.error));
        });
        scope.on("agent/assistant-stream", (event) => {
          if (event.agent !== agent) return;
          const frame = event.frame;
          if (frame.type === "start") attemptText = "";
          if (frame.type === "chunk" && frame.chunk.type === "text-delta")
            attemptText += frame.chunk.text;
          if (
            frame.type === "end" &&
            frame.outcome.kind === "committed" &&
            frame.outcome.eventType === "assistant/message"
          )
            output = attemptText;
        });
        if (ask)
          scope.on(
            "approval/request",
            (req, next) => (req.agent === agent ? ask(req) : next()),
            { prepend: true },
          );
      },
    });
    const abort = () => handle.agent.cancel({ kind: "user" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const historyLimit = this.config().modules.chat.localHistoryMaxMessages;
      const previous =
        historyLimit > 0
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
            source: { kind: "plugin", plugin: "@dsh-plugin/dsh-synapse" },
          }),
        );
      handle.agent.followup(
        this.loader.llm.createUserMessage({
          content,
          source: { kind: "plugin", plugin: "@dsh-plugin/dsh-synapse" },
        }),
      );
      await handle.agent.whenIdle();
      signal.throwIfAborted();
      if (error) throw error;
      if (!output)
        throw new Error("DSH 任务未返回文本结果，请检查宿主会话日志");
      return output;
    } finally {
      signal.removeEventListener("abort", abort);
      await handle.dispose();
    }
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.tasks);
  }
}
