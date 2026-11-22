import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import { Button, Input, Icon, Table } from "@dsh-plugin/dsh-ui-components";
import type { ConfigView, ConfigValue } from "@dsh-plugin/dsh-loader/config";
import type { McpSpec } from "../types.js";
import { mcpServerItem } from "../feature-config.js";
import { DIALOG_CSS, Fields, fieldDefault, setAt } from "./fields.js";
import { EditorDialog, ErrorNotice, MANAGER_CSS, TableArea, useRequests } from "./shared.js";

interface ToolRow { name: string; description?: string; inputSchema?: Record<string, unknown> }
interface EditorState { base: ConfigView; server: McpSpec; originalName: string }

export function McpPanel({ view, client, onSaved }: ConfigPanelProps & { onSaved?(): void }) {
  const request = useRequests();
  const [query, setQuery] = React.useState("");
  const [snapshot, setSnapshot] = React.useState(view);
  const [editor, setEditor] = React.useState<EditorState>();
  React.useEffect(() => { setSnapshot(current => view.revision > current.revision ? view : current); }, [view]);
  const rows = snapshot.value.mcpServers as unknown as McpSpec[];
  const refresh = async () => {
    const latest = await request.run(() => client.read(view.template.id));
    if (latest) { setSnapshot(latest); }
  };
  const edit = async (name = "") => {
    const latest = await request.run(() => client.read(view.template.id));
    if (!latest) { return; }
    setSnapshot(latest);
    const server = name ? (latest.value.mcpServers as unknown as McpSpec[]).find(item => item.name === name) : fieldDefault(mcpServerItem) as McpSpec;
    if (server) { setEditor({ base: latest, server: structuredClone(server), originalName: name }); }
  };
  const visible = rows.filter(row => [row.name, row.transport, ...row.allowedTools].some(term => term.toLowerCase().includes(query.trim().toLowerCase())));
  return <div className="synapse-resources">
    <style>{MANAGER_CSS}</style>
    <div className="sr-bar"><div className="sr-search"><Input type="search" aria-label="搜索 MCP 服务" placeholder="搜索服务或工具" value={query} onChange={setQuery} prefix={<Icon name="Search" size={15}/>}/></div>
      <Button size="sm" variant="primary" disabled={request.busy} onClick={() => { void edit(); }}>新增 MCP</Button></div>
    <ErrorNotice error={request.error}/>
    <Table rowKey="name" data={visible} pagination={visible.length > 10 ? {pageSize:10,simple:true} : false} size="small" border={false} showHeader={false} tableLayoutFixed columns={[
      { title: "名称", dataIndex: "name", render:(name: string, row: McpSpec) => <div className="sr-item"><strong>{name}</strong><small>{row.transport} · {row.allowedTools.length} 项工具允许调用</small></div> },
      { title: "状态", width: 82, render: (_value, row: McpSpec) => row.enabled ? "已启用" : "已停用" },
      { title: "操作", width: 70, render: (_value, row: McpSpec) => <Button size="sm" variant="text" disabled={request.busy} onClick={() => { void edit(row.name); }}>编辑</Button> },
    ]} noDataElement={query ? "没有符合条件的服务" : "还没有 MCP 服务"}/>
    {editor && <McpEditor {...{ view, client }} initial={editor} close={() => setEditor(undefined)} saved={() => { setEditor(undefined); void refresh(); onSaved?.(); }}/>}
  </div>;
}

function McpEditor({ view, client, initial, close, saved }: ConfigPanelProps & { initial: EditorState; close(): void; saved(): void }) {
  const request = useRequests();
  const [server, setServer] = React.useState(initial.server);
  const [tools, setTools] = React.useState<ToolRow[]>();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const resource = { id: "mcp-servers", revision: initial.base.revision };
  const test = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "mcp.test", { input: { server: server as unknown as ConfigValue } }, signal));
    if (result) { setTools((result.value as unknown as { tools: ToolRow[] }).tools); }
  };
  const save = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "mcp.save", {
      input: { originalName: initial.originalName, server: server as unknown as ConfigValue }, resource,
    }, signal), true);
    if (result) { saved(); }
  };
  const remove = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "mcp.delete", { input: { originalName: initial.originalName, confirmDelete }, resource }, signal), true);
    if (result) { saved(); }
  };
  const fields = mcpServerItem.fields!.filter(field => {
    if (field.key === "allowedTools") { return false; }
    return server.transport === "stdio" ? !["url", "headers"].includes(field.key!) : !["command", "args", "env"].includes(field.key!);
  });
  return <EditorDialog title={initial.originalName || "新增 MCP"} close={close} locked={request.writing}
    actions={<Arco.Button type="primary" disabled={request.busy} loading={request.busy} onClick={() => { void save(); }}>保存</Arco.Button>}
    footer={<div className="synapse-editor-footer"><Arco.Space>{initial.originalName && <>
      <Arco.Checkbox checked={confirmDelete} disabled={request.busy} onChange={setConfirmDelete}>确认删除</Arco.Checkbox>
      <Arco.Button status="danger" disabled={!confirmDelete || request.busy} onClick={() => { void remove(); }}>删除</Arco.Button></>}</Arco.Space><Arco.Button disabled={request.writing} onClick={close}>关闭</Arco.Button></div>}>
    <style>{DIALOG_CSS}</style><ErrorNotice error={request.error}/>
    <fieldset disabled={request.busy} style={{ border: 0, padding: 0, margin: 0 }} className="synapse-config-form">
      <Fields fields={fields} draft={server} prefix="synapse-mcp-server" onChange={(path, value) => { setServer(setAt(server, path, value)); setTools(undefined); }}/>
      <div className="synapse-editor-field"><label>允许自动调用的工具</label>
        <Arco.Select mode="multiple" allowCreate value={server.allowedTools} options={[...new Set([...server.allowedTools, ...(tools ?? []).map(tool => tool.name)])]} disabled={request.busy} onChange={allowedTools => setServer({ ...server, allowedTools })}/>
        <p className="synapse-config-help">留空时聊天不会自动调用 MCP 工具。测试成功后可从工具列表选择。</p>
      </div>
    </fieldset>
    <Arco.Button loading={request.busy} disabled={request.busy} onClick={() => { void test(); }}>测试并获取工具</Arco.Button>
    {tools && <section><h4>工具列表（{tools.length}）</h4>
      <TableArea><Arco.Table rowKey="name" data={tools} pagination={false} size="small" columns={[
        { title: "名称", dataIndex: "name" }, { title: "说明", dataIndex: "description" },
        { title: "允许调用", width: 100, render: (_value, tool: ToolRow) => <Arco.Checkbox disabled={request.busy} checked={server.allowedTools.includes(tool.name)} onChange={checked => setServer({ ...server, allowedTools: checked ? [...new Set([...server.allowedTools, tool.name])] : server.allowedTools.filter(name => name !== tool.name) })}/> },
      ]}/></TableArea>
      {tools.map(tool => <details key={tool.name}><summary>{tool.name} · 参数 Schema</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre></details>)}
    </section>}
  </EditorDialog>;
}
