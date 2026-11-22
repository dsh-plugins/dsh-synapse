import * as React from "react";
import { ModelSelect } from "@dsh-plugin/dsh-loader/client";
import { fieldDefault, type ConfigField, type ConfigModelValue } from "@dsh-plugin/dsh-loader/config";
import { Button, Field, Input, InputNumber, Select, Switch, Textarea } from "@dsh-plugin/dsh-ui-components";
import type { SettingsContext } from "../settings-context.js";
import { at, setAt } from "../fields.js";

function findField(fields: ConfigField[], key: string): ConfigField | undefined {
  for (const field of fields) {
    if (field.key === key) return field;
    if (field.type === "group") {
      const child = findField(field.fields ?? [], key);
      if (child) return child;
    }
  }
}

/** Layout groups introduce no property in the stored configuration. */
export function getFields(fields: ConfigField[], path: string[] = []): ConfigField[] {
  for (const key of path) fields = findField(fields, key)?.fields ?? [];
  return fields;
}

export function SettingsFields({ ctx, fields, path = [] }: {
  ctx: SettingsContext; fields: ConfigField[]; path?: string[];
}) {
  return <div className="syn-pref-fields">{fields.map((field, index) => {
    if (field.visibleWhen && at(ctx.value, field.visibleWhen.path) !== field.visibleWhen.equals) return null;
    const next = field.type === "group" ? path : [...path, field.key!];
    return <div key={field.key ?? index} data-pref-label={field.label} tabIndex={-1}><SettingField ctx={ctx} field={field} path={next}/></div>;
  })}</div>;
}

function SettingField({ ctx, field, path }: { ctx: SettingsContext; field: ConfigField; path: string[] }) {
  const id = React.useId();
  const value = at(ctx.value, path) ?? field.default;
  const condition = (field as ConfigField & { disabledWhen?: { path: string[]; equals: boolean } }).disabledWhen;
  const disabled = ctx.saving || Boolean(condition && at(ctx.value, condition.path) === condition.equals);
  const change = (next: unknown) => ctx.setValue(previous => setAt(previous, path, next));
  const shared = { id, disabled, "aria-label": field.label };
  if (field.panel === "speech-api-key") {
    return <a href="https://breezeblue.ai/zh?code=MQC8R5" target="_blank" rel="noopener noreferrer">获取 BreezeBlue API Key</a>;
  }
  if (field.type === "object" || field.type === "group") {
    if (!field.fields?.length) return null;
    return <fieldset className="syn-pref-group"><legend>{field.label}</legend>
      {field.description && <p>{field.description}</p>}
      <SettingsFields ctx={ctx} fields={field.fields} path={path}/>
    </fieldset>;
  }
  if (field.type === "array" && field.item) {
    const rows = Array.isArray(value) ? value : [];
    return <fieldset className="syn-pref-group"><legend>{field.label}</legend>
      {field.description && <p>{field.description}</p>}
      {rows.map((_, index) => <div className="syn-pref-array-row" key={index}>
        <SettingField ctx={ctx} field={{ ...field.item!, label: `${field.item!.label} ${index + 1}` }} path={[...path, String(index)]}/>
        <Button size="sm" variant="text" disabled={disabled} aria-label={`移除${field.label}第 ${index + 1} 项`} onClick={() => change(rows.filter((_, i) => i !== index))}>移除</Button>
      </div>)}
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => change([...rows, fieldDefault(field.item!)])}>添加{field.item.label}</Button>
    </fieldset>;
  }
  let control: React.ReactNode;
  switch (field.type) {
    case "model":
      control = <ModelSelect id={id} label={field.label} disabled={disabled} value={value as ConfigModelValue ?? null} onChange={change}/>;
      break;
    case "boolean":
      control = <Switch {...shared} checked={value === true} onChange={change}/>;
      break;
    case "number":
      control = <InputNumber {...shared} min={field.min} max={field.max} value={typeof value === "number" ? value : undefined} onChange={change}/>;
      break;
    case "select":
    case "multiselect": {
      const options = field.options ?? [];
      const decode = (key: string) => options.find(option => String(option.value) === key)?.value ?? key;
      control = <Select {...shared} multiple={field.type === "multiselect"} value={Array.isArray(value) ? value.map(String) : String(value ?? "")}
        options={options.map(option => ({ ...option, value: String(option.value) }))}
        onChange={key => change(Array.isArray(key) ? key.map(decode) : decode(key))}/>;
      break;
    }
    case "textarea":
      control = <Textarea {...shared} autoSize={{ minRows: 3, maxRows: 10 }} value={String(value ?? "")} onChange={change}/>;
      break;
    case "password": {
      const masked = value !== null && typeof value === "object";
      control = <div className="syn-pref-password">
        <Input {...shared} type="password" autoComplete="new-password" placeholder={masked ? "已设置，输入以替换" : undefined}
          value={masked ? "" : String(value ?? "")} onChange={change}/>
        {masked && <Button size="sm" variant="text" disabled={disabled} aria-label={`清除${field.label}`} onClick={() => change("")}>清除</Button>}
      </div>;
      break;
    }
    default:
      control = <Input {...shared} value={String(value ?? "")} required={field.required} maxLength={field.max} onChange={change}/>;
  }
  return <Field htmlFor={id} label={field.label} description={field.description} required={field.required} layout={field.type === "boolean" ? "inline" : "stack"}>
    {control}
  </Field>;
}
