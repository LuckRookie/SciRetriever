from __future__ import annotations

import hashlib
import os
import re
import stat
from dataclasses import dataclass
from typing import Final

from sciretriever.infrastructure.storage.files.artifacts import ArtifactFilesystemError
from sciretriever.model.primitives import RelativeArtifactPath

_CHUNK_BYTES: Final = 1024 * 1024
_MAX_ARTIFACT_BYTES: Final = 512 * 1024 * 1024
_DIGEST: Final = re.compile(r"^[0-9a-f]{64}$")
_PREFIX: Final = re.compile(r"^[0-9a-f]{2}$")
_READ_FLAGS: Final = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)


@dataclass(frozen=True, slots=True)
class ArtifactIdentity:
    device: int
    inode: int
    links: int
    size: int
    digest: str


@dataclass(frozen=True, slots=True)
class FormalArtifactCandidate:
    path: RelativeArtifactPath
    identity: ArtifactIdentity


def formal_artifact_path(kind: str, prefix: str, digest: str) -> RelativeArtifactPath | None:
    if _PREFIX.fullmatch(prefix) is None or _DIGEST.fullmatch(digest) is None:
        return None
    if digest[:2] != prefix:
        return None
    return RelativeArtifactPath(f"{kind}/{prefix}/{digest}")


def open_immutable_artifact(parent: int, name: str) -> int:
    try:
        descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
    except OSError as error:
        raise ArtifactFilesystemError("artifact entry is missing or unsafe") from error
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        os.close(descriptor)
        raise ArtifactFilesystemError(
            "immutable artifact must be an exclusively linked owner-only regular file"
        )
    return descriptor


def descriptor_identity(descriptor: int) -> ArtifactIdentity:
    initial = os.fstat(descriptor)
    digest = hashlib.sha256()
    size = 0
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, _CHUNK_BYTES)
        if not chunk:
            break
        size += len(chunk)
        if size > _MAX_ARTIFACT_BYTES:
            raise ArtifactFilesystemError("artifact exceeds the bounded verification size")
        digest.update(chunk)
    final = os.fstat(descriptor)
    if (
        (initial.st_dev, initial.st_ino, initial.st_nlink, initial.st_size)
        != (final.st_dev, final.st_ino, final.st_nlink, final.st_size)
        or final.st_uid != os.geteuid()
        or stat.S_IMODE(final.st_mode) != 0o600
        or final.st_nlink != 1
        or size != final.st_size
    ):
        raise ArtifactFilesystemError("artifact identity changed during verification")
    return ArtifactIdentity(
        final.st_dev,
        final.st_ino,
        final.st_nlink,
        size,
        digest.hexdigest(),
    )
