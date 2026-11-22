import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import { Button, Icon, Input, Pagination, SegmentedControl, Table } from "@dsh-plugin/dsh-ui-components";
import type { ConfigResource } from "@dsh-plugin/dsh-loader/config";
import type { Channel } from "../../types.js";
import type { SettingsContext } from "../settings-context.js";
import { EditorDialog, ErrorNotice, useRequests } from "../shared.js";
import { MemoryImport } from "../memory.js";
import { MemorySettings } from "./memory-settings.js";

const categories = [{ value: "all", label: "全部" }, { value: "chat", label: "聊天记忆" }, { value: "review", label: "审查记忆" }];
const categoryName = (channel: string) => channel === "review" ? "审查记忆" : "聊天记忆";
const sourceName = (source: string) => ({ hermes: "Hermes 导入", agent: "会话总结" })[source] ?? source;
const pageSize = 10;
interface MemorySummary { id: number; channel: Channel; source: string; summary: string; created: string }
interface MemoryDocument extends Omit<MemorySummary,"summary"> { text: string }
interface Page { items: MemorySummary[]; total: number; page: number }

function MemoryDetail({ value, resource, view, client, close, changed }: ConfigPanelProps & {
  value: MemoryDocument; resource: ConfigResource; close(): void; changed(): void;
}) {
  const request = useRequests();
  const [mode, setMode] = React.useState<"read"|"edit"|"delete">("read");
  const [channel, setChannel] = React.useState(value.channel);
  const [text, setText] = React.useState(value.text);
  async function save() {
    const deleting = mode === "delete";
    const result = await request.run(signal => client.invoke(view.template.id, deleting ? "memory.delete" : "memory.update", {
      resource, input: deleting ? { memoryId: value.id, confirmDelete: true } : { memoryId: value.id, channel, text },
    }, signal), true);
    if (result) { changed(); close(); }
  }
  function back() { setMode("read"); setChannel(value.channel); setText(value.text); }
  return <EditorDialog title={mode === "delete" ? "删除记忆" : mode === "edit" ? "编辑记忆" : "记忆详情"} close={close} locked={request.writing}
    footer={mode === "read" ? <div className="synapse-editor-footer"><Arco.Button status="danger" onClick={() => setMode("delete")}>删除</Arco.Button><Arco.Space>
      <Arco.Button onClick={close}>关闭</Arco.Button><Arco.Button onClick={() => setMode("edit")}>编辑</Arco.Button></Arco.Space></div>
      : <Arco.Space><Arco.Button disabled={request.busy} onClick={back}>取消</Arco.Button><Arco.Button type="primary" status={mode === "delete" ? "danger" : undefined}
        loading={request.busy} disabled={request.busy || (mode === "edit" && !text.trim())} onClick={() => void save()}>{mode === "delete" ? "确认删除" : "保存记忆"}</Arco.Button></Arco.Space>}>
    <ErrorNotice error={request.error}/>
    {mode === "edit" ? <div className="synapse-config-form">
      <label>记忆分类<Arco.Select value={channel} disabled={request.busy} options={categories.slice(1)} onChange={setChannel}/></label>
      <label>记忆正文<Arco.Input.TextArea value={text} disabled={request.busy} autoSize={{ minRows: 6, maxRows: 20 }} onChange={setText}/></label>
    </div> : <>
      {mode === "delete" && <p>确定从本地记忆库删除这条记忆？</p>}
      <p>{categoryName(value.channel)} · {sourceName(value.source)} · {value.created} UTC</p>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value.text}</p>
    </>}
  </EditorDialog>;
}

function HybridSearch({ view, client, initialQuery, initialScope, close }: ConfigPanelProps & { initialQuery: string; initialScope: string; close(): void }) {
  const request = useRequests();
  const [query, setQuery] = React.useState(initialQuery);
  const [scope, setScope] = React.useState(initialScope === "review" ? "review" : "chat");
  const [hits, setHits] = React.useState<(MemoryDocument & { score: number })[]>();
  async function search() {
    const result = await request.run(signal => client.invoke(view.template.id, "memory.search", { input: { query, channel: scope } }, signal));
    if (result) setHits((result.value as unknown as {items: typeof hits}).items);
  }
  return <EditorDialog title="混合检索" close={close}>
    <div className="synapse-config-form"><Arco.Select aria-label="检索分类" value={scope} options={categories.slice(1)} disabled={request.busy} onChange={v => { setScope(v); setHits(undefined); }}/>
      <Arco.Input aria-label="检索内容" placeholder="想从记忆中查找什么？" value={query} disabled={request.busy} onChange={v => { setQuery(v); setHits(undefined); }} onPressEnter={() => { if(query.trim() && !request.busy) void search(); }}/>
      <Arco.Button disabled={!query.trim() || request.busy} loading={request.busy} onClick={() => void search()}>检索</Arco.Button></div>
    <ErrorNotice error={request.error}/>
    {hits && (hits.length ? <ol>{hits.map(hit => <li key={hit.id}><p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{hit.text}</p><small>{sourceName(hit.source)}</small></li>)}</ol> : <p>没有检索到相关记忆。</p>)}
  </EditorDialog>;
}

