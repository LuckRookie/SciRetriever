import {
  annotationRecord,
  parseLiteratureId,
  parseAssetId,
} from "@sciretriever/contracts";
import { SqliteDocumentStorage } from "../document/storage.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import {
  LiteratureMetadataService,
  missingArchiveMetadata,
} from "./metadata-service.js";
import { adjudicateMetadataFields } from "./metadata-fields.js";
import { metadataObservationCandidates } from "./metadata-rules.js";
import {
  validateMetadataProposals,
  type MetadataFragment,
} from "./metadata-proposals.js";
import type { dshMetadataProposer } from "./metadata-agent.js";

/** Internal archive step. It reads only the corrected main document and never starts parsing. */
export class ArchiveMetadataService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly metadata: LiteratureMetadataService,
    private readonly documents: SqliteDocumentStorage,
    private readonly annotations: SqliteAnnotationStorage,
    private readonly proposer: ReturnType<typeof dshMetadataProposer>,
  ) {}
  async build(value: unknown, signal?: AbortSignal) {
    const r = annotationRecord(value, [
      "literature_id",
      "document_version_id",
      "annotation_id",
      "expected_revision",
    ]);
    const literatureId = parseLiteratureId(r.literature_id),
      document = parseAssetId(r.document_version_id);
    if (
      typeof r.annotation_id !== "string" ||
      !r.annotation_id.match(/^[a-f0-9]{64}$/u)
    )
      throw new Error("metadata-annotation-invalid");
    const current = await this.metadata.read(literatureId, signal);
    if (r.expected_revision !== current.metadata_revision)
      throw new Error("metadata-revision-stale");
    const snapshot = await this.database.documentVersion(document);
    if (
      !snapshot ||
      snapshot.version.schema_version !== 2 ||
      snapshot.version.source_material_ref.literature_id !== literatureId ||
      !snapshot.is_default ||
      snapshot.default_revision === null
    )
      throw new Error("metadata-default-proofread-required");
    const primary = (await this.database.currentFacts(literatureId))
      ?.primary_asset;
    if (primary?.asset_id !== snapshot.version.source_material_ref.asset_id)
      throw new Error("metadata-main-part-required");
    const annotation = await this.annotations.byId(r.annotation_id, signal);
    if (
      !annotation ||
      annotation.document_version_id !== document ||
      annotation.part !== "main"
    )
      throw new Error("metadata-annotation-invalid");
    if (!this.proposer) throw new Error("metadata-model-unavailable");
    const proposer = this.proposer;
    const result = await this.documents.withVerifiedDocument(
      document,
      async (version, markdown, structure) => {
        if (version.schema_version !== 2 || structure.schema_version !== 2)
          throw new Error("metadata-proofread-required");
        const roles = new Map(
          annotation.segment_roles.map((s) => [s.segment_id, s.role]),
        );
        const fragments: MetadataFragment[] = structure.segments
          .filter(
            (s) =>
              s.page === 0 ||
              ["front-matter", "abstract", "keywords"].includes(
                roles.get(s.segment_id) ?? "",
              ),
          )
          .map((s) => ({
            fragment_id: s.segment_id,
            page: s.page + 1,
            role: roles.get(s.segment_id) ?? "body",
            text: new TextDecoder("utf8", { fatal: true }).decode(
              markdown.subarray(s.start_utf8, s.end_utf8),
            ),
          }));
        if (!fragments.length) throw new Error("metadata-fragments-missing");
        if (
          fragments.length > 512 ||
          Buffer.byteLength(JSON.stringify(fragments), "utf8") > 256 * 1024
        )
          throw new Error("metadata-input-limit");
        const response = await proposer.propose(fragments, signal);
        return {
          ...validateMetadataProposals(response.value, document, fragments),
          usage: response.usage,
          model: response.model,
        };
      },
      signal,
    );
    const resolved = adjudicateMetadataFields({
      current: current.literature.metadata,
      states: current.field_states,
      candidates: [
        ...metadataObservationCandidates(current.observations),
        ...result.candidates,
      ],
    });
    await this.metadata.publish(current, resolved, null, signal, {
      literature_id: literatureId,
      document_version_id: document,
      default_revision: snapshot.default_revision,
      annotation_id: annotation.annotation_id,
    });
    const missing = missingArchiveMetadata(resolved.metadata);
    return {
      status: missing.length ? ("failed" as const) : ("completed" as const),
      metadata_revision: current.metadata_revision + 1,
      missing,
      discarded: result.discarded,
      usage: result.usage,
      model: result.model,
    };
  }
}
