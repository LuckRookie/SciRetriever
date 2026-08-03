from __future__ import annotations

import importlib.util
import os
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import BaseModel, ValidationError
from target_light_document_support import (
    ASSET_ID,
    TaskBoundaryService,
    document_value,
    manifest_blocks,
    parsed_document,
    parser_request,
    pdf_bytes,
)

from sciretriever.core.documents import (
    LightDocumentError,
    document_bytes,
    validate_light_document,
)
from sciretriever.infrastructure.parsers.mineru import (
    MinerUArchiveAdapter,
    MinerUArchiveBounds,
    MinerUServiceBounds,
    OperatorManagedMinerUAdapter,
)
from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.model import documents as document_models
from sciretriever.model.assets import AssetPublication, PublishedArtifact, StagedArtifact
from sciretriever.model.canonical_json import CanonicalJsonInput, CanonicalJsonObject
from sciretriever.model.documents import (
    LightDocumentBounds,
    LightPublicationTarget,
)
from sciretriever.model.execution import (
    TargetProjection,
    TargetResult,
    ValidatedDocumentAcceptance,
)
from sciretriever.model.primitives import (
    BatchRunId,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.services.documents import DocumentServiceDependencies, LightDocumentService


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
        for module_name in (
            "sciretriever.content.api",
            "sciretriever.content.light_models",
            "sciretriever.content.light_document",
            "sciretriever.content.light_serialization",
            "sciretriever.content.light_service",
        ):
            self.assertIsNone(importlib.util.find_spec(module_name), module_name)

    def test_target_model_round_trip_keeps_nested_block_variants(self) -> None:
        document = validate_light_document(
            parsed_document(),
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
            parsed_document(),
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
            with self.subTest(name=name), self.assertRaises((LightDocumentError, ValidationError)):
                validate_light_document(
                    parsed_document(value), ASSET_ID, 2, manifest_blocks(), bounds
                )

    def test_publication_writes_canonical_artifact_before_acceptance(self) -> None:
        events: list[str] = []

        class Store:
            def __init__(self, root: Path) -> None:
                self._store = CoreArtifactStore(root)

            def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
                events.append("artifact")
                return self._store.publish(artifact)

        class Sink:
            command: ValidatedDocumentAcceptance | None = None

            def publish(self, acceptance: ValidatedDocumentAcceptance) -> AssetPublication | None:
                events.append("catalog")
                self.command = acceptance
                return None

        with TemporaryDirectory(prefix="sciretriever-light-") as directory:
            os.chmod(directory, 0o700)
            sink = Sink()
            target = LightPublicationTarget(
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000201"),
                primary_relation_id=WorkVersionAssetId("00000000-0000-0000-0000-000000000202"),
                primary_asset_id=ASSET_ID,
                primary_sha256=sha256_digest(pdf_bytes()),
            )
            parser = OperatorManagedMinerUAdapter(
                TaskBoundaryService("unused", "none"),
                MinerUArchiveAdapter(MinerUArchiveBounds()),
                MinerUServiceBounds(2),
            )
            projection = TargetProjection(
                batch_run_id=BatchRunId("00000000-0000-0000-0000-000000000203"),
                work_version_id=target.work_version_id,
                result=TargetResult(
                    subject_type="work-version",
                    subject_id=str(target.work_version_id),
                    outcome="partially-advanced",
                    initial_state="asset-ready",
                    target_state="light-text-ready",
                    final_state="light-text-ready",
                    stage="parsing",
                    failure=None,
                ),
                details=CanonicalJsonObject(()),
                failure_stages_to_clear=("parsing",),
            )
            result = LightDocumentService(
                DocumentServiceDependencies(parser, Store(Path(directory) / "storage"), sink)
            ).accept(target, parser_request(pdf_bytes()), projection)

            self.assertEqual(events, ["artifact", "catalog"])
            self.assertEqual(result.artifact.sha256, sha256_digest(document_bytes(result.document)))
            self.assertIsNotNone(sink.command)

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
                    parsed_document(value), ASSET_ID, 2, manifest_blocks(), LightDocumentBounds()
                )

    def test_repeated_locators_for_one_unique_block_remain_valid(self) -> None:
        value = document_value()
        title = value["title"]
        assert isinstance(title, dict)
        evidence = title["evidence"]
        assert isinstance(evidence, list)
        evidence.append(deepcopy(evidence[0]))

        document = validate_light_document(
            parsed_document(value), ASSET_ID, 2, manifest_blocks(), LightDocumentBounds()
        )

        assert document.title is not None
        self.assertEqual(len(document.title.evidence), 2)


if __name__ == "__main__":
    unittest.main()
