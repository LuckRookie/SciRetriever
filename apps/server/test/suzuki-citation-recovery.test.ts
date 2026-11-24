import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  parseReference,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { expect, it } from "vitest";
import { MetadataSourceRun } from "../src/application/jobs/metadata-progress.js";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { parseCitationCheckpoint } from "../src/entry/citation-checkpoint.js";
import type { CitationDiscoveryReport } from "../src/entry/discovery.js";
import { runMetadataTask } from "../src/entry/metadata-task.js";
import {
  readSuzukiRecoveryPlan,
  recoverSuzukiCitationCheckpoint,
  writeSuzukiRecoveryPlan,
} from "../src/entry/suzuki-citation-recovery.js";
import { startIntake } from "../src/literature/intake.js";
import { withActivity } from "../src/logging/activity.js";
import {
  MetadataProviderFailure,
  type ReferenceQueryPort,
} from "../src/metadata/ports.js";
import { networkRequestDispatched } from "../src/network/request-activity.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { CatalogWriteAdmission } from "../src/storage/write-admission.js";

const sources = ["openalex", "semantic-scholar"] as const;
type Source = (typeof sources)[number];
const rateLimit = "metadata-provider-rate-limited";
const testTime = Date.parse("2026-11-24T00:00:00Z");
const taskKey = "suzuki-citation-restore-fixture";
const actor = { actor: "cli:suzuki-citation-restore-fixture" };

