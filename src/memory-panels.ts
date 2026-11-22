import type { ConfigPanel } from "@dsh-plugin/dsh-loader/config";
import { array, flag, num, select, text } from "./feature-config.js";

const categories: [string, string][] = [["chat", "聊天（QQ / Discord 共享）"], ["review", "GitHub 审查"]];
export const memoryManagementPanels: ConfigPanel[] = [
  {
    id: "memory-import", title: "Hermes 记忆导入", custom: true,
    fields: [select("channel", "记忆分类", categories), { ...text("markdown", "Hermes 记忆 Markdown", "", "textarea"), max: 500000 },
      array("excluded", "忽略的条目", num("index", "序号", 0))],
    operations: [
      { id: "memory.preview", input: ["markdown", "channel"], readOnly: true },
      { id: "memory.import", input: ["markdown", "channel", "excluded"] },
    ],
  },
  {
    id: "memory", title: "长期记忆", custom: true,
    fields: [select("scope", "浏览范围", [["all", "全部"], ...categories]), select("channel", "记忆分类", categories),
      text("query", "检索关键词"), num("page", "页码", 1, 1), num("pageSize", "每页条数", 10, 1, 100),
      num("memoryId", "记忆 ID", 1, 1), text("text", "记忆正文", "", "textarea"),
      flag("confirmDelete", "确认删除")],
    operations: [
      { id: "memory.page", input: ["scope", "query", "page", "pageSize"], readOnly: true },
      { id: "memory.load", input: ["memoryId"], readOnly: true },
      { id: "memory.update", input: ["memoryId", "channel", "text"], requiresRevision: true },
      { id: "memory.delete", input: ["memoryId", "confirmDelete"], requiresRevision: true },
      { id: "memory.search", input: ["query", "channel"], readOnly: true },
      { id: "memory.recent", input: ["channel"], readOnly: true },
    ],
  },
];
