from __future__ import annotations

import unittest

from pydantic import ValidationError

from sciretriever.core.library import (
    prepare_export_record,
    select_export_candidates,
)
from sciretriever.model.analysis import UnifiedMetadataValues
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.library import ExportCandidate
from sciretriever.model.library_details import WorkVersionDetail
from sciretriever.model.library_views import MetadataView, ReferenceSetView, TagSetView, TagView
from sciretriever.model.literature import Author, Identifier
from sciretriever.model.primitives import (
    VersionRole,
    WorkId,
    WorkVersionId,
    WorkVersionState,
    sha256_digest,
)

WORK_ID = WorkId("00000000-0000-0000-0000-000000000001")


def _candidate(version: str, role: VersionRole, *, complete: bool = True) -> ExportCandidate:
    version_id = WorkVersionId(f"00000000-0000-0000-0000-{version:0>12}")
    values = UnifiedMetadataValues(
        title="A unified title",
        authors=(
            Author(
                display_name="Ada Lovelace",
                family_name="Lovelace",
                given_name="Ada",
                orcid=None,
                affiliations=("Analytical Engine",),
            ),
        ),
        abstract="An abstract",
        publication_date=None,
        publication_year=1843,
        document_type="article",
        language="en",
        venue="Journal",
        publisher=None,
        volume=None,
        issue=None,
        pages="1-2",
        article_number=None,
        open_access_status=None,
        identifiers=(Identifier(namespace="doi", value="10.1000/example"),),
    )
    detail = WorkVersionDetail(
        kind="work-version-detail",
        work_id=WORK_ID,
        work_version_id=version_id,
        identifiers=values.identifiers,
        metadata=MetadataView(
            revision=1,
            sha256=sha256_digest(b"metadata"),
            values=values,
            keywords=("metadata-keyword",),
            provenance=(),
        ),
        assets=(),
        light_document=None,
        analysis=None,
        references=ReferenceSetView(complete=complete, items=()),
        tags=TagSetView(
            complete=complete,
            items=(TagView(name="tag", evidence=CanonicalJsonObject(())),),
        ),
        state=WorkVersionState.UNREVIEWED,
        missing_step=None,
        current_failure=None,
        observations_included=False,
        observations=(),
        provenance=(),
    )
    return ExportCandidate(
        work_id=WORK_ID,
        work_version_id=version_id,
        version_role=role,
        detail=detail,
    )


class M7LibraryExportCoreTests(unittest.TestCase):
    def test_candidate_rejects_identity_mismatch_in_model(self) -> None:
        candidate = _candidate("000000000005", VersionRole.FORMAL)

        with self.assertRaises(ValidationError):
            ExportCandidate(
                work_id=candidate.work_id,
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000006"),
                version_role=candidate.version_role,
                detail=candidate.detail,
            )

    def test_default_selection_prefers_formal_version_without_completion_gate(self) -> None:
        preprint = _candidate("000000000002", VersionRole.PREPRINT)
        formal = _candidate("000000000003", VersionRole.FORMAL)

        selected = select_export_candidates((preprint, formal), all_versions=False)

        self.assertEqual(
            tuple(item.work_version_id for item in selected),
            (formal.work_version_id,),
        )
        self.assertEqual(prepare_export_record(formal).record.title, "A unified title")

    def test_all_versions_maps_fields_and_reports_incomplete_optional_sets(self) -> None:
        candidate = _candidate("000000000004", VersionRole.OTHER, complete=False)

        prepared = prepare_export_record(candidate)

        self.assertEqual(prepared.record.authors, ("Ada Lovelace",))
        self.assertEqual(prepared.record.identifiers, candidate.detail.metadata.values.identifiers)
        self.assertEqual(prepared.record.institutions, ("Analytical Engine",))
        self.assertEqual(prepared.record.keywords, ("metadata-keyword",))
        self.assertEqual(
            tuple(item.field for item in prepared.omissions),
            ("tags", "references"),
        )


if __name__ == "__main__":
    unittest.main()
