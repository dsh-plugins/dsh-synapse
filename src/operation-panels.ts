import type { ConfigPanel } from "@dsh-plugin/dsh-loader/config";
import { text, flag, select } from "./feature-config.js";

const fill = (...keys: string[]) =>
  keys.map((key) => ({ from: [key], to: [key] }));
const editorFields = ["selected", "name", "content", "confirmDelete"];

export const panels: ConfigPanel[] = [
  {
    id: "skills",
    title: "Skill 管理",
    description:
      "选择已有 Skill 编辑，或填写名称并粘贴 Markdown 后创建。同名 Home Skill 保存后生成当前 profile 的覆盖文件。",
    fields: [
      {
        type: "select",
        key: "selected",
        label: "已有 Skill",
        optionsFrom: {
          operation: "skills.list",
          path: ["items"],
          label: ["label"],
          value: ["name"],
        },
      },
      text("name", "Skill 名称"),
      {
        ...text("content", "Markdown 文档（可直接粘贴导入）", "", "textarea"),
        max: 200000,
      },
      flag("confirmDelete", "确认删除当前 profile 中选中的 Skill"),
    ],
    operations: [
      {
        id: "skills.list",
        input: [],
        readOnly: true,
        autoRun: true,
        button: { label: "刷新 Skill 列表" },
      },
      {
        id: "skills.load",
        input: ["selected"],
        readOnly: true,
        onChange: [["selected"]],
        button: { label: "重新加载 Skill" },
        fill: fill(...editorFields),
        result: [{ type: "text", path: ["origin"], title: "来源" }],
      },
      {
        id: "skills.new",
        input: [],
        readOnly: true,
        button: { label: "清空编辑器" },
        fill: fill(...editorFields),
      },
      {
        id: "skills.preview",
        input: ["content"],
        readOnly: true,
        button: { label: "预览 Markdown" },
        result: [{ type: "markdown" }],
      },
      {
        id: "skills.create",
        input: ["name", "content"],
        button: { label: "创建 Skill", success: "Skill 已创建" },
        fill: fill(...editorFields),
        refresh: ["skills.list"],
      },
      {
        id: "skills.save",
        input: ["name", "content"],
        requiresRevision: true,
        button: { label: "保存 Skill", success: "Skill 已保存到当前 profile" },
        fill: fill(...editorFields),
        refresh: ["skills.list"],
      },
      {
        id: "skills.delete",
        input: ["name", "selected", "confirmDelete"],
        requiresRevision: true,
        button: { label: "删除 Skill", success: "Skill 已删除" },
        fill: fill(...editorFields),
        refresh: ["skills.list"],
      },
    ],
  },
  {
    id: "mcp",
    title: "MCP 工具预览",
    description:
      "服务配置在上方保存后生效。此处只读取已保存且启用的服务名称，不展示凭据。",
    fields: [
      {
        type: "select",
        key: "name",
        label: "MCP 服务",
        optionsFrom: {
          operation: "mcp.servers",
          path: ["items"],
          label: ["name"],
          value: ["name"],
        },
      },
    ],
    operations: [
      {
        id: "mcp.servers",
        input: [],
        readOnly: true,
        autoRun: true,
        button: { label: "刷新服务列表" },
      },
      {
        id: "mcp.tools",
        input: ["name"],
        readOnly: true,
        button: { label: "预览工具" },
        result: [
          { type: "list", path: ["tools"], label: ["name"], title: "工具名称" },
          { type: "json", path: ["tools"], title: "工具说明与参数 Schema" },
        ],
      },
    ],
  },
  {
    id: "memory",
    title: "Hermes 记忆导入与检索",
    description:
      "粘贴 Markdown 后先预览分块，再批量导入。首次下载模型可能需要几分钟；取消导入不会提交本批记忆。",
    fields: [
      select("channel", "记忆分类", [
        ["chat", "聊天（QQ / Discord 共享）"],
        ["review", "GitHub 审查"],
      ]),
      {
        ...text("markdown", "Hermes 记忆 Markdown", "", "textarea"),
        max: 500000,
      },
      text("query", "检索关键词"),
    ],
    operations: [
      {
        id: "memory.preview",
        input: ["markdown", "channel"],
        readOnly: true,
        button: { label: "预览分块" },
        result: [{ type: "list", path: ["items"], label: ["text"] }],
      },
      {
        id: "memory.import",
        input: ["markdown", "channel"],
        button: { label: "批量导入", success: "记忆导入完成" },
        refresh: ["memory.recent"],
        result: [{ type: "text", path: ["summary"] }],
      },
      {
        id: "memory.search",
        input: ["query", "channel"],
        readOnly: true,
        button: { label: "混合检索" },
        result: [{ type: "list", path: ["items"], label: ["text"] }],
      },
      {
        id: "memory.recent",
        input: ["channel"],
        readOnly: true,
        button: { label: "最近记忆" },
        result: [{ type: "list", path: ["items"], label: ["text"] }],
      },
    ],
  },
  {
    id: "reviews",
    title: "GitHub 审查任务",
    fields: [
      {
        type: "select",
        key: "id",
        label: "任务",
        optionsFrom: {
          operation: "reviews.list",
          path: ["items"],
          label: ["label"],
          value: ["id"],
        },
      },
    ],
    operations: [
      {
        id: "reviews.list",
        input: [],
        readOnly: true,
        autoRun: true,
        button: { label: "刷新任务" },
      },
      {
        id: "reviews.read",
        input: ["id"],
        readOnly: true,
        onChange: [["id"]],
        button: { label: "查看任务" },
        result: [{ type: "text" }],
      },
      {
        id: "reviews.retry",
        input: ["id"],
        button: { label: "重试失败任务", success: "任务已重新排队" },
        refresh: ["reviews.list", "reviews.read"],
      },
    ],
  },
  {
    id: "status",
    title: "运行状态与配置同步",
    fields: [],
    operations: [
      {
        id: "status.read",
        input: [],
        readOnly: true,
        autoRun: true,
        button: { label: "刷新状态" },
        result: [{ type: "text" }],
      },
      {
        id: "features.refresh",
        input: [],
        button: {
          label: "同步聊天命令修改的功能设置",
          success: "已同步，请在配置卡片查看已保存值",
        },
      },
    ],
  },
];
