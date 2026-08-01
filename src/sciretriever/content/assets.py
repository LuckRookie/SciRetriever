from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

import anyio
from anyio import to_thread

from sciretriever.content.asset_validation import validate_asset
from sciretriever.content.model import (
    ArtifactKind,
    AssetCandidate,
    BoundedByteStream,
    ContentTarget,
    StagedArtifact,
)
from sciretriever.content.ports import (
    ArtifactStorePort,
    AssetFetcherPort,
    AssetResolverPort,
    CancellableAssetFetcherPort,
    CandidateRaceExhausted,
    CandidateRacePort,
    RaceCallable,
    RaceToken,
)
from sciretriever.content.publisher_contracts import (
    ContentAcceptance,
    PrimaryPdfAcceptance,
    SupplementaryAssetAcceptance,
)
from sciretriever.kernel import (
    AssetId,
    CanonicalJsonObject,
    RelativeArtifactPath,
    Sha256,
)
from sciretriever.kernel.enums import AssetRole
from sciretriever.kernel.ids import WorkVersionAssetId


@dataclass(frozen=True, slots=True)
class AssetAcceptancePolicy:
    min_pdf_bytes: int = 1_000
    max_asset_bytes: int = 100 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ResolverTier:
    name: str
    resolvers: tuple[AssetResolverPort, ...]
    race: bool


@dataclass(frozen=True, slots=True)
class CandidateEvidence:
    provider: str
    outcome: str


@dataclass(frozen=True, slots=True)
class ContentAssetFailure:
    code: str
    evidence: tuple[CandidateEvidence, ...]


@dataclass(frozen=True, slots=True)
class ContentAssetReplay:
    asset_id: AssetId
    sha256: Sha256


@dataclass(frozen=True, slots=True)
class ContentAssetSuccess:
    asset_id: AssetId
    relation_id: WorkVersionAssetId
    sha256: Sha256
    provider: str
    role: AssetRole


ContentAssetResult = ContentAssetFailure | ContentAssetReplay | ContentAssetSuccess


@dataclass(frozen=True, slots=True)
class AcceptedCandidate:
    candidate: AssetCandidate
    content: BoundedByteStream


class CandidateRejected(OSError):
    pass


class AcceptancePublisher(Protocol):
    def publish(self, acceptance: ContentAcceptance) -> None: ...


