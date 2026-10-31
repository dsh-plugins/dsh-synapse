import { randomUUID } from "node:crypto";

// Native lifecycle contract fixture; durable history survives owner disposal.
export function hostFixture(execute = async () => "done") {
  const created = [],
    resumed = [],
    disposed = [],
    attachments = [],
    stored = new Map(),
    logs = new Map(),
    permissionWrites = [];
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
            section: (s) => sections.push(s),
            variable: (name, fn) => variables.set(name, fn),
          },
          tools: {
            restrict: (filter) => restrictions.push(filter),
            register: (tool) => {
              tools.push(tool);
              return () => tools.splice(tools.indexOf(tool), 1);
            },
          },
        })[name],
      on: (name, fn) => listeners.set(name, fn),
    };
    const agent = {
      id,
      session: {
        id,
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
            emit("agent/error", { error });
          }
        })();
      },
      whenIdle: () => task,
    };
    await options.setup(scope, agent);
    const record = {
      options,
      agent,
      tools,
      restrictions,
      injected,
      conversation,
      selected,
    };
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
          agents: { create, resume: create },
          permissionPresets: permissions,
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
    select: (value) => {
      selection = value;
    },
  };
}
