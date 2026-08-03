from __future__ import annotations

import ast
import os
import unittest
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

from sciretriever.adapters.mineru import (
    MinerUServiceBounds,
    OperatorManagedMinerUAdapter,
)
from sciretriever.adapters.mineru_archive import MinerUArchiveAdapter, MinerUArchiveBounds
from sciretriever.core.documents import (
    LightDocumentError,
    document_bytes,
    validate_light_document,
)
from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.model.assets import AssetPublication, PublishedArtifact, StagedArtifact
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.documents import (
    LightDocumentAcceptance,
    LightDocumentBounds,
    LightPublicationTarget,
)
from sciretriever.model.execution import ContentAcceptanceCommand, TargetProjection, TargetResult
from sciretriever.model.parsing import ManifestBlock, ParserRequest, ParserResult
from sciretriever.model.primitives import (
    BatchRunId,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.services.documents import DocumentServiceDependencies, LightDocumentService


class M5DocumentsTargetTests(unittest.TestCase):
    def test_documents_layers_keep_typed_dependency_direction(self) -> None:
        root = Path(__file__).parents[1] / "src" / "sciretriever"

        def imports(path: Path) -> set[str]:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            modules = {
                node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
            }
            modules.update(
                alias.name
                for node in ast.walk(tree)
                if isinstance(node, ast.Import)
                for alias in node.names
            )
            return modules

        service_imports = imports(root / "services" / "documents" / "api.py")
        adapter_imports = imports(root / "adapters" / "mineru.py") | imports(
            root / "adapters" / "mineru_archive.py"
        )
        core_source = "".join(
            path.read_text(encoding="utf-8")
            for path in sorted((root / "core" / "documents").glob("*.py"))
        )

        self.assertFalse(any(name.startswith("sciretriever.kernel") for name in service_imports))
        self.assertFalse(any(name.startswith("sciretriever.core") for name in adapter_imports))
        self.assertNotIn("CanonicalJsonInput", core_source)
        self.assertTrue(issubclass(LightDocumentBounds, BaseModel))
        self.assertTrue(issubclass(ManifestBlock, BaseModel))

    def test_core_validation_round_trip_and_bounds_are_target_owned(self) -> None:
        document = validate_light_document(
            parsed_document(), ASSET_ID, 2, manifest_blocks(), LightDocumentBounds()
        )

        parsed = type(document).model_validate_json(document.model_dump_json())

        self.assertEqual(parsed, document)
        self.assertEqual(document_bytes(parsed), document_bytes(document))
        with self.assertRaises(LightDocumentError):
            validate_light_document(
                parsed_document(), ASSET_ID, 2, manifest_blocks(), LightDocumentBounds(max_blocks=1)
            )
        invalid_locator = document_value()
        title = invalid_locator["title"]
        assert isinstance(title, dict)
        evidence = title["evidence"]
        assert isinstance(evidence, list)
        locator = evidence[0]
        assert isinstance(locator, dict)
        locator["char_end"] = locator["char_start"]
        with self.assertRaises(ValidationError):
            parsed_document(invalid_locator)

    def test_parser_failure_does_not_publish_file_or_catalog(self) -> None:
        class FailingParser:
            def parse(self, request: ParserRequest) -> ParserResult:
                del request
                raise LightDocumentError("parser-failed")

        class Store:
            def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
                del artifact
                raise AssertionError("store must not be called")

        class Publisher:
            def publish(self, command: ContentAcceptanceCommand) -> AssetPublication | None:
                del command
                raise AssertionError("publisher must not be called")

        pdf = pdf_bytes()
        target = self._target(pdf)
        with self.assertRaises(LightDocumentError):
            LightDocumentService(
                DocumentServiceDependencies(FailingParser(), Store(), Publisher())
            ).accept(target, parser_request(pdf), self._projection())

    def test_successful_parser_publishes_before_catalog_and_aligns_primary(self) -> None:
        events: list[str] = []

        class Store:
            def __init__(self, root: Path) -> None:
                self._store = CoreArtifactStore(root)

            def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
                events.append("artifact")
                return self._store.publish(artifact)

        class Publisher:
            def __init__(self) -> None:
                self.command: ContentAcceptanceCommand | None = None

            def publish(self, command: ContentAcceptanceCommand) -> AssetPublication | None:
                events.append("catalog")
                self.command = command
                return None

        pdf = pdf_bytes()
        parser = OperatorManagedMinerUAdapter(
            TaskBoundaryService("unused", "none"),
            MinerUArchiveAdapter(MinerUArchiveBounds()),
            MinerUServiceBounds(max_polls=2),
        )
        publisher = Publisher()
        with TemporaryDirectory(prefix="sciretriever-m5-target-") as directory:
            os.chmod(directory, 0o700)
            result = LightDocumentService(
                DocumentServiceDependencies(parser, Store(Path(directory) / "storage"), publisher)
            ).accept(self._target(pdf), parser_request(pdf), self._projection())

        self.assertEqual(events, ["artifact", "catalog"])
        self.assertEqual(result.artifact.sha256, sha256_digest(document_bytes(result.document)))
        self.assertIsNotNone(publisher.command)
        assert publisher.command is not None
        acceptance = publisher.command.acceptance
        self.assertIsInstance(acceptance, LightDocumentAcceptance)
        assert isinstance(acceptance, LightDocumentAcceptance)
        self.assertEqual(acceptance.expected_primary_sha256, sha256_digest(pdf))

    @staticmethod
    def _target(pdf: bytes) -> LightPublicationTarget:
        return LightPublicationTarget(
            work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000201"),
            primary_relation_id=WorkVersionAssetId("00000000-0000-0000-0000-000000000202"),
            primary_asset_id=ASSET_ID,
            primary_sha256=sha256_digest(pdf),
        )

    @staticmethod
    def _projection() -> TargetProjection:
        work_version_id = WorkVersionId("00000000-0000-0000-0000-000000000201")
        return TargetProjection(
            batch_run_id=BatchRunId("00000000-0000-0000-0000-000000000203"),
            work_version_id=work_version_id,
            result=TargetResult(
                subject_type="work-version",
                subject_id=str(work_version_id),
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


if __name__ == "__main__":
    unittest.main()
