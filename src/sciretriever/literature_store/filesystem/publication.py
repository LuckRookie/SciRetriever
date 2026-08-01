from __future__ import annotations

import json
import os
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Final, NoReturn
from uuid import uuid4

from sciretriever.content.api import ArtifactKind, PublishedArtifact, StagedArtifact
from sciretriever.kernel import RelativeArtifactPath
from sciretriever.literature_store.filesystem.artifact_identity import (
    descriptor_identity,
    open_immutable_artifact,
)
from sciretriever.literature_store.filesystem.artifacts import (
    ArtifactFilesystemError,
    CoreStorage,
    ensure_child,
)

_MAX_ARTIFACT_BYTES: Final = 512 * 1024 * 1024
Checkpoint = Callable[[str], None]


def assert_never(value: NoReturn) -> NoReturn:
    raise AssertionError(f"unhandled artifact kind: {value!r}")


class ArtifactConflictError(Exception):
    __slots__ = ("path",)

    def __init__(self, path: RelativeArtifactPath) -> None:
        self.path = path
        super().__init__(str(path))

    def __str__(self) -> str:
        return f"immutable artifact conflict at {self.path}"


class ArtifactValidationError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


def _directory(kind: ArtifactKind) -> str:
    match kind:
        case ArtifactKind.PRIMARY_PDF:
            return "primary"
        case ArtifactKind.SUPPLEMENTARY:
            return "supplementary"
        case ArtifactKind.LIGHT_DOCUMENT:
            return "light-document"
        case ArtifactKind.ANALYSIS:
            return "analysis"
        case unreachable:
            assert_never(unreachable)


def _validate_type(artifact: StagedArtifact) -> None:
    if not artifact.content or len(artifact.content) > _MAX_ARTIFACT_BYTES:
        raise ArtifactValidationError("artifact size is outside the supported bounds")
    match artifact.kind:
        case ArtifactKind.PRIMARY_PDF:
            if not artifact.content.startswith(b"%PDF-"):
                raise ArtifactValidationError("primary artifact is not a PDF")
        case ArtifactKind.SUPPLEMENTARY:
            return
        case ArtifactKind.LIGHT_DOCUMENT | ArtifactKind.ANALYSIS:
            try:
                parsed = json.loads(artifact.content)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ArtifactValidationError("structured artifact is not valid JSON") from error
            if not isinstance(parsed, dict):
                raise ArtifactValidationError("structured artifact must be a JSON object")
        case unreachable:
            assert_never(unreachable)


@dataclass(frozen=True, slots=True)
class CoreArtifactStore:
    storage_root: Path

    def __init__(self, storage_root: str | os.PathLike[str]) -> None:
        object.__setattr__(self, "storage_root", Path(storage_root).absolute())

    def publish(  # noqa: C901
        self, artifact: StagedArtifact, *, checkpoint: Checkpoint | None = None
    ) -> PublishedArtifact:
        _validate_type(artifact)
        digest = str(artifact.sha256)
        relative = RelativeArtifactPath(f"{_directory(artifact.kind)}/{digest[:2]}/{digest}")
        staging_name = f"artifact-{uuid4()}.stage"
        with CoreStorage(self.storage_root).open_core() as core:
            staging = ensure_child(core, ".staging", "core staging")
            kind_directory = ensure_child(core, _directory(artifact.kind), "artifact kind")
            prefix = ensure_child(kind_directory, digest[:2], "artifact prefix")
            published = False
            try:
                descriptor = os.open(
                    staging_name,
                    os.O_WRONLY
                    | os.O_CREAT
                    | os.O_EXCL
                    | os.O_CLOEXEC
                    | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                    dir_fd=staging,
                )
                try:
                    view = memoryview(artifact.content)
                    while view:
                        written = os.write(descriptor, view)
                        view = view[written:]
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                if checkpoint is not None:
                    checkpoint("after-stage-fsync")
                self._verify(staging, staging_name, artifact)
                try:
                    os.link(
                        staging_name,
                        digest,
                        src_dir_fd=staging,
                        dst_dir_fd=prefix,
                        follow_symlinks=False,
                    )
                    published = True
                    os.unlink(staging_name, dir_fd=staging)
                    os.fsync(staging)
                except FileExistsError:
                    try:
                        self._verify(prefix, digest, artifact)
                    except ArtifactFilesystemError as error:
                        raise ArtifactConflictError(relative) from error
                if checkpoint is not None:
                    checkpoint("after-publish")
                self._verify(prefix, digest, artifact)
                os.fsync(prefix)
                os.fsync(kind_directory)
                os.fsync(core)
                if checkpoint is not None:
                    checkpoint("after-directory-fsync")
                if not published:
                    os.unlink(staging_name, dir_fd=staging)
                    os.fsync(staging)
                if checkpoint is not None:
                    checkpoint("after-cleanup")
                return PublishedArtifact(
                    artifact.kind, relative, artifact.sha256, len(artifact.content)
                )
            except ArtifactConflictError:
                raise
            except (OSError, ArtifactFilesystemError) as error:
                if published:
                    raise ArtifactFilesystemError("artifact publication failed") from error
                raise
            finally:
                os.close(prefix)
                os.close(kind_directory)
                if published:
                    with suppress(FileNotFoundError):
                        os.unlink(staging_name, dir_fd=staging)
                os.close(staging)

    @staticmethod
    def _verify(parent: int, name: str, artifact: StagedArtifact) -> None:
        descriptor = open_immutable_artifact(parent, name)
        try:
            identity = descriptor_identity(descriptor)
            if identity.size != len(artifact.content) or identity.digest != str(artifact.sha256):
                digest = str(artifact.sha256)
                raise ArtifactConflictError(
                    RelativeArtifactPath(f"{_directory(artifact.kind)}/{digest[:2]}/{digest}")
                )
        finally:
            os.close(descriptor)
