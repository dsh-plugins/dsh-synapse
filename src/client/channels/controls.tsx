import * as React from "react";
import { Button, Field, Input, Modal, Select, Switch } from "@dsh-plugin/dsh-ui-components";
import type { Bridge, GroupEntry } from "./groups-model.js";

export function TextField({ label, value, change, secret, mono, description, readOnly, placeholder }: {
  label: string; value: string; change?(value: string): void; secret?: boolean; mono?: boolean;
  description?: string; readOnly?: boolean; placeholder?: string;
}) {
  const id = React.useId(), [shown, show] = React.useState(false);
  const masked = secret && value !== null && typeof value === "object";
  return <Field htmlFor={id} label={label} description={description}><Input id={id} mono={mono} readOnly={readOnly}
    autoComplete="off" spellCheck={false} type={secret && !shown ? "password" : "text"} value={masked ? "" : value ?? ""} placeholder={masked ? "已设置，输入以替换" : placeholder}
    onChange={change} suffix={masked ? <Button size="sm" variant="text" aria-label={"清除" + label} onClick={() => change?.("")}>清除</Button> : secret ? <Button size="sm" variant="text" aria-label={(shown ? "隐藏" : "显示") + label}
      aria-pressed={shown} onClick={() => show(!shown)}>{shown ? "隐藏" : "显示"}</Button> : undefined} /></Field>;
}

export function Toggle({ label, checked, change, description }: { label: string; checked: boolean; change(value: boolean): void; description?: string }) {
  const id = React.useId();
  return <Field layout="inline" htmlFor={id} label={label} description={description}>
    <Switch id={id} aria-label={label} checked={checked} onChange={change}/>
  </Field>;
}

export function Dialog({ title, children, footer, close }: { title: string; children: React.ReactNode; footer: React.ReactNode; close(): void }) {
  return <Modal visible className="syn-dialog synapse-channel-dialog" title={title} autoFocus focusLock maskClosable={false}
    onCancel={close} footer={footer} style={{ width: "min(600px, calc(100% - 24px))" }}>
    <div className="channel-fields">{children}</div>
  </Modal>;
}

export const emptyBridge = (group: string): Bridge => ({ guildId: "", channelName: "", group, needReply: false, needCmd: false });
export function BridgeFields({ value, groups, change }: { value: Bridge; groups: GroupEntry[]; change(value: Bridge): void }) {
  const id = React.useId();
  return <>
    <TextField label="Discord 服务器 ID" mono value={value.guildId} change={guildId => change({ ...value, guildId })}/>
    <TextField label="频道名称" placeholder="general" value={value.channelName} change={channelName => change({ ...value, channelName })}/>
    <Field label="关联的 QQ 群" htmlFor={id}><Select id={id} aria-label="关联的 QQ 群" value={value.group}
      options={groups.map(g => ({ value: g.id, label: g.name ? g.name + " · " + g.id : g.id }))}
      onChange={group => change({ ...value, group: String(group) })}/></Field>
    <Toggle label="QQ 只转发对桥接消息的回复" checked={value.needReply} change={needReply => change({ ...value, needReply })}/>
    <Toggle label="两端只转发 /send 和桥接回复" checked={value.needCmd} change={needCmd => change({ ...value, needCmd })}/>
  </>;
}
