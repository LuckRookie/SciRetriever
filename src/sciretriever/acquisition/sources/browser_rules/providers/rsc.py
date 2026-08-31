"""Reviewed rsc Browser site rule."""

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

RSC_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="rsc-publishing-pdf",
    revision=3,
    landing_origin="https://pubs.rsc.org",
    allowed_origins=("https://pubs.rsc.org",),
    web_scope_provider_name="rsc-publishing",
    actions=pdf_actions(
        "a[href*='/content/articlepdf/'], a[title='Download PDF'], a[data-type='pdf']"
    ),
    page_markers=publisher_page_markers(
        "rsc",
        entitled_selectors=(
            "a[href*='/content/articlepdf/']",
            "a[title='Download PDF']",
            "a[data-type='pdf']",
        ),
        paywall_selectors=(
            "#access-denied",
            ".access-denied",
            "[class*='paywall']",
        ),
    ),
    capture_url_prefixes=("https://pubs.rsc.org/en/content/articlepdf/",),
    article_identity_kinds=(
        BrowserArticleIdentityKind.LANDING_PATH_STEM,
        BrowserArticleIdentityKind.LANDING_PATH_TOKEN,
    ),
    supplement_selectors=(
        "a[href*='suppdata']",
        "a[href*='supplementary']",
        "a[href*='supporting']",
    ),
    supplement_filename_markers=DEFAULT_SUPPLEMENT_FILENAME_MARKERS,
    excluded_filename_markers=DEFAULT_EXCLUDED_FILENAME_MARKERS,
    challenge_resource_profile=cloudflare_challenge_profile(),
)


__all__ = ("RSC_BROWSER_RULE",)
