import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name: "synapse-test", version: "1.0.0" });
server.registerTool(
  "read",
  { description: "Test read", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "fixture result" }] }),
);
server.registerTool(
  "blocked",
  { description: "Must not run", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "blocked" }] }),
);
await server.connect(new StdioServerTransport());
