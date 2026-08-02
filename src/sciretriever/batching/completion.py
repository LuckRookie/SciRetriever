from __future__ import annotations

from dataclasses import dataclass
from uuid import NAMESPACE_URL, UUID, uuid5

from sciretriever.content.analysis import analysis_bytes
from sciretriever.content.ports import ArtifactStorePort
from sciretriever.core.execution import validate_target_alignment
from sciretriever.core.literature.acceptance import validate_completion_submission_contract
from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    parse_canonical_json,
)
from sciretriever.model.analysis import AnalysisProposalV1
from sciretriever.model.assets import ArtifactKind, StagedArtifact
from sciretriever.model.execution import TargetProjection
from sciretriever.model.literature import (
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
)
from sciretriever.model.primitives import (
    AnalysisArtifactId,
    AssetId,
    LightDocumentId,
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    WorkVersionId,
    sha256_digest,
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
    validate_target_alignment(target, context.work_version_id)
    proposal_bytes = analysis_bytes(proposal)
    proposal_hash = sha256_digest(proposal_bytes)
    staged = StagedArtifact(
        kind=ArtifactKind.ANALYSIS,
        path=RelativeArtifactPath(f"analysis/{str(proposal_hash)[:2]}/{proposal_hash}"),
        sha256=proposal_hash,
        content=proposal_bytes,
    )
    published = artifact_store.publish(staged)
    identity = "\0".join(
        (
            str(context.work_version_id),
            str(context.light_document_id),
            str(context.light_document_sha256),
            str(proposal_hash),
        )
    )
    proposal_value = _object(proposal_bytes, "proposal")
    provenance_value = CanonicalJsonObject(
        (
            ("input_sha256", str(context.light_document_sha256)),
            ("model_identity", context.model_identity),
            ("model_provider", context.model_provider),
            ("parameters_sha256", str(context.parameters_sha256)),
            ("parser_identity", context.parser_identity),
        )
    )
    provenance = CompletionProvenance(
        parser_identity=context.parser_identity,
        model_provider=context.model_provider,
        model_identity=context.model_identity,
        input_sha256=context.light_document_sha256,
        parameters_sha256=context.parameters_sha256,
        evidence=provenance_value,
    )
    analysis = CompletionAnalysisFact(
        work_version_id=context.work_version_id,
        light_document_id=context.light_document_id,
        input_sha256=context.light_document_sha256,
        analysis_id=AnalysisArtifactId(_uuid(f"analysis\0{identity}")),
        artifact_id=AssetId(_uuid(f"artifact\0analysis\0{proposal_hash}")),
        artifact_path=published.path,
        artifact_sha256=published.sha256,
        artifact_size=published.size,
        proposal=proposal_value,
    )
    final_values = _object(
        proposal.final_bibliography.model_dump_json().encode("utf-8"), "final_bibliography"
    )
    final_revision = context.metadata_revision + 1
    final_metadata = FinalMetadataFact(
        work_version_id=context.work_version_id,
        expected_snapshot_id=context.metadata_snapshot_id,
        expected_revision=context.metadata_revision,
        expected_sha256=context.metadata_sha256,
        snapshot_id=MetadataSnapshotId(_uuid(f"metadata\0{identity}")),
        revision=final_revision,
        sha256=metadata_snapshot_sha256(final_revision, final_values, provenance_value),
        values=final_values,
        provenance=provenance_value,
    )
    reference_set_id = ReferenceSetId(_uuid(f"references\0{identity}"))
    reference_members = tuple(
        ReferenceMemberFact(
            member_id=ReferenceMemberId(
                str(
                    uuid5(
                        UUID(str(reference_set_id)),
                        f"{ordinal}\0{reference.reference_id}",
                    )
                )
            ),
            raw_text=reference.raw_text,
            reference=_object(reference.model_dump_json().encode("utf-8"), "reference"),
            target_work_id=reference.resolved_work_id,
            target_work_version_id=reference.resolved_work_version_id,
        )
        for ordinal, reference in enumerate(proposal.references)
    )
    references = ReferenceSetFact(
        set_id=reference_set_id,
        work_version_id=context.work_version_id,
        revision=final_revision,
        members=reference_members,
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
            member_id=TagMemberId(_uuid(f"tag\0{identity}\0{key}")),
            name=spellings[key],
            evidence=CanonicalJsonObject(
                (
                    ("origins", tuple(sorted(origins[key]))),
                    ("source", "analysis-proposal"),
                )
            ),
        )
        for key in sorted(spellings, key=lambda item: (item, spellings[item]))
    )
    tags = TagSetFact(
        set_id=TagSetId(_uuid(f"tags\0{identity}")),
        work_version_id=context.work_version_id,
        revision=final_revision,
        members=tag_members,
    )
    submission = CompletionSubmission(
        work_version_id=context.work_version_id,
        light_document_id=context.light_document_id,
        light_document_sha256=context.light_document_sha256,
        analysis=analysis,
        metadata=final_metadata,
        references=references,
        tags=tags,
        provenance=provenance,
    )
    validate_completion_submission_contract(submission)
    return submission


__all__ = ("CompletionContext", "complete_analysis")
