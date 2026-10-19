import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseAsset,
  parseMaterialContextBundle,
  parseMaterialContextRequest,
  parseLiteratureId,
  parseLiterature,
  parseLibrarySearchRequest,
  parseMetaLiteratureId,
  parseProvenance,
  sha256,
  type ArtifactRef,
  type EvidenceRef,
  type MaterialContextBundle,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import type { ParserBackend } from "../src/parsing/ports.js";
import { runCli } from "../src/cli/main.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { migrateDocumentCatalog } from "../src/storage/sqlite/document-migration.js";
import {
  inspectRetrievalCatalog,
  migrateRetrievalCatalog,
} from "../src/storage/sqlite/retrieval-migration.js";
import { RetrievalStorage } from "../src/retrieval/storage.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  inspectV4,
  prepareRetrievalVocab,
} from "../src/storage/sqlite/retrieval-engine.js";
import {
  SCHEMA_V4_FINGERPRINT,
  SCHEMA_V4_MANIFEST,
} from "../src/storage/sqlite/schema-v4.js";
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} from "../src/storage/sqlite/execution-schema.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const artifact = (bytes: Uint8Array, media_type: string): ArtifactRef => ({
  sha256: createHash("sha256")
    .update(bytes)
    .digest("hex") as ArtifactRef["sha256"],
  byte_size: bytes.length,
  media_type,
});

const request = (
  kinds: readonly ("metadata" | "document")[] = ["metadata", "document"],
) => ({
  query: "synthetic",
  scope: { kind: "library" },
  kinds,
  versions: { kind: "default" },
  budget: { max_items: 20, max_bytes: 16_384, token_limit: null },
  continuation: null,
});
function recount(bundle: MaterialContextBundle): MaterialContextBundle {
  let result = { ...bundle, usage: { ...bundle.usage, bytes: 0 } };
  for (let i = 0; i < 10; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes === result.usage.bytes) return result;
    result = { ...result, usage: { ...result.usage, bytes } };
  }
  throw new Error("bundle byte count did not stabilize");
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("isolates cold retrieval from library reads with one reusable read-only worker and closes both owners exactly once", async () => {
  const env = await fixture();
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await env.app.maintenance!.rebuildIndex();
    const retrieval = vi.spyOn(SqliteWorker.prototype, "retrieval");
    const library = vi.spyOn(SqliteWorker.prototype, "librarySearchPage");
    const close = vi.spyOn(SqliteWorker.prototype, "close");
    try {
      query = await createQueryApplication(env.home);
      const list = parseLibrarySearchRequest({ query: {}, limit: 20 });
      const [bundle, page] = await Promise.all([
        query.context!.search(request(["metadata"])),
        query.query!.search(list),
      ]);
      expect(bundle.items.length).toBeGreaterThan(0);
      expect(page.items).toHaveLength(1);
      await query.context!.search(request(["metadata"]));
      const retrievalWorkers = new Set(retrieval.mock.contexts);
      const libraryWorkers = new Set(library.mock.contexts);
      expect(retrievalWorkers.size).toBe(1);
      expect(libraryWorkers.size).toBe(1);
      for (const worker of retrievalWorkers)
        expect(libraryWorkers.has(worker)).toBe(false);
      await Promise.all([query.close(), query.close()]);
      for (const worker of [...retrievalWorkers, ...libraryWorkers])
        expect(
          close.mock.contexts.filter((owner) => owner === worker),
        ).toHaveLength(1);
    } finally {
      await query?.close();
      retrieval.mockRestore();
      library.mockRestore();
      close.mockRestore();
    }
  } finally {
    await env.close();
  }
}, 30000);

