"""Reviewed acs Browser site rule."""

from __future__ import annotations

from typing import Final

from ..helpers import (
    DEFAULT_EXCLUDED_FILENAME_MARKERS,
    DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    pdf_actions,
    publisher_page_markers,
)
from ..model import BrowserArticleIdentityKind, BrowserSiteRule

ACS_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="acs-publications-pdf",
    revision=2,
    landing_origin="https://pubs.acs.org",
    allowed_origins=("https://pubs.acs.org",),
    web_scope_provider_name="acs-publications",
    actions=pdf_actions(
        "a[href*='/doi/pdf/'], a[href*='/doi/epdf/'], a[data-test='pdf-link'], a[title='PDF']"
    ),
    doi_pdf_url_template="https://pubs.acs.org/doi/pdf/{doi}",
    max_actions=2,
    page_markers=publisher_page_markers(
        "acs",
        entitled_selectors=(
            "a[href*='/doi/pdf/']",
            "a[href*='/doi/epdf/']",
            "a[data-test='pdf-link']",
        ),
        paywall_selectors=(
            "[data-test='access-options']",
            ".article__access-denied",
            "[class*='paywall']",
        ),
    ),
    capture_url_prefixes=(
        "https://pubs.acs.org/doi/pdf/",
        "https://pubs.acs.org/doi/epdf/",
    ),
    article_identity_kinds=(BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,),
    article_id_namespaces=("doi",),
    supplement_filename_markers=DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
)


__all__ = ("ACS_BROWSER_RULE",)
