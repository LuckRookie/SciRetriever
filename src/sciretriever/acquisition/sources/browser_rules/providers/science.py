"""Reviewed science Browser site rule."""

from __future__ import annotations

from typing import Final

from ..helpers import (
    DEFAULT_EXCLUDED_FILENAME_MARKERS,
    DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    cloudflare_challenge_profile,
    pdf_actions,
    publisher_page_markers,
)
from ..model import BrowserArticleIdentityKind, BrowserSiteRule

SCIENCE_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="science-aaas-pdf",
    revision=3,
    landing_origin="https://www.science.org",
    allowed_origins=("https://www.science.org",),
    web_scope_provider_name="science-aaas",
    actions=pdf_actions("a[href*='/doi/epdf/'], a[href*='/doi/pdf/'], a[data-test='pdf-link']"),
    doi_pdf_url_template="https://www.science.org/doi/epdf/{doi}",
    page_markers=publisher_page_markers(
        "science",
        entitled_selectors=(
            "a[href*='/doi/epdf/']",
            "a[href*='/doi/pdf/']",
            "a[data-test='pdf-link']",
        ),
        paywall_selectors=(
            "[data-test='access-options']",
            ".access-denied",
            "[class*='paywall']",
        ),
    ),
    capture_url_prefixes=(
        "https://www.science.org/doi/epdf/",
        "https://www.science.org/doi/pdf/",
    ),
    article_identity_kinds=(BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,),
    article_id_namespaces=("doi",),
    supplement_filename_markers=DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
    challenge_resource_profile=cloudflare_challenge_profile(),
)


__all__ = ("SCIENCE_BROWSER_RULE",)
