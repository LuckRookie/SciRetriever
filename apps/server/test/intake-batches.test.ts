import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  parseIntakeBatch,
  parseIntakeBatchPage,
  parseLibrarySearchRequest,
  parseLiteratureId,
  type IntakeBatchId,
  type LiteratureId,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { startIntake, finishIntake } from "../src/literature/intake.js";
import { createMetadataOperations } from "../src/entry/metadata-operations.js";
import { withActivity } from "../src/logging/activity.js";
import { TopicDiscoveryService } from "../src/entry/discovery.js";
import { ObservationRepository } from "../src/storage/sqlite/repositories.js";
import { ExecutionTaskService } from "../src/application/jobs/service.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";

export function intakeObservation(
  record: string,
  options: { keywords?: string[]; terms?: string[]; source?: string } = {},
) {
  return parseMetadataObservation({
    observation_id: randomUUID(),
    source_type: null,
    source_type_mapping_version: null,
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: options.source ?? "fixture",
      source_record_id: record,
      observed_at: new Date().toISOString(),
      input_sha256: "1".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      ...EMPTY_METADATA,
      title: record,
      identifiers: [{ namespace: "doi", value: `10.1000/${record}` }],
      keywords: options.keywords ?? [],
      subject_terms: options.terms ?? [],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: options.keywords ?? [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
async function fixture(
  run: (
    app: Awaited<ReturnType<typeof createApplication>>,
    home: string,
  ) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-")),
    app = await createApplication(home);
  try {
    await withActivity({ actor: "cli:intake-test" }, () => run(app, home));
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}
const get = (
  app: Awaited<ReturnType<typeof createApplication>>,
  id: IntakeBatchId,
) =>
  app.library
    .intakeBatches({ operation: "get", request: { batch_id: id } })
    .then(parseIntakeBatch);
it("counts distinct created, enriched and matched members, supports rename/reset, and records rejected imports", () =>
  fixture(async (app) => {
    const old1 = intakeObservation("old1"),
      old2 = intakeObservation("old2");
    await app.identity.observe(old1);
    await app.identity.observe(old2);
    const id = await startIntake(app.database, "topic", "scope", {
      query: "scope",
    });
    const fresh = intakeObservation("new");
    for (const o of [fresh, fresh, intakeObservation("old1"), old2])
      await app.identity.observe(o, { intake_batch_id: id });
    await finishIntake(app.database, id, "completed");
    expect((await get(app, id)).counts).toEqual({
      hits: 3,
      created: 1,
      enriched: 1,
      matched: 1,
      rejected: 0,
    });
    await app.database.writeIntake({
      operation: "rename",
      request: { batch_id: id, label: "  edited  " },
    });
    expect(await get(app, id)).toMatchObject({
      label: "edited",
      renamed: true,
    });
    await app.database.writeIntake({
      operation: "rename",
      request: { batch_id: id, label: null },
    });
    expect(await get(app, id)).toMatchObject({
      label: "scope",
      renamed: false,
    });
    const report = await createMetadataOperations(app).importBibliography({
      format: "csl-json",
      file_name: "papers.json",
      content: JSON.stringify([
        { title: "Imported", DOI: "10.1000/imported" },
        {},
      ]),
    });
    expect(report.items).toMatchObject([
      { disposition: "created" },
      { disposition: "rejected" },
    ]);
    expect(report.intake_batch_id).toBeTruthy();
    const imported = await get(app, report.intake_batch_id!);
    expect(imported).toMatchObject({
      kind: "import",
      origin: "cli",
      label: "papers.json",
      counts: { hits: 1, created: 1, rejected: 1 },
    });
    const page = parseIntakeBatchPage(
      await app.library.intakeBatches({
        operation: "list",
        request: { limit: 1 },
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    const second = parseIntakeBatchPage(
      await app.library.intakeBatches({
        operation: "list",
        request: { limit: 1, cursor: page.next_cursor },
      }),
    );
    expect(second.items[0]?.batch_id).not.toBe(page.items[0]?.batch_id);
  }));
it("persists accepted members when discovery stops before publication and identifies a dead owner", () =>
  fixture(async (app) => {
    const one = intakeObservation("kept"),
      two = intakeObservation("interrupted");
    const service = new TopicDiscoveryService(
      {
        searchTopicProvider: async () => ({
          provider_name: "fixture",
          outcome: "EXHAUSTED",
          observations: [one, two],
          relations: [],
          raw_item_count: 2,
          failure: null,
        }),
      },
      {
        observe: async (
          value: unknown,
          options: Parameters<typeof app.identity.observe>[1],
        ) => {
          if (
            (value as { observation_id: string }).observation_id ===
            two.observation_id
          )
            throw new Error("synthetic interruption");
          return app.identity.observe(value, options);
        },
      },
      new ObservationRepository(app.database),
      app.database,
    );
    await expect(
      service.run({
        query: "interrupted\nAND scope",
        providers: [{ provider_name: "fixture", scan_limit: 10 }],
      }),
    ).rejects.toThrow("synthetic interruption");
    const page = parseIntakeBatchPage(
      await app.library.intakeBatches({ operation: "list", request: {} }),
    );
    expect(page.items[0]).toMatchObject({
      label: "interrupted\nAND scope",
      status: "interrupted",
      counts: { hits: 1, created: 1 },
    });
    const dead = await startIntake(app.database, "import", "dead", {
      format: "ris",
    });
    // A second synthetic batch emulates a process that died without a finally.
    const b = await get(app, dead);
    const deadId = randomUUID() as IntakeBatchId;
    await app.database.writeIntake({
      operation: "create",
      batch: { ...b, batch_id: deadId },
      owner_pid: 2147483647,
    });
    expect((await get(app, deadId)).status).toBe("interrupted");
  }));
it("filters batches with OR and both keyword layers with case-insensitive AND; facets cover the whole result and count papers once", () =>
  fixture(async (app, home) => {
    const a = await startIntake(app.database, "topic", "A", { query: "A" }),
      b = await startIntake(app.database, "topic", "B", { query: "B" });
    for (const [record, id, keywords, terms] of [
      ["a", a, ["Energy", "ENERGY", "Storage"], ["Physics", "Materials"]],
      ["b", b, ["energy"], ["physics"]],
      ["c", b, ["Unrelated"], ["Biology"]],
    ] as const)
      await app.identity.observe(
        intakeObservation(record, {
          keywords: [...keywords],
          terms: [...terms],
        }),
        { intake_batch_id: id },
      );
    await finishIntake(app.database, a, "completed");
    await finishIntake(app.database, b, "completed");
    expect(await app.library.facets({ query: {}, limit: 10 })).toEqual(
      await app.library.facets({
        query: { intake_batch_ids: [a, b] },
        limit: 10,
      }),
    );
    const query = parseLibrarySearchRequest({
      query: {
        intake_batch_ids: [a, b],
        subject_terms: ["PHYSICS"],
        keywords: ["EnErGy"],
      },
    }).query;
    const page = await app.library.search({ query, limit: 1 });
    expect(page.total_count).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(
      await app.library.facets({ query: { text: "!!!" }, limit: 10 }),
    ).toEqual({ total: 0, keywords: [], subject_terms: [] });
    const facets = await app.library.facets({ query, limit: 10 });
    expect(facets.total).toBe(2);
    expect(facets.keywords[0]).toEqual({ value: "ENERGY", count: 2 });
    expect(facets.subject_terms[0]).toEqual({ value: "Physics", count: 2 });
    expect(
      (
        await app.library.search({
          query: { ...query, subject_terms: ["physics", "materials"] },
        })
      ).total_count,
    ).toBe(1);
    expect(
      (await app.library.search({ query: { intake_batch_ids: [a] } }))
        .total_count,
    ).toBe(1);
    const detail = await app.library.detail(
      page.items[0]!.literature.literature_id,
    );
    expect(detail.intake_batches).toHaveLength(1);
    expect(detail.literature.metadata.subject_terms.length).toBeGreaterThan(0);
    expect(
      (await app.library.search({ query: { text: "Biology" } })).total_count,
    ).toBe(1);
    await app.maintenance!.refreshIndex!();
    const { createQueryApplication } = await import(
      "../src/bootstrap/application.js"
    );
    const reader = await createQueryApplication(home);
    try {
      const request = {
        query: "Biology",
        scope: { kind: "library" as const },
        kinds: ["metadata" as const],
        versions: { kind: "default" as const },
        budget: { max_items: 10, max_bytes: 65536, token_limit: null },
        continuation: null,
      };
      const bundle = await reader.context!.search(request);
      const knowledge = await reader.knowledgeContext!.search({
        ...request,
        schema_version: 3,
      });
      for (const result of [bundle, knowledge]) {
        expect(result.items).toHaveLength(1);
        const item = result.items[0];
        expect(item?.kind).toBe("metadata");
        if (item?.kind !== "metadata")
          throw new Error("metadata context item is required");
        expect(result.coverage).toBe("partial");
        expect(result.gaps).toContainEqual({
          code: "material-missing",
          literature_id: item.literature_id,
        });
        expect(item.text).toContain("Biology");
      }
    } finally {
      await reader.close();
    }
  }));
it("previews and freezes ordered PDF scope beyond one thousand rows, with disjoint skip counts and idempotent creation", () =>
  fixture(async (app, home) => {
    const { DatabaseSync } = await import("node:sqlite"),
      { canonicalJsonBytes, parseLiteratureId } = await import(
        "@sciretriever/contracts"
      ),
      { createHash } = await import("node:crypto");
    const { createTaskOperations } = await import(
      "../src/entry/task-operations.js"
    );
    const catalog = join(home, "catalog.sqlite");
    if (!catalog) throw new Error("fixture catalog path missing");
    const db = new DatabaseSync(catalog);
    const ids: string[] = [];
    try {
      db.exec("PRAGMA foreign_keys=ON;BEGIN");
      for (let n = 0; n < 1005; n++) {
        const id = randomUUID(),
          meta = randomUUID();
        ids.push(id);
        const metadata = {
          ...EMPTY_METADATA,
          title: `Title ${String(n).padStart(4, "0")}`,
          publication_year: (n % 2) + 2025,
        };
        db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(meta, id);
        db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(
          id,
          meta,
        );
        db.prepare(
          "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,publication_year) VALUES(?,1,?,?,?)",
        ).run(
          id,
          createHash("sha256")
            .update(canonicalJsonBytes(metadata))
            .digest("hex"),
          metadata.title,
          metadata.publication_year,
        );
      }
      const asset = randomUUID(),
        p = randomUUID();
      db.prepare(
        "INSERT INTO provenances VALUES(?,'user','fixture',NULL,?,NULL,NULL)",
      ).run(p, new Date().toISOString());
      db.prepare(
        "INSERT INTO artifact_objects VALUES(?,?,10,'application/pdf','fixture.pdf')",
      ).run(asset, "1".repeat(64));
      db.prepare(
        "INSERT INTO assets VALUES(?,?,10,'application/pdf','fixture.pdf')",
      ).run(asset, "1".repeat(64));
      db.prepare(
        "INSERT INTO literature_assets VALUES(?,?,?,'primary-pdf',?,NULL)",
      ).run(randomUUID(), ids[0]!, asset, p);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    await app.database.setAutomaticPdfExhaustion(ids[1]!);
    const selector = {
      kind: "query",
      query: parseLibrarySearchRequest({ query: {} }).query,
      sort: "title-desc",
      limit: 3,
    };
    const preview = await app.library.pdfSelection(selector);
    expect(preview.counts).toEqual({
      matched: 1005,
      process: 3,
      skipped_has_pdf: 1,
      skipped_unavailable: 1,
      over_limit: 1000,
    });
    expect(preview.items.map((i) => i.literature_id)).toEqual([
      ids[1004],
      ids[1003],
      ids[1002],
    ]);
    const tasks = createTaskOperations(app)!;
    const job = await tasks.create({
      kind: "acquire-pdf",
      selector,
      idempotency_key: "bounded",
    });
    const read = await tasks.read(job.job_id);
    expect(read.scope).toEqual({ selector, counts: preview.counts });
    expect(read.targets.map((t) => t.literature_id)).toEqual(
      preview.items.map((i) => i.literature_id),
    );
    const complete = await tasks.create({
      kind: "acquire-pdf",
      selector: { ...selector, limit: null },
      idempotency_key: "unlimited",
    });
    expect((await tasks.read(complete.job_id)).scope?.counts.process).toBe(
      1003,
    );
    expect((await app.jobs!.getPolicy(complete.job_id))?.max_attempts).toBe(
      1003,
    );
    // A later arrival never changes the already saved scope or idempotent receipt.
    await app.identity.observe(intakeObservation("later"));
    expect((await tasks.read(complete.job_id)).scope?.counts.process).toBe(
      1003,
    );
    expect(
      (
        await tasks.create({
          kind: "acquire-pdf",
          selector,
          idempotency_key: "bounded",
        })
      ).job_id,
    ).toBe(job.job_id);
    expect(
      (
        await tasks.create({
          kind: "acquire-pdf",
          selector: { ...selector, limit: null },
          idempotency_key: "unlimited",
          policy: {},
        })
      ).job_id,
    ).toBe(complete.job_id);
    const explicit = await app.library.pdfSelection({
      kind: "literatures",
      literature_ids: ids.slice(0, 3).map(parseLiteratureId),
    });
    expect(explicit.counts).toEqual({
      matched: 3,
      process: 3,
      skipped_has_pdf: 0,
      skipped_unavailable: 0,
      over_limit: 0,
    });
    expect(
      (await tasks.list()).tasks.find((t) => t.job_id === job.job_id)?.scope,
    ).toEqual(read.scope);
  }));

it("keeps explicit PDF and exhausted targets in preview and submission, and retries exhausted targets only on execution", () =>
  fixture(async (app) => {
    const ids: LiteratureId[] = [];
    for (const record of ["has-pdf", "exhausted", "missing-pdf"]) {
      const decision = await app.identity.observe(intakeObservation(record));
      if (decision.disposition !== "accepted")
        throw new Error("fixture literature was not accepted");
      ids.push(parseLiteratureId(decision.literature_id));
    }
    await app.maintenance!.ingestPdf({
      literature_id: ids[0]!,
      bytes: workbenchPdf(),
    });
    await app.database.setAutomaticPdfExhaustion(ids[1]!);
    const selector = { kind: "literatures" as const, literature_ids: ids };
    const preview = await app.library.pdfSelection(selector);
    expect(preview.counts).toEqual({
      matched: 3,
      process: 3,
      skipped_has_pdf: 0,
      skipped_unavailable: 0,
      over_limit: 0,
    });
    expect(preview.items.map((item) => item.literature_id)).toEqual(ids);
    const queryPreview = await app.library.pdfSelection({
      kind: "query",
      query: {},
      sort: "title-asc",
      limit: null,
    });
    expect(queryPreview.counts).toEqual({
      matched: 3,
      process: 1,
      skipped_has_pdf: 1,
      skipped_unavailable: 1,
      over_limit: 0,
    });
    const { createTaskOperations } = await import(
      "../src/entry/task-operations.js"
    );
    const tasks = createTaskOperations(app)!;
    const job = await tasks.create({
      kind: "acquire-pdf",
      selector,
      idempotency_key: "explicit-pdf-retry",
    });
    const saved = await tasks.read(job.job_id);
    expect(saved.scope).toEqual({ selector, counts: preview.counts });
    expect(saved.targets.map((target) => target.literature_id)).toEqual(ids);
    expect(job.selector).toMatchObject({
      frozen_targets: ids.map((id) => ({
        target: { kind: "literature", literature_id: id },
        candidates: [id],
        clear_exhaustion: true,
      })),
    });
    expect(await app.database.hasAutomaticPdfExhaustion(ids[1]!)).toBe(true);
    const acquired: LiteratureId[] = [];
    const completion = new DatabaseCompletionService({
      library: app.library,
      database: app.database,
      writes: app.writes,
      completion: null,
      acquisition: {
        acquire: async ({ literature_id }) => {
          expect(
            await app.database.hasAutomaticPdfExhaustion(literature_id),
          ).toBe(false);
          acquired.push(literature_id);
          return { kind: "exhausted" };
        },
      },
    });
    const runner = new ExecutionTaskService(
      app.jobs!,
      app.queue!,
      app.interventions!,
      { completion },
    );
    const results = await runner.runJob(job.job_id);
    expect(results).toHaveLength(3);
    expect(acquired).toEqual([ids[1], ids[2]]);
    expect((await tasks.read(job.job_id)).job.status).toBe("completed");
  }));
