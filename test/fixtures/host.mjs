import { randomUUID } from "node:crypto";

// Contract fixture for the public native Agent lifecycle (not a second model API).
export function hostFixture(execute = async () => "done") {
  const created = [],
    disposed = [],
    attachments = [];
  let selection = {
    provider: "configured-provider",
    model: "configured-model",
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
          agentDefaultModel: { currentSelection: () => ({ ...selection }) },
          attachments: {
            saveImage: async (image) => {
              attachments.push(image);
              return { attachmentId: "image-1" };
            },
          },
          agents: {
            create: async (options) => {
              const listeners = new Map(),
                tools = [],
                sections = [],
                variables = new Map(),
                injected = [],
                restrictions = [];
              const controller = new AbortController();
              let task = Promise.resolve();
              const emit = (name, data) =>
                listeners.get(name)?.({ agent, ...data });
              const scope = {
                get: (name) =>
                  ({
                    systemPrompt: {
                      section: (s) => sections.push(s),
                      variable: (name, fn) => variables.set(name, fn),
                    },
                    tools: {
                      restrict: (filter) => restrictions.push(filter),
                      register: (tool) => tools.push(tool),
                    },
                  })[name],
                on: (name, fn) => listeners.set(name, fn),
              };
              const agent = {
                id: options.sessionId,
                ctx: scope,
                inject: (message) => injected.push(message),
                cancel: () => controller.abort(),
                followup: (message) => {
                  task = (async () => {
                    try {
                      await listeners.get("agent/pre-step")?.(
                        { agent },
                        async () => ({ kind: "enter" }),
                      );
                      const output = await execute({
                        options,
                        message,
                        injected,
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
                      emit("agent/assistant-stream", {
                        frame: { type: "start" },
                      });
                      emit("agent/assistant-stream", {
                        frame: {
                          type: "chunk",
                          chunk: { type: "text-delta", text: output },
                        },
                      });
                      emit("agent/assistant-stream", {
                        frame: {
                          type: "end",
                          outcome: {
                            kind: "committed",
                            eventType: "assistant/message",
                          },
                        },
                      });
                    } catch (error) {
                      emit("agent/error", { error });
                    }
                  })();
                },
                whenIdle: () => task,
              };
              await options.setup(scope, agent);
              created.push({ options, agent, tools, restrictions, injected });
              return {
                agent,
                dispose: async () => {
                  disposed.push(agent.id);
                  controller.abort();
                  await task;
                },
              };
            },
          },
        })[name],
    },
  };
  return {
    loader,
    created,
    disposed,
    attachments,
    select: (value) => {
      selection = value;
    },
  };
}
