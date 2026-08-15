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

ACM_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="acm-digital-library",
    platform_key="acm-digital-library",
    landing_origins=("https://dl.acm.org",),
    asset_origins=("https://dl.acm.org",),
    stable_locator_namespaces=(),
    provider_record_names=(),
    weak_doi_prefixes=("10.1145",),
    weak_publisher_names=("acm", "association for computing machinery"),
    public_route_keys=(),
    api_route_keys=(),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="acm-dl-open-access-and-usage-2026-08-15",
    production_status=ProfileProductionStatus.UNSUPPORTED,
    evidence=PublisherAccessEvidence(
        display_name="ACM Digital Library",
        product_name="ACM Digital Library Basic and Premium",
        official_references=(
            "https://www.acm.org/publications/openaccess",
            "https://libraries.acm.org/digital-library/platform-and-features",
            "https://libraries.acm.org/digital-library/policies",
            "https://libraries.acm.org/subscriptions-access/authentication",
            "https://dl.acm.org/robots.txt",
        ),
        access_terms_references=("https://libraries.acm.org/digital-library/policies",),
        rate_limit_references=(
            "https://libraries.acm.org/digital-library/policies",
            "https://dl.acm.org/robots.txt",
        ),
        verification_date=date(2026, 8, 15),
        evidence_revision="acm-dl-automated-access-unsupported-2026-08-15",
        notes_reference="docs/notes/providers/acm.md",
        fixture_reference="tests/fixtures/acquisition/profiles/acm-digital-library.json",
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

IEEE_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="ieee-xplore",
    platform_key="ieee-xplore",
    landing_origins=("https://ieeexplore.ieee.org",),
    asset_origins=("https://ieeexplore.ieee.org",),
    stable_locator_namespaces=("ieee-arnumber",),
    provider_record_names=(),
    weak_doi_prefixes=("10.1109",),
    weak_publisher_names=("ieee", "institute of electrical and electronics engineers"),
    public_route_keys=(),
    api_route_keys=(),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="ieee-xplore-api-terms-2026-08-15",
    production_status=ProfileProductionStatus.UNSUPPORTED,
    evidence=PublisherAccessEvidence(
        display_name="IEEE Xplore",
        product_name="IEEE Xplore article and Full-Text Access platform",
        official_references=(
            "https://ieeexplore.ieee.org/",
            "https://developer.ieee.org/docs",
            "https://developer.ieee.org/Chargeable_Full_Text_Requests",
        ),
        access_terms_references=("https://developer.ieee.org/API_Terms_of_Use2",),
        rate_limit_references=("https://developer.ieee.org/API_Terms_of_Use2",),
        verification_date=date(2026, 8, 15),
        evidence_revision="ieee-access-unsupported-2026-08-15",
        notes_reference="docs/notes/providers/ieee.md",
        fixture_reference="tests/fixtures/acquisition/profiles/ieee-xplore.json",
    ),
)

IOP_ACCESS_PROFILE: Final[PublisherAccessProfile] = PublisherAccessProfile(
    access_key="iopscience",
    platform_key="iopscience",
    landing_origins=("https://iopscience.iop.org",),
    asset_origins=("https://iopscience.iop.org",),
    stable_locator_namespaces=(),
    provider_record_names=(),
    weak_doi_prefixes=("10.1088",),
    weak_publisher_names=(
        "iop publishing",
        "institute of physics publishing",
        "iopscience",
    ),
    public_route_keys=(),
    api_route_keys=(),
    browser_route_key=None,
    browser_allowed_origins=(),
    browser_rate_limit_group=None,
    browser_session_key=None,
    browser_rule_id=None,
    browser_rule_revision=None,
    policy_evidence=PolicyEvidence.OFFICIAL,
    policy_revision="iop-tdm-policy-2026-07",
    production_status=ProfileProductionStatus.UNSUPPORTED,
    evidence=PublisherAccessEvidence(
        display_name="IOPscience",
        product_name="IOPscience journals platform",
        official_references=(
            "https://ioppublishing.org/legal/textanddataminingpolicy/",
            "https://ioppublishing.org/terms-conditions/",
            "https://ioppublishing.org/librarians/licencing/",
            (
                "https://ioppublishing.org/news/"
                "iop-publishing-collaborates-with-openathens-and-seamlessaccess-"
                "to-improve-user-experience/"
            ),
            "https://iopscience.iop.org/robots.txt",
        ),
        access_terms_references=(
            "https://ioppublishing.org/legal/textanddataminingpolicy/",
            "https://ioppublishing.org/terms-conditions/",
        ),
        rate_limit_references=(
            "https://ioppublishing.org/legal/textanddataminingpolicy/",
            "https://iopscience.iop.org/robots.txt",
        ),
        verification_date=date(2026, 8, 15),
        evidence_revision="iopscience-automated-access-unsupported-2026-08-15",
        notes_reference="docs/notes/providers/iop.md",
        fixture_reference="tests/fixtures/acquisition/profiles/iopscience.json",
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
                ACM_ACCESS_PROFILE,
                ACS_ACCESS_PROFILE,
                CORE_ACCESS_PROFILE,
                ELSEVIER_ACCESS_PROFILE,
                IEEE_ACCESS_PROFILE,
                IOP_ACCESS_PROFILE,
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
    "ACM_ACCESS_PROFILE",
    "ACS_ACCESS_PROFILE",
    "CORE_ACCESS_PROFILE",
    "ELSEVIER_ACCESS_PROFILE",
    "IEEE_ACCESS_PROFILE",
    "IOP_ACCESS_PROFILE",
    "NATURE_ACCESS_PROFILE",
    "PUBLISHER_ACCESS_VERIFICATION_MATRIX",
    "PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG",
    "RSC_ACCESS_PROFILE",
    "SPRINGERLINK_ACCESS_PROFILE",
    "WILEY_ACCESS_PROFILE",
)
