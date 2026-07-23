import hashlib
import importlib
from io import BytesIO
import json
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
import threading
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog_api = importlib.import_module("sciretriever.catalog")
assets_api = importlib.import_module("sciretriever.catalog.assets")
coordinator_api = importlib.import_module("sciretriever.storage.coordinator")
manager_api = importlib.import_module("sciretriever.storage.manager")
enums = importlib.import_module("sciretriever.core.enums")
errors = importlib.import_module("sciretriever.errors")

AssetAcceptanceContext = coordinator_api.AssetAcceptanceContext
AssetAcceptanceCoordinator = coordinator_api.AssetAcceptanceCoordinator
AssetAcceptanceResult = coordinator_api.AssetAcceptanceResult
RawAssetStore = manager_api.RawAssetStore


def new_id() -> str:
    return str(uuid4())


class InjectedCrash(BaseException):
    pass


class FailingStream:
    def __init__(self) -> None:
        self._first = True

    def read(self, _size: int = -1) -> bytes:
        if self._first:
            self._first = False
            return b"partial"
        raise OSError("injected read failure")


class CountingStream:
    def __init__(self, data: bytes) -> None:
        self._stream = BytesIO(data)
        self.read_calls = 0

    def read(self, size: int = -1) -> bytes:
        self.read_calls += 1
        return self._stream.read(size)


class CoordinatorFixture:
    def __init__(self, directory: str, doi: str = "10.1000/coordinator") -> None:
        base = Path(directory)
        self.catalog_path = base / "catalog.sqlite"
        self.storage_root = base / "storage"
        self.storage_root.mkdir()
        self.catalog = catalog_api.create_catalog_engine(self.catalog_path)
        catalog_api.initialize_catalog(self.catalog)
        self.repository = assets_api.AssetRepository(self.catalog)
        self.store = RawAssetStore(self.storage_root, chunk_size=5)
        self.coordinator = AssetAcceptanceCoordinator(self.repository, self.store)
        self.work_version_id, self.job_id = self.create_work_and_job(doi)

    def close(self) -> None:
        self.catalog.dispose()

    def create_work_and_job(self, doi: str) -> tuple[str, str]:
        work = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work({"doi": doi}).work_version
        job = catalog_api.JobRepository(self.catalog).attach_or_create_job(
            work.id,
            enums.AssetRole.PRIMARY_PDF,
        )
        return work.id, job.id

    def accept(
        self,
        data: bytes = b"immutable evidence",
        *,
        work_id: str | None = None,
        job_id: str | None = None,
        intent_id: str | None = None,
        checkpoint=coordinator_api._noop_checkpoint,
    ) -> AssetAcceptanceResult:
        return self.coordinator.accept(
            BytesIO(data),
            work_id or self.work_version_id,
            job_id or self.job_id,
            enums.AssetRole.PRIMARY_PDF,
            "application/pdf",
            "pdf",
            {"provider": "test"},
            intent_id=intent_id,
            checkpoint=checkpoint,
        )

    def count(self, table: str, where: str = "", parameters: tuple[object, ...] = ()) -> int:
        with self.catalog.connect() as connection:
            return connection.exec_driver_sql(
                f'SELECT count(*) FROM "{table}" {where}', parameters
            ).scalar_one()

    def intent_events(self, intent_id: str) -> tuple[str, ...]:
        with self.catalog.connect() as connection:
            return tuple(
                connection.exec_driver_sql(
                    "SELECT event_type FROM events WHERE subject_id = ? ORDER BY occurred_at, id",
                    (intent_id,),
                ).scalars()
            )


class AssetAcceptanceCoordinatorTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = CoordinatorFixture(self.temporary.name)
        self.addCleanup(self.fixture.close)

    def test_happy_path_is_durable_linked_cataloged_and_finalized(self) -> None:
        data = b"durable primary pdf"
        intent_id = new_id()
        checkpoints: list[str] = []
        linked_inodes: list[tuple[int, int]] = []

        def inspect_checkpoint(name: str, value: object) -> None:
            checkpoints.append(name)
            if name == "after_target_fsync":
                if not isinstance(value, AssetAcceptanceContext):
                    raise AssertionError("checkpoint did not receive an acceptance context")
                staged_path = self.fixture.storage_root / getattr(value, "staged").temporary_path
                target_path = (
                    self.fixture.storage_root / getattr(value, "publication").storage_path
                )
                linked_inodes.append((staged_path.stat().st_ino, target_path.stat().st_ino))

        result = self.fixture.accept(data, intent_id=intent_id, checkpoint=inspect_checkpoint)

        self.assertIsInstance(result, AssetAcceptanceResult)
        self.assertFalse(hasattr(result, "__dict__"))
        self.assertEqual(
            checkpoints,
            [
                "after_stage_fsync",
                "after_intent_commit",
                "after_target_fsync",
                "after_catalog_publish_commit",
                "after_staging_remove",
                "after_finalize_commit",
            ],
        )
        self.assertEqual(linked_inodes[0][0], linked_inodes[0][1])
        self.assertIs(result.intent.state, enums.AssetIntentState.FINALIZED)
        self.assertEqual(result.intent.raw_asset_id, result.raw_asset.id)
        self.assertEqual(result.work_asset.raw_asset_id, result.raw_asset.id)
        self.assertFalse(result.reused_content)
        self.assertTrue(result.publication.created)
        self.assertEqual(result.raw_asset.sha256, hashlib.sha256(data).hexdigest())
        self.assertFalse((self.fixture.storage_root / result.intent.temporary_path).exists())
        target = self.fixture.storage_root / result.publication.storage_path
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(target.parent.stat().st_mode), 0o700)
        self.assertEqual(self.fixture.count("asset_intents"), 1)
        self.assertEqual(self.fixture.count("raw_assets"), 1)
        self.assertEqual(self.fixture.count("work_version_assets"), 1)
        self.assertEqual(self.fixture.count("failures"), 0)
        self.assertEqual(
            self.fixture.intent_events(intent_id),
            (
                "asset_intent.created",
                "asset_intent.published",
                "asset_intent.finalized",
            ),
        )

    def test_same_content_for_different_works_reuses_one_target_and_raw_row(self) -> None:
        data = b"shared immutable bytes"
        first = self.fixture.accept(data)
        work_two, job_two = self.fixture.create_work_and_job("10.1000/coordinator-two")

        second = self.fixture.accept(data, work_id=work_two, job_id=job_two)

        self.assertTrue(first.publication.created)
        self.assertFalse(first.reused_content)
        self.assertFalse(second.publication.created)
        self.assertTrue(second.reused_content)
        self.assertEqual(first.raw_asset.id, second.raw_asset.id)
        self.assertEqual(first.publication.storage_path, second.publication.storage_path)
        self.assertEqual(self.fixture.count("raw_assets"), 1)
        self.assertEqual(self.fixture.count("work_version_assets"), 2)
        self.assertEqual(self.fixture.count("asset_intents"), 2)

    def test_explicit_finalized_intent_replay_is_idempotent_and_reverified(self) -> None:
        intent_id = new_id()
        first = self.fixture.accept(intent_id=intent_id)
        counts = tuple(
            self.fixture.count(table)
            for table in ("asset_intents", "raw_assets", "work_version_assets", "events")
        )

        replay = self.fixture.accept(intent_id=intent_id)

        self.assertEqual(replay.intent, first.intent)
        self.assertEqual(replay.raw_asset, first.raw_asset)
        self.assertEqual(replay.work_asset, first.work_asset)
        self.assertTrue(replay.reused_content)
        self.assertFalse(replay.publication.created)
        self.assertEqual(
            tuple(
                self.fixture.count(table)
                for table in ("asset_intents", "raw_assets", "work_version_assets", "events")
            ),
            counts,
        )
        self.assertEqual(self.fixture.store.verify_published(replay.publication), replay.publication)

    def test_finalized_unique_collision_reuses_existing_and_removes_new_stage(self) -> None:
        data = b"finalized unique collision"
        first = self.fixture.accept(data, intent_id=new_id())
        colliding_id = new_id()
        counts = tuple(
            self.fixture.count(table)
            for table in ("asset_intents", "raw_assets", "work_version_assets", "events")
        )

        replay = self.fixture.accept(data, intent_id=colliding_id)

        self.assertEqual(replay.intent, first.intent)
        self.assertTrue(replay.reused_content)
        self.assertFalse(
            (self.fixture.storage_root / f"staging/{colliding_id}.part").exists()
        )
        self.assertEqual(
            tuple(
                self.fixture.count(table)
                for table in ("asset_intents", "raw_assets", "work_version_assets", "events")
            ),
            counts,
        )

    def test_finalized_collision_corruption_preserves_incoming_stage_and_target(self) -> None:
        data = b"finalized replay corruption"
        first = self.fixture.accept(data, intent_id=new_id())
        target = self.fixture.storage_root / first.publication.storage_path
        target.chmod(0o600)
        target.write_bytes(b"corrupt")
        target.chmod(0o400)
        before = target.stat()
        colliding_id = new_id()

        with self.assertRaises(errors.StorageCorruptionError):
            self.fixture.accept(data, intent_id=colliding_id)

        after = target.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(target.read_bytes(), b"corrupt")
        self.assertTrue(
            (self.fixture.storage_root / f"staging/{colliding_id}.part").exists()
        )
        self.assertEqual(self.fixture.count("asset_intents"), 1)
        self.assertEqual(self.fixture.count("failures"), 1)
        with self.fixture.catalog.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM failures"
            ).scalar_one()
        self.assertEqual(json.loads(details)["intent_id"], first.intent.id)

    def test_finalized_collision_missing_target_preserves_incoming_stage_and_failure(self) -> None:
        data = b"finalized missing collision"
        first = self.fixture.accept(data, intent_id=new_id())
        target = self.fixture.storage_root / first.publication.storage_path
        target.unlink()
        colliding_id = new_id()

        with self.assertRaises(errors.StorageError):
            self.fixture.accept(data, intent_id=colliding_id)

        self.assertFalse(target.exists())
        self.assertTrue(
            (self.fixture.storage_root / f"staging/{colliding_id}.part").exists()
        )
        self.assertEqual(self.fixture.count("failures"), 1)
        with self.fixture.catalog.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM failures"
            ).scalar_one()
        self.assertEqual(json.loads(details)["intent_id"], first.intent.id)

    def test_finalized_collision_verifies_target_and_catalog_before_stage_deletion(self) -> None:
        data = b"verify finalized before cleanup"
        first = self.fixture.accept(data, intent_id=new_id())
        colliding_id = new_id()
        incoming = self.fixture.storage_root / f"staging/{colliding_id}.part"
        observations: list[bool] = []
        verify = self.fixture.store.verify_published

        def observe(*args, **kwargs):
            observations.append(incoming.exists())
            return verify(*args, **kwargs)

        with patch.object(self.fixture.store, "verify_published", side_effect=observe):
            replay = self.fixture.accept(data, intent_id=colliding_id)

        self.assertEqual(replay.intent, first.intent)
        self.assertEqual(observations, [True])
        self.assertFalse(incoming.exists())

    def test_explicit_abandoned_replay_reads_nothing_and_creates_nothing(self) -> None:
        data = b"must never be read"
        digest = hashlib.sha256(data).hexdigest()
        intent_id = new_id()
        self.fixture.repository.create_intent(
            intent_id,
            self.fixture.work_version_id,
            self.fixture.job_id,
            "primary_pdf",
            digest,
            "application/pdf",
            "pdf",
            len(data),
            {"provider": "test"},
        )
        self.fixture.repository.abandon_pending_intent(
            intent_id,
            "test_abandonment",
            "test abandonment",
        )
        stream = CountingStream(data)

        with self.assertRaisesRegex(errors.CatalogError, "abandoned"):
            self.fixture.coordinator.accept(
                stream,
                self.fixture.work_version_id,
                self.fixture.job_id,
                "primary_pdf",
                "application/pdf",
                "pdf",
                {"provider": "test"},
                intent_id=intent_id,
            )

        self.assertEqual(stream.read_calls, 0)
        self.assertFalse(
            (self.fixture.storage_root / f"staging/{intent_id}.part").exists()
        )
        self.assertFalse(
            (self.fixture.storage_root / f"raw/{digest[:2]}/{digest}").exists()
        )
        self.assertEqual(self.fixture.count("raw_assets"), 0)

    def test_abandoned_unique_collision_cleans_incoming_without_publishing(self) -> None:
        data = b"abandoned collision evidence"
        digest = hashlib.sha256(data).hexdigest()
        existing_id = new_id()
        self.fixture.repository.create_intent(
            existing_id,
            self.fixture.work_version_id,
            self.fixture.job_id,
            "primary_pdf",
            digest,
            "application/pdf",
            "pdf",
            len(data),
            {"provider": "test"},
        )
        self.fixture.repository.abandon_pending_intent(
            existing_id,
            "test_abandonment",
            "test abandonment",
        )
        colliding_id = new_id()
        counts = (self.fixture.count("events"), self.fixture.count("failures"))

        with self.assertRaisesRegex(errors.CatalogError, "abandoned"):
            self.fixture.accept(data, intent_id=colliding_id)

        self.assertIs(
            self.fixture.repository.get_intent(existing_id).state,
            enums.AssetIntentState.ABANDONED,
        )
        self.assertIsNone(self.fixture.repository.get_intent(colliding_id))
        self.assertFalse(
            (self.fixture.storage_root / f"staging/{colliding_id}.part").exists()
        )
        self.assertFalse(
            (self.fixture.storage_root / f"raw/{digest[:2]}/{digest}").exists()
        )
        self.assertEqual(self.fixture.count("raw_assets"), 0)
        self.assertEqual(
            (self.fixture.count("events"), self.fixture.count("failures")),
            counts,
        )

    def test_each_crash_checkpoint_leaves_exact_reconcilable_residue_after_reopen(self) -> None:
        expectations = {
            "after_stage_fsync": (None, True, False, 0, 0, 0),
            "after_intent_commit": (enums.AssetIntentState.PENDING, True, False, 0, 0, 1),
            "after_target_fsync": (enums.AssetIntentState.PENDING, True, True, 0, 0, 1),
            "after_catalog_publish_commit": (
                enums.AssetIntentState.PUBLISHED,
                True,
                True,
                1,
                1,
                2,
            ),
            "after_staging_remove": (
                enums.AssetIntentState.PUBLISHED,
                False,
                True,
                1,
                1,
                2,
            ),
            "after_finalize_commit": (
                enums.AssetIntentState.FINALIZED,
                False,
                True,
                1,
                1,
                3,
            ),
        }
        for checkpoint_name, expected in expectations.items():
            with self.subTest(checkpoint=checkpoint_name), TemporaryDirectory() as directory:
                fixture = CoordinatorFixture(directory, f"10.1000/crash-{checkpoint_name}")
                intent_id = new_id()
                data = checkpoint_name.encode("ascii")
                digest = hashlib.sha256(data).hexdigest()

                def crash(name: str, _value: object) -> None:
                    if name == checkpoint_name:
                        raise InjectedCrash(name)

                with self.assertRaises(InjectedCrash):
                    fixture.accept(data, intent_id=intent_id, checkpoint=crash)
                fixture.close()

                reopened_catalog = catalog_api.open_catalog_engine(fixture.catalog_path)
                self.addCleanup(reopened_catalog.dispose)
                reopened_repository = assets_api.AssetRepository(reopened_catalog)
                reopened_store = RawAssetStore(fixture.storage_root)
                state, staged_exists, target_exists, raw_count, link_count, event_count = expected
                intent = reopened_repository.get_intent(intent_id)
                self.assertEqual(None if intent is None else intent.state, state)
                self.assertEqual(
                    (fixture.storage_root / f"staging/{intent_id}.part").exists(), staged_exists
                )
                target = fixture.storage_root / f"raw/{digest[:2]}/{digest}"
                self.assertEqual(target.exists(), target_exists)
                with reopened_catalog.connect() as connection:
                    self.assertEqual(
                        connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(),
                        raw_count,
                    )
                    self.assertEqual(
                        connection.exec_driver_sql("SELECT count(*) FROM work_version_assets").scalar_one(),
                        link_count,
                    )
                    self.assertEqual(
                        connection.exec_driver_sql(
                            "SELECT count(*) FROM events WHERE subject_id = ?", (intent_id,)
                        ).scalar_one(),
                        event_count,
                    )
                    self.assertEqual(
                        connection.exec_driver_sql("SELECT count(*) FROM failures").scalar_one(),
                        0,
                    )
                if target_exists:
                    verified = reopened_store.verify_published(digest, len(data))
                    self.assertEqual(verified.storage_path, f"raw/{digest[:2]}/{digest}")

    def test_stage_read_failure_creates_no_intent_or_orphan(self) -> None:
        intent_id = new_id()
        with self.assertRaisesRegex(errors.StorageError, "injected asset stream"):
            self.fixture.coordinator.accept(
                FailingStream(),
                self.fixture.work_version_id,
                self.fixture.job_id,
                "primary_pdf",
                "application/pdf",
                "pdf",
                {"provider": "test"},
                intent_id=intent_id,
            )

        self.assertIsNone(self.fixture.repository.get_intent(intent_id))
        self.assertFalse((self.fixture.storage_root / f"staging/{intent_id}.part").exists())
        self.assertEqual(self.fixture.store.enumerate_staging(), ((), ()))
        self.assertEqual(self.fixture.count("raw_assets"), 0)

    def test_normal_exception_before_intent_commit_removes_durable_stage(self) -> None:
        intent_id = new_id()
        with patch.object(
            self.fixture.repository,
            "create_intent",
            side_effect=errors.CatalogError("injected create failure"),
        ):
            with self.assertRaisesRegex(errors.CatalogError, "injected create"):
                self.fixture.accept(intent_id=intent_id)

        self.assertFalse((self.fixture.storage_root / f"staging/{intent_id}.part").exists())
        self.assertIsNone(self.fixture.repository.get_intent(intent_id))
        self.assertEqual(self.fixture.count("failures"), 0)

    def test_normal_post_intent_failures_are_recorded_and_recoverable(self) -> None:
        cases = (
            (
                "publish",
                "publish",
                errors.StorageError("injected publish failure"),
                enums.AssetIntentState.PENDING,
                True,
                False,
                "asset_publication_failure",
            ),
            (
                "catalog",
                "register_verified_published_intent",
                errors.CatalogError("injected catalog failure"),
                enums.AssetIntentState.PENDING,
                True,
                True,
                "asset_catalog_publication_failure",
            ),
            (
                "remove",
                "remove_staged",
                errors.StorageError("injected remove failure"),
                enums.AssetIntentState.PUBLISHED,
                True,
                True,
                "asset_staging_cleanup_failure",
            ),
            (
                "finalize",
                "finalize_intent",
                errors.CatalogError("injected finalize failure"),
                enums.AssetIntentState.PUBLISHED,
                False,
                True,
                "asset_finalization_failure",
            ),
        )
        for (
            label,
            method_name,
            injected,
            expected_state,
            staged_exists,
            target_exists,
            expected_category,
        ) in cases:
            with self.subTest(phase=label), TemporaryDirectory() as directory:
                fixture = CoordinatorFixture(directory, f"10.1000/failure-{label}")
                intent_id = new_id()
                data = f"failure-{label}".encode("ascii")
                owner = fixture.store if method_name in {"publish", "remove_staged"} else fixture.repository
                with patch.object(owner, method_name, side_effect=injected):
                    with self.assertRaises(type(injected)):
                        fixture.accept(data, intent_id=intent_id)

                intent = fixture.repository.get_intent(intent_id)
                self.assertIs(intent.state, expected_state)
                self.assertEqual(
                    (fixture.storage_root / intent.temporary_path).exists(), staged_exists
                )
                self.assertEqual(
                    (fixture.storage_root / intent.storage_path).exists(), target_exists
                )
                self.assertEqual(fixture.count("failures"), 1)
                with fixture.catalog.connect() as connection:
                    failure = connection.exec_driver_sql(
                        "SELECT category, details_json FROM failures"
                    ).mappings().one()
                self.assertEqual(failure["category"], expected_category)
                self.assertIn(f'"phase":', failure["details_json"])
                self.assertIn(type(injected).__name__, failure["details_json"])
                self.assertIn(intent, fixture.repository.list_reconcilable_intents())
                fixture.close()

    def test_normal_checkpoint_failure_after_intent_records_failure(self) -> None:
        intent_id = new_id()

        def fail(name: str, _value: object) -> None:
            if name == "after_target_fsync":
                raise RuntimeError("injected checkpoint failure")

        with self.assertRaisesRegex(RuntimeError, "checkpoint"):
            self.fixture.accept(intent_id=intent_id, checkpoint=fail)

        intent = self.fixture.repository.get_intent(intent_id)
        self.assertIs(intent.state, enums.AssetIntentState.PENDING)
        self.assertTrue((self.fixture.storage_root / intent.temporary_path).exists())
        self.assertTrue((self.fixture.storage_root / intent.storage_path).exists())
        self.assertEqual(self.fixture.count("failures"), 1)

    def test_unique_pending_collision_without_evidence_converges_without_orphan(self) -> None:
        data = b"unique pending collision"
        digest = hashlib.sha256(data).hexdigest()
        existing_id = new_id()
        existing = self.fixture.repository.create_intent(
            existing_id,
            self.fixture.work_version_id,
            self.fixture.job_id,
            "primary_pdf",
            digest,
            "application/pdf",
            "pdf",
            len(data),
            {"provider": "test"},
        )
        new_intent_id = new_id()

        result = self.fixture.accept(data, intent_id=new_intent_id)

        recovered = self.fixture.repository.get_intent(existing_id)
        self.assertIs(recovered.state, enums.AssetIntentState.FINALIZED)
        self.assertEqual(result.intent, recovered)
        self.assertEqual(result.intent.id, existing.id)
        self.assertTrue(result.publication.created)
        self.assertFalse(result.reused_content)
        self.assertIsNone(self.fixture.repository.get_intent(new_intent_id))
        self.assertFalse(
            (self.fixture.storage_root / f"staging/{new_intent_id}.part").exists()
        )
        self.assertEqual(self.fixture.store.enumerate_staging(), ((), ()))
        self.assertEqual(self.fixture.count("failures"), 0)
        self.assertEqual(self.fixture.count("raw_assets"), 1)
        self.assertEqual(self.fixture.count("work_version_assets"), 1)
        target = self.fixture.storage_root / result.publication.storage_path
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o400)

    def test_published_collision_recreates_absent_target_and_finalizes(self) -> None:
        data = b"published collision target recovery"
        existing_id = new_id()

        def crash(name: str, _value: object) -> None:
            if name == "after_staging_remove":
                raise InjectedCrash(name)

        with self.assertRaises(InjectedCrash):
            self.fixture.accept(data, intent_id=existing_id, checkpoint=crash)
        published = self.fixture.repository.get_intent(existing_id)
        self.assertIs(published.state, enums.AssetIntentState.PUBLISHED)
        target = self.fixture.storage_root / published.storage_path
        target.unlink()
        colliding_id = new_id()

        result = self.fixture.accept(data, intent_id=colliding_id)

        self.assertEqual(result.intent.id, existing_id)
        self.assertIs(result.intent.state, enums.AssetIntentState.FINALIZED)
        self.assertTrue(result.publication.created)
        self.assertFalse(result.reused_content)
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o400)
        self.assertFalse(
            (self.fixture.storage_root / f"staging/{colliding_id}.part").exists()
        )
        self.assertEqual(self.fixture.count("failures"), 0)

    def test_collision_corrupt_target_retains_stage_and_failure_is_retry_stable(self) -> None:
        data = b"pending collision corruption"
        digest = hashlib.sha256(data).hexdigest()
        existing_id = new_id()
        self.fixture.repository.create_intent(
            existing_id,
            self.fixture.work_version_id,
            self.fixture.job_id,
            "primary_pdf",
            digest,
            "application/pdf",
            "pdf",
            len(data),
            {"provider": "test"},
        )
        target = self.fixture.storage_root / f"raw/{digest[:2]}/{digest}"
        target.parent.mkdir(mode=0o700)
        target.write_bytes(b"corrupt collision target")
        target.chmod(0o400)
        before = target.stat()
        colliding_id = new_id()
        incoming = self.fixture.storage_root / f"staging/{colliding_id}.part"

        with self.assertRaises(errors.StorageCorruptionError):
            self.fixture.accept(data, intent_id=colliding_id)

        after = target.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o400)
        self.assertEqual(target.read_bytes(), b"corrupt collision target")
        self.assertTrue(incoming.exists())
        self.assertEqual(self.fixture.count("failures"), 1)
        with self.fixture.catalog.connect() as connection:
            details = connection.exec_driver_sql(
                "SELECT details_json FROM failures"
            ).scalar_one()
        self.assertEqual(json.loads(details)["intent_id"], existing_id)

        with self.assertRaises(errors.StorageConflictError):
            self.fixture.accept(data, intent_id=colliding_id)
        self.assertEqual(self.fixture.count("failures"), 1)

        reconciler_api = importlib.import_module("sciretriever.storage.reconciler")
        reconciler = reconciler_api.RawAssetReconciler(
            self.fixture.store,
            self.fixture.repository,
        )
        reconciler.reconcile_all()
        counts = (self.fixture.count("events"), self.fixture.count("failures"))
        reconciler.reconcile_all()
        self.assertEqual(
            (self.fixture.count("events"), self.fixture.count("failures")),
            counts,
        )

    def test_shared_acceptance_lock_blocks_exclusive_reconciliation_until_return(self) -> None:
        attempted = threading.Event()
        acquired = threading.Event()
        order: list[str] = []
        threads: list[threading.Thread] = []

        def reconcile() -> None:
            attempted.set()
            with self.fixture.store.lock(exclusive=True):
                order.append("exclusive")
                acquired.set()

        def checkpoint(name: str, _value: object) -> None:
            if name == "after_stage_fsync":
                thread = threading.Thread(target=reconcile)
                threads.append(thread)
                thread.start()
                self.assertTrue(attempted.wait(timeout=1))
                order.append("checkpoint")

        self.fixture.accept(checkpoint=checkpoint)
        for thread in threads:
            thread.join(timeout=2)

        self.assertTrue(acquired.is_set())
        self.assertEqual(order, ["checkpoint", "exclusive"])
        self.assertTrue(all(not thread.is_alive() for thread in threads))

    def test_corrupt_existing_target_is_never_overwritten_or_removed(self) -> None:
        data = b"expected immutable target"
        digest = hashlib.sha256(data).hexdigest()
        target = self.fixture.storage_root / f"raw/{digest[:2]}/{digest}"
        target.parent.mkdir(mode=0o700)
        target.write_bytes(b"corrupt immutable target")
        target.chmod(0o400)
        before = target.stat()
        intent_id = new_id()

        with self.assertRaises(errors.StorageCorruptionError):
            self.fixture.accept(data, intent_id=intent_id)

        after = target.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(target.read_bytes(), b"corrupt immutable target")
        intent = self.fixture.repository.get_intent(intent_id)
        self.assertIs(intent.state, enums.AssetIntentState.PENDING)
        self.assertTrue((self.fixture.storage_root / intent.temporary_path).exists())
        self.assertEqual(self.fixture.count("raw_assets"), 0)
        self.assertEqual(self.fixture.count("failures"), 1)

    def test_writable_existing_target_blocks_registration_and_is_unchanged(self) -> None:
        data = b"correct bytes with writable target"
        digest = hashlib.sha256(data).hexdigest()
        target = self.fixture.storage_root / f"raw/{digest[:2]}/{digest}"
        target.parent.mkdir(mode=0o700)
        target.write_bytes(data)
        target.chmod(0o600)
        before = target.stat()
        intent_id = new_id()

        with self.assertRaisesRegex(errors.StorageCorruptionError, "mode"):
            self.fixture.accept(data, intent_id=intent_id)

        after = target.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o600)
        intent = self.fixture.repository.get_intent(intent_id)
        self.assertIs(intent.state, enums.AssetIntentState.PENDING)
        self.assertIsNone(intent.raw_asset_id)
        self.assertTrue((self.fixture.storage_root / intent.temporary_path).exists())
        self.assertEqual(self.fixture.count("raw_assets"), 0)
        self.assertEqual(self.fixture.count("work_version_assets"), 0)
        self.assertEqual(
            self.fixture.count(
                "events",
                "WHERE subject_id = ? AND event_type = ?",
                (intent_id, "asset_intent.published"),
            ),
            0,
        )
        with self.fixture.catalog.connect() as connection:
            failure = connection.exec_driver_sql(
                "SELECT category, retryable FROM failures"
            ).mappings().one()
        self.assertEqual(failure["category"], "asset_storage_corruption")
        self.assertEqual(failure["retryable"], 0)

    def test_raw_metadata_mismatch_rolls_back_registration_without_partial_catalog_rows(self) -> None:
        data = b"metadata mismatch"
        digest = hashlib.sha256(data).hexdigest()
        existing_raw_id = new_id()
        with self.fixture.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    existing_raw_id,
                    digest,
                    f"raw/{digest[:2]}/{digest}",
                    "application/pdf",
                    "pdf",
                    len(data) + 1,
                    "{}",
                ),
            )
        intent_id = new_id()

        with self.assertRaisesRegex(errors.CatalogError, "metadata conflicts"):
            self.fixture.accept(data, intent_id=intent_id)

        intent = self.fixture.repository.get_intent(intent_id)
        self.assertIs(intent.state, enums.AssetIntentState.PENDING)
        self.assertIsNone(intent.raw_asset_id)
        self.assertEqual(self.fixture.count("raw_assets"), 1)
        self.assertEqual(self.fixture.count("work_version_assets"), 0)
        self.assertEqual(
            self.fixture.count(
                "events", "WHERE subject_id = ? AND event_type = ?", (intent_id, "asset_intent.published")
            ),
            0,
        )
        self.assertEqual(self.fixture.count("failures"), 1)
        self.assertTrue((self.fixture.storage_root / intent.temporary_path).exists())
        self.assertTrue((self.fixture.storage_root / intent.storage_path).exists())

    def test_constructor_input_and_result_invariants_are_enforced(self) -> None:
        with self.assertRaises(TypeError):
            AssetAcceptanceCoordinator(object(), self.fixture.store)
        with self.assertRaises(TypeError):
            AssetAcceptanceCoordinator(self.fixture.repository, object())
        with self.assertRaises(ValueError):
            self.fixture.accept(intent_id="not-a-uuid")
        self.assertEqual(self.fixture.store.enumerate_staging(), ((), ()))

        result = self.fixture.accept()
        with self.assertRaisesRegex(ValueError, "reused_content"):
            AssetAcceptanceResult(
                result.intent,
                result.raw_asset,
                result.work_asset,
                result.publication,
                True,
            )

    def test_incoherent_work_and_role_fail_before_intent_creation(self) -> None:
        other_work, other_job = self.fixture.create_work_and_job("10.1000/coordinator-other")
        cases = (
            (self.fixture.work_version_id, other_job, enums.AssetRole.PRIMARY_PDF, "does not belong"),
            (other_work, other_job, enums.AssetRole.XML, "role does not match"),
        )
        for work_id, job_id, role, message in cases:
            with self.subTest(message=message):
                intent_id = new_id()
                with self.assertRaisesRegex(errors.CatalogError, message):
                    self.fixture.coordinator.accept(
                        BytesIO(b"incoherent request"),
                        work_id,
                        job_id,
                        role,
                        "application/pdf",
                        "pdf",
                        {"provider": "test"},
                        intent_id=intent_id,
                    )
                self.assertIsNone(self.fixture.repository.get_intent(intent_id))
                self.assertFalse(
                    (self.fixture.storage_root / f"staging/{intent_id}.part").exists()
                )


if __name__ == "__main__":
    import unittest

    unittest.main()
