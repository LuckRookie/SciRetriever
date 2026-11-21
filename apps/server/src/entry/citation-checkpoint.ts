import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  parseIntakeBatchId,
  parseLiteratureId,
  parseMetaLiteratureId,
  parseStableFailure,
  type IntakeBatchId,
  type MetadataObservation,
  type StableFailure,
} from "@sciretriever/contracts";
import type { MetadataScanEvent } from "../metadata/ports.js";
import type { MetadataSourceRun } from "../application/jobs/metadata-progress.js";
import type {
  CitationDeferredChanges,
  CitationDeferredEntry,
  CitationProgress,
} from "../storage/sqlite/citation-progress.js";
import type { DiscoveryPublication } from "../storage/sqlite/worker.js";
import {
  isCitationRateLimit,
  MAX_CITATION_RETRIES,
} from "./citation-cooldown.js";

export type CitationCause = DiscoveryPublication["citation_causes"][number];
export type CitationItem = Extract<MetadataScanEvent, { kind: "item" }>;
export interface CitationProviderState {
  readonly provider_name: string;
  readonly scan_limit: number | null;
  raw_item_count: number;
  attempted: boolean;
  terminal: "SCAN_LIMIT_REACHED" | "FAILED" | null;
  failure: StableFailure | null;
  cooldown?: {
    readonly retries: number;
    /** Null means disabled. An absent deadline retains the count after a different failure. */
    readonly until?: number | null;
    readonly failure: StableFailure;
  };
}
export interface CitationQueryProgress {
  failure: StableFailure | null;
  returnedRelations: boolean;
  usableRelations: number;
  incomplete: boolean;
  pending_item: CitationPendingItem | null;
}
type SourceIdentity = readonly [
  id: string,
  provenance: MetadataObservation["provenance"]["provenance_id"],
  observedAt: string,
];
export interface CitationPendingItem {
  readonly key: string;
  readonly next_relation: number;
  readonly observations: readonly SourceIdentity[];
  readonly relations: readonly SourceIdentity[];
}

type DeferredAnchor = CitationDeferredEntry & {
  readonly source_id: string;
  readonly depth: number;
};
export type DeferredReference = DeferredAnchor & {
  readonly kind: "reference-query";
  readonly active_query: CitationQueryProgress | null;
};
export type DeferredLookup = DeferredAnchor & {
  readonly kind: "lookup";
  readonly relation_id: string;
  readonly reference_provider: string;
  readonly outgoing: boolean;
  readonly unresolved: boolean;
};
export type CitationDeferredWork = DeferredReference | DeferredLookup;

export function referenceQueryId(sourceId: string, provider: string) {
  return JSON.stringify(["reference-query", sourceId, provider]);
}

export interface CitationCheckpoint {
  readonly version: 1;
  readonly run_id: string;
  readonly batch_id: IntakeBatchId;
  readonly started_at: string;
  readonly source_id: string | null;
  readonly checked: boolean;
  readonly next_provider: number;
  readonly active_query: CitationQueryProgress | null;
  readonly raw_provider: number;
  readonly raw_items: readonly string[];
  readonly causes: readonly CitationCause[];
  readonly providers: readonly CitationProviderState[];
  readonly deferred?: CitationDeferredChanges<CitationDeferredWork>;
  readonly closed: "COMPLETED" | "PARTIAL" | "FAILED" | null;
}

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validateQuery(query: CitationQueryProgress | null) {
  const invalid = () => new Error("invalid citation checkpoint");
  if (query === null) return;
  if (
    !query ||
    typeof query.returnedRelations !== "boolean" ||
    typeof query.incomplete !== "boolean" ||
    !nonnegative(query.usableRelations)
  )
    throw invalid();
  if (query.failure !== null) parseStableFailure(query.failure);
  if (query.pending_item === null) return;
  const pending = query.pending_item;
  const validIdentities = (value: readonly SourceIdentity[]) =>
    Array.isArray(value) &&
    value.every(
      (identity) =>
        Array.isArray(identity) &&
        identity.length === 3 &&
        identity.every(
          (field) => typeof field === "string" && field.length > 0,
        ),
    );
  if (
    !pending ||
    !/^[a-f0-9]{64}$/u.test(pending.key) ||
    !nonnegative(pending.next_relation) ||
    !validIdentities(pending.observations) ||
    !validIdentities(pending.relations) ||
    pending.next_relation >= pending.relations.length
  )
    throw invalid();
}

