"""Explicit verification and production admission catalogs for Browser rules."""

from __future__ import annotations

from typing import Final

from .model import BrowserRuleCatalog
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

BROWSER_RULE_VERIFICATION_CATALOG: Final[BrowserRuleCatalog] = BrowserRuleCatalog(
    (
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
)

# Only rules whose implementation and current access-policy evidence are
# admitted to the production object graph belong here. Catalog membership
# permits the reviewed, paced IP-entitled Browser attempt; it never asserts
# that the current machine is entitled to a particular article.
PRODUCTION_BROWSER_RULE_CATALOG: Final[BrowserRuleCatalog] = BrowserRuleCatalog(
    (
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
)

__all__ = (
    "BROWSER_RULE_VERIFICATION_CATALOG",
    "PRODUCTION_BROWSER_RULE_CATALOG",
)
