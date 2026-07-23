"""Bounded foreground multi-source acquisition orchestration."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import fcntl
from io import BytesIO
import os
from pathlib import Path
import stat
import time
from types import TracebackType
from typing import Mapping
from urllib.parse import urlsplit

from sciretriever.acquisition.attempt_details import CandidateAttemptDetails
from sciretriever.acquisition.candidate_executor import CandidateExecutionStatus, CandidateExecutor
from sciretriever.acquisition.candidate_resolution import CandidateResolver, validate_resolved_candidates
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate
from sciretriever.acquisition.controls import CircuitBreaker, HostBudgetManager, ProviderHealth
from sciretriever.acquisition.legacy_candidates import LegacySingleCandidateResolver
from sciretriever.acquisition.models import AcquisitionProvider, AcquisitionResult, AcquisitionTarget, AdmissionResult, ProviderContent
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.acquisition.routing import tiers
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.records import AttemptRecord
from sciretriever.core.enums import AttemptOutcome, JobState
from sciretriever.diagnostics import AttemptMetadata, DiagnosticEnvelope, map_exception, redact
from sciretriever.errors import AcquisitionError, ConfigError, ProviderErrorCategory, StorageError
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator


@dataclass(frozen=True, slots=True)
class _CandidateResult:
    entry: SourceEntry
    attempt: AttemptRecord | None
    content: ProviderContent | None
    error: Exception | None
    retryable: bool
    latency: float
    sequence: int
    skipped: str | None = None


class _ForegroundInvocationFileLock:
    """Crash-releasing catalog-wide lock for foreground acquisition invocations."""

    def __init__(self, catalog_path: Path) -> None:
        self._path = catalog_path.with_name(f".{catalog_path.name}.acquisition.lock")
        self._descriptor: int | None = None

    async def __aenter__(self) -> None:
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor: int | None = None
        try:
            descriptor = os.open(self._path, flags, 0o600)
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                os.close(descriptor)
                descriptor = None
                raise AcquisitionError("foreground acquisition lock is not a regular file")
            os.fchmod(descriptor, 0o600)
        except OSError as error:
            if descriptor is not None:
                os.close(descriptor)
            raise AcquisitionError("could not open foreground acquisition lock") from error
        if descriptor is None:
            raise AcquisitionError("could not open foreground acquisition lock")
        self._descriptor = descriptor
        try:
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return
                except BlockingIOError:
                    await asyncio.sleep(0.02)
                except OSError as error:
                    raise AcquisitionError(
                        "could not acquire foreground acquisition lock"
                    ) from error
        except BaseException:
            os.close(descriptor)
            self._descriptor = None
            raise

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        descriptor = self._descriptor
        self._descriptor = None
        if descriptor is None:
            return
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        except OSError as error:
            if exc_type is None:
                raise AcquisitionError(
                    "could not release foreground acquisition lock"
                ) from error
        finally:
            os.close(descriptor)


class MultiSourceOrchestrator:
    def __init__(
        self,
        jobs: JobRepository,
        coordinator: AssetAcceptanceCoordinator,
        providers: Mapping[str, AcquisitionProvider],
        *,
        budgets: HostBudgetManager | None = None,
        health: ProviderHealth | None = None,
        circuits: CircuitBreaker | None = None,
        monotonic=time.monotonic,
        candidate_resolvers: Mapping[str, CandidateResolver] | None = None,
        candidate_executor: CandidateExecutor | None = None,
    ) -> None:
        self.jobs = jobs
        self.coordinator = coordinator
        self.providers = dict(providers)
        self.budgets = budgets or HostBudgetManager()
        self.health = health or ProviderHealth()
        self.circuits = circuits or CircuitBreaker()
        self._executor = candidate_executor or CandidateExecutor(
            budgets=self.budgets, monotonic=monotonic
        )
        self._candidate_resolvers = dict(candidate_resolvers or {})
        self._invocation_lock = asyncio.Lock()
        self._foreground_lock = _ForegroundInvocationFileLock(jobs.catalog_path)

    @staticmethod
    def _deduplicate(
        candidates: tuple[RuntimeDownloadCandidate, ...],
    ) -> tuple[RuntimeDownloadCandidate, ...]:
        seen: set[tuple[str, object]] = set()
        selected: list[RuntimeDownloadCandidate] = []
        for candidate in candidates:
            identity = (candidate.redacted_url_identity, candidate.role)
            if identity not in seen:
                seen.add(identity)
                selected.append(candidate)
        return tuple(selected)

    async def _candidate(
        self,
        job_id: str,
        target: AcquisitionTarget,
        entry: SourceEntry,
        sequence: int,
        timeout: float,
        stop_event: asyncio.Event | None = None,
    ) -> _CandidateResult:
        provider = self.providers.get(entry.provider)
        resolver = self._candidate_resolvers.get(
            entry.candidate_id, self._candidate_resolvers.get(entry.provider)
        )
        if resolver is None and provider is not None:
            resolver = LegacySingleCandidateResolver(provider)
        if resolver is None:
            self.jobs.append_event(
                "acquisition_job",
                job_id,
                "source.skipped",
                {"candidate_id": entry.candidate_id, "provider": entry.provider, "reason": "provider_unavailable"},
            )
            return _CandidateResult(entry, None, None, None, False, 0.0, sequence, "provider_unavailable")
        try:
            candidates = self._deduplicate(
                validate_resolved_candidates(
                    entry, target.role, resolver.resolver_id,
                    resolver.resolve(target, entry, target.role),
                )
            )
        except Exception as error:
            self.jobs.append_event(
                "acquisition_job",
                job_id,
                "source.skipped",
                {"candidate_id": entry.candidate_id, "provider": entry.provider, "reason": "incompatible_target"},
            )
            return _CandidateResult(entry, None, None, error, False, 0.0, sequence, "incompatible_target")

        attempt = self.jobs.start_attempt(
            job_id,
            entry.provider,
            details=CandidateAttemptDetails(entry.candidate_id, sequence).to_dict(
                priority=entry.priority, tier=entry.tier
            ),
        )
        total_latency = 0.0
        last_error: Exception | None = None
        retryable = False
        for candidate in candidates:
            if stop_event is not None and stop_event.is_set():
                return _CandidateResult(entry, attempt, None, None, False, total_latency, sequence, "race_lost")
            host = urlsplit(candidate.execution_url).hostname or ""
            if not self.circuits.allow(host):
                last_error = TimeoutError("candidate host circuit is unavailable")
                retryable = True
                await asyncio.sleep(0)
                continue
            operation = (
                resolver.operation_for(candidate, target)
                if isinstance(resolver, LegacySingleCandidateResolver)
                else None
            )
            try:
                execution = await self._executor.execute(
                    candidate, timeout=timeout, operation=operation
                )
            except asyncio.CancelledError:
                if stop_event is not None and stop_event.is_set():
                    return _CandidateResult(entry, attempt, None, None, False, total_latency, sequence, "race_lost")
                raise
            total_latency += execution.latency
            if stop_event is not None and stop_event.is_set():
                return _CandidateResult(entry, attempt, None, None, False, total_latency, sequence, "race_lost")
            if execution.status is CandidateExecutionStatus.VALIDATED:
                self.health.record(entry.provider, succeeded=True, latency=execution.latency)
                self.circuits.record_success(host)
                return _CandidateResult(entry, attempt, execution.content, None, False, total_latency, sequence)
            last_error = execution.error or AcquisitionError("candidate execution failed")
            retryable = retryable or execution.retryable
            self.health.record(entry.provider, succeeded=False, latency=execution.latency)
            self.circuits.record_failure(host)
            if (
                isinstance(last_error, ProviderAcquisitionError)
                and last_error.category is ProviderErrorCategory.RATE_LIMIT
            ):
                break
            await asyncio.sleep(0)
        return _CandidateResult(entry, attempt, None, last_error, retryable, total_latency, sequence)

    @staticmethod
    def _diagnostic(result: _CandidateResult) -> DiagnosticEnvelope:
        if result.error is None:
            raise ValueError("cannot map an empty candidate error")
        return map_exception(
            result.error,
            provider=result.entry.provider,
            retryable=result.retryable,
            attempt=AttemptMetadata(
                candidate_id=result.entry.candidate_id,
                attempt_sequence=result.sequence,
                latency_ms=max(0, round(result.latency * 1000)),
            ),
        )

    def _details(
        self, result: _CandidateResult, outcome: AttemptOutcome
    ) -> dict[str, object]:
        diagnostic = self._diagnostic(result) if result.error is not None else None
        return CandidateAttemptDetails(
            result.entry.candidate_id,
            result.sequence,
            outcome=outcome,
            error=None if diagnostic is None else diagnostic.summary,
        ).to_dict(
            latency=result.latency,
            **({} if diagnostic is None else {"diagnostic": diagnostic.to_dict()}),
        )

    def _finish_attempt(
        self, job_id: str, result: _CandidateResult, outcome: AttemptOutcome
    ) -> None:
        if result.attempt is None:
            return
        if result.error is not None:
            diagnostic = self._diagnostic(result)
            details = {"diagnostic": diagnostic.to_dict()}
            self.jobs.append_failure(
                str(getattr(getattr(result.error, "category", "acquisition_failure"), "value", getattr(result.error, "category", "acquisition_failure"))),
                diagnostic.summary,
                job_id=job_id,
                attempt_id=result.attempt.id,
                retryable=diagnostic.retryable,
                details=details,
            )
            self.jobs.append_event(
                "acquisition_attempt", result.attempt.id, "acquisition.failure", details
            )
        self.jobs.finish_attempt(
            result.attempt.id, outcome, details=self._details(result, outcome)
        )

    def _finish_exhausted(
        self, admission: AdmissionResult, results: list[_CandidateResult]
    ) -> AcquisitionResult:
        if admission.job_id is None:
            raise AcquisitionError("exhausted acquisition has no diagnostic job")
        for result in results:
            outcome = AttemptOutcome.RETRYABLE if result.retryable else AttemptOutcome.FAILED
            self._finish_attempt(admission.job_id, result, outcome)
        error = ConfigError("all source candidates were exhausted")
        diagnostic = map_exception(error, retryable=any(result.retryable for result in results))
        self.jobs.append_failure(
            diagnostic.reason_code.value,
            diagnostic.summary,
            work_id=admission.work_id,
            job_id=admission.job_id,
            retryable=diagnostic.retryable,
            details={"diagnostic": diagnostic.to_dict()},
        )
        self.jobs.complete_job_and_requests(admission.job_id, JobState.FAILED)
        return AcquisitionResult(
            admission.work_id, admission.job_id, JobState.FAILED.value,
            error=diagnostic.summary,
        )

    def _accept_winner(
        self,
        admission: AdmissionResult,
        winner: _CandidateResult,
        losers: list[_CandidateResult],
    ) -> AcquisitionResult:
        if admission.job_id is None or winner.attempt is None or winner.content is None:
            raise AcquisitionError("winner is missing acquisition diagnostic state")
        for loser in losers:
            self._finish_attempt(
                admission.job_id,
                loser,
                AttemptOutcome.CANCELLED if loser.skipped == "race_lost" else (
                    AttemptOutcome.RETRYABLE if loser.retryable else AttemptOutcome.FAILED
                ),
            )
        content = winner.content
        accepted_id: str | None = None
        try:
            accepted = self.coordinator.accept(
                BytesIO(content.data),
                admission.work_id,
                admission.job_id,
                admission.asset_role,
                content.media_type,
                content.format,
                redact(
                    {
                        "provider": content.provider,
                        "source_url": content.source_url,
                        "candidate_id": winner.entry.candidate_id,
                        **dict(content.provenance),
                    }
                ),
                attempt_id=winner.attempt.id,
            )
            accepted_id = accepted.raw_asset.id
            self.jobs.finish_attempt_and_job(
                winner.attempt.id,
                AttemptOutcome.SUCCEEDED,
                JobState.SUCCEEDED,
                details=self._details(winner, AttemptOutcome.SUCCEEDED)
                | {"raw_asset_id": accepted_id},
            )
            return AcquisitionResult(
                admission.work_id, admission.job_id, "succeeded", accepted_id,
                winner.attempt.id,
            )
        except Exception as error:
            if accepted_id is not None:
                self.jobs.succeed_nonterminal_jobs_for_work(
                    admission.work_id, admission.asset_role
                )
                return AcquisitionResult(
                    admission.work_id, admission.job_id, "succeeded", accepted_id,
                    winner.attempt.id,
                )
            mapped = StorageError("asset acceptance storage failure") if isinstance(error, OSError) else error
            failed = _CandidateResult(
                winner.entry, winner.attempt, None, mapped,
                isinstance(error, (asyncio.TimeoutError, TimeoutError, OSError)),
                winner.latency, winner.sequence,
            )
            self._finish_attempt(
                admission.job_id,
                failed,
                AttemptOutcome.RETRYABLE if failed.retryable else AttemptOutcome.FAILED,
            )
            self.jobs.complete_job_and_requests(admission.job_id, JobState.FAILED)
            return AcquisitionResult(
                admission.work_id, admission.job_id, "failed",
                attempt_id=winner.attempt.id,
                error=self._diagnostic(failed).summary,
            )

    async def acquire(
        self,
        admission: AdmissionResult,
        target: AcquisitionTarget,
        plan: SourcePlan,
        *,
        timeout: float,
    ) -> AcquisitionResult:
        if admission.reused_asset_id is not None:
            return AcquisitionResult(
                admission.work_id, None, "reused", admission.reused_asset_id
            )
        async with self._invocation_lock:
            async with self._foreground_lock:
                existing = self.coordinator.existing_asset_id(
                    admission.work_id, admission.asset_role
                )
                if existing is not None:
                    self.jobs.succeed_nonterminal_jobs_for_work(
                        admission.work_id, admission.asset_role
                    )
                    return AcquisitionResult(
                        admission.work_id, None, "reused", existing
                    )
                return await self._acquire_locked(admission, target, plan, timeout)

    async def _acquire_locked(
        self,
        admission: AdmissionResult,
        target: AcquisitionTarget,
        plan: SourcePlan,
        timeout: float,
    ) -> AcquisitionResult:
        if admission.job_id is None:
            raise AcquisitionError("multi-source admission did not supply a job")
        if plan.role is not admission.asset_role or target.role is not plan.role:
            raise AcquisitionError("source plan, admission, and target roles must match")
        job = self.jobs.restart_foreground_job(admission.job_id)
        try:
            results: list[_CandidateResult] = []
            sequence = 1
            if plan.mode is RoutingMode.SERIAL:
                for tier_entries in tiers(plan.entries):
                    for entry in self.health.order(tier_entries):
                        result = await self._candidate(
                            job.id, target, entry, sequence, timeout
                        )
                        sequence += 1
                        results.append(result)
                        if result.content is not None:
                            return self._accept_winner(admission, result, results[:-1])
                return self._finish_exhausted(admission, results)

            for tier_entries in tiers(plan.entries):
                ordered = self.health.order(tier_entries)
                stop_event = asyncio.Event()
                tasks = [
                    asyncio.create_task(
                        self._candidate(
                            job.id, target, entry, sequence + index, timeout, stop_event
                        )
                    )
                    for index, entry in enumerate(ordered)
                ]
                sequence += len(tasks)
                pending = set(tasks)
                tier_results: list[_CandidateResult] = []
                winner: _CandidateResult | None = None
                try:
                    while pending and winner is None:
                        done, pending = await asyncio.wait(
                            pending, return_when=asyncio.FIRST_COMPLETED
                        )
                        completed = await asyncio.gather(*done)
                        tier_results.extend(completed)
                        valid = [item for item in completed if item.content is not None]
                        if valid:
                            winner = min(
                                valid,
                                key=lambda item: (
                                    item.entry.priority, item.entry.candidate_id
                                ),
                            )
                            stop_event.set()
                            for task in pending:
                                task.cancel()
                    if pending:
                        tier_results.extend(await asyncio.gather(*pending))
                except asyncio.CancelledError:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    raise
                if winner is not None:
                    losers = [
                        *results,
                        *(
                            _CandidateResult(
                                item.entry, item.attempt, None, item.error,
                                item.retryable, item.latency, item.sequence,
                                "race_lost",
                            )
                            for item in tier_results
                            if item is not winner
                        ),
                    ]
                    return self._accept_winner(admission, winner, losers)
                results.extend(tier_results)
            return self._finish_exhausted(admission, results)
        except asyncio.CancelledError:
            diagnostic = map_exception(asyncio.CancelledError(), retryable=False)
            self.jobs.cancel_job_and_requests(
                job.id, details={"diagnostic": diagnostic.to_dict()}
            )
            raise


__all__ = ("MultiSourceOrchestrator",)
