from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.collection.ports import (
    CitationDiscoveryRequest, CitationObservation, MetadataDiscoveryRequest,
    MetadataObservation, ProviderCitationResult, ProviderDiscoveryResult,
)
from sciretriever.kernel.contracts import Identifier
from sciretriever.kernel.errors import Action, FailureEvidence, Reason


@dataclass(frozen=True, slots=True)
class VendorMetadataRecord:
    record_id: str
    title: str
    authors: tuple[str, ...]
    publication_year: int | None
    identifiers: tuple[tuple[str, str], ...]
    abstract: str | None


@dataclass(frozen=True, slots=True)
class VendorCitationRecord:
    namespace: str
    value: str


class MetadataClient(Protocol):
    def search(self, request: MetadataDiscoveryRequest) -> tuple[VendorMetadataRecord, ...]: ...


class CitationClient(Protocol):
    def expand(self, request: CitationDiscoveryRequest) -> tuple[VendorCitationRecord, ...]: ...


def _failure(provider: str, retryable: bool) -> FailureEvidence:
    return FailureEvidence(
        "provider-unavailable" if retryable else "provider-invalid-response",
        Reason(f"{provider} provider request failed"),
        Action("Retry the request." if retryable else "Check provider configuration."),
        retryable,
    )


class MetadataProviderAdapter:
    def __init__(self, provider: str, client: MetadataClient) -> None:
        self._provider = provider
        self._client = client

    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult:
        try:
            records = self._client.search(request)
            observations = tuple(
                MetadataObservation(
                    self._provider, record.record_id, record.title, record.authors,
                    record.publication_year,
                    tuple(Identifier(namespace, value) for namespace, value in record.identifiers),
                    record.abstract,
                )
                for record in records
            )
            return ProviderDiscoveryResult(self._provider, observations, None)
        except (OSError, TimeoutError):
            return ProviderDiscoveryResult(self._provider, (), _failure(self._provider, True))
        except (TypeError, ValueError):
            return ProviderDiscoveryResult(self._provider, (), _failure(self._provider, False))


class CitationProviderAdapter:
    def __init__(self, provider: str, client: CitationClient) -> None:
        self._provider = provider
        self._client = client

    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult:
        try:
            records = self._client.expand(request)
            observations = tuple(
                CitationObservation(
                    self._provider, request.seed, Identifier(record.namespace, record.value),
                    request.direction,
                )
                for record in records
            )
            return ProviderCitationResult(self._provider, observations, None)
        except (OSError, TimeoutError):
            return ProviderCitationResult(self._provider, (), _failure(self._provider, True))
        except (TypeError, ValueError):
            return ProviderCitationResult(self._provider, (), _failure(self._provider, False))


__all__ = (
    "CitationClient", "CitationProviderAdapter", "MetadataClient",
    "MetadataProviderAdapter", "VendorCitationRecord", "VendorMetadataRecord",
)
