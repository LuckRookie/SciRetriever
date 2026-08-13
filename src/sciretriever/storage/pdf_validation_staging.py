"""Storage implementation of Acquisition's owner-only PDF validation stage."""

from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO, NoReturn, Protocol, cast

from sciretriever.acquisition.ports import PdfValidationStage
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.staging import create_staging

_TEMPORARY_PREFIX = "sciretriever-pdf-"


class PdfValidationStagingAdapterError(RuntimeError):
    """The system-temporary staging boundary could not be used safely."""

    _MESSAGE = "PDF validation staging adapter failed"

    def __init__(self, _detail: object | None = None) -> None:
        super().__init__(self._MESSAGE)


def _failure() -> NoReturn:
    raise PdfValidationStagingAdapterError() from None


class _TemporaryDirectory(Protocol):
    @property
    def name(self) -> str: ...

    def cleanup(self) -> None: ...


class _DescriptorStage(Protocol):
    def write(self, data: bytes) -> int: ...

    def flush(self) -> None: ...

    def open(self) -> AbstractContextManager[int]: ...

    def close(self) -> None: ...


TemporaryDirectoryFactory = Callable[..., _TemporaryDirectory]
DescriptorStageFactory = Callable[[StorageRoot], _DescriptorStage]


class _SystemPdfValidationStage:
    """One stage plus the private temporary root whose lifetime it owns."""

    __slots__ = ("_stage", "_temporary_directory", "_closed")

    def __init__(
        self,
        stage: _DescriptorStage,
        temporary_directory: _TemporaryDirectory,
    ) -> None:
        self._stage = stage
        self._temporary_directory = temporary_directory
        self._closed = False

    def write(self, data: bytes) -> int:
        if self._closed or type(data) is not bytes:
            _failure()
        try:
            return self._stage.write(data)
        except Exception:
            _failure()

    def flush(self) -> None:
        if self._closed:
            _failure()
        try:
            self._stage.flush()
        except Exception:
            _failure()

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        if self._closed:
            _failure()
        context: AbstractContextManager[int] | None = None
        stream: BinaryIO | None = None
        entered = False
        body_failed = False
        try:
            context = self._stage.open()
            descriptor = context.__enter__()
            entered = True
            os.lseek(descriptor, 0, os.SEEK_SET)
            stream = cast(BinaryIO, os.fdopen(descriptor, "rb", closefd=False))
            yield stream
        except BaseException:
            body_failed = True
            raise
        finally:
            cleanup_failed = False
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    cleanup_failed = True
            if context is not None and entered:
                try:
                    context.__exit__(None, None, None)
                except Exception:
                    cleanup_failed = True
            if cleanup_failed and not body_failed:
                _failure()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        failed = False
        try:
            self._stage.close()
        except Exception:
            failed = True
        try:
            self._temporary_directory.cleanup()
        except Exception:
            failed = True
        if failed:
            _failure()

    def __repr__(self) -> str:
        return f"<SystemPdfValidationStage closed={self._closed}>"

    def __del__(self) -> None:  # pragma: no cover - deterministic close is the contract.
        try:
            self.close()
        except Exception:
            pass


class SystemPdfValidationStaging:
    """Create fresh 0700/0600 validation stages under system temporary storage."""

    __slots__ = ("_parent", "_temporary_directory_factory", "_stage_factory")

    def __init__(
        self,
        *,
        parent: Path | None = None,
        temporary_directory_factory: TemporaryDirectoryFactory = TemporaryDirectory,
        stage_factory: DescriptorStageFactory = create_staging,
    ) -> None:
        if parent is not None and not isinstance(parent, Path):
            raise TypeError("parent must be a Path or None")
        if not callable(temporary_directory_factory):
            raise TypeError("temporary_directory_factory must be callable")
        if not callable(stage_factory):
            raise TypeError("stage_factory must be callable")
        self._parent = parent
        self._temporary_directory_factory = temporary_directory_factory
        self._stage_factory = stage_factory

    def create(self) -> PdfValidationStage:
        temporary_directory: _TemporaryDirectory | None = None
        stage: _DescriptorStage | None = None
        try:
            temporary_directory = self._temporary_directory_factory(
                prefix=_TEMPORARY_PREFIX,
                dir=self._parent,
            )
            root = StorageRoot(Path(temporary_directory.name) / "root")
            stage = self._stage_factory(root)
            return _SystemPdfValidationStage(stage, temporary_directory)
        except Exception:
            if stage is not None:
                try:
                    stage.close()
                except Exception:
                    pass
            if temporary_directory is not None:
                try:
                    temporary_directory.cleanup()
                except Exception:
                    pass
            _failure()


__all__ = (
    "PdfValidationStagingAdapterError",
    "SystemPdfValidationStaging",
)
