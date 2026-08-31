"""Local, secret-opaque configuration status assembly and presentation."""

from __future__ import annotations

import argparse
import json
import sys
from typing import cast

from sciretriever.acquisition.api import (
    AUTHORIZED_PDF_API_PROVIDER_KEYS,
    BUILTIN_SCI_HUB_MIRROR_URLS,
    UNSUPPORTED_AUTHORIZED_PDF_API_PROVIDER_KEYS,
)
from sciretriever.bootstrap import PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS
from sciretriever.configuration import (
    ConfigurationError,
    CredentialLookup,
    browser_access_status,
    configuration_runtime_status,
    configuration_service_origin,
    configuration_status,
    load_credentials,
    load_editable_user_configuration,
    load_user_configuration,
)
from sciretriever.entry.cli.config_ui import ConfigStatusPresenter
from sciretriever.model.configuration import (
    BrowserAccessStatus,
    BrowserController,
    Configuration,
    ConfigurationCapabilityStatus,
    ConfigurationRuntimeStatus,
    CoreCredentialService,
    ModelConfig,
    ModelProviderConfig,
    ProviderCapability,
)

_PUBLIC_ACQUISITION_SERVICES: dict[str, tuple[str, str]] = {
    "arxiv": ("public-pdf-api", "public PDF API"),
    "europe-pmc": ("public-pdf-api", "public PDF API"),
    "unpaywall": ("oa-locator-api", "OA locator API"),
    "sci-hub": ("operator-locator", "operator locator"),
}
_UNSUPPORTED_AUTHORIZED_API_DETAILS = {
    "springer": "Full Text product returns JATS/XML, not primary PDF",
}


def ordinary_provider_settings(
    configuration: Configuration,
    provider: str,
) -> dict[str, object]:
    if provider == "web-of-science":
        settings = configuration.sources.metadata.web_of_science
        return (
            {}
            if settings is None
            else {
                "product": settings.product.value,
                "database": settings.database,
                "edition": settings.edition,
            }
        )
    if provider == "crossref":
        settings = configuration.sources.metadata.crossref
        return {} if settings is None else {"mode": settings.mode.value, "mailto": settings.mailto}
    if provider == "unpaywall":
        settings = configuration.sources.acquisition.unpaywall
        return {} if settings is None else {"contact_email": settings.contact_email}
    if provider == "sci-hub":
        settings = configuration.sources.acquisition.sci_hub
        return {
            "mode": "builtin" if settings is None else "custom",
            "urls": list(BUILTIN_SCI_HUB_MIRROR_URLS if settings is None else settings.urls),
        }
    return {}


def _missing_ordinary_fields(
    configuration: Configuration,
    status: ConfigurationCapabilityStatus,
) -> tuple[str, ...]:
    if status.ordinary_parameters_ready:
        return ()
    if status.provider.value == "web-of-science":
        return ("product", "database")
    if status.provider.value == "crossref":
        return ("mode",)
    if status.provider.value == "unpaywall":
        return ("contact_email",)
    if status.provider.value == "sci-hub":
        return ("urls",)
    del configuration
    return ("provider-specific settings",)


def _provider_payload(
    configuration: Configuration,
    status: ConfigurationCapabilityStatus,
) -> dict[str, object]:
    return {
        "provider": status.provider.value,
        "enabled": status.enabled,
        "production_available": status.production_available,
        "local_ready": status.local_ready,
        "failure_code": status.failure_code,
        "ordinary_settings": ordinary_provider_settings(configuration, status.provider.value),
        "missing_ordinary_fields": _missing_ordinary_fields(configuration, status),
        "credentials": {
            "status": status.credential.status.value,
            "fields": [
                {
                    "name": field.name,
                    "required": field.required,
                    "configured": field.present,
                }
                for field in status.credential.fields
            ],
        },
        "access_policy_ready": status.access_policy_ready,
        "probe_available": status.probe_available,
    }


