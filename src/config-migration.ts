import { readFile } from "node:fs/promises";
import { validateValues } from "@dsh-plugin/dsh-loader/config";
import { template, validateConfig } from "./config.js";
import {
  text,
  flag,
  array,
  object,
  featureFiles,
  modulesFromFiles,
} from "./feature-config.js";
import { pathsFor, safePath, atomicWrite } from "./files.js";
import type { SynapseConfig, SynapseContext } from "./types.js";

// Register the legacy fields only while reading the old snapshot. They never
// remain in the active template or the newly persisted configuration.
const migrationTemplate = {
  ...template,
  fields: [
    ...template.fields,
    ...[
      text("botJson", "旧机器人配置", "{}", "password"),
      ...["llmUrl", "llmKey", "model", "hermesUrl", "hermesKey"].map((k) =>
        text(k, k, "", "password"),
      ),
      flag("externalHermes", "旧代理开关"),
      array(
        "features",
        "旧功能配置",
        object("item", "功能", [
          text("id", "ID"),
          text("json", "旧配置", "{}", "password"),
        ]),
      ),
      array(
        "mcp",
        "旧 MCP",
        object("item", "服务", [
          text("name", "名称"),
          flag("enabled", "启用", true),
          text("transport", "传输", "stdio"),
          text("command", "命令"),
          text("url", "URL"),
          text("argsJson", "参数", "[]"),
          text("envJson", "环境", "{}", "password"),
          text("headersJson", "请求头", "{}", "password"),
          text("allowedTools", "工具"),
        ]),
      ),
    ].map((f) => ({ ...f, visibleWhen: { path: ["enabled"], equals: null } })),
  ],
};

export function migrateConfig(old: any): SynapseConfig {
  const c = structuredClone(old);
  const base = JSON.parse(old.botJson || "{}");
  for (const key of ["userAgent", "logLevel", "tokenParams"])
    if (base[key] !== undefined) c[key] = base[key];
  c.modules = modulesFromFiles(
    c.modules,
    (old.features ?? []).map((f) => ({ id: f.id, value: JSON.parse(f.json) })),
  );
  c.mcpServers = (old.mcp ?? []).map((s) => ({
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    command: s.command,
    url: s.url,
    args: JSON.parse(s.argsJson),
    env: Object.entries(JSON.parse(s.envJson)).map(([name, value]) => ({
      name,
      value,
    })),
    headers: Object.entries(JSON.parse(s.headersJson)).map(([name, value]) => ({
      name,
      value,
    })),
    allowedTools: s.allowedTools.split(/\s+/).filter(Boolean),
  }));
  return validateConfig(
    validateValues(template.fields, c) as unknown as SynapseConfig,
  );
}

export async function registerConfig(ctx: SynapseContext) {
  const reader = await ctx.dshLoader.config.register<any>(
    ctx,
    migrationTemplate,
  );
  let snapshot;
  try {
    snapshot = reader.get();
  } finally {
    reader.dispose();
  }
  const old = snapshot.value;
  const legacy =
    old.features?.length > 0 ||
    old.mcp?.length > 0 ||
    (old.botJson && old.botJson !== "{}") ||
    old.llmUrl ||
    old.externalHermes;
  let migrated: SynapseConfig;
  if (legacy) {
    migrated = migrateConfig(old);
    const paths = pathsFor(ctx, migrated);
    const live = [];
    for (const f of featureFiles(migrated)) {
      const file = await safePath(
        paths.profile,
        "data",
        "dsh-synapse",
        "bot",
        "configs",
        ...(f.id === "peak-valley-timer" ? [] : ["features"]),
        `${f.id}.json`,
      );
      try {
        live.push({
          id: f.id,
          value: JSON.parse(await readFile(file, "utf8")),
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    migrated.modules = modulesFromFiles(migrated.modules, live);
    migrated = validateConfig(
      validateValues(
        template.fields,
        migrated as any,
      ) as unknown as SynapseConfig,
    );
    const backup = await safePath(
      paths.profile,
      "data",
      "dsh-synapse",
      "config-before-forms.json",
    );
    await atomicWrite(backup, JSON.stringify(snapshot, null, 2));
  }
  const handle = await ctx.dshLoader.config.register<SynapseConfig>(
    ctx,
    template,
  );
  if (migrated) await handle.update(migrated, snapshot.revision);
  return handle;
}
