import { ContractValidationError, parseUtcTimestamp } from "./index.js";

export const ACQUISITION_STAGES = [
  "direct",
  "publisher-api",
  "general-api",
  "public-web",
  "browser",
] as const;
export type AcquisitionRouteStage = (typeof ACQUISITION_STAGES)[number];
export interface AcquisitionRoute {
  readonly source: string;
  readonly stage: AcquisitionRouteStage;
  readonly mode_reason:
    | "auto-default"
    | "auto-configured"
    | "custom"
    | "builtin";
  readonly ready: boolean;
  readonly unavailable_code?: string;
}
export interface AcquisitionRouteState {
  /** Null for a configuration-only process with no assembled acquisition runtime. */
  readonly effective: readonly AcquisitionRoute[] | null;
  /** Selection and local configuration readiness; never an entitlement probe. */
  readonly pending: readonly AcquisitionRoute[];
  readonly changed: boolean | null;
  readonly restart_required: boolean | null;
}
export const ACQUISITION_ATTEMPT_RESULTS = [
  "hit",
  "miss",
  "not-applicable",
  "not-enabled",
  "unavailable",
  "failed",
  "cooldown",
  "rejected",
  "escalated",
] as const;
export interface AcquisitionAttempt {
  readonly stage: AcquisitionRouteStage;
  readonly source: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly requested: boolean;
  readonly result: (typeof ACQUISITION_ATTEMPT_RESULTS)[number];
  readonly code?: string;
  readonly candidates?: number;
}
export const MAX_ACQUISITION_ATTEMPTS = 64;
export const MAX_PRIOR_ACQUISITION_ATTEMPTS = 16;
function fail(): never {
  throw new ContractValidationError();
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) fail();
  return row;
}
function token(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,95}$/u.test(value)
    ? value
    : fail();
}
function stage(value: unknown): AcquisitionRouteStage {
  return ACQUISITION_STAGES.includes(value as AcquisitionRouteStage)
    ? (value as AcquisitionRouteStage)
    : fail();
}
export function parseAcquisitionAttempt(value: unknown): AcquisitionAttempt {
  const r = record(value, [
    "stage",
    "source",
    "started_at",
    "finished_at",
    "requested",
    "result",
    "code",
    "candidates",
  ]);
  const started = parseUtcTimestamp(r.started_at),
    finished = parseUtcTimestamp(r.finished_at);
  if (
    Date.parse(finished) < Date.parse(started) ||
    typeof r.requested !== "boolean" ||
    !ACQUISITION_ATTEMPT_RESULTS.includes(
      r.result as AcquisitionAttempt["result"],
    ) ||
    (r.result === "escalated" &&
      (r.stage !== "browser" || r.source !== "browser" || r.requested)) ||
    (["not-enabled", "cooldown"].includes(String(r.result)) && r.requested) ||
    (r.candidates !== undefined &&
      (!Number.isSafeInteger(r.candidates) ||
        Number(r.candidates) < 0 ||
        Number(r.candidates) > 1000))
  )
    fail();
  return Object.freeze({
    stage: stage(r.stage),
    source: token(r.source),
    started_at: started,
    finished_at: finished,
    requested: r.requested,
    result: r.result as AcquisitionAttempt["result"],
    ...(r.code === undefined ? {} : { code: token(r.code) }),
    ...(r.candidates === undefined
      ? {}
      : { candidates: r.candidates as number }),
  });
}
export function parseAcquisitionAttempts(
  value: unknown,
  maximum = MAX_ACQUISITION_ATTEMPTS,
): readonly AcquisitionAttempt[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return Object.freeze(value.map(parseAcquisitionAttempt));
}
export function parseAcquisitionRoute(value: unknown): AcquisitionRoute {
  const r = record(value, [
    "source",
    "stage",
    "mode_reason",
    "ready",
    "unavailable_code",
  ]);
  if (
    typeof r.ready !== "boolean" ||
    !["auto-default", "auto-configured", "custom", "builtin"].includes(
      String(r.mode_reason),
    ) ||
    (r.ready && r.unavailable_code !== undefined)
  )
    fail();
  return Object.freeze({
    source: token(r.source),
    stage: stage(r.stage),
    mode_reason: r.mode_reason as AcquisitionRoute["mode_reason"],
    ready: r.ready,
    ...(r.unavailable_code === undefined
      ? {}
      : { unavailable_code: token(r.unavailable_code) }),
  });
}
export function parseAcquisitionRouteState(
  value: unknown,
): AcquisitionRouteState {
  const r = record(value, [
    "effective",
    "pending",
    "changed",
    "restart_required",
  ]);
  const routes = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 32) fail();
    const rows = v.map(parseAcquisitionRoute);
    if (
      new Set(rows.map((x) => x.source)).size !== rows.length ||
      rows.some(
        (x, i) =>
          i > 0 &&
          ACQUISITION_STAGES.indexOf(x.stage) <
            ACQUISITION_STAGES.indexOf(rows[i - 1]!.stage),
      )
    )
      fail();
    return Object.freeze(rows);
  };
  if (
    (r.effective === null
      ? r.changed !== null || r.restart_required !== null
      : typeof r.changed !== "boolean" ||
        typeof r.restart_required !== "boolean") ||
    r.changed !== r.restart_required
  )
    fail();
  return Object.freeze({
    effective: r.effective === null ? null : routes(r.effective),
    pending: routes(r.pending),
    changed: r.changed as boolean | null,
    restart_required: r.restart_required as boolean | null,
  });
}

export interface AcquisitionTaskTrace {
  readonly target_id: string;
  readonly attempt_id: string;
  readonly literature_id: string;
  readonly attempts: readonly AcquisitionAttempt[];
  readonly truncated: boolean;
}
export function parseAcquisitionTaskTrace(
  value: unknown,
): AcquisitionTaskTrace {
  const r = record(value, [
    "target_id",
    "attempt_id",
    "literature_id",
    "attempts",
    "truncated",
  ]);
  const id = (v: unknown): string =>
    typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(v) ? v : fail();
  if (typeof r.truncated !== "boolean") fail();
  return Object.freeze({
    target_id: id(r.target_id),
    attempt_id: id(r.attempt_id),
    literature_id: id(r.literature_id),
    attempts: parseAcquisitionAttempts(r.attempts),
    truncated: r.truncated,
  });
}
