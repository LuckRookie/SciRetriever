from __future__ import annotations

import pickle
import unittest
from datetime import date

from sciretriever.acquisition.access_profiles import PublisherAccessProfile
from sciretriever.acquisition.cohort import AcquisitionWorkItem, TieredCohortExecutor
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import AcquisitionPlan, RouteSpec
from sciretriever.model.acquisition import AcquisitionPath
from sciretriever.network.browser_scheduler import (
    BrowserGroupPolicy,
    BrowserGroupScheduler,
    BrowserSchedulerCancellation,
)


class _AdvancingBrowserClock:
    def __init__(self) -> None:
        self.current = 0.0

    def now(self) -> float:
        return self.current

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        del cancel_event
        self.current = max(self.current, deadline)


def _profile() -> PublisherAccessProfile:
    from sciretriever.acquisition.access_profiles import (
        PolicyEvidence,
        ProfileProductionStatus,
        PublisherAccessEvidence,
        PublisherAccessProfile,
    )

    return PublisherAccessProfile(
        access_key="wiley-online-library",
        platform_key="wiley-online-library",
        landing_origins=("https://onlinelibrary.wiley.com",),
        asset_origins=(
            "https://onlinelibrary.wiley.com",
            "https://alm.wiley.com",
        ),
        stable_locator_namespaces=("wiley-id",),
        provider_record_names=("wiley",),
        weak_doi_prefixes=("10.1002",),
        weak_publisher_names=("wiley",),
        public_route_keys=("public:direct",),
        api_route_keys=("api:wiley-tdm-v1",),
        browser_route_key="browser:wiley-online-library",
        browser_allowed_origins=(
            "https://onlinelibrary.wiley.com",
            "https://alm.wiley.com",
        ),
        browser_rate_limit_group="wiley-online-library",
        browser_session_key="wiley-online-library",
        browser_rule_id="wiley-online-library",
        browser_rule_revision=1,
        policy_evidence=PolicyEvidence.PROJECT_CONSERVATIVE,
        policy_revision="2026-08-15",
        production_status=ProfileProductionStatus.FIXTURE_VERIFIED,
        evidence=PublisherAccessEvidence(
            display_name="Wiley Online Library",
            product_name="Wiley fixture",
            official_references=("https://onlinelibrary.wiley.com/about",),
            access_terms_references=("https://onlinelibrary.wiley.com/terms",),
            rate_limit_references=("https://onlinelibrary.wiley.com/rate-limits",),
            verification_date=date(2026, 8, 15),
            evidence_revision="wiley-fixture-v1",
            notes_reference="docs/notes/providers/wiley.md",
            fixture_reference=("tests/fixtures/acquisition/profiles/wiley-online-library.json"),
        ),
        browser_policy=BrowserGroupPolicy(
            rate_limit_group="wiley-online-library",
            policy_revision="2026-08-15",
            minimum_start_interval=10.0,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=3,
        ),
    )


