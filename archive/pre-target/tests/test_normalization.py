import hashlib
from pathlib import Path
import sys
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.derivation import canonical_json_bytes
from sciretriever.core.enums import AssetRole
from sciretriever.normalization import RawNormalizationInput, normalize_inputs


def raw(role: AssetRole, media_type: str, payload: bytes) -> RawNormalizationInput:
    return RawNormalizationInput(str(uuid4()), role, media_type, hashlib.sha256(payload).hexdigest(), payload)


class NormalizationTests(TestCase):
    def test_xml_and_html_are_deterministic_and_format_independent(self) -> None:
        xml = raw(AssetRole.XML, "application/xml", b"<article><title>Title</title><p>Body</p><ref>doi:10.1000/test PMID: 42</ref></article>")
        html = raw(AssetRole.HTML, "text/html", b"<html><body><h1>Heading</h1><p>More text</p><script>hidden</script></body></html>")
        first = normalize_inputs((html, xml))
        second = normalize_inputs((xml, html))
        self.assertEqual(first, second)
        self.assertEqual(canonical_json_bytes(first.content.to_dict()), canonical_json_bytes(second.content.to_dict()))
        self.assertIn("Body", "".join(section.text for section in first.content.sections))
        self.assertNotIn("hidden", "".join(section.text for section in first.content.sections))
        self.assertEqual({identifier.namespace for identifier in first.content.references[0].identifiers}, {"doi", "pmid"})
        self.assertEqual(len(first.evidence), sum(bool(section.text) for section in first.content.sections) + len(first.content.references))

    def test_line_endings_and_unicode_are_canonical(self) -> None:
        xml = raw(AssetRole.XML, "application/xml", "<a><p>Cafe\u0301\r\nnext</p></a>".encode())
        content = normalize_inputs((xml,)).content
        self.assertEqual(content.sections[0].text, "Caf\u00e9\nnext")

    def test_xml_and_html_tables_preserve_generic_structure_and_evidence(self) -> None:
        xml = raw(
            AssetRole.XML,
            "application/xml",
            b"<article><table-wrap><caption><title>Values</title></caption>"
            b"<table><tr><th>Key</th><td rowspan='2'>A<b>B</b></td></tr>"
            b"<tr><td>Second</td></tr></table><table-wrap-foot><p>Note</p>"
            b"</table-wrap-foot></table-wrap></article>",
        )
        html = raw(
            AssetRole.HTML,
            "text/html",
            b"<html><body><table><caption>Other</caption><tr><th>H<td>C"
            b"</table></body></html>",
        )
        draft = normalize_inputs((xml, html))
        self.assertEqual(len(draft.content.tables), 2)
        captions = {table.caption for table in draft.content.tables}
        self.assertEqual(captions, {"Values", "Other"})
        xml_table = next(table for table in draft.content.tables if table.caption == "Values")
        self.assertEqual(xml_table.notes, "Note")
        self.assertEqual(
            [(cell.row_index, cell.column_index, cell.text) for cell in xml_table.cells],
            [(0, 0, "Key"), (0, 1, "AB"), (1, 0, "Second")],
        )
        self.assertTrue(xml_table.cells[0].is_header)
        self.assertEqual(xml_table.cells[1].row_span, 2)
        self.assertFalse(any(section.text in {"Values", "Key", "A", "B", "Second", "Note"} for section in draft.content.sections))
        xml_table_index = draft.content.tables.index(xml_table)
        table_paths = {item.normalized_path for item in draft.evidence if "/tables/" in item.normalized_path}
        self.assertIn(f"/tables/{xml_table_index}/caption", table_paths)
        self.assertIn(f"/tables/{xml_table_index}/cells/1/text", table_paths)
        self.assertIn(f"/tables/{xml_table_index}/notes", table_paths)


if __name__ == "__main__":
    import unittest
    unittest.main()
