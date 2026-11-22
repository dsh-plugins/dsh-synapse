import type { ConfigPanel } from "@dsh-plugin/dsh-loader/config";
import { select, text } from "./feature-config.js";

export const instructionPanel: ConfigPanel = {
  id: "instructions", title: "会话规则文件", custom: true,
  fields: [
    select("channel", "通道", [["chat", "聊天"], ["review", "审查"]]),
    text("content", "Markdown 正文", "", "textarea"),
  ],
  operations: [
    { id: "instructions.read", input: ["channel"], readOnly: true },
    { id: "instructions.save", input: ["channel", "content"], requiresRevision: true },
    { id: "instructions.inherit", input: ["channel"], requiresRevision: true },
  ],
};
