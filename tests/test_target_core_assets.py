from __future__ import annotations

import unittest

from sciretriever.core import assets as core_assets
from sciretriever.core.assets import AssetRuleError, AssetValidationCode
from sciretriever.model.assets import (
    AcceptedContentReference,
    ContentAssetFailure,
    ContentAssetReplay,
)
from sciretriever.model.primitives import (
    AssetId,
    LightDocumentId,
    sha256_digest,
)
from tests.target_core_asset_support import UUID_B, pdf, target


class CoreAssetTests(unittest.TestCase):
    def test_policy_validation_rejects_empty_and_inconsistent_bounds(self) -> None:
        self.assertEqual(
            {code.value for code in AssetValidationCode},
            {
                "size-invalid",
                "media-type-invalid",
                "format-invalid",
                "parse-invalid",
                "not-primary",
                "identity-mismatch",
                "identity-unconfirmed",
            },
        )
        core_assets.validate_asset_policy(300, 1_000, 256)
        cases = (
            (0, 1_000, 256, "min_pdf_bytes", "must be positive"),
            (300, 0, 256, "max_asset_bytes", "must be positive"),
            (1_001, 1_000, 256, "max_asset_bytes", "must be at least min_pdf_bytes"),
            (300, 1_000, 0, "chunk_size", "must be positive"),
            (300, 1_000, 1_001, "chunk_size", "must not exceed max_asset_bytes"),
        )
        for min_bytes, max_bytes, chunk_size, field, expectation in cases:
            with self.subTest(field=field):
                with self.assertRaises(AssetRuleError) as raised:
                    core_assets.validate_asset_policy(min_bytes, max_bytes, chunk_size)
                self.assertEqual(raised.exception.field, field)
                self.assertEqual(raised.exception.expectation, expectation)

    def test_primary_current_decision_replays_only_an_asset_id(self) -> None:
        body = pdf()
        self.assertIsNone(core_assets.decide_primary_current(target()))
        replay = core_assets.decide_primary_current(
            target(
                current=AcceptedContentReference(
                    content_id=AssetId(UUID_B), sha256=sha256_digest(body), revision=1
                )
            )
        )
        invalid = core_assets.decide_primary_current(
            target(
                current=AcceptedContentReference(
                    content_id=LightDocumentId(UUID_B), sha256=sha256_digest(body), revision=1
                )
            )
        )
        self.assertIsInstance(replay, ContentAssetReplay)
        self.assertIsInstance(invalid, ContentAssetFailure)
        assert isinstance(invalid, ContentAssetFailure)
        self.assertEqual(invalid.code, "current-primary-invalid")


if __name__ == "__main__":
    unittest.main()
