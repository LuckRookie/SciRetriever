from __future__ import annotations

import os
from collections.abc import Callable
from typing import assert_never

from sciretriever.batching.api import ContentAcceptanceCommand
from sciretriever.content.api import (
    ArtifactKind,
    LightDocumentAcceptance,
    PrimaryPdfAcceptance,
    SupplementaryAssetAcceptance,
)
from sciretriever.kernel import BoundaryError, canonical_json_bytes
from sciretriever.literature_store.sqlite.publisher_support import (
    StalePublicationError,
    StatementFailpoint,
    execute,
    immediate,
    verify_published_artifact,
    verify_structured_artifact,
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

    def publish(self, command: ContentAcceptanceCommand) -> None:  # noqa: C901
        if command.acceptance.work_version_id != command.target.work_version_id:
            raise StalePublicationError("content acceptance identities differ")
        match command.acceptance:
            case PrimaryPdfAcceptance() as acceptance:
                verify_published_artifact(acceptance.artifact)
                if acceptance.artifact.kind is not ArtifactKind.PRIMARY_PDF:
                    raise StalePublicationError("primary artifact kind mismatched")
            case LightDocumentAcceptance() as acceptance:
                verify_structured_artifact(
                    acceptance.artifact,
                    ArtifactKind.LIGHT_DOCUMENT,
                    acceptance.document,
                )
            case SupplementaryAssetAcceptance() as acceptance:
                verify_published_artifact(acceptance.artifact)
                if acceptance.artifact.kind is not ArtifactKind.SUPPLEMENTARY:
                    raise StalePublicationError("supplementary artifact kind mismatched")
            case unreachable:
                assert_never(unreachable)
        try:
            result_json = canonical_json_bytes(command.target.result_envelope().canonical()).decode(
                "ascii"
            )
        except BoundaryError as error:
            raise StalePublicationError("target result envelope is invalid") from error
        point = StatementFailpoint(self._failpoint)
        with immediate(self._catalog_path) as connection:
            match command.acceptance:
                case PrimaryPdfAcceptance() as acceptance:
                    self._primary(connection, point, acceptance)
                case LightDocumentAcceptance() as acceptance:
                    self._light(connection, point, acceptance)
                case SupplementaryAssetAcceptance() as acceptance:
                    self._supplementary(connection, point, acceptance)
                case unreachable:
                    assert_never(unreachable)
            target = command.target
            for stage in target.failure_stages_to_clear:
                execute(
                    connection,
                    point,
                    "DELETE FROM current_failures WHERE subject_kind='work-version' AND "
                    "subject_id=? AND stage=?",
                    (str(target.work_version_id), stage.value),
                )
            cursor = execute(
                connection,
                point,
                "UPDATE batch_targets SET started=1,result_json=? WHERE batch_run_id=? AND "
                "target_id=? AND target_kind='work-version' AND result_json IS NULL",
                (result_json, str(target.batch_run_id), str(target.work_version_id)),
            )
            if cursor.rowcount != 1:
                raise StalePublicationError("content target changed")
            point.before_commit()
            connection.commit()

    @staticmethod
    def _primary(connection, point: StatementFailpoint, acceptance: PrimaryPdfAcceptance) -> None:
        artifact = acceptance.artifact
        metadata = connection.execute(
            "SELECT c.metadata_snapshot_id,s.revision,s.sha256 FROM "
            "work_version_current_metadata c JOIN metadata_snapshots s ON "
            "s.id=c.metadata_snapshot_id WHERE c.work_version_id=?",
            (str(acceptance.work_version_id),),
        ).fetchone()
        if metadata != (
            str(acceptance.expected_metadata_id),
            acceptance.expected_metadata_revision,
            str(acceptance.expected_metadata_sha256),
        ):
            raise StalePublicationError("metadata changed")
        if (
            connection.execute(
                "SELECT 1 FROM accepted_primary_assets WHERE work_version_id=?",
                (str(acceptance.work_version_id),),
            ).fetchone()
            is not None
        ):
            raise StalePublicationError("primary asset already accepted")
        execute(
            connection,
            point,
            "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size,media_type) VALUES(?,?,"
            "?,?,?,?)",
            (
                str(acceptance.artifact_id),
                "raw",
                str(artifact.sha256),
                str(artifact.path),
                artifact.size,
                "application/pdf",
            ),
        )
        source = canonical_json_bytes(acceptance.source).decode("ascii")
        execute(
            connection,
            point,
            "INSERT INTO raw_assets(artifact_id,asset_role,source_json) VALUES(?,'primary-pdf',?)",
            (str(acceptance.artifact_id), source),
        )
        execute(
            connection,
            point,
            "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role) VALUES(?,?,?,"
            "'primary-pdf')",
            (
                str(acceptance.relation_id),
                str(acceptance.work_version_id),
                str(acceptance.artifact_id),
            ),
        )
        execute(
            connection,
            point,
            "INSERT INTO accepted_primary_assets(work_version_id,work_version_asset_id) VALUES("
            "?,?)",
            (str(acceptance.work_version_id), str(acceptance.relation_id)),
        )

    @staticmethod
    def _supplementary(
        connection, point: StatementFailpoint, acceptance: SupplementaryAssetAcceptance
    ) -> None:
        metadata = connection.execute(
            "SELECT c.metadata_snapshot_id,s.revision,s.sha256 FROM "
            "work_version_current_metadata c JOIN metadata_snapshots s ON "
            "s.id=c.metadata_snapshot_id WHERE c.work_version_id=?",
            (str(acceptance.work_version_id),),
        ).fetchone()
        if metadata != (
            str(acceptance.expected_metadata_id),
            acceptance.expected_metadata_revision,
            str(acceptance.expected_metadata_sha256),
        ):
            raise StalePublicationError("metadata changed")
        primary = connection.execute(
            "SELECT a.sha256 FROM accepted_primary_assets p JOIN work_version_assets w ON "
            "w.id=p.work_version_asset_id JOIN artifacts a ON a.id=w.artifact_id WHERE "
            "p.work_version_id=?",
            (str(acceptance.work_version_id),),
        ).fetchone()
        actual_primary = None if primary is None else primary[0]
        expected_primary = (
            None
            if acceptance.expected_primary_sha256 is None
            else str(acceptance.expected_primary_sha256)
        )
        if actual_primary != expected_primary:
            raise StalePublicationError("primary asset changed")
        artifact = acceptance.artifact
        execute(
            connection,
            point,
            "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size,media_type) VALUES(?,?,"
            "?,?,?,?)",
            (
                str(acceptance.artifact_id),
                "raw",
                str(artifact.sha256),
                str(artifact.path),
                artifact.size,
                acceptance.media_type,
            ),
        )
        source = canonical_json_bytes(acceptance.source).decode("ascii")
        execute(
            connection,
            point,
            "INSERT INTO raw_assets(artifact_id,asset_role,source_json) VALUES(?,?,?)",
            (str(acceptance.artifact_id), acceptance.role.value, source),
        )
        execute(
            connection,
            point,
            "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role) VALUES(?,?,?,?)",
            (
                str(acceptance.relation_id),
                str(acceptance.work_version_id),
                str(acceptance.artifact_id),
                acceptance.role.value,
            ),
        )

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
