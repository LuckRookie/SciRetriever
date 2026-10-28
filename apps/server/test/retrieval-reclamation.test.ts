import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import { MaterialContextService } from "../src/retrieval/query.js";
import {
  RetrievalStorage,
  type RetrievalEntry,
} from "../src/retrieval/storage.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

async function fixture() {
  const e = await coreProcessingFixture(),
    store = new RetrievalStorageClient(e.app.database);
  const index = new RetrievalIndexService(
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
const request = (limit = 20) => ({
  query: "synthetic",
  scope: { kind: "library" },
  kinds: ["metadata"],
  versions: { kind: "default" },
  budget: { max_items: limit, max_bytes: 65536, token_limit: null },
  continuation: null,
});
async function entries(
  e: Awaited<ReturnType<typeof fixture>>,
  n = 280,
): Promise<RetrievalEntry[]> {
  const source = (await e.store.metadataPage(null, 1))[0]!;
  return Array.from({ length: n }, () => ({
    kind: "metadata",
    literature_id: source.literature_id,
    meta_literature_id: source.meta_literature_id,
    metadata_revision: source.metadata_revision,
    metadata_sha256: source.metadata_sha256,
    document_version_id: null,
    representation_sha256: null,
    source_asset_id: null,
    source_asset_sha256: null,
    unit_start_utf8: null,
    unit_end_utf8: null,
    unit_sha256: null,
    section_id: null,
    unit_ordinal: 0,
    is_default: 1,
    title: "Synthetic retired source",
    body: "Synthetic old chunk",
  }));
}
function counts(catalog: string) {
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT (SELECT count(*) FROM retrieval_generations) AS generations,(SELECT count(*) FROM retrieval_entries) AS entries,(SELECT count(*) FROM retrieval_fts) AS fts",
      )
      .get()!;
  } finally {
    db.close();
  }
}

it("reclaims ready generations after publication in bounded batches without changing sources", async () => {
  const e = await fixture();
  try {
    const old = await e.index.build();
    const retired = await e.store.beginGeneration(await e.store.revision());
    await e.store.insertEntries(retired, await entries(e), 1);
    await e.store.publish(retired, await e.store.revision());
    const batch = e.store.pruneGenerationBatch.bind(e.store),
      sizes: number[] = [];
    vi.spyOn(e.store, "pruneGenerationBatch").mockImplementation(
      async (...args) => {
        const result = await batch(...args);
        sizes.push(result.entries_deleted);
        if (result.entries_deleted && !result.done)
          expect((await e.store.verifyCatalog()).integrity).toBe("ok");
        return result;
      },
    );
    const revision = await e.store.revision(),
      current = await e.index.build();
    expect(current.generation_id).not.toBe(old.generation_id);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(128);
    expect(sizes.filter((n) => n > 0).length).toBeGreaterThan(2);
    expect(await e.store.revision()).toBe(revision);
    expect(counts(e.catalog)).toEqual({
      generations: 1,
      entries: current.entry_count,
      fts: current.entry_count,
    });
    await expect(
      e.store.pruneGenerationBatch(current.generation_id),
    ).rejects.toMatchObject({ code: "index-stale" });
    await expect(e.index.verify()).resolves.toMatchObject({
      status: "verified",
    });
  } finally {
    await e.close();
  }
}, 30000);

it("resumes cancelled reclamation of abandoned staging and admits independent writes", async () => {
  const e = await fixture(),
    stop = new AbortController();
  try {
    const current = await e.index.build();
    const abandoned = await e.store.beginGeneration(await e.store.revision());
    await e.store.insertEntries(abandoned, await entries(e), 1);
    const batch = e.store.pruneGenerationBatch.bind(e.store);
    const spy = vi
      .spyOn(e.store, "pruneGenerationBatch")
      .mockImplementationOnce(async (...args) => {
        const result = await batch(...args);
        expect(result.entries_deleted).toBe(128);
        await e.app.folders.manage({
          operation: "create",
          request: { name: "Between reclamation batches" },
        });
        stop.abort();
        return result;
      });
    await expect(e.index.refresh(stop.signal)).rejects.toMatchObject({
      code: "index-cancelled",
    });
    expect(counts(e.catalog).generations).toBe(2);
    expect(await e.store.active()).toEqual(current);
    expect((await e.store.verifyCatalog()).integrity).toBe("ok");
    spy.mockRestore();
    const read = vi.spyOn(e.app.library, "detail");
    await e.index.refresh();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(counts(e.catalog)).toEqual({
      generations: 1,
      entries: current.entry_count,
      fts: current.entry_count,
    });
  } finally {
    await e.close();
  }
}, 30000);

