"""Strict, side-effect-free access to SciRetriever configuration."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from sciretriever.config_loader import MAX_CONFIG_BYTES, load_config
from sciretriever.config_models import (
    AcquisitionConfig,
    AnalysisConfig,
    BrowserConfig,
    BrowserRuleConfig,
    ConfigCheckMode,
    CredentialsConfig,
    DiscoveryConfig,
    ExpansionConfig,
    LLMConfig,
    MinerUConfig,
    PackageConfig,
    PathsConfig,
    PreflightConfig,
    SciHubConfig,
    SciRetrieverConfig,
    SearchConfig,
    TranslatorConfig,
    TranslatorRuleConfig,
)
from sciretriever.config_parsing.acquisition import ACQUISITION_PROVIDERS
from sciretriever.config_parsing.base import METADATA_PROVIDERS
from sciretriever.errors import ConfigError


STORAGE_ROOT_ENV = "SCIRETRIEVER_STORAGE_ROOT"
CONFIG_ENV = "SCIRETRIEVER_CONFIG"


def resolve_storage_root(
    explicit: str | os.PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> Path:
    """Resolve the configured storage root without touching the filesystem."""
    environ = os.environ if env is None else env
    configured = explicit if explicit is not None else environ.get(STORAGE_ROOT_ENV)
    if configured is None or not str(configured).strip():
        raise ConfigError(
            f"Storage root is required; pass it explicitly or set {STORAGE_ROOT_ENV}"
        )
    return Path(configured).expanduser().resolve(strict=False)


def get_credential(
    env_var: str,
    *,
    env: Mapping[str, str] | None = None,
) -> str | None:
    """Read and normalize one credential from an environment mapping."""
    if not isinstance(env_var, str) or not env_var.strip():
        raise ConfigError("Credential environment variable name must be nonblank")
    environ = os.environ if env is None else env
    value = environ.get(env_var)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


__all__ = (
    "ACQUISITION_PROVIDERS",
    "CONFIG_ENV",
    "MAX_CONFIG_BYTES",
    "METADATA_PROVIDERS",
    "STORAGE_ROOT_ENV",
    "AcquisitionConfig",
    "AnalysisConfig",
    "BrowserConfig",
    "BrowserRuleConfig",
    "ConfigCheckMode",
    "CredentialsConfig",
    "DiscoveryConfig",
    "ExpansionConfig",
    "LLMConfig",
    "MinerUConfig",
    "PackageConfig",
    "PathsConfig",
    "PreflightConfig",
    "SciHubConfig",
    "SciRetrieverConfig",
    "SearchConfig",
    "TranslatorConfig",
    "TranslatorRuleConfig",
    "get_credential",
    "load_config",
    "resolve_storage_root",
)
