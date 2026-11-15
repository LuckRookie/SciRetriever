import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { IndexRefreshService } from "../src/retrieval/refresh.js";
import { ExecutionQueue } from "../src/application/jobs/service.js";
import { createTaskReader } from "../src/entry/task-read.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  parseLiterature,
  parseAsset,
  parseRawParse,
  parseRawParseInput,
  rawParseIdentity,
  sha256,
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  uncheckedProcessorValues,
  type FormDraftsPartResult,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { executeQuery } from "../src/entry/query-operations.js";
import {
  buildDraftDocument,
  currentDraftMethodHash,
} from "../src/document/draft-builder.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { artifactReference } from "../src/storage/artifact-layout.js";
import { correctedDocumentFixture } from "./corrected-document-fixture.js";
import { SqliteProcessorStorage } from "../src/storage/processor-results.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

type Fixture = Awaited<ReturnType<typeof coreProcessingFixture>>;
const source = "# Synthetic draft\n\nA fixed synthetic finding.\n";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const selector = { kind: "query", query: {}, sort: "title-asc", limit: null };
async function rawOnly(f: Fixture, asset = f.asset) {
  f.setText(source);
  await f.app.rawParsing!.parseAsset(
    asset.asset_id,
    ["vlm-engine"],
    undefined,
    { expected_sha256: asset.sha256, force: false },
  );
  return (await f.app.rawParseStorage!.current(asset.asset_id)).find(
    (r) => r.profile === "vlm-engine",
  )!.result!;
}
async function paper(
  f: Fixture,
  n: number,
  title: string,
  withRaw = true,
  withPdf = true,
) {
  const literature = parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(n + 100),
    metadata: { ...FIXTURE_LITERATURE.metadata, title, identifiers: [] },
  });
  await f.app.database.putLiterature(literature);
  if (!withPdf) return { literature, asset: null };
  await f.app.maintenance!.ingestPdf({
    literature_id: literature.literature_id,
    bytes: workbenchPdf(`10.5555/draft-${n}`),
  });
  const asset = (await f.app.library.detail(literature.literature_id))
    .primary_pdf!.asset;
  if (withRaw) await rawOnly(f, asset);
  return { literature, asset };
}
async function supplement(f: Fixture, literatureId: string, n: number) {
  const bytes = workbenchPdf(`10.5555/draft-supplement-${n}`),
    path = `objects/draft-supplement-${n}.pdf`;
  const stage = await f.app.files.stage({ maxBytes: bytes.length });
  try {
    await stage.write(bytes);
    await f.app.files.publish(stage, path);
  } finally {
    await stage.discard();
  }
  const asset = parseAsset({
    asset_id: randomUUID(),
    sha256: await sha256(bytes),
    size_bytes: bytes.length,
    media_type: "application/pdf",
    path,
  });
  await f.app.database.putLiteratureAsset({
    literature_asset_id: randomUUID(),
    literature_id: literatureId,
    asset,
    role: "supplementary-pdf",
    source_url: null,
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "user",
      source_name: "synthetic",
      source_record_id: null,
      observed_at: "2026-11-15T00:00:00Z",
      input_sha256: asset.sha256,
      parameters_sha256: null,
    },
  });
  await rawOnly(f, asset);
  return asset;
}
async function form(
  f: Fixture,
  literatureId = f.parseRequest.literature_id,
  asset = f.asset,
) {
  const raw = (await f.app.rawParseStorage!.current(asset.asset_id)).find(
    (r) => r.profile === "vlm-engine",
  )!.result!;
  return f.app.draftDocuments.publish({
    literature_id: literatureId,
    asset_id: asset.asset_id,
    asset_sha256: asset.sha256,
    raw,
  });
}
const create = (
  f: Fixture,
  key: string,
  options: { selector?: unknown; include_older_method?: boolean } = {},
) =>
  f.app.jobService!.create({
    target_kind: "selector",
    selector: (options.selector ??
      selector) as import("../src/entry/selectors.js").LiteratureSelector,
    goal: "draft",
    include_older_method: options.include_older_method ?? false,
    idempotency_key: key,
    policy_version: "synthetic-drafts-v1",
    policy: { mode: "never", max_retries: 0 },
  });