def _acquisition_payload(
    configuration: Configuration,
    status: ConfigurationCapabilityStatus,
) -> dict[str, object]:
    payload = _provider_payload(configuration, status)
    provider = status.provider.value
    public_service = _PUBLIC_ACQUISITION_SERVICES.get(provider)
    public_service_payload: dict[str, object] | None = None
    if public_service is not None:
        kind, label = public_service
        missing = cast(tuple[str, ...], payload["missing_ordinary_fields"])
        local_ready = not missing
        public_service_payload = {
            "kind": kind,
            "label": label,
            "production_available": True,
            "local_ready": local_ready,
            "failure_code": None if local_ready else "missing-ordinary-parameter",
            "ordinary_settings": payload["ordinary_settings"],
            "missing_ordinary_fields": missing,
        }
    payload["public_source"] = {
        "saved_asset_hints_supported": True,
        "provider_service": public_service_payload,
    }
    payload["authorized_api"] = {
        "available": provider in AUTHORIZED_PDF_API_PROVIDER_KEYS,
        "unsupported": provider in UNSUPPORTED_AUTHORIZED_PDF_API_PROVIDER_KEYS,
        "detail": _UNSUPPORTED_AUTHORIZED_API_DETAILS.get(provider),
        "credentials": payload["credentials"],
    }
    return payload


def _model_payload(model: ModelConfig | None) -> dict[str, object] | None:
    if model is None:
        return None
    return {
        "reference": model.reference,
        "provider": model.provider,
        "model": model.model,
        "reasoning": model.reasoning.value,
        "image": model.image,
    }


def _model_provider_payload(
    provider: ModelProviderConfig,
    credentials: CredentialLookup | None,
) -> dict[str, object]:
    required = provider.requires_api_key
    configured: bool | None = None
    origin_matches: bool | None = None
    if required:
        configured = bool(credentials is not None and credentials.has_model_provider(provider.name))
        try:
            origin = configuration_service_origin(provider.base_url)
            origin_matches = bool(
                credentials is not None
                and credentials.model_secret_for_origin(provider.name, origin) is not None
            )
        except ConfigurationError:
            origin_matches = False
    return {
        "name": provider.name,
        "api": provider.api.value,
        "base_url": provider.base_url,
        "key": {
            "required": required,
            "configured": configured,
            "origin_matches": origin_matches,
        },
    }


