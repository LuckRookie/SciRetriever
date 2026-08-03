from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.model.assets import ArtifactKind, StagedArtifact
from sciretriever.model.primitives import RelativeArtifactPath, sha256_digest


class TargetRawAssetContentAddressingTests(unittest.TestCase):
    def test_identical_raw_bytes_share_one_path_across_asset_roles(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-raw-addressing-") as temporary:
            root = Path(temporary)
            os.chmod(root, 0o700)
            store = CoreArtifactStore(root / "storage")
            content = b"%PDF-1.7\nshared bytes\n%%EOF"
            digest = sha256_digest(content)
            primary = store.publish(
                StagedArtifact(
                    kind=ArtifactKind.PRIMARY_PDF,
                    path=RelativeArtifactPath("staged"),
                    sha256=digest,
                    content=content,
                )
            )
            supplementary = store.publish(
                StagedArtifact(
                    kind=ArtifactKind.SUPPLEMENTARY,
                    path=RelativeArtifactPath("staged"),
                    sha256=digest,
                    content=content,
                )
            )

            self.assertEqual(primary.path, supplementary.path)
            self.assertEqual(str(primary.path), f"raw/{str(digest)[:2]}/{digest}")
            self.assertEqual(
                tuple((root / "storage" / "core" / "raw").rglob(str(digest))),
                (root / "storage" / "core" / "raw" / str(digest)[:2] / str(digest),),
            )


if __name__ == "__main__":
    unittest.main()
