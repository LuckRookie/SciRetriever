from __future__ import annotations

import json
import math
import posixpath
import stat
import zipfile
from dataclasses import dataclass
from io import BytesIO
from typing import assert_never

from pydantic import ValidationError
from PyPDF2 import PdfReader

import sciretriever.model.parsing as parsing_models
from sciretriever.model.canonical_json import CanonicalJsonInput
from sciretriever.model.documents import LightDocumentV1
from sciretriever.services.documents.ports import ParserFailure


@dataclass(frozen=True, slots=True)
class MinerUArchiveBounds:
    max_archive_bytes: int = 64 * 1024 * 1024
    max_member_bytes: int = 32 * 1024 * 1024
    max_extracted_bytes: int = 128 * 1024 * 1024
    max_json_bytes: int = 32 * 1024 * 1024
    max_json_depth: int = 64
    max_blocks: int = 100_000

    def __post_init__(self) -> None:
        values = (
            self.max_archive_bytes,
            self.max_member_bytes,
            self.max_extracted_bytes,
            self.max_json_bytes,
            self.max_json_depth,
            self.max_blocks,
        )
        if any(
            not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in values
        ):
            raise ParserFailure("mineru-bounds-invalid")


@dataclass(frozen=True, slots=True)
class MinerUArchiveResult:
    document: LightDocumentV1
    pdf_pages: int
    block_manifest: tuple[parsing_models.ManifestBlock, ...]


class MinerUArchiveAdapter:
    def __init__(self, bounds: MinerUArchiveBounds) -> None:
        self._bounds = bounds

    def parse(self, archive_bytes: bytes, pdf_bytes: bytes) -> MinerUArchiveResult:
        if not pdf_bytes.startswith(b"%PDF-"):
            raise ParserFailure("primary-pdf-invalid")
        try:
            page_count = len(PdfReader(BytesIO(pdf_bytes), strict=True).pages)
        except (OSError, ValueError) as error:
            raise ParserFailure("primary-pdf-invalid") from error
        payloads = self._archive(archive_bytes)
        middle = self._json(payloads["middle"])
        self._json(payloads["content"])
        block_manifest = self._manifest(middle, page_count)
        try:
            document = LightDocumentV1.model_validate_json(payloads["content"])
        except (ValidationError, ValueError) as error:
            raise ParserFailure("document-schema") from error
        return MinerUArchiveResult(document, page_count, block_manifest)

    def _archive(self, payload: bytes) -> dict[str, bytes]:  # noqa: C901
        if not payload or len(payload) > self._bounds.max_archive_bytes:
            raise ParserFailure("archive-size")
        found: dict[str, bytes] = {}
        seen: set[str] = set()
        total = 0
        try:
            with zipfile.ZipFile(BytesIO(payload)) as archive:
                for info in archive.infolist():
                    name = info.filename
                    normalized = posixpath.normpath(name)
                    mode = info.external_attr >> 16
                    if (
                        not name
                        or "\x00" in name
                        or "\\" in name
                        or name.startswith("/")
                        or normalized != name
                        or normalized.startswith("../")
                        or normalized.casefold() in seen
                        or info.is_dir()
                        or stat.S_IFMT(mode) not in {0, stat.S_IFREG}
                        or info.file_size > self._bounds.max_member_bytes
                    ):
                        raise ParserFailure("archive-entry")
                    seen.add(normalized.casefold())
                    total += info.file_size
                    if total > self._bounds.max_extracted_bytes:
                        raise ParserFailure("archive-extracted-size")
                    lower = normalized.lower()
                    if lower.endswith("_middle.json"):
                        key = "middle"
                    elif lower.endswith("_model.json"):
                        key = "model"
                    elif lower.endswith("_content_list.json"):
                        key = "content"
                    else:
                        raise ParserFailure("archive-schema")
                    if key in found:
                        raise ParserFailure("archive-duplicate-role")
                    found[key] = archive.read(info)
        except (OSError, RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
            raise ParserFailure("archive-invalid") from error
        if set(found) != {"middle", "model", "content"}:
            raise ParserFailure("archive-required-output")
        self._json(found["model"])
        return found

    def _json(self, payload: bytes) -> CanonicalJsonInput:
        if len(payload) > self._bounds.max_json_bytes:
            raise ParserFailure("json-size")
        try:
            value = json.loads(
                payload, parse_constant=self._reject_constant, object_pairs_hook=self._unique_object
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
            raise ParserFailure("json-invalid") from error
        self._json_depth(value)
        return value

    @staticmethod
    def _reject_constant(value: str) -> float:
        raise ValueError(value)

    @staticmethod
    def _unique_object(
        pairs: list[tuple[str, CanonicalJsonInput]],
    ) -> dict[str, CanonicalJsonInput]:
        result: dict[str, CanonicalJsonInput] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(key)
            result[key] = value
        return result

    def _json_depth(self, value: CanonicalJsonInput) -> None:
        stack = [(value, 1)]
        while stack:
            current, depth = stack.pop()
            if depth > self._bounds.max_json_depth:
                raise ParserFailure("json-depth")
            match current:
                case dict():
                    stack.extend((item, depth + 1) for item in current.values())
                case list():
                    stack.extend((item, depth + 1) for item in current)
                case float() if not math.isfinite(current):
                    raise ParserFailure("json-number")
                case None | bool() | int() | float() | str():
                    continue
                case unreachable:
                    assert_never(unreachable)

    def _manifest(
        self, value: CanonicalJsonInput, pages: int
    ) -> tuple[parsing_models.ManifestBlock, ...]:
        if (
            not isinstance(value, dict)
            or set(value) != {"_backend", "pdf_info"}
            or value["_backend"] != "vlm"
        ):
            raise ParserFailure("middle-schema")
        raw_pages = value["pdf_info"]
        if not isinstance(raw_pages, list) or len(raw_pages) != pages:
            raise ParserFailure("middle-pages")
        manifest: list[parsing_models.ManifestBlock] = []
        seen: set[str] = set()
        for index, page in enumerate(raw_pages):
            if (
                not isinstance(page, dict)
                or set(page) != {"page_idx", "blocks"}
                or page["page_idx"] != index
            ):
                raise ParserFailure("middle-page-schema")
            blocks = page["blocks"]
            if not isinstance(blocks, dict):
                raise ParserFailure("middle-blocks")
            for block_id, length in blocks.items():
                if (
                    not isinstance(block_id, str)
                    or block_id in seen
                    or not isinstance(length, int)
                    or isinstance(length, bool)
                    or length < 1
                ):
                    raise ParserFailure("middle-block")
                seen.add(block_id)
                manifest.append(
                    parsing_models.ManifestBlock(
                        block_id=block_id,
                        page_number=index + 1,
                        char_length=length,
                    )
                )
        if len(manifest) > self._bounds.max_blocks:
            raise ParserFailure("middle-block-bound")
        return tuple(manifest)


__all__ = ("MinerUArchiveAdapter", "MinerUArchiveBounds", "MinerUArchiveResult")