it("keeps a successful publication when cancellation interrupts its retired-generation cleanup", async () => {
  const e = await fixture(),
    stop = new AbortController();
  try {
    await e.index.build();
    const retired = await e.store.beginGeneration(await e.store.revision());
    await e.store.insertEntries(retired, await entries(e), 1);
    await e.store.publish(retired, await e.store.revision());
    const batch = e.store.pruneGenerationBatch.bind(e.store);
    const spy = vi
      .spyOn(e.store, "pruneGenerationBatch")
      .mockImplementationOnce(async (...args) => {
        const result = await batch(...args);
        expect(result.done).toBe(false);
        stop.abort();
        return result;
      });
    const published = await e.index.build(stop.signal);
    expect(published.generation_id).not.toBe(retired);
    expect(await e.store.active()).toEqual(published);
    expect(counts(e.catalog).generations).toBeGreaterThan(1);
    spy.mockRestore();
    await e.index.refresh();
    expect(counts(e.catalog)).toEqual({
      generations: 1,
      entries: published.entry_count,
      fts: published.entry_count,
    });
  } finally {
    await e.close();
  }
}, 30000);

it("pins a read snapshot while another connection publishes and reclaims the old generation", async () => {
  const e = await fixture();
  let reader: RetrievalStorage | undefined,
    writer: RetrievalStorage | undefined;
  try {
    const before = await e.index.build();
    writer = new RetrievalStorage(e.catalog, false);
    reader = new RetrievalStorage(e.catalog, true);
    const next = writer.beginGeneration(writer.revision());
    writer.insertEntries(next, await entries(e, 1), 1);
    expect(reader.active()?.generation_id).toBe(before.generation_id);
    const connection = Reflect.get(reader, "db") as DatabaseSync,
      prepare = connection.prepare.bind(connection);
    let switched = false;
    const spy = vi.spyOn(connection, "prepare").mockImplementation((sql) => {
      if (!switched && sql.includes("retrieval_fts MATCH")) {
        switched = true;
        writer!.publish(next, writer!.revision());
        while (!writer!.pruneGenerationBatch().done) {
          /* Each batch is a separate transaction. */
        }
      }
      return prepare(sql);
    });
    try {
      expect(
        reader.search(
          '"synthetic"',
          ["synthetic"],
          before.generation_id,
          [],
          ["metadata"],
          null,
          20,
          null,
        ).hits.length,
      ).toBeGreaterThan(0);
      expect(switched).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(() =>
      reader!.search(
        '"synthetic"',
        ["synthetic"],
        before.generation_id,
        [],
        ["metadata"],
        null,
        20,
        null,
      ),
    ).toThrow("index-stale");
    expect(counts(e.catalog).generations).toBe(1);
  } finally {
    reader?.close();
    writer?.close();
    await e.close();
  }
}, 30000);

it.each([
  { timing: "before-search", api: "search" },
  { timing: "after-search", api: "search" },
  { timing: "before-search", api: "candidates" },
  { timing: "after-search", api: "candidates" },
] as const)(
  "returns requery rather than partial or corrupt results when publication occurs $timing ($api)",
  async ({ timing, api }) => {
    const e = await fixture();
    const context = new MaterialContextService(
      e.store,
      e.app.documentRead,
      e.app.library,
    );
    try {
      await e.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: "00000000-0000-0000-0000-000000000030",
          meta_literature_id: "00000000-0000-0000-0000-000000000031",
        }),
      );
      const initial = await e.index.build();
      const first = await context.search(request(1));
      expect(first.continuation).not.toBeNull();
      if (timing === "before-search") {
        const search = e.store.search.bind(e.store);
        vi.spyOn(e.store, "search").mockImplementationOnce(async (...args) => {
          await e.index.build();
          return search(...args);
        });
      } else {
        const detail = e.app.library.detail.bind(e.app.library);
        vi.spyOn(e.app.library, "detail").mockImplementationOnce(
          async (...args) => {
            const result = await detail(...args);
            await e.index.build();
            return result;
          },
        );
      }
      const pending =
        api === "search"
          ? context.search(request())
          : context.withCandidates(request(), initial, async (session) => {
              for (const hit of session.hits) await session.expand(hit);
            });
      await expect(pending).rejects.toMatchObject({
        code: "context-cursor-invalid",
      });
      await expect(
        context.search({ ...request(1), continuation: first.continuation }),
      ).rejects.toMatchObject({ code: "context-cursor-invalid" });
    } finally {
      await context.close();
      await e.close();
    }
  },
  30000,
);
