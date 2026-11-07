import * as React from "react";
import { Arco, type ConfigDialogProps } from "@dsh-plugin/dsh-loader/client";
import type { GithubRepository } from "../types.js";
import { newRepository } from "../github-repositories.js";
import { MANAGER_CSS, TableArea } from "./shared.js";

const features = [
  ["reviewPr", "PR 审查"],
  ["triageIssues", "Issue 分诊"],
  ["sendCards", "生成与发送卡片"],
] as const;

export function GithubRepositories({ value, setValue, setReader, saving }: ConfigDialogProps<GithubRepository[]>) {
  React.useEffect(() => setReader(() => {
    const names = value.map(row => row.repository.toLowerCase());
    if (new Set(names).size !== names.length) {
      throw new Error("GitHub 仓库连接不能重复");
    }
    return value;
  }), [value, setReader]);

  type Row = GithubRepository & { index: number };
  const update = (index: number, patch: Partial<GithubRepository>) => {
    setValue(value.map((row, i) => i === index ? { ...row, ...patch } : row));
  };
  return <>
    <style>{MANAGER_CSS}</style>
    <p>每行填写一个 owner/repo，或用 owner/* 配置组织。卡片发送到已订阅该仓库的 QQ 群。</p>
    <div className="synapse-manager-toolbar">
      <Arco.Button disabled={saving} onClick={() => setValue([...value, newRepository()])}>新增仓库</Arco.Button>
    </div>
    <TableArea><Arco.Table rowKey="index" data={value.map((row, index) => ({ ...row, index }))} size="small" pagination={false}
      columns={[
        { title: "仓库", render: (_cell, row: Row) => <Arco.Input value={row.repository} placeholder="owner/repo" disabled={saving}
          aria-label={`仓库 ${row.index + 1}`} onChange={repository => update(row.index, { repository })}/> },
        ...features.map(([key, label]) => ({ title: label, align: "center" as const, render: (_cell, row: Row) =>
          <Arco.Checkbox checked={row[key]} disabled={saving} aria-label={`${row.repository || `仓库 ${row.index + 1}`} ${label}`}
            onChange={checked => update(row.index, { [key]: checked })}/> })),
        { title: "操作", width: 76, render: (_cell, row: Row) => <Arco.Button size="small" disabled={saving}
          onClick={() => setValue(value.filter((_item, index) => index !== row.index))}>删除</Arco.Button> },
      ]}/></TableArea>
  </>;
}
