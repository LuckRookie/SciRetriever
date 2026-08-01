from __future__ import annotations

from sciretriever.adapters.registry import Capability, ProviderRegistry
from sciretriever.collection.ports import (
    CitationDiscoveryRequest,
    MetadataDiscoveryRequest,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)
from sciretriever.kernel.errors import Action, FailureEvidence, Reason


def _failure(provider: str, retryable: bool) -> FailureEvidence:
    action = (
        "Retry the provider request."
        if retryable
        else "Check the provider response or configuration."
    )
    return FailureEvidence(
        "provider-unavailable" if retryable else "provider-invalid-response",
        Reason(f"{provider} provider request failed"),
        Action(action),
        retryable,
    )


def collect_metadata(
    registry: ProviderRegistry,
    providers: tuple[str, ...],
    request: MetadataDiscoveryRequest,
) -> tuple[ProviderDiscoveryResult, ...]:
    registry.require(Capability.METADATA, providers)
    results: list[ProviderDiscoveryResult] = []
    for name in providers:
        try:
            result = registry.metadata(name).search(request)
        except (OSError, TimeoutError):
            result = ProviderDiscoveryResult(name, (), _failure(name, True))
        except (TypeError, ValueError):
            result = ProviderDiscoveryResult(name, (), _failure(name, False))
        if result.provider != name or any(
            observation.provider != name for observation in result.observations
        ):
            result = ProviderDiscoveryResult(name, (), _failure(name, False))
        results.append(result)
    return tuple(results)


def collect_citations(
    registry: ProviderRegistry,
    providers: tuple[str, ...],
    request: CitationDiscoveryRequest,
) -> tuple[ProviderCitationResult, ...]:
    registry.require(Capability.CITATION, providers)
    results: list[ProviderCitationResult] = []
    for name in providers:
        try:
            result = registry.citation(name).expand(request)
        except (OSError, TimeoutError):
            result = ProviderCitationResult(name, (), _failure(name, True))
        except (TypeError, ValueError):
            result = ProviderCitationResult(name, (), _failure(name, False))
        if result.provider != name or any(
            observation.provider != name for observation in result.observations
        ):
            result = ProviderCitationResult(name, (), _failure(name, False))
        results.append(result)
    return tuple(results)


__all__ = ("collect_citations", "collect_metadata")
