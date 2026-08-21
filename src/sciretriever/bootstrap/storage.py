"""Storage construction, rollback, admission, and scoped graph lifecycle."""

from __future__ import annotations

import logging
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Generator

from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.graphs import (
    LocalLibraryObjectGraph,
    _LocalLibraryEntry,
)
from sciretriever.bootstrap.services import _UuidLiteratureIds
from sciretriever.model.configuration import Configuration
from sciretriever.model.report import StableFailure

if TYPE_CHECKING:
    from sciretriever.literature.api import LiteratureApi
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.files.paths import StorageRoot
    from sciretriever.storage.files.reader import VerifiedReader
    from sciretriever.storage.files.store import ArtifactStore
    from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
    from sciretriever.storage.sqlite.engine import CatalogEngine
    from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter


class _CatalogWriteAdmission:
    __slots__ = ("_artifact_reconciler", "_catalog_path")

    def __init__(self, catalog_path: Path, artifact_reconciler: object) -> None:
        from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler

        if not isinstance(artifact_reconciler, ArtifactStoreReconciler):
            raise TypeError("artifact_reconciler must be an ArtifactStoreReconciler")
        self._catalog_path = catalog_path
        self._artifact_reconciler = artifact_reconciler

    @contextmanager
    def acquire_nowait(self) -> Generator[None, None, None]:
        from sciretriever.entry.ports import WriteAdmissionFailure
        from sciretriever.storage.files.reconciliation import ArtifactReconciliationError
        from sciretriever.storage.locking import (
            CatalogLockConflictError,
            CatalogLockError,
            CatalogWriteLock,
        )

        try:
            with CatalogWriteLock(self._catalog_path):
                self._artifact_reconciler.reconcile_admitted()
                try:
                    yield None
                except BaseException:
                    raise
                else:
                    self._artifact_reconciler.reconcile_admitted()
        except WriteAdmissionFailure:
            raise
        except CatalogLockConflictError as error:
            raise WriteAdmissionFailure(_write_admission_conflict_failure()) from error
        except (ArtifactReconciliationError, CatalogLockError) as error:
            raise WriteAdmissionFailure(_write_admission_storage_failure()) from error


def _write_admission_conflict_failure() -> StableFailure:
    return StableFailure(
        code="write-admission-conflict",
        reason="Another operation currently owns the local database write boundary.",
        action="Wait for the other operation to finish, then retry.",
        retryable=True,
    )


def _write_admission_storage_failure() -> StableFailure:
    return StableFailure(
        code="write-admission-failed",
        reason="The local database and artifact store could not be admitted safely.",
        action="Check the local storage and retry the operation.",
        retryable=True,
    )


@dataclass(slots=True)
class _OwnedNode:
    path: Path = field(repr=False)
    descriptor: int = field(repr=False)
    device: int
    inode: int
    links: int


@dataclass(frozen=True, slots=True)
class _FreshStorageOwnership:
    catalog: _OwnedNode | None = None
    artifact_root: _OwnedNode | None = None

    @property
    def owned(self) -> bool:
        return self.catalog is not None or self.artifact_root is not None


@dataclass(frozen=True, slots=True)
class _ProjectLoggerState:
    handlers: tuple[logging.Handler, ...]
    level: int
    propagate: bool
    disabled: bool


@dataclass(frozen=True, slots=True)
class _StorageFoundation:
    engine: CatalogEngine
    storage_root: StorageRoot
    artifact_store: ArtifactStore
    verified_reader: VerifiedReader
    ownership: _FreshStorageOwnership = field(repr=False)


@dataclass(frozen=True, slots=True)
class _ScopedStorageComponents:
    foundation: _StorageFoundation
    atomic_user_output: AtomicOutput
    write_admission: _CatalogWriteAdmission
    discovery_repository: SqliteDiscoveryRepository
    entry_reader: SqliteEntryReader
    artifact_reconciler: object
    literature_api: LiteratureApi
    literature_writer: LiteratureWriter


def _missing(path: Path) -> bool:
    try:
        os.lstat(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False


def _owned_node(path: Path, *, directory: bool) -> _OwnedNode:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | (getattr(os, "O_DIRECTORY", 0) if directory else 0)
    )
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        path_metadata = os.lstat(path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        stat.S_ISLNK(path_metadata.st_mode)
        or not expected(metadata.st_mode)
        or not expected(path_metadata.st_mode)
        or (path_metadata.st_dev, path_metadata.st_ino) != (metadata.st_dev, metadata.st_ino)
    ):
        os.close(descriptor)
        raise OSError("fresh storage identity is unsafe")
    return _OwnedNode(
        path=path,
        descriptor=descriptor,
        device=metadata.st_dev,
        inode=metadata.st_ino,
        links=metadata.st_nlink,
    )


