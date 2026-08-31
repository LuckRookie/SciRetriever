"""Reviewed elsevier Browser site rule."""

from __future__ import annotations

from typing import Final

from ..helpers import (
    DEFAULT_EXCLUDED_FILENAME_MARKERS,
    cloudflare_challenge_profile,
    pdf_actions,
    publisher_page_markers,
)
from ..model import BrowserArticleIdentityKind, BrowserSiteRule

ELSEVIER_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="sciencedirect-pdf",
    revision=3,
    landing_origin="https://www.sciencedirect.com",
    allowed_origins=(
        "https://www.sciencedirect.com",
        "https://linkinghub.elsevier.com",
        "https://pdf.sciencedirectassets.com",
        "https://id.elsevier.com",
        "https://auth.elsevier.com",
    ),
    web_scope_provider_name="elsevier",
    landing_origin_aliases=("https://linkinghub.elsevier.com",),
    actions=pdf_actions(
        "a.pdf-download-btn-link, a[href$='/pdfft'], a[href*='/pdfft?'], button[aria-label*='PDF']"
    ),
    page_markers=publisher_page_markers(
        "sciencedirect",
        entitled_selectors=(
            "a.pdf-download-btn-link",
            "a[href$='/pdfft']",
            "a[href*='/pdfft?']",
        ),
        paywall_selectors=(
            "[data-aa-region='access-module']",
            ".access-module",
            "[data-testid='access-denied']",
        ),
        login_url_prefixes=(
            "https://id.elsevier.com/as/authorization.oauth2",
            "https://auth.elsevier.com/shibauth",
        ),
    ),
    capture_url_prefixes=("https://www.sciencedirect.com/science/article/pii/",),
    capture_origin_roots=("https://pdf.sciencedirectassets.com",),
    capture_root_filename_markers=("main",),
    article_identity_kinds=(
        BrowserArticleIdentityKind.LANDING_PATH_STEM,
        BrowserArticleIdentityKind.LANDING_PATH_TOKEN,
        BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,
    ),
    article_id_namespaces=("pii", "elsevier-article-eid"),
    supplement_filename_markers=(
        "mmc",
        "supp",
        "supplement",
        "supplementary",
        "supporting",
    ),
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
    challenge_resource_profile=cloudflare_challenge_profile(),
)


__all__ = ("ELSEVIER_BROWSER_RULE",)
