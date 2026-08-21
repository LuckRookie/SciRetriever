"""Reviewed iopscience Browser site rule."""

from __future__ import annotations

from typing import Final

from ..helpers import (
    DEFAULT_EXCLUDED_FILENAME_MARKERS,
    DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    pdf_actions,
    publisher_page_markers,
)
from ..model import BrowserArticleIdentityKind, BrowserSiteRule

IOPSCIENCE_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="iopscience-pdf",
    revision=2,
    landing_origin="https://iopscience.iop.org",
    allowed_origins=("https://iopscience.iop.org",),
    web_scope_provider_name="iopscience",
    actions=pdf_actions(
        "a[href$='/pdf'], a[href*='/article/'][href*='/pdf'], a[data-test='pdf-download']"
    ),
    doi_pdf_url_template="https://iopscience.iop.org/article/{doi}/pdf",
    max_actions=2,
    page_markers=publisher_page_markers(
        "iopscience",
        entitled_selectors=(
            "a[href$='/pdf']",
            "a[href*='/article/'][href*='/pdf']",
            "a[data-test='pdf-download']",
        ),
        paywall_selectors=(
            "[data-test='access-options']",
            ".access-denied",
            "[class*='paywall']",
        ),
    ),
    capture_url_prefixes=("https://iopscience.iop.org/article/",),
    article_identity_kinds=(BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,),
    article_id_namespaces=("doi",),
    supplement_filename_markers=DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
)


__all__ = ("IOPSCIENCE_BROWSER_RULE",)