export function parseCitationCheckpoint(input: unknown): CitationCheckpoint {
  const invalid = () => new Error("invalid citation checkpoint");
  if (!input || typeof input !== "object") throw invalid();
  const row = input as CitationCheckpoint;
  if (
    row.version !== 1 ||
    typeof row.run_id !== "string" ||
    !row.run_id ||
    typeof row.started_at !== "string" ||
    !Number.isFinite(Date.parse(row.started_at)) ||
    typeof row.checked !== "boolean" ||
    !nonnegative(row.next_provider) ||
    !Number.isSafeInteger(row.raw_provider) ||
    row.raw_provider < -1 ||
    !Array.isArray(row.raw_items) ||
    !row.raw_items.every(
      (item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item),
    ) ||
    !Array.isArray(row.causes) ||
    !Array.isArray(row.providers) ||
    row.raw_provider >= row.providers.length ||
    ![null, "COMPLETED", "PARTIAL", "FAILED"].includes(row.closed)
  )
    throw invalid();
  parseIntakeBatchId(row.batch_id);
  if (row.source_id !== null) parseLiteratureId(row.source_id);
  validateQuery(row.active_query);
  for (const state of row.providers) {
    if (
      !state ||
      typeof state.provider_name !== "string" ||
      typeof state.attempted !== "boolean" ||
      !nonnegative(state.raw_item_count) ||
      (state.scan_limit !== null &&
        (!nonnegative(state.scan_limit) ||
          state.scan_limit < 1 ||
          state.raw_item_count > state.scan_limit)) ||
      ![null, "SCAN_LIMIT_REACHED", "FAILED"].includes(state.terminal)
    )
      throw invalid();
    if (state.failure !== null) parseStableFailure(state.failure);
    if (state.cooldown !== undefined) {
      const { retries, until, failure } = state.cooldown;
      if (
        !nonnegative(retries) ||
        retries > MAX_CITATION_RETRIES ||
        (until === undefined
          ? retries === 0
          : until === null
            ? retries !== MAX_CITATION_RETRIES || state.terminal !== "FAILED"
            : !nonnegative(until) ||
              !Number.isFinite(new Date(until).getTime()) ||
              retries >= MAX_CITATION_RETRIES) ||
        !isCitationRateLimit(parseStableFailure(failure))
      )
        throw invalid();
    }
  }
  if (row.deferred !== undefined) {
    const { added, completed } = row.deferred;
    if (
      !Array.isArray(added) ||
      (completed !== null && (typeof completed !== "string" || !completed))
    )
      throw invalid();
    for (const work of added as readonly CitationDeferredWork[]) {
      if (
        !work ||
        !nonnegative(work.depth) ||
        !row.providers.some(
          (state) => state.provider_name === work.provider_name,
        )
      )
        throw invalid();
      parseLiteratureId(work.source_id);
      if (work.kind === "reference-query") {
        if (work.id !== referenceQueryId(work.source_id, work.provider_name))
          throw invalid();
        validateQuery(work.active_query);
      } else if (
        work.kind !== "lookup" ||
        typeof work.relation_id !== "string" ||
        !work.relation_id ||
        !row.providers.some(
          (state) => state.provider_name === work.reference_provider,
        ) ||
        typeof work.outgoing !== "boolean" ||
        typeof work.unresolved !== "boolean" ||
        work.id !== lookupWorkId(work.relation_id, work.provider_name)
      )
        throw invalid();
    }
  }
  for (const cause of row.causes) {
    parseMetaLiteratureId(cause.meta_literature_id);
    parseLiteratureId(cause.source_literature_id);
    parseLiteratureId(cause.target_literature_id);
    parseLiteratureId(cause.actual_literature_id);
    if (
      !nonnegative(cause.depth) ||
      cause.depth < 1 ||
      ![cause.source_literature_id, cause.target_literature_id].includes(
        cause.actual_literature_id,
      )
    )
      throw invalid();
  }
  return row;
}

export function lookupWorkId(relationId: string, provider: string) {
  return JSON.stringify(["lookup", relationId, provider]);
}

