import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import type { ConfigResource } from "@dsh-plugin/dsh-loader/config";
import { EditorDialog, ErrorNotice, MANAGER_CSS, Preview, TableArea, useRequests } from "./shared.js";

interface SkillRow { name: string; inherited: boolean; revision: string }
interface SkillDocument { name: string; content: string; selected: string; origin: string }

export function SkillsPanel({ view, client }: ConfigPanelProps) {
  const request = useRequests();
  const [rows, setRows] = React.useState<SkillRow[]>([]);
  const [document, setDocument] = React.useState<{ value: SkillDocument; resource?: ConfigResource }>();
  const refresh = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "skills.list", { input: {} }, signal));
    if (result) { setRows((result.value as unknown as { items: SkillRow[] }).items); }
  };
  React.useEffect(() => { void refresh(); }, [client]);
  const edit = async (name: string) => {
    const result = await request.run(signal => client.invoke(view.template.id, "skills.load", { input: { selected: name } }, signal));
    if (result) { setDocument({ value: result.value as unknown as SkillDocument, resource: result.resource ?? undefined }); }
  };
  return <>
    <style>{MANAGER_CSS}</style>
    <div className="synapse-manager-toolbar"><Arco.Button loading={request.busy} onClick={() => { void refresh(); }}>刷新</Arco.Button>
      <Arco.Button type="primary" disabled={request.busy} onClick={() => setDocument({ value: { name: "", content: "", selected: "", origin: "当前 profile" } })}>新增 Skill</Arco.Button></div>
    <ErrorNotice error={request.error}/>
    <TableArea><Arco.Table rowKey="name" data={rows} pagination={false} size="small" columns={[
      { title: "名称", dataIndex: "name" },
      { title: "来源", width: 110, render: (_value, row: SkillRow) => row.inherited ? "Home" : "profile" },
      { title: "操作", width: 90, render: (_value, row: SkillRow) => <Arco.Button size="small" disabled={request.busy} onClick={() => { void edit(row.name); }}>编辑</Arco.Button> },
    ]}/></TableArea>
    {document && <SkillEditor key={document.resource?.id ?? "new"} {...{ view, client }} initial={document} close={() => setDocument(undefined)} saved={() => { void refresh(); }}/>}
  </>;
}

function SkillEditor({ view, client, initial, close, saved }: ConfigPanelProps & {
  initial: { value: SkillDocument; resource?: ConfigResource }; close(): void; saved(): void;
}) {
  const request = useRequests();
  const [document, setDocument] = React.useState(initial.value);
  const [resource, setResource] = React.useState(initial.resource);
  const [editing, setEditing] = React.useState(!initial.resource);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const save = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, resource ? "skills.save" : "skills.create", {
      input: { name: document.name, content: document.content }, ...(resource ? { resource } : {}),
    }, signal), true);
    if (result) {
      setDocument(result.value as unknown as SkillDocument); setResource(result.resource ?? undefined); setEditing(false); saved();
    }
  };
  const remove = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "skills.delete", {
      input: { name: document.name, selected: document.selected, confirmDelete }, resource,
    }, signal), true);
    if (result) { saved(); close(); }
  };
  const inherited = document.origin.includes("继承");
  return <EditorDialog title={document.name || "新增 Skill"} close={close} locked={request.writing}
    actions={<><Arco.Button disabled={request.busy} onClick={() => setEditing(!editing)}>{editing ? "预览" : "编辑"}</Arco.Button>
      {editing && <Arco.Button type="primary" loading={request.busy} onClick={() => { void save(); }}>保存</Arco.Button>}</>}
    footer={<div className="synapse-editor-footer"><Arco.Space>{resource && !inherited && <>
      <Arco.Checkbox checked={confirmDelete} disabled={request.busy} onChange={setConfirmDelete}>确认删除</Arco.Checkbox>
      <Arco.Button status="danger" disabled={!confirmDelete || request.busy} onClick={() => { void remove(); }}>删除</Arco.Button></>}</Arco.Space><Arco.Button disabled={request.writing} onClick={close}>关闭</Arco.Button></div>}>
    <ErrorNotice error={request.error}/><p>{document.origin}</p>
    {editing ? <>
      <div className="synapse-editor-field"><label htmlFor="synapse-skill-name">名称</label><Arco.Input id="synapse-skill-name" value={document.name} disabled={Boolean(resource) || request.busy} onChange={name => setDocument({ ...document, name })}/></div>
      <Arco.Input.TextArea aria-label="Skill Markdown" value={document.content} disabled={request.busy} autoSize={{ minRows: 12 }} onChange={content => setDocument({ ...document, content })}/>
    </> : <Preview content={document.content}/>}
  </EditorDialog>;
}
