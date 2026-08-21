"""Local declarative rules for controlled Browser acquisition.

Provider declarations are split by publisher while this package keeps the
historic import surface stable. Catalog admission remains explicit: importing
a provider module never makes its rule executable in production.
"""

from .catalog import (
    BROWSER_RULE_VERIFICATION_CATALOG,
    PRODUCTION_BROWSER_RULE_CATALOG,
)
from .model import (
    BrowserActionKind,
    BrowserArticleIdentityKind,
    BrowserCaptureDisposition,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from .providers import (
    ACS_BROWSER_RULE,
    AIP_BROWSER_RULE,
    ELSEVIER_BROWSER_RULE,
    IOPSCIENCE_BROWSER_RULE,
    OXFORD_ACADEMIC_BROWSER_RULE,
    RSC_BROWSER_RULE,
    SCIENCE_BROWSER_RULE,
    SPRINGERLINK_BROWSER_RULE,
    WILEY_BROWSER_RULE,
)

__all__ = (
    "ACS_BROWSER_RULE",
    "AIP_BROWSER_RULE",
    "BrowserActionKind",
    "BrowserArticleIdentityKind",
    "BrowserCaptureDisposition",
    "BrowserPageMarker",
    "BrowserPageMarkerKind",
    "BrowserRuleAction",
    "BrowserRuleCatalog",
    "BrowserSiteRule",
    "BROWSER_RULE_VERIFICATION_CATALOG",
    "ELSEVIER_BROWSER_RULE",
    "IOPSCIENCE_BROWSER_RULE",
    "OXFORD_ACADEMIC_BROWSER_RULE",
    "PRODUCTION_BROWSER_RULE_CATALOG",
    "RSC_BROWSER_RULE",
    "SCIENCE_BROWSER_RULE",
    "SPRINGERLINK_BROWSER_RULE",
    "WILEY_BROWSER_RULE",
)
