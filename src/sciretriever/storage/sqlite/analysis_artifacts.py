"""SQLite-bound verified Parser artifact reader for Analysis."""

from __future__ import annotations

import sqlite3
from contextlib import AbstractContextManager, suppress
from types import TracebackType
from typing import BinaryIO, NoReturn

from pydantic import ValidationError

from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.model.primitives import Sha256
from sciretriever.storage.files.paths import StoragePathError, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStoreError
from sciretriever.storage.sqlite.engine import CatalogEngine


class AnalysisArtifactReadError(RuntimeError):
    """Stable failure for a Catalog-bound Parser artifact read."""

    _MESSAGE = "analysis artifact read failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)

    def __repr__(self) -> str:
        return "<AnalysisArtifactReadError>"


def _read_failure() -> NoReturn:
    raise AnalysisArtifactReadError() from None


def _runtime_object(value: object) -> object:
    """Erase trusted static types before validating an external boundary."""

    return value


def _normalized_parser_reference(
    value: object,
    *,
    max_artifact_bytes: int,
) -> ArtifactReference:
    if not isinstance(value, ParserArtifactRef):
        _read_failure()
    digest = _runtime_object(value.sha256)
    if (
        not isinstance(digest, Sha256)
        or type(value.byte_size) is not int
        or value.byte_size <= 0
        or value.byte_size > max_artifact_bytes
        or type(value.media_type) is not str
        or not value.media_type.strip()
        or value.media_type != value.media_type.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value.media_type)
    ):
        _read_failure()
    try:
        checked = ParserArtifactRef.model_validate(value.model_dump())
        path = content_addressed_reference(checked.sha256, checked.byte_size)
        reference = ArtifactReference(
            path=path,
            sha256=checked.sha256,
            byte_size=checked.byte_size,
            media_type=checked.media_type,
        )
    except (
        ArtifactStoreError,
        StoragePathError,
        ValidationError,
        TypeError,
        ValueError,
    ):
        _read_failure()
    if checked != value:
        _read_failure()
    return reference


def _verify_catalog(engine: CatalogEngine, reference: ArtifactReference) -> None:
    expected = (
        reference.path.root,
        reference.sha256.root,
        reference.byte_size,
        reference.media_type,
    )
    try:
        with engine.read_snapshot() as connection:
            rows = connection.execute(
                "SELECT relative_path,sha256,byte_size,media_type "
                "FROM artifact_objects WHERE relative_path=?",
                (reference.path.root,),
            ).fetchall()
            if len(rows) != 1 or tuple(rows[0]) != expected:
                _read_failure()
    except AnalysisArtifactReadError:
        raise
    except (sqlite3.Error, TypeError, ValueError):
        _read_failure()
    except Exception:
        _read_failure()


class _AnalysisArtifactReadContext(AbstractContextManager[BinaryIO]):
    """Close the Catalog snapshot before yielding the verified stream."""

    __slots__ = (
        "_engine",
        "_reader",
        "_reference",
        "_stream_context",
        "_entered",
        "_closed",
    )

    def __init__(
        self,
        engine: CatalogEngine,
        reader: VerifiedReader,
        reference: ArtifactReference,
    ) -> None:
        self._engine = engine
        self._reader = reader
        self._reference = reference
        self._stream_context: AbstractContextManager[BinaryIO] | None = None
        self._entered = False
        self._closed = False

    def __repr__(self) -> str:
        return "<_AnalysisArtifactReadContext>"

    def __enter__(self) -> BinaryIO:
        if self._entered or self._closed:
            _read_failure()
        try:
            _verify_catalog(self._engine, self._reference)
            stream_context = self._reader.open(self._reference)
            self._stream_context = stream_context
            stream = stream_context.__enter__()
        except BaseException as error:
            self._closed = True
            stream_context = self._stream_context
            if stream_context is not None:
                with suppress(Exception):
                    stream_context.__exit__(None, None, None)
            if isinstance(error, Exception):
                _read_failure()
            raise
        self._entered = True
        return stream

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        if not self._entered or self._closed:
            _read_failure()
        self._closed = True
        stream_context = self._stream_context
        if stream_context is None:
            _read_failure()
        try:
            stream_context.__exit__(exc_type, exc_value, traceback)
        except Exception:
            _read_failure()
        except BaseException:
            raise
        return False


class AnalysisArtifactReader:
    """Open only Catalog-registered Parser artifacts through verified bytes."""

    __slots__ = ("_engine", "_reader")

    def __init__(self, engine: CatalogEngine, reader: VerifiedReader) -> None:
        engine_value = _runtime_object(engine)
        reader_value = _runtime_object(reader)
        if not isinstance(engine_value, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if not isinstance(reader_value, VerifiedReader):
            raise TypeError("reader must be a VerifiedReader")
        self._engine = engine_value
        self._reader = reader_value

    def __repr__(self) -> str:
        return "<AnalysisArtifactReader>"

    def open_artifact(
        self,
        reference: ParserArtifactRef,
    ) -> AbstractContextManager[BinaryIO]:
        try:
            normalized = _normalized_parser_reference(
                reference,
                max_artifact_bytes=self._reader.max_artifact_bytes,
            )
        except AnalysisArtifactReadError:
            raise
        except Exception:
            _read_failure()
        return _AnalysisArtifactReadContext(
            self._engine,
            self._reader,
            normalized,
        )


__all__ = ("AnalysisArtifactReadError", "AnalysisArtifactReader")
