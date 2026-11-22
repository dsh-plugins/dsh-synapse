import * as React from "react";
import { Button, DisclosureRow, DshProvider, Icon, Input, SettingsRow } from "@dsh-plugin/dsh-ui-components";
import type { ConfigField, ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import { ChannelsSection } from "./channels/index.js";
import { listGroups } from "./channels/groups-model.js";
import { PreferencesSection } from "./preferences/index.js";
import { ResourcesSection } from "./resources/index.js";
import { useSettingsDraft } from "./settings-draft.js";
import type { SettingsContext } from "./settings-context.js";
import { SectionIcon } from "./settings-icons.js";
import { sections } from "./settings-sections.js";
import { settingsCss } from "./settings-styles.js";

const channels = ["onebot", "discord", "github", "groups"];
const preferences = ["session", "notifications"];
const permissionNames = { "read-only": "仅查看", "workspace-write": "工作区修改", "danger-full-access": "完全权限", auto: "自动审查" };
type Match = { label: string; context: string; route: string };

function search(ctx: SettingsContext, groups: ReturnType<typeof listGroups>, query: string) {
  const matches: Match[] = [];
  const includes = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  for (const section of sections) {
    for (const [route, label, description, , keywords] of section.items) {
      if (includes([label, description, keywords].join(" "))) matches.push({ label, context: section.title, route });
    }
  }
  for (const group of groups) {
    if (includes(group.id + " " + group.name)) matches.push({ label: group.name || group.id, context: "群聊 · " + group.id, route: "groups?group=" + encodeURIComponent(group.id) });
  }
  for (const repo of ctx.value.github.repositories) {
    if (includes(repo.repository)) matches.push({ label: repo.repository, context: "GitHub 仓库", route: "github?repo=" + encodeURIComponent(repo.repository) });
  }
  function fields(items: ConfigField[], parent: string) {
    for (const field of items) {
      if (field.fields) fields(field.fields, field.label);
      else if (includes(field.label)) matches.push({ label: field.label, context: parent, route: "notifications?field=" + encodeURIComponent(field.label) });
    }
  }
  const modules = ctx.view.template.fields.find(field => field.key === "modules");
  if (modules?.fields) fields(modules.fields, modules.label);
  return matches;
}

function Settings({ view, client }: ConfigPanelProps) {
  const draft = useSettingsDraft({ view, client });
  const [route, setRoute] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");
  const panel = React.useRef<HTMLElement>(null);
  const active = route.split(/[/?]/)[0];
  const navigate = (to: string) => { setQuery(""); setRoute(to); };
  const ctx: SettingsContext = { ...draft, client, route, navigate };
  const groups = React.useMemo(() => listGroups(draft.value), [draft.value]);
  const term = query.trim();
  const matches = term ? search(ctx, groups, term) : [];
  const value = draft.value;
  const discordEnabled = typeof value.modules.discord.token === "string"
    ? Boolean(value.modules.discord.token) : Boolean((value.modules.discord.token as { set: boolean })?.set);
  const summaries: Record<string, string> = {
    onebot: value.enabled ? "已启用" : "未启用",
    discord: discordEnabled ? value.modules.discord.bridges.length + " 条桥接" : "未设置",
    github: value.github.enabled ? value.github.repositories.length + " 条仓库规则" : "未启用",
    groups: groups.length + " 个群聊", session: permissionNames[value.limits.sessionPermission],
    memory: value.memory.enabled ? "已启用" : "未启用", mcp: value.mcpServers.length + " 个服务",
  };
  async function save() {
    setError(""); setNotice("");
    const invalid = panel.current?.querySelector<HTMLInputElement>("input:invalid, textarea:invalid");
    if (invalid?.getClientRects().length && !invalid.reportValidity()) return;
    try { await draft.save(); setNotice("配置已保存。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function discard() {
    if (!window.confirm("撤销本页未保存的修改？")) return;
    draft.discard(); setError(""); setNotice("已载入最新配置。");
  }
  const actions = <>
    {draft.dirty && <SettingsRow className="syn-ui-actions" label="有未保存的更改">
      <div className="syn-ui-buttons">
        <Button variant="text" size="sm" disabled={draft.saving} onClick={discard}>撤销更改</Button>
        <Button variant="primary" size="sm" disabled={draft.saving || !!draft.conflict} onClick={() => void save()}>保存设置</Button>
      </div>
    </SettingsRow>}
    {(error || draft.conflict) && <div className="syn-notice" role="alert">{draft.conflict || error}</div>}
    <div className="syn-notice" role="status" aria-live="polite">{notice}</div>
  </>;
  return <section className="syn-config" ref={panel} aria-label="Synapse 插件设置"
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopPropagation();
        if (draft.dirty && !draft.saving && !draft.conflict) void save();
      }
    }}>
    <style>{settingsCss}</style>
    <div className="syn-ui-search"><Input type="search" aria-label="查找设置、群聊或仓库"
      placeholder="查找设置、群聊或仓库" prefix={<Icon name="Search" size={15}/>} value={query} onChange={setQuery}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.key === "Escape") setQuery("");
        if (event.key === "Enter" && !event.nativeEvent.isComposing && matches[0]) { event.preventDefault(); navigate(matches[0].route); }
      }}/></div>
    {term ? matches.length ? <div className="syn-matches">{matches.map((m, i) =>
      <button type="button" key={i} onClick={() => navigate(m.route)}><strong>{m.label}</strong><small>{m.context}</small><Icon name="ChevronRight" size={14}/></button>)}</div>
      : <p className="syn-empty">没有匹配项，请试试群号或设置名称。</p>
    : sections.map(group => <section key={group.title} className="syn-group"><h2>{group.title}</h2><div className="syn-rows">
        {group.items.map(([id, label, description, glyph]) => {
          const Component = channels.includes(id) ? ChannelsSection : preferences.includes(id) ? PreferencesSection : ResourcesSection;
          return <div key={id} className="syn-item" data-section={id}>
            <DisclosureRow className="syn-ui-disclosure" expanded={active === id} onToggle={open => navigate(open ? id : "")}
              leading={<span className={"syn-symbol syn-" + glyph}><SectionIcon name={glyph}/></span>}
              title={<span className="syn-ui-line"><span className="syn-label"><strong>{label}</strong><small>{description}</small></span>
                {summaries[id] && <span className="syn-summary">{summaries[id]}</span>}</span>}>
              {active === id && <div className="syn-body"><div className="syn-fields"><Component {...ctx} section={id}/></div>{actions}</div>}
            </DisclosureRow>
          </div>;
        })}
      </div></section>)}
    {(!active || term) && actions}
  </section>;
}

export function SettingsPanel(props: ConfigPanelProps) {
  return <DshProvider theme="host"><Settings {...props}/></DshProvider>;
}