function rows(f: Fixture, sql: string) {
  const db = new DatabaseSync(join(f.home, "catalog.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
function receipts(
  task: Awaited<
    ReturnType<NonNullable<Fixture["app"]["processingTasks"]>["read"]>
  >,
) {
  return [...task.results, ...task.partial_results] as {
    result: { literature_id: string; parts: FormDraftsPartResult[] };
  }[];
}
async function oldMethod(f: Fixture) {
  const raw = (await f.app.rawParseStorage!.current(f.asset.asset_id)).find(
    (r) => r.profile === "vlm-engine",
  )!.result!;
  const material = (await f.app.database.documentMaterial(
    f.parseRequest.literature_id,
    f.asset.asset_id,
  ))!;
  const built = await buildDraftDocument(
    raw,
    {
      readArtifact: (id, kind, ref, signal) =>
        f.app.rawParseStorage!.readArtifact(id, kind, ref, signal),
    },
    await f.app.archiveText!.pdf.inspect(f.asset.asset_id, f.asset.sha256),
    material.material,
    { correct_reading_order: true },
  );
  const storage = new SqliteDocumentStorage(f.app.database, f.app.files);
  const publish = async (
    kind: Parameters<typeof artifactReference>[0],
    bytes: Uint8Array,
    artifact: import("@sciretriever/contracts").ArtifactRef,
  ) => {
    const path =
      (await f.app.database.locateArtifact(artifact))?.reference ??
      artifactReference(kind, artifact);
    await storage.publishImmutableArtifact(path, bytes, artifact);
    return path;
  };
  const v = built.document;
  const paths = {
    draft_content_artifact_path: await publish(
      "draft-content",
      built.content_bytes,
      v.draft_content,
    ),
    markdown_artifact_path: await publish(
      "draft-markdown",
      built.markdown,
      v.markdown,
    ),
    structure_artifact_path: await publish(
      "document-structure",
      built.structure_bytes,
      v.structure,
    ),
  };
  const commit = async () =>
    storage.commitDraftVersion({
      version: v,
      ...paths,
      source_artifact_path: material.path,
      resource_artifact_paths: {},
      expected_current_revision:
        (await f.app.database.draftCurrent(f.asset.asset_id))?.revision ?? null,
      expected_default_revision:
        (
          await f.app.database.documentDefault(
            f.parseRequest.literature_id,
            f.asset.asset_id,
            f.asset.sha256,
          )
        )?.revision ?? null,
    });
  await commit();
  return { version: v, commit };
}

it("previews without writes or page tools, skips before applying the query limit, and freezes the same counts", async () => {
  const f = await coreProcessingFixture({ offline: true });
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await f.app.metadataFields.edit({
      literature_id: f.parseRequest.literature_id,
      expected_revision: (
        await f.app.metadataFields.read(f.parseRequest.literature_id)
      ).metadata_revision,
      set: [{ field: "title", value: "D eligible" }],
      unlock: [],
    });
    await rawOnly(f);
    const existing = await paper(f, 2, "A existing");
    await form(f, existing.literature.literature_id, existing.asset!);
    // Existence belongs to the selected raw, even if another profile owns
    // draft_current. Preview must still see the first profile's fixed draft.
    const other = await f.app.rawParsing!.parseAsset(
      existing.asset!.asset_id,
      ["pipeline"],
      undefined,
      { expected_sha256: existing.asset!.sha256, force: false },
    );
    await f.app.draftDocuments.publish({
      literature_id: existing.literature.literature_id,
      asset_id: existing.asset!.asset_id,
      asset_sha256: existing.asset!.sha256,
      raw: other[0]!.result!,
    });
    await paper(f, 3, "B unparsed", false);
    await paper(f, 4, "C no PDF", false, false);
    const extra = await paper(f, 5, "E eligible");
    await supplement(f, extra.literature.literature_id, 5);
    q = await createQueryApplication(f.home);
    const before = rows(
      f,
      "SELECT (SELECT count(*) FROM document_versions) v,(SELECT count(*) FROM raw_parses) r,(SELECT count(*) FROM execution_jobs) j,(SELECT count(*) FROM archive_version_events) e",
    );
    const inspect = vi.spyOn(f.app.archiveText!.pdf, "inspect"),
      rawRead = vi.spyOn(q.rawParseRead!, "current");
    const expected = {
      matched: 5,
      process: 2,
      process_parts: 3,
      skipped_has_draft: 1,
      skipped_no_raw_parse: 2,
      over_limit: 0,
    };
    expect(await executeQuery(q, "form-drafts-preview", { selector })).toEqual(
      expected,
    );
    const limited = { ...selector, limit: 1 };
    const counts = await executeQuery(q, "form-drafts-preview", {
      selector: limited,
    });
    expect(counts).toEqual({
      ...expected,
      process: 1,
      process_parts: 1,
      over_limit: 1,
    });
    expect(
      rows(
        f,
        "SELECT (SELECT count(*) FROM document_versions) v,(SELECT count(*) FROM raw_parses) r,(SELECT count(*) FROM execution_jobs) j,(SELECT count(*) FROM archive_version_events) e",
      ),
    ).toEqual(before);
    expect(inspect).not.toHaveBeenCalled();
    expect(rawRead).not.toHaveBeenCalled();
    const descending = await create(f, "preview-descending", {
      selector: { ...limited, sort: "title-desc" },
    });
    expect(descending.selector).toMatchObject({
      scope: {
        counts: { ...expected, process: 1, process_parts: 2, over_limit: 1 },
      },
    });
    expect(
      (await f.app.jobs!.listTargets(descending.job_id)).map(
        (t) => t.literature_id,
      ),
    ).toEqual([extra.literature.literature_id]);
    const job = await create(f, "preview-freeze", { selector: limited });
    const task = await createTaskReader(f.app.jobs!).read(job.job_id);
    expect(task.scope).toMatchObject({ counts });
    expect(task.targets.map((t) => t.literature_id)).toEqual([
      f.parseRequest.literature_id,
    ]);
    expect(
      (await createTaskReader(f.app.jobs!).list()).tasks.find(
        (t) => t.job_id === job.job_id,
      )!.scope,
    ).toEqual(task.scope);
    expect(
      await executeQuery(q, "task-run", { job_id: job.job_id }),
    ).toMatchObject({
      scope: task.scope,
      items: [{ operation: "form-drafts", draft_parts: [] }],
    });
    await expect(
      create(f, "too-large", {
        selector: {
          kind: "literatures",
          literature_ids: Array(10_001).fill(f.parseRequest.literature_id),
        },
      }),
    ).rejects.toThrow();
  } finally {
    vi.restoreAllMocks();
    await q?.close();
    await f.close();
  }
}, 60_000);

it("isolates a failed PDF part, keeps other drafts, and submits only missing parts again without parser, model or network calls", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    await rawOnly(f);
    const supp = await supplement(f, f.parseRequest.literature_id, 10);
    await paper(f, 2, "Second eligible");
    const parses = f.parseCalls,
      calls = f.modelCalls;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Synthetic network forbidden"));
    const inspect = f.app.archiveText!.pdf.inspect.bind(f.app.archiveText!.pdf);
    const blocked = vi
      .spyOn(f.app.archiveText!.pdf, "inspect")
      .mockImplementation(async (...args) => {
        if (args[0] === supp.asset_id)
          throw new Error("Synthetic page tools failure");
        return inspect(...args);
      });
    const job = await create(f, "parts-first");
    const task = await f.app.processingTasks!.run(job.job_id);
    expect(task.job.status).toBe("failed");
    const parts = receipts(task).flatMap((r) => r.result.parts);
    expect(parts.filter((p) => p.status === "formed")).toHaveLength(2);
    const q = await createQueryApplication(f.home);
    try {
      const report = (await executeQuery(q, "task-run", {
        job_id: job.job_id,
      })) as {
        items: { operation: string; draft_parts: FormDraftsPartResult[] }[];
      };
      expect(
        report.items.every((item) => item.operation === "form-drafts"),
      ).toBe(true);
      expect(report.items.flatMap((item) => item.draft_parts)).toContainEqual(
        expect.objectContaining({
          asset_id: supp.asset_id,
          failure_code: "page-tools-unavailable",
        }),
      );
    } finally {
      await q.close();
    }
    expect(parts).toContainEqual(
      expect.objectContaining({
        asset_id: supp.asset_id,
        status: "failed",
        failure_code: "page-tools-unavailable",
      }),
    );
    expect(rows(f, "SELECT count(*) n FROM document_versions")[0]!.n).toBe(2);
    blocked.mockRestore();
    const next = await create(f, "parts-second");
    expect(next.selector).toMatchObject({
      scope: { counts: { process: 1, process_parts: 1, skipped_has_draft: 1 } },
    });
    const resumed = await f.app.processingTasks!.run(next.job_id);
    expect(resumed.job.status).toBe("completed");
    expect(receipts(resumed).flatMap((r) => r.result.parts)).toEqual([
      expect.objectContaining({ part: "main", status: "skipped" }),
      expect.objectContaining({ asset_id: supp.asset_id, status: "formed" }),
    ]);
    expect(rows(f, "SELECT count(*) n FROM document_versions")[0]!.n).toBe(3);
    expect((await create(f, "parts-first")).selector).toEqual(job.selector);
    expect(f.parseCalls).toBe(parses);
    expect(f.modelCalls).toBe(calls);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 60_000);

it("reopens the frozen task, excludes later arrivals and reports reuse only for formation after creation", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    await rawOnly(f);
    await paper(f, 2, "Second");
    const job = await create(f, "freeze-restart");
    await paper(f, 3, "Later arrival");
    await form(f);
    await f.reopen();
    expect((await create(f, "freeze-restart")).selector).toEqual(job.selector);
    const task = await f.app.processingTasks!.run(job.job_id);
    expect(task.job.status).toBe("completed");
    expect(task.targets.map((t) => t.literature_id).sort()).toEqual([
      id(1),
      id(2),
    ]);
    expect(
      receipts(task)
        .flatMap((r) => r.result.parts)
        .map((p) => p.status)
        .sort(),
    ).toEqual(["formed", "reused"]);
    expect(rows(f, "SELECT count(*) n FROM document_versions")[0]!.n).toBe(2);
  } finally {
    await f.close();
  }
}, 60_000);

