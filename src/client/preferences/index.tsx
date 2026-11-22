import * as React from "react";
import { Button, Field, Radio, RadioGroup, Select } from "@dsh-plugin/dsh-ui-components";
import type { ConfigField } from "@dsh-plugin/dsh-loader/config";
import type { SettingsContext } from "../settings-context.js";
import { ActivityPanel, ActivityParameters } from "../activity.js";
import { getFields, SettingsFields } from "./fields.js";
import { InstructionFile } from "./instructions.js";
import { ErrorNotice, useRequests } from "../shared.js";

const categories = [
  { value: "chat", label: "聊天与触发条件" },
  { value: "presentation", label: "进度、审批与回执" },
  { value: "policy", label: "主动回复与热词" },
  { value: "subscriptions", label: "订阅、欢迎与时段提醒" },
  { value: "speech", label: "语音合成" },
  { value: "activity", label: "群状态、词云与触发日志" },
];

const CSS = `
.syn-prefs,.syn-pref-fields,.syn-pref-rules[open]{display:grid;gap:14px;min-width:0}
.syn-prefs>section,.syn-pref-rules,.syn-pref-group{min-width:0;margin:0}
.syn-pref-group{padding:10px 0;border:0;border-top:1px solid var(--border)}
.syn-pref-group>legend,.syn-prefs h3{font:inherit;font-weight:600;margin:0}
.syn-pref-group>.arco-btn{margin-top:8px}
.syn-pref-array-row,.syn-pref-password{display:flex;align-items:flex-start;gap:8px;min-width:0;margin-block:6px}
.syn-pref-array-row>:first-child,.syn-pref-password>:first-child{flex:1;min-width:0}
.syn-pref-actions{display:flex;flex-wrap:wrap;gap:8px}
.syn-prefs p{margin:4px 0 8px;overflow-wrap:anywhere}
.syn-pref-rules summary{cursor:pointer;font-weight:500}
.syn-pref-rules textarea{width:100%}
.syn-prefs .synapse-activity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:12px}
.syn-prefs .synapse-activity-field{display:grid;gap:4px;min-width:0}
.syn-prefs .synapse-activity-help{font-size:12px;color:var(--muted)}
.syn-prefs [data-pref-label]:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
`;

function RuntimeStatus({ ctx }: { ctx: SettingsContext }) {
  const request = useRequests();
  const [result, setResult] = React.useState("");
  const call = (operation: "status.read" | "features.refresh") => request.run(async signal => {
    const next = await ctx.client.invoke(ctx.view.template.id, operation, { input: {} }, signal);
    if (operation === "features.refresh") await ctx.refresh();
    setResult(String(next.value));
  }, operation === "features.refresh");
  return <section><h3>机器人运行状态</h3><div className="syn-pref-actions">
    <Button size="sm" variant="outline" disabled={request.busy} onClick={() => void call("status.read")}>读取运行状态</Button>
    <Button size="sm" variant="outline" disabled={request.busy || ctx.saving} onClick={() => void call("features.refresh")}>同步聊天命令修改的设置</Button>
  </div><ErrorNotice error={request.error}/>{result && <p role="status" style={{ whiteSpace: "pre-wrap" }}>{result}</p>}</section>;
}

function GroupFields({ ctx, path, filter }: {
  ctx: SettingsContext; path: string[]; filter?: (field: ConfigField) => boolean;
}) {
  const fields = getFields(ctx.view.template.fields, path);
  return <SettingsFields ctx={ctx} fields={filter ? fields.filter(filter) : fields} path={path}/>;
}

