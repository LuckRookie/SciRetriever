"""Transactional exact-identifier resolution for acquisition-side callers."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy import Connection, insert, or_, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import identifiers as identifier_table
from sciretriever.catalog.models import identity_reviews, works
from sciretriever.catalog.records import (
    IdentityResolution,
    IdentityReviewRecord,
    WorkRecord,
)
from sciretriever.catalog.repository import (
    CatalogRepository,
    _append_event,
    _work_record,
    canonical_json,
    catalog_operation,
)
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339


IdentifierInput = Identifier | Mapping[str, object] | tuple[str, str]
IdentifierCollection = Iterable[object] | Mapping[object, object]


def _normalize_identifiers(values: IdentifierCollection) -> tuple[Identifier, ...]:
    normalized: list[Identifier] = []
    if isinstance(values, Mapping):
        mapping_items: list[tuple[str, str]] = []
        for namespace, value in values.items():
            if not isinstance(namespace, str) or not isinstance(value, str):
                raise TypeError("identifier mappings must contain string keys and values")
            mapping_items.append((namespace, value))
        if {key for key, _ in mapping_items} == {"namespace", "value"}:
            single = dict(mapping_items)
            namespace = single["namespace"]
            value = single["value"]
            normalized.append(Identifier(namespace, value))
        else:
            for namespace, value in mapping_items:
                normalized.append(Identifier(namespace, value))
    else:
        for item in values:
            if isinstance(item, Identifier):
                identifier = Identifier(item.namespace, item.value)
            elif isinstance(item, Mapping):
                identifier = Identifier.from_dict(item)
            elif isinstance(item, tuple) and len(item) == 2:
                identifier = Identifier(item[0], item[1])
            else:
                raise TypeError("identifiers must contain Identifier, mapping, or pair values")
            normalized.append(identifier)
    result = tuple(sorted(set(normalized), key=lambda item: (item.namespace, item.value)))
    if not result:
        raise ValueError("at least one identifier is required")
    return result


def _metadata_values(
    metadata: CandidateMetadata | Mapping[str, object] | None,
) -> dict[str, object]:
    if metadata is None:
        return {}
    if isinstance(metadata, CandidateMetadata):
        candidate = metadata
    elif isinstance(metadata, Mapping):
        values = dict(metadata)
        if "publication_year" in values:
            if "year" in values:
                raise ValueError("metadata cannot contain both year and publication_year")
            values["year"] = values.pop("publication_year")
        allowed = {"title", "abstract", "authors", "year", "venue", "keywords"}
        unknown = values.keys() - allowed
        if unknown:
            raise ValueError(f"metadata has unknown fields: {', '.join(sorted(unknown))}")
        authors = values.get("authors", ())
        keywords = values.get("keywords", ())
        if isinstance(authors, tuple):
            authors = list(authors)
        if isinstance(keywords, tuple):
            keywords = list(keywords)
        candidate = CandidateMetadata.from_dict(
            {
                "title": values.get("title"),
                "abstract": values.get("abstract"),
                "authors": authors,
                "year": values.get("year"),
                "venue": values.get("venue"),
                "keywords": keywords,
            }
        )
    else:
        raise TypeError("metadata must be CandidateMetadata, a mapping, or None")
    return {
        "title": candidate.title,
        "abstract": candidate.abstract,
        "publication_year": candidate.year,
        "venue": candidate.venue,
    }


def _review_record(row: Mapping[Any, Any]) -> IdentityReviewRecord:
    return IdentityReviewRecord(
        id=row["id"],
        state=row["state"],
        identifiers_json=row["identifiers_json"],
        candidate_work_ids_json=row["candidate_work_ids_json"],
        reason=row["reason"],
        decision=row["decision"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        resolved_at=row["resolved_at"],
    )


def _matching_work_ids(
    connection: Connection,
    normalized: tuple[Identifier, ...],
) -> set[str]:
    predicates = tuple(
        (identifier_table.c.namespace == item.namespace)
        & (identifier_table.c.value == item.value)
        for item in normalized
    )
    return set(connection.execute(select(identifier_table.c.work_id).where(or_(*predicates))).scalars())


def _insert_aliases(
    connection: Connection,
    work_id: str,
    normalized: tuple[Identifier, ...],
    existing: set[tuple[str, str]],
) -> None:
    created_at = utc_now_rfc3339()
    rows = [
        {
            "id": new_uuid4(),
            "work_id": work_id,
            "namespace": item.namespace,
            "value": item.value,
            "created_at": created_at,
        }
        for item in normalized
        if (item.namespace, item.value) not in existing
    ]
    if rows:
        connection.execute(insert(identifier_table), rows)


class IdentityResolver:
    """Create or resolve a Work using exact normalized aliases only."""

    def __init__(self, catalog: CatalogEngine | CatalogRepository) -> None:
        if isinstance(catalog, CatalogRepository):
            self.__catalog = catalog._catalog
        elif isinstance(catalog, CatalogEngine):
            if catalog.read_only:
                raise ValueError("IdentityResolver requires a writable catalog")
            self.__catalog = catalog
        else:
            raise TypeError("catalog must be a CatalogEngine or CatalogRepository")

    def create_or_reuse_work(
        self,
        identifiers: IdentifierCollection,
        metadata: CandidateMetadata | Mapping[str, object] | None = None,
    ) -> IdentityResolution:
        normalized = _normalize_identifiers(identifiers)
        metadata_values = _metadata_values(metadata)
        with catalog_operation("identity resolution"):
            with self.__catalog.critical_transaction() as connection:
                matches = _matching_work_ids(connection, normalized)
                if len(matches) > 1:
                    return self._create_review(connection, normalized, matches)
                if not matches:
                    return self._create_work(connection, normalized, metadata_values)
                return self._reuse_work(
                    connection,
                    normalized,
                    metadata_values,
                    next(iter(matches)),
                )

    def list_identifiers(self, work_id: str) -> tuple[Identifier, ...]:
        work_id = validate_uuid(work_id, "work_id")
        with catalog_operation("work identifier listing"):
            with self.__catalog.connect() as connection:
                rows = connection.execute(
                    select(identifier_table.c.namespace, identifier_table.c.value)
                    .where(identifier_table.c.work_id == work_id)
                    .order_by(identifier_table.c.namespace, identifier_table.c.value)
                ).tuples().all()
        return tuple(Identifier(namespace, value) for namespace, value in rows)

    @staticmethod
    def _create_review(
        connection: Connection,
        normalized: tuple[Identifier, ...],
        matches: set[str],
    ) -> IdentityResolution:
        identifiers_json = canonical_json([item.to_dict() for item in normalized])
        candidate_work_ids_json = canonical_json(sorted(matches))
        existing = (
            connection.execute(
                select(identity_reviews).where(
                    identity_reviews.c.state == "pending",
                    identity_reviews.c.identifiers_json == identifiers_json,
                    identity_reviews.c.candidate_work_ids_json == candidate_work_ids_json,
                )
            )
            .mappings()
            .one_or_none()
        )
        if existing is not None:
            return IdentityResolution(
                decision="review_required",
                identifiers=normalized,
                review=_review_record(existing),
            )

        now = utc_now_rfc3339()
        reason = "identifiers map to multiple existing works"
        values = {
            "id": new_uuid4(),
            "state": "pending",
            "identifiers_json": identifiers_json,
            "candidate_work_ids_json": candidate_work_ids_json,
            "reason": reason,
            "decision": None,
            "created_at": now,
            "updated_at": now,
            "resolved_at": None,
        }
        connection.execute(insert(identity_reviews).values(**values))
        _append_event(
            connection,
            subject_type="identity_review",
            subject_id=values["id"],
            event_type="identity.review_required",
            details={
                "candidate_work_ids": sorted(matches),
                "identifiers": [item.to_dict() for item in normalized],
                "reason": reason,
            },
        )
        return IdentityResolution(
            decision="review_required",
            identifiers=normalized,
            review=_review_record(values),
        )

    @staticmethod
    def _create_work(
        connection: Connection,
        normalized: tuple[Identifier, ...],
        metadata_values: Mapping[str, object],
    ) -> IdentityResolution:
        now = utc_now_rfc3339()
        values = {
            "id": new_uuid4(),
            "status": "active",
            "title": metadata_values.get("title"),
            "abstract": metadata_values.get("abstract"),
            "publication_year": metadata_values.get("publication_year"),
            "venue": metadata_values.get("venue"),
            "needs_review": 0,
            "review_reason": None,
            "merged_into_work_id": None,
            "created_at": now,
            "updated_at": now,
        }
        connection.execute(insert(works).values(**values))
        _insert_aliases(connection, values["id"], normalized, set())
        _append_event(
            connection,
            subject_type="work",
            subject_id=values["id"],
            event_type="identity.work_created",
            details={"identifiers": [item.to_dict() for item in normalized]},
        )
        return IdentityResolution(
            decision="created",
            identifiers=normalized,
            work=_work_record(values),
        )

    @staticmethod
    def _reuse_work(
        connection: Connection,
        normalized: tuple[Identifier, ...],
        metadata_values: Mapping[str, object],
        work_id: str,
    ) -> IdentityResolution:
        work_row = connection.execute(select(works).where(works.c.id == work_id)).mappings().one()
        existing_aliases = set(
            connection.execute(
                select(identifier_table.c.namespace, identifier_table.c.value).where(
                    identifier_table.c.work_id == work_id
                )
            ).tuples()
        )
        _insert_aliases(connection, work_id, normalized, existing_aliases)
        updates = {
            name: value
            for name, value in metadata_values.items()
            if work_row[name] is None and value is not None
        }
        if updates:
            updates["updated_at"] = utc_now_rfc3339()
            connection.execute(update(works).where(works.c.id == work_id).values(**updates))
            work_row = {**dict(work_row), **updates}
        _append_event(
            connection,
            subject_type="work",
            subject_id=work_id,
            event_type="identity.work_reused",
            details={
                "attached_identifiers": [
                    item.to_dict()
                    for item in normalized
                    if (item.namespace, item.value) not in existing_aliases
                ],
                "filled_metadata": sorted(updates.keys() - {"updated_at"}),
            },
        )
        return IdentityResolution(
            decision="reused",
            identifiers=normalized,
            work=_work_record(work_row),
        )


__all__ = ("IdentityResolver",)
