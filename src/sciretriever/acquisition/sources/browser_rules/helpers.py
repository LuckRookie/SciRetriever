"""Shared declarative helpers for reviewed publisher Browser rules."""

from __future__ import annotations

from typing import Final

from .model import (
    BrowserActionKind,
    BrowserChallengeResourceProfile,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
)

DEFAULT_SUPPLEMENT_FILENAME_MARKERS: Final[tuple[str, ...]] = (
    "supp",
    "supplement",
    "supplementary",
    "supporting",
    "additional",
    "appendix",
    "esi",
)
DEFAULT_EXCLUDED_FILENAME_MARKERS: Final[tuple[str, ...]] = (
    "cover",
    "frontmatter",
    "preview",
    "sample",
)


def cloudflare_challenge_profile() -> BrowserChallengeResourceProfile:
    """Return the closed Cloudflare dependency used by verified rules.

    The profile is intentionally a factory so each Provider rule owns an
    immutable value that participates in that rule's revision fingerprint.
    It does not add the challenge origin to the Publisher origin allow-list.
    """

    return BrowserChallengeResourceProfile(
        origin="https://challenges.cloudflare.com",
        # Cloudflare's documented Turnstile client script is rooted at the
        # fixed ``/turnstile/v0/`` family.  Keep this alongside the existing
        # challenge-platform family; the profile remains path- and
        # resource-type-closed and does not admit the whole challenge origin.
        path_prefixes=(
            "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/",
            "https://challenges.cloudflare.com/turnstile/v0/",
        ),
        resource_types=("script", "document", "fetch", "xhr", "image"),
        interaction_selectors=(
            "#challenge-form",
            "[data-captcha]",
            "iframe[src*='captcha']",
        ),
        settling_selectors=(
            "#challenge-running",
            ".cf-challenge-running",
        ),
    )


def pdf_actions(selector: str) -> tuple[BrowserRuleAction, ...]:
    return (
        BrowserRuleAction(
            kind=BrowserActionKind.CLICK,
            selector=selector,
        ),
        BrowserRuleAction(
            kind=BrowserActionKind.WAIT_FOR_ANY_CAPTURE,
        ),
    )


def publisher_page_markers(
    provider: str,
    *,
    entitled_selectors: tuple[str, ...],
    paywall_selectors: tuple[str, ...],
    login_url_prefixes: tuple[str, ...] = (),
) -> tuple[BrowserPageMarker, ...]:
    return (
        BrowserPageMarker(
            marker_id=f"{provider}-entitled",
            kind=BrowserPageMarkerKind.ENTITLED,
            css_selectors=entitled_selectors,
        ),
        BrowserPageMarker(
            marker_id=f"{provider}-login-required",
            kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            css_selectors=(
                "form[action*='login']",
                "form[action*='signin']",
                "[data-test='login-form']",
                "#loginForm",
            ),
            url_prefixes=login_url_prefixes,
        ),
        BrowserPageMarker(
            marker_id=f"{provider}-paywall",
            kind=BrowserPageMarkerKind.PAYWALL,
            css_selectors=paywall_selectors,
        ),
        BrowserPageMarker(
            marker_id=f"{provider}-challenge",
            kind=BrowserPageMarkerKind.CHALLENGE,
            css_selectors=(
                "#challenge-running",
                "#challenge-form",
                ".cf-challenge-running",
                "[data-captcha]",
                "iframe[src*='captcha']",
            ),
            text_markers=(
                ("title", "just a moment"),
                ("body", "verify you are human"),
                ("body", "checking your browser"),
                ("body", "security check required"),
                ("body", "captcha"),
            ),
        ),
        BrowserPageMarker(
            marker_id=f"{provider}-rate-limited",
            kind=BrowserPageMarkerKind.RATE_LIMITED,
            response_statuses=(429,),
        ),
        BrowserPageMarker(
            marker_id=f"{provider}-access-denied",
            kind=BrowserPageMarkerKind.ACCESS_DENIED,
            response_statuses=(403,),
        ),
        BrowserPageMarker(
            marker_id=f"{provider}-not-found",
            kind=BrowserPageMarkerKind.NOT_FOUND,
            response_statuses=(404,),
        ),
    )


__all__ = (
    "DEFAULT_EXCLUDED_FILENAME_MARKERS",
    "DEFAULT_SUPPLEMENT_FILENAME_MARKERS",
    "cloudflare_challenge_profile",
    "pdf_actions",
    "publisher_page_markers",
)