export function applyCitationCheckpoint(
  progress: CitationProgress<CitationDeferredWork>,
  checkpoint: CitationCheckpoint,
) {
  const { source_id, raw_provider, deferred } = checkpoint;
  const id =
    source_id === null || raw_provider < 0
      ? undefined
      : referenceQueryId(
          source_id,
          checkpoint.providers[raw_provider]!.provider_name,
        );
  const retain =
    checkpoint.active_query !== null ||
    deferred?.added.some((work) => work.id === id);
  progress.record(
    checkpoint.causes,
    checkpoint.checked ? source_id : null,
    deferred,
    id === undefined
      ? undefined
      : { id, items: retain ? checkpoint.raw_items : null },
  );
}

/** A cause is enqueued at its first committed occurrence in event order. */
export async function restoreCitationProgress(
  source: Pick<MetadataSourceRun, "checkpoints">,
  resume: CitationCheckpoint | undefined,
  through: number,
  progress: CitationProgress<CitationDeferredWork>,
) {
  for (let after = -1; after < through; ) {
    const page = await source.checkpoints(after, through);
    if (!page.length)
      throw new Error("citation checkpoint history is incomplete");
    for (const event of page) {
      const checkpoint = parseCitationCheckpoint(event.payload);
      if (!resume || checkpoint.run_id !== resume.run_id) continue;
      if (
        checkpoint.batch_id !== resume.batch_id ||
        checkpoint.started_at !== resume.started_at
      )
        throw new Error("citation checkpoint belongs to another run");
      applyCitationCheckpoint(progress, checkpoint);
    }
    after = page.at(-1)!.sequence;
  }
}

function stableProvenance(value: MetadataObservation["provenance"]) {
  return {
    source_kind: value.source_kind,
    source_name: value.source_name,
    source_record_id: value.source_record_id,
    input_sha256: value.input_sha256,
    parameters_sha256: value.parameters_sha256,
  };
}

/** Provider conversion can generate new UUIDs on every read of the same row. */
export function citationItemKey(event: CitationItem): string {
  return createHash("sha256")
    .update(
      canonicalJsonBytes({
        failure: event.failure,
        observations: event.item.observations.map(
          ({ provenance, ...facts }) => {
            Reflect.deleteProperty(facts, "observation_id");
            return { ...facts, provenance: stableProvenance(provenance) };
          },
        ),
        relations: event.item.relations.map(
          ({ citing, cited, provenance }) => ({
            citing,
            cited,
            provenance: stableProvenance(provenance),
          }),
        ),
      }),
    )
    .digest("hex");
}

/** A single raw response may supply many independent citation relations. */
export function pendingCitationItem(
  event: CitationItem,
  key: string,
  nextRelation: number,
): CitationPendingItem {
  const identity = (
    value: Pick<MetadataObservation, "provenance"> & { observation_id: string },
  ): SourceIdentity => [
    value.observation_id,
    value.provenance.provenance_id,
    value.provenance.observed_at,
  ];
  return {
    key,
    next_relation: nextRelation,
    observations: event.item.observations.map(identity),
    relations: event.item.relations.map(identity),
  };
}

export function restoreCitationItem(
  event: CitationItem,
  saved: CitationPendingItem,
): CitationItem {
  const { observations, relations } = event.item;
  // The matching key hashes both arrays, including their lengths. A mismatch
  // here means the saved identities cannot be paired with the item.
  if (
    observations.length !== saved.observations.length ||
    relations.length !== saved.relations.length
  )
    throw new Error("citation checkpoint item lengths do not match its key");
  const provenance = (
    current: MetadataObservation["provenance"],
    value: SourceIdentity,
  ) => ({
    ...current,
    provenance_id: value[1],
    observed_at: value[2],
  });
  return {
    ...event,
    item: {
      ...event.item,
      observations: observations.map((value, index) => {
        const identity = saved.observations[index]!;
        return {
          ...value,
          observation_id: identity[0] as MetadataObservation["observation_id"],
          provenance: provenance(value.provenance, identity),
        };
      }),
      relations: relations.map((value, index) => {
        const identity = saved.relations[index]!;
        return {
          ...value,
          observation_id: identity[0],
          provenance: provenance(value.provenance, identity),
        };
      }),
    },
  };
}
