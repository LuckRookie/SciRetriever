import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseLiterature, parseAsset } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import type { SqliteCommand } from "../src/storage/sqlite/worker.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it("matches the existing query filter semantics and rejects incomplete discovery causes without conflating versions", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-query-integrity-"));
  const app = await createApplication(home);
  let raw: DatabaseSync | undefined;
  try {
    for (let n = 1; n <= 3; n++)
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n),
          meta_literature_id: id(n === 3 ? 102 : 101),
          version_role: n === 2 ? "preprint" : "published",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: n === 1 ? "Straße Alpha" : "Beta",
            publication_year: n === 3 ? null : 2020 + n,
            language: n === 1 ? "de" : "en",
            document_type: n === 1 ? "article" : "book",
            venue: n === 1 ? "Science Journal" : null,
            publisher: n === 1 ? "Example Press" : null,
            keywords: n === 1 ? ["alpha", "beta"] : ["beta"],
            identifiers: [
              { namespace: "doi", value: `10.5555/integrity.${n}` },
            ],
            authors:
              n === 1
                ? [
                    {
                      kind: "person",
                      display_name: "Lina Straße",
                      given_name: "Lina",
                      family_name: "Straße",
                      orcid: "0000-0002-1825-0097",
                      affiliations: [{ name: "Example Institute", ror: null }],
                    },
                  ]
                : [],
          },
        }),
      );
    const provenance = (n: number) => ({
      provenance_id: id(n),
      source_kind: "metadata-provider" as const,
      source_name: "fixture",
      source_record_id: null,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: null,
      parameters_sha256: null,
    });
    await app.observations.publish({
      observation_id: id(200),
      literature_id: id(1),
      provenance: provenance(201),
      metadata: FIXTURE_LITERATURE.metadata,
      version_role: "published",
      reference_count: null,
      cited_by_count: null,
      declared_keywords: [],
      reference_texts: [],
    });
    raw = new DatabaseSync(join(home, "catalog.sqlite"));
    raw.exec("PRAGMA foreign_keys=ON");
    raw
      .prepare("INSERT INTO discovery_runs VALUES(?, 'topic', 'COMPLETED', ?)")
      .run(id(300), "2026-09-10T00:00:00Z");
    raw
      .prepare(
        "INSERT INTO topic_discovery_inputs VALUES(?, 'topic', 'fixture', NULL, NULL)",
      )
      .run(id(300));
    raw
      .prepare("INSERT INTO discovery_results VALUES(?,?)")
      .run(id(300), id(101));
    raw
      .prepare("INSERT INTO topic_discovery_causes VALUES(?,?,?,?)")
      .run(id(300), id(101), id(200), id(1));
    raw
      .prepare(
        "INSERT INTO discovery_runs VALUES(?, 'citation', 'COMPLETED', ?)",
      )
      .run(id(301), "2026-09-10T00:00:00Z");
    raw
      .prepare(
        "INSERT INTO citation_discovery_inputs VALUES(?, 'citation', 'references', 1, 10)",
      )
      .run(id(301));
    raw
      .prepare("INSERT INTO discovery_results VALUES(?,?)")
      .run(id(301), id(102));
    raw
      .prepare("INSERT INTO citation_discovery_causes VALUES(?,?,?,?,?,1)")
      .run(id(301), id(102), id(1), id(3), id(3));
    // The exhaustion fact is written through its public API; direct tests never fabricate it.
    await app.database.setAutomaticPdfExhaustion(id(1));
    await app.database.setAutomaticPdfExhaustion(id(1));
    expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(true);
    expect(
      raw
        .prepare(
          "SELECT count(*) AS n FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
        )
        .get(id(1)),
    ).toEqual({ n: 1 });
    const verify = async (
      cases: readonly {
        query: object;
        expected: readonly string[] | "rejected";
      }[],
    ) => {
      for (const { query, expected } of cases) {
        if (expected === "rejected") {
          await expect(app.library.search({ query })).rejects.toMatchObject({
            code: "sqlite-worker",
          });
          continue;
        }
        expect(
          (await app.library.search({ query })).items
            .map((item) => item.literature.literature_id)
            .sort(),
        ).toEqual([...expected].sort());
      }
    };
    await verify([
      { query: {}, expected: [id(1), id(2), id(3)] },
      { query: { text: "STRASSE" }, expected: [id(1)] },
      { query: { title: "STRASSE" }, expected: [id(1)] },
      { query: { author: "lina" }, expected: [id(1)] },
      { query: { author: "STRASSE" }, expected: [id(1)] },
      {
        query: { author_orcids: ["0000-0002-1825-0097"] },
        expected: [id(1)],
      },
      {
        query: {
          identifiers: [{ namespace: "doi", value: "10.5555/integrity.2" }],
        },
        expected: [id(2)],
      },
      { query: { publication_year_from: 2022 }, expected: [id(2)] },
      { query: { publication_year_to: 2021 }, expected: [id(1)] },
      { query: { venue: "SCIENCE" }, expected: [id(1)] },
      { query: { publisher: "press" }, expected: [id(1)] },
      { query: { languages: ["en"] }, expected: [id(2), id(3)] },
      {
        query: { document_types: ["book", "article"] },
        expected: [id(1), id(2), id(3)],
      },
      { query: { keywords: ["alpha", "beta"] }, expected: [id(1)] },
      { query: { version_roles: ["preprint"] }, expected: [id(2)] },
      {
        query: { statuses: ["UNREVIEWED"] },
        expected: [id(1), id(2), id(3)],
      },
      {
        query: { missing_steps: ["primary-pdf"] },
        expected: [id(1), id(2), id(3)],
      },
      { query: { needs_manual_pdf: true }, expected: [id(1)] },
      { query: { needs_manual_pdf: false }, expected: [id(2), id(3)] },
      { query: { discovery_run_ids: [id(300)] }, expected: [id(1)] },
      { query: { discovery_run_ids: [id(301)] }, expected: [id(3)] },
      {
        query: { discovery_run_ids: [id(300), id(301)] },
        expected: [id(1), id(3)],
      },
      { query: { discovery_run_ids: [id(999)] }, expected: [] },
      { query: { languages: ["en"], keywords: ["alpha"] }, expected: [] },
    ]);
    expect(
      (await app.library.search({ query: { discovery_run_ids: [id(300)] } }))
        .total_count,
    ).toBe(1);
    // A historical exhaustion marker and a current PDF are distinct facts: false means no marker.
    await app.database.putLiteratureAsset({
      literature_asset_id: id(402),
      literature_id: id(1),
      asset: parseAsset({
        asset_id: id(401),
        path: "assets/fixture.pdf",
        sha256: "a".repeat(64),
        size_bytes: 5,
        media_type: "application/pdf",
      }),
      role: "primary-pdf",
      provenance: provenance(403),
      source_url: null,
    });
    await verify([
      { query: { needs_manual_pdf: true }, expected: [] },
      { query: { needs_manual_pdf: false }, expected: [id(2), id(3)] },
      { query: { statuses: ["ASSET_READY"] }, expected: [id(1)] },
      { query: { missing_steps: ["parser-result"] }, expected: [id(1)] },
    ]);
    raw
      .prepare("DELETE FROM topic_discovery_causes WHERE discovery_run_id=?")
      .run(id(300));
    await verify([
      { query: { discovery_run_ids: [id(300)] }, expected: "rejected" },
      { query: { discovery_run_ids: [id(301)] }, expected: [id(3)] },
    ]);
    // The membership foreign keys may have been bypassed in a damaged catalog copy.
    raw.exec("PRAGMA foreign_keys=OFF");
    raw
      .prepare("INSERT INTO topic_discovery_causes VALUES(?,?,?,?)")
      .run(id(300), id(101), id(200), id(1));
    raw
      .prepare(
        "UPDATE topic_discovery_causes SET actual_literature_id=? WHERE discovery_run_id=?",
      )
      .run(id(2), id(300));
    await verify([
      { query: { discovery_run_ids: [id(300)] }, expected: "rejected" },
    ]);
    raw
      .prepare(
        "UPDATE citation_discovery_causes SET meta_literature_id=? WHERE discovery_run_id=?",
      )
      .run(id(101), id(301));
    await verify([
      { query: { discovery_run_ids: [id(301)] }, expected: "rejected" },
    ]);
    // Duplicate FTS rows cannot duplicate a literature or silently change relevance.
    raw
      .prepare(
        "INSERT INTO literature_search_fts SELECT * FROM literature_search_fts WHERE literature_id=?",
      )
      .run(id(1));
    await expect(
      app.library.search({ query: { text: "STRASSE" } }),
    ).rejects.toMatchObject({ code: "sqlite-worker" });
  } finally {
    raw?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
it("stores the automatic acquisition exhaustion fact only through a validated LiteratureId API", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-exhaustion-api-"));
  const app = await createApplication(home);
  let raw: DatabaseSync | undefined;
  try {
    for (const n of [1, 2])
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n),
          meta_literature_id: id(100 + n),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            identifiers: [
              { namespace: "doi", value: `10.5555/exhaustion.${n}` },
            ],
          },
        }),
      );
    // Idempotent set: one durable row per Literature and a correct read projection.
    await app.database.setAutomaticPdfExhaustion(id(1));
    await app.database.setAutomaticPdfExhaustion(id(1));
    expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(true);
    expect(await app.database.hasAutomaticPdfExhaustion(id(2))).toBe(false);
    expect(
      (
        await app.library.search({ query: { needs_manual_pdf: true } })
      ).items.map((item) => item.literature.literature_id),
    ).toEqual([id(1)]);
    expect(
      (
        await app.library.search({ query: { needs_manual_pdf: false } })
      ).items.map((item) => item.literature.literature_id),
    ).toEqual([id(2)]);
    // Unknown Literatures, non-identifier values and candidate/failure-shaped pseudo facts are refused.
    await expect(
      app.database.setAutomaticPdfExhaustion(id(999)),
    ).rejects.toMatchObject({ code: "sqlite-worker" });
    await expect(
      app.database.setAutomaticPdfExhaustion("first"),
    ).rejects.toMatchObject({ code: "sqlite-worker" });
    await expect(
      app.database.hasAutomaticPdfExhaustion(id(999)),
    ).rejects.toMatchObject({ code: "sqlite-worker" });
    await expect(
      app.database.clearAutomaticPdfExhaustion(id(999)),
    ).rejects.toMatchObject({ code: "sqlite-worker" });
    for (const pseudo of [
      {
        kind: "set_automatic_pdf_exhaustion",
        literatureId: id(1),
        transfer_id: "first",
      },
      {
        kind: "set_automatic_pdf_exhaustion",
        literatureId: id(1),
        failure_reason: "network",
      },
      { kind: "clear_automatic_pdf_exhaustion", literature_id: id(1) },
    ])
      await expect(
        app.database.run(pseudo as unknown as SqliteCommand),
      ).rejects.toMatchObject({ code: "sqlite-worker" });
    expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(true);
    // Clear is idempotent, and it never touches another Literature's fact.
    await app.database.setAutomaticPdfExhaustion(id(2));
    await app.database.clearAutomaticPdfExhaustion(id(1));
    await app.database.clearAutomaticPdfExhaustion(id(1));
    expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(false);
    expect(await app.database.hasAutomaticPdfExhaustion(id(2))).toBe(true);
    // The fact is owned by the Literature row: deleting the Literature cascades it away.
    raw = new DatabaseSync(join(home, "catalog.sqlite"));
    raw.exec("PRAGMA foreign_keys=ON");
    raw.exec("PRAGMA defer_foreign_keys=ON");
    raw.exec("BEGIN");
    raw.prepare("DELETE FROM literatures WHERE literature_id=?").run(id(2));
    raw
      .prepare("DELETE FROM meta_literatures WHERE meta_literature_id=?")
      .run(id(102));
    raw.exec("COMMIT");
    expect(
      raw
        .prepare(
          "SELECT count(*) AS n FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
        )
        .get(id(2)),
    ).toEqual({ n: 0 });
    // A closed application refuses further exhaustion writes and reads.
    await app.close();
    for (const operation of [
      () => app.database.setAutomaticPdfExhaustion(id(1)),
      () => app.database.clearAutomaticPdfExhaustion(id(1)),
      () => app.database.hasAutomaticPdfExhaustion(id(1)),
    ]) {
      let refusal: unknown;
      try {
        await operation();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      expect(["write-admission-closed", "sqlite-worker"]).toContain(
        (refusal as { readonly code?: string }).code,
      );
    }
  } finally {
    raw?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
