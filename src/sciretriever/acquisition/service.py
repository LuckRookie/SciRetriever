"""WorkVersion-native foreground acquisition orchestration."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from io import BytesIO
import time
from typing import Mapping, Sequence
from urllib.parse import urlsplit

from sciretriever.acquisition.candidate_executor import CandidateExecutionStatus, CandidateExecutor
from sciretriever.acquisition.candidate_resolution import CandidateResolver, validate_resolved_candidates
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate
from sciretriever.acquisition.controls import CircuitBreaker, HostBudgetManager, ProviderHealth
from sciretriever.acquisition.models import AcquisitionResult, AcquisitionTarget, ProviderContent
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.catalog.assets import AssetRepository
from sciretriever.core.enums import AssetRole
from sciretriever.core.ids import validate_uuid
from sciretriever.diagnostics import map_exception, redact
from sciretriever.errors import AcquisitionError, ConfigError, ProviderErrorCategory
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator


@dataclass(frozen=True, slots=True)
class _SourceResult:
    provider: str
    content: ProviderContent | None
    details: Mapping[str, object]


class WorkVersionAcquisitionService:
    """Fill one asset gap for an existing WorkVersion in the current process."""

    def __init__(
        self,
        assets: AssetRepository,
        coordinator: AssetAcceptanceCoordinator,
        resolvers: Mapping[str, CandidateResolver],
        executor: CandidateExecutor,
        *,
        translator_resolvers: Sequence[CandidateResolver] = (),
        browser_resolvers: Sequence[CandidateResolver] = (),
        provider_concurrency: int = 4,
        budgets: HostBudgetManager | None = None,
        health: ProviderHealth | None = None,
        circuits: CircuitBreaker | None = None,
        monotonic=time.monotonic,
    ) -> None:
        self.assets = assets
        self.coordinator = coordinator
        self.resolvers = dict(resolvers)
        self.translator_resolvers = tuple(translator_resolvers)
        self.browser_resolvers = tuple(browser_resolvers)
        translator_names = [resolver.provider for resolver in self.translator_resolvers]
        if len(set(translator_names)) != len(translator_names):
            raise ValueError("translator resolvers must have unique provider names")
        browser_names = [resolver.provider for resolver in self.browser_resolvers]
        if len(set(browser_names)) != len(browser_names):
            raise ValueError("browser resolvers must have unique provider names")
        self.executor = executor
        if not isinstance(provider_concurrency, int) or isinstance(provider_concurrency, bool) or provider_concurrency <= 0:
            raise ValueError("provider concurrency must be positive")
        self.provider_concurrency = provider_concurrency
        self.budgets = budgets or HostBudgetManager(monotonic=monotonic)
        self.health = health or ProviderHealth()
        self.circuits = circuits or CircuitBreaker()

    @staticmethod
    def _deduplicate(
        candidates: tuple[RuntimeDownloadCandidate, ...],
    ) -> tuple[RuntimeDownloadCandidate, ...]:
        seen: set[tuple[str, AssetRole]] = set()
        result: list[RuntimeDownloadCandidate] = []
        for candidate in candidates:
            identity = (candidate.redacted_url_identity, candidate.role)
            if identity not in seen:
                seen.add(identity)
                result.append(candidate)
        return tuple(result)

    async def _run_source(
        self,
        target: AcquisitionTarget,
        provider: str,
        role: AssetRole,
        timeout: float,
        *,
        resolver: CandidateResolver | None = None,
        tier: str = "first",
    ) -> _SourceResult:
        resolver = self.resolvers.get(provider) if resolver is None else resolver
        if resolver is None:
            return _SourceResult(provider, None, {"provider": provider, "tier": tier, "outcome": "unavailable"})
        attempted: list[dict[str, object]] = []
        try:
            resolved = await asyncio.wait_for(
                asyncio.to_thread(resolver.resolve, target, role, timeout=timeout),
                timeout=timeout,
            )
            candidates = self._deduplicate(validate_resolved_candidates(
                provider, role, resolver.resolver_id, resolved
            ))[:8]
        except Exception as error:
            diagnostic = map_exception(error, provider=provider, retryable=False)
            return _SourceResult(provider, None, {
                "provider": provider,
                "tier": tier,
                "outcome": "resolution_failed",
                "diagnostic": diagnostic.to_dict(),
            })
        for candidate in candidates:
            host = urlsplit(candidate.execution_url).hostname or ""
            if not self.circuits.allow(host):
                attempted.append({"candidate": candidate.redacted_url_identity, "outcome": "circuit_open"})
                continue
            execution = await self.executor.execute(candidate, timeout=timeout, target=target)
            if execution.status is CandidateExecutionStatus.VALIDATED:
                self.health.record(provider, succeeded=True, latency=execution.latency)
                self.circuits.record_success(host)
                attempted.append({"candidate": candidate.redacted_url_identity, "outcome": "validated"})
                return _SourceResult(provider, execution.content, {
                    "provider": provider,
                    "tier": tier,
                    "outcome": "validated",
                    "candidates": attempted,
                })
            error = execution.error or AcquisitionError("candidate execution failed")
            diagnostic = map_exception(error, provider=provider, retryable=execution.retryable)
            attempted.append({
                "candidate": candidate.redacted_url_identity,
                "outcome": execution.status.value,
                "diagnostic": diagnostic.to_dict(),
            })
            self.health.record(provider, succeeded=False, latency=execution.latency)
            self.circuits.record_failure(host)
            if (
                isinstance(error, ProviderAcquisitionError)
                and error.category is ProviderErrorCategory.RATE_LIMIT
            ):
                break
            await asyncio.sleep(0)
        return _SourceResult(provider, None, {
            "provider": provider,
            "tier": tier,
            "outcome": "exhausted",
            "candidates": attempted,
        })

    async def acquire(
        self,
        work_version_id: str,
        role: AssetRole,
        target: AcquisitionTarget,
        providers: tuple[str, ...],
        *,
        timeout: float,
    ) -> AcquisitionResult:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        if not isinstance(role, AssetRole):
            raise TypeError("role must be an AssetRole")
        if target.role is not role:
            raise AcquisitionError("target and requested asset roles must match")
        if not providers or len(set(providers)) != len(providers):
            raise AcquisitionError("providers must be a nonempty tuple of unique names")
        if not self.assets.work_version_exists(work_version_id):
            raise AcquisitionError(f"WorkVersion does not exist: {work_version_id}")
        existing = self.coordinator.existing_asset_id(work_version_id, role)
        if existing is not None:
            return AcquisitionResult(work_version_id, "reused", existing)

        semaphore = asyncio.Semaphore(min(self.provider_concurrency, len(providers)))

        async def bounded(provider: str) -> _SourceResult:
            async with semaphore:
                return await self._run_source(target, provider, role, timeout)

        ordered = providers
        task_providers = {
            asyncio.create_task(bounded(provider)): provider for provider in ordered
        }
        pending = set(task_providers)
        results: list[_SourceResult] = []
        winner: _SourceResult | None = None
        try:
            while pending and winner is None:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                completed = await asyncio.gather(*done)
                results.extend(completed)
                valid = [item for item in completed if item.content is not None]
                if valid:
                    winner = min(valid, key=lambda item: (providers.index(item.provider), item.provider))
                    for task in pending:
                        task.cancel()
                        provider = task_providers[task]
                        results.append(_SourceResult(provider, None, {
                            "provider": provider, "tier": "first", "outcome": "race_lost",
                        }))
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        except BaseException:
            for task in task_providers:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*task_providers, return_exceptions=True)
            raise

        source_details = [result.details for result in sorted(results, key=lambda item: providers.index(item.provider))]
        if winner is None and role is AssetRole.PRIMARY_PDF:
            for resolver in self.translator_resolvers:
                translated = await self._run_source(
                    target, resolver.provider, role, timeout,
                    resolver=resolver, tier="translator",
                )
                results.append(translated)
                source_details.append(translated.details)
                if translated.content is not None:
                    winner = translated
                    break
        if winner is None and role is AssetRole.PRIMARY_PDF:
            for resolver in self.browser_resolvers:
                browsed = await self._run_source(
                    target, resolver.provider, role, timeout,
                    resolver=resolver, tier="browser",
                )
                results.append(browsed)
                source_details.append(browsed.details)
                if browsed.content is not None:
                    winner = browsed
                    break
        if winner is not None:
            content = winner.content
            assert content is not None
            accepted = self.coordinator.accept(
                BytesIO(content.data), work_version_id, role, content.media_type,
                content.format, redact({"provider": content.provider, **dict(content.provenance)}),
            )
            self.assets.append_acquisition_diagnostic(work_version_id, role, "succeeded", {
                "winner": winner.provider,
                "raw_asset_id": accepted.raw_asset.id,
                "sources": source_details,
            })
            return AcquisitionResult(work_version_id, "succeeded", accepted.raw_asset.id)

        diagnostic = map_exception(ConfigError("all source candidates were exhausted"), retryable=False)
        self.assets.append_acquisition_diagnostic(work_version_id, role, "failed", {
            "overall": diagnostic.to_dict(),
            "sources": source_details,
        })
        return AcquisitionResult(
            work_version_id,
            "failed",
            error=diagnostic.summary,
            source_failures=tuple(source_details),
        )


__all__ = ("WorkVersionAcquisitionService",)
