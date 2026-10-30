import { timingSafeEqual } from "node:crypto";
export function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function json(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export async function body(req, max = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error("请求过大"), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function browserAuthorized(ctx, req, res) {
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  if (
    (site && !["same-origin", "none"].includes(site)) ||
    (origin && new URL(origin).host !== req.headers.host)
  ) {
    json(res, { error: "拒绝跨站请求" }, 403);
    return false;
  }
  const connection = ctx.dshLoader.services.get("connection");
  if (typeof connection?.authorizeIndex !== "function") {
    json(res, { error: "DSH 浏览器认证不可用" }, 503);
    return false;
  }
  return connection.authorizeIndex(req, res);
}
