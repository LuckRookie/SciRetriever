import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_METADATA,
  parseLiterature,
  parseRetrievalGenerationReceipt,
} from "@sciretriever/contracts";
import { expect, it } from "vitest";
import {
  generateScaleLibrary,
  type ScaleLibrary,
} from "./scale-library-fixture.js";

const mode = process.env.SCIRETRIEVER_INDEX_CAPACITY;
const papers = 120_000;
const seed = 20261121;
const additions = 1000;
const run = resolve("sandbox/runs/2026-11-21-index-capacity");
const reports = resolve("sandbox/reports/2026-11-21-index-capacity");
type Application = import("../dist/bootstrap/application.js").Application;
type Index = import("../dist/retrieval/index.js").RetrievalIndexService;
type Store =
  import("../dist/storage/sqlite/retrieval-client.js").RetrievalStorageClient;
type Timings = Record<string, { calls: number; elapsed_ms: number }>;

function instrument<T extends object, K extends keyof T>(
  object: T,
  key: K,
  replacement: T[K],
) {
  const original = object[key];
  object[key] = replacement;
  return () => {
    object[key] = original;
  };
}

async function write(name: string, value: unknown) {
  await writeFile(
    join(reports, `${name}.json`),
    JSON.stringify(value, null, 2) + "\n",
  );
}

function inspectFixture(library: ScaleLibrary) {
  const db = new DatabaseSync(library.catalog, { readOnly: true });
  try {
    return db
      .prepare(
        `
      SELECT (SELECT count(*) FROM literatures) AS metadata_sources,
        (SELECT count(*) FROM document_versions) AS document_sources
    `,
      )
      .get() as { metadata_sources: number; document_sources: number };
  } finally {
    db.close();
  }
}

async function rebuild(
  app: Application,
  index: Index,
  store: Store,
  name: string,
  sourceCounts: ReturnType<typeof inspectFixture>,
) {
  const timings: Timings = {};
  const totalStarted = performance.now();
  let metadataStarted = totalStarted,
    documentStarted: number | undefined,
    stagedAt: number | undefined;
  let peakRss = process.memoryUsage.rss(),
    collected = 0,
    lastProgress = totalStarted;
  const rssBefore = peakRss;
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, 250);
  const timed = async <T>(operation: string, work: () => Promise<T>) => {
    const start = performance.now();
    try {
      return await work();
    } finally {
      const info = (timings[operation] ??= { calls: 0, elapsed_ms: 0 });
      info.calls++;
      info.elapsed_ms += performance.now() - start;
    }
  };
  const metadataPage = store.metadataPage.bind(store);
  const documentPage = store.documentPage.bind(store);
  const begin = store.beginGeneration.bind(store);
  const insert = store.insertEntries.bind(store);
  const publish = store.publish.bind(store);
  const prune = store.pruneGenerationBatch.bind(store);
  const detail = app.library.detail.bind(app.library);
  const text = app.documentRead.withVerifiedTextVersion.bind(app.documentRead);
  const probes = [
    instrument(store, "metadataPage", (after, limit) => {
      if (after === null) metadataStarted = performance.now();
      return timed("metadata_page", () => metadataPage(after, limit));
    }),
    instrument(store, "documentPage", (after, limit) => {
      documentStarted ??= performance.now();
      return timed("document_page", () => documentPage(after, limit));
    }),
    instrument(store, "beginGeneration", (...args) => {
      stagedAt = performance.now();
      return timed("begin_generation_and_integrity_checks", () =>
        begin(...args),
      );
    }),
    instrument(store, "insertEntries", (...args) =>
      timed("sqlite_entry_and_fts_inserts", () => insert(...args)),
    ),
    instrument(store, "publish", (...args) =>
      timed("publish_integrity_and_hashes", () => publish(...args)),
    ),
    instrument(store, "pruneGenerationBatch", (...args) =>
      timed("retired_generation_cleanup", () => prune(...args)),
    ),
    instrument(app.library, "detail", (id) =>
      timed(
        documentStarted === undefined
          ? "metadata_detail"
          : "document_metadata_detail",
        () => detail(id),
      ),
    ),
    instrument(app.documentRead, "withVerifiedTextVersion", (...args) =>
      timed("document_verification_render_and_spool", () => text(...args)),
    ),
  ];
  const results = () => {
    const now = performance.now();
    const metadataMs = (documentStarted ?? now) - metadataStarted;
    const documentMs =
      documentStarted === undefined
        ? null
        : (stagedAt ?? now) - documentStarted;
    return {
      elapsed_ms: Math.round(now - totalStarted),
      source_counts: sourceCounts,
      collected,
      metadata_ms: Math.round(metadataMs),
      document_ms: documentMs === null ? null : Math.round(documentMs),
      metadata_sources_per_second:
        documentStarted === undefined
          ? null
          : (sourceCounts.metadata_sources * 1000) / metadataMs,
      document_sources_per_second:
        documentMs === null || stagedAt === undefined
          ? null
          : (sourceCounts.document_sources * 1000) / documentMs,
      timings,
      rss_before_bytes: rssBefore,
      rss_peak_bytes: peakRss,
      load: loadavg(),
    };
  };
  try {
    const receipt = await index.build(undefined, async ({ done, total }) => {
      collected = done;
      if (performance.now() - lastProgress >= 15_000) {
        lastProgress = performance.now();
        await write(`${name}-progress`, { done, total, ...results() });
      }
    });
    await write(name, { ...results(), receipt });
    return receipt;
  } catch (error) {
    await write(name, {
      ...results(),
      error: String(error),
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : null,
    });
    throw error;
  } finally {
    clearInterval(sample);
    for (const restore of probes) restore();
  }
}

