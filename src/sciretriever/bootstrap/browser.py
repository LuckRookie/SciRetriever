"""Controlled-Browser production assembly and approved live probe adapter.

Profile/session lifecycle, generic scheduling, admission readiness, and
the minimal production Browser probe change together.  The package
`sciretriever.bootstrap` remains the public assembly surface.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.configuration.cloak_runtime import (
    CLOAKBROWSER_BROWSER_VERSION,
    CloakRuntimeManager,
)
from sciretriever.model.configuration import (
    BrowserConfigurationProbeResult,
    Configuration,
    ProbeOutcome,
)
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.cloakbrowser import (
    CloakBrowserFactory,
    CloakBrowserRuntimeAvailability,
    cloakbrowser_runtime_availability,
)
from sciretriever.network.policy import ResolverLike

if TYPE_CHECKING:
    from sciretriever.acquisition.browser_admission import BrowserAdmissionController
    from sciretriever.acquisition.cohort import TieredCohortExecutor
    from sciretriever.network.browser import (
        BrowserCaptureDecision,
        BrowserCaptureEvidence,
        BrowserClient,
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
        if profile.browser_probe_enabled
    )


PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS = (
    _production_browser_configuration_probe_access_keys()
)


_BROWSER_RUNTIME_FAILURES: dict[str, tuple[str, str, bool]] = {
    "browser-disabled": (
        "Controlled Browser access is disabled in ordinary configuration.",
        "Enable Browser access explicitly in the interactive configuration center.",
        False,
    ),
    "browser-production-route-unavailable": (
        "No Publisher Browser route has completed production verification.",
        "Use Public and authorized API routes; Browser access remains unavailable.",
        False,
    ),
    "browser-profile-not-selected": (
        "No operator-managed Browser profile identity is selected.",
        "Select or initialize one profile in the configuration center.",
        False,
    ),
    "browser-profile-missing": (
        "The selected Browser profile is not present on this machine.",
        "Initialize the selected profile in the configuration center.",
        False,
    ),
    "needs-new-runtime-profile": (
        "The selected profile predates the fixed CloakBrowser identity contract.",
        "Create and select a new Browser profile; the existing profile is left untouched.",
        False,
    ),
    "browser-profile-attention": (
        "The selected Browser profile failed its local safety check.",
        "Inspect or remove the selected profile through the configuration center.",
        False,
    ),
    "browser-cloak-wrapper-unavailable": (
        "The pinned CloakBrowser Python wrapper is not ready in this installation.",
        "Repair the SciRetriever installation before attempting Browser access.",
        False,
    ),
    "browser-playwright-api-unavailable": (
        "The pinned Playwright API dependency is not ready in this installation.",
        "Repair the SciRetriever installation before attempting Browser access.",
        False,
    ),
    "browser-cloak-binary-unavailable": (
        "The pinned CloakBrowser binary is not present in the local runtime cache.",
        "Install the pinned CloakBrowser binary from the configuration center.",
        False,
    ),
    "browser-cloak-runtime-not-ready": (
        "The local CloakBrowser binary did not pass its manifest and signature checks.",
        "Repair, reinstall, or roll back the CloakBrowser runtime before Browser access.",
        False,
    ),
    "browser-headed-display-unavailable": (
        "The headed Browser display runtime is not available on this machine.",
        "Install Xvfb on headless Linux before attempting Browser access.",
        False,
    ),
}


def _browser_runtime_failure(code: str | None) -> StableFailure | None:
    if code is None:
        return None
    details = _BROWSER_RUNTIME_FAILURES.get(code)
    if details is None:
        # Keep the boundary stable even if a future readiness branch adds a
        # code before its tailored copy is documented here.
        details = (
            "The controlled Browser runtime is not ready.",
            "Inspect Browser installation and profile readiness before retrying.",
            False,
        )
    reason, action, retryable = details
    return StableFailure(code=code, reason=reason, action=action, retryable=retryable)


@dataclass(frozen=True, slots=True)
class _AcquisitionExecutionRuntime:
    """Process-local execution objects shared by every Acquisition work item."""

    browser_client: BrowserClient | None = field(repr=False)
    browser_session_broker: BrowserSessionBroker = field(repr=False)
    browser_scheduler: BrowserGroupScheduler = field(repr=False)
    browser_admission: BrowserAdmissionController = field(repr=False)
    cohort_executor: TieredCohortExecutor = field(repr=False)
    browser_runtime_failure: StableFailure | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.browser_runtime_failure is not None and not isinstance(
            self.browser_runtime_failure,
            StableFailure,
        ):
            raise TypeError("browser_runtime_failure must be StableFailure or None")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("Acquisition execution runtime cannot be serialized")

    def close(self) -> None:
        """Retire the shared Browser runtime without deleting its persistent profile."""

        self.browser_session_broker.close()


@dataclass(frozen=True, slots=True, repr=False)
class _BrowserRuntimeAssembly:
    """One isolated assembly of the sole production Browser runtime."""

    execution: _AcquisitionExecutionRuntime = field(repr=False)
    availability: CloakBrowserRuntimeAvailability = field(repr=False)
    ready: bool
    failure_code: str | None = None

    @property
    def failure(self) -> StableFailure | None:
        """Return the redacted failure corresponding to ``failure_code``."""

        return _browser_runtime_failure(self.failure_code)


@dataclass(frozen=True, slots=True, repr=False)
class _BrowserProbeTarget:
    policy: BrowserGroupPolicy = field(repr=False)
    session_key: str
    url: str
    origin: str


@dataclass(frozen=True, slots=True)
class _BrowserProbeExecution:
    """Typed deterministic probe execution; no raw callback crosses Network."""

    expected_origin: str
    launched: list[bool] = field(repr=False)
    target_reached: list[bool] = field(repr=False)

    def run(self, session: BrowserFlowSession) -> None:
        self.launched[0] = True
        observation = session.observe()
        self.target_reached[0] = (
            observation.origin == self.expected_origin and observation.status_code == 200
        )


class _DenyAllBrowserCapturePolicy:
    """Configuration probes may inspect page state but never read article bytes."""

    __slots__ = ()

    def decide(self, evidence: BrowserCaptureEvidence) -> BrowserCaptureDecision:
        from sciretriever.network.browser import BrowserCaptureDecision, BrowserCaptureEvidence

        if not isinstance(evidence, BrowserCaptureEvidence):
            raise TypeError("evidence must be BrowserCaptureEvidence")
        return BrowserCaptureDecision.REJECT


class _ProductionBrowserConfigurationProbePort:
    """One scheduled runtime/reachability assessment per production route."""

    __slots__ = ("_client", "_scheduler", "_supported_access_keys", "_targets")

    def __init__(
        self,
        client: BrowserClient | None,
        scheduler: BrowserGroupScheduler,
        supported_access_keys: frozenset[str],
        *,
        session_key: str,
        policy: BrowserGroupPolicy,
    ) -> None:
        from sciretriever.acquisition.profile_catalog import (
            PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
        )
        from sciretriever.network.browser import BrowserClient
        from sciretriever.network.browser_scheduler import BrowserGroupPolicy, BrowserGroupScheduler

        if client is not None and not isinstance(client, BrowserClient):
            raise TypeError("client must be a BrowserClient or None")
        if not isinstance(scheduler, BrowserGroupScheduler):
            raise TypeError("scheduler must be a BrowserGroupScheduler")
        if not isinstance(policy, BrowserGroupPolicy):
            raise TypeError("policy must be a BrowserGroupPolicy")
        if (
            not isinstance(supported_access_keys, frozenset)
            or any(type(key) is not str for key in supported_access_keys)
            or supported_access_keys - PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS
        ):
            raise TypeError("supported_access_keys must contain production Browser access keys")
        targets: dict[str, _BrowserProbeTarget] = {}
        for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG:
            if not profile.browser_probe_enabled:
                continue
            if not profile.landing_origins:
                raise BootstrapError("acquisition-not-ready")
            access_key = str(profile.access_key)
            if access_key not in supported_access_keys:
                continue
            url = f"{profile.landing_origins[0]}/"
            targets[access_key] = _BrowserProbeTarget(
                policy=policy,
                session_key=session_key,
                url=url,
                origin=profile.landing_origins[0],
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
        from sciretriever.acquisition.sources.browser import (
            build_generic_browser_destination_guard,
        )
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
        from sciretriever.network.browser_scheduler import BrowserGroupPolicy

        if not isinstance(policy, BrowserGroupPolicy):
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
            execution = _BrowserProbeExecution(
                expected_origin=target.origin,
                launched=[False],
                target_reached=[False],
            )
            destination_guard = build_generic_browser_destination_guard(target.url)

            result = self._client.run(
                AccessScope(access_key, "web"),
                target.url,
                AccessPolicy(max_concurrency=1),
                controller=execution,
                destination_guard=destination_guard,
                capture_policy=_DenyAllBrowserCapturePolicy(),
                navigation_only=False,
                discard_unapproved_subresources=True,
                session_key=session_key,
            )
            launched = execution.launched[0]
            target_reached = execution.target_reached[0]
            expected_completion = isinstance(result, AccessFailure) and result.code == "no-download"
            passed = expected_completion and target_reached
            result_fields = {
                "challenge_dependency_declared": False,
                "challenge_resource_admitted_count": 0,
                "challenge_resource_blocked_count": 0,
            }
            if passed:
                probe_result = BrowserConfigurationProbeResult(
                    access_key=access_key,
                    outcome=ProbeOutcome.PASSED,
                    local_ready=True,
                    browser_launched=True,
                    minimal_target_reached=True,
                    navigation_count=1,
                    **result_fields,
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
                **result_fields,
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
            challenge_dependency_declared=False,
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
                "browser-probe-challenge-unresolved",
                BrowserGroupFeedback.NONE,
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
    """Construct one CloakBrowser Acquisition runtime for this object graph."""

    return _new_browser_runtime(
        configuration,
        access_coordinator=access_coordinator,
        resolver=resolver,
        browser_profile_home=browser_profile_home,
    ).execution


def _new_browser_runtime(  # noqa: C901
    configuration: Configuration,
    *,
    access_coordinator: AccessCoordinator,
    resolver: ResolverLike,
    browser_profile_home: str | Path | None = None,
) -> _BrowserRuntimeAssembly:
    """Build one isolated assembly of the sole production CloakBrowser runtime.

    Ordinary Acquisition and an explicit ``config test`` each call this
    function, so they share the same readiness and object-graph contract while
    retaining independent brokers and live runtime lifecycles. Missing local
    readiness never falls back to a stock launcher.
    """

    from sciretriever.acquisition.browser_admission import (
        BrowserAdmissionConfiguration,
        BrowserAdmissionController,
        BrowserGroupAdmissionState,
        BrowserGroupReadiness,
    )
    from sciretriever.acquisition.cohort import TieredCohortExecutor
    from sciretriever.configuration import (
        browser_profile_identity_status,
        browser_profile_status,
        configured_browser_group_policies,
        resolve_browser_profile,
    )
    from sciretriever.model.configuration import BrowserProfilePresence
    from sciretriever.network.browser import BrowserClient
    from sciretriever.network.browser_scheduler import BrowserGroupScheduler
    from sciretriever.network.browser_sessions import BrowserSessionBroker

    if not isinstance(configuration, Configuration):
        raise TypeError("configuration must be a Configuration")
    if not isinstance(access_coordinator, AccessCoordinator):
        raise TypeError("access_coordinator must be an AccessCoordinator")
    if not callable(resolver) and not callable(getattr(resolver, "resolve", None)):
        raise TypeError("resolver must implement the Network resolver contract")
    session_broker = BrowserSessionBroker()
    scheduler = BrowserGroupScheduler(
        clock=_SystemBrowserSchedulerClock(),
        max_concurrency=configuration.browser.max_concurrency,
    )
    selected_profile = configuration.browser.profile
    profile_presence = browser_profile_status(
        selected_profile,
        home=browser_profile_home,
    ).presence
    identity_status = browser_profile_identity_status(
        selected_profile,
        home=browser_profile_home,
    )

    try:
        runtime_manager = CloakRuntimeManager(home=browser_profile_home)
        runtime_status = runtime_manager.status()
    except Exception:
        runtime_manager = None
        runtime_status = None
    cache_directory: Path | None = None
    runtime_verified = bool(runtime_status is not None and runtime_status.ready)
    if runtime_verified and runtime_manager is not None:
        try:
            cache_directory = runtime_manager.cache_directory
        except Exception:
            runtime_verified = False
    try:
        availability = cloakbrowser_runtime_availability(
            browser_version=CLOAKBROWSER_BROWSER_VERSION,
            cache_directory=cache_directory if runtime_verified else None,
        )
    except (TypeError, ValueError):
        availability = CloakBrowserRuntimeAvailability(
            cloak_wrapper_available=False,
            playwright_api_available=False,
            binary_executable_available=False,
            headed_display_available=False,
            browser_version=None,
        )

    profile_ready = (
        selected_profile is not None
        and profile_presence is BrowserProfilePresence.CONFIGURED
        and identity_status.ready
    )
    runtime_files_ready = (
        runtime_verified
        and availability.cloak_wrapper_available
        and availability.playwright_api_available
        and availability.binary_executable_available
        and availability.headed_display_available
    )
    ready = configuration.browser.enabled and profile_ready and runtime_files_ready
    failure_code: str | None = None
    if not configuration.browser.enabled:
        failure_code = "browser-disabled"
    elif selected_profile is None:
        failure_code = "browser-profile-not-selected"
    elif profile_presence is BrowserProfilePresence.MISSING:
        failure_code = "browser-profile-missing"
    elif identity_status.presence == "needs-new-runtime-profile":
        failure_code = "needs-new-runtime-profile"
    elif (
        profile_presence is BrowserProfilePresence.ATTENTION
        or identity_status.presence == "attention"
    ):
        failure_code = "browser-profile-attention"
    elif not availability.cloak_wrapper_available:
        failure_code = "browser-cloak-wrapper-unavailable"
    elif not availability.playwright_api_available:
        failure_code = "browser-playwright-api-unavailable"
    elif runtime_status is None or not runtime_status.ready:
        failure_code = (
            "browser-cloak-binary-unavailable"
            if runtime_status is None or runtime_status.presence == "missing"
            else "browser-cloak-runtime-not-ready"
        )
    elif not availability.binary_executable_available:
        failure_code = "browser-cloak-binary-unavailable"
    elif not availability.headed_display_available:
        failure_code = "browser-headed-display-unavailable"

    browser_client: BrowserClient | None = None
    if ready:
        assert selected_profile is not None
        assert runtime_manager is not None
        try:
            profile_handle = resolve_browser_profile(
                selected_profile,
                home=browser_profile_home,
            )
            browser_client = BrowserClient(
                factory=CloakBrowserFactory(profile_handle, runtime_manager),
                resolver=resolver,
                coordinator=access_coordinator,
                session_broker=session_broker,
            )
        except Exception:
            ready = False
            failure_code = "browser-cloak-runtime-not-ready"

    effective_policies = configured_browser_group_policies(configuration.browser)
    if not profile_ready:
        group_readiness = BrowserGroupReadiness.SESSION_MISSING
    elif not runtime_files_ready:
        group_readiness = BrowserGroupReadiness.RUNTIME_FAILED
    else:
        group_readiness = BrowserGroupReadiness.READY
    groups = (
        BrowserGroupAdmissionState(
            policy=effective_policies["browser-generic"],
            session_key=selected_profile or "browser-profile-missing",
            readiness=group_readiness,
        ),
    )
    execution_confirmed = configuration.browser.enabled and profile_ready
    admission = BrowserAdmissionController(
        BrowserAdmissionConfiguration(
            explicitly_enabled=configuration.browser.enabled,
            execution_confirmed=execution_confirmed,
            runtime_ready=browser_client is not None,
            groups=groups,
        )
    )
    execution = _AcquisitionExecutionRuntime(
        browser_client=browser_client,
        browser_session_broker=session_broker,
        browser_scheduler=scheduler,
        browser_admission=admission,
        cohort_executor=TieredCohortExecutor(
            max_concurrency=configuration.execution.max_concurrency,
            browser_admission=admission,
            browser_scheduler=scheduler,
        ),
        browser_runtime_failure=_browser_runtime_failure(failure_code),
    )
    return _BrowserRuntimeAssembly(
        execution=execution,
        availability=availability,
        ready=ready,
        failure_code=failure_code,
    )
