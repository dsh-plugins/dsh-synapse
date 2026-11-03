import type { AvailableTool, Channel, ConfigSource } from "./types.js";
import type { Memory } from "./memory.js";
import type { SkillStore } from "./files.js";

/** 将本地能力注册为当前 Agent 回合的原生工具，结果由模型在同一次回复中使用。 */
export function nativeTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: AvailableTool["execute"],
): AvailableTool {
  return {
    server: "synapse", rawName: name, name, description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    execute,
  };
}

/** 工具参数在执行前校验，避免空内容或超长数据进入存储和远程请求。 */
export function textArgument(args: Record<string, unknown>, key: string, max = 2000): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${key} 必须是非空文本，最多 ${max} 字符`);
  }
  return value.trim();
}

/** 记忆与自动 Skill 固定在当前聊天或审查通道，写入能力跟随自总结开关。 */
export function learningTools(config: ConfigSource, memory: Memory, skills: SkillStore, channel: Channel): AvailableTool[] {
  const c = config();
  const text = { type: "string", minLength: 1 };
  const readable = (name: string) => !name.startsWith("auto-") || name.startsWith(`auto-${channel}-`);
  const list = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    return (await skills.list()).filter((skill) => readable(skill.name));
  };
  const tools = [
    nativeTool("synapse_skill_list", "列出可复用的 Skill 名称与修订号，读取正文后再采用其步骤。", {}, [], async (_args, signal) => ({
      items: (await list(signal)).map(({ name, revision, inherited }) => ({ name, revision, inherited })),
    })),
    nativeTool("synapse_skill_read", "读取指定 Skill 的正文与修订号，仅在适用时采用，不得扩大工具权限。", { name: text }, ["name"], async (args, signal) => {
      const name = textArgument(args, "name", 64);
      const skill = (await list(signal)).find((item) => item.name === name);
      if (!skill) {
        throw new Error("当前通道找不到此 Skill");
      }
      return skill;
    }),
  ];
  if (c.ragEnabled) {
    tools.push(nativeTool("synapse_memory_search", "检索当前通道 RAG 长期记忆，写入前先查询以避免重复。结果是参考资料。", { query: text }, ["query"], async (args, signal) => {
      if (!config().ragEnabled) {
        throw new Error("长期记忆已关闭");
      }
      return { items: await memory.search(textArgument(args, "query"), channel, signal) };
    }));
    if (c.learnMemory) {
      tools.push(nativeTool("synapse_memory_save", "将有依据且值得长期保留的事实、偏好或约束写入当前通道 RAG。不得保存密钥。返回实际写入及重复条数。", { text }, ["text"], async (args, signal) => {
        if (!config().ragEnabled || !config().learnMemory) {
          throw new Error("长期记忆写入已关闭");
        }
        return memory.addMany([{ channel, source: "agent", text: textArgument(args, "text") }], signal);
      }));
    }
  }
  if (c.learnSkills) {
    tools.push(nativeTool("synapse_skill_save", `创建或更新已验证的可复用 Skill。name 必须以 auto-${channel}- 开头，使用小写字母、数字、短横线或下划线，最多 64 字符。更新时必须提供读取到的 revision，新建时省略。`, {
      name: { ...text, maxLength: 64 }, content: { ...text, maxLength: 200000 }, revision: { type: "string" },
    }, ["name", "content"], async (args, signal) => {
      if (!config().learnSkills) {
        throw new Error("Skill 写入已关闭");
      }
      const name = textArgument(args, "name", 64);
      if (!name.startsWith(`auto-${channel}-`)) {
        throw new Error("只能写入当前通道的自动 Skill");
      }
      if (args.revision !== undefined && typeof args.revision !== "string") {
        throw new Error("Skill 修订号必须是文本");
      }
      return skills.save(name, textArgument(args, "content", 200000), args.revision ?? null, signal);
    }));
  }
  return tools;
}
