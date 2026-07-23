"""Acquisition job, request, and attempt lifecycle repository."""

from __future__ import annotations

import json
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

from sqlalchemy import Connection, insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import acquisition_attempts, acquisition_jobs, download_requests
from sciretriever.catalog.records import (
    AttemptRecord,
    DownloadRequestRecord,
    EventRecord,
    FailureRecord,
    JobRecord,
)
from sciretriever.catalog.repository import (
    CatalogRepository,
    _append_event,
    _required_text,
    canonical_json,
    catalog_operation,
)
from sciretriever.core.enums import (
    NONTERMINAL_JOB_STATES,
    AssetRole,
    AttemptOutcome,
    JobState,
)
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.diagnostics.redaction import redact, redact_url
from sciretriever.diagnostics.codec import decode_diagnostic
from sciretriever.errors import CatalogError


# Current foreground jobs only move from admission to execution and terminal completion.
LEGAL_JOB_STATE_TRANSITIONS: Mapping[JobState, frozenset[JobState]] = MappingProxyType(
    {
        JobState.PENDING: frozenset({JobState.ACTIVE, JobState.CANCELLED}),
        JobState.ACTIVE: frozenset(
            {
                JobState.SUCCEEDED,
                JobState.FAILED,
                JobState.CANCELLED,
            }
        ),
        JobState.SUCCEEDED: frozenset(),
        JobState.FAILED: frozenset(),
        JobState.CANCELLED: frozenset(),
    }
)


def _asset_role(value: AssetRole | str) -> AssetRole:
    try:
        return value if isinstance(value, AssetRole) else AssetRole(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"unsupported asset role: {value!r}") from error


def _job_state(value: JobState | str) -> JobState:
    try:
        return value if isinstance(value, JobState) else JobState(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"unsupported job state: {value!r}") from error


def _attempt_outcome(value: AttemptOutcome | str) -> AttemptOutcome:
    try:
        return value if isinstance(value, AttemptOutcome) else AttemptOutcome(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"unsupported attempt outcome: {value!r}") from error


def _optional_text(value: str | None, field_name: str) -> str | None:
    return None if value is None else _required_text(value, field_name)


def _failure_message(details: object | None) -> str:
    if not isinstance(details, Mapping):
        return "Acquisition failure recorded"
    diagnostic = details.get("diagnostic")
    if not isinstance(diagnostic, Mapping):
        return "Acquisition failure recorded"
    try:
        encoded = canonical_json(diagnostic)
        return decode_diagnostic(encoded).summary
    except (TypeError, ValueError):
        return "Acquisition failure recorded"


