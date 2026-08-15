"""Production publisher/access profile catalog.

Only capabilities with current repository evidence are declared here.  A
profile can be useful for public/API planning without implying that a Browser
route is production-ready.
"""

from __future__ import annotations

from datetime import date
from typing import Final

from sciretriever.acquisition.access_profiles import (
    PolicyEvidence,
    ProfileProductionStatus,
    PublisherAccessEvidence,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
)
from sciretriever.acquisition.profile_verification import PublisherAccessVerificationMatrix
from sciretriever.acquisition.sources.browser_rules import PRODUCTION_BROWSER_RULE_CATALOG

CORE_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="core-open-access",
    platform_key="core-api",
    landing_origins=("https://core.ac.uk",),
    asset_origins=("https://api.core.ac.uk", "https://core.ac.uk"),
    stable_locator_namespaces=(),
    provider_record_names=("core",),
    weak_doi_prefixes=(),
    weak_publisher_names=(),
    public_route_keys=(),
    api_route_keys=("api:core",),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="core-v3-2026-08-13",
    production_status=ProfileProductionStatus.PRODUCTION_READY,
    evidence=PublisherAccessEvidence(
        display_name="CORE",
        product_name="CORE API v3",
        official_references=(
            "https://api.core.ac.uk/docs/v3",
            "https://api.core.ac.uk/swagger/v3.json",
            "https://core.ac.uk/services/api",
        ),
        access_terms_references=("https://core.ac.uk/terms",),
        rate_limit_references=("https://api.core.ac.uk/docs/v3",),
        verification_date=date(2026, 8, 15),
        evidence_revision="core-v3-2026-08-15",
        notes_reference="docs/notes/providers/core.md",
        fixture_reference="tests/fixtures/acquisition/profiles/core-open-access.json",
    ),
)

WILEY_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="wiley-online-library",
    platform_key="wiley-online-library",
    landing_origins=("https://onlinelibrary.wiley.com",),
    asset_origins=(
        "https://onlinelibrary.wiley.com",
        "https://alm.wiley.com",
    ),
    stable_locator_namespaces=(),
    provider_record_names=("wiley",),
    weak_doi_prefixes=("10.1002",),
    weak_publisher_names=("wiley",),
    public_route_keys=(),
    api_route_keys=("api:wiley-tdm-v1",),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="wiley-tdm-v1-client-1.2.0-2026-08-13",
    production_status=ProfileProductionStatus.PRODUCTION_READY,
    evidence=PublisherAccessEvidence(
        display_name="Wiley Online Library",
        product_name="Wiley Online Library TDM API v1",
        official_references=(
            "https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining",
            "https://github.com/WileyLabs/tdm-client",
            "https://static.wiley.com/tdm/",
        ),
        access_terms_references=(
            "https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining",
        ),
        rate_limit_references=("https://github.com/WileyLabs/tdm-client",),
        verification_date=date(2026, 8, 15),
        evidence_revision="wiley-tdm-v1-client-1.2.0-2026-08-15",
        notes_reference="docs/notes/providers/wiley.md",
        fixture_reference="tests/fixtures/acquisition/profiles/wiley-online-library.json",
    ),
)

PUBLISHER_ACCESS_VERIFICATION_MATRIX: Final[PublisherAccessVerificationMatrix] = (
    PublisherAccessVerificationMatrix(
        profiles=PublisherAccessProfileCatalog((CORE_ACCESS_PROFILE, WILEY_ACCESS_PROFILE)),
        browser_rules=PRODUCTION_BROWSER_RULE_CATALOG,
    )
)
PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG: Final[PublisherAccessProfileCatalog] = (
    PUBLISHER_ACCESS_VERIFICATION_MATRIX.production_profiles
)


__all__ = (
    "CORE_ACCESS_PROFILE",
    "PUBLISHER_ACCESS_VERIFICATION_MATRIX",
    "PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG",
    "WILEY_ACCESS_PROFILE",
)
