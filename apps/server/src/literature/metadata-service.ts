import { randomUUID } from "node:crypto";
import {
  EMPTY_METADATA,
  canonicalJsonBytes,
  parseLiteratureId,
  parseMetadataField,
  parseMetadataFieldCandidate,
  parseMetadataObservation,
  parseMetadataEditRequest,
  sha256,
  type Literature,
  type MetadataFieldCandidate,
  type MetadataFieldState,
  type LiteratureMetadata,
  type MetadataObservation,
} from "@sciretriever/contracts";
import type {
  SqliteWorker,
  IdentityPublicationCommand,
} from "../storage/sqlite/worker.js";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
  stableIdentifierKeys,
} from "./identity-rules.js";
import { adjudicateMetadataFields } from "./metadata-fields.js";
import { userObservationSemanticSha256 } from "./metadata-rules.js";

export class MetadataFieldError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface MetadataFieldSnapshot {
  readonly literature: Literature;
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly field_states: readonly MetadataFieldState[];
  readonly observations: readonly MetadataObservation[];
}
export class LiteratureMetadataService {
  constructor(private readonly database: SqliteWorker) {}
  async read(
    literatureId: string,
    signal?: AbortSignal,
  ): Promise<MetadataFieldSnapshot> {
    const id = parseLiteratureId(literatureId);
    const result = await this.database.run<MetadataFieldSnapshot | null>(
      { kind: "metadata_fields_read", literatureId: id },
      signal,
    );
    if (!result) throw new MetadataFieldError("metadata-literature-missing");
    return result;
  }
  async edit(value: unknown, signal?: AbortSignal) {
    const input = parseMetadataEditRequest(value);
    const current = await this.read(input.literature_id, signal);
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision !== current.metadata_revision
    )
      throw new MetadataFieldError("metadata-revision-stale");
    if (
      !Array.isArray(input.set) ||
      !Array.isArray(input.unlock) ||
      input.set.length + input.unlock.length === 0
    )
      throw new MetadataFieldError("metadata-edit-empty");
    const fields = input.set.map((s) => parseMetadataField(s.field)),
      unlock = input.unlock.map(parseMetadataField);
    if (new Set([...fields, ...unlock]).size !== fields.length + unlock.length)
      throw new MetadataFieldError("metadata-edit-duplicate-field");
    let observation: MetadataObservation | null = null;
    let manual: readonly MetadataFieldCandidate[] = [];
    if (fields.length) {
      observation = parseMetadataObservation({
        observation_id: randomUUID(),
        source_type: null,
        source_type_mapping_version: null,
        metadata: {
          ...EMPTY_METADATA,
          ...Object.fromEntries(input.set.map((s) => [s.field, s.value])),
        },
        provenance: {
          provenance_id: randomUUID(),
          source_kind: "user",
          source_name: "manual-metadata",
          source_record_id: null,
          observed_at: new Date().toISOString(),
          input_sha256: null,
          parameters_sha256: null,
        },
        version_role: null,
        version_links: [],
        declared_keywords: [],
        reference_texts: [],
        reference_count: null,
        cited_by_count: null,
        asset_hints: [],
      });
      const evidence = {
        source: "manual" as const,
        observation_id: observation.observation_id,
        provenance: observation.provenance,
      };
      manual = input.set.map((s) =>
        parseMetadataFieldCandidate({ ...s, evidence }),
      );
    }
    const resolved = adjudicateMetadataFields({
      current: current.literature.metadata,
      states: current.field_states,
      candidates: [],
      manual,
      unlock,
      preserve_nonempty: true,
    });
    await this.publish(current, resolved, observation, signal);
    return this.read(input.literature_id, signal);
  }
  async publish(
    current: MetadataFieldSnapshot,
    resolved: {
      readonly metadata: LiteratureMetadata;
      readonly states: readonly MetadataFieldState[];
    },
    observation: MetadataObservation | null,
    signal?: AbortSignal,
    condition?: IdentityPublicationCommand["document_condition"],
  ): Promise<void> {
    if (signal?.aborted) throw new MetadataFieldError("metadata-cancelled");
    const metadata = resolved.metadata;
    const key = stableIdentifierKeys(metadata).length
      ? null
      : fallbackIdentityKey(metadata);
    // The existing identity publication owns metadata, its indexes and observation links in one CAS transaction.
    await this.database.run(
      {
        kind: "publish_identity_observation",
        publication: {
          ...(condition ? { document_condition: condition } : {}),
          literatures: [
            {
              literature: { ...current.literature, metadata },
              metadata_revision: current.metadata_revision + 1,
              metadata_sha256: await sha256(canonicalJsonBytes(metadata)),
              fallback_identity_sha256: key
                ? await fallbackIdentitySha256(key)
                : null,
              field_states: resolved.states,
            },
          ],
          meta_literatures: [],
          observation: observation
            ? {
                literature_id: current.literature.literature_id,
                observation,
                user_semantic_sha256:
                  await userObservationSemanticSha256(observation),
              }
            : null,
          expected_literatures: [
            {
              literature_id: current.literature.literature_id,
              meta_literature_id: current.literature.meta_literature_id,
              metadata_revision: current.metadata_revision,
              metadata_sha256: current.metadata_sha256,
            },
          ],
          expected_meta_literatures: [],
          retired_meta_literature_ids: [],
          clear_automatic_pdf_exhaustion_for: [],
        },
      },
      signal,
    );
  }
}
export function missingArchiveMetadata(
  metadata: LiteratureMetadata,
): readonly string[] {
  return (
    [
      "title",
      "authors",
      "publication_year",
      "publication_form",
      "article_kind",
    ] as const
  )
    .filter(
      (field) =>
        metadata[field] === null ||
        (Array.isArray(metadata[field]) && metadata[field].length === 0),
    )
    .map((field) => `metadata-missing:${field}`);
}
