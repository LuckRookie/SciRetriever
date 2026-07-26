from __future__ import annotations

from collections.abc import Iterator
from typing import assert_never

from sqlalchemy import select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    version_references,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import CatalogError
from sciretriever.integrations.graph import (
    GraphDirection,
    GraphIdentifier,
    GraphIdentifierNamespace,
)

from .service import ExpansionContractError, FrontierNode


_IDENTIFIER_ORDER = {
    GraphIdentifierNamespace.DOI: 0,
    GraphIdentifierNamespace.PMID: 1,
    GraphIdentifierNamespace.ARXIV: 2,
    GraphIdentifierNamespace.OPENALEX: 3,
    GraphIdentifierNamespace.S2: 4,
}


class CatalogFrontier:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def seed(self, work_version_id: str) -> FrontierNode:
        version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            work_id = connection.execute(
                select(work_versions.c.work_id).where(work_versions.c.id == version_id)
            ).scalar_one_or_none()
            if work_id is None:
                raise CatalogError(f"unknown WorkVersion: {version_id}")
            identifier = self._identifier(connection, version_id)
        return FrontierNode(work_id, version_id, identifier)

    def preferred(self, work_id: str) -> FrontierNode | None:
        checked_work_id = validate_uuid(work_id, "work_id")
        with self._catalog.connect() as connection:
            version_id = connection.execute(
                select(works.c.preferred_work_version_id).where(
                    works.c.id == checked_work_id,
                    works.c.status == "active",
                )
            ).scalar_one_or_none()
            if version_id is None:
                return None
            try:
                identifier = self._identifier(connection, version_id)
            except CatalogError:
                return None
        return FrontierNode(checked_work_id, version_id, identifier)

    def neighbors(
        self, node: FrontierNode, direction: GraphDirection
    ) -> Iterator[str]:
        with self._catalog.connect() as connection:
            match direction:
                case GraphDirection.REFERENCES:
                    statement = (
                        select(version_references.c.cited_work_id)
                        .where(
                            version_references.c.citing_work_version_id
                            == node.work_version_id,
                            version_references.c.cited_work_id.is_not(None),
                            version_references.c.cited_work_id != node.work_id,
                        )
                        .distinct()
                        .order_by(version_references.c.cited_work_id)
                    )
                case GraphDirection.CITED_BY:
                    statement = (
                        select(work_versions.c.work_id)
                        .join(
                            version_references,
                            version_references.c.citing_work_version_id
                            == work_versions.c.id,
                        )
                        .where(
                            version_references.c.cited_work_id == node.work_id,
                            work_versions.c.work_id != node.work_id,
                        )
                        .distinct()
                        .order_by(work_versions.c.work_id)
                    )
                case GraphDirection.BOTH:
                    raise ExpansionContractError(
                        "catalog frontier requires one concrete direction"
                    )
                case unreachable:
                    assert_never(unreachable)
            yield from connection.execute(statement).scalars().yield_per(128)

    @staticmethod
    def _identifier(connection, work_version_id: str) -> GraphIdentifier:
        rows = connection.execute(
            select(
                work_version_identifiers.c.namespace,
                work_version_identifiers.c.value,
            ).where(work_version_identifiers.c.work_version_id == work_version_id)
        ).tuples()
        identifiers = tuple(
            GraphIdentifier(GraphIdentifierNamespace(namespace), value)
            for namespace, value in rows
            if namespace in {item.value for item in GraphIdentifierNamespace}
        )
        if not identifiers:
            raise CatalogError(
                f"WorkVersion has no graph-capable identifier: {work_version_id}"
            )
        return min(
            identifiers,
            key=lambda item: (_IDENTIFIER_ORDER[item.namespace], item.value),
        )


__all__ = ("CatalogFrontier",)