it("reforms older methods only by explicit request and does not mislabel a preexisting fixed version as concurrent reuse", async () => {
  const f = await coreProcessingFixture({ offline: true });
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await rawOnly(f);
    const old = await oldMethod(f);
    expect(old.version.draft_method_sha256).not.toBe(currentDraftMethodHash());
    q = await createQueryApplication(f.home);
    expect(await q.formDraftsPreview!({ selector })).toMatchObject({
      process: 0,
      skipped_has_draft: 1,
    });
    expect(
      await q.formDraftsPreview!({ selector, include_older_method: true }),
    ).toMatchObject({ process: 1, process_parts: 1 });
    const run = async (key: string) =>
      f.app.processingTasks!.run(
        (await create(f, key, { include_older_method: true })).job_id,
      );
    expect(
      receipts(await run("old-method-first"))[0]!.result.parts[0]!.status,
    ).toBe("formed");
    const current = (await f.app.database.draftCurrent(f.asset.asset_id))!;
    expect(
      (await f.app.database.documentVersion(current.document_version_id))!
        .version,
    ).toMatchObject({ draft_method_sha256: currentDraftMethodHash() });
    await old.commit();
    expect(
      receipts(await run("old-method-again"))[0]!.result.parts[0]!.status,
    ).toBe("formed");
    expect(rows(f, "SELECT count(*) n FROM document_versions")[0]!.n).toBe(2);
  } finally {
    await q?.close();
    await f.close();
  }
}, 60_000);

