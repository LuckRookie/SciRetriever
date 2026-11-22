import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  parseTaskCitationSourceCooldowns,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import type { CitationClock } from "../src/entry/citation-cooldown.js";
import { runMetadataTask } from "../src/entry/metadata-task.js";
import { createTaskReader } from "../src/entry/task-read.js";
import { processingJobId } from "../src/application/jobs/processing.js";
import { withActivity } from "../src/logging/activity.js";
import {
  MetadataProviderFailure,
  type MetadataLookupPort,
  type NeutralMetadataItem,
  type ReferenceQueryContext,
  type ReferenceQueryPort,
} from "../src/metadata/ports.js";
import { networkRequestDispatched } from "../src/network/request-activity.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";

const START = Date.parse("2026-11-22T00:00:00Z");
const MINUTE = 60_000;
const IDEMPOTENCY_KEY = "citation-source-cooldown";

class Clock implements CitationClock {
  readonly waits: number[] = [];
  constructor(
    public time = START,
    private readonly onWait?: () => void,
  ) {}
  now() {
    return this.time;
  }
  async wait(milliseconds: number, signal?: AbortSignal) {
    this.waits.push(milliseconds);
    this.onWait?.();
    signal?.throwIfAborted();
    this.time += milliseconds;
  }
}

function limited(retry_after_ms?: number) {
  return new MetadataProviderFailure(
    {
      code: "metadata-provider-rate-limited",
      reason: "The fixture exhausted its quota.",
      action: "Wait for the provider cooldown.",
      retryable: true,
    },
    retry_after_ms === undefined ? {} : { retry_after_ms },
  );
}

function titleOf(key: ProviderLiteratureKey) {
  return key.identifiers
    .find((id) => id.namespace === "doi")!
    .value.split("/")[1]!;
}

function observation(source: string, name: string) {
  return parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: randomUUID(),
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
      source_record_id: name,
      observed_at: "2026-11-22T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      ...EMPTY_METADATA,
      title: name,
      identifiers: [{ namespace: "doi", value: `10.5555/${name}` }],
    },
    version_role: "published",
    version_links: [],
    reference_count: null,
    cited_by_count: null,
    declared_keywords: [],
    reference_texts: [],
    asset_hints: [],
  });
}

function related(
  source: string,
  context: ReferenceQueryContext,
  target: string,
  inline = true,
): NeutralMetadataItem {
  const observed = observation(source, target);
  return {
    observations: inline ? [observed] : [],
    relations: [
      {
        observation_id: randomUUID(),
        provenance: observed.provenance,
        citing: context.keys[0]!,
        cited: {
          record_id: target,
          identifiers: observed.metadata.identifiers,
        },
      },
    ],
  };
}

function referencePort(
  source: string,
  rows: (
    anchor: string,
    context: ReferenceQueryContext,
  ) => readonly (NeutralMetadataItem | (() => never))[],
): ReferenceQueryPort {
  return {
    provider_name: source,
    open_reference_query(context) {
      networkRequestDispatched();
      const items = rows(titleOf(context.keys[0]!), context);
      let offset = 0;
      return {
        pull_raw_item() {
          const item = items[offset++];
          if (typeof item === "function") item();
          return item === undefined
            ? null
            : {
                raw_item: item,
                source_exhausted_after: offset === items.length,
              };
        },
        convert_raw_item: (raw) => raw as NeutralMetadataItem,
      };
    },
  };
}

function open(
  home: string,
  clock: Clock,
  ports: ReferenceQueryPort[],
  lookups: MetadataLookupPort[] = [],
) {
  return createApplication(home, {
    metadata: { reference_query_ports: ports, lookup_ports: lookups },
    citationClock: clock,
    indexRefreshIntervalMs: null,
    browserHost: () => null,
  });
}

