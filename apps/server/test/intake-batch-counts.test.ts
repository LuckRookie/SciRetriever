import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  parseIntakeBatch,
  parseIntakeBatchPage,
  type IntakeBatch,
} from "@sciretriever/contracts";
import {
  fullTextCountsFromRow,
  fullTextCountsProjection,
} from "../src/storage/sqlite/full-text-counts.js";
import {
  queryIntakeBatches,
  queryIntakeBatchSummaries,
} from "../src/storage/sqlite/intake-engine.js";
import { StoredLibraryState } from "../src/storage/sqlite/library-state.js";
import {
  fullTextId,
  libraryFullTextFixture,
} from "./library-fulltext-fixture.js";

function legacyBatch(db: DatabaseSync, batchId: string) {
  const batch = db
    .prepare("SELECT * FROM intake_batches WHERE batch_id=?")
    .get(batchId)!;
  const scope =
    "SELECT literature_id FROM intake_batch_members WHERE batch_id=?";
  const paper = fullTextCountsProjection(
    scope,
    "count(DISTINCT l.meta_literature_id)",
  );
  const row = db
    .prepare(
      `WITH ${paper.cte}
    SELECT ${paper.columns},count(*) AS hits,coalesce(sum(m.disposition='created'),0) AS created,
      coalesce(sum(m.disposition='enriched'),0) AS enriched,coalesce(sum(m.disposition='matched'),0) AS matched,
      coalesce(sum(m.disposition='restored'),0) AS restored,count(n.literature_id) AS needs_metadata,count(p.literature_id) AS has_pdf,
      coalesce(sum(CASE WHEN p.literature_id IS NULL AND EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex
        WHERE ex.literature_id=m.literature_id) THEN sr_status(m.literature_id)='UNREVIEWED' ELSE 0 END),0) AS unavailable
    FROM intake_batch_members m JOIN literatures l ON l.literature_id=m.literature_id
    LEFT JOIN literature_assets p ON p.literature_id=m.literature_id AND p.role='primary-pdf'
    LEFT JOIN literature_needs_metadata n ON n.literature_id=m.literature_id WHERE m.batch_id=?`,
    )
    .get(batchId, batchId)!;
  const { has_pdf, unavailable, total, obtained, exhausted, ...counts } = row;
  const parse = db
    .prepare(
      `SELECT count(*) AS n FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
    WHERE la.role='primary-pdf' AND la.literature_id IN (${scope}) AND NOT EXISTS(
      SELECT 1 FROM raw_parse_current c WHERE c.source_asset_id=a.asset_id AND c.source_sha256=a.sha256
        AND c.profile='vlm-engine' AND c.raw_parse_id IS NOT NULL)`,
    )
    .get(batchId)!.n;
  const pending = Number(counts.hits) - Number(has_pdf) - Number(unavailable);
  return parseIntakeBatch({
    batch_id: batch.batch_id,
    kind: batch.kind,
    label: batch.label ?? batch.default_label,
    default_label: batch.default_label,
    renamed: batch.label !== null,
    origin: batch.origin,
    created_at: batch.created_at,
    finished_at: batch.finished_at,
    state: batch.state,
    result: batch.result,
    confirmation: batch.confirmation,
    confirmed_at: batch.confirmed_at,
    initiated_by: batch.initiated_by,
    source: null,
    progress: null,
    request: JSON.parse(String(batch.request_json)),
    full_text: fullTextCountsFromRow({ total, obtained, exhausted }),
    counts: {
      ...counts,
      rejected: batch.rejected,
      conflicts: 0,
      possible_duplicates: 0,
      pending_decision: 0,
    },
    pdf: { has_pdf, unavailable, pending },
    estimates: { acquire_pdf: pending, parse },
    discovery_run_id: batch.discovery_run_id,
    source_failures: batch.source_failures,
  });
}

