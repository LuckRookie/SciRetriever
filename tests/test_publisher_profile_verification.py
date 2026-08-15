from __future__ import annotations

import dataclasses
import json
import unittest
from datetime import date
from pathlib import Path
from typing import cast

from sciretriever.acquisition.access_profiles import (
    PolicyEvidence,
    ProfileProductionStatus,
    PublisherAccessEvidence,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
)
from sciretriever.acquisition.profile_catalog import (
    ACM_ACCESS_PROFILE,
    ACS_ACCESS_PROFILE,
    AIP_ACCESS_PROFILE,
    APS_ACCESS_PROFILE,
    IEEE_ACCESS_PROFILE,
    IOP_ACCESS_PROFILE,
    NATURE_ACCESS_PROFILE,
    OXFORD_ACADEMIC_ACCESS_PROFILE,
    PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    PUBLISHER_ACCESS_VERIFICATION_MATRIX,
    RSC_ACCESS_PROFILE,
    SPRINGERLINK_ACCESS_PROFILE,
)
from sciretriever.acquisition.profile_verification import (
    PublisherAccessVerificationMatrix,
    PublisherProfileVerificationError,
)
from sciretriever.acquisition.sources.browser_rules import (
    BrowserActionKind,
    BrowserArticleIdentityKind,
    BrowserPageMarker,
    BrowserPageMarkerKind,
    BrowserRuleAction,
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.model.access import BrowserCaptureKind
from sciretriever.network.browser_scheduler import BrowserGroupPolicy


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise AssertionError("fixture value must be a string-keyed object")
    return cast(dict[str, object], value)


def _sequence(value: object) -> list[object]:
    if not isinstance(value, list):
        raise AssertionError("fixture value must be an array")
    return cast(list[object], value)


def _strings(value: object) -> tuple[str, ...]:
    items = _sequence(value)
    if any(not isinstance(item, str) for item in items):
        raise AssertionError("fixture array must contain strings")
    return tuple(cast(str, item) for item in items)


def _load_fixture(reference: str) -> dict[str, object]:
    payload = json.loads(Path(reference).read_text(encoding="utf-8"))
    return _mapping(payload)


def _browser_profile(
    *,
    status: ProfileProductionStatus = ProfileProductionStatus.FIXTURE_VERIFIED,
) -> PublisherAccessProfile:
    return PublisherAccessProfile(
        access_key="fixture-publisher",
        platform_key="fixture-platform",
        landing_origins=("https://publisher.test",),
        asset_origins=("https://publisher.test",),
        stable_locator_namespaces=(),
        provider_record_names=("fixture-publisher",),
        weak_doi_prefixes=(),
        weak_publisher_names=("fixture publisher",),
        public_route_keys=(),
        api_route_keys=(),
        browser_route_key="browser:fixture-publisher",
        browser_allowed_origins=("https://publisher.test",),
        browser_rate_limit_group="fixture-publisher",
        browser_session_key="fixture-publisher",
        browser_rule_id="fixture-publisher",
        browser_rule_revision=1,
        policy_evidence=PolicyEvidence.PROJECT_CONSERVATIVE,
        policy_revision="fixture-browser-v1",
        production_status=status,
        evidence=PublisherAccessEvidence(
            display_name="Fixture Publisher",
            product_name="Fixture Browser Platform",
            official_references=("https://publisher.test/docs",),
            access_terms_references=("https://publisher.test/terms",),
            rate_limit_references=("https://publisher.test/rate-limits",),
            verification_date=date(2026, 8, 15),
            evidence_revision="fixture-publisher-v1",
            notes_reference="docs/notes/providers/wiley.md",
            fixture_reference="tests/fixtures/acquisition/profiles/browser-gate.json",
        ),
        browser_policy=BrowserGroupPolicy(
            rate_limit_group="fixture-publisher",
            policy_revision="fixture-browser-v1",
            minimum_start_interval=30.0,
            rate_limit_cooldown=120.0,
            runtime_failure_threshold=2,
            cooldown_after_completion=5.0,
            failure_cooldown=60.0,
        ),
    )


def _browser_rule() -> BrowserSiteRule:
    return BrowserSiteRule(
        rule_id="fixture-publisher",
        revision=1,
        landing_origin="https://publisher.test",
        allowed_origins=("https://publisher.test",),
        web_scope_provider_name="fixture-publisher",
        actions=(
            BrowserRuleAction(
                kind=BrowserActionKind.CLICK,
                selector="a[data-action='pdf']",
            ),
        ),
        page_markers=(
            BrowserPageMarker(
                marker_id="entitled",
                kind=BrowserPageMarkerKind.ENTITLED,
                css_selectors=("#entitled",),
            ),
            BrowserPageMarker(
                marker_id="login-required",
                kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
                css_selectors=("#login-required",),
            ),
            BrowserPageMarker(
                marker_id="paywall",
                kind=BrowserPageMarkerKind.PAYWALL,
                css_selectors=("#paywall",),
            ),
            BrowserPageMarker(
                marker_id="challenge-required",
                kind=BrowserPageMarkerKind.CHALLENGE_REQUIRED,
                css_selectors=("#challenge-required",),
            ),
        ),
        capture_url_prefixes=("https://publisher.test/pdf/",),
        article_identity_kinds=(BrowserArticleIdentityKind.LANDING_PATH_STEM,),
        supplement_url_prefixes=("https://publisher.test/supp/",),
        supplement_selectors=("a.supplement",),
        supplement_filename_markers=("supp",),
        excluded_url_prefixes=("https://publisher.test/legal/",),
        excluded_filename_markers=("cover",),
    )


class PublisherProfileEvidenceFixtureTests(unittest.TestCase):
    def test_every_matrix_profile_has_one_matching_evidence_fixture(self) -> None:
        self.assertEqual(
            PUBLISHER_ACCESS_VERIFICATION_MATRIX.production_profiles.profiles,
            PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.profiles,
        )
        for profile in PUBLISHER_ACCESS_VERIFICATION_MATRIX.profiles:
            with self.subTest(profile=profile.access_key):
                fixture = _load_fixture(profile.evidence.fixture_reference)
                capabilities = _mapping(fixture["capabilities"])
                stable_identity = _mapping(fixture["stable_identity"])
                ownership_cases = tuple(
                    _mapping(item) for item in _sequence(fixture["ownership_cases"])
                )
                self.assertEqual(fixture["schema_version"], 1)
                self.assertEqual(fixture["access_key"], profile.access_key)
                self.assertEqual(fixture["display_name"], profile.evidence.display_name)
                self.assertEqual(fixture["product_name"], profile.evidence.product_name)
                self.assertEqual(
                    fixture["verification_state"],
                    profile.production_status.value,
                )
                self.assertEqual(
                    fixture["verification_date"],
                    profile.evidence.verification_date.isoformat(),
                )
                self.assertEqual(
                    fixture["evidence_revision"],
                    profile.evidence.evidence_revision,
                )
                self.assertEqual(fixture["notes_reference"], profile.evidence.notes_reference)
                self.assertEqual(
                    _strings(fixture["official_references"]),
                    profile.evidence.official_references,
                )
                self.assertEqual(
                    _strings(fixture["access_terms_references"]),
                    profile.evidence.access_terms_references,
                )
                self.assertEqual(
                    _strings(fixture["rate_limit_references"]),
                    profile.evidence.rate_limit_references,
                )
                self.assertEqual(_strings(fixture["landing_origins"]), profile.landing_origins)
                self.assertEqual(_strings(fixture["asset_origins"]), profile.asset_origins)
                self.assertEqual(
                    _strings(stable_identity["locator_namespaces"]),
                    profile.stable_locator_namespaces,
                )
                self.assertEqual(
                    _strings(stable_identity["provider_record_names"]),
                    profile.provider_record_names,
                )
                self.assertTrue(_strings(stable_identity["examples"]))
                self.assertEqual(
                    _strings(capabilities["public_routes"]),
                    profile.public_route_keys,
                )
                self.assertEqual(
                    _strings(capabilities["authorized_api_routes"]),
                    profile.api_route_keys,
                )
                self.assertEqual(capabilities["browser_route"], profile.browser_route_key)
                self.assertIn("primary", {item["expected"] for item in ownership_cases})
                self.assertTrue(
                    {item["expected"] for item in ownership_cases} & {"supplement", "excluded"}
                )
                self.assertTrue(_strings(fixture["evidence_gaps"]))

    def test_springerlink_and_nature_are_separate_unsupported_profiles(self) -> None:
        profiles = (SPRINGERLINK_ACCESS_PROFILE, NATURE_ACCESS_PROFILE)
        self.assertEqual(
            {profile.access_key for profile in profiles},
            {"springerlink", "nature-portfolio"},
        )
        self.assertEqual(len({profile.platform_key for profile in profiles}), 2)
        self.assertTrue(
            set(SPRINGERLINK_ACCESS_PROFILE.landing_origins).isdisjoint(
                NATURE_ACCESS_PROFILE.landing_origins
            )
        )
        for profile in profiles:
            with self.subTest(profile=profile.access_key):
                self.assertIs(
                    profile.production_status,
                    ProfileProductionStatus.UNSUPPORTED,
                )
                self.assertEqual(profile.provider_record_names, ())
                self.assertEqual(profile.public_route_keys, ())
                self.assertEqual(profile.api_route_keys, ())
                self.assertIsNone(profile.browser_route_key)
                self.assertIsNone(profile.browser_rate_limit_group)
                self.assertIsNone(profile.browser_session_key)
                self.assertIsNone(
                    PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key)
                )

    def test_springer_fixtures_keep_jats_and_browser_out_of_pdf_routes(self) -> None:
        for profile in (SPRINGERLINK_ACCESS_PROFILE, NATURE_ACCESS_PROFILE):
            with self.subTest(profile=profile.access_key):
                fixture = _load_fixture(profile.evidence.fixture_reference)
                route_verification = _mapping(fixture["route_verification"])
                authorized_api = _mapping(route_verification["authorized_api"])
                browser = _mapping(route_verification["browser"])
                self.assertEqual(authorized_api["state"], "unsupported")
                self.assertEqual(authorized_api["payload"], "jats-xml-not-pdf")
                self.assertEqual(browser["state"], "unsupported")
                self.assertTrue(_strings(browser["blockers"]))

    def test_acs_does_not_promote_tdm_xml_or_upstream_browser_verdict(self) -> None:
        profile = ACS_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.provider_record_names, ())
        self.assertEqual(profile.weak_doi_prefixes, ("10.1021",))
        self.assertEqual(profile.public_route_keys, ())
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        authorized_api = _mapping(route_verification["authorized_api"])
        browser = _mapping(route_verification["browser"])
        self.assertEqual(authorized_api["payload"], "licensed-jats-xml-not-pdf")
        self.assertEqual(browser["state"], "unsupported")
        self.assertIn(
            "upstream-browser-success-is-not-production-evidence",
            _strings(browser["blockers"]),
        )

    def test_acm_open_access_does_not_authorize_a_scripted_profile_route(self) -> None:
        profile = ACM_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.provider_record_names, ())
        self.assertEqual(profile.weak_doi_prefixes, ("10.1145",))
        self.assertEqual(profile.public_route_keys, ())
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        public = _mapping(route_verification["public"])
        authorized_api = _mapping(route_verification["authorized_api"])
        browser = _mapping(route_verification["browser"])
        ownership = tuple(_mapping(item) for item in _sequence(fixture["ownership_cases"]))
        self.assertEqual(
            public["availability"],
            "all-acm-published-articles-open-access-since-2026-01-01",
        )
        self.assertEqual(public["state"], "generic-asset-hint-only")
        self.assertEqual(
            authorized_api["payload"],
            "premium-bulk-download-feature-without-public-api-contract",
        )
        self.assertIn(
            "official-usage-policy-prohibits-scripted-article-download",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            "upstream-browser-success-is-not-production-evidence",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            {"case_id": "related-artifact-or-supplement", "expected": "supplement"},
            ownership,
        )

    def test_aip_terms_keep_automated_site_access_out_of_production(self) -> None:
        profile = AIP_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.provider_record_names, ())
        self.assertEqual(profile.weak_doi_prefixes, ("10.1063",))
        self.assertEqual(profile.public_route_keys, ())
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(profile.browser_rate_limit_group)
        self.assertIsNone(profile.browser_session_key)
        self.assertNotEqual(profile.platform_key, IOP_ACCESS_PROFILE.platform_key)
        self.assertTrue(set(profile.landing_origins).isdisjoint(IOP_ACCESS_PROFILE.landing_origins))
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        authorized_api = _mapping(route_verification["authorized_api"])
        browser = _mapping(route_verification["browser"])
        ownership = tuple(_mapping(item) for item in _sequence(fixture["ownership_cases"]))
        self.assertEqual(
            authorized_api["payload"],
            "no-reviewed-machine-access-api",
        )
        self.assertIn(
            "official-terms-prohibit-automated-site-access",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            "upstream-browser-success-is-not-production-evidence",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            {"case_id": "supplementary-material-or-file", "expected": "supplement"},
            ownership,
        )

    def test_aps_redirect_and_crawler_policy_do_not_create_a_pdf_route(self) -> None:
        profile = APS_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.provider_record_names, ())
        self.assertEqual(profile.weak_doi_prefixes, ("10.1103",))
        self.assertEqual(
            profile.landing_origins,
            ("https://journals.aps.org", "https://link.aps.org"),
        )
        self.assertEqual(profile.asset_origins, ("https://journals.aps.org",))
        self.assertEqual(profile.public_route_keys, ())
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(profile.browser_rate_limit_group)
        self.assertIsNone(profile.browser_session_key)
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        public = _mapping(route_verification["public"])
        authorized_api = _mapping(route_verification["authorized_api"])
        browser = _mapping(route_verification["browser"])
        ownership = tuple(_mapping(item) for item in _sequence(fixture["ownership_cases"]))
        self.assertEqual(
            public["legacy_link_origin"],
            "redirect-only-to-canonical-journals-origin",
        )
        self.assertEqual(
            authorized_api["payload"],
            "no-reviewed-public-full-text-api",
        )
        self.assertIn(
            "robots-indexing-allowance-is-not-pdf-automation-permission",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            "upstream-unsupported-verdict-is-not-production-evidence",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            {"case_id": "supplementary-material", "expected": "supplement"},
            ownership,
        )

    def test_oxford_platform_similarity_does_not_create_a_shared_browser_group(
        self,
    ) -> None:
        profile = OXFORD_ACADEMIC_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.provider_record_names, ())
        self.assertEqual(profile.weak_doi_prefixes, ("10.1093",))
        self.assertEqual(profile.public_route_keys, ())
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(profile.browser_rate_limit_group)
        self.assertIsNone(profile.browser_session_key)
        self.assertNotEqual(profile.platform_key, AIP_ACCESS_PROFILE.platform_key)
        self.assertTrue(set(profile.landing_origins).isdisjoint(AIP_ACCESS_PROFILE.landing_origins))
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        authorized_api = _mapping(route_verification["authorized_api"])
        browser = _mapping(route_verification["browser"])
        ownership = tuple(_mapping(item) for item in _sequence(fixture["ownership_cases"]))
        self.assertEqual(
            authorized_api["payload"],
            "no-reviewed-machine-access-pdf-api",
        )
        self.assertIn(
            "shared-platform-template-is-not-shared-risk-or-session-evidence",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            "upstream-browser-success-is-not-production-evidence",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            {"case_id": "supplementary-material-or-file", "expected": "supplement"},
            ownership,
        )

    def test_rsc_esi_is_never_promoted_by_an_unsupported_profile(self) -> None:
        profile = RSC_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.weak_doi_prefixes, ("10.1039",))
        self.assertEqual(profile.public_route_keys, ())
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        browser = _mapping(route_verification["browser"])
        ownership = tuple(_mapping(item) for item in _sequence(fixture["ownership_cases"]))
        self.assertIn(
            "official-terms-prohibit-automated-download",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            {"case_id": "electronic-supplementary-information", "expected": "supplement"},
            ownership,
        )

    def test_ieee_arnumber_does_not_imply_a_ready_pdf_route(self) -> None:
        profile = IEEE_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.stable_locator_namespaces, ("ieee-arnumber",))
        self.assertEqual(profile.provider_record_names, ())
        self.assertEqual(profile.weak_doi_prefixes, ("10.1109",))
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        authorized_api = _mapping(route_verification["authorized_api"])
        browser = _mapping(route_verification["browser"])
        self.assertEqual(
            authorized_api["payload"],
            "licensed-full-text-shape-not-publicly-specified",
        )
        self.assertIn(
            "institution-specific-upstream-sso-is-not-production-evidence",
            _strings(browser["blockers"]),
        )

    def test_iop_agreed_delivery_does_not_become_a_browser_or_api_route(self) -> None:
        profile = IOP_ACCESS_PROFILE
        self.assertIs(profile.production_status, ProfileProductionStatus.UNSUPPORTED)
        self.assertEqual(profile.provider_record_names, ())
        self.assertEqual(profile.weak_doi_prefixes, ("10.1088",))
        self.assertEqual(profile.public_route_keys, ())
        self.assertEqual(profile.api_route_keys, ())
        self.assertIsNone(profile.browser_route_key)
        self.assertIsNone(profile.browser_rate_limit_group)
        self.assertIsNone(profile.browser_session_key)
        self.assertIsNone(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG.get(profile.access_key))
        fixture = _load_fixture(profile.evidence.fixture_reference)
        route_verification = _mapping(fixture["route_verification"])
        authorized_api = _mapping(route_verification["authorized_api"])
        browser = _mapping(route_verification["browser"])
        ownership = tuple(_mapping(item) for item in _sequence(fixture["ownership_cases"]))
        self.assertEqual(
            authorized_api["payload"],
            "reviewed-sftp-or-agreed-delivery-is-not-a-public-api",
        )
        self.assertIn(
            "official-terms-prohibit-systematic-downloading",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            "general-robots-policy-disallows-all",
            _strings(browser["blockers"]),
        )
        self.assertIn(
            {"case_id": "supplementary-data-or-file", "expected": "supplement"},
            ownership,
        )

    def test_browser_fixture_executes_primary_supplement_and_wrong_article_cases(self) -> None:
        profile = _browser_profile()
        rule = _browser_rule()
        matrix = PublisherAccessVerificationMatrix(
            PublisherAccessProfileCatalog((profile,)),
            BrowserRuleCatalog((rule,)),
        )
        fixture = _load_fixture(profile.evidence.fixture_reference)
        browser = _mapping(fixture["browser"])
        self.assertEqual(browser["rule_id"], rule.rule_id)
        self.assertEqual(browser["rule_revision"], rule.revision)
        self.assertEqual(browser["rate_limit_group"], profile.browser_rate_limit_group)
        self.assertEqual(browser["session_group"], profile.browser_session_key)
        self.assertEqual(
            set(_strings(browser["page_states"])),
            {marker.kind.value for marker in rule.page_markers},
        )
        for value in _sequence(browser["capture_cases"]):
            case = _mapping(value)
            with self.subTest(case=case["case_id"]):
                self.assertEqual(
                    rule.classify_capture(
                        cast(str, case["locator"]),
                        BrowserCaptureKind.DOWNLOAD,
                        "application/pdf",
                        landing_url=cast(str, case["landing_url"]),
                        identifiers=(),
                    ).value,
                    case["expected"],
                )
        self.assertEqual(len(matrix.production_profiles), 0)
        self.assertEqual(matrix.production_browser_rules.rules, ())


