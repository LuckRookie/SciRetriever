"""Fail-closed admission for untrusted MinerU result archives."""

from __future__ import annotations

import hashlib
from io import BytesIO
import json
import math
import posixpath
import stat
import struct
import zipfile
import zlib

from sciretriever.config import MinerUConfig
from sciretriever.errors import MinerUError, MinerUErrorCategory

from .mineru_contracts import MinerUArchiveEntry, ValidatedMinerUArchive


_JSON_SUFFIXES = ("_middle.json", "_model.json", "_content_list.json")
_IMAGE_EXTENSIONS = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
_COMPRESSIONS = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
_JPEG_SOF_MARKERS = frozenset({
    0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
    0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
})


def _reject(message: str) -> MinerUError:
    return MinerUError(MinerUErrorCategory.ARCHIVE_REJECTED, message)


def _positive_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise _reject("MinerU archive contains an invalid image")


def _validate_png(payload: bytes) -> None:
    if len(payload) < 45 or not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise _reject("MinerU archive contains a malformed PNG image")
    offset = 8
    chunks = 0
    saw_header = False
    saw_end = False
    while offset < len(payload):
        if len(payload) - offset < 12:
            raise _reject("MinerU archive contains a malformed PNG image")
        length = struct.unpack(">I", payload[offset:offset + 4])[0]
        kind = payload[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(payload):
            raise _reject("MinerU archive contains a malformed PNG image")
        data = payload[offset + 8:offset + 8 + length]
        expected_crc = struct.unpack(">I", payload[offset + 8 + length:end])[0]
        if zlib.crc32(kind + data) & 0xFFFFFFFF != expected_crc:
            raise _reject("MinerU archive contains a malformed PNG image")
        chunks += 1
        if chunks == 1:
            if kind != b"IHDR" or length != 13:
                raise _reject("MinerU archive contains a malformed PNG image")
            _positive_dimensions(*struct.unpack(">II", data[:8]))
            saw_header = True
        elif kind == b"IHDR":
            raise _reject("MinerU archive contains a malformed PNG image")
        if kind == b"IEND":
            if length != 0 or end != len(payload):
                raise _reject("MinerU archive contains a malformed PNG image")
            saw_end = True
            break
        offset = end
    if not saw_header or not saw_end:
        raise _reject("MinerU archive contains a malformed PNG image")


def _validate_jpeg(payload: bytes) -> None:
    if len(payload) < 14 or not payload.startswith(b"\xff\xd8"):
        raise _reject("MinerU archive contains a malformed JPEG image")
    offset = 2
    saw_frame = False
    saw_scan = False
    while offset < len(payload):
        if payload[offset] != 0xFF:
            if not saw_scan:
                raise _reject("MinerU archive contains a malformed JPEG image")
            offset += 1
            continue
        while offset < len(payload) and payload[offset] == 0xFF:
            offset += 1
        if offset >= len(payload):
            raise _reject("MinerU archive contains a malformed JPEG image")
        marker = payload[offset]
        offset += 1
        if marker == 0x00 or 0xD0 <= marker <= 0xD7:
            if not saw_scan:
                raise _reject("MinerU archive contains a malformed JPEG image")
            continue
        if marker == 0xD9:
            if offset != len(payload) or not saw_frame or not saw_scan:
                raise _reject("MinerU archive contains a malformed JPEG image")
            return
        if marker in {0xD8, 0x01}:
            raise _reject("MinerU archive contains a malformed JPEG image")
        if offset + 2 > len(payload):
            raise _reject("MinerU archive contains a malformed JPEG image")
        length = struct.unpack(">H", payload[offset:offset + 2])[0]
        if length < 2 or offset + length > len(payload):
            raise _reject("MinerU archive contains a malformed JPEG image")
        segment = payload[offset + 2:offset + length]
        if marker in _JPEG_SOF_MARKERS:
            if len(segment) < 6:
                raise _reject("MinerU archive contains a malformed JPEG image")
            height, width = struct.unpack(">HH", segment[1:5])
            _positive_dimensions(width, height)
            saw_frame = True
        elif marker == 0xDA:
            saw_scan = True
        offset += length
    raise _reject("MinerU archive contains a malformed JPEG image")


def _validate_webp(payload: bytes) -> None:
    if (
        len(payload) < 20 or payload[:4] != b"RIFF" or payload[8:12] != b"WEBP"
        or struct.unpack("<I", payload[4:8])[0] + 8 != len(payload)
    ):
        raise _reject("MinerU archive contains a malformed WebP image")
    offset = 12
    dimensions: tuple[int, int] | None = None
    while offset < len(payload):
        if offset + 8 > len(payload):
            raise _reject("MinerU archive contains a malformed WebP image")
        kind = payload[offset:offset + 4]
        length = struct.unpack("<I", payload[offset + 4:offset + 8])[0]
        start = offset + 8
        end = start + length
        padded_end = end + (length & 1)
        if end > len(payload) or padded_end > len(payload):
            raise _reject("MinerU archive contains a malformed WebP image")
        data = payload[start:end]
        if kind == b"VP8X":
            if len(data) < 10:
                raise _reject("MinerU archive contains a malformed WebP image")
            dimensions = (
                int.from_bytes(data[4:7], "little") + 1,
                int.from_bytes(data[7:10], "little") + 1,
            )
        elif kind == b"VP8L":
            if len(data) < 5 or data[0] != 0x2F:
                raise _reject("MinerU archive contains a malformed WebP image")
            bits = int.from_bytes(data[1:5], "little")
            dimensions = ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        elif kind == b"VP8 ":
            if len(data) < 10 or data[3:6] != b"\x9d\x01\x2a":
                raise _reject("MinerU archive contains a malformed WebP image")
            width, height = struct.unpack("<HH", data[6:10])
            dimensions = (width & 0x3FFF, height & 0x3FFF)
        offset = padded_end
    if offset != len(payload) or dimensions is None:
        raise _reject("MinerU archive contains a malformed WebP image")
    _positive_dimensions(*dimensions)


def _validate_image(payload: bytes, media_type: str) -> None:
    if media_type == "image/png":
        _validate_png(payload)
    elif media_type == "image/jpeg":
        _validate_jpeg(payload)
    elif media_type == "image/webp":
        _validate_webp(payload)
    else:
        raise _reject("MinerU archive contains an unsupported image type")


def _walk_json(value: object, config: MinerUConfig) -> None:
    elements = 0
    strings = 0
    blocks = 0
    pages: set[int] = set()
    stack: list[tuple[object, int]] = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        if depth > config.max_json_depth:
            raise _reject("MinerU JSON exceeds depth bound")
        elements += 1
        if elements > config.max_json_elements:
            raise _reject("MinerU JSON exceeds element bound")
        if isinstance(current, str):
            strings += len(current)
            if strings > config.max_json_string_characters:
                raise _reject("MinerU JSON exceeds string bound")
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, dict):
            blocks += 1
            if blocks > config.max_blocks:
                raise _reject("MinerU JSON exceeds block bound")
            for page_key in ("page_idx", "page_no", "page_id"):
                page = current.get(page_key)
                if isinstance(page, int) and not isinstance(page, bool):
                    pages.add(page)
                    if len(pages) > config.max_pages:
                        raise _reject("MinerU JSON exceeds page bound")
            for key, item in current.items():
                if not isinstance(key, str):
                    raise _reject("MinerU JSON contains a non-string key")
                strings += len(key)
                if strings > config.max_json_string_characters:
                    raise _reject("MinerU JSON exceeds string bound")
                stack.append((item, depth + 1))
    if strings > config.max_text_characters:
        raise _reject("MinerU JSON exceeds text bound")


