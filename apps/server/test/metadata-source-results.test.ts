import { withActivity } from "../src/logging/activity.js";
const runMetadataTask: typeof runMetadataTaskInternal = (...args) =>
  withActivity({ actor: "cli:test" }, () => runMetadataTaskInternal(...args));
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  parseMetadataObservation,
  parseMetadataSourceProgress,
  parseSourceStatistics,
  parseTaskSourceResults,
  type MetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { createTaskReader } from "../src/entry/task-read.js";
import {
  prepareMetadataTask,
  runMetadataTask as runMetadataTaskInternal,
} from "../src/entry/metadata-task.js";
import { sourceStatistics } from "../src/application/source-statistics.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { networkRequestDispatched } from "../src/network/request-activity.js";
import {
  MetadataProviderFailure,
  type RawItemSession,
  type NeutralMetadataItem,
} from "../src/metadata/ports.js";
function observation(source: string, name: string): MetadataObservation {
  return parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: randomUUID(),
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
      source_record_id: name,
      observed_at: new Date().toISOString(),
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: name,
      identifiers: [{ namespace: "doi", value: "10.5555/" + name }],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
function session(items: NeutralMetadataItem[]): RawItemSession {
  let index = 0;
  return {
    pull_raw_item() {
      networkRequestDispatched();
      return index < items.length
        ? {
            raw_item: items[index++]!,
            source_exhausted_after: index === items.length,
          }
        : null;
    },
    convert_raw_item: (raw) => raw as NeutralMetadataItem,
  };
}
it("records request/returned progress while a source is still running and reuses the same totals after completion and lookup", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-live-"));
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const one = observation("crossref", "shared");
  const two = observation("openalex", "shared");
  const app = await createApplication(home, {
    metadata: {
      topic_search_ports: [
        {
          provider_name: "crossref",
          open_topic_search: () => {
            let index = 0;
            return {
              async pull_raw_item() {
                networkRequestDispatched();
                if (index++ === 0)
                  return { raw_item: one, source_exhausted_after: false };
                await held;
                return null;
              },
              convert_raw_item: () => ({ observations: [one], relations: [] }),
            };
          },
        },
        {
          provider_name: "openalex",
          open_topic_search: () =>
            session([{ observations: [two], relations: [] }]),
        },
      ],
      lookup_ports: [
        {
          provider_name: "crossref",
          open_lookup: () => {
            networkRequestDispatched();
            throw new MetadataProviderFailure({
              code: "metadata-provider-authentication",
              reason: "synthetic private message",
              action: "synthetic",
              retryable: false,
            });
          },
        },
        {
          provider_name: "openalex",
          open_lookup: () =>
            session([
              {
                observations: [observation("openalex", "shared")],
                relations: [],
              },
            ]),
        },
      ],
      readiness: { elsevier: "credential-missing" },
    },
  });
  let run: Promise<unknown> | undefined;
  try {
    const request = prepareMetadataTask(app, {
      kind: "topic",
      query: "synthetic",
      year_from: null,
      year_to: null,
    });
    expect(request.providers.map((p) => p.source)).toEqual([
      "crossref",
      "openalex",
    ]);
    const job = await withActivity({ actor: "cli:test" }, () =>
      app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "live",
        operations: [{ operation: "acquire-metadata", request }],
      }),
    );
    const reader = createTaskReader(app.jobs!);
    run = app.processingTasks!.run(job.job_id);
    await vi.waitFor(async () => {
      const read = await reader.read(job.job_id);
      expect(read.job.status).toBe("running");
      expect(read.source_results.metadata?.records[0]).toMatchObject({
        requested: true,
        returned: 1,
        result: "running",
      });
    });
    release();
    await run;
    const done = await reader.read(job.job_id);
    expect(parseTaskSourceResults(done.source_results).metadata).toMatchObject({
      returned: 2,
      merged: 1,
      new_literatures: 1,
      matched_literatures: 0,
    });
    expect(
      done.source_results.metadata!.sources.map((s) => s.included),
    ).toEqual([1, 1]);
    const id = (
      await app.database.findLiteratureByIdentifiers(one.metadata.identifiers)
    )[0]!.literature_id;
    const result = await runMetadataTask(app, {
      kind: "lookup",
      literature_ids: [id],
      providers: [
        { source: "crossref", scan_limit: 2 },
        { source: "elsevier", scan_limit: 2 },
        { source: "openalex", scan_limit: 2 },
      ],
    });
    expect(result.source_summary.metadata!.records).toMatchObject([
      {
        source: "crossref",
        result: "error",
        requested: true,
        problem: { display: "credential-invalid" },
      },
      {
        source: "elsevier",
        result: "unavailable",
        requested: false,
        problem: { display: "not-configured" },
      },
      { source: "openalex", result: "hit", requested: true },
    ]);
    const totals = await sourceStatistics(app.jobs!, { range: "all" });
    expect(totals.metadata).toMatchObject({
      topic_searches: 1,
      lookup_documents: 1,
    });
    expect(
      totals.metadata.sources.find((s) => s.source === "openalex"),
    ).toMatchObject({
      topic_coverage: { ratio: 1 },
      lookup_hit: { numerator: 1, denominator: 1, ratio: 1 },
    });
    expect(JSON.stringify(result.source_summary)).not.toMatch(
      /synthetic private|https|authorization|headers|cookie|token/,
    );
  } finally {
    release();
    await run;
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
it("attributes citation-list coverage to its primary source and preserves separate supporting lookup errors and successes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-citation-"));
  const target = observation("openalex", "citation-target");
  const app = await createApplication(home, {
    metadata: {
      reference_query_ports: [
        {
          provider_name: "crossref",
          open_reference_query: (context) =>
            session([
              {
                observations: [],
                relations: [
                  {
                    observation_id: randomUUID(),
                    provenance: observation("crossref", "relation").provenance,
                    citing: context.keys[0]!,
                    cited: {
                      record_id: null,
                      identifiers: target.metadata.identifiers,
                    },
                  },
                ],
              },
            ]),
        },
      ],
      lookup_ports: [
        {
          provider_name: "crossref",
          open_lookup: () => {
            networkRequestDispatched();
            throw new MetadataProviderFailure({
              code: "metadata-provider-http",
              reason: "synthetic",
              action: "synthetic",
              retryable: true,
            });
          },
        },
        {
          provider_name: "openalex",
          open_lookup: () =>
            session([{ observations: [target], relations: [] }]),
        },
      ],
    },
  });
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const result = await runMetadataTask(app, {
      kind: "citation",
      seed_literature_ids: [FIXTURE_LITERATURE.literature_id],
      direction: "references",
      max_depth: 1,
      result_limit: 20,
      providers: [
        { source: "crossref", scan_limit: 20 },
        { source: "openalex", scan_limit: 20 },
      ],
    });
    const summary = result.source_summary.metadata!;
    expect(summary).toMatchObject({ merged: 1, new_literatures: 1 });
    expect(summary.records).toMatchObject([
      {
        source: "crossref",
        purpose: "reference-query",
        role: "primary",
        result: "hit",
      },
      {
        source: "crossref",
        purpose: "lookup",
        role: "supporting",
        result: "error",
      },
      {
        source: "openalex",
        purpose: "lookup",
        role: "supporting",
        result: "hit",
      },
    ]);
    const stats = await sourceStatistics(app.jobs!, { range: "all" });
    expect(stats.metadata).toMatchObject({
      reference_documents: 1,
      lookup_documents: 0,
    });
    expect(
      stats.metadata.sources.find((s) => s.source === "crossref"),
    ).toMatchObject({
      reference_hit: { numerator: 1, denominator: 1, ratio: 1 },
      error_rate: { numerator: 1, denominator: 2, ratio: 0.5 },
    });
    expect(
      stats.metadata.sources.find((s) => s.source === "openalex")!.lookup_hit
        ?.denominator,
    ).toBe(0);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
