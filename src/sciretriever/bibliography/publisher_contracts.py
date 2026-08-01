from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, unique

from sciretriever.kernel import (
    AnalysisArtifactId, AssetId, BoundaryError, CanonicalJsonObject,
    LightDocumentId, MetadataSnapshotId, RelativeArtifactPath, Sha256, WorkId,
    WorkVersionId, canonical_json_bytes,
)
from sciretriever.kernel.ids import UuidValue


@dataclass(frozen=True, slots=True)
class ReferenceSetId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class ReferenceMemberId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class TagSetId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class TagMemberId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class ReferenceMemberFact:
    member_id: ReferenceMemberId
    raw_text: str
    reference: CanonicalJsonObject
    target_work_id: WorkId | None = None
    target_work_version_id: WorkVersionId | None = None

    def __post_init__(self) -> None:
        if self.target_work_version_id is not None and self.target_work_id is None:
            raise BoundaryError.for_field(
                "target_work_version_id", "requires target_work_id"
            )


@dataclass(frozen=True, slots=True)
class TagMemberFact:
    member_id: TagMemberId
    name: str
    evidence: CanonicalJsonObject


def metadata_snapshot_bytes(
    revision: int, values: CanonicalJsonObject, provenance: CanonicalJsonObject,
) -> bytes:
    return canonical_json_bytes(CanonicalJsonObject((
        ("provenance", provenance), ("revision", revision), ("values", values),
    )))


def metadata_snapshot_sha256(
    revision: int, values: CanonicalJsonObject, provenance: CanonicalJsonObject,
) -> Sha256:
    return Sha256.from_bytes(metadata_snapshot_bytes(revision, values, provenance))


@dataclass(frozen=True, slots=True)
class ReferenceSetFact:
    set_id: ReferenceSetId
    work_version_id: WorkVersionId
    revision: int
    members: tuple[ReferenceMemberFact, ...]


@dataclass(frozen=True, slots=True)
class TagSetFact:
    set_id: TagSetId
    work_version_id: WorkVersionId
    revision: int
    members: tuple[TagMemberFact, ...]


@dataclass(frozen=True, slots=True)
class FinalMetadataFact:
    work_version_id: WorkVersionId
    expected_snapshot_id: MetadataSnapshotId
    expected_revision: int
    expected_sha256: Sha256
    snapshot_id: MetadataSnapshotId
    revision: int
    sha256: Sha256
    values: CanonicalJsonObject
    provenance: CanonicalJsonObject

    def __post_init__(self) -> None:
        if metadata_snapshot_sha256(self.revision, self.values, self.provenance) != self.sha256:
            raise BoundaryError.for_field("sha256", "must identify the complete canonical metadata snapshot")


@dataclass(frozen=True, slots=True)
class CompletionAnalysisFact:
    work_version_id: WorkVersionId
    light_document_id: LightDocumentId
    input_sha256: Sha256
    analysis_id: AnalysisArtifactId
    artifact_id: AssetId
    artifact_path: RelativeArtifactPath
    artifact_sha256: Sha256
    artifact_size: int
    proposal: CanonicalJsonObject

    def __post_init__(self) -> None:
        proposal_bytes = canonical_json_bytes(self.proposal)
        if self.artifact_sha256 != Sha256.from_bytes(proposal_bytes):
            raise BoundaryError.for_field("artifact_sha256", "must identify proposal bytes")
        if self.artifact_size != len(proposal_bytes):
            raise BoundaryError.for_field("artifact_size", "must equal proposal byte length")


@dataclass(frozen=True, slots=True)
class CompletionProvenance:
    parser_identity: str
    model_provider: str
    model_identity: str
    input_sha256: Sha256
    parameters_sha256: Sha256
    evidence: CanonicalJsonObject


