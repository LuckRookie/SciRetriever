import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  ContractValidationError,
  DATABASE_COMPLETION_REPORT_PARTITIONS,
  parseAsset,
  parseCompletionTarget,
  parseDatabaseCompletionReport,
  parseIdentifier,
  parseLiterature,
  parseLiteratureMetadata,
  parseMetaLiterature,
  parseProvenance,
  parseReportEnd,
  parseReference,
  parseStableFailure,
  parseStrictJsonObject,
  parseLibraryQuery,
} from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/compat-v1/records.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

function rejects(value: unknown, parser: (input: unknown) => unknown): void {
  expect(() => parser(value)).toThrow(ContractValidationError);
}

describe("closed provider-neutral contracts", () => {
  it("parses every synthetic v1 record at the boundary", () => {
    expect(parseProvenance(fixture.provenance).source_name).toBe(
      "fixture-provider",
    );
    expect(
      parseLiteratureMetadata(fixture.metadata).authors[0]?.display_name,
    ).toBe("Ada Lovelace");
    expect(parseLibraryQuery(fixture.query).publication_year_from).toBe(2020);
    expect(parseAsset(fixture.asset).path).toBe("objects/aa/synthetic.pdf");
    expect(parseReference(fixture.relation).source_literature_id).toBe(
      fixture.relation &&
        (fixture.relation as Record<string, unknown>).source_literature_id,
    );
    expect(
      parseMetaLiterature(fixture.literature).representative_literature_id,
    ).toBe("00000000-0000-0000-0000-000000000004");
    expect(
      parseLiterature({
        literature_id: "00000000-0000-0000-0000-000000000004",
        meta_literature_id: "00000000-0000-0000-0000-000000000006",
        version_role: "published",
        metadata: fixture.metadata,
        status: "UNREVIEWED",
      }).status,
    ).toBe("UNREVIEWED");
  });

  it("rejects unknown fields, null where text is required, and cross-field violations", () => {
    rejects(
      { ...(fixture.provenance as object), secret: "discarded" },
      parseProvenance,
    );
    rejects({ ...(fixture.asset as object), media_type: null }, parseAsset);
    rejects(
      {
        ...(fixture.relation as object),
        target_literature_id: (fixture.relation as Record<string, unknown>)
          .source_literature_id,
      },
      parseReference,
    );
    rejects(
      {
        ...(fixture.query as object),
        publication_year_from: 2030,
        publication_year_to: 2020,
      },
      parseLibraryQuery,
    );
    rejects(
      {
        ...(fixture.metadata as object),
        authors: [
          {
            display_name: "Ada Lovelace",
            kind: "unknown",
          },
        ],
      },
      parseLiteratureMetadata,
    );
  });

  it("normalizes boundary text and keeps returned collections immutable", () => {
    const identifier = parseIdentifier({
      namespace: " DOI ",
      value: "DOI:10.1234/Fixture.1",
    });
    expect(identifier).toEqual({
      namespace: "doi",
      value: "10.1234/fixture.1",
    });
    const metadata = parseLiteratureMetadata(fixture.metadata);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.authors)).toBe(true);
  });

  it("does not expose rejected input in the stable failure shape", () => {
    const error = (() => {
      try {
        parseStableFailure({
          code: "secret",
          reason: "token=abc",
          action: "retry",
          retryable: true,
        });
      } catch (caught) {
        return caught as ContractValidationError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ContractValidationError);
    expect(error?.message).toBe("contract validation failed");
    expect(JSON.stringify(error)).not.toContain("token=abc");
  });

  it("requires the exact report end shape and a failure only for failed reports", () => {
    expect(parseReportEnd({ kind: "finished" })).toEqual({ kind: "finished" });
    expect(
      parseReportEnd({
        kind: "failed",
        failure: {
          code: "timeout",
          reason: "retry later",
          action: "retry",
          retryable: true,
        },
      }).kind,
    ).toBe("failed");
    rejects(
      {
        kind: "finished",
        failure: { code: "x", reason: "y", action: "z", retryable: false },
      },
      parseReportEnd,
    );
    rejects({ kind: "failed" }, parseReportEnd);
  });
});

const completionIds = {
  completed: "00000000-0000-0000-0000-00000000000a",
  parserFailed: "00000000-0000-0000-0000-00000000000b",
  skipped: "00000000-0000-0000-0000-00000000000c",
  notStarted: "00000000-0000-0000-0000-00000000000d",
  interrupted: "00000000-0000-0000-0000-00000000000e",
  meta: "00000000-0000-0000-0000-00000000000f",
} as const;