def _same_owned_node(node: _OwnedNode, *, directory: bool) -> bool:
    try:
        descriptor_metadata = os.fstat(node.descriptor)
        path_metadata = os.lstat(node.path)
    except OSError:
        return False
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    return (
        not stat.S_ISLNK(path_metadata.st_mode)
        and expected(descriptor_metadata.st_mode)
        and expected(path_metadata.st_mode)
        and (
            descriptor_metadata.st_dev,
            descriptor_metadata.st_ino,
            descriptor_metadata.st_nlink,
        )
        == (
            node.device,
            node.inode,
            node.links,
        )
        and (path_metadata.st_dev, path_metadata.st_ino)
        == (descriptor_metadata.st_dev, descriptor_metadata.st_ino)
        and path_metadata.st_nlink == descriptor_metadata.st_nlink
    )


def _release_fresh_storage_ownership(ownership: _FreshStorageOwnership) -> None:
    for node in (ownership.catalog, ownership.artifact_root):
        if node is None or node.descriptor < 0:
            continue
        descriptor = node.descriptor
        node.descriptor = -1
        try:
            os.close(descriptor)
        except OSError:
            pass


def _project_logger_state() -> _ProjectLoggerState:
    logger = logging.getLogger("sciretriever")
    return _ProjectLoggerState(
        handlers=tuple(logger.handlers),
        level=logger.level,
        propagate=logger.propagate,
        disabled=logger.disabled,
    )


def _restore_project_logger(state: _ProjectLoggerState) -> None:
    """Best-effort rollback without touching root or host-owned handlers."""

    logger = logging.getLogger("sciretriever")
    previous = frozenset(state.handlers)
    for handler in tuple(logger.handlers):
        if handler in previous:
            continue
        try:
            logger.removeHandler(handler)
        except Exception:
            pass
        try:
            handler.close()
        except Exception:
            pass
    logger.handlers[:] = state.handlers
    logger.setLevel(state.level)
    logger.propagate = state.propagate
    logger.disabled = state.disabled


def _rollback_fresh_storage(ownership: _FreshStorageOwnership) -> None:  # noqa: C901
    """Remove only the unchanged, empty nodes proven to be created here.

    The rollback is intentionally non-recursive.  Any identity change,
    unexpected SQLite sidecar, or nonempty artifact root is concurrent/user
    evidence, so the complete pair is preserved rather than guessed at.
    """

    try:
        if not ownership.owned:
            return
        catalog = ownership.catalog
        artifacts = ownership.artifact_root
        if catalog is not None and not _same_owned_node(catalog, directory=False):
            return
        if artifacts is not None and not _same_owned_node(artifacts, directory=True):
            return
        if catalog is not None:
            for suffix in ("-wal", "-shm", "-journal"):
                if not _missing(Path(f"{catalog.path}{suffix}")):
                    return
        if artifacts is not None:
            try:
                with os.scandir(artifacts.path) as entries:
                    if next(entries, None) is not None:
                        return
            except OSError:
                return
        if catalog is not None:
            try:
                catalog.path.unlink()
            except OSError:
                return
        if artifacts is not None:
            try:
                artifacts.path.rmdir()
            except OSError:
                pass
    finally:
        _release_fresh_storage_ownership(ownership)


def _build_storage_foundation(
    catalog_path: Path,
    artifact_root: Path,
) -> _StorageFoundation:
    """Create the two final roots as one rollback-safe Bootstrap boundary."""

    from sciretriever.storage.files.paths import StorageRoot
    from sciretriever.storage.files.reader import VerifiedReader
    from sciretriever.storage.files.store import ArtifactStore
    from sciretriever.storage.sqlite.engine import CatalogEngine, create_or_open_catalog

    fresh_pair = _missing(catalog_path) and _missing(artifact_root)
    owned_artifacts: _OwnedNode | None = None
    owned_catalog: _OwnedNode | None = None
    try:
        if fresh_pair:
            try:
                os.mkdir(artifact_root, 0o700)
            except FileExistsError:
                fresh_pair = False
            else:
                owned_artifacts = _owned_node(artifact_root, directory=True)
        storage_root = StorageRoot(artifact_root)

        if fresh_pair:

            def catalog_checkpoint(name: str) -> None:
                nonlocal owned_catalog
                if name == "after-publication":
                    owned_catalog = _owned_node(catalog_path, directory=False)

            with create_or_open_catalog(catalog_path, checkpoint=catalog_checkpoint):
                pass
            engine = CatalogEngine.open(catalog_path)
        else:
            engine = CatalogEngine(catalog_path)
        artifact_store = ArtifactStore(storage_root)
        verified_reader = VerifiedReader(storage_root)
    except BaseException:
        ownership = _FreshStorageOwnership(
            catalog=owned_catalog,
            artifact_root=owned_artifacts,
        )
        if owned_catalog is None and not _missing(catalog_path):
            # Publication happened but descriptor-bound ownership could not be
            # established.  Preserve both roots as concurrent/user evidence.
            _release_fresh_storage_ownership(ownership)
        else:
            _rollback_fresh_storage(ownership)
        raise
    return _StorageFoundation(
        engine=engine,
        storage_root=storage_root,
        artifact_store=artifact_store,
        verified_reader=verified_reader,
        ownership=_FreshStorageOwnership(
            catalog=owned_catalog,
            artifact_root=owned_artifacts,
        ),
    )


