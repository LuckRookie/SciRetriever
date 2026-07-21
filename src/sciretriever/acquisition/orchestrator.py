"""P4 compatibility adapter over the canonical P5 lifecycle owner."""

from __future__ import annotations

from typing import Callable, Mapping

from sciretriever.acquisition.models import AcquisitionProvider, AcquisitionResult, AcquisitionTarget, AdmissionResult
from sciretriever.acquisition.controls import CircuitBreaker, HostBudget, HostBudgetManager, ProviderHealth, RetryPolicy
from sciretriever.acquisition.multi_orchestrator import MultiSourceOrchestrator
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan
from sciretriever.catalog.jobs import JobRepository
from sciretriever.errors import AcquisitionError
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator


class AcquisitionOrchestrator:
    """Preserve the P4 API by translating it to a one-entry serial plan."""

    def __init__(
        self,
        jobs: JobRepository,
        coordinator: AssetAcceptanceCoordinator,
        *,
        budgets: HostBudgetManager | None = None,
        health: ProviderHealth | None = None,
        circuits: CircuitBreaker | None = None,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        self.jobs = jobs
        self.coordinator = coordinator
        self.budgets = budgets
        self.health = health
        self.circuits = circuits
        self.retry_policy = retry_policy

    async def acquire(
        self,
        admission: AdmissionResult,
        target: AcquisitionTarget,
        provider: AcquisitionProvider,
        *,
        timeout: float,
    ) -> AcquisitionResult:
        if provider.name != admission.provider:
            raise AcquisitionError(
                f"admitted provider {admission.provider!r} does not match {provider.name!r}"
            )
        if target.role is not admission.asset_role:
            raise AcquisitionError("acquisition target role does not match admission")
        plan = SourcePlan(
            role=admission.asset_role,
            mode=RoutingMode.SERIAL,
            entries=(SourceEntry("p4", provider.name, 0),),
        )
        return await MultiSourceOrchestrator(
            self.jobs,
            self.coordinator,
            {provider.name: provider},
            budgets=self.budgets,
            health=self.health,
            circuits=self.circuits,
            retry_policy=self.retry_policy,
        ).acquire(admission, target, plan, timeout=timeout)


ProviderLoader = Callable[[tuple[str, ...]], Mapping[str, AcquisitionProvider]]


class AcquisitionRuntime:
    """Own process-local provider controls for exactly one command invocation."""

    def __init__(
        self,
        jobs: JobRepository,
        coordinator: AssetAcceptanceCoordinator,
        provider_loader: ProviderLoader,
        *,
        default_budget: HostBudget = HostBudget(),
        budget_overrides: Mapping[str, HostBudget] | None = None,
    ) -> None:
        self.jobs = jobs
        self.coordinator = coordinator
        self._provider_loader = provider_loader
        self.providers: dict[str, AcquisitionProvider] = {}
        self.budgets = HostBudgetManager(default_budget, dict(budget_overrides or {}))
        self.health = ProviderHealth()
        self.circuits = CircuitBreaker()
        self.retry_policy = RetryPolicy()
        self._multi: dict[tuple[str, ...], MultiSourceOrchestrator] = {}
        self._single: AcquisitionOrchestrator | None = None

    def provider(self, name: str) -> AcquisitionProvider:
        if name not in self.providers:
            self.providers.update(self._provider_loader((name,)))
        try:
            return self.providers[name]
        except KeyError as error:
            raise ValueError(f"provider is unavailable: {name}") from error

    def multi(self, names: tuple[str, ...]) -> MultiSourceOrchestrator:
        key = tuple(dict.fromkeys(names))
        missing = tuple(name for name in key if name not in self.providers)
        if missing:
            self.providers.update(self._provider_loader(missing))
        if key not in self._multi:
            registry = {name: self.providers[name] for name in key if name in self.providers}
            self._multi[key] = MultiSourceOrchestrator(
                self.jobs,
                self.coordinator,
                registry,
                budgets=self.budgets,
                health=self.health,
                circuits=self.circuits,
                retry_policy=self.retry_policy,
            )
        return self._multi[key]

    def single(self) -> AcquisitionOrchestrator:
        if self._single is None:
            self._single = AcquisitionOrchestrator(
                self.jobs,
                self.coordinator,
                budgets=self.budgets,
                health=self.health,
                circuits=self.circuits,
                retry_policy=self.retry_policy,
            )
        return self._single


__all__ = ("AcquisitionOrchestrator", "AcquisitionRuntime", "ProviderLoader")