const completionFailure = {
  code: "parser-unavailable",
  reason: "parser service did not answer",
  action: "retry the target later",
  retryable: true,
};

function completionReport(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "database-completion",
    end: { kind: "interrupted" },
    goal: "CONTENT_READY",
    completed: [
      {
        target: { kind: "literature", literature_id: completionIds.completed },
        literature_id: completionIds.completed,
      },
    ],
    failed: [
      {
        target: {
          kind: "meta-literature",
          meta_literature_id: completionIds.meta,
        },
        literature_id: completionIds.parserFailed,
        stage: "parsing",
        failure: { ...completionFailure },
      },
    ],
    skipped: [
      {
        target: { kind: "literature", literature_id: completionIds.skipped },
        reason: "manual-pdf-required",
        literature_ids: [completionIds.skipped],
      },
    ],
    notStarted: [
      {
        target: {
          kind: "literature",
          literature_id: completionIds.notStarted,
        },
      },
    ],
    interrupted: [
      {
        target: {
          kind: "literature",
          literature_id: completionIds.interrupted,
        },
        literature_id: null,
      },
    ],
    no_usable_content_literature_ids: [completionIds.completed],
    ...overrides,
  };
}

describe("database completion report contract", () => {
  it("parses the five mutually exclusive partitions in contract order", () => {
    const report = parseDatabaseCompletionReport(completionReport());
    expect(DATABASE_COMPLETION_REPORT_PARTITIONS).toEqual([
      "completed",
      "failed",
      "skipped",
      "notStarted",
      "interrupted",
    ]);
    expect(Object.keys(report)).toEqual([
      "kind",
      "end",
      "goal",
      "completed",
      "failed",
      "skipped",
      "notStarted",
      "interrupted",
      "no_usable_content_literature_ids",
    ]);
    expect(report.completed[0]?.literature_id).toBe(completionIds.completed);
    expect(report.failed[0]?.stage).toBe("parsing");
    expect(report.failed[0]?.literature_id).toBe(completionIds.parserFailed);
    expect(report.failed[0]?.failure).toEqual(completionFailure);
    expect(report.skipped[0]?.reason).toBe("manual-pdf-required");
    expect(report.notStarted[0]?.target.kind).toBe("literature");
    expect(report.interrupted[0]?.literature_id).toBeNull();
    expect(report.no_usable_content_literature_ids).toEqual([
      completionIds.completed,
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.completed)).toBe(true);
    expect(Object.isFrozen(report.skipped)).toBe(true);
    expect(Object.isFrozen(report.skipped[0])).toBe(true);
    expect(Object.isFrozen(report.skipped[0]?.literature_ids)).toBe(true);
  });

  it("keeps cleanup feedback overlapping a final partition", () => {
    const report = parseDatabaseCompletionReport(
      completionReport({
        no_usable_content_literature_ids: [
          completionIds.completed,
          completionIds.skipped,
        ],
      }),
    );
    expect(report.completed[0]?.literature_id).toBe(completionIds.completed);
    expect(report.skipped[0]?.target.kind).toBe("literature");
    expect(report.no_usable_content_literature_ids).toEqual([
      completionIds.completed,
      completionIds.skipped,
    ]);
  });

  it("accepts empty partitions and all three report endings", () => {
    expect(
      parseDatabaseCompletionReport({
        kind: "database-completion",
        end: { kind: "finished" },
        goal: "ASSET_READY",
        completed: [],
        failed: [],
        skipped: [],
        notStarted: [],
        interrupted: [],
        no_usable_content_literature_ids: [],
      }).end,
    ).toEqual({ kind: "finished" });
    expect(parseDatabaseCompletionReport(completionReport()).end).toEqual({
      kind: "interrupted",
    });
    expect(
      parseDatabaseCompletionReport(
        completionReport({
          end: { kind: "failed", failure: completionFailure },
        }),
      ).end,
    ).toEqual({ kind: "failed", failure: completionFailure });
  });

  it("rejects a frozen target that appears twice in one report", () => {
    const error = (() => {
      try {
        parseDatabaseCompletionReport(
          completionReport({
            skipped: [
              {
                target: {
                  kind: "literature",
                  literature_id: completionIds.completed,
                },
                reason: "already-satisfied",
                literature_ids: [],
              },
            ],
          }),
        );
      } catch (caught) {
        return caught as ContractValidationError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ContractValidationError);
    expect(error?.path).toEqual(["skipped", "0", "target"]);
    rejects(
      completionReport({
        notStarted: [
          {
            target: {
              kind: "meta-literature",
              meta_literature_id: completionIds.meta,
            },
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        completed: [
          {
            target: {
              kind: "literature",
              literature_id: completionIds.completed,
            },
            literature_id: completionIds.completed,
          },
          {
            target: {
              kind: "literature",
              literature_id: completionIds.completed,
            },
            literature_id: completionIds.completed,
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
  });

  it("rejects unknown partitions, missing partitions and unknown item fields", () => {
    rejects(
      { ...completionReport(), aborted: [] },
      parseDatabaseCompletionReport,
    );
    const missingPartition = completionReport();
    delete missingPartition.notStarted;
    rejects(missingPartition, parseDatabaseCompletionReport);
    rejects(
      completionReport({
        completed: [
          {
            target: {
              kind: "literature",
              literature_id: completionIds.completed,
            },
            literature_id: completionIds.completed,
            details: "free-form",
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        interrupted: [
          {
            target: {
              kind: "literature",
              literature_id: completionIds.interrupted,
            },
            literature_id: null,
            reason: "user",
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
  });

  it("rejects an invalid end status and a finished report with interrupted targets", () => {
    rejects(
      completionReport({ end: { kind: "cancelled" } }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({ end: { kind: "failed" } }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        end: { kind: "finished", failure: completionFailure },
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({ end: { kind: "finished" } }),
      parseDatabaseCompletionReport,
    );
  });

  it("validates item stages, skipped reasons and stable failures", () => {
    rejects(
      completionReport({
        failed: [
          {
            target: {
              kind: "meta-literature",
              meta_literature_id: completionIds.meta,
            },
            literature_id: null,
            stage: "discovery",
            failure: completionFailure,
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        skipped: [
          {
            target: {
              kind: "literature",
              literature_id: completionIds.skipped,
            },
            reason: "failed",
            literature_ids: [],
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        skipped: [
          {
            target: {
              kind: "literature",
              literature_id: completionIds.skipped,
            },
            reason: "not-eligible",
            literature_ids: [completionIds.skipped, completionIds.skipped],
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        no_usable_content_literature_ids: [
          completionIds.completed,
          completionIds.completed,
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        completed: [
          {
            target: {
              kind: "literature",
              literature_id: completionIds.completed,
            },
            literature_id: null,
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        failed: [
          {
            target: { kind: "literature", literature_id: completionIds.meta },
            literature_id: null,
            stage: "analysis",
            failure: {
              ...completionFailure,
              reason: "see https://example.test/run/42",
            },
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        failed: [
          {
            target: {
              kind: "meta-literature",
              meta_literature_id: completionIds.meta,
            },
            literature_id: null,
            stage: "literature",
            failure: {
              ...completionFailure,
              action: "inspect /var/tmp/run.log",
            },
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
    rejects(
      completionReport({
        failed: [
          {
            target: {
              kind: "meta-literature",
              meta_literature_id: completionIds.meta,
            },
            literature_id: null,
            stage: "acquisition",
            failure: { ...completionFailure, reason: "token=abc123" },
          },
        ],
      }),
      parseDatabaseCompletionReport,
    );
  });

  it("parses both completion target kinds and rejects an unknown kind", () => {
    expect(
      parseCompletionTarget({
        kind: "meta-literature",
        meta_literature_id: completionIds.meta,
      }),
    ).toEqual({
      kind: "meta-literature",
      meta_literature_id: completionIds.meta,
    });
    expect(
      parseCompletionTarget({
        kind: "literature",
        literature_id: completionIds.completed,
      }),
    ).toEqual({
      kind: "literature",
      literature_id: completionIds.completed,
    });
    rejects(
      { kind: "discovery-run", discovery_run_id: completionIds.meta },
      parseCompletionTarget,
    );
    rejects(
      { kind: "meta-literature", literature_id: completionIds.meta },
      parseCompletionTarget,
    );
  });

  it("round-trips through canonical JSON and rejects duplicate JSON keys", () => {
    const report = parseDatabaseCompletionReport(completionReport());
    const bytes = canonicalJsonBytes(report);
    expect(parseDatabaseCompletionReport(parseStrictJsonObject(bytes))).toEqual(
      report,
    );
    expect(() =>
      parseStrictJsonObject('{"completed":[],"completed":[]}'),
    ).toThrow(ContractValidationError);
    rejects(
      parseStrictJsonObject(
        JSON.stringify({ ...completionReport(), goal: "ARCHIVED" }),
      ),
      parseDatabaseCompletionReport,
    );
  });
});
