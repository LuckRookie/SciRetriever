from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

import sciretriever.model.assets as asset_models
from sciretriever.content.asset_acquisition import CandidateAcquisition
from sciretriever.content.ports import (
    ArtifactStorePort,
    AssetFetcherPort,
    AssetResolverPort,
    CancellableAssetFetcherPort,
    CandidateRacePort,
)
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.model.assets import PrimaryPdfAcceptance, SupplementaryAssetAcceptance
from sciretriever.model.execution import ContentAcceptance
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    RelativeArtifactPath,
    WorkVersionAssetId,
    sha256_digest,
)


@dataclass(frozen=True, slots=True)
class AssetAcceptancePolicy:
    min_pdf_bytes: int = 1_000
    max_asset_bytes: int = 100 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ResolverTier:
    name: str
    resolvers: tuple[AssetResolverPort, ...]
    race: bool


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
        race: CandidateRacePort[asset_models.AcceptedCandidate] | None = None,
        cancellable_fetcher: CancellableAssetFetcherPort | None = None,
    ) -> None:
        self._tiers = tiers
        self._fetcher = fetcher
        self._store = store
        self._publisher = publisher
        self._acquisition = CandidateAcquisition(
            fetcher=fetcher,
            race_port=race,
            cancellable_fetcher=cancellable_fetcher,
            min_pdf_bytes=policy.min_pdf_bytes,
            max_asset_bytes=policy.max_asset_bytes,
        )

    def accept(
        self,
        target: asset_models.ContentTarget,
        role: AssetRole,
    ) -> asset_models.ContentAssetResult:
        current = target.current_accepted_content
        if role is AssetRole.PRIMARY_PDF and current is not None:
            if isinstance(current.content_id, AssetId):
                return asset_models.ContentAssetReplay(
                    asset_id=current.content_id, sha256=current.sha256
                )
            return asset_models.ContentAssetFailure(code="current-primary-invalid", evidence=())
        evidence: list[asset_models.CandidateEvidence] = []
        for tier in self._tiers:
            candidates = tuple(
                candidate
                for resolver in tier.resolvers
                for candidate in resolver.resolve(target)
                if candidate.role is role
            )
            winner = (
                self._acquisition.race(candidates, target, role, evidence)
                if tier.race
                else self._acquisition.fallback(candidates, target, role, evidence)
            )
            if winner is not None:
                candidate, content = winner
                return self._publish(
                    target, candidate, b"".join(content.chunks), content.media_type
                )
        return asset_models.ContentAssetFailure(
            code="candidates-exhausted", evidence=tuple(evidence)
        )

    def _publish(
        self,
        target: asset_models.ContentTarget,
        candidate: asset_models.AssetCandidate,
        content: bytes,
        media_type: str,
    ) -> asset_models.ContentAssetResult:
        metadata_hash = target.current_metadata.sha256
        if metadata_hash is None:
            return asset_models.ContentAssetFailure(code="metadata-hash-missing", evidence=())
        digest = sha256_digest(content)
        kind = (
            asset_models.ArtifactKind.PRIMARY_PDF
            if candidate.role is AssetRole.PRIMARY_PDF
            else asset_models.ArtifactKind.SUPPLEMENTARY
        )
        published = self._store.publish(
            asset_models.StagedArtifact(
                kind=kind,
                path=RelativeArtifactPath("staged"),
                sha256=digest,
                content=content,
            )
        )
        asset_id = AssetId(str(uuid4()))
        relation_id = WorkVersionAssetId(str(uuid4()))
        source = CanonicalJsonObject((("provider", candidate.provider),))
        if candidate.role is AssetRole.PRIMARY_PDF:
            acceptance = PrimaryPdfAcceptance(
                work_version_id=target.work_version_id,
                expected_metadata_id=target.current_metadata.snapshot_id,
                expected_metadata_revision=target.expected_metadata_revision,
                expected_metadata_sha256=metadata_hash,
                artifact_id=asset_id,
                relation_id=relation_id,
                artifact=published,
                source=source,
            )
        else:
            acceptance = SupplementaryAssetAcceptance(
                work_version_id=target.work_version_id,
                expected_metadata_id=target.current_metadata.snapshot_id,
                expected_metadata_revision=target.expected_metadata_revision,
                expected_metadata_sha256=metadata_hash,
                expected_primary_sha256=target.expected_accepted_content_sha256,
                artifact_id=asset_id,
                relation_id=relation_id,
                role=candidate.role,
                media_type=media_type,
                artifact=published,
                source=source,
            )
        self._publisher.publish(acceptance)
        return asset_models.ContentAssetSuccess(
            asset_id=asset_id,
            relation_id=relation_id,
            sha256=digest,
            provider=candidate.provider,
            role=candidate.role,
        )


__all__ = (
    "AssetAcceptancePolicy",
    "ContentAssetService",
    "ResolverTier",
)
