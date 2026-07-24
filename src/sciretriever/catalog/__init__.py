"""Stable catalog engine and fresh-schema API."""

from importlib import import_module

from .engine import (
    DEFAULT_BUSY_TIMEOUT_MS,
    CatalogEngine,
    create_catalog_engine,
    open_catalog_engine,
    open_read_only_catalog_engine,
)
from .assets import AssetRepository
from .identity import IdentityResolver
from .library import (
    AuthorRepository,
    MetadataIngestionBatch,
    MetadataIngestionObservation,
    ReferenceRepository,
    RegistryRepository,
    TagRepository,
    WorkRepository,
    normalize_title,
)
from .schema import initialize_catalog
from .records import (
    ArtifactRegistration,
    AssetIntentRecord,
    DomainRunRecord,
    CurrentAnalysisRecord,
    EventRecord,
    ExternalParserAttemptRecord,
    FailureRecord,
    IdentityResolution,
    IdentityResolutionResult,
    IdentityReviewRecord,
    MetadataLabelRecord,
    NormalizedArtifactRecord,
    PackageVersionRecord,
    ProcessingRunRecord,
    RawAssetRecord,
    WorkRecord,
    WorkVersionAssetRecord,
    WorkVersionRecord,
    MetadataObservationRecord,
    AuthorRecord,
    AuthorshipRecord,
    RegistryRecord,
    TagRecord,
    VersionRelationRecord,
    VersionReferenceRecord,
)
from .repository import CatalogRepository, ReadOnlyCatalogView, canonical_json
from .artifacts import ArtifactRepository
from .packages import PackageSourceRepository, PackageVersionRepository
from .processing import ProcessingRunRepository
from .analysis import CurrentAnalysisRepository, ExternalParserAttemptRepository, ManualMetadataRepository
from .download_selection import (
    DownloadSelection,
    WorkVersionDownloadRecord,
    WorkVersionDownloadRepository,
)
from .analysis_selection import AnalysisSelection, WorkVersionAnalysisRecord, WorkVersionAnalysisRepository


_domain_runs_api = import_module(f"{__name__}.domain_runs")
DomainRunRepository = getattr(_domain_runs_api, "DomainRunRepository")
LEGAL_DOMAIN_RUN_TRANSITIONS = getattr(_domain_runs_api, "LEGAL_DOMAIN_RUN_TRANSITIONS")
_library_read_api = import_module(f"{__name__}.library_read")
LibraryFilters = getattr(_library_read_api, "LibraryFilters")
LibraryItem = getattr(_library_read_api, "LibraryItem")
LibraryReadRepository = getattr(_library_read_api, "LibraryReadRepository")
LibraryResult = getattr(_library_read_api, "LibraryResult")


__all__ = (
    "DEFAULT_BUSY_TIMEOUT_MS",
    "AssetIntentRecord",
    "ArtifactRegistration",
    "ArtifactRepository",
    "AssetRepository",
    "AuthorRepository",
    "AuthorRecord",
    "AuthorshipRecord",
    "CatalogEngine",
    "CatalogRepository",
    "DomainRunRecord",
    "CurrentAnalysisRecord",
    "CurrentAnalysisRepository",
    "DomainRunRepository",
    "EventRecord",
    "ExternalParserAttemptRecord",
    "ExternalParserAttemptRepository",
    "FailureRecord",
    "IdentityResolution",
    "IdentityResolutionResult",
    "IdentityResolver",
    "IdentityReviewRecord",
    "LEGAL_DOMAIN_RUN_TRANSITIONS",
    "LibraryFilters",
    "LibraryItem",
    "LibraryReadRepository",
    "LibraryResult",
    "MetadataLabelRecord",
    "ManualMetadataRepository",
    "MetadataIngestionBatch",
    "MetadataIngestionObservation",
    "MetadataObservationRecord",
    "NormalizedArtifactRecord",
    "PackageSourceRepository",
    "PackageVersionRecord",
    "PackageVersionRepository",
    "ProcessingRunRecord",
    "ProcessingRunRepository",
    "RawAssetRecord",
    "ReadOnlyCatalogView",
    "ReferenceRepository",
    "RegistryRecord",
    "RegistryRepository",
    "TagRecord",
    "TagRepository",
    "VersionRelationRecord",
    "VersionReferenceRecord",
    "WorkRecord",
    "WorkRepository",
    "WorkVersionRecord",
    "WorkVersionAssetRecord",
    "DownloadSelection",
    "WorkVersionDownloadRecord",
    "WorkVersionDownloadRepository",
    "AnalysisSelection",
    "WorkVersionAnalysisRecord",
    "WorkVersionAnalysisRepository",
    "initialize_catalog",
    "canonical_json",
    "create_catalog_engine",
    "open_catalog_engine",
    "open_read_only_catalog_engine",
    "normalize_title",
)
