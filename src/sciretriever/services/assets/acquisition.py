from __future__ import annotations

from dataclasses import dataclass

import anyio
from anyio import to_thread

import sciretriever.model.assets as asset_models
from sciretriever.core.assets import validate_asset
from sciretriever.model.primitives import AssetRole

from .errors import CandidateRejected
from .ports import (
    AssetFetcherPort,
    CancellableAssetFetcherPort,
    CandidateRaceExhausted,
    CandidateRacePort,
    RaceCallable,
    RaceCancellation,
)


@dataclass(frozen=True, slots=True)
class AcquisitionRequest:
    """Mutable evidence buffer shared by one tier acquisition attempt."""

    candidates: tuple[asset_models.AssetCandidate, ...]
    target: asset_models.ContentTarget
    role: AssetRole
    evidence: list[asset_models.CandidateEvidence]


@dataclass(frozen=True, slots=True)
class CandidateAcquisition:
    fetcher: AssetFetcherPort
    race_port: CandidateRacePort[asset_models.AcceptedCandidate] | None
    cancellable_fetcher: CancellableAssetFetcherPort | None
    min_pdf_bytes: int
    max_asset_bytes: int

    def fallback(self, request: AcquisitionRequest) -> asset_models.AcceptedCandidate | None:
        for candidate in request.candidates:
            try:
                accepted = self.fetch_and_validate(candidate, request, None)
            except CandidateRejected as failure:
                request.evidence.append(
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome=str(failure)
                    )
                )
                continue
            except OSError:
                request.evidence.append(
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome="transport-failed"
                    )
                )
                continue
            return accepted
        return None

    def race(self, request: AcquisitionRequest) -> asset_models.AcceptedCandidate | None:
        if not request.candidates or self.race_port is None:
            return None
        outcomes: dict[int, asset_models.CandidateEvidence] = {}

        def operation(
            index: int, candidate: asset_models.AssetCandidate
        ) -> RaceCallable[asset_models.AcceptedCandidate]:
            async def execute(token: RaceCancellation) -> asset_models.AcceptedCandidate:
                try:
                    accepted = await to_thread.run_sync(
                        lambda: self.fetch_and_validate(candidate, request, token),
                        abandon_on_cancel=True,
                    )
                except CandidateRejected as failure:
                    outcomes[index] = asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome=str(failure)
                    )
                    raise
                except OSError:
                    outcomes[index] = asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome="transport-failed"
                    )
                    raise
                outcomes[index] = asset_models.CandidateEvidence(
                    provider=candidate.provider, outcome="accepted"
                )
                return accepted

            return execute

        operations = tuple(
            (str(index), operation(index, candidate))
            for index, candidate in enumerate(request.candidates)
        )
        try:
            accepted = anyio.run(self.race_port.run, operations, lambda _value: None)
        except CandidateRaceExhausted:
            request.evidence.extend(
                outcomes.get(
                    index,
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome="candidate-failed"
                    ),
                )
                for index, candidate in enumerate(request.candidates)
            )
            return None
        except TimeoutError:
            request.evidence.extend(
                outcomes.get(
                    index,
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome="deadline-exceeded"
                    ),
                )
                for index, candidate in enumerate(request.candidates)
            )
            return None
        request.evidence.extend(
            outcomes[index] for index in sorted(outcomes) if outcomes[index].outcome != "accepted"
        )
        return accepted

    def fetch_and_validate(
        self,
        candidate: asset_models.AssetCandidate,
        request: AcquisitionRequest,
        token: RaceCancellation | None,
    ) -> asset_models.AcceptedCandidate:
        if token is not None and self.cancellable_fetcher is not None:
            content = self.cancellable_fetcher.fetch_cancellable(candidate, token)
        else:
            content = self.fetcher.fetch(candidate)
        failure = validate_asset(
            content,
            request.target,
            request.role,
            min_pdf_bytes=self.min_pdf_bytes,
            max_asset_bytes=self.max_asset_bytes,
        )
        if failure is not None:
            raise CandidateRejected(failure.value)
        return asset_models.AcceptedCandidate(candidate=candidate, content=content)


__all__ = ("CandidateAcquisition",)
