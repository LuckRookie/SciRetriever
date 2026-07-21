"""Acquisition job, request, and attempt lifecycle repository."""

from __future__ import annotations

import json
from types import MappingProxyType
from typing import Any, Mapping

from sqlalchemy import insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import acquisition_attempts, acquisition_jobs, download_requests
from sciretriever.catalog.records import (
    AttemptRecord,
    DownloadRequestRecord,
    EventRecord,
    FailureRecord,
    JobRecord,
    JobResumeState,
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
from sciretriever.core.timestamps import parse_rfc3339, utc_now_rfc3339
from sciretriever.errors import CatalogError


# Terminal states have no outgoing transitions. A retry or resume always re-enters ACTIVE.
LEGAL_JOB_STATE_TRANSITIONS: Mapping[JobState, frozenset[JobState]] = MappingProxyType(
    {
        JobState.PENDING: frozenset({JobState.ACTIVE, JobState.PAUSED, JobState.CANCELLED}),
        JobState.ACTIVE: frozenset(
            {
                JobState.RETRYABLE,
                JobState.PAUSED,
                JobState.SUCCEEDED,
                JobState.FAILED,
                JobState.CANCELLED,
            }
        ),
        JobState.RETRYABLE: frozenset(
            {JobState.ACTIVE, JobState.PAUSED, JobState.FAILED, JobState.CANCELLED}
        ),
        JobState.PAUSED: frozenset({JobState.ACTIVE, JobState.CANCELLED}),
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


def _millisecond_timestamp(value: str | None, field_name: str) -> str | None:
    if value is None:
        return None
    parse_rfc3339(value)
    if len(value) != 24:
        raise ValueError(f"{field_name} must use millisecond RFC3339 UTC form")
    return value


def _job_record(row: Mapping[Any, Any]) -> JobRecord:
    return JobRecord(
        id=row["id"],
        work_id=row["work_id"],
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
        work_id=row["work_id"],
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

    def set_source_plan_json_if_absent(
        self,
        job_id: str,
        source_plan_json: str,
        *,
        asset_role: AssetRole | str,
        schema_version: int,
    ) -> JobRecord:
        """Persist an acquisition-owned plan through a catalog-neutral contract."""

        job_id = validate_uuid(job_id, "job_id")
        if not isinstance(source_plan_json, str):
            raise TypeError("source_plan_json must be a string")
        try:
            decoded = json.loads(source_plan_json)
        except (TypeError, ValueError) as error:
            raise ValueError("source_plan_json must contain valid JSON") from error
        plan_json = canonical_json(decoded)
        role = _asset_role(asset_role)
        if not isinstance(schema_version, int) or isinstance(schema_version, bool) or schema_version <= 0:
            raise ValueError("schema_version must be a positive integer")
        with catalog_operation("source plan assignment"):
            with self.__catalog.critical_transaction() as connection:
                row = connection.execute(
                    select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                ).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                if AssetRole(row["asset_role"]) is not role:
                    raise CatalogError("source plan role does not match acquisition job")
                existing = row["source_plan_json"]
                if existing is not None:
                    if existing != plan_json:
                        raise CatalogError("acquisition job already has a different source plan")
                    return _job_record(row)
                now = utc_now_rfc3339()
                connection.execute(
                    update(acquisition_jobs)
                    .where(acquisition_jobs.c.id == job_id)
                    .values(source_plan_json=plan_json, updated_at=now)
                )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="job.source_plan_set",
                    details={"schema_version": schema_version, "role": role.value},
                )
                return _job_record({**dict(row), "source_plan_json": plan_json, "updated_at": now})

    def set_source_plan_if_absent(self, job_id: str, source_plan: object) -> JobRecord:
        """Compatibility wrapper for the original generic plan API."""

        plan_json = source_plan if isinstance(source_plan, str) else canonical_json(source_plan)
        try:
            value = json.loads(plan_json)
            role = value["role"]
            schema_version = value["schema_version"]
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("source plan must contain role and schema_version") from error
        return self.set_source_plan_json_if_absent(
            job_id,
            plan_json,
            asset_role=role,
            schema_version=schema_version,
        )

    def list_due_retryable_jobs(self, now: str) -> tuple[JobRecord, ...]:
        normalized = _millisecond_timestamp(now, "now")
        with catalog_operation("due retryable job listing"):
            with self.__catalog.connect() as connection:
                rows = connection.execute(
                    select(acquisition_jobs)
                    .where(
                        acquisition_jobs.c.state == JobState.RETRYABLE.value,
                        (acquisition_jobs.c.next_retry_at.is_(None))
                        | (acquisition_jobs.c.next_retry_at <= normalized),
                    )
                    .order_by(acquisition_jobs.c.next_retry_at, acquisition_jobs.c.created_at, acquisition_jobs.c.id)
                ).mappings().all()
        return tuple(_job_record(row) for row in rows)

    def get_resume_state(self, job_id: str) -> JobResumeState:
        job = self.get_job(job_id)
        if job is None:
            raise CatalogError(f"acquisition job does not exist: {job_id}")
        if job.source_plan_json is None:
            raise CatalogError("acquisition job has no durable source plan")
        return JobResumeState(job, self.list_attempts(job.id), self.list_requests(job.id))

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
        work_id: str,
        asset_role: AssetRole | str,
        request_key: str | None = None,
        *,
        source_plan: object | None = None,
        request_provenance: object | None = None,
    ) -> JobRecord:
        work_id = validate_uuid(work_id, "work_id")
        role = _asset_role(asset_role)
        normalized_key = None if request_key is None else _required_text(request_key, "request_key")
        source_plan_json = None if source_plan is None else canonical_json(source_plan)
        provenance_json = (
            None if request_provenance is None else canonical_json(request_provenance)
        )
        with catalog_operation("job admission"):
            with self.__catalog.critical_transaction() as connection:
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
                        if request["work_id"] != work_id or request["asset_role"] != role.value:
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
                            acquisition_jobs.c.work_id == work_id,
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
                        "work_id": work_id,
                        "asset_role": role.value,
                        "state": JobState.PENDING.value,
                        "source_plan_json": source_plan_json,
                        "next_retry_at": None,
                        "created_at": now,
                        "updated_at": now,
                    }
                    connection.execute(insert(acquisition_jobs).values(**values))
                    job = _job_record(values)
                else:
                    job = _job_record(row)

                if normalized_key is not None:
                    now = utc_now_rfc3339()
                    connection.execute(
                        insert(download_requests).values(
                            id=new_uuid4(),
                            work_id=work_id,
                            job_id=job.id,
                            request_key=normalized_key,
                            asset_role=role.value,
                            status="attached",
                            provenance_json=provenance_json,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job.id,
                    event_type="job.created" if created else "job.request_attached",
                    details={"request_key": normalized_key} if normalized_key is not None else None,
                )
                return job

    def transition_job(
        self,
        job_id: str,
        new_state: JobState | str,
        *,
        next_retry_at: str | None = None,
    ) -> JobRecord:
        job_id = validate_uuid(job_id, "job_id")
        target = _job_state(new_state)
        retry_at = _millisecond_timestamp(next_retry_at, "next_retry_at")
        if target is not JobState.RETRYABLE and retry_at is not None:
            raise ValueError("next_retry_at is only valid for retryable jobs")
        with catalog_operation("job transition"):
            with self.__catalog.critical_transaction() as connection:
                row = (
                    connection.execute(
                        select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                    )
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                current = JobState(row["state"])
                if target not in LEGAL_JOB_STATE_TRANSITIONS[current]:
                    raise CatalogError(
                        f"illegal acquisition job transition: {current.value} -> {target.value}"
                    )
                values = {
                    "state": target.value,
                    "next_retry_at": retry_at if target is JobState.RETRYABLE else None,
                    "updated_at": utc_now_rfc3339(),
                }
                connection.execute(
                    update(acquisition_jobs)
                    .where(acquisition_jobs.c.id == job_id)
                    .values(**values)
                )
                updated = {**dict(row), **values}
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="job.state_changed",
                    details={"from": current.value, "to": target.value},
                )
                return _job_record(updated)

    def claim_job(self, job_id: str, *, allow_paused: bool = False) -> bool:
        """Atomically claim a pending, due retryable, or explicitly resumed job."""
        job_id = validate_uuid(job_id, "job_id")
        if not isinstance(allow_paused, bool):
            raise TypeError("allow_paused must be boolean")
        with catalog_operation("job claim"):
            with self.__catalog.critical_transaction() as connection:
                row = connection.execute(
                    select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                ).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                state = JobState(row["state"])
                now = utc_now_rfc3339()
                claimable = state is JobState.PENDING or (allow_paused and state is JobState.PAUSED) or (
                    state is JobState.RETRYABLE
                    and (row["next_retry_at"] is None or row["next_retry_at"] <= now)
                )
                if not claimable:
                    return False
                connection.execute(
                    update(acquisition_jobs)
                    .where(
                        acquisition_jobs.c.id == job_id,
                        acquisition_jobs.c.state == state.value,
                    )
                    .values(state=JobState.ACTIVE.value, next_retry_at=None, updated_at=now)
                )
                _append_event(
                    connection,
                    subject_type="acquisition_job",
                    subject_id=job_id,
                    event_type="job.claimed",
                    details={"from": state.value},
                )
                return True

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
                changes = {"state": target.value, "next_retry_at": None, "updated_at": now}
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

    def succeed_nonterminal_jobs_for_work(
        self,
        work_id: str,
        asset_role: AssetRole | str,
    ) -> tuple[JobRecord, ...]:
        """Repair dangling work-role jobs after an accepted asset is observed."""
        work_id = validate_uuid(work_id, "work_id")
        role = _asset_role(asset_role)
        nonterminal = tuple(state.value for state in NONTERMINAL_JOB_STATES)
        with catalog_operation("work job repair"):
            with self.__catalog.critical_transaction() as connection:
                rows = connection.execute(
                    select(acquisition_jobs).where(
                        acquisition_jobs.c.work_id == work_id,
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
                                next_retry_at=None,
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
                        "next_retry_at": None,
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
                            details_json=canonical_json(
                                {"reason": "existing primary asset proves acquisition succeeded"}
                            ),
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
        next_retry_at: str | None = None,
    ) -> tuple[AttemptRecord, JobRecord]:
        """Atomically finish one attempt and move its owning job coherently."""
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        normalized_outcome = _attempt_outcome(outcome)
        target = None if job_state is None else _job_state(job_state)
        retry_at = _millisecond_timestamp(next_retry_at, "next_retry_at")
        if target is not JobState.RETRYABLE and retry_at is not None:
            raise ValueError("next_retry_at is only valid for retryable jobs")
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
                    attempt_changes["details_json"] = canonical_json(details)
                connection.execute(
                    update(acquisition_attempts)
                    .where(acquisition_attempts.c.id == attempt_id)
                    .values(**attempt_changes)
                )
                job_changes: dict[str, object] = {}
                if target is not None:
                    job_changes = {
                        "state": target.value,
                        "next_retry_at": retry_at if target is JobState.RETRYABLE else None,
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
                        event_type="job.state_changed" if target is JobState.RETRYABLE else "job.completed",
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
        details_json = None if details is None else canonical_json(details)
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
                    values["details_json"] = canonical_json(details)
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
            details,
        )

    def append_failure(
        self,
        category: str,
        message: str,
        *,
        work_id: str | None = None,
        job_id: str | None = None,
        attempt_id: str | None = None,
        processing_run_id: str | None = None,
        retryable: bool = False,
        details: object | None = None,
    ) -> FailureRecord:
        return self.__repository.append_failure(
            category,
            message,
            work_id=work_id,
            job_id=job_id,
            attempt_id=attempt_id,
            processing_run_id=processing_run_id,
            retryable=retryable,
            details=details,
        )


def attach_or_create_job(
    catalog: CatalogEngine | CatalogRepository,
    work_id: str,
    asset_role: AssetRole | str,
    request_key: str | None = None,
    *,
    source_plan: object | None = None,
    request_provenance: object | None = None,
) -> JobRecord:
    """Convenience boundary for callers that do not retain a JobRepository."""
    return JobRepository(catalog).attach_or_create_job(
        work_id,
        asset_role,
        request_key,
        source_plan=source_plan,
        request_provenance=request_provenance,
    )


__all__ = (
    "JobRepository",
    "LEGAL_JOB_STATE_TRANSITIONS",
    "attach_or_create_job",
)