class ContentAssetService:
    def __init__(
        self,
        tiers: tuple[ResolverTier, ...],
        fetcher: AssetFetcherPort,
        store: ArtifactStorePort,
        publisher: AcceptancePublisher,
        policy: AssetAcceptancePolicy,
        race: CandidateRacePort[AcceptedCandidate] | None = None,
        cancellable_fetcher: CancellableAssetFetcherPort | None = None,
    ) -> None:
        self._tiers = tiers
        self._fetcher = fetcher
        self._store = store
        self._publisher = publisher
        self._policy = policy
        self._race_port = race
        self._cancellable_fetcher = cancellable_fetcher

    def accept(
        self,
        target: ContentTarget,
        role: AssetRole,
    ) -> ContentAssetResult:
        current = target.current_accepted_content
        if role is AssetRole.PRIMARY_PDF and current is not None:
            if isinstance(current.content_id, AssetId):
                return ContentAssetReplay(current.content_id, current.sha256)
            return ContentAssetFailure("current-primary-invalid", ())
        evidence: list[CandidateEvidence] = []
        for tier in self._tiers:
            candidates = tuple(
                candidate
                for resolver in tier.resolvers
                for candidate in resolver.resolve(target)
                if candidate.role is role
            )
            winner = (
                self._run_race(candidates, target, role, evidence)
                if tier.race
                else self._fallback(candidates, target, role, evidence)
            )
            if winner is not None:
                candidate, content = winner
                return self._publish(target, candidate, content.content, content.media_type)
        return ContentAssetFailure("candidates-exhausted", tuple(evidence))

    def _fallback(
        self,
        candidates: tuple[AssetCandidate, ...],
        target: ContentTarget,
        role: AssetRole,
        evidence: list[CandidateEvidence],
    ) -> tuple[AssetCandidate, BoundedByteStream] | None:
        for candidate in candidates:
            try:
                accepted = self._fetch_and_validate(candidate, target, role, None)
            except CandidateRejected as failure:
                evidence.append(CandidateEvidence(candidate.provider, str(failure)))
                continue
            except (OSError, TimeoutError):
                evidence.append(CandidateEvidence(candidate.provider, "transport-failed"))
                continue
            evidence.append(CandidateEvidence(candidate.provider, "accepted"))
            return accepted.candidate, accepted.content
        return None

    def _run_race(
        self,
        candidates: tuple[AssetCandidate, ...],
        target: ContentTarget,
        role: AssetRole,
        evidence: list[CandidateEvidence],
    ) -> tuple[AssetCandidate, BoundedByteStream] | None:
        if not candidates or self._race_port is None:
            return None
        outcomes: dict[int, CandidateEvidence] = {}

        def operation(index: int, candidate: AssetCandidate) -> RaceCallable[AcceptedCandidate]:
            async def execute(token: RaceToken) -> AcceptedCandidate:
                try:
                    accepted = await to_thread.run_sync(
                        lambda: self._fetch_and_validate(candidate, target, role, token),
                        abandon_on_cancel=True,
                    )
                except CandidateRejected as failure:
                    outcomes[index] = CandidateEvidence(candidate.provider, str(failure))
                    raise
                except (OSError, TimeoutError):
                    outcomes[index] = CandidateEvidence(candidate.provider, "transport-failed")
                    raise
                outcomes[index] = CandidateEvidence(candidate.provider, "accepted")
                return accepted

            return execute

        operations = tuple(
            (str(index), operation(index, candidate)) for index, candidate in enumerate(candidates)
        )
        try:
            accepted = anyio.run(self._race_port.run, operations, lambda _value: None)
        except CandidateRaceExhausted:
            evidence.extend(
                outcomes.get(index, CandidateEvidence(candidate.provider, "candidate-failed"))
                for index, candidate in enumerate(candidates)
            )
            return None
        except TimeoutError:
            evidence.extend(
                outcomes.get(index, CandidateEvidence(candidate.provider, "deadline-exceeded"))
                for index, candidate in enumerate(candidates)
            )
            return None
        evidence.extend(
            outcomes[index] for index in sorted(outcomes) if outcomes[index].outcome != "accepted"
        )
        return accepted.candidate, accepted.content

    def _fetch_and_validate(
        self,
        candidate: AssetCandidate,
        target: ContentTarget,
        role: AssetRole,
        token: RaceToken | None,
    ) -> AcceptedCandidate:
        if token is not None and self._cancellable_fetcher is not None:
            content = self._cancellable_fetcher.fetch_cancellable(candidate, token)
        else:
            content = self._fetcher.fetch(candidate)
        failure = validate_asset(
            content,
            target,
            role,
            min_pdf_bytes=self._policy.min_pdf_bytes,
            max_asset_bytes=self._policy.max_asset_bytes,
        )
        if failure is not None:
            raise CandidateRejected(failure.code)
        return AcceptedCandidate(candidate, content)

    def _publish(
        self,
        target: ContentTarget,
        candidate: AssetCandidate,
        content: bytes,
        media_type: str,
    ) -> ContentAssetResult:
        metadata_hash = target.current_metadata.sha256
        if metadata_hash is None:
            return ContentAssetFailure("metadata-hash-missing", ())
        digest = Sha256.from_bytes(content)
        kind = (
            ArtifactKind.PRIMARY_PDF
            if candidate.role is AssetRole.PRIMARY_PDF
            else ArtifactKind.SUPPLEMENTARY
        )
        published = self._store.publish(
            StagedArtifact(kind, RelativeArtifactPath("staged"), digest, content)
        )
        asset_id = AssetId(str(uuid4()))
        relation_id = WorkVersionAssetId(str(uuid4()))
        source = CanonicalJsonObject((("provider", candidate.provider),))
        if candidate.role is AssetRole.PRIMARY_PDF:
            acceptance = PrimaryPdfAcceptance(
                target.work_version_id,
                target.current_metadata.snapshot_id,
                target.expected_metadata_revision,
                metadata_hash,
                asset_id,
                relation_id,
                published,
                source,
            )
        else:
            acceptance = SupplementaryAssetAcceptance(
                target.work_version_id,
                target.current_metadata.snapshot_id,
                target.expected_metadata_revision,
                metadata_hash,
                target.expected_accepted_content_sha256,
                asset_id,
                relation_id,
                candidate.role,
                media_type,
                published,
                source,
            )
        self._publisher.publish(acceptance)
        return ContentAssetSuccess(
            asset_id, relation_id, digest, candidate.provider, candidate.role
        )


__all__ = (
    "AssetAcceptancePolicy",
    "CandidateEvidence",
    "ContentAssetFailure",
    "ContentAssetReplay",
    "ContentAssetResult",
    "ContentAssetService",
    "ContentAssetSuccess",
    "ResolverTier",
)