function workKey(work: number | string) {
  return {
    record_id: String(work),
    identifiers: [
      { namespace: "doi", value: `10.9999/restore-suzuki-${work}` },
    ],
  };
}
function observation(work: number, source: Source) {
  const key = workKey(work);
  return parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: randomUUID(),
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
      source_record_id: key.record_id,
      observed_at: new Date().toISOString(),
      input_sha256: "1".repeat(64),
      parameters_sha256: "2".repeat(64),
    },
    metadata: {
      ...EMPTY_METADATA,
      title: `Fixture ${work}`,
      identifiers: key.identifiers,
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
function item(anchor: ProviderLiteratureKey, work: number, source: Source) {
  const metadata = observation(work, source);
  return {
    observations: [metadata],
    relations: [
      {
        observation_id: randomUUID(),
        provenance: metadata.provenance,
        citing: workKey(work),
        cited: anchor,
      },
    ],
  };
}
function input(seed: string) {
  return {
    kind: "citation",
    seed_literature_ids: [seed],
    max_depth: 2,
    direction: "cited-by",
    result_limit: null,
    providers: sources.map((source) => ({ source, scan_limit: null })),
  } as const;
}
function fixtureSources(legacyRateSeen = false, stop?: AbortController) {
  let attemptedRate = legacyRateSeen;
  let now = testTime;
  const calls: string[] = [];
  const waits: number[] = [];
  const graph: Record<string, number[]> = {
    "openalex:0": [1, 2, 1, 3],
    "openalex:2": [9, 10],
    "openalex:3": [11],
    "semantic-scholar:1": [12],
  };
  const ports: ReferenceQueryPort[] = sources.map((source) => ({
    provider_name: source,
    open_reference_query({ keys: [anchor] }) {
      if (!anchor) throw new Error("fixture: missing anchor");
      const work = anchor.identifiers[0]!.value.split("-").at(-1)!;
      const id = `${source}:${work}`;
      calls.push(id);
      const rows = graph[id] ?? [];
      let offset = 0;
      return {
        pull_raw_item() {
          if (offset === 0) networkRequestDispatched();
          if (source === "semantic-scholar" && !attemptedRate) {
            attemptedRate = true;
            throw new MetadataProviderFailure({
              code: rateLimit,
              reason: "Fixture rate limit",
              action: "Retry",
              retryable: true,
            });
          }
          if (
            id === "openalex:2" &&
            offset === 1 &&
            stop &&
            !stop.signal.aborted
          ) {
            stop.abort();
            return null;
          }
          const row = rows[offset++];
          return row === undefined
            ? null
            : {
                raw_item: row,
                source_exhausted_after: offset === rows.length,
                buffered_next: false,
              };
        },
        convert_raw_item: (row) => item(anchor, Number(row), source),
      };
    },
  }));
  return {
    calls,
    waits,
    options: {
      metadata: { reference_query_ports: ports, lookup_ports: [] },
      indexRefreshIntervalMs: null,
      citationClock: {
        now: () => now,
        async wait(ms: number) {
          waits.push(ms);
          now += ms;
        },
      },
    },
  };
}

async function seed(app: Application) {
  const saved = await app.identity.observe(observation(0, "openalex"));
  if (saved.disposition !== "accepted")
    throw new Error("fixture seed was rejected");
  return saved.literature_id;
}

async function run(app: Application, seedId: string, signal?: AbortSignal) {
  const result = await withActivity(actor, () =>
    runMetadataTask(app, input(seedId), signal, taskKey),
  );
  return result as typeof result & CitationDiscoveryReport;
}

async function writeLegacyPrefix(app: Application, seedId: string) {
  const repo = new ExecutionRepository(app.database);
  const request = input(seedId);
  const job = await app.processingTasks!.submit({
    schema_version: 1,
    idempotency_key: taskKey,
    operations: [{ operation: "acquire-metadata", request }],
  });
  const id = job.job_id;
  const target = `${id}:0`;
  const started = new Date().toISOString();
  const attempt = `attempt-${randomUUID()}`;
  await repo.updateJob(id, "running");
  await repo.updateTarget(target, "literature", "pending");
  await repo.consumeBudget(id, {
    attempts: 1,
    network_bytes: 0,
    model_calls: 0,
  });
  await repo.startAttempt({
    attempt_id: attempt,
    target_id: target,
    stage: "literature",
    status: "running",
    started_at: started,
    finished_at: null,
    failure: null,
    usage: null,
  });
  await repo.appendEvent({
    event_id: randomUUID(),
    job_id: id,
    sequence: -1,
    kind: "attempt-started",
    payload: { target_id: target, attempt_id: attempt },
    created_at: started,
  });
  const journal = new MetadataSourceRun(repo, id, target);
  const batch = await startIntake(
    app.database,
    "citation",
    "Legacy Suzuki fixture",
    {
      seed_literature_id: seedId,
      direction: "cited-by",
      providers: [...sources],
    },
    "cli",
  );
  const children = new Map<number, string>();
  async function reference(
    source: Source,
    anchor: number,
    anchorId: string,
    works: number[],
    result: "hit" | "miss" | "cancelled" | "error",
  ) {
    const progress = await journal.begin(source, "reference-query", anchorId);
    await progress.dispatched();
    for (const work of works) {
      // Old Entry wrote the relation, metadata, reference and included progress
      // separately, retaining discovery causes only in memory before settlement.
      const {
        observations: [metadata],
        relations: [relation],
      } = item(workKey(anchor), work, source);
      await progress.returned(1);
      await app.observations.publishProviderRelation(relation!);
      const saved = await app.identity.observe(metadata!, {
        intake_batch_id: batch,
        intake_exclude_ids: [seedId],
      });
      if (saved.disposition !== "accepted")
        throw new Error("legacy fixture target was rejected");
      const paper = (await app.database.getLiterature(saved.literature_id))!;
      await progress.observed(paper.meta_literature_id, saved.created);
      await app.references.publishWithProviderObservation(
        parseReference({
          reference_id: randomUUID(),
          source_literature_id: saved.literature_id,
          target_literature_id: anchorId,
        }),
        relation!.observation_id,
      );
      await progress.included(paper.meta_literature_id);
      if (anchor === 0) children.set(work, saved.literature_id);
    }
    if (result === "error") await progress.failure(rateLimit);
    else await progress.finish(result);
  }
  await reference("openalex", 0, seedId, [1, 2, 1, 3], "hit");
  await reference("openalex", 1, children.get(1)!, [], "miss");
  await reference("semantic-scholar", 1, children.get(1)!, [], "error");
  await reference("openalex", 2, children.get(2)!, [9], "cancelled");
  expect(await journal.latestCheckpoint()).toBeNull();
  return { id, target, batch };
}

async function projection(
  app: Application,
  id: string,
  runId: string,
  batchId: string,
) {
  const repo = new ExecutionRepository(app.database);
  const latest = await new MetadataSourceRun(
    repo,
    id,
    `${id}:0`,
  ).latestCheckpoint();
  const checkpoint = parseCitationCheckpoint(latest?.payload);
  const db = new DatabaseSync(join(app.home, "catalog.sqlite"), {
    readOnly: true,
  });
  try {
    // Use work titles and stable provenance fields so a new random UUID does
    // not obscure any extra observation or reference support.
    const facts = (sql: string, ...args: string[]) =>
      db
        .prepare(sql)
        .all(...args)
        .map((row) => Object.values(row));
    return {
      results: facts(
        `SELECT m.title FROM discovery_results r JOIN meta_literatures meta USING(meta_literature_id)
        JOIN literature_metadata m ON m.literature_id=meta.representative_literature_id WHERE r.discovery_run_id=? ORDER BY m.title`,
        runId,
      ),
      causes: facts(
        `SELECT s.title AS citing_title,t.title AS cited_title,c.depth FROM citation_discovery_causes c
        JOIN literature_metadata s ON s.literature_id=c.source_literature_id JOIN literature_metadata t ON t.literature_id=c.target_literature_id
        WHERE c.discovery_run_id=? ORDER BY s.title,t.title,c.depth`,
        runId,
      ),
      members: facts(
        `SELECT m.title,b.disposition FROM intake_batch_members b JOIN literature_metadata m USING(literature_id)
        WHERE b.batch_id=? ORDER BY m.title`,
        batchId,
      ),
      observations: facts(
        `SELECT p.source_name,p.source_record_id,p.input_sha256,p.parameters_sha256 FROM metadata_observations o JOIN provenances p USING(provenance_id) ORDER BY 1,2,3,4`,
      ),
      relationObservations: facts(
        `SELECT p.source_name,p.source_record_id,p.input_sha256,p.parameters_sha256 FROM provider_relation_observations o JOIN provenances p USING(provenance_id) ORDER BY 1,2,3,4`,
      ),
      supports:
        facts(`SELECT s.title AS citing_title,t.title AS cited_title,p.source_name,p.source_record_id,p.input_sha256,p.parameters_sha256 FROM provider_relation_reference_supports o
        JOIN provider_relation_observations x USING(observation_id) JOIN provenances p USING(provenance_id)
        JOIN literature_references r USING(reference_id) JOIN literature_metadata s ON s.literature_id=r.source_literature_id
        JOIN literature_metadata t ON t.literature_id=r.target_literature_id ORDER BY 1,2,3,4,5,6`),
      rawCount: checkpoint.providers.map((state) => state.raw_item_count),
      resultCount: (await app.database.getDiscovery(runId))!.results.length,
      attempts: (await repo.getBudget(id))!.attempts,
    };
  } finally {
    db.close();
  }
}

it("rebuilds the legacy state and resumes like a checkpointed interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-suzuki-recovery-"));
  let app: Application | undefined;
  const close = async () => {
    await app?.close();
    app = undefined;
  };
  try {
    const a = fixtureSources();
    app = await createApplication(join(root, "a"), a.options);
    const complete = await run(app, await seed(app));
    const full = await projection(
      app,
      complete.job_id,
      String(complete.discovery_run_id),
      String(complete.intake_batch_id),
    );
    await close();

    const stop = new AbortController();
    const c = fixtureSources(false, stop);
    const cHome = join(root, "c");
    app = await createApplication(cHome, c.options);
    const cSeed = await seed(app);
    const interrupted = await run(app, cSeed, stop.signal).catch(
      (error: unknown) => {
        if (!stop.signal.aborted) throw error;
        return null;
      },
    );
    expect(stop.signal.aborted).toBe(true);
    const jobs = await new ExecutionRepository(app.database).listJobs(1);
    const cId = jobs[0]!.job_id;
    expect(interrupted?.status ?? jobs[0]!.status).toMatch(/interrupted/i);
    const saved = parseCitationCheckpoint(
      (
        await new MetadataSourceRun(
          new ExecutionRepository(app.database),
          cId,
          `${cId}:0`,
        ).latestCheckpoint()
      )?.payload,
    );
    expect(saved.raw_items).toHaveLength(1);
    expect(saved.active_query?.usableRelations).toBe(1);
    expect(saved.providers[1]!.cooldown?.until).toBe(testTime + 60_000);
    expect(c.calls).toEqual([
      "openalex:0",
      "openalex:1",
      "semantic-scholar:1",
      "openalex:2",
    ]);
    const prefix = c.calls.length;
    await close();
    app = await createApplication(cHome, c.options);
    await app.processingTasks!.control(cId, "resume");
    const cResult = await run(app, cSeed);
    expect(cResult.discovery_run_id).toBe(saved.run_id);
    const modern = await projection(app, cId, saved.run_id, saved.batch_id);
    await close();

    const b = fixtureSources(true);
    const bHome = join(root, "b");
    app = await createApplication(bHome, b.options);
    const bSeed = await seed(app);
    const legacy = await writeLegacyPrefix(app, bSeed);
    await close();
    const catalog = join(bHome, "catalog.sqlite");
    const plan = await readSuzukiRecoveryPlan(
      catalog,
      legacy.id,
      legacy.batch,
      testTime,
    );
    expect(plan.evidence).toMatchObject({
      batch_members: 4,
      causes: 4,
      pending_count: 2,
      raw_item_count_before_resume: 5,
      raw_replay_count: 1,
    });
    expect(plan.rawItems).toEqual(saved.raw_items);
    expect(
      plan.deferred.map(({ kind, provider_name }) => [kind, provider_name]),
    ).toEqual([["reference-query", "semantic-scholar"]]);
    const writes = new CatalogWriteAdmission(catalog);
    const worker = new SqliteWorker(catalog, writes);
    let imported;
    try {
      imported = await writes.run(() => writeSuzukiRecoveryPlan(worker, plan));
    } finally {
      await worker.close();
      await writes.close();
    }
    app = await createApplication(bHome, b.options);
    expect(
      (await new ExecutionRepository(app.database).getJob(legacy.id))?.status,
    ).toBe("interrupted");
    await app.processingTasks!.control(legacy.id, "resume");
    const bResult = await run(app, bSeed);
    expect(bResult.discovery_run_id).toBe(imported.run_id);
    const restored = await projection(
      app,
      legacy.id,
      imported.run_id,
      legacy.batch,
    );
    expect(b.calls).toEqual(c.calls.slice(prefix));
    expect(b.calls).toEqual(a.calls.slice(prefix - 1));
    expect(b.waits).toEqual(c.waits);
    expect(b.waits).toEqual([60_000]);
    expect(restored).toEqual(modern);
    expect(restored).toEqual({ ...full, attempts: 2 });
    expect(full.attempts).toBe(1);
    expect(restored.rawCount).toEqual([7, 1]);
    expect(restored.resultCount).toBe(7);
    expect(
      restored.supports.filter(([title]) => title === "Fixture 9"),
    ).toHaveLength(1);
    expect(
      restored.observations.filter(([, work]) => work === "9"),
    ).toHaveLength(1);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("refuses an unrelated catalog with no writes, and refuses a catalog held by another process", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-suzuki-refused-"));
  const f = fixtureSources();
  try {
    const app = await createApplication(root, f.options);
    await app.close();
    const catalog = join(root, "catalog.sqlite");
    const bytes = await readFile(catalog);
    const files = await readdir(root);
    await expect(
      recoverSuzukiCitationCheckpoint(catalog, true),
    ).rejects.toThrow("legacy job is absent");
    expect((await readFile(catalog)).equals(bytes)).toBe(true);
    expect(await readdir(root)).toEqual(files);

    const child = spawn(
      process.execPath,
      [
        "-e",
        'require("node:fs").openSync(process.argv[1],"r"); process.stdin.resume(); process.stdout.write("held\\n")',
        catalog,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const closed = once(child, "close");
    try {
      await once(child.stdout, "data");
      await expect(recoverSuzukiCitationCheckpoint(catalog)).rejects.toThrow(
        "catalog is in use",
      );
      await expect(
        recoverSuzukiCitationCheckpoint(catalog, true),
      ).rejects.toThrow("catalog is in use");
    } finally {
      child.stdin.end();
      await closed;
    }
    expect((await readFile(catalog)).equals(bytes)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps an incomplete import out of the normal resume path", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-suzuki-incomplete-"));
  const f = fixtureSources(true);
  const app = await createApplication(root, f.options);
  try {
    const id = await seed(app);
    const legacy = await writeLegacyPrefix(app, id);
    const journal = new MetadataSourceRun(
      new ExecutionRepository(app.database),
      legacy.id,
      legacy.target,
    );
    await app.database.writeMetadataSegment(() =>
      journal.checkpoint({
        version: 1,
        run_id: randomUUID(),
        batch_id: legacy.batch,
        started_at: new Date().toISOString(),
        source_id: null,
        checked: false,
        next_provider: 0,
        active_query: null,
        raw_provider: -1,
        raw_items: [],
        causes: [],
        providers: [],
        results_published: true,
        closed: null,
        legacy_recovery: { raw_item_count_before_resume: 5, verified: false },
      }),
    );
    await expect(
      app.citations.run({
        origin: "cli",
        seed_literature_ids: [id],
        direction: "cited-by",
        max_depth: 2,
        result_limit: null,
        providers: sources.map((provider_name) => ({
          provider_name,
          scan_limit: null,
        })),
        source_run: journal,
      }),
    ).rejects.toThrow("legacy citation recovery has not been verified");
    expect(f.calls).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
