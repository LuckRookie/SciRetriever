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
    PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    PUBLISHER_ACCESS_VERIFICATION_MATRIX,
)
from sciretriever.acquisition.profile_verification import (
    PublisherAccessVerificationMatrix,
    PublisherProfileVerificationError,
)


def _fixture_profile(
    *,
    access_key: str = "fixture-publisher",
    fixture_reference: str = "tests/fixtures/acquisition/profiles/browser-gate.json",
    status: ProfileProductionStatus = ProfileProductionStatus.FIXTURE_VERIFIED,
) -> PublisherAccessProfile:
    origin = f"https://{access_key}.test"
    policy_revision = f"{access_key}-browser-v1"
    return PublisherAccessProfile(
        access_key=access_key,
        platform_key=access_key,
        landing_origins=(origin,),
        asset_origins=(origin,),
        stable_locator_namespaces=("doi",),
        provider_record_names=(),
        weak_doi_prefixes=(),
        weak_publisher_names=(access_key,),
        public_route_keys=(),
        api_route_keys=(),
        browser_probe_enabled=True,
        policy_evidence=PolicyEvidence.PROJECT_CONSERVATIVE,
        policy_revision=policy_revision,
        production_status=status,
        evidence=PublisherAccessEvidence(
            display_name=access_key.replace("-", " ").title(),
            product_name="Fixture Browser platform",
            official_references=(f"{origin}/docs",),
            access_terms_references=(f"{origin}/terms",),
            rate_limit_references=(f"{origin}/limits",),
            verification_date=date(2026, 8, 15),
            evidence_revision=f"{access_key}-evidence-v1",
            notes_reference="docs/notes/providers/wiley.md",
            fixture_reference=fixture_reference,
        ),
    )


def _fixture_payload(reference: str) -> dict[str, object]:
    value = json.loads(Path(reference).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise AssertionError("publisher fixture must be a string-keyed object")
    return cast(dict[str, object], value)


class PublisherProfileVerificationTests(unittest.TestCase):
    def test_catalog_fixtures_match_profile_identity_and_route_capabilities(self) -> None:
        profiles = PUBLISHER_ACCESS_VERIFICATION_MATRIX.profiles
        self.assertEqual(len(profiles), 23)
        for profile in profiles:
            with self.subTest(access_key=profile.access_key):
                payload = _fixture_payload(profile.evidence.fixture_reference)
                self.assertEqual(payload["access_key"], profile.access_key)
                self.assertEqual(payload["display_name"], profile.evidence.display_name)
                self.assertEqual(payload["product_name"], profile.evidence.product_name)
                self.assertEqual(
                    payload["verification_state"],
                    profile.production_status.value,
                )
                self.assertEqual(payload["landing_origins"], list(profile.landing_origins))
                self.assertEqual(payload["asset_origins"], list(profile.asset_origins))
                capabilities = payload["capabilities"]
                self.assertIsInstance(capabilities, dict)
                capabilities = cast(dict[str, object], capabilities)
                self.assertEqual(
                    capabilities["public_routes"],
                    list(profile.public_route_keys),
                )
                self.assertEqual(
                    capabilities["authorized_api_routes"],
                    list(profile.api_route_keys),
                )
                self.assertEqual(
                    capabilities["browser_probe_enabled"],
                    profile.browser_probe_enabled,
                )

    def test_production_catalog_is_exactly_the_verified_production_subset(self) -> None:
        expected = tuple(
            profile
            for profile in PUBLISHER_ACCESS_VERIFICATION_MATRIX.profiles
            if profile.production_status is ProfileProductionStatus.PRODUCTION_READY
        )
        self.assertEqual(tuple(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG), expected)
        self.assertEqual(
            sum(profile.browser_probe_enabled for profile in expected),
            9,
        )

    def test_browser_profiles_no_longer_reference_click_rules(self) -> None:
        fields = {field.name for field in dataclasses.fields(PublisherAccessProfile)}
        self.assertNotIn("browser_rule_id", fields)
        self.assertNotIn("browser_rule_revision", fields)
        self.assertNotIn("browser_route_key", fields)
        self.assertNotIn("browser_allowed_origins", fields)
        self.assertNotIn("browser_rate_limit_group", fields)
        self.assertNotIn("browser_session_key", fields)
        self.assertNotIn("browser_policy", fields)
        for profile in PUBLISHER_ACCESS_VERIFICATION_MATRIX.profiles:
            self.assertFalse(hasattr(profile, "browser_rule_id"))
            self.assertFalse(hasattr(profile, "browser_rule_revision"))
            if profile.browser_probe_enabled:
                self.assertTrue(profile.landing_origins)

    def test_duplicate_fixture_reference_fails_closed(self) -> None:
        first = _fixture_profile(access_key="first")
        second = _fixture_profile(access_key="second")
        second = dataclasses.replace(
            second,
            evidence=dataclasses.replace(
                second.evidence,
                fixture_reference=first.evidence.fixture_reference,
            ),
        )
        with self.assertRaisesRegex(
            PublisherProfileVerificationError,
            "profile-fixture-reference-duplicate",
        ):
            PublisherAccessVerificationMatrix(PublisherAccessProfileCatalog((first, second)))

    def test_matrix_rejects_an_invalid_catalog_boundary(self) -> None:
        with self.assertRaises(TypeError):
            PublisherAccessVerificationMatrix(cast(PublisherAccessProfileCatalog, object()))


if __name__ == "__main__":
    unittest.main()