def status_payload(
    configuration: Configuration,
    capabilities: tuple[ConfigurationCapabilityStatus, ...],
    runtime: ConfigurationRuntimeStatus,
    browser: BrowserAccessStatus,
    credentials: CredentialLookup | None = None,
) -> dict[str, object]:
    parser = configuration.parsing
    analysis = configuration.analysis
    analysis_model = configuration.models.get(analysis.model)
    browser_model = configuration.models.get(configuration.access.model)
    parser_secret_ready = not runtime.parsing.bearer_token_required or (
        runtime.parsing.bearer_token_configured is True
        and runtime.parsing.credential_origin_matches is True
    )
    parser_ready = runtime.parsing.configuration_complete and parser_secret_ready
    controlled_browser = {
        **browser.model_dump(mode="json"),
        "controller": configuration.access.browser_controller.value,
        "controller_ready": (
            configuration.access.browser_controller is BrowserController.RULES
            or runtime.agents.browser_locally_ready
        ),
        "controller_required_model": (
            None
            if configuration.access.browser_controller is BrowserController.RULES
            else configuration.access.model
        ),
        "article_entitlement_assessment": "not-evaluated",
        "article_entitlement_evaluated": False,
        "cloakbrowser_license": {
            "configured": bool(
                credentials is not None
                and credentials.has_core_service(CoreCredentialService.CLOAKBROWSER)
            ),
            "status": "reserved-not-used-by-pinned-free-binary",
        },
    }
    return {
        "storage": {
            "configuration_complete": runtime.storage_configuration_complete,
            "catalog_path": configuration.paths.catalog_path,
            "artifact_root": configuration.paths.artifact_root,
            "missing_fields": runtime.storage_missing_fields,
        },
        "providers": {
            "credentials_file": "~/.sciretriever/credentials.toml",
            "metadata_mode": configuration.sources.metadata.mode.value,
            "metadata_limit": configuration.sources.metadata.limit,
            "acquisition_mode": configuration.sources.acquisition.mode.value,
            "metadata": [
                _provider_payload(configuration, item)
                for item in capabilities
                if item.capability is ProviderCapability.METADATA
            ],
            "acquisition": [
                _acquisition_payload(configuration, item)
                for item in capabilities
                if item.capability is ProviderCapability.ACQUISITION
            ],
            "controlled_browser": controlled_browser,
        },
        "models": {
            "providers": [
                _model_provider_payload(provider, credentials)
                for provider in configuration.providers.values
            ],
            "models": [
                cast(dict[str, object], _model_payload(model))
                for model in configuration.models.values
            ],
        },
        "analyze": {
            "model": analysis.model,
            "selected_model": _model_payload(analysis_model),
            "reference_locally_ready": runtime.agents.analysis_reference_locally_ready,
            "content_locally_ready": runtime.agents.analysis_content_locally_ready,
            "reference_configuration_complete": (
                runtime.agents.analysis.reference_configuration_complete
            ),
            "content_configuration_complete": (
                runtime.agents.analysis.content_configuration_complete
            ),
            "reference_missing_fields": runtime.agents.analysis.reference_missing_fields,
            "content_missing_fields": runtime.agents.analysis.content_missing_fields,
            "limits": {
                "metadata_max_output_tokens": analysis.metadata_max_output_tokens,
                "content_max_output_tokens": analysis.content_max_output_tokens,
                "reference_max_output_tokens": analysis.reference_max_output_tokens,
                "max_input_bytes": analysis.max_input_bytes,
                "max_chunk_bytes": analysis.max_chunk_bytes,
                "max_chunk_count": analysis.max_chunk_count,
                "max_total_llm_requests": analysis.max_total_llm_requests,
                "max_total_output_tokens": analysis.max_total_output_tokens,
            },
        },
        "download": {
            "model": configuration.access.model,
            "selected_model": _model_payload(browser_model),
            "model_locally_ready": runtime.agents.browser_locally_ready,
            "model_missing_fields": runtime.agents.browser.missing_fields,
            "controller": configuration.access.browser_controller.value,
            "browser": controlled_browser,
        },
        "parsing": {
            "locally_ready": parser_ready,
            "configuration_complete": runtime.parsing.configuration_complete,
            "base_url": parser.base_url,
            "connection_mode": (
                None if parser.connection_mode is None else parser.connection_mode.value
            ),
            "model_identity": parser.model_identity,
            "remote_upload_authorized": parser.remote_upload_authorized,
            "implementation": {
                "release": "3.4.4",
                "api_protocol": 2,
                "profile": "vlm-engine",
                "archive_backend": "vlm",
                "parse_method": "auto",
            },
            "missing_fields": runtime.parsing.missing_fields,
            "bearer_token": {
                "source": "credentials.toml" if runtime.parsing.bearer_token_required else None,
                "required": runtime.parsing.bearer_token_required,
                "configured": runtime.parsing.bearer_token_configured,
                "origin_matches": runtime.parsing.credential_origin_matches,
            },
        },
        "execution": {"max_concurrency": configuration.execution.max_concurrency},
        "library": {"max_input_bytes": configuration.library.max_input_bytes},
    }


def show_local_status(theme: str) -> None:
    configuration = load_editable_user_configuration()
    credentials = load_credentials(home=None)
    capabilities = configuration_status(configuration, credentials=credentials).capabilities
    runtime = configuration_runtime_status(configuration, credentials=credentials)
    browser = browser_access_status(
        configuration,
        probe_supported_access_keys=PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS,
    )
    ConfigStatusPresenter(theme).status(
        status_payload(configuration, capabilities, runtime, browser, credentials)
    )


def run_status(arguments: argparse.Namespace) -> int:
    configuration = load_user_configuration()
    credentials = load_credentials(home=None)
    result = configuration_status(configuration, credentials=credentials)
    runtime = configuration_runtime_status(configuration, credentials=credentials)
    browser = browser_access_status(
        configuration,
        probe_supported_access_keys=PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS,
    )
    payload = status_payload(
        configuration,
        result.capabilities,
        runtime,
        browser,
        credentials,
    )
    if arguments.json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    else:
        ConfigStatusPresenter(arguments.theme).status(payload)
    return 0


__all__ = (
    "ordinary_provider_settings",
    "run_status",
    "show_local_status",
    "status_payload",
)
