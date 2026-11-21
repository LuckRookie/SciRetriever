import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import { RetrievalStorage } from "../src/retrieval/storage.js";
import { MaterialContextService } from "../src/retrieval/query.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { inspectCatalogRetrieval } from "../src/storage/sqlite/catalog-schema.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const paper = (n: number, title = `Synthetic title ${n}`) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(n + 1),
    metadata: { ...FIXTURE_LITERATURE.metadata, title },
  });
const request = (limit = 20) => ({
  query: "synthetic",
  scope: { kind: "library" },
  kinds: ["metadata"],
  versions: { kind: "default" },
  budget: { max_items: limit, max_bytes: 65536, token_limit: null },
  continuation: null,
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function fixture() {
  const e = await coreProcessingFixture(),
    store = new RetrievalStorageClient(e.app.database),
    index = new RetrievalIndexService(
      store,
      e.app.documentRead,
      e.app.library,
      e.app.writes,
    );
  return {
    ...e,
    store,
    index,
    catalog: join(e.home, "catalog.sqlite"),
    close: async () => {
      await index.close();
      await e.close();
    },
  };
}
function rows(catalog: string) {
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body FROM retrieval_entries e JOIN retrieval_active_generation a USING(generation_id) JOIN retrieval_fts f ON f.rowid=e.entry_id ORDER BY e.kind,e.literature_id,e.document_version_id,e.unit_ordinal,e.entry_id",
      )
      .all();
  } finally {
    db.close();
  }
}

it("advances to each scanned revision while another connection keeps publishing", async () => {
  const e = await fixture(),
    writer = new SqliteWorker(e.catalog, e.app.writes),
    context = new MaterialContextService(
      e.store,
      e.app.documentRead,
      e.app.library,
    );
  try {
    const before = await e.index.refresh();
    await writer.putLiterature(paper(30));

    const publications = [40, 50, 60];
    const scannedRevisions: number[] = [];
    const scanChanges = e.store.scanChanges.bind(e.store);
    vi.spyOn(e.store, "scanChanges").mockImplementation(async () => {
      const scan = await scanChanges();
      const next = publications[scannedRevisions.length];
      scannedRevisions.push(scan.revision);
      // Write after the snapshot is taken on each of the first three scans.
      // Bounding the writes lets the old implementation return its wrong watermark.
      if (next !== undefined) await writer.putLiterature(paper(next));
      return scan;
    });

    let indexed = before.source_revision;
    for (const [round, published] of publications.entries()) {
      const generation = await e.index.refresh();
      expect(generation.source_revision).toBe(scannedRevisions[round]);
      expect(generation.source_revision).toBeGreaterThan(indexed);
      expect(scannedRevisions).toHaveLength(round + 1);
      expect(await e.store.active()).toEqual(generation);
      indexed = generation.source_revision;
      const stale = await context.search(request());
      expect(stale).toMatchObject({
        coverage: "index-stale",
        indexed_revision: indexed,
        source_revision: await e.store.revision(),
      });
      expect(stale.source_revision!).toBeGreaterThan(indexed);
      const found = stale.items.map((item) => item.literature_id);
      expect(found).toContain(id(published - 10));
      expect(found).not.toContain(id(published));
    }

    const final = await e.index.refresh();
    expect(final.source_revision).toBe(await e.store.revision());
    expect(final.source_revision).toBeGreaterThan(indexed);
    const incremental = await context.search(request());
    expect(incremental.indexed_revision).toBe(incremental.source_revision);
    expect(incremental.items.map((item) => item.literature_id)).toContain(
      id(60),
    );
    const indexedRows = rows(e.catalog);
    await e.index.build();
    expect(rows(e.catalog)).toEqual(indexedRows);
    const rebuilt = await context.search(request());
    expect(rebuilt.items).toEqual(incremental.items);
    expect(rebuilt.coverage).toBe(incremental.coverage);
    expect(rebuilt.gaps).toEqual(incremental.gaps);
  } finally {
    await context.close();
    await writer.close();
    await e.close();
  }
});

