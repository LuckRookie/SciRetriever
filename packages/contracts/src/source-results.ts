import {
  ContractValidationError,
  parseLiteratureId,
  parseUtcTimestamp,
} from "./index.js";
import {
  ACQUISITION_STAGES,
  type AcquisitionRouteStage,
} from "./acquisition.js";
import {
  parseSourceProblem,
  parseSourceTechnicalDetails,
  type SourceProblem,
  type SourceTechnicalDetails,
} from "./source-configuration.js";

export const METADATA_SOURCE_PURPOSES = [
  "topic-search",
  "lookup",
  "reference-query",
] as const;
export type MetadataSourcePurpose = (typeof METADATA_SOURCE_PURPOSES)[number];
export interface MetadataTaskProvider {
  readonly source: string;
  readonly scan_limit: number;
}
export type MetadataTaskRequest =
  | {
      readonly kind: "topic";
      readonly providers: readonly MetadataTaskProvider[];
      readonly query: string;
      readonly year_from: number | null;
      readonly year_to: number | null;
    }
  | {
      readonly kind: "citation";
      readonly providers: readonly {
        readonly source: string;
        readonly scan_limit: number | null;
      }[];
      readonly seed_literature_ids: readonly string[];
      readonly direction: "references" | "cited-by" | "both";
      readonly max_depth: number;
      readonly result_limit: number | null;
    }
  | {
      readonly kind: "lookup";
      readonly providers: readonly MetadataTaskProvider[];
      readonly literature_ids: readonly string[];
    };
export type MetadataSourceResult =
  | "hit"
  | "miss"
  | "error"
  | "unavailable"
  | "cooldown"
  | "not-enabled"
  | "cancelled";
