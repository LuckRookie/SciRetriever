from __future__ import annotations

import json
import zipfile
from io import BytesIO

from PyPDF2 import PdfWriter

from sciretriever.content.light_document import ManifestBlock
from sciretriever.kernel.json import CanonicalJsonInput
from sciretriever.model.parsing import ParserRequest, ParserTask, ParserTaskState
from sciretriever.model.primitives import AssetId, sha256_digest

ASSET_ID = AssetId("00000000-0000-0000-0000-000000000101")


def parser_request(pdf: bytes, resume_task_id: str | None = None) -> ParserRequest:
    return ParserRequest(
        pdf=pdf,
        asset_id=ASSET_ID,
        asset_sha256=sha256_digest(pdf),
        resume_task_id=resume_task_id,
    )


def manifest_blocks() -> tuple[ManifestBlock, ...]:
    return tuple(
        ManifestBlock(block_id, 1, length)
        for block_id, length in (
            ("b1", 5),
            ("b2", 4),
            ("b3", 1),
            ("b4", 1),
            ("b5", 6),
        )
    )


def pdf_bytes(pages: int = 2) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def document_value() -> dict[str, CanonicalJsonInput]:
    locator: dict[str, CanonicalJsonInput] = {
        "asset_id": str(ASSET_ID),
        "page_start": 1,
        "page_end": 1,
        "block_id": "b1",
        "char_start": 0,
        "char_end": 5,
    }
    evidence: list[CanonicalJsonInput] = [locator]
    return {
        "schema_version": "1",
        "title": {"text": "Title", "evidence": evidence},
        "abstract": [],
        "sections": [
            {
                "section_id": "s1",
                "level": 1,
                "title": None,
                "blocks": [
                    {"kind": "paragraph", "block_id": "b1", "text": "alpha", "evidence": evidence},
                    {
                        "kind": "list",
                        "block_id": "b2",
                        "ordered": False,
                        "items": [
                            {
                                "text": "item",
                                "evidence": [{**locator, "block_id": "b2", "char_end": 4}],
                            }
                        ],
                    },
                    {
                        "kind": "table",
                        "block_id": "b3",
                        "caption": None,
                        "columns": ["A"],
                        "rows": [["1"]],
                        "evidence": [{**locator, "block_id": "b3", "char_end": 1}],
                    },
                    {
                        "kind": "formula",
                        "block_id": "b4",
                        "text": "x",
                        "label": None,
                        "evidence": [{**locator, "block_id": "b4", "char_end": 1}],
                    },
                    {
                        "kind": "figure-caption",
                        "block_id": "b5",
                        "text": "figure",
                        "evidence": [{**locator, "block_id": "b5", "char_end": 6}],
                    },
                ],
                "children": [],
            }
        ],
        "references": [],
        "provenance": [],
    }


def archive_bytes(
    value: dict[str, CanonicalJsonInput] | None = None,
    middle_value: dict[str, CanonicalJsonInput] | None = None,
) -> bytes:
    output = BytesIO()
    content = document_value() if value is None else value
    middle = middle_value or {
        "_backend": "vlm",
        "pdf_info": [
            {"page_idx": 0, "blocks": {"b1": 5, "b2": 4, "b3": 1, "b4": 1, "b5": 6}},
            {"page_idx": 1, "blocks": {}},
        ],
    }
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("doc_middle.json", json.dumps(middle))
        archive.writestr("doc_model.json", '{"model":"fixture"}')
        archive.writestr("doc_content_list.json", json.dumps(content))
    return output.getvalue()


class TaskBoundaryService:
    def __init__(self, invalid_id: str, boundary: str) -> None:
        self.invalid_id = invalid_id
        self.boundary = boundary
        self.polls = 0

    def submit(self, pdf: bytes) -> str:
        return self.invalid_id if self.boundary == "submit" else "valid-task"

    def poll(self, task_id: str) -> ParserTask:
        self.polls += 1
        returned = self.invalid_id if self.boundary == "poll" else task_id
        return ParserTask(
            task_id=returned,
            state=ParserTaskState.COMPLETED,
            archive=archive_bytes(),
        )