class PublisherPlanningContractTests(unittest.TestCase):
    def test_strong_evidence_selects_profile_but_weak_hints_never_do(self) -> None:
        from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
        from sciretriever.acquisition.planning import (
            PublisherAccessResolver,
            ResolutionEvidence,
            ResolutionEvidenceKind,
        )

        resolver = PublisherAccessResolver(PublisherAccessProfileCatalog((_profile(),)))
        strong = resolver.resolve(
            (
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                    value="https://onlinelibrary.wiley.com",
                    source="doi-landing",
                ),
            )
        )
        weak = resolver.resolve(
            (
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.DOI_PREFIX,
                    value="10.1002",
                    source="literature-doi",
                ),
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.PUBLISHER_TEXT,
                    value="Wiley",
                    source="literature-metadata",
                ),
            )
        )

        self.assertEqual(strong.access_key, "wiley-online-library")
        self.assertTrue(strong.is_strong)
        self.assertIsNone(weak.access_key)
        self.assertEqual(weak.weak_candidate_keys, ("wiley-online-library",))

    def test_planner_is_tiered_deterministic_and_scopes_readiness_to_routes(self) -> None:
        from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
        from sciretriever.acquisition.planning import (
            AcquisitionPlanBuilder,
            PublisherAccessResolver,
            ResolutionEvidence,
            ResolutionEvidenceKind,
            RouteCapability,
            RouteReadiness,
            RouteSpec,
        )

        catalog = PublisherAccessProfileCatalog((_profile(),))
        resolution = PublisherAccessResolver(catalog).resolve(
            (
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                    value="https://onlinelibrary.wiley.com",
                    source="doi-landing",
                ),
            )
        )
        candidates = (
            RouteSpec(
                route_key="api:elsevier-full-text",
                tier=AcquisitionPath.AUTHORIZED_PROVIDER_API,
                capability=RouteCapability.DIRECT_PDF,
                profile_access_key="elsevier-sciencedirect",
                readiness=RouteReadiness.UNCONFIGURED,
            ),
            RouteSpec(
                route_key="browser:wiley-online-library",
                tier=AcquisitionPath.CONTROLLED_BROWSER,
                capability=RouteCapability.BROWSER_PDF,
                profile_access_key="wiley-online-library",
                readiness=RouteReadiness.READY,
                risk_group="wiley-online-library",
            ),
            RouteSpec(
                route_key="public:direct",
                tier=AcquisitionPath.PUBLIC,
                capability=RouteCapability.DIRECT_PDF,
                readiness=RouteReadiness.READY,
            ),
            RouteSpec(
                route_key="api:wiley-tdm-v1",
                tier=AcquisitionPath.AUTHORIZED_PROVIDER_API,
                capability=RouteCapability.DIRECT_PDF,
                profile_access_key="wiley-online-library",
                readiness=RouteReadiness.READY,
                quota_group="wiley-tdm",
            ),
        )
        builder = AcquisitionPlanBuilder(catalog)

        first = builder.build(resolution=resolution, route_specs=candidates)
        second = builder.build(resolution=resolution, route_specs=candidates)

        self.assertEqual(first, second)
        self.assertEqual(
            tuple(route.route_key for route in first.routes),
            (
                "public:direct",
                "api:wiley-tdm-v1",
                "browser:wiley-online-library",
            ),
        )
        self.assertNotIn(
            "api:elsevier-full-text",
            tuple(route.route_key for route in first.routes),
        )

    def test_route_hints_and_plans_are_safe_runtime_only_values(self) -> None:
        from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
        from sciretriever.acquisition.planning import (
            AccessRouteHint,
            AccessRouteHintKind,
            AcquisitionPlanBuilder,
            PublisherAccessResolution,
        )

        hint = AccessRouteHint(
            kind=AccessRouteHintKind.CANONICAL_LANDING,
            value="https://onlinelibrary.wiley.com/doi/10.1002/example",
            source_route_key="api:wiley-tdm-v1",
            profile_access_key="wiley-online-library",
        )
        plan = AcquisitionPlanBuilder(PublisherAccessProfileCatalog((_profile(),))).build(
            resolution=PublisherAccessResolution.unresolved(),
            route_specs=(),
        )

        self.assertNotIn("token", repr(hint).casefold())
        with self.assertRaises(TypeError):
            pickle.dumps(hint)
        with self.assertRaises(TypeError):
            pickle.dumps(plan)
        with self.assertRaises(ValueError):
            AccessRouteHint(
                kind=AccessRouteHintKind.PDF_OBJECT_LOCATOR,
                value="https://example.test/object.pdf?token=secret",
                source_route_key="api:example",
                profile_access_key="example",
            )


