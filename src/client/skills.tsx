import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import { Button, Icon, Input, Table } from "@dsh-plugin/dsh-ui-components";
import type { ConfigResource } from "@dsh-plugin/dsh-loader/config";
import { EditorDialog, ErrorNotice, MANAGER_CSS, Preview, TableArea, useRequests } from "./shared.js";

interface SkillRow { name: string; title: string; inherited: boolean; revision: string }
interface SkillDocument { name: string; content: string; selected: string; origin: string }

export function SkillsPanel({ view, client, settings }: ConfigPanelProps & { settings?():void }) {
  const request = useRequests();
  const file = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const [listError, setListError] = React.useState("");
  const [version, refresh] = React.useReducer(n => n + 1, 0);
  const [rows, setRows] = React.useState<SkillRow[]>([]);
  const [document, setDocument] = React.useState<{ value: SkillDocument; resource?: ConfigResource }>();
  React.useEffect(() => {
    const controller = new AbortController();
    setListError("");
    const timer = setTimeout(() => {
      void client.invoke(view.template.id, "skills.list", { input: { query } }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setRows((result.value as unknown as { items: SkillRow[] }).items); })
        .catch(e => { if(!controller.signal.aborted) setListError(e instanceof Error ? e.message : String(e)); });
    }, query ? 140 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, view.template.id, query, version]);
  const edit = async (name: string) => {
    const result = await request.run(signal => client.invoke(view.template.id, "skills.load", { input: { selected: name } }, signal));
    if (result) { setDocument({ value: result.value as unknown as SkillDocument, resource: result.resource ?? undefined }); }
  };
  async function importFile(source: File) {
    const result = await request.run(async () => {
      if (source.size > 800000) throw new Error("Skill 文档最多可含 200000 个字符");
      const content = await source.text();
      if (!content.trim() || content.length > 200000) throw new Error("Skill 文档为空或超过 200000 个字符");
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const name = frontmatter?.match(/^name:\s*["']?([a-z0-9][a-z0-9_-]{0,63})["']?\s*$/m)?.[1] ?? source.name.replace(/\.(md|markdown)$/i, "").toLowerCase();
      return { name, content, selected: "", origin: "当前 profile" };
    });
    if (result) setDocument({ value: result });
  }
  return <div className="synapse-resources">
    <style>{MANAGER_CSS}</style>
    <div className="sr-bar"><div className="sr-search"><Input type="search" aria-label="搜索 Skill" placeholder="搜索名称或正文" value={query} onChange={setQuery} prefix={<Icon name="Search" size={15}/>}/></div>
      {settings && <Button size="sm" variant="outline" onClick={settings}>总结设置</Button>}
      <Button size="sm" variant="outline" disabled={request.busy} onClick={() => file.current?.click()}>导入文件</Button>
      <input type="file" hidden ref={file} accept=".md,.markdown,text/markdown" onChange={event => { const source = event.target.files?.[0]; event.target.value = ""; if(source) void importFile(source); }}/>
      <Button size="sm" variant="primary" disabled={request.busy} onClick={() => setDocument({ value: { name: "", content: "", selected: "", origin: "当前 profile" } })}>新增 Skill</Button></div>
    <ErrorNotice error={request.error || listError}/>
    <Table rowKey="name" data={rows} pagination={rows.length > 10 ? { pageSize: 10, simple:true } : false} size="small" border={false} showHeader={false} tableLayoutFixed columns={[
      { title: "名称", dataIndex: "name", render: (name: string, row: SkillRow) => <div className="sr-item"><strong>{row.title}</strong>{row.title !== name && <small>{name}</small>}</div> },
      { title: "来源", width: 83, render: (_value, row: SkillRow) => row.inherited ? "Home" : "profile" },
      { title: "操作", width: 70, render: (_value, row: SkillRow) => <Button size="sm" variant="text" disabled={request.busy} onClick={() => { void edit(row.name); }}>编辑</Button> },
    ]} noDataElement={query ? "没有符合条件的 Skill" : "还没有 Skill"}/>
    {listError && <Button size="sm" onClick={refresh}>重新加载</Button>}
    {document && <SkillEditor key={document.resource?.id ?? "new"} {...{ view, client }} initial={document} close={() => setDocument(undefined)} saved={() => { void refresh(); }}/>}
  </div>;
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
