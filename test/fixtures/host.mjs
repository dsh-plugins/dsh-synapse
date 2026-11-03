import { randomUUID } from "node:crypto";

// Native lifecycle contract fixture; durable history survives owner disposal.
export function hostFixture(execute = async () => "done", { legacySubagents = false } = {}) {
  const created = [],
    resumed = [],
    disposed = [],
    attachments = [],
    stored = new Map(),
    logs = new Map(),
    permissionWrites = [],
    records = new Map(),
    failures = new Map(),
    activeChildren = new Map(),
    globalListeners = new Map();
  const globalContext = {
    on(name, listener) {
      const set = globalListeners.get(name) ?? new Set();
      globalListeners.set(name, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  const broadcast = (name, data) => {
    for (const listener of globalListeners.get(name) ?? []) {
      listener(data);
    }
  };
  const permissions = {
    names: ["read-only", "workspace-write", "danger-full-access", "auto"],
    set(session, preset) {
      if (!this.names.includes(preset)) throw new Error("unknown preset");
      session.append("permission/preset", { preset });
      permissionWrites.push({ sessionId: session.id, preset });
    },
  };
  let selection = {
    provider: "configured-provider",
    model: "configured-model",
  };
  async function create(options) {
    const id = options.sessionId ?? options.resumeSessionId;
    const conversation = stored.get(id) ?? [];
    stored.set(id, conversation);
    const events = logs.get(id) ?? [];
    logs.set(id, events);
    const listeners = new Map(),
      tools = [],
      sections = [],
      variables = new Map(),
      injected = [],
      restrictions = [],
      selected = [];
    let controller = new AbortController(),
      task = Promise.resolve();
    const emit = (name, data) => listeners.get(name)?.({ agent, ...data });
    const scope = {
      get: (name) =>
        ({
          systemPrompt: {
            section: (s) => {
              sections.push(s);
              return () => sections.splice(sections.indexOf(s), 1);
            },
            variable: (name, fn) => {
              variables.set(name, fn);
              return () => variables.delete(name);
            },
          },
          tools: {
            restrict: (filter) => {
              restrictions.push(filter);
              return () => restrictions.splice(restrictions.indexOf(filter), 1);
            },
            register: (tool) => {
              tools.push(tool);
              return () => tools.splice(tools.indexOf(tool), 1);
            },
          },
        })[name],
      on(name, fn) {
        listeners.set(name, fn);
        return () => {
          if (listeners.get(name) === fn) {
            listeners.delete(name);
          }
        };
      },
    };
    const agent = {
      id,
      session: {
        id,
        header: { id, ...options.meta },
        events,
        append: (type, data) => events.push({ type, data }),
      },
      ctx: scope,
      model: { select: (s) => selected.push(s) },
      inject: (message) => {
        injected.push(message);
        conversation.push(message);
      },
      cancel: () => controller.abort(),
      followup: (message) => {
        controller = new AbortController();
        task = (async () => {
          try {
            conversation.push(message);
            await listeners.get("agent/pre-step")?.({ agent }, async () => ({
              kind: "enter",
            }));
            const output = await execute({
              options,
              message,
              conversation,
              injected,
              selected,
              tools,
              sections,
              variables,
              restrictions,
              signal: controller.signal,
              emit,
              approve: (req) =>
                listeners.get("approval/request")?.(
                  { agent, ...req },
                  async () => "unavailable",
                ),
            });
            emit("agent/assistant-stream", { frame: { type: "start" } });
            emit("agent/assistant-stream", {
              frame: {
                type: "chunk",
                chunk: { type: "text-delta", text: output },
              },
            });
            emit("agent/assistant-stream", {
              frame: {
                type: "end",
                outcome: { kind: "committed", eventType: "assistant/message" },
              },
            });
            conversation.push({ role: "assistant", content: output });
          } catch (error) {
            failures.set(id, error);
            emit("agent/error", { error });
          }
        })();
      },
      whenIdle: () => task,
    };
    await options.setup?.(scope, agent);
    const record = {
      options,
      agent,
      tools,
      restrictions,
      injected,
      conversation,
      selected,
      sections,
      variables,
      listeners,
    };
    records.set(id, record);
    broadcast("agent/created", { agent });
    if (options.resumeSessionId) resumed.push(record);
    else created.push(record);
    return {
      agent,
      dispose: async () => {
        disposed.push(agent.id);
        controller.abort();
        await task;
      },
    };
  }
  const agents = { create, resume: create, ctx: globalContext };
  async function startActivation(spec) {
    spec.signal.throwIfAborted();
    const parent = spec.request.parent;
    const handle = await create({
      sessionId: spec.childId,
      meta: { origin: "subagent", parentSession: parent.id, delegationDepth: 1 },
      setup: (_scope, agent) => agent.model.select(records.get(parent.id).selected.at(-1)),
    });
    handle.agent.followup({ role: "user", content: spec.request.prompt });
    const result = handle.agent.whenIdle().then(() => ({
      output: [{ type: "text", text: records.get(spec.childId).conversation.at(-1)?.content ?? "" }],
      stopReason: failures.has(spec.childId) ? "error" : "completed",
    }));
    const activation = { childId: spec.childId, result, dispose: async () => {
      await handle.dispose();
      activeChildren.delete(spec.childId);
    } };
    activeChildren.set(spec.childId, activation);
    return activation;
  }
  const subagents = {
    ctx: globalContext,
    getProvider: () => ({ prepareContinuable: async () => ({}) }),
    ...(legacySubagents ? {
      async startContinuable(spec) {
        const activation = await startActivation(spec);
        void activation.result.then((result) => broadcast("subagent/end", { id: spec.childId, stopReason: result.stopReason, lastAssistantMessage: result.output }));
        return { childId: spec.childId };
      },
      async drainContinuableChildren(_parent, ids) {
        for (const id of ids) {
          await activeChildren.get(id)?.dispose();
        }
      },
    } : { startActivation }),
  };
  const loader = {
    llm: {
      createUserMessage: (input) => ({
        id: randomUUID(),
        role: "user",
        ...input,
      }),
    },
    services: {
      get: (name) =>
        ({
          agents,
          subagents,
          permissionPresets: permissions,
          sessionTitle: {
            get: (session) => session.events.filter((e) => e.type === "session/title").at(-1)?.data,
            rename: (session, title) => session.append("session/title", { title }),
          },
          sessionPersistence: {
            stat: async (id) =>
              stored.has(id) ? { header: { id } } : undefined,
          },
          agentDefaultModel: { currentSelection: () => ({ ...selection }) },
          attachments: {
            saveImage: async (image) => {
              attachments.push(image);
              return { attachmentId: "image-1" };
            },
          },
        })[name],
    },
  };
  return {
    loader,
    created,
    resumed,
    disposed,
    attachments,
    stored,
    permissions,
    permissionWrites,
    listenerCount: (name) => globalListeners.get(name)?.size ?? 0,
    select: (value) => {
      selection = value;
    },
  };
}
