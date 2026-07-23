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
    AcquisitionAttemptRecord,
    AcquisitionJobRecord,
    AttemptRecord,
    ArtifactRegistration,
    AssetIntentRecord,
    DomainRunRecord,
    DownloadRequestRecord,
    EventRecord,
    FailureRecord,
    IdentityResolution,
    IdentityResolutionResult,
    IdentityReviewRecord,
    JobRecord,
    MetadataLabelRecord,
    LightStructureRecord,
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
from .enrichment import CitationRepository, EnrichmentRepository
from .packages import PackageSourceRepository, PackageVersionRepository
from .processing import ProcessingRunRepository
from .reporting import CatalogReportingRepository


_domain_runs_api = import_module(f"{__name__}.domain_runs")
DomainRunRepository = getattr(_domain_runs_api, "DomainRunRepository")
LEGAL_DOMAIN_RUN_TRANSITIONS = getattr(_domain_runs_api, "LEGAL_DOMAIN_RUN_TRANSITIONS")
_jobs_api = import_module(f"{__name__}.jobs")
JobRepository = getattr(_jobs_api, "JobRepository")
LEGAL_JOB_STATE_TRANSITIONS = getattr(_jobs_api, "LEGAL_JOB_STATE_TRANSITIONS")
_library_read_api = import_module(f"{__name__}.library_read")
LibraryFilters = getattr(_library_read_api, "LibraryFilters")
LibraryItem = getattr(_library_read_api, "LibraryItem")
LibraryReadRepository = getattr(_library_read_api, "LibraryReadRepository")
LibraryResult = getattr(_library_read_api, "LibraryResult")


__all__ = (
    "DEFAULT_BUSY_TIMEOUT_MS",
    "AcquisitionAttemptRecord",
    "AcquisitionJobRecord",
    "AttemptRecord",
    "AssetIntentRecord",
    "ArtifactRegistration",
    "ArtifactRepository",
    "AssetRepository",
    "AuthorRepository",
    "AuthorRecord",
    "AuthorshipRecord",
    "CatalogEngine",
    "CatalogRepository",
    "CatalogReportingRepository",
    "CitationRepository",
    "DomainRunRecord",
    "DomainRunRepository",
    "DownloadRequestRecord",
    "EventRecord",
    "FailureRecord",
    "EnrichmentRepository",
    "IdentityResolution",
    "IdentityResolutionResult",
    "IdentityResolver",
    "IdentityReviewRecord",
    "JobRecord",
    "JobRepository",
    "LEGAL_DOMAIN_RUN_TRANSITIONS",
    "LEGAL_JOB_STATE_TRANSITIONS",
    "LibraryFilters",
    "LibraryItem",
    "LibraryReadRepository",
    "LibraryResult",
    "MetadataLabelRecord",
    "MetadataIngestionBatch",
    "MetadataIngestionObservation",
    "MetadataObservationRecord",
    "LightStructureRecord",
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
    "initialize_catalog",
    "canonical_json",
    "create_catalog_engine",
    "open_catalog_engine",
    "open_read_only_catalog_engine",
    "normalize_title",
)
