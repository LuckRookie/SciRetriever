from __future__ import annotations

import inspect
import unittest
from pathlib import Path

from pydantic import BaseModel, ValidationError

import sciretriever.core.library as core_library
from sciretriever.model.analysis import UnifiedMetadataValues
from sciretriever.model.documents import ReferenceView
from sciretriever.model.execution import CurrentFailure
from sciretriever.model.library import (
    ExportCandidate,
    ExportPreparedRecord,
    ExportSelectionRequest,
)
from sciretriever.model.library_details import GraphPage, WorkVersionDetail
from sciretriever.model.library_pages import LibraryPage, LibraryPageRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.library_views import WorkSummary
from sciretriever.model.literature import Author
from sciretriever.model.primitives import WorkId, WorkVersionId, WorkVersionState


class TargetLibraryModelOwnershipTests(unittest.TestCase):
    def test_library_read_contracts_have_direct_target_owners(self) -> None:
        owners = (
            (Author, "sciretriever.model.literature"),
            (UnifiedMetadataValues, "sciretriever.model.analysis"),
            (ReferenceView, "sciretriever.model.documents"),
            (CurrentFailure, "sciretriever.model.execution"),
            (QueryFilterV1, "sciretriever.model.library_query"),
            (LibraryPageRequest, "sciretriever.model.library_pages"),
            (LibraryPage, "sciretriever.model.library_pages"),
            (WorkSummary, "sciretriever.model.library_views"),
            (WorkVersionDetail, "sciretriever.model.library_details"),
            (GraphPage, "sciretriever.model.library_details"),
            (ExportCandidate, "sciretriever.model.library"),
            (ExportPreparedRecord, "sciretriever.model.library"),
            (ExportSelectionRequest, "sciretriever.model.library"),
        )
        for model, module_name in owners:
            self.assertEqual(model.__module__, module_name)
            self.assertTrue(issubclass(model, BaseModel))
            self.assertTrue(model.model_config.get("frozen"))
            self.assertEqual(model.model_config.get("extra"), "forbid")
            self.assertTrue(model.model_config.get("strict"))

    def test_library_model_sources_are_closed_to_old_layers(self) -> None:
        source_files = (
            Path(inspect.getfile(LibraryPageRequest)),
            Path(inspect.getfile(WorkSummary)),
            Path(inspect.getfile(WorkVersionDetail)),
            Path(inspect.getfile(ExportSelectionRequest)),
        )
        for source_file in source_files:
            source = source_file.read_text(encoding="utf-8")
            self.assertNotIn("sciretriever.interoperability", source)
            self.assertNotIn("sciretriever.kernel", source)
            self.assertNotIn("sciretriever.literature_store", source)

    def test_export_contracts_are_not_reexported_from_core(self) -> None:
        self.assertFalse(hasattr(core_library, "ExportCandidate"))
        self.assertFalse(hasattr(core_library, "ExportPreparedRecord"))
        self.assertFalse(hasattr(core_library, "ExportSelectionRequest"))

    def test_library_page_rejects_malformed_limits_and_round_trips(self) -> None:
        with self.assertRaises(ValidationError):
            LibraryPageRequest(limit=0, cursor=None, include_all_versions=False)
        with self.assertRaises(ValidationError):
            LibraryPageRequest(limit=True, cursor=None, include_all_versions=False)

        page = LibraryPage(
            items=(
                WorkSummary(
                    kind="work",
                    work_id=WorkId("00000000-0000-0000-0000-000000000001"),
                    work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000002"),
                    preferred_work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000002"),
                    title="A library work",
                    state=WorkVersionState.UNREVIEWED,
                ),
            ),
            next_cursor=None,
        )
        self.assertEqual(LibraryPage.model_validate_json(page.model_dump_json()), page)


if __name__ == "__main__":
    unittest.main()
