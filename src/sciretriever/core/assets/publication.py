from __future__ import annotations

from typing import TypeAlias, assert_never

from sciretriever.model import assets as asset_models

from .errors import AssetRuleError

AssetAcceptance: TypeAlias = (
    asset_models.PrimaryPdfAcceptance | asset_models.SupplementaryAssetAcceptance
)


def validate_content_acceptance(
    value: AssetAcceptance,
    target: asset_models.ContentTarget | None = None,
) -> None:
    """Validate an asset publication and, when supplied, its target snapshot."""
    match value:
        case asset_models.PrimaryPdfAcceptance() as acceptance:
            validate_primary_pdf_acceptance(acceptance, target)
        case asset_models.SupplementaryAssetAcceptance() as acceptance:
            validate_supplementary_asset_acceptance(acceptance, target)
        case unreachable:
            assert_never(unreachable)


def validate_primary_pdf_acceptance(
    value: asset_models.PrimaryPdfAcceptance,
    target: asset_models.ContentTarget | None = None,
) -> None:
    """Validate a published primary PDF and its optional target alignment."""
    _verify_published_artifact(value.artifact)
    _verify_artifact_kind(value.artifact, asset_models.ArtifactKind.PRIMARY_PDF)
    if target is not None:
        _verify_metadata_alignment(value, target)


def validate_supplementary_asset_acceptance(
    value: asset_models.SupplementaryAssetAcceptance,
    target: asset_models.ContentTarget | None = None,
) -> None:
    """Validate a published supplementary asset and its optional target alignment."""
    _verify_published_artifact(value.artifact)
    if value.role is asset_models.AssetRole.PRIMARY_PDF:
        raise AssetRuleError.for_field("role", "must be a supplementary role")
    _verify_artifact_kind(value.artifact, asset_models.ArtifactKind.SUPPLEMENTARY)
    if target is not None:
        _verify_metadata_alignment(value, target)
        if value.expected_primary_sha256 != target.expected_accepted_content_sha256:
            raise AssetRuleError.for_field("expected_primary_sha256", "must match target primary")


def _verify_published_artifact(artifact: asset_models.PublishedArtifact) -> None:
    directory = _artifact_directory(artifact.kind)
    digest = str(artifact.sha256)
    expected = f"{directory}/{digest[:2]}/{digest}"
    if str(artifact.path) != expected or artifact.size <= 0:
        raise AssetRuleError.for_field("artifact", "published artifact identity is inconsistent")


def _artifact_directory(kind: asset_models.ArtifactKind) -> str:
    match kind:
        case asset_models.ArtifactKind.PRIMARY_PDF | asset_models.ArtifactKind.SUPPLEMENTARY:
            return "raw"
        case asset_models.ArtifactKind.LIGHT_DOCUMENT:
            return "light-document"
        case asset_models.ArtifactKind.ANALYSIS:
            return "analysis"
        case unreachable:
            assert_never(unreachable)


def _verify_artifact_kind(
    artifact: asset_models.PublishedArtifact,
    expected: asset_models.ArtifactKind,
) -> None:
    if artifact.kind is not expected:
        raise AssetRuleError.for_field("artifact", f"must be a {expected.value} artifact")


def _verify_metadata_alignment(
    value: asset_models.PrimaryPdfAcceptance | asset_models.SupplementaryAssetAcceptance,
    target: asset_models.ContentTarget,
) -> None:
    if value.work_version_id != target.work_version_id:
        raise AssetRuleError.for_field("work_version_id", "must match content target")
    if value.expected_metadata_id != target.current_metadata.snapshot_id:
        raise AssetRuleError.for_field("expected_metadata_id", "must match current metadata")
    if value.expected_metadata_revision != target.current_metadata.revision:
        raise AssetRuleError.for_field("expected_metadata_revision", "must match current metadata")
    if value.expected_metadata_sha256 != target.current_metadata.sha256:
        raise AssetRuleError.for_field("expected_metadata_sha256", "must match current metadata")


__all__ = (
    "AssetAcceptance",
    "validate_content_acceptance",
    "validate_primary_pdf_acceptance",
    "validate_supplementary_asset_acceptance",
)
