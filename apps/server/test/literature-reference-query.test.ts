import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  parseLiterature,
  parseReference,
  parseReferenceDetail,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it("reads supported references in both directions with stable v1 pagination and exact support locators", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-reference-query-"));
  const app = await createApplication(home);
  try {
    for (const [n, title, year] of [
      [1, "Source", 2025],
      [2, "Zulu", 2026],
      [3, "Alpha", 2026],
      [4, null, 2026],
      [5, "Aaron", null],
      [6, "Unsupported", 2027],
    ] as const) {
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n),
          meta_literature_id: id(n + 100),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title,
            publication_year: year,
            identifiers: [{ namespace: "doi", value: `10.5555/ref.${n}` }],
          },
        }),
      );
    }
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
      version_role: "published",
      reference_count: 900,
      cited_by_count: 800,
      metadata: FIXTURE_LITERATURE.metadata,
      declared_keywords: [],
      reference_texts: [
        "Zulu source text",
        "Alpha source text",
        "Untitled source text",
        "Undated source text",
      ],
    });
    for (let n = 2; n <= 6; n++) {
      await app.references.publish(
        parseReference({
          reference_id: id(n + 300),
          source_literature_id: id(1),
          target_literature_id: id(n),
        }),
      );
      if (n < 6)
        await app.references.supportWithMetadataReferenceText(
          id(n + 300),
          id(200),
          n - 2,
        );
    }
    await app.observations.publishProviderRelation({
      observation_id: id(210),
      provenance: provenance(211),
      citing: {
        record_id: null,
        identifiers: [{ namespace: "doi", value: "10.5555/ref.1" }],
      },
      cited: {
        record_id: null,
        identifiers: [{ namespace: "doi", value: "10.5555/ref.3" }],
      },
    });
    await app.references.supportWithProviderObservation(id(303), id(210));
    await app.references.supportWithProviderObservation(id(303), id(210));
    const request = { literature_id: id(1), direction: "references" as const };
    const first = await app.library.references({ ...request, limit: 1 });
    expect(first.total_count).toBe(4);
    expect(first.items[0]?.related_literature.literature.literature_id).toBe(
      id(3),
    );
    expect(first.items[0]?.support_count).toBe(2);
    expect(first.items[0]).not.toHaveProperty("supports");
    const second = await app.library.references({
      ...request,
      cursor: first.next_cursor,
      limit: 2,
    });
    expect(
      second.items.map(
        (item) => item.related_literature.literature.literature_id,
      ),
    ).toEqual([id(2), id(4)]);
    const last = await app.library.references({
      ...request,
      cursor: second.next_cursor,
    });
    expect(
      last.items.map(
        (item) => item.related_literature.literature.literature_id,
      ),
    ).toEqual([id(5)]);
    expect(last.next_cursor).toBeNull();
    const inverse = await app.library.references({
      literature_id: id(3),
      direction: "cited-by",
    });
    expect(inverse.total_count).toBe(1);
    expect(inverse.items[0]?.reference).toEqual(first.items[0]?.reference);
    expect(inverse.items[0]?.related_literature.literature.literature_id).toBe(
      id(1),
    );
    const detail = await app.library.referenceDetail(id(303));
    expect(detail.source.literature.literature_id).toBe(id(1));
    expect(detail.target.literature.literature_id).toBe(id(3));
    expect(detail.supports).toEqual([
      {
        reference_id: id(303),
        source: { kind: "provider_relation", observation_id: id(210) },
      },
      {
        reference_id: id(303),
        source: {
          kind: "metadata_reference_text",
          metadata_observation_id: id(200),
          reference_index: 1,
        },
      },
    ]);
    expect(Object.isFrozen(detail.supports[0]?.source)).toBe(true);
    expect(() =>
      parseReferenceDetail({ ...detail, target: detail.source }),
    ).toThrow();
    expect(() =>
      parseReferenceDetail({
        ...detail,
        supports: [...detail.supports, detail.supports[0]],
      }),
    ).toThrow();
    await expect(app.library.referenceDetail(id(306))).rejects.toMatchObject({
      code: "literature-not-found",
    });
    await expect(
      app.library.references({
        literature_id: id(999),
        direction: "references",
      }),
    ).rejects.toMatchObject({ code: "literature-not-found" });
    expect(
      (
        await app.library.references({
          literature_id: id(6),
          direction: "references",
        })
      ).total_count,
    ).toBe(0);
    for (const invalid of [
      { ...request, direction: "cited-by", cursor: first.next_cursor },
      { ...request, literature_id: id(2), cursor: first.next_cursor },
      { ...request, cursor: first.next_cursor! + "=" },
      { ...request, cursor: "x".repeat(65537) },
      { ...request, limit: 0 },
      { ...request, query: {} },
    ])
      await expect(app.library.references(invalid)).rejects.toThrow();
    for (const cursor of [first.next_cursor!, second.next_cursor!]) {
      const raw = Buffer.from(cursor, "base64url").toString("utf8");
      expect(JSON.parse(raw)).toMatchObject({
        kind: "literature-references",
        version: 1,
        payload: {
          literature_id: request.literature_id,
          direction: request.direction,
        },
      });
      expect(Buffer.from(raw).toString("base64url")).toBe(cursor);
    }
    // A valid foreign key alone does not prove that a text belongs to the citing endpoint.
    const raw = new DatabaseSync(join(home, "catalog.sqlite"));
    try {
      raw
        .prepare(
          "UPDATE literature_metadata_observations SET literature_id=? WHERE observation_id=?",
        )
        .run(id(6), id(200));
    } finally {
      raw.close();
    }
    await expect(app.library.references(request)).rejects.toMatchObject({
      code: "sqlite-worker",
    });
    await expect(app.library.referenceDetail(id(303))).rejects.toMatchObject({
      code: "sqlite-worker",
    });
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
