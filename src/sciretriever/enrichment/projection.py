"""Rebuildable non-authoritative search projection."""

from __future__ import annotations

import json

from sqlalchemy import select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import light_structures, version_references, work_versions
from sciretriever.core.ids import validate_uuid


class SearchProjectionBuilder:
    def __init__(self, catalog: CatalogEngine) -> None:
        self.catalog = catalog

    def build(self, work_version_id: str) -> dict[str, object]:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self.catalog.connect() as connection:
            work = connection.execute(select(work_versions).where(work_versions.c.id == work_version_id)).mappings().one()
            light = connection.execute(select(light_structures).where(light_structures.c.work_version_id == work_version_id).order_by(light_structures.c.kind, light_structures.c.id)).mappings().all()
            cited = connection.execute(select(version_references.c.cited_work_id).where(version_references.c.citing_work_version_id == work_version_id, version_references.c.cited_work_id.is_not(None)).order_by(version_references.c.cited_work_id)).scalars().all()
        values = [json.loads(row["content_json"]) for row in light]
        return {
            "work_version_id": work_version_id, "title": work["title"], "abstract": work["abstract"],
            "light_structure": values, "citation_document_ids": list(dict.fromkeys(cited)),
        }


__all__ = ("SearchProjectionBuilder",)
