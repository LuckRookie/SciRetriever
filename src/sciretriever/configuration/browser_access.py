"""Secret-free controlled-Browser configuration and local readiness.

This module owns Browser policy tightening and status derivation. It performs
no network access, launches no browser, and asks the profile boundary only for
presence metadata. ``sciretriever.configuration`` remains the public surface.
"""

from __future__ import annotations

import importlib.metadata
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType

from sciretriever.model.configuration import (
    AccessConfig,
    BrowserAccessStatus,
    BrowserPolicyOverrideConfig,
    BrowserPolicyStatus,
    BrowserProbeAvailabilityStatus,
    BrowserProfilePresence,
    BrowserProfileSelectionStatus,
    BrowserRouteStatus,
    BrowserRuntimeStatus,
    BrowserSessionStatus,
    Configuration,
    ConfigurationActionRequired,
    normalize_browser_access_key,
)
from sciretriever.network.browser_scheduler import BrowserGroupPolicy

from .browser_identity import IDENTITY_SCHEMA as _IDENTITY_SCHEMA
from .browser_profiles import browser_profile_identity_status, browser_profile_status
from .cloak_runtime import (
    CLOAKBROWSER_PLAYWRIGHT_VERSION,
    CLOAKBROWSER_WRAPPER_VERSION,
    CloakRuntimeManager,
)
from .errors import fail as _fail


def _cloak_local_status(
    *,
    home: str | Path | None,
    profile_identity: str | None,
) -> tuple[bool, bool, bool, str | None, bool, bool, str | None]:
    """Return bounded Cloak/profile metadata without importing the vendor.

    The tuple is intentionally primitive and secret/path-free.  Wrapper and
    Playwright package discovery use local package metadata only.  The binary
    manager performs its own owner-only manifest verification with
    ``create=False``; no cache is created and no network action is possible.
    Profile identity status reads only the bounded identity manifest, never
    Preferences, cookies, history or site content.
    """

    try:
        wrapper_available = (
            importlib.metadata.version("cloakbrowser") == CLOAKBROWSER_WRAPPER_VERSION
        )
    except (importlib.metadata.PackageNotFoundError, ImportError, OSError, ValueError):
        wrapper_available = False
    try:
        playwright_api_available = (
            importlib.metadata.version("playwright") == CLOAKBROWSER_PLAYWRIGHT_VERSION
        )
    except (importlib.metadata.PackageNotFoundError, ImportError, OSError, ValueError):
        playwright_api_available = False

    try:
        runtime = CloakRuntimeManager(home=home).status()
    except Exception:
        # Status is a diagnostic boundary: malformed/unsafe runtime is
        # represented as unavailable rather than leaking a path or exception.
        runtime = None
    binary_presence = bool(runtime is not None and runtime.version is not None)
    binary_version = None if runtime is None else runtime.version
    binary_verified = bool(runtime is not None and runtime.verified)

    fixed_identity_manifest = False
    identity_schema: str | None = None
    if profile_identity is not None:
        try:
            identity = browser_profile_identity_status(profile_identity, home=home)
            fixed_identity_manifest = identity.manifest_ready
            identity_schema = identity.identity_schema
        except Exception:
            fixed_identity_manifest = False
            identity_schema = None
    # Keep a stable schema marker in fixtures that explicitly provide a ready
    # profile but where older test doubles do not return one.
    if fixed_identity_manifest and identity_schema is None:
        identity_schema = _IDENTITY_SCHEMA
    return (
        wrapper_available,
        playwright_api_available,
        binary_presence,
        binary_version,
        binary_verified,
        fixed_identity_manifest,
        identity_schema,
    )


