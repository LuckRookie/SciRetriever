from .collection import collect_metadata
from .providers import (
    MetadataClient,
    MetadataProviderAdapter,
    VendorMetadataRecord,
)

__all__ = (
    "MetadataClient",
    "MetadataProviderAdapter",
    "VendorMetadataRecord",
    "collect_metadata",
)