def _job_record(row: Mapping[Any, Any]) -> JobRecord:
    return JobRecord(
        id=row["id"],
        work_version_id=row["work_version_id"],
        asset_role=AssetRole(row["asset_role"]),
        state=JobState(row["state"]),
        source_plan_json=row["source_plan_json"],
        next_retry_at=row["next_retry_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _request_record(row: Mapping[Any, Any]) -> DownloadRequestRecord:
    return DownloadRequestRecord(
        id=row["id"],
        work_version_id=row["work_version_id"],
        job_id=row["job_id"],
        request_key=row["request_key"],
        asset_role=AssetRole(row["asset_role"]),
        status=row["status"],
        provenance_json=row["provenance_json"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _attempt_record(row: Mapping[Any, Any]) -> AttemptRecord:
    outcome = row["outcome"]
    return AttemptRecord(
        id=row["id"],
        job_id=row["job_id"],
        provider=row["provider"],
        outcome=None if outcome is None else AttemptOutcome(outcome),
        source_url=row["source_url"],
        details_json=row["details_json"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


class JobRepository:
    """Coordinate acquisition admission and legal lifecycle transitions."""

    def __init__(self, catalog: CatalogEngine | CatalogRepository) -> None:
        if isinstance(catalog, CatalogRepository):
            self.__catalog = catalog._catalog
            self.__repository = catalog
        elif isinstance(catalog, CatalogEngine):
            if catalog.read_only:
                raise ValueError("JobRepository requires a writable catalog")
            self.__catalog = catalog
            self.__repository = CatalogRepository(catalog)
        else:
            raise TypeError("catalog must be a CatalogEngine or CatalogRepository")

    @property
    def catalog_path(self) -> Path:
        return self.__catalog.path

    def get_job(self, job_id: str) -> JobRecord | None:
        job_id = validate_uuid(job_id, "job_id")
        with catalog_operation("job lookup"):
            with self.__catalog.connect() as connection:
                row = (
                    connection.execute(
                        select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                    )
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _job_record(row)

    def get_request(self, request_key: str) -> DownloadRequestRecord | None:
        request_key = _required_text(request_key, "request_key")
        with catalog_operation("request lookup"):
            with self.__catalog.connect() as connection:
                row = (
                    connection.execute(
                        select(download_requests).where(
                            download_requests.c.request_key == request_key
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _request_record(row)

    def list_requests(self, job_id: str) -> tuple[DownloadRequestRecord, ...]:
        job_id = validate_uuid(job_id, "job_id")
        with catalog_operation("job request listing"):
            with self.__catalog.connect() as connection:
                rows = connection.execute(
                    select(download_requests)
                    .where(download_requests.c.job_id == job_id)
                    .order_by(download_requests.c.created_at, download_requests.c.id)
                ).mappings().all()
        return tuple(_request_record(row) for row in rows)

    def attach_or_create_job(
        self,
        work_version_id: str,
        asset_role: AssetRole | str,
        request_key: str | None = None,
        *,
        request_provenance: object | None = None,
    ) -> JobRecord:
        work_version_id = validate_uuid(work_version_id, "work_id")
        role = _asset_role(asset_role)
        normalized_key = None if request_key is None else _required_text(request_key, "request_key")
        provenance_json = (
            None if request_provenance is None else canonical_json(redact(request_provenance))
        )
        with catalog_operation("job admission"):
            with self.__catalog.critical_transaction() as connection:
                request = None
                if normalized_key is not None:
                    request = (
                        connection.execute(
                            select(download_requests).where(
                                download_requests.c.request_key == normalized_key
                            )
                        )
                        .mappings()
                        .one_or_none()
                    )
                    if request is not None:
                        if request["work_version_id"] != work_version_id or request["asset_role"] != role.value:
                            raise CatalogError(
                                "request_key is already bound to a different work or asset role"
                            )
                        if request["job_id"] is None:
                            raise CatalogError("request_key exists without an attached job")
                        row = (
                            connection.execute(
                                select(acquisition_jobs).where(
                                    acquisition_jobs.c.id == request["job_id"]
                                )
                            )
                            .mappings()
                            .one()
                        )
                        return _job_record(row)

                nonterminal_values = tuple(state.value for state in NONTERMINAL_JOB_STATES)
                row = (
                    connection.execute(
                        select(acquisition_jobs).where(
                            acquisition_jobs.c.work_version_id == work_version_id,
                            acquisition_jobs.c.asset_role == role.value,
                            acquisition_jobs.c.state.in_(nonterminal_values),
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                created = row is None
                if row is None:
                    now = utc_now_rfc3339()
                    values = {
                        "id": new_uuid4(),
                    "work_version_id": work_version_id,
                        "asset_role": role.value,
                        "state": JobState.PENDING.value,
                        "created_at": now,
                        "updated_at": now,
                    }
                    connection.execute(insert(acquisition_jobs).values(**values))
                    created_row = connection.execute(
                        select(acquisition_jobs).where(acquisition_jobs.c.id == values["id"])
                    ).mappings().one()
                    job = _job_record(created_row)
                else:
                    job = _job_record(row)

                if normalized_key is not None:
                    now = utc_now_rfc3339()
                    if request is None:
                        connection.execute(
                            insert(download_requests).values(
                                id=new_uuid4(),
                                work_version_id=work_version_id,
                                job_id=job.id,
                                request_key=normalized_key,
                                asset_role=role.value,
                                status="attached",
                                provenance_json=provenance_json,
                                created_at=now,
                                updated_at=now,
                            )
                        )
                    else:
                        request_changes = {
                            "job_id": job.id,
                            "status": "attached",
                            "updated_at": now,
                        }
                        if provenance_json is not None:
                            request_changes["provenance_json"] = provenance_json
                        connection.execute(
                            update(download_requests)
                            .where(download_requests.c.id == request["id"])
                            .values(**request_changes)
                        )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job.id,
                    event_type="job.created" if created else "job.request_attached",
                    details={"request_key": normalized_key} if normalized_key is not None else None,
                )
                return job

    def begin_existing_asset_import(self, job_id: str) -> bool:
        """Atomically begin one explicit asset import without durable resume semantics."""
        job_id = validate_uuid(job_id, "job_id")
        with catalog_operation("existing asset import start"):
            with self.__catalog.critical_transaction() as connection:
                row = connection.execute(
                    select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                ).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                state = JobState(row["state"])
                now = utc_now_rfc3339()
                if state is not JobState.PENDING:
                    return False
                connection.execute(
                    update(acquisition_jobs)
                    .where(
                        acquisition_jobs.c.id == job_id,
                        acquisition_jobs.c.state == state.value,
                    )
                    .values(state=JobState.ACTIVE.value, updated_at=now)
                )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="existing_asset_import.started",
                    details={"from": state.value},
                )
                return True

    def restart_foreground_job(self, job_id: str) -> JobRecord:
        """Re-enter a diagnostic job and close stale work from an earlier invocation."""

        job_id = validate_uuid(job_id, "job_id")
        with catalog_operation("foreground job restart"):
            with self.__catalog.critical_transaction() as connection:
                row = connection.execute(
                    select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                ).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                current = JobState(row["state"])
                now = utc_now_rfc3339()
                unfinished = connection.execute(
                    select(acquisition_attempts.c.id).where(
                        acquisition_attempts.c.job_id == job_id,
                        acquisition_attempts.c.finished_at.is_(None),
                    )
                ).scalars().all()
                if unfinished:
                    connection.execute(
                        update(acquisition_attempts)
                        .where(
                            acquisition_attempts.c.job_id == job_id,
                            acquisition_attempts.c.finished_at.is_(None),
                        )
                        .values(
                            outcome=AttemptOutcome.CANCELLED.value,
                            finished_at=now,
                            details_json=canonical_json(
                                {
                                    "diagnostic": {
                                        "reason": "interrupted_before_foreground_rerun"
                                    }
                                }
                            ),
                        )
                    )
                    for attempt_id in unfinished:
                        _append_event(
                            connection,
                            subject_type="acquisition_attempt",
                            subject_id=attempt_id,
                            event_type="attempt.finished",
                            details={"outcome": AttemptOutcome.CANCELLED.value},
                        )
                changes = {
                    "state": JobState.ACTIVE.value,
                    "updated_at": now,
                }
                connection.execute(
                    update(acquisition_jobs)
                    .where(acquisition_jobs.c.id == job_id)
                    .values(**changes)
                )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="job.foreground_restarted",
                    details={"from": row["state"], "stale_attempts": len(unfinished)},
                )
                return _job_record({**dict(row), **changes})

    def get_attempt(self, attempt_id: str) -> AttemptRecord | None:
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        with catalog_operation("attempt lookup"):
            with self.__catalog.connect() as connection:
                row = (
                    connection.execute(
                        select(acquisition_attempts).where(
                            acquisition_attempts.c.id == attempt_id
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _attempt_record(row)

    def list_attempts(self, job_id: str) -> tuple[AttemptRecord, ...]:
        job_id = validate_uuid(job_id, "job_id")
        with catalog_operation("job attempt listing"):
            with self.__catalog.connect() as connection:
                rows = connection.execute(
                    select(acquisition_attempts)
                    .where(acquisition_attempts.c.job_id == job_id)
                    .order_by(acquisition_attempts.c.started_at, acquisition_attempts.c.id)
                ).mappings().all()
        return tuple(_attempt_record(row) for row in rows)

    def list_nonterminal_jobs_for_work(
        self,
        work_version_id: str,
        asset_role: AssetRole | str,
    ) -> tuple[JobRecord, ...]:
        """List unfinished jobs for one Work and asset role without changing ownership."""

        work_version_id = validate_uuid(work_version_id, "work_id")
        role = _asset_role(asset_role)
        nonterminal = tuple(state.value for state in NONTERMINAL_JOB_STATES)
        with catalog_operation("work nonterminal job listing"):
            with self.__catalog.connect() as connection:
                rows = connection.execute(
                    select(acquisition_jobs)
                    .where(
                        acquisition_jobs.c.work_version_id == work_version_id,
                        acquisition_jobs.c.asset_role == role.value,
                        acquisition_jobs.c.state.in_(nonterminal),
                    )
                    .order_by(acquisition_jobs.c.created_at, acquisition_jobs.c.id)
                ).mappings().all()
        return tuple(_job_record(row) for row in rows)

    def complete_job_and_requests(self, job_id: str, new_state: JobState | str) -> JobRecord:
        """Atomically close a terminal job and every request attached to it."""
        job_id = validate_uuid(job_id, "job_id")
        target = _job_state(new_state)
        if target not in {JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED}:
            raise ValueError("job completion requires a terminal state")
        with catalog_operation("job and request completion"):
            with self.__catalog.critical_transaction() as connection:
                row = connection.execute(
                    select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                ).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                current = JobState(row["state"])
                if current is target:
                    return _job_record(row)
                if current in {JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED}:
                    raise CatalogError(
                        f"cannot rewrite terminal acquisition job: {current.value} -> {target.value}"
                    )
                if target not in LEGAL_JOB_STATE_TRANSITIONS[current]:
                    raise CatalogError(
                        f"illegal acquisition job transition: {current.value} -> {target.value}"
                    )
                now = utc_now_rfc3339()
                changes = {"state": target.value, "updated_at": now}
                connection.execute(update(acquisition_jobs).where(acquisition_jobs.c.id == job_id).values(**changes))
                connection.execute(
                    update(download_requests)
                    .where(download_requests.c.job_id == job_id)
                    .values(status=target.value, updated_at=now)
                )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="job.completed",
                    details={"from": current.value, "to": target.value},
                )
                return _job_record({**dict(row), **changes})

    def cancel_job_and_requests(
        self,
        job_id: str,
        *,
        details: object | None = None,
    ) -> JobRecord:
        """Atomically cancel a nonterminal job and every unfinished attempt."""

        job_id = validate_uuid(job_id, "job_id")
        cancellation_details = redact(details)
        with catalog_operation("job cancellation"):
            with self.__catalog.critical_transaction() as connection:
                row = connection.execute(
                    select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                ).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                current = JobState(row["state"])
                if current is JobState.CANCELLED:
                    return _job_record(row)
                if current in {JobState.SUCCEEDED, JobState.FAILED}:
                    return _job_record(row)
                if JobState.CANCELLED not in LEGAL_JOB_STATE_TRANSITIONS[current]:
                    raise CatalogError(
                        f"illegal acquisition job transition: {current.value} -> cancelled"
                    )

                now = utc_now_rfc3339()
                unfinished_ids = connection.execute(
                    select(acquisition_attempts.c.id).where(
                        acquisition_attempts.c.job_id == job_id,
                        acquisition_attempts.c.finished_at.is_(None),
                    )
                ).scalars().all()
                attempt_changes: dict[str, object] = {
                    "outcome": AttemptOutcome.CANCELLED.value,
                    "finished_at": now,
                }
                for attempt_id in unfinished_ids:
                    attempt_row = connection.execute(
                        select(acquisition_attempts).where(
                            acquisition_attempts.c.id == attempt_id
                        )
                    ).mappings().one()
                    current_details = (
                        None
                        if attempt_row["details_json"] is None
                        else json.loads(attempt_row["details_json"])
                    )
                    updated_details = cancellation_details
                    if isinstance(current_details, Mapping):
                        updated_details = dict(current_details)
                        updated_details["outcome"] = AttemptOutcome.CANCELLED.value
                        if details is not None:
                            metadata = updated_details.get("metadata")
                            updated_details["metadata"] = {
                                **(dict(metadata) if isinstance(metadata, Mapping) else {}),
                                **(
                                    dict(cancellation_details)
                                    if isinstance(cancellation_details, Mapping)
                                    else {"cancellation": cancellation_details}
                                ),
                            }
                    changes_for_attempt = dict(attempt_changes)
                    if updated_details is not None:
                        changes_for_attempt["details_json"] = canonical_json(updated_details)
                    connection.execute(
                        update(acquisition_attempts)
                        .where(acquisition_attempts.c.id == attempt_id)
                        .values(**changes_for_attempt)
                    )
                    _append_event(
                        connection,
                        subject_type="acquisition_attempt",
                        subject_id=attempt_id,
                        event_type="attempt.finished",
                        details={"outcome": AttemptOutcome.CANCELLED.value},
                    )
                    _append_event(
                        connection,
                        subject_type="acquisition_attempt",
                        subject_id=attempt_id,
                        event_type="acquisition.cancelled",
                        details=cancellation_details,
                    )

                changes = {
                    "state": JobState.CANCELLED.value,
                    "updated_at": now,
                }
                connection.execute(
                    update(acquisition_jobs).where(acquisition_jobs.c.id == job_id).values(**changes)
                )
                connection.execute(
                    update(download_requests)
                    .where(download_requests.c.job_id == job_id)
                    .values(status=JobState.CANCELLED.value, updated_at=now)
                )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="acquisition.cancelled",
                    details=cancellation_details,
                )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="job.completed",
                    details={"from": current.value, "to": JobState.CANCELLED.value},
                )
                return _job_record({**dict(row), **changes})

    def succeed_nonterminal_jobs_for_work(
        self,
        work_version_id: str,
        asset_role: AssetRole | str,
    ) -> tuple[JobRecord, ...]:
        """Repair dangling work-role jobs after an accepted asset is observed."""
        work_version_id = validate_uuid(work_version_id, "work_id")
        role = _asset_role(asset_role)
        nonterminal = tuple(state.value for state in NONTERMINAL_JOB_STATES)
        with catalog_operation("work job repair"):
            with self.__catalog.critical_transaction() as connection:
                rows = connection.execute(
                    select(acquisition_jobs).where(
                        acquisition_jobs.c.work_version_id == work_version_id,
                        acquisition_jobs.c.asset_role == role.value,
                        acquisition_jobs.c.state.in_(nonterminal),
                    )
                ).mappings().all()
                now = utc_now_rfc3339()
                repaired: list[JobRecord] = []
                for row in rows:
                    current = JobState(row["state"])
                    if current is not JobState.ACTIVE:
                        connection.execute(
                            update(acquisition_jobs)
                            .where(acquisition_jobs.c.id == row["id"])
                            .values(
                                state=JobState.ACTIVE.value,
                                updated_at=now,
                            )
                        )
                        _append_event(
                            connection,
                            subject_type="acquisition_job",
                            subject_id=row["id"],
                            event_type="job.state_changed",
                            details={"from": current.value, "to": JobState.ACTIVE.value},
                        )
                    changes = {
                        "state": JobState.SUCCEEDED.value,
                        "updated_at": now,
                    }
                    unfinished_ids = connection.execute(
                        select(acquisition_attempts.c.id).where(
                            acquisition_attempts.c.job_id == row["id"],
                            acquisition_attempts.c.finished_at.is_(None),
                        )
                    ).scalars().all()
                    connection.execute(
                        update(acquisition_attempts)
                        .where(
                            acquisition_attempts.c.job_id == row["id"],
                            acquisition_attempts.c.finished_at.is_(None),
                        )
                        .values(
                            outcome=AttemptOutcome.SUCCEEDED.value,
                            finished_at=now,
                        )
                    )
                    for attempt_id in unfinished_ids:
                        _append_event(
                            connection,
                            subject_type="acquisition_attempt",
                            subject_id=attempt_id,
                            event_type="attempt.finished",
                            details={"outcome": AttemptOutcome.SUCCEEDED.value, "repair": True},
                        )
                    connection.execute(
                        update(acquisition_jobs)
                        .where(acquisition_jobs.c.id == row["id"])
                        .values(**changes)
                    )
                    connection.execute(
                        update(download_requests)
                        .where(download_requests.c.job_id == row["id"])
                        .values(status=JobState.SUCCEEDED.value, updated_at=now)
                    )
                    _append_event(
                        connection,
                        subject_type="acquisition_job",
                        subject_id=row["id"],
                        event_type="job.repaired_from_existing_asset",
                        details={"from": JobState.ACTIVE.value, "to": JobState.SUCCEEDED.value},
                    )
                    repaired.append(_job_record({**dict(row), **changes}))
                return tuple(repaired)

    def finish_attempt_and_job(
        self,
        attempt_id: str,
        outcome: AttemptOutcome | str,
        job_state: JobState | str | None,
        *,
        details: object | None = None,
    ) -> tuple[AttemptRecord, JobRecord]:
        """Atomically finish one attempt and move its owning job coherently."""
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        normalized_outcome = _attempt_outcome(outcome)
        target = None if job_state is None else _job_state(job_state)
        if normalized_outcome is AttemptOutcome.SUCCEEDED and target is not JobState.SUCCEEDED:
            raise ValueError("a succeeded attempt must complete its job")
        if target is JobState.SUCCEEDED and normalized_outcome is not AttemptOutcome.SUCCEEDED:
            raise ValueError("a succeeded job requires a succeeded attempt")
        with catalog_operation("attempt and job completion"):
            with self.__catalog.critical_transaction() as connection:
                attempt_row = connection.execute(
                    select(acquisition_attempts).where(acquisition_attempts.c.id == attempt_id)
                ).mappings().one_or_none()
                if attempt_row is None:
                    raise CatalogError(f"acquisition attempt does not exist: {attempt_id}")
                if attempt_row["finished_at"] is not None:
                    raise CatalogError("acquisition attempt is already finished")
                job_row = connection.execute(
                    select(acquisition_jobs).where(acquisition_jobs.c.id == attempt_row["job_id"])
                ).mappings().one()
                current = JobState(job_row["state"])
                if target is not None and target not in LEGAL_JOB_STATE_TRANSITIONS[current]:
                    raise CatalogError(
                        f"illegal acquisition job transition: {current.value} -> {target.value}"
                    )
                now = utc_now_rfc3339()
                attempt_changes = {
                    "outcome": normalized_outcome.value,
                    "finished_at": now,
                }
                if details is not None:
                    attempt_changes["details_json"] = canonical_json(redact(details))
                connection.execute(
                    update(acquisition_attempts)
                    .where(acquisition_attempts.c.id == attempt_id)
                    .values(**attempt_changes)
                )
                job_changes: dict[str, object] = {}
                if target is not None:
                    job_changes = {
                        "state": target.value,
                        "updated_at": now,
                    }
                    connection.execute(
                        update(acquisition_jobs)
                        .where(acquisition_jobs.c.id == job_row["id"])
                        .values(**job_changes)
                    )
                if target in {JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED}:
                    connection.execute(
                        update(download_requests)
                        .where(download_requests.c.job_id == job_row["id"])
                        .values(status=target.value, updated_at=now)
                    )
                _append_event(
                    connection,
                    subject_type="acquisition_attempt",
                    subject_id=attempt_id,
                    event_type="attempt.finished",
                    details={"outcome": normalized_outcome.value},
                )
                if target is not None:
                    _append_event(
                        connection,
                        subject_type="acquisition_job",
                        subject_id=job_row["id"],
                        event_type="job.completed",
                        details={"from": current.value, "to": target.value},
                    )
                return (
                    _attempt_record({**dict(attempt_row), **attempt_changes}),
                    _job_record({**dict(job_row), **job_changes}),
                )

    def start_attempt(
        self,
        job_id: str,
        provider: str,
        *,
        source_url: str | None = None,
        details: object | None = None,
    ) -> AttemptRecord:
        job_id = validate_uuid(job_id, "job_id")
        provider = _required_text(provider, "provider")
        source_url = _optional_text(source_url, "source_url")
        source_url = None if source_url is None else redact_url(source_url)
        details_json = None if details is None else canonical_json(redact(details))
        with catalog_operation("attempt start"):
            with self.__catalog.critical_transaction() as connection:
                state = connection.execute(
                    select(acquisition_jobs.c.state).where(acquisition_jobs.c.id == job_id)
                ).scalar_one_or_none()
                if state is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                if JobState(state) is not JobState.ACTIVE:
                    raise CatalogError("an acquisition attempt requires an active job")
                values = {
                    "id": new_uuid4(),
                    "job_id": job_id,
                    "provider": provider,
                    "outcome": None,
                    "source_url": source_url,
                    "details_json": details_json,
                    "started_at": utc_now_rfc3339(),
                    "finished_at": None,
                }
                connection.execute(insert(acquisition_attempts).values(**values))
                _append_event(
                    connection,
                    subject_type="acquisition_attempt",
                    subject_id=values["id"],
                    event_type="attempt.started",
                    details={"provider": provider},
                )
                return _attempt_record(values)

    def finish_attempt(
        self,
        attempt_id: str,
        outcome: AttemptOutcome | str,
        *,
        details: object | None = None,
    ) -> AttemptRecord:
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        normalized_outcome = _attempt_outcome(outcome)
        with catalog_operation("attempt finish"):
            with self.__catalog.critical_transaction() as connection:
                row = (
                    connection.execute(
                        select(acquisition_attempts).where(
                            acquisition_attempts.c.id == attempt_id
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"acquisition attempt does not exist: {attempt_id}")
                if row["finished_at"] is not None:
                    raise CatalogError("acquisition attempt is already finished")
                values = {
                    "outcome": normalized_outcome.value,
                    "finished_at": utc_now_rfc3339(),
                }
                if details is not None:
                    values["details_json"] = canonical_json(redact(details))
                connection.execute(
                    update(acquisition_attempts)
                    .where(acquisition_attempts.c.id == attempt_id)
                    .values(**values)
                )
                updated = {**dict(row), **values}
                _append_event(
                    connection,
                    subject_type="acquisition_attempt",
                    subject_id=attempt_id,
                    event_type="attempt.finished",
                    details={"outcome": normalized_outcome.value},
                )
                return _attempt_record(updated)

    def append_event(
        self,
        subject_type: str,
        subject_id: str,
        event_type: str,
        details: object | None = None,
    ) -> EventRecord:
        return self.__repository.append_event(
            subject_type,
            subject_id,
            event_type,
            redact(details),
        )

    def append_failure(
        self,
        category: str,
        message: str,
        *,
        work_version_id: str | None = None,
        job_id: str | None = None,
        attempt_id: str | None = None,
        processing_run_id: str | None = None,
        retryable: bool = False,
        details: object | None = None,
    ) -> FailureRecord:
        return self.__repository.append_failure(
            category,
            _failure_message(details),
            work_version_id=work_version_id,
            job_id=job_id,
            attempt_id=attempt_id,
            processing_run_id=processing_run_id,
            retryable=retryable,
            details=redact(details),
        )


def attach_or_create_job(
    catalog: CatalogEngine | CatalogRepository,
    work_version_id: str,
    asset_role: AssetRole | str,
    request_key: str | None = None,
    *,
    request_provenance: object | None = None,
) -> JobRecord:
    """Convenience boundary for callers that do not retain a JobRepository."""
    return JobRepository(catalog).attach_or_create_job(
        work_version_id,
        asset_role,
        request_key,
        request_provenance=request_provenance,
    )


__all__ = (
    "JobRepository",
    "LEGAL_JOB_STATE_TRANSITIONS",
    "attach_or_create_job",
)