def _build_local_library_graph(
    configuration: Configuration,
    *,
    configure_process_logging: bool,
    logging_level: int,
) -> LocalLibraryObjectGraph:
    from sciretriever.entry.library import LibraryOperations
    from sciretriever.literature.api import LiteratureApi
    from sciretriever.literature.service import LiteratureService
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
    from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
    from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
    from sciretriever.storage.sqlite.literature_reader import LiteratureReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

    catalog_path = configuration.paths.catalog_path
    artifact_root = configuration.paths.artifact_root
    if catalog_path is None or artifact_root is None:
        raise BootstrapError("paths-not-ready")
    foundation = _build_storage_foundation(Path(catalog_path), Path(artifact_root))
    try:
        engine = foundation.engine
        writer = LiteratureWriter(engine)
        literature_api = LiteratureApi(
            LiteratureService(
                read_port=LiteraturePreconditionReader(engine, foundation.verified_reader),
                identity_port=writer,
                content_port=SqliteContentPublication(
                    engine,
                    foundation.artifact_store,
                    foundation.verified_reader,
                ),
                reference_port=writer,
                maintenance_port=writer,
                id_factory=_UuidLiteratureIds(),
                query_port=LiteratureReader(engine, foundation.verified_reader),
                artifact_read_port=LiteratureArtifactReader(engine, foundation.verified_reader),
            )
        )
        output = AtomicOutput(max_bytes=536_870_912)
        operations = LibraryOperations(literature=literature_api, output=output)
        graph = LocalLibraryObjectGraph(
            configuration=configuration,
            catalog_engine=engine,
            storage_root=foundation.storage_root,
            artifact_store=foundation.artifact_store,
            verified_reader=foundation.verified_reader,
            atomic_user_output=output,
            literature_api=literature_api,
            entry_api=_LocalLibraryEntry(operations),
        )
        if configure_process_logging:
            logger_state = _project_logger_state()
            try:
                from sciretriever.logging.api import configure_logging

                configure_logging(level=logging_level)
            except BaseException:
                _restore_project_logger(logger_state)
                raise
    except BaseException:
        _rollback_fresh_storage(foundation.ownership)
        raise
    _release_fresh_storage_ownership(foundation.ownership)
    return graph


def _build_scoped_storage(configuration: Configuration) -> _ScopedStorageComponents:
    from sciretriever.literature.api import LiteratureApi
    from sciretriever.literature.service import LiteratureService
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler
    from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
    from sciretriever.storage.sqlite.artifact_references import SqliteArtifactReferenceStore
    from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
    from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
    from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
    from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
    from sciretriever.storage.sqlite.literature_reader import LiteratureReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

    catalog_path = configuration.paths.catalog_path
    artifact_root = configuration.paths.artifact_root
    if catalog_path is None or artifact_root is None:
        raise BootstrapError("paths-not-ready")
    foundation = _build_storage_foundation(Path(catalog_path), Path(artifact_root))
    try:
        engine = foundation.engine
        writer = LiteratureWriter(engine)
        literature_api = LiteratureApi(
            LiteratureService(
                read_port=LiteraturePreconditionReader(engine, foundation.verified_reader),
                identity_port=writer,
                content_port=SqliteContentPublication(
                    engine,
                    foundation.artifact_store,
                    foundation.verified_reader,
                ),
                reference_port=writer,
                maintenance_port=writer,
                id_factory=_UuidLiteratureIds(),
                query_port=LiteratureReader(engine, foundation.verified_reader),
                artifact_read_port=LiteratureArtifactReader(engine, foundation.verified_reader),
            )
        )
        artifact_reconciler = ArtifactStoreReconciler(
            foundation.storage_root,
            SqliteArtifactReferenceStore(engine),
        )
        return _ScopedStorageComponents(
            foundation=foundation,
            atomic_user_output=AtomicOutput(max_bytes=536_870_912),
            write_admission=_CatalogWriteAdmission(engine.catalog_path, artifact_reconciler),
            discovery_repository=SqliteDiscoveryRepository(engine),
            entry_reader=SqliteEntryReader(engine, foundation.verified_reader),
            artifact_reconciler=artifact_reconciler,
            literature_api=literature_api,
            literature_writer=writer,
        )
    except BaseException:
        _rollback_fresh_storage(foundation.ownership)
        raise


def _finish_scoped_graph(
    storage: _ScopedStorageComponents,
    graph: object,
    *,
    configure_process_logging: bool,
    logging_level: int,
) -> object:
    try:
        if configure_process_logging:
            logger_state = _project_logger_state()
            try:
                from sciretriever.logging.api import configure_logging

                configure_logging(level=logging_level)
            except BaseException:
                _restore_project_logger(logger_state)
                raise
    except BaseException:
        _rollback_fresh_storage(storage.foundation.ownership)
        raise
    _release_fresh_storage_ownership(storage.foundation.ownership)
    return graph


__all__ = ()
