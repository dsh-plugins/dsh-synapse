import type { ConfigPanel } from "@dsh-plugin/dsh-loader/config";
import { text, flag, mcpServerItem, num } from "./feature-config.js";
import { activityField } from "./activity-config.js";
import { memoryManagementPanels } from "./memory-panels.js";
import { instructionPanel } from "./instruction-panel.js";

export const panels: ConfigPanel[] = [
  instructionPanel,
  {
    id: "groups", title: "查询 QQ 群", custom: true, fields: [text("id", "群号")],
    operations: [{ id: "groups.lookup", input: ["id"], readOnly: true }],
  },
  { id: "speech-api-key", title: "获取 BreezeBlue API Key", custom: true, fields: [], operations: [] },
  {
    id: "activity", title: "群聊上下文与主动回复", custom: true,
    fields: [{ ...activityField, key: "settings", hidden: false }, text("groupId", "群号"), text("type", "日志类型"), text("from", "开始时间"), text("to", "结束时间"), num("beforeId", "上一页 ID", 0)],
    operations: [
      { id: "activity.load", input: [], readOnly: true },
      { id: "activity.save", input: ["settings"], requiresRevision: true },
      { id: "activity.status", input: [], readOnly: true },
      { id: "activity.words", input: ["groupId"], readOnly: true },
      { id: "activity.logs", input: ["groupId", "type", "from", "to", "beforeId"], readOnly: true },
    ],
  },
  {
    id: "skills", title: "Skill 管理", custom: true,
    fields: [text("query", "搜索 Skill"), text("selected", "已选 Skill"), text("name", "Skill 名称"), { ...text("content", "Markdown 文档", "", "textarea"), max: 200000 }, flag("confirmDelete", "确认删除")],
    operations: [
      { id: "skills.list", input: ["query"], readOnly: true },
      { id: "skills.load", input: ["selected"], readOnly: true },
      { id: "skills.create", input: ["name", "content"] },
      { id: "skills.save", input: ["name", "content"], requiresRevision: true },
      { id: "skills.delete", input: ["name", "selected", "confirmDelete"], requiresRevision: true },
    ],
  },
  {
    id: "mcp", title: "MCP 管理", custom: true,
    fields: [text("originalName", "原 MCP 名称"), flag("confirmDelete", "确认删除"), { ...mcpServerItem, key: "server" }],
    operations: [
      { id: "mcp.test", input: ["server"], readOnly: true },
      { id: "mcp.save", input: ["originalName", "server"], requiresRevision: true },
      { id: "mcp.delete", input: ["originalName", "confirmDelete"], requiresRevision: true },
    ],
  },
  ...memoryManagementPanels,
  {
    id: "reviews", title: "GitHub 审查任务", custom: true,
    fields: [text("id", "任务 ID")],
    operations: [
      { id: "reviews.list", input: [], readOnly: true },
      { id: "reviews.read", input: ["id"], readOnly: true },
      { id: "reviews.retry", input: ["id"] },
    ],
  },
  {
    id: "status", title: "运行状态与配置同步", fields: [],
    operations: [
      { id: "status.read", input: [], readOnly: true, autoRun: true, button: { label: "刷新状态" }, result: [{ type: "text" }] },
      { id: "features.refresh", input: [], button: { label: "同步聊天命令修改的功能设置", success: "已同步，请在配置卡片查看已保存值" } },
    ],
  },
];