def _json_payload(payload: bytes, config: MinerUConfig) -> object:
    if len(payload) > config.max_json_bytes:
        raise _reject("MinerU JSON exceeds byte bound")
    try:
        def object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
            result: dict[str, object] = {}
            for key, item in pairs:
                if key in result:
                    raise ValueError("duplicate JSON key")
                result[key] = item
            return result

        def reject_constant(_: str) -> object:
            raise ValueError("non-finite JSON number")

        def finite_float(value: str) -> float:
            parsed = float(value)
            if not math.isfinite(parsed):
                raise ValueError("non-finite JSON number")
            return parsed

        value = json.loads(
            payload, object_pairs_hook=object_pairs, parse_constant=reject_constant,
            parse_float=finite_float,
        )
    except (RecursionError, UnicodeDecodeError, ValueError) as error:
        raise _reject("MinerU archive contains invalid JSON") from error
    _walk_json(value, config)
    return value


def _number(value: object) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise _reject("MinerU middle JSON contains invalid geometry")
    number = float(value)
    if not math.isfinite(number):
        raise _reject("MinerU middle JSON contains invalid geometry")
    return number


def _bbox(value: object, width: float, height: float) -> None:
    if not isinstance(value, list) or len(value) != 4:
        raise _reject("MinerU middle JSON contains invalid bbox")
    left, top, right, bottom = (_number(item) for item in value)
    if left < 0 or top < 0 or right <= left or bottom <= top or right > width or bottom > height:
        raise _reject("MinerU middle JSON contains out-of-page bbox")


