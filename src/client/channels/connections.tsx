import * as React from "react";
import { Button, Field, Select, Table, Tag } from "@dsh-plugin/dsh-ui-components";
import type { ConnectionConfig } from "../../types.js";
import type { SettingsContext } from "../settings-context.js";
import { BridgeFields, Dialog, emptyBridge, TextField, Toggle } from "./controls.js";
import { listGroups, validateBridges, type Bridge } from "./groups-model.js";

export function OneBotSection(ctx: SettingsContext) {
  const q = ctx.value.connection;
  const [result, setResult] = React.useState("");
  function update(key: keyof ConnectionConfig, value: string) {
    ctx.setValue(previous => ({ ...previous, connection: { ...previous.connection, [key]: value } }));
    setResult("");
  }
  function check() {
    for (const [key, protocols] of [["httpUrl", ["http:", "https:"]], ["wsUrl", ["ws:", "wss:"]]] as const) {
      try {
        const url = new URL(q[key]);
        if (!(protocols as readonly string[]).includes(url.protocol) || url.username || url.password) throw new Error();
      } catch { setResult(key === "httpUrl" ? "请填写有效的 HTTP(S) 服务地址。" : "请填写有效的 WS(S) 服务地址。"); return; }
    }
    setResult("两个地址的格式正确。");
  }
  return <div className="channel-fields">
    <div className="channel-heading"><h3>OneBot 接入</h3><Button variant="outline" size="sm" onClick={check}>校验地址</Button></div>
    <Toggle label="启用机器人" checked={ctx.value.enabled} description="启动 QQ 和 Discord 共用的机器人进程。" change={enabled => ctx.setValue(previous => ({ ...previous, enabled }))}/>
    <div className="channel-grid">
      <TextField label="HTTP 服务地址" mono value={q.httpUrl} change={v => update("httpUrl", v)} description="填写 NapCat 或 Snowluma 的 OneBot HTTP 地址。"/>
      <TextField label="正向 WebSocket 地址" mono value={q.wsUrl} change={v => update("wsUrl", v)} description="用于接收消息和群事件。"/>
      <TextField label="HTTP 访问令牌" secret value={q.httpToken} change={v => update("httpToken", v)}/>
      <TextField label="WebSocket 访问令牌" secret value={q.wsToken} change={v => update("wsToken", v)}/>
    </div>
    {result && <p role="status">{result}</p>}
    <TextField label="Chrome / Chromium 路径" mono value={q.chromePath} change={v => update("chromePath", v)} description="生成进度、GitHub 或 B 站图片卡片时使用。"/>
    <details><summary>高级连接选项</summary><div className="channel-grid">
      <TextField label="WebSocket 令牌参数前缀" mono value={q.tokenParams} change={v => update("tokenParams", v)}/>
      <TextField label="HTTP User-Agent" mono value={q.userAgent} change={v => update("userAgent", v)}/>
      <Field label="日志级别"><Select aria-label="日志级别" value={q.logLevel} options={[
        { value: "debug", label: "调试" }, { value: "info", label: "信息" }, { value: "warn", label: "警告" }, { value: "error", label: "错误" },
      ]} onChange={v => update("logLevel", String(v))}/></Field>
    </div></details>
    <div className="channel-heading"><span>已为 {ctx.value.modules.chat.groups.length} 个群开启对话</span>
      <Button size="sm" variant="outline" onClick={() => ctx.navigate("groups")}>管理群聊</Button></div>
  </div>;
}

export function DiscordSection(ctx: SettingsContext) {
  const data = ctx.value.modules.discord, groups = listGroups(ctx.value);
  const [edit, setEdit] = React.useState<{ index: number; value: Bridge }>();
  const [removing, setRemoving] = React.useState(false), [error, setError] = React.useState("");
  function open(index: number) {
    setEdit({ index, value: data.bridges[index] ? { ...data.bridges[index] } : emptyBridge(groups[0]?.id ?? "") });
    setRemoving(false); setError("");
  }
  function save() {
    if (!edit) return;
    const index = edit.index, route = { ...edit.value, guildId: edit.value.guildId.trim(), channelName: edit.value.channelName.trim().replace(/^#+/, "").trim() };
    const change = (routes: Bridge[]) => index < 0 ? [...routes, route] : removing ? routes.filter((_, i) => i !== index) : routes.map((row, i) => i === index ? route : row);
    try {
      validateBridges(change(data.bridges));
      ctx.setValue(previous => ({ ...previous, modules: { ...previous.modules, discord: { ...previous.modules.discord, bridges: change(previous.modules.discord.bridges) } } }));
      setEdit(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className="channel-fields">
    <TextField label="Discord Bot Token" secret value={data.token} description="填写令牌后，已启用的机器人会连接 Discord。清空可停用 Discord 连接。"
      change={token => ctx.setValue(previous => ({ ...previous, modules: { ...previous.modules, discord: { ...previous.modules.discord, token } } }))}/>
    <div className="channel-heading"><h3>频道桥接</h3><Button size="sm" variant="outline" onClick={() => groups.length ? open(-1) : ctx.navigate("groups")}>
      {groups.length ? "添加桥接" : "先添加 QQ 群"}</Button></div>
    <Table className="groups-table" rowKey="index" data={data.bridges.map((row, index) => ({ ...row, index }))} size="small" pagination={data.bridges.length > 10 ? { pageSize: 10 } : false}
      scroll={{ x: 555 }} noDataElement="尚未关联 Discord 频道" columns={[
        { title: "Discord 频道", width: 155, render: (_, r: Bridge) => <div className="channel-name"><strong>#{r.channelName}</strong><small>{r.guildId}</small></div> },
        { title: "QQ 群", width: 130, render: (_, r: Bridge) => groups.find(g => g.id === r.group)?.name || r.group },
        { title: "转发规则", render: (_, r: Bridge) => <Tag size="sm">{r.needCmd ? "/send 与桥接回复" : r.needReply ? "QQ 仅桥接回复" : "全部消息"}</Tag> },
        { title: "操作", width: 86, fixed: "right", render: (_, r) => <Button size="sm" variant="text" onClick={() => open((r as Bridge & { index: number }).index)}>编辑</Button> },
      ]}/>
    {edit && <Dialog title={removing ? "移除频道桥接" : edit.index < 0 ? "添加频道桥接" : "编辑频道桥接"} close={() => setEdit(undefined)}
      footer={<div className="groups-dialog-actions">
        {!removing && edit.index >= 0 && <Button danger variant="text" onClick={() => setRemoving(true)}>移除桥接</Button>}
        <Button variant="outline" onClick={() => setEdit(undefined)}>取消</Button><Button danger={removing} onClick={save}>{removing ? "确认移除" : "应用修改"}</Button></div>}>
      {removing ? <p>移除 #{edit.value.channelName} 的桥接？</p> : <BridgeFields groups={groups} value={edit.value} change={value => { setEdit({ ...edit, value }); setError(""); }}/>}
      {error && <p role="alert" className="groups-error">{error}</p>}
    </Dialog>}
  </div>;
}
