import { randomUUID } from "node:crypto";

// Native lifecycle contract fixture; durable history survives owner disposal.
export function hostFixture(execute = async () => "done", { legacySubagents = false, workspaces = false } = {}) {
  const created = [],
    resumed = [],
    disposed = [],
    attachments = [],
    stored = new Map(),
    logs = new Map(),
    headers = new Map(),
    permissionWrites = [],
    records = new Map(),
    liveAgents = new Map(),
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
  const archived = new Set(), workspaceEntries = new Map();
  const workspaceRegistry = workspaces ? {
    get archivedSessionIds() { return [...archived]; },
    archiveSession: async (id) => { archived.add(id); },
    list: () => [...workspaceEntries.values()],
    async create(cwd) {
      if (!workspaceEntries.has(cwd)) {
        const members = new Set();
        workspaceEntries.set(cwd, {
          path: cwd,
          get sessionIds() { return [...members]; },
          async attachSession(id) {
            if (headers.get(id)?.cwd !== cwd) { throw new Error("会话原始目录与工作区不匹配"); }
            members.add(id);
          },
        });
      }
      return workspaceEntries.get(cwd);
    },
  } : undefined;
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
    if (liveAgents.has(id)) {
      throw Object.assign(new Error(`会话 ${id} 已有活动代理`), { name: "SessionAlreadyOwnedError" });
    }
    const conversation = stored.get(id) ?? [];
    stored.set(id, conversation);
    const events = logs.get(id) ?? [];
    logs.set(id, events);
    const header = headers.get(id) ?? { id, ...options.meta };
    headers.set(id, header);
    const listeners = new Map(),
      tools = [],
      sections = [],
      contexts = [],
      variables = new Map(),
      injected = [],
      restrictions = [],
      selected = [];
    let committedInjections = 0;
    let lastTurn = events.findLast(event => event.type === "turn/start")?.data.turn ?? 0;
    let runtimeContext = events.findLast(event => event.type === "user/message" && event.data.source?.kind === "runtime-context")?.data.content[0]?.text ?? "";
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
            context: (entry) => {
              contexts.push(entry);
              return () => contexts.splice(contexts.indexOf(entry), 1);
            },
            variable: (name, fn) => {
              variables.set(name, fn);
              return () => variables.delete(name);
            },
          },
          tools: {
            get: (name) => tools.find(tool => tool.name === name),
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
        header,
        events,
        append: (type, data) => {
          const event = { type, data };
          events.push(event);
          listeners.get("session/event")?.(agent.session, event);
        },
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
          let turn;
          try {
            conversation.push(message);
            const admission = await listeners.get("agent/pre-step")?.({ agent }, async () => ({
              kind: archived.has(id) ? "reject" : "enter",
            }));
            if (admission?.kind === "reject") { return; }
            turn = ++lastTurn;
            agent.session.append("turn/start", { turn });
            for (const context of injected.slice(committedInjections)) { agent.session.append("user/message", context); }
            committedInjections = injected.length;
            agent.session.append("user/message", message);
            const currentContext = contexts.map(entry => entry.text({ agent })).filter(Boolean).join("\n");
            if (currentContext !== runtimeContext) {
              const context = { role: "user", content: [{ type: "text", text: currentContext }], source: { kind: "runtime-context" } };
              conversation.push(context);
              agent.session.append("user/message", context);
              runtimeContext = currentContext;
            }
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
              session: agent.session,
              turn,
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
          } finally {
            if (turn !== undefined) { agent.session.append("turn/end", { turn }); }
          }
        })();
      },
      whenIdle: () => task,
    };
    await options.setup?.(scope, agent);
    const handle = {
      agent,
      dispose: async () => {
        if (liveAgents.get(id) !== agent) { return; }
        disposed.push(agent.id);
        controller.abort();
        await task;
        liveAgents.delete(id);
      },
    };
    const record = {
      options,
      agent,
      handle,
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
    liveAgents.set(id, agent);
    broadcast("agent/created", { agent });
    if (options.resumeSessionId) resumed.push(record);
    else created.push(record);
    return handle;
  }
  const agents = { create, resume: create, get: id => liveAgents.get(id), ctx: globalContext };
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
    dsh: { agentInstructions: { renderAgentInstructions: files => ({ text: files.map(file => `${file.displayPath}\n${file.content}`).join("\n") }) } },
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
          sessions: { flush: async () => true },
          subagents,
          workspaceRegistry,
          agentPresets: {
            async mount(scope, id) {
              if (id !== "standard") { throw new Error("预设不存在"); }
              scope.get("systemPrompt").section({ name: "deployment:persona-prefix", text: "宿主标准系统提示词" });
              scope.get("tools").register({ name: "standard_read", execute: async () => ({ content: "宿主标准工具结果" }) });
              return { id };
            },
            presetForSession: session => session.events.filter(event => event.type === "agent-preset/selected").at(-1)?.data.agentPreset ?? session.header.agentPreset ?? null,
          },
          workingDirectory: {
            get: (session) => session.events.filter(event => event.type === "working-directory/change").at(-1)?.data.cwd ?? session.header.cwd,
            set: async (agent, cwd, signal) => {
              signal?.throwIfAborted();
              agent.session.append("working-directory/change", { cwd });
              return cwd;
            },
          },
          permissionPresets: permissions,
          sessionTitle: {
            get: (session) => session.events.filter((e) => e.type === "session/title").at(-1)?.data,
            rename: (session, title) => session.append("session/title", { title }),
          },
          sessionPersistence: {
            stat: async (id) =>
              stored.has(id) ? { header: headers.get(id) } : undefined,
            flush: async () => {},
            open: async (id, access) => {
              if (access !== "read") { throw new Error("测试只读句柄不接受写入"); }
              if (!logs.has(id)) { throw Object.assign(new Error("会话不存在"), { name: "SessionPersistenceNotFoundError" }); }
              return { read: async (offset = 0, length = Infinity) => ({ events: logs.get(id).slice(offset, offset + length) }), close: async () => {} };
            },
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
    workspaceRegistry,
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
