from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import sciretriever.model.assets as asset_models
from sciretriever.content.ports import BoundedTransportPort
from sciretriever.model.access import BoundedByteStream, Header, TransportRequest
from sciretriever.model.primitives import AssetRole


@dataclass(frozen=True, slots=True)
class ResolverCandidate:
    locator: str
    role: AssetRole
    headers: tuple[Header, ...] = ()


class ResolverClient(Protocol):
    def resolve(self, target: asset_models.ContentTarget) -> tuple[ResolverCandidate, ...]: ...


class AssetResolverAdapter:
    def __init__(self, provider: str, client: ResolverClient) -> None:
        self._provider = provider
        self._client = client

    def resolve(
        self, target: asset_models.ContentTarget
    ) -> tuple[asset_models.AssetCandidate, ...]:
        candidates = self._client.resolve(target)
        seen: set[tuple[str, AssetRole]] = set()
        results: list[asset_models.AssetCandidate] = []
        for candidate in candidates:
            identity = (candidate.locator, candidate.role)
            if identity in seen:
                continue
            seen.add(identity)
            results.append(
                asset_models.AssetCandidate(
                    provider=self._provider,
                    role=candidate.role,
                    locator=candidate.locator,
                    headers=candidate.headers,
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

    def fetch(self, candidate: asset_models.AssetCandidate) -> BoundedByteStream:
        response = self._transport.execute(
            TransportRequest(
                method="GET",
                url=candidate.locator,
                headers=candidate.headers,
                body=None,
                timeout_seconds=self._timeout,
                max_response_bytes=self._max_bytes,
            )
        )
        media_type = next(
            (header.value for header in response.headers if header.name.lower() == "content-type"),
            "application/octet-stream",
        )
        return BoundedByteStream(
            chunks=(response.body,),
            media_type=media_type,
            final_locator=response.final_url,
            size=len(response.body),
        )


__all__ = (
    "AssetFetcherAdapter",
    "AssetResolverAdapter",
    "ResolverCandidate",
    "ResolverClient",
)
