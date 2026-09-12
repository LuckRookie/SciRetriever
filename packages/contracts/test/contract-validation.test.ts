import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  parseAsset,
  parseIdentifier,
  parseLiterature,
  parseLiteratureMetadata,
  parseMetaLiterature,
  parseProvenance,
  parseReportEnd,
  parseReference,
  parseStableFailure,
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
