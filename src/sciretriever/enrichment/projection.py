"""Rebuildable non-authoritative search projection."""

from __future__ import annotations

import json

from sqlalchemy import select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import citations, light_structures, works
from sciretriever.core.ids import validate_uuid


class SearchProjectionBuilder:
    def __init__(self, catalog: CatalogEngine) -> None:
        self.catalog = catalog

    def build(self, work_id: str) -> dict[str, object]:
        work_id = validate_uuid(work_id, "work_id")
        with self.catalog.connect() as connection:
            work = connection.execute(select(works).where(works.c.id == work_id)).mappings().one()
            light = connection.execute(select(light_structures).where(light_structures.c.work_id == work_id).order_by(light_structures.c.kind, light_structures.c.id)).mappings().all()
            cited = connection.execute(select(citations.c.cited_work_id).where(citations.c.citing_work_id == work_id, citations.c.cited_work_id.is_not(None)).order_by(citations.c.cited_work_id)).scalars().all()
        values = [json.loads(row["content_json"]) for row in light]
        return {
            "work_id": work_id, "title": work["title"], "abstract": work["abstract"],
            "light_structure": values, "citation_document_ids": list(dict.fromkeys(cited)),
        }


__all__ = ("SearchProjectionBuilder",)
