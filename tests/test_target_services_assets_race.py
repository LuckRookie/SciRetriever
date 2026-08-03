from __future__ import annotations

import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from target_content_assets_support import (
    UUID_A,
    UUID_B,
    ControlledFetcher,
    DeterministicRaceFetcher,
    FailingResolver,
    RecordingPublisher,
    RecordingStore,
    Resolver,
    candidate,
    pdf,
    stream,
    target,
)

from sciretriever.infrastructure.access.racing import CandidateRace
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.model.assets import ContentAssetFailure, ContentAssetReplay, ContentAssetSuccess
from sciretriever.model.execution import TargetProjection, TargetResult
from sciretriever.model.primitives import AssetRole, BatchRunId, WorkVersionId
from sciretriever.services.assets import (
    AssetAcceptancePolicy,
    AssetServiceDependencies,
    ContentAssetService,
    ResolverTier,
)


class TargetContentAssetRaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-content-race-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.events: list[str] = []
        self.projection = TargetProjection(
            batch_run_id=BatchRunId(UUID_B),
            work_version_id=WorkVersionId(UUID_A),
            result=TargetResult(
                subject_type="work-version",
                subject_id=UUID_A,
                outcome="partially-advanced",
                initial_state="unreviewed",
                target_state="asset-ready",
                final_state="asset-ready",
                stage="asset",
                failure=None,
            ),
            details=CanonicalJsonObject(()),
            failure_stages_to_clear=(),
        )
        self.publisher = RecordingPublisher(self.events, self.projection)

    def service(
        self,
        tiers: tuple[ResolverTier, ...],
        fetcher: ControlledFetcher | DeterministicRaceFetcher,
        *,
        timeout: float = 1.0,
        cancellable: bool = False,
    ) -> ContentAssetService:
        return ContentAssetService(
            AssetServiceDependencies(
                tiers=tiers,
                fetcher=fetcher,
                store=RecordingStore(self.root / "storage", self.events),
                publisher=self.publisher,
                race=CandidateRace(deadline_seconds=timeout),
                cancellable_fetcher=fetcher if cancellable else None,
            ),
            AssetAcceptancePolicy(min_pdf_bytes=300),
        )

    def test_race_failure_isolated_from_valid_sibling(self) -> None:
        bad = candidate("bad", provider="bad")
        good = candidate("good", provider="good")
        fetcher = ControlledFetcher(
            {bad.locator: TimeoutError("secret"), good.locator: stream(pdf())}
        )
        service = self.service((ResolverTier("first", (Resolver((bad, good)),), True),), fetcher)

        result = service.accept(target(), AssetRole.PRIMARY_PDF, self.projection)

        self.assertIsInstance(result, ContentAssetSuccess)
        self.assertEqual(len(self.publisher.commands), 1)

    def test_resolver_failure_isolated_and_retained_on_later_success(self) -> None:
        good = candidate("good", provider="good")
        service = self.service(
            (
                ResolverTier(
                    "first",
                    (FailingResolver("broken"), Resolver((good,), identity="good")),
                    False,
                ),
            ),
            ControlledFetcher({good.locator: stream(pdf())}),
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF, self.projection)

        self.assertIsInstance(result, ContentAssetSuccess)
        assert isinstance(result, ContentAssetSuccess)
        self.assertEqual(
            tuple((item.provider, item.outcome) for item in result.evidence),
            (("broken", "resolver-failed"),),
        )
        self.assertNotIn("private", str(result.evidence))

    def test_race_returns_first_valid_and_cancels_cooperative_late_loser(self) -> None:
        fast = candidate("fast", provider="fast")
        late = candidate("late", provider="late")
        fetcher = DeterministicRaceFetcher(
            {fast.locator: stream(pdf()), late.locator: stream(pdf(doi="10.9999/late"))},
        )
        service = self.service(
            (ResolverTier("first", (Resolver((fast, late)),), True),),
            fetcher,
            cancellable=True,
        )
        results: list[ContentAssetSuccess | ContentAssetFailure | ContentAssetReplay] = []

        def accept() -> None:
            results.append(service.accept(target(), AssetRole.PRIMARY_PDF, self.projection))
            fetcher.service_done.set()

        service_thread = threading.Thread(target=accept)
        service_thread.start()

        self.assertTrue(fetcher.late_entered.wait(1.0))
        fetcher.fast_release.set()
        self.assertTrue(fetcher.service_done.wait(1.0))
        self.assertFalse(fetcher.late_finished.is_set())
        fetcher.cancellation_probe.set()
        self.assertTrue(fetcher.cancellation_seen.wait(1.0))
        self.assertEqual(len(self.publisher.commands), 1)

        fetcher.late_release.set()
        self.assertTrue(fetcher.late_finished.wait(1.0))
        self.assertTrue(fetcher.winner_authority_hidden.is_set())
        service_thread.join(timeout=1.0)

        self.assertFalse(service_thread.is_alive())
        self.assertEqual(len(results), 1)
        self.assertIsInstance(results[0], ContentAssetSuccess)
        self.assertEqual(len(self.publisher.commands), 1)

    def test_race_all_failures_are_aggregated_in_configured_order(self) -> None:
        first = candidate("first", provider="first")
        second = candidate("second", provider="second")
        fetcher = ControlledFetcher(
            {first.locator: OSError("private-a"), second.locator: TimeoutError("private-b")}
        )
        service = self.service(
            (ResolverTier("first", (Resolver((first, second)),), True),), fetcher
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF, self.projection)

        self.assertIsInstance(result, ContentAssetFailure)
        assert isinstance(result, ContentAssetFailure)
        self.assertEqual(tuple(item.provider for item in result.evidence), ("first", "second"))
        self.assertNotIn("private", str(result.evidence))

    def test_race_deadline_expires_without_publication(self) -> None:
        late = candidate("late", provider="late")
        fetcher = ControlledFetcher({late.locator: stream(pdf())}, {late.locator: 0.3})
        service = self.service(
            (ResolverTier("first", (Resolver((late,)),), True),),
            fetcher,
            timeout=0.05,
            cancellable=True,
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF, self.projection)

        self.assertIsInstance(result, ContentAssetFailure)
        self.assertTrue(fetcher.cancelled.wait(0.2))
        self.assertEqual(self.publisher.commands, [])

    def test_two_valid_race_candidates_publish_first_current_winner_once(self) -> None:
        slow_first = candidate("slow", provider="configured-first")
        fast_second = candidate("fast", provider="current-winner")
        fetcher = ControlledFetcher(
            {slow_first.locator: stream(pdf()), fast_second.locator: stream(pdf())},
            {slow_first.locator: 0.2},
        )
        service = self.service(
            (ResolverTier("first", (Resolver((slow_first, fast_second)),), True),), fetcher
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF, self.projection)

        self.assertIsInstance(result, ContentAssetSuccess)
        assert isinstance(result, ContentAssetSuccess)
        self.assertEqual(result.provider, "current-winner")
        self.assertEqual(len(self.publisher.commands), 1)


if __name__ == "__main__":
    unittest.main()
