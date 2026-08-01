from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import os
from pathlib import Path
from typing import Final

from sciretriever.batching.ports import AdmissionPort, CatalogIdentity
from sciretriever.kernel import RelativeArtifactPath
from sciretriever.literature_store.filesystem.artifact_identity import (
    FormalArtifactCandidate,
    descriptor_identity,
    formal_artifact_path,
    open_immutable_artifact,
)
from sciretriever.literature_store.filesystem.artifacts import (
    ArtifactFilesystemError,
    CoreStorage,
    open_child,
)


_KINDS: Final = ("primary", "supplementary", "light-document", "analysis")
Checkpoint = Callable[[str], None]


@dataclass(frozen=True, slots=True)
class ReconciliationResult:
    deleted: tuple[RelativeArtifactPath, ...]
    preserved: tuple[RelativeArtifactPath, ...]


@dataclass(frozen=True, slots=True)
class _ScanResult:
    candidates: tuple[FormalArtifactCandidate, ...]
    preserved: tuple[RelativeArtifactPath, ...]


@dataclass(frozen=True, slots=True)
class ReconciliationConfig:
    storage_root: Path
    catalog_path: Path
    admission: AdmissionPort
    catalog_identity: CatalogIdentity


class CoreArtifactReconciler:
    def __init__(
        self,
        storage_root: str | os.PathLike[str],
        catalog_path: str | os.PathLike[str],
        admission: AdmissionPort,
        catalog_identity: CatalogIdentity,
    ) -> None:
        self._config = ReconciliationConfig(
            Path(storage_root).absolute(),
            Path(catalog_path).absolute(),
            admission,
            catalog_identity,
        )

    def reconcile(self, *, checkpoint: Checkpoint | None = None) -> ReconciliationResult:
        config = self._config
        with config.admission.acquire_core_write(config.catalog_identity):
            return self._reconcile(checkpoint)

    def reconcile_guarded(self) -> None:
        self._reconcile(None)

    def _reconcile(self, checkpoint: Checkpoint | None) -> ReconciliationResult:
        from sciretriever.literature_store.sqlite.engine import open_read_only_snapshot

        config = self._config
        with CoreStorage(config.storage_root).open_core() as core:
            scan = self._scan(core)
            if checkpoint is not None:
                checkpoint("after-scan")
            with open_read_only_snapshot(config.catalog_path) as connection:
                connection.execute("BEGIN")
                referenced = {
                    RelativeArtifactPath(row[0])
                    for row in connection.execute("SELECT storage_path FROM artifacts")
                }
                deleted: list[RelativeArtifactPath] = []
                preserved = list(scan.preserved)
                for candidate in scan.candidates:
                    if candidate.path in referenced:
                        preserved.append(candidate.path)
                    elif self._delete(core, candidate):
                        deleted.append(candidate.path)
                    else:
                        preserved.append(candidate.path)
            return ReconciliationResult(tuple(deleted), tuple(preserved))

    @staticmethod
    def _scan(core: int) -> _ScanResult:
        found: list[FormalArtifactCandidate] = []
        preserved: list[RelativeArtifactPath] = []
        for kind in _KINDS:
            if kind not in os.listdir(core):
                continue
            kind_descriptor = open_child(core, kind, "artifact kind")
            try:
                for prefix_name in sorted(os.listdir(kind_descriptor)):
                    try:
                        prefix = open_child(kind_descriptor, prefix_name, "artifact prefix")
                    except ArtifactFilesystemError:
                        preserved.append(RelativeArtifactPath(f"{kind}/{prefix_name}"))
                        continue
                    try:
                        for digest in sorted(os.listdir(prefix)):
                            relative = RelativeArtifactPath(
                                f"{kind}/{prefix_name}/{digest}"
                            )
                            formal = formal_artifact_path(kind, prefix_name, digest)
                            if formal is None:
                                preserved.append(relative)
                                continue
                            try:
                                descriptor = open_immutable_artifact(prefix, digest)
                            except ArtifactFilesystemError:
                                preserved.append(formal)
                                continue
                            try:
                                try:
                                    identity = descriptor_identity(descriptor)
                                except ArtifactFilesystemError:
                                    preserved.append(formal)
                                else:
                                    if identity.digest == digest:
                                        found.append(FormalArtifactCandidate(formal, identity))
                                    else:
                                        preserved.append(formal)
                            finally:
                                os.close(descriptor)
                    finally:
                        os.close(prefix)
            finally:
                os.close(kind_descriptor)
        return _ScanResult(tuple(found), tuple(preserved))

    @staticmethod
    def _delete(core: int, candidate: FormalArtifactCandidate) -> bool:
        kind_name, prefix_name, digest = str(candidate.path).split("/")
        kind = open_child(core, kind_name, "artifact kind")
        try:
            prefix = open_child(kind, prefix_name, "artifact prefix")
            try:
                try:
                    descriptor = open_immutable_artifact(prefix, digest)
                except ArtifactFilesystemError:
                    return False
                try:
                    current = descriptor_identity(descriptor)
                    try:
                        entry = os.stat(digest, dir_fd=prefix, follow_symlinks=False)
                    except OSError:
                        return False
                    if (
                        current != candidate.identity
                        or (entry.st_dev, entry.st_ino) != (
                            candidate.identity.device,
                            candidate.identity.inode,
                        )
                        or current.digest != digest
                    ):
                        return False
                    os.unlink(digest, dir_fd=prefix)
                    os.fsync(prefix)
                    return True
                finally:
                    os.close(descriptor)
            finally:
                os.close(prefix)
        finally:
            os.close(kind)
