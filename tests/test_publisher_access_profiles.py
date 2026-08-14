from __future__ import annotations

import dataclasses
import unittest

from sciretriever.acquisition.access_profiles import (
    AccessPlatformKey,
    BrowserRateLimitGroup,
    BrowserRuleSet,
    BrowserSessionKey,
    PolicyEvidence,
    ProfileProductionStatus,
    PublisherAccessKey,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
    normalize_profile_origin,
)
from sciretriever.network.browser_scheduler import BrowserGroupPolicy


def _profile(
    *,
    access_key: str = "wiley-online-library",
    origin: str = "https://onlinelibrary.wiley.com",
    policy_revision: str = "2026-08-15",
    rules: BrowserRuleSet | None = None,
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
        browser_route_key=f"browser:{access_key}",
        browser_allowed_origins=(origin,),
        browser_rate_limit_group=access_key,
        browser_session_key=access_key,
        policy_evidence=evidence,
        policy_revision=policy_revision,
        notes_reference=f"docs/notes/providers/{access_key}.md",
        production_status=status,
        browser_policy=BrowserGroupPolicy(
            rate_limit_group=access_key,
            policy_revision=policy_revision,
            minimum_start_interval=10.0,
            maximum_starts_per_window=4,
            window_seconds=120.0,
            cooldown_after_completion=2.0,
            failure_cooldown=30.0,
        ),
        browser_rules=BrowserRuleSet() if rules is None else rules,
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
        rules = BrowserRuleSet(
            pdf_action_selectors=("a[data-action='download-pdf']",),
            login_markers=("Sign in",),
            primary_pdf_url_markers=("/doi/pdf/",),
            supplementary_url_markers=("suppinfo",),
        )
        first = _profile(rules=rules)
        second = _profile(rules=rules)
        revised = _profile(
            rules=dataclasses.replace(rules, pdf_action_selectors=("a.pdf-download",))
        )
        first_policy = first.browser_policy
        self.assertIsNotNone(first_policy)
        assert first_policy is not None
        revised_policy = dataclasses.replace(
            first,
            browser_policy=dataclasses.replace(
                first_policy,
                minimum_start_interval=20.0,
            ),
        )

        self.assertEqual(first, second)
        self.assertEqual(first.revision_hash, second.revision_hash)
        self.assertNotEqual(first.revision_hash, revised.revision_hash)
        self.assertNotEqual(first.revision_hash, revised_policy.revision_hash)
        self.assertEqual(len({first, second}), 1)
        self.assertNotIn("download-pdf", repr(first))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            first.access_key = "changed"  # type: ignore[misc]

    def test_browser_profile_shape_and_production_evidence_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            dataclasses.replace(_profile(), browser_session_key=None)
        with self.assertRaises(ValueError):
            dataclasses.replace(_profile(), browser_route_key=None)
        with self.assertRaises(ValueError):
            dataclasses.replace(_profile(), browser_policy=None)
        with self.assertRaises(ValueError):
            dataclasses.replace(
                _profile(),
                browser_policy=BrowserGroupPolicy(
                    rate_limit_group="another-provider",
                    policy_revision="2026-08-15",
                    minimum_start_interval=10.0,
                ),
            )
        with self.assertRaises(ValueError):
            _profile(
                status=ProfileProductionStatus.PRODUCTION_READY,
                evidence=PolicyEvidence.UNVERIFIED,
            )
        with self.assertRaises(ValueError):
            _profile(
                status=ProfileProductionStatus.PRODUCTION_READY,
                evidence=PolicyEvidence.OFFICIAL,
                rules=BrowserRuleSet(),
            )
        production = _profile(
            status=ProfileProductionStatus.PRODUCTION_READY,
            evidence=PolicyEvidence.OFFICIAL,
            rules=BrowserRuleSet(primary_pdf_url_markers=("/doi/pdf/",)),
        )
        self.assertEqual(production.production_status, ProfileProductionStatus.PRODUCTION_READY)
        with self.assertRaises(ValueError):
            dataclasses.replace(
                production,
                browser_policy=BrowserGroupPolicy(
                    rate_limit_group="wiley-online-library",
                    policy_revision="2026-08-15",
                    minimum_start_interval=0.0,
                ),
            )

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
