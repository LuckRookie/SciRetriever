import { expect, it } from "vitest";
import {
  ContractValidationError,
  parseCitationSourceCooldown,
  parseTaskCitationSourceCooldowns,
  parseMetadataTaskRequest,
  parseMetadataSourceProgress,
  parseMetadataSourceRecord,
  parsePdfSourceResult,
  parseSourceRatio,
  parseSourceStatistics,
  parseSourceStatisticsRequest,
  parseTaskSourceResults,
} from "../src/index.js";

const at = "2026-10-28T00:00:00.000Z",
  literature = "00000000-0000-0000-0000-000000000001";
const emptyPdf = {
  documents: 0,
  obtained: 0,
  not_obtained: 0,
  unknown: 0,
  sources: [],
};
const request = {
  kind: "topic",
  query: "synthetic",
  year_from: null,
  year_to: null,
  providers: [{ source: "crossref", scan_limit: 100 }],
};
const progress = {
  schema_version: 1,
  record_id: "record-1",
  source: "crossref",
  purpose: "topic-search",
  role: "primary",
  unit_id: "topic",
  at,
  phase: "started",
};
const stats = {
  schema_version: 1,
  range: "all",
  range_start: null,
  as_of: at,
  recorded_since: null,
  history: "recorded-only",
  pdf: emptyPdf,
  metadata: {
    topic_searches: 0,
    lookup_documents: 0,
    reference_documents: 0,
    sources: [],
  },
};

const cooldown = {
  target_id: "job-1:0",
  run_id: "00000000-0000-0000-0000-000000000002",
  source: "openalex",
  status: "cooling",
  retries: 0,
  next_retry_at: at,
  reason: {
    code: "metadata-provider-rate-limited",
    reason: "The source returned a quota error.",
    action: "Wait for the source to recover.",
    retryable: true,
  },
  pending_count: 2,
  pending_sample: [
    { literature_id: literature, purpose: "reference-query" },
    { literature_id: literature, purpose: "lookup", relation_id: "relation-1" },
  ],
  pending_truncated: false,
};

it("decodes cooldown transitions and bounded task fields without discarding wire fields", () => {
  const changes = [
    cooldown,
    { ...cooldown, next_retry_at: "+275760-09-13T00:00:00.000Z" },
    { ...cooldown, status: "disabled", retries: 6, next_retry_at: null },
    { ...cooldown, status: "retry-ended", retries: 1, next_retry_at: null },
    { ...cooldown, status: "recovered", next_retry_at: null, reason: null },
    {
      ...cooldown,
      pending_count: 21,
      pending_sample: Array.from({ length: 20 }, (_, n) => ({
        literature_id: literature,
        purpose: "lookup",
        relation_id: `relation-${n}`,
      })),
      pending_truncated: true,
    },
  ];
  for (const row of changes)
    expect(parseCitationSourceCooldown(row)).toEqual(row);
  expect(parseTaskCitationSourceCooldowns({ job: {} })).toEqual({});
  const fields = { citation_source_cooldowns: [cooldown] };
  expect(parseTaskCitationSourceCooldowns({ job: {}, ...fields })).toEqual(
    fields,
  );
  const truncated = {
    citation_source_cooldowns: Array.from({ length: 32 }, (_, n) => ({
      ...cooldown,
      target_id: `job-1:${n}`,
    })),
    citation_source_cooldowns_truncated: true,
  };
  expect(parseTaskCitationSourceCooldowns(truncated)).toEqual(truncated);
});