function checkpoint() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
const generation = (revision: number) => ({
  generation_id: "00000000-0000-0000-0000-000000000101",
  source_revision: revision,
  entry_count: 0,
  source_count: 0,
});

it("retains committed parts on cancellation, leaves unclaimed targets pending and resumes through a new selection", async () => {
  const f = await coreProcessingFixture({
    offline: true,
    configurationText: "[execution]\nmax_concurrency=1\n",
  });
  const entered = checkpoint(),
    release = checkpoint();
  let pending: Promise<unknown> | undefined,
    cancelling: Promise<unknown> | undefined;
  try {
    await rawOnly(f);
    await paper(f, 2, "Second eligible");
    const publish = f.app.draftDocuments.publish.bind(f.app.draftDocuments);
    vi.spyOn(f.app.draftDocuments, "publish").mockImplementationOnce(
      async (...args) => {
        const formed = await publish(...args);
        entered.release();
        await release.reached;
        return formed;
      },
    );
    const job = await create(f, "cancel-drafts", {
      selector: {
        kind: "literatures",
        literature_ids: [f.parseRequest.literature_id, id(2)],
      },
    });
    pending = f.app.processingTasks!.run(job.job_id);
    await entered.reached;
    const accepted = (await f.app.database.draftCurrent(f.asset.asset_id))!
      .document_version_id;
    cancelling = f.app.processingTasks!.control(job.job_id, "cancel");
    await vi.waitFor(
      async () =>
        expect((await f.app.jobs!.getJob(job.job_id))!.status).toBe(
          "cancelled",
        ),
      { timeout: 20_000 },
    );
    release.release();
    await cancelling;
    await pending;
    const task = await f.app.processingTasks!.read(job.job_id);
    expect(task.job.status).toBe("cancelled");
    expect(task.targets.find((t) => t.literature_id === id(2))).toMatchObject({
      stage: "queued",
      disposition: "pending",
    });
    expect(
      await f.app.jobs!.listAttempts(
        task.targets.find((t) => t.literature_id === id(2))!.target_id,
      ),
    ).toEqual([]);
    expect(receipts(task).flatMap((r) => r.result.parts)).toContainEqual(
      expect.objectContaining({
        status: "formed",
        document_version_id: accepted,
      }),
    );
    expect(
      (await f.app.database.draftCurrent(f.asset.asset_id))!
        .document_version_id,
    ).toBe(accepted);
    await f.reopen();
    const next = await create(f, "resume-after-cancel");
    expect(next.selector).toMatchObject({
      scope: { counts: { process: 1, skipped_has_draft: 1 } },
    });
    expect((await f.app.processingTasks!.run(next.job_id)).job.status).toBe(
      "completed",
    );
    expect(rows(f, "SELECT count(*) n FROM document_versions")[0]!.n).toBe(2);
  } finally {
    release.release();
    await Promise.allSettled([
      ...(pending ? [pending] : []),
      ...(cancelling ? [cancelling] : []),
    ]);
    vi.restoreAllMocks();
    await f.close();
  }
}, 60_000);

