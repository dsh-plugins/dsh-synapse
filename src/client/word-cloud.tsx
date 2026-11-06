import * as React from "react";
import { Arco, type ConfigPanelProps } from "@dsh-plugin/dsh-loader/client";
import type { GroupWordCloud } from "../word-cloud.js";
import { EditorDialog, ErrorNotice, useRequests } from "./shared.js";

const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const CLOUD_CSS = `
.synapse-word-cloud{display:flex;flex-wrap:wrap;align-items:center;align-content:center;justify-content:center;gap:14px 20px;min-height:220px;padding:24px 12px;border-radius:8px;background:var(--color-fill-1)}
.synapse-cloud-word{display:inline-block;max-width:100%;line-height:1.25;text-align:center;overflow-wrap:anywhere;color:var(--color-text-2);text-decoration:underline dotted var(--color-text-4);text-underline-offset:5px;cursor:help}
.synapse-cloud-word.is-hot{color:rgb(var(--primary-6));text-decoration:none}
.synapse-cloud-word.is-blocked{color:var(--color-text-3);text-decoration:line-through}
.synapse-cloud-word:focus-visible{outline:2px solid rgb(var(--primary-6));outline-offset:4px;border-radius:3px}
.synapse-cloud-note{color:var(--color-text-3);font-size:12px;line-height:1.6}
.synapse-cloud-tooltip{max-width:320px;overflow-wrap:anywhere;line-height:1.7}
`;

/** 只读弹窗独立管理请求，关闭时取消读取并沿用共享弹出层布局。 */
export function WordCloudDialog({ groupId, name, view, client, close }: ConfigPanelProps & { groupId: string; name?: string; close(): void }) {
  const request = useRequests();
  const [cloud, setCloud] = React.useState<GroupWordCloud>();
  const refresh = async () => {
    const result = await request.run(signal => client.invoke(view.template.id, "activity.words", { input: { groupId } }, signal));
    if (result) { setCloud(result.value as unknown as GroupWordCloud); }
  };
  React.useEffect(() => { void refresh(); }, [client, view.template.id, groupId]);
  const highest = cloud?.items.reduce((weight, term) => Math.max(weight, term.weight), 0) ?? 0;
  const status = (term: GroupWordCloud["items"][number]) => term.blocked ? "屏蔽词，不参与概率回复"
    : term.eligible ? `参与热词加成，词云加成 +${(term.boost * 100).toFixed(2)}%`
    : term.messages < 3 ? "未达到 3 条消息，不参与热词加成" : "未进入热词前 20，不参与热词加成";
  return <EditorDialog title={`群词云 · ${name ? name + "（" + groupId + "）" : groupId}`} close={close}
    actions={<Arco.Button disabled={request.busy} loading={request.busy} onClick={() => { void refresh(); }}>刷新词云</Arco.Button>}>
    <style>{CLOUD_CSS}</style>
    <ErrorNotice error={request.error}/>
    {cloud ? <>
      <Arco.Space wrap><Arco.Tag color={cloud.enabled ? "green" : "gray"}>{cloud.enabled ? "概率回复已启用" : "概率回复已关闭"}</Arco.Tag>
        <span>{cloud.items.length} 个词，{cloud.items.filter(term => term.eligible).length} 个参与热词加成</span></Arco.Space>
      <p className="synapse-cloud-note">统计最近 {cloud.windowHours} 小时，词频半衰期 {cloud.halfLifeHours} 小时；字号与字重按衰减词频变化。强调色表示参与加成，点状下划线表示仅统计，删除线表示屏蔽词。</p>
      {cloud.items.length ? <div className="synapse-word-cloud" role="list" aria-label="群聊词频" aria-busy={request.busy}>
        {cloud.items.map(term => {
          const scale = highest > 0 ? Math.sqrt(term.weight / highest) : 0;
          return <Arco.Tooltip key={term.word} trigger={["hover", "focus"]} content={<div className="synapse-cloud-tooltip">
            <strong>{term.word}</strong><br/>{term.messages} 条消息 · 衰减词频 {term.weight.toFixed(2)}<br/>
            {status(term)}<br/>规则生效时的触发概率：{percent(term.probabilityBps)}
            {!cloud.enabled && <><br/>当前概率回复已关闭，实际不触发。</>}
          </div>}>
            <span role="listitem" tabIndex={0} className={`synapse-cloud-word${term.eligible ? " is-hot" : ""}${term.blocked ? " is-blocked" : ""}`}
              aria-label={`${term.word}，${status(term)}，规则生效时的触发概率 ${percent(term.probabilityBps)}`}
              style={{ fontSize: 14 + 40 * scale, fontWeight: Math.round(400 + 400 * scale) }}>{term.word}</span>
          </Arco.Tooltip>;
        })}
      </div> : <Arco.Empty description="统计窗口内暂无词频"/>}
      <p className="synapse-cloud-note">基础概率 {percent(cloud.baseProbabilityBps)}。悬浮或聚焦词条可查看概率；实际触发仍受消息过滤、群级冷却、限额和群内回复忙碌状态约束。多个热词命中时只取最大加成。</p>
      <p className="synapse-cloud-note">统计时间：{new Date(cloud.at).toLocaleString("zh-CN", { hour12: false })}</p>
    </> : request.busy ? <p role="status">正在读取词云…</p> : null}
  </EditorDialog>;
}
