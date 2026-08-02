from __future__ import annotations

import ast
import importlib
import os
import stat
import unittest
import zipfile
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import BaseModel, ValidationError
from target_light_document_support import (
    ASSET_ID,
    TaskBoundaryService,
    archive_bytes,
    document_value,
    manifest_blocks,
    parser_request,
    pdf_bytes,
)

from sciretriever.adapters.mineru import (
    MinerUArchiveAdapter,
    MinerUServiceBounds,
    OperatorManagedMinerUAdapter,
)
from sciretriever.content.light_document import (
    LightDocumentBounds,
    LightDocumentError,
    validate_light_document,
)
from sciretriever.content.light_serialization import document_bytes
from sciretriever.content.light_service import (
    LightDocumentService,
    ParserIdentity,
)
from sciretriever.kernel.json import CanonicalJsonInput
from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.model import documents as document_models
from sciretriever.model.assets import PublishedArtifact, StagedArtifact
from sciretriever.model.documents import (
    LightDocumentAcceptance,
    LightPublicationTarget,
    ParagraphBlock,
)
from sciretriever.model.parsing import ParserTask, ParserTaskState
from sciretriever.model.primitives import WorkVersionAssetId, WorkVersionId, sha256_digest

legacy_light_models = importlib.import_module("sciretriever.content.light_models")
legacy_content_api = importlib.import_module("sciretriever.content.api")
legacy_light_document = importlib.import_module("sciretriever.content.light_document")


