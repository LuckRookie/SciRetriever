from __future__ import annotations

import stat
import unittest
import zipfile
from io import BytesIO

from target_light_document_support import (
    ASSET_ID,
    TaskBoundaryService,
    archive_bytes,
    document_value,
    parser_request,
    pdf_bytes,
)

from sciretriever.core.documents import LightDocumentError, validate_light_document
from sciretriever.infrastructure.parsers.mineru import (
    MinerUArchiveAdapter,
    MinerUArchiveBounds,
    MinerUServiceBounds,
    OperatorManagedMinerUAdapter,
)
from sciretriever.model.canonical_json import CanonicalJsonInput
from sciretriever.model.documents import LightDocumentBounds, ParagraphBlock
from sciretriever.model.parsing import ParserTask, ParserTaskState
from sciretriever.model.primitives import sha256_digest
from sciretriever.services.documents.ports import ParserFailure


class TargetMinerUTests(unittest.TestCase):
    def test_local_archive_converts_to_typed_document_context(self) -> None:
        parsed = MinerUArchiveAdapter(MinerUArchiveBounds()).parse(archive_bytes(), pdf_bytes())

        document = validate_light_document(
            parsed.document,
            ASSET_ID,
            parsed.pdf_pages,
            parsed.block_manifest,
            LightDocumentBounds(),
        )

        first = document.sections[0].blocks[0]
        self.assertIsInstance(first, ParagraphBlock)
        assert isinstance(first, ParagraphBlock)
        self.assertEqual(first.text, "alpha")

    def test_archive_traversal_symlink_oversize_and_truncation_reject(self) -> None:
        adapter = MinerUArchiveAdapter(MinerUArchiveBounds(max_archive_bytes=500_000))
        hostile = BytesIO()
        with zipfile.ZipFile(hostile, "w") as archive:
            archive.writestr("../doc_content_list.json", "{}")
        symlink = BytesIO()
        link = zipfile.ZipInfo("doc_content_list.json")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(symlink, "w") as archive:
            archive.writestr(link, "target")
        oversized = MinerUArchiveAdapter(MinerUArchiveBounds(max_member_bytes=4))
        truncated = document_value()
        truncated["truncated"] = True
        for payload in (
            hostile.getvalue(),
            symlink.getvalue(),
            archive_bytes(truncated),
            b"not-a-zip",
        ):
            with self.subTest(size=len(payload)), self.assertRaises(ParserFailure):
                adapter.parse(payload, pdf_bytes())
        with self.assertRaises(ParserFailure):
            oversized.parse(archive_bytes(), pdf_bytes())

    def test_remote_recovery_polls_explicit_task_without_submit(self) -> None:
        class Service:
            submitted = 0
            polled: list[str] = []

            def submit(self, pdf: bytes) -> str:
                self.submitted += 1
                return "new-task"

            def poll(self, task_id: str) -> ParserTask:
                self.polled.append(task_id)
                return ParserTask(
                    task_id=task_id,
                    state=ParserTaskState.COMPLETED,
                    archive=archive_bytes(),
                )

        pdf = pdf_bytes()
        service = Service()
        adapter = OperatorManagedMinerUAdapter(
            service,
            MinerUArchiveAdapter(MinerUArchiveBounds()),
            MinerUServiceBounds(2),
        )

        result = adapter.parse(parser_request(pdf, resume_task_id="approved-task"))

        self.assertEqual(result.document.schema_version, "1")
        self.assertEqual(result.provenance.input_sha256, sha256_digest(pdf))
        self.assertEqual(result.provenance.task_id, "approved-task")
        self.assertEqual((service.submitted, service.polled), (0, ["approved-task"]))

    def test_locator_page_must_match_manifest_block_page(self) -> None:
        for page_start, page_end in ((2, 2), (1, 2)):
            value = document_value()
            title = value["title"]
            assert isinstance(title, dict)
            evidence = title["evidence"]
            assert isinstance(evidence, list)
            locator = evidence[0]
            assert isinstance(locator, dict)
            locator.update(page_start=page_start, page_end=page_end)
            with self.subTest(pages=(page_start, page_end)), self.assertRaises(LightDocumentError):
                parsed = MinerUArchiveAdapter(MinerUArchiveBounds()).parse(
                    archive_bytes(value), pdf_bytes()
                )
                validate_light_document(
                    parsed.document,
                    ASSET_ID,
                    parsed.pdf_pages,
                    parsed.block_manifest,
                    LightDocumentBounds(),
                )

    def test_page_two_manifest_block_accepts_page_two_locator(self) -> None:
        value = document_value()
        title = value["title"]
        assert isinstance(title, dict)
        evidence = title["evidence"]
        assert isinstance(evidence, list)
        locator = evidence[0]
        assert isinstance(locator, dict)
        locator.update(block_id="page-two", page_start=2, page_end=2)
        middle: dict[str, CanonicalJsonInput] = {
            "_backend": "vlm",
            "pdf_info": [
                {"page_idx": 0, "blocks": {"b1": 5, "b2": 4, "b3": 1, "b4": 1, "b5": 6}},
                {"page_idx": 1, "blocks": {"page-two": 5}},
            ],
        }

        parsed = MinerUArchiveAdapter(MinerUArchiveBounds()).parse(
            archive_bytes(value, middle), pdf_bytes()
        )
        document = validate_light_document(
            parsed.document,
            ASSET_ID,
            parsed.pdf_pages,
            parsed.block_manifest,
            LightDocumentBounds(),
        )

        assert document.title is not None
        self.assertEqual(document.title.evidence[0].page_start, 2)

    def test_invalid_task_ids_stop_at_resume_submit_and_poll_boundaries(self) -> None:
        invalid = ("", " ", "x" * 129, "bad\nline", "path/value", "任务")
        pdf = pdf_bytes()
        for boundary in ("resume", "submit", "poll"):
            for task_id in invalid:
                with self.subTest(boundary=boundary, task_id=task_id[:8]):
                    service = TaskBoundaryService(task_id, boundary)
                    adapter = OperatorManagedMinerUAdapter(
                        service, MinerUArchiveAdapter(MinerUArchiveBounds()), MinerUServiceBounds(2)
                    )
                    with self.assertRaises(ParserFailure):
                        adapter.parse(
                            parser_request(
                                pdf,
                                resume_task_id=task_id if boundary == "resume" else None,
                            )
                        )
                    self.assertEqual(service.polls, 0 if boundary in {"resume", "submit"} else 1)


if __name__ == "__main__":
    unittest.main()
