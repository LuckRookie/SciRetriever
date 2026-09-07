"""Production Acquisition Source exports.

Only A5's concrete :class:`PublicLocatorFetcher` is exported here.  The
similarly named Protocols in individual public-protocol modules remain private
handoff descriptions rather than three competing package APIs.
"""

from sciretriever.acquisition.sources.arxiv import ArxivPdfSource
from sciretriever.acquisition.sources.browser import (
    CONTROLLED_BROWSER_PRODUCTION_STATUS,
    BrowserFlowSession,
    BrowserRunner,
    ControlledBrowserPdfSource,
    GenericBrowserDestinationGuard,
    build_generic_browser_destination_guard,
)
from sciretriever.acquisition.sources.configured_sci_hub import (
    BUILTIN_SCI_HUB_MIRROR_URLS,
    ConfiguredLocatorResolver,
    ConfiguredSciHubLandingResolver,
    ConfiguredSciHubPdfSource,
    configured_sci_hub_route_status,
)
from sciretriever.acquisition.sources.direct import (
    DirectPdfSource,
    PublicLocatorFetcher,
    WebAccessProfileResolver,
)
from sciretriever.acquisition.sources.doi_landing import DoiLandingResolver
from sciretriever.acquisition.sources.europe_pmc import EuropePmcPdfSource
from sciretriever.acquisition.sources.unpaywall import UnpaywallPdfSource

__all__ = (
    "ArxivPdfSource",
    "BrowserFlowSession",
    "BrowserRunner",
    "BUILTIN_SCI_HUB_MIRROR_URLS",
    "CONTROLLED_BROWSER_PRODUCTION_STATUS",
    "ConfiguredLocatorResolver",
    "ConfiguredSciHubLandingResolver",
    "ConfiguredSciHubPdfSource",
    "ControlledBrowserPdfSource",
    "GenericBrowserDestinationGuard",
    "DirectPdfSource",
    "DoiLandingResolver",
    "EuropePmcPdfSource",
    "PublicLocatorFetcher",
    "UnpaywallPdfSource",
    "WebAccessProfileResolver",
    "configured_sci_hub_route_status",
    "build_generic_browser_destination_guard",
)
