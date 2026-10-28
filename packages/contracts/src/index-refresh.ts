import { ContractValidationError } from "./index.js";

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
