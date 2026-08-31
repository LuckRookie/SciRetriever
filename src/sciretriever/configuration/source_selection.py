"""Resolve user Source modes into deterministic capability selections.

This is a local product catalog, not a network availability detector.  Auto
contains only production-admitted Sources that can be used safely without an
operator identity, credential, entitlement, or risk acknowledgement.  A
Custom list is always consumed exactly in its configured order.
"""

from typing import Final

from sciretriever.model.configuration import Configuration, ProviderName, SourceMode

AUTO_METADATA_SOURCE_PROVIDERS: Final[tuple[ProviderName, ...]] = (
    ProviderName.CROSSREF,
    ProviderName.SEMANTIC_SCHOLAR,
    ProviderName.ARXIV,
    ProviderName.OPENALEX,
    ProviderName.EUROPE_PMC,
    ProviderName.DATACITE,
    ProviderName.CORE,
    ProviderName.OPENCITATIONS,
)

# Existing direct-file and landing-page AssetHints are intrinsic Acquisition
# evidence and are consumed independently of this named Provider selection.
# These two entries add the only independent zero-configuration public PDF
# protocols currently admitted for automatic use.
AUTO_ACQUISITION_SOURCE_PROVIDERS: Final[tuple[ProviderName, ...]] = (
    ProviderName.ARXIV,
    ProviderName.EUROPE_PMC,
)


def metadata_source_providers(configuration: Configuration) -> tuple[ProviderName, ...]:
    """Return the effective ordered Metadata Source selection."""

    if not isinstance(configuration, Configuration):
        raise TypeError("configuration must be a Configuration")
    settings = configuration.sources.metadata
    return (
        AUTO_METADATA_SOURCE_PROVIDERS if settings.mode is SourceMode.AUTO else settings.providers
    )


def acquisition_source_providers(configuration: Configuration) -> tuple[ProviderName, ...]:
    """Return the effective ordered named Acquisition Source selection."""

    if not isinstance(configuration, Configuration):
        raise TypeError("configuration must be a Configuration")
    settings = configuration.sources.acquisition
    return (
        AUTO_ACQUISITION_SOURCE_PROVIDERS
        if settings.mode is SourceMode.AUTO
        else settings.providers
    )


__all__ = (
    "AUTO_ACQUISITION_SOURCE_PROVIDERS",
    "AUTO_METADATA_SOURCE_PROVIDERS",
    "acquisition_source_providers",
    "metadata_source_providers",
)
