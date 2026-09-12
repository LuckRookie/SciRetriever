import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCrossrefRecord } from "../src/metadata/crossref-fixture.js";

it("maps a representative Crossref record into the neutral observation contract", async () => {
  const payload = JSON.parse(
    await readFile(
      resolve("tests/fixtures/metadata/crossref/search-page-1.json"),
      "utf8",
    ),
  ) as { message: { items: unknown[] } };
  const observation = await parseCrossrefRecord(payload.message.items[0], {
    observation_id: "00000000-0000-0000-0000-000000000701",
    provenance_id: "00000000-0000-0000-0000-000000000702",
    observed_at: "2026-09-10T00:00:00Z",
    parameters_sha256: "b".repeat(64),
  });
  expect(observation.provenance.source_name).toBe("crossref");
  expect(observation.metadata.title).toBe("A Crossref record");
  expect(observation.metadata.authors[0]).toMatchObject({
    kind: "person",
    display_name: "Ada Lovelace",
    orcid: "0000-0002-1825-0097",
  });
  expect(observation.metadata.authors[1]).toMatchObject({
    kind: "organization",
    display_name: "Crossref Research Consortium",
  });
  expect(observation.metadata.abstract).toBe("A safe abstract.");
  expect(observation.metadata.publication_date).toBe("2024-03-02");
  expect(observation.reference_texts).toHaveLength(4);
  expect(observation.asset_hints.length).toBeGreaterThanOrEqual(2);
  expect(observation.asset_hints.map((hint) => hint.url)).not.toContain(
    "https://assets.example.org/signed.pdf?signature=fixture-secret",
  );
  expect(observation.declared_keywords).toEqual([]);
});
