from __future__ import annotations

import os
from collections.abc import Callable
from typing import assert_never

import sciretriever.literature_store.sqlite.publishers_assets as publishers_assets
from sciretriever.core import assets as core_assets
from sciretriever.core.assets import AssetRuleError
from sciretriever.core.documents import validate_light_document_acceptance
from sciretriever.core.documents.validation import LightDocumentError
from sciretriever.core.execution import (
    ExecutionRejectedError,
    canonical_target_projection,
    validate_content_acceptance_command,
)
from sciretriever.literature_store.sqlite.publisher_support import (
    StalePublicationError,
    StatementFailpoint,
    execute,
    immediate,
)
from sciretriever.model.assets import (
    AssetPublication,
    PrimaryPdfAcceptance,
    SupplementaryAssetAcceptance,
)
from sciretriever.model.canonical_json import canonical_json_bytes
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.execution import ContentAcceptanceCommand


class ContentAcceptancePublisher:
    def __init__(
        self,
        catalog_path: str | os.PathLike[str],
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._catalog_path = catalog_path
        self._failpoint = failpoint

    def publish(self, command: ContentAcceptanceCommand) -> AssetPublication | None:  # noqa: C901
        try:
            match command.acceptance:
                case PrimaryPdfAcceptance() as acceptance:
                    core_assets.validate_content_acceptance(acceptance)
                case SupplementaryAssetAcceptance() as acceptance:
                    core_assets.validate_content_acceptance(acceptance)
                case LightDocumentAcceptance() as acceptance:
                    validate_light_document_acceptance(acceptance)
                case unreachable:
                    assert_never(unreachable)
        except (AssetRuleError, LightDocumentError) as error:
            raise StalePublicationError(str(error)) from error
        try:
            validate_content_acceptance_command(command)
        except ExecutionRejectedError as error:
            raise StalePublicationError(str(error)) from error
        try:
            result_json = canonical_target_projection(command.target).decode("ascii")
        except ExecutionRejectedError as error:
            raise StalePublicationError("target result envelope is invalid") from error
        point = StatementFailpoint(self._failpoint)
        publication: AssetPublication | None
        with immediate(self._catalog_path) as connection:
            match command.acceptance:
                case PrimaryPdfAcceptance() as acceptance:
                    publication = publishers_assets.publish_primary_asset(
                        connection, point, acceptance
                    )
                case LightDocumentAcceptance() as acceptance:
                    self._light(connection, point, acceptance)
                    publication = None
                case SupplementaryAssetAcceptance() as acceptance:
                    publication = publishers_assets.publish_supplementary_asset(
                        connection, point, acceptance
                    )
                case unreachable:
                    assert_never(unreachable)
            target = command.target
            for stage in target.failure_stages_to_clear:
                execute(
                    connection,
                    point,
                    "DELETE FROM current_failures WHERE subject_kind='work-version' AND "
                    "subject_id=? AND stage=?",
                    (str(target.work_version_id), stage),
                )
            cursor = execute(
                connection,
                point,
                "UPDATE batch_targets SET started=1,result_json=? WHERE batch_run_id=? AND "
                "target_id=? AND target_kind='work-version' AND EXISTS(SELECT 1 FROM batch_runs "
                "b WHERE b.id=? AND b.status='running')",
                (
                    result_json,
                    str(target.batch_run_id),
                    str(target.work_version_id),
                    str(target.batch_run_id),
                ),
            )
            if cursor.rowcount != 1:
                raise StalePublicationError("content target changed")
            point.before_commit()
            connection.commit()
        return publication

    @staticmethod
    def _light(connection, point: StatementFailpoint, acceptance: LightDocumentAcceptance) -> None:
        artifact = acceptance.artifact
        primary = connection.execute(
            "SELECT p.work_version_asset_id,a.sha256 FROM accepted_primary_assets p JOIN "
            "work_version_assets w ON w.id=p.work_version_asset_id JOIN artifacts a ON "
            "a.id=w.artifact_id WHERE p.work_version_id=?",
            (str(acceptance.work_version_id),),
        ).fetchone()
        if primary != (
            str(acceptance.expected_primary_relation_id),
            str(acceptance.expected_primary_sha256),
        ):
            raise StalePublicationError("primary asset changed")
        execute(
            connection,
            point,
            "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size,media_type) VALUES(?,?,"
            "?,?,?,?)",
            (
                str(acceptance.artifact_id),
                "light-document",
                str(artifact.sha256),
                str(artifact.path),
                artifact.size,
                "application/json",
            ),
        )
        document = canonical_json_bytes(acceptance.document).decode("ascii")
        provenance = canonical_json_bytes(acceptance.provenance).decode("ascii")
        execute(
            connection,
            point,
            "INSERT INTO light_documents(id,work_version_id,primary_asset_id,artifact_id,sha256,"
            "document_json,provenance_json,complete) VALUES(?,?,?,?,?,?,?,1)",
            (
                str(acceptance.document_id),
                str(acceptance.work_version_id),
                str(acceptance.expected_primary_relation_id),
                str(acceptance.artifact_id),
                str(artifact.sha256),
                document,
                provenance,
            ),
        )
        execute(
            connection,
            point,
            "INSERT INTO work_version_current_light_document(work_version_id,light_document_id) "
            "VALUES(?,?)",
            (str(acceptance.work_version_id), str(acceptance.document_id)),
        )
        execute(
            connection,
            point,
            "DELETE FROM light_text_fts WHERE work_version_id=?",
            (str(acceptance.work_version_id),),
        )
        execute(
            connection,
            point,
            "INSERT INTO light_text_fts(work_version_id,content) VALUES(?,?)",
            (str(acceptance.work_version_id), document),
        )


__all__ = ("ContentAcceptancePublisher",)
