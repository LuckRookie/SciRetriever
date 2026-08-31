"""Reviewed oxford academic Browser site rule."""

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

OXFORD_ACADEMIC_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="oxford-academic-pdf",
    revision=3,
    landing_origin="https://academic.oup.com",
    allowed_origins=("https://academic.oup.com",),
    web_scope_provider_name="oxford-academic",
    actions=pdf_actions("a[href*='/doi/pdf/'], a[href*='/doi/epdf/'], a[href*='/article-pdf/']"),
    doi_pdf_url_template="https://academic.oup.com/doi/pdf/{doi}",
    page_markers=publisher_page_markers(
        "oxford",
        entitled_selectors=(
            "a[href*='/doi/pdf/']",
            "a[href*='/doi/epdf/']",
            "a[href*='/article-pdf/']",
        ),
        paywall_selectors=(
            "[data-test='access-options']",
            ".purchase-options",
            "[class*='paywall']",
        ),
    ),
    capture_url_prefixes=(
        "https://academic.oup.com/doi/pdf/",
        "https://academic.oup.com/doi/epdf/",
        "https://academic.oup.com/article-pdf/",
    ),
    article_identity_kinds=(
        BrowserArticleIdentityKind.LANDING_PATH_STEM,
        BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,
    ),
    article_id_namespaces=("doi",),
    supplement_filename_markers=DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
    challenge_resource_profile=cloudflare_challenge_profile(),
)


__all__ = ("OXFORD_ACADEMIC_BROWSER_RULE",)