async function fixture(
  clock: Clock,
  ports: ReferenceQueryPort[],
  lookups: MetadataLookupPort[] = [],
) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-citation-cooldown-"));
  try {
    const app = await open(home, clock, ports, lookups);
    return {
      home,
      app,
      async close() {
        await app.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

async function seeds(app: Application, ...names: string[]) {
  const ids: string[] = [];
  for (const name of names) {
    const decision = await app.identity.observe(observation("fixture", name));
    if (decision.disposition !== "accepted") throw new Error(decision.reason);
    ids.push(decision.literature_id);
  }
  return ids;
}

function run(
  app: Application,
  seedIds: string[],
  providers: ReferenceQueryPort[],
  signal?: AbortSignal,
  maxDepth = 1,
) {
  return withActivity({ actor: "cli:citation-cooldown" }, () =>
    runMetadataTask(
      app,
      {
        kind: "citation",
        seed_literature_ids: seedIds,
        direction: "references",
        max_depth: maxDepth,
        providers: providers.map((port) => ({ source: port.provider_name })),
      },
      signal,
      IDEMPOTENCY_KEY,
    ),
  );
}

function details(app: Application, job: string) {
  return createTaskReader(new ExecutionRepository(app.database)).read(job);
}

it("applies all six default waits, disables the source, and keeps missing anchors visible", async () => {
  const clock = new Clock();
  const calls: string[] = [];
  const attempts: number[] = [];
  const ports = [
    referencePort("quota", (anchor) => {
      calls.push("quota:" + anchor);
      attempts.push(clock.now() - START);
      throw limited();
    }),
    referencePort("free", (anchor, context) => {
      calls.push("free:" + anchor);
      return [related("free", context, anchor + "-target")];
    }),
  ];
  const f = await fixture(clock, ports);
  try {
    const ids = await seeds(f.app, "first", "second");
    const result = await run(f.app, ids, ports);
    expect(result).toMatchObject({ status: "PARTIAL", result_count: 2 });
    expect(clock.waits.map((ms) => ms / MINUTE)).toEqual([
      1, 5, 15, 60, 60, 60,
    ]);
    expect(attempts.map((ms) => ms / MINUTE)).toEqual([
      0, 1, 6, 21, 81, 141, 201,
    ]);
    expect(calls).toEqual([
      "quota:first",
      "free:first",
      "free:second",
      ...Array<string>(6).fill("quota:first"),
    ]);
    const initial = await details(f.app, result.job_id);
    expect(
      initial.events.filter(
        (event) => event.kind === "citation-source-cooldown",
      ),
    ).toHaveLength(7);
    expect(initial.citation_source_cooldowns).toEqual([
      expect.objectContaining({
        source: "quota",
        status: "disabled",
        retries: 6,
        next_retry_at: null,
        reason: expect.objectContaining({
          code: "metadata-provider-rate-limited",
        }),
        pending_count: 2,
        pending_sample: expect.arrayContaining(
          ids.map((literature_id) => ({
            literature_id,
            purpose: "reference-query",
          })),
        ),
        pending_truncated: false,
      }),
    ]);
    expect(parseTaskCitationSourceCooldowns(initial)).toEqual({
      citation_source_cooldowns: initial.citation_source_cooldowns,
    });

    // Exercise the appended and first-read paths after the activity tail
    // has rolled past the cooldown events.
    const db = new DatabaseSync(join(f.home, "catalog.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN");
      const latest = Number(
        db
          .prepare(
            "SELECT max(sequence) AS head FROM execution_events WHERE job_id=?",
          )
          .get(result.job_id)!.head,
      );
      const insert = db.prepare(
        "INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at) VALUES(?,?,?,'fixture-event','{}',?)",
      );
      for (let i = 1; i <= 1010; i++)
        insert.run(
          randomUUID(),
          result.job_id,
          latest + i,
          new Date().toISOString(),
        );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const aged = await details(f.app, result.job_id);
    expect(
      aged.events.some((event) => event.kind === "citation-source-cooldown"),
    ).toBe(false);
    expect(aged.citation_source_cooldowns).toEqual(
      initial.citation_source_cooldowns,
    );
  } finally {
    await f.close();
  }
});

async function publication(app: Application) {
  const result = [];
  for (const {
    reference,
    supports,
  } of await app.database.referenceSnapshot()) {
    const citing = await app.database.getLiterature(
      reference.source_literature_id,
    );
    const cited = await app.database.getLiterature(
      reference.target_literature_id,
    );
    result.push([
      citing?.metadata.title,
      cited?.metadata.title,
      supports.length,
    ]);
  }
  const { tables } = await app.database.snapshotCounts();
  return {
    edges: result.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    literature: tables.literatures,
    observations: tables.metadata_observations,
    relations: tables.provider_relation_observations,
  };
}

it("honors Retry-After and replays a committed prefix once, then starts a fresh streak", async () => {
  async function expand(withLimits: boolean) {
    const clock = new Clock();
    const calls: string[] = [];
    let first = true;
    let next = true;
    const ports = [
      referencePort("quota", (anchor, context) => {
        calls.push("quota:" + anchor);
        if (anchor === "first") {
          const prefix = related("quota", context, "prefix");
          if (withLimits && first) {
            first = false;
            return [
              prefix,
              () => {
                throw limited(180_000);
              },
            ];
          }
          return [prefix, related("quota", context, "suffix")];
        }
        if (withLimits && next) {
          next = false;
          throw limited();
        }
        return [];
      }),
      referencePort("free", (anchor, context) => {
        calls.push("free:" + anchor);
        return anchor === "first" ? [] : [related("free", context, "other")];
      }),
    ];
    const f = await fixture(clock, ports);
    try {
      const result = await run(
        f.app,
        await seeds(f.app, "first", "second"),
        ports,
      );
      expect(result).toMatchObject({ status: "COMPLETED", result_count: 3 });
      const detail = await details(f.app, result.job_id);
      return { calls, clock, detail, facts: await publication(f.app) };
    } finally {
      await f.close();
    }
  }
  const healthy = await expand(false);
  const cooled = await expand(true);
  expect(cooled.facts).toEqual(healthy.facts);
  expect(healthy.calls).toEqual(["quota:first", "quota:second", "free:second"]);
  expect(cooled.calls).toEqual([
    "quota:first",
    "free:first",
    "free:second",
    "quota:first",
    "quota:second",
    "quota:second",
  ]);
  expect(cooled.clock.waits).toEqual([180_000, MINUTE]);
  expect(
    cooled.detail.events
      .filter((event) => event.kind === "citation-source-cooldown")
      .map((event) => event.payload),
  ).toEqual([
    expect.objectContaining({
      retries: 0,
      status: "cooling",
      next_retry_at: new Date(START + 180_000).toISOString(),
    }),
    expect.objectContaining({ retries: 0, status: "recovered" }),
    expect.objectContaining({
      retries: 0,
      status: "cooling",
      next_retry_at: new Date(START + 180_000 + MINUTE).toISOString(),
    }),
    expect.objectContaining({ retries: 0, status: "recovered" }),
  ]);
  expect(cooled.detail.citation_source_cooldowns?.[0]).toMatchObject({
    status: "recovered",
    pending_count: 0,
    pending_sample: [],
  });
});

it.each([
  { elapsed: 500, waits: [1500] },
  { elapsed: 2500, waits: [] },
])(
  "restores cooling and pending anchors after $elapsed ms of interruption",
  async ({ elapsed, waits }) => {
    const abort = new AbortController();
    const firstClock = new Clock(START, () => abort.abort());
    let attempt = 0;
    const calls: string[] = [];
    const ports = [
      referencePort("quota", (anchor, context) => {
        calls.push("quota:" + anchor);
        if (attempt++ < 2) throw limited(attempt === 1 ? 0 : 2000);
        return [related("quota", context, anchor + "-target")];
      }),
      referencePort("free", (anchor) => {
        calls.push("free:" + anchor);
        return [];
      }),
    ];
    const f = await fixture(firstClock, ports);
    let reopened: Application | undefined;
    try {
      const ids = await seeds(f.app, "first", "second");
      await expect(run(f.app, ids, ports, abort.signal)).rejects.toThrow();
      expect(firstClock.waits).toEqual([2000]);
      const job = await processingJobId(IDEMPOTENCY_KEY);
      const interrupted = await details(f.app, job);
      expect(interrupted.citation_source_cooldowns?.[0]).toMatchObject({
        status: "cooling",
        retries: 1,
        next_retry_at: new Date(START + 2000).toISOString(),
        pending_count: 2,
      });
      expect(parseTaskCitationSourceCooldowns(interrupted)).toEqual({
        citation_source_cooldowns: interrupted.citation_source_cooldowns,
      });
      expect(calls).toEqual([
        "quota:first",
        "free:first",
        "quota:first",
        "free:second",
      ]);
      await f.app.close();
      const clock = new Clock(START + elapsed);
      reopened = await open(f.home, clock, ports);
      await reopened.processingTasks!.control(job, "resume");
      const result = await run(reopened, ids, ports);
      expect(result).toMatchObject({
        job_id: job,
        status: "COMPLETED",
        result_count: 2,
      });
      expect(calls.slice(4)).toEqual(["quota:first", "quota:second"]);
      expect(clock.waits).toEqual(waits);
      expect(
        (await details(reopened, job)).citation_source_cooldowns?.[0],
      ).toMatchObject({
        status: "recovered",
        pending_count: 0,
      });
    } finally {
      await reopened?.close();
      await f.close();
    }
  },
);

it("defers a supporting lookup and suspends further paging of the same source", async () => {
  const clock = new Clock();
  const calls: string[] = [];
  let once = true;
  const ports = [
    referencePort("quota", (_, context) => {
      calls.push("quota:references");
      return [
        related("quota", context, "found-later", false),
        related("quota", context, "inline"),
      ];
    }),
    referencePort("free", () => {
      calls.push("free:references");
      return [];
    }),
  ];
  const lookups: MetadataLookupPort[] = [
    {
      provider_name: "quota",
      open_lookup(key) {
        networkRequestDispatched();
        const name = titleOf(key);
        calls.push("quota:lookup:" + name);
        if (once) {
          once = false;
          throw limited(3000);
        }
        return {
          pull_raw_item: () => ({
            raw_item: name,
            source_exhausted_after: true,
          }),
          convert_raw_item: (raw) => ({
            observations: [observation("quota", String(raw))],
            relations: [],
          }),
        };
      },
    },
    {
      provider_name: "free",
      open_lookup(key) {
        networkRequestDispatched();
        calls.push("free:lookup:" + titleOf(key));
        return {
          pull_raw_item: () => null,
          convert_raw_item: () => ({ observations: [], relations: [] }),
        };
      },
    },
  ];
  const f = await fixture(clock, ports, lookups);
  try {
    const result = await run(f.app, await seeds(f.app, "anchor"), ports);
    expect(result).toMatchObject({ status: "COMPLETED", result_count: 2 });
    expect(calls).toEqual([
      "quota:references",
      "quota:lookup:found-later",
      "free:lookup:found-later",
      "free:references",
      "quota:lookup:found-later",
      "quota:references",
    ]);
    expect(clock.waits).toEqual([3000]);
    expect((await publication(f.app)).edges).toEqual([
      ["anchor", "found-later", 1],
      ["anchor", "inline", 1],
    ]);
    const detail = await details(f.app, result.job_id);
    expect(detail.citation_source_cooldowns?.[0]).toMatchObject({
      status: "recovered",
      pending_count: 0,
    });
    expect(parseTaskCitationSourceCooldowns(detail)).toEqual({
      citation_source_cooldowns: detail.citation_source_cooldowns,
    });
    expect(
      detail.source_results.metadata?.sources.find(
        (source) => source.source === "quota",
      )?.requests,
    ).toBe(4);
  } finally {
    await f.close();
  }
});

it("uses a shorter path revealed by a late reply to extend the frontier", async () => {
  const clock = new Clock();
  let once = true;
  const calls: string[] = [];
  const graph: Readonly<Record<string, string>> = {
    root: "detour",
    detour: "join",
    join: "boundary",
    boundary: "newly-reachable",
  };
  const ports = [
    referencePort("quota", (anchor, context) => {
      calls.push("quota:" + anchor);
      if (anchor !== "root") return [];
      if (once) {
        once = false;
        throw limited(1000);
      }
      return [related("quota", context, "join")];
    }),
    referencePort("free", (anchor, context) => {
      calls.push("free:" + anchor);
      return graph[anchor] ? [related("free", context, graph[anchor])] : [];
    }),
  ];
  const f = await fixture(clock, ports);
  try {
    const result = await run(
      f.app,
      await seeds(f.app, "root"),
      ports,
      undefined,
      3,
    );
    expect(result).toMatchObject({ status: "COMPLETED", result_count: 4 });
    expect(calls).toEqual([
      "quota:root",
      "free:root",
      "free:detour",
      "free:join",
      "quota:root",
      "quota:detour",
      "quota:join",
      "quota:boundary",
      "free:boundary",
    ]);
    expect((await publication(f.app)).edges).toContainEqual([
      "boundary",
      "newly-reachable",
      1,
    ]);
  } finally {
    await f.close();
  }
});

it("keeps the retry count when a retry ends with an unrelated failure", async () => {
  const clock = new Clock();
  const attempts = new Map<string, number>();
  const ports = [
    referencePort("quota", (anchor, context) => {
      const attempt = (attempts.get(anchor) ?? 0) + 1;
      attempts.set(anchor, attempt);
      if (attempt === 1) throw limited();
      if (anchor === "first")
        throw new MetadataProviderFailure({
          code: "metadata-provider-unavailable",
          reason: "The fixture returned HTTP 503.",
          action: "Retry the provider later.",
          retryable: true,
        });
      return [related("quota", context, "second-target")];
    }),
  ];
  const f = await fixture(clock, ports);
  try {
    const result = await run(
      f.app,
      await seeds(f.app, "first", "second"),
      ports,
    );
    expect(result).toMatchObject({ status: "PARTIAL", result_count: 1 });
    expect(clock.waits).toEqual([MINUTE, 5 * MINUTE]);
    const detail = await details(f.app, result.job_id);
    expect(
      detail.events
        .filter((event) => event.kind === "citation-source-cooldown")
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ status: "cooling", retries: 0 }),
      expect.objectContaining({
        status: "retry-ended",
        retries: 1,
        reason: expect.objectContaining({
          code: "metadata-provider-unavailable",
        }),
      }),
      expect.objectContaining({ status: "cooling", retries: 1 }),
      expect.objectContaining({ status: "recovered", retries: 0 }),
    ]);
  } finally {
    await f.close();
  }
});

it("keeps zero-depth expansion free of source work and checked anchors", async () => {
  const ports = [
    referencePort("quota", () => {
      throw new Error("zero-depth expansion must not call the source");
    }),
  ];
  const f = await fixture(new Clock(), ports);
  try {
    const result = await run(
      f.app,
      await seeds(f.app, "root"),
      ports,
      undefined,
      0,
    );
    expect(result).toMatchObject({
      status: "COMPLETED",
      result_count: 0,
      source_results: [],
    });
    const history = await f.app.database.withExecutionRuntime(async () => {
      const [target] = await f.app.database.listExecutionTargets(result.job_id);
      const [tail] = await f.app.database.citationCheckpoints(
        result.job_id,
        target!.target_id,
      );
      return f.app.database.citationCheckpoints(
        result.job_id,
        target!.target_id,
        { after: -1, through: tail!.sequence },
      );
    });
    expect(history.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        source_id: null,
        checked: false,
        closed: null,
      }),
      expect.objectContaining({
        source_id: null,
        checked: false,
        closed: "COMPLETED",
      }),
    ]);
  } finally {
    await f.close();
  }
});
