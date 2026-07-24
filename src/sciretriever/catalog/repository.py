"""SQLAlchemy Core repositories for neutral catalog records."""

from __future__ import annotations

from contextlib import contextmanager
import json
from typing import Any, Iterator, Mapping

from sqlalchemy import Connection, insert, select
from sqlalchemy.exc import IntegrityError, OperationalError

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    events,
    failures,
    identifiers,
    metadata_labels,
    works,
)
from sciretriever.catalog.records import (
    EventRecord,
    FailureRecord,
    MetadataLabelRecord,
    WorkRecord,
)
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.core.validation import validate_sha256
from sciretriever.errors import CatalogError


def canonical_json(value: object) -> str:
    """Serialize JSON with stable key ordering and no insignificant whitespace."""
    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise ValueError("value must be canonical-JSON serializable") from error


@contextmanager
def catalog_operation(action: str) -> Iterator[None]:
    """Translate storage conflicts only where repository operations cross out."""
    try:
        yield
    except (IntegrityError, OperationalError) as error:
        raise CatalogError(f"Catalog {action} failed: {error}") from error


def _required_text(value: str, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = " ".join(value.split())
    if not normalized:
        raise ValueError(f"{field_name} must not be blank")
    return normalized


def _identifier(value: Identifier | Mapping[str, object]) -> Identifier:
    if isinstance(value, Identifier):
        return Identifier(value.namespace, value.value)
    return Identifier.from_dict(value)


def _work_record(row: Mapping[Any, Any]) -> WorkRecord:
    return WorkRecord(
        id=row["id"],
        status=row["status"],
        preferred_work_version_id=row["preferred_work_version_id"],
        preferred_version_is_manual=bool(row["preferred_version_is_manual"]),
        needs_review=bool(row["needs_review"]),
        review_reason=row["review_reason"],
        merged_into_work_id=row["merged_into_work_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _label_record(row: Mapping[Any, Any]) -> MetadataLabelRecord:
    return MetadataLabelRecord(
        id=row["id"],
        work_version_id=row["work_version_id"],
        taxonomy=row["taxonomy"],
        taxonomy_version=row["taxonomy_version"],
        input_sha256=row["input_sha256"],
        label=row["label"],
        needs_review=bool(row["needs_review"]),
        created_at=row["created_at"],
    )


def _event_record(row: Mapping[Any, Any]) -> EventRecord:
    return EventRecord(
        id=row["id"],
        subject_type=row["subject_type"],
        subject_id=row["subject_id"],
        event_type=row["event_type"],
        details_json=row["details_json"],
        occurred_at=row["occurred_at"],
    )


def _failure_record(row: Mapping[Any, Any]) -> FailureRecord:
    return FailureRecord(
        id=row["id"],
        work_version_id=row["work_version_id"],
        processing_run_id=row["processing_run_id"],
        category=row["category"],
        message=row["message"],
        retryable=bool(row["retryable"]),
        details_json=row["details_json"],
        occurred_at=row["occurred_at"],
    )


def _select_work(connection: Connection, work_id: str) -> WorkRecord | None:
    row = connection.execute(select(works).where(works.c.id == work_id)).mappings().one_or_none()
    return None if row is None else _work_record(row)


def _select_work_by_identifier(
    connection: Connection,
    identifier: Identifier,
) -> WorkRecord | None:
    row = (
        connection.execute(
            select(works)
            .join(identifiers, identifiers.c.work_id == works.c.id)
            .where(
                identifiers.c.namespace == identifier.namespace,
                identifiers.c.value == identifier.value,
            )
        )
        .mappings()
        .one_or_none()
    )
    return None if row is None else _work_record(row)


def _select_labels(
    connection: Connection,
    *,
    work_version_id: str,
    taxonomy: str,
    taxonomy_version: str,
    input_sha256: str,
) -> tuple[MetadataLabelRecord, ...]:
    rows = (
        connection.execute(
            select(metadata_labels)
            .where(
                metadata_labels.c.work_version_id == work_version_id,
                metadata_labels.c.taxonomy == taxonomy,
                metadata_labels.c.taxonomy_version == taxonomy_version,
                metadata_labels.c.input_sha256 == input_sha256,
            )
            .order_by(metadata_labels.c.label, metadata_labels.c.id)
        )
        .mappings()
        .all()
    )
    return tuple(_label_record(row) for row in rows)


def _append_event(
    connection: Connection,
    *,
    subject_type: str,
    subject_id: str,
    event_type: str,
    details: object | None = None,
) -> EventRecord:
    values = {
        "id": new_uuid4(),
        "subject_type": _required_text(subject_type, "subject_type"),
        "subject_id": validate_uuid(subject_id, "subject_id"),
        "event_type": _required_text(event_type, "event_type"),
        "details_json": None if details is None else canonical_json(details),
        "occurred_at": utc_now_rfc3339(),
    }
    connection.execute(insert(events).values(**values))
    return _event_record(values)


class CatalogRepository:
    """Writable repository for catalog-owned neutral records."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("CatalogRepository requires a writable catalog")
        self._catalog = catalog

    def get_work(self, work_id: str) -> WorkRecord | None:
        work_id = validate_uuid(work_id, "work_id")
        with catalog_operation("work lookup"):
            with self._catalog.connect() as connection:
                return _select_work(connection, work_id)

    def lookup_work(self, identifier: Identifier | Mapping[str, object]) -> WorkRecord | None:
        normalized = _identifier(identifier)
        with catalog_operation("identifier lookup"):
            with self._catalog.connect() as connection:
                return _select_work_by_identifier(connection, normalized)

    find_work_by_identifier = lookup_work

    def add_metadata_label(
        self,
        work_version_id: str,
        taxonomy: str,
        taxonomy_version: str,
        input_sha256: str,
        label: str,
        *,
        needs_review: bool = False,
    ) -> MetadataLabelRecord:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        taxonomy = _required_text(taxonomy, "taxonomy")
        taxonomy_version = _required_text(taxonomy_version, "taxonomy_version")
        input_sha256 = validate_sha256(input_sha256, "input_sha256")
        label = _required_text(label, "label")
        if not isinstance(needs_review, bool):
            raise TypeError("needs_review must be a boolean")
        with catalog_operation("metadata label write"):
            with self._catalog.critical_transaction() as connection:
                existing = (
                    connection.execute(
                        select(metadata_labels).where(
                            metadata_labels.c.work_version_id == work_version_id,
                            metadata_labels.c.taxonomy == taxonomy,
                            metadata_labels.c.taxonomy_version == taxonomy_version,
                            metadata_labels.c.input_sha256 == input_sha256,
                            metadata_labels.c.label == label,
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                if existing is not None:
                    return _label_record(existing)
                values = {
                    "id": new_uuid4(),
                    "work_version_id": work_version_id,
                    "taxonomy": taxonomy,
                    "taxonomy_version": taxonomy_version,
                    "input_sha256": input_sha256,
                    "label": label,
                    "needs_review": int(needs_review),
                    "created_at": utc_now_rfc3339(),
                }
                connection.execute(insert(metadata_labels).values(**values))
                return _label_record(values)

    write_metadata_label = add_metadata_label

    def get_reusable_metadata_labels(
        self,
        work_version_id: str,
        taxonomy: str,
        taxonomy_version: str,
        input_sha256: str,
    ) -> tuple[MetadataLabelRecord, ...]:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        taxonomy = _required_text(taxonomy, "taxonomy")
        taxonomy_version = _required_text(taxonomy_version, "taxonomy_version")
        input_sha256 = validate_sha256(input_sha256, "input_sha256")
        with catalog_operation("metadata label lookup"):
            with self._catalog.connect() as connection:
                return _select_labels(
                    connection,
                    work_version_id=work_version_id,
                    taxonomy=taxonomy,
                    taxonomy_version=taxonomy_version,
                    input_sha256=input_sha256,
                )

    get_metadata_labels = get_reusable_metadata_labels

    def append_event(
        self,
        subject_type: str,
        subject_id: str,
        event_type: str,
        details: object | None = None,
    ) -> EventRecord:
        with catalog_operation("event append"):
            with self._catalog.transaction() as connection:
                return _append_event(
                    connection,
                    subject_type=subject_type,
                    subject_id=subject_id,
                    event_type=event_type,
                    details=details,
                )

    def append_failure(
        self,
        category: str,
        message: str,
        *,
        work_version_id: str | None = None,
        processing_run_id: str | None = None,
        retryable: bool = False,
        details: object | None = None,
    ) -> FailureRecord:
        contexts = {
            "work_version_id": work_version_id,
            "processing_run_id": processing_run_id,
        }
        if all(value is None for value in contexts.values()):
            raise ValueError("a failure requires at least one catalog context")
        for name, value in contexts.items():
            if value is not None:
                contexts[name] = validate_uuid(value, name)
        if not isinstance(retryable, bool):
            raise TypeError("retryable must be a boolean")
        values = {
            "id": new_uuid4(),
            **contexts,
            "category": _required_text(category, "category"),
            "message": _required_text(message, "message"),
            "retryable": int(retryable),
            "details_json": None if details is None else canonical_json(details),
            "occurred_at": utc_now_rfc3339(),
        }
        with catalog_operation("failure append"):
            with self._catalog.transaction() as connection:
                connection.execute(insert(failures).values(**values))
        return _failure_record(values)


class ReadOnlyCatalogView:
    """Discovery-facing catalog view with lookup-only capabilities."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if not catalog.read_only:
            raise CatalogError("ReadOnlyCatalogView requires a read-only catalog engine")
        self.__catalog = catalog

    def get_work(self, work_id: str) -> WorkRecord | None:
        work_id = validate_uuid(work_id, "work_id")
        with catalog_operation("read-only work lookup"):
            with self.__catalog.connect() as connection:
                return _select_work(connection, work_id)

    def lookup_work(self, identifier: Identifier | Mapping[str, object]) -> WorkRecord | None:
        normalized = _identifier(identifier)
        with catalog_operation("read-only identifier lookup"):
            with self.__catalog.connect() as connection:
                return _select_work_by_identifier(connection, normalized)

    find_work_by_identifier = lookup_work

    def get_reusable_metadata_labels(
        self,
        work_version_id: str,
        taxonomy: str,
        taxonomy_version: str,
        input_sha256: str,
    ) -> tuple[MetadataLabelRecord, ...]:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        taxonomy = _required_text(taxonomy, "taxonomy")
        taxonomy_version = _required_text(taxonomy_version, "taxonomy_version")
        input_sha256 = validate_sha256(input_sha256, "input_sha256")
        with catalog_operation("read-only metadata label lookup"):
            with self.__catalog.connect() as connection:
                return _select_labels(
                    connection,
                    work_version_id=work_version_id,
                    taxonomy=taxonomy,
                    taxonomy_version=taxonomy_version,
                    input_sha256=input_sha256,
                )

    get_metadata_labels = get_reusable_metadata_labels


__all__ = ("CatalogRepository", "ReadOnlyCatalogView", "canonical_json")
