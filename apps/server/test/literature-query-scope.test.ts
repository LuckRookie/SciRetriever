import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  parseLibrarySearchRequest,
  parseLiterature,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const emptyQuery = parseLibrarySearchRequest({ query: {} }).query;

it.each([11])(
  "isolates discovery queries from unrelated invalid metadata in catalog v%i while validating selected versions",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-query-scope-"));
    const app = await createApplication(home);
    let reader: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    let raw: DatabaseSync | undefined;
    try {
      for (const [n, meta, role, title] of [
        [1, 101, "preprint", "Needle first"],
        [2, 101, "published", "Other first version"],
        [3, 103, "published", "Needle second"],
        [4, 103, "preprint", "Other second version"],
        [5, 105, "published", "Needle legacy"],
      ] as const)
        await app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id(n),
            meta_literature_id: id(meta),
            version_role: role,
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title,
              identifiers: [{ namespace: "doi", value: `10.5555/scoped.${n}` }],
            },
          }),
        );
      await app.observations.publish({
        source_type: null,
        source_type_mapping_version: null,
        observation_id: id(200),
        literature_id: id(1),
        provenance: {
          provenance_id: id(201),
          source_kind: "metadata-provider",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-10-07T00:00:00Z",
          input_sha256: null,
          parameters_sha256: null,
        },
        metadata: FIXTURE_LITERATURE.metadata,
        version_role: "preprint",
        reference_count: null,
        cited_by_count: null,
        declared_keywords: [],
        reference_texts: [],
      });
      raw = new DatabaseSync(join(home, "catalog.sqlite"));
      raw.exec("PRAGMA foreign_keys=ON");
      raw
        .prepare(
          "INSERT INTO discovery_runs VALUES(?, 'topic', 'COMPLETED', ?)",
        )
        .run(id(300), "2026-10-07T00:00:00Z");
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
        .run(id(301), "2026-10-07T00:00:00Z");
      raw
        .prepare(
          "INSERT INTO citation_discovery_inputs VALUES(?, 'citation', 'references', 1, 10)",
        )
        .run(id(301));
      raw
        .prepare("INSERT INTO discovery_results VALUES(?,?)")
        .run(id(301), id(103));
      raw
        .prepare("INSERT INTO citation_discovery_causes VALUES(?,?,?,?,?,1)")
        .run(id(301), id(103), id(1), id(3), id(3));
      // Older catalogs can contain a TEXT value rejected by today's domain contract.
      const damageAbstract = (n: number) =>
        raw!
          .prepare(
            "UPDATE literature_metadata SET abstract='' WHERE literature_id=?",
          )
          .run(id(n));
      damageAbstract(5);
      reader = await createQueryApplication(home);
      expect(reader.readiness).toMatchObject({
        status: "ready",
        schema_version: version,
      });
      const query = reader.query!;
      const items = (runIds: readonly string[], text: string | null = null) =>
        query.search({
          query: { discovery_run_ids: runIds, text },
          sort: "title-asc",
        });

      expect(
        (await items([id(300)])).items.map(
          (item) => item.literature.literature_id,
        ),
      ).toEqual([id(1)]);
      expect(
        (await items([id(301)])).items.map(
          (item) => item.literature.literature_id,
        ),
      ).toEqual([id(3)]);
      expect(
        (await items([id(300), id(301), id(300)])).items.map(
          (item) => item.literature.literature_id,
        ),
      ).toEqual([id(1), id(3)]);
      expect(
        (await items([id(300)], "Needle")).items.map(
          (item) => item.literature.literature_id,
        ),
      ).toEqual([id(1)]);
      expect((await items([id(999)])).total_count).toBe(0);
      expect((await items([id(300)], "Other")).total_count).toBe(0);
      await expect(items([])).rejects.toMatchObject({
        code: "invalid-contract",
        path: ["abstract"],
      });

      const read = vi.spyOn(app.database, "librarySnapshot");
      const selected = await app.library.selectionSnapshot({
        ...emptyQuery,
        discovery_run_ids: [id(300)],
      });
      expect(
        selected.matches.map((item) => item.literature.literature_id),
      ).toEqual([id(1)]);
      expect(
        selected.members.map((item) => item.literature.literature_id),
      ).toEqual([id(1), id(2)]);
      expect(read).toHaveBeenCalledTimes(1);
      const combined = await app.library.selectionSnapshot({
        ...emptyQuery,
        discovery_run_ids: [id(300), id(301)],
        text: "Needle",
      });
      expect(
        combined.matches.map((item) => item.literature.literature_id).sort(),
      ).toEqual([id(1), id(3)]);
      expect(
        combined.members.map((item) => item.literature.literature_id),
      ).toEqual([id(1), id(2), id(3), id(4)]);
      expect(
        await app.library.selectionSnapshot({
          ...emptyQuery,
          discovery_run_ids: [id(300)],
          text: "Other",
        }),
      ).toEqual({ matches: [], members: [] });

      // FTS and explicit IDs compose with the discovery scope rather than widening it.
      expect(
        (
          await app.database.librarySnapshot('"needle"', [id(300)], false, [
            id(3),
          ])
        ).length,
      ).toBe(0);
      expect(
        (
          await app.database.librarySnapshot(
            '"needle"',
            [id(300)],
            false,
            [],
            [id(103)],
          )
        ).length,
      ).toBe(0);

      // Search needs only the caused version; Entry needs every sibling's valid facts.
      damageAbstract(2);
      expect((await items([id(300)])).total_count).toBe(1);
      await expect(
        app.library.selectionSnapshot({
          ...emptyQuery,
          discovery_run_ids: [id(300)],
        }),
      ).rejects.toMatchObject({ code: "invalid-contract", path: ["abstract"] });
      damageAbstract(1);
      await expect(items([id(300)])).rejects.toMatchObject({
        code: "invalid-contract",
        path: ["abstract"],
      });
      expect(
        raw
          .prepare(
            "SELECT abstract FROM literature_metadata WHERE literature_id=?",
          )
          .get(id(5)),
      ).toEqual({ abstract: "" });
    } finally {
      vi.restoreAllMocks();
      raw?.close();
      await reader?.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
