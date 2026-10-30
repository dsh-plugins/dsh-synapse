const $ = (id) => document.getElementById(id);
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  attrs: Record<string, unknown> = {},
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  Object.assign(n, attrs);
  return n;
}
function notify(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = error ? "error" : "";
}
async function request(path, data?) {
  const r = await fetch(path, {
    cache: "no-store",
    ...(data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  const result = await r.json();
  if (!r.ok || result.ok === false)
    throw new Error(result.error || result.message || `HTTP ${r.status}`);
  return result;
}
const api = (action, data?) => request("/api/dsh-synapse/" + action, data);
function button(label, action) {
  const b = node("button", label);
  b.onclick = async () => {
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      notify(e.message, true);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
function labeled(parent, label, input) {
  const id = "field-" + ++sequence;
  input.id = id;
  const l = node("label", label, { htmlFor: id });
  parent.append(l, input);
  return input;
}
let sequence = 0,
  dirty = false,
  view,
  draft,
  active = "配置";
const tabs = ["配置", "Skill", "MCP", "Hermes 记忆", "GitHub 审查"];
for (const label of tabs) {
  const b = button(label, async () => {
    if (dirty && !confirm("当前修改尚未保存，放弃修改并切换？")) return;
    dirty = false;
    active = label;
    await render();
  });
  b.setAttribute("role", "tab");
  $("tabs").append(b);
}
async function loadConfig() {
  view = (await request("/api/dshloader/config/dsh-synapse")).value;
  draft = structuredClone(view.value);
}
async function saveConfig() {
  const saved = await request("/api/dshloader/config/dsh-synapse", {
    value: draft,
    expectedRevision: view.revision,
  });
  view = saved.value;
  draft = structuredClone(view.value);
  dirty = false;
  notify("已保存。通道正在重新连接；可刷新状态检查结果。");
}
function field(parent, f, obj, key = f.key) {
  if (f.type === "group" || f.type === "object") {
    const box = node("fieldset");
    box.append(node("legend", f.label));
    parent.append(box);
    const target = f.type === "object" ? (obj[key] ??= {}) : obj;
    for (const child of f.fields) field(box, child, target);
    return;
  }
  if (f.type === "array") {
    const box = node("fieldset");
    box.append(node("legend", f.label));
    parent.append(box);
    const list = node("div");
    box.append(list);
    const redraw = () => {
      list.replaceChildren();
      (obj[key] ||= []).forEach((_, i) => {
        const row = node("div", undefined, { className: "row" });
        field(row, { ...f.item, label: `第 ${i + 1} 项` }, obj[key], i);
        row.append(
          button("删除", () => {
            obj[key].splice(i, 1);
            dirty = true;
            redraw();
          }),
        );
        list.append(row);
      });
    };
    redraw();
    box.append(
      button("添加", () => {
        obj[key].push(defaultOf(f.item));
        dirty = true;
        redraw();
      }),
    );
    return;
  }
  let control;
  if (f.type === "boolean") {
    control = node("input", undefined, {
      type: "checkbox",
      checked: obj[key] === true,
    });
    control.onchange = () => {
      obj[key] = control.checked;
      dirty = true;
    };
  } else if (f.type === "select") {
    control = node("select");
    for (const opt of f.options)
      control.append(node("option", opt.label, { value: opt.value }));
    control.value = obj[key];
    control.onchange = () => {
      obj[key] = control.value;
      dirty = true;
    };
  } else {
    const isJSON = String(key).toLowerCase().includes("json");
    control = node(f.type === "textarea" || isJSON ? "textarea" : "input");
    if (control.tagName === "INPUT")
      control.type =
        f.type === "password"
          ? "password"
          : f.type === "number"
            ? "number"
            : "text";
    const secret = obj[key] && typeof obj[key] === "object";
    control.value = secret ? "" : (obj[key] ?? "");
    if (secret)
      control.placeholder = "已保存（不回显）。留空保持不变；输入替换。";
    control.oninput = () => {
      obj[key] = f.type === "number" ? Number(control.value) : control.value;
      dirty = true;
    };
    if (f.min !== undefined) control.min = f.min;
    if (f.max !== undefined) control.max = f.max;
  }
  labeled(parent, f.label, control);
  if (f.description)
    parent.append(node("div", f.description, { className: "muted" }));
  if (f.type === "password")
    parent.append(
      button("清空此值", () => {
        obj[key] = "";
        control.value = "";
        control.placeholder = "已清空，保存后生效";
        dirty = true;
      }),
    );
}
function defaultOf(f) {
  if (f.default !== undefined) return structuredClone(f.default);
  if (f.type === "object")
    return Object.fromEntries(f.fields.map((x) => [x.key, defaultOf(x)]));
  if (f.type === "array") return [];
  if (f.type === "boolean") return false;
  if (f.type === "select") return f.options[0].value;
  if (f.type === "number") return f.min || 0;
  return "";
}
async function configPanel(root, onlyMcp = false) {
  await loadConfig();
  root.append(
    node(
      "p",
      onlyMcp
        ? "添加或修改 MCP 服务，保存后可预览工具。仅允许列表中的工具可被聊天自动调用。"
        : "所有通道和上游功能均保存在当前 profile；保存使用修订号检查并发修改。",
    ),
  );
  for (const f of view.template.fields)
    if (onlyMcp ? f.key === "mcp" : f.key !== "mcp") field(root, f, draft);
  root.append(button("保存配置", saveConfig));
  if (!onlyMcp) {
    root.append(
      button("载入上游功能 JSON 以预览 / 修改", async () => {
        const rows = await api("features");
        for (const row of rows) {
          const f = draft.features.find((f) => f.id === row.id);
          if (f) f.json = JSON.stringify(row.value, null, 2);
        }
        dirty = true;
        root.replaceChildren();
        root.append(
          node("p", "已载入当前功能配置，可能包含密钥。修改后保存。"),
        );
        for (const f of view.template.fields)
          if (f.key !== "mcp") field(root, f, draft);
        root.append(button("保存配置", saveConfig));
      }),
    );
  } else {
    const box = node("section");
    root.append(box);
    for (const s of draft.mcp) {
      box.append(
        button(`预览 ${s.name} 工具`, async () => {
          preview.textContent = JSON.stringify(
            await api("mcp/tools", { name: s.name }),
            null,
            2,
          );
        }),
      );
    }
    const preview = node("pre", "工具列表显示在这里");
    box.append(preview);
  }
}
async function skillPanel(root) {
  const layout = node("div", undefined, { className: "two" }),
    list = node("div"),
    editor = node("div");
  layout.append(list, editor);
  root.append(layout);
  const name = labeled(editor, "Skill 名称", node("input")),
    text = labeled(editor, "Markdown 文档", node("textarea"));
  text.style.minHeight = "400px";
  let revision = null,
    inherited = false;
  name.oninput = text.oninput = () => {
    dirty = true;
  };
  const file = labeled(
    editor,
    "导入 SKILL.md",
    node("input", undefined, {
      type: "file",
      accept: ".md,text/markdown,text/plain",
    }),
  );
  file.onchange = async () => {
    const f = file.files?.[0];
    if (f) {
      text.value = await f.text();
      dirty = true;
    }
  };
  const preview = node("pre", "选择 Skill 预览或创建新 Skill。");
  editor.append(preview);
  const refresh = async () => {
    list.replaceChildren();
    for (const s of await api("skills"))
      list.append(
        button(s.name + (s.inherited ? " · Home" : ""), () => {
          name.value = s.name;
          text.value = s.content;
          revision = s.revision;
          inherited = s.inherited;
          preview.textContent = s.content;
          dirty = false;
        }),
      );
  };
  editor.append(
    button("预览文档", () => {
      preview.textContent = text.value;
    }),
    button("新建", () => {
      name.value = "";
      text.value = "";
      revision = null;
      inherited = false;
      dirty = false;
    }),
    button("保存 Skill", async () => {
      const saved = await api("skills/save", {
        name: name.value,
        content: text.value,
        revision,
      });
      revision = saved.revision;
      dirty = false;
      notify("Skill 已保存，可被运行中的聊天检索。");
      await refresh();
    }),
    button("删除 Skill", async () => {
      if (inherited) throw new Error("Home Skill 为继承项，请在 Home 中管理");
      if (!confirm(`删除 ${name.value}？`)) return;
      await api("skills/delete", { name: name.value, revision });
      name.value = "";
      text.value = "";
      revision = null;
      dirty = false;
      await refresh();
      notify("Skill 已删除");
    }),
  );
  await refresh();
}
async function memoryPanel(root) {
  const channel = labeled(root, "记忆分类", node("select"));
  channel.append(
    node("option", "聊天（QQ / Discord 共享）", { value: "chat" }),
    node("option", "GitHub 审查", { value: "review" }),
  );
  const markdown = labeled(root, "粘贴 Hermes 记忆 Markdown", node("textarea"));
  markdown.oninput = () => {
    dirty = true;
  };
  const preview = node("pre", "导入前可预览分块。");
  root.append(
    button("预览分块", async () => {
      preview.textContent = JSON.stringify(
        await api("memory/import", {
          markdown: markdown.value,
          channel: channel.value,
          preview: true,
        }),
        null,
        2,
      );
    }),
    button("批量导入", async () => {
      notify("正在生成本地嵌入；首次下载模型可能需要几分钟…");
      preview.textContent = JSON.stringify(
        await api("memory/import", {
          markdown: markdown.value,
          channel: channel.value,
        }),
        null,
        2,
      );
      dirty = false;
      notify("记忆导入完成");
    }),
  );
  const query = labeled(root, "检索记忆", node("input"));
  root.append(
    button("混合检索", async () => {
      preview.textContent = JSON.stringify(
        await api("memory/search", {
          query: query.value,
          channel: channel.value,
        }),
        null,
        2,
      );
    }),
    button("最近记忆", async () => {
      preview.textContent = JSON.stringify(
        await api(`memory?channel=${channel.value}`),
        null,
        2,
      );
    }),
    preview,
  );
}
async function reviewPanel(root) {
  root.append(
    node("p", "Webhook：" + location.origin + "/hooks/dsh-synapse/github"),
    node(
      "p",
      "配置 GitHub Secret 和仓库允许列表后启用；未开启自动发布时，结果仅保存在此处。",
    ),
  );
  const list = node("div");
  root.append(button("刷新任务", refresh), list);
  async function refresh() {
    list.replaceChildren();
    for (const job of await api("reviews")) {
      const a = node("article");
      a.append(
        node("strong", `${job.event} · ${job.state} · ${job.id}`),
        node("pre", job.error || job.result || "等待处理"),
      );
      if (job.state === "failed")
        a.append(
          button("重试", async () => {
            await api("reviews/retry", { id: job.id });
            await refresh();
          }),
        );
      list.append(a);
    }
  }
  await refresh();
}
async function render() {
  for (const b of $("tabs").children)
    b.setAttribute("aria-selected", String(b.textContent === active));
  const root = $("content");
  root.replaceChildren();
  notify("");
  try {
    if (active === "配置") await configPanel(root);
    if (active === "MCP") await configPanel(root, true);
    if (active === "Skill") await skillPanel(root);
    if (active === "Hermes 记忆") await memoryPanel(root);
    if (active === "GitHub 审查") await reviewPanel(root);
  } catch (e) {
    notify(e.message, true);
  }
}
async function status() {
  try {
    const s = await api("status");
    $("status").textContent = s.lastError
      ? "需要处理：" + s.lastError
      : "机器人：" + s.bot;
  } catch (e) {
    $("status").textContent = e.message;
  }
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
await render();
await status();
setInterval(status, 10000);
