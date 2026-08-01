from __future__ import annotations

from dataclasses import dataclass
from uuid import NAMESPACE_URL, UUID, uuid5

from sciretriever.batching.publisher_contracts import TargetProjection
from sciretriever.bibliography.api import (
    CompletionAnalysisFact,
    CompletionProvenance,
    CompletionSubmission,
    FinalMetadataFact,
    ReferenceMemberFact,
    ReferenceMemberId,
    ReferenceSetFact,
    ReferenceSetId,
    TagMemberFact,
    TagMemberId,
    TagSetFact,
    TagSetId,
    metadata_snapshot_sha256,
)
from sciretriever.content.api import (
    AnalysisProposalV1, ArtifactKind, ArtifactStorePort, StagedArtifact,
)
from sciretriever.kernel import (
    AnalysisArtifactId,
    AssetId,
    BoundaryError,
    CanonicalJsonObject,
    LightDocumentId,
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    WorkId,
    WorkVersionId,
    parse_canonical_json,
)


@dataclass(frozen=True, slots=True)
class CompletionContext:
    work_version_id: WorkVersionId
    light_document_id: LightDocumentId
    light_document_sha256: Sha256
    metadata_snapshot_id: MetadataSnapshotId
    metadata_revision: int
    metadata_sha256: Sha256
    parser_identity: str
    model_provider: str
    model_identity: str
    parameters_sha256: Sha256


def _object(payload: bytes, field: str) -> CanonicalJsonObject:
    value = parse_canonical_json(payload.decode("ascii"))
    if not isinstance(value, CanonicalJsonObject):
        raise BoundaryError.for_field(field, "must be a canonical JSON object")
    return value


def _uuid(name: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"urn:sciretriever:completion:v1:{name}"))


def complete_analysis(
    proposal: AnalysisProposalV1,
    context: CompletionContext,
    target: TargetProjection,
    artifact_store: ArtifactStorePort,
) -> CompletionSubmission:
    if target.work_version_id != context.work_version_id:
        raise BoundaryError.for_field("target", "must share the completion WorkVersion")
    proposal_bytes = proposal.canonical_bytes()
    proposal_hash = Sha256.from_bytes(proposal_bytes)
    staged = StagedArtifact(
        ArtifactKind.ANALYSIS,
        RelativeArtifactPath(f"analysis/{str(proposal_hash)[:2]}/{proposal_hash}"),
        proposal_hash,
        proposal_bytes,
    )
    published = artifact_store.publish(staged)
    identity = "\0".join((
        str(context.work_version_id), str(context.light_document_id),
        str(context.light_document_sha256), str(proposal_hash),
    ))
    proposal_value = _object(proposal_bytes, "proposal")
    provenance_value = CanonicalJsonObject((
        ("input_sha256", str(context.light_document_sha256)),
        ("model_identity", context.model_identity),
        ("model_provider", context.model_provider),
        ("parameters_sha256", str(context.parameters_sha256)),
        ("parser_identity", context.parser_identity),
    ))
    provenance = CompletionProvenance(
        context.parser_identity, context.model_provider, context.model_identity,
        context.light_document_sha256, context.parameters_sha256, provenance_value,
    )
    analysis = CompletionAnalysisFact(
        context.work_version_id, context.light_document_id,
        context.light_document_sha256, AnalysisArtifactId(_uuid(f"analysis\0{identity}")),
        AssetId(_uuid(f"artifact\0analysis\0{proposal_hash}")), published.path,
        published.sha256, published.size, proposal_value,
    )
    final_values = _object(
        proposal.final_bibliography.model_dump_json().encode("utf-8"), "final_bibliography"
    )
    final_revision = context.metadata_revision + 1
    final_metadata = FinalMetadataFact(
        context.work_version_id, context.metadata_snapshot_id,
        context.metadata_revision, context.metadata_sha256,
        MetadataSnapshotId(_uuid(f"metadata\0{identity}")), final_revision,
        metadata_snapshot_sha256(final_revision, final_values, provenance_value),
        final_values, provenance_value,
    )
    reference_set_id = ReferenceSetId(_uuid(f"references\0{identity}"))
    reference_members = tuple(
        ReferenceMemberFact(
            ReferenceMemberId(str(uuid5(
                UUID(str(reference_set_id)),
                f"{ordinal}\0{reference.reference_id}",
            ))), reference.raw_text,
            _object(reference.model_dump_json().encode("utf-8"), "reference"),
            None if reference.resolved_work_id is None else WorkId(reference.resolved_work_id),
            None if reference.resolved_work_version_id is None else WorkVersionId(reference.resolved_work_version_id),
        )
        for ordinal, reference in enumerate(proposal.references)
    )
    references = ReferenceSetFact(
        reference_set_id, context.work_version_id,
        final_revision, reference_members,
    )
    origins: dict[str, set[str]] = {}
    spellings: dict[str, str] = {}
    for origin, values in (
        ("keyword", proposal.keywords_and_tags.keywords),
        ("tag", proposal.keywords_and_tags.tags),
    ):
        for value in values:
            key = value.casefold()
            origins.setdefault(key, set()).add(origin)
            spellings.setdefault(key, value)
    tag_members = tuple(
        TagMemberFact(
            TagMemberId(_uuid(f"tag\0{identity}\0{key}")), spellings[key],
            CanonicalJsonObject((
                ("origins", tuple(sorted(origins[key]))),
                ("source", "analysis-proposal"),
            )),
        )
        for key in sorted(spellings, key=lambda item: (item, spellings[item]))
    )
    tags = TagSetFact(
        TagSetId(_uuid(f"tags\0{identity}")), context.work_version_id,
        final_revision, tag_members,
    )
    return CompletionSubmission(
        context.work_version_id, context.light_document_id,
        context.light_document_sha256, analysis, final_metadata, references, tags,
        provenance,
    )


__all__ = ("CompletionContext", "complete_analysis")
