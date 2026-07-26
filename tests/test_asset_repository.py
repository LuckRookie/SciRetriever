from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import AssetRepository, IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.core.enums import AssetIntentState, AssetRole
from sciretriever.errors import CatalogError


def new_id() -> str:
    return str(uuid4())


class AssetRepositoryTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        initialize_catalog(self.catalog)
        self.addCleanup(self.catalog.dispose)
        self.assets = AssetRepository(self.catalog)
        self.work_version_id = self.create_work("10.1000/assets-one")

    def create_work(self, doi: str) -> str:
        resolution = IdentityResolver(self.catalog).create_or_reuse_work({"doi": doi})
        assert resolution.work_version is not None
        return resolution.work_version.id

    def create_intent(
        self,
        *,
        intent_id: str | None = None,
        work_version_id: str | None = None,
        sha256: str = "a" * 64,
        provenance: object = None,
    ):
        return self.assets.create_intent(
            intent_id or new_id(),
            work_version_id or self.work_version_id,
            AssetRole.PRIMARY_PDF,
            sha256,
            "application/pdf",
            "pdf",
            42,
            {"provider": "test"} if provenance is None else provenance,
        )

    def count(self, table: str) -> int:
        with self.catalog.connect() as connection:
            return connection.exec_driver_sql(f'SELECT count(*) FROM "{table}"').scalar_one()

    def test_create_publish_finalize_and_exact_replay(self) -> None:
        intent_id = new_id()
        first = self.create_intent(intent_id=intent_id)
        replay = self.create_intent(intent_id=intent_id)
        self.assertEqual(replay, first)
        published = self.assets.register_verified_published_intent(first.id)
        finalized = self.assets.finalize_intent(first.id)
        self.assertIs(published.state, AssetIntentState.PUBLISHED)
        self.assertIs(finalized.state, AssetIntentState.FINALIZED)
        self.assertEqual(self.assets.finalize_intent(first.id), finalized)
        self.assertEqual(len(self.assets.get_work_version_assets(self.work_version_id)), 1)

    def test_version_role_hash_identity_converges_and_conflicts_roll_back(self) -> None:
        first = self.create_intent(intent_id=new_id())
        replay = self.create_intent(intent_id=new_id())
        self.assertEqual(replay.id, first.id)
        with self.assertRaises(CatalogError):
            self.create_intent(intent_id=new_id(), provenance={"provider": "different"})
        self.assertEqual(self.count("asset_intents"), 1)

    def test_same_content_across_versions_reuses_raw_asset_and_preserves_links(self) -> None:
        other = self.create_work("10.1000/assets-two")
        first = self.create_intent(work_version_id=self.work_version_id)
        second = self.create_intent(work_version_id=other)
        with ThreadPoolExecutor(max_workers=2) as executor:
            published = tuple(executor.map(
                self.assets.register_verified_published_intent,
                (first.id, second.id),
            ))
        self.assertEqual({item.raw_asset_id for item in published}, {published[0].raw_asset_id})
        self.assertEqual(self.count("raw_assets"), 1)
        self.assertEqual(self.count("work_version_assets"), 2)

    def test_abandonment_and_failure_recording_are_atomic_and_idempotent(self) -> None:
        intent = self.create_intent()
        abandoned = self.assets.abandon_pending_intent(
            intent.id, "asset_invalid", "validation failed", details={"phase": "validation"}
        )
        self.assertIs(abandoned.state, AssetIntentState.ABANDONED)
        self.assertEqual(
            self.assets.abandon_pending_intent(
                intent.id, "asset_invalid", "validation failed", details={"phase": "validation"}
            ),
            abandoned,
        )
        self.assertEqual(self.count("diagnostic_records"), 1)
        with self.assertRaises(CatalogError):
            self.assets.register_verified_published_intent(intent.id)

    def test_terminal_intent_replay_does_not_append_duplicate_diagnostics(self) -> None:
        intent = self.create_intent()
        first = self.assets.abandon_pending_intent(
            intent.id, "storage", "failed", details={"phase": "one"}
        )
        replay = self.assets.abandon_pending_intent(
            intent.id, "storage", "failed", details={"phase": "one"}
        )
        self.assertEqual(first, replay)
        self.assertEqual(self.count("diagnostic_records"), 1)

    def test_reconcilable_listing_is_deterministic_and_excludes_terminal(self) -> None:
        higher = self.create_intent(intent_id="ffffffff-ffff-4fff-8fff-ffffffffffff", sha256="b" * 64)
        lower = self.create_intent(intent_id="00000000-0000-4000-8000-000000000001", sha256="c" * 64)
        terminal = self.create_intent(sha256="d" * 64)
        self.assets.abandon_pending_intent(terminal.id, "test", "terminal")
        listed = self.assets.list_reconcilable_intents()
        self.assertEqual({item.id for item in listed}, {higher.id, lower.id})
        self.assertEqual(tuple(item.id for item in listed), tuple(item.id for item in sorted(listed, key=lambda item: (item.created_at, item.id))))

    def test_missing_work_version_and_invalid_metadata_leave_no_rows(self) -> None:
        with self.assertRaises(CatalogError):
            self.create_intent(work_version_id=new_id())
        with self.assertRaises(ValueError):
            self.assets.create_intent(
                new_id(), self.work_version_id, AssetRole.PRIMARY_PDF, "bad",
                "application/pdf", "pdf", 42, {"provider": "test"},
            )
        self.assertEqual(self.count("asset_intents"), 0)

    def test_public_registration_bypass_is_absent(self) -> None:
        self.assertFalse(hasattr(self.assets, "register_raw_asset"))
        self.assertFalse(hasattr(self.assets, "link_work_asset"))


if __name__ == "__main__":
    import unittest
    unittest.main()
