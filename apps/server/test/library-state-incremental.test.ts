import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import { LibraryStateCache } from "./legacy-library-state-cache.js";
import { archiveStates } from "../src/storage/sqlite/archive-engine.js";
import { deriveCurrentState } from "../src/literature/state.js";

function paper(db: DatabaseSync, id: string, meta = id) {
  if (meta === id)
    db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(id, id);
  db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(id, meta);
  db.prepare(
    "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,'Fixture')",
  ).run(id, "a".repeat(64));
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  initializeCurrentCatalog(db);
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  for (const id of ["a", "b"]) paper(db, id);
  paper(db, "c", "a");
  db.exec("COMMIT");
  return db;
}
const full = (
  db: DatabaseSync,
  maxTags = 6,
  profile: "pipeline" | "vlm-engine" = "vlm-engine",
) =>
  new Map(
    [...archiveStates(db)].map(([id, facts]) => [
      id,
      deriveCurrentState(facts, maxTags, profile),
    ]),
  );
const read = (cache: LibraryStateCache, db: DatabaseSync) =>
  cache.read(db, "fixture", 6, "vlm-engine", () => {});

it("recomputes only dirty papers for independent readers and removes deleted-paper tombstones from their projections", () => {
  const db = fixture(),
    first = new LibraryStateCache(),
    second = new LibraryStateCache();
  try {
    const before = read(first, db),
      otherBefore = read(second, db);
    db.exec(
      "UPDATE literature_metadata SET title=NULL WHERE literature_id='a'",
    );
    const next = read(first, db);
    expect(next).toEqual(full(db));
    expect(next.get("a")).not.toBe(before.get("a"));
    expect(next.get("b")).toBe(before.get("b"));
    expect(next.get("c")).toBe(before.get("c"));
    expect(read(first, db)).toBe(next);
    db.exec("BEGIN; DELETE FROM literatures WHERE literature_id='c'; COMMIT");
    expect(
      db
        .prepare(
          "SELECT revision FROM library_state_changes WHERE literature_id='c'",
        )
        .get(),
    ).toBeDefined();
    for (const cache of [first, second]) {
      const value = read(cache, db);
      expect(value).toEqual(full(db));
      expect(value.has("c")).toBe(false);
      expect(value.get("b")).toBe(
        cache === first ? before.get("b") : otherBefore.get("b"),
      );
    }
    expect(before.has("c")).toBe(true);
  } finally {
    db.close();
  }
});

it("falls back for large batches, untracked revision writes, identity and policy changes", () => {
  const db = fixture(),
    cache = new LibraryStateCache();
  try {
    db.exec("BEGIN");
    for (let n = 0; n < 65; n++) paper(db, `batch-${n}`);
    db.exec("COMMIT");
    const before = read(cache, db);
    db.exec(
      "UPDATE literature_metadata SET title=NULL WHERE literature_id LIKE 'batch-%'",
    );
    const batch = read(cache, db);
    expect(batch).toEqual(full(db));
    expect(batch.get("a")).not.toBe(before.get("a"));
    db.exec("UPDATE library_state_revision SET revision=revision+1");
    const untracked = read(cache, db);
    expect(untracked).toEqual(full(db));
    expect(untracked.get("a")).not.toBe(batch.get("a"));
    const identity = cache.read(db, "replacement", 6, "vlm-engine", () => {});
    expect(identity.get("a")).not.toBe(untracked.get("a"));
    for (const [maxTags, profile] of [
      [0, "vlm-engine"],
      [6, "pipeline"],
    ] as const)
      expect(cache.read(db, "replacement", maxTags, profile, () => {})).toEqual(
        full(db, maxTags, profile),
      );
  } finally {
    db.close();
  }
});

it("publishes neither partial values nor the new revision when an incremental checkpoint is cancelled", () => {
  const db = fixture(),
    cache = new LibraryStateCache();
  try {
    const before = read(cache, db),
      saved = [...before];
    db.exec(
      "BEGIN; UPDATE literature_metadata SET title=NULL WHERE literature_id IN ('a','b')",
    );
    let checkpoints = 0;
    expect(() =>
      cache.read(db, "fixture", 6, "vlm-engine", () => {
        if (++checkpoints === 10) throw Error("cancelled");
      }),
    ).toThrow("cancelled");
    expect(checkpoints).toBe(10);
    expect([...before]).toEqual(saved);
    db.exec("ROLLBACK");
    expect(read(cache, db)).toBe(before);
    db.exec(
      "UPDATE literature_metadata SET title=NULL WHERE literature_id='a'",
    );
    expect(read(cache, db)).toEqual(full(db));
  } finally {
    db.close();
  }
});

it("uses a bounded indexed asset-owner lookup and promotes ambiguous shared assets to full invalidation", () => {
  const db = fixture(),
    cache = new LibraryStateCache();
  try {
    db.exec("BEGIN");
    for (let n = 0; n < 33; n++) paper(db, `owner-${n}`);
    db.prepare(
      "INSERT INTO artifact_objects VALUES('artifact',?,1,'application/pdf','fixture.pdf')",
    ).run("b".repeat(64));
    db.prepare(
      "INSERT INTO assets VALUES('asset',?,1,'application/pdf','fixture.pdf')",
    ).run("b".repeat(64));
    db.exec(
      "INSERT INTO provenances(provenance_id,source_kind,source_name,observed_at) VALUES('provenance','user','fixture','2026-10-29T00:00:00Z')",
    );
    for (let n = 0; n < 33; n++)
      db.prepare(
        "INSERT INTO literature_assets(literature_asset_id,literature_id,asset_id,role,provenance_id) VALUES(?,?,'asset','primary-pdf','provenance')",
      ).run(`link-${n}`, `owner-${n}`);
    db.exec("COMMIT");
    const before = read(cache, db);
    db.exec(
      "UPDATE assets SET relative_path=relative_path WHERE asset_id='asset'",
    );
    const next = read(cache, db);
    expect(next).toEqual(full(db));
    expect(next.get("a")).not.toBe(before.get("a"));
    expect(
      db
        .prepare(
          "SELECT full_revision=revision AS full FROM library_state_revision",
        )
        .get()!.full,
    ).toBe(1);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT DISTINCT literature_id FROM literature_assets WHERE asset_id=? ORDER BY literature_id LIMIT 33",
      )
      .all("asset");
    expect(
      plan.some((row) =>
        String(row.detail).includes("library_state_asset_owners"),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});
