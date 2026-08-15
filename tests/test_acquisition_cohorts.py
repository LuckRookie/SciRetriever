from __future__ import annotations

import hashlib
import threading
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from io import BytesIO
from typing import BinaryIO

from sciretriever.acquisition.browser_admission import (
    BrowserAdmissionConfiguration,
    BrowserAdmissionController,
    BrowserAdmissionDisposition,
    BrowserGroupAdmissionState,
    BrowserGroupReadiness,
)
from sciretriever.acquisition.cohort import (
    AcquisitionWorkItem,
    TieredCohortExecutor,
    WorkItemDisposition,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import (
    AccessRouteHint,
    AccessRouteHintKind,
    AcquisitionPlan,
    PublisherAccessResolution,
    ResolutionEvidence,
    ResolutionEvidenceKind,
    RouteCapability,
    RouteReadiness,
    RouteSpec,
)
from sciretriever.acquisition.ports import TemporaryPdf
from sciretriever.model.acquisition import AcquisitionPath, PdfCandidate
from sciretriever.model.primitives import ProvenanceId, Sha256, SourceKind, UtcTimestamp
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.network.browser_scheduler import (
    BrowserGroupPolicy,
    BrowserGroupScheduler,
    BrowserSchedulerCancellation,
)

_TIME = UtcTimestamp("2026-08-15T00:00:00Z")
_HASH = Sha256("a" * 64)
_PREFIX = {
    AcquisitionPath.PUBLIC: "public",
    AcquisitionPath.AUTHORIZED_PROVIDER_API: "api",
    AcquisitionPath.CONTROLLED_BROWSER: "browser",
}


class _AdvancingBrowserClock:
    def __init__(self) -> None:
        self.current = 0.0
        self._lock = threading.Lock()

    def now(self) -> float:
        with self._lock:
            return self.current

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        del cancel_event
        with self._lock:
            self.current = max(self.current, deadline)


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _route(
    tier: AcquisitionPath,
    key: str,
    *,
    group: str = "publisher-a",
) -> RouteSpec:
    return RouteSpec(
        route_key=f"{_PREFIX[tier]}:{key}",
        tier=tier,
        capability=(
            RouteCapability.BROWSER_PDF
            if tier is AcquisitionPath.CONTROLLED_BROWSER
            else RouteCapability.DIRECT_PDF
        ),
        readiness=RouteReadiness.READY,
        profile_access_key=(None if tier is AcquisitionPath.PUBLIC else group),
        quota_group=(group if tier is AcquisitionPath.AUTHORIZED_PROVIDER_API else None),
        risk_group=(group if tier is AcquisitionPath.CONTROLLED_BROWSER else None),
    )


def _plan(
    key: str,
    *,
    group: str = "publisher-a",
    tiers: tuple[AcquisitionPath, ...] = tuple(AcquisitionPath),
    extra_routes: tuple[RouteSpec, ...] = (),
) -> AcquisitionPlan:
    evidence = ResolutionEvidence(
        kind=ResolutionEvidenceKind.LANDING_ORIGIN,
        value=f"https://{group}.test",
        source="doi-landing",
    )
    routes = tuple(_route(tier, key, group=group) for tier in tiers) + extra_routes
    ordered_routes = tuple(
        sorted(routes, key=lambda route: tuple(AcquisitionPath).index(route.tier))
    )
    revision = (
        "sha256:"
        + hashlib.sha256(
            repr(tuple(route.route_key for route in ordered_routes)).encode()
        ).hexdigest()
    )
    return AcquisitionPlan(
        revision=revision,
        resolution=PublisherAccessResolution(
            access_key=group,
            selected_evidence_kind=ResolutionEvidenceKind.LANDING_ORIGIN,
            evidence=(evidence,),
        ),
        routes=ordered_routes,
    )


def _executor(
    *groups: str,
    max_concurrency: int = 4,
    confirmed: bool = True,
) -> TieredCohortExecutor:
    return TieredCohortExecutor(
        max_concurrency=max_concurrency,
        browser_scheduler=BrowserGroupScheduler(
            clock=_AdvancingBrowserClock(),
            max_concurrency=max_concurrency,
        ),
        browser_admission=BrowserAdmissionController(
            BrowserAdmissionConfiguration(
                explicitly_enabled=True,
                execution_confirmed=confirmed,
                runtime_ready=True,
                groups=tuple(
                    BrowserGroupAdmissionState(
                        policy=BrowserGroupPolicy(
                            rate_limit_group=group,
                            policy_revision="fixture-v1",
                            minimum_start_interval=10.0,
                            rate_limit_cooldown=60.0,
                            runtime_failure_threshold=3,
                        ),
                        session_key=group,
                        readiness=BrowserGroupReadiness.READY,
                    )
                    for group in groups
                ),
            )
        ),
    )


class _TemporaryContent:
    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        stream = BytesIO(b"%PDF-cohort-fixture")
        try:
            yield stream
        finally:
            stream.close()

    def discard(self) -> None:
        return


def _temporary(index: int, tier: AcquisitionPath) -> TemporaryPdf:
    return TemporaryPdf(
        candidate=PdfCandidate(
            candidate_key=f"fixture:{index}",
            source_name="fixture",
            acquisition_path=tier,
            declared_media_type="application/pdf",
        ),
        content=_TemporaryContent(),
        safe_source_url=f"https://fixture.invalid/{index}.pdf",
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 100)),
            source_kind=SourceKind.ASSET_PROVIDER,
            source_name="fixture",
            source_record_id=f"fixture:{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
    )


