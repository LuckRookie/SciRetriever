import {
  ContractValidationError,
  parseLiteratureId,
  parseUtcTimestamp,
  type LiteratureId,
} from "./index.js";
import {
  parseLiteratureBibliographySummary,
  type LiteratureBibliographySummary,
} from "./literature-summary.js";
import { tagInteger, tagRecord } from "./tags.js";

/** One request moves at most this many papers into or out of recently deleted. */
export const LIBRARY_TRASH_MAX_IDS = 1000;
export const LIBRARY_TRASH_PAGE_LIMIT = 100;

export type LibraryTrashOperation = "delete" | "restore";
export interface LibraryTrashRequest {
  readonly operation: LibraryTrashOperation;
  readonly selector: {
    readonly kind: "literatures";
    readonly literature_ids: readonly LiteratureId[];
  };
}
export interface LibraryTrashResult {
  readonly operation: LibraryTrashOperation;
  /** Papers named in the request. */
  readonly target_count: number;
  /** Papers whose state this request actually changed. */
  readonly changed: number;
}
export type LibraryTrashQuery =
  | {
      readonly operation: "list";
      readonly request: {
        readonly limit: number;
        readonly cursor: string | null;
      };
    }
  | { readonly operation: "count"; readonly request: Record<string, never> };
export interface LibraryTrashItem {
  readonly literature: LiteratureBibliographySummary;
  readonly deleted_at: string;
  readonly deleted_by: string;
}
export interface LibraryTrashPage {
  readonly items: readonly LibraryTrashItem[];
  readonly next_cursor: string | null;
}
export interface LibraryTrashCount {
  readonly total_count: number;
}

function fail(): never {
  throw new ContractValidationError();
}
function operation(value: unknown): LibraryTrashOperation {
  if (value !== "delete" && value !== "restore") fail();
  return value;
}
function actor(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) fail();
  return value;
}

export function parseLibraryTrashRequest(value: unknown): LibraryTrashRequest {
  const r = tagRecord(value, ["operation", "selector"]);
  const selector = tagRecord(r.selector, ["kind", "literature_ids"]);
  if (selector.kind !== "literatures") fail();
  const ids = selector.literature_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > LIBRARY_TRASH_MAX_IDS)
    fail();
  const literature_ids = ids.map(parseLiteratureId);
  if (new Set(literature_ids).size !== literature_ids.length) fail();
  return Object.freeze({
    operation: operation(r.operation),
    selector: Object.freeze({
      kind: "literatures" as const,
      literature_ids: Object.freeze(literature_ids),
    }),
  });
}

export function parseLibraryTrashResult(value: unknown): LibraryTrashResult {
  const r = tagRecord(value, ["operation", "target_count", "changed"]);
  const target_count = tagInteger(r.target_count, 1),
    changed = tagInteger(r.changed);
  if (target_count > LIBRARY_TRASH_MAX_IDS || changed > target_count) fail();
  return Object.freeze({
    operation: operation(r.operation),
    target_count,
    changed,
  });
}

export function parseLibraryTrashQuery(value: unknown): LibraryTrashQuery {
  const r = tagRecord(value, ["operation", "request"]);
  if (r.operation === "count")
    return Object.freeze({
      operation: "count" as const,
      request: tagRecord(r.request, []) as Record<string, never>,
    });
  if (r.operation !== "list") fail();
  const request = tagRecord(r.request, ["limit", "cursor"]);
  const limit = tagInteger(request.limit, 1);
  if (limit > LIBRARY_TRASH_PAGE_LIMIT) fail();
  if (
    request.cursor !== null &&
    (typeof request.cursor !== "string" ||
      !/^[A-Za-z0-9_-]{1,1024}$/u.test(request.cursor))
  )
    fail();
  return Object.freeze({
    operation: "list" as const,
    request: Object.freeze({
      limit,
      cursor: request.cursor as string | null,
    }),
  });
}

export function parseLibraryTrashItem(value: unknown): LibraryTrashItem {
  const r = tagRecord(value, ["literature", "deleted_at", "deleted_by"]);
  return Object.freeze({
    literature: parseLiteratureBibliographySummary(r.literature),
    deleted_at: parseUtcTimestamp(r.deleted_at),
    deleted_by: actor(r.deleted_by),
  });
}

export function parseLibraryTrashPage(value: unknown): LibraryTrashPage {
  const r = tagRecord(value, ["items", "next_cursor"]);
  if (!Array.isArray(r.items) || r.items.length > LIBRARY_TRASH_PAGE_LIMIT)
    fail();
  if (
    r.next_cursor !== null &&
    (typeof r.next_cursor !== "string" || !r.next_cursor.length)
  )
    fail();
  return Object.freeze({
    items: Object.freeze(r.items.map(parseLibraryTrashItem)),
    next_cursor: r.next_cursor as string | null,
  });
}

export function parseLibraryTrashCount(value: unknown): LibraryTrashCount {
  const r = tagRecord(value, ["total_count"]);
  return Object.freeze({ total_count: tagInteger(r.total_count) });
}
