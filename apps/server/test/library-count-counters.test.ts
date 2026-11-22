import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseLiterature,
  parseAsset,
  parseLiteratureId,
} from "@sciretriever/contracts";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { LiteratureQueryService } from "../src/literature/query.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-11-22T00:00:00.000Z";
const paper = (n: number, meta: number) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(meta),
    version_role: n === 1 ? "preprint" : "published",
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `Synthetic ${n}`,
      publication_year: 2020,
      identifiers: [],
    },
  });

async function drain(worker: SqliteWorker) {
  for (let n = 0; n < 20; n++)
    if (!(await worker.refreshLibraryState()).more) return;
  throw new Error("backfill failed to finish");
}

it("repairs only changed papers, preserving the old owner and checking uncollected sibling PDFs", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-count-counters-"));
  const path = join(home, "catalog.sqlite");
  const db = new DatabaseSync(path);
  const worker = new SqliteWorker(path);
  const second = new SqliteWorker(path);
  const service = new LiteratureQueryService(worker);
  function exec(sql: string) {
    db.exec(sql);
  }
  const compare = async () => {
    expect(await worker.libraryStatePending()).toBe(false);
    for (const collection_scope of ["all", "collected"] as const) {
      const global = await service.counts({ collection_scope });
      const alone = await service.exactCount({
        kind: "counts",
        query: { collection_scope, publication_year_from: 1 },
      });
      if (alone.kind !== "counts") throw new Error("Expected counts");
      const { collection_counts, ...versions } = global;
      expect(versions).toEqual(alone.counts);
      if (collection_counts)
        expect(collection_counts).toEqual({
          collected: (await service.counts({ collection_scope: "collected" }))
            .total,
          discovered_only: global.total - collection_counts.collected,
        });
    }
  };
  try {
    initializeCurrentCatalog(db);
    exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    await worker.configureLibraryState(6, "vlm-engine");
    await worker.putLiterature(paper(1, 101));
    await worker.putLiterature(paper(2, 101));
    await worker.collectLiteratures([parseLiteratureId(id(1))]);
    await Promise.all([
      worker.putLiterature(paper(3, 103)),
      second.putLiterature(paper(4, 104)),
    ]);
    await worker.putLiteratureAsset({
      literature_asset_id: id(41),
      literature_id: id(2),
      role: "primary-pdf",
      asset: parseAsset({
        asset_id: id(42),
        sha256: "f".repeat(64),
        size_bytes: 8,
        media_type: "application/pdf",
        path: "objects/synthetic.pdf",
      }),
      provenance: {
        provenance_id: id(43),
        source_kind: "user",
        source_name: "synthetic",
        source_record_id: null,
        observed_at: at,
        input_sha256: null,
        parameters_sha256: null,
      },
      source_url: null,
    });
    expect(
      await service.counts({ collection_scope: "collected" }),
    ).toMatchObject({
      total: 1,
      with_primary_pdf: 0,
      full_text: { total: 1, obtained: 1 },
    });
    await compare();

    await worker.setAutomaticPdfExhaustion(id(1));
    db.prepare(
      "INSERT INTO automatic_pdf_acquisition_exhaustions VALUES(?)",
    ).run(id(3));
    expect(await worker.libraryStatePending()).toBe(true);
    expect((await service.counts({})).unavailable_pdf).toBe(2);
    await drain(worker);
    await compare();

    db.prepare(
      `INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,finished_at,state,result,initiated_by,request_json)
      VALUES(?,'import','Synthetic','web',?,?,'finished','completed','local:web','{}')`,
    ).run(id(60), at, at);
    const mark = db.prepare(
      "INSERT INTO intake_withdrawn_objects VALUES(?,?,?,?)",
    );
    mark.run("literature-asset", id(41), id(60), at);
    mark.run("literature", id(4), id(60), at);
    const dirty = db.prepare(
      "SELECT meta_literature_id FROM library_count_dirty ORDER BY meta_literature_id",
    );
    expect(dirty.all()).toEqual([
      { meta_literature_id: id(101) },
      { meta_literature_id: id(104) },
    ]);
    expect(await service.counts({})).toMatchObject({
      total: 3,
      with_primary_pdf: 0,
      full_text: { obtained: 0 },
    });
    await drain(worker);
    await compare();
    exec("DELETE FROM intake_withdrawn_objects");
    await drain(worker);
    await compare();

    exec("BEGIN");
    db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(id(102), id(2));
    db.prepare(
      "UPDATE literatures SET meta_literature_id=? WHERE literature_id=?",
    ).run(id(102), id(2));
    exec("COMMIT");
    expect(dirty.all()).toEqual([{ meta_literature_id: id(101) }]);
    await drain(worker);
    expect(
      (await service.counts({ collection_scope: "collected" })).full_text
        .obtained,
    ).toBe(0);
    await compare();

    exec("BEGIN; PRAGMA defer_foreign_keys=ON");
    db.prepare("DELETE FROM literatures WHERE literature_id=?").run(id(4));
    db.prepare("DELETE FROM meta_literatures WHERE meta_literature_id=?").run(
      id(104),
    );
    exec("COMMIT");
    await drain(worker);
    expect((await service.counts({})).total).toBe(3);
    await compare();

    await worker.putLiterature(
      parseLiterature({
        ...paper(2, 102),
        metadata: {
          ...paper(2, 102).metadata,
          article_kind: "correction-or-editorial",
        },
      }),
    );
    expect((await service.counts({})).statuses.ASSET_READY).toBe(1);
    await compare();
    await worker.configureLibraryState(4, "pipeline");
    expect((await service.counts({})).status_updating).toBe(true);
    await drain(worker);
    await compare();
  } finally {
    db.close();
    await second.close();
    await worker.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("resumes the persisted paper cursor and repairs IDs behind it", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-count-backfill-"));
  const path = join(home, "catalog.sqlite");
  const db = new DatabaseSync(path);
  let worker = new SqliteWorker(path);
  try {
    initializeCurrentCatalog(db);
    db.exec("PRAGMA journal_mode=WAL; BEGIN");
    const meta = db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const version = db.prepare(
      "INSERT INTO literatures VALUES(?,?,'published')",
    );
    const metadata = db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,'Synthetic')",
    );
    const write = (n: number) => {
      meta.run(id(n), id(n));
      version.run(id(n), id(n));
      metadata.run(id(n), "a".repeat(64));
    };
    for (let n = 1; n <= 520; n++) write(n);
    db.exec("COMMIT");
    await worker.configureLibraryState(6, "vlm-engine");
    const cursor = db.prepare("SELECT * FROM library_count_progress");
    for (let i = 0; i < 5 && cursor.get()?.after_id === ""; i++)
      await worker.refreshLibraryState();
    expect(cursor.get()).toMatchObject({ ready: 0, after_id: id(256) });
    expect(await new LiteratureQueryService(worker).counts({})).toMatchObject({
      total: 520,
      counts_backfill_pending: true,
    });
    await worker.close();
    db.exec("BEGIN");
    write(0);
    db.prepare(
      "INSERT INTO automatic_pdf_acquisition_exhaustions VALUES(?)",
    ).run(id(1));
    db.exec("COMMIT");
    worker = new SqliteWorker(path);
    expect(cursor.get()?.after_id).toBe(id(256));
    await drain(worker);
    expect(await new LiteratureQueryService(worker).counts({})).toMatchObject({
      total: 521,
      unavailable_pdf: 1,
      full_text: { total: 521, exhausted: 1 },
    });
    expect(cursor.get()).toMatchObject({ ready: 1, after_id: id(520) });
  } finally {
    db.close();
    await worker.close();
    await rm(home, { recursive: true, force: true });
  }
});