class TieredCohortContractTests(unittest.TestCase):
    def _plan(self, key: str) -> AcquisitionPlan:
        from sciretriever.acquisition.planning import (
            AcquisitionPlan,
            PublisherAccessResolution,
            ResolutionEvidence,
            ResolutionEvidenceKind,
            RouteCapability,
            RouteReadiness,
            RouteSpec,
        )

        evidence = ResolutionEvidence(
            kind=ResolutionEvidenceKind.LANDING_ORIGIN,
            value="https://publisher-a.test",
            source="doi-landing",
        )
        return AcquisitionPlan(
            revision="sha256:" + "a" * 64,
            resolution=PublisherAccessResolution(
                access_key="publisher-a",
                selected_evidence_kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                evidence=(evidence,),
            ),
            routes=tuple(
                RouteSpec(
                    route_key=f"{tier.value}:{key}",
                    tier=tier,
                    capability=(
                        RouteCapability.BROWSER_PDF
                        if tier is AcquisitionPath.CONTROLLED_BROWSER
                        else RouteCapability.DIRECT_PDF
                    ),
                    readiness=RouteReadiness.READY,
                    risk_group=(
                        "publisher-a" if tier is AcquisitionPath.CONTROLLED_BROWSER else None
                    ),
                )
                for tier in AcquisitionPath
            ),
        )

    def _executor(self) -> TieredCohortExecutor:
        from sciretriever.acquisition.browser_admission import (
            BrowserAdmissionConfiguration,
            BrowserAdmissionController,
            BrowserGroupAdmissionState,
            BrowserGroupReadiness,
        )
        from sciretriever.network.browser_scheduler import BrowserGroupPolicy

        return TieredCohortExecutor(
            browser_scheduler=BrowserGroupScheduler(
                clock=_AdvancingBrowserClock(),
                max_concurrency=4,
            ),
            browser_admission=BrowserAdmissionController(
                BrowserAdmissionConfiguration(
                    explicitly_enabled=True,
                    execution_confirmed=True,
                    runtime_ready=True,
                    groups=(
                        BrowserGroupAdmissionState(
                            policy=BrowserGroupPolicy(
                                rate_limit_group="publisher-a",
                                policy_revision="fixture-v1",
                                minimum_start_interval=0.0,
                                rate_limit_cooldown=60.0,
                                runtime_failure_threshold=3,
                            ),
                            session_key="publisher-a",
                            readiness=BrowserGroupReadiness.READY,
                        ),
                    ),
                )
            ),
        )

    def test_whole_cohort_finishes_each_tier_before_the_next_one_starts(self) -> None:
        from sciretriever.acquisition.cohort import (
            AcquisitionWorkItem,
            WorkItemDisposition,
        )
        from sciretriever.acquisition.outcomes import RouteExecutionResult

        trace: list[tuple[str, AcquisitionPath]] = []
        items = tuple(AcquisitionWorkItem(work_key=key, plan=self._plan(key)) for key in ("a", "b"))

        executor = self._executor()
        result = executor.execute(
            items,
            lambda item, route: (
                trace.append((item.work_key, route.tier)) or RouteExecutionResult.normal_miss()
            ),
        )

        self.assertEqual(
            tuple(tier for _key, tier in trace),
            (
                AcquisitionPath.PUBLIC,
                AcquisitionPath.PUBLIC,
                AcquisitionPath.AUTHORIZED_PROVIDER_API,
                AcquisitionPath.AUTHORIZED_PROVIDER_API,
                AcquisitionPath.CONTROLLED_BROWSER,
                AcquisitionPath.CONTROLLED_BROWSER,
            ),
        )
        self.assertTrue(
            all(item.disposition is WorkItemDisposition.EXHAUSTED for item in result.items)
        )

    def test_transient_api_failure_defers_and_never_escalates_to_browser(self) -> None:
        from sciretriever.acquisition.cohort import (
            AcquisitionWorkItem,
            WorkItemDisposition,
        )
        from sciretriever.acquisition.outcomes import RouteExecutionResult
        from sciretriever.model.report import StableFailure

        trace: list[AcquisitionPath] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            del item
            trace.append(route.tier)
            if route.tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
                return RouteExecutionResult.deferred(
                    StableFailure(
                        code="provider-temporarily-unavailable",
                        reason="The authorized API is temporarily unavailable.",
                        action="Retry after the provider recovers.",
                        retryable=True,
                    )
                )
            return RouteExecutionResult.normal_miss()

        executor = self._executor()
        result = executor.execute(
            (AcquisitionWorkItem(work_key="a", plan=self._plan("a")),),
            execute,
        )

        self.assertNotIn(AcquisitionPath.CONTROLLED_BROWSER, trace)
        self.assertIs(result.items[0].disposition, WorkItemDisposition.DEFERRED)
        self.assertFalse(result.items[0].exhausted)

    def test_action_required_and_failure_are_never_reported_as_exhaustion(self) -> None:
        from sciretriever.acquisition.cohort import (
            AcquisitionWorkItem,
            WorkItemDisposition,
        )
        from sciretriever.acquisition.outcomes import RouteExecutionResult
        from sciretriever.model.report import StableFailure

        failure = StableFailure(
            code="browser-login-required",
            reason="The Browser session requires operator login.",
            action="Open Browser Access configuration and sign in.",
            retryable=False,
        )
        executor = self._executor()
        result = executor.execute(
            (AcquisitionWorkItem(work_key="a", plan=self._plan("a")),),
            lambda _item, route: (
                RouteExecutionResult.action_required(failure)
                if route.tier is AcquisitionPath.CONTROLLED_BROWSER
                else RouteExecutionResult.normal_miss()
            ),
        )

        self.assertIs(result.items[0].disposition, WorkItemDisposition.ACTION_REQUIRED)
        self.assertFalse(result.items[0].exhausted)


if __name__ == "__main__":
    unittest.main()
