"""Secret-free local configuration status and explicit probe selection.

Status derives only local readiness and credential presence.  Probe functions
validate an explicit caller-owned adapter result; they do not own Network or
persist probe observations.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Protocol, runtime_checkable

from sciretriever.configuration.credentials import (
    _CAPABILITY_MATRIX,
    _CORE_CREDENTIAL_SPECS,
    CredentialLookup,
    _credential_status,
    _provider_name,
    _service_origin,
    load_credentials,
)
from sciretriever.configuration.errors import ConfigurationError
from sciretriever.configuration.errors import fail as _fail
from sciretriever.model.configuration import (
    AnalysisAuthentication,
    AnalysisConfigurationStatus,
    BrowserAccessStatus,
    BrowserConfigurationProbeResult,
    BrowserProfilePresence,
    Configuration,
    ConfigurationCapabilityStatus,
    ConfigurationProbeResult,
    ConfigurationProbeSummary,
    ConfigurationRuntimeStatus,
    ConfigurationStatus,
    CoreCredentialService,
    CredentialStatus,
    ParserConnectionMode,
    ParsingConfigurationStatus,
    ProbeOutcome,
    ProviderCapability,
    ProviderCredentialStatus,
    ProviderName,
    normalize_browser_access_key,
)

_READY_CREDENTIAL_STATUSES = frozenset({CredentialStatus.CONFIGURED, CredentialStatus.NOT_REQUIRED})


def _metadata_configuration_statuses(
    configuration: Configuration,
    credentials: CredentialLookup,
) -> dict[ProviderName, ConfigurationCapabilityStatus]:
    from sciretriever.metadata.registry import metadata_provider_statuses

    result: dict[ProviderName, ConfigurationCapabilityStatus] = {}
    for status in metadata_provider_statuses(configuration, credentials):
        provider = ProviderName(status.provider_name)
        production = status.production_available
        ordinary = status.failure_code != "missing-ordinary-parameter"
        credential = _credential_status(
            provider,
            ProviderCapability.METADATA,
            credentials.field_names(provider),
            section_present=credentials.has_provider(provider),
            production_supported=production,
        )
        policy = status.access_policy is not None and status.access_scope is not None
        result[provider] = ConfigurationCapabilityStatus(
            provider=provider,
            capability=ProviderCapability.METADATA,
            production_available=production,
            enabled=status.enabled,
            ordinary_parameters_ready=ordinary,
            credential=credential,
            access_policy_ready=policy,
            probe_available=True,
            local_ready=status.ready,
            failure_code=status.failure_code,
        )
    return result


def _acquisition_configuration_statuses(
    configuration: Configuration,
    credentials: CredentialLookup,
    *,
    configured_sci_hub_resolver: object | None,
) -> dict[ProviderName, ConfigurationCapabilityStatus]:
    from sciretriever.acquisition.registry import acquisition_provider_statuses

    result: dict[ProviderName, ConfigurationCapabilityStatus] = {}
    statuses = acquisition_provider_statuses(
        configuration,
        configured_sci_hub_resolver=configured_sci_hub_resolver,  # type: ignore[arg-type]
    )
    for status in statuses:
        provider = ProviderName(status.provider_name)
        # Registry readiness answers whether normal Acquisition can consume
        # this Provider's evidence.  A generic AssetHint route is deliberately
        # not a Provider service adapter and must never become a config-test
        # probe registration.  No Acquisition Source currently has a
        # literature-independent, officially specified minimal probe.
        production = any(mapping.production_available for mapping in status.mappings)
        ordinary = status.failure_code != "missing-ordinary-parameter"
        has_authorized_source = any(
            mapping.capability.value == "authorized-provider-api" and mapping.production_available
            for mapping in status.mappings
        )
        has_authorized_mapping = any(
            mapping.capability.value == "authorized-provider-api" for mapping in status.mappings
        )
        credential = (
            _credential_status(
                provider,
                ProviderCapability.ACQUISITION,
                credentials.field_names(provider),
                section_present=credentials.has_provider(provider),
                production_supported=has_authorized_source,
            )
            if has_authorized_mapping
            else ProviderCredentialStatus(
                provider=provider,
                capability=ProviderCapability.ACQUISITION,
                status=(
                    CredentialStatus.NOT_REQUIRED if production else CredentialStatus.UNSUPPORTED
                ),
            )
        )
        policy = production
        credential_ready = (
            not has_authorized_source or credential.status in _READY_CREDENTIAL_STATUSES
        )
        local_ready = status.ready and credential_ready
        failure_code = status.failure_code
        if status.ready and not credential_ready:
            failure_code = "missing-required-credential"
        result[provider] = ConfigurationCapabilityStatus(
            provider=provider,
            capability=ProviderCapability.ACQUISITION,
            production_available=production,
            enabled=status.enabled,
            ordinary_parameters_ready=ordinary,
            credential=credential,
            access_policy_ready=policy,
            probe_available=False,
            local_ready=local_ready,
            failure_code=failure_code,
        )
    return result


def _configuration_fingerprint(configuration: Configuration) -> str:
    """Bind a status snapshot to ordinary settings without retaining paths.

    Ordinary configuration is already secret-free.  Catalog and artifact
    path strings are additionally reduced to presence bits before hashing so
    the diagnostic snapshot cannot become a path fingerprint.  The remaining
    canonical payload includes every ordinary group, including enabled
    Provider order and probe-relevant product parameters.
    """

    payload: dict[str, object] = configuration.model_dump(mode="json", by_alias=True)
    paths = payload.get("paths")
    if not isinstance(paths, dict):
        _fail("configuration value is invalid")
    payload["paths"] = {
        "catalog_path_configured": paths.get("catalog_path") is not None,
        "artifact_root_configured": paths.get("artifact_root") is not None,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def configuration_status(
    configuration: Configuration,
    *,
    credentials: CredentialLookup | None = None,
    credentials_home: str | Path | None = None,
    configured_sci_hub_resolver: object | None = None,
) -> ConfigurationStatus:
    """Compute the full local matrix without Network, Catalog, or artifacts."""

    if not isinstance(configuration, Configuration):
        _fail("configuration value is invalid")
    if credentials is not None and credentials_home is not None:
        _fail("configuration value is invalid")
    if credentials is not None and not isinstance(credentials, CredentialLookup):
        _fail("configuration value is invalid")
    bundle = load_credentials(home=credentials_home) if credentials is None else credentials
    metadata = _metadata_configuration_statuses(configuration, bundle)
    acquisition = _acquisition_configuration_statuses(
        configuration,
        bundle,
        configured_sci_hub_resolver=configured_sci_hub_resolver,
    )
    capabilities: list[ConfigurationCapabilityStatus] = []
    for provider, accepted in _CAPABILITY_MATRIX.items():
        for capability in accepted:
            if capability is ProviderCapability.METADATA:
                capabilities.append(metadata[provider])
            else:
                capabilities.append(acquisition[provider])
    return ConfigurationStatus(
        configuration_fingerprint=_configuration_fingerprint(configuration),
        capabilities=tuple(capabilities),
    )


def _core_credential_presence(
    credentials: CredentialLookup,
    service: CoreCredentialService,
    secret_field: str,
    base_url: str | None,
) -> tuple[bool, bool]:
    del secret_field
    present = credentials.has_core_service(service)
    if base_url is None:
        return present, False
    try:
        expected_origin = _service_origin(base_url)
    except ConfigurationError:
        return present, False
    return present, credentials.core_secret_for_origin(service, expected_origin) is not None


def configuration_runtime_status(
    configuration: Configuration,
    *,
    credentials: CredentialLookup | None = None,
    credentials_home: str | Path | None = None,
) -> ConfigurationRuntimeStatus:
    """Report local Storage, MinerU, and Analysis configuration completeness.

    This is a presence-only diagnostic.  It does not bind Storage, contact a
    Parser or LLM service, or retain an environment value.
    """

    if not isinstance(configuration, Configuration):
        _fail("configuration value is invalid")
    if credentials is not None and credentials_home is not None:
        _fail("configuration value is invalid")
    if credentials is not None and not isinstance(credentials, CredentialLookup):
        _fail("configuration value is invalid")
    storage_missing = tuple(
        name
        for name, value in (
            ("catalog_path", configuration.paths.catalog_path),
            ("artifact_root", configuration.paths.artifact_root),
        )
        if value is None
    )

    parser = configuration.parsing
    analysis = configuration.analysis
    bearer_required = parser.connection_mode is ParserConnectionMode.REMOTE
    api_key_required = analysis.authentication is AnalysisAuthentication.API_KEY
    bundle = (
        load_credentials(home=credentials_home)
        if credentials is None and (bearer_required or api_key_required)
        else credentials
    )
    parsing_missing = [
        name
        for name, value in (
            ("base_url", parser.base_url),
            ("connection_mode", parser.connection_mode),
            ("model_identity", parser.model_identity),
        )
        if value is None
    ]
    if bearer_required and not parser.remote_upload_authorized:
        parsing_missing.append("remote_upload_authorized")
    if bearer_required:
        assert bundle is not None
        parser_token_present, parser_origin_matches = _core_credential_presence(
            bundle,
            CoreCredentialService.MINERU,
            _CORE_CREDENTIAL_SPECS[CoreCredentialService.MINERU].secret_field,
            parser.base_url,
        )
    else:
        parser_token_present, parser_origin_matches = False, False
    parsing_status = ParsingConfigurationStatus(
        configuration_complete=not parsing_missing,
        bearer_token_required=bearer_required,
        bearer_token_configured=(parser_token_present if bearer_required else None),
        credential_origin_matches=parser_origin_matches if bearer_required else None,
        missing_fields=tuple(parsing_missing),
    )

    reference_fields = (
        ("provider", analysis.provider),
        ("protocol", analysis.protocol),
        ("base_url", analysis.base_url),
        ("model", analysis.model),
        ("context_window_tokens", analysis.context_window_tokens),
        ("authentication", analysis.authentication),
        ("reference_max_output_tokens", analysis.reference_max_output_tokens),
    )
    content_fields = (
        ("provider", analysis.provider),
        ("protocol", analysis.protocol),
        ("base_url", analysis.base_url),
        ("model", analysis.model),
        ("context_window_tokens", analysis.context_window_tokens),
        ("authentication", analysis.authentication),
        ("metadata_max_output_tokens", analysis.metadata_max_output_tokens),
        ("content_max_output_tokens", analysis.content_max_output_tokens),
        ("reference_max_output_tokens", analysis.reference_max_output_tokens),
        ("max_input_bytes", analysis.max_input_bytes),
        ("max_chunk_bytes", analysis.max_chunk_bytes),
        ("max_chunk_count", analysis.max_chunk_count),
        ("max_total_llm_requests", analysis.max_total_llm_requests),
        ("max_total_output_tokens", analysis.max_total_output_tokens),
    )
    reference_missing = tuple(name for name, value in reference_fields if value is None)
    content_missing = tuple(name for name, value in content_fields if value is None)
    if api_key_required:
        assert bundle is not None
        api_key_present, analysis_origin_matches = _core_credential_presence(
            bundle,
            CoreCredentialService.LLM,
            _CORE_CREDENTIAL_SPECS[CoreCredentialService.LLM].secret_field,
            analysis.base_url,
        )
    else:
        api_key_present, analysis_origin_matches = False, False
    analysis_status = AnalysisConfigurationStatus(
        api_key_required=api_key_required,
        api_key_configured=api_key_present if api_key_required else None,
        credential_origin_matches=analysis_origin_matches if api_key_required else None,
        reference_configuration_complete=not reference_missing,
        content_configuration_complete=not content_missing,
        reference_missing_fields=reference_missing,
        content_missing_fields=content_missing,
    )
    return ConfigurationRuntimeStatus(
        storage_configuration_complete=not storage_missing,
        storage_missing_fields=storage_missing,
        parsing=parsing_status,
        analysis=analysis_status,
    )


@runtime_checkable
class ConfigurationProbePort(Protocol):
    """Explicit Provider probe seam; implementations own all Network details."""

    @property
    def supported_capabilities(
        self,
    ) -> frozenset[tuple[ProviderName, ProviderCapability]]: ...

    def probe(
        self,
        provider: ProviderName,
        capability: ProviderCapability,
    ) -> ConfigurationProbeResult: ...


def _skipped_probe(status: ConfigurationCapabilityStatus) -> ConfigurationProbeResult:
    return ConfigurationProbeResult(
        provider=status.provider,
        capability=status.capability,
        outcome=ProbeOutcome.SKIPPED,
        local_ready=False,
        failure_code=status.failure_code or "local-readiness-failed",
    )


def _failed_probe(status: ConfigurationCapabilityStatus) -> ConfigurationProbeResult:
    return ConfigurationProbeResult(
        provider=status.provider,
        capability=status.capability,
        outcome=ProbeOutcome.FAILED,
        local_ready=True,
        network_reachable=False,
        failure_code="probe-failed",
    )


def _checked_probe_result(
    status: ConfigurationCapabilityStatus,
    result: object,
) -> ConfigurationProbeResult:
    if not isinstance(result, ConfigurationProbeResult):
        return _failed_probe(status)
    try:
        checked = ConfigurationProbeResult.model_validate(result.model_dump(mode="python"))
    except Exception:
        return _failed_probe(status)
    if (
        checked.provider is not status.provider
        or checked.capability is not status.capability
        or not checked.local_ready
        or checked.outcome is ProbeOutcome.SKIPPED
    ):
        return _failed_probe(status)
    return checked


def _validated_status_snapshot(
    configuration: Configuration,
    snapshot: ConfigurationStatus,
) -> ConfigurationStatus:
    """Revalidate one complete snapshot and bind enablement to configuration."""

    try:
        checked = ConfigurationStatus.model_validate(snapshot.model_dump(mode="python"))
    except Exception:
        _fail("configuration value is invalid")
    if checked.configuration_fingerprint != _configuration_fingerprint(configuration):
        _fail("configuration value is invalid")
    metadata_enabled = frozenset(configuration.sources.metadata.providers)
    acquisition_enabled = frozenset(configuration.sources.acquisition.providers)
    for status in checked.capabilities:
        enabled = (
            status.provider in metadata_enabled
            if status.capability is ProviderCapability.METADATA
            else status.provider in acquisition_enabled
        )
        probe_available = status.capability is ProviderCapability.METADATA
        if status.enabled is not enabled or status.probe_available is not probe_available:
            _fail("configuration value is invalid")
    return checked


def run_configuration_probes(
    configuration: Configuration,
    probe_port: ConfigurationProbePort,
    *,
    provider: ProviderName | str | None = None,
    test_all: bool = False,
    credentials_home: str | Path | None = None,
    configured_sci_hub_resolver: object | None = None,
    status_snapshot: ConfigurationStatus | None = None,
) -> ConfigurationProbeSummary:
    """Run an ordered, non-persistent explicit probe selection.

    A named Provider is tested even when disabled.  ``test_all`` considers
    only enabled production capabilities.  Local failures are represented as
    skipped results and one failed probe never short-circuits later entries.
    """

    if not isinstance(probe_port, ConfigurationProbePort):
        raise TypeError("probe_port must implement ConfigurationProbePort")
    if type(test_all) is not bool or (provider is None) == (not test_all):
        _fail("configuration value is invalid")
    selected_provider = None if provider is None else _provider_name(provider)
    supported = probe_port.supported_capabilities
    if not isinstance(supported, frozenset) or any(
        not isinstance(item, tuple)
        or len(item) != 2
        or not isinstance(item[0], ProviderName)
        or not isinstance(item[1], ProviderCapability)
        for item in supported
    ):
        raise TypeError("probe_port supported_capabilities is invalid")
    if status_snapshot is not None and (
        credentials_home is not None or configured_sci_hub_resolver is not None
    ):
        _fail("configuration value is invalid")
    if status_snapshot is not None and not isinstance(status_snapshot, ConfigurationStatus):
        _fail("configuration value is invalid")
    local = (
        configuration_status(
            configuration,
            credentials_home=credentials_home,
            configured_sci_hub_resolver=configured_sci_hub_resolver,
        )
        if status_snapshot is None
        else _validated_status_snapshot(configuration, status_snapshot)
    )
    selected = tuple(
        status
        for status in local.capabilities
        if status.probe_available
        and (status.provider, status.capability) in supported
        and (
            (test_all and status.enabled)
            or (selected_provider is not None and status.provider is selected_provider)
        )
    )
    results: list[ConfigurationProbeResult] = []
    for status in selected:
        if not status.local_ready:
            results.append(_skipped_probe(status))
            continue
        try:
            raw = probe_port.probe(status.provider, status.capability)
        except Exception:
            results.append(_failed_probe(status))
        else:
            results.append(_checked_probe_result(status, raw))
    return ConfigurationProbeSummary(results=tuple(results))


@runtime_checkable
class BrowserConfigurationProbePort(Protocol):
    """Explicit single-target Browser probe seam.

    Implementations own the approved minimal target and must execute the
    article flow through the process-shared Browser group scheduler.
    """

    @property
    def supported_access_keys(self) -> frozenset[str]: ...

    def probe(self, access_key: str) -> BrowserConfigurationProbeResult: ...


def _skipped_browser_probe(
    access_key: str,
    failure_code: str,
) -> BrowserConfigurationProbeResult:
    return BrowserConfigurationProbeResult(
        access_key=access_key,
        outcome=ProbeOutcome.SKIPPED,
        local_ready=False,
        failure_code=failure_code,
    )


def _failed_browser_probe(access_key: str) -> BrowserConfigurationProbeResult:
    return BrowserConfigurationProbeResult(
        access_key=access_key,
        outcome=ProbeOutcome.FAILED,
        local_ready=True,
        browser_launched=False,
        failure_code="browser-probe-failed",
    )


def _validated_browser_access_snapshot(snapshot: BrowserAccessStatus) -> BrowserAccessStatus:
    try:
        return BrowserAccessStatus.model_validate(snapshot.model_dump(mode="python"))
    except Exception:
        _fail("configuration value is invalid")


def _browser_probe_precondition(
    access_key: str,
    status: BrowserAccessStatus,
) -> str | None:
    if access_key not in {route.access_key for route in status.routes}:
        return "browser-production-route-unavailable"
    if not status.runtime.framework_available or not status.runtime.python_dependency_available:
        return "browser-runtime-unavailable"
    if not status.runtime.chromium_executable_available:
        return "browser-chromium-unavailable"
    if not status.runtime.headed_display_available:
        return "browser-headed-display-unavailable"
    if not status.enabled:
        return "browser-disabled"
    if status.profile.selected is None:
        return "browser-profile-not-selected"
    if status.profile.presence is BrowserProfilePresence.MISSING:
        return "browser-profile-missing"
    if status.profile.presence is BrowserProfilePresence.ATTENTION:
        return "browser-profile-attention"
    if access_key not in status.probe.supported_access_keys:
        return "browser-probe-unavailable"
    return None


def _checked_browser_probe_result(
    access_key: str,
    result: object,
) -> BrowserConfigurationProbeResult:
    if not isinstance(result, BrowserConfigurationProbeResult):
        return _failed_browser_probe(access_key)
    try:
        checked = BrowserConfigurationProbeResult.model_validate(result.model_dump(mode="python"))
    except Exception:
        return _failed_browser_probe(access_key)
    if (
        checked.access_key != access_key
        or not checked.local_ready
        or checked.outcome is ProbeOutcome.SKIPPED
    ):
        return _failed_browser_probe(access_key)
    return checked


def run_browser_configuration_probe(
    access_key: str,
    probe_port: BrowserConfigurationProbePort,
    *,
    status_snapshot: BrowserAccessStatus,
) -> BrowserConfigurationProbeResult:
    """Run one explicitly named approved target without persisting its result."""

    try:
        normalized_key = normalize_browser_access_key(access_key)
    except (TypeError, ValueError):
        _fail("configuration value is invalid")
    if not isinstance(probe_port, BrowserConfigurationProbePort):
        raise TypeError("probe_port must implement BrowserConfigurationProbePort")
    if not isinstance(status_snapshot, BrowserAccessStatus):
        _fail("configuration value is invalid")
    status = _validated_browser_access_snapshot(status_snapshot)
    supported = probe_port.supported_access_keys
    if not isinstance(supported, frozenset) or any(type(key) is not str for key in supported):
        raise TypeError("probe_port supported_access_keys is invalid")
    try:
        checked_supported = frozenset(normalize_browser_access_key(key) for key in supported)
    except (TypeError, ValueError):
        raise TypeError("probe_port supported_access_keys is invalid") from None
    if checked_supported != frozenset(status.probe.supported_access_keys):
        _fail("configuration value is invalid")
    failure_code = _browser_probe_precondition(normalized_key, status)
    if failure_code is not None:
        return _skipped_browser_probe(normalized_key, failure_code)
    try:
        raw = probe_port.probe(normalized_key)
    except Exception:
        return _failed_browser_probe(normalized_key)
    return _checked_browser_probe_result(normalized_key, raw)
