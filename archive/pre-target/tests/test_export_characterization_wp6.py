from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest

from sciretriever.cli.library import _atomic_write, _render
from sciretriever.catalog.library_projection import LibraryItem, LibraryResult
from sciretriever.core.contracts import Identifier


class ExistingExportCharacterizationTests(unittest.TestCase):
    def test_existing_reading_projection_is_canonical_and_secret_free(self) -> None:
        # Given
        item = LibraryItem(
            work_id="00000000-0000-0000-0000-000000000001",
            work_version_id="00000000-0000-0000-0000-000000000002",
            preferred_work_version_id="00000000-0000-0000-0000-000000000002",
            is_preferred=True,
            version_class="formal_publication",
            title="Canonical title",
            abstract=None,
            language="en",
            work_type="article",
            publication_date="2026-07-26",
            publication_year=2026,
            publisher=None,
            venue=None,
            volume=None,
            issue=None,
            pages=None,
            article_number=None,
            open_access_status=None,
            identifiers=(Identifier("doi", "10.1000/example"),),
            authors=("Ada Lovelace",),
            tags=("battery",),
            light_content=("Safe light content",),
        )

        # When
        result = LibraryResult((item,))
        first = _render(result, "json")
        second = _render(result, "json")

        # Then
        self.assertEqual(first, second)
        expected_row = (
            '{"abstract":null,"article_number":null,"authors":["Ada Lovelace"],'
            '"identifiers":[{"namespace":"doi","value":"10.1000/example"}],'
            '"is_preferred":true,"language":"en","light_content":["Safe light content"],'
            '"open_access_status":null,"pages":null,'
            '"preferred_work_version_id":"00000000-0000-0000-0000-000000000002",'
            '"publication_date":"2026-07-26","publication_year":2026,"publisher":null,'
            '"tags":["battery"],"title":"Canonical title","venue":null,'
            '"version_class":"formal_publication","volume":null,'
            '"work_id":"00000000-0000-0000-0000-000000000001","work_type":"article",'
            '"work_version_id":"00000000-0000-0000-0000-000000000002"}'
        )
        self.assertEqual(first.encode("ascii"), f"[{expected_row}]\n".encode("ascii"))
        self.assertEqual(_render(result, "jsonl").encode("ascii"), f"{expected_row}\n".encode("ascii"))
        self.assertEqual(json.loads(first)[0]["work_version_id"], item.work_version_id)
        self.assertNotIn("provider_record_id", first)
        self.assertNotIn("provenance", first)
        self.assertNotIn("raw_reference", first)

    def test_existing_writer_rejects_catalog_aliases_and_sidecars(self) -> None:
        # Given
        with tempfile.TemporaryDirectory(prefix="sciretriever-export-characterization-") as raw:
            root = Path(raw)
            catalog = root / "catalog.sqlite"
            catalog.write_bytes(b"catalog")
            symlink = root / "catalog-symlink"
            symlink.symlink_to(catalog)
            hardlink = root / "catalog-hardlink"
            os.link(catalog, hardlink)
            destinations = (
                catalog,
                Path(f"{catalog}-wal"),
                Path(f"{catalog}-shm"),
                Path(f"{catalog}-journal"),
                symlink,
                hardlink,
            )

            # When / Then
            for destination in destinations:
                with self.subTest(destination=destination):
                    with self.assertRaisesRegex(ValueError, "catalog storage"):
                        _atomic_write(destination, "{}\n", catalog)
            self.assertEqual(tuple(root.glob(".*.tmp")), ())


if __name__ == "__main__":
    unittest.main()