it.each([false, true])(
  "uses registered Markdown raw without invoking a parser (ambiguous pages: %s)",
  async (ambiguous) => {
    const f = await coreProcessingFixture({
      offline: true,
      pageCount: ambiguous ? 2 : 1,
    });
    try {
      const bytes = Buffer.from(
        ambiguous
          ? "Repeated text."
          : "# Unique heading\n\nThe unique body text.",
      );
      f.setText(bytes.toString());
      const input = parseRawParseInput({
        source_asset_id: f.asset.asset_id,
        source_sha256: f.asset.sha256,
        profile: "vlm-engine-markdown-only" as const,
        parser_version: "synthetic-legacy-v1",
        model_identity: null,
        parameters_sha256: "a".repeat(64),
        page_count: ambiguous ? 2 : 1,
        page_sizes: [],
        blocks: null,
        markdown: {
          sha256: await sha256(bytes),
          byte_size: bytes.length,
          media_type: "text/markdown",
        },
        resources: [],
        private_content_list: null,
      });
      const raw = await parseRawParse({
        ...input,
        ...(await rawParseIdentity(input)),
      });
      await f.app.rawParseStorage!.publish({
        result: raw,
        markdown: { artifact: input.markdown, bytes },
        blocks: null,
        private_content_list: null,
        resources: [],
      });
      const job = await create(f, `markdown-${ambiguous}`);
      expect(job.selector).toMatchObject({
        scope: { counts: { process: 1, process_parts: 1 } },
      });
      const task = await f.app.processingTasks!.run(job.job_id);
      const part = receipts(task)[0]!.result.parts[0]!;
      if (ambiguous)
        expect(part).toMatchObject({
          status: "failed",
          failure_code: "needs-parse",
        });
      else {
        expect(part).toMatchObject({ status: "formed", default_changed: true });
        const segments = await f.app.documentRead.segments({
          document_version_id: part.document_version_id!,
          section_id: null,
          limit: 200,
          cursor: null,
        });
        expect(segments.text_level).toBe("draft");
      }
      expect(f.parseCalls).toBe(0);
      expect(f.modelCalls).toBe(0);
    } finally {
      await f.close();
    }
  },
  60_000,
);

