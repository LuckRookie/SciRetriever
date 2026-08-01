import importlib
import inspect
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog_api = importlib.import_module("sciretriever.catalog")
domain_runs_api = importlib.import_module("sciretriever.catalog.domain_runs")
enums = importlib.import_module("sciretriever.core.enums")
sqlalchemy_exc = importlib.import_module("sqlalchemy.exc")
CatalogError = importlib.import_module("sciretriever.errors").CatalogError


class DomainRunTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        self.catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        catalog_api.initialize_catalog(self.catalog)
        work = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1000/domain-run"}).work_version
        self.package_version_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO package_versions "
                "(id, work_version_id, version, schema_version, quality, storage_path, sha256) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    self.package_version_id,
                    work.id,
                    1,
                    "1",
                    "pdf_backed",
                    "packages/work/v1.json",
                    "a" * 64,
                ),
            )
        self.runs = domain_runs_api.DomainRunRepository(self.catalog)

    def test_create_transition_success_and_exact_public_shape(self) -> None:
        run = self.runs.create_domain_run(self.package_version_id)
        self.assertEqual(run.status, enums.DomainRunStatus.PENDING)
        active = self.runs.transition_domain_run(run.id, "active")
        self.assertEqual(active.status, enums.DomainRunStatus.ACTIVE)
        succeeded = self.runs.transition_domain_run(
            run.id,
            enums.DomainRunStatus.SUCCEEDED,
            output_pointer="domain-outputs/run/manifest.json",
            output_sha256="b" * 64,
        )
        self.assertEqual(succeeded.output_pointer, "domain-outputs/run/manifest.json")
        self.assertEqual(succeeded.output_sha256, "b" * 64)
        self.assertEqual(self.runs.get_domain_run(run.id), succeeded)
        with self.assertRaises(FrozenInstanceError):
            succeeded.status = enums.DomainRunStatus.FAILED
        with self.assertRaises(CatalogError):
            self.runs.transition_domain_run(run.id, "failed")

        parameters = inspect.signature(self.runs.create_domain_run).parameters
        self.assertEqual(tuple(parameters), ("package_version_id",))

    def test_success_requires_output_pair_and_other_states_forbid_it(self) -> None:
        run = self.runs.create(self.package_version_id)
        self.runs.transition(run.id, "active")
        with self.assertRaises(ValueError):
            self.runs.transition(run.id, "succeeded", output_pointer="output.jsonl")
        with self.assertRaises(ValueError):
            self.runs.transition(
                run.id,
                "failed",
                output_pointer="output.jsonl",
                output_sha256="c" * 64,
            )
        failed = self.runs.transition(run.id, "failed")
        self.assertIsNone(failed.output_pointer)
        self.assertIsNone(failed.output_sha256)

    def test_foreign_key_conflict_is_catalog_error_with_root_cause(self) -> None:
        with self.assertRaises(CatalogError) as caught:
            self.runs.create_domain_run(str(uuid4()))
        self.assertIsInstance(caught.exception.__cause__, sqlalchemy_exc.IntegrityError)


if __name__ == "__main__":
    import unittest

    unittest.main()
