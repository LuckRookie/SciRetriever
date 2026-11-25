import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseLibraryCounts } from "@sciretriever/contracts";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import { SqliteReadLane, SqliteWorker } from "../src/storage/sqlite/worker.js";
import { LiteratureQueryService } from "../src/literature/query.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("counts each material category on its own past the count limit", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-material-counts-"));
  const path = join(home, "catalog.sqlite");
  const db = new DatabaseSync(path);
  const lane = new SqliteReadLane();
  const worker = new SqliteWorker(path, undefined, {
    readOnly: true,
    readLane: lane,
  });
  const service = new LiteratureQueryService(worker);
  try {
    initializeCurrentCatalog(db);
    db.exec("PRAGMA journal_mode=WAL; BEGIN");
    const meta = db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const version = db.prepare(
      "INSERT INTO literatures VALUES(?,?,'published')",
    );
    const metadata = db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,publication_year) VALUES(?,1,?,'Sample record',?)",
    );
    const fts = db.prepare(
      "INSERT INTO literature_search_fts(literature_id,title) VALUES(?,'sample record')",
    );
    const exhausted = db.prepare(
      "INSERT INTO automatic_pdf_acquisition_exhaustions VALUES(?)",
    );
    // 10,001 bibliographic-only records and 3 whose automatic routes ran out.
    for (let n = 1; n <= 10_004; n++) {
      const key = id(n);
      meta.run(key, key);
      version.run(key, key);
      metadata.run(key, "a".repeat(64), n > 10_001 ? 2019 : 2020);
      fts.run(key);
      if (n > 10_001) exhausted.run(key);
    }
    db.exec("COMMIT");
    for (const query of [
      { text: "sample", publication_year_to: 2020 },
      { publication_year_to: 2020 },
    ]) {
      const counts = parseLibraryCounts(await service.counts(query));
      expect(counts).toMatchObject({ total: 10_000, count_truncated: true });
      expect(counts.material_counts).toEqual({
        READY: { count: 0 },
        ASSET_READY: { count: 0 },
        metadata: { count: 10_000, truncated: true },
        ARCHIVING: { count: 0 },
        ARCHIVE_FAILED: { count: 0 },
        unavailable: { count: 3 },
        EXCLUDED: { count: 0 },
      });
    }
    for (const query of [
      { text: "sample", publication_year_to: 2019 },
      { publication_year_to: 2019 },
    ]) {
      const counts = await service.counts(query);
      expect(counts).toMatchObject({
        total: 3,
        unavailable_pdf: 3,
        statuses: { UNREVIEWED: 3 },
      });
      expect(counts.count_truncated).toBeUndefined();
      expect(counts.material_counts).toBeUndefined();
    }
  } finally {
    db.close();
    await worker.close();
    await lane.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
