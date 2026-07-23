from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import IdentityResolver, ProcessingRunRepository, initialize_catalog, create_catalog_engine
from sciretriever.core.enums import ProcessingRunState, ProcessingStage


class ProcessingRepositoryTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_version_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/processing"}).work_version.id
        self.repository = ProcessingRunRepository(self.catalog)

    def test_claim_success_and_exact_replay_are_idempotent(self) -> None:
        first = self.repository.claim_or_resume(
            self.work_version_id, ProcessingStage.NORMALIZATION, "normalizer", "1", {"pages": 10}
        )
        replay = self.repository.claim_or_resume(
            self.work_version_id, "normalization", "normalizer", "1", {"pages": 10}
        )
        self.assertEqual(replay, first)
        succeeded = self.repository.succeed(first.id)
        self.assertIs(succeeded.state, ProcessingRunState.SUCCEEDED)
        self.assertEqual(self.repository.succeed(first.id), succeeded)
        self.assertEqual(
            self.repository.claim_or_resume(
                self.work_version_id, "normalization", "normalizer", "1", {"pages": 10}
            ),
            succeeded,
        )

    def test_failure_is_recorded_once_and_can_resume(self) -> None:
        run = self.repository.claim_or_resume(
            self.work_version_id, "enrichment", "enricher", "1", {"summary": 200}
        )
        failed = self.repository.fail(run.id, "summarizer_failed", "offline failure")
        self.assertIs(failed.state, ProcessingRunState.FAILED)
        self.assertEqual(self.repository.fail(run.id, "ignored", "ignored"), failed)
        resumed = self.repository.claim_or_resume(
            self.work_version_id, "enrichment", "enricher", "1", {"summary": 200}
        )
        self.assertIs(resumed.state, ProcessingRunState.ACTIVE)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM failures").scalar_one(), 1)


if __name__ == "__main__":
    import unittest
    unittest.main()
