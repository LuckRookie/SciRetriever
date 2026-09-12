import { describe, expect, it } from "vitest";
import { assessPdfIdentity } from "../src/acquisition/pdf-evidence.js";
import {
  FIXTURE_DOI,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

describe("PDF content identity evidence", () => {
  it("accepts matching extractable identity and version from real PDF bytes", async () => {
    const result = await assessPdfIdentity(
      workbenchPdf(),
      `doi:${FIXTURE_DOI}`,
      "published",
    );
    expect(result.page_count).toBe(1);
    expect(result.verdict.disposition).toBe("accepted");
    expect(result.verdict.evidence).toContainEqual({
      kind: "identifier",
      value: `doi:${FIXTURE_DOI}`,
    });
  });
  it("keeps conflicting identity or version uncertain and rejects malformed input", async () => {
    expect(
      (
        await assessPdfIdentity(
          workbenchPdf("10.5555/another"),
          `doi:${FIXTURE_DOI}`,
          "published",
        )
      ).verdict.disposition,
    ).toBe("uncertain");
    expect(
      (
        await assessPdfIdentity(
          workbenchPdf(FIXTURE_DOI, "preprint"),
          `doi:${FIXTURE_DOI}`,
          "published",
        )
      ).verdict.disposition,
    ).toBe("uncertain");
    await expect(
      assessPdfIdentity(
        new TextEncoder().encode("%PDF-not-valid"),
        `doi:${FIXTURE_DOI}`,
        "published",
      ),
    ).rejects.toBeDefined();
    await expect(
      assessPdfIdentity(
        workbenchPdf(),
        `doi:${FIXTURE_DOI}`,
        "published",
        AbortSignal.abort(),
      ),
    ).rejects.toBeDefined();
  });
  it("keeps image-only pages uncertain because no identity text is available", async () => {
    const result = await assessPdfIdentity(
      workbenchPdf(FIXTURE_DOI, "published", false),
      `doi:${FIXTURE_DOI}`,
      "published",
    );
    expect(result.page_count).toBe(1);
    expect(result.verdict.disposition).toBe("uncertain");
    expect(result.verdict.evidence).toEqual([]);
  });
});
