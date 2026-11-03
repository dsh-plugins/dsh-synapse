/**
 * dsh-synapse 配置弹窗的通用字段渲染器。
 *
 * 与 dsh-loader 内置表单等价：按 ConfigField 声明渲染 label / 控件 / 描述 /
 * 错误，支持嵌套 object / array 与 group 折叠分组。弹窗是独立 React 根，
 * 必须在此自带布局样式，不能依赖宿主 CSS。
 */
import * as React from "react";
import type { ConfigField } from "@dsh-plugin/dsh-loader/config";

/** 弹窗自带的紧凑布局样式（data-synapse-config 标记避免重复注入）。 */
export const DIALOG_CSS = `
.synapse-config-form{display:flex;flex-direction:column;gap:14px;font-size:0.95em}
.synapse-config-item{display:flex;flex-direction:column;gap:6px;min-width:0}
.synapse-config-label{font-weight:500;display:block}
.synapse-config-control input[type=text],.synapse-config-control input[type=number],.synapse-config-control input[type=password],.synapse-config-control select,.synapse-config-control textarea{width:100%;max-width:100%;box-sizing:border-box;font:inherit;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:6px;background:var(--dsw-alias-bg-base,Canvas);color:inherit}
.synapse-config-control textarea{resize:vertical;min-height:64px}
.synapse-config-control select[multiple]{min-height:120px}
.synapse-config-help{color:var(--dsw-alias-label-secondary,#888);font-size:0.85em;margin:0}
.synapse-config-error{color:var(--dsw-alias-status-danger,#d33);font-size:0.85em;margin:0}
.synapse-config-array{display:flex;flex-direction:column;gap:12px;border-left:3px solid var(--dsw-alias-border-l2,#8884);padding-left:12px}
.synapse-config-array-item{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,#8883);border-radius:8px;padding:10px}
.synapse-config-array-toolbar{display:flex;gap:8px;justify-content:flex-end}
.synapse-config-group{border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:10px;padding:0 12px;margin:0;min-width:0}
.synapse-config-group[data-expanded=false]{border:0;padding:0 12px}
.synapse-config-group legend{padding:0 8px;font-weight:500}
.synapse-config-group-body{padding:8px 0;display:flex;flex-direction:column;gap:14px}
.synapse-config-group-toggle{display:inline-flex;align-items:center;gap:6px;border:0;background:none;font:inherit;font-weight:inherit;text-align:start;cursor:pointer;padding:0}
.synapse-config-group-toggle svg{transition:transform 160ms ease}
.synapse-config-group[data-expanded=true]>legend .synapse-config-group-toggle svg{transform:rotate(90deg)}
.synapse-config-actions{display:flex;gap:8px;flex-wrap:wrap}
.synapse-config-actions button{font:inherit;border:1px solid var(--dsw-alias-border-l2,#8886);border-radius:6px;padding:6px 12px;background:transparent;color:inherit;cursor:pointer}
.synapse-config-actions button:disabled{opacity:.5;cursor:default}
.synapse-config-empty{color:var(--dsw-alias-label-secondary,#888);padding:8px 0}
`;

function at(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((v, key) => {
    if (v === null || typeof v !== "object") return undefined;
    return (v as Record<string, unknown>)[key];
  }, value);
}

function setAt<T>(value: T, path: string[], next: unknown): T {
  if (!path.length) {
    return next as T;
  }
  const copy = structuredClone(value) as Record<string, unknown>;
  let target: Record<string, unknown> = copy;
  for (const key of path.slice(0, -1)) {
    target[key] ??= {};
    target = target[key] as Record<string, unknown>;
  }
  target[path[path.length - 1]!] = next;
  return copy as T;
}

function fieldDefault(field: ConfigField): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean":
      return false;
    case "number":
      return field.min ?? 0;
    case "select":
      return field.options?.[0]?.value ?? "";
    case "multiselect":
      return [];
    case "array":
      return [];
    case "object": {
      const result: Record<string, unknown> = {};
      for (const sub of field.fields ?? []) {
        if (sub.type !== "group") result[sub.key!] = fieldDefault(sub);
      }
      return result;
    }
    default:
      return "";
  }
}

interface FieldProps {
  fields: ConfigField[];
  draft: unknown;
  path?: string[];
  onChange(path: string[], value: unknown): void;
  errors?: Record<string, string>;
  prefix: string;
}

