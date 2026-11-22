import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import { EditorDialog, ErrorNotice, MANAGER_CSS, Preview, useRequests } from "./shared.js";

export function MemoryImportPanel(props: ConfigPanelProps) {
  const [open, setOpen] = React.useState(false);
  return <><style>{MANAGER_CSS}</style><Arco.Button onClick={() => setOpen(true)}>导入 Hermes 记忆</Arco.Button>
    {open && <MemoryImport {...props} close={() => setOpen(false)}/>}</>;
}

export function MemoryImport({ view, client, close, onImported, requirePreview = false }: ConfigPanelProps & { close(): void; onImported?(): void; requirePreview?: boolean }) {
  const request = useRequests();
  const [markdown, setMarkdown] = React.useState("");
  const [channel, setChannel] = React.useState("chat");
  const [preview, setPreview] = React.useState(false);
  const [items, setItems] = React.useState<{ text: string }[]>();
  const [excluded, setExcluded] = React.useState<Set<number>>(new Set());
  const [page, setPage] = React.useState(1);
  const [summary, setSummary] = React.useState("");
  const showPreview = async () => {
    if (preview) { setPreview(false); return; }
    const result = await request.run(signal => client.invoke(view.template.id, "memory.preview", { input: { markdown, channel } }, signal));
    if (result) {
      setItems((result.value as unknown as { items: { text: string }[] }).items);
      setPage(1); setExcluded(new Set()); setPreview(true);
    }
  };
  const importMemory = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "memory.import", { input: { markdown, channel, excluded: [...excluded] } }, signal), true);
    if (result) { setSummary((result.value as unknown as { summary: string }).summary); onImported?.(); }
  };
  function clearPreview() { setSummary(""); setItems(undefined); setPreview(false); setExcluded(new Set()); }
  const chosen = (items?.length ?? 0) - excluded.size;
  return <EditorDialog title="导入 Hermes 记忆" close={close} locked={request.writing}
    actions={<Arco.Button disabled={!markdown.trim() || request.busy} onClick={() => { void showPreview(); }}>{preview ? "编辑" : "预览"}</Arco.Button>}
    footer={<Arco.Space>{request.writing && <Arco.Button onClick={request.cancel}>取消导入</Arco.Button>}<Arco.Button disabled={request.writing} onClick={close}>关闭</Arco.Button><Arco.Button type="primary" loading={request.busy} disabled={!(view.value.memory as { enabled?: boolean } | undefined)?.enabled || !markdown.trim() || request.busy || Boolean(summary) || ((requirePreview || preview) && (!preview || !chosen))} onClick={() => { void importMemory(); }}>确认导入</Arco.Button></Arco.Space>}>
    <ErrorNotice error={request.error}/>
    {!(view.value.memory as { enabled?: boolean } | undefined)?.enabled && <Arco.Alert type="warning" content="请先在「长期记忆与 Skill」中启用长期记忆并保存，之后可以确认导入。"/>}
    {summary && <Arco.Alert type="success" content={summary}/>}
    <div className="synapse-editor-field"><label>记忆分类</label><Arco.Select value={channel} disabled={request.busy} options={[{ label: "聊天", value: "chat" }, { label: "GitHub 审查", value: "review" }]} onChange={value => { setChannel(value); clearPreview(); }}/></div>
    {preview && items ? <>
      <p>已选 {chosen} 条，共 {items.length} 条。</p>
      <div className="synapse-import-items">{items.slice((page - 1) * 20, page * 20).map((item, index) => {
        const n = (page - 1) * 20 + index;
        return <Arco.Checkbox key={n} checked={!excluded.has(n)} disabled={request.busy || Boolean(summary)} onChange={checked => setExcluded(previous => {
          const next = new Set(previous); if (checked) next.delete(n); else next.add(n); return next;
        })}><span style={{whiteSpace: "pre-wrap", overflowWrap: "anywhere"}}>{item.text}</span></Arco.Checkbox>;
      })}</div>
      {items.length > 20 && <Arco.Pagination simple current={page} total={items.length} pageSize={20} onChange={setPage}/>}
      <details><summary>Markdown 原文</summary><Preview content={markdown}/></details>
    </> : <Arco.Input.TextArea aria-label="Hermes 记忆 Markdown" value={markdown} disabled={request.busy} autoSize={{ minRows: 12, maxRows: 20 }} placeholder="在此粘贴 Hermes 记忆 Markdown" onChange={value => { setMarkdown(value); clearPreview(); }}/>}
  </EditorDialog>;
}