async function fixture(document = false, publishBeforeV4 = false) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-retrieval-context-"));
  const catalog = join(home, "catalog.sqlite");
  let app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  let text =
    "# Results\nDose 5 mg increased yield.\n\n| group | value |\n| A | 2 mg |\n";
  let parses = 0;
  const parser: ParserBackend = {
    parse: async (input) => {
      parses++;
      const bytes = Buffer.from(text);
      return {
        source_asset_id: input.source_asset_id,
        source_sha256: input.source_sha256,
        page_count: 1,
        markdown: { artifact: artifact(bytes, "text/markdown"), bytes },
        resources: [],
        provenance: {
          provenance: parseProvenance({
            provenance_id: id(900 + parses),
            source_kind: "parser",
            source_name: "fixture",
            source_record_id: null,
            observed_at: "2026-09-29T00:00:00Z",
            input_sha256: input.source_sha256,
            parameters_sha256: "a".repeat(64),
          }),
          parser_version: "fixture",
          mode: null,
          model_identity: null,
        },
      };
    },
  };
  let asset: ReturnType<typeof parseAsset> | null = null;
  let oldEvidence: EvidenceRef | null = null;
  let oldVersionId: string | null = null;
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    if (document) {
      const pdf = workbenchPdf();
      const stage = await app.files.stage();
      await stage.write(pdf);
      await app.files.publish(stage, "objects/source.pdf");
      asset = parseAsset({
        asset_id: id(810),
        sha256: await sha256(pdf),
        size_bytes: pdf.length,
        media_type: "application/pdf",
        path: "objects/source.pdf",
      });
      await app.database.putLiteratureAsset({
        literature_asset_id: id(811),
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset,
        role: "primary-pdf",
        source_url: null,
        provenance: {
          provenance_id: id(812),
          source_kind: "asset-provider",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-09-29T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        },
      });
    }
    await app.close();
    await migrateDocumentCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v3.sqlite"),
    });
    if (publishBeforeV4) {
      if (!asset) throw new Error("pre-v4 document requires material");
      app = await createApplication(home, {
        executionSchema: "require-v2",
        parsing: { parser, rules: new TypeScriptParserArtifactRules() },
      });
      const old = await app.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      oldVersionId = old.document.document_version_id;
      const slice = await app.documentRead.slice({
        document_version_id: oldVersionId,
        selector: { kind: "segment", segment_id: "p2" },
        max_bytes: 128,
        continuation: null,
      });
      oldEvidence = slice.evidence[0] ?? null;
      await app.close();
    }
    await migrateRetrievalCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v4.sqlite"),
    });
    app = await createApplication(home, {
      executionSchema: "require-v2",
      parsing: { parser, rules: new TypeScriptParserArtifactRules() },
    });
    return {
      home,
      catalog,
      app,
      asset,
      oldEvidence,
      oldVersionId,
      setText: (value: string) => {
        text = value;
      },
      get parses() {
        return parses;
      },
      close: async () => {
        await app.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

describe("explicit retrieval projection and bounded Context", () => {
  it("batches metadata sources without losing source counts or searchable entries", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    const insert = vi.spyOn(RetrievalStorageClient.prototype, "insertEntries");
    try {
      for (let n = 1; n <= 256; n++) {
        await env.app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id(10_000 + n),
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title: `Batchneedle ${n}`,
            },
          }),
        );
      }
      const generation = await env.app.maintenance!.rebuildIndex();
      expect(generation).toMatchObject({ entry_count: 257, source_count: 257 });
      expect(insert.mock.calls.length).toBeLessThanOrEqual(3);
      expect(insert.mock.calls.length).toBeGreaterThan(1);
      expect(
        insert.mock.calls.every(
          ([, entries, count]) => entries.length <= 128 && count <= 128,
        ),
      ).toBe(true);
      expect(insert.mock.calls.reduce((n, [, , count]) => n + count, 0)).toBe(
        257,
      );
      query = await createQueryApplication(env.home);
      const context = await query.context!.search({
        ...request(["metadata"]),
        query: "batchneedle",
        scope: { kind: "literatures", literature_ids: [id(10_256)] },
      });
      expect(context.items).toHaveLength(1);
      expect(context.items[0]?.literature_id).toBe(id(10_256));
      const db = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT count(DISTINCT literature_id) AS n FROM retrieval_entries WHERE generation_id=?",
            )
            .get(generation.generation_id),
        ).toEqual({ n: 257 });
      } finally {
        db.close();
      }
    } finally {
      insert.mockRestore();
      await query?.close();
      await env.close();
    }
  }, 30_000);

  it("bounds replay bytes and counts a fragmented document only once", async () => {
    const env = await fixture(true);
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    const insert = vi.spyOn(RetrievalStorageClient.prototype, "insertEntries");
    try {
      env.setText(`# Results\n\n${"Dose ".repeat(300_000)}\n`);
      await env.app.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: env.asset!.asset_id,
        asset_sha256: env.asset!.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      const generation = await env.app.maintenance!.rebuildIndex();
      expect(generation.source_count).toBe(2);
      expect(generation.entry_count).toBeGreaterThan(32);
      expect(insert.mock.calls.length).toBeGreaterThan(1);
      for (const [, entries] of insert.mock.calls) {
        expect(entries.length).toBeLessThanOrEqual(128);
        expect(
          entries.reduce(
            (n, e) =>
              n + Buffer.byteLength(e.title) + Buffer.byteLength(e.body),
            0,
          ),
        ).toBeLessThanOrEqual(1024 * 1024);
      }
      expect(insert.mock.calls.reduce((n, [, , count]) => n + count, 0)).toBe(
        2,
      );
      expect(
        insert.mock.calls.reduce((n, [, entries]) => n + entries.length, 0),
      ).toBe(generation.entry_count);
      query = await createQueryApplication(env.home);
      const context = await query.context!.search({
        ...request(["document"]),
        query: "dose",
      });
      expect(context.items.length).toBeGreaterThan(0);
    } finally {
      insert.mockRestore();
      await query?.close();
      await env.close();
    }
  }, 30_000);

  it("rejects queued cancellation but settles a publish already sent to SQLite", async () => {
    const env = await fixture();
    try {
      const store = new RetrievalStorageClient(env.app.database);
      const revision = await store.revision();
      const entered = deferred();
      const release = deferred();
      const hold = env.app.writes.run(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = new AbortController();
      const rejected = store.beginGeneration(revision, queued.signal);
      const settled = rejected.then(
        () => null,
        (error: unknown) => error,
      );
      queued.abort();
      release.resolve();
      await hold;
      expect(await settled).toMatchObject({
        code: "write-admission-cancelled",
      });
      const generation = await store.beginGeneration(revision);
      const blocker = new DatabaseSync(env.catalog);
      try {
        blocker.exec("BEGIN IMMEDIATE");
        const stop = new AbortController();
        const published = await env.app.writes.run(async () => {
          const sent = store.publish(generation, revision, stop.signal);
          stop.abort();
          blocker.exec("COMMIT");
          return sent;
        });
        expect(published.generation_id).toBe(generation);
        expect((await store.active())?.generation_id).toBe(generation);
      } finally {
        blocker.close();
      }
    } finally {
      await env.close();
    }
  });

  it("cancels an in-flight rebuild when the authenticated HTTP client disconnects", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    let server: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
    const originalPage = RetrievalStorageClient.prototype.metadataPage;
    const releasePage = deferred();
    try {
      const before = await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const pageRead = deferred();
      const cancelled = deferred();
      const finished = deferred();
      let failure: unknown;
      let held = false;
      RetrievalStorageClient.prototype.metadataPage = async function (
        after,
        limit,
      ) {
        const page = await originalPage.call(this, after, limit);
        if (!held) {
          held = true;
          pageRead.resolve();
          await releasePage.promise;
        }
        return page;
      };
      server = await startQueryOnlyHttp({
        application: query,
        maintenance: {
          ...env.app.maintenance!,
          rebuildIndex: async (signal) => {
            if (!signal) throw new Error("missing HTTP cancellation signal");
            signal.addEventListener("abort", () => cancelled.resolve(), {
              once: true,
            });
            try {
              return await env.app.maintenance!.rebuildIndex(signal);
            } catch (error) {
              failure = error;
              throw error;
            } finally {
              finished.resolve();
            }
          },
        },
      });
      const root = await fetch(server.origin);
      const cookie = root.headers.get("set-cookie")!.split(";")[0]!;
      const session = await fetch(
        `${server.origin}/api/v1/maintenance/session`,
        { headers: { Cookie: cookie } },
      );
      const { csrf } = (await session.json()) as { csrf: string };
      const stop = new AbortController();
      const pending = fetch(
        `${server.origin}/api/v1/maintenance/rebuild-index`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: server.origin,
            "Content-Type": "application/json",
            "X-Sciretriever-Csrf": csrf,
            "X-Sciretriever-Protocol-Version": "1",
          },
          body: JSON.stringify({
            protocol_version: 1,
            request: { kind: "rebuild" },
          }),
          signal: stop.signal,
        },
      );
      const disconnected = pending.catch(() => undefined);
      await pageRead.promise;
      stop.abort();
      await cancelled.promise;
      releasePage.resolve();
      await Promise.all([disconnected, finished.promise]);
      expect(failure).toMatchObject({ code: "index-cancelled" });
      expect(
        (await inspectRetrievalCatalog(env.catalog)).active_generation,
      ).toBe(before.generation_id);
      const after = await env.app.maintenance!.rebuildIndex();
      expect(after.generation_id).not.toBe(before.generation_id);
    } finally {
      releasePage.resolve();
      RetrievalStorageClient.prototype.metadataPage = originalPage;
      await server?.close();
      await query?.close();
      await env.close();
    }
  }, 10_000);

  it("keeps a v3 DocumentVersion and its evidence readable after v4 migration and rebuild", async () => {
    const env = await fixture(true, true);
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      expect(env.oldEvidence).not.toBeNull();
      expect(env.oldVersionId).not.toBeNull();
      query = await createQueryApplication(env.home);
      expect(
        await query.documentRead!.resolveEvidence(env.oldEvidence!),
      ).toMatchObject({
        text: "Dose 5 mg increased yield.\n",
      });
      const generation = await env.app.maintenance!.rebuildIndex();
      const result = await query.context!.search({
        ...request(["document"]),
        query: "dose",
      });
      expect(result).toMatchObject({
        coverage: "complete",
        generation_id: generation.generation_id,
      });
      expect(result.items[0]).toMatchObject({
        reference: { document_version_id: env.oldVersionId },
      });
      expect(
        await query.documentRead!.resolveEvidence(env.oldEvidence!),
      ).toMatchObject({
        text: "Dose 5 mg increased yield.\n",
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("publishes a generation, filters kinds before pagination, and reports missing material", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      expect(
        (
          await runCli(
            ["storage", "retrieval-inspect", "--catalog", env.catalog],
            { home: env.home },
          )
        ).value,
      ).toMatchObject({ schema_version: 4, active_generation: null });
      const published = (
        await runCli(["maintenance", "rebuild-index"], { home: env.home })
      ).value as {
        generation_id: string;
        source_count: number;
        entry_count: number;
      };
      expect(published).toMatchObject({ source_count: 1, entry_count: 1 });
      query = await createQueryApplication(env.home);
      const context = query.context!;
      const bundle = await context.search(request());
      expect(bundle).toMatchObject({
        coverage: "partial",
        generation_id: published.generation_id,
        truncated: false,
      });
      expect(bundle.items).toHaveLength(1);
      expect(bundle.items[0]).toMatchObject({
        kind: "metadata",
        literature_id: FIXTURE_LITERATURE.literature_id,
        reference: { kind: "metadata" },
      });
      expect(bundle.gaps).toEqual([
        {
          code: "material-missing",
          literature_id: null,
        },
      ]);
      expect(bundle.usage.bytes).toBe(
        Buffer.byteLength(JSON.stringify(bundle)),
      );
      const parsedRequest = parseMaterialContextRequest(request());
      expect(() =>
        parseMaterialContextBundle(
          recount({ ...bundle, coverage: "complete" }),
          parsedRequest,
        ),
      ).toThrow();
      expect(() =>
        parseMaterialContextBundle(
          recount({ ...bundle, continuation: "abc" }),
          parsedRequest,
        ),
      ).toThrow();
      expect(await context.search(request(["document"]))).toMatchObject({
        coverage: "partial",
        items: [],
        gaps: [{ code: "material-missing", literature_id: null }],
      });
      expect(
        await context.search({
          ...request(["document"]),
          scope: {
            kind: "literatures",
            literature_ids: [FIXTURE_LITERATURE.literature_id],
          },
        }),
      ).toMatchObject({
        coverage: "partial",
        items: [],
        gaps: [
          {
            code: "material-missing",
            literature_id: FIXTURE_LITERATURE.literature_id,
          },
        ],
      });
      await expect(
        context.search({
          ...request(["document"]),
          scope: { kind: "literatures", literature_ids: [id(991)] },
        }),
      ).rejects.toThrow("context-source-integrity");
      await expect(
        context.search({
          ...request(["metadata"]),
          scope: { kind: "literatures", literature_ids: [id(991)] },
        }),
      ).rejects.toThrow("context-source-integrity");
      const first = await context.search({
        ...request(),
        budget: { max_items: 1, max_bytes: 16_384, token_limit: null },
      });
      expect(first.items).toHaveLength(1);
      expect(first.continuation).toBeNull();
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("retains the old generation after source change until an explicit rebuild", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      const before = await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const ready = await query.context!.search(request());
      expect(ready.generation_id).toBe(before.generation_id);
      await env.app.database.putLiterature({
        ...FIXTURE_LITERATURE,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Updated synthetic",
        },
      });
      expect(await query.context!.search(request())).toMatchObject({
        coverage: "index-stale",
        generation_id: before.generation_id,
        items: [],
      });
      const after = await env.app.maintenance!.rebuildIndex();
      expect(after.generation_id).not.toBe(before.generation_id);
      const db = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM retrieval_generations WHERE status='ready'",
              )
              .get() as { n: number }
          ).n,
        ).toBe(2);
      } finally {
        db.close();
      }
      expect(await query.context!.search(request())).toMatchObject({
        generation_id: after.generation_id,
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("refuses a metadata subtable change that does not update its canonical hash", async () => {
    const env = await fixture();
    try {
      const before = await env.app.maintenance!.rebuildIndex();
      const db = new DatabaseSync(env.catalog);
      try {
        db.prepare(
          "INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) VALUES(?,?,?)",
        ).run(FIXTURE_LITERATURE.literature_id, 0, "tampered");
      } finally {
        db.close();
      }
      await expect(env.app.maintenance!.rebuildIndex()).rejects.toThrow(
        "index-source-invalid",
      );
      const inspect = (
        await runCli(
          ["storage", "retrieval-inspect", "--catalog", env.catalog],
          { home: env.home },
        )
      ).value as { active_generation: string };
      expect(inspect.active_generation).toBe(before.generation_id);
    } finally {
      await env.close();
    }
  });

  it("keeps cursor ordering stable while a different generation is building", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.app.database.putLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: parseLiteratureId(id(991)),
        meta_literature_id: parseMetaLiteratureId(id(992)),
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Synthetic second",
          identifiers: [],
        },
      });
      const before = await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const pageRequest = {
        ...request(["metadata"]),
        budget: { max_items: 1, max_bytes: 16_384, token_limit: null },
      };
      const first = await query.context!.search(pageRequest);
      expect(first.items).toHaveLength(1);
      expect(first.continuation).not.toBeNull();
      const second = await query.context!.search({
        ...pageRequest,
        continuation: first.continuation,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.literature_id).not.toBe(
        first.items[0]?.literature_id,
      );
      const envelope = JSON.parse(
        Buffer.from(first.continuation!, "base64url").toString("utf8"),
      ) as { payload: string; checksum: string };
      const payload = JSON.parse(envelope.payload) as {
        after: Record<string, unknown>;
      };
      payload.after.extra = "forged";
      envelope.payload = JSON.stringify(payload);
      envelope.checksum = createHash("sha256")
        .update(envelope.payload)
        .digest("hex");
      await expect(
        query.context!.search({
          ...pageRequest,
          continuation: Buffer.from(JSON.stringify(envelope)).toString(
            "base64url",
          ),
        }),
      ).rejects.toThrow("context-cursor-invalid");
      const store = new RetrievalStorage(env.catalog, false);
      try {
        const source = store.metadataPage(null, 1)[0]!;
        const building = store.beginGeneration(store.revision());
        store.insertEntries(
          building,
          [
            {
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
              title: "synthetic ".repeat(100),
              body: "",
            },
          ],
          1,
        );
      } finally {
        store.close();
      }
      const again = await query.context!.search(pageRequest);
      expect(again.items[0]?.literature_id).toBe(first.items[0]?.literature_id);
      const next = await query.context!.search({
        ...pageRequest,
        continuation: again.continuation,
      });
      expect(next.items[0]?.literature_id).toBe(second.items[0]?.literature_id);
      expect(again.generation_id).toBe(before.generation_id);
      await env.app.maintenance!.rebuildIndex();
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("inspects one SQLite snapshot when another connection publishes between counts and active", async () => {
    const env = await fixture();
    try {
      const before = await env.app.maintenance!.rebuildIndex();
      const writer = new RetrievalStorage(env.catalog, false);
      const reader = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        const revision = writer.revision();
        const next = writer.beginGeneration(revision);
        prepareRetrievalVocab(reader);
        reader.exec("PRAGMA query_only=ON");
        const inspected = inspectV4(
          reader,
          {
            schema_fingerprint: SCHEMA_V4_FINGERPRINT,
            schema_manifest: SCHEMA_V4_MANIFEST,
            execution_schema_version: EXECUTION_SCHEMA_VERSION,
            execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
            execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
            execution_runtime_schema_fingerprint:
              EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
          },
          () => {
            writer.publish(next, revision);
          },
        );
        expect(inspected.active_generation).toBe(before.generation_id);
        expect(writer.active()?.generation_id).toBe(next);
      } finally {
        reader.close();
        writer.close();
      }
    } finally {
      await env.close();
    }
  });

  it("refuses changed v4 DDL in a long-lived read-only query session", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      expect((await query.context!.search(request())).items).toHaveLength(1);
      const db = new DatabaseSync(env.catalog);
      try {
        db.exec("DROP INDEX retrieval_entries_version");
      } finally {
        db.close();
      }
      expect(await query.context!.search(request())).toMatchObject({
        coverage: "index-corrupt",
        items: [],
      });
      expect(
        await query.query!.detail(FIXTURE_LITERATURE.literature_id),
      ).toMatchObject({
        literature: { metadata: { title: FIXTURE_LITERATURE.metadata.title } },
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("keeps source reads available but refuses a writer after a retrieval trigger is altered", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.app.maintenance!.rebuildIndex();
      const db = new DatabaseSync(env.catalog);
      try {
        db.exec("DROP TRIGGER retrieval_revision_literatures_insert");
      } finally {
        db.close();
      }
      query = await createQueryApplication(env.home);
      expect(
        await query.query!.detail(FIXTURE_LITERATURE.literature_id),
      ).toMatchObject({
        literature: { metadata: { title: FIXTURE_LITERATURE.metadata.title } },
      });
      expect(await query.context!.search(request())).toMatchObject({
        coverage: "index-corrupt",
        items: [],
      });
      const writer = new SqliteWorker(env.catalog);
      try {
        await expect(writer.schema()).rejects.toThrow();
      } finally {
        await writer.close();
      }
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("detects missing FTS rows and repairs them only through explicit rebuild", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      const before = await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      expect((await query.context!.search(request())).items).toHaveLength(1);
      const db = new DatabaseSync(env.catalog);
      try {
        db.exec(
          "DELETE FROM retrieval_fts WHERE rowid=(SELECT entry_id FROM retrieval_entries LIMIT 1)",
        );
      } finally {
        db.close();
      }
      expect(await query.context!.search(request())).toMatchObject({
        coverage: "index-corrupt",
        items: [],
      });
      expect(
        await query.query!.detail(FIXTURE_LITERATURE.literature_id),
      ).toMatchObject({
        literature: { metadata: { title: FIXTURE_LITERATURE.metadata.title } },
      });
      const repaired = await env.app.maintenance!.rebuildIndex();
      expect(repaired.generation_id).not.toBe(before.generation_id);
      expect(await query.context!.search(request())).toMatchObject({
        coverage: "partial",
        generation_id: repaired.generation_id,
      });
      expect(
        (await inspectRetrievalCatalog(env.catalog)).active_generation,
      ).toBe(repaired.generation_id);
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("rejects changed FTS text even when entry and FTS counts still match", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const db = new DatabaseSync(env.catalog);
      try {
        db.exec(
          "UPDATE retrieval_fts SET title='unrelated' WHERE rowid=(SELECT entry_id FROM retrieval_entries LIMIT 1)",
        );
      } finally {
        db.close();
      }
      expect(await query.context!.search(request())).toMatchObject({
        coverage: "index-corrupt",
        items: [],
      });
      const repaired = await env.app.maintenance!.rebuildIndex();
      expect(await query.context!.search(request())).toMatchObject({
        generation_id: repaired.generation_id,
        coverage: "partial",
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("rejects damaged FTS postings even when FTS content and counts remain", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const db = new DatabaseSync(env.catalog);
      try {
        const row = db
          .prepare(
            "SELECT id,block FROM retrieval_fts_data ORDER BY id DESC LIMIT 1",
          )
          .get() as { id: number; block: Uint8Array };
        const changed = Uint8Array.from(row.block);
        changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
        db.prepare("UPDATE retrieval_fts_data SET block=? WHERE id=?").run(
          changed,
          row.id,
        );
      } finally {
        db.close();
      }
      expect(await query.context!.search(request())).toMatchObject({
        coverage: "index-corrupt",
        items: [],
      });
      const repaired = await env.app.maintenance!.rebuildIndex();
      expect(await query.context!.search(request())).toMatchObject({
        generation_id: repaired.generation_id,
        coverage: "partial",
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("leaves a damaged active generation untouched when source verification blocks repair", async () => {
    const env = await fixture();
    try {
      const before = await env.app.maintenance!.rebuildIndex();
      const db = new DatabaseSync(env.catalog);
      try {
        db.exec(
          "DELETE FROM retrieval_fts WHERE rowid=(SELECT entry_id FROM retrieval_entries LIMIT 1)",
        );
        db.prepare(
          "INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) VALUES(?,?,?)",
        ).run(FIXTURE_LITERATURE.literature_id, 0, "tampered");
      } finally {
        db.close();
      }
      await expect(env.app.maintenance!.rebuildIndex()).rejects.toThrow(
        "index-source-invalid",
      );
      const check = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          (
            check
              .prepare(
                "SELECT generation_id FROM retrieval_active_generation WHERE singleton=1",
              )
              .get() as { generation_id: string }
          ).generation_id,
        ).toBe(before.generation_id);
        expect(
          (
            check
              .prepare(
                "SELECT count(*) AS n FROM retrieval_generations WHERE status='ready'",
              )
              .get() as { n: number }
          ).n,
        ).toBe(1);
      } finally {
        check.close();
      }
    } finally {
      await env.close();
    }
  });

  it("rolls back an in-transaction repair failure and permits a clean explicit retry", async () => {
    const env = await fixture(true);
    try {
      const document = await env.app.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: env.asset!.asset_id,
        asset_sha256: env.asset!.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      const before = await env.app.maintenance!.rebuildIndex();
      const changed = new DatabaseSync(env.catalog);
      try {
        changed.exec(
          "UPDATE retrieval_fts SET title='tampered' WHERE rowid=(SELECT entry_id FROM retrieval_entries WHERE kind='metadata' LIMIT 1)",
        );
      } finally {
        changed.close();
      }
      const snapshot = () => {
        const db = new DatabaseSync(env.catalog, { readOnly: true });
        try {
          return {
            active: db
              .prepare(
                "SELECT generation_id FROM retrieval_active_generation WHERE singleton=1",
              )
              .get(),
            fts: db
              .prepare(
                "SELECT rowid,title,body FROM retrieval_fts ORDER BY rowid",
              )
              .all(),
            metadata: db
              .prepare(
                "SELECT metadata_sha256 FROM literature_metadata WHERE literature_id=?",
              )
              .get(FIXTURE_LITERATURE.literature_id),
            document: db
              .prepare(
                "SELECT representation_sha256,markdown_sha256,structure_sha256 FROM document_versions WHERE document_version_id=?",
              )
              .get(document.document.document_version_id),
          };
        } finally {
          db.close();
        }
      };
      const damaged = snapshot();
      const store = new RetrievalStorage(env.catalog, false);
      try {
        const revision = store.revision();
        const staging = store.beginGeneration(revision);
        // TEMP triggers do not alter the main manifest. This fires after the
        // repair has dropped/rebuilt FTS but before its COMMIT.
        const connection = Reflect.get(store, "db") as DatabaseSync;
        connection.exec(
          "CREATE TEMP TRIGGER fail_repair BEFORE UPDATE OF status ON main.retrieval_generations BEGIN SELECT RAISE(ABORT,'injected repair failure'); END",
        );
        expect(() => store.publish(staging, revision)).toThrow(
          "injected repair failure",
        );
        expect(snapshot()).toEqual(damaged);
        await expect(inspectRetrievalCatalog(env.catalog)).rejects.toThrow();
      } finally {
        store.close();
      }
      const repaired = await env.app.maintenance!.rebuildIndex();
      expect(repaired.generation_id).not.toBe(before.generation_id);
      expect(
        (await inspectRetrievalCatalog(env.catalog)).active_generation,
      ).toBe(repaired.generation_id);
      expect(snapshot().metadata).toEqual(damaged.metadata);
      expect(snapshot().document).toEqual(damaged.document);
    } finally {
      await env.close();
    }
  });

  it("bounds a repeated long heading without replacing the previous generation", async () => {
    const env = await fixture(true);
    try {
      const before = await env.app.maintenance!.rebuildIndex();
      env.setText(
        `# ${"A".repeat(4 * 1024 * 1024)}\n\n${Array.from({ length: 17 }, (_, n) => `Dose ${n} mg.\n`).join("\n")}`,
      );
      await env.app.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: env.asset!.asset_id,
        asset_sha256: env.asset!.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      await expect(env.app.maintenance!.rebuildIndex()).rejects.toThrow(
        "index-limit",
      );
      const db = new DatabaseSync(env.catalog, { readOnly: true });
      try {
        expect(
          (
            db
              .prepare(
                "SELECT generation_id FROM retrieval_active_generation WHERE singleton=1",
              )
              .get() as { generation_id: string }
          ).generation_id,
        ).toBe(before.generation_id);
      } finally {
        db.close();
      }
    } finally {
      await env.close();
    }
  }, 30_000);

  it("preserves negation and a whole table unit while counting a small multibyte Context budget", async () => {
    const env = await fixture(true);
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      env.setText(
        `# Results\nDose 5 mg did not improve yield.\n\n| compound | dose | response |\n| A | 5 mg | no effect |\n| B | 10 mg | improvement |\n\n${"αβ ".repeat(500)}\n`,
      );
      await env.app.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: env.asset!.asset_id,
        asset_sha256: env.asset!.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const negation = await query.context!.search({
        ...request(["document"]),
        query: "improve",
      });
      expect(negation.items[0]?.text).toContain("did not improve");
      const table = await query.context!.search({
        ...request(["document"]),
        query: "compound dose",
      });
      expect(table.items[0]?.text).toContain("| B | 10 mg | improvement |");
      await expect(
        query.context!.search({
          ...request(["document"]),
          query: "αβ",
          budget: { max_items: 1, max_bytes: 1024, token_limit: null },
        }),
      ).rejects.toMatchObject({ code: "context-budget-invalid" });
      const compact = await query.context!.search({
        ...request(["document"]),
        query: "αβ",
        budget: { max_items: 1, max_bytes: 2048, token_limit: null },
      });
      expect(compact.usage.bytes).toBe(
        Buffer.byteLength(JSON.stringify(compact)),
      );
      expect(compact.usage.bytes).toBeLessThanOrEqual(2048);
      expect(compact.items).toHaveLength(1);
      expect(compact.items[0]).toMatchObject({
        kind: "source-text",
        text: "",
        evidence: [],
        gap: "context-too-large",
        reference: {
          kind: "document",
          document_version_id: expect.any(String),
          representation_sha256: expect.any(String),
          start_utf8: expect.any(Number),
          end_utf8: expect.any(Number),
        },
      });
      expect(compact.gaps).toContainEqual({
        code: "context-too-large",
        literature_id: FIXTURE_LITERATURE.literature_id,
      });
      const reference = compact.items[0]!.reference;
      if (reference.kind !== "document")
        throw new Error("expected fixed Document reference");
      const expanded = await query.documentRead!.slice({
        document_version_id: reference.document_version_id,
        selector: {
          kind: "range",
          start_utf8: reference.start_utf8,
          end_utf8: reference.end_utf8,
        },
        max_bytes: 65536,
        continuation: null,
      });
      expect(expanded.text).toContain("αβ");
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("indexes exact published versions and returns verified Unicode text with resolvable evidence", async () => {
    const env = await fixture(true);
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      const asset = env.asset!;
      const selection = (revision: number | null) => ({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        mode: "reparse" as const,
        expected_default_revision: revision,
      });
      const old = await env.app.documentProcessing.parseDocuments(
        selection(null),
      );
      env.setText(
        "# Results\nDose 10 mg increased yield.\n\n| group | value |\n| B | 4 mg |\n",
      );
      const current = await env.app.documentProcessing.parseDocuments(
        selection(old.default_revision),
      );
      expect(current.document.document_version_id).not.toBe(
        old.document.document_version_id,
      );
      await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const base = { ...request(["document"]), query: "dose" };
      const latest = await query.context!.search(base);
      expect(latest.coverage).toBe("complete");
      expect(latest.items).toHaveLength(1);
      expect(latest.items[0]).toMatchObject({
        kind: "source-text",
        text: "Dose 10 mg increased yield.\n",
        reference: {
          document_version_id: current.document.document_version_id,
        },
      });
      expect(latest.items[0]!.evidence.length).toBeGreaterThan(0);
      const withoutEvidence = recount({
        ...latest,
        items: [{ ...latest.items[0]!, evidence: [] }],
      });
      expect(() =>
        parseMaterialContextBundle(
          withoutEvidence,
          parseMaterialContextRequest(base),
        ),
      ).toThrow();
      const resolved = await Promise.all(
        latest.items[0]!.evidence.map((evidence) =>
          query!.documentRead!.resolveEvidence(evidence),
        ),
      );
      expect(
        resolved.some(
          (item) =>
            "text" in item && item.text === "Dose 10 mg increased yield.\n",
        ),
      ).toBe(true);
      const historical = await query.context!.search({
        ...base,
        versions: {
          kind: "explicit",
          documents: [
            {
              literature_id: FIXTURE_LITERATURE.literature_id,
              document_version_id: old.document.document_version_id,
              representation_sha256: old.document.representation_sha256,
            },
          ],
        },
      });
      expect(historical.items).toHaveLength(1);
      expect(historical.items[0]).toMatchObject({
        text: "Dose 5 mg increased yield.\n",
        reference: { document_version_id: old.document.document_version_id },
      });
      await expect(
        query.context!.search({
          ...base,
          versions: {
            kind: "explicit",
            documents: [
              {
                literature_id: FIXTURE_LITERATURE.literature_id,
                document_version_id: old.document.document_version_id,
                representation_sha256: "0".repeat(64),
              },
            ],
          },
        }),
      ).rejects.toThrow("context-source-integrity");
      const table = await query.context!.search({ ...base, query: "group" });
      expect(table.items[0]?.text).toContain("| B | 4 mg |");
      const nextGeneration = await env.app.maintenance!.rebuildIndex();
      expect(nextGeneration.entry_count).toBeGreaterThan(0);
      const repeated = await query.context!.search(base);
      expect(repeated).toMatchObject({
        generation_id: nextGeneration.generation_id,
        coverage: "complete",
      });
      expect(repeated.items[0]?.text).toBe("Dose 10 mg increased yield.\n");
      const repeatedEvidence = await query.documentRead!.resolveEvidence(
        repeated.items[0]!.evidence.at(-1)!,
      );
      expect("text" in repeatedEvidence && repeatedEvidence.text).toBe(
        "Dose 10 mg increased yield.\n",
      );
      expect(env.parses).toBe(2);
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("reports evidence-limit for a matching unit with more than 32 source segments", async () => {
    const env = await fixture(true);
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      env.setText(
        `# Results\n${Array.from({ length: 40 }, (_, i) => `Dose line ${i}.\n`).join("")}`,
      );
      await env.app.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: env.asset!.asset_id,
        asset_sha256: env.asset!.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const bundle = await query.context!.search({
        ...request(["document"]),
        query: "dose",
      });
      expect(bundle.coverage).toBe("partial");
      expect(bundle.items[0]).toMatchObject({
        kind: "source-text",
        text: "",
        gap: "evidence-limit",
        evidence: [],
      });
      expect(bundle.gaps).toContainEqual({
        code: "evidence-limit",
        literature_id: FIXTURE_LITERATURE.literature_id,
      });
    } finally {
      await query?.close();
      await env.close();
    }
  });

  it("marks candidate-limit before pagination when more than 4097 matching rows exist", async () => {
    const env = await fixture(true);
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      env.setText(
        `# Results\n${Array.from({ length: 4100 }, (_, i) => `Dose evidence ${i}.\n\n`).join("")}`,
      );
      await env.app.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: env.asset!.asset_id,
        asset_sha256: env.asset!.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
      await env.app.maintenance!.rebuildIndex();
      query = await createQueryApplication(env.home);
      const bundle = await query.context!.search({
        ...request(["document"]),
        query: "dose",
        budget: { max_items: 20, max_bytes: 262_144, token_limit: null },
      });
      expect(bundle.coverage).toBe("partial");
      expect(bundle.gaps).toContainEqual({
        code: "candidate-limit",
        literature_id: null,
      });
      expect(bundle.items).toHaveLength(20);
      expect(
        new Set(
          bundle.items.map((item) =>
            item.reference.kind === "document" ? item.reference.start_utf8 : -1,
          ),
        ).size,
      ).toBe(20);
    } finally {
      await query?.close();
      await env.close();
    }
  });
});
