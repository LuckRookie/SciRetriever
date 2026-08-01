from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar

from sciretriever.content.model import (
    AcceptedPrimaryPdf,
    AnalysisProposalV1,
    AssetCandidate,
    BoundedByteStream,
    ContentTarget,
    Header,
    LightDocumentManifest,
    ParserResult,
    PublishedArtifact,
    StagedArtifact,
    TransportRequest,
    TransportResponse,
)


class AssetResolverPort(Protocol):
    def resolve(self, target: ContentTarget) -> tuple[AssetCandidate, ...]: ...


class AssetFetcherPort(Protocol):
    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream: ...


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
        candidate: AssetCandidate,
        token: RaceToken,
    ) -> BoundedByteStream: ...


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
    def parse(self, primary_pdf: AcceptedPrimaryPdf) -> ParserResult: ...


class AnalysisModelPort(Protocol):
    def analyze(self, document: LightDocumentManifest) -> AnalysisProposalV1: ...


class BoundedTransportPort(Protocol):
    def execute(self, request: TransportRequest) -> TransportResponse: ...


class ArtifactStorePort(Protocol):
    def publish(self, artifact: StagedArtifact) -> PublishedArtifact: ...


__all__ = (
    "AnalysisModelPort",
    "ArtifactStorePort",
    "AssetCandidate",
    "AssetFetcherPort",
    "AssetResolverPort",
    "BoundedByteStream",
    "BoundedTransportPort",
    "ContentTarget",
    "CandidateRaceExhausted",
    "CandidateRacePort",
    "CancellableAssetFetcherPort",
    "Header",
    "InvalidRaceDeadline",
    "ParserPort",
    "RaceCallable",
    "RaceToken",
    "TransportRequest",
    "TransportResponse",
)
