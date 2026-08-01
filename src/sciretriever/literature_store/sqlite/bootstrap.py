from __future__ import annotations

from collections.abc import Callable
import os
import re
import stat
from typing import Final

from sciretriever.literature_store.filesystem import CanonicalCatalogPath


_UUID: Final = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def recover_bootstrap_temps(
    scope: CanonicalCatalogPath,
    validate_path: Callable[[str], bool],
) -> None:
    pattern = re.compile(rf"^\.{re.escape(scope.basename)}\.bootstrap-{_UUID}\.tmp$")
    parent = os.open(scope.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    changed = False
    try:
        try:
            final = os.stat(scope.basename, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            final = None
        for name in os.listdir(parent):
            if pattern.fullmatch(name) is None:
                continue
            metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink not in (1, 2)
            ):
                continue
            if not validate_path(str(scope.parent / name)):
                continue
            if final is not None and metadata.st_nlink == 2:
                if (metadata.st_dev, metadata.st_ino) != (final.st_dev, final.st_ino):
                    continue
            os.unlink(name, dir_fd=parent)
            changed = True
        if changed:
            os.fsync(parent)
    finally:
        os.close(parent)
