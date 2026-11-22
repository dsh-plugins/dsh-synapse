import * as React from "react";
import { Button, Field, Input, Tabs, TabPane } from "@dsh-plugin/dsh-ui-components";
import { validateActivity } from "../../activity-config.js";
import { ActivityParameters } from "../activity.js";
import type { SettingsContext } from "../settings-context.js";
import { BridgeFields, Dialog, emptyBridge, Toggle } from "./controls.js";
import { applyGroup, featureLabels, listGroups, readGroup, removeGroup, type Feature, type GroupEntry } from "./groups-model.js";

export async function lookupName(ctx: SettingsContext, id: string, signal: AbortSignal): Promise<string> {
  const result = await ctx.client.invoke(ctx.view.template.id, "groups.lookup", { input: { id } }, signal);
  const data = result.value as { id?: string; name?: string };
  if (data?.id !== id || typeof data.name !== "string" || !data.name.trim()) throw new Error("OneBot 未返回该群的名称。");
  return data.name.trim();
}

export function GroupSettings({ ctx, group, close }: { ctx: SettingsContext; group: GroupEntry; close(): void }) {
  const [draft, setDraft] = React.useState(() => readGroup(ctx.value, group.id));
  const [name, setName] = React.useState(group.name);
  const [tab, setTab] = React.useState("behavior"), [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState(""), [looking, setLooking] = React.useState(false);
  const lookup = React.useRef<AbortController>();
  const newKey = React.useRef(0);
  React.useEffect(() => () => lookup.current?.abort(), []);
  async function refreshName() {
    if (lookup.current) return;
    const call = new AbortController(); lookup.current = call; setLooking(true); setError("");
    try {
      const found = await lookupName(ctx, group.id, call.signal);
      if (!call.signal.aborted) setName(found);
    } catch (cause) {
      if (!call.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!call.signal.aborted) { lookup.current = undefined; setLooking(false); } }
  }
  function save() {
    try {
      const edit = (previous: typeof ctx.value) => applyGroup(previous, { ...group, name }, draft);
      const next = edit(ctx.value); validateActivity(next.activity);
      ctx.setValue(edit); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function feature(key: Feature, label: string = featureLabels[key]) {
    return <Toggle key={key} label={label} checked={draft.features.includes(key)}
      change={enabled => setDraft({ ...draft, features: enabled ? [...draft.features, key] : draft.features.filter(f => f !== key) })}/>;
  }
  function addWelcome() {
    setDraft({ ...draft, welcomes: [...draft.welcomes, { index: --newKey.current, msg: "欢迎 ${at} 加入群聊！" }] });
  }
  return <Dialog title={deleting ? "移除群聊" : name || "QQ 群 " + group.id} close={close} footer={
    deleting ? <><Button variant="outline" onClick={() => setDeleting(false)}>返回</Button>
      <Button danger onClick={() => { ctx.setValue(previous => removeGroup(previous, group)); close(); }}>确认移除</Button></> :
    <div className="groups-dialog-actions"><Button danger variant="text" onClick={() => setDeleting(true)}>移除群聊</Button>
      <Button variant="outline" onClick={close}>取消</Button><Button onClick={save}>应用修改</Button></div>
  }>
    {deleting ? <p>将移除这个群的功能、主动回复策略、频道桥接和 GitHub 群通知订阅。</p> : <>
      <div className="channel-heading"><span>QQ 群号 {group.id}</span>
        <Button variant="text" size="sm" disabled={looking} onClick={() => void refreshName()}>{looking ? "正在获取…" : "从 OneBot 获取群名"}</Button></div>
      <Tabs activeTab={tab} onChange={setTab}>
        <TabPane title="回复与欢迎" key="behavior"><div className="channel-fields">
          {feature("chat", "允许机器人参与对话")}{feature("command", "响应群命令")}
          <Toggle label="欢迎新成员" checked={draft.welcomes.length > 0} change={on => on ? addWelcome() : setDraft({ ...draft, welcomes: [] })}/>
          {draft.welcomes.map((row, i) => <div className="channel-fields" key={row.index}>
            <Field label={draft.welcomes.length > 1 ? "欢迎语 " + (i + 1) : "欢迎语"} description={'用 ${at} 提及新成员。'}>
              <Input.TextArea aria-label={"欢迎语 " + (i + 1)} value={row.msg} onChange={msg => setDraft({ ...draft, welcomes: draft.welcomes.map(item => item.index === row.index ? { ...item, msg } : item) })}/>
            </Field>
            {draft.welcomes.length > 1 && <Button variant="text" size="sm" onClick={() => setDraft({ ...draft, welcomes: draft.welcomes.filter(item => item.index !== row.index) })}>移除此欢迎语</Button>}
          </div>)}
          {draft.welcomes.length > 0 && <div><Button size="sm" variant="outline" onClick={addWelcome}>添加欢迎语</Button></div>}
        </div></TabPane>
        <TabPane title="主动回复" key="activity"><div className="channel-fields">
          <Toggle label="概率回复" checked={draft.policy.probabilityEnabled} description={ctx.value.activity.probabilityEnabled ? undefined : "全局概率回复已关闭。"}
            change={probabilityEnabled => setDraft({ ...draft, policy: { ...draft.policy, probabilityEnabled } })}/>
          <Toggle label="空闲时发起话题" checked={draft.policy.idleEnabled} description={ctx.value.activity.idleEnabled ? undefined : "全局空闲消息已关闭。"}
            change={idleEnabled => setDraft({ ...draft, policy: { ...draft.policy, idleEnabled } })}/>
          <Toggle label="使用全局参数" checked={draft.policy.useDefaults}
            change={useDefaults => setDraft({ ...draft, policy: { ...draft.policy, useDefaults } })}/>
          {!draft.policy.useDefaults && <ActivityParameters value={draft.policy} change={settings => setDraft({ ...draft, policy: { ...draft.policy, ...settings } })}/>}
        </div></TabPane>
        <TabPane title="群功能" key="features"><div className="channel-fields">
          {(Object.keys(featureLabels) as Feature[]).filter(key => key !== "chat" && key !== "command").map(key => feature(key))}
        </div></TabPane>
        <TabPane title="Discord 桥接" key="bridges"><div className="channel-fields">
          {draft.bridges.map((row, i) => <fieldset className="groups-bridge" key={row.index}>
            <legend>{row.value.channelName || "频道 " + (i + 1)}</legend>
            <BridgeFields value={row.value} groups={listGroups(ctx.value)} change={value => setDraft({ ...draft, bridges: draft.bridges.map(b => b.index === row.index ? { ...b, value } : b) })}/>
            <Button size="sm" variant="text" danger onClick={() => setDraft({ ...draft, bridges: draft.bridges.filter(b => b.index !== row.index) })}>移除桥接</Button>
          </fieldset>)}
          <div><Button size="sm" variant="outline" onClick={() => setDraft({ ...draft, bridges: [...draft.bridges, { index: --newKey.current, value: emptyBridge(group.id) }] })}>添加桥接</Button></div>
        </div></TabPane>
      </Tabs>
    </>}
    {error && <p role="alert" className="groups-error">{error}</p>}
  </Dialog>;
}
