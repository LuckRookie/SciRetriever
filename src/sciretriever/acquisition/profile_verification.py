"""Fail-closed admission gate for publisher access profiles.

The profile catalog, executable Browser rule catalog, Provider policy, and
offline evidence fixture are intentionally separate artifacts.  This module
is the single place that proves they identify the same access party and rule
revision before a profile can be selected for production assembly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit

from sciretriever.acquisition.access_profiles import (
    ProfileProductionStatus,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
    normalize_profile_origin,
)
from sciretriever.acquisition.sources.browser_rules import (
    BrowserArticleIdentityKind,
    BrowserPageMarkerKind,
    BrowserRuleCatalog,
    BrowserSiteRule,
)

_REQUIRED_BROWSER_MARKER_GROUPS: Final[tuple[frozenset[BrowserPageMarkerKind], ...]] = (
    frozenset(
        {
            BrowserPageMarkerKind.AUTHENTICATED,
            BrowserPageMarkerKind.ENTITLED,
        }
    ),
    frozenset({BrowserPageMarkerKind.LOGIN_REQUIRED}),
    frozenset(
        {
            BrowserPageMarkerKind.NOT_ENTITLED,
            BrowserPageMarkerKind.PAYWALL,
        }
    ),
    frozenset(
        {
            BrowserPageMarkerKind.MFA_REQUIRED,
            BrowserPageMarkerKind.CHALLENGE_REQUIRED,
            BrowserPageMarkerKind.RATE_LIMITED,
            BrowserPageMarkerKind.IP_BLOCKED,
            BrowserPageMarkerKind.ACCOUNT_WARNING,
        }
    ),
)


class PublisherProfileVerificationError(ValueError):
    """A profile evidence package and its executable rule do not align."""


def _prefix_origin(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.hostname is None:
        raise PublisherProfileVerificationError("profile-capture-origin-invalid")
    port = parsed.port
    authority = parsed.hostname if port in {None, 443} else f"{parsed.hostname}:{port}"
    try:
        return normalize_profile_origin(f"{parsed.scheme}://{authority}")
    except (TypeError, ValueError):
        raise PublisherProfileVerificationError("profile-capture-origin-invalid") from None


def _rule_by_id(catalog: BrowserRuleCatalog) -> dict[str, BrowserSiteRule]:
    return {rule.rule_id: rule for rule in catalog.rules}


def _validate_rule_alignment(
    profile: PublisherAccessProfile,
    rule: BrowserSiteRule,
) -> None:
    if profile.browser_rule_revision != rule.revision:
        raise PublisherProfileVerificationError("profile-browser-rule-revision-mismatch")
    if profile.landing_origins != (rule.landing_origin,):
        raise PublisherProfileVerificationError("profile-browser-landing-origin-mismatch")
    if profile.browser_allowed_origins != rule.allowed_origins:
        raise PublisherProfileVerificationError("profile-browser-allowed-origins-mismatch")
    if profile.browser_rate_limit_group != rule.web_scope_provider_name:
        raise PublisherProfileVerificationError("profile-browser-risk-scope-mismatch")
    capture_origins = {
        _prefix_origin(prefix)
        for prefix in (
            *rule.capture_url_prefixes,
            *rule.supplement_url_prefixes,
            *rule.excluded_url_prefixes,
        )
    }
    if not capture_origins.issubset(profile.asset_origins):
        raise PublisherProfileVerificationError("profile-browser-asset-origin-mismatch")
    if BrowserArticleIdentityKind.IDENTIFIER_IN_PATH in rule.article_identity_kinds and not set(
        rule.article_id_namespaces
    ).issubset(profile.stable_locator_namespaces):
        raise PublisherProfileVerificationError("profile-browser-article-identity-mismatch")
    if not rule.capture_url_prefixes:
        raise PublisherProfileVerificationError("profile-browser-primary-capture-missing")
    _validate_doi_locator_alignment(profile, rule)
    if not (
        rule.supplement_url_prefixes
        or rule.supplement_selectors
        or rule.supplement_filename_markers
    ):
        raise PublisherProfileVerificationError("profile-browser-supplement-rule-missing")
    marker_kinds = frozenset(marker.kind for marker in rule.page_markers)
    if any(not marker_kinds.intersection(group) for group in _REQUIRED_BROWSER_MARKER_GROUPS):
        raise PublisherProfileVerificationError("profile-browser-page-state-marker-missing")


def _validate_doi_locator_alignment(
    profile: PublisherAccessProfile,
    rule: BrowserSiteRule,
) -> None:
    if rule.doi_pdf_url_template is not None and "doi" not in profile.stable_locator_namespaces:
        raise PublisherProfileVerificationError("profile-browser-doi-locator-mismatch")


@dataclass(frozen=True, slots=True)
class PublisherAccessVerificationMatrix:
    """A complete three-state matrix and its reviewed Browser rules."""

    profiles: PublisherAccessProfileCatalog
    browser_rules: BrowserRuleCatalog

    def __post_init__(self) -> None:
        if not isinstance(self.profiles, PublisherAccessProfileCatalog):
            raise TypeError("profiles must be a PublisherAccessProfileCatalog")
        if not isinstance(self.browser_rules, BrowserRuleCatalog):
            raise TypeError("browser_rules must be a BrowserRuleCatalog")
        fixture_references = tuple(profile.evidence.fixture_reference for profile in self.profiles)
        if len(fixture_references) != len(set(fixture_references)):
            raise PublisherProfileVerificationError("profile-fixture-reference-duplicate")
        by_rule_id = _rule_by_id(self.browser_rules)
        referenced_rule_ids: list[str] = []
        for profile in self.profiles:
            if profile.browser_route_key is None:
                continue
            rule_id = profile.browser_rule_id
            if rule_id is None:
                raise PublisherProfileVerificationError("profile-browser-rule-reference-missing")
            rule = by_rule_id.get(rule_id)
            if rule is None:
                raise PublisherProfileVerificationError("profile-browser-rule-not-installed")
            _validate_rule_alignment(profile, rule)
            referenced_rule_ids.append(rule_id)
        if len(referenced_rule_ids) != len(set(referenced_rule_ids)):
            raise PublisherProfileVerificationError("profile-browser-rule-reference-duplicate")
        if set(referenced_rule_ids) != set(by_rule_id):
            raise PublisherProfileVerificationError("profile-browser-rule-unreferenced")

    @property
    def production_profiles(self) -> PublisherAccessProfileCatalog:
        """Return only independently production-ready profiles."""

        return PublisherAccessProfileCatalog(
            tuple(
                profile
                for profile in self.profiles
                if profile.production_status is ProfileProductionStatus.PRODUCTION_READY
            )
        )

    @property
    def production_browser_rules(self) -> BrowserRuleCatalog:
        """Return rules referenced by independently production-ready profiles."""

        production_rule_ids = frozenset(
            profile.browser_rule_id
            for profile in self.profiles
            if profile.production_status is ProfileProductionStatus.PRODUCTION_READY
            and profile.browser_rule_id is not None
        )
        return BrowserRuleCatalog(
            tuple(rule for rule in self.browser_rules.rules if rule.rule_id in production_rule_ids)
        )


__all__ = (
    "PublisherAccessVerificationMatrix",
    "PublisherProfileVerificationError",
)
