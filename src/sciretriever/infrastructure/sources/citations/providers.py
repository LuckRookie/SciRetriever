from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.literature import Identifier
from sciretriever.model.sources import (
    CitationDiscoveryRequest,
    CitationObservation,
    ProviderCitationResult,
)


@dataclass(frozen=True, slots=True)
class VendorCitationRecord:
    namespace: str
    value: str


class CitationClient(Protocol):
    def expand(self, request: CitationDiscoveryRequest) -> tuple[VendorCitationRecord, ...]: ...


def _failure(provider: str, retryable: bool) -> FailureEvidence:
    return FailureEvidence(
        code="provider-unavailable" if retryable else "provider-invalid-response",
        reason=Reason(value=f"{provider} provider request failed"),
        action=Action(value="Retry the request." if retryable else "Check provider configuration."),
        retryable=retryable,
    )


class CitationProviderAdapter:
    def __init__(self, provider: str, client: CitationClient) -> None:
        self._provider = provider
        self._client = client

    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult:
        try:
            records = self._client.expand(request)
            observations = tuple(
                CitationObservation(
                    provider=self._provider,
                    source_work_id=request.seed,
                    target_identifier=Identifier(namespace=record.namespace, value=record.value),
                    direction=request.direction,
                )
                for record in records
            )
            return ProviderCitationResult(
                provider=self._provider, observations=observations, failure=None
            )
        except (OSError, TimeoutError):
            return ProviderCitationResult(
                provider=self._provider,
                observations=(),
                failure=_failure(self._provider, True),
            )
        except (TypeError, ValueError):
            return ProviderCitationResult(
                provider=self._provider,
                observations=(),
                failure=_failure(self._provider, False),
            )


__all__ = (
    "CitationClient",
    "CitationProviderAdapter",
    "VendorCitationRecord",
)
