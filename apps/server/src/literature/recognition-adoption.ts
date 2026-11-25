import { createHash } from "node:crypto";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { LiteratureIdentityService } from "./identity.js";
import { LiteratureMetadataService } from "./metadata-service.js";
import { adjudicateMetadataFields } from "./metadata-fields.js";
import type { RecognitionResult } from "./intake-recognition.js";

/** The user source record a later recognition leaves on the literature. */
export interface RecognitionRecord {
  readonly source_name: "post-parse-recognition" | "file-recognition";
  /** Prefix of the deterministic observation ID. */
  readonly observation_prefix: string;
  /** The input the clues came from (a raw parse, a stored PDF asset). */
  readonly source_record_id: string;
  readonly input_sha256: string;
  /** Title used when the result carries none. */
  readonly title: string;
}
export type RecognitionAdoption =
  | { readonly status: "conflict"; readonly reason: string }
  | {
      readonly status: "adopted";
      readonly recognized: boolean;
      readonly title_changed: boolean;
    };

/**
 * Adopts one 6.4.6 result for a marked literature, as 8.4 describes: an
 * identified observation goes through identity first; a user source record
 * with the identifiers and title follows (manual locks still win); the mark
 * is cleared only when the paper was identified.
 */
export async function adoptRecognition(
  database: SqliteWorker,
  identity: LiteratureIdentityService,
  literatureId: string,
  result: RecognitionResult,
  record: RecognitionRecord,
  signal?: AbortSignal,
): Promise<RecognitionAdoption> {
  if (result.observation) {
    const accepted = await identity.observe(result.observation, {
      target_literature_id: literatureId,
    });
    if (accepted.disposition !== "accepted")
      return { status: "conflict", reason: accepted.reason };
  }
  const service = new LiteratureMetadataService(database),
    current = await service.read(literatureId, signal);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        literatureId,
        record.source_record_id,
        result.metadata.title,
        result.metadata.identifiers,
      ]),
    )
    .digest("hex");
  const observationId = `${record.observation_prefix}-${digest}`;
  const observation = parseMetadataObservation({
    observation_id: observationId,
    metadata: {
      ...EMPTY_METADATA,
      title: result.metadata.title ?? record.title,
      identifiers: result.metadata.identifiers,
    },
    provenance: {
      provenance_id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`,
      source_kind: "user",
      source_name: record.source_name,
      source_record_id: record.source_record_id,
      observed_at:
        (await database.getObservation(observationId))?.provenance
          .observed_at ?? new Date().toISOString(),
      input_sha256: record.input_sha256,
      parameters_sha256: null,
    },
    source_type: null,
    source_type_mapping_version: null,
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
  const resolved = adjudicateMetadataFields({
    current: current.literature.metadata,
    states: current.field_states,
    candidates: [
      {
        field: "title",
        value: observation.metadata.title,
        evidence: {
          source: "manual",
          observation_id: observation.observation_id,
          provenance: observation.provenance,
        },
      },
    ],
  });
  await service.publish(current, resolved, observation, signal);
  const recognized = result.recognition.state === "recognized";
  if (recognized)
    await database.run({
      kind: "import_write",
      action: {
        op: "items-write",
        action: {
          kind: "needs",
          literature_id: literatureId,
          needed: false,
          batch_id: null,
          now: new Date().toISOString(),
        },
      },
    });
  return {
    status: "adopted",
    recognized,
    title_changed:
      resolved.metadata.title !== current.literature.metadata.title,
  };
}
