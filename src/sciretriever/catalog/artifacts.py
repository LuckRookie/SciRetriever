"""Catalog registration for immutable derived artifacts."""

from __future__ import annotations

from sqlalchemy import insert, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import normalized_artifacts
from sciretriever.catalog.records import ArtifactRegistration, NormalizedArtifactRecord
from sciretriever.catalog.repository import _append_event, _required_text, canonical_json, catalog_operation
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.core.validation import validate_media_type, validate_sha256, validate_storage_path, validate_token
from sciretriever.errors import CatalogError


def _positive(value: int, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


class ArtifactRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("ArtifactRepository requires a writable catalog")
        self._catalog = catalog

    def get(self, artifact_id: str) -> NormalizedArtifactRecord | None:
        artifact_id = validate_uuid(artifact_id, "artifact_id")
        with catalog_operation("artifact lookup"):
            with self._catalog.connect() as connection:
                row = connection.execute(select(normalized_artifacts).where(normalized_artifacts.c.id == artifact_id)).mappings().one_or_none()
        return None if row is None else NormalizedArtifactRecord.from_row(row)

    def find_derivation(self, artifact_id: str) -> NormalizedArtifactRecord | None:
        return self.get(artifact_id)

    def list_for_work(self, work_id: str) -> tuple[NormalizedArtifactRecord, ...]:
        work_id = validate_uuid(work_id, "work_id")
        with catalog_operation("work artifact listing"):
            with self._catalog.connect() as connection:
                rows = connection.execute(
                    select(normalized_artifacts).where(normalized_artifacts.c.work_id == work_id).order_by(normalized_artifacts.c.kind, normalized_artifacts.c.id)
                ).mappings().all()
        return tuple(NormalizedArtifactRecord.from_row(row) for row in rows)

    def register_pair_after_publication(
        self,
        work_id: str,
        raw_asset_id: str,
        artifacts: tuple[ArtifactRegistration, ...],
    ) -> tuple[NormalizedArtifactRecord, ...]:
        work_id = validate_uuid(work_id, "work_id")
        raw_asset_id = validate_uuid(raw_asset_id, "raw_asset_id")
        if not artifacts:
            raise ValueError("artifacts must not be empty")
        prepared = []
        for artifact in artifacts:
            if not isinstance(artifact, ArtifactRegistration):
                raise TypeError("artifacts must contain ArtifactRegistration values")
            prepared.append({
                "id": validate_uuid(artifact.id, "artifact_id"), "work_id": work_id,
                "raw_asset_id": raw_asset_id, "kind": validate_token(artifact.kind, "kind"),
                "schema_version": _required_text(artifact.schema_version, "schema_version"),
                "storage_path": validate_storage_path(artifact.storage_path),
                "sha256": validate_sha256(artifact.sha256),
                "media_type": validate_media_type(artifact.media_type),
                "byte_size": _positive(artifact.byte_size, "byte_size"),
                "provenance_json": canonical_json(artifact.provenance),
            })
        with catalog_operation("artifact registration"):
            with self._catalog.critical_transaction() as connection:
                result = []
                for values in prepared:
                    row = connection.execute(select(normalized_artifacts).where(normalized_artifacts.c.id == values["id"])).mappings().one_or_none()
                    if row is not None:
                        comparable = {key: row[key] for key in values if key != "created_at"}
                        if comparable != values:
                            raise CatalogError("artifact replay metadata conflicts")
                        result.append(NormalizedArtifactRecord.from_row(row))
                        continue
                    values["created_at"] = utc_now_rfc3339()
                    connection.execute(insert(normalized_artifacts).values(**values))
                    _append_event(connection, subject_type="normalized_artifact", subject_id=values["id"], event_type="normalized_artifact.registered")
                    result.append(NormalizedArtifactRecord.from_row(values))
                return tuple(result)


__all__ = ("ArtifactRepository",)
