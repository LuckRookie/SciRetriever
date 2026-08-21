"""Shared declarative helpers for reviewed publisher Browser rules."""

from __future__ import annotations

from typing import Final

from .model import (
    BrowserActionKind,
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
            kind=BrowserPageMarkerKind.CHALLENGE_REQUIRED,
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
    "pdf_actions",
    "publisher_page_markers",
)
