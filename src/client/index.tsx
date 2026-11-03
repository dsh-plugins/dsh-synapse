/**
 * dsh-synapse 浏览器半区：为 config-api 的 modules / mcpServers 字段注册
 * 自定义配置弹窗。字段模板从宿主侧共享（moduleFields / mcpServerItem），
 * 弹窗内部使用等价的声明式渲染器，外壳、校验与修订号保存由 dsh-loader 负责。
 */
import * as React from "react";
import type { ConfigDialogProps, DshLoaderUi } from "@dsh-plugin/dsh-loader/client";
import { moduleFields, mcpServerItem } from "../feature-config.js";
import { Fields, DIALOG_CSS, fieldDefault } from "./fields.js";
import type { SynapseConfig } from "../types.js";

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
        onChange={(_, next) => setValue(next as SynapseConfig["modules"])}
        errors={errors}
        prefix="synapse-modules"
      />
    </div>
  );
}

function McpServersEditor({
  value,
  setValue,
  errors,
}: ConfigDialogProps<SynapseConfig["mcpServers"]>) {
  const list = Array.isArray(value) ? value : [];
  return (
    <div className="synapse-config-form">
      <StyleTag />
      {list.length === 0 && <p className="synapse-config-empty">暂无 MCP 服务</p>}
      {list.map((server, index) => (
        <fieldset className="synapse-config-group" key={index}>
          <legend>{server?.name?.trim() || `服务 ${index + 1}`}</legend>
          <div className="synapse-config-group-body">
            <Fields
              fields={(mcpServerItem.fields ?? []).map((field) => ({
                ...field,
                // 密码引用形态在弹窗中按普通文本处理，保存时由宿主恢复。
              }))}
              draft={server}
              path={[]}
              onChange={(_, next) =>
                setValue(
                  list.map((entry, i) => (i === index ? next : entry)) as SynapseConfig["mcpServers"],
                )
              }
              errors={errors}
              prefix={`synapse-mcp-${index}`}
            />
            <div className="synapse-config-actions">
              <button
                type="button"
                onClick={() =>
                  setValue(list.filter((_, i) => i !== index) as SynapseConfig["mcpServers"])
                }
              >
                删除此服务
              </button>
            </div>
          </div>
        </fieldset>
      ))}
      <div className="synapse-config-actions">
        <button
          type="button"
          onClick={() =>
            setValue([
              ...list,
              fieldDefault(mcpServerItem) as SynapseConfig["mcpServers"][number],
            ] as SynapseConfig["mcpServers"])
          }
        >
          新增 MCP 服务
        </button>
      </div>
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
  ctx.dshLoaderUi.config.registerDialog<SynapseConfig["mcpServers"]>(ctx, {
    id: "mcp-servers-editor",
    configId: "dsh-synapse",
    field: ["mcpServers"],
    title: "编辑 MCP 服务",
    component: McpServersEditor,
  });
}
