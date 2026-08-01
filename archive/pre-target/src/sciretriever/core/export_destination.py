"""Filesystem admission contract for export destinations."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import stat

from sciretriever.core.export_errors import ExportContractError


@dataclass(frozen=True, slots=True)
class ExportDestination:
    path: Path

    @classmethod
    def parse(cls, destination: Path, catalog_path: Path) -> ExportDestination:
        if not isinstance(destination, Path) or not isinstance(catalog_path, Path):
            raise ExportContractError("export destination and catalog path must be Path values")
        candidate = destination.expanduser().absolute()
        parent = candidate.parent
        if not parent.is_dir() or parent.is_symlink() or parent.resolve(strict=True) != parent:
            raise ExportContractError("export parent must be an existing non-symlink directory")
        catalog = catalog_path.expanduser().absolute().resolve(strict=False)
        protected = (catalog, Path(f"{catalog}-wal"), Path(f"{catalog}-shm"), Path(f"{catalog}-journal"))
        resolved = candidate.resolve(strict=False)
        for protected_path in protected:
            if resolved == protected_path:
                raise ExportContractError("export destination conflicts with catalog storage")
            if candidate.exists() and protected_path.exists() and os.path.samefile(candidate, protected_path):
                raise ExportContractError("export destination conflicts with catalog storage")
        if candidate.is_symlink():
            raise ExportContractError("export destination must not be a symlink")
        if candidate.exists():
            metadata = candidate.stat(follow_symlinks=False)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise ExportContractError("existing export destination must be a single-link regular file")
        return cls(candidate)


__all__ = ("ExportDestination",)