/** Safe, immutable deltas, carried by the existing metadata-source task event. */
export type MetadataSourceProgress = {
  readonly schema_version: 1;
  readonly record_id: string;
  readonly source: string;
  readonly purpose: MetadataSourcePurpose;
  readonly role: "primary" | "supporting";
  readonly unit_id: string;
  readonly at: string;
} & (
  | { readonly phase: "started" | "requested" }
  | { readonly phase: "returned" | "rejected"; readonly count: number }
  | {
      readonly phase: "included" | "observed";
      readonly result_id: string;
      readonly disposition: "created" | "matched" | "related";
    }
  | {
      readonly phase: "finished";
      readonly result: MetadataSourceResult;
      readonly problem: SourceProblem | null;
    }
);
export interface MetadataSourceRecord {
  readonly record_id: string;
  readonly source: string;
  readonly purpose: MetadataSourcePurpose;
  readonly role: "primary" | "supporting";
  readonly unit_id: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly requested: boolean;
  readonly returned: number;
  readonly included: number;
  readonly rejected: number;
  readonly result: "running" | MetadataSourceResult;
  readonly problem: SourceProblem | null;
}
/** Published means an admitted primary PDF receipt, never merely a download or escalation. */
export interface PdfSourceResult {
  readonly schema_version: 1;
  readonly literature_id: string;
  readonly finished_at: string;
  readonly result: "obtained" | "not-obtained";
  readonly source: string | null;
  readonly stage: AcquisitionRouteStage | null;
  readonly receipt_id: string | null;
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourceRatio {
  readonly numerator: number;
  readonly denominator: number;
  readonly ratio: number | null;
}
/** numerator is the sum of per-search coverage fractions; denominator is nonempty, requested searches. */
export interface SourceMeanCoverage extends SourceRatio {
  readonly method: "mean-per-search";
  readonly covered_results: number;
  readonly merged_results: number;
}
export interface PdfSourceMetrics {
  readonly source: string;
  readonly stage: AcquisitionRouteStage;
  readonly attempted: number;
  readonly obtained: number;
  readonly obtained_without_request: number;
  readonly requests: number;
  readonly errors: number;
  readonly attempt_rate: SourceRatio;
  readonly hit_rate: SourceRatio;
  readonly error_rate: SourceRatio;
  readonly problems: readonly SourceProblem[];
  readonly technical_details: SourceTechnicalDetails;
}
export interface PdfSourceSummary {
  readonly documents: number;
  readonly obtained: number;
  readonly not_obtained: number;
  readonly unknown: number;
  readonly sources: readonly PdfSourceMetrics[];
}
export interface MetadataSourceCounts {
  readonly source: string;
  readonly purpose: MetadataSourcePurpose | "mixed";
  readonly returned: number;
  readonly included: number;
  readonly requests: number;
  readonly attempted_units: number;
  readonly hit_units: number;
  readonly errors: number;
  readonly coverage: SourceRatio;
  readonly problems: readonly SourceProblem[];
  readonly technical_details: SourceTechnicalDetails;
}
export interface MetadataSourceSummary {
  readonly returned: number;
  readonly merged: number;
  readonly new_literatures: number;
  readonly matched_literatures: number;
  readonly rejected: number;
  readonly sources: readonly MetadataSourceCounts[];
  readonly records: readonly MetadataSourceRecord[];
  readonly record_count: number;
  readonly records_truncated: boolean;
}
export interface TaskSourceResults {
  readonly schema_version: 1;
  readonly availability: "recorded" | "unrecorded";
  readonly metadata: MetadataSourceSummary | null;
  readonly pdf: PdfSourceSummary | null;
}
export interface SourceStatisticsRequest {
  readonly range: "last-30-days" | "all";
}
export interface MetadataSourceMetrics {
  readonly source: string;
  readonly topic_coverage: SourceMeanCoverage | null;
  readonly lookup_hit: SourceRatio | null;
  readonly reference_hit: SourceRatio | null;
  readonly error_rate: SourceRatio;
  readonly problems: readonly SourceProblem[];
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourceStatistics {
  readonly schema_version: 1;
  readonly range: SourceStatisticsRequest["range"];
  readonly range_start: string | null;
  readonly as_of: string;
  readonly recorded_since: string | null;
  readonly history: "recorded-only";
  readonly pdf: PdfSourceSummary;
  readonly metadata: {
    readonly topic_searches: number;
    readonly lookup_documents: number;
    readonly reference_documents: number;
    readonly sources: readonly MetadataSourceMetrics[];
  };
}

function fail(): never {
  throw new ContractValidationError();
}
function rec(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(r, k)) ||
    Object.keys(r).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail();
  return r;
}
function one<T extends string>(value: unknown, values: readonly T[]): T {
  return values.includes(value as T) ? (value as T) : fail();
}
const id = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(v) ? v : fail();
const source = (v: unknown) =>
  typeof v === "string" && /^[a-z][a-z0-9-]{0,95}$/u.test(v) ? v : fail();
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max
    ? v
    : fail();
const bool = (v: unknown) => (typeof v === "boolean" ? v : fail());
function list<T>(
  v: unknown,
  read: (v: unknown) => T,
  maximum = 10000,
): readonly T[] {
  if (!Array.isArray(v) || v.length > maximum) fail();
  return Object.freeze(v.map(read));
}
const nullable = <T>(v: unknown, read: (v: unknown) => T): T | null =>
  v === null ? null : read(v);
const purpose = (v: unknown) => one(v, METADATA_SOURCE_PURPOSES);
const stage = (v: unknown) => one(v, ACQUISITION_STAGES);
const results = [
  "hit",
  "miss",
  "error",
  "unavailable",
  "cooldown",
  "not-enabled",
  "cancelled",
] as const;
const problems = (v: unknown) => list(v, parseSourceProblem, 4);
function unique<T>(values: readonly T[], key: (v: T) => string): readonly T[] {
  if (new Set(values.map(key)).size !== values.length) fail();
  return values;
}
export function parseMetadataTaskRequest(value: unknown): MetadataTaskRequest {
  const shape = rec(
    value,
    ["kind", "providers"],
    [
      "query",
      "year_from",
      "year_to",
      "seed_literature_ids",
      "direction",
      "max_depth",
      "result_limit",
      "literature_ids",
    ],
  );
  const positiveLimit = (v: unknown) => {
    const n = count(v);
    return n >= 1 ? n : fail();
  };
  const readProviders = <T extends number | null>(
    readLimit: (v: unknown) => T,
    optional = false,
  ) => {
    const providers = unique(
      list(
        shape.providers,
        (v) => {
          const p = optional
            ? rec(v, ["source"], ["scan_limit"])
            : rec(v, ["source", "scan_limit"]);
          return Object.freeze({
            source: source(p.source),
            scan_limit: readLimit(p.scan_limit),
          });
        },
        32,
      ),
      (p) => p.source,
    );
    if (!providers.length) fail();
    return providers;
  };
  if (shape.kind === "topic") {
    const r = rec(value, [
      "kind",
      "providers",
      "query",
      "year_from",
      "year_to",
    ]);
    if (typeof r.query !== "string" || !r.query.trim() || r.query.length > 8192)
      fail();
    const year = (v: unknown) => {
        const n = count(v, 9999);
        if (!n) fail();
        return n;
      },
      from = nullable(r.year_from, year),
      to = nullable(r.year_to, year);
    if (from !== null && to !== null && from > to) fail();
    return Object.freeze({
      kind: "topic",
      providers: readProviders(positiveLimit),
      query: r.query,
      year_from: from,
      year_to: to,
    });
  }
  if (shape.kind === "citation") {
    const r = rec(
        value,
        ["kind", "providers", "seed_literature_ids", "direction"],
        ["max_depth", "result_limit"],
      ),
      seeds = unique(
        list(r.seed_literature_ids, parseLiteratureId, 1000),
        (v) => v,
      ),
      limit = r.result_limit == null ? null : positiveLimit(r.result_limit);
    if (!seeds.length) fail();
    return Object.freeze({
      kind: "citation",
      providers: readProviders(
        (v) => (v == null ? null : positiveLimit(v)),
        true,
      ),
      seed_literature_ids: seeds,
      direction: one(r.direction, ["references", "cited-by", "both"]),
      max_depth: r.max_depth === undefined ? 1 : count(r.max_depth, 32),
      result_limit: limit,
    });
  }
  const r = rec(value, ["kind", "providers", "literature_ids"]);
  if (r.kind !== "lookup") fail();
  const ids = unique(list(r.literature_ids, parseLiteratureId, 1000), (v) => v);
  if (!ids.length) fail();
  return Object.freeze({
    kind: "lookup",
    providers: readProviders(positiveLimit),
    literature_ids: ids,
  });
}
export function parseMetadataSourceProgress(
  value: unknown,
): MetadataSourceProgress {
  const r = rec(
    value,
    [
      "schema_version",
      "record_id",
      "source",
      "purpose",
      "role",
      "unit_id",
      "at",
      "phase",
    ],
    ["count", "result_id", "disposition", "result", "problem"],
  );
  if (r.schema_version !== 1) fail();
  const base = {
    schema_version: 1 as const,
    record_id: id(r.record_id),
    source: source(r.source),
    purpose: purpose(r.purpose),
    role: one(r.role, ["primary", "supporting"]),
    unit_id: id(r.unit_id),
    at: parseUtcTimestamp(r.at),
  };
  const keys = [
    "schema_version",
    "record_id",
    "source",
    "purpose",
    "role",
    "unit_id",
    "at",
    "phase",
  ];
  if (r.phase === "started" || r.phase === "requested") {
    rec(value, keys);
    return Object.freeze({ ...base, phase: r.phase });
  }
  if (r.phase === "returned" || r.phase === "rejected") {
    rec(value, [...keys, "count"]);
    return Object.freeze({ ...base, phase: r.phase, count: count(r.count) });
  }
  if (r.phase === "included" || r.phase === "observed") {
    rec(value, [...keys, "result_id", "disposition"]);
    return Object.freeze({
      ...base,
      phase: r.phase,
      result_id: id(r.result_id),
      disposition: one(r.disposition, ["created", "matched", "related"]),
    });
  }
  rec(value, [...keys, "result", "problem"]);
  if (r.phase !== "finished") fail();
  const result = one(r.result, results),
    problem = nullable(r.problem, parseSourceProblem);
  if (["error", "unavailable"].includes(result) !== (problem !== null)) fail();
  return Object.freeze({ ...base, phase: "finished", result, problem });
}
export function parseMetadataSourceRecord(
  value: unknown,
): MetadataSourceRecord {
  const r = rec(value, [
      "record_id",
      "source",
      "purpose",
      "role",
      "unit_id",
      "started_at",
      "finished_at",
      "requested",
      "returned",
      "included",
      "rejected",
      "result",
      "problem",
    ]),
    started = parseUtcTimestamp(r.started_at),
    finished = nullable(r.finished_at, parseUtcTimestamp),
    result = one(r.result, ["running", ...results]),
    problem = nullable(r.problem, parseSourceProblem),
    requested = bool(r.requested);
  if (
    (result === "running") !== (finished === null) ||
    (finished !== null && Date.parse(finished) < Date.parse(started)) ||
    (["not-enabled", "cooldown", "unavailable"].includes(result) &&
      requested) ||
    ["error", "unavailable"].includes(result) !== (problem !== null)
  )
    fail();
  return Object.freeze({
    record_id: id(r.record_id),
    source: source(r.source),
    purpose: purpose(r.purpose),
    role: one(r.role, ["primary", "supporting"]),
    unit_id: id(r.unit_id),
    started_at: started,
    finished_at: finished,
    requested,
    returned: count(r.returned),
    included: count(r.included),
    rejected: count(r.rejected),
    result,
    problem,
  });
}
export function parsePdfSourceResult(value: unknown): PdfSourceResult {
  const r = rec(value, [
      "schema_version",
      "literature_id",
      "finished_at",
      "result",
      "source",
      "stage",
      "receipt_id",
      "technical_details",
    ]),
    result = one(r.result, ["obtained", "not-obtained"]);
  if (
    r.schema_version !== 1 ||
    (result === "obtained"
      ? r.source === null || r.stage === null || r.receipt_id === null
      : r.source !== null || r.stage !== null || r.receipt_id !== null)
  )
    fail();
  return Object.freeze({
    schema_version: 1,
    literature_id: parseLiteratureId(r.literature_id),
    finished_at: parseUtcTimestamp(r.finished_at),
    result,
    source: nullable(r.source, source),
    stage: nullable(r.stage, stage),
    receipt_id: nullable(r.receipt_id, id),
    technical_details: parseSourceTechnicalDetails(r.technical_details),
  });
}
export function parseSourceRatio(
  value: unknown,
  fractionalNumerator = false,
): SourceRatio {
  const r = rec(value, ["numerator", "denominator", "ratio"]),
    denominator = count(r.denominator),
    n = r.numerator;
  if (
    typeof n !== "number" ||
    !Number.isFinite(n) ||
    n < 0 ||
    n > denominator + 1e-10 ||
    (!fractionalNumerator && !Number.isSafeInteger(n))
  )
    fail();
  if (
    denominator === 0
      ? n !== 0 || r.ratio !== null
      : typeof r.ratio !== "number" ||
        !Number.isFinite(r.ratio) ||
        r.ratio < 0 ||
        r.ratio > 1 ||
        Math.abs(r.ratio - n / denominator) > 1e-12
  )
    fail();
  return Object.freeze({
    numerator: n,
    denominator,
    ratio: r.ratio as number | null,
  });
}
function pdfMetrics(value: unknown): PdfSourceMetrics {
  const r = rec(value, [
      "source",
      "stage",
      "attempted",
      "obtained",
      "obtained_without_request",
      "requests",
      "errors",
      "attempt_rate",
      "hit_rate",
      "error_rate",
      "problems",
      "technical_details",
    ]),
    attempted = count(r.attempted),
    obtained = count(r.obtained),
    obtained_without_request = count(r.obtained_without_request),
    requests = count(r.requests),
    errors = count(r.errors),
    attempt_rate = parseSourceRatio(r.attempt_rate),
    hit_rate = parseSourceRatio(r.hit_rate),
    error_rate = parseSourceRatio(r.error_rate);
  if (
    attempt_rate.numerator !== attempted ||
    obtained_without_request > obtained ||
    hit_rate.numerator !== obtained - obtained_without_request ||
    hit_rate.denominator !== attempted ||
    error_rate.numerator !== errors ||
    error_rate.denominator !== requests
  )
    fail();
  return Object.freeze({
    source: source(r.source),
    stage: stage(r.stage),
    attempted,
    obtained,
    obtained_without_request,
    requests,
    errors,
    attempt_rate,
    hit_rate,
    error_rate,
    problems: problems(r.problems),
    technical_details: parseSourceTechnicalDetails(r.technical_details),
  });
}
export function parsePdfSourceSummary(value: unknown): PdfSourceSummary {
  const r = rec(value, [
      "documents",
      "obtained",
      "not_obtained",
      "unknown",
      "sources",
    ]),
    documents = count(r.documents),
    obtained = count(r.obtained),
    not_obtained = count(r.not_obtained),
    unknown = count(r.unknown),
    sources = unique(list(r.sources, pdfMetrics, 64), (x) => x.source);
  if (
    obtained + not_obtained + unknown !== documents ||
    sources.reduce((n, s) => n + s.obtained, 0) !== obtained ||
    sources.some((s) => s.attempt_rate.denominator !== documents)
  )
    fail();
  return Object.freeze({ documents, obtained, not_obtained, unknown, sources });
}
function metadataCounts(value: unknown): MetadataSourceCounts {
  const r = rec(value, [
      "source",
      "purpose",
      "returned",
      "included",
      "requests",
      "attempted_units",
      "hit_units",
      "errors",
      "coverage",
      "problems",
      "technical_details",
    ]),
    requests = count(r.requests),
    errors = count(r.errors),
    attempted_units = count(r.attempted_units),
    hit_units = count(r.hit_units),
    included = count(r.included),
    coverage = parseSourceRatio(r.coverage);
  if (
    errors > requests ||
    hit_units > attempted_units ||
    attempted_units > requests ||
    coverage.numerator !== included
  )
    fail();
  return Object.freeze({
    source: source(r.source),
    purpose: one(r.purpose, [...METADATA_SOURCE_PURPOSES, "mixed"]),
    returned: count(r.returned),
    included,
    requests,
    attempted_units,
    hit_units,
    errors,
    coverage,
    problems: problems(r.problems),
    technical_details: parseSourceTechnicalDetails(r.technical_details),
  });
}
export function parseTaskSourceResults(value: unknown): TaskSourceResults {
  const r = rec(value, ["schema_version", "availability", "metadata", "pdf"]);
  if (
    r.schema_version !== 1 ||
    !["recorded", "unrecorded"].includes(String(r.availability)) ||
    (r.availability === "unrecorded") !==
      (r.metadata === null && r.pdf === null)
  )
    fail();
  let metadata: MetadataSourceSummary | null = null;
  if (r.metadata !== null) {
    const m = rec(r.metadata, [
        "returned",
        "merged",
        "new_literatures",
        "matched_literatures",
        "rejected",
        "sources",
        "records",
        "record_count",
        "records_truncated",
      ]),
      sources = unique(list(m.sources, metadataCounts, 96), (s) => s.source),
      records = unique(
        list(m.records, parseMetadataSourceRecord, 200),
        (s) => s.record_id,
      ),
      merged = count(m.merged),
      record_count = count(m.record_count),
      records_truncated = bool(m.records_truncated);
    if (
      sources.reduce((n, s) => n + s.returned, 0) !== m.returned ||
      sources.some((s) => s.coverage.denominator !== merged) ||
      record_count > records.length !== records_truncated ||
      record_count < records.length
    )
      fail();
    metadata = Object.freeze({
      returned: count(m.returned),
      merged,
      new_literatures: count(m.new_literatures),
      matched_literatures: count(m.matched_literatures),
      rejected: count(m.rejected),
      sources,
      records,
      record_count,
      records_truncated,
    });
  }
  return Object.freeze({
    schema_version: 1,
    availability: r.availability as TaskSourceResults["availability"],
    metadata,
    pdf: nullable(r.pdf, parsePdfSourceSummary),
  });
}
export function parseSourceStatisticsRequest(
  value: unknown,
): SourceStatisticsRequest {
  const r = rec(value, ["range"]);
  return Object.freeze({ range: one(r.range, ["last-30-days", "all"]) });
}
function meanCoverage(value: unknown): SourceMeanCoverage {
  const r = rec(value, [
    "method",
    "covered_results",
    "merged_results",
    "numerator",
    "denominator",
    "ratio",
  ]);
  if (r.method !== "mean-per-search") fail();
  const ratio = parseSourceRatio(
      { numerator: r.numerator, denominator: r.denominator, ratio: r.ratio },
      true,
    ),
    covered_results = count(r.covered_results),
    merged_results = count(r.merged_results);
  if (covered_results > merged_results) fail();
  return Object.freeze({
    ...ratio,
    method: "mean-per-search",
    covered_results,
    merged_results,
  });
}
export function parseSourceStatistics(value: unknown): SourceStatistics {
  const r = rec(value, [
      "schema_version",
      "range",
      "range_start",
      "as_of",
      "recorded_since",
      "history",
      "pdf",
      "metadata",
    ]),
    range = one(r.range, ["last-30-days", "all"]),
    as_of = parseUtcTimestamp(r.as_of),
    range_start = nullable(r.range_start, parseUtcTimestamp),
    recorded_since = nullable(r.recorded_since, parseUtcTimestamp);
  if (
    r.schema_version !== 1 ||
    r.history !== "recorded-only" ||
    (range === "all") !== (range_start === null) ||
    (range_start !== null &&
      Date.parse(range_start) !== Date.parse(as_of) - 30 * 86400000) ||
    (recorded_since !== null && Date.parse(recorded_since) > Date.parse(as_of))
  )
    fail();
  const m = rec(r.metadata, [
      "topic_searches",
      "lookup_documents",
      "reference_documents",
      "sources",
    ]),
    sources = unique(
      list(
        m.sources,
        (value) => {
          const v = rec(value, [
            "source",
            "topic_coverage",
            "lookup_hit",
            "reference_hit",
            "error_rate",
            "problems",
            "technical_details",
          ]);
          return Object.freeze({
            source: source(v.source),
            topic_coverage: nullable(v.topic_coverage, meanCoverage),
            lookup_hit: nullable(v.lookup_hit, parseSourceRatio),
            reference_hit: nullable(v.reference_hit, parseSourceRatio),
            error_rate: parseSourceRatio(v.error_rate),
            problems: problems(v.problems),
            technical_details: parseSourceTechnicalDetails(v.technical_details),
          });
        },
        32,
      ),
      (s) => s.source,
    );
  return Object.freeze({
    schema_version: 1,
    range,
    range_start,
    as_of,
    recorded_since,
    history: "recorded-only",
    pdf: parsePdfSourceSummary(r.pdf),
    metadata: Object.freeze({
      topic_searches: count(m.topic_searches),
      lookup_documents: count(m.lookup_documents),
      reference_documents: count(m.reference_documents),
      sources,
    }),
  });
}
