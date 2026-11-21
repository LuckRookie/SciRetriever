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
import type { CitationProgress } from "../storage/sqlite/citation-progress.js";
import type { DiscoveryPublication } from "../storage/sqlite/worker.js";

export type CitationCause = DiscoveryPublication["citation_causes"][number];
export type CitationItem = Extract<MetadataScanEvent, { kind: "item" }>;
export interface CitationProviderState {
  readonly provider_name: string;
  readonly scan_limit: number | null;
  raw_item_count: number;
  attempted: boolean;
  terminal: "SCAN_LIMIT_REACHED" | "FAILED" | null;
  failure: StableFailure | null;
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
  readonly closed: "COMPLETED" | "PARTIAL" | "FAILED" | null;
}

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

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
    ![null, "COMPLETED", "PARTIAL", "FAILED"].includes(row.closed)
  )
    throw invalid();
  parseIntakeBatchId(row.batch_id);
  if (row.source_id !== null) parseLiteratureId(row.source_id);
  if (row.active_query !== null) {
    const query = row.active_query;
    if (
      !query ||
      typeof query.returnedRelations !== "boolean" ||
      typeof query.incomplete !== "boolean" ||
      !nonnegative(query.usableRelations)
    )
      throw invalid();
    if (query.failure !== null) parseStableFailure(query.failure);
    if (query.pending_item !== null) {
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
  }
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

/** A cause is enqueued at its first committed occurrence in event order. */
export async function restoreCitationProgress(
  source: Pick<MetadataSourceRun, "checkpoints">,
  resume: CitationCheckpoint | undefined,
  through: number,
  progress: CitationProgress,
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
      progress.record(
        checkpoint.causes,
        checkpoint.checked ? checkpoint.source_id : null,
        !resume.checked &&
          resume.active_query &&
          checkpoint.source_id === resume.source_id &&
          checkpoint.raw_provider === resume.next_provider
          ? checkpoint.raw_items
          : [],
      );
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
