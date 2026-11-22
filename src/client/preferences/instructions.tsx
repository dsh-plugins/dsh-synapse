import * as React from "react";
import type { ConfigResource } from "@dsh-plugin/dsh-loader/config";
import { Button, Textarea } from "@dsh-plugin/dsh-ui-components";
import type { SettingsContext } from "../settings-context.js";
import { ErrorNotice, useRequests } from "../shared.js";

type Document = { name: string; content: string; source: string; override: boolean };

export function InstructionFile({ ctx, channel }: { ctx: SettingsContext; channel: "chat" | "review" }) {
  const name = channel === "chat" ? "SOUL.md" : "AGENTS.md";
  const request = useRequests();
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<Document>();
  const [resource, setResource] = React.useState<ConfigResource>();
  const [draft, setDraft] = React.useState("");
  const [confirmInherit, setConfirmInherit] = React.useState(false);
  async function act(action: "read" | "save" | "inherit") {
    const result = await request.run(signal => ctx.client.invoke(ctx.view.template.id, "instructions." + action, {
      input: action === "save" ? { channel, content: draft } : { channel },
      ...(action === "read" ? {} : { resource }),
    }, signal), action !== "read");
    if (!result) return;
    const current = result.value as unknown as Document;
    setFile(current);
    setResource(result.resource);
    setDraft(current.content);
    setConfirmInherit(false);
  }
  const title = (channel === "chat" ? "聊天人设" : "审查规则") + " · " + name;
  return <details className="syn-pref-rules" open={open} onToggle={event => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (next && !file && !request.busy) void act("read");
  }}>
    <summary>{title}</summary>
    {request.busy && <p role="status">正在处理规则文件…</p>}
    <ErrorNotice error={request.error}/>
    {file && <>
      <p>当前来源 <code>{file.source}</code></p>
      <Textarea aria-label={title} mono value={draft} disabled={request.busy} onChange={setDraft} autoSize={{ minRows: 5, maxRows: 14 }}/>
    </>}
    <div className="syn-pref-actions">
      <Button size="sm" variant="outline" disabled={request.busy} onClick={() => void act("read")}>重新载入</Button>
      {file && <Button size="sm" disabled={request.busy || (file.override && draft === file.content)} onClick={() => void act("save")}>保存到当前 profile</Button>}
      {file?.override && !confirmInherit && <Button size="sm" variant="text" disabled={request.busy} onClick={() => setConfirmInherit(true)}>恢复继承</Button>}
    </div>
    {confirmInherit && <div>
      <p>删除当前 profile 的 {name} 后，下次请求会重新读取上级规则。</p>
      <div className="syn-pref-actions"><Button size="sm" variant="outline" disabled={request.busy} onClick={() => setConfirmInherit(false)}>取消</Button>
        <Button size="sm" danger disabled={request.busy} onClick={() => void act("inherit")}>删除覆盖文件</Button></div>
    </div>}
  </details>;
}
