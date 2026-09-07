"""Pure setup and resolution policy for model Providers and models.

The CLI owns questions and presentation. This module owns the two small
registries, task selection, Analyze business defaults, and resolution of one
``provider/model`` reference for Bootstrap.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import ValidationError

from sciretriever.model.configuration import (
    AgentProtocol,
    AgentReasoningEffort,
    AnalysisConfig,
    BrowserConfig,
    Configuration,
    ModelConfig,
    ModelProviderConfig,
    ModelProvidersConfig,
    ModelsConfig,
)

AnalysisLimitsDisposition = Literal["created", "preserved", "reset"]


@dataclass(frozen=True, slots=True)
class ModelRegistryUpdate:
    """Validated Provider and model registries produced by one edit."""

    providers: ModelProvidersConfig
    models: ModelsConfig


@dataclass(frozen=True, slots=True)
class AnalysisModelSelection:
    """Validated Analyze selection and its business-limit disposition."""

    analysis: AnalysisConfig
    analysis_limits: AnalysisLimitsDisposition


def build_model_provider_configuration(
    *,
    name: str,
    api: AgentProtocol,
    base_url: str,
) -> ModelProviderConfig:
    """Build one complete, secret-free model Provider."""

    return ModelProviderConfig(name=name, api=api, base_url=base_url)


def build_model_configuration(
    *,
    provider: str,
    model: str,
    reasoning: AgentReasoningEffort,
    image: bool,
    stream: bool = True,
) -> ModelConfig:
    """Build one configured model without a local alias or preset."""

    return ModelConfig(
        reference=f"{provider}/{model}",
        reasoning=reasoning,
        image=image,
        stream=stream,
    )


def upsert_model(
    current: Configuration,
    *,
    provider: ModelProviderConfig,
    model: ModelConfig,
) -> ModelRegistryUpdate:
    """Add or replace one Provider and one model as a coherent registry edit."""

    if not isinstance(current, Configuration):
        raise TypeError("current must be a Configuration")
    if not isinstance(provider, ModelProviderConfig) or not isinstance(model, ModelConfig):
        raise TypeError("model provider and model are invalid")
    if model.provider != provider.name:
        raise ValueError("model and provider are inconsistent")
    providers = ModelProvidersConfig(
        values=tuple(item for item in current.providers.values if item.name != provider.name)
        + (provider,)
    )
    models = ModelsConfig(
        values=tuple(item for item in current.models.values if item.reference != model.reference)
        + (model,)
    )
    payload = current.model_dump(mode="python")
    payload.update({"providers": providers, "models": models})
    Configuration.model_validate(payload)
    return ModelRegistryUpdate(providers=providers, models=models)


def upsert_model_provider(
    current: Configuration,
    *,
    provider: ModelProviderConfig,
) -> ModelProvidersConfig:
    """Add or replace one Provider while revalidating referring models."""

    if not isinstance(current, Configuration):
        raise TypeError("current must be a Configuration")
    if not isinstance(provider, ModelProviderConfig):
        raise TypeError("model provider is invalid")
    providers = ModelProvidersConfig(
        values=tuple(item for item in current.providers.values if item.name != provider.name)
        + (provider,)
    )
    payload = current.model_dump(mode="python")
    payload["providers"] = providers
    Configuration.model_validate(payload)
    return providers


def remove_model(current: Configuration, *, reference: str) -> ModelsConfig:
    """Remove one model after every module has stopped selecting it."""

    if not isinstance(current, Configuration):
        raise TypeError("current must be a Configuration")
    if reference in {current.analysis.model, current.browser.model}:
        raise ValueError("model is still selected by a module")
    values = tuple(item for item in current.models.values if item.reference != reference)
    if len(values) == len(current.models.values):
        raise ValueError("model does not exist")
    return ModelsConfig(values=values)


def remove_model_provider(
    current: Configuration,
    *,
    name: str,
) -> ModelProvidersConfig:
    """Remove one Provider only when no configured model references it."""

    if not isinstance(current, Configuration):
        raise TypeError("current must be a Configuration")
    if any(item.provider == name for item in current.models.values):
        raise ValueError("model provider is still used by a model")
    values = tuple(item for item in current.providers.values if item.name != name)
    if len(values) == len(current.providers.values):
        raise ValueError("model provider does not exist")
    return ModelProvidersConfig(values=values)


def select_analysis_model(
    current: Configuration,
    *,
    reference: str,
) -> AnalysisModelSelection:
    """Select one model and preserve or create Analyze business limits."""

    if not isinstance(current, Configuration):
        raise TypeError("current must be a Configuration")
    model = current.models.get(reference)
    if model is None:
        raise ValueError("Analyze requires a configured model")
    existing = current.analysis
    selected_existing = existing.model_copy(update={"model": model.reference})
    if _analysis_limits_complete(existing):
        try:
            _validated_configuration(current, analysis=selected_existing)
        except (TypeError, ValueError, ValidationError):
            pass
        else:
            return AnalysisModelSelection(
                analysis=selected_existing,
                analysis_limits="preserved",
            )
    defaults = _default_analysis_limits().model_copy(update={"model": model.reference})
    _validated_configuration(current, analysis=defaults)
    empty_before = all(
        value is None
        for field, value in existing.model_dump(mode="python").items()
        if field != "model"
    )
    return AnalysisModelSelection(
        analysis=defaults,
        analysis_limits="created" if empty_before else "reset",
    )


def select_browser_model(current: Configuration, *, reference: str) -> BrowserConfig:
    """Select one image-capable model without changing Analyze."""

    if not isinstance(current, Configuration):
        raise TypeError("current must be a Configuration")
    model = current.models.get(reference)
    if model is None or not model.image:
        raise ValueError("Browser requires a configured image model")
    selected = current.browser.model_copy(update={"model": model.reference})
    payload = current.model_dump(mode="python")
    payload["browser"] = selected
    Configuration.model_validate(payload)
    return selected


def resolve_task_model(
    configuration: Configuration,
    *,
    task: Literal["analyze", "browser"],
) -> tuple[ModelProviderConfig, ModelConfig]:
    """Resolve one module selection to its Provider and configured model."""

    if not isinstance(configuration, Configuration):
        raise TypeError("configuration must be a Configuration")
    reference = configuration.analysis.model if task == "analyze" else configuration.browser.model
    model = configuration.models.get(reference)
    if model is None:
        raise ValueError(f"{task} model is not configured")
    provider = configuration.providers.get(model.provider)
    if provider is None:
        raise ValueError("configured model provider is unavailable")
    return provider, model


def _analysis_limits_complete(value: AnalysisConfig) -> bool:
    return all(
        item is not None
        for field, item in value.model_dump(mode="python").items()
        if field != "model"
    )


def _default_analysis_limits() -> AnalysisConfig:
    """Return product-owned defaults independent of Provider model metadata."""

    return AnalysisConfig(
        metadata_max_output_tokens=2_048,
        content_max_output_tokens=8_192,
        reference_max_output_tokens=2_048,
        max_input_bytes=4_194_304,
        max_chunk_bytes=1_048_576,
        max_chunk_count=4,
        max_total_llm_requests=8,
        max_total_output_tokens=32_768,
    )


def _validated_configuration(
    current: Configuration,
    *,
    analysis: AnalysisConfig,
) -> Configuration:
    payload = current.model_dump(mode="python")
    payload["analysis"] = analysis
    return Configuration.model_validate(payload)


__all__ = (
    "AnalysisLimitsDisposition",
    "AnalysisModelSelection",
    "ModelRegistryUpdate",
    "build_model_configuration",
    "build_model_provider_configuration",
    "remove_model",
    "remove_model_provider",
    "resolve_task_model",
    "select_analysis_model",
    "select_browser_model",
    "upsert_model",
    "upsert_model_provider",
)
