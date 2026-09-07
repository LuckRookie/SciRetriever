"""Protocol-independent, bounded validation for candidate primary PDFs.

This module owns only the file-fact gate.  It copies candidate bytes into a
private staging object before asking the standard PDF reader to inspect them.
It deliberately does not inspect bibliographic fields or document content,
and it does not trust a filename or declared media type.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from contextlib import AbstractContextManager
from enum import Enum, unique
from typing import BinaryIO, Callable, Final, Protocol, TypeAlias, cast

from PyPDF2 import PdfReader

from sciretriever.acquisition.ports import (
    PdfValidationStage,
    PdfValidationStagingPort,
)
from sciretriever.model.access import BoundedByteStream
from sciretriever.model.primitives import Sha256

DEFAULT_MAX_PDF_BYTES: Final[int] = 512 * 1024 * 1024
_COPY_CHUNK_BYTES: Final[int] = 1024 * 1024
_SNIFF_BYTES: Final[int] = 1024
_PDF_HEADER = re.compile(rb"%PDF-[0-9]\.[0-9]")


class CancellationEvent(Protocol):
    """The small cancellation surface used at synchronous validation gates."""

    def is_set(self) -> bool: ...


class ReadablePdfSource(Protocol):
    """A binary source that honours a bounded read request."""

    def read(self, size: int = -1, /) -> bytes: ...


PdfByteSource: TypeAlias = bytes | BoundedByteStream | ReadablePdfSource | Iterable[bytes]


@unique
class PdfValidationCode(str, Enum):
    """Stable, non-sensitive identifiers for expected PDF rejections."""

    BYTE_BUDGET_EXCEEDED = "byte-budget-exceeded"
    EMPTY = "empty"
    ENCRYPTED = "encrypted"
    INVALID_BUDGET = "invalid-budget"
    NOT_PDF = "not-pdf"
    NO_PAGES = "no-pages"
    PAGE_TREE_ERROR = "page-tree-error"
    READER_ERROR = "reader-error"
    RESULT_CLOSED = "result-closed"
    SOURCE_ERROR = "source-error"


_VALIDATION_MESSAGES: Final[dict[PdfValidationCode, str]] = {
    PdfValidationCode.BYTE_BUDGET_EXCEEDED: "PDF byte budget exceeded",
    PdfValidationCode.EMPTY: "PDF bytes are empty",
    PdfValidationCode.ENCRYPTED: "PDF requires an unavailable password",
    PdfValidationCode.INVALID_BUDGET: "PDF byte budget is invalid",
    PdfValidationCode.NOT_PDF: "PDF byte signature is missing",
    PdfValidationCode.NO_PAGES: "PDF page tree has no pages",
    PdfValidationCode.PAGE_TREE_ERROR: "PDF page tree is unreadable",
    PdfValidationCode.READER_ERROR: "PDF reader could not open the bytes",
    PdfValidationCode.RESULT_CLOSED: "validated PDF is closed",
    PdfValidationCode.SOURCE_ERROR: "PDF byte source could not be read",
}
_CANDIDATE_REJECTION_CODES: Final[frozenset[PdfValidationCode]] = frozenset(
    {
        PdfValidationCode.BYTE_BUDGET_EXCEEDED,
        PdfValidationCode.EMPTY,
        PdfValidationCode.ENCRYPTED,
        PdfValidationCode.NOT_PDF,
        PdfValidationCode.NO_PAGES,
        PdfValidationCode.PAGE_TREE_ERROR,
        PdfValidationCode.READER_ERROR,
    }
)


class PdfValidationError(ValueError):
    """A stable and path-free failure at the validation boundary."""

    __slots__ = ("code",)

    def __init__(self, code: PdfValidationCode) -> None:
        if not isinstance(code, PdfValidationCode):
            code = PdfValidationCode.SOURCE_ERROR
        self.code = code
        super().__init__(_VALIDATION_MESSAGES[code])

    @property
    def is_candidate_rejection(self) -> bool:
        """Whether acquisition may treat this as a normal invalid candidate."""

        return self.code in _CANDIDATE_REJECTION_CODES


class PdfValidationCancelled(RuntimeError):
    """Cancellation observed at a validation boundary."""

    def __init__(self) -> None:
        super().__init__("PDF validation cancelled")


class PdfValidationStagingError(RuntimeError):
    """The private staging boundary could not be used or safely cleaned."""

    def __init__(self) -> None:
        super().__init__("PDF validation staging failed")


def _cancel_if_requested(cancel_event: CancellationEvent | None) -> None:
    if cancel_event is None:
        return
    try:
        cancelled = cancel_event.is_set()
    except Exception:
        raise PdfValidationCancelled() from None
    if cancelled:
        raise PdfValidationCancelled()


class ValidatedPdf:
    """A checked owner-only PDF stage whose caller controls a short lifetime.

    The value contains no path or provider object.  A publication adapter can
    read it through :meth:`open`, using ``sha256`` and ``byte_size`` as the
    expected immutable identity.  Closing or leaving a context always removes
    the stage and its private temporary root.
    """

    __slots__ = (
        "_byte_size",
        "_closed",
        "_sha256",
        "_stage",
    )

    def __init__(
        self,
        stage: PdfValidationStage,
        *,
        sha256: Sha256,
        byte_size: int,
    ) -> None:
        self._stage = stage
        self._sha256 = sha256
        self._byte_size = byte_size
        self._closed = False

    @property
    def sha256(self) -> Sha256:
        return self._sha256

    @property
    def byte_size(self) -> int:
        return self._byte_size

    @property
    def media_type(self) -> str:
        return "application/pdf"

    @property
    def closed(self) -> bool:
        return self._closed

    def open(self) -> AbstractContextManager[BinaryIO]:
        """Open a bounded-lifetime binary view without exposing a path."""

        if self._closed:
            raise PdfValidationError(PdfValidationCode.RESULT_CLOSED)
        try:
            return self._stage.open()
        except Exception:
            raise PdfValidationStagingError() from None

    def close(self) -> None:
        """Idempotently remove the staged file and its private root."""

        if self._closed:
            return
        self._closed = True
        cleanup_failed = False
        try:
            self._stage.close()
        except Exception:
            cleanup_failed = True
        if cleanup_failed:
            raise PdfValidationStagingError() from None

    def discard(self) -> None:
        """Alias used by temporary-content adapters for explicit rejection."""

        self.close()

    def __enter__(self) -> ValidatedPdf:
        if self._closed:
            raise PdfValidationError(PdfValidationCode.RESULT_CLOSED)
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        if exc_type is None:
            self.close()
        else:
            try:
                self.close()
            except PdfValidationStagingError:
                pass
        return False

    def __repr__(self) -> str:
        return (
            "ValidatedPdf("
            f"sha256={self._sha256.root!r}, byte_size={self._byte_size}, "
            f"media_type={self.media_type!r}, closed={self._closed})"
        )

    def __del__(self) -> None:  # pragma: no cover - deterministic contexts are the contract.
        try:
            self.close()
        except Exception:
            pass


def _write_chunk(
    stage: PdfValidationStage,
    chunk: object,
    *,
    total: int,
    max_bytes: int,
    digest: hashlib._Hash,
    sniff: bytearray,
    cancel_event: CancellationEvent | None,
) -> int:
    _cancel_if_requested(cancel_event)
    if not isinstance(chunk, bytes):
        raise PdfValidationError(PdfValidationCode.SOURCE_ERROR)
    next_total = total + len(chunk)
    if next_total > max_bytes:
        raise PdfValidationError(PdfValidationCode.BYTE_BUDGET_EXCEEDED)
    if not chunk:
        return total
    try:
        written = stage.write(chunk)
        if written != len(chunk):
            raise PdfValidationStagingError()
    except Exception:
        raise PdfValidationStagingError() from None
    digest.update(chunk)
    if len(sniff) < _SNIFF_BYTES:
        sniff.extend(chunk[: _SNIFF_BYTES - len(sniff)])
    _cancel_if_requested(cancel_event)
    return next_total


def _copy_readable(
    stage: PdfValidationStage,
    read: Callable[[int], object],
    *,
    max_bytes: int,
    digest: hashlib._Hash,
    sniff: bytearray,
    cancel_event: CancellationEvent | None,
) -> int:
    total = 0
    while True:
        _cancel_if_requested(cancel_event)
        request_size = min(_COPY_CHUNK_BYTES, max_bytes - total + 1)
        try:
            chunk = read(request_size)
        except (PdfValidationCancelled, PdfValidationError):
            raise
        except Exception:
            _cancel_if_requested(cancel_event)
            raise PdfValidationError(PdfValidationCode.SOURCE_ERROR) from None
        _cancel_if_requested(cancel_event)
        if chunk == b"":
            return total
        total = _write_chunk(
            stage,
            chunk,
            total=total,
            max_bytes=max_bytes,
            digest=digest,
            sniff=sniff,
            cancel_event=cancel_event,
        )


def _copy_iterable(
    stage: PdfValidationStage,
    source: Iterable[object],
    *,
    max_bytes: int,
    digest: hashlib._Hash,
    sniff: bytearray,
    cancel_event: CancellationEvent | None,
) -> int:
    total = 0
    try:
        iterator = iter(source)
        while True:
            _cancel_if_requested(cancel_event)
            try:
                chunk = next(iterator)
            except StopIteration:
                return total
            total = _write_chunk(
                stage,
                chunk,
                total=total,
                max_bytes=max_bytes,
                digest=digest,
                sniff=sniff,
                cancel_event=cancel_event,
            )
    except (PdfValidationCancelled, PdfValidationError, PdfValidationStagingError):
        raise
    except Exception:
        _cancel_if_requested(cancel_event)
        raise PdfValidationError(PdfValidationCode.SOURCE_ERROR) from None


def _copy_to_stage(
    stage: PdfValidationStage,
    source: object,
    *,
    max_bytes: int,
    digest: hashlib._Hash,
    sniff: bytearray,
    cancel_event: CancellationEvent | None,
) -> int:
    if isinstance(source, bytes):
        return _write_chunk(
            stage,
            source,
            total=0,
            max_bytes=max_bytes,
            digest=digest,
            sniff=sniff,
            cancel_event=cancel_event,
        )
    if isinstance(source, BoundedByteStream):
        return _copy_iterable(
            stage,
            source.chunks,
            max_bytes=max_bytes,
            digest=digest,
            sniff=sniff,
            cancel_event=cancel_event,
        )
    read = getattr(source, "read", None)
    if callable(read):
        return _copy_readable(
            stage,
            cast(Callable[[int], object], read),
            max_bytes=max_bytes,
            digest=digest,
            sniff=sniff,
            cancel_event=cancel_event,
        )
    if isinstance(source, Iterable):
        return _copy_iterable(
            stage,
            cast(Iterable[object], source),
            max_bytes=max_bytes,
            digest=digest,
            sniff=sniff,
            cancel_event=cancel_event,
        )
    raise PdfValidationError(PdfValidationCode.SOURCE_ERROR)


def _validate_signature(sniff: bytes, byte_size: int) -> None:
    if byte_size == 0:
        raise PdfValidationError(PdfValidationCode.EMPTY)
    if _PDF_HEADER.search(sniff) is None:
        raise PdfValidationError(PdfValidationCode.NOT_PDF)


def _open_reader(stream: BinaryIO, cancel_event: CancellationEvent | None) -> PdfReader:
    _cancel_if_requested(cancel_event)
    try:
        reader = PdfReader(stream, strict=False)
    except MemoryError:
        raise
    except Exception:
        _cancel_if_requested(cancel_event)
        raise PdfValidationError(PdfValidationCode.READER_ERROR) from None
    _cancel_if_requested(cancel_event)
    return reader


def _unlock_if_possible(reader: PdfReader, cancel_event: CancellationEvent | None) -> None:
    try:
        encrypted = reader.is_encrypted
    except MemoryError:
        raise
    except Exception:
        _cancel_if_requested(cancel_event)
        raise PdfValidationError(PdfValidationCode.READER_ERROR) from None
    _cancel_if_requested(cancel_event)
    if not encrypted:
        return
    try:
        password_type = reader.decrypt("")
    except MemoryError:
        raise
    except Exception:
        _cancel_if_requested(cancel_event)
        raise PdfValidationError(PdfValidationCode.ENCRYPTED) from None
    _cancel_if_requested(cancel_event)
    try:
        unlocked = int(password_type) != 0
    except (TypeError, ValueError, OverflowError):
        raise PdfValidationError(PdfValidationCode.ENCRYPTED) from None
    if not unlocked:
        raise PdfValidationError(PdfValidationCode.ENCRYPTED)


def _validate_page_tree(reader: PdfReader, cancel_event: CancellationEvent | None) -> None:
    _cancel_if_requested(cancel_event)
    try:
        pages = reader.pages
        page_count = len(pages)
    except MemoryError:
        raise
    except Exception:
        _cancel_if_requested(cancel_event)
        raise PdfValidationError(PdfValidationCode.PAGE_TREE_ERROR) from None
    _cancel_if_requested(cancel_event)
    if page_count == 0:
        raise PdfValidationError(PdfValidationCode.NO_PAGES)
    try:
        pages[0]
    except MemoryError:
        raise
    except Exception:
        _cancel_if_requested(cancel_event)
        raise PdfValidationError(PdfValidationCode.PAGE_TREE_ERROR) from None
    _cancel_if_requested(cancel_event)


def _validate_staged_reader(
    stage: PdfValidationStage,
    cancel_event: CancellationEvent | None,
) -> None:
    try:
        context = stage.open()
        with context as stream:
            reader = _open_reader(stream, cancel_event)
            _unlock_if_possible(reader, cancel_event)
            _validate_page_tree(reader, cancel_event)
    except (MemoryError, PdfValidationCancelled, PdfValidationError):
        raise
    except Exception:
        raise PdfValidationStagingError() from None


def _cleanup_failed_stage(
    stage: PdfValidationStage | None,
) -> None:
    cleanup_failed = False
    if stage is not None:
        try:
            stage.close()
        except Exception:
            cleanup_failed = True
    if cleanup_failed:
        raise PdfValidationStagingError() from None


def validate_pdf(
    source: object,
    *,
    staging: PdfValidationStagingPort,
    max_bytes: int = DEFAULT_MAX_PDF_BYTES,
    declared_media_type: str | None = None,
    cancel_event: CancellationEvent | None = None,
) -> ValidatedPdf:
    """Copy and validate a candidate PDF under a deterministic byte budget.

    Article association is deliberately outside this file-fact gate and is
    owned by the automatic or manual Acquisition caller. ``declared_media_type``
    is accepted only to make its non-authoritative status obvious; it never
    changes validation.
    """

    del declared_media_type
    if not isinstance(staging, PdfValidationStagingPort):
        raise TypeError("staging must implement PdfValidationStagingPort")
    if type(max_bytes) is not int or max_bytes <= 0:
        raise PdfValidationError(PdfValidationCode.INVALID_BUDGET)
    _cancel_if_requested(cancel_event)

    stage: PdfValidationStage | None = None
    keep_stage = False
    try:
        try:
            stage = staging.create()
            if not isinstance(stage, PdfValidationStage):
                raise TypeError("staging returned an invalid stage")
        except Exception:
            raise PdfValidationStagingError() from None
        digest = hashlib.sha256()
        sniff = bytearray()
        byte_size = _copy_to_stage(
            stage,
            source,
            max_bytes=max_bytes,
            digest=digest,
            sniff=sniff,
            cancel_event=cancel_event,
        )
        _validate_signature(bytes(sniff), byte_size)
        try:
            stage.flush()
        except Exception:
            raise PdfValidationStagingError() from None
        _cancel_if_requested(cancel_event)
        _validate_staged_reader(stage, cancel_event)
        _cancel_if_requested(cancel_event)
        validated = ValidatedPdf(
            stage,
            sha256=Sha256(digest.hexdigest()),
            byte_size=byte_size,
        )
        keep_stage = True
        return validated
    finally:
        if not keep_stage:
            _cleanup_failed_stage(stage)


__all__ = (
    "CancellationEvent",
    "DEFAULT_MAX_PDF_BYTES",
    "PdfByteSource",
    "PdfValidationCancelled",
    "PdfValidationCode",
    "PdfValidationError",
    "PdfValidationStagingError",
    "ReadablePdfSource",
    "ValidatedPdf",
    "validate_pdf",
)
