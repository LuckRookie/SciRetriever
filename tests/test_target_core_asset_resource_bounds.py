from __future__ import annotations

import unittest
from unittest.mock import patch

from sciretriever.core import assets as core_assets
from sciretriever.model.primitives import AssetRole
from tests.target_core_asset_support import pdf, stream, target


class _FakeMetadata(dict[str, str]):
    @property
    def title(self) -> str:
        return self["/Title"]

    @property
    def author(self) -> str:
        return self["/Author"]


class _FakePage:
    def __init__(self) -> None:
        self.extract_count = 0

    def extract_text(self) -> str:
        self.extract_count += 1
        return "Article body"


class _FakeReader:
    def __init__(self, pages: tuple[_FakePage, ...]) -> None:
        self.pages = pages
        self.metadata = _FakeMetadata(
            {
                "/Title": "Exact Article Title",
                "/Author": "Ada Lovelace",
                "/CreationDate": "D:20240101",
            }
        )
        self.is_encrypted = False


class CoreAssetResourceBoundTests(unittest.TestCase):
    def test_pdf_identity_inspection_reads_at_most_five_pages(self) -> None:
        pages = tuple(_FakePage() for _ in range(6))
        reader = _FakeReader(pages)

        with patch("sciretriever.core.assets.acceptance.PdfReader", return_value=reader):
            failure = core_assets.validate_asset(
                stream(pdf(), "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                min_pdf_bytes=300,
                max_asset_bytes=100_000,
            )

        self.assertIsNone(failure)
        self.assertEqual([page.extract_count for page in pages], [1, 1, 1, 1, 1, 0])


if __name__ == "__main__":
    unittest.main()