/** The receipt's generation and SQLite entry rowids change across full rebuilds. */
function indexDigest(catalog: string) {
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    const h = createHash("sha256");
    const rows = db.prepare(`
      SELECT e.kind,e.literature_id,e.meta_literature_id,e.metadata_revision,e.metadata_sha256,
        e.document_version_id,e.representation_sha256,e.source_asset_id,e.source_asset_sha256,
        e.unit_start_utf8,e.unit_end_utf8,e.unit_sha256,e.section_id,e.unit_ordinal,e.is_default,f.title,f.body
      FROM retrieval_active_generation a JOIN retrieval_entries e USING(generation_id)
      JOIN retrieval_fts f ON f.rowid=e.entry_id
      ORDER BY e.kind,e.literature_id,e.document_version_id,e.unit_ordinal,e.entry_id
    `);
    for (const row of rows.iterate())
      h.update(JSON.stringify(Object.values(row)) + "\n");
    return h.digest("hex");
  } finally {
    db.close();
  }
}

it.runIf(mode !== undefined)(
  "rebuilds above 100,000 sources and refreshes another 1000 papers with the same result as rebuilding",
  { timeout: 90 * 60 * 1000 },
  async () => {
    if (mode !== "before" && mode !== "after")
      throw new Error("SCIRETRIEVER_INDEX_CAPACITY must be before or after");
    await mkdir(run, { recursive: true });
    await mkdir(reports, { recursive: true });
    // Each invocation keeps its own catalog because the test appends papers.
    const directory = await mkdtemp(join(run, `${mode}-`));
    const library = await generateScaleLibrary({
      directory: join(directory, "library"),
      papers,
      seed,
      sourceRecords: 200,
    });
    await write(`fixture-${mode}`, library);
    const counts = inspectFixture(library);
    expect(counts.metadata_sources).toBe(library.counts.literature);
    expect(counts.metadata_sources + counts.document_sources).toBeGreaterThan(
      100_000,
    );
    // Using the built server allows the unchanged build to run while the fix is prepared.
    const { createApplication, createQueryApplication } = await import(
      "../dist/bootstrap/application.js"
    );
    const { SqliteWorker } = await import("../dist/storage/sqlite/worker.js");
    const { RetrievalStorageClient } = await import(
      "../dist/storage/sqlite/retrieval-client.js"
    );
    const { RetrievalIndexService } = await import(
      "../dist/retrieval/index.js"
    );
    const app = await createApplication(library.home, {
      browserHost: () => null,
      metadata: {},
      indexRefreshIntervalMs: null,
    });
    const worker = new SqliteWorker(library.catalog, app.writes);
    const store = new RetrievalStorageClient(worker);
    const index = new RetrievalIndexService(
      store,
      app.documentRead,
      app.library,
      app.writes,
    );
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      const initial = await rebuild(app, index, store, mode, counts);
      expect(parseRetrievalGenerationReceipt(initial)).toEqual(initial);
      expect(initial.source_count).toBe(
        counts.metadata_sources + counts.document_sources,
      );
      expect(initial.source_revision).toBe(await store.revision());

      const appended: string[] = [];
      for (let n = 0; n < additions; n++) {
        const suffix = String(n).padStart(12, "0");
        const literature_id = `ffcaf000-0001-4000-8000-${suffix}`;
        await app.database.putLiterature(
          parseLiterature({
            literature_id,
            meta_literature_id: `ffcaf000-0002-4000-8000-${suffix}`,
            version_role: "published",
            status: "UNREVIEWED",
            metadata: {
              ...EMPTY_METADATA,
              publication_year: 2026,
              publication_form: "journal-article",
              title: `capacityappend spectroscopy ${n}`,
            },
          }),
        );
        appended.push(literature_id);
      }
      const started = performance.now();
      const updated = await index.refresh();
      const elapsed_ms = Math.round(performance.now() - started);
      expect(updated.generation_id).toBe(initial.generation_id);
      expect(updated.source_count).toBe(initial.source_count + additions);
      expect(updated.source_revision).toBe(await store.revision());
      expect((await store.scanChanges()).literature_ids).toEqual([]);

      query = await createQueryApplication(library.home);
      const search = async (text: string) => {
        const result = await query!.context!.search({
          query: text,
          scope: { kind: "library" },
          kinds: ["metadata", "document"],
          versions: { kind: "default" },
          budget: { max_items: 12, max_bytes: 65536, token_limit: null },
          continuation: null,
        });
        const { items, coverage, gaps, indexed_revision, source_revision } =
          result;
        expect(indexed_revision).toBe(source_revision);
        return { items, coverage, gaps };
      };
      const samples = [
        "capacityappend 29",
        "optical spectroscopy",
        "synthetic specimen",
      ];
      const incremental = [];
      for (const sample of samples) incremental.push(await search(sample));
      expect(
        incremental[0]!.items.some((hit) => hit.literature_id === appended[29]),
      ).toBe(true);
      const digest = indexDigest(library.catalog);
      await write("incremental", {
        updated,
        elapsed_ms,
        digest,
        checked_queries: samples,
        load: loadavg(),
      });

      const rebuilt = await rebuild(
        app,
        index,
        store,
        "rebuild-after-append",
        inspectFixture(library),
      );
      expect(rebuilt.source_revision).toBe(updated.source_revision);
      expect(rebuilt.source_count).toBe(updated.source_count);
      expect(rebuilt.entry_count).toBe(updated.entry_count);
      expect(indexDigest(library.catalog)).toBe(digest);
      for (const [i, sample] of samples.entries())
        expect(await search(sample)).toEqual(incremental[i]);
      await write("comparison", {
        digest,
        consistent: true,
        checked_queries: samples,
      });
    } finally {
      await query?.close();
      await index.close();
      await worker.close();
      await app.close();
    }
  },
);