def _operator_browser_policy(
    baseline: BrowserGroupPolicy,
    override: BrowserPolicyOverrideConfig,
) -> BrowserGroupPolicy:
    if override.max_concurrency is not None and override.max_concurrency > baseline.max_concurrency:
        _fail("browser policy override would relax the baseline")
    if (
        override.minimum_start_interval is not None
        and override.minimum_start_interval < baseline.minimum_start_interval
    ):
        _fail("browser policy override would relax the baseline")
    if (
        override.cooldown_after_completion is not None
        and override.cooldown_after_completion < baseline.cooldown_after_completion
    ):
        _fail("browser policy override would relax the baseline")
    if (
        override.rate_limit_cooldown is not None
        and override.rate_limit_cooldown < baseline.rate_limit_cooldown
    ):
        _fail("browser policy override would relax the baseline")
    if (
        override.failure_cooldown is not None
        and override.failure_cooldown < baseline.failure_cooldown
    ):
        _fail("browser policy override would relax the baseline")
    if (
        override.runtime_failure_threshold is not None
        and override.runtime_failure_threshold > baseline.runtime_failure_threshold
    ):
        _fail("browser policy override would relax the baseline")

    window_limit = baseline.maximum_starts_per_window
    window_seconds = baseline.window_seconds
    if override.maximum_starts_per_window is not None:
        assert override.window_seconds is not None
        if window_limit is not None and (
            override.maximum_starts_per_window > window_limit
            or window_seconds is None
            or override.window_seconds < window_seconds
        ):
            _fail("browser policy override would relax the baseline")
        window_limit = override.maximum_starts_per_window
        window_seconds = override.window_seconds

    try:
        return BrowserGroupPolicy(
            rate_limit_group=baseline.rate_limit_group,
            policy_revision=baseline.policy_revision,
            minimum_start_interval=(
                baseline.minimum_start_interval
                if override.minimum_start_interval is None
                else override.minimum_start_interval
            ),
            rate_limit_cooldown=(
                baseline.rate_limit_cooldown
                if override.rate_limit_cooldown is None
                else override.rate_limit_cooldown
            ),
            runtime_failure_threshold=(
                baseline.runtime_failure_threshold
                if override.runtime_failure_threshold is None
                else override.runtime_failure_threshold
            ),
            max_concurrency=(
                baseline.max_concurrency
                if override.max_concurrency is None
                else override.max_concurrency
            ),
            maximum_starts_per_window=window_limit,
            window_seconds=window_seconds,
            cooldown_after_completion=(
                baseline.cooldown_after_completion
                if override.cooldown_after_completion is None
                else override.cooldown_after_completion
            ),
            failure_cooldown=(
                baseline.failure_cooldown
                if override.failure_cooldown is None
                else override.failure_cooldown
            ),
        )
    except (TypeError, ValueError):
        _fail("browser policy override would relax the baseline")


def tightened_browser_group_policies(
    access: AccessConfig,
    baseline_policies: Mapping[str, BrowserGroupPolicy],
) -> Mapping[str, BrowserGroupPolicy]:
    """Apply operator Browser limits without permitting a baseline relaxation."""

    if not isinstance(access, AccessConfig) or not isinstance(baseline_policies, Mapping):
        _fail("configuration value is invalid")
    checked: dict[str, BrowserGroupPolicy] = {}
    for group, policy in baseline_policies.items():
        if type(group) is not str or not isinstance(policy, BrowserGroupPolicy):
            _fail("configuration value is invalid")
        if group != policy.rate_limit_group or group in checked:
            _fail("configuration value is invalid")
        checked[group] = policy
    for override in access.browser_policy_overrides:
        baseline = checked.get(override.rate_limit_group)
        if baseline is None:
            _fail("browser policy group is unknown")
        checked[override.rate_limit_group] = _operator_browser_policy(baseline, override)
    return MappingProxyType(checked)


def _production_browser_group_policies() -> Mapping[str, BrowserGroupPolicy]:
    from sciretriever.acquisition.profile_catalog import (
        PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    )

    policies: dict[str, BrowserGroupPolicy] = {}
    for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG:
        policy = profile.browser_policy
        if policy is None:
            continue
        existing = policies.get(policy.rate_limit_group)
        if existing is not None and existing != policy:
            _fail("configuration value is invalid")
        policies[policy.rate_limit_group] = policy
    return MappingProxyType(policies)


def configured_browser_group_policies(
    access: AccessConfig,
) -> Mapping[str, BrowserGroupPolicy]:
    """Return production Browser group policies after operator tightening."""

    return tightened_browser_group_policies(access, _production_browser_group_policies())


def eligible_production_browser_access_keys(access: AccessConfig) -> frozenset[str]:
    """Return production Browser routes permitted by the ordinary configuration."""

    from sciretriever.acquisition.profile_catalog import (
        PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    )

    if not isinstance(access, AccessConfig):
        _fail("configuration value is invalid")
    return frozenset(
        str(profile.access_key)
        for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG
        if profile.browser_route_key is not None
    )


def _browser_action(
    code: str,
    reason: str,
    action: str,
) -> tuple[ConfigurationActionRequired, ...]:
    return (ConfigurationActionRequired(code=code, reason=reason, action=action),)


