import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseLibrarySearchRequest,
  parseLiterature,
  parseMetadataObservation,
  parseLiteratureId,
} from "@sciretriever/contracts";
import {
  FULL_TEXT_EXPECTED,
  fullTextCatalogRows,
  fullTextId as id,
  libraryFullTextFixture,
} from "./library-fulltext-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { queryFingerprint } from "../src/literature/query.js";
import { processorFixture } from "./processor-fixture.js";
import { libraryCounts } from "../src/storage/sqlite/library-page.js";
import { LibraryStateCache } from "../src/storage/sqlite/library-state-cache.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

it("counts folder, batch, discovery and combined scopes by paper, filters PDFs by version and excludes withdrawn facts without writes", async () => {
  const f = await libraryFullTextFixture();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Count must not use network"));
  try {
    const before = fullTextCatalogRows(f.home),
      query = f.reader.query!;
    expect(await query.counts({})).toEqual(FULL_TEXT_EXPECTED);
    const full = { total: 4, obtained: 1, missing: 3, exhausted: 1 };
    const scopes = [
      { folder: { id: f.root, include_descendants: true } },
      { intake_batch_ids: [f.batch] },
      { discovery_run_ids: [f.discovery] },
      {
        folder: { id: f.root, include_descendants: true },
        intake_batch_ids: [f.batch],
        discovery_run_ids: [f.discovery],
        languages: ["en"],
      },
    ];
    for (const scope of scopes) {
      const counts = await query.counts(scope);
      expect(counts.full_text).toEqual(full);
      expect(counts.total).toBe(4);
      expect(counts.with_primary_pdf).toBe(0);
      expect(counts.statuses.UNREVIEWED).toBe(4);
      for (const quick of [
        { statuses: ["READY"] },
        { needs_manual_pdf: true },
        { needs_manual_pdf: false },
        { statuses: ["EXCLUDED"], needs_manual_pdf: true },
      ])
        expect(await query.counts({ ...scope, ...quick })).toEqual(counts);
      const versioned = { ...scope, version_roles: ["preprint"] };
      expect((await query.counts(versioned)).full_text).toEqual({
        total: 2,
        obtained: 1,
        missing: 1,
        exhausted: 0,
      });
      expect(counts.with_primary_pdf).toBe(
        (await query.search({ query: { ...scope, has_primary_pdf: true } }))
          .total_count,
      );
      expect(counts.full_text.total).toBe(
        counts.full_text.obtained + counts.full_text.missing,
      );
      expect(counts.full_text.exhausted).toBeLessThanOrEqual(
        counts.full_text.missing,
      );
    }
    expect(
      (await query.search({ query: { has_primary_pdf: true } })).items
        .map((x) => x.literature.literature_id)
        .sort(),
    ).toEqual([id(2), id(6)]);
    expect(
      (await query.search({ query: { has_primary_pdf: false } })).total_count,
    ).toBe(8);
    expect(
      (await query.search({ query: { has_primary_pdf: null } })).total_count,
    ).toBe(10);
    expect((await query.counts({ has_primary_pdf: false })).full_text).toEqual({
      total: 7,
      obtained: 1,
      missing: 6,
      exhausted: 2,
    });
    expect(
      (await query.counts({ has_primary_pdf: true })).with_primary_pdf,
    ).toBe(FULL_TEXT_EXPECTED.with_primary_pdf);
    expect((await query.counts({})).with_primary_pdf).toBe(
      (await query.search({ query: { has_primary_pdf: true } })).total_count,
    );
    expect(
      (await query.counts({ title: "Scope 1", version_roles: ["preprint"] }))
        .full_text,
    ).toEqual({ total: 1, obtained: 1, missing: 0, exhausted: 0 });
    expect((await query.counts({ title: "Scope 3" })).full_text).toEqual({
      total: 1,
      obtained: 0,
      missing: 1,
      exhausted: 0,
    });
    expect((await query.counts({ title: "Other 10" })).full_text).toEqual({
      total: 1,
      obtained: 0,
      missing: 1,
      exhausted: 1,
    });
    const empty = await query.counts({ title: "No matching title" });
    expect(empty).toEqual({
      ...FULL_TEXT_EXPECTED,
      total: 0,
      unavailable_pdf: 0,
      with_primary_pdf: 0,
      full_text: { total: 0, obtained: 0, missing: 0, exhausted: 0 },
      statuses: {
        UNREVIEWED: 0,
        ASSET_READY: 0,
        ARCHIVING: 0,
        ARCHIVE_FAILED: 0,
        READY: 0,
        EXCLUDED: 0,
      },
    });
    expect(await query.counts({ text: "---" })).toEqual(empty);
    const selected = await f.app.library.selectionSnapshot(
      parseLibrarySearchRequest({
        query: {
          has_primary_pdf: false,
          title: "Scope",
          version_roles: ["preprint"],
        },
      }).query,
    );
    expect(
      selected.matches.map((x) => x.literature.literature_id).sort(),
    ).toEqual([id(1), id(3)]);
    expect(
      selected.members.map((x) => x.literature.literature_id).sort(),
    ).toEqual([id(1), id(2), id(3), id(4)]);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.modelCalls).toBe(0);
    expect(fullTextCatalogRows(f.home)).toEqual(before);
  } finally {
    fetch.mockRestore();
    await f.close();
  }
});

