from __future__ import annotations

from uuid import NAMESPACE_URL, UUID, uuid5

from sciretriever.core.execution import validate_completion_target
from sciretriever.core.literature.acceptance import validate_completion_submission_contract
from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.model import analysis as analysis_models
from sciretriever.model.assets import ArtifactKind, PublishedArtifact
from sciretriever.model.canonical_json import CanonicalJsonObject, parse_canonical_json
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
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    sha256_digest,
)

from .errors import AnalysisValidationError
from .serialization import analysis_bytes


def validate_analysis_artifact(artifact: PublishedArtifact, content: bytes) -> None:
    digest = sha256_digest(content)
    expected_path = RelativeArtifactPath(f"analysis/{str(digest)[:2]}/{digest}")
    if artifact.kind is not ArtifactKind.ANALYSIS:
        raise AnalysisValidationError("analysis_artifact_kind")
    if artifact.path != expected_path:
        raise AnalysisValidationError("analysis_artifact_path")
    if artifact.sha256 != digest:
        raise AnalysisValidationError("analysis_artifact_sha256")
    if artifact.size != len(content):
        raise AnalysisValidationError("analysis_artifact_size")


def _canonical_object(payload: bytes) -> CanonicalJsonObject:
    value = parse_canonical_json(payload.decode("ascii"))
    if not isinstance(value, CanonicalJsonObject):
        raise AnalysisValidationError("analysis_invalid_object")
    return value


def _uuid(name: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"urn:sciretriever:completion:v1:{name}"))


def _identity(
    target: analysis_models.AnalysisTarget,
    proposal_hash: Sha256,
) -> str:
    return "\0".join(
        (
            str(target.work_version_id),
            str(target.light_document_id),
            str(target.light_document_sha256),
            str(proposal_hash),
        )
    )


def _provenance(target: analysis_models.AnalysisTarget) -> CompletionProvenance:
    evidence = CanonicalJsonObject(
        (
            ("input_sha256", str(target.light_document_sha256)),
            ("model_identity", target.model_identity),
            ("model_provider", target.model_provider),
            ("parameters_sha256", str(target.parameters_sha256)),
            ("parser_identity", target.parser_identity),
        )
    )
    return CompletionProvenance(
        parser_identity=target.parser_identity,
        model_provider=target.model_provider,
        model_identity=target.model_identity,
        input_sha256=target.light_document_sha256,
        parameters_sha256=target.parameters_sha256,
        evidence=evidence,
    )


def _references(
    proposal: analysis_models.AnalysisProposalV1,
    target: analysis_models.AnalysisTarget,
    revision: int,
    identity: str,
) -> ReferenceSetFact:
    set_id = ReferenceSetId(_uuid(f"references\0{identity}"))
    members = tuple(
        ReferenceMemberFact(
            member_id=ReferenceMemberId(
                str(uuid5(UUID(str(set_id)), f"{ordinal}\0{reference.reference_id}"))
            ),
            raw_text=reference.raw_text,
            reference=_canonical_object(reference.model_dump_json().encode("utf-8")),
            target_work_id=reference.resolved_work_id,
            target_work_version_id=reference.resolved_work_version_id,
        )
        for ordinal, reference in enumerate(proposal.references)
    )
    return ReferenceSetFact(
        set_id=set_id,
        work_version_id=target.work_version_id,
        revision=revision,
        members=members,
    )


def _tags(
    proposal: analysis_models.AnalysisProposalV1,
    target: analysis_models.AnalysisTarget,
    revision: int,
    identity: str,
) -> TagSetFact:
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
    members = tuple(
        TagMemberFact(
            member_id=TagMemberId(_uuid(f"tag\0{identity}\0{key}")),
            name=spellings[key],
            evidence=CanonicalJsonObject(
                (("origins", tuple(sorted(origins[key]))), ("source", "analysis-proposal"))
            ),
        )
        for key in sorted(spellings, key=lambda item: (item, spellings[item]))
    )
    return TagSetFact(
        set_id=TagSetId(_uuid(f"tags\0{identity}")),
        work_version_id=target.work_version_id,
        revision=revision,
        members=members,
    )


def assemble_completion_submission(
    proposal: analysis_models.AnalysisProposalV1,
    target: analysis_models.AnalysisTarget,
    target_projection: TargetProjection,
    artifact: PublishedArtifact,
) -> CompletionSubmission:
    validate_completion_target(target_projection, target.work_version_id)
    proposal_content = analysis_bytes(proposal)
    validate_analysis_artifact(artifact, proposal_content)
    proposal_hash = sha256_digest(proposal_content)
    identity = _identity(target, proposal_hash)
    provenance = _provenance(target)
    analysis = CompletionAnalysisFact(
        work_version_id=target.work_version_id,
        light_document_id=target.light_document_id,
        input_sha256=target.light_document_sha256,
        analysis_id=AnalysisArtifactId(_uuid(f"analysis\0{identity}")),
        artifact_id=AssetId(_uuid(f"artifact\0analysis\0{proposal_hash}")),
        artifact_path=artifact.path,
        artifact_sha256=artifact.sha256,
        artifact_size=artifact.size,
        proposal=_canonical_object(proposal_content),
    )
    final_values = _canonical_object(proposal.final_bibliography.model_dump_json().encode("utf-8"))
    final_revision = target.metadata_revision + 1
    metadata = FinalMetadataFact(
        work_version_id=target.work_version_id,
        expected_snapshot_id=target.metadata_snapshot_id,
        expected_revision=target.metadata_revision,
        expected_sha256=target.metadata_sha256,
        snapshot_id=MetadataSnapshotId(_uuid(f"metadata\0{identity}")),
        revision=final_revision,
        sha256=metadata_snapshot_sha256(final_revision, final_values, provenance.evidence),
        values=final_values,
        provenance=provenance.evidence,
    )
    submission = CompletionSubmission(
        work_version_id=target.work_version_id,
        light_document_id=target.light_document_id,
        light_document_sha256=target.light_document_sha256,
        analysis=analysis,
        metadata=metadata,
        references=_references(proposal, target, final_revision, identity),
        tags=_tags(proposal, target, final_revision, identity),
        provenance=provenance,
    )
    validate_completion_submission_contract(submission)
    return submission


__all__ = (
    "assemble_completion_submission",
    "validate_analysis_artifact",
)
