/**
 * Synapse 配置面板：共享宿主字段模板，并通过 loader 注册管理表格与配置弹窗。
 */
import * as React from "react";
import type { ConfigDialogProps, DshLoaderUi } from "@dsh-plugin/dsh-loader/client";
import { moduleFields } from "../feature-config.js";
import { Fields, DIALOG_CSS, setAt } from "./fields.js";
import type { SynapseConfig } from "../types.js";
import { SkillsPanel } from "./skills.js";
import { McpPanel } from "./mcp.js";
import { MemoryImportPanel } from "./memory.js";
import { ReviewsPanel } from "./reviews.js";

export const inject = ["dshLoaderUi"];

function StyleTag() {
  return <style data-synapse-config="">{DIALOG_CSS}</style>;
}

function ModulesEditor({
  value,
  setValue,
  errors,
}: ConfigDialogProps<SynapseConfig["modules"]>) {
  return (
    <div className="synapse-config-form">
      <StyleTag />
      <Fields
        fields={moduleFields}
        draft={value}
        path={[]}
        onChange={(path, next) => setValue(setAt(value, path, next))}
        errors={errors}
        prefix="synapse-modules"
      />
    </div>
  );
}

export function apply(ctx: {
  effect(fn: () => (() => void) | void): unknown;
  dshLoaderUi: Pick<DshLoaderUi, "config">;
}) {
  ctx.dshLoaderUi.config.registerDialog<SynapseConfig["modules"]>(ctx, {
    id: "modules-editor",
    configId: "dsh-synapse",
    field: ["modules"],
    title: "编辑聊天与通知功能",
    component: ModulesEditor,
  });
  for (const [id, component] of [["skills", SkillsPanel], ["mcp", McpPanel], ["memory-import", MemoryImportPanel], ["reviews", ReviewsPanel]] as const) {
    ctx.dshLoaderUi.config.registerPanel(ctx, { id, configId: "dsh-synapse", component });
  }
  for (const [field, label] of [["memoryPrompt", "记忆"], ["skillPrompt", "Skill"]] as const) {
    ctx.dshLoaderUi.config.registerDialog<string>(ctx, {
      id: field === "memoryPrompt" ? "memory-prompt-editor" : "skill-prompt-editor",
      configId: "dsh-synapse",
      field: [field],
      title: `编辑${label}提示词`,
      component: PromptEditor,
    });
  }
}

function PromptEditor({ value, setValue, saving, errors }: ConfigDialogProps<string>) {
  return (
    <div className="synapse-config-form">
      <StyleTag />
      <div className="synapse-config-control">
        <label className="synapse-config-label" htmlFor="synapse-learning-prompt">系统提示词</label>
        <textarea id="synapse-learning-prompt" rows={16} value={value ?? ""} disabled={saving} onChange={(event) => setValue(event.target.value)} />
        <p className="synapse-config-help">保存后对下一次请求生效。留空时不注入此段要求。</p>
        {Object.entries(errors).map(([key, message]) => <p key={key} className="synapse-config-error">{message}</p>)}
      </div>
    </div>
  );
}
