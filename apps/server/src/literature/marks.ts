import { randomUUID } from "node:crypto";
import {
  marksMarkdown,
  parseMarkOperation,
  parseReadingMark,
  type LiteratureDetail,
  type ReadingMark,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import { activityContext } from "../logging/activity.js";

export class MarkError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
type Detail = (id: string) => Promise<LiteratureDetail>;
/** “Chen 等 · 期刊 · 2025 · doi:…”, the citation line an export starts with. */
function byline(detail: LiteratureDetail): string {
  const m = detail.literature.metadata;
  const authors = m.authors.map((a) => a.display_name);
  const doi = m.identifiers.find((i) => i.namespace === "doi")?.value;
  return [
    authors.length > 3
      ? `${authors.slice(0, 3).join(", ")} 等`
      : authors.join(", ") || null,
    m.venue,
    m.publication_year === null ? null : String(m.publication_year),
    doi ? `doi:${doi}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
/**
 * A person's highlights, region captures and notes (ADR 0046). They are user
 * data about a paper and never change the paper's own facts.
 */
export class MarkService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly detail: Detail,
  ) {}
  async query(value: unknown, signal?: AbortSignal) {
    const command = parseMarkOperation(value);
    if (command.operation !== "list" && command.operation !== "export")
      throw new MarkError("mark-read-operation-invalid");
    const listed = (await this.database.marks(command, signal)) as {
      items: unknown[];
    };
    const items = listed.items.map(parseReadingMark);
    if (command.operation === "list") return { items };
    if (command.request.format === "json")
      return { format: "json", content: JSON.stringify({ items }, null, 2) };
    const detail = await this.detail(command.request.literature_id);
    return {
      format: "markdown",
      content: marksMarkdown(
        {
          title: detail.literature.metadata.title ?? "未命名文献",
          byline: byline(detail),
        },
        items,
      ),
    };
  }
  async manage(value: unknown, signal?: AbortSignal): Promise<ReadingMark> {
    const command = parseMarkOperation(value);
    if (command.operation === "list" || command.operation === "export")
      throw new MarkError("mark-write-operation-invalid");
    return parseReadingMark(
      await this.database.marks(
        {
          ...command,
          actor: activityContext().actor,
          now: new Date().toISOString(),
          ...(command.operation === "create" ? { mark_id: randomUUID() } : {}),
        },
        signal,
      ),
    );
  }
}
