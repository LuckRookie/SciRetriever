"""Controlled-Browser production assembly and approved live probe adapter.

Profile/session lifecycle, Publisher-lane scheduling, admission readiness, and
the minimal production Browser probe change together.  The package
`sciretriever.bootstrap` remains the public assembly surface.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.model.configuration import (
    BrowserConfigurationProbeResult,
    Configuration,
    ProbeOutcome,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.policy import ResolverLike

if TYPE_CHECKING:
    from sciretriever.acquisition.browser_admission import BrowserAdmissionController
    from sciretriever.acquisition.cohort import TieredCohortExecutor
    from sciretriever.acquisition.sources.browser_rules import BrowserSiteRule
    from sciretriever.network.browser import (
        BrowserClient,
        BrowserDestinationKind,
        BrowserFlowSession,
    )
    from sciretriever.network.browser_scheduler import (
        BrowserGroupFeedback,
        BrowserGroupPolicy,
        BrowserGroupScheduler,
        BrowserSchedulerCancellation,
    )
    from sciretriever.network.browser_sessions import BrowserSessionBroker


def _production_browser_configuration_probe_access_keys() -> frozenset[str]:
    from sciretriever.acquisition.profile_catalog import (
        PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    )

    return frozenset(
        str(profile.access_key)
        for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG
        if profile.browser_route_key is not None
    )


PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS = (
    _production_browser_configuration_probe_access_keys()
)


@dataclass(frozen=True, slots=True)
class _AcquisitionExecutionRuntime:
    """Process-local execution objects shared by every Acquisition work item."""

    browser_client: BrowserClient | None = field(repr=False)
    browser_session_broker: BrowserSessionBroker = field(repr=False)
    browser_scheduler: BrowserGroupScheduler = field(repr=False)
    browser_admission: BrowserAdmissionController = field(repr=False)
    cohort_executor: TieredCohortExecutor = field(repr=False)

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("Acquisition execution runtime cannot be serialized")

    def close(self) -> None:
        """Retire the shared Browser runtime without deleting its persistent profile."""

        self.browser_session_broker.close()


@dataclass(frozen=True, slots=True, repr=False)
class _BrowserProbeDestinationGuard:
    """Keep one configuration probe inside its reviewed Publisher origins."""

    rule: BrowserSiteRule = field(repr=False)

    def check(self, url: str, kind: BrowserDestinationKind) -> None:
        from sciretriever.network.browser import BrowserDestinationKind

        if not isinstance(kind, BrowserDestinationKind) or not self.rule.allows_url(url):
            raise ValueError("Browser probe destination is outside the approved rule")


@dataclass(frozen=True, slots=True, repr=False)
class _BrowserProbeTarget:
    policy: BrowserGroupPolicy = field(repr=False)
    session_key: str
    rule: BrowserSiteRule = field(repr=False)


class _ProductionBrowserConfigurationProbePort:
    """One scheduled runtime/reachability assessment per production route."""

    __slots__ = ("_client", "_scheduler", "_supported_access_keys", "_targets")

    def __init__(
        self,
        client: BrowserClient | None,
        scheduler: BrowserGroupScheduler,
        supported_access_keys: frozenset[str],
    ) -> None:
        from sciretriever.acquisition.profile_catalog import (
            PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
        )
        from sciretriever.acquisition.sources.browser_rules import (
            PRODUCTION_BROWSER_RULE_CATALOG,
        )
        from sciretriever.network.browser import BrowserClient
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        if client is not None and not isinstance(client, BrowserClient):
            raise TypeError("client must be a BrowserClient or None")
        if not isinstance(scheduler, BrowserGroupScheduler):
            raise TypeError("scheduler must be a BrowserGroupScheduler")
        if (
            not isinstance(supported_access_keys, frozenset)
            or any(type(key) is not str for key in supported_access_keys)
            or supported_access_keys - PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS
        ):
            raise TypeError("supported_access_keys must contain production Browser access keys")
        rules_by_identity = {
            (rule.rule_id, rule.revision): rule for rule in PRODUCTION_BROWSER_RULE_CATALOG.rules
        }
        targets: dict[str, _BrowserProbeTarget] = {}
        for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG:
            if profile.browser_route_key is None:
                continue
            policy = profile.browser_policy
            session_key = profile.browser_session_key
            rule_id = profile.browser_rule_id
            rule_revision = profile.browser_rule_revision
            if policy is None or session_key is None or rule_id is None or rule_revision is None:
                raise BootstrapError("acquisition-not-ready")
            rule = rules_by_identity.get((rule_id, rule_revision))
            if rule is None:
                raise BootstrapError("acquisition-not-ready")
            access_key = str(profile.access_key)
            if access_key not in supported_access_keys:
                continue
            targets[access_key] = _BrowserProbeTarget(
                policy=policy,
                session_key=str(session_key),
                rule=rule,
            )
        if frozenset(targets) != supported_access_keys:
            raise BootstrapError("acquisition-not-ready")
        self._client = client
        self._scheduler = scheduler
        self._supported_access_keys = supported_access_keys
        self._targets = targets

    @property
    def supported_access_keys(self) -> frozenset[str]:
        return self._supported_access_keys

    def probe(self, access_key: str) -> BrowserConfigurationProbeResult:
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.admission import AccessPolicy, AccessScope
        from sciretriever.network.browser_scheduler import (
            BrowserArticleAttempt,
            BrowserAttemptCompletion,
            BrowserAttemptDisposition,
            BrowserGroupFeedback,
            BrowserScheduledDisposition,
        )

        target = self._targets.get(access_key)
        if target is None or self._client is None:
            raise AssertionError("Browser probe executed without a ready approved target")
        policy = target.policy
        session_key = target.session_key
        rule = target.rule
        from sciretriever.acquisition.sources.browser_rules import BrowserSiteRule
        from sciretriever.network.browser_scheduler import BrowserGroupPolicy

        if not isinstance(policy, BrowserGroupPolicy) or not isinstance(rule, BrowserSiteRule):
            raise AssertionError("Browser probe target violated its production contract")
        attempt = BrowserArticleAttempt(
            attempt_key=f"configuration-probe-{access_key}",
            rate_limit_group=policy.rate_limit_group,
            session_key=session_key,
            policy=policy,
        )

        def run(
            _attempt: BrowserArticleAttempt,
        ) -> BrowserAttemptCompletion[BrowserConfigurationProbeResult]:
            del _attempt
            launched = False
            target_reached = False

            def flow(session: BrowserFlowSession) -> None:
                nonlocal launched, target_reached
                launched = True
                observation = session.observe()
                target_reached = (
                    observation.origin == rule.landing_origin and observation.status_code == 200
                )

            result = self._client.run(
                AccessScope(rule.web_scope_provider_name, "web"),
                f"{rule.landing_origin}/",
                AccessPolicy(max_concurrency=1),
                flow=flow,
                destination_guard=_BrowserProbeDestinationGuard(rule),
                navigation_only=True,
                session_key=session_key,
            )
            expected_completion = isinstance(result, AccessFailure) and result.code == "no-download"
            passed = expected_completion and target_reached
            if passed:
                probe_result = BrowserConfigurationProbeResult(
                    access_key=access_key,
                    outcome=ProbeOutcome.PASSED,
                    local_ready=True,
                    browser_launched=True,
                    minimal_target_reached=True,
                    navigation_count=1,
                )
                return BrowserAttemptCompletion(
                    probe_result,
                    BrowserAttemptDisposition.COMPLETED,
                    BrowserGroupFeedback.SUCCESS,
                )

            failure_code, feedback = self._probe_failure(result, target_reached)
            probe_result = BrowserConfigurationProbeResult(
                access_key=access_key,
                outcome=ProbeOutcome.FAILED,
                local_ready=True,
                browser_launched=launched,
                minimal_target_reached=target_reached if launched else None,
                navigation_count=1 if launched else 0,
                failure_code=failure_code,
            )
            return BrowserAttemptCompletion(
                probe_result,
                BrowserAttemptDisposition.FAILED,
                feedback,
            )

        scheduled = self._scheduler.execute((attempt,), run)[0]
        if (
            scheduled.disposition is BrowserScheduledDisposition.EXECUTED
            and scheduled.value is not None
        ):
            return scheduled.value
        return BrowserConfigurationProbeResult(
            access_key=access_key,
            outcome=ProbeOutcome.FAILED,
            local_ready=True,
            browser_launched=False,
            failure_code=(
                "browser-probe-action-required"
                if scheduled.disposition is BrowserScheduledDisposition.ACTION_REQUIRED
                else "browser-probe-deferred"
            ),
        )

    @staticmethod
    def _probe_failure(
        result: object,
        target_reached: bool,
    ) -> tuple[str, BrowserGroupFeedback]:
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.browser_scheduler import BrowserGroupFeedback

        if not target_reached:
            return "browser-probe-target-unreachable", BrowserGroupFeedback.RUNTIME_FAILURE
        if not isinstance(result, AccessFailure):
            return "browser-probe-unexpected-response", BrowserGroupFeedback.RUNTIME_FAILURE
        return {
            "challenge": (
                "browser-probe-challenge-required",
                BrowserGroupFeedback.CHALLENGE_REQUIRED,
            ),
            "timeout": ("browser-probe-timeout", BrowserGroupFeedback.RUNTIME_FAILURE),
            "cleanup": ("browser-probe-cleanup-failed", BrowserGroupFeedback.CLEANUP_FAILURE),
            "cancelled": ("browser-probe-cancelled", BrowserGroupFeedback.RUNTIME_FAILURE),
            "admission": ("browser-probe-admission-failed", BrowserGroupFeedback.RUNTIME_FAILURE),
            "policy": ("browser-probe-policy-failed", BrowserGroupFeedback.RUNTIME_FAILURE),
        }.get(
            result.code,
            ("browser-probe-runtime-failed", BrowserGroupFeedback.RUNTIME_FAILURE),
        )


class _SystemBrowserSchedulerClock:
    """Monotonic production clock with cancellation-aware local waits."""

    __slots__ = ()

    def now(self) -> float:
        return time.monotonic()

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                return
            waiter = None if cancel_event is None else getattr(cancel_event, "wait", None)
            if callable(waiter):
                waiter(remaining)
            else:
                time.sleep(remaining if cancel_event is None else min(remaining, 0.1))


def _new_acquisition_execution_runtime(
    configuration: Configuration,
    *,
    access_coordinator: AccessCoordinator,
    resolver: ResolverLike,
    browser_profile_home: str | Path | None = None,
) -> _AcquisitionExecutionRuntime:
    """Construct one no-Network Acquisition runtime for this object graph."""

    from sciretriever.acquisition.browser_admission import (
        BrowserAdmissionConfiguration,
        BrowserAdmissionController,
        BrowserGroupAdmissionState,
        BrowserGroupReadiness,
    )
    from sciretriever.acquisition.cohort import TieredCohortExecutor
    from sciretriever.acquisition.profile_catalog import (
        PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    )
    from sciretriever.configuration import (
        browser_profile_status,
        configured_browser_group_policies,
        resolve_browser_profile,
    )
    from sciretriever.model.configuration import BrowserProfilePresence
    from sciretriever.network.browser import BrowserClient
    from sciretriever.network.browser_scheduler import BrowserGroupScheduler
    from sciretriever.network.browser_sessions import BrowserSessionBroker
    from sciretriever.network.playwright import (
        PlaywrightBrowserFactory,
        playwright_runtime_availability,
    )

    if not isinstance(configuration, Configuration):
        raise TypeError("configuration must be a Configuration")
    if not isinstance(access_coordinator, AccessCoordinator):
        raise TypeError("access_coordinator must be an AccessCoordinator")
    if not callable(resolver) and not callable(getattr(resolver, "resolve", None)):
        raise TypeError("resolver must implement the Network resolver contract")
    session_broker = BrowserSessionBroker()
    scheduler = BrowserGroupScheduler(
        clock=_SystemBrowserSchedulerClock(),
        max_concurrency=configuration.access.browser_max_concurrency,
    )
    profiles = tuple(
        profile
        for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG
        if profile.browser_route_key is not None
    )
    selected_profile = configuration.access.browser_profile
    profile_presence = browser_profile_status(
        selected_profile,
        home=browser_profile_home,
    ).presence
    runtime_availability = playwright_runtime_availability()
    runtime_files_ready = (
        runtime_availability.python_dependency_available
        and runtime_availability.chromium_executable_available
        and runtime_availability.headed_display_available
    )
    profile_ready = (
        selected_profile is not None and profile_presence is BrowserProfilePresence.CONFIGURED
    )
    browser_client: BrowserClient | None = None
    if profiles and configuration.access.browser_enabled and profile_ready and runtime_files_ready:
        assert selected_profile is not None
        profile_handle = resolve_browser_profile(
            selected_profile,
            home=browser_profile_home,
        )
        browser_client = BrowserClient(
            factory=PlaywrightBrowserFactory(profile_handle),
            resolver=resolver,
            coordinator=access_coordinator,
            session_broker=session_broker,
        )

    effective_policies = configured_browser_group_policies(configuration.access)
    if not profile_ready:
        group_readiness = BrowserGroupReadiness.SESSION_MISSING
    elif not runtime_files_ready:
        group_readiness = BrowserGroupReadiness.RUNTIME_FAILED
    else:
        group_readiness = BrowserGroupReadiness.READY
    groups = tuple(
        BrowserGroupAdmissionState(
            policy=effective_policies[profile.browser_rate_limit_group],
            session_key=profile.browser_session_key,
            readiness=group_readiness,
        )
        for profile in profiles
        if profile.browser_rate_limit_group is not None and profile.browser_session_key is not None
    )
    execution_confirmed = configuration.access.browser_enabled and bool(profiles) and profile_ready
    admission = BrowserAdmissionController(
        BrowserAdmissionConfiguration(
            explicitly_enabled=configuration.access.browser_enabled,
            execution_confirmed=execution_confirmed,
            runtime_ready=browser_client is not None,
            groups=groups,
        )
    )
    return _AcquisitionExecutionRuntime(
        browser_client=browser_client,
        browser_session_broker=session_broker,
        browser_scheduler=scheduler,
        browser_admission=admission,
        cohort_executor=TieredCohortExecutor(
            max_concurrency=configuration.execution.max_concurrency,
            browser_admission=admission,
            browser_scheduler=scheduler,
        ),
    )