class TargetLightDocumentTests(unittest.TestCase):
    def test_document_contracts_have_one_strict_model_owner(self) -> None:
        target_names = {
            "SourceLocator",
            "EvidenceText",
            "Author",
            "ParagraphBlock",
            "ListBlock",
            "TableBlock",
            "FormulaBlock",
            "FigureCaptionBlock",
            "Section",
            "ReferenceView",
            "LightDocumentV1",
        }
        legacy_path = (
            Path(__file__).parents[1] / "src" / "sciretriever" / "content" / "light_models.py"
        )
        legacy_tree = ast.parse(legacy_path.read_text(encoding="utf-8"))
        legacy_definitions = {
            node.name for node in ast.walk(legacy_tree) if isinstance(node, ast.ClassDef)
        }

        self.assertEqual(legacy_definitions & target_names, set())
        for name in target_names:
            contract = getattr(document_models, name)
            self.assertTrue(issubclass(contract, BaseModel))
            allowed_owners = {document_models.__name__}
            if name == "Author":
                allowed_owners.add("sciretriever.model.literature")
            self.assertIn(contract.__module__, allowed_owners)
            self.assertTrue(contract.model_config["frozen"])
            self.assertTrue(contract.model_config["strict"])
            self.assertEqual(contract.model_config["extra"], "forbid")
            self.assertNotIn(name, legacy_light_models.__dict__)
            self.assertNotIn(name, legacy_content_api.__dict__)
            self.assertNotIn(name, legacy_light_document.__dict__)

    def test_target_model_round_trip_keeps_nested_block_variants(self) -> None:
        document = validate_light_document(
            document_value(),
            ASSET_ID,
            2,
            manifest_blocks(),
            LightDocumentBounds(),
        )

        parsed = document_models.LightDocumentV1.model_validate_json(document.model_dump_json())

        self.assertEqual(parsed, document)
        self.assertIsInstance(parsed.sections[0].blocks[0], document_models.ParagraphBlock)
        self.assertEqual(document_bytes(parsed), document_bytes(document))

    def test_complete_union_is_frozen_canonical_and_preserves_order(self) -> None:
        document = validate_light_document(
            document_value(),
            ASSET_ID,
            2,
            manifest_blocks(),
            LightDocumentBounds(),
        )

        self.assertEqual(document_bytes(document), document_bytes(document))
        self.assertEqual(
            [block.kind for block in document.sections[0].blocks],
            ["paragraph", "list", "table", "formula", "figure-caption"],
        )
        with self.assertRaises(ValidationError):
            setattr(document, "schema_version", "2")

    def test_closed_schema_recursive_bounds_and_locator_alignment_reject(self) -> None:
        cases: list[tuple[str, dict[str, CanonicalJsonInput], LightDocumentBounds]] = []
        extra = document_value()
        extra["unexpected"] = True
        cases.append(("extra", extra, LightDocumentBounds()))
        bad_page = document_value()
        title = bad_page["title"]
        assert isinstance(title, dict)
        evidence = title["evidence"]
        assert isinstance(evidence, list)
        assert isinstance(evidence[0], dict)
        evidence[0]["page_end"] = 3
        cases.append(("page", bad_page, LightDocumentBounds()))
        empty = document_value()
        empty["sections"] = []
        cases.append(("empty", empty, LightDocumentBounds()))
        for name, value, bounds in cases:
            with self.subTest(name=name), self.assertRaises(LightDocumentError):
                validate_light_document(value, ASSET_ID, 2, manifest_blocks(), bounds)

    def test_local_mineru_archive_converts_only_complete_aligned_document(self) -> None:
        adapter = MinerUArchiveAdapter(LightDocumentBounds())
        pdf = pdf_bytes()

        document = adapter.parse(archive_bytes(), ASSET_ID, sha256_digest(pdf), pdf)

        self.assertEqual(document.schema_version, "1")
        first = document.sections[0].blocks[0]
        self.assertIsInstance(first, ParagraphBlock)
        assert isinstance(first, ParagraphBlock)
        self.assertEqual(first.text, "alpha")

    def test_archive_traversal_symlink_oversize_and_truncation_reject(self) -> None:
        adapter = MinerUArchiveAdapter(LightDocumentBounds(max_archive_bytes=500_000))
        hostile = BytesIO()
        with zipfile.ZipFile(hostile, "w") as archive:
            archive.writestr("../doc_content_list.json", "{}")
        symlink = BytesIO()
        link = zipfile.ZipInfo("doc_content_list.json")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(symlink, "w") as archive:
            archive.writestr(link, "target")
        oversized = MinerUArchiveAdapter(LightDocumentBounds(max_member_bytes=4))
        truncated = document_value()
        truncated["truncated"] = True
        for payload in (
            hostile.getvalue(),
            symlink.getvalue(),
            archive_bytes(truncated),
            b"not-a-zip",
        ):
            with self.subTest(size=len(payload)), self.assertRaises(LightDocumentError):
                adapter.parse(payload, ASSET_ID, sha256_digest(pdf_bytes()), pdf_bytes())
        with self.assertRaises(LightDocumentError):
            oversized.parse(archive_bytes(), ASSET_ID, sha256_digest(pdf_bytes()), pdf_bytes())

    def test_publication_writes_canonical_artifact_before_acceptance(self) -> None:
        events: list[str] = []

        class Store:
            def __init__(self, root: str) -> None:
                self._store = CoreArtifactStore(root)

            def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
                events.append("artifact")
                return self._store.publish(artifact)

        class Sink:
            acceptance: LightDocumentAcceptance | None = None

            def publish(self, acceptance: LightDocumentAcceptance) -> None:
                events.append("catalog")
                self.acceptance = acceptance

        with TemporaryDirectory(prefix="sciretriever-light-") as directory:
            os.chmod(directory, 0o700)
            document = validate_light_document(
                document_value(),
                ASSET_ID,
                2,
                manifest_blocks(),
                LightDocumentBounds(),
            )
            sink = Sink()
            target = LightPublicationTarget(
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000201"),
                primary_relation_id=WorkVersionAssetId("00000000-0000-0000-0000-000000000202"),
                primary_asset_id=ASSET_ID,
                primary_sha256=sha256_digest(pdf_bytes()),
            )
            parser = ParserIdentity("mineru", "3.4.4", "vlm", "fixture", sha256_digest(b"params"))

            result = LightDocumentService(Store(str(Path(directory) / "storage")), sink).publish(
                target, document, parser
            )

            self.assertEqual(events, ["artifact", "catalog"])
            self.assertEqual(result.artifact.sha256, sha256_digest(document_bytes(document)))
            self.assertIsNotNone(sink.acceptance)

    def test_remote_recovery_polls_only_explicit_task_id_without_submit(self) -> None:
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
            MinerUArchiveAdapter(LightDocumentBounds()),
            MinerUServiceBounds(2),
        )

        result = adapter.parse(parser_request(pdf, resume_task_id="approved-task"))

        self.assertEqual(result.document.schema_version, "1")
        self.assertEqual(result.provenance.input_sha256, sha256_digest(pdf))
        self.assertEqual(result.provenance.task_id, "approved-task")
        self.assertEqual((service.submitted, service.polled), (0, ["approved-task"]))

    def test_duplicate_block_ids_reject_across_complete_recursive_tree(self) -> None:
        cases: list[dict[str, CanonicalJsonInput]] = []
        same = document_value()
        sections = same["sections"]
        assert isinstance(sections, list)
        section = sections[0]
        assert isinstance(section, dict)
        blocks = section["blocks"]
        assert isinstance(blocks, list)
        blocks.append(deepcopy(blocks[0]))
        cases.append(same)
        sibling = document_value()
        sibling_sections = sibling["sections"]
        assert isinstance(sibling_sections, list)
        sibling_sections.append(deepcopy(sibling_sections[0]))
        cases.append(sibling)
        deep = document_value()
        deep_sections = deep["sections"]
        assert isinstance(deep_sections, list)
        deep_section = deep_sections[0]
        assert isinstance(deep_section, dict)
        child = deepcopy(deep_section)
        child["section_id"] = "nested"
        deep_section["children"] = [child]
        cases.append(deep)
        for value in cases:
            with self.subTest(depth=str(value)[:20]), self.assertRaises(LightDocumentError):
                validate_light_document(
                    value, ASSET_ID, 2, manifest_blocks(), LightDocumentBounds()
                )

    def test_repeated_locators_for_one_unique_block_remain_valid(self) -> None:
        value = document_value()
        title = value["title"]
        assert isinstance(title, dict)
        evidence = title["evidence"]
        assert isinstance(evidence, list)
        evidence.append(deepcopy(evidence[0]))

        document = validate_light_document(
            value, ASSET_ID, 2, manifest_blocks(), LightDocumentBounds()
        )

        assert document.title is not None
        self.assertEqual(len(document.title.evidence), 2)

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
                MinerUArchiveAdapter(LightDocumentBounds()).parse(
                    archive_bytes(value), ASSET_ID, sha256_digest(pdf_bytes()), pdf_bytes()
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

        document = MinerUArchiveAdapter(LightDocumentBounds()).parse(
            archive_bytes(value, middle), ASSET_ID, sha256_digest(pdf_bytes()), pdf_bytes()
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
                        service, MinerUArchiveAdapter(LightDocumentBounds()), MinerUServiceBounds(2)
                    )
                    with self.assertRaises(LightDocumentError):
                        adapter.parse(
                            parser_request(
                                pdf,
                                resume_task_id=task_id if boundary == "resume" else None,
                            )
                        )
                    self.assertEqual(service.polls, 0 if boundary in {"resume", "submit"} else 1)


if __name__ == "__main__":
    unittest.main()
