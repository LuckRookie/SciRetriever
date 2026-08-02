from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.literature import Identifier
from sciretriever.model.sources import CitationObservation, MetadataObservation
from sciretriever.services.collection.ports import (
    CitationDiscoveryRequest,
    MetadataDiscoveryRequest,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)


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
        code="provider-unavailable" if retryable else "provider-invalid-response",
        reason=Reason(value=f"{provider} provider request failed"),
        action=Action(value="Retry the request." if retryable else "Check provider configuration."),
        retryable=retryable,
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
                    provider=self._provider,
                    provider_record_id=record.record_id,
                    title=record.title,
                    authors=record.authors,
                    publication_year=record.publication_year,
                    identifiers=tuple(
                        Identifier(namespace=namespace, value=value)
                        for namespace, value in record.identifiers
                    ),
                    abstract=record.abstract,
                )
                for record in records
            )
            return ProviderDiscoveryResult(
                provider=self._provider, observations=observations, failure=None
            )
        except (OSError, TimeoutError):
            return ProviderDiscoveryResult(
                provider=self._provider,
                observations=(),
                failure=_failure(self._provider, True),
            )
        except (TypeError, ValueError):
            return ProviderDiscoveryResult(
                provider=self._provider,
                observations=(),
                failure=_failure(self._provider, False),
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
    "MetadataClient",
    "MetadataProviderAdapter",
    "VendorCitationRecord",
    "VendorMetadataRecord",
)
