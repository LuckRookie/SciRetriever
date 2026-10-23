import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import { LIBRARY_INTAKE_BACKFILL_SQL } from "../src/storage/sqlite/schema.js";

it("maintains earliest UTC intake on observation/link/provenance changes and rollback; uses the sort index", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-"));
  const db = new DatabaseSync(join(home, "catalog.sqlite"));
  try {
    initializeCurrentCatalog(db);
    db.exec("PRAGMA foreign_keys=ON;BEGIN");
    for (const id of ["a", "b", "c"]) {
      db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(
        "meta-" + id,
        id,
      );
      db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(
        id,
        "meta-" + id,
      );
    }
    db.exec("COMMIT");
    const compare = () => {
      const slow = db
        .prepare(
          "SELECT l.literature_id,(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',min(julianday(p.observed_at))) FROM literature_metadata_observations lo JOIN metadata_observations o ON o.observation_id=lo.observation_id JOIN provenances p ON p.provenance_id=o.provenance_id WHERE lo.literature_id=l.literature_id) AS intake_at FROM literatures l ORDER BY l.literature_id",
        )
        .all();
      expect(
        db
          .prepare("SELECT * FROM literature_intake ORDER BY literature_id")
          .all(),
      ).toEqual(slow);
    };
    compare();
    const observation = db.prepare(
      "INSERT INTO metadata_observations(observation_id,provenance_id,version_role) VALUES(?,?,'published')",
    );
    for (const [id, time] of [
      ["first", "2026-10-20T01:30:00+02:00"],
      ["late", "2026-10-21T00:00:00Z"],
      ["earlier", "2020-01-01T00:00:00.100Z"],
    ] as const) {
      db.prepare(
        "INSERT INTO provenances VALUES(?,'metadata-provider','synthetic',NULL,?,NULL,NULL)",
      ).run(id, time);
      observation.run(id, id);
      db.prepare(
        "INSERT INTO literature_metadata_observations VALUES('a',?)",
      ).run(id);
      compare();
    }
    expect(
      db
        .prepare(
          "SELECT intake_at FROM literature_intake WHERE literature_id='a'",
        )
        .get()?.intake_at,
    ).toBe("2020-01-01T00:00:00.100Z");
    db.exec(
      "UPDATE literature_metadata_observations SET literature_id='b' WHERE observation_id='earlier'",
    );
    compare();
    db.exec(
      "UPDATE provenances SET observed_at='2019-01-01T01:00:00+01:00' WHERE provenance_id='late'",
    );
    compare();
    db.exec(
      "UPDATE metadata_observations SET provenance_id='earlier' WHERE observation_id='late'",
    );
    compare();
    db.exec(
      "DELETE FROM literature_metadata_observations WHERE observation_id='earlier'",
    );
    compare();
    db.exec(
      "BEGIN;UPDATE provenances SET observed_at='1800-01-01' WHERE provenance_id='earlier';ROLLBACK",
    );
    compare();
    db.exec(
      "DELETE FROM literature_metadata_observations;DELETE FROM metadata_observations;DELETE FROM provenances",
    );
    compare();
    // The explicit backfill recovers the same derived values, without changing source facts.
    db.exec("DELETE FROM literature_intake");
    db.exec(LIBRARY_INTAKE_BACKFILL_SQL);
    compare();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT li.literature_id FROM literature_intake li INDEXED BY literature_intake_order CROSS JOIN literatures l ON l.literature_id=li.literature_id ORDER BY li.intake_at DESC,li.literature_id ASC LIMIT 50",
      )
      .all();
    expect(
      plan.some((r) => String(r.detail).includes("literature_intake_order")),
    ).toBe(true);
    expect(plan.some((r) => String(r.detail).includes("TEMP B-TREE"))).toBe(
      false,
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});
