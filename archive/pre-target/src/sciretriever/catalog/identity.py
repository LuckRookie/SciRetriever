"""Transactional exact-identifier resolution for acquisition-side callers."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy import Connection, insert, or_, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.library import WorkRepository
from sciretriever.catalog.registry_repository import RegistryRepository
from sciretriever.catalog.models import identifiers as identifier_table
from sciretriever.catalog.models import authors, authorships, identity_reviews, work_version_identifiers, work_versions, works
from sciretriever.catalog.records import (
    IdentityResolution,
    IdentityReviewRecord,
)
from sciretriever.catalog.repository import (
    CatalogRepository,
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
        "authors": candidate.authors or None,
        "keywords": candidate.keywords or None,
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
                matched_work_id = next(iter(matches)) if matches else None
                title_value = metadata_values.get("title")
                title = title_value if isinstance(title_value, str) else normalized[0].value
                doi = next(
                    (item.value for item in normalized if item.namespace == "doi"),
                    None,
                )
                venue_value = metadata_values.get("venue")
                venue_id = (
                    RegistryRepository(self.__catalog)
                    .add("venue", venue_value, _connection=connection)
                    .id
                    if isinstance(venue_value, str)
                    else None
                )
                version, work_created = WorkRepository(
                    self.__catalog
                ).ingest_version_with_disposition(
                    provider="acquisition",
                    provider_record_id="|".join(
                        f"{item.namespace}:{item.value}" for item in normalized
                    ),
                    title=title,
                    doi=doi,
                    venue_id=venue_id,
                    metadata={
                        key: value
                        for key, value in metadata_values.items()
                        if value is not None
                    },
                    _connection=connection,
                    _work_id=matched_work_id,
                )
                existing_aliases = set(
                    connection.execute(
                        select(
                            identifier_table.c.namespace,
                            identifier_table.c.value,
                        ).where(identifier_table.c.work_id == version.work_id)
                    ).tuples()
                )
                _insert_aliases(
                    connection,
                    version.work_id,
                    normalized,
                    existing_aliases,
                )
                self._attach_version_identifiers(connection, version.id, normalized)
                author_values = metadata_values.get("authors")
                if isinstance(author_values, tuple):
                    self._attach_authors(connection, version.id, author_values)
                work = _work_record(
                    connection.execute(
                        select(works).where(works.c.id == version.work_id)
                    ).mappings().one()
                )
                return IdentityResolution(
                    decision="created" if work_created else "reused",
                    identifiers=normalized,
                    work=work,
                    work_version=version,
                )

    def lookup_existing(self, normalized: tuple[Identifier, ...]) -> bool:
        with self.__catalog.connect() as connection:
            return bool(_matching_work_ids(connection, normalized))

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
    def _attach_version_identifiers(
        connection: Connection,
        work_version_id: str,
        normalized: tuple[Identifier, ...],
    ) -> None:
        work_id = connection.execute(
            select(work_versions.c.work_id).where(work_versions.c.id == work_version_id)
        ).scalar_one()
        created_at = utc_now_rfc3339()
        for item in normalized:
            owner_version_id = connection.execute(
                select(work_version_identifiers.c.work_version_id).where(
                    work_version_identifiers.c.namespace == item.namespace,
                    work_version_identifiers.c.value == item.value,
                )
            ).scalar_one_or_none()
            if owner_version_id is not None:
                owner_work_id = connection.execute(
                    select(work_versions.c.work_id).where(
                        work_versions.c.id == owner_version_id
                    )
                ).scalar_one()
                if owner_work_id != work_id:
                    raise RuntimeError("identifier owner changed during identity resolution")
                continue
            connection.execute(
                insert(work_version_identifiers).values(
                    id=new_uuid4(),
                    work_version_id=work_version_id,
                    namespace=item.namespace,
                    value=item.value,
                    created_at=created_at,
                )
            )

    @staticmethod
    def _attach_authors(
        connection: Connection,
        work_version_id: str,
        author_names: tuple[str, ...],
    ) -> None:
        existing_positions = set(
            connection.execute(
                select(authorships.c.position).where(
                    authorships.c.work_version_id == work_version_id
                )
            ).scalars()
        )
        created_at = utc_now_rfc3339()
        for position, display_name in enumerate(author_names):
            if position in existing_positions:
                continue
            author_id = new_uuid4()
            connection.execute(
                insert(authors).values(
                    id=author_id,
                    display_name=display_name,
                    normalized_name=display_name.casefold(),
                    orcid=None,
                    created_at=created_at,
                )
            )
            connection.execute(
                insert(authorships).values(
                    id=new_uuid4(),
                    work_version_id=work_version_id,
                    author_id=author_id,
                    position=position,
                    role=None,
                    is_corresponding=0,
                    affiliation=None,
                    created_at=created_at,
                )
            )

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
        return IdentityResolution(
            decision="review_required",
            identifiers=normalized,
            review=_review_record(values),
        )

__all__ = ("IdentityResolver",)
