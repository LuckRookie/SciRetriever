from __future__ import annotations

from sciretriever.adapters.registry import Capability, ProviderRegistry
from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.services.collection.ports import (
    CitationDiscoveryRequest,
    MetadataDiscoveryRequest,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)


def _failure(provider: str, retryable: bool) -> FailureEvidence:
    action = (
        "Retry the provider request."
        if retryable
        else "Check the provider response or configuration."
    )
    return FailureEvidence(
        code="provider-unavailable" if retryable else "provider-invalid-response",
        reason=Reason(value=f"{provider} provider request failed"),
        action=Action(value=action),
        retryable=retryable,
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
            result = ProviderDiscoveryResult(
                provider=name, observations=(), failure=_failure(name, True)
            )
        except (TypeError, ValueError):
            result = ProviderDiscoveryResult(
                provider=name, observations=(), failure=_failure(name, False)
            )
        if result.provider != name or any(
            observation.provider != name for observation in result.observations
        ):
            result = ProviderDiscoveryResult(
                provider=name, observations=(), failure=_failure(name, False)
            )
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
            result = ProviderCitationResult(
                provider=name, observations=(), failure=_failure(name, True)
            )
        except (TypeError, ValueError):
            result = ProviderCitationResult(
                provider=name, observations=(), failure=_failure(name, False)
            )
        if result.provider != name or any(
            observation.provider != name for observation in result.observations
        ):
            result = ProviderCitationResult(
                provider=name, observations=(), failure=_failure(name, False)
            )
        results.append(result)
    return tuple(results)


__all__ = ("collect_citations", "collect_metadata")