class PublisherProfileAdmissionGateTests(unittest.TestCase):
    def test_only_production_ready_profiles_and_rules_are_assembled(self) -> None:
        rule = _browser_rule()
        fixture_matrix = PublisherAccessVerificationMatrix(
            PublisherAccessProfileCatalog((_browser_profile(),)),
            BrowserRuleCatalog((rule,)),
        )
        self.assertEqual(len(fixture_matrix.production_profiles), 0)
        production_matrix = PublisherAccessVerificationMatrix(
            PublisherAccessProfileCatalog(
                (
                    _browser_profile(
                        status=ProfileProductionStatus.PRODUCTION_READY,
                    ),
                )
            ),
            BrowserRuleCatalog((rule,)),
        )
        self.assertEqual(len(production_matrix.production_profiles), 1)
        self.assertEqual(production_matrix.production_browser_rules.rules, (rule,))

    def test_missing_misaligned_or_incomplete_browser_rules_fail_closed(self) -> None:
        profile = _browser_profile()
        rule = _browser_rule()
        invalid_inputs = (
            (
                PublisherAccessProfileCatalog((profile,)),
                BrowserRuleCatalog(),
            ),
            (
                PublisherAccessProfileCatalog(
                    (dataclasses.replace(profile, browser_rule_revision=2),)
                ),
                BrowserRuleCatalog((rule,)),
            ),
            (
                PublisherAccessProfileCatalog((profile,)),
                BrowserRuleCatalog(
                    (dataclasses.replace(rule, page_markers=rule.page_markers[:-1]),)
                ),
            ),
            (
                PublisherAccessProfileCatalog((profile,)),
                BrowserRuleCatalog(
                    (
                        dataclasses.replace(
                            rule,
                            supplement_url_prefixes=(),
                            supplement_selectors=(),
                            supplement_filename_markers=(),
                        ),
                    )
                ),
            ),
        )
        for profiles, rules in invalid_inputs:
            with self.subTest(rules=rules):
                with self.assertRaises(PublisherProfileVerificationError):
                    PublisherAccessVerificationMatrix(profiles, rules)

    def test_unsupported_profile_has_no_executable_route(self) -> None:
        profile = _browser_profile()
        unsupported = dataclasses.replace(
            profile,
            public_route_keys=(),
            api_route_keys=(),
            browser_route_key=None,
            browser_allowed_origins=(),
            browser_rate_limit_group=None,
            browser_session_key=None,
            browser_rule_id=None,
            browser_rule_revision=None,
            browser_policy=None,
            production_status=ProfileProductionStatus.UNSUPPORTED,
        )
        matrix = PublisherAccessVerificationMatrix(
            PublisherAccessProfileCatalog((unsupported,)),
            BrowserRuleCatalog(),
        )
        self.assertEqual(len(matrix.production_profiles), 0)
        self.assertEqual(matrix.production_browser_rules.rules, ())


if __name__ == "__main__":
    unittest.main()
