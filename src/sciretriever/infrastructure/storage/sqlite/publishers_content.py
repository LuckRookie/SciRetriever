from __future__ import annotations

import os
from collections.abc import Callable
from typing import overload

from typing_extensions import assert_never

import sciretriever.infrastructure.storage.sqlite.publishers_assets as publishers_assets
from sciretriever.infrastructure.storage import target_result_envelope_json
from sciretriever.infrastructure.storage.sqlite.publisher_support import (
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
from sciretriever.model.execution import (
    ValidatedAssetAcceptance,
    ValidatedDocumentAcceptance,
)


class ContentAcceptancePublisher:
    def __init__(
        self,
        catalog_path: str | os.PathLike[str],
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._catalog_path = catalog_path
        self._failpoint = failpoint

    @overload
    def publish(self, acceptance: ValidatedAssetAcceptance) -> AssetPublication: ...

    @overload
    def publish(self, acceptance: ValidatedDocumentAcceptance) -> None: ...

    def publish(
        self, acceptance: ValidatedAssetAcceptance | ValidatedDocumentAcceptance
    ) -> AssetPublication | None:  # noqa: C901
        point = StatementFailpoint(self._failpoint)
        publication: AssetPublication | None
        with immediate(self._catalog_path) as connection:
            match acceptance:
                case ValidatedAssetAcceptance(
                    acceptance=value,
                    target=target,
                    target_result=result,
                ):
                    match value:
                        case PrimaryPdfAcceptance():
                            publication = publishers_assets.publish_primary_asset(
                                connection, point, value
                            )
                        case SupplementaryAssetAcceptance():
                            publication = publishers_assets.publish_supplementary_asset(
                                connection, point, value
                            )
                        case unreachable:
                            assert_never(unreachable)
                case ValidatedDocumentAcceptance(
                    acceptance=value,
                    target=target,
                    target_result=result,
                ):
                    self._light(connection, point, value)
                    publication = None
                case unreachable:
                    assert_never(unreachable)
            result_json = target_result_envelope_json(result)
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
                "b WHERE b.id=? AND b.batch_type='process' AND b.status='running')",
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