class TieredAcquisitionCohortTests(unittest.TestCase):
    def test_public_and_api_overlap_but_each_tier_is_a_global_barrier(self) -> None:
        items = tuple(AcquisitionWorkItem(work_key=key, plan=_plan(key)) for key in ("a", "b"))
        barriers = {
            AcquisitionPath.PUBLIC: threading.Barrier(2),
            AcquisitionPath.AUTHORIZED_PROVIDER_API: threading.Barrier(2),
        }
        lock = threading.Lock()
        completed = {tier: 0 for tier in AcquisitionPath}
        active = {tier: 0 for tier in AcquisitionPath}
        maximum = {tier: 0 for tier in AcquisitionPath}
        phases: list[AcquisitionPath] = []

        def execute(
            _item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            tier = route.tier
            with lock:
                if tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
                    self.assertEqual(completed[AcquisitionPath.PUBLIC], 2)
                elif tier is AcquisitionPath.CONTROLLED_BROWSER:
                    self.assertEqual(
                        completed[AcquisitionPath.AUTHORIZED_PROVIDER_API],
                        2,
                    )
                phases.append(tier)
                active[tier] += 1
                maximum[tier] = max(maximum[tier], active[tier])
            barrier = barriers.get(tier)
            if barrier is not None:
                try:
                    barrier.wait(timeout=3.0)
                except threading.BrokenBarrierError as error:
                    raise AssertionError("cohort tier did not run concurrently") from error
            with lock:
                active[tier] -= 1
                completed[tier] += 1
            return RouteExecutionResult.normal_miss()

        result = _executor("publisher-a", max_concurrency=2).execute(items, execute)

        self.assertEqual(
            phases,
            [
                AcquisitionPath.PUBLIC,
                AcquisitionPath.PUBLIC,
                AcquisitionPath.AUTHORIZED_PROVIDER_API,
                AcquisitionPath.AUTHORIZED_PROVIDER_API,
                AcquisitionPath.CONTROLLED_BROWSER,
                AcquisitionPath.CONTROLLED_BROWSER,
            ],
        )
        self.assertEqual(maximum[AcquisitionPath.PUBLIC], 2)
        self.assertEqual(maximum[AcquisitionPath.AUTHORIZED_PROVIDER_API], 2)
        self.assertEqual(maximum[AcquisitionPath.CONTROLLED_BROWSER], 1)
        self.assertEqual(tuple(item.work_key for item in result.items), ("a", "b"))
        self.assertTrue(
            all(item.disposition is WorkItemDisposition.EXHAUSTED for item in result.items)
        )

    def test_worker_count_is_bounded_while_independent_items_overlap(self) -> None:
        items = tuple(
            AcquisitionWorkItem(
                work_key=key,
                plan=_plan(key, tiers=(AcquisitionPath.PUBLIC,)),
            )
            for key in ("a", "b", "c")
        )
        first_pair = threading.Barrier(2)
        lock = threading.Lock()
        entered = 0
        active = 0
        maximum = 0

        def execute(
            _item: AcquisitionWorkItem,
            _route: RouteSpec,
        ) -> RouteExecutionResult:
            nonlocal active, entered, maximum
            with lock:
                entered += 1
                position = entered
                active += 1
                maximum = max(maximum, active)
            if position <= 2:
                try:
                    first_pair.wait(timeout=3.0)
                except threading.BrokenBarrierError as error:
                    raise AssertionError("bounded workers did not overlap") from error
            with lock:
                active -= 1
            return RouteExecutionResult.normal_miss()

        _executor(max_concurrency=2).execute(items, execute)

        self.assertEqual(entered, 3)
        self.assertEqual(maximum, 2)

    def test_public_and_api_successes_leave_only_the_minimum_browser_set(self) -> None:
        items = tuple(AcquisitionWorkItem(work_key=key, plan=_plan(key)) for key in ("a", "b", "c"))
        browser_work: list[str] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if item.work_key == "a" and route.tier is AcquisitionPath.PUBLIC:
                return RouteExecutionResult.delivered(_temporary(1, AcquisitionPath.PUBLIC))
            if item.work_key == "b" and route.tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
                return RouteExecutionResult.delivered(
                    _temporary(2, AcquisitionPath.AUTHORIZED_PROVIDER_API)
                )
            if route.tier is AcquisitionPath.CONTROLLED_BROWSER:
                browser_work.append(item.work_key)
            return RouteExecutionResult.normal_miss()

        result = _executor("publisher-a").execute(items, execute)

        self.assertEqual(browser_work, ["c"])
        self.assertEqual(
            tuple(item.disposition for item in result.items),
            (
                WorkItemDisposition.DELIVERED,
                WorkItemDisposition.DELIVERED,
                WorkItemDisposition.EXHAUSTED,
            ),
        )
        self.assertEqual(
            tuple(decision.work_key for decision in result.browser_admission.decisions),
            ("c",),
        )
        self.assertEqual(result.browser_admission.summary.groups[0].paper_count, 1)

    def test_browser_groups_overlap_but_each_group_keeps_one_article_flow(self) -> None:
        items = tuple(
            AcquisitionWorkItem(work_key=key, plan=_plan(key, group=group))
            for key, group in (
                ("w1", "wiley"),
                ("w2", "wiley"),
                ("e1", "elsevier"),
                ("e2", "elsevier"),
            )
        )
        first_group_barrier = threading.Barrier(2)
        lock = threading.Lock()
        active_by_group: dict[str, int] = {}
        maximum_by_group: dict[str, int] = {}
        maximum_total = 0
        starts: list[tuple[str, str]] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            nonlocal maximum_total
            if route.tier is not AcquisitionPath.CONTROLLED_BROWSER:
                return RouteExecutionResult.normal_miss()
            group = route.risk_group
            self.assertIsNotNone(group)
            assert group is not None
            with lock:
                active_by_group[group] = active_by_group.get(group, 0) + 1
                maximum_by_group[group] = max(
                    maximum_by_group.get(group, 0),
                    active_by_group[group],
                )
                maximum_total = max(maximum_total, sum(active_by_group.values()))
                starts.append((group, item.work_key))
            if item.work_key in {"w1", "e1"}:
                first_group_barrier.wait(1.0)
            with lock:
                active_by_group[group] -= 1
            return RouteExecutionResult.normal_miss()

        result = _executor("wiley", "elsevier", max_concurrency=2).execute(
            items,
            execute,
        )

        self.assertEqual(maximum_by_group, {"wiley": 1, "elsevier": 1})
        self.assertEqual(maximum_total, 2)
        self.assertEqual(
            tuple(key for group, key in starts if group == "wiley"),
            ("w1", "w2"),
        )
        self.assertEqual(
            tuple(key for group, key in starts if group == "elsevier"),
            ("e1", "e2"),
        )
        self.assertTrue(all(item.exhausted for item in result.items))

    def test_browser_rate_limit_stops_queued_callback_and_next_cohort_at_admission(self) -> None:
        executor = _executor("wiley", "elsevier", max_concurrency=2)
        items = tuple(
            AcquisitionWorkItem(work_key=key, plan=_plan(key, group=group))
            for key, group in (("w1", "wiley"), ("w2", "wiley"), ("e1", "elsevier"))
        )
        browser_calls: list[str] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if route.tier is not AcquisitionPath.CONTROLLED_BROWSER:
                return RouteExecutionResult.normal_miss()
            browser_calls.append(item.work_key)
            if item.work_key == "w1":
                return RouteExecutionResult.deferred(
                    StableFailure(
                        code="acquisition-browser-rate-limited",
                        reason="The fixture provider is rate limited.",
                        action="Retry after the fixture provider cooldown.",
                        retryable=True,
                    )
                )
            return RouteExecutionResult.normal_miss()

        first = executor.execute(items, execute)

        self.assertEqual(set(browser_calls), {"w1", "e1"})
        self.assertEqual(
            tuple(item.disposition for item in first.items),
            (
                WorkItemDisposition.DEFERRED,
                WorkItemDisposition.DEFERRED,
                WorkItemDisposition.EXHAUSTED,
            ),
        )
        self.assertNotIn("browser:w2", first.items[1].attempted_route_keys)
        self.assertIsNotNone(first.items[1].failure)
        if first.items[1].failure is None:
            self.fail("queued rate-limited item did not retain a stable failure")
        self.assertEqual(
            first.items[1].failure.code,
            "acquisition-browser-group-rate-limited",
        )

        browser_calls.clear()
        second = executor.execute(
            (AcquisitionWorkItem(work_key="w3", plan=_plan("alternate", group="wiley")),),
            execute,
        )
        self.assertEqual(browser_calls, [])
        self.assertIs(second.items[0].disposition, WorkItemDisposition.DEFERRED)
        self.assertIs(
            second.browser_admission.decisions[0].disposition,
            BrowserAdmissionDisposition.DEFERRED,
        )
        self.assertEqual(second.browser_admission.summary.groups[0].readiness, "rate-limited")

    def test_browser_challenge_opens_only_its_group_circuit(self) -> None:
        executor = _executor("wiley", "elsevier", max_concurrency=2)
        items = tuple(
            AcquisitionWorkItem(work_key=key, plan=_plan(key, group=group))
            for key, group in (("w1", "wiley"), ("w2", "wiley"), ("e1", "elsevier"))
        )
        browser_calls: list[str] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if route.tier is not AcquisitionPath.CONTROLLED_BROWSER:
                return RouteExecutionResult.normal_miss()
            browser_calls.append(item.work_key)
            if item.work_key == "w1":
                return RouteExecutionResult.action_required(
                    StableFailure(
                        code="acquisition-browser-challenge-required",
                        reason="The fixture provider requires a challenge review.",
                        action="Review the fixture provider outside automation.",
                        retryable=False,
                    )
                )
            return RouteExecutionResult.normal_miss()

        result = executor.execute(items, execute)

        self.assertEqual(set(browser_calls), {"w1", "e1"})
        self.assertEqual(
            tuple(item.disposition for item in result.items),
            (
                WorkItemDisposition.ACTION_REQUIRED,
                WorkItemDisposition.ACTION_REQUIRED,
                WorkItemDisposition.EXHAUSTED,
            ),
        )
        self.assertNotIn("browser:w2", result.items[1].attempted_route_keys)
        self.assertIsNotNone(result.items[1].failure)
        if result.items[1].failure is None:
            self.fail("queued circuit item did not retain a stable failure")
        self.assertEqual(
            result.items[1].failure.code,
            "acquisition-browser-group-challenge-required",
        )

    def test_browser_cleanup_failure_stops_same_group_without_exhaustion(self) -> None:
        executor = _executor("wiley", "elsevier", max_concurrency=2)
        items = tuple(
            AcquisitionWorkItem(work_key=key, plan=_plan(key, group=group))
            for key, group in (("w1", "wiley"), ("w2", "wiley"), ("e1", "elsevier"))
        )
        browser_calls: list[str] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if route.tier is not AcquisitionPath.CONTROLLED_BROWSER:
                return RouteExecutionResult.normal_miss()
            browser_calls.append(item.work_key)
            if item.work_key == "w1":
                return RouteExecutionResult.failed(
                    StableFailure(
                        code="acquisition-browser-cleanup-failed",
                        reason="The fixture Browser cleanup failed.",
                        action="Repair the fixture Browser runtime.",
                        retryable=True,
                    )
                )
            return RouteExecutionResult.normal_miss()

        result = executor.execute(items, execute)

        self.assertEqual(set(browser_calls), {"w1", "e1"})
        self.assertEqual(
            tuple(item.disposition for item in result.items),
            (
                WorkItemDisposition.FAILED,
                WorkItemDisposition.ACTION_REQUIRED,
                WorkItemDisposition.EXHAUSTED,
            ),
        )
        self.assertNotIn("browser:w2", result.items[1].attempted_route_keys)
        self.assertIsNotNone(result.items[1].failure)
        if result.items[1].failure is None:
            self.fail("queued cleanup circuit item did not retain a stable failure")
        self.assertEqual(
            result.items[1].failure.code,
            "acquisition-browser-group-cleanup-failure",
        )

    def test_tier_observer_exposes_public_terminal_items_before_browser_execution(
        self,
    ) -> None:
        items = tuple(AcquisitionWorkItem(work_key=key, plan=_plan(key)) for key in ("a", "b"))
        observed: list[tuple[AcquisitionPath, tuple[WorkItemDisposition, ...]]] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if item.work_key == "a" and route.tier is AcquisitionPath.PUBLIC:
                return RouteExecutionResult.delivered(_temporary(1, AcquisitionPath.PUBLIC))
            if route.tier is AcquisitionPath.CONTROLLED_BROWSER:
                self.assertEqual(
                    observed[0],
                    (
                        AcquisitionPath.PUBLIC,
                        (
                            WorkItemDisposition.DELIVERED,
                            WorkItemDisposition.PENDING,
                        ),
                    ),
                )
            return RouteExecutionResult.normal_miss()

        _executor("publisher-a").execute(
            items,
            execute,
            on_tier_completed=lambda tier, results: observed.append(
                (tier, tuple(item.disposition for item in results))
            ),
        )

        self.assertEqual(
            tuple(tier for tier, _items in observed),
            tuple(AcquisitionPath),
        )

    def test_default_admission_never_starts_hidden_browser_traffic(self) -> None:
        item = AcquisitionWorkItem(work_key="a", plan=_plan("a"))
        browser_work: list[str] = []

        result = TieredCohortExecutor().execute(
            (item,),
            lambda current, route: (
                (
                    browser_work.append(current.work_key)
                    if route.tier is AcquisitionPath.CONTROLLED_BROWSER
                    else None
                )
                or RouteExecutionResult.normal_miss()
            ),
        )

        self.assertEqual(browser_work, [])
        self.assertIs(result.items[0].disposition, WorkItemDisposition.EXHAUSTED)
        self.assertIs(
            result.browser_admission.decisions[0].disposition,
            BrowserAdmissionDisposition.REJECTED,
        )

    def test_unconfirmed_browser_is_action_required_with_a_duration_summary(self) -> None:
        item = AcquisitionWorkItem(work_key="a", plan=_plan("a"))
        browser_work: list[str] = []

        result = _executor("publisher-a", confirmed=False).execute(
            (item,),
            lambda current, route: (
                (
                    browser_work.append(current.work_key)
                    if route.tier is AcquisitionPath.CONTROLLED_BROWSER
                    else None
                )
                or RouteExecutionResult.normal_miss()
            ),
        )

        self.assertEqual(browser_work, [])
        self.assertIs(
            result.items[0].disposition,
            WorkItemDisposition.ACTION_REQUIRED,
        )
        summary = result.browser_admission.summary.groups[0]
        self.assertEqual(summary.eligible_count, 1)
        self.assertEqual(summary.allowed_count, 0)
        self.assertEqual(summary.conservative_minimum_duration_seconds, 0.0)

    def test_replanning_runs_new_same_tier_routes_once_without_repeating_misses(self) -> None:
        seed = _route(AcquisitionPath.PUBLIC, "seed")
        initial = _plan("initial", tiers=(), extra_routes=(seed,))
        derived = _route(AcquisitionPath.PUBLIC, "derived")
        api = _route(AcquisitionPath.AUTHORIZED_PROVIDER_API, "derived")
        refreshed = _plan("refreshed", tiers=(), extra_routes=(seed, derived, api))
        item = AcquisitionWorkItem(work_key="a", plan=initial)
        hint = AccessRouteHint(
            kind=AccessRouteHintKind.CANONICAL_LANDING,
            value="https://publisher-a.test/article",
            source_route_key="public:seed",
            profile_access_key="publisher-a",
        )
        attempts: list[str] = []

        def execute(
            _item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            attempts.append(route.route_key)
            if route.route_key == "public:seed":
                return RouteExecutionResult.hints_only(hint)
            return RouteExecutionResult.normal_miss()

        def refresh(current: AcquisitionWorkItem) -> AcquisitionPlan:
            return refreshed if hint in current.route_hints else current.plan

        result = TieredCohortExecutor().execute(
            (item,),
            execute,
            refresh_plan=refresh,
        )

        self.assertEqual(
            attempts,
            ["public:seed", "public:derived", "api:derived"],
        )
        self.assertEqual(item.plan_revisions, [initial.revision, refreshed.revision])
        self.assertEqual(
            result.items[0].attempted_route_keys,
            ("public:seed", "public:derived", "api:derived"),
        )

    def test_replanning_cycle_fails_locally_instead_of_looping(self) -> None:
        seed = _route(AcquisitionPath.PUBLIC, "seed")
        initial = _plan("initial", tiers=(), extra_routes=(seed,))
        derived = _route(AcquisitionPath.PUBLIC, "derived")
        refreshed = _plan("refreshed", tiers=(), extra_routes=(seed, derived))
        item = AcquisitionWorkItem(work_key="a", plan=initial)

        with self.assertLogs("sciretriever.acquisition.cohort", level="INFO") as captured:
            result = TieredCohortExecutor().execute(
                (item,),
                lambda _item, _route: RouteExecutionResult.normal_miss(),
                refresh_plan=lambda current: (
                    refreshed if current.plan.revision == initial.revision else initial
                ),
            )

        self.assertIs(result.items[0].disposition, WorkItemDisposition.FAILED)
        failure = result.items[0].failure
        self.assertIsNotNone(failure)
        if failure is None:
            self.fail("plan cycle did not retain its stable failure")
        self.assertEqual(failure.code, "acquisition-plan-cycle")
        output = "\n".join(captured.output)
        self.assertIn("event=acquisition-plan-failed", output)
        self.assertIn("tier=public", output)

    def test_info_logging_explains_tiers_groups_misses_and_stable_failures(self) -> None:
        items = (
            AcquisitionWorkItem(work_key="deferred", plan=_plan("deferred")),
            AcquisitionWorkItem(
                work_key="exhausted",
                plan=_plan("exhausted", group="publisher-b"),
            ),
            AcquisitionWorkItem(
                work_key="delivered",
                plan=_plan("delivered", group="publisher-b"),
            ),
        )
        quota_failure = StableFailure(
            code="acquisition-authorized-quota",
            reason="The fixture API quota is temporarily exhausted.",
            action="Retry after the shared fixture quota resets.",
            retryable=True,
        )

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if (
                item.work_key == "deferred"
                and route.tier is AcquisitionPath.AUTHORIZED_PROVIDER_API
            ):
                return RouteExecutionResult.deferred(quota_failure)
            if item.work_key == "delivered" and route.tier is AcquisitionPath.PUBLIC:
                return RouteExecutionResult.delivered(_temporary(99, AcquisitionPath.PUBLIC))
            return RouteExecutionResult.normal_miss()

        with self.assertLogs("sciretriever.acquisition.cohort", level="INFO") as captured:
            result = _executor("publisher-a", "publisher-b").execute(items, execute)

        output = "\n".join(captured.output)
        self.assertEqual(
            tuple(item.disposition for item in result.items),
            (
                WorkItemDisposition.DEFERRED,
                WorkItemDisposition.EXHAUSTED,
                WorkItemDisposition.DELIVERED,
            ),
        )
        for tier in AcquisitionPath:
            self.assertIn(f"event=acquisition-tier-started tier={tier.value}", output)
            self.assertIn(f"event=acquisition-tier-finished tier={tier.value}", output)
        self.assertIn("event=acquisition-route-missed", output)
        self.assertIn("event=acquisition-route-delivered", output)
        self.assertIn("provider_group=publisher-b", output)
        self.assertIn("code=acquisition-authorized-quota", output)
        self.assertIn(quota_failure.reason, output)
        self.assertIn(quota_failure.action, output)
        self.assertNotIn("plan_revision=", output)
        delivered = result.items[2].temporary_pdf
        self.assertIsNotNone(delivered)
        assert delivered is not None
        delivered.content.discard()

    def test_debug_logging_uses_only_safe_plan_and_route_identities(self) -> None:
        item = AcquisitionWorkItem(work_key="debug-target", plan=_plan("debug-target"))

        with self.assertLogs("sciretriever.acquisition.cohort", level="DEBUG") as captured:
            _executor("publisher-a").execute(
                (item,),
                lambda _item, _route: RouteExecutionResult.normal_miss(),
            )

        output = "\n".join(captured.output)
        self.assertIn(f"plan_revision={item.plan.revision}", output)
        self.assertIn("resolution_evidence_kind=landing-origin", output)
        self.assertIn("route_key=public:debug-target", output)
        self.assertIn("provider_group=publisher-a", output)
        self.assertNotIn("https://publisher-a.test", output)


if __name__ == "__main__":
    unittest.main()
