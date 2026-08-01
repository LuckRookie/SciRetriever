"""Validated state records for raw-asset acceptance."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.catalog.records import AssetIntentRecord, RawAssetRecord, WorkVersionAssetRecord
from sciretriever.core.enums import AssetIntentState

from .records import PublicationResult, StagedAsset


@dataclass(frozen=True, slots=True)
class AssetAcceptanceContext:
    """Immutable, coherent state exposed at an intermediate crash checkpoint."""

    staged: StagedAsset
    intent: AssetIntentRecord | None = None
    publication: PublicationResult | None = None
    raw_asset: RawAssetRecord | None = None
    work_asset: WorkVersionAssetRecord | None = None
    reused_content: bool | None = None

    def __post_init__(self) -> None:
        if self.intent is not None:
            _validate_intent_staged(self.intent, self.staged)
        if self.publication is not None:
            _validate_publication_staged(self.publication, self.staged)
        if (self.raw_asset is None) != (self.work_asset is None):
            raise ValueError("raw_asset and work_asset must be present together")
        if self.raw_asset is not None and self.work_asset is not None:
            if self.intent is None or self.publication is None:
                raise ValueError("catalog records require an intent and publication")
            validate_catalog_records(
                self.intent,
                self.raw_asset,
                self.work_asset,
                self.publication,
            )
        if self.reused_content is None:
            if self.publication is not None:
                raise ValueError("publication requires a reused_content decision")
        elif self.publication is None:
            raise ValueError("reused_content requires a publication")
        elif self.reused_content != (not self.publication.created):
            raise ValueError("reused_content must be the inverse of publication.created")


@dataclass(frozen=True, slots=True)
class AssetAcceptanceResult:
    """Final catalog and storage records produced by one accepted asset."""

    intent: AssetIntentRecord
    raw_asset: RawAssetRecord
    work_asset: WorkVersionAssetRecord
    publication: PublicationResult
    reused_content: bool

    def __post_init__(self) -> None:
        if self.intent.state is not AssetIntentState.FINALIZED:
            raise ValueError("accepted asset intent must be finalized")
        validate_catalog_records(
            self.intent,
            self.raw_asset,
            self.work_asset,
            self.publication,
        )
        if not isinstance(self.reused_content, bool):
            raise TypeError("reused_content must be a boolean")
        if self.reused_content != (not self.publication.created):
            raise ValueError("reused_content must be the inverse of publication.created")


def _validate_intent_staged(intent: AssetIntentRecord, staged: StagedAsset) -> None:
    if intent.id != staged.intent_id:
        raise ValueError("intent and staged asset IDs do not match")
    if intent.temporary_path != staged.temporary_path:
        raise ValueError("intent and staged paths do not match")
    if intent.expected_sha256 != staged.sha256:
        raise ValueError("intent and staged hashes do not match")
    if intent.expected_byte_size != staged.byte_size:
        raise ValueError("intent and staged sizes do not match")


def _validate_publication_staged(
    publication: PublicationResult,
    staged: StagedAsset,
) -> None:
    if publication.sha256 != staged.sha256:
        raise ValueError("publication and staged hashes do not match")
    if publication.byte_size != staged.byte_size:
        raise ValueError("publication and staged sizes do not match")


def validate_catalog_records(
    intent: AssetIntentRecord,
    raw_asset: RawAssetRecord,
    work_asset: WorkVersionAssetRecord,
    publication: PublicationResult,
) -> None:
    if intent.raw_asset_id != raw_asset.id:
        raise ValueError("intent does not reference the returned raw asset")
    if work_asset.work_version_id != intent.work_version_id:
        raise ValueError("work asset does not reference the intent work")
    if work_asset.raw_asset_id != raw_asset.id:
        raise ValueError("work asset does not reference the returned raw asset")
    if work_asset.asset_role is not intent.asset_role:
        raise ValueError("work asset role does not match the intent")
    expected = (publication.storage_path, publication.sha256, publication.byte_size)
    actual = (raw_asset.storage_path, raw_asset.sha256, raw_asset.byte_size)
    if actual != expected:
        raise ValueError("raw asset metadata does not match the publication")
    if (
        raw_asset.storage_path != intent.storage_path
        or raw_asset.sha256 != intent.expected_sha256
        or raw_asset.byte_size != intent.expected_byte_size
        or raw_asset.media_type != intent.media_type
        or raw_asset.format != intent.format
    ):
        raise ValueError("raw asset metadata does not match the intent")


__all__ = ("AssetAcceptanceContext", "AssetAcceptanceResult", "validate_catalog_records")
