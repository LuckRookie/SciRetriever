"""Bookkeeping for external domain-pack runs without domain payloads."""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Mapping

from sqlalchemy import insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import domain_runs
from sciretriever.catalog.records import DomainRunRecord
from sciretriever.catalog.repository import (
    CatalogRepository,
    _append_event,
    _required_text,
    catalog_operation,
)
from sciretriever.core.enums import DomainRunStatus
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.core.validation import validate_sha256
from sciretriever.errors import CatalogError


LEGAL_DOMAIN_RUN_TRANSITIONS: Mapping[DomainRunStatus, frozenset[DomainRunStatus]] = (
    MappingProxyType(
        {
            DomainRunStatus.PENDING: frozenset(
                {DomainRunStatus.ACTIVE, DomainRunStatus.CANCELLED}
            ),
            DomainRunStatus.ACTIVE: frozenset(
                {
                    DomainRunStatus.SUCCEEDED,
                    DomainRunStatus.FAILED,
                    DomainRunStatus.CANCELLED,
                }
            ),
            DomainRunStatus.SUCCEEDED: frozenset(),
            DomainRunStatus.FAILED: frozenset(),
            DomainRunStatus.CANCELLED: frozenset(),
        }
    )
)


def _status(value: DomainRunStatus | str) -> DomainRunStatus:
    try:
        return value if isinstance(value, DomainRunStatus) else DomainRunStatus(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"unsupported domain run status: {value!r}") from error


def _domain_run_record(row: Mapping[Any, Any]) -> DomainRunRecord:
    return DomainRunRecord(
        id=row["id"],
        package_version_id=row["package_version_id"],
        status=DomainRunStatus(row["status"]),
        output_pointer=row["output_pointer"],
        output_sha256=row["output_sha256"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class DomainRunRepository:
    """Track only status and external output references for domain runs."""

    def __init__(self, catalog: CatalogEngine | CatalogRepository) -> None:
        if isinstance(catalog, CatalogRepository):
            self.__catalog = catalog._catalog
        elif isinstance(catalog, CatalogEngine):
            if catalog.read_only:
                raise ValueError("DomainRunRepository requires a writable catalog")
            self.__catalog = catalog
        else:
            raise TypeError("catalog must be a CatalogEngine or CatalogRepository")

    def get_domain_run(self, run_id: str) -> DomainRunRecord | None:
        run_id = validate_uuid(run_id, "run_id")
        with catalog_operation("domain run lookup"):
            with self.__catalog.connect() as connection:
                row = (
                    connection.execute(select(domain_runs).where(domain_runs.c.id == run_id))
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _domain_run_record(row)

    def create_domain_run(self, package_version_id: str) -> DomainRunRecord:
        package_version_id = validate_uuid(package_version_id, "package_version_id")
        now = utc_now_rfc3339()
        values = {
            "id": new_uuid4(),
            "package_version_id": package_version_id,
            "status": DomainRunStatus.PENDING.value,
            "output_pointer": None,
            "output_sha256": None,
            "created_at": now,
            "updated_at": now,
        }
        with catalog_operation("domain run creation"):
            with self.__catalog.critical_transaction() as connection:
                connection.execute(insert(domain_runs).values(**values))
                _append_event(
                    connection,
                    subject_type="domain_run",
                    subject_id=values["id"],
                    event_type="domain_run.created",
                )
        return _domain_run_record(values)

    create = create_domain_run

    def transition_domain_run(
        self,
        run_id: str,
        new_status: DomainRunStatus | str,
        *,
        output_pointer: str | None = None,
        output_sha256: str | None = None,
    ) -> DomainRunRecord:
        run_id = validate_uuid(run_id, "run_id")
        target = _status(new_status)
        if target is DomainRunStatus.SUCCEEDED:
            if output_pointer is None or output_sha256 is None:
                raise ValueError("successful domain runs require an output pointer and SHA-256")
            pointer = _required_text(output_pointer, "output_pointer")
            sha256 = validate_sha256(output_sha256, "output_sha256")
        else:
            if output_pointer is not None or output_sha256 is not None:
                raise ValueError("only successful domain runs may record output references")
            pointer = None
            sha256 = None

        with catalog_operation("domain run transition"):
            with self.__catalog.critical_transaction() as connection:
                row = (
                    connection.execute(select(domain_runs).where(domain_runs.c.id == run_id))
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"domain run does not exist: {run_id}")
                current = DomainRunStatus(row["status"])
                if target not in LEGAL_DOMAIN_RUN_TRANSITIONS[current]:
                    raise CatalogError(
                        f"illegal domain run transition: {current.value} -> {target.value}"
                    )
                values = {
                    "status": target.value,
                    "output_pointer": pointer,
                    "output_sha256": sha256,
                    "updated_at": utc_now_rfc3339(),
                }
                connection.execute(
                    update(domain_runs).where(domain_runs.c.id == run_id).values(**values)
                )
                updated = {**dict(row), **values}
                _append_event(
                    connection,
                    subject_type="domain_run",
                    subject_id=run_id,
                    event_type="domain_run.state_changed",
                    details={"from": current.value, "to": target.value},
                )
                return _domain_run_record(updated)

    transition = transition_domain_run


__all__ = ("DomainRunRepository", "LEGAL_DOMAIN_RUN_TRANSITIONS")
