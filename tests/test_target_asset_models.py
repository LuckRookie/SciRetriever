from __future__ import annotations

import ast
import importlib
import unittest
from pathlib import Path

from pydantic import BaseModel, ValidationError

from sciretriever.model.access import BoundedByteStream, Header
from sciretriever.model.assets import (
    AcceptedCandidate,
    AcceptedContentReference,
    AcceptedPrimaryPdf,
    ArtifactKind,
    AssetCandidate,
    CandidateEvidence,
    ContentAssetFailure,
    ContentAssetReplay,
    ContentAssetResult,
    ContentAssetSuccess,
    PublishedArtifact,
    StagedArtifact,
)
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    RelativeArtifactPath,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)


class TargetAssetModelTests(unittest.TestCase):
    def test_asset_contracts_have_one_strict_model_owner(self) -> None:
        asset_models = importlib.import_module("sciretriever.model.assets")
        legacy_modules = tuple(
            importlib.import_module(module_name)
            for module_name in (
                "sciretriever.content.api",
                "sciretriever.content.model",
                "sciretriever.content.ports",
                "sciretriever.content.light_service",
            )
        )
        model_names = {
            "AssetCandidate",
            "AcceptedContentReference",
            "AcceptedPrimaryPdf",
            "AcceptedCandidate",
            "StagedArtifact",
            "PublishedArtifact",
            "CandidateEvidence",
            "ContentAssetFailure",
            "ContentAssetReplay",
            "ContentAssetSuccess",
        }
        enum_names = {"ArtifactKind"}
        legacy_path = Path(__file__).parents[1] / "src" / "sciretriever" / "content" / "model.py"
        legacy_tree = ast.parse(legacy_path.read_text(encoding="utf-8"))
        legacy_definitions = {
            node.name for node in ast.walk(legacy_tree) if isinstance(node, ast.ClassDef)
        }

        self.assertEqual(legacy_definitions & model_names, set())
        for name in model_names:
            contract = getattr(asset_models, name)
            self.assertTrue(issubclass(contract, BaseModel))
            self.assertEqual(contract.__module__, asset_models.__name__)
            self.assertTrue(contract.model_config["frozen"])
            self.assertTrue(contract.model_config["strict"])
            self.assertEqual(contract.model_config["extra"], "forbid")
            for legacy_module in legacy_modules:
                self.assertNotIn(name, legacy_module.__dict__)
                self.assertNotIn(name, getattr(legacy_module, "__all__", ()))
        for name in enum_names:
            self.assertEqual(getattr(asset_models, name).__module__, asset_models.__name__)
            for legacy_module in legacy_modules:
                self.assertNotIn(name, legacy_module.__dict__)
                self.assertNotIn(name, getattr(legacy_module, "__all__", ()))

    def test_asset_contracts_round_trip_without_mutation(self) -> None:
        candidate = AssetCandidate(
            provider="fixture",
            role=AssetRole.PRIMARY_PDF,
            locator="https://source.invalid/article.pdf",
            headers=(Header(name="Authorization", value="secret"),),
        )
        accepted = AcceptedPrimaryPdf(
            asset_id=AssetId("00000000-0000-0000-0000-000000000001"),
            work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000002"),
            sha256=sha256_digest(b"pdf"),
            media_type="application/pdf",
        )
        relation = AcceptedContentReference(
            content_id=accepted.asset_id,
            sha256=accepted.sha256,
            revision=1,
        )
        evidence = CandidateEvidence(provider="fixture", outcome="accepted")
        failure = ContentAssetFailure(code="candidate-failed", evidence=(evidence,))
        replay = ContentAssetReplay(asset_id=accepted.asset_id, sha256=accepted.sha256)
        success = ContentAssetSuccess(
            asset_id=accepted.asset_id,
            relation_id=WorkVersionAssetId("00000000-0000-0000-0000-000000000003"),
            sha256=accepted.sha256,
            provider="fixture",
            role=AssetRole.PRIMARY_PDF,
            evidence=(),
        )
        acquired = AcceptedCandidate(
            candidate=candidate,
            content=BoundedByteStream(
                chunks=(b"pdf",),
                media_type="application/pdf",
                final_locator="https://source.invalid/article.pdf",
                size=3,
            ),
        )
        staged = StagedArtifact(
            kind=ArtifactKind.PRIMARY_PDF,
            path=RelativeArtifactPath("staged"),
            sha256=sha256_digest(b"pdf"),
            content=b"pdf",
        )
        published = PublishedArtifact(
            kind=staged.kind,
            path=RelativeArtifactPath("primary/aa/" + "a" * 64),
            sha256=staged.sha256,
            size=len(staged.content),
        )

        self.assertEqual(AssetCandidate.model_validate_json(candidate.model_dump_json()), candidate)
        self.assertEqual(
            AcceptedPrimaryPdf.model_validate_json(accepted.model_dump_json()), accepted
        )
        self.assertEqual(
            AcceptedContentReference.model_validate_json(relation.model_dump_json()), relation
        )
        self.assertEqual(StagedArtifact.model_validate_json(staged.model_dump_json()), staged)
        self.assertEqual(
            PublishedArtifact.model_validate_json(published.model_dump_json()), published
        )
        self.assertEqual(
            CandidateEvidence.model_validate_json(evidence.model_dump_json()), evidence
        )
        self.assertEqual(
            ContentAssetFailure.model_validate_json(failure.model_dump_json()), failure
        )
        self.assertEqual(ContentAssetReplay.model_validate_json(replay.model_dump_json()), replay)
        self.assertEqual(
            ContentAssetSuccess.model_validate_json(success.model_dump_json()), success
        )
        self.assertEqual(
            AcceptedCandidate.model_validate_json(acquired.model_dump_json()), acquired
        )
        self.assertEqual(
            ContentAssetResult,
            ContentAssetFailure | ContentAssetReplay | ContentAssetSuccess,
        )
        with self.assertRaises((TypeError, ValidationError)):
            setattr(candidate, "provider", "changed")
        self.assertNotIn("secret", repr(candidate))

    def test_asset_contracts_reject_malformed_structure_without_business_decisions(self) -> None:
        with self.assertRaises(ValidationError):
            AssetCandidate.model_validate(
                {
                    "provider": 1,
                    "role": AssetRole.PRIMARY_PDF,
                    "locator": "locator",
                    "headers": (),
                }
            )
        with self.assertRaises(ValidationError):
            AssetCandidate.model_validate(
                {
                    "provider": "fixture",
                    "role": AssetRole.PRIMARY_PDF,
                    "locator": "locator",
                    "headers": (),
                    "unexpected": True,
                }
            )
        mismatched = StagedArtifact(
            kind=ArtifactKind.PRIMARY_PDF,
            path=RelativeArtifactPath("staged"),
            sha256=sha256_digest(b"different"),
            content=b"content",
        )
        self.assertNotEqual(mismatched.sha256, sha256_digest(mismatched.content))


if __name__ == "__main__":
    unittest.main()
