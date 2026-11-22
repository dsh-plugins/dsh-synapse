import { callOneBot } from "./onebot-tools.js";
import type { ConnectionConfig } from "./types.js";

export async function lookupGroup(connection: ConnectionConfig, id: string, signal: AbortSignal) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("请输入有效的 QQ 群号。");
  const result = await callOneBot(connection, "get_group_info", { group_id: Number(id), no_cache: true }, signal);
  const response = result.receipt as { status?: string; retcode?: number; data?: { group_id?: string | number; group_name?: string } } | null;
  if (result.httpStatus < 200 || result.httpStatus >= 300) throw new Error(`OneBot 返回 HTTP ${result.httpStatus}，请检查连接和令牌。`);
  if (response?.status !== "ok" || response.retcode !== 0) throw new Error("未能查询此群，请确认群号正确且机器人已加入该群。");
  if (String(response.data?.group_id) !== id || typeof response.data.group_name !== "string" || !response.data.group_name.trim()) throw new Error("OneBot 未返回该群的名称。");
  return { id, name: response.data.group_name.trim() };
}
