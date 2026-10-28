import { expect, it } from "vitest";
import {
  parseMetadataSourceProgress,
  parsePdfSourceResult,
  type MetadataSourceProgress,
  type AcquisitionAttempt,
} from "@sciretriever/contracts";
import {
  SourceResultAggregation,
  taskSourceResults,
} from "../src/application/source-results.js";
import { sourceProblem } from "../src/providers/shared/source-problem.js";
import { AuthorizedProviderError } from "../src/providers/shared/authorized-pdf.js";
const at = "2026-10-28T00:00:00.000Z";
const lit = "00000000-0000-4000-8000-000000000001";
function metadata(
  totals: SourceResultAggregation,
  job: string,
  id: string,
  source: string,
  ids: string[],
  options: {
    purpose?: "topic-search" | "lookup" | "reference-query";
    role?: "primary" | "supporting";
    requested?: boolean;
    result?: "hit" | "miss" | "error" | "unavailable" | "cooldown";
    returned?: number;
    unit?: string;
  } = {},
) {
  const base = {
    schema_version: 1,
    record_id: id,
    source,
    purpose: options.purpose ?? "topic-search",
    role: options.role ?? "primary",
    unit_id: options.unit ?? "search",
    at,
  };
  const send = (change: Record<string, unknown>) =>
    totals.accept({
      job_id: job,
      kind: "metadata-source",
      payload: {
        target_id: "target",
        progress: parseMetadataSourceProgress({ ...base, ...change }),
      },
    });
  send({ phase: "started" });
  if (options.requested !== false) send({ phase: "requested" });
  send({ phase: "returned", count: options.returned ?? ids.length });
  for (const result_id of ids) {
    send({
      phase: "observed",
      result_id,
      disposition: source === "crossref" ? "created" : "matched",
    });
    send({ phase: "included", result_id, disposition: "related" });
  }
  const result = options.result ?? (ids.length ? "hit" : "miss");
  send({
    phase: "finished",
    result,
    problem:
      result === "error" || result === "unavailable"
        ? sourceProblem(
            result === "unavailable"
              ? "metadata-source-credential-missing"
              : "metadata-provider-authorization",
            "metadata",
          )
        : null,
  });
}
function attempt(
  totals: SourceResultAggregation,
  source: string,
  result: AcquisitionAttempt["result"],
  requested: boolean,
  literature = lit,
) {
  totals.accept({
    job_id: "pdf",
    kind: "acquisition-attempt",
    payload: {
      literature_id: literature,
      attempt: {
        stage:
          source === "browser"
            ? "browser"
            : source === "doi-landing"
              ? "public-web"
              : "publisher-api",
        source,
        result,
        requested,
        started_at: at,
        finished_at: at,
        ...(result === "failed" ? { code: "network-failed" } : {}),
      },
    },
  });
}
function final(
  totals: SourceResultAggregation,
  result: "obtained" | "not-obtained",
  source: string | null,
  literature = lit,
) {
  totals.accept({
    job_id: "pdf",
    kind: "pdf-source-result",
    payload: {
      result: parsePdfSourceResult({
        schema_version: 1,
        literature_id: literature,
        finished_at: at,
        result,
        source,
        stage:
          source === "browser"
            ? "browser"
            : source === "doi-landing"
              ? "public-web"
              : source
                ? "publisher-api"
                : null,
        receipt_id: source ? "published-1" : null,
        technical_details: { diagnostics: [] },
      }),
    },
  });
}
it("sums safe per-source records, deduplicates overlapping works and versions, and averages per-search coverage", () => {
  const totals = new SourceResultAggregation();
  metadata(
    totals,
    "large",
    "a",
    "crossref",
    ["work-1", "work-2", "work-3", "work-4", "work-5"],
    { returned: 7 },
  );
  metadata(totals, "large", "b", "openalex", [
    "work-1",
    "work-6",
    "work-7",
    "work-8",
    "work-9",
    "work-10",
  ]);
  metadata(totals, "small", "c", "crossref", ["single"]);
  metadata(totals, "small", "d", "openalex", []);
  const task = totals.task().metadata!;
  expect(task).toMatchObject({
    returned: 14,
    merged: 11,
    new_literatures: 6,
    matched_literatures: 5,
    record_count: 4,
  });
  expect(task.sources.reduce((n, r) => n + r.returned, 0)).toBe(task.returned);
  const stats = totals.statistics({ range: "all" }, at, at);
  const cross = stats.metadata.sources.find((s) => s.source === "crossref")!;
  expect(stats.metadata.topic_searches).toBe(2);
  expect(cross.topic_coverage).toEqual({
    method: "mean-per-search",
    numerator: 1.5,
    denominator: 2,
    ratio: 0.75,
    covered_results: 6,
    merged_results: 11,
  });
  expect(cross.topic_coverage!.ratio).not.toBe(6 / 11);
});
it("keeps supporting lookups out of hit denominators, preserves their errors, and excludes missing configuration and cooldown from requests", () => {
  const t = new SourceResultAggregation();
  metadata(t, "lookup", "1", "crossref", [], {
    purpose: "lookup",
    result: "error",
    unit: "one",
  });
  metadata(t, "lookup", "2", "openalex", ["one"], {
    purpose: "lookup",
    unit: "one",
  });
  metadata(t, "refs", "3", "crossref", ["two"], {
    purpose: "reference-query",
    unit: "seed",
  });
  metadata(t, "refs", "4", "openalex", [], {
    purpose: "lookup",
    role: "supporting",
    result: "error",
    unit: "seed",
  });
  metadata(t, "refs", "5", "elsevier", [], {
    purpose: "reference-query",
    requested: false,
    result: "unavailable",
    unit: "seed",
  });
  metadata(t, "refs", "6", "crossref", [], {
    purpose: "reference-query",
    requested: false,
    result: "cooldown",
    unit: "other",
  });
  const stats = t.statistics({ range: "all" }, at, at);
  expect(stats.metadata).toMatchObject({
    lookup_documents: 1,
    reference_documents: 1,
  });
  expect(
    stats.metadata.sources.find((s) => s.source === "openalex"),
  ).toMatchObject({
    lookup_hit: { numerator: 1, denominator: 1, ratio: 1 },
    error_rate: { numerator: 1, denominator: 2, ratio: 0.5 },
  });
  expect(
    stats.metadata.sources.find((s) => s.source === "elsevier"),
  ).toMatchObject({
    reference_hit: { numerator: 0, denominator: 0, ratio: null },
    problems: [{ display: "not-configured" }],
  });
  expect(
    t.task().metadata!.sources.find((s) => s.source === "crossref")!.requests,
  ).toBe(2);
});
it("counts only the final published PDF channel and never converts escalation or cleanup failure into another success", () => {
  const t = new SourceResultAggregation();
  attempt(t, "elsevier", "not-enabled", false);
  attempt(t, "wiley", "cooldown", false);
  attempt(t, "doi-landing", "failed", true);
  attempt(t, "browser", "escalated", false);
  attempt(t, "browser", "hit", true);
  final(t, "obtained", "browser");
  final(t, "not-obtained", null);
  const pdf = t.task().pdf!;
  expect(pdf).toMatchObject({
    documents: 1,
    obtained: 1,
    not_obtained: 0,
    unknown: 0,
  });
  expect(pdf.sources.filter((s) => s.obtained > 0)).toMatchObject([
    {
      source: "browser",
      obtained: 1,
      hit_rate: { numerator: 1, denominator: 1, ratio: 1 },
    },
  ]);
  expect(pdf.sources.find((s) => s.source === "wiley")!.attempted).toBe(0);
  expect(pdf.sources.find((s) => s.source === "elsevier")!.attempted).toBe(0);
  expect(
    pdf.sources.find((s) => s.source === "doi-landing")!.error_rate.ratio,
  ).toBe(1);
  expect(pdf.sources.reduce((n, s) => n + s.obtained, 0)).toBe(pdf.obtained);
  const legacy = new SourceResultAggregation();
  attempt(legacy, "browser", "escalated", false); // old task: no final receipt evidence
  expect(legacy.task().pdf).toMatchObject({ obtained: 0, unknown: 1 });
  expect(taskSourceResults([])).toEqual({
    schema_version: 1,
    availability: "unrecorded",
    metadata: null,
    pdf: null,
  });
});
it("does not invent request evidence for a historical cached PDF hit", () => {
  const t = new SourceResultAggregation();
  attempt(t, "wiley", "hit", false);
  expect(t.task().pdf!.sources[0]).toMatchObject({
    obtained: 1,
    attempted: 0,
    obtained_without_request: 1,
    hit_rate: { numerator: 0, denominator: 0, ratio: null },
  });
});
it("bounds the display records without truncating aggregates and rejects conflicting or out-of-order progress", () => {
  const t = new SourceResultAggregation();
  for (let n = 0; n < 205; n++)
    metadata(t, "j", String(n), "crossref", ["work-" + n], {
      purpose: "lookup",
      unit: String(n),
    });
  expect(t.task().metadata).toMatchObject({
    record_count: 205,
    records_truncated: true,
    merged: 205,
  });
  expect(t.task().metadata!.records).toHaveLength(200);
  expect(t.statistics({ range: "all" }, at, at).metadata.lookup_documents).toBe(
    205,
  );
  const p: MetadataSourceProgress = {
    schema_version: 1,
    record_id: "missing",
    source: "crossref",
    purpose: "lookup",
    role: "primary",
    unit_id: "u",
    at,
    phase: "requested",
  };
  expect(() =>
    t.accept({
      job_id: "j",
      kind: "metadata-source",
      payload: { target_id: "t", progress: p },
    }),
  ).toThrow();
});
it("uses only proven credential and entitlement facts, never a bare 403 or a vendor message", () => {
  const error = (
    authentication: "accepted" | "rejected" | "not-proven",
    fulltext_permission: "denied" | "not-proven",
    status = 403,
  ) =>
    new AuthorizedProviderError({
      code: "access",
      http_status: status,
      ...(authentication === "not-proven" ? {} : { authentication }),
      ...(fulltext_permission === "not-proven" ? {} : { fulltext_permission }),
    });
  expect(
    sourceProblem(
      "candidate-download-failed",
      "pdf",
      error("not-proven", "not-proven"),
    ).display,
  ).toBe("error");
  expect(
    sourceProblem(
      "candidate-download-failed",
      "pdf",
      error("accepted", "denied"),
    ).display,
  ).toBe("no-fulltext-permission");
  expect(
    sourceProblem(
      "candidate-download-failed",
      "pdf",
      error("rejected", "not-proven", 401),
    ).display,
  ).toBe("credential-invalid");
  expect(
    JSON.stringify(
      sourceProblem(
        "bad https://secret?token=value",
        "pdf",
        error("accepted", "denied"),
      ),
    ),
  ).not.toMatch(/private|https|token|value/);
});

