"""Python 3.10-compatible deterministic P5 multi-source orchestration."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from io import BytesIO
import time
from typing import Mapping
from urllib.parse import urlsplit

from sciretriever.acquisition.attempt_details import CandidateAttemptDetails
from sciretriever.acquisition.controls import CircuitBreaker, HostBudgetManager, ProviderHealth, RetryPolicy
from sciretriever.acquisition.models import AcquisitionProvider, AcquisitionResult, AcquisitionTarget, AdmissionResult, ProviderContent
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.acquisition.routing import next_attempt_sequence, resume_candidates, tiers
from sciretriever.acquisition.validation import validate_content
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.records import AttemptRecord
from sciretriever.core.enums import AttemptOutcome, JobState
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import AcquisitionError
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator


@dataclass(frozen=True, slots=True)
class _CandidateResult:
    entry: SourceEntry
    attempt: AttemptRecord | None
    content: ProviderContent | None
    error: Exception | None
    retryable: bool
    latency: float
    attempt_sequence: int | None
    skipped: str | None = None


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
        retry_policy: RetryPolicy | None = None,
        monotonic=time.monotonic,
    ) -> None:
        self.jobs = jobs
        self.coordinator = coordinator
        self.providers = dict(providers)
        self.budgets = budgets or HostBudgetManager()
        self.health = health or ProviderHealth()
        self.circuits = circuits or CircuitBreaker()
        self.retry_policy = retry_policy or RetryPolicy()
        self._clock = monotonic

    async def _candidate(
        self,
        job_id: str,
        target: AcquisitionTarget,
        entry: SourceEntry,
        attempt_sequence: int,
        timeout: float,
    ) -> _CandidateResult:
        provider = self.providers.get(entry.provider)
        if provider is None:
            self.jobs.append_event("acquisition_job", job_id, "source.skipped", {"candidate_id": entry.candidate_id, "provider": entry.provider, "reason": "provider_unavailable"})
            return _CandidateResult(entry, None, None, None, False, 0.0, None, "provider_unavailable")
        try:
            initial_url = provider.initial_url(target)
            host = urlsplit(initial_url).hostname or ""
        except Exception as error:
            self.jobs.append_event("acquisition_job", job_id, "source.skipped", {"candidate_id": entry.candidate_id, "provider": entry.provider, "reason": "incompatible_target"})
            return _CandidateResult(entry, None, None, error, False, 0.0, None, "incompatible_target")
        if not self.circuits.allow(host):
            self.jobs.append_event("acquisition_job", job_id, "source.skipped", {"candidate_id": entry.candidate_id, "provider": entry.provider, "host": host, "reason": "circuit_open"})
            return _CandidateResult(entry, None, None, None, True, 0.0, None, "circuit_open")
        async with self.budgets.acquire(host):
            attempt = self.jobs.start_attempt(
                job_id,
                entry.provider,
                source_url=initial_url,
                details=CandidateAttemptDetails(entry.candidate_id, attempt_sequence).to_dict(
                    priority=entry.priority,
                    tier=entry.tier,
                ),
            )
            started = self._clock()
            worker = asyncio.create_task(asyncio.to_thread(provider.acquire, target, timeout=timeout))
            try:
                try:
                    content = await asyncio.wait_for(asyncio.shield(worker), timeout=timeout)
                except (asyncio.TimeoutError, TimeoutError):
                    await asyncio.gather(worker, return_exceptions=True)
                    raise
                validate_content(content, target.role)
                latency = max(0.0, self._clock() - started)
                self.health.record(entry.provider, succeeded=True, latency=latency)
                self.circuits.record_success(host)
                return _CandidateResult(entry, attempt, content, None, False, latency, attempt_sequence)
            except asyncio.CancelledError:
                await asyncio.gather(worker, return_exceptions=True)
                latency = max(0.0, self._clock() - started)
                self.jobs.finish_attempt_and_job(
                    attempt.id,
                    AttemptOutcome.CANCELLED,
                    None,
                    details=CandidateAttemptDetails(
                        entry.candidate_id,
                        attempt_sequence,
                        outcome=AttemptOutcome.CANCELLED,
                    ).to_dict(reason="orchestrator_cancelled"),
                )
                raise
            except Exception as error:
                latency = max(0.0, self._clock() - started)
                retryable = isinstance(error, (asyncio.TimeoutError, TimeoutError, OSError)) or (
                    isinstance(error, ProviderAcquisitionError) and error.retryable
                )
                self.health.record(entry.provider, succeeded=False, latency=latency)
                self.circuits.record_failure(host)
                return _CandidateResult(entry, attempt, None, error, retryable, latency, attempt_sequence)

    def _finish_intermediate(self, job_id: str, result: _CandidateResult, outcome: AttemptOutcome | None = None) -> None:
        if result.attempt is None:
            return
        actual = outcome or (AttemptOutcome.RETRYABLE if result.retryable else AttemptOutcome.FAILED)
        if result.attempt_sequence is None:
            raise AcquisitionError("attempt result is missing its durable sequence")
        details = CandidateAttemptDetails(
            result.entry.candidate_id,
            result.attempt_sequence,
            outcome=actual,
            error=None if result.error is None else str(result.error),
        ).to_dict(latency=result.latency)
        if result.error is not None:
            self.jobs.append_failure(
                getattr(result.error, "category", "acquisition_failure"),
                str(result.error) or type(result.error).__name__,
                job_id=job_id,
                attempt_id=result.attempt.id,
                retryable=result.retryable,
                details={"candidate_id": result.entry.candidate_id, "provider": result.entry.provider},
            )
        self.jobs.finish_attempt_and_job(result.attempt.id, actual, None, details=details)

    def _finish_exhausted(self, job_id: str, results: list[_CandidateResult]) -> AcquisitionResult:
        attempts = sorted(
            (result for result in results if result.attempt is not None),
            key=lambda result: result.attempt_sequence or 0,
        )
        retryable = any(result.retryable for result in results)
        if not attempts:
            target_state = JobState.RETRYABLE if retryable else JobState.PAUSED
            next_retry_at = None
            if retryable:
                next_retry_at = self.retry_policy.next_retry_at(
                    utc_now_rfc3339(), 1, jitter_key=job_id
                )
            self.jobs.transition_job(job_id, target_state, next_retry_at=next_retry_at)
            job = self.jobs.get_job(job_id)
            return AcquisitionResult(job.work_id, job_id, target_state.value, error="all sources skipped")
        target_state = JobState.RETRYABLE if retryable else JobState.FAILED
        eligible = (
            [result for result in attempts if result.retryable]
            if retryable
            else [result for result in attempts if not result.retryable]
        )
        closer = eligible[-1] if eligible else None
        for result in attempts:
            if result is not closer:
                self._finish_intermediate(job_id, result)
        attempt_count = len(self.jobs.list_attempts(job_id))
        next_retry_at = (
            self.retry_policy.next_retry_at(utc_now_rfc3339(), max(1, attempt_count), jitter_key=job_id)
            if retryable
            else None
        )
        if closer is None:
            self.jobs.transition_job(job_id, target_state, next_retry_at=next_retry_at)
            job = self.jobs.get_job(job_id)
            return AcquisitionResult(job.work_id, job_id, target_state.value, error="all sources exhausted")
        if closer.error is not None:
            self.jobs.append_failure(
                getattr(closer.error, "category", "acquisition_failure"),
                str(closer.error) or type(closer.error).__name__,
                job_id=job_id,
                attempt_id=closer.attempt.id,
                retryable=closer.retryable,
                details={"candidate_id": closer.entry.candidate_id, "provider": closer.entry.provider},
            )
        actual = AttemptOutcome.RETRYABLE if target_state is JobState.RETRYABLE else AttemptOutcome.FAILED
        if closer.attempt_sequence is None:
            raise AcquisitionError("closure attempt is missing its durable sequence")
        self.jobs.finish_attempt_and_job(
            closer.attempt.id,
            actual,
            target_state,
            details=CandidateAttemptDetails(
                closer.entry.candidate_id,
                closer.attempt_sequence,
                outcome=actual,
                error=None if closer.error is None else str(closer.error),
            ).to_dict(latency=closer.latency),
            next_retry_at=next_retry_at,
        )
        job = self.jobs.get_job(job_id)
        return AcquisitionResult(job.work_id, job_id, target_state.value, error="all sources exhausted")

    def _accept_winner(
        self,
        admission: AdmissionResult,
        result: _CandidateResult,
        losers: list[_CandidateResult],
    ) -> AcquisitionResult:
        if admission.job_id is None or result.attempt is None or result.content is None:
            raise AcquisitionError("winner is missing durable acquisition state")
        for loser in losers:
            if loser.content is not None:
                self._finish_intermediate(admission.job_id, loser, AttemptOutcome.CANCELLED)
            else:
                self._finish_intermediate(admission.job_id, loser)
        content = result.content
        if result.attempt_sequence is None:
            raise AcquisitionError("winner is missing its durable attempt sequence")
        accepted_raw_asset_id: str | None = None
        try:
            accepted = self.coordinator.accept(
                BytesIO(content.data),
                admission.work_id,
                admission.job_id,
                admission.asset_role,
                content.media_type,
                content.format,
                {"provider": content.provider, "source_url": content.source_url, "candidate_id": result.entry.candidate_id, **dict(content.provenance)},
                attempt_id=result.attempt.id,
            )
            accepted_raw_asset_id = accepted.raw_asset.id
            self.jobs.finish_attempt_and_job(
                result.attempt.id,
                AttemptOutcome.SUCCEEDED,
                JobState.SUCCEEDED,
                details=CandidateAttemptDetails(
                    result.entry.candidate_id,
                    result.attempt_sequence,
                    outcome=AttemptOutcome.SUCCEEDED,
                ).to_dict(
                    raw_asset_id=accepted.raw_asset.id,
                    final_url=content.source_url,
                    latency=result.latency,
                ),
            )
            return AcquisitionResult(admission.work_id, admission.job_id, "succeeded", accepted.raw_asset.id, result.attempt.id)
        except Exception as error:
            if accepted_raw_asset_id is not None:
                raise
            retryable = isinstance(error, (asyncio.TimeoutError, TimeoutError, OSError))
            outcome = AttemptOutcome.RETRYABLE if retryable else AttemptOutcome.FAILED
            target_state = JobState.RETRYABLE if retryable else JobState.FAILED
            next_retry_at = None
            if retryable:
                attempt_count = len(self.jobs.list_attempts(admission.job_id))
                next_retry_at = self.retry_policy.next_retry_at(
                    utc_now_rfc3339(), max(1, attempt_count), jitter_key=admission.job_id
                )
            self.jobs.append_failure(
                getattr(error, "category", "acquisition_failure"),
                str(error) or type(error).__name__,
                work_id=admission.work_id,
                job_id=admission.job_id,
                attempt_id=result.attempt.id,
                retryable=retryable,
                details={"candidate_id": result.entry.candidate_id, "provider": result.entry.provider},
            )
            self.jobs.finish_attempt_and_job(
                result.attempt.id,
                outcome,
                target_state,
                details=CandidateAttemptDetails(
                    result.entry.candidate_id,
                    result.attempt_sequence,
                    outcome=outcome,
                    error=str(error),
                ).to_dict(latency=result.latency),
                next_retry_at=next_retry_at,
            )
            return AcquisitionResult(
                admission.work_id,
                admission.job_id,
                outcome.value,
                attempt_id=result.attempt.id,
                error=str(error),
            )

    async def acquire(
        self,
        admission: AdmissionResult,
        target: AcquisitionTarget,
        plan: SourcePlan,
        *,
        timeout: float,
        resume_paused: bool = False,
    ) -> AcquisitionResult:
        if admission.reused_asset_id is not None:
            return AcquisitionResult(admission.work_id, None, "reused", admission.reused_asset_id)
        if admission.job_id is None:
            raise AcquisitionError("multi-source admission did not supply a job")
        if plan.role is not admission.asset_role or target.role is not plan.role:
            raise AcquisitionError("source plan, admission, and target roles must match")
        job = self.jobs.set_source_plan_json_if_absent(
            admission.job_id,
            plan.to_json(),
            asset_role=plan.role,
            schema_version=plan.schema_version,
        )
        if not self.jobs.claim_job(job.id, allow_paused=resume_paused):
            current = self.jobs.get_job(job.id)
            return AcquisitionResult(admission.work_id, job.id, "in_progress" if current.state is JobState.ACTIVE else current.state.value)
        try:
            attempts = self.jobs.list_attempts(job.id)
            decision = resume_candidates(plan, attempts, retry_due=True)
            if not decision.runnable:
                self.jobs.transition_job(job.id, JobState.PAUSED)
                return AcquisitionResult(admission.work_id, job.id, "paused", error="no runnable source candidates")

            all_results: list[_CandidateResult] = []
            sequence = next_attempt_sequence(attempts)
            if plan.mode is RoutingMode.SERIAL:
                for tier_entries in tiers(decision.runnable):
                    for entry in self.health.order(tier_entries):
                        result = await self._candidate(job.id, target, entry, sequence, timeout)
                        sequence += 1
                        all_results.append(result)
                        if result.content is not None:
                            return self._accept_winner(admission, result, all_results[:-1])
                return self._finish_exhausted(job.id, all_results)

            for tier_entries in tiers(decision.runnable):
                ordered = self.health.order(tier_entries)
                tasks = [
                    asyncio.create_task(self._candidate(job.id, target, entry, sequence + index, timeout))
                    for index, entry in enumerate(ordered)
                ]
                sequence += len(ordered)
                pending = set(tasks)
                winner: _CandidateResult | None = None
                try:
                    while pending and winner is None:
                        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                        completed = await asyncio.gather(*done)
                        all_results.extend(completed)
                        valid = [result for result in completed if result.content is not None]
                        if valid:
                            winner = min(valid, key=lambda item: (item.entry.priority, item.entry.candidate_id))
                    if pending:
                        drained = await asyncio.gather(*pending)
                        all_results.extend(drained)
                except asyncio.CancelledError:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    raise
                if winner is not None:
                    losers = [result for result in all_results if result is not winner]
                    return self._accept_winner(admission, winner, losers)
            return self._finish_exhausted(job.id, all_results)
        except asyncio.CancelledError:
            current = self.jobs.get_job(job.id)
            if current is not None and current.state is JobState.ACTIVE:
                self.jobs.complete_job_and_requests(job.id, JobState.CANCELLED)
            raise


__all__ = ("MultiSourceOrchestrator",)
