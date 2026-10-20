import {
  annotationRecord,
  parseAssetId,
  parseLiteratureId,
} from "@sciretriever/contracts";
import type {
  SqliteWorker,
  IdentityReadContext,
} from "../storage/sqlite/worker.js";
import type { ArchiveReferencePublication } from "../storage/sqlite/archive-reference-engine.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
  stableIdentifierKeys,
} from "./identity-rules.js";
import {
  referenceIdentityMetadata,
  matchArchiveReference,
} from "./reference-matching.js";
export class ArchiveReferenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Literature owns matching; Storage atomically validates its fixed inputs and publishes relation supports. */
export class ArchiveReferenceService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly annotations: SqliteAnnotationStorage,
  ) {}
  async build(value: unknown, signal?: AbortSignal) {
    const r = annotationRecord(value, [
      "literature_id",
      "document_version_id",
      "annotation_id",
    ]);
    const source = parseLiteratureId(r.literature_id),
      document = parseAssetId(r.document_version_id);
    if (
      typeof r.annotation_id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(r.annotation_id)
    )
      throw new ArchiveReferenceError("archive-reference-invalid");
    const snapshot = await this.database.documentVersion(document);
    if (
      !snapshot ||
      snapshot.version.schema_version !== 2 ||
      snapshot.version.source_material_ref.literature_id !== source ||
      !snapshot.is_default ||
      snapshot.default_revision === null
    )
      throw new ArchiveReferenceError("archive-reference-default-required");
    const annotation = await this.annotations.byId(r.annotation_id, signal);
    if (
      !annotation ||
      annotation.document_version_id !== document ||
      annotation.part !== "main"
    )
      throw new ArchiveReferenceError("archive-reference-main-required");
    if (annotation.references.length > 10000)
      throw new ArchiveReferenceError("archive-reference-limit");
    const links: ArchiveReferencePublication["links"][number][] = [],
      unmatched: { reference_index: number; reason: string }[] = [];
    const cache = new Map<string, IdentityReadContext>();
    for (const reference of annotation.references) {
      if (signal?.aborted)
        throw new ArchiveReferenceError("archive-reference-cancelled");
      const metadata = referenceIdentityMetadata(reference);
      if (!metadata) {
        unmatched.push({
          reference_index: reference.reference_index,
          reason: "reference-identity-incomplete",
        });
        continue;
      }
      const stable = stableIdentifierKeys(metadata),
        fallback = stable.length ? null : fallbackIdentityKey(metadata),
        hash = fallback ? await fallbackIdentitySha256(fallback) : null;
      const key = JSON.stringify({ stable, hash });
      let context = cache.get(key);
      if (!context) {
        context = await this.database.readIdentity({
          observation_id: `archive-reference-read:${document}:${reference.reference_index}`,
          provider_record_key: null,
          stable_identifier_keys: stable,
          fallback_identity_sha256: hash,
          user_observation_semantic_sha256: null,
          version_link_keys: [],
        });
        cache.set(key, context);
      }
      const match = matchArchiveReference(
        source,
        reference,
        context.literatures,
      );
      if (!match.target) {
        unmatched.push({
          reference_index: reference.reference_index,
          reason: match.reason,
        });
        continue;
      }
      const target = context.facts.find(
        (f) => f.literature.literature_id === match.target!.literature_id,
      );
      if (!target)
        throw new ArchiveReferenceError("archive-reference-target-missing");
      links.push({
        reference,
        target_literature_id: match.target.literature_id,
        target_metadata_revision: target.metadata_revision,
        target_metadata_sha256: target.metadata_sha256,
        basis: match.basis,
      });
    }
    const result = await this.database.run<{ linked: number }>(
      {
        kind: "archive_reference_publish",
        publication: {
          literature_id: source,
          document_version_id: document,
          annotation_id: annotation.annotation_id,
          expected_default_revision: snapshot.default_revision,
          links,
        },
      },
      signal,
    );
    return {
      document_version_id: document,
      annotation_id: annotation.annotation_id,
      total: annotation.references.length,
      linked: result.linked,
      unmatched,
    };
  }
}