it("counts candidate versions of one requested paper once and attributes only the final successful channel", () => {
  const totals = new SourceResultAggregation();
  const other = "00000000-0000-4000-8000-000000000002";
  for (const [id, source, result] of [
    [lit, "wiley", "miss"],
    [other, "browser", "hit"],
  ] as const) {
    totals.accept({
      job_id: "fallback",
      kind: "acquisition-attempt",
      payload: {
        target_id: "meta-target",
        literature_id: id,
        attempt: {
          stage: source === "browser" ? "browser" : "publisher-api",
          source,
          result,
          requested: true,
          started_at: at,
          finished_at: at,
        },
      },
    });
    totals.accept({
      job_id: "fallback",
      kind: "pdf-source-result",
      payload: {
        target_id: "meta-target",
        result: {
          schema_version: 1,
          literature_id: id,
          finished_at: at,
          result: result === "hit" ? "obtained" : "not-obtained",
          source: result === "hit" ? source : null,
          stage: result === "hit" ? "browser" : null,
          receipt_id: result === "hit" ? "published" : null,
          technical_details: { diagnostics: [] },
        },
      },
    });
  }
  expect(totals.task().pdf).toMatchObject({
    documents: 1,
    obtained: 1,
    not_obtained: 0,
  });
  expect(
    totals.task().pdf!.sources.map((s) => [s.source, s.attempted, s.obtained]),
  ).toEqual([
    ["wiley", 1, 0],
    ["browser", 1, 1],
  ]);
});

it("uses the latest confirmed delivery when a target publishes again, while later failure cannot revoke it", () => {
  const t = new SourceResultAggregation();
  attempt(t, "wiley", "hit", true);
  final(t, "obtained", "wiley");
  attempt(t, "browser", "hit", true);
  final(t, "obtained", "browser");
  final(t, "not-obtained", null);
  expect(t.task().pdf).toMatchObject({
    documents: 1,
    obtained: 1,
    not_obtained: 0,
  });
  expect(t.task().pdf!.sources.map((s) => [s.source, s.obtained])).toEqual([
    ["wiley", 0],
    ["browser", 1],
  ]);
});