it("retains legacy cursor bytes when omitted, and binds new cursors to the primary-PDF condition", async () => {
  const f = await libraryFullTextFixture();
  try {
    for (const [n, title] of [
      [1, "Legacy Alpha"],
      [2, "Legacy Beta"],
    ] as const) {
      const old = (await f.app.database.getLiterature(id(n)))!;
      await f.app.database.putLiterature(
        parseLiterature({ ...old, metadata: { ...old.metadata, title } }),
      );
    }
    const query = { title: "Legacy" },
      request = { query, sort: "title-asc", limit: 1 };
    expect(queryFingerprint(parseLibrarySearchRequest(request).query)).toBe(
      "236c21b30ae39e5e2b6ea8cca0453da3185cb62c885cfc5b7bdbaf4674f9739f",
    );
    const legacy =
      "eyJjaGVja3N1bSI6IjBhY2NlZTE5MzE4ZWI2MzEwYzE0ZTQ0ZTI3NjMzODNiMzZjYjg2M2JkMjUyZmM4ZjlhNDdmNDU1ZDdhYjAzMWYiLCJraW5kIjoibGlicmFyeS1zZWFyY2giLCJwYXlsb2FkIjp7InBvc2l0aW9uIjp7ImxpdGVyYXR1cmVfaWQiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJub3JtYWxpemVkX3RpdGxlIjoibGVnYWN5IGFscGhhIiwidGl0bGVfaXNfbnVsbCI6ZmFsc2V9LCJxdWVyeV9maW5nZXJwcmludCI6IjIzNmMyMWIzMGFlMzllNWUyYjZlYThjY2EwNDUzZGEzMTg1Y2I2MmM4ODVjZmM1YjdiZGJhZjQ2NzRmOTczOWYiLCJzb3J0IjoidGl0bGUtYXNjIn0sInZlcnNpb24iOjF9";
    expect((await f.reader.query!.search(request)).next_cursor).toBe(legacy);
    expect(
      (await f.reader.query!.search({ ...request, cursor: legacy })).items.map(
        (x) => x.literature.literature_id,
      ),
    ).toEqual([id(2)]);
    await expect(
      f.reader.query!.search({
        ...request,
        cursor: legacy,
        query: { ...query, has_primary_pdf: true },
      }),
    ).rejects.toMatchObject({ code: "literature-query" });
    expect(
      queryFingerprint(
        parseLibrarySearchRequest({ query: { has_primary_pdf: false } }).query,
      ),
    ).not.toBe(
      queryFingerprint(
        parseLibrarySearchRequest({ query: { has_primary_pdf: true } }).query,
      ),
    );
  } finally {
    await f.close();
  }
});

it("keeps status, version PDF and paper PDF counts in one snapshot during a checkpointed external write", async () => {
  const f = await libraryFullTextFixture(),
    path = join(f.home, "catalog.sqlite");
  const db = new DatabaseSync(path, { readOnly: true }),
    writer = new DatabaseSync(path);
  try {
    db.exec("BEGIN");
    const states = new LibraryStateCache().read(
      db,
      "fulltext-snapshot",
      6,
      "vlm-engine",
      () => {},
    );
    let changed = false;
    db.function("sr_query_continue", () => 1);
    db.function("sr_status", (key) => {
      if (!changed) {
        changed = true;
        writer
          .prepare(
            "UPDATE literature_assets SET role='supplementary-pdf' WHERE literature_id=?",
          )
          .run(id(2));
      }
      return states.get(String(key))!.status;
    });
    const query = parseLibrarySearchRequest({ query: {} }).query;
    expect(libraryCounts(db, query, null)).toEqual(FULL_TEXT_EXPECTED);
    expect(changed).toBe(true);
    db.exec("COMMIT");
    expect((await f.reader.query!.counts({})).full_text).toEqual({
      total: 8,
      obtained: 1,
      missing: 7,
      exhausted: 2,
    });
    expect((await f.reader.query!.counts({})).with_primary_pdf).toBe(1);
  } finally {
    db.close();
    writer.close();
    await f.close();
  }
});

