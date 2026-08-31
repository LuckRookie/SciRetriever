from __future__ import annotations

import hashlib
import pickle
import threading
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from io import BytesIO
from typing import BinaryIO, cast

from sciretriever.acquisition.browser_admission import (
    BrowserAdmissionConfiguration,
    BrowserAdmissionController,
    BrowserAdmissionDisposition,
    BrowserGroupAdmissionState,
    BrowserGroupReadiness,
)
from sciretriever.acquisition.cohort import (
    AcquisitionProgressObserver,
    AcquisitionProgressPhase,
    AcquisitionProgressSnapshot,
    AcquisitionWorkItem,
    BrowserEscalationObserver,
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
    def test_route_local_failure_does_not_hide_a_later_independent_success(self) -> None:
        first = _route(AcquisitionPath.PUBLIC, "first")
        second = _route(AcquisitionPath.PUBLIC, "second")
        item = AcquisitionWorkItem(
            work_key="route-fallback",
            plan=_plan("route-fallback", tiers=(), extra_routes=(first, second)),
        )
        failure = StableFailure(
            code="acquisition-fixture-first-route",
            reason="The first independent fixture route failed.",
            action="Inspect the first fixture route.",
            retryable=True,
        )

        with self.assertLogs("sciretriever.acquisition.cohort", level="DEBUG") as captured:
            result = TieredCohortExecutor().execute(
                (item,),
                lambda _item, route: (
                    RouteExecutionResult.failed(failure)
                    if route.route_key == first.route_key
                    else RouteExecutionResult.delivered(_temporary(101, AcquisitionPath.PUBLIC))
                ),
            )

        self.assertEqual(
            result.items[0].attempted_route_keys,
            (first.route_key, second.route_key),
        )
        self.assertIs(result.items[0].disposition, WorkItemDisposition.DELIVERED)
        self.assertIsNone(result.items[0].failure)
        output = "\n".join(captured.output)
        first_result = next(
            line for line in captured.output if "event=acquisition-route-failure" in line
        )
        self.assertIn(f"route_key={first.route_key}", first_result)
        self.assertIn("disposition=failure next=next-route", first_result)
        self.assertRegex(first_result, r"elapsed_ms=\d+")
        self.assertIn("event=acquisition-route-delivered", output)
        delivered = result.items[0].temporary_pdf
        self.assertIsNotNone(delivered)
        assert delivered is not None
        delivered.content.discard()

    def test_public_route_local_failure_does_not_hide_later_api_success(self) -> None:
        public = _route(AcquisitionPath.PUBLIC, "landing-crossref")
        api = _route(AcquisitionPath.AUTHORIZED_PROVIDER_API, "publisher-pdf")
        item = AcquisitionWorkItem(
            work_key="api-rescue",
            plan=_plan("api-rescue", tiers=(), extra_routes=(public, api)),
        )
        failure = StableFailure(
            code="acquisition-public-locator-network-failed",
            reason="The public fixture locator could not be accessed safely.",
            action="Continue with an independent verified route.",
            retryable=False,
        )

        result = TieredCohortExecutor().execute(
            (item,),
            lambda _item, route: (
                RouteExecutionResult.failed(failure)
                if route is public
                else RouteExecutionResult.delivered(
                    _temporary(102, AcquisitionPath.AUTHORIZED_PROVIDER_API)
                )
            ),
        )

        self.assertEqual(result.items[0].attempted_route_keys, (public.route_key, api.route_key))
        self.assertIs(result.items[0].disposition, WorkItemDisposition.DELIVERED)
        self.assertIsNone(result.items[0].failure)
        delivered = result.items[0].temporary_pdf
        self.assertIsNotNone(delivered)
        assert delivered is not None
        delivered.content.discard()

    def test_four_strong_springerlink_items_reach_browser_after_public_failures(self) -> None:
        public = _route(
            AcquisitionPath.PUBLIC,
            "landing-crossref",
            group="springerlink",
        )
        api = _route(
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            "springer-api",
            group="springerlink",
        )
        browser = _route(
            AcquisitionPath.CONTROLLED_BROWSER,
            "springerlink",
            group="springerlink",
        )
        items = tuple(
            AcquisitionWorkItem(
                work_key=f"springer-{index}",
                plan=_plan(
                    f"springer-{index}",
                    group="springerlink",
                    tiers=(),
                    extra_routes=(public, api, browser),
                ),
            )
            for index in range(1, 5)
        )
        public_failure = StableFailure(
            code="acquisition-public-locator-network-failed",
            reason="The public fixture locator could not be accessed safely.",
            action="Continue with the verified SpringerLink Browser route.",
            retryable=False,
        )
        browser_attempts: list[str] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if route is public:
                return RouteExecutionResult.failed(public_failure)
            if route is api:
                return RouteExecutionResult.normal_miss()
            browser_attempts.append(item.work_key)
            return RouteExecutionResult.delivered(
                _temporary(110 + int(item.work_key.rpartition("-")[2]), route.tier)
            )

        result = _executor("springerlink").execute(items, execute)

        self.assertEqual(browser_attempts, [f"springer-{index}" for index in range(1, 5)])
        self.assertEqual(
            tuple(decision.work_key for decision in result.browser_admission.decisions),
            tuple(browser_attempts),
        )
        self.assertTrue(
            all(
                decision.disposition is BrowserAdmissionDisposition.ALLOWED
                for decision in result.browser_admission.decisions
            )
        )
        summary = result.browser_admission.summary.groups[0]
        self.assertEqual((summary.eligible_count, summary.allowed_count), (4, 4))
        self.assertTrue(
            all(item.disposition is WorkItemDisposition.DELIVERED for item in result.items)
        )
        for item in result.items:
            self.assertEqual(
                item.attempted_route_keys,
                (public.route_key, api.route_key, browser.route_key),
            )
            self.assertIsNone(item.failure)
            delivered = item.temporary_pdf
            self.assertIsNotNone(delivered)
            assert delivered is not None
            delivered.content.discard()

    def test_unrescued_route_local_failure_survives_browser_miss(self) -> None:
        public = _route(AcquisitionPath.PUBLIC, "landing-crossref")
        browser = _route(AcquisitionPath.CONTROLLED_BROWSER, "publisher-browser")
        item = AcquisitionWorkItem(
            work_key="unrescued-route-failure",
            plan=_plan(
                "unrescued-route-failure",
                tiers=(),
                extra_routes=(public, browser),
            ),
        )
        failure = StableFailure(
            code="acquisition-public-locator-response-failed",
            reason="The public fixture locator returned a non-miss response.",
            action="Review the first route failure before retrying.",
            retryable=False,
        )

        result = _executor("publisher-a").execute(
            (item,),
            lambda _item, route: (
                RouteExecutionResult.failed(failure)
                if route is public
                else RouteExecutionResult.normal_miss()
            ),
        )

        self.assertEqual(
            result.items[0].attempted_route_keys,
            (public.route_key, browser.route_key),
        )
        self.assertIs(result.items[0].disposition, WorkItemDisposition.FAILED)
        self.assertEqual(result.items[0].failure, failure)
        self.assertFalse(result.items[0].exhausted)

    def test_unresolved_low_risk_issue_blocks_browser_only_after_api_pass(self) -> None:
        public = _route(AcquisitionPath.PUBLIC, "public")
        api = _route(AcquisitionPath.AUTHORIZED_PROVIDER_API, "api")
        browser = _route(AcquisitionPath.CONTROLLED_BROWSER, "browser")
        item = AcquisitionWorkItem(
            work_key="low-risk-issue",
            plan=_plan(
                "low-risk-issue",
                tiers=(),
                extra_routes=(public, api, browser),
            ),
        )
        attempts: list[str] = []
        failure = StableFailure(
            code="acquisition-fixture-public-deferred",
            reason="The public fixture route is temporarily unavailable.",
            action="Retry the public fixture route later.",
            retryable=True,
        )

        def execute(
            _item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            attempts.append(route.route_key)
            if route is public:
                return RouteExecutionResult.deferred(failure)
            return RouteExecutionResult.normal_miss()

        result = _executor("publisher-a").execute((item,), execute)

        self.assertEqual(attempts, [public.route_key, api.route_key])
        self.assertIs(result.items[0].disposition, WorkItemDisposition.DEFERRED)
        self.assertEqual(result.items[0].failure, failure)
        self.assertEqual(result.browser_admission.decisions, ())

    def test_fatal_route_contract_failure_stops_the_item_immediately(self) -> None:
        first = _route(AcquisitionPath.PUBLIC, "fatal")
        second = _route(AcquisitionPath.PUBLIC, "hidden")
        item = AcquisitionWorkItem(
            work_key="fatal-contract",
            plan=_plan("fatal-contract", tiers=(), extra_routes=(first, second)),
        )
        attempts: list[str] = []
        failure = StableFailure(
            code="acquisition-port-contract",
            reason="The fixture component violated its contract.",
            action="Correct the fixture assembly.",
            retryable=False,
        )

        def execute(
            _item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            attempts.append(route.route_key)
            return RouteExecutionResult.fatal(failure)

        result = TieredCohortExecutor().execute((item,), execute)

        self.assertEqual(attempts, [first.route_key])
        self.assertIs(result.items[0].disposition, WorkItemDisposition.FAILED)
        self.assertEqual(result.items[0].failure, failure)

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

    def test_browser_challenge_unresolved_remains_article_local(self) -> None:
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
                        code="acquisition-browser-challenge-unresolved",
                        reason="The fixture challenge remained after controller stop.",
                        action="Retry this article or use another approved source.",
                        retryable=True,
                    )
                )
            return RouteExecutionResult.normal_miss()

        result = executor.execute(items, execute)

        self.assertEqual(set(browser_calls), {"w1", "w2", "e1"})
        self.assertEqual(
            tuple(item.disposition for item in result.items),
            (
                WorkItemDisposition.ACTION_REQUIRED,
                WorkItemDisposition.EXHAUSTED,
                WorkItemDisposition.EXHAUSTED,
            ),
        )
        self.assertIn("browser:w2", result.items[1].attempted_route_keys)
        self.assertIsNone(result.items[1].failure)

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

    def test_progress_snapshots_partition_every_tier_and_group(self) -> None:
        items = tuple(
            AcquisitionWorkItem(work_key=key, plan=_plan(key, group=group))
            for key, group in (
                ("delivered", "publisher-b"),
                ("deferred", "publisher-a"),
                ("action", "publisher-b"),
                ("failed", "publisher-a"),
                ("exhausted", "publisher-c"),
            )
        )
        progress: list[AcquisitionProgressSnapshot] = []

        def execute(
            item: AcquisitionWorkItem,
            route: RouteSpec,
        ) -> RouteExecutionResult:
            if item.work_key == "delivered" and route.tier is AcquisitionPath.PUBLIC:
                return RouteExecutionResult.delivered(_temporary(71, AcquisitionPath.PUBLIC))
            if route.tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
                failure = StableFailure(
                    code=f"acquisition-fixture-{item.work_key}",
                    reason="The fixture route reached a stable terminal state.",
                    action="Follow the fixture action before retrying.",
                    retryable=item.work_key == "deferred",
                )
                if item.work_key == "deferred":
                    return RouteExecutionResult.deferred(failure)
                if item.work_key == "action":
                    return RouteExecutionResult.action_required(failure)
                if item.work_key == "failed":
                    return RouteExecutionResult.failed(failure)
            return RouteExecutionResult.normal_miss()

        result = _executor(
            "publisher-a",
            "publisher-b",
            "publisher-c",
        ).execute(items, execute, on_progress=progress.append)

        self.assertEqual(
            tuple((snapshot.tier, snapshot.phase) for snapshot in progress),
            tuple(
                (tier, phase)
                for tier in AcquisitionPath
                for phase in (
                    AcquisitionProgressPhase.STARTED,
                    AcquisitionProgressPhase.FINISHED,
                )
            ),
        )
        for snapshot in progress:
            self.assertEqual(
                snapshot.selected,
                sum(
                    (
                        snapshot.resolved,
                        snapshot.pending,
                        snapshot.deferred,
                        snapshot.action_required,
                        snapshot.failed,
                        snapshot.exhausted,
                    )
                ),
            )
            self.assertEqual(
                snapshot.selected,
                sum(group.selected for group in snapshot.groups),
            )
            self.assertEqual(
                tuple(group.provider_group for group in snapshot.groups),
                tuple(sorted(group.provider_group for group in snapshot.groups)),
            )
        self.assertEqual(
            (
                progress[1].selected,
                progress[1].resolved,
                progress[1].pending,
                progress[1].deferred,
                progress[1].action_required,
                progress[1].failed,
                progress[1].exhausted,
            ),
            (5, 1, 4, 0, 0, 0, 0),
        )
        self.assertEqual(
            (
                progress[3].selected,
                progress[3].resolved,
                progress[3].pending,
                progress[3].deferred,
                progress[3].action_required,
                progress[3].failed,
                progress[3].exhausted,
            ),
            (5, 1, 2, 1, 1, 0, 0),
        )
        self.assertEqual(
            (
                progress[-1].selected,
                progress[-1].resolved,
                progress[-1].pending,
                progress[-1].deferred,
                progress[-1].action_required,
                progress[-1].failed,
                progress[-1].exhausted,
            ),
            (5, 1, 0, 1, 1, 1, 1),
        )
        self.assertEqual(
            tuple(group.provider_group for group in progress[-1].groups),
            ("publisher-a", "publisher-b", "publisher-c"),
        )
        for value in (progress[-1], progress[-1].groups[0]):
            with self.assertRaisesRegex(TypeError, "cannot be serialized"):
                pickle.dumps(value)
        delivered = result.items[0].temporary_pdf
        self.assertIsNotNone(delivered)
        assert delivered is not None
        delivered.content.discard()

    def test_invalid_progress_observers_are_rejected_before_route_io(self) -> None:
        route_calls: list[str] = []

        def execute(item: AcquisitionWorkItem, _route: RouteSpec) -> RouteExecutionResult:
            route_calls.append(item.work_key)
            return RouteExecutionResult.normal_miss()

        invalid_progress = cast(AcquisitionProgressObserver, object())
        with self.assertRaisesRegex(TypeError, "on_progress must be callable"):
            TieredCohortExecutor().execute(
                (AcquisitionWorkItem(work_key="progress", plan=_plan("progress")),),
                execute,
                on_progress=invalid_progress,
            )
        invalid_escalation = cast(BrowserEscalationObserver, object())
        with self.assertRaisesRegex(TypeError, "on_browser_escalation must be callable"):
            TieredCohortExecutor().execute(
                (AcquisitionWorkItem(work_key="browser", plan=_plan("browser")),),
                execute,
                on_browser_escalation=invalid_escalation,
            )
        self.assertEqual(route_calls, [])

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

    def test_info_logging_keeps_results_and_failures_without_debug_route_noise(self) -> None:
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
        self.assertIn("event=acquisition-cohort-started", output)
        self.assertIn("event=acquisition-cohort-finished", output)
        self.assertIn("event=acquisition-route-delivered", output)
        self.assertIn("provider_group=publisher-b", output)
        self.assertIn("code=acquisition-authorized-quota", output)
        self.assertIn(quota_failure.reason, output)
        self.assertIn(quota_failure.action, output)
        self.assertNotIn("event=acquisition-route-missed", output)
        self.assertNotIn("event=acquisition-tier-started", output)
        self.assertNotIn("event=acquisition-tier-finished", output)
        self.assertNotIn("event=acquisition-tier-group-progress", output)
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
        self.assertIn("event=acquisition-route-missed", output)
        self.assertIn("disposition=miss", output)
        self.assertIn("next=", output)
        self.assertRegex(output, r"elapsed_ms=\d+")
        for tier in AcquisitionPath:
            self.assertIn(f"event=acquisition-tier-started tier={tier.value}", output)
            self.assertIn(f"event=acquisition-tier-finished tier={tier.value}", output)
        self.assertIn("event=acquisition-tier-group-progress", output)
        self.assertIn("event=acquisition-browser-escalation-ready", output)
        self.assertIn("eligible=1 admitted=1", output)
        self.assertIn("event=acquisition-browser-admission-allowed", output)
        self.assertNotIn("https://publisher-a.test", output)


if __name__ == "__main__":
    unittest.main()
