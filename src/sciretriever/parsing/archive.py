"""Fail-closed extraction of untrusted Parser ZIP archives.

Archives are expanded only into a fresh owner-only directory in the system
temporary area.  The returned object is a context manager; leaving the context
removes every private Parser file on both success and failure.
"""

from __future__ import annotations

import hashlib
import io
import os
import stat
import tempfile
import zipfile
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Final, Iterator, NoReturn

from sciretriever.model.primitives import Sha256
from sciretriever.parsing.markdown import MarkdownConversionError, canonical_resource_path
from sciretriever.parsing.ports import ParserArtifactContent

_READ_CHUNK_BYTES: Final[int] = 1024 * 1024
_TEMPORARY_PREFIX: Final[str] = "sciretriever-parsing-"
_SUPPORTED_COMPRESSION: Final[frozenset[int]] = frozenset(
    {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
)


class ParserArchiveError(ValueError):
    """Stable rejection that never exposes an archive member or machine path."""

    _CODES = frozenset(
        {
            "archive-invalid",
            "archive-budget",
            "archive-entry-invalid",
            "archive-duplicate",
            "archive-content-invalid",
            "archive-cleanup",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self._CODES:
            raise ValueError("unknown Parser archive error code")
        self.code = code
        super().__init__(f"parser archive rejected ({code})")

    def __repr__(self) -> str:
        return f"ParserArchiveError(code={self.code!r})"


def _fail(code: str) -> NoReturn:
    raise ParserArchiveError(code) from None


@dataclass(frozen=True, slots=True)
class ParserArchiveBounds:
    """Hard limits enforced before and during one ZIP extraction."""

    max_archive_bytes: int = 64 * 1024 * 1024
    max_file_count: int = 4096
    max_member_bytes: int = 32 * 1024 * 1024
    max_total_bytes: int = 128 * 1024 * 1024
    max_compression_ratio: int = 200

    def __post_init__(self) -> None:
        for value in (
            self.max_archive_bytes,
            self.max_file_count,
            self.max_member_bytes,
            self.max_total_bytes,
            self.max_compression_ratio,
        ):
            if type(value) is not int or value <= 0:
                raise ValueError("Parser archive bounds must be positive integers")


class _ArchiveMemberContent:
    __slots__ = ("_path", "_size")

    def __init__(self, path: Path, size: int) -> None:
        self._path = path
        self._size = size

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = -1
        try:
            descriptor = os.open(self._path, flags)
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) & 0o077
                or metadata.st_nlink != 1
                or metadata.st_size != self._size
            ):
                _fail("archive-content-invalid")
        except ParserArchiveError:
            if descriptor >= 0:
                os.close(descriptor)
            raise
        except OSError:
            if descriptor >= 0:
                os.close(descriptor)
            _fail("archive-content-invalid")

        stream = os.fdopen(descriptor, "rb", closefd=True)
        try:
            yield stream
        finally:
            stream.close()

    def __repr__(self) -> str:
        return "_ArchiveMemberContent(<private staging>)"


@dataclass(frozen=True, slots=True)
class ParserArchiveMember:
    """One safe regular member exposed through a path-free read capability."""

    reference: str
    sha256: Sha256
    byte_size: int
    content: ParserArtifactContent = field(repr=False)


class ExtractedParserArchive(AbstractContextManager["ExtractedParserArchive"]):
    """Short owner of all private files extracted for one Parser attempt."""

    __slots__ = ("_closed", "_temporary", "members")

    def __init__(
        self,
        temporary: tempfile.TemporaryDirectory[str],
        members: tuple[ParserArchiveMember, ...],
    ) -> None:
        self._temporary = temporary
        self._closed = False
        self.members = members

    def __enter__(self) -> "ExtractedParserArchive":
        if self._closed:
            _fail("archive-content-invalid")
        return self

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._temporary.cleanup()
        except Exception:
            _fail("archive-cleanup")

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: object | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self.close()

    def __repr__(self) -> str:
        return f"ExtractedParserArchive(members={len(self.members)}, closed={self._closed})"


def _checked_bounds(value: ParserArchiveBounds | None) -> ParserArchiveBounds:
    if value is None:
        return ParserArchiveBounds()
    if not isinstance(value, ParserArchiveBounds):
        raise TypeError("bounds must be ParserArchiveBounds")
    return value


def _cleanup(temporary: tempfile.TemporaryDirectory[str]) -> None:
    try:
        temporary.cleanup()
    except Exception:
        _fail("archive-cleanup")


def _secure_root(path: Path) -> None:
    try:
        os.chmod(path, 0o700, follow_symlinks=False)
        metadata = path.stat(follow_symlinks=False)
    except OSError:
        _fail("archive-invalid")
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        _fail("archive-invalid")


def _secure_parent(root: Path, parts: tuple[str, ...]) -> Path:
    current = root
    for part in parts:
        current = current / part
        try:
            current.mkdir(mode=0o700)
            os.chmod(current, 0o700, follow_symlinks=False)
        except FileExistsError:
            pass
        except OSError:
            _fail("archive-entry-invalid")
        try:
            metadata = current.stat(follow_symlinks=False)
        except OSError:
            _fail("archive-entry-invalid")
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            _fail("archive-entry-invalid")
    return current


def _entry_reference(info: zipfile.ZipInfo) -> str:
    if (
        not info.filename
        or info.is_dir()
        or info.flag_bits & 0x1
        or info.compress_type not in _SUPPORTED_COMPRESSION
        or info.file_size < 0
        or info.compress_size < 0
        or info.external_attr & 0x10
    ):
        _fail("archive-entry-invalid")
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(unix_mode)
    if file_type not in {0, stat.S_IFREG}:
        _fail("archive-entry-invalid")
    try:
        return canonical_resource_path(info.filename)
    except MarkdownConversionError:
        _fail("archive-entry-invalid")


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        try:
            written = os.write(descriptor, payload[offset:])
        except OSError:
            _fail("archive-invalid")
        if written <= 0:
            _fail("archive-invalid")
        offset += written


def _open_target(target: Path) -> int:
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(target, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        return descriptor
    except OSError:
        _fail("archive-invalid")


def _copy_archive_bytes(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    descriptor: int,
    bounds: ParserArchiveBounds,
    total_before: int,
) -> tuple[int, Sha256]:
    byte_size = 0
    digest = hashlib.sha256()
    try:
        with archive.open(info, "r") as source:
            while True:
                chunk = source.read(_READ_CHUNK_BYTES)
                if type(chunk) is not bytes:
                    _fail("archive-invalid")
                if not chunk:
                    break
                byte_size += len(chunk)
                if (
                    byte_size > info.file_size
                    or byte_size > bounds.max_member_bytes
                    or total_before + byte_size > bounds.max_total_bytes
                ):
                    _fail("archive-budget")
                digest.update(chunk)
                _write_all(descriptor, chunk)
    except ParserArchiveError:
        raise
    except Exception:
        _fail("archive-invalid")
    if byte_size != info.file_size:
        _fail("archive-invalid")
    return byte_size, Sha256(digest.hexdigest())


def _verify_target(target: Path, byte_size: int) -> None:
    try:
        metadata = target.stat(follow_symlinks=False)
    except OSError:
        _fail("archive-invalid")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
        or metadata.st_size != byte_size
    ):
        _fail("archive-invalid")


def _extract_member(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    reference: str,
    root: Path,
    bounds: ParserArchiveBounds,
    total_before: int,
) -> tuple[ParserArchiveMember, int]:
    parts = tuple(reference.split("/"))
    parent = _secure_parent(root, parts[:-1])
    target = parent / parts[-1]
    descriptor = _open_target(target)
    try:
        byte_size, digest = _copy_archive_bytes(
            archive,
            info,
            descriptor=descriptor,
            bounds=bounds,
            total_before=total_before,
        )
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
    _verify_target(target, byte_size)
    return (
        ParserArchiveMember(
            reference=reference,
            sha256=digest,
            byte_size=byte_size,
            content=_ArchiveMemberContent(target, byte_size),
        ),
        total_before + byte_size,
    )


def _validated_entries(
    archive: zipfile.ZipFile,
    bounds: ParserArchiveBounds,
) -> tuple[tuple[zipfile.ZipInfo, str], ...]:
    infos = archive.infolist()
    if not infos:
        _fail("archive-invalid")
    if len(infos) > bounds.max_file_count:
        _fail("archive-budget")

    validated: list[tuple[zipfile.ZipInfo, str]] = []
    seen: set[str] = set()
    declared_total = 0
    for info in infos:
        reference = _entry_reference(info)
        folded = reference.casefold()
        if folded in seen:
            _fail("archive-duplicate")
        seen.add(folded)
        if info.file_size > bounds.max_member_bytes:
            _fail("archive-budget")
        declared_total += info.file_size
        if declared_total > bounds.max_total_bytes:
            _fail("archive-budget")
        compressed = max(info.compress_size, 1)
        if info.file_size > bounds.max_compression_ratio * compressed:
            _fail("archive-budget")
        validated.append((info, reference))
    return tuple(validated)


def _extract_entries(
    archive: zipfile.ZipFile,
    entries: tuple[tuple[zipfile.ZipInfo, str], ...],
    *,
    root: Path,
    bounds: ParserArchiveBounds,
) -> tuple[ParserArchiveMember, ...]:
    members: list[ParserArchiveMember] = []
    extracted_total = 0
    for info, reference in entries:
        member, extracted_total = _extract_member(
            archive,
            info,
            reference=reference,
            root=root,
            bounds=bounds,
            total_before=extracted_total,
        )
        members.append(member)
    return tuple(sorted(members, key=lambda item: item.reference))


def extract_parser_archive(
    payload: bytes,
    *,
    bounds: ParserArchiveBounds | None = None,
) -> ExtractedParserArchive:
    """Extract one untrusted ZIP into a bounded owner-only temporary context."""

    checked = _checked_bounds(bounds)
    if type(payload) is not bytes or not payload:
        _fail("archive-invalid")
    if len(payload) > checked.max_archive_bytes:
        _fail("archive-budget")

    try:
        temporary = tempfile.TemporaryDirectory(prefix=_TEMPORARY_PREFIX)
    except Exception:
        _fail("archive-invalid")
    root = Path(temporary.name)
    try:
        _secure_root(root)
        with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
            entries = _validated_entries(archive, checked)
            members = _extract_entries(
                archive,
                entries,
                root=root,
                bounds=checked,
            )
    except ParserArchiveError:
        _cleanup(temporary)
        raise
    except Exception:
        _cleanup(temporary)
        _fail("archive-invalid")

    return ExtractedParserArchive(
        temporary,
        members,
    )


__all__ = (
    "ExtractedParserArchive",
    "ParserArchiveBounds",
    "ParserArchiveError",
    "ParserArchiveMember",
    "extract_parser_archive",
)
