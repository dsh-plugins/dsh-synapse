import * as React from "react";
import { Arco, Scrollbar, Markdown } from "@dsh-plugin/dsh-loader/client";

export const MANAGER_CSS = `
.synapse-manager-toolbar{display:flex;justify-content:flex-end;gap:8px;margin:8px 0}
.synapse-manager-table{max-height:360px;margin-top:12px}
.synapse-manager-table .arco-table-th{position:sticky;top:0;z-index:1}
.synapse-editor.arco-modal{top:120px;margin-bottom:120px;max-height:calc(100dvh - 240px);display:flex;flex-direction:column;width:min(900px,calc(100vw - 32px))}
.synapse-editor>div:has(>.arco-modal-header){display:flex;flex-direction:column;min-height:0;max-height:inherit}
.synapse-editor .arco-modal-header,.synapse-editor .arco-modal-footer{flex-shrink:0}
.synapse-editor .arco-modal-content{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:16px 20px}
.synapse-editor-wrap{overflow:hidden}
.synapse-editor .arco-modal-title{width:100%;text-align:start}
.synapse-editor-heading{display:flex;align-items:center;gap:12px;justify-content:space-between;padding-right:24px}
.synapse-editor-heading>span{overflow-wrap:anywhere;min-width:0}
.synapse-editor-heading .arco-space{flex-shrink:0}
.synapse-editor .synapse-editor-scroll{flex:0 1 auto;width:100%}
.synapse-editor-content{min-width:0;overflow-wrap:anywhere}
.synapse-editor-content .arco-textarea{resize:none}
.synapse-markdown{line-height:1.65;overflow-wrap:anywhere;min-height:80px}
.synapse-markdown pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--color-fill-1);padding:12px;border-radius:6px}
.synapse-markdown img{max-width:100%}.synapse-markdown table{border-collapse:collapse;width:100%}
.synapse-markdown th,.synapse-markdown td{border:1px solid var(--color-border-2);padding:6px}
.synapse-manager-error{margin:8px 0;color:var(--color-danger-light-4,var(--color-text-1))}
.synapse-editor-field{margin-bottom:14px}.synapse-editor-field>label{display:block;margin-bottom:6px}
.synapse-editor-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
`;

export function useRequests() {
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [writing, setWriting] = React.useState(false);
  const active = React.useRef(true), calls = React.useRef(new Map<AbortController, boolean>());
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const call of calls.current.keys()) { call.abort(); }
      calls.current.clear();
    };
  }, []);
  const run = React.useCallback(async <T,>(work: (signal: AbortSignal) => Promise<T>, write = false): Promise<T | undefined> => {
    const controller = new AbortController();
    calls.current.set(controller, write);
    setError(""); setBusy(true); setWriting([...calls.current.values()].some(Boolean));
    try {
      const result = await work(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (cause) {
      if (active.current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return undefined;
    } finally {
      calls.current.delete(controller);
      if (active.current) { setBusy(calls.current.size > 0); setWriting([...calls.current.values()].some(Boolean)); }
    }
  }, []);
  const cancel = () => {
    for (const call of calls.current.keys()) { call.abort(); }
    setError("已取消请求");
  };
  return { error, busy, writing, run, cancel };
}

export function ErrorNotice({ error }: { error: string }) {
  return error ? <Arco.Alert type="error" content={error} className="synapse-manager-error" /> : null;
}

export function Preview({ content }: { content: string }) {
  return <div className="synapse-markdown"><Markdown skipHtml components={{ a: ({ href, title, children }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a> }}>{content || "暂无内容"}</Markdown></div>;
}

export function EditorDialog({ title, actions, footer, children, close, locked = false }: {
  title: string; actions?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; close(): void; locked?: boolean;
}) {
  return <Arco.Modal visible alignCenter={false} className="synapse-editor" wrapClassName="synapse-editor-wrap"
    title={<div className="synapse-editor-heading"><span>{title}</span><Arco.Space>{actions}</Arco.Space></div>}
    footer={footer ?? <Arco.Button disabled={locked} onClick={close}>关闭</Arco.Button>} onCancel={() => { if (!locked) { close(); } }} closable={!locked} escToExit={!locked} maskClosable={false} unmountOnExit>
    <style>{MANAGER_CSS}</style>
    <Scrollbar className="synapse-editor-scroll" aria-label={title}><div className="synapse-editor-content">{children}</div></Scrollbar>
  </Arco.Modal>;
}

export function TableArea({ children }: { children: React.ReactNode }) {
  return <Scrollbar className="synapse-manager-table" aria-label="管理列表">{children}</Scrollbar>;
}
