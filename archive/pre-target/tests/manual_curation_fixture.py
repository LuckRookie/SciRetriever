from __future__ import annotations

from sciretriever.catalog.curation import CurationOperationOwner, CurationRequest
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.manual_metadata_curation import ManualMetadataClearHandler, ManualMetadataSetHandler
from sciretriever.catalog.manual_tag_curation import ManualTagAddHandler
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot


def _apply(catalog: CatalogEngine, handler: ManualMetadataSetHandler | ManualMetadataClearHandler | ManualTagAddHandler) -> None:
    CurationOperationOwner(catalog).apply(CurationRequest(
        handler, ReviewDecision.NOT_REQUIRED, SafeSnapshot(()),
        operation_id=handler.operation_id,
    ))


def set_manual_metadata(
    catalog: CatalogEngine, work_version_id: str, field_name: str, value: str | int,
) -> None:
    _apply(catalog, ManualMetadataSetHandler.load(
        catalog, work_version_id, field_name, value,
    ))


def clear_manual_metadata(catalog: CatalogEngine, work_version_id: str, field_name: str) -> None:
    _apply(catalog, ManualMetadataClearHandler.load(catalog, work_version_id, field_name))


def add_manual_tag(catalog: CatalogEngine, work_id: str, tag_id: str) -> None:
    _apply(catalog, ManualTagAddHandler.load(catalog, work_id, tag_id))


__all__ = ("add_manual_tag", "clear_manual_metadata", "set_manual_metadata")