def _production_browser_route_statuses(access: AccessConfig) -> tuple[BrowserRouteStatus, ...]:
    from sciretriever.acquisition.access_profiles import PolicyEvidence
    from sciretriever.acquisition.profile_catalog import (
        PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    )

    effective_policies = configured_browser_group_policies(access)
    routes: list[BrowserRouteStatus] = []
    for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG:
        if profile.browser_route_key is None:
            continue
        group = profile.browser_rate_limit_group
        if group is None:
            _fail("configuration value is invalid")
        policy = effective_policies.get(group)
        if policy is None or profile.policy_evidence is PolicyEvidence.UNVERIFIED:
            _fail("configuration value is invalid")
        routes.append(
            BrowserRouteStatus(
                access_key=str(profile.access_key),
                display_name=profile.evidence.display_name,
                route_key=profile.browser_route_key,
                rate_limit_group=str(group),
                policy=BrowserPolicyStatus(
                    evidence=profile.policy_evidence.value,
                    policy_revision=policy.policy_revision,
                    verification_date=profile.evidence.verification_date,
                    notes_reference=profile.evidence.notes_reference,
                    max_concurrency=policy.max_concurrency,
                    minimum_start_interval=policy.minimum_start_interval,
                    maximum_starts_per_window=policy.maximum_starts_per_window,
                    window_seconds=policy.window_seconds,
                    cooldown_after_completion=policy.cooldown_after_completion,
                    rate_limit_cooldown=policy.rate_limit_cooldown,
                    failure_cooldown=policy.failure_cooldown,
                    runtime_failure_threshold=policy.runtime_failure_threshold,
                ),
            )
        )
    return tuple(routes)


def _normalized_browser_probe_keys(
    values: frozenset[str],
    route_keys: frozenset[str],
) -> frozenset[str]:
    try:
        normalized = frozenset(normalize_browser_access_key(key) for key in values)
    except (TypeError, ValueError):
        _fail("configuration value is invalid")
    if normalized - route_keys:
        _fail("configuration value is invalid")
    return normalized


def _browser_required_action(  # noqa: C901
    *,
    routes_available: bool,
    cloak_wrapper_available: bool,
    playwright_api_available: bool,
    binary_presence: bool,
    binary_verified: bool,
    headed_display_available: bool,
    access: AccessConfig,
    selected_profile: str | None,
    presence: BrowserProfilePresence,
    identity_presence: str,
) -> tuple[ConfigurationActionRequired, ...]:
    if not routes_available:
        return _browser_action(
            "browser-production-route-unavailable",
            "No Publisher Browser route has completed production verification.",
            "Use Public and authorized API routes; Browser access remains unavailable.",
        )
    if not access.browser_enabled:
        return _browser_action(
            "browser-disabled",
            "Controlled Browser access is disabled in ordinary configuration.",
            "Enable Browser access explicitly in the interactive configuration center.",
        )
    if selected_profile is None:
        return _browser_action(
            "browser-profile-not-selected",
            "No operator-managed Browser profile identity is selected.",
            "Select or initialize one profile in the configuration center.",
        )
    if presence is BrowserProfilePresence.MISSING:
        return _browser_action(
            "browser-profile-missing",
            "The selected Browser profile is not present on this machine.",
            "Initialize the selected profile in the configuration center.",
        )
    if presence is BrowserProfilePresence.ATTENTION:
        return _browser_action(
            "browser-profile-attention",
            "The selected Browser profile failed its local safety check.",
            "Inspect or remove the selected profile through the configuration center.",
        )
    if identity_presence == "needs-new-runtime-profile":
        return _browser_action(
            "needs-new-runtime-profile",
            "The selected profile predates the fixed CloakBrowser identity contract.",
            "Create and select a new Browser profile; the existing profile is left untouched.",
        )
    if identity_presence != "configured":
        return _browser_action(
            "browser-profile-attention",
            "The selected Browser profile identity manifest failed its local safety check.",
            "Inspect or remove the selected profile through the configuration center.",
        )
    if not cloak_wrapper_available:
        return _browser_action(
            "browser-cloak-wrapper-unavailable",
            "The pinned CloakBrowser Python wrapper is not ready in this installation.",
            "Repair the SciRetriever installation before attempting Browser access.",
        )
    if not playwright_api_available:
        return _browser_action(
            "browser-playwright-api-unavailable",
            "The pinned Playwright API dependency is not ready in this installation.",
            "Repair the SciRetriever installation before attempting Browser access.",
        )
    if not binary_presence:
        return _browser_action(
            "browser-cloak-binary-unavailable",
            "The pinned CloakBrowser binary is not present in the local runtime cache.",
            "Install the pinned CloakBrowser binary from the configuration center.",
        )
    if not binary_verified:
        return _browser_action(
            "browser-cloak-runtime-not-ready",
            "The local CloakBrowser binary did not pass its manifest and signature checks.",
            "Repair, reinstall, or roll back the CloakBrowser runtime before Browser access.",
        )
    if not headed_display_available:
        return _browser_action(
            "browser-headed-display-unavailable",
            "The headed Browser display runtime is not available on this machine.",
            "Install Xvfb on headless Linux before attempting Browser access.",
        )
    return _browser_action(
        "browser-session-not-assessed",
        "Status does not launch the Browser or prove article entitlement.",
        "Run one explicit Browser probe for an approved Publisher target if needed.",
    )


