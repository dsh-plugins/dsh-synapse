import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import type { ActivityConfig, ActivityGroup, ActivitySettings } from "../activity-config.js";
import { EditorDialog, ErrorNotice, MANAGER_CSS, TableArea, useRequests } from "./shared.js";

const time = (value: number) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "无";
const types = { check: "检查", roll: "掷骰", hit: "命中", skip: "跳过", submit: "提交", commit: "原生确认", send: "发送", failure: "失败", config: "配置变更", recovery: "恢复" };
const fields: Record<string, [string, string, boolean?][]> = {
  probability: [["baseBps", "基础概率", true], ["minBps", "最低概率", true], ["maxBps", "最高概率", true], ["cooldownSec", "冷却（秒）"], ["perMinute", "每分钟限额"], ["perHour", "每小时限额"]],
  idle: [["probabilityBps", "命中概率", true], ["windowMinutes", "窗口中心（分钟）"], ["jitterMinutes", "窗口浮动（分钟）"], ["cooldownSec", "冷却（秒）"], ["perHour", "每小时限额"], ["perDay", "每日限额"], ["delayMinSec", "最短延迟（秒）"], ["delayMaxSec", "最长延迟（秒）"]],
  words: [["windowHours", "词频窗口（小时）"], ["halfLifeHours", "半衰期（小时）"], ["maxBoostPercent", "最大词云加成（%，至多 200）"]],
};
const FORM_CSS = `.synapse-activity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.synapse-activity-field{display:flex;flex-direction:column;gap:6px}.synapse-activity-switches{display:flex;align-items:center;flex-wrap:wrap;gap:16px;margin:12px 0}.synapse-activity-filter{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.synapse-activity-filter>.arco-input-wrapper{width:180px}`;

function Lines({ values, label, placeholder, change }: { values: (number | string)[]; label: string; placeholder: string; change(value: string[]): void }) {
  const [text, setText] = React.useState(values.join("\n"));
  return <Arco.Input.TextArea aria-label={label} placeholder={placeholder} value={text} onChange={next => { setText(next); change(next.split(/\r?\n/).map(item => item.trim()).filter(Boolean)); }} autoSize={{ minRows: 3, maxRows: 6 }}/>;
}

function Parameters({ value, change }: { value: ActivitySettings; change(next: ActivitySettings): void }) {
  const set = (section: string, key: string, next: unknown) => change({ ...value, [section]: { ...value[section], [key]: next } });
  return <>
    {Object.entries(fields).map(([section, items]) => <React.Fragment key={section}>
      <Arco.Divider orientation="left">{{ probability: "概率回复", idle: "空闲消息", words: "持久化词云" }[section]}</Arco.Divider>
      <div className="synapse-activity-grid">{items.map(([key, label, percent]) => <label className="synapse-activity-field" key={key}>{label}
        <Arco.InputNumber aria-label={label} value={value[section][key] / (percent ? 100 : 1)} min={0} max={percent ? 100 : undefined} precision={percent ? 2 : 0}
          suffix={percent ? "%" : undefined} onChange={next => set(section, key, Math.round(Number(next) * (percent ? 100 : 1)))} />
      </label>)}</div>
      {section === "idle" && <div className="synapse-activity-grid" style={{ marginTop: 12 }}>{[["quietStart", "静默开始（HH:mm）"], ["quietEnd", "静默结束（HH:mm）"], ["timeZone", "时区"]].map(([key, label]) => <label className="synapse-activity-field" key={key}>{label}<Arco.Input aria-label={label} value={value.idle[key]} onChange={next => set("idle", key, next)}/></label>)}</div>}
    </React.Fragment>)}
    <Arco.Divider orientation="left">概率回复屏蔽词</Arco.Divider>
    <Lines label="概率回复屏蔽词" placeholder="每行一个；命中后仍记录背景与真人活跃" values={value.blockedWords} change={next => change({ ...value, blockedWords: next })}/>
  </>;
}

