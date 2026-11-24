import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  parseIntakeBatchId,
  parseLiteratureDetail,
  parseMetadataObservation,
  parseMetadataSourceProgress,
  parseProcessingTaskRequest,
  type IntakeBatchId,
  type StableFailure,
} from "@sciretriever/contracts";
import { MetadataSourceRun } from "../application/jobs/metadata-progress.js";
import { finishIntake } from "../literature/intake.js";
import { ExecutionRepository } from "../storage/execution/repository.js";
import { acquireExecutionRuntime } from "../storage/execution/runtime-owner.js";
import { readCatalogLayout } from "../storage/sqlite/catalog-identity.js";
import { CURRENT_CATALOG_CONFIG } from "../storage/sqlite/catalog-layout.js";
import { CitationProgress } from "../storage/sqlite/citation-progress.js";
import {
  schemaTargetFile,
  schemaTargetPath,
} from "../storage/sqlite/schema-path.js";
import {
  METADATA_SEGMENT_ITEMS,
  SqliteWorker,
} from "../storage/sqlite/worker.js";
import { CatalogWriteAdmission } from "../storage/write-admission.js";
import {
  citationItemKey,
  lookupWorkId,
  parseCitationCheckpoint,
  referenceQueryId,
  restoreCitationProgress,
  type CitationCause,
  type CitationCheckpoint,
  type CitationDeferredWork,
  type CitationProviderState,
  type CitationQueryProgress,
} from "./citation-checkpoint.js";
import { coolCitationSource } from "./citation-cooldown.js";

const SUZUKI_JOB = "processing-2b51707b3af941d8f870ac66dcef06f6";
const SUZUKI_BATCH = "92645ec9-39ee-4003-a5d1-d6f594caa75e";
const SUZUKI_SEED = "a88a8808-7acd-45ae-ae37-5e7e7fa35d49";
const RATE_LIMIT = "metadata-provider-rate-limited";
const sha = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");

function requireEvidence(value: unknown, field: string): asserts value {
  if (!value) throw new Error(`Suzuki citation recovery refused: ${field}`);
}

function fileInfo(path: string) {
  const value = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!value) return null;
  requireEvidence(
    value.isFile() && value.nlink === 1n,
    "unsafe catalog or sidecar",
  );
  return value;
}

function lockPath(path: string) {
  return join(
    dirname(path),
    ".sciretriever-locks",
    `catalog-${sha(path)}.lock`,
  );
}

