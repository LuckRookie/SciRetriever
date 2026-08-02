from __future__ import annotations

import os
from collections.abc import Callable

from sciretriever.core.execution import (
    ExecutionRejectedError,
    canonical_target_projection,
    target_projection_canonical,
    validate_completion_target,
)
from sciretriever.core.literature.acceptance import (
    CompletionRejectedError,
    validate_completion_submission_contract,
)
from sciretriever.core.literature.completion import (
    completion_submission_canonical,
    metadata_snapshot_sha256,
)
from sciretriever.kernel import CanonicalJsonObject, canonical_json_bytes
from sciretriever.literature_store.sqlite.publisher_support import (
    StalePublicationError,
    StatementFailpoint,
    execute,
    immediate,
)
from sciretriever.model.execution import TargetProjection
from sciretriever.model.literature import (
    CompletionOutcome,
    CompletionSubmission,
    ReferenceSetFact,
    TagSetFact,
)
from sciretriever.model.primitives import sha256_digest


def _references(connection, point: StatementFailpoint, fact: ReferenceSetFact) -> None:
    execute(
        connection,
        point,
        "INSERT INTO reference_sets(id,work_version_id,revision,complete) VALUES(?,?,?,1)",
        (str(fact.set_id), str(fact.work_version_id), fact.revision),
    )
    for ordinal, member in enumerate(fact.members):
        payload = canonical_json_bytes(member.reference).decode("ascii")
        if member.target_work_id is None:
            execute(
                connection,
                point,
                "INSERT INTO unresolved_references(id,reference_set_id,ordinal,raw_text,"
                "reference_json) VALUES(?,?,?,?,?)",
                (str(member.member_id), str(fact.set_id), ordinal, member.raw_text, payload),
            )
        else:
            execute(
                connection,
                point,
                "INSERT INTO reference_members(id,reference_set_id,ordinal,target_work_id,"
                "target_work_version_id,reference_json) VALUES(?,?,?,?,?,?)",
                (
                    str(member.member_id),
                    str(fact.set_id),
                    ordinal,
                    str(member.target_work_id),
                    None
                    if member.target_work_version_id is None
                    else str(member.target_work_version_id),
                    payload,
                ),
            )


def _tags(connection, point: StatementFailpoint, fact: TagSetFact) -> None:
    execute(
        connection,
        point,
        "INSERT INTO tag_sets(id,work_version_id,revision,complete) VALUES(?,?,?,1)",
        (str(fact.set_id), str(fact.work_version_id), fact.revision),
    )
    for member in fact.members:
        execute(
            connection,
            point,
            "INSERT INTO tag_members(id,tag_set_id,name,evidence_json) VALUES(?,?,?,?)",
            (
                str(member.member_id),
                str(fact.set_id),
                member.name,
                canonical_json_bytes(member.evidence).decode("ascii"),
            ),
        )