function CollapsibleGroup({
  field,
  children,
}: {
  field: ConfigField;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(
    Boolean(field.defaultCollapsed),
  );
  const expanded = !field.collapsible || !collapsed;
  const bodyId = React.useId();
  return (
    <fieldset className="synapse-config-group" data-expanded={expanded}>
      <legend>
        {field.collapsible ? (
          <button
            className="synapse-config-group-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setCollapsed((v) => !v)}
          >
            <span>{field.label}</span>
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 1 L10 6 L3 11 Z" fill="currentColor" />
            </svg>
          </button>
        ) : (
          field.label
        )}
      </legend>
      {expanded && (
        <div id={bodyId} className="synapse-config-group-body">
          {field.description && (
            <p className="synapse-config-help">{field.description}</p>
          )}
          {children}
        </div>
      )}
    </fieldset>
  );
}

export function Fields({
  fields,
  draft,
  path = [],
  onChange,
  errors = {},
  prefix,
}: FieldProps) {
  return (
    <>
      {fields.map((field, index) => {
        if (
          field.visibleWhen &&
          JSON.stringify(at(draft, field.visibleWhen.path)) !==
            JSON.stringify(field.visibleWhen.equals)
        )
          return null;
        const next =
          field.type === "group" ? path : [...path, field.key!];
        const key = next.join(".") + ":" + index;
        if (field.type === "group" || field.type === "object") {
          return (
            <CollapsibleGroup field={field} key={key}>
              <Fields
                fields={field.fields ?? []}
                draft={draft}
                path={next}
                onChange={onChange}
                errors={errors}
                prefix={prefix}
              />
            </CollapsibleGroup>
          );
        }
        const raw = at(draft, next);
        const value = raw === undefined ? fieldDefault(field) : raw;
        const id = `${prefix}-${next.map(encodeURIComponent).join(".")}`;
        const error = errors[next.join(".")];
        let control: React.ReactNode;
        if (field.type === "array") {
          const list = Array.isArray(value) ? value : [];
          control = (
            <div className="synapse-config-array">
              {list.length === 0 && (
                <div className="synapse-config-empty">暂无条目</div>
              )}
              {list.map((_, itemIndex) => (
                <div className="synapse-config-array-item" key={itemIndex}>
                  <Fields
                    fields={[{ ...field.item!, key: String(itemIndex) }]}
                    draft={draft}
                    path={next}
                    onChange={onChange}
                    errors={errors}
                    prefix={prefix}
                  />
                  <div className="synapse-config-array-toolbar">
                    <button
                      type="button"
                      onClick={() =>
                        onChange(
                          next,
                          list.filter((_, i) => i !== itemIndex),
                        )
                      }
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              <div className="synapse-config-array-toolbar">
                <button
                  type="button"
                  onClick={() =>
                    onChange(next, [...list, fieldDefault(field.item!)])
                  }
                >
                  新增
                </button>
              </div>
            </div>
          );
        } else if (field.type === "boolean") {
          control = (
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              onChange={(e) => onChange(next, e.target.checked)}
            />
          );
        } else if (field.type === "select" || field.type === "multiselect") {
          const multiple = field.type === "multiselect";
          control = (
            <select
              id={id}
              multiple={multiple}
              value={
                multiple
                  ? (value as unknown[]).map((v) => JSON.stringify(v))
                  : JSON.stringify(value)
              }
              onChange={(e) => {
                const decode = (text: string) => JSON.parse(text);
                onChange(
                  next,
                  multiple
                    ? [...e.target.selectedOptions].map((option) =>
                        decode(option.value),
                      )
                    : decode(e.target.value),
                );
              }}
            >
              {(field.options ?? []).map((option) => (
                <option
                  key={JSON.stringify(option.value)}
                  value={JSON.stringify(option.value)}
                >
                  {option.label}
                </option>
              ))}
            </select>
          );
        } else if (field.type === "textarea") {
          control = (
            <textarea
              id={id}
              value={String(value ?? "")}
              onChange={(e) => onChange(next, e.target.value)}
            />
          );
        } else {
          const inputType =
            field.type === "password"
              ? "password"
              : field.type === "number"
                ? "number"
                : "text";
          const isSecretRef =
            field.type === "password" &&
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value);
          control = (
            <input
              id={id}
              type={inputType}
              value={isSecretRef ? "" : String(value ?? "")}
              placeholder={
                isSecretRef ? "已设置，留空保持不变" : undefined
              }
              min={field.min}
              max={field.max}
              onChange={(e) =>
                onChange(
                  next,
                  field.type === "number" && e.target.value !== ""
                    ? Number(e.target.value)
                    : e.target.value,
                )
              }
            />
          );
        }
        return (
          <div className="synapse-config-item" key={key}>
            <label className="synapse-config-label" htmlFor={id}>
              {field.label}
              {field.required ? " *" : ""}
            </label>
            <div className="synapse-config-control">
              {control}
              {field.description && (
                <p className="synapse-config-help">{field.description}</p>
              )}
              {error && <p className="synapse-config-error">{error}</p>}
            </div>
          </div>
        );
      })}
    </>
  );
}

export { at, setAt, fieldDefault };
