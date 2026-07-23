"""Bounded execution and validation for one internal download candidate."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import Enum
import math
from queue import Empty, Queue
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from sciretriever.acquisition.candidates import RuntimeDownloadCandidate
from sciretriever.acquisition.controls import HostBudgetManager
from sciretriever.acquisition.legacy_candidates import LegacyCandidateOperation
from sciretriever.acquisition.models import AcquisitionTransport, ProviderContent
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.acquisition.validation import validate_content
from sciretriever.errors import ValidationError


class CandidateExecutionStatus(str, Enum):
    VALIDATED = "validated"
    RETRYABLE = "retryable"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@dataclass(frozen=True, slots=True)
class CandidateExecutionResult:
    status: CandidateExecutionStatus
    content: ProviderContent | None
    error: Exception | None = field(repr=False)
    latency: float
    retry_after: int | None = None

    @property
    def retryable(self) -> bool:
        return self.status in {
            CandidateExecutionStatus.RETRYABLE,
            CandidateExecutionStatus.INTERRUPTED,
        }


@dataclass(frozen=True, slots=True)
class _WorkerOutcome:
    content: ProviderContent | None = None
    error: BaseException | None = None


class CandidateExecutor:
    def __init__(
        self,
        transport: AcquisitionTransport | None = None,
        *,
        budgets: HostBudgetManager | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._transport = transport
        self._budgets = budgets or HostBudgetManager(monotonic=monotonic)
        self._clock = monotonic

    async def execute(
        self,
        candidate: RuntimeDownloadCandidate,
        *,
        timeout: float,
        operation: LegacyCandidateOperation | None = None,
    ) -> CandidateExecutionResult:
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool):
            raise TypeError("candidate timeout must be a number")
        if not math.isfinite(float(timeout)) or timeout <= 0:
            raise ValueError("candidate timeout must be positive and finite")
        host = urlsplit(candidate.execution_url).hostname or ""
        started = self._clock()
        deadline = started + timeout
        try:
            return await asyncio.wait_for(
                self._execute_with_budget(
                    candidate,
                    host=host,
                    deadline=deadline,
                    started=started,
                    operation=operation,
                ),
                timeout=timeout,
            )
        except (asyncio.TimeoutError, TimeoutError) as error:
            return self._result(
                CandidateExecutionStatus.INTERRUPTED, started, error=error
            )

    async def _execute_with_budget(
        self,
        candidate: RuntimeDownloadCandidate,
        *,
        host: str,
        deadline: float,
        started: float,
        operation: LegacyCandidateOperation | None,
    ) -> CandidateExecutionResult:
        async with self._budgets.acquire(host):
            remaining = deadline - self._clock()
            if remaining <= 0:
                return self._result(
                    CandidateExecutionStatus.INTERRUPTED,
                    started,
                    error=TimeoutError("candidate deadline expired during budget admission"),
                )
            try:
                content = await self._run_bounded(
                    candidate, remaining, deadline, operation
                )
                if self._clock() >= deadline:
                    return self._result(
                        CandidateExecutionStatus.INTERRUPTED,
                        started,
                        error=TimeoutError("candidate completed after deadline"),
                    )
                content = self._sanitize_content(candidate, content)
                validate_content(content, candidate.role)
                if self._clock() >= deadline:
                    return self._result(
                        CandidateExecutionStatus.INTERRUPTED,
                        started,
                        error=TimeoutError("candidate validation exceeded deadline"),
                    )
                return self._result(
                    CandidateExecutionStatus.VALIDATED, started, content=content
                )
            except Exception as error:
                status = (
                    CandidateExecutionStatus.INTERRUPTED
                    if isinstance(error, TimeoutError)
                    else CandidateExecutionStatus.RETRYABLE
                    if self._is_retryable(error)
                    else CandidateExecutionStatus.FAILED
                )
                retry_after = (
                    error.retry_after
                    if isinstance(error, ProviderAcquisitionError)
                    else None
                )
                return self._result(
                    status, started, error=error, retry_after=retry_after
                )

    async def _run_bounded(
        self,
        candidate: RuntimeDownloadCandidate,
        timeout: float,
        deadline: float,
        operation: LegacyCandidateOperation | None,
    ) -> ProviderContent:
        outcomes: Queue[_WorkerOutcome] = Queue(maxsize=1)

        def run() -> None:
            try:
                outcomes.put(_WorkerOutcome(content=self._run(candidate, timeout, operation)))
            except BaseException as error:
                outcomes.put(_WorkerOutcome(error=error))

        threading.Thread(
            target=run,
            name=f"sciretriever-candidate-{candidate.download_candidate_id[:12]}",
            daemon=True,
        ).start()
        while True:
            try:
                outcome = outcomes.get_nowait()
            except Empty:
                remaining = deadline - self._clock()
                if remaining <= 0:
                    raise TimeoutError("candidate execution exceeded deadline")
                await asyncio.sleep(min(0.01, remaining))
                continue
            if outcome.error is not None:
                raise outcome.error
            if outcome.content is None:
                raise RuntimeError("candidate worker returned no result")
            return outcome.content

    def _run(
        self,
        candidate: RuntimeDownloadCandidate,
        timeout: float,
        operation: LegacyCandidateOperation | None,
    ) -> ProviderContent:
        if operation is not None:
            return operation.run(timeout)
        if self._transport is None:
            raise ValueError("direct candidate execution requires a transport")
        response = self._transport.get(
            candidate.execution_url,
            headers=candidate.request_headers,
            timeout=timeout,
        )
        if not 200 <= response.status < 300:
            raise ProviderAcquisitionError.for_response(candidate.provider, response)
        formats = {
            "primary_pdf": "pdf",
            "supplementary_pdf": "pdf",
            "xml": "xml",
            "html": "html",
        }
        return ProviderContent(
            candidate.role,
            response.headers.get(
                "content-type", candidate.media_type_hint or "application/octet-stream"
            ),
            formats[candidate.role.value],
            self._safe_source_url(candidate),
            candidate.provider,
            response.body,
            candidate.sanitized_provenance,
        )

    @staticmethod
    def _safe_source_url(candidate: RuntimeDownloadCandidate) -> str:
        return f"candidate://{candidate.redacted_url_identity}"

    @classmethod
    def _sanitize_content(
        cls,
        candidate: RuntimeDownloadCandidate,
        content: ProviderContent,
    ) -> ProviderContent:
        return ProviderContent(
            content.role,
            content.media_type,
            content.format,
            cls._safe_source_url(candidate),
            content.provider,
            content.data,
            candidate.sanitized_provenance,
        )

    @staticmethod
    def _is_retryable(error: Exception) -> bool:
        if isinstance(error, ProviderAcquisitionError):
            return error.retryable
        return isinstance(error, OSError) and not isinstance(error, ValidationError)

    def _result(
        self,
        status: CandidateExecutionStatus,
        started: float,
        *,
        content: ProviderContent | None = None,
        error: Exception | None = None,
        retry_after: int | None = None,
    ) -> CandidateExecutionResult:
        return CandidateExecutionResult(
            status,
            content,
            error,
            max(0.0, self._clock() - started),
            retry_after,
        )


__all__ = ()
