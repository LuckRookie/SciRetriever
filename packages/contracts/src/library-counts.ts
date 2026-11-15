import {
  ContractValidationError,
  LITERATURE_STATUSES,
  type LiteratureStatus,
} from "./index.js";

export interface FullTextCounts {
  readonly total: number;
  readonly obtained: number;
  readonly missing: number;
  readonly exhausted: number;
}
export function parseFullTextCounts(value: unknown): FullTextCounts {
  const fail = (): never => {
    throw new ContractValidationError();
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== "exhausted,missing,obtained,total")
    fail();
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail();
  const result = {
    total: count(r.total),
    obtained: count(r.obtained),
    missing: count(r.missing),
    exhausted: count(r.exhausted),
  };
  if (
    result.total !== result.obtained + result.missing ||
    result.exhausted > result.missing
  )
    fail();
  return Object.freeze(result);
}

export interface LibraryCounts {
  readonly total: number;
  readonly recently_opened: number;
  readonly statuses: Readonly<Record<LiteratureStatus, number>>;
  readonly unavailable_pdf: number;
}
export function parseLibraryCounts(value: unknown): LibraryCounts {
  const fail = (): never => {
    throw new ContractValidationError();
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !==
      "recently_opened,statuses,total,unavailable_pdf" ||
    !r.statuses ||
    typeof r.statuses !== "object" ||
    Array.isArray(r.statuses)
  )
    fail();
  const states = r.statuses as Record<string, unknown>;
  if (
    Object.keys(states).sort().join() !== [...LITERATURE_STATUSES].sort().join()
  )
    fail();
  const count = (v: unknown): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail();
  const total = count(r.total),
    unavailable = count(r.unavailable_pdf);
  const statuses = Object.fromEntries(
    LITERATURE_STATUSES.map((s) => [s, count(states[s])]),
  ) as Record<LiteratureStatus, number>;
  if (
    Object.values(statuses).reduce((a, b) => a + b, 0) !== total ||
    unavailable > statuses.UNREVIEWED
  )
    fail();
  const recently_opened = count(r.recently_opened);
  if (recently_opened > Math.min(100, total)) fail();
  return Object.freeze({
    recently_opened,
    total,
    statuses: Object.freeze(statuses),
    unavailable_pdf: unavailable,
  });
}
