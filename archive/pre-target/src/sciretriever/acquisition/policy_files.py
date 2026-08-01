"""Safe bounded snapshots of local acquisition policy files."""

from __future__ import annotations

import os
from pathlib import Path
import stat


MAX_POLICY_BYTES = 1024 * 1024


def read_policy_lines(path: Path) -> tuple[str, ...]:
    before = path.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError("policy path must be a regular non-symlink file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise ValueError("policy file changed while opening")
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = -1
            payload = stream.read(MAX_POLICY_BYTES + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(payload) > MAX_POLICY_BYTES:
        raise ValueError("policy file is too large")
    text = payload.decode("utf-8")
    return tuple(
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


__all__ = ("MAX_POLICY_BYTES", "read_policy_lines")
