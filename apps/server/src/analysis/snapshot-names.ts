import type { SnapshotDefinition } from "@sciretriever/contracts";

/** A presentation label; never an input to content or method hashes. */
export function generatedSnapshotName(
  definition: SnapshotDefinition,
  count: number,
  tagNames: readonly string[] = [],
  folderName: string | null = null,
): string {
  if (definition.kind === "literatures") return `手选 ${count} 篇`;
  const q = definition.query,
    parts: string[] = [];
  if (q.folder)
    parts.push(folderName ? `文件夹 ${folderName}` : "文件夹（已删除）");
  if (q.recently_opened) parts.push("最近阅读");
  if (q.text) parts.push(`检索 ${q.text}`);
  if (q.title) parts.push(`标题 ${q.title}`);
  if (q.author) parts.push(`作者 ${q.author}`);
  if (q.tags?.ids.length)
    parts.push(tagNames.length ? `标签 ${tagNames.join("、")}` : "标签筛选");
  if (q.publication_year_from && q.publication_year_to)
    parts.push(`${q.publication_year_from}–${q.publication_year_to} 年`);
  else if (q.publication_year_from)
    parts.push(`${q.publication_year_from} 年起`);
  else if (q.publication_year_to) parts.push(`${q.publication_year_to} 年止`);
  if (q.venue) parts.push(q.venue);
  if (!parts.length) {
    const filtered = Object.values(q).some((value) =>
      Array.isArray(value)
        ? value.length > 0
        : value !== null &&
          value !== undefined &&
          value !== false &&
          value !== "",
    );
    parts.push(filtered ? "筛选文献" : "全部文献");
  }
  return [
    ...parts
      .map((p) => p.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim())
      .map((p) => (p.length > 70 ? p.slice(0, 69) + "…" : p))
      .slice(0, 3),
    `${count} 篇`,
  ].join(" · ");
}
