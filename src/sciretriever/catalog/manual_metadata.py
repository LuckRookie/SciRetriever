"""Explicit manual canonical metadata ownership."""

from __future__ import annotations

from sqlalchemy import delete, insert

from .analysis_validation import validate_canonical_value
from .canonical_projection import recompute_canonical_projection
from .engine import CatalogEngine
from .models import manual_metadata_overrides
from .repository import _required_text, canonical_json
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


class ManualMetadataRepository:
    """Explicit manual canonical-field overrides, independent of generated state."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine) or catalog.read_only:
            raise CatalogError("ManualMetadataRepository requires a writable catalog")
        self._catalog = catalog

    def set(self, work_version_id: str, field_name: str, value: object) -> None:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        field_name = _required_text(field_name, "field_name")
        with self._catalog.critical_transaction() as connection:
            value = validate_canonical_value(connection, field_name, value)
            connection.execute(insert(manual_metadata_overrides).prefix_with("OR REPLACE").values(
                work_version_id=work_version_id, field_name=field_name,
                value_json=canonical_json(value), updated_at=utc_now_rfc3339()))
            recompute_canonical_projection(connection, work_version_id, frozenset({field_name}))

    def remove(self, work_version_id: str, field_name: str) -> None:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        field_name = _required_text(field_name, "field_name")
        with self._catalog.critical_transaction() as connection:
            connection.execute(delete(manual_metadata_overrides).where(
                manual_metadata_overrides.c.work_version_id == work_version_id,
                manual_metadata_overrides.c.field_name == field_name))
            recompute_canonical_projection(connection, work_version_id, frozenset({field_name}))


__all__ = ("ManualMetadataRepository",)
