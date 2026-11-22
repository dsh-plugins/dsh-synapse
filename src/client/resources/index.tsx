import * as React from "react";
import type { SettingsContext } from "../settings-context.js";
import { SkillsPanel } from "../skills.js";
import { McpPanel } from "../mcp.js";
import { MemoryBrowser } from "./memory-browser.js";
import { MemorySettings } from "./memory-settings.js";

const resourceCss = `
.synapse-resources{display:grid;gap:12px;min-width:0;container:synapse-resource / inline-size}
.synapse-resources [role=tabpanel]{min-width:0}
.synapse-resources [role=tablist]{justify-self:start}
.synapse-resources .sr-bar,.synapse-resources .sr-pages{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.synapse-resources .sr-search{flex:1 1 180px;min-width:0}
.synapse-resources .sr-brief,.synapse-resources .sr-item>*{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.synapse-resources .sr-brief{max-width:min(100%,calc(100cqw - 104px))}
.synapse-resources .sr-item small,.synapse-resources .sr-pages small{font-size:12px;color:var(--dsw-alias-label-secondary)}
.synapse-resources .sr-pages{margin-top:10px;justify-content:space-between}
.synapse-import-items{display:grid;gap:10px;padding-block:8px}
.synapse-resource-modal{width:min(660px,calc(100vw - 32px))!important}
.synapse-resource-modal .arco-modal-footer{display:flex;gap:8px;justify-content:flex-end}
@container synapse-resource (max-width:430px){.synapse-resources .sr-search{flex-basis:100%}}
`;

export function ResourcesSection({ section, ...ctx }: SettingsContext & { section:string }) {
  const [skillSettings, setSkillSettings] = React.useState(false);
  return <><style>{resourceCss}</style>
    {section === "memory" && <MemoryBrowser ctx={ctx}/>}
    {section === "skills" && <>
      <SkillsPanel view={ctx.view} client={ctx.client} settings={() => setSkillSettings(true)}/>
      {skillSettings && <MemorySettings ctx={ctx} skills close={() => setSkillSettings(false)}/>}
    </>}
    {section === "mcp" && <McpPanel view={ctx.view} client={ctx.client} onSaved={() => void ctx.refresh()}/>}
  </>;
}