/** 策略编辑与运行日志共用配置修订号，保存时进行宿主统一校验。 */
export function ActivityPanel({ view, client }: ConfigPanelProps) {
  const request = useRequests();
  const [rows, setRows] = React.useState<any[]>([]), [logs, setLogs] = React.useState<any[]>([]);
  const [draft, setDraft] = React.useState<ActivityConfig>(), [resource, setResource] = React.useState<any>();
  const [selected, setSelected] = React.useState<number>(), [newGroup, setNewGroup] = React.useState<number>();
  const [filter, setFilter] = React.useState({ groupId: "", type: "", from: "", to: "" });
  const [detail, setDetail] = React.useState<any>();
  const invoke = (operation: string, input = {}, revision?: any, write = false) => request.run(signal => client.invoke(view.template.id, operation, { input, ...(revision ? { resource: revision } : {}) }, signal), write);
  const refresh = async () => {
    const result = await invoke("activity.status");
    if (result) { setRows((result.value as any).items); }
  };
  const query = async (older = false) => {
    const result = await invoke("activity.logs", { ...filter, beforeId: older && logs.length ? logs.at(-1).id : 0 });
    if (result) { setLogs((result.value as any).items); }
  };
  React.useEffect(() => { void refresh(); void query(); }, [client]);
  const open = async () => {
    const result = await invoke("activity.load");
    if (result) { setDraft((result.value as any).settings); setResource(result.resource); setSelected(undefined); }
  };
  const save = async () => {
    const result = await invoke("activity.save", { settings: draft }, resource, true);
    if (result) { setDraft(undefined); await refresh(); await query(); }
  };
  const group = draft?.groups.find(item => item.groupId === selected);
  const updateGroup = (next: Partial<ActivityGroup>) => setDraft({ ...draft, groups: draft.groups.map(item => item.groupId === selected ? { ...item, ...next } : item) });
  const add = () => {
    if (!Number.isSafeInteger(newGroup) || newGroup <= 0 || draft.groups.some(item => item.groupId === newGroup)) { return; }
    const { probability, idle, words, blockedWords } = structuredClone(draft);
    setDraft({ ...draft, groups: [...draft.groups, { groupId: newGroup, probabilityEnabled: false, idleEnabled: false, useDefaults: true, probability, idle, words, blockedWords }] });
    setSelected(newGroup); setNewGroup(undefined);
  };
  return <>
    <style>{MANAGER_CSS + FORM_CSS}</style>
    <div className="synapse-manager-toolbar"><Arco.Button onClick={() => { void open(); }} disabled={request.busy}>编辑群聊策略</Arco.Button><Arco.Button onClick={() => { void refresh(); }} loading={request.busy}>刷新状态</Arco.Button></div>
    <ErrorNotice error={request.error}/>
    <p>仅用于已启用聊天的 QQ 群。两个主动功能都需要全局和群级开关同时开启；背景窗口最多 100 条，图片由模型按需读取。</p>
    <TableArea><Arco.Table rowKey="groupId" data={rows} size="small" pagination={false} columns={[
      { title: "群", render: (_value, row) => `${row.name || ""}（${row.groupId}）` },
      { title: "窗口 / 状态", render: (_value, row) => <>{row.contextCount} 条 / {row.busy ? "回复中" : "空闲"}{row.claimedContextCount > 0 && <><br/>{row.claimedContextCount} 条提交中</>}</> },
      { title: "概率回复", render: (_value, row) => <>{row.probabilityEnabled ? "启用" : "关闭"}<br/>分钟 {row.probabilityMinute}/{row.limits.probability.perMinute}，小时 {row.probabilityHour}/{row.limits.probability.perHour}<br/>冷却至 {time(row.probabilityCooldownUntil)}</> },
      { title: "空闲消息", render: (_value, row) => <>{row.idleEnabled ? "启用" : "关闭"}<br/>小时 {row.idleHour}/{row.limits.idle.perHour}，每日 {row.idleDay}/{row.limits.idle.perDay}<br/>冷却至 {time(row.idleCooldownUntil)}</> },
      { title: "下次空闲期限", render: (_value, row) => <>{time(row.windowDue)}{row.pendingDue && <><br/>待发送 {time(row.pendingDue)}</>}</> },
    ]}/></TableArea>
    <Arco.Divider orientation="left">触发与配置日志</Arco.Divider>
    <div className="synapse-activity-filter"><Arco.Input aria-label="筛选群号" placeholder="群号（留空查全部）" value={filter.groupId} onChange={value => setFilter({ ...filter, groupId: value })}/>
      <Arco.Select aria-label="筛选日志类型" style={{ width: 140 }} allowClear placeholder="全部类型" value={filter.type || undefined} onChange={value => setFilter({ ...filter, type: value || "" })} options={Object.entries(types).map(([value, label]) => ({ value, label }))}/>
      <Arco.Input aria-label="日志开始时间" placeholder="开始时间，如 2026-11-04 09:00" value={filter.from} onChange={value => setFilter({ ...filter, from: value })}/>
      <Arco.Input aria-label="日志结束时间" placeholder="结束时间" value={filter.to} onChange={value => setFilter({ ...filter, to: value })}/>
      <Arco.Button disabled={request.busy} onClick={() => { void query(); }}>查询</Arco.Button><Arco.Button disabled={request.busy || !logs.length} onClick={() => { void query(true); }}>更早记录</Arco.Button></div>
    <TableArea><Arco.Table rowKey="id" data={logs} size="small" pagination={false} columns={[
      { title: "时间", render: (_value, row) => time(row.time) }, { title: "群号", dataIndex: "groupId" },
      { title: "类型", render: (_value, row) => types[row.type] || row.type }, { title: "原因", dataIndex: "reason" },
      { title: "概率 / 命中词", render: (_value, row) => `${row.probabilityBps === undefined ? "" : (row.probabilityBps / 100).toFixed(2) + "%"} ${(row.words || []).join("、")}` },
      { title: "操作", render: (_value, row) => <Arco.Button size="small" onClick={() => setDetail(row)}>详情</Arco.Button> },
    ]}/></TableArea>
    {detail && <EditorDialog title="触发日志详情" close={() => setDetail(undefined)}><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(detail, null, 2)}</pre></EditorDialog>}
    {draft && <EditorDialog title={group ? `群策略 · ${selected}` : "群聊策略 · 全局默认值"} locked={request.writing} close={() => setDraft(undefined)}
      actions={<Arco.Button type="primary" loading={request.writing} onClick={() => { void save(); }}>保存</Arco.Button>}>
      <ErrorNotice error={request.error}/>
      <div className="synapse-activity-switches"><label>全局概率回复 <Arco.Switch checked={draft.probabilityEnabled} onChange={value => setDraft({ ...draft, probabilityEnabled: value })}/></label><label>全局空闲消息 <Arco.Switch checked={draft.idleEnabled} onChange={value => setDraft({ ...draft, idleEnabled: value })}/></label><Arco.Button onClick={() => setSelected(undefined)}>编辑全局默认值</Arco.Button></div>
      <TableArea><Arco.Table rowKey="groupId" size="small" pagination={false} data={draft.groups} columns={[
        { title: "群号", dataIndex: "groupId" }, { title: "概率", render: (_value, row) => row.probabilityEnabled ? "启用" : "关闭" },
        { title: "空闲", render: (_value, row) => row.idleEnabled ? "启用" : "关闭" }, { title: "参数", render: (_value, row) => row.useDefaults ? "继承全局" : "群级自定义" },
        { title: "操作", render: (_value, row) => <Arco.Space><Arco.Button size="small" onClick={() => setSelected(row.groupId)}>编辑</Arco.Button><Arco.Button size="small" onClick={() => { setDraft({ ...draft, groups: draft.groups.filter(item => item.groupId !== row.groupId) }); if (selected === row.groupId) { setSelected(undefined); } }}>移除</Arco.Button></Arco.Space> },
      ]}/></TableArea>
      <Arco.Space style={{ marginTop: 12 }}><Arco.InputNumber aria-label="新增群号" placeholder="群号" value={newGroup} min={1} precision={0} onChange={setNewGroup}/><Arco.Button onClick={add}>新增群策略</Arco.Button></Arco.Space>
      {group ? <>
        <div className="synapse-activity-switches"><label>群概率回复 <Arco.Switch checked={group.probabilityEnabled} onChange={value => updateGroup({ probabilityEnabled: value })}/></label><label>群空闲消息 <Arco.Switch checked={group.idleEnabled} onChange={value => updateGroup({ idleEnabled: value })}/></label>
          <label>继承全局参数 <Arco.Switch checked={group.useDefaults} onChange={value => { const { probability, idle, words, blockedWords } = structuredClone(draft); updateGroup(value ? { useDefaults: true } : { useDefaults: false, probability, idle, words, blockedWords }); }}/></label></div>
        {group.useDefaults ? <p>本群使用全局默认参数，关闭继承后可单独编辑。</p> : <Parameters key={group.groupId} value={group} change={updateGroup}/>}
      </> : <>
        <Parameters key="global" value={draft} change={next => setDraft({ ...draft, ...next })}/>
        <Arco.Divider orientation="left">缓存与日志</Arco.Divider><div className="synapse-activity-grid">{[["imageRetentionDays", "图片保留天数"], ["logRetentionDays", "日志保留天数"]].map(([key, label]) => <label key={key} className="synapse-activity-field">{label}<Arco.InputNumber aria-label={label} min={1} precision={0} value={draft[key]} onChange={value => setDraft({ ...draft, [key]: value })}/></label>)}</div>
        <Arco.Divider orientation="left">其他机器人 QQ 号</Arco.Divider><Lines label="其他机器人 QQ 号" placeholder="每行一个 QQ 号；自身机器人自动排除" values={draft.botUsers} change={value => setDraft({ ...draft, botUsers: value.map(Number) })}/>
        <p>AI 忽略名单在“聊天与通知功能 → QQ / Discord 消息行为”中编辑。名单只影响 AI 输入、窗口、词云与真人活跃。</p>
      </>}
    </EditorDialog>}
  </>;
}