it("counts a primary PDF as obtained in ASSET_READY, READY, ARCHIVING, ARCHIVE_FAILED and EXCLUDED without processing during reads", async () => {
  const e = await processorFixture({ offline: true });
  const reader = await createQueryApplication(e.home);
  const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
  const check = async (status: string) => {
    const before = fullTextCatalogRows(e.home),
      calls = { model: e.modelCalls, parse: e.parseCalls };
    const value = await reader.query!.counts({});
    expect(value.statuses[status as keyof typeof value.statuses]).toBe(1);
    expect(value.with_primary_pdf).toBe(1);
    expect(value.full_text).toEqual({
      total: 1,
      obtained: 1,
      missing: 0,
      exhausted: 0,
    });
    expect({ model: e.modelCalls, parse: e.parseCalls }).toEqual(calls);
    expect(fullTextCatalogRows(e.home)).toEqual(before);
  };
  try {
    await check("ASSET_READY");
    await e.build(e.parseRequest);
    await check("READY");
    await e.app.writes.run(async () => {
      db.exec("UPDATE archive_runs SET state='running',job_id=NULL");
    });
    await check("ARCHIVING");
    await e.app.writes.run(async () => {
      db.exec("UPDATE archive_runs SET state='finished'");
      db.prepare(
        "INSERT INTO archive_issues VALUES(?,?,?,'proofread','synthetic-failure','{}',NULL,'2026-11-17T00:00:00Z')",
      ).run(
        randomUUID(),
        e.parseRequest.literature_id,
        e.parseRequest.asset_id,
      );
    });
    await check("ARCHIVE_FAILED");
    const old = (await e.app.database.getLiterature(
      e.parseRequest.literature_id,
    ))!;
    await e.app.database.putLiterature(
      parseLiterature({
        ...old,
        metadata: { ...old.metadata, article_kind: "correction-or-editorial" },
      }),
    );
    await check("EXCLUDED");
  } finally {
    db.close();
    await reader.close();
    await e.close();
  }
}, 60_000);

it("counts only exhausted automatic outcomes and drops the count when new metadata arrives", async () => {
  const f = await libraryFullTextFixture();
  try {
    const names = [
      "network",
      "rate-limit",
      "configuration",
      "cancelled",
      "exhausted",
    ];
    for (const [n, name] of names.entries()) {
      const lit = id(200 + n);
      await f.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: lit,
          meta_literature_id: id(1200 + n),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Acquisition count probe ${name}`,
            identifiers: [{ namespace: "doi", value: `10.5555/count-${name}` }],
          },
        }),
      );
      const service = new DatabaseCompletionService({
        library: f.app.library,
        database: f.app.database,
        writes: f.app.writes,
        completion: null,
        acquisition: {
          acquire: async () =>
            name === "exhausted"
              ? { kind: "exhausted" }
              : name === "cancelled"
                ? { kind: "cancelled" }
                : {
                    kind: "route-failure",
                    failure: {
                      code: "candidate-download-failed",
                      source: `synthetic-${name}`,
                      reason: `Synthetic ${name} failure`,
                      retryable: name !== "configuration",
                    },
                  },
        },
      });
      await service.run({
        selector: {
          kind: "literatures",
          literature_ids: [parseLiteratureId(lit)],
        },
        goal: "ASSET_READY",
      });
      expect(await f.app.database.hasAutomaticPdfExhaustion(lit)).toBe(
        name === "exhausted",
      );
    }
    expect(
      (await f.reader.query!.counts({ title: "Acquisition count probe" }))
        .full_text,
    ).toEqual({ total: 5, obtained: 0, missing: 5, exhausted: 1 });
    const last = id(204),
      metadata = (await f.app.database.getLiterature(last))!.metadata;
    await f.app.identity.observe(
      parseMetadataObservation({
        observation_id: randomUUID(),
        source_type: null,
        source_type_mapping_version: null,
        provenance: {
          provenance_id: randomUUID(),
          source_kind: "metadata-provider",
          source_name: "synthetic-refresh",
          source_record_id: "refresh",
          observed_at: new Date().toISOString(),
          input_sha256: "a".repeat(64),
          parameters_sha256: null,
        },
        metadata: { ...metadata, keywords: ["new metadata"] },
        version_role: "published",
        version_links: [],
        asset_hints: [],
        reference_count: null,
        cited_by_count: null,
        declared_keywords: [],
        reference_texts: [],
      }),
      { target_literature_id: last },
    );
    expect(
      (await f.reader.query!.counts({ title: "Acquisition count probe" }))
        .full_text,
    ).toEqual({ total: 5, obtained: 0, missing: 5, exhausted: 0 });
  } finally {
    await f.close();
  }
});
