from __future__ import annotations

from sqlalchemy import insert, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import version_references
from sciretriever.catalog.records import VersionReferenceRecord
from sciretriever.catalog.repository import _required_text, canonical_json
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339


class ReferenceRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add(
        self,
        citing_work_version_id: str,
        reference_order: int,
        raw_reference: str,
        *,
        cited_work_id: str | None = None,
        identifier: Identifier | None = None,
        source_artifact_id: str | None = None,
        locator: object | None = None,
    ) -> VersionReferenceRecord:
        citing_work_version_id = validate_uuid(
            citing_work_version_id, "citing_work_version_id"
        )
        if cited_work_id is not None:
            cited_work_id = validate_uuid(cited_work_id, "cited_work_id")
        if source_artifact_id is not None:
            source_artifact_id = validate_uuid(
                source_artifact_id, "source_artifact_id"
            )
        values = {
            "id": new_uuid4(),
            "citing_work_version_id": citing_work_version_id,
            "cited_work_id": cited_work_id,
            "reference_order": reference_order,
            "raw_reference": (
                raw_reference
                if isinstance(raw_reference, str) and raw_reference.strip()
                else _required_text(raw_reference, "raw_reference")
            ),
            "cited_namespace": None if identifier is None else identifier.namespace,
            "cited_value": None if identifier is None else identifier.value,
            "source_artifact_id": source_artifact_id,
            "locator_json": None if locator is None else canonical_json(locator),
            "created_at": utc_now_rfc3339(),
        }
        with self._catalog.critical_transaction() as connection:
            connection.execute(insert(version_references).values(**values))
        return VersionReferenceRecord(**values)

    def cited_by(self, work_id: str) -> tuple[VersionReferenceRecord, ...]:
        work_id = validate_uuid(work_id, "work_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(version_references)
                .where(version_references.c.cited_work_id == work_id)
                .order_by(version_references.c.created_at, version_references.c.id)
            ).mappings().all()
        return tuple(
            VersionReferenceRecord(
                **{
                    field: row[field]
                    for field in VersionReferenceRecord.__dataclass_fields__
                }
            )
            for row in rows
        )


__all__ = ("ReferenceRepository",)
