"""Stable API for immutable raw-asset storage and recovery."""

from sciretriever.errors import (
    CrossDeviceStorageError,
    DurabilityError,
    StorageConflictError,
    StorageCorruptionError,
    StorageError,
    StoragePathError,
)

from .coordinator import (
    AssetAcceptanceContext,
    AssetAcceptanceCoordinator,
    AssetAcceptanceResult,
)
from .manager import RawAssetStore
from .derived import DerivedArtifactReconciler, DerivedArtifactStore
from .derived_records import DerivedPublication, DerivedReconciliationReport, DerivedStagedArtifact
from .reconciler import RawAssetReconciler, ReconciliationItem, ReconciliationReport
from .records import PublicationResult, StagedAsset


__all__ = (
    "AssetAcceptanceContext",
    "AssetAcceptanceCoordinator",
    "AssetAcceptanceResult",
    "CrossDeviceStorageError",
    "DurabilityError",
    "PublicationResult",
    "RawAssetStore",
    "RawAssetReconciler",
    "ReconciliationItem",
    "ReconciliationReport",
    "StagedAsset",
    "StorageConflictError",
    "StorageCorruptionError",
    "StorageError",
    "StoragePathError",
)
