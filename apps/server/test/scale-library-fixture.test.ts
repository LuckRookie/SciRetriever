import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { inspectCatalogRetrieval } from "../src/storage/sqlite/catalog-schema.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  generateScaleLibrary,
  SCALE_LIBRARY_SEED,
  SCALE_LIBRARY_SIZES,
  type ScaleLibrary,
} from "./scale-library-fixture.js";
import { measureScaleLibrary } from "./scale-library-benchmark.js";

it("generates a valid 2000-paper scale library with product-readable material, tasks and counts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sciretriever-scale-library-"));
  let app: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    const library = await generateScaleLibrary({
      directory: join(temp, "library"),
      papers: 2000,
      seed: SCALE_LIBRARY_SEED,
      sourceRecords: 200,
    });
    expect(await inspectCatalogRetrieval(library.catalog)).toMatchObject({
      schema_version: 19,
      integrity: "ok",
      foreign_keys: "ok",
    });
    const db = new DatabaseSync(library.catalog, { readOnly: true });
    try {
      const counts = db
        .prepare(
          `
        SELECT (SELECT count(*) FROM meta_literatures) AS meta,
          (SELECT count(*) FROM literatures) AS literature,
          (SELECT count(*) FROM meta_literatures p WHERE (SELECT count(*) FROM literatures l WHERE l.meta_literature_id=p.meta_literature_id)=2) AS double,
          (SELECT count(*) FROM literatures l WHERE version_role='published' AND NOT EXISTS(SELECT 1 FROM literature_metadata_identifiers i WHERE i.literature_id=l.literature_id AND namespace='doi')) AS without_doi
      `,
        )
        .get();
      expect(counts).toEqual({
        meta: 2000,
        literature: 2200,
        double: 200,
        without_doi: 300,
      });
      expect(counts).toMatchObject({
        meta: library.counts.meta,
        literature: library.counts.literature,
        double: library.counts.double,
        without_doi: library.counts.without_doi,
      });
    } finally {
      db.close();
    }
    app = await createQueryApplication(library.home);
    expect(app.readiness).toMatchObject({
      status: "ready",
      schema_version: 19,
    });
    expect(await app.query!.counts({})).toMatchObject({
      total: library.counts.literature,
      with_primary_pdf: 200,
      statuses: library.counts.statuses,
      full_text: { total: 2000, obtained: 200, missing: 1800, exhausted: 0 },
    });
    expect(await app.query!.counts({ text_levels: ["draft"] })).toMatchObject({
      total: library.counts.draft,
    });
    expect(
      await app.documentRead!.describe({ document_version_id: library.draft }),
    ).toMatchObject({ text_level: "draft" });
    expect(await app.taskRead!(library.jobs.running)).toMatchObject({
      job: { status: "running" },
      start_requested: true,
      source_results: {
        metadata: {
          sources: expect.arrayContaining([
            expect.objectContaining({ source: "crossref" }),
            expect.objectContaining({ source: "openalex" }),
          ]),
        },
      },
    });
    expect(await app.taskRead!(library.jobs.completed)).toMatchObject({
      job: { status: "completed" },
    });
    const taskDatabase = new SqliteWorker(library.catalog, undefined, {
      readOnly: true,
    });
    try {
      expect(
        await taskDatabase.getExecutionPolicy(library.jobs.running),
      ).toMatchObject({
        mode: "never",
        intervention_timeout_ms: expect.any(Number),
      });
    } finally {
      await taskDatabase.close();
    }
  } finally {
    await app?.close();
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

const selectedScale = process.env.SCIRETRIEVER_SCALE_LIBRARY;
it.runIf(selectedScale !== undefined)(
  "runs an explicitly selected scale library",
  { timeout: (selectedScale === "1m" ? 12 : 4) * 60 * 60 * 1000 },
  async () => {
    if (
      selectedScale !== "10k" &&
      selectedScale !== "1m" &&
      selectedScale !== "10m"
    )
      throw new Error("SCIRETRIEVER_SCALE_LIBRARY must be 10k, 1m or 10m");
    const seed = Number(
      process.env.SCIRETRIEVER_SCALE_LIBRARY_SEED ?? SCALE_LIBRARY_SEED,
    );
    if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff)
      throw new Error("Invalid SCIRETRIEVER_SCALE_LIBRARY_SEED");
    const papers = SCALE_LIBRARY_SIZES[selectedScale];
    const name = `${selectedScale}-${seed}`;
    const directory = resolve("sandbox/scale-libraries", name);
    const reports = resolve("sandbox/reports/2026-11-21-scale-library", name);
    const reuse = process.env.SCIRETRIEVER_SCALE_LIBRARY_REUSE === "1";
    const stage =
      process.env.SCIRETRIEVER_SCALE_LIBRARY_STAGE ?? (reuse ? "reads" : "all");
    if (
      stage !== "all" &&
      stage !== "generate" &&
      stage !== "index" &&
      stage !== "reads" &&
      stage !== "memory"
    )
      throw new Error("Invalid scale library stage");
    await mkdir(reports, { recursive: true, mode: 0o700 });
    try {
      await mkdir(resolve("sandbox/scale-libraries"), {
        recursive: true,
        mode: 0o700,
      });
      let library: ScaleLibrary;
      if (stage !== "all" && stage !== "generate") {
        if ((await realpath(directory)) !== directory)
          throw new Error("Unexpected scale directory path");
        library = JSON.parse(
          await readFile(join(directory, "fixture.json"), "utf8"),
        ) as ScaleLibrary;
        if (
          library.papers !== papers ||
          library.seed !== seed ||
          library.home !== join(directory, "home") ||
          library.catalog !== join(directory, "catalog.sqlite") ||
          library.artifacts !== join(directory, "artifacts")
        )
          throw new Error("Scale fixture path or identity mismatch");
        for (const path of [
          library.catalog,
          library.artifacts,
          join(library.home, ".sciretriever", "config.toml"),
        ]) {
          if ((await realpath(path)) !== path)
            throw new Error("Unexpected scale fixture path");
        }
      } else {
        library = await generateScaleLibrary({
          directory,
          seed,
          papers,
          sourceRecords: 1_000_000,
        });
      }
      if (stage === "all" || stage === "generate") {
        await writeFile(
          join(reports, "generation.json"),
          JSON.stringify({ ...library, load: loadavg() }, null, 2) + "\n",
          { mode: 0o600 },
        );
      }
      if (stage !== "generate")
        await measureScaleLibrary(library, reports, stage);
    } catch (error) {
      await writeFile(
        join(reports, "failure.json"),
        JSON.stringify(
          { error: String(error), at: new Date().toISOString() },
          null,
          2,
        ) + "\n",
      );
      throw error;
    }
  },
);