it("backfills a corrected part without changing its default, content events or a real stored result's freshness", async () => {
  const f = await coreProcessingFixture({ offline: true });
  const store = new SqliteProcessorStorage(
    f.app.database,
    f.app.files,
    f.app.documentRead,
  );
  try {
    f.setText(source);
    const corrected = await correctedDocumentFixture(f.app).parseDocuments(
      f.parseRequest,
    );
    await f.app.structureAnnotations!.buildRules({
      document_version_id: corrected.document.document_version_id,
    });
    const state = await f.app.archive.status(f.parseRequest.literature_id),
      main = state.parts.find((p) => p.part === "main")!;
    expect(main.content_version).not.toBeNull();
    const segments = await f.app.documentRead.segments({
      document_version_id: main.document_version_id!,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    const slice = await f.app.documentRead.slice({
      document_version_id: main.document_version_id!,
      selector: {
        kind: "segment",
        segment_id: segments.segments.at(-1)!.segment_id,
      },
      max_bytes: 65536,
      continuation: null,
    });
    const invocation = parseProcessorInvocation({
      schema_version: 1,
      processor: { id: "labels", version: "2" },
      spec: {},
      inputs: [
        {
          kind: "archive-document",
          input_id: "document",
          literature_id: f.parseRequest.literature_id,
          description_version: state.description_version,
          parts: [
            {
              asset_id: f.asset.asset_id,
              asset_sha256: f.asset.sha256,
              part: "main",
              available: true,
              content_version: main.content_version,
              document_version_id: main.document_version_id,
              structure_annotation_id: main.structure_annotation_id,
            },
          ],
        },
      ],
      execution: {
        reads: { parts: "main", roles: "all" },
        uses_description: false,
        map: null,
        method_sha256: "a".repeat(64),
        model: null,
      },
    });
    const content = {
      kind: "report" as const,
      text: slice.text,
      claims: [
        {
          record_id: "finding",
          text: slice.text,
          sources: [
            { kind: "document" as const, evidence: slice.evidence[0]! },
          ],
        },
      ],
    };
    const stored = await store.publish(
      await parseProcessorResult({
        schema_version: 1,
        result_id: randomUUID(),
        invocation,
        comparison_sha256: await processorComparison(invocation),
        status: "ok",
        content,
        value_checks: uncheckedProcessorValues(
          content,
          "Synthetic lifecycle receipt.",
        ),
        coverage: [
          {
            input_id: "document",
            parts: [],
            status: "complete",
            read_segments: [],
            gaps: [],
          },
        ],
        producer: "external",
        provenance: { source: "synthetic-backfill" },
        literature_ids: [f.parseRequest.literature_id],
        created_at: "2026-11-15T00:00:00Z",
      }),
    );
    expect(stored.freshness).toMatchObject({ state: "current", reasons: [] });
    const before = rows(
        f,
        "SELECT * FROM archive_version_events WHERE kind='content-version-changed'",
      ),
      calls = f.modelCalls,
      parses = f.parseCalls;
    expect(await f.app.database.draftCurrent(f.asset.asset_id)).toBeNull();
    const task = await f.app.processingTasks!.run(
      (await create(f, "corrected-backfill")).job_id,
    );
    expect(task.job.status).toBe("completed");
    expect(receipts(task)[0]!.result.parts[0]).toMatchObject({
      status: "formed",
      default_changed: false,
    });
    expect(
      (await f.app.database.documentDefault(
        f.parseRequest.literature_id,
        f.asset.asset_id,
        f.asset.sha256,
      ))!.document_version_id,
    ).toBe(main.document_version_id);
    expect(
      rows(
        f,
        "SELECT * FROM archive_version_events WHERE kind='content-version-changed'",
      ),
    ).toEqual(before);
    expect((await store.byId(stored.result.result_id))!.freshness).toEqual(
      stored.freshness,
    );
    expect(f.modelCalls).toBe(calls);
    expect(f.parseCalls).toBe(parses);
  } finally {
    await store.close();
    await f.close();
  }
}, 60_000);

it("persists a distinct draft goal with the existing analysis stage and reads its saved scope", async () => {
  const database = new SqliteWorker();
  const repository = new ExecutionRepository(database);
  const scope = {
    selector: { kind: "query", query: {}, sort: "title-asc", limit: null },
    counts: {
      matched: 1,
      process: 1,
      process_parts: 1,
      skipped_has_draft: 0,
      skipped_no_raw_parse: 0,
      over_limit: 0,
    },
  };
  try {
    const job = await repository.createJob({
      job_id: "draft-stage-gate",
      idempotency_key: "draft-stage-gate",
      target_kind: "selector",
      selector: { schema_version: 2, goal: "draft", scope },
      policy_version: "draft-stage-gate-v1",
      policy: { mode: "never", max_retries: 0 },
      targets: [
        {
          job_id: "draft-stage-gate",
          target_id: "draft-stage-gate:0",
          ordinal: 0,
          literature_id: null,
          version_role: null,
          stage: "queued",
          disposition: "pending",
          next_eligible_at: null,
        },
      ],
    });
    // This gate exercises the queue/schema, not draft formation or selection.
    const queue = new ExecutionQueue(repository);
    await queue.runNext(job.job_id, async () => "completed", {
      stage_for_target: () => "analysis",
    });
    expect(await repository.listAttempts("draft-stage-gate:0")).toEqual([
      expect.objectContaining({ stage: "analysis", status: "completed" }),
    ]);
    const reader = createTaskReader(repository);
    expect(await reader.read(job.job_id)).toMatchObject({
      job: { selector: { goal: "draft" } },
      scope: { counts: scope.counts },
    });
    expect((await reader.list()).tasks[0]).toMatchObject({
      progress: { total: 1, done: 1 },
      scope: { counts: scope.counts },
    });
  } finally {
    await database.close();
  }
});

it("coalesces one thousand pending draft publication refreshes into the latest revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-draft-refresh-"));
  const started = checkpoint(),
    unblock = checkpoint();
  let revision = 1;
  const scanned: number[] = [];
  const rebuild = vi.fn(async () => generation(revision));
  const service = new IndexRefreshService(
    join(root, "catalog.sqlite"),
    {
      async refresh() {
        const acceptedRevision = revision;
        scanned.push(acceptedRevision);
        if (scanned.length === 1) {
          started.release();
          await unblock.reached;
        }
        return generation(acceptedRevision);
      },
      build: rebuild,
    },
    async () => revision,
  );
  try {
    await service.start();
    await service.schedule();
    await started.reached;
    for (let next = 2; next <= 1_001; next++) {
      revision = next;
      await service.schedule();
    }
    expect(scanned).toEqual([1]);
    expect(await service.status()).toMatchObject({
      request_sequence: 1_001,
      requested_revision: 1_001,
    });
    unblock.release();
    await vi.waitFor(
      async () =>
        expect(await service.status()).toMatchObject({
          status: "updated",
          indexed_revision: 1_001,
        }),
      { timeout: 20_000 },
    );
    expect(scanned).toEqual([1, 1_001]);
    expect(rebuild).not.toHaveBeenCalled();
  } finally {
    unblock.release();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
