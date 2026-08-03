from __future__ import annotations

import sqlite3

from sciretriever.infrastructure.storage.sqlite.engine import (
    open_read_only_snapshot,
)
from sciretriever.infrastructure.storage.sqlite.library_detail import (
    detail_observations,
    detail_sets,
)
from sciretriever.infrastructure.storage.sqlite.library_parse import (
    analysis_view,
    light_view,
    metadata_view,
)
from sciretriever.infrastructure.storage.sqlite.library_query import (
    export_candidates,
)
from sciretriever.infrastructure.storage.sqlite.library_query import search as search_page
from sciretriever.infrastructure.storage.sqlite.library_relations import _LibraryRelations
from sciretriever.model.execution import CurrentFailure
from sciretriever.model.library import ExportCandidate, ExportSelectionRequest
from sciretriever.model.library_details import (
    WorkDetail,
    WorkVersionDetail,
)
from sciretriever.model.library_pages import LibraryPage, LibraryPageRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.library_views import (
    AssetView,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    MissingStep,
    RelativeArtifactPath,
    Sha256,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
    WorkVersionState,
)


class SqliteLibraryReadRepository(_LibraryRelations):
    def search(self, filters: QueryFilterV1, request: LibraryPageRequest) -> LibraryPage:
        with open_read_only_snapshot(self._catalog_path) as connection:
            return search_page(connection, filters, request)

    def select_snapshot(self, request: ExportSelectionRequest) -> tuple[ExportCandidate, ...]:
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = export_candidates(connection, request.filters)
            return tuple(
                ExportCandidate(
                    work_id=work_id,
                    work_version_id=version_id,
                    version_role=version_role,
                    detail=self._version(connection, version_id, False),
                )
                for work_id, version_id, version_role in rows
            )

    def get_work(self, work_id: WorkId, observations: bool) -> WorkDetail:
        with open_read_only_snapshot(self._catalog_path) as connection:
            representative = connection.execute(
                "SELECT work_version_id FROM work_representative_versions WHERE work_id=?",
                (str(work_id),),
            ).fetchone()
            if representative is None:
                raise LookupError(str(work_id))
            version_rows = connection.execute(
                "SELECT id FROM work_versions WHERE work_id=? ORDER BY CASE version_role WHEN "
                "'formal' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE "
                "3 END,id",
                (str(work_id),),
            ).fetchall()
            versions = tuple(
                self._version(connection, WorkVersionId(row[0]), observations)
                for row in version_rows
            )
            memberships = self._memberships(connection, work_id)
            edges = self._work_edges(connection, work_id)
        return WorkDetail(
            kind="work-detail",
            work_id=work_id,
            preferred_work_version_id=WorkVersionId(representative[0]),
            at_least_one_completed=any(
                item.state is WorkVersionState.COMPLETED for item in versions
            ),
            versions=versions,
            collection_memberships=memberships,
            work_references=edges,
        )

    def get_version(self, version_id: WorkVersionId, observations: bool) -> WorkVersionDetail:
        with open_read_only_snapshot(self._catalog_path) as connection:
            return self._version(connection, version_id, observations)

    def _version(
        self,
        connection: sqlite3.Connection,
        version_id: WorkVersionId,
        observations: bool,
    ) -> WorkVersionDetail:
        row = connection.execute(
            "SELECT v.work_id,st.state,st.missing_step,s.revision,s.sha256,s.values_json,"
            "s.provenance_json "
            "FROM work_versions v JOIN work_version_state_view st ON st.work_version_id=v.id "
            "JOIN work_version_current_metadata c ON c.work_version_id=v.id JOIN "
            "metadata_snapshots s ON s.id=c.metadata_snapshot_id WHERE v.id=?",
            (str(version_id),),
        ).fetchone()
        if row is None:
            raise LookupError(str(version_id))
        work_id, state, missing = row[:3]
        identifiers = tuple(
            Identifier(namespace=item[0], value=item[1])
            for item in connection.execute(
                "SELECT namespace,value FROM stable_identifiers WHERE work_version_id=? ORDER "
                "BY namespace,value",
                (str(version_id),),
            ).fetchall()
        )
        assets = tuple(
            AssetView(
                asset_id=AssetId(item[0]),
                role=AssetRole(item[1]),
                sha256=Sha256(item[2]),
                media_type=item[3] or "application/octet-stream",
                byte_size=item[4],
                storage_path=RelativeArtifactPath(item[5]),
                provenance=(),
            )
            for item in connection.execute(
                "SELECT a.id,w.role,a.sha256,a.media_type,a.byte_size,a.storage_path FROM "
                "work_version_assets w JOIN artifacts a ON a.id=w.artifact_id WHERE "
                "w.work_version_id=? ORDER BY w.role,a.id",
                (str(version_id),),
            ).fetchall()
        )
        light = light_view(
            connection.execute(
                "SELECT d.artifact_id,d.sha256,d.document_json,d.provenance_json FROM "
                "work_version_current_light_document c JOIN light_documents d ON "
                "d.id=c.light_document_id WHERE c.work_version_id=?",
                (str(version_id),),
            ).fetchone()
        )
        metadata = metadata_view((row[3], row[4], row[5], row[6]))
        metadata = metadata.model_copy(
            update={
                "values": metadata.values.model_copy(
                    update={"identifiers": identifiers or metadata.values.identifiers}
                )
            }
        )
        analysis = analysis_view(
            connection.execute(
                "SELECT a.artifact_id,a.sha256,a.input_sha256,a.proposal_json,a.provenance_json "
                "FROM completion_bundles b JOIN analysis_artifacts a ON "
                "a.id=b.analysis_artifact_id WHERE b.work_version_id=?",
                (str(version_id),),
            ).fetchone()
        )
        references, tags = detail_sets(connection, version_id)
        failure_row = connection.execute(
            "SELECT stage,code,reason,action,retryable,updated_at FROM current_failures WHERE "
            "subject_kind='work-version' AND subject_id=? ORDER BY updated_at DESC,stage LIMIT "
            "1",
            (str(version_id),),
        ).fetchone()
        failure = (
            None
            if failure_row is None
            else CurrentFailure(
                stage=failure_row[0],
                code=failure_row[1],
                reason=failure_row[2],
                action=failure_row[3],
                retryable=bool(failure_row[4]),
                updated_at=UtcTimestamp(failure_row[5]),
            )
        )
        observation_items = detail_observations(connection, version_id) if observations else ()
        return WorkVersionDetail(
            kind="work-version-detail",
            work_id=WorkId(work_id),
            work_version_id=version_id,
            identifiers=identifiers,
            metadata=metadata,
            assets=assets,
            light_document=light,
            analysis=analysis,
            references=references,
            tags=tags,
            state=WorkVersionState(state),
            missing_step=None if missing is None else MissingStep(missing),
            current_failure=failure,
            observations_included=observations,
            observations=observation_items,
            provenance=(),
        )


__all__ = ("SqliteLibraryReadRepository",)