function Session({ ctx }: { ctx: SettingsContext }) {
  const limits = getFields(ctx.view.template.fields, ["limits"]);
  const permission = limits.find(field => field.key === "sessionPermission");
  return <>
    {permission && <Field label={permission.label} description={permission.description}>
      <RadioGroup direction="vertical" aria-label={permission.label} disabled={ctx.saving}
        value={ctx.value.limits.sessionPermission}
        onChange={sessionPermission => ctx.setValue(previous => ({ ...previous, limits: { ...previous.limits, sessionPermission } }))}>
        {permission.options.map(option => <Radio key={option.value} value={option.value} label={option.label}/>)}
      </RadioGroup>
    </Field>}
    <GroupFields ctx={ctx} path={["limits"]} filter={f => f.key !== "sessionPermission"}/>
    <GroupFields ctx={ctx} path={[]} filter={f => ["chatModel", "reviewModel"].includes(f.key)}/>
    <section><h3>提示词文件</h3><p>每次请求先读取当前 profile 的同名文件，接着查找 DSH Home，两个位置都没有时使用插件内置规则。QQ 与 Discord 共用聊天人设。</p></section>
    <InstructionFile ctx={ctx} channel="chat"/>
    <InstructionFile ctx={ctx} channel="review"/>
  </>;
}

function Notifications({ ctx }: { ctx: SettingsContext }) {
  const [location, query] = ctx.route.split("?");
  const label = new URLSearchParams(query).get("field");
  const root = React.useRef<HTMLDivElement>(null);
  const schema = ctx.view.template.fields;
  const hasLabel = (fields: ConfigField[]): boolean => fields.some(field =>
    field.label === label || hasLabel(field.fields ?? []) || (field.item && hasLabel([field.item])));
  const categoryPaths = [
    ["chat", ["modules", "chat"]], ["chat", ["modules", "management"]],
    ["presentation", ["modules", "presentation"]], ["policy", ["activity"]],
    ["subscriptions", ["modules", "bili"]], ["subscriptions", ["modules", "welcome"]],
    ["subscriptions", ["modules", "peakValley"]], ["speech", ["speech"]],
  ] as [string, string[]][];
  const selected = label ? categoryPaths.find(([, path]) => hasLabel(getFields(schema, path)))?.[0] : location.split("/")[1];
  const category = categories.some(item => item.value === selected) ? selected : "chat";
  React.useEffect(() => {
    if (!label || !root.current) return;
    const target = Array.from(root.current.querySelectorAll<HTMLElement>("[data-pref-label]"))
      .find(el => el.dataset.prefLabel === label);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }, [ctx.route, label]);
  return <div className="syn-pref-fields" ref={root}>
    <Field label="设置分类" htmlFor="synapse-notification-category"><Select id="synapse-notification-category"
      value={category} options={categories} onChange={next => ctx.navigate("notifications/" + next)}/></Field>
    {category === "chat" && <>
      <GroupFields ctx={ctx} path={["modules", "chat"]} filter={field => field.key !== "groups"}/>
      <h3>管理员</h3>
      <GroupFields ctx={ctx} path={["modules", "management"]} filter={field => field.key !== "groups"}/>
    </>}
    {category === "presentation" && <GroupFields ctx={ctx} path={["modules", "presentation"]}/>}
    {category === "policy" && <>
      <GroupFields ctx={ctx} path={["activity"]} filter={field => ["probabilityEnabled", "idleEnabled", "imageRetentionDays", "logRetentionDays", "botUsers"].includes(field.key)}/>
      <ActivityParameters value={ctx.value.activity} change={({ probability, idle, words, blockedWords }) =>
        ctx.setValue(previous => ({ ...previous, activity: { ...previous.activity, probability, idle, words, blockedWords } }))}/>
    </>}
    {category === "subscriptions" && <GroupFields ctx={ctx} path={["modules"]} filter={field => ["bili", "welcome", "peakValley"].includes(field.key)}/>}
    {category === "speech" && <GroupFields ctx={ctx} path={["speech"]}/>}
    {category === "activity" && <><RuntimeStatus ctx={ctx}/><ActivityPanel view={ctx.view} client={ctx.client} monitorOnly/></>}
  </div>;
}

export function PreferencesSection({ section, ...ctx }: SettingsContext & { section: string }) {
  return <div className="syn-prefs"><style>{CSS}</style>
    {section === "session" ? <Session ctx={ctx}/> : <Notifications ctx={ctx}/>}
  </div>;
}