def _image_reference(value: object, available: set[str]) -> None:
    if value in {None, ""}:
        return
    if not isinstance(value, str):
        raise _reject("MinerU middle JSON contains invalid image reference")
    if (
        "\x00" in value or "\\" in value or value.startswith("/")
        or posixpath.normpath(value) != value or value.startswith("../")
        or value.casefold() not in available
    ):
        raise _reject("MinerU middle JSON references a missing or unsafe image")


def _validate_middle(value: object, config: MinerUConfig, image_paths: set[str]) -> None:
    if not isinstance(value, dict) or value.get("_backend") != "vlm":
        raise _reject("MinerU middle JSON is not a VLM document")
    pages = value.get("pdf_info")
    if not isinstance(pages, list) or not pages or len(pages) > config.max_pages:
        raise _reject("MinerU middle JSON has an invalid page collection")
    blocks = 0
    spans = 0
    for expected_index, page in enumerate(pages):
        if not isinstance(page, dict) or page.get("page_idx") != expected_index:
            raise _reject("MinerU middle JSON has an invalid page index")
        page_size = page.get("page_size")
        if not isinstance(page_size, list) or len(page_size) != 2:
            raise _reject("MinerU middle JSON has an invalid page size")
        width, height = (_number(item) for item in page_size)
        if width <= 0 or height <= 0:
            raise _reject("MinerU middle JSON has an invalid page size")
        para_blocks = page.get("para_blocks")
        discarded_blocks = page.get("discarded_blocks")
        if not isinstance(para_blocks, list) or not isinstance(discarded_blocks, list):
            raise _reject("MinerU middle JSON has invalid page blocks")
        stack = [*reversed(discarded_blocks), *reversed(para_blocks)]
        while stack:
            block = stack.pop()
            if not isinstance(block, dict):
                raise _reject("MinerU middle JSON contains an invalid block")
            blocks += 1
            if blocks > config.max_blocks:
                raise _reject("MinerU middle JSON exceeds block bound")
            _bbox(block.get("bbox"), width, height)
            nested = block.get("blocks", [])
            lines = block.get("lines", [])
            if not isinstance(nested, list) or not isinstance(lines, list):
                raise _reject("MinerU middle JSON contains invalid block children")
            stack.extend(reversed(nested))
            for line in lines:
                if not isinstance(line, dict):
                    raise _reject("MinerU middle JSON contains an invalid line")
                _bbox(line.get("bbox"), width, height)
                line_spans = line.get("spans")
                if not isinstance(line_spans, list):
                    raise _reject("MinerU middle JSON contains invalid spans")
                for span in line_spans:
                    if not isinstance(span, dict):
                        raise _reject("MinerU middle JSON contains an invalid span")
                    spans += 1
                    if spans > config.max_spans:
                        raise _reject("MinerU middle JSON exceeds span bound")
                    _bbox(span.get("bbox"), width, height)
                    _image_reference(span.get("image_path"), image_paths)