class CompletionPublisher:
    def __init__(
        self,
        catalog_path: str | os.PathLike[str],
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._catalog_path = catalog_path
        self._failpoint = failpoint

    def publish_completion(  # noqa: C901
        self,
        validated_submission: CompletionSubmission,
        target_projection: TargetProjection,
    ) -> CompletionOutcome:
        submission = validated_submission
        target = target_projection
        try:
            validate_completion_submission_contract(submission)
        except CompletionRejectedError as error:
            raise StalePublicationError(str(error)) from error
        try:
            validate_completion_target(target)
        except ExecutionRejectedError as error:
            raise StalePublicationError(str(error)) from error
        if target.work_version_id != submission.work_version_id:
            raise StalePublicationError("completion submission and target identities differ")
        analysis = submission.analysis
        metadata = submission.metadata
        proposal_bytes = canonical_json_bytes(analysis.proposal)
        if analysis.artifact_sha256 != sha256_digest(
            proposal_bytes
        ) or analysis.artifact_size != len(proposal_bytes):
            raise StalePublicationError("analysis artifact identity is inconsistent")
        proposal = proposal_bytes.decode("ascii")
        if (
            metadata_snapshot_sha256(metadata.revision, metadata.values, metadata.provenance)
            != metadata.sha256
        ):
            raise StalePublicationError("final metadata hash is inconsistent")
        provenance = canonical_json_bytes(submission.provenance.evidence).decode("ascii")
        try:
            result_json = canonical_target_projection(target).decode("ascii")
        except ExecutionRejectedError as error:
            raise StalePublicationError("target result envelope is invalid") from error
        identity_sha256 = sha256_digest(
            canonical_json_bytes(
                CanonicalJsonObject(
                    (
                        ("submission", completion_submission_canonical(submission)),
                        ("target", target_projection_canonical(target)),
                    )
                )
            )
        )
        point = StatementFailpoint(self._failpoint)
        with immediate(self._catalog_path) as connection:
            existing = connection.execute(
                "SELECT b.light_document_id,b.analysis_artifact_id,b.metadata_snapshot_id,"
                "b.reference_set_id,b.tag_set_id,a.sha256,t.result_json,b.identity_sha256 "
                "FROM completion_bundles b JOIN analysis_artifacts a ON "
                "a.id=b.analysis_artifact_id "
                "LEFT JOIN batch_targets t ON t.batch_run_id=? AND t.target_kind='work-version' "
                "AND t.target_id=b.work_version_id WHERE b.work_version_id=?",
                (str(target.batch_run_id), str(submission.work_version_id)),
            ).fetchone()
            expected_bundle = (
                str(submission.light_document_id),
                str(analysis.analysis_id),
                str(metadata.snapshot_id),
                str(submission.references.set_id),
                str(submission.tags.set_id),
                str(analysis.artifact_sha256),
                result_json,
                str(identity_sha256),
            )
            if existing is not None:
                if existing == expected_bundle:
                    return CompletionOutcome.REPLAYED
                raise StalePublicationError("work version already has a divergent completion")
            light = connection.execute(
                "SELECT c.light_document_id,d.sha256 FROM work_version_current_light_document c "
                "JOIN light_documents d ON d.id=c.light_document_id "
                "JOIN accepted_primary_assets p ON p.work_version_id=c.work_version_id "
                "AND p.work_version_asset_id=d.primary_asset_id WHERE c.work_version_id=?",
                (str(submission.work_version_id),),
            ).fetchone()
            current_metadata = connection.execute(
                "SELECT c.metadata_snapshot_id,s.revision,s.sha256 FROM "
                "work_version_current_metadata c "
                "JOIN metadata_snapshots s ON s.id=c.metadata_snapshot_id WHERE "
                "c.work_version_id=?",
                (str(submission.work_version_id),),
            ).fetchone()
            if light != (str(submission.light_document_id), str(submission.light_document_sha256)):
                raise StalePublicationError("light document changed")
            if current_metadata != (
                str(metadata.expected_snapshot_id),
                metadata.expected_revision,
                str(metadata.expected_sha256),
            ):
                raise StalePublicationError("metadata changed")
            for member in submission.references.members:
                if member.target_work_id is None:
                    continue
                topology = connection.execute(
                    "SELECT v.work_id FROM works w LEFT JOIN work_versions v ON v.id=? "
                    "WHERE w.id=?",
                    (
                        None
                        if member.target_work_version_id is None
                        else str(member.target_work_version_id),
                        str(member.target_work_id),
                    ),
                ).fetchone()
                if topology is None or (
                    member.target_work_version_id is not None
                    and topology[0] != str(member.target_work_id)
                ):
                    raise StalePublicationError("resolved reference topology changed")
            artifact_row = connection.execute(
                "SELECT id,storage_path,byte_size FROM artifacts WHERE kind='analysis' AND "
                "sha256=?",
                (str(analysis.artifact_sha256),),
            ).fetchone()
            if artifact_row is None:
                execute(
                    connection,
                    point,
                    "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size,media_type) "
                    "VALUES(?,'analysis',?,?,?,'application/json')",
                    (
                        str(analysis.artifact_id),
                        str(analysis.artifact_sha256),
                        str(analysis.artifact_path),
                        analysis.artifact_size,
                    ),
                )
            elif artifact_row != (
                str(analysis.artifact_id),
                str(analysis.artifact_path),
                analysis.artifact_size,
            ):
                raise StalePublicationError("shared analysis artifact identity differs")
            execute(
                connection,
                point,
                "INSERT INTO analysis_artifacts(id,work_version_id,light_document_id,"
                "artifact_id,sha256,input_sha256,proposal_json,provenance_json,"
                "nine_categories_complete) VALUES(?,?,?,?,?,?,?,?,1)",
                (
                    str(analysis.analysis_id),
                    str(submission.work_version_id),
                    str(submission.light_document_id),
                    str(analysis.artifact_id),
                    str(analysis.artifact_sha256),
                    str(submission.light_document_sha256),
                    proposal,
                    provenance,
                ),
            )
            values = canonical_json_bytes(metadata.values).decode("ascii")
            metadata_provenance = canonical_json_bytes(metadata.provenance).decode("ascii")
            execute(
                connection,
                point,
                "INSERT INTO metadata_snapshots(id,work_version_id,revision,sha256,values_json,"
                "provenance_json) VALUES(?,?,?,?,?,?)",
                (
                    str(metadata.snapshot_id),
                    str(submission.work_version_id),
                    metadata.revision,
                    str(metadata.sha256),
                    values,
                    metadata_provenance,
                ),
            )
            cursor = execute(
                connection,
                point,
                "UPDATE work_version_current_metadata SET metadata_snapshot_id=? WHERE "
                "work_version_id=? AND metadata_snapshot_id=?",
                (
                    str(metadata.snapshot_id),
                    str(submission.work_version_id),
                    str(metadata.expected_snapshot_id),
                ),
            )
            if cursor.rowcount != 1:
                raise StalePublicationError("metadata pointer changed")
            _references(connection, point, submission.references)
            _tags(connection, point, submission.tags)
            execute(
                connection,
                point,
                "INSERT INTO completion_bundles(work_version_id,light_document_id,"
                "analysis_artifact_id,metadata_snapshot_id,reference_set_id,tag_set_id,"
                "identity_sha256) VALUES(?,?,?,?,?,?,?)",
                (
                    str(submission.work_version_id),
                    str(submission.light_document_id),
                    str(analysis.analysis_id),
                    str(metadata.snapshot_id),
                    str(submission.references.set_id),
                    str(submission.tags.set_id),
                    str(identity_sha256),
                ),
            )
            for table, content in (("metadata_fts", values), ("analysis_fts", proposal)):
                execute(
                    connection,
                    point,
                    f"DELETE FROM {table} WHERE work_version_id=?",
                    (str(submission.work_version_id),),
                )
                execute(
                    connection,
                    point,
                    f"INSERT INTO {table}(work_version_id,content) VALUES(?,?)",
                    (str(submission.work_version_id), content),
                )
            for stage in target.failure_stages_to_clear:
                execute(
                    connection,
                    point,
                    "DELETE FROM current_failures WHERE subject_kind='work-version' AND "
                    "subject_id=? AND stage=?",
                    (str(submission.work_version_id), stage),
                )
            cursor = execute(
                connection,
                point,
                "UPDATE batch_targets SET started=1,result_json=? WHERE batch_run_id=? AND "
                "target_id=? AND target_kind='work-version' AND result_json IS NULL",
                (result_json, str(target.batch_run_id), str(submission.work_version_id)),
            )
            if cursor.rowcount != 1:
                raise StalePublicationError("completion target changed")
            point.before_commit()
            connection.commit()
            return CompletionOutcome.PUBLISHED


__all__ = ("CompletionPublisher",)
