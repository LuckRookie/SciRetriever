"""Reviewed aip Browser site rule."""

from __future__ import annotations

from typing import Final

from ..helpers import (
    DEFAULT_EXCLUDED_FILENAME_MARKERS,
    DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    pdf_actions,
    publisher_page_markers,
)
from ..model import BrowserArticleIdentityKind, BrowserSiteRule

AIP_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="aip-publishing-pdf",
    revision=2,
    landing_origin="https://pubs.aip.org",
    allowed_origins=("https://pubs.aip.org",),
    web_scope_provider_name="aip-publishing",
    actions=pdf_actions("a[href*='/doi/epdf/'], a[href*='/doi/pdf/'], a[data-resource-type='pdf']"),
    doi_pdf_url_template="https://pubs.aip.org/doi/epdf/{doi}",
    max_actions=2,
    page_markers=publisher_page_markers(
        "aip",
        entitled_selectors=(
            "a[href*='/doi/epdf/']",
            "a[href*='/doi/pdf/']",
            "a[data-resource-type='pdf']",
        ),
        paywall_selectors=(
            "[data-test='access-options']",
            ".purchase-options",
            "[class*='paywall']",
        ),
    ),
    capture_url_prefixes=(
        "https://pubs.aip.org/doi/epdf/",
        "https://pubs.aip.org/doi/pdf/",
    ),
    article_identity_kinds=(BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,),
    article_id_namespaces=("doi",),
    supplement_filename_markers=DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
)


__all__ = ("AIP_BROWSER_RULE",)