def browser_access_status(  # noqa: C901
    configuration: Configuration,
    *,
    home: str | Path | None = None,
    probe_supported_access_keys: frozenset[str] = frozenset(),
    runtime_availability: object | None = None,
) -> BrowserAccessStatus:
    """Report fixed-profile CloakBrowser readiness without Network or launch.

    The selected profile is checked only for safe presence and filesystem
    metadata. No Cookie, local-storage, history, account or authentication
    content is read. Package and executable checks do not prove launchability,
    authentication, institution access, or article entitlement.
    """

    if not isinstance(configuration, Configuration):
        _fail("configuration value is invalid")
    if home is not None and not isinstance(home, (str, Path)):
        _fail("configuration value is invalid")
    if not isinstance(probe_supported_access_keys, frozenset) or any(
        type(key) is not str for key in probe_supported_access_keys
    ):
        _fail("configuration value is invalid")
    routes = _production_browser_route_statuses(configuration.access)
    route_keys = frozenset(route.access_key for route in routes)
    eligible_route_keys = frozenset(
        route.access_key for route in routes if route.automatic_acquisition_eligible
    )
    normalized_probe_keys = _normalized_browser_probe_keys(
        probe_supported_access_keys,
        route_keys,
    )
    normalized_probe_keys = normalized_probe_keys.intersection(eligible_route_keys)

    selected_profile = configuration.access.browser_profile
    presence = browser_profile_status(selected_profile, home=home).presence
    try:
        identity_status = browser_profile_identity_status(selected_profile, home=home)
    except Exception:
        identity_status = None
    (
        cloak_wrapper_available,
        playwright_api_available,
        binary_presence,
        binary_version,
        binary_verified,
        fixed_identity_manifest,
        identity_schema,
    ) = _cloak_local_status(home=home, profile_identity=selected_profile)
    if runtime_availability is None:
        from sciretriever.network.browser_connect import xvfb_executable_available

        display_available = xvfb_executable_available()
    else:
        runtime_wrapper = getattr(runtime_availability, "cloak_wrapper_available", None)
        runtime_playwright = getattr(runtime_availability, "playwright_api_available", None)
        runtime_binary = getattr(runtime_availability, "binary_executable_available", None)
        runtime_display = getattr(runtime_availability, "headed_display_available", None)
        if any(
            type(value) is not bool
            for value in (runtime_wrapper, runtime_playwright, runtime_binary, runtime_display)
        ):
            _fail("configuration value is invalid")
        cloak_wrapper_available = cloak_wrapper_available and runtime_wrapper is True
        playwright_api_available = playwright_api_available and runtime_playwright is True
        binary_presence = binary_presence and runtime_binary is True
        binary_verified = binary_verified and runtime_binary is True
        display_available = runtime_display is True
    identity_presence = "attention" if identity_status is None else identity_status.presence
    profile = BrowserProfileSelectionStatus(
        selected=selected_profile,
        presence=presence,
    )

    locally_usable = (
        bool(eligible_route_keys)
        and configuration.access.browser_enabled
        and cloak_wrapper_available
        and playwright_api_available
        and binary_presence
        and binary_verified
        and display_available
        and fixed_identity_manifest
        and selected_profile is not None
        and presence is BrowserProfilePresence.CONFIGURED
    )
    required = _browser_required_action(
        routes_available=bool(routes),
        cloak_wrapper_available=cloak_wrapper_available,
        playwright_api_available=playwright_api_available,
        binary_presence=binary_presence,
        binary_verified=binary_verified,
        headed_display_available=display_available,
        access=configuration.access,
        selected_profile=selected_profile,
        presence=presence,
        identity_presence=identity_presence,
    )
    return BrowserAccessStatus(
        enabled=configuration.access.browser_enabled,
        local_max_concurrency=configuration.access.browser_max_concurrency,
        runtime=BrowserRuntimeStatus(
            cloak_wrapper_available=cloak_wrapper_available,
            playwright_api_available=playwright_api_available,
            binary_presence=binary_presence,
            binary_version=binary_version,
            binary_verified=binary_verified,
            headed_display_available=display_available,
            fixed_identity_manifest=fixed_identity_manifest,
            identity_schema=identity_schema,
        ),
        profile=profile,
        session=BrowserSessionStatus(),
        automatic_acquisition_available=locally_usable,
        production_route_count=len(routes),
        automatic_route_count=len(eligible_route_keys),
        routes=tuple(routes),
        probe=BrowserProbeAvailabilityStatus(
            available=bool(normalized_probe_keys),
            supported_access_keys=tuple(sorted(normalized_probe_keys)),
        ),
        action_required=required,
    )


__all__ = (
    "browser_access_status",
    "configured_browser_group_policies",
    "eligible_production_browser_access_keys",
    "tightened_browser_group_policies",
)
