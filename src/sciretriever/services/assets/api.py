from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from typing_extensions import assert_never

import sciretriever.model.assets as asset_models
from sciretriever.core.assets import (
    DEFAULT_ASSET_CHUNK_SIZE,
    decide_primary_current,
    validate_asset_policy,
    validate_content_acceptance,
)
from sciretriever.core.execution import (
    build_target_result_envelope,
    validate_content_acceptance_command,
)
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.execution import (
    ContentAcceptanceCommand,
    TargetProjection,
    ValidatedAssetAcceptance,
)
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    RelativeArtifactPath,
    WorkVersionAssetId,
    sha256_digest,
)

from .acquisition import AcquisitionRequest, CandidateAcquisition
from .ports import (
    ArtifactStorePort,
    AssetAcceptancePublisher,
    AssetFetcherPort,
    AssetResolverPort,
    CancellableAssetFetcherPort,
    CandidateRacePort,
)


@dataclass(frozen=True, slots=True)
class AssetAcceptancePolicy:
    min_pdf_bytes: int = 1_000
    max_asset_bytes: int = 100 * 1024 * 1024
    chunk_size: int = DEFAULT_ASSET_CHUNK_SIZE

    def __post_init__(self) -> None:
        validate_asset_policy(self.min_pdf_bytes, self.max_asset_bytes, self.chunk_size)


def accept_content(
    publisher: AssetAcceptancePublisher,
    acceptance: asset_models.PrimaryPdfAcceptance | asset_models.SupplementaryAssetAcceptance,
    target: TargetProjection,
) -> asset_models.AssetPublication:
    command = ContentAcceptanceCommand(acceptance=acceptance, target=target)
    validate_content_acceptance(acceptance)
    validate_content_acceptance_command(command)
    return publisher.publish(
        ValidatedAssetAcceptance(
            acceptance=acceptance,
            target=target,
            target_result=build_target_result_envelope(target),
        )
    )


@dataclass(frozen=True, slots=True)
class ResolverTier:
    name: str
    resolvers: tuple[AssetResolverPort, ...]
    race: bool


@dataclass(frozen=True, slots=True)
class AssetServiceDependencies:
    tiers: tuple[ResolverTier, ...]
    fetcher: AssetFetcherPort
    store: ArtifactStorePort
    publisher: AssetAcceptancePublisher
    race: CandidateRacePort[asset_models.AcceptedCandidate] | None = None
    cancellable_fetcher: CancellableAssetFetcherPort | None = None


class ContentAssetService:
    def __init__(
        self,
        dependencies: AssetServiceDependencies,
        policy: AssetAcceptancePolicy,
    ) -> None:
        self._dependencies = dependencies
        self._acquisition = CandidateAcquisition(
            fetcher=dependencies.fetcher,
            race_port=dependencies.race,
            cancellable_fetcher=dependencies.cancellable_fetcher,
            min_pdf_bytes=policy.min_pdf_bytes,
            max_asset_bytes=policy.max_asset_bytes,
        )

    def accept(
        self,
        target: asset_models.ContentTarget,
        role: AssetRole,
        target_projection: TargetProjection,
    ) -> asset_models.ContentAssetResult:
        if role is AssetRole.PRIMARY_PDF:
            current = decide_primary_current(target)
            if current is not None:
                return current
        evidence: list[asset_models.CandidateEvidence] = []
        for tier in self._dependencies.tiers:
            candidates: list[asset_models.AssetCandidate] = []
            for resolver in tier.resolvers:
                try:
                    resolved = resolver.resolve(target)
                except OSError:
                    evidence.append(
                        asset_models.CandidateEvidence(
                            provider=resolver.identity, outcome="resolver-failed"
                        )
                    )
                    continue
                candidates.extend(candidate for candidate in resolved if candidate.role is role)
            request = AcquisitionRequest(
                candidates=tuple(candidates),
                target=target,
                role=role,
                evidence=evidence,
            )
            winner = (
                self._acquisition.race(request)
                if tier.race
                else self._acquisition.fallback(request)
            )
            if winner is not None:
                return self._publish(target, winner, tuple(evidence), target_projection)
        return asset_models.ContentAssetFailure(
            code="candidates-exhausted", evidence=tuple(evidence)
        )

    def _publish(
        self,
        target: asset_models.ContentTarget,
        accepted: asset_models.AcceptedCandidate,
        evidence: tuple[asset_models.CandidateEvidence, ...],
        target_projection: TargetProjection,
    ) -> asset_models.ContentAssetResult:
        metadata_hash = target.current_metadata.sha256
        if metadata_hash is None:
            return asset_models.ContentAssetFailure(code="metadata-hash-missing", evidence=())
        content = b"".join(accepted.content.chunks)
        digest = sha256_digest(content)
        match accepted.candidate.role:
            case AssetRole.PRIMARY_PDF:
                kind = asset_models.ArtifactKind.PRIMARY_PDF
            case (
                AssetRole.SUPPLEMENTARY_PDF
                | AssetRole.XML
                | AssetRole.HTML
                | AssetRole.SUPPLEMENTARY
            ):
                kind = asset_models.ArtifactKind.SUPPLEMENTARY
            case unreachable:
                assert_never(unreachable)
        published = self._dependencies.store.publish(
            asset_models.StagedArtifact(
                kind=kind,
                path=RelativeArtifactPath("staged"),
                sha256=digest,
                content=content,
            )
        )
        asset_id = AssetId(str(uuid4()))
        relation_id = WorkVersionAssetId(str(uuid4()))
        source = CanonicalJsonObject((("provider", accepted.candidate.provider),))
        match accepted.candidate.role:
            case AssetRole.PRIMARY_PDF:
                acceptance: (
                    asset_models.PrimaryPdfAcceptance | asset_models.SupplementaryAssetAcceptance
                ) = asset_models.PrimaryPdfAcceptance(
                    work_version_id=target.work_version_id,
                    expected_metadata_id=target.current_metadata.snapshot_id,
                    expected_metadata_revision=target.expected_metadata_revision,
                    expected_metadata_sha256=metadata_hash,
                    artifact_id=asset_id,
                    relation_id=relation_id,
                    artifact=published,
                    source=source,
                )
            case (
                AssetRole.SUPPLEMENTARY_PDF
                | AssetRole.XML
                | AssetRole.HTML
                | AssetRole.SUPPLEMENTARY
            ):
                acceptance = asset_models.SupplementaryAssetAcceptance(
                    work_version_id=target.work_version_id,
                    expected_metadata_id=target.current_metadata.snapshot_id,
                    expected_metadata_revision=target.expected_metadata_revision,
                    expected_metadata_sha256=metadata_hash,
                    expected_primary_sha256=target.expected_accepted_content_sha256,
                    artifact_id=asset_id,
                    relation_id=relation_id,
                    role=accepted.candidate.role,
                    media_type=accepted.content.media_type,
                    artifact=published,
                    source=source,
                )
            case unreachable:
                assert_never(unreachable)
        validate_content_acceptance(acceptance, target)
        publication = accept_content(self._dependencies.publisher, acceptance, target_projection)
        if publication.replayed:
            return asset_models.ContentAssetReplay(
                asset_id=publication.asset_id,
                sha256=digest,
            )
        return asset_models.ContentAssetSuccess(
            asset_id=publication.asset_id,
            relation_id=publication.relation_id,
            sha256=digest,
            provider=accepted.candidate.provider,
            role=accepted.candidate.role,
            evidence=evidence,
        )


__all__ = (
    "AssetAcceptancePolicy",
    "AssetServiceDependencies",
    "ContentAssetService",
    "ResolverTier",
    "accept_content",
)
