from __future__ import annotations

import unittest

from sciretriever.core import assets as core_assets
from sciretriever.core.assets import AssetRuleError
from sciretriever.model.assets import ArtifactKind, PublishedArtifact
from sciretriever.model.primitives import (
    AssetRole,
    MetadataSnapshotId,
    RelativeArtifactPath,
    WorkVersionId,
    sha256_digest,
)
from tests.target_core_asset_support import (
    artifact,
    pdf,
    primary_acceptance,
    supplementary_acceptance,
    target,
)


class CoreAssetPublicationTests(unittest.TestCase):
    def test_publication_validates_hash_path_kind_role_and_target_alignment(self) -> None:
        content_target = target()
        primary_body = pdf()
        supplementary_body = b"xml"
        core_assets.validate_content_acceptance(
            primary_acceptance(content_target, primary_body), content_target
        )
        core_assets.validate_content_acceptance(
            supplementary_acceptance(content_target, supplementary_body), content_target
        )
        primary = primary_acceptance(content_target, primary_body)
        supplementary = supplementary_acceptance(content_target, supplementary_body)
        wrong_artifact_kind = primary.model_copy(
            update={"artifact": artifact(ArtifactKind.SUPPLEMENTARY, primary_body)}
        )
        wrong_artifact_path = primary.model_copy(
            update={
                "artifact": primary.artifact.model_copy(
                    update={"path": RelativeArtifactPath("primary/ff/" + "f" * 64)}
                )
            }
        )
        wrong_artifact_hash = primary.model_copy(
            update={
                "artifact": PublishedArtifact(
                    kind=ArtifactKind.PRIMARY_PDF,
                    path=primary.artifact.path,
                    sha256=sha256_digest(b"different"),
                    size=primary.artifact.size,
                )
            }
        )
        wrong_artifact_size = primary.model_copy(
            update={"artifact": primary.artifact.model_copy(update={"size": 0})}
        )
        wrong_work_version = primary.model_copy(
            update={"work_version_id": WorkVersionId("00000000-0000-0000-0000-000000000003")}
        )
        wrong_metadata = primary.model_copy(
            update={
                "expected_metadata_id": MetadataSnapshotId("00000000-0000-0000-0000-000000000003")
            }
        )
        wrong_role = supplementary.model_copy(update={"role": AssetRole.PRIMARY_PDF})
        wrong_primary = supplementary.model_copy(
            update={"expected_primary_sha256": sha256_digest(b"different-primary")}
        )
        for value in (
            wrong_artifact_kind,
            wrong_artifact_path,
            wrong_artifact_hash,
            wrong_artifact_size,
            wrong_work_version,
            wrong_metadata,
            wrong_role,
            wrong_primary,
        ):
            with self.subTest(value=value):
                with self.assertRaises(AssetRuleError):
                    core_assets.validate_content_acceptance(value, content_target)


if __name__ == "__main__":
    unittest.main()
