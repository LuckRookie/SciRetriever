"""Bounded read-only catalog queries for acquisition reporting."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping

from sqlalchemy import Select, or_, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import acquisition_attempts, acquisition_jobs, events, failures
from sciretriever.core.enums import JobState
from sciretriever.core.ids import validate_uuid
from sciretriever.diagnostics.projection import (
    AttemptSummary,
    FailureProjection,
    JobProjection,
    safe_diagnostic_from_details,
)
from sciretriever.errors import CatalogError


DEFAULT_REPORT_LIMIT = 100
MAX_REPORT_LIMIT = 1000


class CatalogReportingRepository:
    """Project acquisition history without exposing durable detail payloads."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if not catalog.read_only:
            raise CatalogError("CatalogReportingRepository requires a read-only catalog engine")
        self.__catalog = catalog

    def get_job(self, job_id: str) -> JobProjection | None:
        job_id = validate_uuid(job_id, "job_id")
        rows = self._job_rows(select(acquisition_jobs).where(acquisition_jobs.c.id == job_id))
        projections = self._project(rows)
        return None if not projections else projections[0]

    def list_jobs(
        self,
        *,
        work_id: str | None = None,
        state: JobState | str | None = None,
        retryable: bool | None = None,
        category: str | None = None,
        limit: int = DEFAULT_REPORT_LIMIT,
    ) -> tuple[JobProjection, ...]:
        limit = _limit(limit)
        statement = select(acquisition_jobs)
        if work_id is not None:
            statement = statement.where(acquisition_jobs.c.work_version_id == validate_uuid(work_id, "work_id"))
        if state is not None:
            try:
                normalized_state = state if isinstance(state, JobState) else JobState(state)
            except (TypeError, ValueError) as error:
                raise ValueError(f"unsupported job state: {state!r}") from error
            statement = statement.where(acquisition_jobs.c.state == normalized_state.value)
        if retryable is not None or category is not None:
            if retryable is not None and not isinstance(retryable, bool):
                raise TypeError("retryable must be boolean or None")
            failure_filter = select(failures.c.id).where(failures.c.job_id == acquisition_jobs.c.id)
            if retryable is not None:
                failure_filter = failure_filter.where(failures.c.retryable == int(retryable))
            if category is not None:
                normalized_category = _text(category, "category")
                failure_filter = failure_filter.where(failures.c.category == normalized_category)
            statement = statement.where(failure_filter.exists())
        statement = statement.order_by(
            acquisition_jobs.c.created_at,
            acquisition_jobs.c.id,
        ).limit(limit)
        return self._project(self._job_rows(statement))

    def _job_rows(self, statement: Select[Any]) -> tuple[Mapping[Any, Any], ...]:
        with self.__catalog.connect() as connection:
            return tuple(connection.execute(statement).mappings().all())

    def _project(self, job_rows: tuple[Mapping[Any, Any], ...]) -> tuple[JobProjection, ...]:
        if not job_rows:
            return ()
        job_ids = tuple(str(row["id"]) for row in job_rows)
        with self.__catalog.connect() as connection:
            attempt_rows = connection.execute(
                select(acquisition_attempts)
                .where(acquisition_attempts.c.job_id.in_(job_ids))
                .order_by(acquisition_attempts.c.started_at, acquisition_attempts.c.id)
            ).mappings().all()
            failure_rows = connection.execute(
                select(failures)
                .where(failures.c.job_id.in_(job_ids))
                .order_by(failures.c.occurred_at, failures.c.id)
            ).mappings().all()
            attempt_ids = tuple(str(row["id"]) for row in attempt_rows)
            event_condition = events.c.subject_id.in_(job_ids)
            if attempt_ids:
                event_condition = or_(event_condition, events.c.subject_id.in_(attempt_ids))
            event_rows = connection.execute(
                select(events.c.subject_id).where(event_condition)
            ).mappings().all()

        attempts_by_job: dict[str, list[AttemptSummary]] = defaultdict(list)
        providers_by_attempt: dict[str, str | None] = {}
        for row in attempt_rows:
            provider = _safe_provider(row["provider"])
            attempt_id = str(row["id"])
            providers_by_attempt[attempt_id] = provider
            attempts_by_job[str(row["job_id"])].append(
                AttemptSummary(
                    id=attempt_id,
                    provider=provider,
                    outcome=_optional_text(row["outcome"]),
                    started_at=_optional_text(row["started_at"]),
                    finished_at=_optional_text(row["finished_at"]),
                )
            )

        failures_by_job: dict[str, list[FailureProjection]] = defaultdict(list)
        for row in failure_rows:
            job_id = str(row["job_id"])
            category = _safe_category(row["category"])
            retryable = row["retryable"] == 1
            provider = providers_by_attempt.get(str(row["attempt_id"]))
            diagnostic = safe_diagnostic_from_details(
                _optional_text(row["details_json"])
            )
            failures_by_job[job_id].append(
                FailureProjection(str(row["id"]), _optional_text(row["occurred_at"]), category, diagnostic)
            )

        job_for_subject = {attempt.id: job_id for job_id, values in attempts_by_job.items() for attempt in values}
        event_counts: dict[str, int] = defaultdict(int)
        for row in event_rows:
            subject_id = str(row["subject_id"])
            event_counts[job_for_subject.get(subject_id, subject_id)] += 1

        return tuple(
            JobProjection(
                job_id=str(row["id"]),
                work_id=str(row["work_version_id"]),
                asset_role=_safe_token(row["asset_role"], "unknown"),
                state=_safe_token(row["state"], "unknown"),
                created_at=_optional_text(row["created_at"]),
                updated_at=_optional_text(row["updated_at"]),
                attempts=tuple(attempts_by_job[str(row["id"])]),
                failures=tuple(failures_by_job[str(row["id"])]),
                event_count=event_counts[str(row["id"])],
            )
            for row in job_rows
        )


def _limit(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("limit must be an integer")
    if value < 1 or value > MAX_REPORT_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_REPORT_LIMIT}")
    return value


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be nonblank text")
    return value.strip()


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _safe_token(value: object, fallback: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 80:
        return fallback
    return value if all(char.isalnum() or char in "_-" for char in value) else fallback


def _safe_provider(value: object) -> str | None:
    token = _safe_token(value, "")
    return token or None


def _safe_category(value: object) -> str:
    return _safe_token(value, "unknown")


__all__ = ("CatalogReportingRepository", "DEFAULT_REPORT_LIMIT", "MAX_REPORT_LIMIT")
