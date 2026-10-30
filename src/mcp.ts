import type { ConfigSource, AvailableTool } from "./types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
export class McpManager {
  config: ConfigSource;
  connections: Map<string, Promise<Client>>;
  closed: boolean;

  constructor(config: ConfigSource) {
    this.config = config;
    this.connections = new Map();
    this.closed = false;
  }
  async connect(name) {
    if (this.closed) throw new Error("MCP 已关闭");
    const spec = this.config().mcp.find((x) => x.name === name && x.enabled);
    if (!spec) throw new Error("MCP 服务未启用");
    if (!this.connections.has(name))
      this.connections.set(
        name,
        (async () => {
          const client = new Client({ name: "dsh-synapse", version: "0.1.0" });
          const transport =
            spec.transport === "stdio"
              ? new StdioClientTransport({
                  command: spec.command,
                  args: JSON.parse(spec.argsJson),
                  env: {
                    PATH: process.env.PATH ?? "",
                    ...(process.env.SystemRoot
                      ? { SystemRoot: process.env.SystemRoot }
                      : {}),
                    ...JSON.parse(spec.envJson),
                  },
                  stderr: "ignore",
                })
              : spec.transport === "sse"
                ? new SSEClientTransport(new URL(spec.url), {
                    requestInit: { headers: JSON.parse(spec.headersJson) },
                  })
                : new StreamableHTTPClientTransport(new URL(spec.url), {
                    requestInit: { headers: JSON.parse(spec.headersJson) },
                  });
          try {
            await client.connect(transport, { timeout: 15000 });
            if (this.closed) {
              await client.close();
              throw new Error("MCP 已关闭");
            }
            return client;
          } catch (e) {
            await transport.close().catch(() => {});
            this.connections.delete(name);
            throw e;
          }
        })(),
      );
    return this.connections.get(name);
  }
  async list(name) {
    const c = await this.connect(name);
    let cursor;
    const tools = [];
    do {
      const result = await c.listTools(cursor ? { cursor } : undefined, {
        timeout: 15000,
      });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (tools.length > 2000) throw new Error("MCP 工具数量超限");
    } while (cursor);
    return tools;
  }
  async available(): Promise<AvailableTool[]> {
    const result: AvailableTool[] = [];
    for (const spec of this.config().mcp.filter((s) => s.enabled)) {
      const allowed = new Set(spec.allowedTools.split(/\s+/).filter(Boolean));
      if (!allowed.size) continue;
      for (const tool of await this.list(spec.name))
        if (allowed.has(tool.name))
          result.push({
            server: spec.name,
            rawName: tool.name,
            name: `mcp_${result.length}`,
            description: `${spec.name}/${tool.name}: ${tool.description || ""}`,
            parameters: tool.inputSchema,
          });
    }
    return result;
  }
  async call(tool, args) {
    const spec = this.config().mcp.find(
      (s) => s.name === tool.server && s.enabled,
    );
    if (!spec?.allowedTools.split(/\s+/).includes(tool.rawName))
      throw new Error("工具不在允许列表");
    return (await this.connect(tool.server)).callTool(
      { name: tool.rawName, arguments: args },
      undefined,
      { timeout: 60000 },
    );
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(
      [...this.connections.values()].map(async (p) => (await p).close()),
    );
    this.connections.clear();
  }
}
