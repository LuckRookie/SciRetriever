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

ACS_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="acs-publications",
    platform_key="acs-publications",
    landing_origins=("https://pubs.acs.org",),
    asset_origins=("https://pubs.acs.org",),
    stable_locator_namespaces=(),
    provider_record_names=(),
    weak_doi_prefixes=("10.1021",),
    weak_publisher_names=("acs publications", "american chemical society"),
    public_route_keys=(),
    api_route_keys=(),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="acs-publications-terms-2021-05",
    production_status=ProfileProductionStatus.UNSUPPORTED,
    evidence=PublisherAccessEvidence(
        display_name="ACS Publications",
        product_name="ACS Publications article platform",
        official_references=(
            "https://pubs.acs.org/",
            "https://solutions.acs.org/solutions/text-and-data-mining/",
            (
                "https://solutions.acs.org/wp-content/uploads/2025/04/"
                "ACS-Publications-Terms-and-Conditions-of-Use.pdf"
            ),
        ),
        access_terms_references=(
            (
                "https://solutions.acs.org/wp-content/uploads/2025/04/"
                "ACS-Publications-Terms-and-Conditions-of-Use.pdf"
            ),
        ),
        rate_limit_references=(
            (
                "https://solutions.acs.org/wp-content/uploads/2025/04/"
                "ACS-Publications-Terms-and-Conditions-of-Use.pdf"
            ),
        ),
        verification_date=date(2026, 8, 15),
        evidence_revision="acs-browser-unsupported-2026-08-15",
        notes_reference="docs/notes/providers/acs.md",
        fixture_reference="tests/fixtures/acquisition/profiles/acs-publications.json",
    ),
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

ELSEVIER_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="elsevier-sciencedirect",
    platform_key="sciencedirect",
    landing_origins=(
        "https://www.sciencedirect.com",
        "https://linkinghub.elsevier.com",
    ),
    asset_origins=(
        "https://api.elsevier.com",
        "https://www.sciencedirect.com",
        "https://linkinghub.elsevier.com",
        "https://pdf.sciencedirectassets.com",
    ),
    stable_locator_namespaces=("pii", "elsevier-article-eid"),
    provider_record_names=(),
    weak_doi_prefixes=("10.1016",),
    weak_publisher_names=("elsevier", "science direct", "sciencedirect"),
    public_route_keys=(),
    api_route_keys=("api:elsevier-article-object",),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="elsevier-article-object-2026-08-15",
    production_status=ProfileProductionStatus.PRODUCTION_READY,
    evidence=PublisherAccessEvidence(
        display_name="Elsevier / ScienceDirect",
        product_name="Article Retrieval and Object Retrieval APIs",
        official_references=(
            "https://dev.elsevier.com/documentation/ArticleRetrievalAPI.wadl",
            "https://dev.elsevier.com/documentation/ObjectRetrievalAPI.wadl",
            "https://dev.elsevier.com/api_docs.html",
        ),
        access_terms_references=("https://dev.elsevier.com/policy.html",),
        rate_limit_references=("https://dev.elsevier.com/api_key_settings.html",),
        verification_date=date(2026, 8, 15),
        evidence_revision="elsevier-article-object-2026-08-15",
        notes_reference="docs/notes/providers/elsevier.md",
        fixture_reference=("tests/fixtures/acquisition/profiles/elsevier-sciencedirect.json"),
    ),
)

NATURE_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="nature-portfolio",
    platform_key="nature",
    landing_origins=("https://www.nature.com",),
    asset_origins=("https://www.nature.com",),
    stable_locator_namespaces=(),
    provider_record_names=(),
    weak_doi_prefixes=("10.1038",),
    weak_publisher_names=("nature portfolio", "nature publishing group"),
    public_route_keys=(),
    api_route_keys=(),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="springer-nature-tdm-2026-08-15",
    production_status=ProfileProductionStatus.UNSUPPORTED,
    evidence=PublisherAccessEvidence(
        display_name="Nature Portfolio",
        product_name="Nature.com article platform",
        official_references=(
            "https://www.nature.com/",
            "https://www.nature.com/info/terms-and-conditions",
            "https://www.springernature.com/gp/researchers/text-and-data-mining",
        ),
        access_terms_references=("https://www.nature.com/info/terms-and-conditions",),
        rate_limit_references=(
            "https://www.springernature.com/gp/researchers/text-and-data-mining",
        ),
        verification_date=date(2026, 8, 15),
        evidence_revision="nature-browser-unsupported-2026-08-15",
        notes_reference="docs/notes/providers/springer-nature.md",
        fixture_reference="tests/fixtures/acquisition/profiles/nature-portfolio.json",
    ),
)

