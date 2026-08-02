from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar

import sciretriever.model.access as access_models
import sciretriever.model.assets as asset_models
import sciretriever.model.llm as llm_models
import sciretriever.model.parsing as parsing_models


class AssetResolverPort(Protocol):
    def resolve(
        self, target: asset_models.ContentTarget
    ) -> tuple[asset_models.AssetCandidate, ...]: ...


class AssetFetcherPort(Protocol):
    def fetch(self, candidate: asset_models.AssetCandidate) -> access_models.BoundedByteStream: ...


class CandidateRaceExhausted(Exception):
    def __str__(self) -> str:
        return "all asset candidates were exhausted"


@dataclass(frozen=True, slots=True)
class InvalidRaceDeadline(Exception):
    deadline_seconds: float

    def __str__(self) -> str:
        return "candidate race deadline must be positive"


class RaceToken:
    def __init__(self, deadline: float) -> None:
        self.deadline = deadline
        self._winner: str | None = None
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def claim(self, identity: str) -> bool:
        if self._winner is not None or self._cancelled:
            return False
        self._winner = identity
        return True

    def is_current(self, identity: str) -> bool:
        return self._winner == identity and not self._cancelled

    def cancel(self) -> None:
        self._cancelled = True


class CancellableAssetFetcherPort(Protocol):
    def fetch_cancellable(
        self,
        candidate: asset_models.AssetCandidate,
        token: RaceToken,
    ) -> access_models.BoundedByteStream: ...


ResultT = TypeVar("ResultT")
ResultT_co = TypeVar("ResultT_co", covariant=True)


class RaceCallable(Protocol[ResultT_co]):
    def __call__(self, token: RaceToken) -> Awaitable[ResultT_co]: ...


class CandidateRacePort(Protocol, Generic[ResultT]):
    async def run(
        self,
        candidates: tuple[tuple[str, RaceCallable[ResultT]], ...],
        publish: Callable[[ResultT], None],
    ) -> ResultT: ...


class ParserPort(Protocol):
    def parse(self, request: parsing_models.ParserRequest) -> parsing_models.ParserResult: ...


class AnalysisModelPort(Protocol):
    def analyze(self, request: llm_models.LLMRequest) -> llm_models.LLMStructuredResponse: ...


class BoundedTransportPort(Protocol):
    def execute(
        self, request: access_models.TransportRequest
    ) -> access_models.TransportResponse: ...


class ArtifactStorePort(Protocol):
    def publish(self, artifact: asset_models.StagedArtifact) -> asset_models.PublishedArtifact: ...


__all__ = (
    "AnalysisModelPort",
    "ArtifactStorePort",
    "AssetFetcherPort",
    "AssetResolverPort",
    "BoundedTransportPort",
    "CandidateRaceExhausted",
    "CandidateRacePort",
    "CancellableAssetFetcherPort",
    "InvalidRaceDeadline",
    "ParserPort",
    "RaceCallable",
    "RaceToken",
)
