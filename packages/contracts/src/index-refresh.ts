import { ContractValidationError } from "./index.js";
import {
  parseRetrievalGenerationReceipt,
  type RetrievalGenerationReceipt,
} from "./retrieval-context.js";
export interface IndexVerificationResult extends RetrievalGenerationReceipt {
  readonly schema_version: 1;
  readonly status: "verified";
  readonly elapsed_ms: number;
}
export function parseIndexVerificationResult(
  value: unknown,
): IndexVerificationResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !==
      [
        "schema_version",
        "status",
        "elapsed_ms",
        "generation_id",
        "source_revision",
        "entry_count",
        "source_count",
      ]
        .sort()
        .join() ||
    r.schema_version !== 1 ||
    r.status !== "verified" ||
    !Number.isSafeInteger(r.elapsed_ms) ||
    Number(r.elapsed_ms) < 0
  )
    throw new ContractValidationError();
  const { schema_version, status, elapsed_ms, ...generation } = r;
  void schema_version;
  void status;
  return {
    schema_version: 1,
    status: "verified",
    elapsed_ms: Number(elapsed_ms),
    ...parseRetrievalGenerationReceipt(generation),
  };
}

/** Projection work is separate from an accepted document publication. */
export interface IndexRefreshStatus {
  readonly schema_version: 1;
  readonly status: "idle" | "scheduled" | "running" | "updated" | "failed";
  readonly request_sequence: number;
  readonly requested_revision: number | null;
  readonly indexed_revision: number | null;
  readonly requested_at: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly technical_details: { readonly code: string | null };
  readonly pending_literatures?: number | null;
  readonly last_refresh_ms?: number | null;
  readonly index_state?: "ready" | "missing" | "corrupt";
  readonly operation?: "refresh" | "rebuild" | null;
  readonly progress?: { readonly done: number; readonly total: number } | null;
}
export function parseIndexRefreshStatus(value: unknown): IndexRefreshStatus {
  const fail = (): never => {
    throw new ContractValidationError();
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !==
      [
        "schema_version",
        "status",
        "request_sequence",
        "requested_revision",
        "indexed_revision",
        "requested_at",
        "started_at",
        "finished_at",
        "technical_details",
        ...(Object.hasOwn(r, "pending_literatures")
          ? ["pending_literatures"]
          : []),
        ...(Object.hasOwn(r, "last_refresh_ms") ? ["last_refresh_ms"] : []),
        ...["index_state", "operation", "progress"].filter((key) =>
          Object.hasOwn(r, key),
        ),
      ]
        .sort()
        .join() ||
    r.schema_version !== 1 ||
    !["idle", "scheduled", "running", "updated", "failed"].includes(
      String(r.status),
    )
  )
    fail();
  if (
    !Number.isSafeInteger(r.request_sequence) ||
    Number(r.request_sequence) < 0
  )
    fail();
  for (const key of ["requested_revision", "indexed_revision"])
    if (
      r[key] !== null &&
      (!Number.isSafeInteger(r[key]) || Number(r[key]) < 0)
    )
      fail();
  for (const key of ["pending_literatures", "last_refresh_ms"])
    if (
      Object.hasOwn(r, key) &&
      r[key] !== null &&
      (!Number.isSafeInteger(r[key]) || Number(r[key]) < 0)
    )
      fail();
  for (const key of ["requested_at", "started_at", "finished_at"])
    if (
      r[key] !== null &&
      (typeof r[key] !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(String(r[key])) ||
        !Number.isFinite(Date.parse(String(r[key]))))
    )
      fail();
  const details = r.technical_details;
  if (
    Object.hasOwn(r, "index_state") &&
    !["ready", "missing", "corrupt"].includes(String(r.index_state))
  )
    fail();
  if (
    Object.hasOwn(r, "operation") &&
    r.operation !== null &&
    !["refresh", "rebuild"].includes(String(r.operation))
  )
    fail();
  if (Object.hasOwn(r, "progress") && r.progress !== null) {
    const p = r.progress;
    if (
      r.operation !== "rebuild" ||
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).sort().join() !== "done,total" ||
      !("done" in p) ||
      !("total" in p) ||
      !Number.isSafeInteger(p.done) ||
      !Number.isSafeInteger(p.total) ||
      Number(p.done) < 0 ||
      Number(p.total) < Number(p.done)
    )
      fail();
  }
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    Object.keys(details).join() !== "code" ||
    !("code" in details) ||
    (details.code !== null &&
      (typeof details.code !== "string" ||
        !/^[a-z][a-z0-9-]{0,80}$/u.test(details.code)))
  )
    fail();
  return {
    ...r,
    technical_details: { code: (details as { code: string | null }).code },
  } as unknown as IndexRefreshStatus;
}
export const idleIndexRefreshStatus = (): IndexRefreshStatus => ({
  schema_version: 1,
  status: "idle",
  request_sequence: 0,
  requested_revision: null,
  indexed_revision: null,
  requested_at: null,
  started_at: null,
  finished_at: null,
  technical_details: { code: null },
});

export interface IndexRefreshRequest {
  readonly kind: "refresh";
}
export interface IndexRebuildRequest {
  readonly kind: "rebuild";
  readonly background?: boolean;
}
export function parseIndexRefreshRequest(value: unknown): IndexRefreshRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "kind" ||
    !("kind" in value) ||
    value.kind !== "refresh"
  )
    throw new ContractValidationError();
  return { kind: "refresh" };
}
export function parseIndexRebuildRequest(value: unknown): IndexRebuildRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !==
      ["kind", ...(Object.hasOwn(r, "background") ? ["background"] : [])]
        .sort()
        .join() ||
    r.kind !== "rebuild" ||
    (Object.hasOwn(r, "background") && typeof r.background !== "boolean")
  )
    throw new ContractValidationError();
  return {
    kind: "rebuild",
    ...(Object.hasOwn(r, "background")
      ? { background: r.background as boolean }
      : {}),
  };
}
