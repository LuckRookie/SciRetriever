from __future__ import annotations

import io
import threading
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO

from PyPDF2 import PdfWriter

from sciretriever.acquisition.pdf_identity import browser_pdf_belongs_to_literature
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionRequest,
    BrowserPdfAssociationEvidence,
    TemporaryPdf,
)
from sciretriever.acquisition.rules import PdfValidationCancelled, ValidatedPdf, validate_pdf
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.acquisition import AcquisitionPath, PdfCandidate
from sciretriever.model.literature import (
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging


def _pdf_bytes(*, metadata: dict[str, str] | None = None) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    if metadata is not None:
        writer.add_metadata(metadata)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _request() -> AcquisitionRequest:
    literature = Literature(
        literature_id=LiteratureId("00000001-0000-4000-8000-000000000001"),
        meta_literature_id=MetaLiteratureId("00000002-0000-4000-8000-000000000002"),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="A precise study of generic browser acquisition",
            authors=(
                Author(
                    kind=AuthorKind.PERSON,
                    display_name="Ada Lovelace",
                    given_name="Ada",
                    family_name="Lovelace",
                ),
            ),
            identifiers=(Identifier(namespace="doi", value="10.1234/target.article"),),
        ),
        status=LiteratureStatus.UNREVIEWED,
    )
    return AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
    )


def _evidence(
    *,
    start_kind: str = "landing",
    start_locator: str = "https://publisher.test/article",
    capture_locator: str = "https://publisher.test/article.pdf",
    capture_kind: str = "response",
    request_navigation: bool = False,
    from_exact_start: bool = False,
    native_download: bool = False,
) -> BrowserPdfAssociationEvidence:
    return BrowserPdfAssociationEvidence(
        start_locator=start_locator,
        start_kind=start_kind,
        capture_locator=capture_locator,
        capture_kind=capture_kind,
        correlation="direct-request",
        request_navigation=request_navigation,
        from_exact_start=from_exact_start,
        redirect_depth=0,
        native_download=native_download,
    )


class _Content:
    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        stream = io.BytesIO(_pdf_bytes())
        try:
            yield stream
        finally:
            stream.close()

    def discard(self) -> None:
        return


def _provenance() -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId("00000003-0000-4000-8000-000000000003"),
        source_kind=SourceKind.ASSET_PROVIDER,
        source_name="controlled-browser",
        source_record_id="generic-browser@1",
        observed_at=UtcTimestamp("2026-09-06T00:00:00Z"),
        input_sha256=None,
        parameters_sha256=None,
    )


def _candidate(path: AcquisitionPath) -> PdfCandidate:
    return PdfCandidate(
        candidate_key=f"candidate-{path.value}",
        source_name="controlled-browser",
        acquisition_path=path,
        declared_media_type="application/pdf",
    )


class BrowserPdfIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-pdf-identity-")
        self.addCleanup(self.temporary.cleanup)
        self.staging = SystemPdfValidationStaging(parent=Path(self.temporary.name))
        self.request = _request()

    def _validated(self, payload: bytes) -> ValidatedPdf:
        validated = validate_pdf(
            payload,
            staging=self.staging,
            max_bytes=len(payload),
        )
        self.addCleanup(validated.close)
        return validated

    def test_target_doi_in_pdf_or_capture_locator_establishes_identity(self) -> None:
        cases = (
            (
                _pdf_bytes(metadata={"/Subject": "doi:10.1234/target.article"}),
                _evidence(),
            ),
            (
                _pdf_bytes(),
                _evidence(capture_locator="https://publisher.test/10.1234/target.article"),
            ),
        )
        for payload, evidence in cases:
            with self.subTest(capture=evidence.capture_locator):
                self.assertTrue(
                    browser_pdf_belongs_to_literature(
                        self.request,
                        evidence,
                        self._validated(payload),
                    )
                )

    def test_exact_start_direct_file_navigation_is_strong_lineage(self) -> None:
        evidence = _evidence(
            start_kind="direct-file",
            start_locator="https://publisher.test/direct.pdf",
            capture_locator="https://publisher.test/direct.pdf",
            request_navigation=True,
            from_exact_start=True,
        )

        self.assertTrue(
            browser_pdf_belongs_to_literature(
                self.request,
                evidence,
                self._validated(_pdf_bytes()),
            )
        )

    def test_title_and_author_together_establish_identity(self) -> None:
        payload = _pdf_bytes(
            metadata={
                "/Title": "A precise study of generic browser acquisition",
                "/Author": "Ada Lovelace",
            }
        )

        self.assertTrue(
            browser_pdf_belongs_to_literature(
                self.request,
                _evidence(),
                self._validated(payload),
            )
        )

    def test_conflicting_doi_rejects_even_when_capture_url_contains_target(self) -> None:
        payload = _pdf_bytes(metadata={"/Subject": "doi:10.1234/different.article"})
        evidence = _evidence(capture_locator="https://publisher.test/10.1234/target.article")

        self.assertFalse(
            browser_pdf_belongs_to_literature(
                self.request,
                evidence,
                self._validated(payload),
            )
        )

    def test_supplementary_evidence_and_insufficient_identity_are_rejected(self) -> None:
        cases = (
            (
                _pdf_bytes(metadata={"/Subject": "doi:10.1234/target.article"}),
                _evidence(capture_locator="https://publisher.test/article-supplement.pdf"),
            ),
            (
                _pdf_bytes(
                    metadata={"/Subject": "Supporting Information doi:10.1234/target.article"}
                ),
                _evidence(),
            ),
            (_pdf_bytes(), _evidence()),
        )
        for payload, evidence in cases:
            with self.subTest(capture=evidence.capture_locator):
                self.assertFalse(
                    browser_pdf_belongs_to_literature(
                        self.request,
                        evidence,
                        self._validated(payload),
                    )
                )

    def test_cancellation_is_not_reported_as_an_identity_rejection(self) -> None:
        cancelled = threading.Event()
        cancelled.set()

        with self.assertRaises(PdfValidationCancelled):
            browser_pdf_belongs_to_literature(
                self.request,
                _evidence(),
                self._validated(_pdf_bytes()),
                cancel_event=cancelled,
            )

    def test_browser_temporary_pdf_requires_association_evidence_exclusively(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires association evidence"):
            TemporaryPdf(
                candidate=_candidate(AcquisitionPath.CONTROLLED_BROWSER),
                content=_Content(),
                safe_source_url="https://publisher.test/article.pdf",
                provenance=_provenance(),
            )

        with self.assertRaisesRegex(ValueError, "only Browser temporary PDFs"):
            TemporaryPdf(
                candidate=_candidate(AcquisitionPath.PUBLIC),
                content=_Content(),
                safe_source_url="https://publisher.test/article.pdf",
                provenance=_provenance(),
                browser_association=_evidence(),
            )


if __name__ == "__main__":
    unittest.main()
