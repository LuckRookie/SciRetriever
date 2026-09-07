from __future__ import annotations

import dataclasses
import unittest
from datetime import date

from sciretriever.acquisition.access_profiles import (
    AccessPlatformKey,
    BrowserRateLimitGroup,
    BrowserSessionKey,
    PolicyEvidence,
    ProfileProductionStatus,
    PublisherAccessEvidence,
    PublisherAccessKey,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
    normalize_profile_origin,
)


def _profile(
    *,
    access_key: str = "wiley-online-library",
    origin: str = "https://onlinelibrary.wiley.com",
    policy_revision: str = "2026-08-15",
    status: ProfileProductionStatus = ProfileProductionStatus.FIXTURE_VERIFIED,
    evidence: PolicyEvidence = PolicyEvidence.PROJECT_CONSERVATIVE,
) -> PublisherAccessProfile:
    return PublisherAccessProfile(
        access_key=access_key,
        platform_key=access_key,
        landing_origins=(origin,),
        asset_origins=(origin,),
        stable_locator_namespaces=(f"{access_key}-id",),
        provider_record_names=(access_key.split("-")[0],),
        weak_doi_prefixes=("10.1002",),
        weak_publisher_names=(access_key,),
        public_route_keys=(f"public:{access_key}",),
        api_route_keys=(f"api:{access_key}",),
        browser_probe_enabled=True,
        policy_evidence=evidence,
        policy_revision=policy_revision,
        production_status=status,
        evidence=PublisherAccessEvidence(
            display_name=access_key.replace("-", " ").title(),
            product_name=f"{access_key} fixture",
            official_references=(f"{origin}/docs",),
            access_terms_references=(f"{origin}/terms",),
            rate_limit_references=(f"{origin}/rate-limits",),
            verification_date=date(2026, 8, 15),
            evidence_revision=f"{access_key}-fixture-v1",
            notes_reference=f"docs/notes/providers/{access_key}.md",
            fixture_reference=f"tests/fixtures/acquisition/profiles/{access_key}.json",
        ),
    )


class AccessIdentityTests(unittest.TestCase):
    def test_access_scheduling_identities_are_stable_and_not_provider_credentials(self) -> None:
        for identity in (
            PublisherAccessKey,
            AccessPlatformKey,
            BrowserRateLimitGroup,
            BrowserSessionKey,
        ):
            self.assertEqual(identity("  Wiley-Online-Library "), "wiley-online-library")
            for invalid in (
                "",
                "https://example.test",
                "10.1002/example",
                "person@example.test",
                "550e8400-e29b-41d4-a716-446655440000",
                "provider-token",
                "provider\nqueue",
            ):
                with self.subTest(identity=identity.__name__, invalid=invalid):
                    with self.assertRaises((TypeError, ValueError)):
                        identity(invalid)

    def test_profile_origins_are_exact_named_origins(self) -> None:
        self.assertEqual(
            normalize_profile_origin("HTTPS://ONLINELIBRARY.WILEY.COM:443/"),
            "https://onlinelibrary.wiley.com",
        )
        for invalid in (
            "https://user:pass@example.test",
            "https://example.test/article",
            "https://example.test?next=article",
            "https://127.0.0.1",
            "https://localhost",
            "example.test",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises((TypeError, ValueError)):
                    normalize_profile_origin(invalid)


class PublisherAccessProfileTests(unittest.TestCase):
    def test_profile_is_frozen_hashable_deterministic_and_secret_free(self) -> None:
        first = _profile()
        second = _profile()
        revised = _profile(policy_revision="2026-08-16")
        without_probe = dataclasses.replace(first, browser_probe_enabled=False)
        self.assertEqual(first, second)
        self.assertEqual(first.revision_hash, second.revision_hash)
        self.assertNotEqual(first.revision_hash, revised.revision_hash)
        self.assertNotEqual(first.revision_hash, without_probe.revision_hash)
        self.assertEqual(len({first, second}), 1)
        self.assertNotIn("token", repr(first).casefold())
        with self.assertRaises(dataclasses.FrozenInstanceError):
            first.access_key = "changed"  # type: ignore[misc]

    def test_browser_probe_shape_and_production_evidence_fail_closed(self) -> None:
        with self.assertRaises(TypeError):
            dataclasses.replace(_profile(), browser_probe_enabled="yes")  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            dataclasses.replace(_profile(), landing_origins=())
        with self.assertRaises(ValueError):
            _profile(
                status=ProfileProductionStatus.PRODUCTION_READY,
                evidence=PolicyEvidence.UNVERIFIED,
            )
        production = _profile(
            status=ProfileProductionStatus.PRODUCTION_READY,
            evidence=PolicyEvidence.OFFICIAL,
        )
        self.assertEqual(production.production_status, ProfileProductionStatus.PRODUCTION_READY)
        self.assertNotIn(
            "browser_machine_access_grant_required",
            {field.name for field in dataclasses.fields(production)},
        )
        fields = {field.name for field in dataclasses.fields(production)}
        self.assertNotIn("browser_route_key", fields)
        self.assertNotIn("browser_allowed_origins", fields)
        self.assertNotIn("browser_policy", fields)
        with self.assertRaises(ValueError):
            _profile(status=ProfileProductionStatus.UNSUPPORTED)
        unsupported = dataclasses.replace(
            _profile(),
            browser_probe_enabled=False,
            public_route_keys=(),
            api_route_keys=(),
            production_status=ProfileProductionStatus.UNSUPPORTED,
        )
        self.assertIs(unsupported.production_status, ProfileProductionStatus.UNSUPPORTED)

    def test_evidence_package_and_verification_states_are_closed(self) -> None:
        self.assertEqual(
            tuple(status.value for status in ProfileProductionStatus),
            ("production-ready", "fixture-verified", "unsupported"),
        )
        profile = _profile()
        self.assertEqual(profile.evidence.verification_date, date(2026, 8, 15))
        self.assertTrue(profile.evidence.fixture_reference.endswith(".json"))
        for replacement in (
            {"official_references": ()},
            {"access_terms_references": ()},
            {"rate_limit_references": ()},
            {"official_references": ("https://user:secret@example.test/docs",)},
            {"fixture_reference": "../profile.json"},
            {"notes_reference": "docs/architecture/design.md"},
        ):
            with self.subTest(replacement=replacement):
                with self.assertRaises((TypeError, ValueError)):
                    dataclasses.replace(profile.evidence, **replacement)

    def test_catalog_rejects_duplicate_access_identity_but_not_shared_platform_knowledge(
        self,
    ) -> None:
        first = _profile()
        with self.assertRaises(ValueError):
            PublisherAccessProfileCatalog((first, first))
        other = dataclasses.replace(
            _profile(
                access_key="wiley-journal-transfer",
                origin="https://journal.example.test",
            ),
            platform_key=first.platform_key,
        )
        catalog = PublisherAccessProfileCatalog((first, other))
        self.assertEqual(len(catalog), 2)
        self.assertIs(catalog.get(first.access_key), first)
        self.assertIsNone(catalog.get("unknown-publisher"))


if __name__ == "__main__":
    unittest.main()