export function MemoryBrowser({ ctx }: { ctx: SettingsContext }) {
  const { view, client } = ctx;
  const id = React.useId();
  const [scope, setScope] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<Page>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [version, refresh] = React.useReducer(n => n + 1, 0);
  const [modal, setModal] = React.useState<"import" | "rag" | "hybrid">();
  const [detail, setDetail] = React.useState<{value: MemoryDocument; resource: ConfigResource}>();
  const read = useRequests();
  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const load = async () => {
      try {
        const result = await client.invoke(view.template.id, "memory.page", { input: { scope, query, page, pageSize } }, controller.signal);
        if (controller.signal.aborted) return;
        const fetched = result.value as unknown as Page;
        setData(fetched); if (page !== fetched.page) setPage(fetched.page);
      } catch (e) {
        if (!controller.signal.aborted) { setData(undefined); setError(e instanceof Error ? e.message : String(e)); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    const timer = setTimeout(() => void load(), query ? 140 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, view.template.id, scope, query, page, version]);
  async function open(row: MemorySummary) {
    const result = await read.run(signal => client.invoke(view.template.id, "memory.load", { input: { memoryId: row.id } }, signal));
    if (result?.resource) setDetail({ value: result.value as unknown as MemoryDocument, resource: result.resource });
  }
  const start = ((data?.page ?? 1) - 1) * pageSize;
  return <div className="synapse-resources">
    <div className="sr-bar"><div className="sr-search"><Input type="search" aria-label="搜索记忆" prefix={<Icon name="Search" size={15}/>} placeholder="搜索正文或来源" value={query} onChange={v => { setQuery(v); setPage(1); }}/></div>
      <Button size="sm" variant="outline" onClick={() => setModal("rag")}>检索设置</Button>
      <Button size="sm" variant="outline" onClick={() => setModal("hybrid")}>混合检索</Button>
      <Button size="sm" variant="primary" onClick={() => setModal("import")}>导入 Hermes</Button>
    </div>
    <SegmentedControl label="记忆分类" id={id} value={scope} items={categories} onChange={v => { setScope(v); setPage(1); }}/>
    <ErrorNotice error={error || read.error}/>
    <div role="tabpanel" id={`${id}-${scope}-panel`} aria-labelledby={`${id}-${scope}`}>
      <Table rowKey="id" data={data?.items ?? []} loading={loading} size="small" border={false} pagination={false}
        tableLayoutFixed scroll={{ x:"max(100%, 536px)" }} noDataElement={query ? "没有符合条件的记忆" : "还没有记忆"} columns={[
          {title:"记忆摘要", dataIndex:"summary", render:(summary:string) => <span className="sr-brief">{summary}</span>},
          {title:"分类", dataIndex:"channel", width:90, render:categoryName},
          {title:"来源", dataIndex:"source", width:100, ellipsis:true, render:sourceName},
          {title:"操作", dataIndex:"id", width:70, fixed:"right", render:(_v, row: MemorySummary) => <Button size="sm" variant="text" disabled={read.busy} onClick={() => void open(row)}>查看</Button>},
        ]}/>
      <div className="sr-pages"><small role="status">{data?.total ? `显示 ${start + 1}–${start + data.items.length} 条，共 ${data.total} 条` : loading ? "正在读取记忆…" : "共 0 条"}</small>
        {data && data.total > pageSize && <Pagination simple showJumper size="small" current={data.page} total={data.total} pageSize={pageSize} onChange={setPage}/>}
        {error && <Button size="sm" onClick={refresh}>重新加载</Button>}
      </div>
    </div>
    {modal === "rag" && <MemorySettings ctx={ctx} close={() => setModal(undefined)}/>}
    {modal === "hybrid" && <HybridSearch view={view} client={client} initialQuery={query} initialScope={scope} close={() => setModal(undefined)}/>}
    {modal === "import" && <MemoryImport view={view} client={client} requirePreview onImported={refresh} close={() => setModal(undefined)}/>}
    {detail && <MemoryDetail {...detail} view={view} client={client} changed={refresh} close={() => setDetail(undefined)}/>}
  </div>;
}
