import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToSignals } from "node:timers/promises";
import { ftsIndexText } from "../dist/literature/unicode-casefold.js";
import {
  deleteLiteratureSearchRows,
  INSERT_LITERATURE_SEARCH_ROW,
} from "../dist/storage/sqlite/literature-search-rows.js";
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
const fulltextFolders = {
  all: "ee000000-0000-4000-8000-000000000024",
  half: "ee000000-0000-4000-8000-000000000025",
};
const fulltextMembers = Math.min(10_000, fixture.papers / 10);
const at = "2026-11-23T00:00:00.000Z";
const started = performance.now();
const record = {
  scale,
  folder,
  fulltext_folders: { ...fulltextFolders, members: fulltextMembers },
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

function indexSentence(text) {
  return ftsIndexText(text).split(" ");
}

const lead = indexSentence(
  "Previous studies of variation in repeated measurements motivate this study.",
);
const spectroscopy = indexSentence(
  "We cross checked the spectroscopy signal against the calibrated reference.",
);
const sections = [
  [
    "The response of each sample depends on its history as well as the current conditions.",
    "Prior studies in related systems report an association with the local temperature.",
    "Comparisons of published datasets suggest that estimates vary across settings.",
    "A common protocol provides a reference for observing changes in the samples.",
    "The proposed model links changes in the observed response to the exchange rate.",
    "Natural variation in the baseline may obscure the influence of the treatment.",
  ],
  [
    "We recorded measurements in a fixed sequence to limit drift within each session.",
    "The control group received the same preparation at each of the sampling sites.",
    "An independent series of reference measurements set the uncertainty in the calibration.",
    "Replicate samples were diluted before transfer to a clean vessel of known volume.",
    "The analysis used random intercepts for experimental blocks observed on the same date.",
    "Sensitivity checks accounted for missing intervals in the observations.",
  ],
  [
    "The median response in the second interval exceeded the estimated reference value.",
    "A comparison of the replicate curves supported the original direction of change.",
    "The residual variation was largest in the samples collected at the beginning of the series.",
    "The joint distribution of the measurements remained stable in both of the control experiments.",
    "Increasing the observation period narrowed the interval around the estimated rate.",
    "The adjusted estimates preserved the order of the measurements across groups.",
  ],
  [
    "These findings agree with several earlier studies of the same response in similar settings.",
    "The observed differences may reflect variation in the initial composition of the samples.",
    "Further studies should test the effect of the sampling interval in independent experiments.",
    "The apparent plateau is consistent with the assumption of a limited response.",
    "Uncertainty about changes in the control limits the interpretation of the smallest effect.",
    "Additional measurements would distinguish the competing explanations of the result.",
  ],
].map((section) => section.map(indexSentence));
const sectionText = sections.map((section) =>
  section.map((words) => words.join(" ")),
);
const spectroscopyText = spectroscopy.join(" ");

function syntheticBody(seed, id) {
  let state =
    createHash("sha256").update(`${seed}:${id}`).digest().readUInt32LE(0) || 1;
  const sample = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  const quantile = sample();
  const bounds = [
    [0, 2_500],
    [0.5, 6_000],
    [0.94, 10_000],
    [0.99, 18_000],
    [1, 30_001],
  ];
  const upper = bounds.findIndex(([percentile]) => percentile > quantile);
  const [lowerPercentile, lowerWords] = bounds[upper - 1];
  const [upperPercentile, upperWords] = bounds[upper];
  const length =
    lowerWords +
    Math.floor(
      ((quantile - lowerPercentile) / (upperPercentile - lowerPercentile)) *
        (upperWords - lowerWords),
    );
  const hasSpectroscopy = sample() < 0.3;
  const sentences = [lead.join(" ")];
  let count = lead.length;
  if (hasSpectroscopy) {
    sentences.push(spectroscopyText);
    count += spectroscopy.length;
  }
  while (count < length) {
    const section = Math.floor((count / length) * sections.length);
    const next = Math.floor(sample() * sections[section].length);
    const words = sections[section][next];
    const text = sectionText[section][next];
    const remaining = length - count;
    sentences.push(
      remaining < words.length ? words.slice(0, remaining).join(" ") : text,
    );
    count += words.length;
  }
  return { body: sentences.join(" "), length, hasSpectroscopy };
}

function writeFulltextFolders(db) {
  const insertFolder = db.prepare(
    "INSERT INTO folders(folder_id,parent_id,name,position,created_at,updated_at) VALUES(?,NULL,?,0,?,?)",
  );
  const insertMembers = db.prepare(
    `INSERT INTO folder_members(folder_id,literature_id,added_at,actor)
     SELECT ?,value,?,'local:cli' FROM json_each(?)`,
  );
  const sample = (fulltext, available, size) => {
    const ids = db
      .prepare(
        `WITH ordered AS (
          SELECT m.representative_literature_id AS id,
            row_number() OVER (ORDER BY m.representative_literature_id) AS ordinal
          FROM meta_literatures m
          WHERE ${fulltext ? "" : "NOT"} EXISTS (
            SELECT 1 FROM literature_assets a
            WHERE a.literature_id=m.representative_literature_id AND a.role='primary-pdf'
          )
        )
        SELECT id FROM ordered WHERE (ordinal-1) % ?=0 ORDER BY ordinal LIMIT ?`,
      )
      .all(Math.floor(available / size), size)
      .map(({ id }) => id);
    assert.equal(ids.length, size);
    return ids;
  };
  const all = sample(true, fixture.papers / 10, fulltextMembers);
  const half = [
    ...all.filter((_, i) => i % 2 === 0),
    ...sample(false, (9 * fixture.papers) / 10, fulltextMembers / 2),
  ];
  for (const [id, name, ids] of [
    [fulltextFolders.all, "Scale acceptance full text", all],
    [fulltextFolders.half, "Scale acceptance mixed text", half],
  ]) {
    insertFolder.run(id, name, at, at);
    assert.equal(
      insertMembers.run(id, at, JSON.stringify(ids)).changes,
      fulltextMembers,
    );
  }
}

async function writeFulltextIndex() {
  const db = new DatabaseSync(catalog);
  const columns = [
    "literature_id",
    "title",
    "abstract",
    "authors",
    "affiliations",
    "identifiers",
    "keywords",
    "venue",
    "publisher",
    "volume",
    "issue",
    "pages",
  ];
  const digest = createHash("sha256");
  const lengths = [];
  let bodyBytes = 0;
  let commonHits = 0;
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
    const boundary = db
      .prepare("SELECT max(rowid) AS last FROM literature_search_fts")
      .get().last;
    const read = db.prepare(
      `SELECT f.rowid AS doc,${columns.map((column) => `f.${column}`).join(",")},f.content_body,
        EXISTS (SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id
          AND a.role='primary-pdf') AS has_body
      FROM literature_search_fts f
      WHERE f.rowid>? AND f.rowid<=? ORDER BY f.rowid LIMIT 1000`,
    );
    const insert = db.prepare(INSERT_LITERATURE_SEARCH_ROW);
    let cursor = 0;
    let versions = 0;
    let progressAt = performance.now();
    // Replaying the original FTS order keeps the window representative.
    // Updating only the full-text rows with the shared INSERT would move
    // that entire group to the newest end of the index.
    for (;;) {
      stop.signal.throwIfAborted();
      const rows = read.all(cursor, boundary);
      if (rows.length === 0) break;
      db.exec("BEGIN IMMEDIATE");
      deleteLiteratureSearchRows(
        db,
        rows.map(({ doc }) => BigInt(doc)),
      );
      for (const row of rows) {
        assert.equal(row.content_body, "");
        let body = "";
        if (row.has_body) {
          const generated = syntheticBody(fixture.seed, row.literature_id);
          body = generated.body;
          lengths.push(generated.length);
          bodyBytes += Buffer.byteLength(body);
          commonHits += Number(generated.hasSpectroscopy);
          digest
            .update(row.literature_id)
            .update("\0")
            .update(body)
            .update("\0");
        }
        insert.run(...columns.map((column) => row[column]), body);
      }
      db.exec("COMMIT");
      cursor = rows.at(-1).doc;
      versions += rows.length;
      if (performance.now() - progressAt > 30_000) {
        console.log(
          scale,
          "fulltext",
          versions,
          "versions",
          lengths.length,
          "bodies",
        );
        progressAt = performance.now();
      }
      await yieldToSignals();
    }
    assert.equal(versions, fixture.counts.literature);
    assert.equal(lengths.length, fixture.papers / 10);
    const indexed = db
      .prepare("SELECT count(*) AS n FROM literature_search_fts_content")
      .get();
    assert.equal(indexed.n, versions);
    const count = db.prepare(
      "SELECT count(*) AS n FROM literature_search_fts WHERE literature_search_fts MATCH ?",
    );
    const matches = {
      in: count.get('content_body : "in"').n,
      spectroscopy: count.get('content_body : "spectroscopy"').n,
      three: count.get('content_body : ("studies" AND "of" AND "in")').n,
    };
    assert.deepEqual(matches, {
      in: lengths.length,
      spectroscopy: commonHits,
      three: lengths.length,
    });
    // The source catalog was indexed before it had bodies. Remove the dead
    // postings from replay so this represents a freshly generated FTS index.
    const segments = db.prepare(
      "SELECT count(DISTINCT segid) AS n FROM literature_search_fts_idx",
    );
    const before = segments.get().n;
    const compactAt = performance.now();
    db.exec(
      "INSERT INTO literature_search_fts(literature_search_fts) VALUES('optimize')",
    );
    const compaction = {
      elapsed_ms: performance.now() - compactAt,
      segments_before: before,
      segments_after: segments.get().n,
    };
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    lengths.sort((a, b) => a - b);
    return {
      versions,
      papers: lengths.length,
      body_bytes: bodyBytes,
      body_sha256: digest.digest("hex"),
      body_matches: matches,
      compaction,
      words: {
        min: lengths[0],
        p50: lengths[Math.ceil(lengths.length * 0.5) - 1],
        p95: lengths[Math.ceil(lengths.length * 0.95) - 1],
        max: lengths.at(-1),
      },
    };
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

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
    writeFulltextFolders(db);
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
await stage("fulltext", writeFulltextIndex);
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
  record.catalog_free_bytes =
    proof.prepare("PRAGMA freelist_count").get().freelist_count *
    proof.prepare("PRAGMA page_size").get().page_size;
} finally {
  proof.close();
}
record.catalog_bytes = (await stat(catalog)).size;
record.preparation_ms = performance.now() - started;
await writeFile(
  join(root, "prepared.json"),
  JSON.stringify(record, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
