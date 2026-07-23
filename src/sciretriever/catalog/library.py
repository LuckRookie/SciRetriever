"""Typed repositories for the fresh Work-centered catalog."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from typing import Any

from sqlalchemy import Connection, insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    authors,
    authorships,
    generated_work_version_tags,
    identifiers,
    manual_work_tags,
    metadata_observations,
    publisher_aliases,
    publishers,
    tag_aliases,
    tags,
    venue_aliases,
    venues,
    version_relations,
    version_references,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.catalog.records import (
    AuthorRecord,
    AuthorshipRecord,
    MetadataObservationRecord,
    RegistryRecord,
    TagRecord,
    VersionRelationRecord,
    VersionReferenceRecord,
    WorkRecord,
    WorkVersionRecord,
)
from sciretriever.catalog.repository import _append_event, _required_text, _work_record, canonical_json, catalog_operation
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


_TITLE_RULE_VERSION = "title-v1"
_CLASS_RANK = {"formal_publication": 0, "accepted_manuscript": 1, "preprint": 2, "unknown": 3, "other": 3}


def normalize_title(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", _required_text(value, "title")).casefold()
    without_punctuation = "".join(
        " " if unicodedata.category(character)[0] in {"P", "S"} else character
        for character in normalized
    )
    return " ".join(without_punctuation.split())


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


class WorkRepository:
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
        _connection: Connection | None = None,
        _work_id: str | None = None,
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
                        else self._choose_work(
                            connection,
                            normalized_title,
                            normalized_doi,
                            related_work_version_id,
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
                            value_json=value_json, provenance_json=canonical_json({"provider": provider}),
                            observed_at=utc_now_rfc3339(),
                        ))
                if observed is None:
                    _append_event(
                        connection,
                        subject_type="work_version",
                        subject_id=version_id,
                        event_type="metadata.observed",
                        details={"provider": provider, "provider_record_id": provider_record_id},
                    )
                self._recompute_preferred(connection, row["work_id"])
                record = _version_record(
                    connection.execute(
                        select(work_versions).where(work_versions.c.id == version_id)
                    ).mappings().one()
                )
                return record, work_created

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

    def set_preferred(self, work_id: str, work_version_id: str | None) -> WorkRecord:
        work_id = validate_uuid(work_id, "work_id")
        if work_version_id is not None:
            work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.critical_transaction() as connection:
            if work_version_id is not None:
                owner = connection.execute(select(work_versions.c.work_id).where(work_versions.c.id == work_version_id)).scalar_one_or_none()
                if owner != work_id:
                    raise CatalogError("preferred WorkVersion must belong to the Work")
                connection.execute(update(works).where(works.c.id == work_id).values(
                    preferred_work_version_id=work_version_id, preferred_version_is_manual=1,
                    updated_at=utc_now_rfc3339(),
                ))
            else:
                connection.execute(update(works).where(works.c.id == work_id).values(preferred_version_is_manual=0))
                self._recompute_preferred(connection, work_id)
            return _work_record(connection.execute(select(works).where(works.c.id == work_id)).mappings().one())

    @staticmethod
    def _recompute_preferred(connection, work_id: str) -> None:
        work = connection.execute(select(works).where(works.c.id == work_id)).mappings().one()
        if work["preferred_version_is_manual"]:
            return
        rows = connection.execute(select(work_versions).where(work_versions.c.work_id == work_id)).mappings().all()
        doi_versions = set(connection.execute(select(work_version_identifiers.c.work_version_id).where(
            work_version_identifiers.c.namespace == "doi",
            work_version_identifiers.c.work_version_id.in_([row["id"] for row in rows]),
        )).scalars())
        def key(row):
            date = row["publication_date"] or ""
            precedence = row["provider_precedence"] if row["provider_precedence"] is not None else 2**31
            return (_CLASS_RANK[row["version_class"]], row["id"] not in doi_versions,
                    tuple(-ord(char) for char in date), precedence, row["stable_version_key"])
        preferred = min(rows, key=key)
        connection.execute(update(works).where(works.c.id == work_id).values(
            preferred_work_version_id=preferred["id"], updated_at=utc_now_rfc3339(),
        ))


class RegistryRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add(
        self,
        kind: str,
        canonical_name: str,
        aliases: Sequence[str] = (),
        *,
        _connection: Connection | None = None,
    ) -> RegistryRecord:
        table, alias_table, foreign_key = self._tables(kind)
        name = _required_text(canonical_name, "canonical_name")
        normalized_name = normalize_title(name)
        transaction = (
            self._catalog.critical_transaction()
            if _connection is None
            else nullcontext(_connection)
        )
        with transaction as connection:
            row = connection.execute(select(table).where(table.c.normalized_name == normalized_name)).mappings().one_or_none()
            alias_owner = connection.execute(
                select(alias_table.c[foreign_key]).where(
                    alias_table.c.normalized_alias == normalized_name
                )
            ).scalar_one_or_none()
            if row is None and alias_owner is not None:
                raise CatalogError("canonical name conflicts with an existing alias")
            if row is None:
                row = {
                    "id": new_uuid4(),
                    "canonical_name": name,
                    "normalized_name": normalized_name,
                    "created_at": utc_now_rfc3339(),
                }
                connection.execute(insert(table).values(**row))
            for alias in aliases:
                alias_value = _required_text(alias, "alias")
                normalized_alias = normalize_title(alias_value)
                canonical_owner = connection.execute(
                    select(table.c.id).where(table.c.normalized_name == normalized_alias)
                ).scalar_one_or_none()
                if canonical_owner is not None:
                    if canonical_owner == row["id"]:
                        continue
                    raise CatalogError("alias conflicts with an existing canonical name")
                existing_owner = connection.execute(
                    select(alias_table.c[foreign_key]).where(
                        alias_table.c.normalized_alias == normalized_alias
                    )
                ).scalar_one_or_none()
                if existing_owner is None:
                    connection.execute(insert(alias_table).values(
                        id=new_uuid4(), **{foreign_key: row["id"]}, alias=alias_value,
                        normalized_alias=normalized_alias,
                        created_at=utc_now_rfc3339(),
                    ))
                elif existing_owner != row["id"]:
                    raise CatalogError("alias is already assigned to another registry record")
            return RegistryRecord(
                id=row["id"],
                canonical_name=row["canonical_name"],
                created_at=row["created_at"],
            )

    def resolve(self, kind: str, value: str) -> RegistryRecord | None:
        table, alias_table, foreign_key = self._tables(kind)
        value = _required_text(value, "value")
        normalized_value = normalize_title(value)
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(table).where(table.c.normalized_name == normalized_value)
            ).mappings().one_or_none()
            if row is None:
                row = connection.execute(
                    select(table)
                    .join(alias_table, alias_table.c[foreign_key] == table.c.id)
                    .where(alias_table.c.normalized_alias == normalized_value)
                ).mappings().one_or_none()
        return None if row is None else RegistryRecord(**{field: row[field] for field in RegistryRecord.__dataclass_fields__})

    @staticmethod
    def _tables(kind: str):
        if kind == "publisher":
            return publishers, publisher_aliases, "publisher_id"
        if kind == "venue":
            return venues, venue_aliases, "venue_id"
        raise ValueError("kind must be publisher or venue")


class AuthorRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add_authorship(self, work_version_id: str, name: str, position: int, *, orcid: str | None = None,
                       role: str | None = None, is_corresponding: bool = False,
                       affiliation: str | None = None) -> tuple[AuthorRecord, AuthorshipRecord]:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        display_name = _required_text(name, "name")
        normalized_name = display_name.casefold()
        with self._catalog.critical_transaction() as connection:
            row = None if orcid is None else connection.execute(select(authors).where(authors.c.orcid == orcid)).mappings().one_or_none()
            if row is None:
                row = {"id": new_uuid4(), "display_name": display_name, "normalized_name": normalized_name,
                       "orcid": orcid, "created_at": utc_now_rfc3339()}
                connection.execute(insert(authors).values(**row))
            link = {"id": new_uuid4(), "work_version_id": work_version_id, "author_id": row["id"],
                    "position": position, "role": role, "is_corresponding": int(is_corresponding),
                    "affiliation": affiliation, "created_at": utc_now_rfc3339()}
            connection.execute(insert(authorships).values(**link))
            return AuthorRecord(**row), AuthorshipRecord(**{**link, "is_corresponding": bool(link["is_corresponding"])})


class TagRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add(self, canonical_name: str, *, definition: str | None = None,
            aliases: Sequence[str] = ()) -> TagRecord:
        name = _required_text(canonical_name, "canonical_name")
        normalized_name = normalize_title(name)
        with self._catalog.critical_transaction() as connection:
            row = connection.execute(select(tags).where(tags.c.normalized_name == normalized_name)).mappings().one_or_none()
            alias_owner = connection.execute(
                select(tag_aliases.c.tag_id).where(
                    tag_aliases.c.normalized_alias == normalized_name
                )
            ).scalar_one_or_none()
            if row is None and alias_owner is not None:
                raise CatalogError("canonical tag name conflicts with an existing alias")
            if row is None:
                row = {"id": new_uuid4(), "canonical_name": name,
                       "normalized_name": normalized_name, "definition": definition,
                       "created_at": utc_now_rfc3339()}
                connection.execute(insert(tags).values(**row))
            for alias in aliases:
                alias_value = _required_text(alias, "alias")
                normalized_alias = normalize_title(alias_value)
                canonical_owner = connection.execute(
                    select(tags.c.id).where(tags.c.normalized_name == normalized_alias)
                ).scalar_one_or_none()
                if canonical_owner is not None:
                    if canonical_owner == row["id"]:
                        continue
                    raise CatalogError("tag alias conflicts with an existing canonical name")
                existing_owner = connection.execute(
                    select(tag_aliases.c.tag_id).where(
                        tag_aliases.c.normalized_alias == normalized_alias
                    )
                ).scalar_one_or_none()
                if existing_owner is None:
                    connection.execute(insert(tag_aliases).values(id=new_uuid4(), tag_id=row["id"],
                        alias=alias_value, normalized_alias=normalized_alias,
                        language=None, created_at=utc_now_rfc3339()))
                elif existing_owner != row["id"]:
                    raise CatalogError("tag alias is already assigned to another tag")
            return TagRecord(
                id=row["id"],
                canonical_name=row["canonical_name"],
                definition=row["definition"],
                created_at=row["created_at"],
            )

    def add_manual(self, work_id: str, tag_id: str) -> None:
        self._link(manual_work_tags, "work_id", work_id, tag_id, None)

    def resolve(self, value: str) -> TagRecord | None:
        normalized_value = normalize_title(_required_text(value, "value"))
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(tags).where(tags.c.normalized_name == normalized_value)
            ).mappings().one_or_none()
            if row is None:
                row = connection.execute(
                    select(tags)
                    .join(tag_aliases, tag_aliases.c.tag_id == tags.c.id)
                    .where(tag_aliases.c.normalized_alias == normalized_value)
                ).mappings().one_or_none()
        if row is None:
            return None
        return TagRecord(
            id=row["id"],
            canonical_name=row["canonical_name"],
            definition=row["definition"],
            created_at=row["created_at"],
        )

    def add_generated(self, work_version_id: str, tag_id: str, source_artifact_id: str) -> None:
        self._link(generated_work_version_tags, "work_version_id", work_version_id, tag_id, source_artifact_id)

    def _link(self, table, owner_key: str, owner_id: str, tag_id: str, source_artifact_id: str | None) -> None:
        values = {owner_key: validate_uuid(owner_id, owner_key), "tag_id": validate_uuid(tag_id, "tag_id"),
                  "linked_at": utc_now_rfc3339()}
        if source_artifact_id is not None:
            values["source_artifact_id"] = validate_uuid(source_artifact_id, "source_artifact_id")
        with self._catalog.critical_transaction() as connection:
            connection.execute(insert(table).prefix_with("OR IGNORE").values(**values))


class ReferenceRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def add(self, citing_work_version_id: str, reference_order: int, raw_reference: str, *,
            cited_work_id: str | None = None, identifier: Identifier | None = None,
            source_artifact_id: str | None = None, locator: object | None = None) -> VersionReferenceRecord:
        citing_work_version_id = validate_uuid(citing_work_version_id, "citing_work_version_id")
        if cited_work_id is not None:
            cited_work_id = validate_uuid(cited_work_id, "cited_work_id")
        if source_artifact_id is not None:
            source_artifact_id = validate_uuid(source_artifact_id, "source_artifact_id")
        values = {"id": new_uuid4(), "citing_work_version_id": citing_work_version_id,
                  "cited_work_id": cited_work_id, "reference_order": reference_order,
                  "raw_reference": _required_text(raw_reference, "raw_reference"),
                  "cited_namespace": None if identifier is None else identifier.namespace,
                  "cited_value": None if identifier is None else identifier.value,
                  "source_artifact_id": source_artifact_id,
                  "locator_json": None if locator is None else canonical_json(locator),
                  "created_at": utc_now_rfc3339()}
        with self._catalog.critical_transaction() as connection:
            connection.execute(insert(version_references).values(**values))
        return VersionReferenceRecord(**values)

    def cited_by(self, work_id: str) -> tuple[VersionReferenceRecord, ...]:
        work_id = validate_uuid(work_id, "work_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(select(version_references).where(
                version_references.c.cited_work_id == work_id
            ).order_by(version_references.c.created_at, version_references.c.id)).mappings().all()
        return tuple(VersionReferenceRecord(**{field: row[field] for field in VersionReferenceRecord.__dataclass_fields__}) for row in rows)


__all__ = ("AuthorRepository", "ReferenceRepository", "RegistryRepository", "TagRepository", "WorkRepository", "normalize_title")
