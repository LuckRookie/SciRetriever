from __future__ import annotations

from sciretriever.model.access import BoundedByteStream
from sciretriever.model.assets import AssetCandidate
from sciretriever.services.assets.ports import (
    AssetFetcherPort,
    CandidateRaceExhausted,
)


class EmptyAssetResponse(Exception):
    def __str__(self) -> str:
        return "asset response was empty"


class NeutralAssetFetcher:
    def __init__(self, fetcher: AssetFetcherPort) -> None:
        self._fetcher = fetcher

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        stream = self._fetcher.fetch(candidate)
        if stream.size < 1 or not b"".join(stream.chunks):
            raise EmptyAssetResponse
        return stream

    def fetch_first(self, candidates: tuple[AssetCandidate, ...]) -> BoundedByteStream:
        for candidate in candidates:
            try:
                return self.fetch(candidate)
            except EmptyAssetResponse:
                continue
        raise CandidateRaceExhausted


__all__ = ("EmptyAssetResponse", "NeutralAssetFetcher")
