from __future__ import annotations

from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.literature import (
    CompletionAnalysisFact,
    CompletionProvenance,
    CompletionSubmission,
    FinalMetadataFact,
    ReferenceSetFact,
    TagSetFact,
)
from sciretriever.model.primitives import Sha256, sha256_digest


def metadata_snapshot_bytes(
    revision: int,
    values: CanonicalJsonObject,
    provenance: CanonicalJsonObject,
) -> bytes:
    return canonical_json_bytes(
        CanonicalJsonObject(
            (
                ("provenance", provenance),
                ("revision", revision),
                ("values", values),
            )
        )
    )


def metadata_snapshot_sha256(
    revision: int,
    values: CanonicalJsonObject,
    provenance: CanonicalJsonObject,
) -> Sha256:
    return sha256_digest(metadata_snapshot_bytes(revision, values, provenance))


def completion_analysis_bytes(analysis: CompletionAnalysisFact) -> bytes:
    return canonical_json_bytes(analysis.proposal)


def completion_analysis_sha256(analysis: CompletionAnalysisFact) -> Sha256:
    return sha256_digest(completion_analysis_bytes(analysis))


def completion_submission_canonical(submission: CompletionSubmission) -> CanonicalJsonObject:
    return CanonicalJsonObject(
        (
            ("work_version_id", str(submission.work_version_id)),
            ("light_document_id", str(submission.light_document_id)),
            ("light_document_sha256", str(submission.light_document_sha256)),
            ("analysis", _analysis_canonical(submission.analysis)),
            ("metadata", _metadata_canonical(submission.metadata)),
            ("references", _references_canonical(submission.references)),
            ("tags", _tags_canonical(submission.tags)),
            ("provenance", _provenance_canonical(submission.provenance)),
        )
    )


def _analysis_canonical(value: CompletionAnalysisFact) -> CanonicalJsonObject:
    return CanonicalJsonObject(
        (
            ("work_version_id", str(value.work_version_id)),
            ("light_document_id", str(value.light_document_id)),
            ("input_sha256", str(value.input_sha256)),
            ("analysis_id", str(value.analysis_id)),
            ("artifact_id", str(value.artifact_id)),
            ("artifact_path", str(value.artifact_path)),
            ("artifact_sha256", str(value.artifact_sha256)),
            ("artifact_size", value.artifact_size),
            ("proposal", value.proposal),
        )
    )


def _metadata_canonical(value: FinalMetadataFact) -> CanonicalJsonObject:
    return CanonicalJsonObject(
        (
            ("work_version_id", str(value.work_version_id)),
            ("expected_snapshot_id", str(value.expected_snapshot_id)),
            ("expected_revision", value.expected_revision),
            ("expected_sha256", str(value.expected_sha256)),
            ("snapshot_id", str(value.snapshot_id)),
            ("revision", value.revision),
            ("sha256", str(value.sha256)),
            ("values", value.values),
            ("provenance", value.provenance),
        )
    )


def _references_canonical(value: ReferenceSetFact) -> CanonicalJsonObject:
    return CanonicalJsonObject(
        (
            ("set_id", str(value.set_id)),
            ("work_version_id", str(value.work_version_id)),
            ("revision", value.revision),
            (
                "members",
                tuple(
                    CanonicalJsonObject(
                        (
                            ("member_id", str(member.member_id)),
                            ("raw_text", member.raw_text),
                            ("reference", member.reference),
                            (
                                "target_work_id",
                                None
                                if member.target_work_id is None
                                else str(member.target_work_id),
                            ),
                            (
                                "target_work_version_id",
                                None
                                if member.target_work_version_id is None
                                else str(member.target_work_version_id),
                            ),
                        )
                    )
                    for member in value.members
                ),
            ),
        )
    )


def _tags_canonical(value: TagSetFact) -> CanonicalJsonObject:
    return CanonicalJsonObject(
        (
            ("set_id", str(value.set_id)),
            ("work_version_id", str(value.work_version_id)),
            ("revision", value.revision),
            (
                "members",
                tuple(
                    CanonicalJsonObject(
                        (
                            ("member_id", str(member.member_id)),
                            ("name", member.name),
                            ("evidence", member.evidence),
                        )
                    )
                    for member in value.members
                ),
            ),
        )
    )


def _provenance_canonical(value: CompletionProvenance) -> CanonicalJsonObject:
    return CanonicalJsonObject(
        (
            ("parser_identity", value.parser_identity),
            ("model_provider", value.model_provider),
            ("model_identity", value.model_identity),
            ("input_sha256", str(value.input_sha256)),
            ("parameters_sha256", str(value.parameters_sha256)),
            ("evidence", value.evidence),
        )
    )


__all__ = (
    "completion_analysis_bytes",
    "completion_analysis_sha256",
    "completion_submission_canonical",
    "metadata_snapshot_bytes",
    "metadata_snapshot_sha256",
)
