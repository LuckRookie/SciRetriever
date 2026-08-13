"""Storage adapter for Literature-owned verified artifact reads.

The adapter binds one neutral Detail artifact descriptor to the exact
``artifact_objects`` row visible in a single read-only Catalog snapshot, then
delegates byte integrity and safe filesystem traversal to ``VerifiedReader``.
It does not infer media types, expose paths, write user output, or make any
Literature business decision.
"""

from __future__ import annotations

from contextlib import AbstractContextManager, suppress
from types import TracebackType
from typing import BinaryIO

from sciretriever.literature.ports import (
    LiteratureArtifactReadError,
    LiteratureArtifactReference,
)
from sciretriever.model.acquisition import Asset
from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.model.primitives import AssetId, RelativeArtifactPath, Sha256
from sciretriever.storage.files.paths import StoragePathError, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference as StoredArtifactReference
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_artifact_catalog import (
    verify_literature_artifact_catalog,
)


class _LiteratureArtifactReadContext(AbstractContextManager[BinaryIO]):
    """Verify Catalog state briefly, then own only the filesystem stream."""

    __slots__ = (
        "_engine",
        "_reader",
        "_reference",
        "_asset_id",
        "_stream_context",
        "_entered",
        "_closed",
    )

    def __init__(
        self,
        engine: CatalogEngine,
        reader: VerifiedReader,
        reference: StoredArtifactReference,
        asset_id: AssetId | None,
    ) -> None:
        self._engine = engine
        self._reader = reader
        self._reference = reference
        self._asset_id = asset_id
        self._stream_context: AbstractContextManager[BinaryIO] | None = None
        self._entered = False
        self._closed = False

    def __enter__(self) -> BinaryIO:
        if self._entered or self._closed:
            raise LiteratureArtifactReadError()
        try:
            verify_literature_artifact_catalog(
                self._engine,
                self._reference,
                asset_id=self._asset_id,
            )
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
                raise LiteratureArtifactReadError() from None
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
            raise LiteratureArtifactReadError()
        self._closed = True
        stream_context = self._stream_context
        if stream_context is None:
            raise LiteratureArtifactReadError()
        try:
            stream_context.__exit__(exc_type, exc_value, traceback)
        except Exception:
            raise LiteratureArtifactReadError() from None
        except BaseException:
            raise
        return False


class LiteratureArtifactReader:
    """Implement Literature's artifact-read capability over Catalog + files."""

    __slots__ = ("_engine", "_reader")

    def __init__(self, engine: CatalogEngine, reader: VerifiedReader) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if not isinstance(reader, VerifiedReader):
            raise TypeError("reader must be a VerifiedReader")
        self._engine = engine
        self._reader = reader

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]:
        """Return a verified binary stream for one already accepted descriptor."""

        try:
            normalized, asset_id = _descriptor(reference, self._reader.max_artifact_bytes)
        except LiteratureArtifactReadError:
            raise
        except Exception:
            raise LiteratureArtifactReadError() from None
        return _LiteratureArtifactReadContext(
            self._engine,
            self._reader,
            normalized,
            asset_id,
        )


def _descriptor(
    reference: LiteratureArtifactReference,
    max_artifact_bytes: int,
) -> tuple[StoredArtifactReference, AssetId | None]:
    asset_id: AssetId | None
    supplied_path: RelativeArtifactPath | None
    if isinstance(reference, Asset):
        digest = reference.sha256
        byte_size = reference.size_bytes
        media_type = reference.media_type
        supplied_path = reference.path
        asset_id = reference.asset_id
    elif isinstance(reference, ParserArtifactRef | ArtifactRef):
        digest = reference.sha256
        byte_size = reference.byte_size
        media_type = reference.media_type
        supplied_path = None
        asset_id = None
    else:
        raise LiteratureArtifactReadError()

    if (
        not isinstance(digest, Sha256)
        or type(byte_size) is not int
        or byte_size <= 0
        or byte_size > max_artifact_bytes
        or type(media_type) is not str
    ):
        raise LiteratureArtifactReadError()
    normalized_media_type = media_type.strip()
    if not normalized_media_type or any(
        ord(character) < 32 or ord(character) == 127 for character in normalized_media_type
    ):
        raise LiteratureArtifactReadError()
    try:
        canonical_path = content_addressed_reference(digest, byte_size)
    except (StoragePathError, TypeError, ValueError):
        raise LiteratureArtifactReadError() from None
    if supplied_path is not None and supplied_path != canonical_path:
        raise LiteratureArtifactReadError()
    return (
        StoredArtifactReference(
            path=canonical_path,
            sha256=digest,
            byte_size=byte_size,
            media_type=normalized_media_type,
        ),
        asset_id,
    )


__all__ = (
    "LiteratureArtifactReadError",
    "LiteratureArtifactReader",
    "LiteratureArtifactReference",
)
