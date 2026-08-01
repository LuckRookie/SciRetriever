"""Stable catalog engine and fresh-schema API."""

from .engine import (
    DEFAULT_BUSY_TIMEOUT_MS,
    CatalogEngine,
    create_catalog_engine,
    open_catalog_engine,
    open_read_only_catalog_engine,
)
from .assets import AssetRepository
from .identity import IdentityResolver
from .author_repository import AuthorRepository
from .library import MetadataIngestionBatch, MetadataIngestionObservation, WorkRepository
from .reference_repository import ReferenceRepository
from .registry_repository import RegistryRepository
from .tag_repository import TagRepository
from .text import normalize_title
from .schema import initialize_catalog
from .records import (
    ArtifactRegistration,
    AssetIntentRecord,
    DomainRunRecord,
    CurrentAnalysisRecord,
    ExternalParserAttemptRecord,
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
from .analysis import CurrentAnalysisRepository, ExternalParserAttemptRepository
from .download_selection import (
    DownloadSelection,
    WorkVersionDownloadRecord,
    WorkVersionDownloadRepository,
)
from .analysis_selection import AnalysisSelection, WorkVersionAnalysisRecord, WorkVersionAnalysisRepository
from .completion_facts import CompletionFacts, CompletionFactsRepository, CompletionStage
from .diagnostics import CatalogDiagnosticService
from .curation import (
    CurationAlreadyUndoneError,
    CurationAuditCorruptError,
    CurationBoundaryError,
    CurationBusyError,
    CurationCapture,
    CurationCompensationError,
    CurationNoChangeError,
    CurationOperationOwner,
    CurationRequest,
    CurationStaleError,
    CurationStep,
)
from .author_curation import AuthorCurationConflictError, AuthorMergeHandler
from .domain_runs import DomainRunRepository, LEGAL_DOMAIN_RUN_TRANSITIONS
from .library_read import LibraryFilters, LibraryItem, LibraryReadRepository, LibraryResult


__all__ = (
    "DEFAULT_BUSY_TIMEOUT_MS",
    "AssetIntentRecord",
    "ArtifactRegistration",
    "ArtifactRepository",
    "AssetRepository",
    "AuthorRepository",
    "AuthorCurationConflictError",
    "AuthorMergeHandler",
    "AuthorRecord",
    "AuthorshipRecord",
    "CatalogEngine",
    "CatalogRepository",
    "CatalogDiagnosticService",
    "CurationOperationOwner",
    "CurationAlreadyUndoneError",
    "CurationAuditCorruptError",
    "CurationBoundaryError",
    "CurationBusyError",
    "CurationCapture",
    "CurationCompensationError",
    "CurationNoChangeError",
    "CurationRequest",
    "CurationStaleError",
    "CurationStep",
    "CompletionFacts",
    "CompletionFactsRepository",
    "CompletionStage",
    "DomainRunRecord",
    "CurrentAnalysisRecord",
    "CurrentAnalysisRepository",
    "DomainRunRepository",
    "ExternalParserAttemptRecord",
    "ExternalParserAttemptRepository",
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
