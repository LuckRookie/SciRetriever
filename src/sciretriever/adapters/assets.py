from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.content.ports import (
    AssetCandidate,
    BoundedByteStream,
    BoundedTransportPort,
    ContentTarget,
    Header,
    TransportRequest,
)
from sciretriever.model.primitives import AssetRole


@dataclass(frozen=True, slots=True)
class ResolverCandidate:
    locator: str
    role: AssetRole
    headers: tuple[Header, ...] = ()


class ResolverClient(Protocol):
    def resolve(self, target: ContentTarget) -> tuple[ResolverCandidate, ...]: ...


class AssetResolverAdapter:
    def __init__(self, provider: str, client: ResolverClient) -> None:
        self._provider = provider
        self._client = client

    def resolve(self, target: ContentTarget) -> tuple[AssetCandidate, ...]:
        candidates = self._client.resolve(target)
        seen: set[tuple[str, AssetRole]] = set()
        results: list[AssetCandidate] = []
        for candidate in candidates:
            identity = (candidate.locator, candidate.role)
            if identity in seen:
                continue
            seen.add(identity)
            results.append(
                AssetCandidate(
                    self._provider,
                    candidate.role,
                    candidate.locator,
                    candidate.headers,
                )
            )
        return tuple(results)


class AssetFetcherAdapter:
    def __init__(
        self,
        transport: BoundedTransportPort,
        *,
        timeout_seconds: int,
        max_response_bytes: int,
    ) -> None:
        self._transport = transport
        self._timeout = timeout_seconds
        self._max_bytes = max_response_bytes

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        response = self._transport.execute(
            TransportRequest(
                "GET",
                candidate.locator,
                candidate.headers,
                None,
                self._timeout,
                self._max_bytes,
            )
        )
        media_type = next(
            (header.value for header in response.headers if header.name.lower() == "content-type"),
            "application/octet-stream",
        )
        return BoundedByteStream(
            (response.body,),
            media_type,
            response.final_url,
            len(response.body),
        )


__all__ = (
    "AssetFetcherAdapter",
    "AssetResolverAdapter",
    "ResolverCandidate",
    "ResolverClient",
)
