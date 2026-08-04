from __future__ import annotations

import ast
import importlib
import unittest
from pathlib import Path

from pydantic import BaseModel

from sciretriever.core.assets import AssetRuleError, validate_supplementary_asset_acceptance
from sciretriever.core.documents import LightDocumentError, validate_light_document_acceptance
from sciretriever.model.assets import ArtifactKind, PublishedArtifact
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    LightDocumentId,
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)

ROOT = Path(__file__).parents[1]
EXECUTION_PATH = ROOT / "src" / "sciretriever" / "model" / "execution.py"


class TargetM1ExecutionClosureTests(unittest.TestCase):
    def test_execution_has_only_model_dependencies_and_canonical_names(self) -> None:
        source = EXECUTION_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported_modules = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module is not None
        }

        self.assertNotIn("sciretriever.content.publisher_contracts", imported_modules)
        self.assertNotIn("TYPE_CHECKING", source)
        self.assertNotIn("ContentAcceptance = object", source)

        execution = importlib.import_module("sciretriever.model.execution")
        for alias in ("ExecutionScope", "ExecutionResult", "ExecutionSummary", "ExecutionTarget"):
            self.assertNotIn(alias, execution.__dict__)
            self.assertNotIn(alias, execution.__all__)

    def test_acceptance_contracts_have_one_strict_frozen_model_owner(self) -> None:
        assets = importlib.import_module("sciretriever.model.assets")
        documents = importlib.import_module("sciretriever.model.documents")

        owners = (
            (assets, "PrimaryPdfAcceptance"),
            (assets, "SupplementaryAssetAcceptance"),
            (documents, "LightDocumentAcceptance"),
        )
        for owner, name in owners:
            contract = getattr(owner, name, None)
            self.assertIsNotNone(contract, name)
            assert contract is not None
            self.assertTrue(issubclass(contract, BaseModel), name)
            self.assertIs(contract.__module__, owner.__name__, name)
            self.assertTrue(contract.model_config["frozen"], name)
            self.assertTrue(contract.model_config["strict"], name)
            self.assertEqual(contract.model_config["extra"], "forbid", name)
            self.assertNotIn("__post_init__", contract.__dict__, name)
            self.assertNotIn("__str__", contract.__dict__, name)

    def test_business_invalid_acceptance_remains_representable_in_model(self) -> None:
        assets = importlib.import_module("sciretriever.model.assets")
        documents = importlib.import_module("sciretriever.model.documents")
        artifact = PublishedArtifact(
            kind=ArtifactKind.PRIMARY_PDF,
            path=RelativeArtifactPath("primary/aa/" + "a" * 64),
            sha256=sha256_digest(b"different"),
            size=1,
        )
        common = {
            "work_version_id": WorkVersionId("00000000-0000-0000-0000-000000000001"),
            "expected_metadata_id": MetadataSnapshotId("00000000-0000-0000-0000-000000000002"),
            "expected_metadata_revision": 1,
            "expected_metadata_sha256": Sha256("b" * 64),
            "artifact_id": AssetId("00000000-0000-0000-0000-000000000003"),
            "relation_id": WorkVersionAssetId("00000000-0000-0000-0000-000000000004"),
            "artifact": artifact,
            "source": CanonicalJsonObject(()),
        }

        primary = assets.PrimaryPdfAcceptance(**common)
        supplementary = assets.SupplementaryAssetAcceptance(
            **common,
            expected_primary_sha256=None,
            role=AssetRole.PRIMARY_PDF,
            media_type="application/pdf",
        )
        light = documents.LightDocumentAcceptance(
            work_version_id=common["work_version_id"],
            expected_primary_relation_id=common["relation_id"],
            expected_primary_sha256=artifact.sha256,
            document_id=LightDocumentId("00000000-0000-0000-0000-000000000005"),
            artifact_id=common["artifact_id"],
            artifact=artifact,
            document=CanonicalJsonObject((("payload", "raw"),)),
            provenance=CanonicalJsonObject(()),
        )

        self.assertEqual(primary.artifact.kind, ArtifactKind.PRIMARY_PDF)
        self.assertEqual(supplementary.role, AssetRole.PRIMARY_PDF)
        self.assertEqual(light.artifact.kind, ArtifactKind.PRIMARY_PDF)

        with self.assertRaises(AssetRuleError):
            validate_supplementary_asset_acceptance(supplementary)
        with self.assertRaises(LightDocumentError):
            validate_light_document_acceptance(light)


if __name__ == "__main__":
    unittest.main()
