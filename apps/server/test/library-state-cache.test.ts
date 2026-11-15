import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LITERATURE_STATUSES } from "@sciretriever/contracts";
import { archiveFixture } from "./archive-fixture.js";
import { archiveStates } from "../src/storage/sqlite/archive-engine.js";
import { LibraryStateCache } from "../src/storage/sqlite/library-state-cache.js";
import { deriveCurrentState } from "../src/literature/state.js";
import { LiteratureQueryService } from "../src/literature/query.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  LIBRARY_STATE_INPUT_TABLES,
  LIBRARY_STATE_INPUT_TABLES_V16,
} from "../src/storage/sqlite/schema.js";
import { draftStorageFixture } from "./draft-text-storage-fixture.js";

it("invalidates for every mutable draft input, keeps facts immutable and preserves cached/uncached parity", async () => {
  expect(
    LIBRARY_STATE_INPUT_TABLES.filter(
      (table) =>
        !(LIBRARY_STATE_INPUT_TABLES_V16 as readonly string[]).includes(table),
    ).sort(),
  ).toEqual(["draft_current", "draft_version_facts"]);
  const f = await draftStorageFixture();
  try {
    await f.storage.commitDraftVersion(f.publication);
    const db = new DatabaseSync(join(f.e.home, "catalog.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const cache = new LibraryStateCache();
      const read = () => {
        db.exec("BEGIN");
        try {
          return cache.read(db, "draft-fixture", 6, "vlm-engine", () => {});
        } finally {
          db.exec("COMMIT");
        }
      };
      const current = db.prepare("SELECT * FROM draft_current").get()!;
      const facts = db.prepare("SELECT * FROM draft_version_facts").get()!;
      const changes = [
        () => db.exec("UPDATE draft_current SET revision=revision+1"),
        () => db.exec("DELETE FROM draft_current"),
        () =>
          db
            .prepare("INSERT INTO draft_current VALUES(?,?,?,?)")
            .run(
              current.part_asset_id!,
              current.part_sha256!,
              current.document_version_id!,
              current.revision!,
            ),
        () => db.exec("DELETE FROM draft_version_facts"),
        () =>
          db
            .prepare("INSERT INTO draft_version_facts VALUES(?,?,?,?)")
            .run(
              facts.document_version_id!,
              facts.differs_segments!,
              facts.differences!,
              facts.image_only_pages!,
            ),
      ];
      for (const change of changes) {
        const before = read();
        const revision = Number(
          db.prepare("SELECT revision FROM library_state_revision").get()!
            .revision,
        );
        change();
        expect(
          Number(
            db
              .prepare(
                "SELECT revision FROM library_state_changes WHERE literature_id=?",
              )
              .get(f.e.parseRequest.literature_id)!.revision,
          ),
        ).toBeGreaterThan(revision);
        const after = read();
        expect(after).not.toBe(before);
        expect(after).toEqual(
          new Map(
            [...archiveStates(db)].map(([id, state]) => [
              id,
              deriveCurrentState(state),
            ]),
          ),
        );
      }
      const stable = read();
      const revision = db.prepare("SELECT * FROM library_state_revision").get();
      expect(() =>
        db.exec("UPDATE draft_version_facts SET differences=differences+1"),
      ).toThrow("draft version facts are immutable");
      expect(db.prepare("SELECT * FROM library_state_revision").get()).toEqual(
        revision,
      );
      expect(read()).toBe(stable);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
}, 30_000);

it(
  "matches uncached state/counts/filters after each state input changes, including external commits and rollback",
  { timeout: 0 },
  async () => {
    const e = await archiveFixture();
    let db: DatabaseSync | undefined;
    let reader: SqliteWorker | undefined;
    try {
      reader = new SqliteWorker(join(e.home, "catalog.sqlite"), undefined, {
        readOnly: true,
      });
      const query = new LiteratureQueryService(reader);
      db = new DatabaseSync(join(e.home, "catalog.sqlite"));
      db.exec("PRAGMA foreign_keys=ON");
      const cache = new LibraryStateCache();
      const read = (
        maxTags = 6,
        profile: "vlm-engine" | "pipeline" = "vlm-engine",
      ) => {
        db!.exec("BEGIN");
        try {
          return cache.read(db!, "fixture", maxTags, profile, () => {});
        } finally {
          db!.exec("COMMIT");
        }
      };
      const check = async (label: string) => {
        const expected = new Map(
          [...archiveStates(db!)].map(([id, s]) => [id, deriveCurrentState(s)]),
        );
        expect(read(), label).toEqual(expected);
        for (const service of [e.app.library, query]) {
          const counts = await service.counts({});
          for (const status of LITERATURE_STATUSES) {
            const ids = [...expected]
              .filter(([, v]) => v.status === status)
              .map(([id]) => id)
              .sort();
            expect(counts.statuses[status], label + status).toBe(ids.length);
            expect(
              (await service.search({ query: { statuses: [status] } })).items
                .map((i) => i.literature.literature_id)
                .sort(),
              label + status,
            ).toEqual(ids);
          }
        }
      };
      await check("asset-ready");
      await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
      await check("raw-parse");
      await e.submit("cache-ready");
      db.exec(
        "INSERT OR IGNORE INTO proofread_manual_state SELECT asset_id,0 FROM assets",
      );
      db.prepare(
        "INSERT INTO archive_issues VALUES('cache-test-issue',?,?,'references','synthetic','{}','continue',?)",
      ).run(e.id, e.rawParseRequest.asset_id, new Date().toISOString());
      await check("ready");
      expect(read().get(e.id)?.status).toBe("READY");
      const changes: [string, string][] = [
        [
          "UPDATE literatures SET version_role=version_role",
          "UPDATE literatures SET version_role=version_role",
        ],
        [
          "UPDATE assets SET relative_path=relative_path",
          "UPDATE assets SET relative_path=relative_path",
        ],
        [
          "UPDATE raw_parses SET created_at=created_at",
          "UPDATE raw_parses SET created_at=created_at",
        ],
        ["DELETE FROM raw_parse_pins", ""],
        [
          "UPDATE document_versions SET created_at=created_at",
          "UPDATE document_versions SET created_at=created_at",
        ],
        [
          "UPDATE structure_annotation_current SET revision=revision+1",
          "UPDATE structure_annotation_current SET revision=revision-1",
        ],
        [
          "UPDATE archive_steps SET status='pending'",
          "UPDATE archive_steps SET status='done'",
        ],
        [
          "UPDATE archive_description_heads SET source_json=source_json",
          "UPDATE archive_description_heads SET source_json=source_json",
        ],
        [
          "UPDATE literature_assets SET role='supplementary-pdf' WHERE role='primary-pdf'",
          "UPDATE literature_assets SET role='primary-pdf' WHERE role='supplementary-pdf'",
        ],
        ["UPDATE raw_parse_current SET raw_parse_id=NULL", ""],
        [
          "UPDATE proofread_versions SET status='incomplete'",
          "UPDATE proofread_versions SET status='complete'",
        ],
        [
          "UPDATE proofread_manual_state SET revision=revision+1",
          "UPDATE proofread_manual_state SET revision=revision-1",
        ],
        [
          "UPDATE structure_annotations SET structure_satisfied=0",
          "UPDATE structure_annotations SET structure_satisfied=1",
        ],
        [
          "UPDATE literature_metadata SET title=NULL",
          "UPDATE literature_metadata SET title='Restored synthetic title'",
        ],
        [
          "UPDATE archive_runs SET state='running'",
          "UPDATE archive_runs SET state='finished'",
        ],
        [
          "UPDATE execution_jobs SET status='running'",
          "UPDATE execution_jobs SET status='completed'",
        ],
        [
          "UPDATE literature_metadata SET article_kind='correction-or-editorial'",
          "UPDATE literature_metadata SET article_kind='research-article'",
        ],
        [
          "UPDATE archive_issues SET resolution=NULL,step='tags'",
          "UPDATE archive_issues SET resolution='continue'",
        ],
        ["DELETE FROM literature_tag_items", ""],
        ["DELETE FROM document_defaults", ""],
        ["DELETE FROM structure_annotation_current", ""],
        ["DELETE FROM proofread_current", ""],
        ["DELETE FROM literature_metadata_authors", ""],
      ];
      const touched = new Set<string>();
      for (const [change, restore] of changes) {
        // Save affected rows when the mutation removes pointers/assignments.
        const table = /(?:UPDATE|DELETE FROM) (\w+)/.exec(change)![1]!;
        touched.add(table);
        const saved = db.prepare(`SELECT * FROM ${table}`).all();
        const before = read();
        const applied = db.prepare(change).run();
        expect(
          applied.changes,
          table + " has a meaningful fixture",
        ).toBeGreaterThan(0);
        await check(change);
        expect(read(), table + " invalidates cache").not.toBe(before);
        if (restore) db.exec(restore);
        else {
          db.exec("BEGIN");
          for (const row of saved) {
            const columns = Object.keys(row);
            db.prepare(
              `INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
            ).run(...Object.values(row));
          }
          db.exec("COMMIT");
        }
        await check("restored " + table);
      }
      expect([...touched].sort()).toEqual(
        [...LIBRARY_STATE_INPUT_TABLES_V16].sort(),
      );
      // Config is part of the key; compare each variant against the same domain function.
      for (const [maxTags, profile] of [
        [0, "vlm-engine"],
        [6, "pipeline"],
      ] as const)
        expect(read(maxTags, profile)).toEqual(
          new Map(
            [...archiveStates(db)].map(([id, s]) => [
              id,
              deriveCurrentState(s, maxTags, profile),
            ]),
          ),
        );
      const stable = read();
      db.exec("BEGIN; UPDATE literature_metadata SET title=NULL; ROLLBACK");
      expect(read()).toBe(stable);
      db.prepare(
        "INSERT INTO reading_history VALUES(?,?,?) ON CONFLICT(literature_id) DO UPDATE SET last_opened_at=excluded.last_opened_at",
      ).run(e.id, new Date().toISOString(), 1);
      expect(read()).toBe(stable);
      await check("reading-only");
      // Exhaustion counts are intentionally queried live, outside the state cache.
      db.exec(
        "UPDATE literature_assets SET role='supplementary-pdf' WHERE role='primary-pdf'",
      );
      await e.app.database.setAutomaticPdfExhaustion(e.id);
      expect((await query.counts({})).unavailable_pdf).toBe(1);
      expect(
        (await query.search({ query: { needs_manual_pdf: true } })).items.map(
          (i) => i.literature.literature_id,
        ),
      ).toEqual([e.id]);
    } finally {
      db?.close();
      await reader?.close();
      await e.close();
    }
  },
);

it(
  "does not publish a partial cancelled projection",
  { timeout: 0 },
  async () => {
    const e = await archiveFixture();
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      const cache = new LibraryStateCache();
      let checkpoints = 0;
      expect(() =>
        cache.read(db, "fixture", 6, "vlm-engine", () => {
          if (++checkpoints === 4) throw new Error("cancelled");
        }),
      ).toThrow("cancelled");
      expect(cache.read(db, "fixture", 6, "vlm-engine", () => {})).toEqual(
        new Map(
          [...archiveStates(db)].map(([id, s]) => [id, deriveCurrentState(s)]),
        ),
      );
    } finally {
      db.close();
      await e.close();
    }
  },
);

it(
  "reopens a replaced catalog and does not reuse state from an equal revision on the old inode",
  { timeout: 0 },
  async () => {
    const { mkdtemp, rename, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { initializeCurrentCatalog } = await import(
      "../src/storage/sqlite/catalog-layout.js"
    );
    const home = await mkdtemp(join(tmpdir(), "sciretriever-state-inode-"));
    const catalog = join(home, "catalog.sqlite"),
      replacement = join(home, "replacement.sqlite");
    for (const [path, count] of [
      [catalog, 1],
      [replacement, 2],
    ] as const) {
      const db = new DatabaseSync(path);
      try {
        initializeCurrentCatalog(db);
        db.exec("PRAGMA foreign_keys=ON; BEGIN");
        for (let i = 0; i < count; i++) {
          db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(
            String(i),
            String(i),
          );
          db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(
            String(i),
            String(i),
          );
          db.prepare(
            "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256) VALUES(?,1,?)",
          ).run(String(i), "a".repeat(64));
        }
        db.exec("UPDATE library_state_revision SET revision=10; COMMIT");
      } finally {
        db.close();
      }
    }
    const worker = new SqliteWorker(catalog, undefined, { readOnly: true });
    try {
      const q = new LiteratureQueryService(worker);
      expect((await q.counts({})).statuses.UNREVIEWED).toBe(1);
      await rename(replacement, catalog);
      expect((await q.counts({})).statuses.UNREVIEWED).toBe(2);
    } finally {
      await worker.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
