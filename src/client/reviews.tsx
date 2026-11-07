import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import { EditorDialog, ErrorNotice, MANAGER_CSS, Preview, TableArea, useRequests } from "./shared.js";

interface ReviewRow { id: string; event: string; state: string; attempts: number; updated: string; target: string }
interface ReviewDocument { target: string; state: string; content: string }
const states: Record<string, string> = { pending: "等待处理", running: "处理中", done: "已完成", completed: "已完成", failed: "失败", ignored: "已忽略", stale: "已过期" };

export function ReviewsPanel({ view, client }: ConfigPanelProps) {
  const request = useRequests();
  const [rows, setRows] = React.useState<ReviewRow[]>([]);
  const [document, setDocument] = React.useState<ReviewDocument>();
  const refresh = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "reviews.list", { input: {} }, signal));
    if (result) { setRows((result.value as unknown as { items: ReviewRow[] }).items); }
  };
  React.useEffect(() => { void refresh(); }, [client]);
  const read = async (id: string) => {
    const result = await request.run(signal => client.invoke(view.template.id, "reviews.read", { input: { id } }, signal));
    if (result) { setDocument(result.value as unknown as ReviewDocument); }
  };
  const retry = async (id: string) => {
    const result = await request.run(signal => client.invoke(view.template.id, "reviews.retry", { input: { id } }, signal));
    if (result) { await refresh(); }
  };
  return <>
    <style>{MANAGER_CSS}</style><div className="synapse-manager-toolbar"><Arco.Button loading={request.busy} onClick={() => { void refresh(); }}>刷新任务</Arco.Button></div>
    <ErrorNotice error={request.error}/>
    <TableArea><Arco.Table rowKey="id" data={rows} pagination={false} size="small" columns={[
      { title: "任务", dataIndex: "target" },
      { title: "类型", dataIndex: "event", width: 110, render: (event: string) => event === "issues" ? "Issue 分诊" : event === "pull_request" ? "PR 审查" : event },
      { title: "状态", width: 100, render: (_value, row: ReviewRow) => states[row.state] ?? row.state },
      { title: "更新时间", dataIndex: "updated", width: 170 },
      { title: "操作", width: 150, render: (_value, row: ReviewRow) => <Arco.Space><Arco.Button size="small" disabled={request.busy} onClick={() => { void read(row.id); }}>查看</Arco.Button>
        {row.state === "failed" && <Arco.Button size="small" disabled={request.busy} onClick={() => { void retry(row.id); }}>重试</Arco.Button>}</Arco.Space> },
    ]}/></TableArea>
    {document && <EditorDialog title={document.target || "审查任务"} close={() => setDocument(undefined)}><p>{states[document.state] ?? document.state}</p><Preview content={document.content}/></EditorDialog>}
  </>;
}
