from __future__ import annotations

from dataclasses import dataclass

import anyio
from anyio import to_thread

import sciretriever.model.access as access_models
import sciretriever.model.assets as asset_models
from sciretriever.content.asset_validation import validate_asset
from sciretriever.content.ports import (
    AssetFetcherPort,
    CancellableAssetFetcherPort,
    CandidateRaceExhausted,
    CandidateRacePort,
    RaceCallable,
    RaceToken,
)
from sciretriever.model.primitives import AssetRole


class CandidateRejected(OSError):
    pass


@dataclass(frozen=True, slots=True)
class CandidateAcquisition:
    fetcher: AssetFetcherPort
    race_port: CandidateRacePort[asset_models.AcceptedCandidate] | None
    cancellable_fetcher: CancellableAssetFetcherPort | None
    min_pdf_bytes: int
    max_asset_bytes: int

    def fallback(
        self,
        candidates: tuple[asset_models.AssetCandidate, ...],
        target: asset_models.ContentTarget,
        role: AssetRole,
        evidence: list[asset_models.CandidateEvidence],
    ) -> tuple[asset_models.AssetCandidate, access_models.BoundedByteStream] | None:
        for candidate in candidates:
            try:
                accepted = self.fetch_and_validate(candidate, target, role, None)
            except CandidateRejected as failure:
                evidence.append(
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome=str(failure)
                    )
                )
                continue
            except (OSError, TimeoutError):
                evidence.append(
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome="transport-failed"
                    )
                )
                continue
            evidence.append(
                asset_models.CandidateEvidence(provider=candidate.provider, outcome="accepted")
            )
            return accepted.candidate, accepted.content
        return None

    def race(
        self,
        candidates: tuple[asset_models.AssetCandidate, ...],
        target: asset_models.ContentTarget,
        role: AssetRole,
        evidence: list[asset_models.CandidateEvidence],
    ) -> tuple[asset_models.AssetCandidate, access_models.BoundedByteStream] | None:
        if not candidates or self.race_port is None:
            return None
        outcomes: dict[int, asset_models.CandidateEvidence] = {}

        def operation(
            index: int, candidate: asset_models.AssetCandidate
        ) -> RaceCallable[asset_models.AcceptedCandidate]:
            async def execute(token: RaceToken) -> asset_models.AcceptedCandidate:
                try:
                    accepted = await to_thread.run_sync(
                        lambda: self.fetch_and_validate(candidate, target, role, token),
                        abandon_on_cancel=True,
                    )
                except CandidateRejected as failure:
                    outcomes[index] = asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome=str(failure)
                    )
                    raise
                except (OSError, TimeoutError):
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
            (str(index), operation(index, candidate)) for index, candidate in enumerate(candidates)
        )
        try:
            accepted = anyio.run(self.race_port.run, operations, lambda _value: None)
        except CandidateRaceExhausted:
            evidence.extend(
                outcomes.get(
                    index,
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome="candidate-failed"
                    ),
                )
                for index, candidate in enumerate(candidates)
            )
            return None
        except TimeoutError:
            evidence.extend(
                outcomes.get(
                    index,
                    asset_models.CandidateEvidence(
                        provider=candidate.provider, outcome="deadline-exceeded"
                    ),
                )
                for index, candidate in enumerate(candidates)
            )
            return None
        evidence.extend(
            outcomes[index] for index in sorted(outcomes) if outcomes[index].outcome != "accepted"
        )
        return accepted.candidate, accepted.content

    def fetch_and_validate(
        self,
        candidate: asset_models.AssetCandidate,
        target: asset_models.ContentTarget,
        role: AssetRole,
        token: RaceToken | None,
    ) -> asset_models.AcceptedCandidate:
        if token is not None and self.cancellable_fetcher is not None:
            content = self.cancellable_fetcher.fetch_cancellable(candidate, token)
        else:
            content = self.fetcher.fetch(candidate)
        failure = validate_asset(
            content,
            target,
            role,
            min_pdf_bytes=self.min_pdf_bytes,
            max_asset_bytes=self.max_asset_bytes,
        )
        if failure is not None:
            raise CandidateRejected(failure.code)
        return asset_models.AcceptedCandidate(candidate=candidate, content=content)


__all__ = ("CandidateAcquisition",)
