import * as React from "react";
import type { ConfigPanelProps, ConfigValues, ConfigView } from "@dsh-plugin/dsh-loader/client";
import type { SynapseConfig } from "../types.js";
import type { Edit } from "./settings-context.js";

const config = (view: ConfigView) => view.value as unknown as SynapseConfig;
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !("$secret" in value);

/** Carry local edits over unrelated host writes. Lists and secret handles are atomic. */
function merge(base: unknown, draft: unknown, remote: unknown): unknown {
  if (same(base, draft)) return remote;
  if (same(base, remote) || same(draft, remote)) return draft;
  if (record(base) && record(draft) && record(remote)) {
    const result = { ...remote };
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
      const value = merge(base[key], draft[key], remote[key]);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    return result;
  }
  throw new Error("同一项配置已在其他位置修改。请撤销本页更改，载入最新值后再编辑。");
}

export function useSettingsDraft({ view, client }: ConfigPanelProps) {
  const store = React.useRef({ base: view, draft: config(view), latest: view, conflict: "" });
  const pending = React.useRef<AbortController>();
  const [, render] = React.useReducer((n: number) => n + 1, 0);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => () => pending.current?.abort(), []);

  const reconcile = React.useCallback(() => {
    const state = store.current;
    if (state.latest.revision <= state.base.revision) return;
    try {
      state.draft = merge(config(state.base), state.draft, config(state.latest)) as SynapseConfig;
      state.base = state.latest;
      state.conflict = "";
    } catch (error) {
      state.conflict = (error as Error).message;
    }
    render();
  }, []);
  const receive = React.useCallback((next: ConfigView) => {
    if (next.revision > store.current.latest.revision) store.current.latest = next;
    if (!pending.current) reconcile();
  }, [reconcile]);
  React.useEffect(() => receive(view), [view, receive]);
  const refresh = React.useCallback(async () => receive(await client.read(view.template.id)), [client, view.template.id, receive]);

  function setValue(edit: Edit) {
    store.current.draft = edit(store.current.draft);
    render();
  }
  function discard() {
    const latest = store.current.latest;
    store.current = { base: latest, latest, draft: config(latest), conflict: "" };
    render();
  }
  async function persist(edit?: Edit) {
    const state = store.current;
    if (pending.current) throw new Error("正在保存，请稍候。");
    if (state.conflict) throw new Error(state.conflict);
    const controller = new AbortController();
    const submitted = edit ? edit(config(state.base)) : state.draft;
    // Apply row edits to both snapshots before writing so a conflicting draft
    // can reject the action without persisting half of it.
    const draftAtStart = state.draft;
    const nextDraft = edit ? edit(draftAtStart) : submitted;
    pending.current = controller;
    setSaving(true);
    try {
      const { resource } = await client.invoke(view.template.id, "settings.save", {
        input: submitted as unknown as ConfigValues,
        resource: { id: "settings", revision: state.base.revision },
      }, controller.signal);
      controller.signal.throwIfAborted();
      // Store the acknowledged revision even if the follow-up read disconnects.
      // The read supplies fresh opaque references for any newly set passwords.
      const local = state.draft === draftAtStart ? nextDraft : edit ? edit(state.draft) : state.draft;
      state.base = { ...state.base, revision: Number(resource!.revision), value: submitted as unknown as ConfigValues };
      state.draft = local;
      if (state.latest.revision < state.base.revision) state.latest = state.base;
      const confirmed = await client.read(view.template.id);
      controller.signal.throwIfAborted();
      if (confirmed.revision === state.base.revision) {
        state.draft = merge(submitted, state.draft, config(confirmed)) as SynapseConfig;
        state.base = confirmed;
      }
      if (confirmed.revision >= state.latest.revision) state.latest = confirmed;
    } catch (error) {
      if (!controller.signal.aborted) {
        try { receive(await client.read(view.template.id)); } catch { /* Keep offline edits. */ }
      }
      throw error;
    } finally {
      if (!controller.signal.aborted) {
        pending.current = undefined;
        reconcile();
        setSaving(false);
      }
    }
  }
  const state = store.current;
  return { value: state.draft, view: state.latest, dirty: !same(config(state.base), state.draft),
    conflict: state.conflict, saving, setValue, commit: (edit: Edit) => persist(edit), save: () => persist(), discard, refresh };
}