it("excludes unrecorded history, applies job-created time windows and reads beyond one source-event page with a stable snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-window-"));
  const app = await createApplication(home, {
    metadata: {
      topic_search_ports: [
        { provider_name: "crossref", open_topic_search: () => session([]) },
      ],
    },
  });
  try {
    const create = async (key: string, created: string) => {
      return app.jobs!.createJob({
        target_kind: "selector",
        selector: {},
        policy_version: "fixture",
        policy: {},
        idempotency_key: key,
        created_at: created,
      });
    };
    const old = await create("old", "2026-08-01T00:00:00.000Z");
    await create("unrecorded", "2026-07-01T00:00:00.000Z");
    const newJob = await create("new", "2026-10-28T00:00:00.000Z");
    // This reader fixture needs all 1,640 events to cross the real 1,000-row
    // boundary, not 1,640 independent write-admission locks and commits. No job
    // runs while we seed this newly created temporary catalog.
    const seed = new DatabaseSync(join(home, "catalog.sqlite"));
    try {
      seed.exec("PRAGMA foreign_keys=ON");
      seed.exec("BEGIN");
      try {
        const insert = seed.prepare(
          "INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        );
        for (const job of [old, newJob]) {
          let sequence = Number(
            seed
              .prepare(
                "SELECT coalesce(max(sequence),-1)+1 AS next FROM execution_events WHERE job_id=?",
              )
              .get(job.job_id)!.next,
          );
          for (let n = 0; n < 205; n++) {
            const base = {
              schema_version: 1,
              record_id: "r" + n,
              source: "crossref",
              purpose: "lookup",
              role: "primary",
              unit_id: "u" + n,
              at: "2026-10-28T00:00:00.000Z",
            };
            for (const progress of [
              { ...base, phase: "started" },
              { ...base, phase: "requested" },
              { ...base, phase: "returned", count: 0 },
              { ...base, phase: "finished", result: "miss", problem: null },
            ])
              insert.run(
                randomUUID(),
                job.job_id,
                sequence++,
                "metadata-source",
                JSON.stringify({
                  target_id: "t",
                  progress: parseMetadataSourceProgress(progress),
                }),
                base.at,
              );
          }
        }
        seed.exec("COMMIT");
      } catch (error) {
        seed.exec("ROLLBACK");
        throw error;
      }
      expect(seed.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      seed.close();
    }
    const clock = () => new Date("2026-10-28T01:00:00.000Z");
    const pages = vi.spyOn(app.jobs!, "sourceRecordPage");
    const all = parseSourceStatistics(
      await sourceStatistics(app.jobs!, { range: "all" }, undefined, clock),
    );
    // Exercise the real aggregation's continuation too, not only manual paging.
    expect(pages).toHaveBeenCalledTimes(2);
    const [allFirst, allSecond] = await Promise.all(
      pages.mock.results.map((result) => result.value),
    );
    expect(allFirst.events).toHaveLength(1000);
    expect(allSecond.events).toHaveLength(640);
    expect(pages.mock.calls[1]![0]).toMatchObject({
      after: allFirst.next_after,
      snapshot: allFirst.snapshot,
      limit: 1000,
    });
    expect(allSecond.snapshot).toBe(allFirst.snapshot);
    expect(allSecond.next_after).toBeNull();
    pages.mockRestore();
    const recent = await sourceStatistics(
      app.jobs!,
      { range: "last-30-days" },
      undefined,
      clock,
    );
    expect(all.metadata.lookup_documents).toBe(410);
    expect(recent.metadata.lookup_documents).toBe(205);
    expect(all.recorded_since).toBe("2026-08-01T00:00:00.000Z");
    expect(recent.recorded_since).toBe(all.recorded_since);
    const first = await app.jobs!.sourceRecordPage({
      job_id: null,
      from: null,
      through: clock().toISOString(),
      after: 0,
      snapshot: null,
      limit: 1000,
    });
    expect(first.events).toHaveLength(1000);
    expect(first.next_after).not.toBeNull();
    const appended = await app.jobs!.appendEvent({
      event_id: randomUUID(),
      job_id: newJob.job_id,
      sequence: -1,
      kind: "pdf-source-result",
      payload: {
        result: {
          schema_version: 1,
          literature_id: FIXTURE_LITERATURE.literature_id,
          finished_at: clock().toISOString(),
          result: "not-obtained",
          source: null,
          stage: null,
          receipt_id: null,
          technical_details: { diagnostics: [] },
        },
      },
      created_at: clock().toISOString(),
    });
    const second = await app.jobs!.sourceRecordPage({
      job_id: null,
      from: null,
      through: clock().toISOString(),
      after: first.next_after!,
      snapshot: first.snapshot,
      limit: 1000,
    });
    expect(second.events).toHaveLength(640);
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.next_after).toBeNull();
    const ids = [...first.events, ...second.events].map(
      (event) => event.event_id,
    );
    expect(new Set(ids).size).toBe(1640);
    expect(second.events.some((e) => e.kind === "pdf-source-result")).toBe(
      false,
    );
    // The new row has the same timestamp cutoff and is visible to a fresh
    // snapshot; only the fixed high-water mark keeps it out of the old one.
    const fresh = await app.jobs!.sourceRecordPage({
      job_id: null,
      from: null,
      through: clock().toISOString(),
      after: first.next_after!,
      snapshot: null,
      limit: 1000,
    });
    expect(fresh.snapshot).toBeGreaterThan(first.snapshot);
    expect(fresh.events).toHaveLength(641);
    expect(fresh.next_after).toBeNull();
    expect(fresh.events.at(-1)).toEqual(appended);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("does not turn cancellation during a dispatched source into a request error or lose its durable partial progress", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-source-cancel-"));
  let entered!: () => void;
  const dispatched = new Promise<void>((r) => {
    entered = r;
  });
  const abort = new AbortController();
  const app = await createApplication(home, {
    metadata: {
      topic_search_ports: [
        {
          provider_name: "crossref",
          open_topic_search: () => ({
            pull_raw_item: async () => {
              networkRequestDispatched();
              entered();
              await new Promise<void>((r) =>
                abort.signal.addEventListener("abort", () => r(), {
                  once: true,
                }),
              );
              throw new DOMException("synthetic cancellation", "AbortError");
            },
            convert_raw_item: () => ({ observations: [], relations: [] }),
          }),
        },
      ],
    },
  });
  let running: Promise<unknown> | undefined;
  try {
    const job = await withActivity({ actor: "cli:test" }, () =>
      app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "cancel-source",
        operations: [
          {
            operation: "acquire-metadata",
            request: prepareMetadataTask(app, {
              kind: "topic",
              query: "synthetic",
              year_from: null,
              year_to: null,
            }),
          },
        ],
      }),
    );
    running = app.processingTasks!.run(job.job_id, abort.signal);
    await dispatched;
    abort.abort();
    await running;
    const task = await createTaskReader(app.jobs!).read(job.job_id);
    expect(task.source_results.metadata?.records).toMatchObject([
      { requested: true, result: "cancelled", problem: null },
    ]);
    expect(task.source_results.metadata?.sources[0]!.errors).toBe(0);
  } finally {
    abort.abort();
    await running;
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