function requireStoppedCatalog(path: string) {
  const files = [
    path,
    `${path}-wal`,
    `${path}-shm`,
    lockPath(path),
    lockPath(`${path}.execution-runtime`),
  ].filter(fileInfo);
  const result = spawnSync("/usr/bin/fuser", files, {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  requireEvidence(
    !result.error &&
      (result.status === 0 || (result.status === 1 && !result.stderr.trim())),
    "cannot check catalog holders",
  );
  const pids = result.stdout.trim().split(/\s+/u).filter(Boolean);
  requireEvidence(
    pids.every((id) => id === String(process.pid)),
    "catalog is in use or admission is held",
  );
  // Immutable SQLite reads create no sidecars. Refuse a WAL that could contain
  // writes outside that snapshot, before creating coordination files.
  requireEvidence(
    !fileInfo(`${path}-wal`)?.size,
    "checkpoint the stopped catalog before recovery",
  );
  const catalog = fileInfo(path);
  requireEvidence(catalog, "catalog is missing");
  return [catalog.dev, catalog.ino, catalog.size, catalog.mtimeNs].join(":");
}

function openSnapshot(path: string) {
  const location = pathToFileURL(path);
  location.searchParams.set("immutable", "1");
  const db = new DatabaseSync(location, { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  return db;
}

type EventRow = {
  event_id: string;
  job_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  created_at: string;
};
type Call = {
  source: string;
  purpose: "reference-query" | "lookup";
  unit: string;
  opened: number;
  closed: number | null;
  result: string | null;
  returned: number;
};
type RecoveryPlan = {
  readonly path: string;
  readonly jobId: string;
  readonly targetId: string;
  readonly batchId: IntakeBatchId;
  readonly startedAt: string;
  readonly seed: string;
  readonly pending: readonly string[];
  readonly completed: readonly string[];
  readonly causesByAnchor: ReadonlyMap<string, readonly CitationCause[]>;
  readonly providers: readonly CitationProviderState[];
  readonly deferred: readonly CitationDeferredWork[];
  readonly rateEvents: readonly Record<string, unknown>[];
  readonly activeQuery: CitationQueryProgress;
  readonly activeProvider: number;
  readonly rawItems: readonly string[];
  readonly evidence: ReturnType<typeof recoverySummary>;
};

function rateFailure(code: string): StableFailure {
  return {
    code,
    reason:
      code === RATE_LIMIT
        ? "The metadata provider rate limited the recorded request."
        : "A metadata provider failure was recorded before recovery.",
    action: "Retry the provider or inspect its readiness.",
    retryable: true,
  };
}

function recoverySummary(input: {
  seed: string;
  tail: EventRow;
  eventCount: number;
  members: number;
  memberSha: string;
  mappingSha: string;
  pending: readonly string[];
  causes: number;
  rawCount: number;
  rawKeys: readonly string[];
  deferred: readonly CitationDeferredWork[];
}) {
  return {
    seed: input.seed,
    event_count: input.eventCount,
    tail_sequence: input.tail.sequence,
    tail_event_id: input.tail.event_id,
    tail_at: input.tail.created_at,
    tail_sha256: sha(JSON.stringify(input.tail)),
    batch_members: input.members,
    members_sha256: input.memberSha,
    mapping_sha256: input.mappingSha,
    pending_count: input.pending.length,
    pending_sha256: sha(input.pending.join("\n")),
    causes: input.causes,
    raw_item_count_before_resume: input.rawCount,
    raw_replay_count: input.rawKeys.length,
    raw_replay_sha256: sha(input.rawKeys.join("\n")),
    deferred_work: input.deferred.map(({ id }) => id),
  };
}

function readEvents(
  db: DatabaseSync,
  jobId: string,
  target: string,
  providers: readonly CitationProviderState[],
) {
  const states = new Map(
    providers.map((state) => [state.provider_name, state]),
  );
  const calls = new Map<string, Call>();
  const rates: Call[] = [];
  const anchors = new Set<string>();
  let tail!: EventRow;
  let eventCount = 0;
  let included = 0;
  for (const item of db
    .prepare("SELECT * FROM execution_events WHERE job_id=? ORDER BY sequence")
    .iterate(jobId)) {
    tail = item as EventRow;
    requireEvidence(tail.sequence === eventCount++, "event sequence changed");
    if (!tail.sequence) {
      requireEvidence(tail.kind === "attempt-started", "first event changed");
      continue;
    }
    requireEvidence(tail.kind === "metadata-source", "unexpected event kind");
    const payload = JSON.parse(tail.payload_json);
    requireEvidence(payload.target_id === target, "event target changed");
    const p = parseMetadataSourceProgress(payload.progress);
    const state = states.get(p.source);
    requireEvidence(state, "unrequested source");
    if (p.phase === "started") {
      requireEvidence(
        !calls.has(p.record_id) &&
          (p.purpose === "reference-query" || p.purpose === "lookup"),
        "invalid call start",
      );
      calls.set(p.record_id, {
        source: p.source,
        purpose: p.purpose,
        unit: p.unit_id,
        opened: tail.sequence,
        closed: null,
        result: null,
        returned: 0,
      });
      state.attempted = true;
      if (p.purpose === "reference-query") anchors.add(p.unit_id);
    }
    const call = calls.get(p.record_id);
    requireEvidence(
      call &&
        call.closed === null &&
        call.source === p.source &&
        call.unit === p.unit_id &&
        call.purpose === p.purpose,
      "call identity changed",
    );
    if (p.phase === "included") {
      requireEvidence(p.purpose === "reference-query", "unexpected inclusion");
      included++;
    } else if (p.phase === "returned") {
      call.returned += p.count;
      state.raw_item_count += p.count;
    } else if (p.phase === "finished") {
      call.closed = tail.sequence;
      call.result = p.result;
      const code = p.problem?.technical_details.diagnostics[0]?.code;
      if (code === RATE_LIMIT) {
        requireEvidence(
          p.problem?.technical_details.diagnostics.length === 1 &&
            p.problem.technical_details.diagnostics[0]!.retry_after_ms ===
              undefined,
          "rate-limit evidence changed",
        );
        rates.push(call);
      } else if (code) {
        state.failure ??= rateFailure(code);
        if (
          code === "metadata-provider-authentication" ||
          code === "metadata-provider-authorization"
        )
          state.terminal = "FAILED";
      }
    }
  }
  const last = [...calls.values()].at(-1);
  requireEvidence(
    last?.purpose === "reference-query" &&
      last.result === "cancelled" &&
      last.closed === tail?.sequence,
    "tail is not a cancelled reference query",
  );
  requireEvidence(
    [...calls.values()].every(
      (call) =>
        call.closed !== null && (call === last || call.result !== "cancelled"),
    ),
    "another call is unfinished",
  );
  return { tail, eventCount, included, anchors: [...anchors], rates, last };
}

function mapCauses(
  db: DatabaseSync,
  jobId: string,
  batchId: IntakeBatchId,
  seed: string,
  included: number,
) {
  const members = new Set<string>();
  const memberSha = createHash("sha256");
  for (const row of db
    .prepare(
      "SELECT literature_id,disposition FROM intake_batch_members WHERE batch_id=? ORDER BY literature_id",
    )
    .iterate(batchId)) {
    const id = String(row.literature_id);
    members.add(id);
    memberSha.update(JSON.stringify([id, row.disposition]) + "\n");
  }
  const causesByAnchor = new Map<string, CitationCause[]>();
  const seen = new Map<string, Set<string>>();
  const results = new Set<string>();
  const mappedMembers = new Set<string>();
  const mappingSha = createHash("sha256");
  let mapped = 0;
  let causes = 0;
  let lastSequence = -1;
  // A global Reference is corroboration only. The job's included event owns
  // the ordering and attribution. A second match for an event is ambiguous.
  for (const row of db
    .prepare(
      `SELECT e.sequence, e.anchor, e.meta, l.literature_id
    FROM (SELECT sequence, json_extract(payload_json,'$.progress.unit_id') anchor,
      json_extract(payload_json,'$.progress.result_id') meta
      FROM execution_events WHERE job_id=? AND kind='metadata-source'
      AND json_extract(payload_json,'$.progress.phase')='included') e
    JOIN literatures l ON l.meta_literature_id=e.meta
    JOIN literature_references r ON r.source_literature_id=l.literature_id AND r.target_literature_id=e.anchor
    ORDER BY e.sequence`,
    )
    .iterate(jobId)) {
    requireEvidence(
      typeof row.sequence === "number" && row.sequence > lastSequence,
      "ambiguous included endpoint",
    );
    lastSequence = row.sequence;
    const anchor = String(row.anchor),
      meta = String(row.meta),
      actual = String(row.literature_id);
    requireEvidence(
      actual !== seed && members.has(actual),
      "included endpoint is outside the old batch",
    );
    mapped++;
    const seenAtAnchor = seen.get(anchor) ?? new Set<string>();
    if (seenAtAnchor.has(actual)) continue;
    seenAtAnchor.add(actual);
    seen.set(anchor, seenAtAnchor);
    const depth = anchor === seed ? 1 : 2;
    mappingSha.update(
      JSON.stringify([row.sequence, anchor, actual, meta, depth]) + "\n",
    );
    causes++;
    results.add(meta);
    mappedMembers.add(actual);
    const entries = causesByAnchor.get(anchor) ?? [];
    entries.push({
      meta_literature_id: meta,
      source_literature_id: actual,
      target_literature_id: anchor,
      actual_literature_id: actual,
      depth,
    });
    causesByAnchor.set(anchor, entries);
  }
  requireEvidence(
    mapped === included &&
      mappedMembers.size === members.size &&
      results.size === members.size,
    "included events and batch membership differ",
  );
  return {
    causesByAnchor,
    causes,
    members: members.size,
    memberSha: memberSha.digest("hex"),
    mappingSha: mappingSha.digest("hex"),
  };
}

async function readReplayKeys(
  db: DatabaseSync,
  reader: SqliteWorker,
  jobId: string,
  call: Call,
) {
  const rows = db
    .prepare(
      "SELECT * FROM execution_events WHERE job_id=? AND sequence BETWEEN ? AND ? ORDER BY sequence",
    )
    .all(jobId, call.opened, call.closed) as EventRow[];
  const progress = rows.map((row) =>
    parseMetadataSourceProgress(JSON.parse(row.payload_json).progress),
  );
  requireEvidence(
    progress[0]?.phase === "started" &&
      progress[1]?.phase === "requested" &&
      progress.at(-1)?.phase === "finished" &&
      rows.length === 3 + call.returned * 3,
    "tail response shape changed",
  );
  const snapshot = await reader.literatureDetailSnapshot(call.unit);
  const paper = await reader.getLiterature(call.unit);
  requireEvidence(snapshot && paper, "tail node disappeared");
  const detail = await parseLiteratureDetail(snapshot.detail);
  const anchorKey = {
    record_id:
      detail.metadata_observations.find(
        ({ provenance }) => provenance.source_name === call.source,
      )?.provenance.source_record_id ?? null,
    identifiers: paper.metadata.identifiers,
  };
  const attachments =
    db.prepare(`SELECT mo.observation_id AS metadata_id, rel.observation_id AS relation_id
    FROM literature_references rr
    JOIN literatures l ON l.literature_id=rr.source_literature_id
    JOIN provider_relation_reference_supports support USING(reference_id)
    JOIN provider_relation_observations rel ON rel.observation_id=support.observation_id
    JOIN provenances p ON p.provenance_id=rel.provenance_id
    JOIN metadata_observations mo ON mo.provenance_id=p.provenance_id
    JOIN literature_metadata_observations owner ON owner.observation_id=mo.observation_id AND owner.literature_id=l.literature_id
    WHERE rr.target_literature_id=? AND l.meta_literature_id=? AND p.source_name=?
      AND p.observed_at BETWEEN ? AND ?`);
  const keys: string[] = [];
  for (let i = 2; i < rows.length - 1; i += 3) {
    const [returned, observed, included] = progress.slice(i, i + 3);
    requireEvidence(
      returned?.phase === "returned" &&
        returned.count === 1 &&
        observed?.phase === "observed" &&
        included?.phase === "included" &&
        observed.result_id === included.result_id,
      "tail item has no complete evidence",
    );
    const matches = attachments.all(
      call.unit,
      included.result_id,
      call.source,
      rows[i - 1]!.created_at,
      rows[i]!.created_at,
    );
    requireEvidence(
      matches.length === 1,
      "ambiguous tail observation or support",
    );
    const row = matches[0]!;
    const stored = await reader.getObservation(String(row.metadata_id));
    const relation = await reader.getProviderRelation(String(row.relation_id));
    requireEvidence(
      stored &&
        relation &&
        JSON.stringify(relation.cited) === JSON.stringify(anchorKey),
      "tail provider query key changed",
    );
    const fields = { ...stored } as typeof stored & { literature_id?: string };
    delete fields.literature_id;
    const metadata = parseMetadataObservation(fields);
    requireEvidence(
      JSON.stringify(metadata.provenance) ===
        JSON.stringify(relation.provenance),
      "tail provenance differs",
    );
    keys.push(
      citationItemKey({
        kind: "item",
        failure: null,
        item: {
          observations: [metadata],
          relations: [{ ...relation, provenance: metadata.provenance }],
        },
      }),
    );
  }
  return keys;
}

/** The operator command below fixes the identity and evidence. This seam also permits an isolated fixture. */
export async function readSuzukiRecoveryPlan(
  path: string,
  jobId: string,
  batch: string,
  now: number,
): Promise<RecoveryPlan> {
  const batchId = parseIntakeBatchId(batch);
  const db = openSnapshot(path);
  const reader = new SqliteWorker(path, undefined, {
    readOnly: true,
    immutableReadOnly: true,
  });
  try {
    requireEvidence(
      readCatalogLayout(db, CURRENT_CATALOG_CONFIG),
      "current catalog layout required",
    );
    const job = db
      .prepare("SELECT status,selector_json FROM execution_jobs WHERE job_id=?")
      .get(jobId);
    requireEvidence(
      job && (job.status === "running" || job.status === "interrupted"),
      "legacy job is absent or already moved",
    );
    const selector = JSON.parse(String(job.selector_json));
    requireEvidence(selector.schema_version === 3, "saved selector changed");
    const request = await parseProcessingTaskRequest(selector.request);
    const [op] = request.operations;
    requireEvidence(
      request.operations.length === 1 &&
        op?.operation === "acquire-metadata" &&
        op.request.kind === "citation",
      "saved task is not citation expansion",
    );
    const scope = op.request;
    requireEvidence(
      scope.direction === "cited-by" &&
        scope.max_depth === 2 &&
        scope.result_limit === null &&
        scope.seed_literature_ids.length === 1 &&
        scope.providers.every(({ scan_limit }) => scan_limit === null),
      "saved citation scope changed",
    );
    const seed = scope.seed_literature_ids[0]!;
    const target = db
      .prepare(
        "SELECT target_id FROM execution_targets WHERE job_id=? ORDER BY ordinal",
      )
      .all(jobId);
    requireEvidence(
      target.length === 1 && target[0]!.target_id === `${jobId}:0`,
      "citation target changed",
    );
    const targetId = String(target[0]!.target_id);
    const batchRow = db
      .prepare("SELECT * FROM intake_batches WHERE batch_id=?")
      .get(batchId);
    requireEvidence(
      batchRow?.kind === "citation" &&
        batchRow.state === "running" &&
        batchRow.discovery_run_id === null &&
        batchRow.rejected === 0 &&
        batchRow.source_failures === 0,
      "legacy batch is absent or already attached",
    );
    const batchRequest = JSON.parse(String(batchRow.request_json));
    requireEvidence(
      batchRequest.seed_literature_id === seed &&
        batchRequest.direction === scope.direction &&
        JSON.stringify(batchRequest.providers) ===
          JSON.stringify(scope.providers.map(({ source }) => source)),
      "batch request changed",
    );
    const providers: CitationProviderState[] = scope.providers.map(
      ({ source }) => ({
        provider_name: source,
        scan_limit: null,
        raw_item_count: 0,
        attempted: false,
        terminal: null,
        failure: null,
      }),
    );
    const events = readEvents(db, jobId, targetId, providers);
    const mapping = mapCauses(db, jobId, batchId, seed, events.included);
    const second =
      mapping.causesByAnchor
        .get(seed)
        ?.map((cause) => cause.actual_literature_id) ?? [];
    requireEvidence(
      events.anchors[0] === seed &&
        events.anchors.slice(1).every((id, i) => second[i] === id),
      "traversal order differs from seed inclusion",
    );
    const pending = second.slice(events.anchors.length - 2);
    requireEvidence(
      pending[0] === events.last.unit,
      "cancelled node is not the head",
    );
    const activeProvider = providers.findIndex(
      (state) => state.provider_name === events.last.source,
    );
    const rawItems = await readReplayKeys(db, reader, jobId, events.last);
    const deferred: CitationDeferredWork[] = [];
    const rateEvents: Record<string, unknown>[] = [];
    for (const call of events.rates) {
      const state = providers.find(
        ({ provider_name }) => provider_name === call.source,
      )!;
      requireEvidence(
        !state.cooldown && !state.terminal && call.returned === 0,
        "cannot import the rate-limit state",
      );
      rateEvents.push({
        source: call.source,
        ...coolCitationSource(state, rateFailure(RATE_LIMIT), undefined, now),
      });
      if (call.purpose === "reference-query") {
        deferred.push({
          id: referenceQueryId(call.unit, call.source),
          kind: "reference-query",
          provider_name: call.source,
          source_id: call.unit,
          depth: call.unit === seed ? 0 : 1,
          active_query: null,
        });
      } else {
        const [source_id, relation_id, extra] = call.unit.split(":");
        requireEvidence(
          source_id &&
            relation_id &&
            !extra &&
            events.anchors.includes(source_id),
          "blocked lookup anchor changed",
        );
        const relation = await reader.getProviderRelation(relation_id);
        requireEvidence(
          relation &&
            relation.citing.identifiers.length &&
            providers.some(
              ({ provider_name }) =>
                provider_name === relation.provenance.source_name,
            ),
          "blocked lookup relation changed",
        );
        const support = db
          .prepare(
            "SELECT 1 FROM provider_relation_reference_supports WHERE observation_id=? LIMIT 1",
          )
          .get(relation_id);
        deferred.push({
          id: lookupWorkId(relation_id, call.source),
          kind: "lookup",
          provider_name: call.source,
          source_id,
          relation_id,
          depth: source_id === seed ? 0 : 1,
          reference_provider: relation.provenance.source_name,
          outgoing: false,
          unresolved: !support,
        });
      }
    }
    const evidence = recoverySummary({
      ...mapping,
      ...events,
      seed,
      pending,
      rawKeys: rawItems,
      rawCount: providers.reduce((n, state) => n + state.raw_item_count, 0),
      deferred,
    });
    return {
      path,
      jobId,
      targetId,
      batchId,
      startedAt: String(batchRow.created_at),
      seed,
      pending,
      completed: events.anchors.slice(0, -1),
      causesByAnchor: mapping.causesByAnchor,
      providers,
      deferred,
      rateEvents,
      activeProvider,
      rawItems,
      activeQuery: {
        failure: null,
        returnedRelations: true,
        usableRelations: rawItems.length,
        incomplete: false,
        pending_item: null,
      },
      evidence,
    };
  } finally {
    db.close();
    await reader.close();
  }
}

const expectedSuzuki: RecoveryPlan["evidence"] = {
  seed: SUZUKI_SEED,
  event_count: 1851782,
  tail_sequence: 1851781,
  tail_event_id: "91bf4880-011a-405e-b8ea-d27be56d859f",
  tail_at: "2026-11-23T07:53:12.200Z",
  tail_sha256:
    "3e163e187a9baa2ce17a5454c74654f096607809b629f0cc4fedab91d811eb94",
  batch_members: 291317,
  members_sha256:
    "0876ad79c38b1d3702624861707f15ceba5e487f57612c4e4d62e26589f65662",
  mapping_sha256:
    "92eed4d965ad3f401d7e691179a1c8e273e2b13e170ba62471128dd2a936b01e",
  pending_count: 10693,
  pending_sha256:
    "2ef7443f45388512c434a2d3f646f42523471f17f1b0b0b29e71a8515805ab26",
  causes: 613319,
  raw_item_count_before_resume: 613409,
  raw_replay_count: 11,
  raw_replay_sha256:
    "80deca3da2a3a29b34fda890a389871707fad107000ff14d5932b8c6e708d5f5",
  deferred_work: [
    referenceQueryId(
      "f96c0868-b8be-40b1-9cc5-42ed3d9f98d4",
      "semantic-scholar",
    ),
    lookupWorkId("51293bfb-6eff-4981-ac3a-aeb5e9966c97", "core"),
  ],
};

function same(a: unknown, b: unknown) {
  return Buffer.from(canonicalJsonBytes(a)).equals(
    Buffer.from(canonicalJsonBytes(b)),
  );
}

function matchesCause(a: NodeJS.Dict<unknown> | undefined, b: CitationCause) {
  return (
    a?.meta_literature_id === b.meta_literature_id &&
    a.source_literature_id === b.source_literature_id &&
    a.target_literature_id === b.target_literature_id &&
    a.actual_literature_id === b.actual_literature_id &&
    a.depth === b.depth
  );
}

async function verifyRecovery(
  journal: MetadataSourceRun,
  runId: string,
  plan: RecoveryPlan,
) {
  const tail = await journal.latestCheckpoint();
  requireEvidence(tail, "checkpoint is missing after import");
  const checkpoint = parseCitationCheckpoint(tail.payload);
  requireEvidence(
    checkpoint.run_id === runId &&
      checkpoint.batch_id === plan.batchId &&
      same(checkpoint.providers, plan.providers),
    "checkpoint identity or counters differ",
  );
  const progress = new CitationProgress<CitationDeferredWork>(
    [plan.seed],
    2,
    "cited-by",
  );
  const publication = new DatabaseSync(plan.path, { readOnly: true });
  try {
    const batch = publication
      .prepare("SELECT discovery_run_id FROM intake_batches WHERE batch_id=?")
      .get(plan.batchId);
    const count = publication
      .prepare(
        "SELECT count(*) AS n FROM discovery_results WHERE discovery_run_id=?",
      )
      .get(runId);
    requireEvidence(
      batch?.discovery_run_id === runId &&
        count?.n === plan.evidence.batch_members,
      "published run or result count differs",
    );
    const publishedRows = publication
      .prepare(
        `SELECT meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth
      FROM citation_discovery_causes WHERE discovery_run_id=? ORDER BY rowid`,
      )
      .iterate(runId);
    const published = publishedRows[Symbol.iterator]();
    await restoreCitationProgress(journal, checkpoint, tail.sequence, progress);
    requireEvidence(
      progress.resultCount === plan.evidence.batch_members,
      "replayed result count differs",
    );
    const causeReplay = progress.publicationCauses();
    try {
      for (const node of [...plan.completed, plan.pending[0]!])
        for (const cause of plan.causesByAnchor.get(node) ?? []) {
          requireEvidence(
            matchesCause(causeReplay.next().value, cause),
            "replayed cause differs",
          );
          requireEvidence(
            matchesCause(published.next().value, cause),
            "published cause differs",
          );
        }
      requireEvidence(
        causeReplay.next().done && published.next().done,
        "extra replayed or published cause",
      );
    } finally {
      published.return?.();
    }
    const queryId = referenceQueryId(
      plan.pending[0]!,
      plan.providers[plan.activeProvider]!.provider_name,
    );
    requireEvidence(
      progress.beginReplay(queryId) === plan.rawItems.length &&
        plan.rawItems.every((key) => progress.consumeRawItem(queryId, key)),
      "replay keys differ",
    );
    for (const work of plan.deferred) {
      requireEvidence(
        same(progress.deferred(work.id), work),
        "deferred work differs",
      );
      await progress.record([], null, { added: [], completed: work.id });
    }
    requireEvidence(!progress.hasDeferredWork, "extra deferred work");
    for (const id of plan.pending) {
      const next = progress.pending();
      requireEvidence(
        next?.[0] === id && next[1] === 1,
        "replayed pending order differs",
      );
      await progress.record([], id);
    }
    requireEvidence(!progress.pending(), "extra pending node");
  } finally {
    publication.close();
    progress.close();
  }
}

export async function writeSuzukiRecoveryPlan(
  database: SqliteWorker,
  plan: RecoveryPlan,
) {
  const journal = new MetadataSourceRun(
    new ExecutionRepository(database),
    plan.jobId,
    plan.targetId,
  );
  const runId = randomUUID();
  let segments = 0;
  let maxCauses = 0;
  const checkpoint = (fields: Partial<CitationCheckpoint> = {}) => {
    const saved: CitationCheckpoint = {
      version: 1,
      run_id: runId,
      batch_id: plan.batchId,
      started_at: plan.startedAt,
      providers: plan.providers,
      checked: false,
      source_id: null,
      next_provider: 0,
      active_query: null,
      raw_provider: -1,
      raw_items: [],
      causes: [],
      results_published: true,
      closed: null,
      legacy_recovery: {
        raw_item_count_before_resume:
          plan.evidence.raw_item_count_before_resume,
        verified: false,
      },
      ...fields,
    };
    parseCitationCheckpoint(saved);
    return journal.checkpoint({ ...saved });
  };
  const segment = (write: (expired: () => boolean) => Promise<void>) => {
    segments++;
    return database.writeMetadataSegment(write);
  };
  await segment(async () => {
    await database.startCitationDiscovery(
      {
        run: {
          discovery_run_id: runId,
          kind: "citation",
          status: "RUNNING",
          started_at: plan.startedAt,
          direction: "cited-by",
          max_depth: 2,
          result_limit: null,
          seed_literature_ids: [plan.seed],
        },
        providers: plan.providers,
      },
      false,
    );
    await database.writeIntake({
      operation: "resume-citation",
      batch_id: plan.batchId,
      discovery_run_id: runId,
      owner_pid: process.pid,
    });
    await checkpoint();
  });
  for (const source of [...plan.completed, plan.pending[0]!]) {
    const causes = plan.causesByAnchor.get(source) ?? [];
    let offset = 0;
    do {
      await segment(async (expired) => {
        const start = offset;
        while (
          offset < causes.length &&
          (offset === start || !expired()) &&
          offset - start < METADATA_SEGMENT_ITEMS
        )
          await database.appendCitationCause(runId, causes[offset++]!);
        maxCauses = Math.max(maxCauses, offset - start);
        await checkpoint({
          source_id: source,
          causes: causes.slice(start, offset),
          checked: source !== plan.pending[0] && offset === causes.length,
        });
      });
    } while (offset < causes.length);
  }
  const head: Partial<CitationCheckpoint> = {
    source_id: plan.pending[0]!,
    active_query: plan.activeQuery,
    next_provider: plan.activeProvider,
    raw_provider: plan.activeProvider,
  };
  await segment(async () => {
    for (const rate of plan.rateEvents)
      await journal.citationSourceCooldown({ run_id: runId, ...rate });
    await journal.citationSourceDeferred({
      run_id: runId,
      changes: plan.deferred.map((work) => ({
        action: "queued",
        work_id: work.id,
        source: work.provider_name,
        purpose: work.kind,
        literature_id: work.source_id,
        ...(work.kind === "lookup" ? { relation_id: work.relation_id } : {}),
      })),
    });
    await checkpoint({
      ...head,
      raw_items: plan.rawItems,
      deferred: { added: plan.deferred, completed: null },
    });
  });
  await verifyRecovery(journal, runId, plan);
  await segment(async () => {
    await database.finishCitationDiscovery(runId, "INTERRUPTED", []);
    await finishIntake(database, plan.batchId, "interrupted", runId);
    await checkpoint({
      ...head,
      legacy_recovery: {
        raw_item_count_before_resume:
          plan.evidence.raw_item_count_before_resume,
        verified: true,
      },
    });
  });
  return {
    run_id: runId,
    segments,
    max_causes_in_segment: maxCauses,
    replay_verified: true,
  };
}

export async function recoverSuzukiCitationCheckpoint(
  path: string,
  apply = false,
) {
  await schemaTargetPath(path);
  requireEvidence(await schemaTargetFile(path), "target catalog is missing");
  const signature = requireStoppedCatalog(path);
  const plan = await readSuzukiRecoveryPlan(
    path,
    SUZUKI_JOB,
    SUZUKI_BATCH,
    Date.now(),
  );
  for (const key of Object.keys(
    expectedSuzuki,
  ) as (keyof typeof expectedSuzuki)[])
    requireEvidence(same(plan.evidence[key], expectedSuzuki[key]), key);
  requireEvidence(
    same(
      plan.providers.map(({ provider_name, raw_item_count }) => [
        provider_name,
        raw_item_count,
      ]),
      [
        ["semantic-scholar", 0],
        ["openalex", 613034],
        ["europe-pmc", 375],
        ["datacite", 0],
        ["core", 0],
      ],
    ),
    "provider order or raw counts changed",
  );
  requireEvidence(
    requireStoppedCatalog(path) === signature,
    "catalog changed during validation",
  );
  const summary = {
    mode: apply ? "apply" : "dry-run",
    job_id: SUZUKI_JOB,
    batch_id: SUZUKI_BATCH,
    ...plan.evidence,
    cooldowns: plan.rateEvents,
  };
  if (!apply) return summary;

  const admission = new CatalogWriteAdmission(path);
  const runtime = await acquireExecutionRuntime(path);
  try {
    // Offline tool only. Hold both leases across every short transaction and
    // the read-back, so no runner can see a partially verified import.
    return await admission.run(async () => {
      requireEvidence(
        requireStoppedCatalog(path) === signature,
        "catalog changed before writing",
      );
      const database = new SqliteWorker(path, admission);
      try {
        return {
          ...summary,
          ...(await writeSuzukiRecoveryPlan(database, plan)),
        };
      } finally {
        await database.close();
      }
    });
  } finally {
    await admission.close();
    await runtime.release();
  }
}
