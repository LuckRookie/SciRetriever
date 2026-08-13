"""Capability-scoped neutral Metadata API."""

from sciretriever.metadata.api import MetadataApi
from sciretriever.metadata.registry import (
    METADATA_PROVIDER_ORDER,
    METADATA_SEARCH_PROVIDER_ORDER,
    MetadataAssemblyDependencies,
    MetadataCapability,
    MetadataProviderRegistration,
    MetadataProviderStatus,
    MetadataRegistry,
    MetadataRegistryError,
    build_metadata_registry,
    metadata_provider_statuses,
    validate_metadata_provider_matrix,
)
from sciretriever.metadata.rules import (
    MetadataBatchResult,
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    ProviderReferenceQuery,
)
from sciretriever.metadata.service import MetadataService

__all__ = (
    "MetadataApi",
    "METADATA_PROVIDER_ORDER",
    "METADATA_SEARCH_PROVIDER_ORDER",
    "MetadataBatchResult",
    "MetadataAssemblyDependencies",
    "MetadataCapability",
    "MetadataLookupRequest",
    "MetadataProviderRegistration",
    "MetadataProviderResult",
    "MetadataProviderStatus",
    "MetadataReferenceQueryRequest",
    "MetadataRegistry",
    "MetadataRegistryError",
    "MetadataService",
    "ProviderReferenceQuery",
    "build_metadata_registry",
    "metadata_provider_statuses",
    "validate_metadata_provider_matrix",
)
