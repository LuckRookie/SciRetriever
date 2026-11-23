import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { processingJobId } from "../src/application/jobs/processing.js";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import {
  citationItemKey,
  parseCitationCheckpoint,
  pendingCitationItem,
  restoreCitationItem,
  type CitationCause,
  type CitationCheckpoint,
} from "../src/entry/citation-checkpoint.js";
import { runMetadataTask } from "../src/entry/metadata-task.js";
import { createTaskReader } from "../src/entry/task-read.js";
import { finishIntake, startIntake } from "../src/literature/intake.js";
import { IntakeWithdrawalService } from "../src/literature/intake-withdrawal.js";
import { withActivity } from "../src/logging/activity.js";
import type {
  NeutralMetadataItem,
  ReferenceQueryPort,
} from "../src/metadata/ports.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import { METADATA_SEGMENT_ITEMS } from "../src/storage/sqlite/worker.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

const uuid = (kind: number, n: number) =>
  `c0400000-${String(kind).padStart(4, "0")}-4000-8000-${String(n).padStart(12, "0")}`;
const doi = (n: number) => `10.5555/intake-segments-${n}`;
function observation(n: number, revision = 0) {
  return parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: uuid(1, n * 10 + revision),
    provenance: {
      provenance_id: uuid(2, n * 10 + revision),
      source_kind: "metadata-provider",
      source_name: "fixture",
      source_record_id: String(n),
      observed_at: "2026-11-22T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      ...EMPTY_METADATA,
      title: `Synthetic study ${n}`,
      volume: revision ? "Supplement" : null,
      identifiers: [{ namespace: "doi", value: doi(n) }],
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

function groupedCitationItem(
  anchor: ProviderLiteratureKey,
  works: readonly number[],
): NeutralMetadataItem {
  const hash = createHash("sha256").update(JSON.stringify(works)).digest("hex");
  const observations = works.map((work) => {
    const observationValue = observation(work);
    return parseMetadataObservation({
      ...observationValue,
      observation_id: randomUUID(),
      provenance: {
        ...observationValue.provenance,
        provenance_id: randomUUID(),
        input_sha256: hash,
      },
    });
  });
  return {
    observations,
    relations: observations.map((o) => ({
      observation_id: randomUUID(),
      provenance: o.provenance,
      citing: anchor,
      cited: {
        record_id: o.provenance.source_record_id,
        identifiers: o.metadata.identifiers,
      },
    })),
  };
}

type Row = readonly [work: number, revision?: number];
function source(
  graph: ReadonlyMap<number, readonly Row[]>,
  pageSize: number,
  calls: number[] = [],
): ReferenceQueryPort {
  return {
    provider_name: "fixture",
    open_reference_query(context) {
      const anchor = context.keys[0]!;
      const seed = Number(anchor.record_id);
      calls.push(seed);
      const rows = graph.get(seed) ?? [];
      let next = 0;
      return {
        pull_raw_item() {
          if (next === rows.length) return null;
          return {
            raw_item: next++,
            source_exhausted_after: next === rows.length,
            buffered_next: next < rows.length && next % pageSize !== 0,
          };
        },
        convert_raw_item(index) {
          const [work, revision] = rows[Number(index)]!;
          const o = observation(work, revision);
          const related = {
            record_id: String(work),
            identifiers: o.metadata.identifiers,
          };
          const incoming = context.direction === "cited-by";
          return {
            observations: [o],
            relations: [
              {
                observation_id: uuid(3, seed * 10000 + Number(index) + 1),
                provenance: o.provenance,
                citing: incoming ? related : anchor,
                cited: incoming ? anchor : related,
              },
            ],
          };
        },
      };
    },
  };
}
const options = (port: ReferenceQueryPort) => ({
  metadata: { reference_query_ports: [port], lookup_ports: [] },
  indexRefreshIntervalMs: null,
  browserHost: () => null,
});
async function fixture(port: ReferenceQueryPort) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-segments-"));
  const app = await createApplication(home, options(port));
  return {
    home,
    app,
    async close() {
      try {
        await app.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}
async function add(app: Application, n: number) {
  const result = await app.identity.observe(observation(n));
  if (result.disposition !== "accepted") throw new Error(result.reason);
  return result.literature_id;
}
async function run(
  app: Application,
  seeds: string[],
  key: string,
  signal?: AbortSignal,
  scanLimit: number | null = null,
  maxDepth = 1,
  direction: "references" | "cited-by" = "references",
) {
  const result = await withActivity({ actor: "cli:intake-segments" }, () =>
    runMetadataTask(
      app,
      {
        kind: "citation",
        seed_literature_ids: seeds,
        direction,
        max_depth: maxDepth,
        result_limit: null,
        providers: [{ source: "fixture", scan_limit: scanLimit }],
      },
      signal,
      key,
    ),
  );
  return result as typeof result & {
    discovery_run_id: string;
    intake_batch_id: string;
    result_count: number;
  };
}
function inspect<T>(home: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(home, "catalog.sqlite"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function checkpoints(home: string, jobId: string) {
  return inspect(home, (db) =>
    db
      .prepare(
        "SELECT payload_json FROM execution_events WHERE job_id=? AND kind='citation-write-checkpoint' ORDER BY sequence",
      )
      .all(jobId)
      .map((row) => JSON.parse(String(row.payload_json)) as CitationCheckpoint),
  );
}

function snapshot(home: string, runId: string, batchId: string) {
  return inspect(home, (db) => {
    const aliases = new Map<string, string>([
      [runId, "run"],
      [batchId, "batch"],
    ]);
    for (const row of db
      .prepare(
        "SELECT l.literature_id,m.meta_literature_id,i.value FROM literatures l JOIN literature_metadata_identifiers i USING(literature_id) JOIN meta_literatures m USING(meta_literature_id) WHERE i.namespace='doi'",
      )
      .all()) {
      aliases.set(String(row.literature_id), `paper:${row.value}`);
      aliases.set(String(row.meta_literature_id), `work:${row.value}`);
    }
    for (const edge of db.prepare("SELECT * FROM literature_references").all())
      aliases.set(
        String(edge.reference_id),
        `edge:${aliases.get(String(edge.source_literature_id))}:${aliases.get(String(edge.target_literature_id))}`,
      );
    const execution = db
      .prepare(
        "SELECT kind,payload_json,created_at FROM execution_events WHERE kind IN('metadata-source','processing-result') ORDER BY sequence",
      )
      .all();
    for (const row of execution) {
      const value = JSON.parse(String(row.payload_json));
      if (value.progress?.phase === "started")
        aliases.set(value.progress.record_id, `record:${aliases.size}`);
    }
    // Randomly generated IDs are compared by their owners. Wall-clock stamps
    // and physical execution sequence numbers vary with segment boundaries.
    const normalize = (value: unknown, field = ""): unknown => {
      if (typeof value === "string") {
        if (["at", "created_at", "started_at", "finished_at"].includes(field))
          return "<clock>";
        if (field.endsWith("_json")) return normalize(JSON.parse(value));
        return aliases.get(value) ?? value;
      }
      if (Array.isArray(value)) return value.map((item) => normalize(item));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            normalize(item, key),
          ]),
        );
      return value;
    };
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND (name='literatures' OR name='meta_literatures' OR name='provenances' OR name GLOB 'literature_metadata*' OR name GLOB 'metadata_observation*' OR name GLOB 'provider_relation*' OR name='literature_references' OR name GLOB 'discovery_*' OR name GLOB 'citation_discovery_*' OR name GLOB 'intake_batch*' OR name IN ('literature_search_fts','library_literature_states','library_count_contributions','library_count_totals','library_ordered_members','library_discovery_invalid','library_discovery_replaced'))",
      )
      .all()
      .map((row) => String(row.name));
    return {
      tables: Object.fromEntries(
        names.map((name) => [
          name,
          db
            .prepare(`SELECT * FROM "${name}"`)
            .all()
            .map((row) => JSON.stringify(normalize(row)))
            .sort(),
        ]),
      ),
      events: execution.map((row) => normalize(row)),
    };
  });
}

it("preserves fields and visible event order for new intake, match, enrichment and replay", async () => {
  const graph = new Map<number, readonly Row[]>([[0, [[1], [2, 1], [3], [1]]]]);
  async function take(pageSize: number, publishOnce = false) {
    const f = await fixture(source(graph, pageSize));
    try {
      while ((await f.app.database.refreshLibraryState()).more) {
        // Finish the small fixture's backfill before comparing stored rows.
      }
      const seed = await add(f.app, 0);
      await add(f.app, 2);
      await add(f.app, 3);
      if (publishOnce) {
        // Use the original one-transaction publication for the same inputs.
        // All writes to the book, relation, and batch tables still go through Entry.
        const db = f.app.database;
        const start = vi.spyOn(db, "startCitationDiscovery");
        const finish = db.finishCitationDiscovery.bind(db);
        const causes: CitationCause[] = [];
        vi.spyOn(db, "appendCitationCause").mockImplementation(
          async (_id, cause) => {
            causes.push(cause);
          },
        );
        vi.spyOn(db, "finishCitationDiscovery").mockImplementation(
          async (id, status, sources) => {
            const header = start.mock.calls[0]![0];
            await finish(id, status, sources);
            await db.putDiscovery({
              ...header,
              run: { ...header.run, status },
              source_results: sources,
              results: [
                ...new Set(causes.map((cause) => cause.meta_literature_id)),
              ].map((meta_literature_id) => ({ meta_literature_id })),
              topic_causes: [],
              citation_causes: causes,
            });
          },
        );
      }
      const result = await run(f.app, [seed], "parity");
      expect(result.result_count).toBe(3);
      const stored = snapshot(
        f.home,
        result.discovery_run_id,
        result.intake_batch_id,
      );
      expect(stored.tables.library_literature_states).toHaveLength(4);
      expect(stored.tables.library_count_contributions).not.toHaveLength(0);
      expect(stored.tables.library_ordered_members).not.toHaveLength(0);
      return stored;
    } finally {
      await f.close();
    }
  }
  const legacy = await take(64, true);
  expect(await take(64)).toEqual(legacy);
  expect(await take(1)).toEqual(legacy);
});

it("exposes the running batch and only the results committed with its checkpoints", async () => {
  const f = await fixture(source(new Map([[0, [[1], [2]]]]), 1));
  try {
    const seed = await add(f.app, 0);
    const write = f.app.database.writeMetadataSegment.bind(f.app.database);
    let firstCommit!: (checkpoint: CitationCheckpoint) => void;
    const committed = new Promise<CitationCheckpoint>((resolve) => {
      firstCommit = resolve;
    });
    let continueTask!: () => void;
    const resume = new Promise<void>((resolve) => {
      continueTask = resolve;
    });
    let paused = false;
    const check = vi
      .spyOn(f.app.database, "writeMetadataSegment")
      .mockImplementation(async (body, signal) => {
        const value = await write(body, signal);
        if (
          paused ||
          !value ||
          typeof value !== "object" ||
          !("causes" in value)
        )
          return value;
        const checkpoint = parseCitationCheckpoint(value);
        if (checkpoint.causes.length === 0) return value;
        paused = true;
        firstCommit(checkpoint);
        await resume;
        return value;
      });
    const running = run(f.app, [seed], "visible-publication");
    try {
      const checkpoint = await Promise.race([
        committed,
        running.then(() => {
          throw new Error("Task finished before the first publication");
        }),
      ]);
      expect(checkpoint.results_published).toBe(true);
      const job = await processingJobId("visible-publication");
      expect(checkpoints(f.home, job).at(-1)).toMatchObject(checkpoint);
      expect(
        await f.app.database.getDiscovery(checkpoint.run_id),
      ).toMatchObject({
        run: { status: "RUNNING" },
        citation_causes: checkpoint.causes,
        results: [
          { meta_literature_id: checkpoint.causes[0]!.meta_literature_id },
        ],
        source_results: [],
      });
      const page = await f.app.library.search({
        query: { discovery_run_ids: [checkpoint.run_id] },
      });
      expect(page.items.map((item) => item.literature.literature_id)).toEqual(
        checkpoint.causes.map((cause) => cause.actual_literature_id),
      );
      expect(page.items[0]?.discovery_origin).toEqual({
        kind: "citation",
        intake_batch_id: checkpoint.batch_id,
      });
      const cli = await runCli(
        ["library", "batches", "--request", "-", "--json"],
        {
          home: f.home,
          stdout: () => {},
          stdin: (async function* () {
            yield Buffer.from(
              JSON.stringify({ operation: "list", request: {} }),
            );
          })(),
        },
      );
      expect(cli).toMatchObject({
        code: 0,
        value: {
          protocol_version: 1,
          result: {
            items: [
              {
                batch_id: checkpoint.batch_id,
                discovery_run_id: checkpoint.run_id,
                state: "running",
                counts: { hits: 1 },
              },
            ],
          },
        },
      });
      continueTask();
      const done = await running;
      expect(done.discovery_run_id).toBe(checkpoint.run_id);
      expect(done.result_count).toBe(2);
    } finally {
      continueTask();
      check.mockRestore();
      await Promise.allSettled([running]);
    }
  } finally {
    await f.close();
  }
});

it("bounds the publication segments even for a single item with many causes", async () => {
  const size = METADATA_SEGMENT_ITEMS * 2 + 3;
  const works = Array.from({ length: size }, (_, n) => n + 1);
  const f = await fixture({
    provider_name: "fixture",
    open_reference_query({ keys: [anchor] }) {
      let pulled = false;
      return {
        pull_raw_item() {
          if (pulled) return null;
          pulled = true;
          return { raw_item: {}, source_exhausted_after: true };
        },
        convert_raw_item: () => groupedCitationItem(anchor!, works),
      };
    },
  });
  try {
    const seed = await add(f.app, 0);
    const result = await run(f.app, [seed], "large-provider-item");
    const sizes = checkpoints(f.home, result.job_id)
      .filter((row) => row.causes.length > 0)
      .map((row) => row.causes.length);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(METADATA_SEGMENT_ITEMS);
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(size);
    expect(result.result_count).toBe(size);
  } finally {
    await f.close();
  }
}, 60_000);

it("rolls back the segment on a write failure and retries from its first item", async () => {
  const f = await fixture(source(new Map([[0, [[1], [2], [3]]]]), 64));
  try {
    const seed = await add(f.app, 0);
    const observe = f.app.identity.observe.bind(f.app.identity);
    const fault = vi
      .spyOn(f.app.identity, "observe")
      .mockImplementation(async (value, given) => {
        const result = await observe(value, given);
        if (
          (value as { observation_id: string }).observation_id ===
          observation(2).observation_id
        )
          throw new Error("injected failure after identity write");
        return result;
      });
    try {
      await expect(run(f.app, [seed], "rollback")).rejects.toThrow();
    } finally {
      fault.mockRestore();
    }
    expect((await f.app.database.snapshotCounts()).tables).toMatchObject({
      literatures: 1,
      provider_relation_observations: 0,
      literature_references: 0,
    });
    const jobId = await processingJobId("rollback");
    expect(checkpoints(f.home, jobId).flatMap((item) => item.causes)).toEqual(
      [],
    );
    await f.app.processingTasks!.control(jobId, "retry");
    const result = await run(f.app, [seed], "rollback");
    expect(result.result_count).toBe(3);
    expect(
      (await f.app.database.getDiscovery(result.discovery_run_id))
        ?.citation_causes,
    ).toHaveLength(3);
    expect(
      (await f.app.database.referenceSnapshot()).map(
        (row) => row.supports.length,
      ),
    ).toEqual([1, 1, 1]);
    const clean = await fixture(source(new Map([[0, [[1], [2], [3]]]]), 64));
    try {
      const expected = await run(clean.app, [await add(clean.app, 0)], "clean");
      expect(
        snapshot(f.home, result.discovery_run_id, result.intake_batch_id)
          .tables,
      ).toEqual(
        snapshot(
          clean.home,
          expected.discovery_run_id,
          expected.intake_batch_id,
        ).tables,
      );
    } finally {
      await clean.close();
    }
  } finally {
    await f.close();
  }
});

it("rolls back catalog rows when writing the checked event fails at commit", async () => {
  const f = await fixture(source(new Map([[0, [[1], [2]]]]), 64));
  try {
    const seed = await add(f.app, 0);
    const append = f.app.database.appendMetadataEvent.bind(f.app.database);
    const fault = vi
      .spyOn(f.app.database, "appendMetadataEvent")
      .mockImplementation(async (event) => {
        await append(event);
        if (
          event.kind === "citation-write-checkpoint" &&
          (event.payload as { checked: boolean }).checked
        )
          await append(event);
      });
    try {
      await expect(run(f.app, [seed], "checked-failure")).rejects.toThrow();
    } finally {
      fault.mockRestore();
    }
    const id = await processingJobId("checked-failure");
    expect(
      checkpoints(f.home, id).filter((row) => row.source_id === seed),
    ).toEqual([]);
    expect((await f.app.database.snapshotCounts()).tables).toMatchObject({
      literatures: 1,
      provider_relation_observations: 0,
      literature_references: 0,
    });
    await f.app.processingTasks!.control(id, "retry");
    const result = await run(f.app, [seed], "checked-failure");
    expect(result.result_count).toBe(2);
    expect(checkpoints(f.home, id).some((row) => row.checked)).toBe(true);
    await f.app.database.withExecutionRuntime(async () => {
      const repo = new ExecutionRepository(f.app.database);
      expect(
        (await repo.listEvents(id)).some(
          (event) => event.kind === "citation-write-checkpoint",
        ),
      ).toBe(false);
      const detail = await repo.taskDetailEvents(id, true);
      expect(detail.status).toBe("ok");
      if (detail.status === "ok")
        expect(
          detail.detail.technical.some(
            (event) => event.kind === "citation-write-checkpoint",
          ),
        ).toBe(false);
    });
  } finally {
    await f.close();
  }
});

it("records a withdrawn citation target as restored when it reenters intake", async () => {
  const f = await fixture(source(new Map([[0, [[1]]]]), 64));
  try {
    const seed = await add(f.app, 0);
    const prior = await startIntake(
      f.app.database,
      "topic",
      "Previous intake",
      {},
      "cli",
    );
    const picked = await f.app.identity.observe(observation(1), {
      intake_batch_id: prior,
    });
    if (picked.disposition !== "accepted") throw new Error(picked.reason);
    await finishIntake(f.app.database, prior, "completed");
    await new IntakeWithdrawalService(f.app.database).withdraw(prior);
    expect(await f.app.database.getLiterature(picked.literature_id)).toBeNull();
    const result = await run(f.app, [seed], "restore");
    expect(result.result_count).toBe(1);
    expect(
      await f.app.database.getLiterature(picked.literature_id),
    ).not.toBeNull();
    expect(
      inspect(f.home, (db) =>
        db
          .prepare(
            "SELECT literature_id,disposition FROM intake_batch_members WHERE batch_id=?",
          )
          .all(result.intake_batch_id),
      ),
    ).toEqual([
      { literature_id: picked.literature_id, disposition: "restored" },
    ]);
  } finally {
    await f.close();
  }
});

it.each(["segmented", "legacy without publication"])(
  "reopens a %s run and repeats only the unfinished source",
  async (publication) => {
    const calls: number[] = [];
    const port = source(
      new Map([
        [0, [[1]]],
        [9, [[2], [3], [4], [5]]],
      ]),
      2,
      calls,
    );
    const f = await fixture(port);
    let reopened: Application | undefined;
    try {
      const a = await add(f.app, 0);
      const b = await add(f.app, 9);
      const abort = new AbortController();
      const observe = f.app.identity.observe.bind(f.app.identity);
      const fault = vi
        .spyOn(f.app.identity, "observe")
        .mockImplementation(async (value, given) => {
          const result = await observe(value, given);
          if (
            (value as { observation_id: string }).observation_id ===
            observation(4).observation_id
          )
            abort.abort();
          return result;
        });
      try {
        await expect(
          run(f.app, [a, b], "resume", abort.signal),
        ).rejects.toThrow();
      } finally {
        fault.mockRestore();
      }
      const job = await processingJobId("resume");
      const prior = checkpoints(f.home, job);
      const prefix = prior.flatMap((row) => row.causes);
      const { run_id, batch_id } = prior[0]!;
      expect(
        prior.filter((item) => item.checked).map((item) => item.source_id),
      ).toEqual([a]);
      expect(
        prior
          .filter((item) => item.source_id === b)
          .flatMap((item) => item.causes),
      ).toHaveLength(2);
      await f.app.close();
      if (publication === "legacy without publication") {
        // The old code could commit this prefix and finish the batch on error
        // before inserting any DiscoveryRun or publication rows.
        const db = new DatabaseSync(join(f.home, "catalog.sqlite"));
        try {
          db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
          db.prepare(
            "UPDATE intake_batches SET discovery_run_id=NULL WHERE batch_id=?",
          ).run(batch_id);
          for (const table of [
            "citation_discovery_causes",
            "discovery_results",
            "discovery_source_results",
            "discovery_run_providers",
            "citation_discovery_seeds",
            "citation_discovery_inputs",
            "discovery_runs",
          ])
            db.prepare(`DELETE FROM ${table} WHERE discovery_run_id=?`).run(
              run_id,
            );
          db.prepare(
            `UPDATE execution_events SET payload_json=json_remove(payload_json,'$.results_published')
          WHERE job_id=? AND kind='citation-write-checkpoint'`,
          ).run(job);
          db.exec("COMMIT");
        } finally {
          db.close();
        }
      }
      reopened = await createApplication(f.home, options(port));
      await reopened.processingTasks!.control(job, "resume");
      const result = await run(reopened, [a, b], "resume");
      expect(calls).toEqual([0, 9, 9]);
      expect(result).toMatchObject({
        discovery_run_id: run_id,
        intake_batch_id: batch_id,
      });
      expect(result.result_count).toBe(5);
      const saved = await reopened.database.getDiscovery(run_id);
      expect(saved?.results).toHaveLength(5);
      expect(saved?.citation_causes).toHaveLength(5);
      expect(saved?.citation_causes).toEqual(expect.arrayContaining(prefix));
      expect(
        (await reopened.database.referenceSnapshot()).map(
          (row) => row.supports.length,
        ),
      ).toEqual([1, 1, 1, 1, 1]);
      expect(
        checkpoints(f.home, job)
          .filter((item) => item.checked)
          .map((item) => item.source_id),
      ).toEqual([a, b]);
    } finally {
      await reopened?.close();
      await f.close();
    }
  },
);

const layeredGraph = new Map<number, readonly Row[]>([
  [0, [[1], [2], [2]]],
  [9, [[2], [3]]],
  [1, [[4]]],
  [2, [[4], [5], [6]]],
  [3, [[1], [7]]],
]);
const layeredOrder = [0, 9, 1, 2, 3];

function interruptAfterCommit(
  app: Application,
  sourceId: string,
  checked: boolean,
  stop: () => void,
  saveCheckpoints = true,
) {
  let interrupt = false;
  let stopped = false;
  const append = app.database.appendMetadataEvent.bind(app.database);
  const write = app.database.writeMetadataSegment.bind(app.database);
  const events = vi
    .spyOn(app.database, "appendMetadataEvent")
    .mockImplementation(async (event) => {
      if (event.kind === "citation-write-checkpoint") {
        const checkpoint = event.payload as {
          source_id: string | null;
          checked: boolean;
          causes: unknown[];
        };
        if (
          !stopped &&
          checkpoint.source_id === sourceId &&
          checkpoint.checked === checked &&
          (checked || checkpoint.causes.length > 0)
        )
          interrupt = true;
        if (!saveCheckpoints) return;
      }
      await append(event);
    });
  const segments = vi
    .spyOn(app.database, "writeMetadataSegment")
    .mockImplementation((segment, signal) =>
      write(segment, signal).then((result) => {
        if (interrupt) {
          interrupt = false;
          stopped = true;
          stop();
        }
        return result;
      }),
    );
  return () => {
    events.mockRestore();
    segments.mockRestore();
  };
}

it.each([
  {
    point: "midway through a paper",
    checked: false,
    anchor: 1,
    callsBefore: [0, 9],
    callsAfter: [9, 1, 2, 3],
  },
  {
    point: "after the checked commit",
    checked: true,
    anchor: 0,
    callsBefore: [0],
    callsAfter: [9, 1, 2, 3],
  },
  {
    point: "at the layer boundary",
    checked: true,
    anchor: 1,
    callsBefore: [0, 9],
    callsAfter: [1, 2, 3],
  },
])(
  "preserves breadth-first results when interrupted $point",
  async ({ checked, anchor, callsBefore, callsAfter }) => {
    const completeCalls: number[] = [];
    const complete = await fixture(source(layeredGraph, 1, completeCalls));
    const resumedCalls: number[] = [];
    const port = source(layeredGraph, 1, resumedCalls);
    const interrupted = await fixture(port);
    let reopened: Application | undefined;
    try {
      const reference = await run(
        complete.app,
        [await add(complete.app, 0), await add(complete.app, 9)],
        "whole-traversal",
        undefined,
        null,
        2,
      );
      expect(completeCalls).toEqual(layeredOrder);
      const expected = snapshot(
        complete.home,
        reference.discovery_run_id,
        reference.intake_batch_id,
      );
      const seeds = [
        await add(interrupted.app, 0),
        await add(interrupted.app, 9),
      ];
      const stop = new AbortController();
      const restore = interruptAfterCommit(
        interrupted.app,
        seeds[anchor]!,
        checked,
        () => {
          if (checked)
            throw new Error(
              "synthetic interruption immediately after the catalog commit",
            );
          stop.abort();
        },
      );
      try {
        await expect(
          run(interrupted.app, seeds, "resume-layers", stop.signal, null, 2),
        ).rejects.toThrow();
      } finally {
        restore();
      }
      expect(resumedCalls).toEqual(callsBefore);
      const job = await processingJobId("resume-layers");
      const prior = checkpoints(interrupted.home, job).at(-1);
      expect(prior).toMatchObject({ source_id: seeds[anchor], checked });
      await interrupted.app.close();
      reopened = await createApplication(interrupted.home, options(port));
      await reopened.processingTasks!.control(
        job,
        checked ? "retry" : "resume",
      );
      const resumed = await run(
        reopened,
        seeds,
        "resume-layers",
        undefined,
        null,
        2,
      );
      expect(resumedCalls).toEqual([...callsBefore, ...callsAfter]);
      expect(resumed.result_count).toBe(reference.result_count);
      const actual = snapshot(
        interrupted.home,
        resumed.discovery_run_id,
        resumed.intake_batch_id,
      );
      expect(actual.tables).toEqual(expected.tables);
      const completedSources = checkpoints(interrupted.home, job).filter(
        (row) => row.checked,
      );
      expect(completedSources).toHaveLength(layeredOrder.length);
      expect(new Set(completedSources.map((row) => row.source_id)).size).toBe(
        layeredOrder.length,
      );
      const unaffectedProgress = (snap: typeof expected) =>
        snap.events.flatMap((row) => {
          const event = row as {
            kind: string;
            payload_json: { progress?: { unit_id: string; record_id: string } };
          };
          const progress = event.payload_json.progress;
          if (!progress || (!checked && progress.unit_id === `paper:${doi(9)}`))
            return [];
          const { record_id, ...facts } = progress;
          void record_id;
          return [facts];
        });
      expect(unaffectedProgress(actual)).toEqual(unaffectedProgress(expected));
    } finally {
      await reopened?.close();
      await interrupted.close();
      await complete.close();
    }
  },
  60_000,
);

it("restarts a pre-checkpoint two-layer task from its seeds without duplicating admitted facts", async () => {
  const calls: number[] = [];
  const port = source(layeredGraph, 1, calls);
  const f = await fixture(port);
  let reopened: Application | undefined;
  try {
    const seeds = [await add(f.app, 0), await add(f.app, 9)];
    const stop = new AbortController();
    // The old writer committed facts and visible progress without checkpoint events.
    const restore = interruptAfterCommit(
      f.app,
      seeds[0]!,
      true,
      () => stop.abort(),
      false,
    );
    try {
      await expect(
        run(f.app, seeds, "old-resume", stop.signal, null, 2, "cited-by"),
      ).rejects.toThrow();
    } finally {
      restore();
    }
    const job = await processingJobId("old-resume");
    expect(calls).toEqual([0]);
    expect(checkpoints(f.home, job)).toEqual([]);
    const old = inspect(f.home, (db) =>
      db.prepare("SELECT discovery_run_id,status FROM discovery_runs").get(),
    );
    expect(old?.status).toBe("INTERRUPTED");
    await f.app.close();
    reopened = await createApplication(f.home, options(port));
    await reopened.processingTasks!.control(job, "resume");
    const resumed = await run(
      reopened,
      seeds,
      "old-resume",
      undefined,
      null,
      2,
      "cited-by",
    );
    expect(calls).toEqual([0, ...layeredOrder]);
    expect(resumed.discovery_run_id).not.toBe(old?.discovery_run_id);
    expect(
      await reopened.database.getDiscovery(String(old?.discovery_run_id)),
    ).toMatchObject({ run: { status: "INTERRUPTED" } });
    expect(resumed.result_count).toBe(7);
    expect((await reopened.database.snapshotCounts()).tables).toMatchObject({
      literatures: 9,
      literature_references: 10,
    });
    const edges = await reopened.database.referenceSnapshot();
    expect(edges).toHaveLength(
      new Set(
        edges.map(
          ({ reference }) =>
            `${reference.source_literature_id}/${reference.target_literature_id}`,
        ),
      ).size,
    );
    expect(checkpoints(f.home, job).filter((row) => row.checked)).toHaveLength(
      layeredOrder.length,
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
}, 60_000);

it("preserves committed results when settlement fails and retries without another provider query", async () => {
  const calls: number[] = [];
  const f = await fixture(source(new Map([[0, [[1], [2]]]]), 1, calls));
  try {
    const seed = await add(f.app, 0);
    const finish = f.app.database.finishCitationDiscovery.bind(f.app.database);
    const fault = vi
      .spyOn(f.app.database, "finishCitationDiscovery")
      .mockImplementation((id, status, sources) =>
        finish(
          id,
          status,
          status === "COMPLETED"
            ? sources.map((outcome) => ({
                ...outcome,
                provider_name: "not-in-run",
              }))
            : sources,
        ),
      );
    try {
      await expect(run(f.app, [seed], "publication-fault")).rejects.toThrow();
    } finally {
      fault.mockRestore();
    }
    expect((await f.app.database.snapshotCounts()).tables).toMatchObject({
      discovery_runs: 1,
      literatures: 3,
      literature_references: 2,
    });
    const job = await processingJobId("publication-fault");
    const saved = checkpoints(f.home, job);
    expect(saved.filter((row) => row.checked)).toHaveLength(1);
    const { run_id } = saved[0]!;
    expect(await f.app.database.getDiscovery(run_id)).toMatchObject({
      run: { status: "INTERRUPTED" },
      citation_causes: [expect.anything(), expect.anything()],
      source_results: [],
    });
    await f.app.processingTasks!.control(job, "retry");
    const result = await run(f.app, [seed], "publication-fault");
    expect(calls).toEqual([0]);
    expect(result.result_count).toBe(2);
    expect(
      await f.app.database.getDiscovery(result.discovery_run_id),
    ).toMatchObject({
      run: { status: "COMPLETED" },
      citation_causes: [expect.anything(), expect.anything()],
    });
  } finally {
    await f.close();
  }
});

it("rolls an invalid cause back with the relation and checkpoint in its segment", async () => {
  const f = await fixture(source(new Map([[0, [[1]]]]), 1));
  try {
    const seed = await add(f.app, 0);
    const append = f.app.database.appendCitationCause.bind(f.app.database);
    const fault = vi
      .spyOn(f.app.database, "appendCitationCause")
      .mockImplementation((id, cause) =>
        append(id, { ...cause, meta_literature_id: uuid(9, 10) }),
      );
    try {
      await expect(run(f.app, [seed], "invalid-cause")).rejects.toThrow();
    } finally {
      fault.mockRestore();
    }
    const job = await processingJobId("invalid-cause");
    const checkpointsWritten = checkpoints(f.home, job);
    expect(
      checkpointsWritten.flatMap((checkpoint) => checkpoint.causes),
    ).toEqual([]);
    expect((await f.app.database.snapshotCounts()).tables).toMatchObject({
      literatures: 1,
      literature_references: 0,
    });
    expect(
      await f.app.database.getDiscovery(checkpointsWritten[0]!.run_id),
    ).toMatchObject({
      run: { status: "INTERRUPTED" },
      results: [],
      citation_causes: [],
    });
  } finally {
    await f.close();
  }
});

it("puts the checked marker only in the last segment of a single provider page", async () => {
  const f = await fixture(source(new Map([[0, [[1], [2], [3]]]]), 64));
  try {
    const seed = await add(f.app, 0);
    const segment = f.app.database.writeMetadataSegment.bind(f.app.database);
    const cut = vi
      .spyOn(f.app.database, "writeMetadataSegment")
      .mockImplementation((write, signal) =>
        segment(() => write(() => true), signal),
      );
    try {
      const result = await run(f.app, [seed], "split");
      expect(
        checkpoints(f.home, result.job_id)
          .filter((row) => row.source_id === seed)
          .map((row) => [row.raw_items.length, row.causes.length, row.checked]),
      ).toEqual([
        [1, 1, false],
        [1, 1, false],
        [1, 1, true],
      ]);
    } finally {
      cut.mockRestore();
    }
  } finally {
    await f.close();
  }
});

it("resumes a split provider item with the original observation identities", async () => {
  const seen: NeutralMetadataItem[] = [];
  const f = await fixture({
    provider_name: "fixture",
    open_reference_query({ keys: [anchor] }) {
      expect(anchor?.record_id).toBe("0");
      let pulled = false;
      return {
        pull_raw_item() {
          if (pulled) return null;
          pulled = true;
          return { raw_item: {}, source_exhausted_after: true };
        },
        convert_raw_item() {
          const item = groupedCitationItem(anchor!, [1, 2, 3]);
          seen.push(item);
          return item;
        },
      };
    },
  });
  try {
    const seed = await add(f.app, 0);
    const segment = f.app.database.writeMetadataSegment.bind(f.app.database);
    const cut = vi
      .spyOn(f.app.database, "writeMetadataSegment")
      .mockImplementation((write, signal) =>
        segment(() => write(() => true), signal),
      );
    try {
      const abort = new AbortController();
      const observe = f.app.identity.observe.bind(f.app.identity);
      const interruption = vi
        .spyOn(f.app.identity, "observe")
        .mockImplementation(async (o, options) => {
          const decision = await observe(o, options);
          if (
            (o as { provenance: { source_record_id: string } }).provenance
              .source_record_id === "2"
          )
            abort.abort();
          return decision;
        });
      try {
        await expect(
          run(f.app, [seed], "split-item", abort.signal),
        ).rejects.toThrow();
      } finally {
        interruption.mockRestore();
      }
      const job = await processingJobId("split-item");
      const before = checkpoints(f.home, job).filter(
        (row) => row.source_id === seed,
      );
      expect(before.map((row) => [row.causes.length, row.checked])).toEqual([
        [1, false],
      ]);
      await f.app.processingTasks!.control(job, "resume");
      const result = await run(f.app, [seed], "split-item");
      expect(seen).toHaveLength(2);
      expect(result.result_count).toBe(3);
      expect(
        checkpoints(f.home, job)
          .filter((row) => row.source_id === seed)
          .map((row) => [row.causes.length, row.checked]),
      ).toEqual([
        [1, false],
        [1, false],
        [1, true],
      ]);
      expect(
        inspect(f.home, (db) =>
          db
            .prepare(
              "SELECT observation_id FROM provider_relation_observations ORDER BY observation_id",
            )
            .all()
            .map((row) => row.observation_id),
        ),
      ).toEqual(seen[0]!.relations.map((o) => o.observation_id).sort());
    } finally {
      cut.mockRestore();
    }
  } finally {
    await f.close();
  }
});

it("rejects inconsistent saved identities even when the citation item key matches", () => {
  const event = {
    kind: "item" as const,
    failure: null,
    item: groupedCitationItem({ record_id: "0", identifiers: [] }, [1, 2, 3]),
  };
  const saved = pendingCitationItem(event, citationItemKey(event), 1);
  for (const inconsistent of [
    { ...saved, observations: saved.observations.slice(1) },
    { ...saved, relations: saved.relations.slice(1) },
  ])
    expect(() => restoreCitationItem(event, inconsistent)).toThrow(
      "citation checkpoint item lengths do not match its key",
    );
});

it.each([null, 1])(
  "continues when a resumed citation source replaces its partially written response (scan limit %s)",
  async (scanLimit) => {
    const calls: number[] = [];
    const responses = new Map<number, readonly (readonly number[])[]>([
      [0, [[1, 2, 3]]],
      [9, [[6]]],
    ]);
    const f = await fixture({
      provider_name: "fixture",
      open_reference_query({ keys: [anchor] }) {
        const seed = Number(anchor!.record_id);
        calls.push(seed);
        const rows = responses.get(seed)!;
        let next = 0;
        return {
          pull_raw_item() {
            if (next === rows.length) return null;
            return {
              raw_item: rows[next++],
              source_exhausted_after: next === rows.length,
            };
          },
          convert_raw_item: (raw) =>
            groupedCitationItem(anchor!, raw as readonly number[]),
        };
      },
    });
    try {
      const seed = await add(f.app, 0);
      const nextSeed = await add(f.app, 9);
      const segment = f.app.database.writeMetadataSegment.bind(f.app.database);
      const cut = vi
        .spyOn(f.app.database, "writeMetadataSegment")
        .mockImplementation((write, signal) =>
          segment(() => write(() => true), signal),
        );
      const abort = new AbortController();
      const observe = f.app.identity.observe.bind(f.app.identity);
      const interruption = vi
        .spyOn(f.app.identity, "observe")
        .mockImplementation(async (value, given) => {
          const decision = await observe(value, given);
          if (
            (value as { provenance: { source_record_id: string } }).provenance
              .source_record_id === "3"
          )
            abort.abort();
          return decision;
        });
      try {
        await expect(
          run(
            f.app,
            [seed, nextSeed],
            "changed-response",
            abort.signal,
            scanLimit,
          ),
        ).rejects.toThrow();
      } finally {
        interruption.mockRestore();
        cut.mockRestore();
      }
      const job = await processingJobId("changed-response");
      const before = await f.app.database.referenceSnapshot();
      expect(before).toHaveLength(2);
      expect(checkpoints(f.home, job).some((row) => row.checked)).toBe(false);

      responses.set(0, [[2, 4], [5]]);
      await f.app.processingTasks!.control(job, "resume");
      const result = await run(
        f.app,
        [seed, nextSeed],
        "changed-response",
        undefined,
        scanLimit,
      );
      const unrestricted = scanLimit === null;
      const expectedReferences = [
        { source_id: seed, doi: doi(1), supports: 1 },
        { source_id: seed, doi: doi(2), supports: unrestricted ? 2 : 1 },
      ];
      if (unrestricted)
        expectedReferences.push(
          { source_id: seed, doi: doi(4), supports: 1 },
          { source_id: seed, doi: doi(5), supports: 1 },
          { source_id: nextSeed, doi: doi(6), supports: 1 },
        );
      expect(result).toMatchObject({
        status: "COMPLETED",
        result_count: expectedReferences.length,
        source_results: [
          { outcome: unrestricted ? "EXHAUSTED" : "SCAN_LIMIT_REACHED" },
        ],
      });
      expect(calls).toEqual(unrestricted ? [0, 0, 9] : [0, 0]);
      const references = await f.app.database.referenceSnapshot();
      expect(references).toHaveLength(expectedReferences.length);
      expect(references.map(({ reference }) => reference)).toEqual(
        expect.arrayContaining(before.map(({ reference }) => reference)),
      );
      expect(
        inspect(f.home, (db) =>
          db
            .prepare(
              `
      SELECT r.source_literature_id AS source_id, i.value AS doi, count(s.observation_id) AS supports
      FROM literature_references r
      JOIN literature_metadata_identifiers i ON i.literature_id=r.target_literature_id AND i.namespace='doi'
      JOIN provider_relation_reference_supports s USING(reference_id)
      GROUP BY r.reference_id ORDER BY i.value
    `,
            )
            .all(),
        ),
      ).toEqual(expectedReferences);
      const task = await createTaskReader(
        new ExecutionRepository(f.app.database),
      ).read(job);
      expect(task.job.status).toBe("completed");
      expect(
        task.events.filter(
          (event) => event.kind === "citation-response-replaced",
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            literature_id: seed,
            provider_name: "fixture",
            committed_relations: 2,
          }),
        }),
      ]);
      expect(
        checkpoints(f.home, job)
          .filter((row) => row.checked)
          .map((row) => row.source_id),
      ).toEqual([seed, nextSeed]);
    } finally {
      await f.close();
    }
  },
);

