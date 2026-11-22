import * as React from "react";
import { Button, Field, InputNumber, Select, Table, Tag, Tabs, TabPane } from "@dsh-plugin/dsh-ui-components";
import { newRepository, repositoryName, REPOSITORY_PATTERN } from "../../github-repositories.js";
import type { GithubRepository, GithubReviewConfig } from "../../types.js";
import { ReviewsPanel } from "../reviews.js";
import type { SettingsContext } from "../settings-context.js";
import { Dialog, TextField, Toggle } from "./controls.js";
import { listGroups } from "./groups-model.js";

const switches = [["reviewPr", "PR 审查"], ["triageIssues", "Issue 分诊"], ["sendCards", "通知卡片"]] as const;
type Subscription = { repository: string; groups: number[] };
type Editing = { kind: "rules"; index: number; value: GithubRepository } | { kind: "subscriptions"; index: number; value: Subscription };

export function GithubSection(ctx: SettingsContext) {
  const data = ctx.value.github, subscriptions = ctx.value.modules.github.subscriptions;
  const groups = listGroups(ctx.value), names = new Map(groups.map(g => [Number(g.id), g.name || g.id]));
  const linkedRepo = new URLSearchParams(ctx.route.split("?")[1]).get("repo");
  const fromPath = linkedRepo ? "rules" : ctx.route.split("/")[1] || "connection";
  const [tab, setTab] = React.useState(fromPath);
  React.useEffect(() => { setTab(fromPath); }, [fromPath]);
  const [draft, setDraft] = React.useState<Editing>(), [removing, setRemoving] = React.useState(false), [error, setError] = React.useState("");
  function update<K extends keyof GithubReviewConfig>(key: K, value: GithubReviewConfig[K]) {
    ctx.setValue(previous => ({ ...previous, github: { ...previous.github, [key]: value } }));
  }
  function open(kind: "rules" | "subscriptions", index = -1) {
    setRemoving(false); setError("");
    setDraft(kind === "rules" ? { kind, index, value: { ...(data.repositories[index] ?? newRepository()) } }
      : { kind, index, value: structuredClone(subscriptions[index] ?? { repository: "", groups: [] }) });
  }
  React.useEffect(() => {
    if (!linkedRepo) return;
    const index = data.repositories.findIndex(row => row.repository.toLowerCase() === linkedRepo.toLowerCase());
    if (index >= 0) open("rules", index);
  }, [linkedRepo]);
  function close() {
    setDraft(undefined);
    if (linkedRepo) ctx.navigate("github/rules");
  }
  function rows<T>(previous: T[], index: number, value: T) {
    if (index < 0) return [...previous, value];
    return removing ? previous.filter((_, i) => index !== i) : previous.map((item, i) => i === index ? value : item);
  }
  function save() {
    if (!draft) return;
    const name = draft.value.repository.trim();
    if (!removing) {
      const valid = draft.kind === "rules" ? new RegExp(REPOSITORY_PATTERN).test(name) : repositoryName(name);
      if (!valid) { setError(draft.kind === "rules" ? "请输入 owner/repo 或 owner/*。" : "请输入完整仓库名 owner/repo。"); return; }
      const existing = draft.kind === "rules" ? data.repositories : subscriptions;
      if (existing.some((r, i) => i !== draft.index && r.repository.toLowerCase() === name.toLowerCase())) { setError("仓库不能重复。"); return; }
    }
    if (draft.kind === "rules") {
      ctx.setValue(previous => ({ ...previous, github: { ...previous.github,
        repositories: rows(previous.github.repositories, draft.index, { ...draft.value, repository: name }) } }));
    } else {
      ctx.setValue(previous => ({ ...previous, modules: { ...previous.modules, github: { ...previous.modules.github,
        subscriptions: rows(previous.modules.github.subscriptions, draft.index, { ...draft.value, repository: name }) } } }));
    }
    close();
  }
  return <div className="channel-fields">
    <Tabs activeTab={tab} onChange={setTab} lazyload>
      <TabPane key="connection" title="Webhook 接入"><div className="channel-fields">
        <Toggle label="接收 GitHub 事件" checked={data.enabled} change={v => update("enabled", v)}/>
        <TextField label="Webhook 路径" mono readOnly value="/hooks/dsh-synapse/github" description="将此路径接在 DSH 域名之后，Content type 选择 application/json。"/>
        <div className="channel-grid">
          <TextField label="Webhook Secret" secret value={data.webhookSecret} change={v => update("webhookSecret", v)}/>
          <TextField label="GitHub Token" secret value={data.token} change={v => update("token", v)}/>
        </div>
        <Toggle label="把审查结果发布为评论" checked={data.publishReviews} change={v => update("publishReviews", v)}/>
        <details><summary>高级选项</summary><div className="channel-fields">
          <Toggle label="允许无签名的卡片通知" checked={data.allowUnsignedCards} change={v => update("allowUnsignedCards", v)} description="审查和分诊始终需要有效签名。"/>
          <Field label="差异内容上限（字符）"><InputNumber aria-label="差异内容上限" min={1000} max={500000} precision={0} value={data.maxDiffChars} onChange={v => update("maxDiffChars", v)}/></Field>
        </div></details>
      </div></TabPane>
      <TabPane key="rules" title="仓库规则"><div className="channel-fields">
        <div className="channel-heading"><span>单个仓库的设置优先于组织规则。</span><Button size="sm" variant="outline" onClick={() => open("rules")}>添加仓库</Button></div>
        <Table className="groups-table" rowKey="repository" data={data.repositories} size="small" pagination={data.repositories.length > 10 ? { pageSize: 10 } : false}
          noDataElement="还没有仓库规则" scroll={{ x: 445 }} columns={[
            { title: "仓库", dataIndex: "repository" }, { title: "已启用功能", render: (_, r: GithubRepository) => <div className="groups-tags">
              {switches.filter(([key]) => r[key]).map(([key, label]) => <Tag key={key} size="sm">{label}</Tag>)}</div> },
            { title: "操作", width: 86, fixed: "right", render: (_, r) => <Button size="sm" variant="text" onClick={() => open("rules", data.repositories.findIndex(item => item.repository === (r as GithubRepository).repository))}>编辑</Button> },
          ]}/>
      </div></TabPane>
      <TabPane key="subscriptions" title="群通知"><div className="channel-fields">
        <div className="channel-heading"><span>选择接收各仓库通知的 QQ 群。</span><Button size="sm" variant="outline" onClick={() => open("subscriptions")}>添加订阅</Button></div>
        <Table className="groups-table" rowKey="repository" data={subscriptions} size="small" pagination={subscriptions.length > 10 ? { pageSize: 10 } : false}
          noDataElement="还没有群通知订阅" scroll={{ x: 445 }} columns={[
            { title: "仓库", dataIndex: "repository" }, { title: "通知群", render: (_, sub: Subscription) => sub.groups.map(id => names.get(id) || id).join("、") || "未选择" },
            { title: "操作", width: 86, fixed: "right", render: (_, r) => <Button size="sm" variant="text" onClick={() => open("subscriptions", subscriptions.findIndex(item => item.repository === (r as Subscription).repository))}>编辑</Button> },
          ]}/>
      </div></TabPane>
      <TabPane key="reviews" title="审查记录"><ReviewsPanel {...ctx}/></TabPane>
    </Tabs>
    {draft && <Dialog title={(removing ? "移除" : draft.index < 0 ? "添加" : "编辑") + (draft.kind === "rules" ? "仓库规则" : "群通知订阅")} close={close} footer={
      <div className="groups-dialog-actions">
        {!removing && draft.index >= 0 && <Button variant="text" danger onClick={() => setRemoving(true)}>移除</Button>}
        <Button variant="outline" onClick={close}>取消</Button><Button danger={removing} onClick={save}>{removing ? "确认移除" : "应用修改"}</Button>
      </div>}>
      {removing ? <p>移除 {draft.value.repository} 的{draft.kind === "rules" ? "仓库规则" : "群通知订阅"}？</p> : <>
        <TextField label="仓库" mono placeholder="owner/repo" value={draft.value.repository}
          change={repository => setDraft(draft.kind === "rules" ? { ...draft, value: { ...draft.value, repository } } : { ...draft, value: { ...draft.value, repository } })}/>
        {draft.kind === "rules" ? switches.map(([key, label]) => <Toggle key={key} label={label} checked={draft.value[key]} change={checked => setDraft({ ...draft, value: { ...draft.value, [key]: checked } })}/>)
          : <Field label="接收通知的 QQ 群"><Select multiple aria-label="接收通知的 QQ 群" value={draft.value.groups.map(String)}
            options={groups.map(g => ({ value: g.id, label: g.name ? g.name + " · " + g.id : g.id }))}
            onChange={values => setDraft({ ...draft, value: { ...draft.value, groups: (Array.isArray(values) ? values : [values]).map(Number) } })}/></Field>}
      </>}
      {error && <p className="groups-error" role="alert">{error}</p>}
    </Dialog>}
  </div>;
}
