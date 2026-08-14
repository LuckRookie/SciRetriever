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
from sciretriever.network.browser_scheduler import BrowserGroupPolicy

_TIME = UtcTimestamp("2026-08-15T00:00:00Z")
_HASH = Sha256("a" * 64)
_PREFIX = {
    AcquisitionPath.PUBLIC: "public",
    AcquisitionPath.AUTHORIZED_PROVIDER_API: "api",
    AcquisitionPath.CONTROLLED_BROWSER: "browser",
}


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
        browser_admission=BrowserAdmissionController(
            BrowserAdmissionConfiguration(
                explicitly_enabled=True,
                execution_confirmed=confirmed,
                runtime_ready=True,
                groups=tuple(
                    BrowserGroupAdmissionState(
                        policy=BrowserGroupPolicy(
                            rate_limit_group=group,
                            minimum_start_interval=10.0,
                        ),
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


if __name__ == "__main__":
    unittest.main()
