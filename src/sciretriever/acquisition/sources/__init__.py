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
)
from sciretriever.acquisition.sources.browser_rules import (
    PRODUCTION_BROWSER_RULE_CATALOG,
    BrowserActionKind,
    BrowserArticleIdentityKind,
    BrowserCaptureDisposition,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.configured_sci_hub import (
    ConfiguredLocatorResolver,
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
    "BrowserActionKind",
    "BrowserArticleIdentityKind",
    "BrowserCaptureDisposition",
    "BrowserFlowSession",
    "BrowserPageMarker",
    "BrowserPageMarkerKind",
    "BrowserRuleAction",
    "BrowserRuleCatalog",
    "BrowserRunner",
    "BrowserSiteRule",
    "CONTROLLED_BROWSER_PRODUCTION_STATUS",
    "ConfiguredLocatorResolver",
    "ConfiguredSciHubPdfSource",
    "ControlledBrowserPdfSource",
    "DirectPdfSource",
    "DoiLandingResolver",
    "EuropePmcPdfSource",
    "PRODUCTION_BROWSER_RULE_CATALOG",
    "PublicLocatorFetcher",
    "UnpaywallPdfSource",
    "WebAccessProfileResolver",
    "configured_sci_hub_route_status",
)
