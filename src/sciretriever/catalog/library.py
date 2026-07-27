"""Typed repositories for the fresh Work-centered catalog."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, delete, insert, select, tuple_, update

from sciretriever.catalog.catalog_owner import CatalogOwner
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.canonical_projection import recompute_canonical_projection
from sciretriever.catalog.work_curation_state import recompute_preferred
from sciretriever.catalog.models import (
    authors,
    authorships,
    identifiers,
    metadata_observations,
    provider_canonical_projections,
    publisher_aliases,
    publishers,
    venue_aliases,
    venues,
    version_relations,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.catalog.records import (
    MetadataObservationRecord,
    VersionRelationRecord,
    WorkRecord,
    WorkVersionRecord,
)
from sciretriever.catalog.repository import _required_text, _work_record, canonical_json, catalog_operation
from sciretriever.catalog.registry_repository import RegistryRepository
from sciretriever.catalog.text import normalize_title
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


_TITLE_RULE_VERSION = "title-v1"
_CLASS_RANK = {"formal_publication": 0, "accepted_manuscript": 1, "preprint": 2, "unknown": 3, "other": 3}


@dataclass(frozen=True, slots=True)
class MetadataIngestionObservation:
    provider: str
    provider_record_id: str
    fields: tuple[tuple[str, object], ...]
    provenance: tuple[tuple[str, object], ...]


@dataclass(frozen=True, slots=True)
class MetadataIngestionBatch:
    title: str
    identifiers: tuple[Identifier, ...]
    observations: tuple[MetadataIngestionObservation, ...]
    provider_precedence: tuple[str, ...]
    review_reason: str | None = None


def _version_record(row: Mapping[Any, Any]) -> WorkVersionRecord:
    return WorkVersionRecord(
        id=row["id"], work_id=row["work_id"], version_class=row["version_class"],
        normalized_title=row["normalized_title"], title=row["title"], abstract=row["abstract"],
        language=row["language"], work_type=row["work_type"], publication_date=row["publication_date"],
        publication_year=row["publication_year"], publisher_id=row["publisher_id"], venue_id=row["venue_id"],
        volume=row["volume"], issue=row["issue"], pages=row["pages"], article_number=row["article_number"],
        open_access_status=row["open_access_status"], provider_precedence=row["provider_precedence"],
        stable_version_key=row["stable_version_key"], is_provisional=bool(row["is_provisional"]),
        created_at=row["created_at"], updated_at=row["updated_at"],
    )


class WorkRepository(CatalogOwner):
    """Resolve deterministic Work/WorkVersion identity and preferred versions."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine) or catalog.read_only:
            raise CatalogError("WorkRepository requires a writable catalog")
        self._catalog = catalog

    def ingest_version(
        self,
        *,
        provider: str,
        provider_record_id: str,
        title: str,
        doi: str | None = None,
        version_class: str = "unknown",
        publication_date: str | None = None,
        publisher_id: str | None = None,
        venue_id: str | None = None,
        provider_precedence: int | None = None,
        metadata: Mapping[str, object] | None = None,
        related_work_version_id: str | None = None,
        relation_type: str = "is_version_of",
        relation_evidence: Mapping[str, object] | None = None,
    ) -> WorkVersionRecord:
        version, _ = self.ingest_version_with_disposition(
            provider=provider,
            provider_record_id=provider_record_id,
            title=title,
            doi=doi,
            version_class=version_class,
            publication_date=publication_date,
            publisher_id=publisher_id,
            venue_id=venue_id,
            provider_precedence=provider_precedence,
            metadata=metadata,
            related_work_version_id=related_work_version_id,
            relation_type=relation_type,
            relation_evidence=relation_evidence,
        )
        return version

    def ingest_version_with_disposition(
        self,
        *,
        provider: str,
        provider_record_id: str,
        title: str,
        doi: str | None = None,
        version_class: str = "unknown",
        publication_date: str | None = None,
        publisher_id: str | None = None,
        venue_id: str | None = None,
        provider_precedence: int | None = None,
        metadata: Mapping[str, object] | None = None,
        related_work_version_id: str | None = None,
        relation_type: str = "is_version_of",
        relation_evidence: Mapping[str, object] | None = None,
        observation_provenance: Mapping[str, object] | None = None,
        _connection: Connection | None = None,
        _work_id: str | None = None,
        _force_new_work: bool = False,
    ) -> tuple[WorkVersionRecord, bool]:
        provider = _required_text(provider, "provider")
        provider_record_id = _required_text(provider_record_id, "provider_record_id")
        title = _required_text(title, "title")
        normalized_title = normalize_title(title)
        if version_class not in _CLASS_RANK:
            raise ValueError("unsupported version_class")
        normalized_doi = None if doi is None else Identifier("doi", doi).value
        if publisher_id is not None:
            publisher_id = validate_uuid(publisher_id, "publisher_id")
        if venue_id is not None:
            venue_id = validate_uuid(venue_id, "venue_id")
        if _work_id is not None:
            _work_id = validate_uuid(_work_id, "work_id")
        metadata_values = dict(metadata) if metadata is not None else {}
        canonical_values = self._canonical_metadata(metadata_values)
        direct_projection: dict[str, object] = {"title": title, **canonical_values}
        if publication_date is not None:
            direct_projection["publication_date"] = publication_date
            direct_projection.setdefault("publication_year", self._year(publication_date))
        if publisher_id is not None:
            direct_projection["publisher_id"] = publisher_id
        if venue_id is not None:
            direct_projection["venue_id"] = venue_id
        transaction = (
            self._catalog.critical_transaction()
            if _connection is None
            else nullcontext(_connection)
        )
        with catalog_operation("WorkVersion ingestion"):
            with transaction as connection:
                work_created = False
                observed = connection.execute(
                    select(metadata_observations.c.work_version_id).where(
                        metadata_observations.c.provider == provider,
                        metadata_observations.c.provider_record_id == provider_record_id,
                    ).limit(1)
                ).scalar_one_or_none()
                if observed is not None:
                    version_id = observed
                else:
                    version_id = self._match_version(
                        connection, normalized_title, normalized_doi, version_class,
                        publication_date, venue_id,
                    )
                if version_id is None:
                    work_id = (
                        _work_id
                        if _work_id is not None
                        else (
                            None
                            if _force_new_work
                            else self._choose_work(
                                connection,
                                normalized_title,
                                normalized_doi,
                                related_work_version_id,
                            )
                        )
                    )
                    if work_id is None:
                        work_created = True
                        work_id = new_uuid4()
                        now = utc_now_rfc3339()
                        connection.execute(insert(works).values(
                            id=work_id, status="active", preferred_work_version_id=None,
                            preferred_version_is_manual=0, needs_review=0, review_reason=None,
                            merged_into_work_id=None, created_at=now, updated_at=now,
                        ))
                    version_id = new_uuid4()
                    now = utc_now_rfc3339()
                    stable_key = self._stable_key(
                        normalized_doi, normalized_title, version_class, publication_date,
                        venue_id, provider, provider_record_id,
                    )
                    connection.execute(insert(work_versions).values(
                        id=version_id, work_id=work_id, version_class=version_class,
                        normalized_title=normalized_title, title=title, publication_date=publication_date,
                        publication_year=canonical_values.pop("publication_year", self._year(publication_date)),
                        publisher_id=publisher_id, venue_id=venue_id, **canonical_values,
                        provider_precedence=provider_precedence, stable_version_key=stable_key,
                        is_provisional=int(normalized_doi is None and not self._complete_version_key(publication_date, venue_id)),
                        created_at=now, updated_at=now,
                    ))
                row = connection.execute(select(work_versions).where(work_versions.c.id == version_id)).mappings().one()
                if related_work_version_id is not None:
                    self._record_relation(
                        connection,
                        version_id,
                        related_work_version_id,
                        relation_type,
                        relation_evidence,
                    )
                if normalized_doi is not None:
                    existing_doi = connection.execute(select(work_version_identifiers.c.value).where(
                        work_version_identifiers.c.work_version_id == version_id,
                        work_version_identifiers.c.namespace == "doi",
                    )).scalar_one_or_none()
                    if existing_doi is not None and existing_doi != normalized_doi:
                        raise CatalogError("different DOI values cannot identify one WorkVersion")
                    if existing_doi is None:
                        connection.execute(insert(work_version_identifiers).values(
                            id=new_uuid4(), work_version_id=version_id, namespace="doi", value=normalized_doi,
                            created_at=utc_now_rfc3339(),
                        ))
                        connection.execute(update(work_versions).where(work_versions.c.id == version_id).values(
                            stable_version_key=f"doi:{normalized_doi}", is_provisional=0,
                            updated_at=utc_now_rfc3339(),
                        ))
                        work_identifier = connection.execute(select(identifiers.c.id).where(
                            identifiers.c.namespace == "doi", identifiers.c.value == normalized_doi,
                        )).scalar_one_or_none()
                        if work_identifier is None:
                            connection.execute(insert(identifiers).values(
                                id=new_uuid4(), work_id=row["work_id"], namespace="doi", value=normalized_doi,
                                created_at=utc_now_rfc3339(),
                            ))
                current = connection.execute(
                    select(work_versions).where(work_versions.c.id == version_id)
                ).mappings().one()
                fill_values = {
                    key: value
                    for key, value in self._canonical_metadata(metadata_values).items()
                    if current[key] is None
                }
                if current["publisher_id"] is None and publisher_id is not None:
                    fill_values["publisher_id"] = publisher_id
                if current["venue_id"] is None and venue_id is not None:
                    fill_values["venue_id"] = venue_id
                if fill_values:
                    connection.execute(
                        update(work_versions).where(work_versions.c.id == version_id).values(
                            **fill_values, updated_at=utc_now_rfc3339()
                        )
                    )
                observations = {"title": title, **metadata_values}
                if normalized_doi is not None:
                    observations["doi"] = normalized_doi
                for field_name in sorted(observations):
                    value_json = canonical_json(observations[field_name])
                    exists = connection.execute(select(metadata_observations.c.id).where(
                        metadata_observations.c.provider == provider,
                        metadata_observations.c.provider_record_id == provider_record_id,
                        metadata_observations.c.field_name == field_name,
                        metadata_observations.c.value_json == value_json,
                    )).scalar_one_or_none()
                    if exists is None:
                        connection.execute(insert(metadata_observations).values(
                            id=new_uuid4(), work_version_id=version_id, provider=provider,
                            provider_record_id=provider_record_id, field_name=field_name,
                            value_json=value_json,
                            provenance_json=canonical_json(
                                {"provider": provider}
                                if observation_provenance is None
                                else observation_provenance
                            ),
                            observed_at=utc_now_rfc3339(),
                        ))
                self._refresh_direct_provider_projection(connection, version_id, direct_projection, provider_precedence)
                recompute_preferred(connection, row["work_id"])
                record = _version_record(
                    connection.execute(
                        select(work_versions).where(work_versions.c.id == version_id)
                    ).mappings().one()
                )
                return record, work_created

    def ingest_metadata_batch(
        self,
        *,
        title: str,
        identifiers_to_persist: Sequence[Identifier],
        observations: Sequence[MetadataIngestionObservation],
        provider_precedence: Sequence[str],
        review_reason: str | None = None,
        _connection: Connection | None = None,
    ) -> WorkVersionRecord:
        """Persist one merged metadata result and all source evidence atomically."""
        title = _required_text(title, "title")
        if not observations:
            raise ValueError("observations must not be empty")
        precedence = tuple(provider_precedence)
        if (
            not precedence
            or len(set(precedence)) != len(precedence)
            or not all(isinstance(provider, str) and provider.strip() for provider in precedence)
        ):
            raise ValueError("provider_precedence must contain unique non-blank provider names")
        ordered_identifiers = tuple(sorted(set(identifiers_to_persist), key=lambda item: (item.namespace, item.value)))
        dois = {item.value for item in ordered_identifiers if item.namespace == "doi"}
        if len(dois) > 1:
            raise CatalogError("different DOI values cannot identify one WorkVersion")
        doi = next(iter(dois), None)
        primary = next(
            (
                observation
                for observation in observations
                if any(name == "doi" and value == doi for name, value in observation.fields)
            ),
            observations[0],
        )
        primary_fields = dict(primary.fields)
        primary_title = primary_fields.get("title")
        if not isinstance(primary_title, str) or not primary_title.strip():
            primary_title = title
        primary_doi = primary_fields.get("doi")
        if not isinstance(primary_doi, str):
            primary_doi = doi

        provider_rank = {provider: index for index, provider in enumerate(precedence)}
        selected_fields: dict[str, object] = {}
        for observation in sorted(
            observations,
            key=lambda item: (
                provider_rank.get(item.provider, len(provider_rank)),
                item.provider,
                item.provider_record_id,
            ),
        ):
            for field_name, value in observation.fields:
                if field_name not in selected_fields and self._provider_value_present(value):
                    selected_fields[field_name] = value
        selected_date = selected_fields.get("publication_date")
        publication_date = (
            selected_date
            if isinstance(selected_date, str)
            and re.fullmatch(r"\d{4}(?:-\d{2}-\d{2})?", selected_date)
            else None
        )

        transaction = (
            self._catalog.critical_transaction()
            if _connection is None
            else nullcontext(_connection)
        )
        with transaction as connection:
            publisher_id = self._resolve_registry_id(
                connection, "publisher", selected_fields.get("publisher")
            )
            venue_id = self._resolve_registry_id(
                connection, "venue", selected_fields.get("venue")
            )
            identifier_owner_ids = set(connection.execute(
                select(work_version_identifiers.c.work_version_id).where(
                    tuple_(work_version_identifiers.c.namespace, work_version_identifiers.c.value).in_(
                        [(item.namespace, item.value) for item in ordered_identifiers]
                    )
                )
            ).scalars()) if ordered_identifiers else set()
            if doi is not None:
                identifier_owner_ids = {
                    version_id
                    for version_id in identifier_owner_ids
                    if (
                        (owner_doi := connection.execute(
                            select(work_version_identifiers.c.value).where(
                                work_version_identifiers.c.work_version_id == version_id,
                                work_version_identifiers.c.namespace == "doi",
                            )
                        ).scalar_one_or_none())
                        is None
                        or owner_doi == doi
                    )
                }
            if len(identifier_owner_ids) > 1:
                raise CatalogError("metadata identifiers belong to different WorkVersions")
            observation_keys = tuple(sorted({
                (observation.provider, observation.provider_record_id)
                for observation in observations
            }))
            observation_owner_ids = set(connection.execute(
                select(metadata_observations.c.work_version_id).where(
                    tuple_(
                        metadata_observations.c.provider,
                        metadata_observations.c.provider_record_id,
                    ).in_(observation_keys)
                )
            ).scalars())
            if len(observation_owner_ids) > 1:
                raise CatalogError("metadata observations belong to different WorkVersions")
            if identifier_owner_ids and observation_owner_ids != identifier_owner_ids and observation_owner_ids:
                raise CatalogError("metadata observation owner conflicts with identifier owner")
            owner_ids = identifier_owner_ids | observation_owner_ids
            if owner_ids:
                version = _version_record(connection.execute(
                    select(work_versions).where(
                        work_versions.c.id == next(iter(owner_ids))
                    )
                ).mappings().one())
                existing_doi = connection.execute(select(work_version_identifiers.c.value).where(
                    work_version_identifiers.c.work_version_id == version.id,
                    work_version_identifiers.c.namespace == "doi",
                )).scalar_one_or_none()
                if doi is not None and existing_doi is not None and doi != existing_doi:
                    raise CatalogError("different DOI values cannot identify one WorkVersion")
            else:
                provisional_candidates = ()
                if doi is not None:
                    provisional_candidates = tuple(connection.execute(
                        select(work_versions.c.id).select_from(
                            work_versions.join(works, works.c.id == work_versions.c.work_id)
                        ).where(
                            work_versions.c.normalized_title == normalize_title(title),
                            works.c.needs_review == 0,
                            work_versions.c.is_provisional == 1,
                            ~work_versions.c.id.in_(
                                select(work_version_identifiers.c.work_version_id).where(
                                    work_version_identifiers.c.namespace == "doi"
                                )
                            ),
                        ).order_by(work_versions.c.id)
                    ).scalars())
                if len(provisional_candidates) == 1:
                    version = _version_record(connection.execute(
                        select(work_versions).where(
                            work_versions.c.id == provisional_candidates[0]
                        )
                    ).mappings().one())
                else:
                    metadata_fields = {
                        key: value
                        for key, value in primary.fields
                        if key not in {
                            "title", "doi", "publication_date", "publisher", "venue"
                        }
                    }
                    version, _ = self.ingest_version_with_disposition(
                        provider=primary.provider,
                        provider_record_id=primary.provider_record_id,
                        title=primary_title,
                        doi=primary_doi,
                        publication_date=publication_date,
                        publisher_id=publisher_id,
                        venue_id=venue_id,
                        provider_precedence=precedence.index(primary.provider),
                        metadata=metadata_fields,
                        observation_provenance=dict(primary.provenance),
                        _connection=connection,
                        _force_new_work=review_reason is not None,
                    )
                    if len(provisional_candidates) > 1:
                        ambiguous_work_ids = set(connection.execute(
                            select(work_versions.c.work_id).where(
                                work_versions.c.id.in_(provisional_candidates)
                            )
                        ).scalars())
                        ambiguous_work_ids.add(version.work_id)
                        connection.execute(update(works).where(
                            works.c.id.in_(ambiguous_work_ids)
                        ).values(
                            needs_review=1,
                            review_reason="ambiguous exact-title DOI enrichment",
                            updated_at=utc_now_rfc3339(),
                        ))
            for identifier in ordered_identifiers:
                exists = connection.execute(select(work_version_identifiers.c.id).where(
                    work_version_identifiers.c.namespace == identifier.namespace,
                    work_version_identifiers.c.value == identifier.value,
                )).scalar_one_or_none()
                if exists is None:
                    connection.execute(insert(work_version_identifiers).values(
                        id=new_uuid4(), work_version_id=version.id, namespace=identifier.namespace,
                        value=identifier.value, created_at=utc_now_rfc3339(),
                    ))
                work_identifier = connection.execute(select(identifiers.c.id).where(
                    identifiers.c.namespace == identifier.namespace,
                    identifiers.c.value == identifier.value,
                )).scalar_one_or_none()
                if work_identifier is None:
                    connection.execute(insert(identifiers).values(
                        id=new_uuid4(), work_id=version.work_id, namespace=identifier.namespace,
                        value=identifier.value, created_at=utc_now_rfc3339(),
                    ))
            if doi is not None:
                connection.execute(update(work_versions).where(
                    work_versions.c.id == version.id
                ).values(
                    stable_version_key=f"doi:{doi}",
                    is_provisional=0,
                    updated_at=utc_now_rfc3339(),
                ))

            for observation in observations:
                provider = _required_text(observation.provider, "provider")
                record_id = _required_text(observation.provider_record_id, "provider_record_id")
                provenance_json = canonical_json(dict(observation.provenance))
                for field_name, value in observation.fields:
                    value_json = canonical_json(value)
                    exists = connection.execute(select(metadata_observations.c.id).where(
                        metadata_observations.c.provider == provider,
                        metadata_observations.c.provider_record_id == record_id,
                        metadata_observations.c.field_name == field_name,
                        metadata_observations.c.value_json == value_json,
                    )).scalar_one_or_none()
                    if exists is None:
                        connection.execute(insert(metadata_observations).values(
                            id=new_uuid4(), work_version_id=version.id, provider=provider,
                            provider_record_id=record_id, field_name=field_name,
                            value_json=value_json, provenance_json=provenance_json,
                            observed_at=utc_now_rfc3339(),
                        ))
            self._project_provider_observations(connection, version.id, precedence)
            recompute_preferred(connection, version.work_id)
            if review_reason is not None:
                connection.execute(update(works).where(
                    works.c.id == version.work_id
                ).values(
                    needs_review=1,
                    review_reason=_required_text(review_reason, "review_reason"),
                    updated_at=utc_now_rfc3339(),
                ))
            row = connection.execute(select(work_versions).where(work_versions.c.id == version.id)).mappings().one()
            return _version_record(row)

    def ingest_metadata_batches(
        self, batches: Sequence[MetadataIngestionBatch]
    ) -> tuple[WorkVersionRecord, ...]:
        """Persist one metadata search result set in a single transaction."""
        if not batches:
            return ()
        with self._catalog.critical_transaction() as connection:
            return tuple(
                self.ingest_metadata_batch(
                    title=batch.title,
                    identifiers_to_persist=batch.identifiers,
                    observations=batch.observations,
                    provider_precedence=batch.provider_precedence,
                    review_reason=batch.review_reason,
                    _connection=connection,
                )
                for batch in batches
            )

    def get_canonical_metadata(self, work_version_id: str) -> CandidateMetadata:
        """Read the persisted provider-canonical metadata for one WorkVersion."""
        version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(work_versions).where(work_versions.c.id == version_id)
            ).mappings().one_or_none()
            if row is None:
                raise CatalogError(f"unknown WorkVersion: {version_id}")
            venue_name = None
            if row["venue_id"] is not None:
                venue_name = connection.execute(
                    select(venues.c.canonical_name).where(venues.c.id == row["venue_id"])
                ).scalar_one()
            author_names = tuple(connection.execute(
                select(authors.c.display_name)
                .join(authorships, authorships.c.author_id == authors.c.id)
                .where(authorships.c.work_version_id == version_id)
                .order_by(authorships.c.position)
            ).scalars())
        return CandidateMetadata(
            title=row["title"],
            abstract=row["abstract"],
            authors=author_names,
            year=row["publication_year"],
            venue=venue_name,
            keywords=(),
        )

    def _project_provider_observations(
        self,
        connection: Connection,
        work_version_id: str,
        precedence: tuple[str, ...],
    ) -> None:
        rank = {provider: index for index, provider in enumerate(precedence)}
        rows = connection.execute(
            select(
                metadata_observations.c.provider,
                metadata_observations.c.provider_record_id,
                metadata_observations.c.field_name,
                metadata_observations.c.value_json,
            ).where(
                metadata_observations.c.work_version_id == work_version_id,
                metadata_observations.c.provider.in_(precedence),
            )
        ).all()
        choices: dict[str, list[tuple[tuple[object, ...], object]]] = {}
        for row in rows:
            value = json.loads(row.value_json)
            if not self._provider_value_present(value):
                continue
            key = (rank[row.provider], row.provider_record_id, row.value_json)
            choices.setdefault(row.field_name, []).append((key, value))
        for values in choices.values():
            values.sort(key=lambda item: item[0])

        projected: dict[str, object] = {}
        selected_title = self._provider_choice(choices, "title", str)
        if selected_title is not None:
            projected["title"] = selected_title
        publication_date = self._provider_choice(choices, "publication_date", str)
        if publication_date is not None and re.fullmatch(
            r"\d{4}(?:-\d{2}-\d{2})?", publication_date
        ):
            projected["publication_date"] = publication_date
        for field_name in (
            "abstract",
            "language",
            "work_type",
            "volume",
            "issue",
            "pages",
            "article_number",
            "open_access_status",
        ):
            value = self._provider_choice(choices, field_name, str)
            if value is not None:
                projected[field_name] = " ".join(value.split())
        year = self._provider_choice(choices, "publication_year", int)
        if year is None:
            year = self._provider_choice(choices, "year", int)
        if year is not None and not isinstance(year, bool) and year >= 0:
            projected["publication_year"] = year
        elif publication_date is not None and re.fullmatch(
            r"\d{4}(?:-\d{2}-\d{2})?", publication_date
        ):
            projected["publication_year"] = int(publication_date[:4])

        for kind in ("publisher", "venue"):
            for _, value in choices.get(kind, ()):
                registry_id = self._resolve_registry_id(connection, kind, value)
                if registry_id is not None:
                    projected[f"{kind}_id"] = registry_id
                    break
        observed_ranks = [rank[row.provider] for row in rows]
        if observed_ranks:
            projected["provider_precedence"] = min(observed_ranks)
        provider_precedence = projected.pop("provider_precedence", None)
        now = utc_now_rfc3339()
        connection.execute(delete(provider_canonical_projections).where(
            provider_canonical_projections.c.work_version_id == work_version_id))
        for field_name, value in projected.items():
            connection.execute(insert(provider_canonical_projections).values(
                work_version_id=work_version_id, field_name=field_name,
                value_json=canonical_json(value), projected_at=now))
        if provider_precedence is not None:
            connection.execute(update(work_versions).where(work_versions.c.id == work_version_id).values(
                provider_precedence=provider_precedence, updated_at=now))
        recompute_canonical_projection(connection, work_version_id)

        author_value = self._provider_choice(choices, "authors", list)
        if author_value is not None and all(isinstance(item, str) for item in author_value):
            self._sync_authorships(connection, work_version_id, tuple(author_value))

    @staticmethod
    def _refresh_direct_provider_projection(connection: Connection, work_version_id: str,
                                            values: Mapping[str, object], precedence: int | None) -> None:
        current_precedence = connection.execute(select(work_versions.c.provider_precedence).where(
            work_versions.c.id == work_version_id)).scalar_one()
        existing = set(connection.execute(select(provider_canonical_projections.c.field_name).where(
            provider_canonical_projections.c.work_version_id == work_version_id)).scalars())
        may_replace = not existing or (precedence is not None and (current_precedence is None or precedence <= current_precedence))
        now = utc_now_rfc3339()
        for field_name, value in values.items():
            if value is None or (field_name in existing and not may_replace):
                continue
            connection.execute(insert(provider_canonical_projections).prefix_with("OR REPLACE").values(
                work_version_id=work_version_id, field_name=field_name,
                value_json=canonical_json(value), projected_at=now))
        recompute_canonical_projection(connection, work_version_id)

    @staticmethod
    def _provider_value_present(value: object) -> bool:
        if value is None or value == []:
            return False
        return not isinstance(value, str) or bool(value.strip())

    @staticmethod
    def _provider_choice(
        choices: Mapping[str, Sequence[tuple[tuple[object, ...], object]]],
        field_name: str,
        expected_type: type[Any],
    ) -> Any | None:
        for _, value in choices.get(field_name, ()):
            if isinstance(value, expected_type):
                return value
        return None

    @staticmethod
    def _resolve_registry_id(connection: Connection, kind: str, value: object) -> str | None:
        if not isinstance(value, str) or not value.strip():
            return None
        table, alias_table, foreign_key = RegistryRepository._tables(kind)
        normalized = normalize_title(value)
        record_id = connection.execute(select(table.c.id).where(
            table.c.normalized_name == normalized
        )).scalar_one_or_none()
        if record_id is not None:
            return record_id
        return connection.execute(select(alias_table.c[foreign_key]).where(
            alias_table.c.normalized_alias == normalized
        )).scalar_one_or_none()

    @staticmethod
    def _sync_authorships(connection: Connection, work_version_id: str, value: object) -> None:
        if not isinstance(value, tuple) or not all(isinstance(item, str) for item in value):
            return
        existing = {
            row.position: row
            for row in connection.execute(
                select(authorships.c.id, authorships.c.position, authors.c.id.label("author_id"), authors.c.display_name)
                .join(authors, authors.c.id == authorships.c.author_id)
                .where(authorships.c.work_version_id == work_version_id)
            )
        }
        for position, display_name in enumerate(value):
            current = existing.pop(position, None)
            if current is not None and current.display_name == display_name:
                continue
            if current is not None:
                connection.execute(delete(authorships).where(authorships.c.id == current.id))
            author_id = new_uuid4()
            connection.execute(insert(authors).values(
                id=author_id, display_name=display_name, normalized_name=display_name.casefold(),
                orcid=None, created_at=utc_now_rfc3339(),
            ))
            connection.execute(insert(authorships).values(
                id=new_uuid4(), work_version_id=work_version_id, author_id=author_id,
                position=position, role=None, is_corresponding=0, affiliation=None,
                created_at=utc_now_rfc3339(),
            ))
        for row in existing.values():
            connection.execute(delete(authorships).where(authorships.c.id == row.id))

    @staticmethod
    def _canonical_metadata(metadata: Mapping[str, object]) -> dict[str, object]:
        values: dict[str, object] = {}
        for field_name in (
            "abstract",
            "language",
            "work_type",
            "volume",
            "issue",
            "pages",
            "article_number",
            "open_access_status",
        ):
            value = metadata.get(field_name)
            if isinstance(value, str) and value.strip():
                values[field_name] = " ".join(value.split())
        year = metadata.get("publication_year", metadata.get("year"))
        if isinstance(year, int) and not isinstance(year, bool) and year >= 0:
            values["publication_year"] = year
        return values

    @staticmethod
    def _year(publication_date: str | None) -> int | None:
        if publication_date is None or not re.fullmatch(r"\d{4}(?:-\d{2}-\d{2})?", publication_date):
            return None
        return int(publication_date[:4])

    @staticmethod
    def _complete_version_key(publication_date: str | None, venue_id: str | None) -> bool:
        return publication_date is not None and venue_id is not None

    @staticmethod
    def _stable_key(doi: str | None, title: str, version_class: str, publication_date: str | None,
                    venue_id: str | None, provider: str, provider_record_id: str) -> str:
        if doi is not None:
            return f"doi:{doi}"
        if publication_date is not None and venue_id is not None:
            return f"{_TITLE_RULE_VERSION}:{title}|{version_class}|{publication_date}|{venue_id}"
        return f"provider:{provider}:{provider_record_id}"

    @staticmethod
    def _match_version(connection, title: str, doi: str | None, version_class: str,
                       publication_date: str | None, venue_id: str | None) -> str | None:
        if doi is not None:
            matched = connection.execute(select(work_version_identifiers.c.work_version_id).where(
                work_version_identifiers.c.namespace == "doi", work_version_identifiers.c.value == doi,
            )).scalar_one_or_none()
            if matched is not None:
                return matched
            if publication_date is None or venue_id is None:
                return None
            candidates = connection.execute(select(work_versions.c.id).where(
                work_versions.c.normalized_title == title,
                work_versions.c.version_class == version_class,
                work_versions.c.publication_date == publication_date,
                work_versions.c.venue_id == venue_id,
                ~work_versions.c.id.in_(select(work_version_identifiers.c.work_version_id).where(
                    work_version_identifiers.c.namespace == "doi"
                )),
            )).scalars().all()
            return candidates[0] if len(candidates) == 1 else None
        if publication_date is None or venue_id is None:
            return None
        rows = connection.execute(select(work_versions.c.id).where(
            work_versions.c.normalized_title == title, work_versions.c.version_class == version_class,
            work_versions.c.publication_date == publication_date, work_versions.c.venue_id == venue_id,
        )).scalars().all()
        return rows[0] if len(rows) == 1 else None

    @staticmethod
    def _choose_work(
        connection,
        title: str,
        doi: str | None,
        related_work_version_id: str | None,
    ) -> str | None:
        if related_work_version_id is not None:
            related_work_version_id = validate_uuid(
                related_work_version_id,
                "related_work_version_id",
            )
            related_owner_work_id = connection.execute(
                select(work_versions.c.work_id).where(
                    work_versions.c.id == related_work_version_id
                )
            ).scalar_one_or_none()
            if related_owner_work_id is None:
                raise CatalogError("related WorkVersion does not exist")
            return related_owner_work_id
        rows = connection.execute(select(work_versions.c.work_id, work_version_identifiers.c.value).select_from(
            work_versions.outerjoin(work_version_identifiers,
                (work_version_identifiers.c.work_version_id == work_versions.c.id)
                & (work_version_identifiers.c.namespace == "doi"))
        ).where(work_versions.c.normalized_title == title)).all()
        if not rows:
            return None
        doi_values = {row[1] for row in rows if row[1] is not None}
        if doi is not None and doi_values and doi not in doi_values:
            return None
        work_ids = {row[0] for row in rows}
        return next(iter(work_ids)) if len(work_ids) == 1 else None

    @staticmethod
    def _record_relation(
        connection,
        source_work_version_id: str,
        target_work_version_id: str,
        relation_type: str,
        evidence: Mapping[str, object] | None,
    ) -> None:
        target_work_version_id = validate_uuid(
            target_work_version_id,
            "related_work_version_id",
        )
        if source_work_version_id == target_work_version_id:
            return
        relation_type = _required_text(relation_type, "relation_type")
        if evidence is None or not evidence:
            raise ValueError("relation_evidence must describe the explicit version relation")
        source_work_id, target_work_id = connection.execute(
            select(work_versions.c.work_id).where(
                work_versions.c.id.in_(
                    (source_work_version_id, target_work_version_id)
                )
            ).order_by(work_versions.c.id)
        ).scalars().all()
        if source_work_id != target_work_id:
            raise CatalogError("related WorkVersions must belong to the same Work")
        exists = connection.execute(
            select(version_relations.c.id).where(
                version_relations.c.source_work_version_id == source_work_version_id,
                version_relations.c.target_work_version_id == target_work_version_id,
                version_relations.c.relation_type == relation_type,
            )
        ).scalar_one_or_none()
        if exists is None:
            connection.execute(
                insert(version_relations).values(
                    id=new_uuid4(),
                    source_work_version_id=source_work_version_id,
                    target_work_version_id=target_work_version_id,
                    relation_type=relation_type,
                    evidence_json=canonical_json(evidence),
                    created_at=utc_now_rfc3339(),
                )
            )

    def list_relations(
        self,
        work_version_id: str,
    ) -> tuple[VersionRelationRecord, ...]:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(version_relations)
                .where(
                    (version_relations.c.source_work_version_id == work_version_id)
                    | (version_relations.c.target_work_version_id == work_version_id)
                )
                .order_by(version_relations.c.created_at, version_relations.c.id)
            ).mappings().all()
        return tuple(
            VersionRelationRecord(
                **{
                    field: row[field]
                    for field in VersionRelationRecord.__dataclass_fields__
                }
            )
            for row in rows
        )

    def list_observations(
        self,
        work_version_id: str,
    ) -> tuple[MetadataObservationRecord, ...]:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(metadata_observations)
                .where(metadata_observations.c.work_version_id == work_version_id)
                .order_by(
                    metadata_observations.c.provider,
                    metadata_observations.c.provider_record_id,
                    metadata_observations.c.field_name,
                    metadata_observations.c.id,
                )
            ).mappings().all()
        return tuple(
            MetadataObservationRecord(
                **{
                    field: row[field]
                    for field in MetadataObservationRecord.__dataclass_fields__
                }
            )
            for row in rows
        )

__all__ = (
    "MetadataIngestionBatch",
    "MetadataIngestionObservation",
    "WorkRepository",
)
