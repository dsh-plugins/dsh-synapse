const ISSUE_CARD_ACTIONS = ["opened", "reopened", "closed"];
const RELEASE_CARD_ACTIONS = ["created", "published", "released", "prereleased"];

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function cardText(value: unknown, limit: number): string {
  // 上游模板原样插入 HTML，并解析正文中的引用和占位符。
  return text(value, limit).replace(/[&<>"'{}$#/]/g, char => `&#${char.charCodeAt(0)};`);
}

export function githubCard(event: string, payload: any, verified: boolean): object | undefined {
  const release = event === "release";
  const field = event === "issues" ? "issue" : event === "pull_request" ? "pull_request" : release ? "release" : undefined;
  if (!field) { return undefined; }
  const item = payload[field];
  const number = release ? item?.id : item?.number;
  const actions = release ? RELEASE_CARD_ACTIONS : ISSUE_CARD_ACTIONS;
  if (!actions.includes(payload.action) || !Number.isSafeInteger(number) || number <= 0 || (release && item.draft)) {
    return undefined;
  }
  if (verified) { return payload; }

  const repository = payload.repository.full_name;
  const actor = (user: any) => ({ login: cardText(user?.login, 80) || "GitHub" });
  const sender = actor(payload.sender);
  const body = cardText(item.body, 8000).split(/\r\n|[\r\n\u2028\u2029]/, 100).join("<br>");
  const common = { body: body ? `<p>${body}</p>` : "", created_at: text(item.created_at, 64) };
  if (release) {
    const assets = Array.isArray(item.assets) ? item.assets.slice(0, 20).map(asset => ({
      name: text(asset?.name, 240).replace(/[{}$]/g, ""),
      size: Number.isSafeInteger(asset?.size) ? asset.size : 0,
      download_count: Number.isSafeInteger(asset?.download_count) ? asset.download_count : 0,
      browser_download_url: `https://github.com/${repository}/releases`,
    })) : [];
    // 子进程按数值 ID 去重，给未验签卡片使用独立的范围。
    return { action: payload.action, repository: { full_name: repository }, sender, release: {
      ...common, id: -number, name: cardText(item.name, 256), tag_name: cardText(item.tag_name, 256),
      target_commitish: cardText(item.target_commitish, 256), author: actor(item.author),
      published_at: text(item.published_at, 64), draft: false, prerelease: item.prerelease === true, assets,
    } };
  }
  const labels = Array.isArray(item.labels) ? item.labels.slice(0, 30).map(label => ({
    name: cardText(label?.name, 100),
    color: typeof label?.color === "string" && /^[0-9a-f]{6}$/i.test(label.color) ? label.color : "888888",
  })) : [];
  return { action: payload.action, repository: { full_name: repository }, sender, [field]: {
    ...common, number, title: cardText(item.title, 256), user: actor(item.user), labels,
    repository_url: `https://api.github.com/repos/${repository}`,
    state: payload.action === "closed" ? "closed" : "open",
    state_reason: ["completed", "not_planned", "duplicate"].includes(item.state_reason) ? item.state_reason : undefined,
    merged: item.merged === true, draft: item.draft === true,
  } };
}