RSC_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="rsc-publishing",
    platform_key="rsc-publishing",
    landing_origins=("https://pubs.rsc.org",),
    asset_origins=("https://pubs.rsc.org",),
    stable_locator_namespaces=(),
    provider_record_names=(),
    weak_doi_prefixes=("10.1039",),
    weak_publisher_names=("royal society of chemistry", "rsc publishing"),
    public_route_keys=(),
    api_route_keys=(),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="rsc-machine-access-2026-08-15",
    production_status=ProfileProductionStatus.UNSUPPORTED,
    evidence=PublisherAccessEvidence(
        display_name="RSC Publishing",
        product_name="Royal Society of Chemistry publishing platform",
        official_references=(
            "https://pubs.rsc.org/",
            (
                "https://www.rsc.org/publishing/product-information/"
                "product-catalogue/text-and-data-mining"
            ),
            (
                "https://www.rsc.org/publishing/product-information/"
                "access-and-usage/terms-and-conditions"
            ),
        ),
        access_terms_references=(
            (
                "https://www.rsc.org/publishing/product-information/"
                "access-and-usage/terms-and-conditions"
            ),
        ),
        rate_limit_references=(
            (
                "https://www.rsc.org/publishing/product-information/"
                "product-catalogue/text-and-data-mining"
            ),
        ),
        verification_date=date(2026, 8, 15),
        evidence_revision="rsc-browser-unsupported-2026-08-15",
        notes_reference="docs/notes/providers/rsc.md",
        fixture_reference="tests/fixtures/acquisition/profiles/rsc-publishing.json",
    ),
)

SPRINGERLINK_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="springerlink",
    platform_key="springerlink",
    landing_origins=("https://link.springer.com",),
    asset_origins=("https://link.springer.com",),
    stable_locator_namespaces=(),
    provider_record_names=(),
    weak_doi_prefixes=("10.1007",),
    weak_publisher_names=("springer", "springerlink"),
    public_route_keys=(),
    api_route_keys=(),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="springer-nature-tdm-2026-08-15",
    production_status=ProfileProductionStatus.UNSUPPORTED,
    evidence=PublisherAccessEvidence(
        display_name="Springer Nature Link",
        product_name="Springer Nature Link article platform",
        official_references=(
            "https://link.springer.com/",
            "https://link.springer.com/termsandconditions",
            "https://www.springernature.com/gp/researchers/text-and-data-mining",
        ),
        access_terms_references=("https://link.springer.com/termsandconditions",),
        rate_limit_references=(
            "https://www.springernature.com/gp/researchers/text-and-data-mining",
        ),
        verification_date=date(2026, 8, 15),
        evidence_revision="springerlink-browser-unsupported-2026-08-15",
        notes_reference="docs/notes/providers/springer-nature.md",
        fixture_reference="tests/fixtures/acquisition/profiles/springerlink.json",
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
        profiles=PublisherAccessProfileCatalog(
            (
                ACS_ACCESS_PROFILE,
                CORE_ACCESS_PROFILE,
                ELSEVIER_ACCESS_PROFILE,
                NATURE_ACCESS_PROFILE,
                RSC_ACCESS_PROFILE,
                SPRINGERLINK_ACCESS_PROFILE,
                WILEY_ACCESS_PROFILE,
            )
        ),
        browser_rules=PRODUCTION_BROWSER_RULE_CATALOG,
    )
)
PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG: Final[PublisherAccessProfileCatalog] = (
    PUBLISHER_ACCESS_VERIFICATION_MATRIX.production_profiles
)


__all__ = (
    "ACS_ACCESS_PROFILE",
    "CORE_ACCESS_PROFILE",
    "ELSEVIER_ACCESS_PROFILE",
    "NATURE_ACCESS_PROFILE",
    "PUBLISHER_ACCESS_VERIFICATION_MATRIX",
    "PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG",
    "RSC_ACCESS_PROFILE",
    "SPRINGERLINK_ACCESS_PROFILE",
    "WILEY_ACCESS_PROFILE",
)
