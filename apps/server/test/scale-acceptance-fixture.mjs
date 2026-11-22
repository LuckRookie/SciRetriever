import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  migrateLiteratureSearchSchema,
  reconcileLiteratureSearchSchema,
} from "../dist/storage/sqlite/literature-search-schema-migration.js";
import { SqliteWorker } from "../dist/storage/sqlite/worker.js";

const [scale, requested] = process.argv.slice(2);
assert.ok(["10k", "1m"].includes(scale));
const root = resolve(requested);
assert.equal(dirname(root), resolve("sandbox/runs"));
assert.ok(basename(root).startsWith(`scale-acceptance-${scale}-`));
assert.equal(await realpath(root), root);
assert.deepEqual(await readdir(root), []);
const source = resolve("sandbox/scale-libraries", `${scale}-20261121`);
assert.equal(await realpath(source), source);
const fixture = JSON.parse(
  await readFile(join(source, "fixture.json"), "utf8"),
);
assert.equal(fixture.seed, 20261121);
assert.equal(fixture.papers, scale === "10k" ? 10_000 : 1_000_000);
assert.equal(fixture.catalog, join(source, "catalog.sqlite"));
assert.equal(fixture.artifacts, join(source, "artifacts"));
assert.equal(await realpath(fixture.catalog), fixture.catalog);
assert.equal(await realpath(fixture.artifacts), fixture.artifacts);

const catalog = join(root, "catalog.sqlite");
const artifacts = join(root, "artifacts");
const config = join(root, "home", ".sciretriever");
const folder = "ee000000-0000-4000-8000-000000000023";
const at = "2026-11-23T00:00:00.000Z";
const record = {
  scale,
  folder,
  fixture: { ...fixture, catalog, artifacts, home: join(root, "home") },
};
const stage = async (name, work) => {
  const start = performance.now();
  record[name] = {
    result: await work(),
    elapsed_ms: performance.now() - start,
  };
  console.log(scale, name, JSON.stringify(record[name]));
};
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort(new Error("Preparation interrupted")));

await stage("copy", async () => {
  const db = new DatabaseSync(fixture.catalog, { readOnly: true });
  try {
    await backup(db, catalog, { rate: 16_384 });
  } finally {
    db.close();
  }
  stop.signal.throwIfAborted();
  await cp(fixture.artifacts, artifacts, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(
    join(config, "config.toml"),
    [
      "[paths]",
      `catalog_path=${JSON.stringify(catalog)}`,
      `artifact_root=${JSON.stringify(artifacts)}`,
      "[sources.acquisition]",
      'mode="custom"',
      "providers=[]",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
});
stop.signal.throwIfAborted();
await stage("workset", () => {
  const db = new DatabaseSync(catalog);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO folders(folder_id,parent_id,name,position,created_at,updated_at) VALUES(?,NULL,'Scale acceptance fixture',0,?,?)",
    ).run(folder, at, at);
    const result = db
      .prepare(
        `INSERT INTO folder_members(folder_id,literature_id,added_at,actor)
      SELECT ?,literature_id,?, 'local:cli' FROM literatures ORDER BY literature_id LIMIT 10000`,
      )
      .run(folder, at);
    assert.equal(result.changes, 10_000);
    db.exec("COMMIT");
    return result.changes;
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
});
await stage("migration", () => migrateLiteratureSearchSchema(catalog));
stop.signal.throwIfAborted();
await stage("reconcile", () => reconcileLiteratureSearchSchema(catalog));
stop.signal.throwIfAborted();
await stage("backfill", async () => {
  const worker = new SqliteWorker(catalog);
  try {
    await worker.configureLibraryState(6, "vlm-engine");
    let batches = 0;
    let progressAt = performance.now();
    while (await worker.libraryStatePending()) {
      stop.signal.throwIfAborted();
      const batch = await worker.refreshLibraryState();
      batches++;
      if (performance.now() - progressAt > 30_000) {
        console.log(scale, "backfill", batches, JSON.stringify(batch));
        progressAt = performance.now();
      }
      if (!batch.more) break;
    }
    assert.equal(await worker.libraryStatePending(), false);
    return batches;
  } finally {
    await worker.close();
  }
});
const proof = new DatabaseSync(catalog, { readOnly: true });
try {
  const row = proof
    .prepare(
      "SELECT papers,versions,obtained FROM library_count_totals WHERE scope='all'",
    )
    .get();
  assert.equal(row.papers, fixture.papers);
  assert.equal(row.versions, fixture.counts.literature);
  assert.equal(row.obtained, fixture.papers / 10);
  record.corpus = row;
} finally {
  proof.close();
}
await writeFile(
  join(root, "prepared.json"),
  JSON.stringify(record, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
