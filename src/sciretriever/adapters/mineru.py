from __future__ import annotations

import json
import math
import posixpath
import re
import stat
import zipfile
from dataclasses import dataclass
from enum import Enum, unique
from io import BytesIO
from typing import Final, NewType, Protocol, assert_never

from PyPDF2 import PdfReader

from sciretriever.content.api import (
    LightDocumentBounds,
    LightDocumentError,
    LightDocumentV1,
    ManifestBlock,
    validate_light_document,
)
from sciretriever.kernel import AssetId, Sha256
from sciretriever.kernel.json import CanonicalJsonInput

MinerUTaskId = NewType("MinerUTaskId", str)
_MAX_TASK_ID_LENGTH: Final = 128
_TASK_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", re.ASCII)


def parse_mineru_task_id(value: str) -> MinerUTaskId:
    if (
        not isinstance(value, str)
        or len(value) > _MAX_TASK_ID_LENGTH
        or _TASK_ID_PATTERN.fullmatch(value) is None
    ):
        raise LightDocumentError("mineru-task-id")
    return MinerUTaskId(value)


@unique
class MinerUTaskState(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class MinerUTaskView:
    task_id: str
    state: MinerUTaskState
    archive: bytes | None


class MinerUServicePort(Protocol):
    def submit(self, pdf: bytes) -> str: ...
    def poll(self, task_id: str) -> MinerUTaskView: ...


@dataclass(frozen=True, slots=True)
class MinerUServiceBounds:
    max_polls: int = 120


class MinerUArchiveAdapter:
    def __init__(self, bounds: LightDocumentBounds) -> None:
        self._bounds = bounds

    def parse(
        self, archive_bytes: bytes, asset_id: AssetId, asset_sha256: Sha256, pdf_bytes: bytes
    ) -> LightDocumentV1:
        if Sha256.from_bytes(pdf_bytes) != asset_sha256 or not pdf_bytes.startswith(b"%PDF-"):
            raise LightDocumentError("primary-pdf-alignment")
        try:
            page_count = len(PdfReader(BytesIO(pdf_bytes), strict=True).pages)
        except (OSError, ValueError) as error:
            raise LightDocumentError("primary-pdf-invalid") from error
        payloads = self._archive(archive_bytes)
        middle = self._json(payloads["middle"])
        content = self._json(payloads["content"])
        block_manifest = self._manifest(middle, page_count)
        return validate_light_document(content, asset_id, page_count, block_manifest, self._bounds)

    def _archive(self, payload: bytes) -> dict[str, bytes]:  # noqa: C901
        if not payload or len(payload) > self._bounds.max_archive_bytes:
            raise LightDocumentError("archive-size")
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
                        raise LightDocumentError("archive-entry")
                    seen.add(normalized.casefold())
                    total += info.file_size
                    if total > self._bounds.max_extracted_bytes:
                        raise LightDocumentError("archive-extracted-size")
                    lower = normalized.lower()
                    if lower.endswith("_middle.json"):
                        key = "middle"
                    elif lower.endswith("_model.json"):
                        key = "model"
                    elif lower.endswith("_content_list.json"):
                        key = "content"
                    else:
                        raise LightDocumentError("archive-schema")
                    if key in found:
                        raise LightDocumentError("archive-duplicate-role")
                    found[key] = archive.read(info)
        except (OSError, RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
            raise LightDocumentError("archive-invalid") from error
        if set(found) != {"middle", "model", "content"}:
            raise LightDocumentError("archive-required-output")
        self._json(found["model"])
        return found

    def _json(self, payload: bytes) -> CanonicalJsonInput:
        if len(payload) > self._bounds.max_json_bytes:
            raise LightDocumentError("json-size")
        try:
            value = json.loads(
                payload, parse_constant=self._reject_constant, object_pairs_hook=self._unique_object
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
            raise LightDocumentError("json-invalid") from error
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
                raise LightDocumentError("json-depth")
            match current:
                case dict():
                    stack.extend((item, depth + 1) for item in current.values())
                case list():
                    stack.extend((item, depth + 1) for item in current)
                case float() if not math.isfinite(current):
                    raise LightDocumentError("json-number")
                case None | bool() | int() | float() | str():
                    continue
                case unreachable:
                    assert_never(unreachable)

    def _manifest(self, value: CanonicalJsonInput, pages: int) -> tuple[ManifestBlock, ...]:
        if (
            not isinstance(value, dict)
            or set(value) != {"_backend", "pdf_info"}
            or value["_backend"] != "vlm"
        ):
            raise LightDocumentError("middle-schema")
        raw_pages = value["pdf_info"]
        if not isinstance(raw_pages, list) or len(raw_pages) != pages:
            raise LightDocumentError("middle-pages")
        manifest: list[ManifestBlock] = []
        seen: set[str] = set()
        for index, page in enumerate(raw_pages):
            if (
                not isinstance(page, dict)
                or set(page) != {"page_idx", "blocks"}
                or page["page_idx"] != index
            ):
                raise LightDocumentError("middle-page-schema")
            blocks = page["blocks"]
            if not isinstance(blocks, dict):
                raise LightDocumentError("middle-blocks")
            for block_id, length in blocks.items():
                if (
                    not isinstance(block_id, str)
                    or block_id in seen
                    or not isinstance(length, int)
                    or isinstance(length, bool)
                    or length < 1
                ):
                    raise LightDocumentError("middle-block")
                seen.add(block_id)
                manifest.append(ManifestBlock(block_id, index + 1, length))
        if len(manifest) > self._bounds.max_blocks:
            raise LightDocumentError("middle-block-bound")
        return tuple(manifest)


@dataclass(frozen=True, slots=True)
class OperatorManagedMinerUAdapter:
    service: MinerUServicePort
    archive: MinerUArchiveAdapter
    bounds: MinerUServiceBounds

    def parse(
        self,
        pdf: bytes,
        asset_id: AssetId,
        asset_sha256: Sha256,
        *,
        resume_task_id: str | None = None,
    ) -> LightDocumentV1:
        raw_task_id = self.service.submit(pdf) if resume_task_id is None else resume_task_id
        task_id = parse_mineru_task_id(raw_task_id)
        for _ in range(self.bounds.max_polls):
            task = self.service.poll(str(task_id))
            returned_task_id = parse_mineru_task_id(task.task_id)
            if returned_task_id != task_id:
                raise LightDocumentError("mineru-task-id-mismatch")
            if task.state is MinerUTaskState.FAILED:
                raise LightDocumentError("mineru-task-failed")
            if task.state is MinerUTaskState.COMPLETED:
                if task.archive is None:
                    raise LightDocumentError("mineru-result-missing")
                return self.archive.parse(task.archive, asset_id, asset_sha256, pdf)
            if task.archive is not None:
                raise LightDocumentError("mineru-result-premature")
        raise LightDocumentError("mineru-poll-bound")


__all__ = (
    "MinerUArchiveAdapter",
    "MinerUServiceBounds",
    "MinerUServicePort",
    "MinerUTaskId",
    "MinerUTaskState",
    "MinerUTaskView",
    "OperatorManagedMinerUAdapter",
    "parse_mineru_task_id",
)