def admit_mineru_archive(payload: bytes, config: MinerUConfig) -> ValidatedMinerUArchive:
    if not payload or len(payload) > config.max_archive_bytes:
        raise _reject("MinerU archive exceeds byte bound")
    entries: list[MinerUArchiveEntry] = []
    seen: set[str] = set()
    total = 0
    images = 0
    image_bytes = 0
    json_values: dict[str, object] = {}
    try:
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            infos = archive.infolist()
            if not infos or len(infos) > config.max_archive_files:
                raise _reject("MinerU archive file count is invalid")
            for info in infos:
                name = info.filename
                first_part = name.split("/", 1)[0]
                if not name or "\x00" in name or "\\" in name or ":" in first_part or name.startswith("/") or posixpath.normpath(name) != name or name.startswith("../"):
                    raise _reject("MinerU archive contains an unsafe path")
                folded = name.casefold()
                if folded in seen:
                    raise _reject("MinerU archive contains duplicate paths")
                seen.add(folded)
                mode = info.external_attr >> 16
                kind = stat.S_IFMT(mode)
                is_directory = info.is_dir()
                if is_directory:
                    if info.file_size or info.compress_size:
                        raise _reject("MinerU archive directory contains payload")
                    continue
                if kind not in {0, stat.S_IFREG}:
                    raise _reject("MinerU archive contains a special entry")
                if info.flag_bits & 1:
                    raise _reject("MinerU archive contains an encrypted entry")
                if info.compress_type not in _COMPRESSIONS:
                    raise _reject("MinerU archive uses unsupported compression")
                if info.file_size > config.max_file_bytes:
                    raise _reject("MinerU archive entry exceeds byte bound")
                ratio = info.file_size / max(info.compress_size, 1)
                if ratio > config.max_compression_ratio:
                    raise _reject("MinerU archive exceeds compression ratio bound")
                total += info.file_size
                if total > config.max_extracted_bytes:
                    raise _reject("MinerU archive exceeds extracted byte bound")
                lower = name.lower()
                media_type: str
                if lower.endswith(_JSON_SUFFIXES):
                    media_type = "application/json"
                elif "/images/" in lower:
                    extension = posixpath.splitext(lower)[1]
                    if extension not in _IMAGE_EXTENSIONS:
                        raise _reject("MinerU archive contains an unsupported image type")
                    images += 1
                    image_bytes += info.file_size
                    if images > config.max_images or image_bytes > config.max_image_bytes:
                        raise _reject("MinerU archive exceeds image bounds")
                    media_type = _IMAGE_EXTENSIONS[extension]
                else:
                    raise _reject("MinerU archive contains an unexpected file type")
                try:
                    data = archive.read(info)
                except (OSError, RuntimeError, zipfile.BadZipFile) as error:
                    raise _reject("MinerU archive entry failed integrity validation") from error
                if len(data) != info.file_size:
                    raise _reject("MinerU archive entry size mismatch")
                if media_type == "application/json":
                    value = _json_payload(data, config)
                    json_values[name] = value
                    if lower.endswith("_content_list.json"):
                        if not isinstance(value, list):
                            raise _reject("MinerU content list must be a JSON array")
                    elif not isinstance(value, dict):
                        raise _reject("MinerU middle and model outputs must be JSON objects")
                else:
                    _validate_image(data, media_type)
                entries.append(MinerUArchiveEntry(name, media_type, hashlib.sha256(data).hexdigest(), data))
    except MinerUError:
        raise
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        raise _reject("MinerU result is not a valid ZIP archive") from error

    def exactly_one(suffix: str) -> MinerUArchiveEntry:
        matches = [entry for entry in entries if entry.path.lower().endswith(suffix)]
        if len(matches) != 1:
            raise _reject(f"MinerU archive requires exactly one {suffix}")
        return matches[0]

    middle = exactly_one("_middle.json")
    model = exactly_one("_model.json")
    content = exactly_one("_content_list.json")
    suffixes = ("_middle.json", "_model.json", "_content_list.json")
    primary_entries = (middle, model, content)
    stems = {
        entry.path[: -len(suffix)]
        for entry, suffix in zip(primary_entries, suffixes, strict=True)
    }
    if len(stems) != 1:
        raise _reject("MinerU archive primary outputs do not share one document stem")
    parent = posixpath.dirname(stems.pop())
    image_prefix = f"{parent}/images/" if parent else "images/"
    if any(entry not in primary_entries and not entry.path.startswith(image_prefix) for entry in entries):
        raise _reject("MinerU archive members do not share one document root")
    relative_images = {
        entry.path[len(parent) + 1:].casefold() if parent else entry.path.casefold()
        for entry in entries if entry not in primary_entries
    }
    _validate_middle(json_values[middle.path], config, relative_images)
    primary = {middle.path, model.path, content.path}
    return ValidatedMinerUArchive(middle, model, content, tuple(entry for entry in entries if entry.path not in primary))


__all__ = ("admit_mineru_archive",)