it("retains accepted papers across later publications, invalidates the old cursor and matches a full rebuild", async () => {
  const e = await fixture(),
    entered = gate(),
    release = gate();
  let work: Promise<unknown> | undefined;
  try {
    await e.app.database.putLiterature(paper(30));
    await e.app.database.putLiterature(paper(40));
    const before = await e.index.refresh(),
      context = new MaterialContextService(
        e.store,
        e.app.documentRead,
        e.app.library,
      ),
      first = await context.search(request(1));
    expect(first.continuation).not.toBeNull();
    await e.app.database.putLiterature(paper(30, "Changed synthetic thirty"));
    await e.app.database.putLiterature(paper(40, "Changed synthetic forty"));
    const scanned = await e.store.revision();
    const accepted: string[] = [],
      read = vi.spyOn(e.app.library, "detail"),
      commit = e.store.commitLiteratureUpdate.bind(e.store);
    vi.spyOn(e.store, "commitLiteratureUpdate").mockImplementation(
      async (...args) => {
        const result = await commit(...args);
        if (result) {
          accepted.push(args[2]);
          if (accepted.length === 1) {
            entered.resolve();
            await release.promise;
          }
        }
        return result;
      },
    );
    work = e.index.refresh();
    await entered.promise;
    await e.app.folders.manage({
      operation: "create",
      request: { name: "Write between incremental papers" },
    });
    await e.app.database.putLiterature(paper(40, "Latest synthetic forty"));
    await e.app.database.putLiterature(paper(50));
    release.resolve();
    const after = await work;
    expect(after).toMatchObject({
      generation_id: before.generation_id,
      source_revision: scanned,
    });
    expect(accepted).toEqual([id(30), id(40)]);
    const newer = await context.search({ ...request(), query: "latest" });
    expect(newer.coverage).toBe("index-stale");
    expect(newer.items.map((item) => item.literature_id)).toEqual([id(40)]);
    const settled = await e.index.refresh();
    expect(settled).toMatchObject({
      generation_id: before.generation_id,
      source_revision: await e.store.revision(),
    });
    expect(accepted).toEqual([id(30), id(40), id(50)]);
    expect(read.mock.calls.filter(([value]) => value === id(30))).toHaveLength(
      1,
    );
    read.mockRestore();
    await expect(
      context.search({ ...request(1), continuation: first.continuation }),
    ).rejects.toMatchObject({ code: "context-cursor-invalid" });
    const incremental = rows(e.catalog),
      found = await context.search(request());
    await e.index.verify();
    await e.index.build();
    expect(rows(e.catalog)).toEqual(incremental);
    expect((await context.search(request())).items).toEqual(found.items);
    await context.close();
  } finally {
    release.resolve();
    await work;
    await e.close();
  }
}, 30000);

it("removes a literature whose metadata source disappeared without rereading unchanged papers", async () => {
  const e = await fixture();
  try {
    await e.app.database.putLiterature(paper(30));
    await e.index.refresh();
    const change = new DatabaseSync(e.catalog);
    try {
      change.exec("PRAGMA foreign_keys=ON");
      change
        .prepare("DELETE FROM literature_metadata WHERE literature_id=?")
        .run(id(30));
    } finally {
      change.close();
    }
    const read = vi.spyOn(e.app.library, "detail");
    await e.index.refresh();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(rows(e.catalog).every((r) => r.literature_id !== id(30))).toBe(true);
    const indexed = rows(e.catalog);
    await e.index.build();
    expect(rows(e.catalog)).toEqual(indexed);
  } finally {
    await e.close();
  }
});

