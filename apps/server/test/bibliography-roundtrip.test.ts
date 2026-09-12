import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import {
  decodeBibliography,
  importBibliography,
  type BibliographyInputFormat,
} from "../src/entry/bibliography.js";
import { exportBibliographyBatch } from "../src/literature/bibliography.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (value: number) =>
  `00000000-0000-4000-9a00-${String(value).padStart(12, "0")}`;

describe("bibliography format round trips", () => {
  it("exports, decodes and reimports ordered records without losing DOI or author order", async () => {
    const sourceHome = await mkdtemp(
      join(tmpdir(), "sciretriever-bibliography-source-"),
    );
    const source = await createApplication(sourceHome);
    const literatureIds = [id(1), id(2)];
    try {
      for (const [index, literatureId] of literatureIds.entries()) {
        await source.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: literatureId,
            meta_literature_id: id(101 + index),
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title: `Round trip ${index + 1}`,
              authors: [
                {
                  kind: "person",
                  display_name: "Lovelace, Ada",
                  given_name: "Ada",
                  family_name: "Lovelace",
                  orcid: "0000-0002-1825-0097",
                  affiliations: [],
                },
                {
                  kind: "organization",
                  display_name: "Example Consortium",
                  given_name: null,
                  family_name: null,
                  orcid: null,
                  affiliations: [],
                },
              ],
              identifiers: [
                { namespace: "doi", value: `10.1000/round-trip.${index + 1}` },
              ],
            },
          }),
        );
      }
      const details = await Promise.all(
        literatureIds.map((literatureId) =>
          source.library.detail(literatureId),
        ),
      );
      for (const format of [
        "bibtex",
        "biblatex",
        "ris",
        "csl-json",
      ] as const satisfies readonly BibliographyInputFormat[]) {
        const payload = exportBibliographyBatch(details, format);
        const decoded = decodeBibliography(payload, format, {
          observedAt: () => "2026-09-11T00:00:00Z",
        });
        expect(decoded.items.map((item) => item.status)).toEqual([
          "decoded",
          "decoded",
        ]);
        const targetHome = await mkdtemp(
          join(tmpdir(), `sciretriever-bibliography-${format}-`),
        );
        const target = await createApplication(targetHome);
        try {
          const imported = await importBibliography(decoded, target.identity);
          expect(imported.items.map((item) => item.disposition)).toEqual([
            "created",
            "created",
          ]);
          for (const [index, item] of imported.items.entries()) {
            const detail = await target.library.detail(item.literature_id!);
            expect(detail.literature.metadata.identifiers).toContainEqual({
              namespace: "doi",
              value: `10.1000/round-trip.${index + 1}`,
            });
            expect(detail.literature.metadata.authors).toHaveLength(2);
            expect(detail.literature.metadata.authors[0]?.family_name).toBe(
              "Lovelace",
            );
            expect(detail.literature.metadata.authors[1]?.display_name).toBe(
              "Example Consortium",
            );
          }
        } finally {
          await target.close();
          await rm(targetHome, { recursive: true, force: true });
        }
      }
    } finally {
      await source.close();
      await rm(sourceHome, { recursive: true, force: true });
    }
  });
});