it("rejects invalid cooldown states, timestamps, failure shapes, samples and truncation flags", () => {
  for (const invalid of [
    { ...cooldown, status: "running" },
    { ...cooldown, source: "" },
    { ...cooldown, target_id: 1 },
    { ...cooldown, run_id: "" },
    { ...cooldown, retries: -1 },
    { ...cooldown, retries: 1.5 },
    { ...cooldown, retries: 7 },
    { ...cooldown, retries: 6 },
    { ...cooldown, next_retry_at: null },
    { ...cooldown, next_retry_at: "2026-02-30T00:00:00Z" },
    { ...cooldown, status: "disabled", next_retry_at: null },
    { ...cooldown, reason: { code: "quota", reason: "exhausted" } },
    { ...cooldown, reason: { ...cooldown.reason, retryable: "true" } },
    { ...cooldown, pending_count: 1 },
    { ...cooldown, pending_truncated: 1 },
    { ...cooldown, pending_truncated: true },
    {
      ...cooldown,
      pending_count: 21,
      pending_sample: Array(21).fill(cooldown.pending_sample[0]),
    },
    {
      ...cooldown,
      pending_sample: [
        { literature_id: literature, purpose: "lookup" },
        cooldown.pending_sample[1],
      ],
    },
    {
      ...cooldown,
      pending_sample: [
        { literature_id: literature, purpose: "topic-search" },
        cooldown.pending_sample[1],
      ],
    },
    {
      ...cooldown,
      pending_sample: [
        { literature_id: "invalid", purpose: "reference-query" },
        cooldown.pending_sample[1],
      ],
    },
    { ...cooldown, unknown: 1 },
  ])
    expect(() => parseCitationSourceCooldown(invalid)).toThrow(
      ContractValidationError,
    );
  for (const invalid of [
    { citation_source_cooldowns: null },
    { citation_source_cooldowns: [] },
    { citation_source_cooldowns: Array(33).fill(cooldown) },
    { citation_source_cooldowns_truncated: true },
    {
      citation_source_cooldowns: [cooldown],
      citation_source_cooldowns_truncated: false,
    },
  ])
    expect(() => parseTaskCitationSourceCooldowns(invalid)).toThrow(
      ContractValidationError,
    );
});

