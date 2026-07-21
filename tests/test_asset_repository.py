import importlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog_api = importlib.import_module("sciretriever.catalog")
assets_api = importlib.import_module("sciretriever.catalog.assets")
enums = importlib.import_module("sciretriever.core.enums")
CatalogError = importlib.import_module("sciretriever.errors").CatalogError


def new_id() -> str:
    return str(uuid4())


class AssetRepositoryTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        self.catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        catalog_api.apply_migrations(self.catalog)
        self.assets = assets_api.AssetRepository(self.catalog)
        self.work_id, self.job_id = self.create_work_and_job("10.1000/assets-one")

    def create_work_and_job(self, doi: str, role: str = "primary_pdf") -> tuple[str, str]:
        work = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work({"doi": doi}).work
        job = catalog_api.JobRepository(self.catalog).attach_or_create_job(work.id, role)
        return work.id, job.id

    def create_intent(
        self,
        *,
        intent_id: str | None = None,
        work_id: str | None = None,
        job_id: str | None = None,
        sha256: str = "a" * 64,
        provenance: object | None = None,
        byte_size: int = 42,
    ):
        return self.assets.create_intent(
            intent_id or new_id(),
            work_id or self.work_id,
            job_id or self.job_id,
            enums.AssetRole.PRIMARY_PDF,
            sha256,
            "application/pdf",
            "pdf",
            byte_size,
            {"provider": "example"} if provenance is None else provenance,
        )

    def count(self, table: str, where: str = "", parameters: tuple[object, ...] = ()) -> int:
        with self.catalog.connect() as connection:
            return connection.exec_driver_sql(
                f'SELECT count(*) FROM "{table}" {where}', parameters
            ).scalar_one()

    def test_root_export_queries_and_exact_record_conversions(self) -> None:
        self.assertIs(catalog_api.AssetRepository, assets_api.AssetRepository)
        self.assertIn("AssetRepository", catalog_api.__all__)
        intent = self.create_intent()
        self.assertIsInstance(self.assets.get_intent(intent.id), catalog_api.AssetIntentRecord)
        self.assertIs(intent.asset_role, enums.AssetRole.PRIMARY_PDF)
        self.assertIs(intent.state, enums.AssetIntentState.PENDING)
        self.assertIsNone(self.assets.get_intent(new_id()))

        published = self.assets.register_verified_published_intent(intent.id)
        raw = self.assets.get_raw_asset(published.raw_asset_id)
        self.assertIsInstance(raw, catalog_api.RawAssetRecord)
        self.assertEqual(self.assets.get_raw_asset_by_sha256(intent.expected_sha256), raw)
        links = self.assets.get_work_assets(self.work_id)
        self.assertEqual(len(links), 1)
        self.assertIsInstance(links[0], catalog_api.WorkAssetRecord)
        self.assertIs(links[0].asset_role, enums.AssetRole.PRIMARY_PDF)
        self.assertIsNone(self.assets.get_raw_asset(new_id()))
        self.assertIsNone(self.assets.get_raw_asset_by_sha256("f" * 64))

    def test_same_intent_and_unique_key_replays_are_idempotent(self) -> None:
        intent_id = new_id()
        first = self.create_intent(intent_id=intent_id)
        counts = (self.count("asset_intents"), self.count("events"))
        self.assertEqual(self.create_intent(intent_id=intent_id), first)
        self.assertEqual(self.create_intent(intent_id=new_id()), first)
        self.assertEqual((self.count("asset_intents"), self.count("events")), counts)

        published = self.assets.register_verified_published_intent(intent_id)
        event_count = self.count("events", "WHERE subject_id = ?", (intent_id,))
        self.assertEqual(self.assets.register_verified_published_intent(intent_id), published)
        self.assertEqual(self.count("events", "WHERE subject_id = ?", (intent_id,)), event_count)

        finalized = self.assets.finalize_intent(intent_id)
        event_count = self.count("events", "WHERE subject_id = ?", (intent_id,))
        self.assertEqual(self.assets.finalize_intent(intent_id), finalized)
        self.assertEqual(self.count("events", "WHERE subject_id = ?", (intent_id,)), event_count)

    def test_unique_collision_mismatch_rolls_back_without_mutation(self) -> None:
        self.create_intent(provenance={"provider": "first"})
        counts = (self.count("asset_intents"), self.count("events"))
        with self.assertRaisesRegex(CatalogError, "replay metadata conflicts"):
            self.create_intent(intent_id=new_id(), provenance={"provider": "second"})
        self.assertEqual((self.count("asset_intents"), self.count("events")), counts)

    def test_concurrent_content_reuse_preserves_first_provenance_and_all_links(self) -> None:
        work_two, job_two = self.create_work_and_job("10.1000/assets-two")
        sha256 = "b" * 64
        first = self.create_intent(
            work_id=self.work_id,
            job_id=self.job_id,
            sha256=sha256,
            provenance={"provider": "first"},
        )
        second = self.create_intent(
            work_id=work_two,
            job_id=job_two,
            sha256=sha256,
            provenance={"provider": "second"},
        )

        with ThreadPoolExecutor(max_workers=2) as executor:
            published = tuple(
                executor.map(
            self.assets.register_verified_published_intent,
                    (first.id, second.id),
                )
            )

        self.assertEqual({item.raw_asset_id for item in published}, {published[0].raw_asset_id})
        self.assertEqual(self.count("raw_assets"), 1)
        self.assertEqual(self.count("work_assets"), 2)
        self.assertEqual(self.count("asset_intents"), 2)
        raw = self.assets.get_raw_asset(published[0].raw_asset_id)
        self.assertIn(raw.provenance_json, ('{"provider":"first"}', '{"provider":"second"}'))
        with self.catalog.connect() as connection:
            events = connection.exec_driver_sql(
                "SELECT details_json FROM events WHERE event_type = 'asset_intent.published'"
            ).scalars().all()
        self.assertEqual(len(events), 2)
        self.assertEqual(sorted(json.loads(value)["reused"] for value in events), [False, True])
        self.assertEqual(
            {self.assets.get_intent(first.id).provenance_json, self.assets.get_intent(second.id).provenance_json},
            {'{"provider":"first"}', '{"provider":"second"}'},
        )

    def test_abandonment_is_atomic_durable_and_idempotent(self) -> None:
        intent = self.create_intent()
        abandoned = self.assets.abandon_pending_intent(
            intent.id,
            "verification_failed",
            "published file did not verify",
            retryable=True,
            details={"observed_size": 41},
        )
        self.assertIs(abandoned.state, enums.AssetIntentState.ABANDONED)
        counts = (self.count("failures"), self.count("events"))
        self.assertEqual(
            self.assets.abandon_pending_intent(intent.id, "ignored", "ignored"), abandoned
        )
        self.assertEqual((self.count("failures"), self.count("events")), counts)
        with self.catalog.connect() as connection:
            failure = connection.exec_driver_sql(
                "SELECT work_id, job_id, category, retryable, details_json FROM failures"
            ).mappings().one()
        self.assertEqual(failure["work_id"], self.work_id)
        self.assertEqual(failure["job_id"], self.job_id)
        self.assertEqual(failure["category"], "verification_failed")
        self.assertEqual(failure["retryable"], 1)
        self.assertEqual(
            json.loads(failure["details_json"]),
            {"intent_id": intent.id, "details": {"observed_size": 41}},
        )

    def test_record_failure_works_for_every_state_without_changing_intents(self) -> None:
        pending = self.create_intent(sha256="4" * 64)

        published_work, published_job = self.create_work_and_job("10.1000/failure-published")
        published = self.create_intent(
            work_id=published_work, job_id=published_job, sha256="5" * 64
        )
        published = self.assets.register_verified_published_intent(published.id)

        finalized_work, finalized_job = self.create_work_and_job("10.1000/failure-finalized")
        finalized = self.create_intent(
            work_id=finalized_work, job_id=finalized_job, sha256="6" * 64
        )
        self.assets.register_verified_published_intent(finalized.id)
        finalized = self.assets.finalize_intent(finalized.id)

        abandoned_work, abandoned_job = self.create_work_and_job("10.1000/failure-abandoned")
        abandoned = self.create_intent(
            work_id=abandoned_work, job_id=abandoned_job, sha256="7" * 64
        )
        abandoned = self.assets.abandon_pending_intent(
            abandoned.id, "initial_abandonment", "initial abandonment"
        )

        intents = (pending, published, finalized, abandoned)
        before = {intent.id: self.assets.get_intent(intent.id) for intent in intents}
        for intent in intents:
            with self.subTest(state=intent.state):
                failure = self.assets.record_intent_failure(
                    intent.id,
                    "reconciliation_error",
                    "reconciliation observation",
                    retryable=True,
                    details={"state": intent.state.value},
                )
                self.assertIsInstance(failure, catalog_api.FailureRecord)
                self.assertEqual(failure.work_id, intent.work_id)
                self.assertEqual(failure.job_id, intent.job_id)
                self.assertEqual(
                    json.loads(failure.details_json),
                    {"intent_id": intent.id, "details": {"state": intent.state.value}},
                )
                self.assertEqual(self.assets.get_intent(intent.id), before[intent.id])

        self.assertEqual(
            self.count("events", "WHERE event_type = ?", ("asset_intent.failure_recorded",)),
            4,
        )

    def test_record_failure_exact_replay_is_idempotent_but_distinct_details_insert(self) -> None:
        intent = self.create_intent(sha256="8" * 64)
        first = self.assets.record_intent_failure(
            intent.id,
            "verification_error",
            "verification failed",
            retryable=False,
            details={"actual": 41, "expected": 42},
        )
        counts = (self.count("failures"), self.count("events"))
        replay = self.assets.record_intent_failure(
            intent.id,
            "verification_error",
            "verification failed",
            retryable=False,
            details={"expected": 42, "actual": 41},
        )
        self.assertEqual(replay, first)
        self.assertEqual((self.count("failures"), self.count("events")), counts)

        second = self.assets.record_intent_failure(
            intent.id,
            "verification_error",
            "verification failed",
            retryable=False,
            details={"actual": 40, "expected": 42},
        )
        self.assertNotEqual(second.id, first.id)
        self.assertEqual(self.count("failures"), counts[0] + 1)
        self.assertEqual(self.count("events"), counts[1] + 1)
        self.assertEqual(self.assets.get_intent(intent.id), intent)

    def test_illegal_states_missing_rows_and_read_only_are_rejected(self) -> None:
        pending = self.create_intent()
        with self.assertRaises(CatalogError):
            self.assets.finalize_intent(pending.id)
        published = self.assets.register_verified_published_intent(pending.id)
        with self.assertRaises(CatalogError):
            self.assets.abandon_pending_intent(published.id, "late", "too late")

        other_work, other_job = self.create_work_and_job("10.1000/abandoned")
        abandoned = self.create_intent(
            work_id=other_work, job_id=other_job, sha256="c" * 64
        )
        self.assets.abandon_pending_intent(abandoned.id, "cancelled", "cancelled")
        with self.assertRaises(CatalogError):
            self.assets.register_verified_published_intent(abandoned.id)
        for operation in (
            lambda: self.assets.register_verified_published_intent(new_id()),
            lambda: self.assets.finalize_intent(new_id()),
            lambda: self.assets.abandon_pending_intent(new_id(), "missing", "missing"),
            lambda: self.assets.record_intent_failure(new_id(), "missing", "missing"),
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(CatalogError):
                    operation()

        read_only = catalog_api.open_read_only_catalog_engine(self.path)
        self.addCleanup(read_only.dispose)
        with self.assertRaisesRegex(CatalogError, "writable"):
            assets_api.AssetRepository(read_only)
        with self.assertRaises(TypeError):
            assets_api.AssetRepository(object())

    def test_reconcilable_listing_is_deterministic_and_excludes_terminal_states(self) -> None:
        work_two, job_two = self.create_work_and_job("10.1000/list-two")
        lower_id = "00000000-0000-4000-8000-000000000001"
        higher_id = "ffffffff-ffff-4fff-bfff-ffffffffffff"
        timestamp = "2026-07-20T12:00:00.000Z"
        with patch.object(assets_api, "utc_now_rfc3339", return_value=timestamp):
            higher = self.create_intent(intent_id=higher_id, sha256="d" * 64)
            lower = self.create_intent(
                intent_id=lower_id, work_id=work_two, job_id=job_two, sha256="e" * 64
            )
        self.assets.register_verified_published_intent(higher.id)
        self.assets.abandon_pending_intent(lower.id, "skip", "skip")

        work_three, job_three = self.create_work_and_job("10.1000/list-three")
        with patch.object(assets_api, "utc_now_rfc3339", return_value=timestamp):
            pending = self.create_intent(
                intent_id=lower_id.replace("0001", "0002"),
                work_id=work_three,
                job_id=job_three,
                sha256="1" * 64,
            )
        listed = self.assets.list_reconcilable_intents()
        self.assertEqual([item.id for item in listed], [pending.id, higher.id])
        self.assets.finalize_intent(higher.id)
        self.assertEqual(self.assets.list_reconcilable_intents(), (pending,))

    def test_validation_foreign_keys_and_raw_metadata_conflicts_fail_without_partial_writes(self) -> None:
        with self.assertRaises(CatalogError):
            self.assets.create_intent(
                new_id(),
                new_id(),
                new_id(),
                "primary_pdf",
                "2" * 64,
                "application/pdf",
                "pdf",
                42,
                {},
            )
        self.assertEqual(self.count("asset_intents"), 0)

        intent = self.create_intent(sha256="3" * 64)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), "3" * 64, f"raw/33/{'3' * 64}", "application/pdf", "pdf", 99, "{}"),
            )
        counts = (self.count("work_assets"), self.count("events"))
        with self.assertRaisesRegex(CatalogError, "metadata conflicts"):
            self.assets.register_verified_published_intent(intent.id)
        self.assertEqual((self.count("work_assets"), self.count("events")), counts)
        self.assertIs(self.assets.get_intent(intent.id).state, enums.AssetIntentState.PENDING)

    def test_create_intent_rejects_incoherent_job_work_role_and_attempt(self) -> None:
        work_two, job_two = self.create_work_and_job("10.1000/assets-incoherent")
        xml_work, xml_job = self.create_work_and_job("10.1000/assets-xml", role="xml")
        attempt_id = new_id()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO acquisition_attempts (id, job_id, provider) VALUES (?, ?, ?)",
                (attempt_id, job_two, "example"),
            )

        cases = (
            (self.work_id, job_two, "primary_pdf", None, "does not belong"),
            (xml_work, xml_job, "primary_pdf", None, "role does not match"),
            (self.work_id, self.job_id, "primary_pdf", attempt_id, "attempt does not belong"),
        )
        for work_id, job_id, role, attempt, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(CatalogError, message):
                    self.assets.create_intent(
                        new_id(),
                        work_id,
                        job_id,
                        role,
                        "9" * 64,
                        "application/pdf",
                        "pdf",
                        42,
                        {},
                        attempt_id=attempt,
                    )
        self.assertEqual(self.count("asset_intents"), 0)

    def test_public_registration_bypass_is_absent(self) -> None:
        self.assertFalse(callable(getattr(self.assets, "register_published_intent", None)))


if __name__ == "__main__":
    import unittest

    unittest.main()