it("admits a workbench folder write between active citation segments", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-workbench-"));
  let server: Awaited<ReturnType<typeof startProductionWorkbench>> | undefined;
  try {
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    await writeFile(
      join(home, ".sciretriever", "config.toml"),
      `[paths]\ncatalog_path=${JSON.stringify(join(home, "catalog.sqlite"))}\nartifact_root=${JSON.stringify(join(home, "artifacts"))}\n`,
      { mode: 0o600 },
    );
    const rows: Row[] = Array.from({ length: 84 }, (_, n) => [n + 1]);
    server = await startProductionWorkbench({
      home,
      port: 0,
      access: workbenchTestAccess,
      assets: new Map([
        ["/", { contentType: "text/html", body: "<main>Fixture</main>" }],
      ]),
      applicationOptions: options(source(new Map([[0, rows]]), 128)),
    });
    const { origin, application: app } = server;
    const seed = await add(app, 0);
    const auth = await workbenchLogin(origin);
    const index = await fetch(origin, { headers: { Cookie: auth } });
    const cookie =
      auth + "; " + index.headers.get("set-cookie")!.split(";")[0]!;
    const init = await fetch(origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-Workbench-Init": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const grant = (await init.json()) as { client_id: string; csrf: string };
    let trigger!: () => void;
    let processed = 0;
    const foreground = new Promise<void>((resolve) => {
      trigger = resolve;
    }).then(async () => {
      const started = performance.now();
      const response = await fetch(
        origin + "/api/v1/maintenance/folders?client_id=" + grant.client_id,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
            "X-Workbench-Csrf": grant.csrf,
            "X-Sciretriever-Protocol-Version": "1",
          },
          body: JSON.stringify({
            protocol_version: 1,
            request: {
              operation: "create",
              request: { name: "Foreground" },
            },
          }),
        },
      );
      return {
        status: response.status,
        elapsed: performance.now() - started,
        processed,
        body: await response.json(),
      };
    });
    const observe = app.identity.observe.bind(app.identity);
    const slowed = vi
      .spyOn(app.identity, "observe")
      .mockImplementation(async (...args) => {
        if (++processed === 1) trigger();
        await delay(4);
        return observe(...args);
      });
    try {
      const [result, write] = await Promise.all([
        run(app, [seed], "fairness"),
        foreground,
      ]);
      expect(write.status, JSON.stringify(write.body)).toBe(200);
      expect(write.processed).toBeLessThan(rows.length);
      expect(write.elapsed).toBeLessThan(250);
      expect(result.result_count).toBe(rows.length);
      console.info(
        JSON.stringify({
          folder_write_wait_ms: write.elapsed,
          processed_when_written: write.processed,
        }),
      );
    } finally {
      slowed.mockRestore();
      trigger();
      await Promise.allSettled([foreground]);
    }
  } finally {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  }
});
