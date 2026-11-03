import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import { EditorDialog, ErrorNotice, MANAGER_CSS, Preview, useRequests } from "./shared.js";

export function MemoryImportPanel(props: ConfigPanelProps) {
  const [open, setOpen] = React.useState(false);
  return <><style>{MANAGER_CSS}</style><Arco.Button onClick={() => setOpen(true)}>导入 Hermes 记忆</Arco.Button>
    {open && <MemoryImport {...props} close={() => setOpen(false)}/>}</>;
}

function MemoryImport({ view, client, close }: ConfigPanelProps & { close(): void }) {
  const request = useRequests();
  const [markdown, setMarkdown] = React.useState("");
  const [channel, setChannel] = React.useState("chat");
  const [preview, setPreview] = React.useState(false);
  const [count, setCount] = React.useState<number>();
  const [summary, setSummary] = React.useState("");
  const showPreview = async () => {
    if (preview) { setPreview(false); return; }
    const result = await request.run(signal => client.invoke(view.template.id, "memory.preview", { input: { markdown, channel } }, signal));
    if (result) { setCount((result.value as unknown as { items: unknown[] }).items.length); setPreview(true); }
  };
  const importMemory = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "memory.import", { input: { markdown, channel } }, signal), true);
    if (result) { setSummary((result.value as unknown as { summary: string }).summary); }
  };
  return <EditorDialog title="导入 Hermes 记忆" close={close} locked={request.writing}
    actions={<Arco.Button disabled={!markdown.trim() || request.busy} onClick={() => { void showPreview(); }}>{preview ? "编辑" : "预览"}</Arco.Button>}
    footer={<Arco.Space>{request.writing && <Arco.Button onClick={request.cancel}>取消导入</Arco.Button>}<Arco.Button disabled={request.writing} onClick={close}>关闭</Arco.Button><Arco.Button type="primary" loading={request.busy} disabled={!view.value.ragEnabled || !markdown.trim() || request.busy || Boolean(summary)} onClick={() => { void importMemory(); }}>确认导入</Arco.Button></Arco.Space>}>
    <ErrorNotice error={request.error}/>
    {!view.value.ragEnabled && <Arco.Alert type="warning" content="请先保存并启用本地混合记忆，之后可以确认导入。"/>}
    {summary && <Arco.Alert type="success" content={summary}/>}
    <div className="synapse-editor-field"><label>记忆分类</label><Arco.Select value={channel} disabled={request.busy} options={[{ label: "聊天", value: "chat" }, { label: "GitHub 审查", value: "review" }]} onChange={value => { setChannel(value); setSummary(""); setCount(undefined); }}/></div>
    {count !== undefined && <p>将按 Hermes 规则导入 {count} 条记忆。</p>}
    {preview ? <Preview content={markdown}/> : <Arco.Input.TextArea aria-label="Hermes 记忆 Markdown" value={markdown} disabled={request.busy} autoSize={{ minRows: 12 }} placeholder="在此粘贴 Hermes 记忆 Markdown" onChange={value => { setMarkdown(value); setSummary(""); setCount(undefined); }}/>}
  </EditorDialog>;
}
