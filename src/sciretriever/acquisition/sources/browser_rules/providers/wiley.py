"""Reviewed wiley Browser site rule."""

from __future__ import annotations

from typing import Final

from ..helpers import (
    DEFAULT_EXCLUDED_FILENAME_MARKERS,
    DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    pdf_actions,
    publisher_page_markers,
)
from ..model import BrowserArticleIdentityKind, BrowserSiteRule

WILEY_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="wiley-online-library-pdf",
    revision=2,
    landing_origin="https://onlinelibrary.wiley.com",
    allowed_origins=(
        "https://onlinelibrary.wiley.com",
        "https://advanced.onlinelibrary.wiley.com",
    ),
    web_scope_provider_name="wiley",
    landing_origin_aliases=("https://advanced.onlinelibrary.wiley.com",),
    actions=pdf_actions(
        "a[href*='/doi/pdfdirect/'], a[href*='/doi/pdf/'], "
        "a[href*='/doi/epdf/'], a[data-test='pdf-link']"
    ),
    doi_pdf_url_template="https://onlinelibrary.wiley.com/doi/pdfdirect/{doi}",
    max_actions=2,
    page_markers=publisher_page_markers(
        "wiley",
        entitled_selectors=(
            "a[href*='/doi/pdfdirect/']",
            "a[href*='/doi/pdf/']",
            "a[href*='/doi/epdf/']",
            "a[data-test='pdf-link']",
        ),
        paywall_selectors=(
            "[data-test='access-options']",
            ".access-denied",
            "[class*='paywall']",
        ),
    ),
    capture_url_prefixes=(
        "https://onlinelibrary.wiley.com/doi/pdfdirect/",
        "https://onlinelibrary.wiley.com/doi/pdf/",
        "https://onlinelibrary.wiley.com/doi/epdf/",
        "https://advanced.onlinelibrary.wiley.com/doi/pdfdirect/",
        "https://advanced.onlinelibrary.wiley.com/doi/pdf/",
        "https://advanced.onlinelibrary.wiley.com/doi/epdf/",
    ),
    article_identity_kinds=(BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,),
    article_id_namespaces=("doi",),
    supplement_filename_markers=DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
)


__all__ = ("WILEY_BROWSER_RULE",)
