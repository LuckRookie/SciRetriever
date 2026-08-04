from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from pydantic import ValidationError

import sciretriever.model.assets as asset_models
from sciretriever.model.access import (
    BoundedByteStream,
    Header,
    TransportRequest,
    TransportResponse,
)
from sciretriever.model.primitives import AssetRole


class BoundedTransportPort(Protocol):
    def execute(self, request: TransportRequest) -> TransportResponse: ...


@dataclass(frozen=True, slots=True)
class ResolverCandidate:
    locator: str
    role: AssetRole
    headers: tuple[Header, ...] = ()


class ResolverClient(Protocol):
    def resolve(self, target: asset_models.ContentTarget) -> tuple[ResolverCandidate, ...]: ...


@dataclass(frozen=True, slots=True)
class _InvalidResolverResponse(OSError):
    provider: str

    def __str__(self) -> str:
        return f"{self.provider} resolver returned an invalid candidate"


@dataclass(frozen=True, slots=True)
class _UnsuccessfulAssetResponse(OSError):
    status: int

    def __str__(self) -> str:
        return f"asset transport returned HTTP status {self.status}"


class AssetResolverAdapter:
    def __init__(self, provider: str, client: ResolverClient) -> None:
        self._provider = provider
        self._client = client

    @property
    def identity(self) -> str:
        return self._provider

    def resolve(
        self, target: asset_models.ContentTarget
    ) -> tuple[asset_models.AssetCandidate, ...]:
        candidates = self._client.resolve(target)
        seen: set[tuple[str, AssetRole]] = set()
        results: list[asset_models.AssetCandidate] = []
        for candidate in candidates:
            try:
                parsed = asset_models.AssetCandidate(
                    provider=self._provider,
                    role=candidate.role,
                    locator=candidate.locator,
                    headers=candidate.headers,
                )
            except ValidationError as error:
                raise _InvalidResolverResponse(self._provider) from error
            identity = (parsed.locator, parsed.role)
            if identity in seen:
                continue
            seen.add(identity)
            results.append(parsed)
        return tuple(results)


class AssetFetcherAdapter:
    def __init__(
        self,
        transport: BoundedTransportPort,
        *,
        timeout_seconds: float,
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
        if not 200 <= response.status < 300:
            raise _UnsuccessfulAssetResponse(response.status)
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
    "BoundedTransportPort",
    "ResolverCandidate",
    "ResolverClient",
)
