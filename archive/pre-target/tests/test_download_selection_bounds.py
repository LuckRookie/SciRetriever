from __future__ import annotations

import argparse
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    WorkRepository,
    WorkVersionDownloadRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.cli import download


class DownloadSelectionBoundsTests(unittest.TestCase):
    def test_all_missing_repository_selection_is_bounded(self) -> None:
        # Given
        with TemporaryDirectory(prefix="sciretriever-download-selection-") as temporary:
            engine = create_catalog_engine(Path(temporary) / "catalog.sqlite")
            self.addCleanup(engine.dispose)
            initialize_catalog(engine)
            works = WorkRepository(engine)
            for index in range(105):
                works.ingest_version(
                    provider="fixture",
                    provider_record_id=f"record-{index:03d}",
                    title=f"Bounded selection {index:03d}",
                )
            repository = WorkVersionDownloadRepository(engine)

            # When
            default_batch = repository.select_all_missing_primary_pdf(limit=100)
            explicit_batch = repository.select_all_missing_primary_pdf(limit=7)

            # Then
            self.assertEqual(len(default_batch.work_version_ids), 100)
            self.assertEqual(
                explicit_batch.work_version_ids,
                default_batch.work_version_ids[:7],
            )

    def test_all_missing_cli_forwards_explicit_limit(self) -> None:
        # Given
        repository = mock.Mock()
        repository.select_all_missing_primary_pdf.return_value.work_version_ids = ()
        args = argparse.Namespace(
            work_version_id=None,
            work_id=None,
            all_missing=True,
            query=None,
            author=None,
            year=None,
            publisher=None,
            venue=None,
            tag=None,
            limit=7,
        )

        # When
        download._selection(repository, args)

        # Then
        repository.select_all_missing_primary_pdf.assert_called_once_with(limit=7)


if __name__ == "__main__":
    unittest.main()
