"""Reviewed Springer Nature Link Browser site rule."""

from __future__ import annotations

from typing import Final

from ..model import (
    BrowserActionKind,
    BrowserArticleIdentityKind,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserSiteRule,
)

SPRINGERLINK_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="springerlink-pdf",
    revision=5,
    landing_origin="https://link.springer.com",
    allowed_origins=(
        "https://link.springer.com",
        "https://static-content.springer.com",
        "https://idp.springer.com",
        "https://wayf.springernature.com",
    ),
    web_scope_provider_name="springerlink",
    actions=(
        BrowserRuleAction(
            kind=BrowserActionKind.CLICK,
            selector=(
                "a[href*='/content/pdf/'], "
                "a[data-track-action='download pdf'], "
                "a.c-pdf-download__link"
            ),
        ),
        BrowserRuleAction(
            kind=BrowserActionKind.WAIT_FOR_ANY_CAPTURE,
        ),
    ),
    actions_require_entitlement=True,
    doi_pdf_url_template="https://link.springer.com/content/pdf/{doi}.pdf",
    page_markers=(
        BrowserPageMarker(
            marker_id="springerlink-entitled",
            kind=BrowserPageMarkerKind.ENTITLED,
            css_selectors=(
                "a[href*='/content/pdf/']",
                "a[data-track-action='download pdf']",
                "a.c-pdf-download__link",
            ),
        ),
        BrowserPageMarker(
            marker_id="springerlink-login-required",
            kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            url_prefixes=(
                "https://link.springer.com/login",
                "https://idp.springer.com/authorize",
            ),
        ),
        BrowserPageMarker(
            marker_id="springerlink-paywall",
            kind=BrowserPageMarkerKind.PAYWALL,
            css_selectors=("[data-test='access-options']",),
        ),
        BrowserPageMarker(
            marker_id="springerlink-mfa-required",
            kind=BrowserPageMarkerKind.MFA_REQUIRED,
            url_prefixes=("https://wayf.springernature.com/mfa",),
        ),
        BrowserPageMarker(
            marker_id="springerlink-challenge",
            kind=BrowserPageMarkerKind.CHALLENGE,
            css_selectors=("#challenge-running",),
            text_markers=(
                ("title", "just a moment"),
                ("body", "verify you are human"),
                ("body", "checking your browser"),
                ("body", "captcha"),
            ),
        ),
        BrowserPageMarker(
            marker_id="springerlink-rate-limited",
            kind=BrowserPageMarkerKind.RATE_LIMITED,
            response_statuses=(429,),
        ),
        BrowserPageMarker(
            marker_id="springerlink-access-denied",
            kind=BrowserPageMarkerKind.ACCESS_DENIED,
            response_statuses=(403,),
        ),
        BrowserPageMarker(
            marker_id="springerlink-account-warning",
            kind=BrowserPageMarkerKind.ACCOUNT_WARNING,
            css_selectors=("[data-test='account-warning']",),
        ),
        BrowserPageMarker(
            marker_id="springerlink-not-found",
            kind=BrowserPageMarkerKind.NOT_FOUND,
            response_statuses=(404,),
        ),
    ),
    capture_url_prefixes=("https://link.springer.com/content/pdf/",),
    article_identity_kinds=(BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,),
    article_id_namespaces=("doi",),
    supplement_url_prefixes=("https://static-content.springer.com/esm/",),
    supplement_filename_markers=("supplement", "mediaobjects"),
    excluded_url_prefixes=("https://link.springer.com/content/pdf/book-cover/",),
    excluded_filename_markers=("frontmatter", "sample"),
)


__all__ = ("SPRINGERLINK_BROWSER_RULE",)