it("parses frozen topic, citation and lookup selections without accepting arbitrary configuration or credential fields", () => {
  expect(parseMetadataTaskRequest(request)).toEqual(request);
  expect(
    parseMetadataTaskRequest({
      kind: "lookup",
      literature_ids: [literature],
      providers: request.providers,
    }).kind,
  ).toBe("lookup");
  expect(
    parseMetadataTaskRequest({
      kind: "citation",
      seed_literature_ids: [literature],
      direction: "both",
      max_depth: 2,
      result_limit: 100,
      providers: request.providers,
    }).kind,
  ).toBe("citation");
  for (const value of [
    { ...request, token: "synthetic" },
    { ...request, year_from: 2027, year_to: 2026 },
    { ...request, providers: [...request.providers, ...request.providers] },
    {
      ...request,
      providers: [{ source: "https://synthetic.invalid", scan_limit: 1 }],
    },
    { kind: "lookup", providers: request.providers, literature_ids: [] },
  ])
    expect(() => parseMetadataTaskRequest(value)).toThrow();
});
it("accepts positive safe metadata budgets above ten thousand and rejects invalid integer boundaries", () => {
  const citation = {
    kind: "citation",
    seed_literature_ids: [literature],
    direction: "both",
    max_depth: 2,
    result_limit: 50000,
    providers: [{ source: "crossref", scan_limit: 50000 }],
  };
  for (const limit of [1, 10001, 50000, Number.MAX_SAFE_INTEGER]) {
    const providers = [{ source: "crossref", scan_limit: limit }];
    for (const input of [
      { ...request, providers },
      { kind: "lookup", literature_ids: [literature], providers },
      { ...citation, providers, result_limit: limit },
    ])
      expect(parseMetadataTaskRequest(input)).toEqual(input);
  }
  for (const limit of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "50000",
  ]) {
    const providers = [{ source: "crossref", scan_limit: limit }];
    for (const input of [
      { ...request, providers },
      { kind: "lookup", literature_ids: [literature], providers },
      { ...citation, providers },
      { ...citation, result_limit: limit },
    ])
      expect(() => parseMetadataTaskRequest(input)).toThrow();
  }
});
it("defaults citation depth to one and normalizes omitted or null limits without relaxing topic or lookup bounds", () => {
  const base = {
    kind: "citation",
    seed_literature_ids: [literature],
    direction: "references",
  };
  for (const optional of [{}, { result_limit: null }])
    for (const provider of [
      { source: "crossref" },
      { source: "crossref", scan_limit: null },
    ]) {
      const parsed = parseMetadataTaskRequest({
        ...base,
        ...optional,
        providers: [provider],
      });
      expect(parsed).toEqual({
        ...base,
        max_depth: 1,
        result_limit: null,
        providers: [{ source: "crossref", scan_limit: null }],
      });
      expect(Object.isFrozen(parsed.providers[0])).toBe(true);
      expect(
        parseMetadataTaskRequest({ ...parsed, max_depth: 0 }),
      ).toMatchObject({ max_depth: 0 });
    }
  for (const value of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    "1",
  ]) {
    expect(() =>
      parseMetadataTaskRequest({
        ...base,
        result_limit: value,
        providers: [{ source: "crossref" }],
      }),
    ).toThrow();
    expect(() =>
      parseMetadataTaskRequest({
        ...base,
        providers: [{ source: "crossref", scan_limit: value }],
      }),
    ).toThrow();
  }
  for (const provider of [
    { source: "crossref" },
    { source: "crossref", scan_limit: null },
  ]) {
    expect(() =>
      parseMetadataTaskRequest({ ...request, providers: [provider] }),
    ).toThrow();
    expect(() =>
      parseMetadataTaskRequest({
        kind: "lookup",
        literature_ids: [literature],
        providers: [provider],
      }),
    ).toThrow();
  }
  for (const max_depth of [null, -1, 1.5, 33])
    expect(() =>
      parseMetadataTaskRequest({
        ...base,
        max_depth,
        providers: [{ source: "crossref" }],
      }),
    ).toThrow();
});
it("keeps bounded progress phase payloads and puts every reason code inside technical details", () => {
  expect(parseMetadataSourceProgress(progress)).toEqual(progress);
  const problem = {
    display: "error",
    technical_details: {
      diagnostics: [
        {
          code: "metadata-provider-authorization",
          scope: "metadata",
          http_status: 403,
        },
      ],
    },
  };
  expect(
    parseMetadataSourceProgress({
      ...progress,
      phase: "finished",
      result: "error",
      problem,
    }).phase,
  ).toBe("finished");
  for (const value of [
    { ...progress, url: "synthetic" },
    { ...progress, code: "raw-code" },
    { ...progress, count: 1 },
    { ...progress, phase: "returned", count: -1 },
    { ...progress, phase: "finished", result: "error", problem: null },
    { ...progress, phase: "finished", result: "miss", problem },
    {
      ...progress,
      phase: "included",
      result_id: "work",
      disposition: "invented",
    },
  ])
    expect(() => parseMetadataSourceProgress(value)).toThrow();
});
it("distinguishes an in-flight record, a successful receipt and an unavailable source without claiming a request", () => {
  const record = {
    record_id: "r",
    source: "wiley",
    purpose: "lookup",
    role: "primary",
    unit_id: "l",
    started_at: at,
    finished_at: null,
    requested: false,
    returned: 0,
    included: 0,
    rejected: 0,
    result: "running",
    problem: null,
  };
  expect(parseMetadataSourceRecord(record).result).toBe("running");
  expect(() =>
    parseMetadataSourceRecord({ ...record, result: "hit" }),
  ).toThrow();
  expect(() =>
    parseMetadataSourceRecord({
      ...record,
      finished_at: at,
      result: "cooldown",
      requested: true,
    }),
  ).toThrow();
  const receipt = {
    schema_version: 1,
    literature_id: literature,
    finished_at: at,
    result: "obtained",
    source: "wiley",
    stage: "publisher-api",
    receipt_id: "receipt-1",
    technical_details: { diagnostics: [] },
  };
  expect(parsePdfSourceResult(receipt)).toEqual(receipt);
  expect(() =>
    parsePdfSourceResult({ ...receipt, receipt_id: null }),
  ).toThrow();
  expect(() =>
    parsePdfSourceResult({ ...receipt, result: "not-obtained" }),
  ).toThrow();
});
it("validates explicit numerators and denominators, nullable zero samples, and mean-of-search coverage rather than a weighted ratio", () => {
  expect(
    parseSourceRatio({ numerator: 0, denominator: 0, ratio: null }).ratio,
  ).toBeNull();
  for (const value of [
    { numerator: 0, denominator: 0, ratio: 0 },
    { numerator: 2, denominator: 1, ratio: 2 },
    { numerator: 1, denominator: 2, ratio: 0.75 },
    { numerator: 0.5, denominator: 1, ratio: 0.5 },
  ])
    expect(() => parseSourceRatio(value)).toThrow();
  const value = {
    ...stats,
    metadata: {
      ...stats.metadata,
      topic_searches: 2,
      sources: [
        {
          source: "crossref",
          topic_coverage: {
            method: "mean-per-search",
            numerator: 1.5,
            denominator: 2,
            ratio: 0.75,
            covered_results: 6,
            merged_results: 11,
          },
          lookup_hit: null,
          reference_hit: null,
          error_rate: { numerator: 0, denominator: 2, ratio: 0 },
          problems: [],
          technical_details: { diagnostics: [] },
        },
      ],
    },
  };
  expect(
    parseSourceStatistics(value).metadata.sources[0]!.topic_coverage!.ratio,
  ).toBe(0.75);
  expect(() =>
    parseSourceStatistics({
      ...value,
      metadata: {
        ...value.metadata,
        sources: [
          {
            ...value.metadata.sources[0],
            topic_coverage: {
              ...value.metadata.sources[0]!.topic_coverage,
              ratio: 6 / 11,
            },
          },
        ],
      },
    }),
  ).toThrow();
});
it("parses unrecorded history and empty statistics, rejects unknown fields and dishonest totals", () => {
  expect(
    parseTaskSourceResults({
      schema_version: 1,
      availability: "unrecorded",
      metadata: null,
      pdf: null,
    }).availability,
  ).toBe("unrecorded");
  expect(parseSourceStatistics(stats)).toEqual(stats);
  expect(parseSourceStatisticsRequest({ range: "last-30-days" }).range).toBe(
    "last-30-days",
  );
  for (const request of [{ range: "week" }, { range: "all", since: at }])
    expect(() => parseSourceStatisticsRequest(request)).toThrow();
  expect(() =>
    parseSourceStatistics({ ...stats, code: "raw-error" }),
  ).toThrow();
  expect(() =>
    parseSourceStatistics({
      ...stats,
      recorded_since: "2027-01-01T00:00:00.000Z",
    }),
  ).toThrow();
  expect(() =>
    parseTaskSourceResults({
      schema_version: 1,
      availability: "recorded",
      metadata: null,
      pdf: { ...emptyPdf, obtained: 1 },
    }),
  ).toThrow();
});

it("admits metadata operations through the same strict durable processing request parser", async () => {
  const { parseProcessingTaskRequest } = await import("../src/index.js");
  const task = {
    schema_version: 1,
    idempotency_key: "metadata",
    operations: [{ operation: "acquire-metadata", request }],
  };
  expect((await parseProcessingTaskRequest(task)).operations).toEqual(
    task.operations,
  );
  await expect(
    parseProcessingTaskRequest({
      ...task,
      operations: [
        {
          operation: "acquire-metadata",
          request: { ...request, url: "synthetic" },
        },
      ],
    }),
  ).rejects.toThrow();
  await expect(
    parseProcessingTaskRequest({
      ...task,
      operations: [
        {
          operation: "acquire-metadata",
          request: { ...request, providers: [] },
        },
      ],
    }),
  ).rejects.toThrow();
});