it("never runs a global check for cold reads or for a search after another connection writes", async () => {
  const e = await fixture();
  let storage: RetrievalStorage | undefined;
  try {
    const generation = await e.index.refresh();
    const prepare = DatabaseSync.prototype.prepare,
      sql: string[] = [];
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, text: string) {
        sql.push(text);
        if (
          /integrity_check|foreign_key_check|fts_vocab|count\(\*\).*retrieval_entries/iu.test(
            text,
          )
        )
          throw Error("query attempted a full check");
        return prepare.call(this, text);
      });
    try {
      storage = new RetrievalStorage(e.catalog, true);
      expect(storage.active()).toEqual(generation);
      const writer = new DatabaseSync(e.catalog);
      writer
        .prepare(
          "UPDATE library_state_revision SET revision=revision+1 WHERE singleton=1",
        )
        .run();
      writer.close();
      expect(
        storage.search(
          '"synthetic"',
          ["synthetic"],
          generation.generation_id,
          [],
          ["metadata"],
          null,
          20,
          null,
        ).hits.length,
      ).toBeGreaterThan(0);
      expect(sql.some((s) => s.includes("retrieval_fts MATCH"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  } finally {
    storage?.close();
    await e.close();
  }
});

it("reports actual FTS read corruption with a rebuild hint without running a pre-search inspection", async () => {
  const e = await fixture();
  try {
    await e.index.refresh();
    const db = new DatabaseSync(e.catalog);
    try {
      db.exec("DROP TABLE retrieval_fts_data");
    } finally {
      db.close();
    }
    const context = new MaterialContextService(
      e.store,
      e.app.documentRead,
      e.app.library,
    );
    try {
      expect(await context.search(request())).toMatchObject({
        coverage: "index-corrupt",
        maintenance_hint: "rebuild-index",
        items: [],
      });
    } finally {
      await context.close();
    }
  } finally {
    await e.close();
  }
});

it("keeps committed papers and retries only unfinished work after cancellation", async () => {
  const e = await fixture(),
    stop = new AbortController();
  try {
    await e.app.database.putLiterature(paper(30));
    await e.app.database.putLiterature(paper(40));
    await e.index.refresh();
    await e.app.database.putLiterature(paper(30, "Changed synthetic thirty"));
    await e.app.database.putLiterature(paper(40, "Changed synthetic forty"));
    const commit = e.store.commitLiteratureUpdate.bind(e.store),
      spy = vi
        .spyOn(e.store, "commitLiteratureUpdate")
        .mockImplementation(async (...args) => {
          const accepted = await commit(...args);
          if (accepted) stop.abort();
          return accepted;
        });
    await expect(e.index.refresh(stop.signal)).rejects.toMatchObject({
      code: "index-cancelled",
    });
    spy.mockRestore();
    expect((await e.store.scanChanges()).literature_ids).toEqual([id(40)]);
    await e.index.refresh();
    expect((await e.store.scanChanges()).literature_ids).toEqual([]);
  } finally {
    await e.close();
  }
});

it("reports source changes during explicit verification as stale without poisoning a healthy projection", async () => {
  const e = await fixture(),
    entered = gate(),
    release = gate();
  let work: Promise<unknown> | undefined;
  try {
    await e.index.refresh();
    const sources = e.store.literatureSources.bind(e.store);
    vi.spyOn(e.store, "literatureSources").mockImplementationOnce(
      async (...args) => {
        const snapshot = await sources(...args);
        entered.resolve();
        await release.promise;
        return snapshot;
      },
    );
    work = e.index.verify().catch((error: unknown) => error);
    await entered.promise;
    await e.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Concurrent synthetic verification",
        },
      }),
    );
    release.resolve();
    expect(await work).toMatchObject({ code: "index-stale" });
    expect(await e.store.active()).not.toBeNull();
    await e.index.refresh();
    await expect(e.index.verify()).resolves.toMatchObject({
      status: "verified",
    });
  } finally {
    release.resolve();
    await work;
    await e.close();
  }
});

it.each(["rebuild", "source-change"] as const)(
  "checks %s atomically before persisting a verification failure",
  async (change) => {
    const e = await fixture();
    try {
      const before = await e.index.refresh();
      const db = new DatabaseSync(e.catalog);
      try {
        db.exec("UPDATE retrieval_fts SET title='silently changed text'");
      } finally {
        db.close();
      }
      const mark = e.store.markCorrupt.bind(e.store);
      const spy = vi
        .spyOn(e.store, "markCorrupt")
        .mockImplementationOnce(async (...args) => {
          if (change === "rebuild") await e.index.build();
          else await e.app.database.putLiterature(paper(30));
          return mark(...args);
        });
      await expect(e.index.verify()).rejects.toMatchObject({
        code: "index-stale",
      });
      expect(spy).toHaveBeenCalledWith(
        before.generation_id,
        before.source_revision,
      );
      expect(await e.store.active()).not.toBeNull();
      spy.mockRestore();
      if (change === "source-change") await e.index.build();
      await expect(e.index.verify()).resolves.toMatchObject({
        status: "verified",
      });
    } finally {
      await e.close();
    }
  },
);

it("retains a verified corruption marker when the full hash certificate is not current", async () => {
  const e = await fixture();
  try {
    await e.index.refresh();
    const db = new DatabaseSync(e.catalog);
    try {
      db.exec("UPDATE retrieval_fts SET title='silently changed text'");
    } finally {
      db.close();
    }
    await expect(e.index.verify()).rejects.toMatchObject({
      code: "index-corrupt",
    });
    await expect(inspectCatalogRetrieval(e.catalog)).rejects.toMatchObject({
      code: "catalog-schema-refused",
      reason: "catalog-integrity-refused",
    });
    await expect(e.store.active()).rejects.toMatchObject({
      code: "index-corrupt",
    });
  } finally {
    await e.close();
  }
});
