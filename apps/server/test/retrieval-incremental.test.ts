import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { topicDraft } from "./tag-fixture.js";
import { inspectFixtureRetrieval } from "./current-catalog-fixture.js";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import {
  RetrievalStorage,
  type RetrievalEntry,
} from "../src/retrieval/storage.js";
import { MaterialContextService } from "../src/retrieval/query.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const env = await coreProcessingFixture();
  const store = new RetrievalStorageClient(env.app.database);
  const index = new RetrievalIndexService(
    store,
    env.app.documentRead,
    env.app.library,
    env.app.writes,
  );
  const catalog = join(env.home, "catalog.sqlite");
  return {
    ...env,
    index,
    store,
    catalog,
    close: async () => {
      await index.close();
      await env.close();
    },
  };
}
function rows(catalog: string) {
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body
      FROM retrieval_entries e JOIN retrieval_fts f ON f.rowid=e.entry_id JOIN retrieval_active_generation a ON a.generation_id=e.generation_id
      ORDER BY e.kind,e.literature_id,e.document_version_id,e.unit_ordinal,e.entry_id`,
      )
      .all();
  } finally {
    db.close();
  }
}
async function sameAsRebuild(env: Awaited<ReturnType<typeof fixture>>) {
  const incremental = rows(env.catalog);
  const generation = await env.store.active();
  const query = {
    query: "synthetic",
    scope: { kind: "library" },
    kinds: ["metadata", "document"],
    versions: { kind: "default" },
    budget: { max_items: 20, max_bytes: 65536, token_limit: null },
    continuation: null,
  };
  const context = new MaterialContextService(
    env.store,
    env.app.documentRead,
    env.app.library,
  );
  const result = await context.search(query);
  const full = await env.index.build();
  expect(rows(env.catalog)).toEqual(incremental);
  expect(full).toMatchObject({
    entry_count: generation!.entry_count,
    source_count: generation!.source_count,
    source_revision: generation!.source_revision,
  });
  const rebuilt = await context.search(query);
  expect(rebuilt.items).toEqual(result.items);
  expect(rebuilt.gaps).toEqual(result.gaps);
}

describe("incremental material indexing", () => {
  it("reuses verified sources and matches full rebuild entries, ranking and evidence after source changes", async () => {
    const env = await fixture();
    try {
      const text =
        "# Results\n\n" +
        Array.from(
          { length: 145 },
          (_, i) =>
            `## Synthetic section ${i}\n\nSynthetic measurement ${i}: μg 光谱. ${"dose ".repeat(120)}\n`,
        ).join("\n");
      const publish = async (body: string) => {
        env.setText(body);
        await env.app.documentProcessing.parseDocuments({
          ...env.rawParseRequest,
          force: true,
        });
        const corrected = await env.app.proofreading!.build({
          asset_id: env.asset.asset_id,
        });
        const prior = await env.app.database.documentDefault(
          env.parseRequest.literature_id,
          env.asset.asset_id,
          env.asset.sha256,
        );
        return env.app.proofreadDocuments.publish({
          literature_id: env.parseRequest.literature_id,
          asset_id: env.asset.asset_id,
          proofread_id: corrected.version.proofread_id,
          expected_default_revision: prior?.revision ?? null,
        });
      };
      const first = await publish(text);
      expect(first.index_status).toBe("scheduled");
      await vi.waitFor(
        async () =>
          expect(await env.app.indexRefreshStatus!()).toMatchObject({
            status: "updated",
          }),
        { timeout: 20_000 },
      );
      const reads = vi.spyOn(env.app.documentRead, "withVerifiedVersion");
      try {
        await env.index.refresh();
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
      }
      expect(rows(env.catalog).length).toBeGreaterThan(128);
      await sameAsRebuild(env);

      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "Changed synthetic metadata",
            abstract: "Synthetic dosage",
            keywords: ["μg", "光谱"],
          },
        }),
      );
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: "00000000-0000-0000-0000-000000000003",
          meta_literature_id: "00000000-0000-0000-0000-000000000004",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "New synthetic metadata",
            identifiers: [],
            abstract: null,
          },
        }),
      );
      await env.index.refresh();
      await sameAsRebuild(env);

      const second = await publish(text + "\nSynthetic revised conclusion.\n");
      expect(second.index_status).toBe("scheduled");
      await vi.waitFor(
        async () =>
          expect(await env.app.indexRefreshStatus!()).toMatchObject({
            status: "updated",
          }),
        { timeout: 20_000 },
      );
      expect(second.document.document_version_id).not.toBe(
        first.document.document_version_id,
      );
      const versions = rows(env.catalog).filter(
        (row) => row.kind === "document",
      );
      expect(
        versions.some(
          (row) =>
            row.document_version_id === first.document.document_version_id &&
            row.is_default === 0,
        ),
      ).toBe(true);
      expect(
        versions.some(
          (row) =>
            row.document_version_id === second.document.document_version_id &&
            row.is_default === 1,
        ),
      ).toBe(true);
      await sameAsRebuild(env);
    } finally {
      await env.close();
    }
  }, 0);

  it("lets independent writers through a batch and retries only the concurrently changed literature", async () => {
    const env = await fixture();
    const entered = deferred(),
      release = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      const previous = await env.index.build();
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "First changed synthetic metadata",
          },
        }),
      );
      const scanned = await env.store.revision();
      const insert = env.store.insertEntries.bind(env.store);
      vi.spyOn(env.store, "insertEntries").mockImplementationOnce(
        async (...args) => {
          await insert(...args);
          entered.resolve();
          await release.promise;
        },
      );
      pending = env.index.refresh().catch((error: unknown) => error);
      await entered.promise;
      await env.app.folders.manage({
        operation: "create",
        request: { name: "During staging" },
      });
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "Concurrent synthetic metadata",
          },
        }),
      );
      release.resolve();
      expect(await pending).toMatchObject({
        source_revision: scanned,
      });
      expect((await env.store.active())?.generation_id).toBe(
        previous.generation_id,
      );
      const next = await env.index.refresh();
      expect(next.source_revision).toBe(await env.store.revision());
      await sameAsRebuild(env);
    } finally {
      release.resolve();
      await pending;
      await env.close();
    }
  });

  it("retries concurrent metadata replacement without treating it as source corruption", async () => {
    const env = await fixture();
    const entered = deferred(),
      release = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      const scanned = await env.store.revision();
      const page = env.store.literatureSources.bind(env.store);
      vi.spyOn(env.store, "literatureSources").mockImplementationOnce(
        async (...args) => {
          const source = await page(...args);
          entered.resolve();
          await release.promise;
          return source;
        },
      );
      pending = env.index.refresh().catch((error: unknown) => error);
      await entered.promise;
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "Newer synthetic metadata",
          },
        }),
      );
      release.resolve();
      expect(await pending).toMatchObject({
        source_revision: scanned,
      });
      expect((await env.store.scanChanges()).literature_ids).toEqual([]);
      await env.index.refresh();
      expect((await env.store.active())?.source_revision).toBe(
        await env.store.revision(),
      );
    } finally {
      release.resolve();
      await pending;
      await env.close();
    }
  });

  it("excludes another builder without blocking business writes or losing the first staging generation", async () => {
    const env = await fixture();
    const other = new RetrievalIndexService(
      env.store,
      env.app.documentRead,
      env.app.library,
      env.app.writes,
    );
    const entered = deferred(),
      release = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      const insert = env.store.insertEntries.bind(env.store);
      vi.spyOn(env.store, "insertEntries").mockImplementationOnce(
        async (...args) => {
          await insert(...args);
          entered.resolve();
          await release.promise;
        },
      );
      pending = env.index.build();
      await entered.promise;
      await expect(other.build()).rejects.toMatchObject({
        code: "write-admission-conflict",
      });
      await env.app.folders.manage({
        operation: "create",
        request: { name: "Independent writer" },
      });
      release.resolve();
      const generation = await pending;
      expect(await env.store.active()).toEqual(generation);
    } finally {
      release.resolve();
      await pending;
      await other.close();
      await env.close();
    }
  });

  // Reached 2.2 s under Full (36/12) load, too close to the 5 s default.
  it("does not reuse corrupted FTS and preserves repair staging across unrelated commits", async () => {
    const env = await fixture();
    const entered = deferred(),
      release = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      env.setText(
        Array.from(
          { length: 140 },
          (_, n) => `# Synthetic section ${n}\n\nSynthetic text.\n`,
        ).join("\n"),
      );
      await env.app.documentProcessing.parseDocuments(env.rawParseRequest);
      const proof = await env.app.proofreading!.build({
        asset_id: env.asset.asset_id,
      });
      const current = await env.app.database.documentDefault(
        env.parseRequest.literature_id,
        env.asset.asset_id,
        env.asset.sha256,
      );
      const published = await env.app.proofreadDocuments.publish({
        literature_id: env.parseRequest.literature_id,
        asset_id: env.asset.asset_id,
        proofread_id: proof.version.proofread_id,
        expected_default_revision: current?.revision ?? null,
      });
      expect(published.default_updated).toBe(true);
      // Parsing now schedules an index for the draft as well. Finish the
      // publication's accepted background work before this test takes explicit
      // generation ownership and deliberately corrupts/rebuilds the projection.
      await vi.waitFor(
        async () =>
          expect(await env.app.indexRefreshStatus!()).toMatchObject({
            status: "updated",
          }),
        { timeout: 20_000 },
      );
      await env.index.build();
      const original = rows(env.catalog);
      expect(original.length).toBeGreaterThan(128);
      const damaged = new DatabaseSync(env.catalog);
      try {
        damaged.exec("UPDATE retrieval_fts SET body='tampered-index-text'");
      } finally {
        damaged.close();
      }
      const insert = env.store.insertEntries.bind(env.store);
      vi.spyOn(env.store, "insertEntries").mockImplementationOnce(
        async (...args) => {
          await insert(...args);
          entered.resolve();
          await release.promise;
        },
      );
      pending = env.index.build();
      await entered.promise;
      await env.app.folders.manage({
        operation: "create",
        request: { name: "During repair" },
      });
      await env.app.tags.change({
        mutation: { op: "create", tag: topicDraft("Repair concurrent tag") },
        expected_version: (await env.app.tags.state()).version,
        reason: "Synthetic concurrent FTS write",
      });
      release.resolve();
      await pending;
      expect(rows(env.catalog)).toEqual(original);
      expect((await inspectFixtureRetrieval(env.catalog)).integrity).toBe("ok");
    } finally {
      release.resolve();
      await pending;
      await env.close();
    }
  }, 30_000);

  it("removes temporary repair rows if the main batch commit fails", async () => {
    const env = await fixture();
    let storage: RetrievalStorage | undefined;
    try {
      await env.index.build();
      const original = rows(env.catalog);
      const damaged = new DatabaseSync(env.catalog);
      try {
        damaged.exec("UPDATE retrieval_fts SET body='tampered-index-text'");
      } finally {
        damaged.close();
      }
      storage = new RetrievalStorage(env.catalog, false);
      const revision = storage.revision();
      const generation = storage.beginGeneration(revision);
      const connection = Reflect.get(storage, "db") as DatabaseSync;
      const exec = connection.exec.bind(connection);
      let failCommit = true;
      const injected = vi
        .spyOn(connection, "exec")
        .mockImplementation((sql) => {
          if (sql === "COMMIT" && failCommit) {
            failCommit = false;
            throw new Error("synthetic main commit failure");
          }
          exec(sql);
        });
      const entries = original as unknown as RetrievalEntry[];
      try {
        expect(() => storage!.insertEntries(generation, entries, 1)).toThrow(
          "synthetic main commit failure",
        );
      } finally {
        injected.mockRestore();
      }
      // Retrying this batch must not collide with committed temporary rows or
      // publish extra rows left by the failed main transaction.
      storage.insertEntries(generation, entries, 1);
      storage.publish(generation, revision);
      expect(rows(env.catalog)).toEqual(original);
      expect((await inspectFixtureRetrieval(env.catalog)).integrity).toBe("ok");
    } finally {
      storage?.close();
      await env.close();
    }
  });
});
