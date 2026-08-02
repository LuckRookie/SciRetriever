from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar

import sciretriever.model.assets as asset_models
from sciretriever.model.access import BoundedByteStream


class AssetResolverPort(Protocol):
    @property
    def identity(self) -> str: ...

    def resolve(
        self, target: asset_models.ContentTarget
    ) -> tuple[asset_models.AssetCandidate, ...]: ...


class AssetFetcherPort(Protocol):
    def fetch(self, candidate: asset_models.AssetCandidate) -> BoundedByteStream: ...


class RaceCancellation(Protocol):
    @property
    def deadline(self) -> float: ...

    @property
    def cancelled(self) -> bool: ...


class CancellableAssetFetcherPort(Protocol):
    def fetch_cancellable(
        self,
        candidate: asset_models.AssetCandidate,
        token: RaceCancellation,
    ) -> BoundedByteStream: ...


class ArtifactStorePort(Protocol):
    def publish(self, artifact: asset_models.StagedArtifact) -> asset_models.PublishedArtifact: ...


class AssetAcceptancePublisher(Protocol):
    def publish(
        self,
        acceptance: asset_models.PrimaryPdfAcceptance | asset_models.SupplementaryAssetAcceptance,
    ) -> asset_models.AssetPublication: ...


class CandidateRaceExhausted(Exception):
    def __str__(self) -> str:
        return "all asset candidates were exhausted"


@dataclass(frozen=True, slots=True)
class InvalidRaceDeadline(Exception):
    deadline_seconds: float

    def __str__(self) -> str:
        return "candidate race deadline must be positive"


ResultT = TypeVar("ResultT")
ResultT_co = TypeVar("ResultT_co", covariant=True)


class RaceCallable(Protocol[ResultT_co]):
    def __call__(self, token: RaceCancellation) -> Awaitable[ResultT_co]: ...


class CandidateRacePort(Protocol, Generic[ResultT]):
    async def run(
        self,
        candidates: tuple[tuple[str, RaceCallable[ResultT]], ...],
        publish: Callable[[ResultT], None],
    ) -> ResultT: ...


__all__ = (
    "ArtifactStorePort",
    "AssetAcceptancePublisher",
    "AssetFetcherPort",
    "AssetResolverPort",
    "CandidateRaceExhausted",
    "CandidateRacePort",
    "CancellableAssetFetcherPort",
    "InvalidRaceDeadline",
    "RaceCallable",
    "RaceCancellation",
)
