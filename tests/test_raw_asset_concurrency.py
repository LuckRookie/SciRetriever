import hashlib
from io import BytesIO
import json
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
import threading
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (  # noqa: E402
    AssetRepository,
    IdentityResolver,
    JobRepository,
    apply_migrations,
    create_catalog_engine,
    open_catalog_engine,
)
from sciretriever.core.enums import AssetIntentState, AssetRole  # noqa: E402
from sciretriever.storage import (  # noqa: E402
    AssetAcceptanceCoordinator,
    AssetAcceptanceResult,
    RawAssetReconciler,
    RawAssetStore,
)
import sciretriever.storage as storage_api  # noqa: E402


def new_id() -> str:
    return str(uuid4())


class RawAssetConcurrencyTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.catalog_path = self.base / "catalog.sqlite"
        self.storage_root = self.base / "storage"
        self.storage_root.mkdir()
        self.catalog = create_catalog_engine(self.catalog_path)
        apply_migrations(self.catalog)
        self.addCleanup(self.catalog.dispose)

    def create_work_and_job(self, index: int) -> tuple[str, str]:
        work = IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": f"10.1000/concurrent-{index}"}
        ).work
        job = JobRepository(self.catalog).attach_or_create_job(
            work.id, AssetRole.PRIMARY_PDF
        )
        return work.id, job.id

    def run_workers(
        self,
        acquisitions: tuple[tuple[str, str, str, dict[str, object]], ...],
        data: bytes,
    ) -> tuple[list[AssetAcceptanceResult], list[BaseException]]:
        barrier = threading.Barrier(len(acquisitions))
        results: list[AssetAcceptanceResult] = []
        failures: list[BaseException] = []
        result_lock = threading.Lock()

        def accept(item: tuple[str, str, str, dict[str, object]]) -> None:
            work_id, job_id, intent_id, provenance = item
            catalog = open_catalog_engine(self.catalog_path, busy_timeout_ms=10_000)
            try:
                assets = AssetRepository(catalog)
                store = RawAssetStore(self.storage_root, chunk_size=5)
                coordinator = AssetAcceptanceCoordinator(assets, store)
                barrier.wait(timeout=5)
                result = coordinator.accept(
                    BytesIO(data),
                    work_id,
                    job_id,
                    AssetRole.PRIMARY_PDF,
                    "application/pdf",
                    "pdf",
                    provenance,
                    intent_id=intent_id,
                )
                with result_lock:
                    results.append(result)
            except BaseException as error:
                with result_lock:
                    failures.append(error)
            finally:
                catalog.dispose()

        threads = [threading.Thread(target=accept, args=(item,)) for item in acquisitions]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        return results, failures

    def assert_integral(self) -> None:
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(), "ok"
            )
            self.assertEqual(
                connection.exec_driver_sql("PRAGMA foreign_key_check").all(), []
            )
            blob_count = connection.exec_driver_sql(
                "SELECT count(*) FROM ("
                "SELECT typeof(provenance_json) AS kind FROM asset_intents "
                "UNION ALL SELECT typeof(provenance_json) FROM raw_assets "
                "UNION ALL SELECT typeof(details_json) FROM events "
                "UNION ALL SELECT typeof(details_json) FROM failures"
                ") WHERE kind = 'blob'"
            ).scalar_one()
            self.assertEqual(blob_count, 0)

    def test_public_storage_api_contains_only_stable_symbols(self) -> None:
        expected = (
            "AssetAcceptanceContext",
            "AssetAcceptanceCoordinator",
            "AssetAcceptanceResult",
            "CrossDeviceStorageError",
            "DurabilityError",
            "PublicationResult",
            "RawAssetStore",
            "RawAssetReconciler",
            "ReconciliationItem",
            "ReconciliationReport",
            "StagedAsset",
            "StorageConflictError",
            "StorageCorruptionError",
            "StorageError",
            "StoragePathError",
        )
        self.assertEqual(storage_api.__all__, expected)
        self.assertTrue(all(hasattr(storage_api, name) for name in expected))

    def test_identical_content_from_independent_engines_converges(self) -> None:
        data = b"one immutable concurrent raw asset"
        digest = hashlib.sha256(data).hexdigest()
        work_jobs = tuple(self.create_work_and_job(index) for index in range(6))
        acquisitions = tuple(
            (
                work_id,
                job_id,
                new_id(),
                {"provider": "thread", "worker": index},
            )
            for index, (work_id, job_id) in enumerate(work_jobs)
        )

        results, failures = self.run_workers(acquisitions, data)

        self.assertEqual(failures, [])
        self.assertEqual(len(results), len(acquisitions))
        self.assertEqual(sum(result.publication.created for result in results), 1)
        self.assertEqual({result.publication.storage_path for result in results}, {
            f"raw/{digest[:2]}/{digest}"
        })
        self.assertEqual({result.raw_asset.id for result in results}, {results[0].raw_asset.id})
        target = self.storage_root / results[0].publication.storage_path
        before = target.stat()
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(before.st_mode), 0o400)

        assets = AssetRepository(self.catalog)
        intents = assets.list_all_intents()
        self.assertEqual(len(intents), len(acquisitions))
        self.assertTrue(all(intent.state is AssetIntentState.FINALIZED for intent in intents))
        self.assertEqual(
            {json.loads(intent.provenance_json)["worker"] for intent in intents},
            set(range(len(acquisitions))),
        )
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 1
            )
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM work_assets").scalar_one(),
                len(work_jobs),
            )
            event_rows = connection.exec_driver_sql(
                "SELECT subject_id, event_type FROM events "
                "WHERE subject_type = 'asset_intent' ORDER BY subject_id, occurred_at, id"
            ).all()
        events_by_intent = {
            intent.id: tuple(row[1] for row in event_rows if row[0] == intent.id)
            for intent in intents
        }
        self.assertTrue(
            all(
                event_types
                == (
                    "asset_intent.created",
                    "asset_intent.published",
                    "asset_intent.finalized",
                )
                for event_types in events_by_intent.values()
            )
        )
        after = target.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assert_integral()

    def test_concurrent_same_job_retries_obey_intent_uniqueness(self) -> None:
        data = b"same job retry bytes"
        work_id, job_id = self.create_work_and_job(100)
        provenance: dict[str, object] = {
            "provider": "retry",
            "request": "same-job",
        }
        acquisitions = tuple(
            (work_id, job_id, new_id(), provenance) for _ in range(5)
        )

        results, failures = self.run_workers(acquisitions, data)

        self.assertEqual(failures, [])
        self.assertEqual(len(results), len(acquisitions))
        self.assertEqual(len({result.intent.id for result in results}), 1)
        self.assertTrue(
            all(result.intent.state is AssetIntentState.FINALIZED for result in results)
        )
        store = RawAssetStore(self.storage_root)
        assets = AssetRepository(self.catalog)
        RawAssetReconciler(store, assets).reconcile_all()
        counts = {}
        with self.catalog.connect() as connection:
            for table in ("asset_intents", "raw_assets", "work_assets", "events", "failures"):
                counts[table] = connection.exec_driver_sql(
                    f'SELECT count(*) FROM "{table}"'
                ).scalar_one()
        RawAssetReconciler(store, assets).reconcile_all()

        intents = assets.list_all_intents()
        self.assertEqual(len(intents), 1)
        self.assertIs(intents[0].state, AssetIntentState.FINALIZED)
        self.assertEqual(json.loads(intents[0].provenance_json), provenance)
        self.assertEqual(counts["raw_assets"], 1)
        self.assertEqual(counts["work_assets"], 1)
        self.assertEqual(counts["failures"], 0)
        self.assertEqual(store.enumerate_staging(), ((), ()))
        with self.catalog.connect() as connection:
            self.assertEqual(
                {
                    table: connection.exec_driver_sql(
                        f'SELECT count(*) FROM "{table}"'
                    ).scalar_one()
                    for table in counts
                },
                counts,
            )
        self.assert_integral()


if __name__ == "__main__":
    import unittest

    unittest.main()
