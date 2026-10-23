/** Presentation only. Never infer independent account authentication from a label. */
export function actorLabel(actor: unknown): string {
  if (typeof actor !== "string" || !actor || actor.startsWith("historical:"))
    return "历史记录";
  if (actor.startsWith("web-session:")) {
    const date = actor
      .slice("web-session:".length)
      .match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u)?.[0];
    if (!date) return "网页登录 · 历史会话";
    return `网页登录 · ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(date))}`;
  }
  const name = (prefix: string) =>
    actor
      .slice(prefix.length)
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .slice(0, 80);
  if (actor.startsWith("cli:")) return `命令行 · ${name("cli:")}`;
  if (actor.startsWith("mcp:")) return `MCP · ${name("mcp:")}`;
  if (actor === "manual") return "人工修改";
  if (actor === "backfill") return "批量回填";
  if (actor === "auto" || actor.startsWith("system:")) return "系统自动";
  return "人工操作";
}

/** Decorate service view records only; arbitrary scientific payloads stay untouched. */
export function presentActors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentActors);
  if (!value || typeof value !== "object" || value instanceof Uint8Array)
    return value;
  const r = value as Record<string, unknown>,
    out: Record<string, unknown> = { ...r };
  if (
    Object.hasOwn(r, "actor") &&
    (r.actor === null || typeof r.actor === "string")
  )
    out.actor_label = actorLabel(r.actor);
  // These are view containers, not serialized artifacts, tool messages or model payloads.
  for (const key of [
    "items",
    "session",
    "job",
    "origin",
    "last_manual_edit",
    "manual_edits",
    "manual_decisions",
    "decisions",
    "locks",
    "changes",
    "history",
    "assignment",
    "fields",
    "sources",
    "conflicts",
    "result",
  ])
    if (Object.hasOwn(r, key)) out[key] = presentActors(r[key]);
  return out;
}