it("returns the legacy batch fields for sibling versions, withdrawals and parse candidates", async () => {
  const f = await libraryFullTextFixture();
  const db = new DatabaseSync(join(f.home, "catalog.sqlite"));
  try {
    await f.app.writes.run(async () => {
      // Include a second version, a withdrawn PDF, and a supplement-only member.
      const member = db.prepare(
        "INSERT INTO intake_batch_members VALUES(?,?,?)",
      );
      member.run(f.batch, fullTextId(2), "enriched");
      member.run(f.batch, fullTextId(9), "matched");
      member.run(f.batch, fullTextId(12), "restored");
      db.prepare("INSERT INTO literature_needs_metadata VALUES(?,?,?)").run(
        fullTextId(5),
        "2026-11-25T00:00:00Z",
        f.batch,
      );
    });
    new StoredLibraryState(db, { max_tags: 6, archive_profile: "vlm-engine" });
    db.exec("BEGIN");
    const ids = db
      .prepare(
        "SELECT batch_id FROM intake_batches ORDER BY created_at DESC,batch_id DESC",
      )
      .all()
      .map((row) => String(row.batch_id));
    const expected = ids.map((id) => legacyBatch(db, id));
    expect(expected.find((batch) => batch.batch_id === f.batch)).toMatchObject({
      full_text: { total: 6, obtained: 1, exhausted: 1, missing: 5 },
      counts: { hits: 7, enriched: 1, restored: 1, needs_metadata: 1 },
      pdf: { has_pdf: 2, unavailable: 2, pending: 3 },
      estimates: { acquire_pdf: 3, parse: 2 },
    });
    const prepare = vi.spyOn(db, "prepare");
    const page = (() => {
      try {
        const result = queryIntakeBatches(db, {
          operation: "list",
          request: { limit: 20 },
        });
        const scoped = prepare.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.includes("FROM intake_batch_members m"));
        expect(scoped).toHaveLength(2 * ids.length);
        expect(
          scoped.filter((sql) => sql.includes("raw_parse_current")),
        ).toHaveLength(ids.length);
        return { result, scoped };
      } finally {
        prepare.mockRestore();
      }
    })();
    expect(page.result).toEqual({ items: expected, next_cursor: null });
    for (const sql of new Set(page.scoped)) {
      const args = sql.includes("raw_parse_current")
        ? ["vlm-engine", f.batch]
        : [f.batch];
      const plan = db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .all(...args)
        .map(({ detail }) => String(detail));
      expect(plan).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^SEARCH m .*\(batch_id=\?\)$/u),
        ]),
      );
      expect(plan).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^(SCAN m\b|LIST SUBQUERY)/u),
        ]),
      );
    }
    for (const [index, batch_id] of ids.entries())
      expect(
        queryIntakeBatches(db, { operation: "get", request: { batch_id } }),
      ).toEqual(expected[index]);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    await f.close();
  }
});

it("shares every retained field and cursor with the complete batch reads and scans only members on the page", async () => {
  const f = await libraryFullTextFixture();
  const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
    readOnly: true,
  });
  try {
    new StoredLibraryState(db, { max_tags: 6, archive_profile: "vlm-engine" });
    db.exec("BEGIN");
    const request = { limit: 1, cursor: null };
    const complete = (cursor: string | null) =>
      parseIntakeBatchPage(
        queryIntakeBatches(db, {
          operation: "list",
          request: { ...request, cursor },
        }),
      );
    const sharedFields = (batch: IntakeBatch) =>
      Object.fromEntries(
        Object.entries(batch).filter(
          ([key]) => key !== "full_text" && key !== "estimates",
        ),
      );
    const first = complete(null);
    expect(first.next_cursor).not.toBeNull();
    const prepare = vi.spyOn(db, "prepare");
    const { page, statements } = (() => {
      try {
        return {
          page: queryIntakeBatchSummaries(db, request),
          statements: prepare.mock.calls.map(([sql]) => sql),
        };
      } finally {
        prepare.mockRestore();
      }
    })();
    expect(page).toEqual({
      items: first.items.map(sharedFields),
      next_cursor: first.next_cursor,
    });
    const nextSummary = queryIntakeBatchSummaries(db, {
      ...request,
      cursor: first.next_cursor,
    });
    const nextFull = complete(page.next_cursor);
    expect(nextSummary).toEqual({
      items: nextFull.items.map(sharedFields),
      next_cursor: nextFull.next_cursor,
    });
    expect(nextSummary.items[0]?.batch_id).not.toBe(page.items[0]?.batch_id);
    for (const summary of [...page.items, ...nextSummary.items])
      expect(summary).toEqual(
        sharedFields(
          parseIntakeBatch(
            queryIntakeBatches(db, {
              operation: "get",
              request: { batch_id: summary.batch_id },
            }),
          ),
        ),
      );

    const memberSql = statements.filter((sql) => sql.includes("AS hits"));
    expect(memberSql).toHaveLength(1);
    expect(statements.join("\n")).not.toMatch(
      /raw_parse_current|meta_literature_id/u,
    );
    const plan = db
      .prepare("EXPLAIN QUERY PLAN " + memberSql[0])
      .all(first.items[0]!.batch_id)
      .map(({ detail }) => String(detail));
    expect(plan[0]).toMatch(/^SEARCH m .*\(batch_id=\?\)$/u);
    expect(plan.every((step) => !step.startsWith("SCAN "))).toBe(true);
    const pdfSql = statements.filter((sql) =>
      sql.includes("CROSS JOIN intake_batch_members"),
    );
    expect(pdfSql).toHaveLength(1);
    expect(
      db
        .prepare(`EXPLAIN QUERY PLAN ${pdfSql[0]}`)
        .all(first.items[0]!.batch_id)
        .map(({ detail }) => String(detail)),
    ).toEqual([
      expect.stringMatching(/one_primary_pdf_per_literature/u),
      expect.stringMatching(
        /^SEARCH m .*\(batch_id=\? AND literature_id=\?\)$/u,
      ),
    ]);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    await f.close();
  }
});
