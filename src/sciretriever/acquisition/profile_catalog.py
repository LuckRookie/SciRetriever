"""Production publisher/access profile catalog.

Only capabilities with current repository evidence are declared here.  A
profile can be useful for public/API planning without implying that a Browser
route is production-ready.
"""

from __future__ import annotations

from typing import Final

from sciretriever.acquisition.access_profiles import (
    PolicyEvidence,
    ProfileProductionStatus,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
)

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
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="core-v3-2026-08-13",
    notes_reference="docs/notes/providers/core.md",
    production_status=ProfileProductionStatus.PUBLIC_API_ONLY,
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
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="wiley-tdm-v1-client-1.2.0-2026-08-13",
    notes_reference="docs/notes/providers/wiley.md",
    production_status=ProfileProductionStatus.PUBLIC_API_ONLY,
)

PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG: Final[PublisherAccessProfileCatalog] = (
    PublisherAccessProfileCatalog((CORE_ACCESS_PROFILE, WILEY_ACCESS_PROFILE))
)


__all__ = (
    "CORE_ACCESS_PROFILE",
    "PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG",
    "WILEY_ACCESS_PROFILE",
)
