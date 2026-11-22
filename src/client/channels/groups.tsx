import * as React from "react";
import { Button, Input, Select, Table, Tag, type TableColumn } from "@dsh-plugin/dsh-ui-components";
import type { SettingsContext } from "../settings-context.js";
import { addGroup, enabledFeatures, featureLabels, listGroups, type GroupEntry as Group } from "./groups-model.js";
import { GroupSettings, lookupName } from "./group-settings.js";
const paginationSize = 10;
const newRow = { id: "new" } as const;
const statusOptions = [
  { value: "all", label: "全部状态" },
  { value: "on", label: "对话开启" },
  { value: "off", label: "对话关闭" },
];
export function GroupsForm(ctx: SettingsContext) {
  const groups = listGroups(ctx.value);
  const path = ctx.route;
  const linkedId = new URLSearchParams(path.split("?")[1]).get("group");
  const [selected, setSelected] = React.useState<string | null>(linkedId);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [newId, setNewId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const request = React.useRef<AbortController | null>(null);
  const errorId = React.useId();
  const returnFocus = React.useRef<HTMLButtonElement | null>(null);
  const addButton = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    setSelected(linkedId);
  }, [linkedId]);
  React.useEffect(() => () => request.current?.abort(), []);
  const needle = query.trim().toLowerCase();
  const filtered = groups.filter(
    (group) =>
      (group.id.includes(needle) ||
        group.name.toLowerCase().includes(needle)) &&
      (filter === "all" || ctx.value.modules.chat.groups.includes(Number(group.id)) === (filter === "on")),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / paginationSize));
  const current = Math.min(page, pages);
  const visible = filtered.slice(
    (current - 1) * paginationSize,
    current * paginationSize,
  );
  const bridged = new Set(ctx.value.modules.discord.bridges.map((route) => route.group));
  const active = groups.find((group) => group.id === selected);
  function restoreFocus() {
    requestAnimationFrame(() => {
      const target = returnFocus.current;
      (target?.isConnected ? target : addButton.current)?.focus({
        preventScroll: true,
      });
    });
  }
  function closeSettings() {
    setSelected(null);
    if (linkedId) ctx.navigate("groups");
    else restoreFocus();
  }
  function cancelRow() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setNewId(null);
    setError("");
    restoreFocus();
  }
  async function saveRow() {
    if (newId === null || request.current) return;
    const id = newId.trim();
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      setError("请输入有效的 QQ 群号。");
      return;
    }
    if (groups.some((g) => g.id === id)) {
      setError("这个群已经添加。");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const name = await lookupName(ctx, id, controller.signal);
      if (controller.signal.aborted) return;
      if (!name) throw new Error("OneBot 没有返回群名，请重试。");
      await ctx.commit(previous => addGroup(previous, {id, name}));
      if (controller.signal.aborted) return;
      setNewId(null);
      setQuery("");
      setFilter("all");
      const index = ctx.value.groupDirectory?.length ?? 0;
      setPage(Math.floor(Math.max(0, index) / paginationSize) + 1);
      restoreFocus();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "读取群名失败，请重试。",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const columns: TableColumn[] = [
    {
      title: "QQ 群号",
      dataIndex: "id",
      width: 138,
      render: (value: string, row: Group) =>
        row.id === newRow.id ? (
          <Input
            mono
            size="sm"
            aria-label="新增 QQ 群号"
            aria-describedby={error ? errorId : undefined}
            autoFocus
            inputMode="numeric"
            value={newId ?? ""}
            readOnly={busy}
            placeholder="输入群号"
            invalid={Boolean(error)}
            onChange={(v: string) => {
              setNewId(v);
              setError("");
            }}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveRow();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelRow();
              }
            }}
          />
        ) : (
          <span className="groups-number">{value}</span>
        ),
    },
    {
      title: "群名称",
      dataIndex: "name",
      width: 150,
      render: (name: string, row: Group) =>
        row.id === newRow.id ? null : (
          <span className="groups-name">{name || "群名待获取"}</span>
        ),
    },
    {
      title: "已启用功能",
      dataIndex: "features",
      render: (_: unknown, row: Group) => {
        if (row.id === newRow.id) return null;
        const labels: string[] = enabledFeatures(ctx.value, row.id).map(key => featureLabels[key]);
        const policy = ctx.value.activity.groups.find(r => String(r.groupId) === row.id);
        if (policy?.probabilityEnabled) labels.push("概率回复");
        if (policy?.idleEnabled) labels.push("空闲发言");
        if (ctx.value.modules.welcome.welcomes.some(r => r.group.includes(Number(row.id)))) labels.push("欢迎语");
        if (ctx.value.modules.github.subscriptions.some(r => r.groups.includes(Number(row.id)))) labels.push("GitHub 订阅");
        if (bridged.has(row.id)) labels.push("Discord 桥接");
        return labels.length ? (
          <div className="groups-tags">
            {labels.map((label) => (
              <Tag key={label} size="sm">
                {label}
              </Tag>
            ))}
          </div>
        ) : (
          <span className="groups-hint">未启用</span>
        );
      },
    },
    {
      title: "操作",
      dataIndex: "actions",
      fixed: "right",
      width: 120,
      render: (_: unknown, row: Group) =>
        row.id === newRow.id ? (
          <div className="groups-row-actions" aria-busy={busy}>
            <Button
              size="sm"
              disabled={busy}
              variant="text"
              onClick={() => void saveRow()}
            >
              保存
            </Button>
            <Button size="sm" variant="text" disabled={ctx.saving} onClick={cancelRow}>
              取消
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="text"
            aria-label={"管理" + (row.name || row.id)}
            onClick={(event) => {
              returnFocus.current = event.currentTarget as HTMLButtonElement;
              setSelected(row.id);
            }}
          >
            管理
          </Button>
        ),
    },
  ];
  return (
    <div className="groups-form">
      <div className="groups-toolbar">
        <Input
          type="search"
          aria-label="搜索群名称或群号"
          placeholder="搜索群名称或群号"
          value={query}
          onChange={(v: string) => {
            setQuery(v);
            setPage(1);
          }}
        />
        <Select
          aria-label="按对话状态筛选"
          value={filter}
          options={statusOptions}
          onChange={(v) => {
            setFilter(String(v));
            setPage(1);
          }}
        />
        <Button
          ref={addButton}
          size="sm"
          variant="outline"
          disabled={ctx.saving || newId !== null}
          onClick={(event) => {
            returnFocus.current = event.currentTarget as HTMLButtonElement;
            setPage(1);
            setNewId("");
            setError("");
          }}
        >
          添加群聊
        </Button>
      </div>
      {error && (
        <p id={errorId} className="groups-error" role="alert">
          {error}
        </p>
      )}
      <Table
        className="groups-table"
        rowKey="id"
        columns={columns}
        data={newId === null ? visible : [newRow, ...visible]}
        scroll={{ x: 615 }}
        pagination={false}
        size="small"
        tableLayoutFixed
        noDataElement={groups.length ? "没有匹配的群聊" : "还没有添加群聊"}
      />
      {pages > 1 && (
        <nav className="groups-pagination" aria-label="群聊列表分页">
          <Button
            size="sm"
            variant="outline"
            disabled={current === 1}
            onClick={() => setPage(current - 1)}
          >
            上一页
          </Button>
          <span aria-live="polite">
            {current} / {pages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={current === pages}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </Button>
        </nav>
      )}
      {active && (
        <GroupSettings
          key={active.id}
          ctx={ctx}
          group={active}
          close={closeSettings}
        />
      )}
    </div>
  );
}