@dataclass(frozen=True, slots=True)
class CompletionSubmission:
    work_version_id: WorkVersionId
    light_document_id: LightDocumentId
    light_document_sha256: Sha256
    analysis: CompletionAnalysisFact
    metadata: FinalMetadataFact
    references: ReferenceSetFact
    tags: TagSetFact
    provenance: CompletionProvenance

    def __post_init__(self) -> None:
        identities = (
            self.analysis.work_version_id, self.metadata.work_version_id,
            self.references.work_version_id, self.tags.work_version_id,
        )
        if any(value != self.work_version_id for value in identities):
            raise BoundaryError.for_field("completion", "facts must share one WorkVersion")
        if (
            self.analysis.light_document_id != self.light_document_id
            or self.analysis.input_sha256 != self.light_document_sha256
            or self.provenance.input_sha256 != self.light_document_sha256
        ):
            raise BoundaryError.for_field("completion", "analysis and provenance must share input")


def completion_submission_canonical(submission: CompletionSubmission) -> CanonicalJsonObject:
    analysis = submission.analysis
    metadata = submission.metadata
    references = submission.references
    tags = submission.tags
    provenance = submission.provenance
    return CanonicalJsonObject((
        ("work_version_id", str(submission.work_version_id)),
        ("light_document_id", str(submission.light_document_id)),
        ("light_document_sha256", str(submission.light_document_sha256)),
        ("analysis", CanonicalJsonObject((
            ("work_version_id", str(analysis.work_version_id)),
            ("light_document_id", str(analysis.light_document_id)),
            ("input_sha256", str(analysis.input_sha256)),
            ("analysis_id", str(analysis.analysis_id)),
            ("artifact_id", str(analysis.artifact_id)),
            ("artifact_path", str(analysis.artifact_path)),
            ("artifact_sha256", str(analysis.artifact_sha256)),
            ("artifact_size", analysis.artifact_size),
            ("proposal", analysis.proposal),
        ))),
        ("metadata", CanonicalJsonObject((
            ("work_version_id", str(metadata.work_version_id)),
            ("expected_snapshot_id", str(metadata.expected_snapshot_id)),
            ("expected_revision", metadata.expected_revision),
            ("expected_sha256", str(metadata.expected_sha256)),
            ("snapshot_id", str(metadata.snapshot_id)),
            ("revision", metadata.revision),
            ("sha256", str(metadata.sha256)),
            ("values", metadata.values),
            ("provenance", metadata.provenance),
        ))),
        ("references", CanonicalJsonObject((
            ("set_id", str(references.set_id)),
            ("work_version_id", str(references.work_version_id)),
            ("revision", references.revision),
            ("members", tuple(CanonicalJsonObject((
                ("member_id", str(member.member_id)),
                ("raw_text", member.raw_text),
                ("reference", member.reference),
                ("target_work_id", None if member.target_work_id is None else str(member.target_work_id)),
                ("target_work_version_id", None if member.target_work_version_id is None else str(member.target_work_version_id)),
            )) for member in references.members)),
        ))),
        ("tags", CanonicalJsonObject((
            ("set_id", str(tags.set_id)),
            ("work_version_id", str(tags.work_version_id)),
            ("revision", tags.revision),
            ("members", tuple(CanonicalJsonObject((
                ("member_id", str(member.member_id)),
                ("name", member.name),
                ("evidence", member.evidence),
            )) for member in tags.members)),
        ))),
        ("provenance", CanonicalJsonObject((
            ("parser_identity", provenance.parser_identity),
            ("model_provider", provenance.model_provider),
            ("model_identity", provenance.model_identity),
            ("input_sha256", str(provenance.input_sha256)),
            ("parameters_sha256", str(provenance.parameters_sha256)),
            ("evidence", provenance.evidence),
        ))),
    ))


@unique
class CompletionOutcome(str, Enum):
    PUBLISHED = "published"
    REPLAYED = "replayed"


__all__ = (
    "CompletionAnalysisFact", "CompletionOutcome", "CompletionProvenance",
    "CompletionSubmission", "FinalMetadataFact", "ReferenceMemberFact",
    "ReferenceMemberId", "ReferenceSetFact", "ReferenceSetId", "TagMemberFact",
    "TagMemberId", "TagSetFact", "TagSetId", "completion_submission_canonical",
    "metadata_snapshot_bytes", "metadata_snapshot_sha256",
)
