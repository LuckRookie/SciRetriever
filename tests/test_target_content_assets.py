from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from target_content_assets_support import (
    UUID_A,
    UUID_B,
    ControlledFetcher,
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
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.model.access import BoundedByteStream
from sciretriever.model.assets import (
    AcceptedContentReference,
    ContentAssetFailure,
    ContentAssetReplay,
    ContentAssetSuccess,
)
from sciretriever.model.execution import TargetProjection, TargetResult
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    BatchRunId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.services.assets import (
    AssetAcceptancePolicy,
    AssetServiceDependencies,
    ContentAssetService,
    ResolverTier,
)
from sciretriever.services.assets.ports import ArtifactStorePort


class TargetContentAssetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-content-")
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
        self, tiers: tuple[ResolverTier, ...], responses: dict[str, BoundedByteStream]
    ) -> ContentAssetService:
        store: ArtifactStorePort = RecordingStore(self.root / "storage", self.events)
        return ContentAssetService(
            AssetServiceDependencies(
                tiers=tiers,
                fetcher=Fetcher(responses),
                store=store,
                publisher=self.publisher,
                race=CandidateRace(deadline_seconds=1.0),
            ),
            AssetAcceptancePolicy(
                min_pdf_bytes=300,
                max_asset_bytes=1_000_000,
                chunk_size=300,
            ),
        )

    def test_public_exports_are_the_narrow_use_case_surface(self) -> None:
        expected = (
            "AssetAcceptancePolicy",
            "AssetServiceDependencies",
            "ContentAssetService",
            "ResolverTier",
        )
        import sciretriever.services.assets as assets_package
        from sciretriever.services.assets import api as assets_api

        self.assertEqual(assets_api.__all__, expected)
        self.assertEqual(assets_package.__all__, expected)

        import sciretriever.content.api as content_api

        for module_name in (
            "sciretriever.content.assets",
            "sciretriever.content.asset_acquisition",
            "sciretriever.content.asset_validation",
        ):
            self.assertIsNone(importlib.util.find_spec(module_name), module_name)
        for name in ("AssetAcceptancePolicy", "ContentAssetService", "ResolverTier"):
            self.assertNotIn(name, content_api.__dict__)
            self.assertNotIn(name, content_api.__all__)

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
            (
                "wrong",
                pdf(title="Different Article", author="Other Author", doi="10.9999/wrong"),
                "identity-mismatch",
            ),
            ("truncated", pdf()[:-20], "format-invalid"),
            (
                "supplement",
                pdf(title="Supplementary Information for Exact Article Title"),
                "not-primary",
            ),
            ("unconfirmed", pdf(title="", author="", doi=None), "identity-unconfirmed"),
            ("malformed", b"not a pdf" + b"x" * 400, "format-invalid"),
        )
        for name, body, code in cases:
            with self.subTest(name=name):
                item = candidate(f"https://source.invalid/{name}")
                service = self.service(
                    (ResolverTier("first", (Resolver((item,)),), False),),
                    {item.locator: stream(body)},
                )
                result = service.accept(target(), AssetRole.PRIMARY_PDF)
                self.assertIsInstance(result, ContentAssetFailure)
                assert isinstance(result, ContentAssetFailure)
                self.assertEqual(result.code, "candidates-exhausted")
                self.assertEqual(result.evidence[0].outcome, code)
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
        self.assertEqual(
            tuple((item.provider, item.outcome) for item in result.evidence),
            (("a", "identity-mismatch"),),
        )

    def test_exact_existing_primary_replays_and_different_bytes_cannot_replace(self) -> None:
        body = pdf()
        current = AcceptedContentReference(
            content_id=AssetId(UUID_B),
            sha256=sha256_digest(body),
            revision=1,
        )
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
            AssetServiceDependencies(
                tiers=(ResolverTier("first", (Resolver((bad, good)),), False),),
                fetcher=fetcher,
                store=RecordingStore(self.root / "serial", self.events),
                publisher=self.publisher,
            ),
            AssetAcceptancePolicy(min_pdf_bytes=300),
        )

        result = service.accept(target(), AssetRole.PRIMARY_PDF)

        self.assertIsInstance(result, ContentAssetSuccess)
        assert isinstance(result, ContentAssetSuccess)
        self.assertEqual((fetcher.calls, result.provider), ([bad.locator, good.locator], "good"))
        self.assertEqual(
            tuple((item.provider, item.outcome) for item in result.evidence),
            (("bad", "transport-failed"),),
        )
        self.assertEqual(len(self.publisher.commands), 1)


if __name__ == "__main__":
    unittest.main()
