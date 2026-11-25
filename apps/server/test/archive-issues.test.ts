import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  archiveStates,
  runArchiveStorage,
} from "../src/storage/sqlite/archive-engine.js";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  initializeCurrentCatalog(db);
  db.exec(`
    BEGIN;
    INSERT INTO provenances VALUES('source','user','fixture',NULL,'2026-11-25',NULL,NULL);
    INSERT INTO meta_literatures VALUES('meta-z','z'),('meta-a','a'),('meta-orphan','orphan');
    INSERT INTO literatures VALUES('z','meta-z','published'),('a','meta-a','published'),('orphan','meta-orphan','published');
    INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title)
      SELECT literature_id,1,printf('%064x',1),literature_id FROM literatures WHERE literature_id!='orphan';
    WITH materials(id,n,media) AS (VALUES
      ('old',1,'application/pdf'),('main',2,'application/pdf'),('supp',3,'application/pdf'),
      ('non-pdf',4,'text/html'),('dual',5,'application/pdf'))
    INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path)
      SELECT id,printf('%064x',n),n,media,'fixture/'||id FROM materials;
    INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path)
      SELECT artifact_id,sha256,byte_size,media_type,relative_path FROM artifact_objects;
    INSERT INTO literature_assets VALUES
      ('old-link','a','old','primary-pdf','source',NULL),
      ('supp-link','a','supp','supplementary-pdf','source',NULL),
      ('non-pdf-link','a','non-pdf','supplementary-pdf','source',NULL),
      ('dual-supp','z','dual','supplementary-pdf','source',NULL),
      ('dual-main','z','dual','primary-pdf','source',NULL),
      ('orphan-link','orphan','main','primary-pdf','source',NULL);
    INSERT INTO archive_steps VALUES('a','main','arrange','done',printf('%064x',1),'{}',NULL,0,0,0,0,'2026-11-25');
    INSERT INTO archive_issues VALUES
      ('references','z','dual','references','refs','{}',NULL,'2026-11-25'),
      ('old-issue','a','old','proofread','replaced','{}',NULL,'2026-11-25'),
      ('resolved','a','main','tags','done','{}','continue','2026-11-25'),
      ('legacy-step','a','main','document','legacy','{}',NULL,'2026-11-25'),
      ('correction-b','a','main','proofread','correction','{"page":2}',NULL,'2026-11-25'),
      ('correction-a','a','main','proofread','correction','{"page":1}',NULL,'2026-11-25'),
      ('supplement','a','supp','metadata','correction','{}',NULL,'2026-11-25'),
      ('html','a','non-pdf','proofread','bad-media','{}',NULL,'2026-11-25'),
      ('missing-page','z','dual','proofread','page-content-missing','{}',NULL,'2026-11-25'),
      ('missing-metadata','orphan','main','proofread','no-metadata','{}',NULL,'2026-11-25');
    DELETE FROM literature_assets WHERE literature_asset_id='old-link';
    INSERT INTO literature_assets VALUES('main-link','a','main','primary-pdf','source',NULL);
    COMMIT;
  `);
  return db;
}

type Request = {
  literature_id?: string;
  include_resolved?: boolean;
  reason?: string;
  part?: "main" | "supplementary";
  offset?: number;
  limit?: number;
};

function legacyIssues(db: DatabaseSync, request: Request) {
  const ids =
    request.literature_id ??
    db
      .prepare("SELECT DISTINCT literature_id FROM archive_issues")
      .all()
      .map((row) => String(row.literature_id));
  const grouped = [...archiveStates(db, ids).values()]
    .flatMap((state) => state.issues)
    .filter((issue) => request.include_resolved || issue.resolution === null);
  const filtered = grouped.filter(
    (issue) =>
      (!request.reason || issue.reason === request.reason) &&
      (!request.part || issue.part === request.part),
  );
  const offset = request.offset ?? 0,
    limit = request.limit ?? 50;
  return {
    items: filtered.slice(offset, offset + limit),
    groups: [...new Set(grouped.map((issue) => issue.reason))].map(
      (reason) => ({
        reason,
        count: grouped.filter((issue) => issue.reason === reason).length,
      }),
    ),
    total_count: filtered.length,
    next_offset: offset + limit < filtered.length ? offset + limit : null,
  };
}

it("matches the state-based count and issue pages across current and replaced materials", () => {
  const db = fixture();
  try {
    const legacy = legacyIssues(db, {});
    expect(
      legacy.items.map(({ issue_id, part, affects_readiness }) => [
        issue_id,
        part,
        affects_readiness,
      ]),
    ).toEqual([
      ["legacy-step", "main", false],
      ["correction-b", "main", true],
      ["correction-a", "main", true],
      ["supplement", "supplementary", false],
      ["missing-page", "main", false],
      ["references", "main", false],
    ]);
    expect(runArchiveStorage(db, "issue-count", {})).toEqual({
      total_count: legacy.total_count,
    });
    for (const request of [
      {},
      { include_resolved: true },
      { reason: "correction", part: "supplementary" },
      { part: "main", limit: 2, offset: 2 },
      { limit: 1, offset: 50 },
      { literature_id: "a", include_resolved: true, limit: 2 },
      { literature_id: "z" },
      { literature_id: "absent" },
      { reason: "absent" },
    ] satisfies Request[]) {
      expect(runArchiveStorage(db, "issues", request)).toEqual(
        legacyIssues(db, request),
      );
    }
    db.exec(
      "UPDATE archive_issues SET resolution='skip' WHERE issue_id='supplement'",
    );
    expect(runArchiveStorage(db, "issue-count", {})).toEqual({
      total_count: 5,
    });
    db.exec(
      "UPDATE archive_issues SET resolution=NULL WHERE issue_id='resolved'",
    );
    expect(runArchiveStorage(db, "issue-count", {})).toEqual({
      total_count: 6,
    });
    db.exec(
      "DELETE FROM literature_assets WHERE literature_asset_id='main-link'",
    );
    expect(runArchiveStorage(db, "issue-count", {})).toEqual({
      total_count: legacyIssues(db, {}).total_count,
    });
    expect(runArchiveStorage(db, "issue-count", {})).toEqual({
      total_count: 2,
    });
  } finally {
    db.close();
  }
});

it("counts through one partial-index query as resolved history grows", () => {
  const db = fixture();
  try {
    const capture = () => {
      const prepare = vi.spyOn(db, "prepare");
      try {
        expect(runArchiveStorage(db, "issue-count", {})).toEqual({
          total_count: 6,
        });
        expect(prepare).toHaveBeenCalledTimes(1);
        return prepare.mock.calls[0]![0];
      } finally {
        prepare.mockRestore();
      }
    };
    const sql = capture();
    db.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<8192)
      INSERT INTO archive_issues
      SELECT 'history-'||n,'a','main','proofread','synthetic','{}','continue','2026-11-25' FROM seq`);
    expect(capture()).toBe(sql);
    const accesses = db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .all()
      .map(({ detail }) => String(detail));
    expect(accesses.filter((detail) => detail.startsWith("SCAN"))).toEqual([
      "SCAN i USING INDEX archive_issues_unresolved",
    ]);
    expect(
      accesses
        .filter((detail) => detail.startsWith("SEARCH"))
        .map((detail) => detail.split(" ")[1]),
    ).toEqual(["m", "a", "la"]);
    expect(sql).not.toMatch(/archive_steps|detail_json/u);
  } finally {
    db.close();
  }
});
