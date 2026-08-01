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
    Fetcher,
    RecordingPublisher,
    RecordingStore,
    Resolver,
    candidate,
    pdf,
    stream,
    target,
)

from sciretriever.adapters.acquisition import CandidateRace
from sciretriever.batching.api import (
    TargetProjection,
    TargetResult,
)
from sciretriever.content.assets import (
    AssetAcceptancePolicy,
    ContentAssetFailure,
    ContentAssetReplay,
    ContentAssetService,
    ContentAssetSuccess,
    ResolverTier,
)
from sciretriever.content.model import (
    AcceptedContentReference,
    BoundedByteStream,
)
from sciretriever.content.ports import ArtifactStorePort
from sciretriever.kernel import (
    AssetId,
    BatchRunId,
    CanonicalJsonObject,
    Sha256,
    WorkVersionId,
)
from sciretriever.kernel.enums import AssetRole


class TargetContentAssetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-content-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.events: list[str] = []
        self.projection = TargetProjection(
            BatchRunId(UUID_B),
            WorkVersionId(UUID_A),
            TargetResult.PARTIALLY_ADVANCED,
            CanonicalJsonObject(()),
            (),
        )
        self.publisher = RecordingPublisher(self.events, self.projection)

    def service(
        self, tiers: tuple[ResolverTier, ...], responses: dict[str, BoundedByteStream]
    ) -> ContentAssetService:
        store: ArtifactStorePort = RecordingStore(self.root / "storage", self.events)
        return ContentAssetService(
            tiers,
            Fetcher(responses),
            store,
            self.publisher,
            AssetAcceptancePolicy(min_pdf_bytes=300, max_asset_bytes=1_000_000),
            race=CandidateRace(deadline_seconds=1.0),
        )

    def test_exact_doi_primary_publishes_file_before_catalog(self) -> None:
        first = candidate("https://source.invalid/article")
        service = self.service(
            (ResolverTier("first", (Resolver((first,)),), True),), {first.locator: stream(pdf())}
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetSuccess)
        self.assertEqual(self.events, ["file", "catalog"])
        acceptance = self.publisher.commands[0].acceptance
        self.assertTrue(hasattr(acceptance, "source"))
        self.assertNotIn("secret", str(getattr(acceptance, "source")))

    def test_complete_title_author_year_fallback_accepts_without_doi(self) -> None:
        first = candidate("https://source.invalid/fallback")
        service = self.service(
            (ResolverTier("first", (Resolver((first,)),), False),),
            {
                first.locator: stream(pdf(doi=None)),
            },
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetSuccess)

    def test_wrong_truncated_supplementary_and_unconfirmed_pdf_are_typed_failures(self) -> None:
        cases = (
            ("wrong", pdf(title="Different Article", author="Other Author", doi="10.9999/wrong")),
            ("truncated", pdf()[:-20]),
            ("supplement", pdf(title="Supplementary Information for Exact Article Title")),
            ("unconfirmed", pdf(title="", author="", doi=None)),
        )
        for name, body in cases:
            with self.subTest(name=name):
                item = candidate(f"https://source.invalid/{name}")
                service = self.service(
                    (ResolverTier("first", (Resolver((item,)),), False),),
                    {item.locator: stream(body)},
                )
                result = service.accept(target(), AssetRole.PRIMARY_PDF)
                self.assertIsInstance(result, ContentAssetFailure)
                assert isinstance(result, ContentAssetFailure)
                self.assertNotIn("source.invalid", str(result.evidence))
                self.assertNotIn("private", str(result.evidence))

    def test_provider_order_breaks_same_race_wave_and_fallback_waits_for_exhaustion(self) -> None:
        wrong = candidate("wrong", provider="a")
        winner = candidate("winner", provider="b")
        fallback = candidate("fallback", provider="translator")
        service = self.service(
            (
                ResolverTier("first", (Resolver((wrong,)), Resolver((winner,))), True),
                ResolverTier("translator", (Resolver((fallback,)),), False),
            ),
            {
                wrong.locator: stream(pdf(doi="10.9999/wrong")),
                winner.locator: stream(pdf()),
                fallback.locator: stream(pdf()),
            },
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetSuccess)
        assert isinstance(result, ContentAssetSuccess)
        self.assertEqual(result.provider, "b")

    def test_exact_existing_primary_replays_and_different_bytes_cannot_replace(self) -> None:
        body = pdf()
        current = AcceptedContentReference(AssetId(UUID_B), Sha256.from_bytes(body), 1)
        item = candidate("same")
        service = self.service(
            (ResolverTier("first", (Resolver((item,)),), False),), {item.locator: stream(body)}
        )

        replay = service.accept(target(current=current), AssetRole.PRIMARY_PDF)
        replacement = service.accept(target(current=current), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(replay, ContentAssetReplay)
        self.assertIsInstance(replacement, ContentAssetReplay)
        self.assertEqual(self.events, [])

    def test_supplementary_role_publishes_without_primary_semantics(self) -> None:
        item = candidate("supp", AssetRole.XML)
        xml = b"<article><title>support</title></article>"
        service = self.service(
            (ResolverTier("first", (Resolver((item,)),), False),),
            {item.locator: stream(xml, "application/xml")},
        )

        result = service.accept(target(), AssetRole.XML)

        self.assertIsInstance(result, ContentAssetSuccess)
        self.assertEqual(self.publisher.commands[0].target, self.projection)
        self.assertEqual(self.events, ["file", "catalog"])

    def test_serial_transport_failure_is_redacted_and_falls_through_in_order(self) -> None:
        bad = candidate("https://secret.invalid/bad", provider="bad")
        good = candidate("good", provider="good")
        fetcher = ControlledFetcher(
            {bad.locator: OSError("token=SECRET"), good.locator: stream(pdf())}
        )
        service = ContentAssetService(
            (ResolverTier("first", (Resolver((bad, good)),), False),),
            fetcher,
            RecordingStore(self.root / "serial", self.events),
            self.publisher,
            AssetAcceptancePolicy(min_pdf_bytes=300),
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetSuccess)
        assert isinstance(result, ContentAssetSuccess)
        self.assertEqual((fetcher.calls, result.provider), ([bad.locator, good.locator], "good"))
        self.assertEqual(len(self.publisher.commands), 1)

    def test_race_failure_isolated_from_valid_sibling(self) -> None:
        bad = candidate("bad", provider="bad")
        good = candidate("good", provider="good")
        fetcher = ControlledFetcher(
            {bad.locator: TimeoutError("secret"), good.locator: stream(pdf())}
        )
        service = ContentAssetService(
            (ResolverTier("first", (Resolver((bad, good)),), True),),
            fetcher,
            RecordingStore(self.root / "race-failure", self.events),
            self.publisher,
            AssetAcceptancePolicy(min_pdf_bytes=300),
            race=CandidateRace(deadline_seconds=1.0),
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetSuccess)
        self.assertEqual(len(self.publisher.commands), 1)

    def test_race_returns_first_valid_and_cancels_cooperative_late_loser(self) -> None:
        fast = candidate("fast", provider="fast")
        late = candidate("late", provider="late")
        fetcher = DeterministicRaceFetcher(
            {fast.locator: stream(pdf()), late.locator: stream(pdf(doi="10.9999/late"))},
        )
        service = ContentAssetService(
            (ResolverTier("first", (Resolver((fast, late)),), True),),
            fetcher,
            RecordingStore(self.root / "race-late", self.events),
            self.publisher,
            AssetAcceptancePolicy(min_pdf_bytes=300),
            race=CandidateRace(deadline_seconds=1.0),
            cancellable_fetcher=fetcher,
        )
        results: list[ContentAssetSuccess | ContentAssetFailure | ContentAssetReplay] = []

        def accept() -> None:
            results.append(service.accept(target(), AssetRole.PRIMARY_PDF))
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
        self.assertTrue(fetcher.late_claim_rejected.is_set())
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
        service = ContentAssetService(
            (ResolverTier("first", (Resolver((first, second)),), True),),
            fetcher,
            RecordingStore(self.root / "race-all-fail", self.events),
            self.publisher,
            AssetAcceptancePolicy(min_pdf_bytes=300),
            race=CandidateRace(deadline_seconds=1.0),
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetFailure)
        assert isinstance(result, ContentAssetFailure)
        self.assertEqual(tuple(item.provider for item in result.evidence), ("first", "second"))
        self.assertNotIn("private", str(result.evidence))

    def test_race_deadline_expires_without_publication(self) -> None:
        late = candidate("late", provider="late")
        fetcher = ControlledFetcher({late.locator: stream(pdf())}, {late.locator: 0.3})
        service = ContentAssetService(
            (ResolverTier("first", (Resolver((late,)),), True),),
            fetcher,
            RecordingStore(self.root / "race-deadline", self.events),
            self.publisher,
            AssetAcceptancePolicy(min_pdf_bytes=300),
            race=CandidateRace(deadline_seconds=0.05),
            cancellable_fetcher=fetcher,
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

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
        service = ContentAssetService(
            (ResolverTier("first", (Resolver((slow_first, fast_second)),), True),),
            fetcher,
            RecordingStore(self.root / "race-two-valid", self.events),
            self.publisher,
            AssetAcceptancePolicy(min_pdf_bytes=300),
            race=CandidateRace(deadline_seconds=1.0),
            cancellable_fetcher=fetcher,
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetSuccess)
        assert isinstance(result, ContentAssetSuccess)
        self.assertEqual(result.provider, "current-winner")
        self.assertEqual(len(self.publisher.commands), 1)


if __name__ == "__main__":
    unittest.main()
