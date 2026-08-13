"""Local Library reads and verified user-facing artifact copies.

This Entry slice deliberately delegates every query decision to Literature.
It neither interprets cursors nor derives Literature state or reverse
references.  Artifact bytes likewise come only from Literature's verified
reader and are published only through Entry's atomic user-output boundary.
"""

from __future__ import annotations

import hashlib
from contextlib import AbstractContextManager
from typing import BinaryIO

from sciretriever.entry.ports import AtomicUserOutputPort, UserOutputTarget
from sciretriever.literature.api import (
    LiteratureApi,
    LiteratureArtifactReadError,
    LiteratureArtifactReference,
)
from sciretriever.model.acquisition import Asset
from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.library import (
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    ReferenceDetail,
)
from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.model.primitives import LiteratureId, ReferenceId, Sha256

_COPY_CHUNK_SIZE = 1024 * 1024


class LibraryOperations:
    """Thin Entry operations over one assembled local Literature boundary."""

    __slots__ = ("_literature", "_output")

    def __init__(
        self,
        *,
        literature: LiteratureApi,
        output: AtomicUserOutputPort,
    ) -> None:
        if not isinstance(literature, LiteratureApi):
            raise TypeError("literature must be a LiteratureApi")
        if not isinstance(output, AtomicUserOutputPort):
            raise TypeError("output must implement AtomicUserOutputPort")
        self._literature = literature
        self._output = output

    def search_literature(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        """Return Literature's concrete-version local search page unchanged."""

        return self._literature.search(request)

    def get_literature_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        """Return one snapshot-consistent Literature projection unchanged."""

        return self._literature.read_detail(literature_id)

    def list_literature_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        """Delegate forward or reverse traversal of the same Reference facts."""

        return self._literature.read_references(request)

    def get_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail:
        """Return both endpoints and all current support for one Reference."""

        return self._literature.read_reference_detail(reference_id)

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]:
        """Open an existing Detail descriptor through Literature verification."""

        return self._literature.open_artifact(reference)

    def export_artifact(
        self,
        reference: LiteratureArtifactReference,
        target: UserOutputTarget,
        overwrite: bool = False,
    ) -> None:
        """Copy one verified artifact to an atomically published user target.

        The output context is deliberately outermost.  It therefore cannot
        publish until Literature's managed reader has completed its close-time
        integrity check.  A second digest/size check covers the exact bytes
        written to the staged user output before that context may publish.
        """

        expected_sha256, expected_size = _artifact_identity(reference)
        digest = hashlib.sha256()
        copied_size = 0
        with self._output.open_atomic(target, overwrite=overwrite) as destination:
            with self._literature.open_artifact(reference) as source:
                while True:
                    chunk = source.read(_COPY_CHUNK_SIZE)
                    if not isinstance(chunk, bytes):
                        raise LiteratureArtifactReadError()
                    if not chunk:
                        break
                    copied_size += len(chunk)
                    if copied_size > expected_size:
                        raise LiteratureArtifactReadError()
                    digest.update(chunk)
                    _write_all(destination, chunk)
            if copied_size != expected_size or Sha256(digest.hexdigest()) != expected_sha256:
                raise LiteratureArtifactReadError()


def _artifact_identity(reference: LiteratureArtifactReference) -> tuple[Sha256, int]:
    if isinstance(reference, Asset):
        digest = reference.sha256
        size = reference.size_bytes
    elif isinstance(reference, ParserArtifactRef | ArtifactRef):
        digest = reference.sha256
        size = reference.byte_size
    else:
        raise LiteratureArtifactReadError()
    if not isinstance(digest, Sha256) or type(size) is not int or size < 0:
        raise LiteratureArtifactReadError()
    return digest, size


def _write_all(destination: BinaryIO, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = destination.write(remaining)
        if type(written) is not int or written <= 0 or written > len(remaining):
            raise RuntimeError("atomic user output rejected staged artifact bytes")
        remaining = remaining[written:]


__all__ = ("LibraryOperations",)
