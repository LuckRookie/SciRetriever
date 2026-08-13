"""Atomic Catalog cleanup after Analysis explicitly returns ``NoUsableContent``.

The adapter consumes Entry's closed CAS command and executes only a short
``BEGIN IMMEDIATE`` transaction. Physical orphan reclamation is deliberately
deferred to the enclosing operation's write-admission exit: a target-local
reconciliation could otherwise cross another worker's publication-before-
reference window in the same admitted completion operation.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Final, TypeAlias

from sciretriever.entry.ports import (
    NoUsableContentCleanupCommand,
    NoUsableContentCleanupFailure,
    NoUsableContentCleanupResult,
)
from sciretriever.literature.ports import (
    ReferenceCleanupDecision,
    fts5_index_text,
    literature_content_artifact,
)
from sciretriever.model.analysis import ArtifactRef, LiteratureContent
from sciretriever.model.literature import (
    ContentReferenceTextSupport,
    Reference,
    ReferenceSupport,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.storage.files.paths import content_addressed_reference

from .engine import CatalogEngine
from .literature_preconditions import _current_metadata, _references, _supports
from .literature_writer import content_reference_closure_token

CleanupCheckpoint: TypeAlias = Callable[[str], None]

NO_USABLE_CONTENT_CLEANUP_FAILPOINTS: Final[tuple[str, ...]] = (
    "after-preconditions",
    "after-reference-cleanup",
    "after-content-cleanup",
    "after-parser-cleanup",
    "after-primary-cleanup",
    "after-fts-cleanup",
    "after-orphan-catalog-cleanup",
    "before-commit",
)
_FAILPOINTS = frozenset(NO_USABLE_CONTENT_CLEANUP_FAILPOINTS)


class NoUsableContentCleanupStorageError(RuntimeError):
    """Path-free internal taxonomy before translation to Entry's failure."""


class NoUsableContentCleanupConflictError(NoUsableContentCleanupStorageError):
    """The offered current-facts closure is stale or incomplete."""


class NoUsableContentCleanupIntegrityError(NoUsableContentCleanupStorageError):
    """The Catalog or command contains an impossible cleanup binding."""


class SqliteNoUsableContentCleanup:
    """Implement Entry's all-or-nothing managed-current-PDF cleanup Port."""

    __slots__ = ("_engine", "_failpoint")

    def __init__(
        self,
        engine: object,
        *,
        failpoint: CleanupCheckpoint | None = None,
    ) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if failpoint is not None and not callable(failpoint):
            raise TypeError("failpoint must be callable")
        self._engine = engine
        self._failpoint = failpoint

    def cleanup_no_usable_content(
        self,
        command: NoUsableContentCleanupCommand,
    ) -> NoUsableContentCleanupResult:
        if not isinstance(command, NoUsableContentCleanupCommand):
            raise TypeError("command must be a NoUsableContentCleanupCommand")
        try:
            with self._engine.write_transaction() as connection:
                retired = _require_current_closure(connection, command)
                self._checkpoint("after-preconditions")
                _apply_reference_cleanup(connection, command)
                self._checkpoint("after-reference-cleanup")
                _delete_current_content(connection, command)
                self._checkpoint("after-content-cleanup")
                _delete_parser_result(connection, command)
                self._checkpoint("after-parser-cleanup")
                _delete_primary_relation(connection, command)
                self._checkpoint("after-primary-cleanup")
                _clear_fts_content(connection, command)
                self._checkpoint("after-fts-cleanup")
                _retire_unreferenced_rows(
                    connection,
                    command.primary_asset.asset_id.root,
                    retired,
                )
                self._checkpoint("after-orphan-catalog-cleanup")
                self._checkpoint("before-commit")
        except NoUsableContentCleanupFailure:
            raise
        except NoUsableContentCleanupConflictError:
            raise NoUsableContentCleanupFailure(_stale_failure()) from None
        except Exception:
            raise NoUsableContentCleanupFailure(_storage_failure()) from None
        return NoUsableContentCleanupResult(
            literature_id=command.literature_id,
            primary_asset_id=command.primary_asset.asset_id,
        )

    def _checkpoint(self, name: str) -> None:
        if name not in _FAILPOINTS:
            raise NoUsableContentCleanupIntegrityError()
        if self._failpoint is None:
            return
        try:
            self._failpoint(name)
        except Exception as error:
            raise NoUsableContentCleanupStorageError() from error


class _RetiredRows:
    __slots__ = ("artifact_paths", "provenance_ids")

    def __init__(self, artifact_paths: set[str], provenance_ids: set[str]) -> None:
        self.artifact_paths = artifact_paths
        self.provenance_ids = provenance_ids


def _require_current_closure(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
) -> _RetiredRows:
    identity = connection.execute(
        "SELECT l.meta_literature_id,m.metadata_revision,m.metadata_sha256 "
        "FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id "
        "WHERE l.literature_id=?",
        (command.literature_id.root,),
    ).fetchone()
    if identity is None or tuple(identity) != (
        command.meta_literature_id.root,
        command.metadata_revision,
        command.metadata_sha256.root,
    ):
        raise NoUsableContentCleanupConflictError()
    exhaustion = connection.execute(
        "SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
        (command.literature_id.root,),
    ).fetchone()
    if exhaustion is not None:
        raise NoUsableContentCleanupConflictError()

    asset = command.primary_asset
    relation = command.primary_relation
    primary_rows = connection.execute(
        "SELECT la.literature_asset_id,la.asset_id,la.provenance_id,la.source_url,"
        "a.sha256,a.size_bytes,a.media_type,a.relative_path,"
        "o.sha256,o.byte_size,o.media_type,o.relative_path "
        "FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id "
        "JOIN artifact_objects o ON o.relative_path=a.relative_path "
        "WHERE la.literature_id=? AND la.role='primary-pdf'",
        (command.literature_id.root,),
    ).fetchall()
    expected_primary = (
        relation.literature_asset_id.root,
        asset.asset_id.root,
        relation.provenance.provenance_id.root,
        relation.source_url,
        asset.sha256.root,
        asset.size_bytes,
        asset.media_type,
        asset.path.root,
        asset.sha256.root,
        asset.size_bytes,
        asset.media_type,
        asset.path.root,
    )
    if len(primary_rows) != 1 or tuple(primary_rows[0]) != expected_primary:
        raise NoUsableContentCleanupConflictError()
    _require_provenance(connection, relation.provenance)

    parser = command.parser_result
    parser_row = connection.execute(
        "SELECT source_sha256,result_sha256,page_count,markdown_artifact_path,"
        "markdown_sha256,markdown_byte_size,markdown_media_type,provenance_id,"
        "parser_version,mode,model_identity FROM parser_results WHERE source_asset_id=?",
        (asset.asset_id.root,),
    ).fetchone()
    expected_parser = (
        parser.source_sha256.root,
        parser.result_sha256.root,
        parser.page_count,
        _artifact_path(parser.markdown.sha256.root, parser.markdown.byte_size),
        parser.markdown.sha256.root,
        parser.markdown.byte_size,
        parser.markdown.media_type,
        parser.provenance.provenance.provenance_id.root,
        parser.provenance.parser_version,
        parser.provenance.mode,
        parser.provenance.model_identity,
    )
    if parser_row is None or tuple(parser_row) != expected_parser:
        raise NoUsableContentCleanupConflictError()
    _require_artifact(connection, parser.markdown)
    _require_provenance(connection, parser.provenance.provenance)
    resource_rows = tuple(
        tuple(row)
        for row in connection.execute(
            "SELECT ordinal,reference,artifact_path,artifact_sha256,artifact_byte_size,"
            "artifact_media_type FROM parser_result_resources WHERE source_asset_id=? "
            "ORDER BY ordinal",
            (asset.asset_id.root,),
        ).fetchall()
    )
    expected_resources = tuple(
        (
            ordinal,
            resource.reference,
            _artifact_path(resource.artifact.sha256.root, resource.artifact.byte_size),
            resource.artifact.sha256.root,
            resource.artifact.byte_size,
            resource.artifact.media_type,
        )
        for ordinal, resource in enumerate(parser.resources)
    )
    if resource_rows != expected_resources:
        raise NoUsableContentCleanupConflictError()
    for resource in parser.resources:
        _require_artifact(connection, resource.artifact)

    artifact_paths = {
        asset.path.root,
        str(parser_row[3]),
        *(str(row[2]) for row in resource_rows),
    }
    provenance_ids = {
        relation.provenance.provenance_id.root,
        parser.provenance.provenance.provenance_id.root,
    }
    _require_current_content(connection, command, artifact_paths, provenance_ids)
    return _RetiredRows(artifact_paths, provenance_ids)


def _require_current_content(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
    artifact_paths: set[str],
    provenance_ids: set[str],
) -> None:
    row = connection.execute(
        "SELECT literature_content_sha256,metadata_revision,metadata_sha256,primary_asset_id,"
        "primary_asset_sha256,parser_result_sha256,structured_artifact_path,"
        "structured_artifact_sha256,structured_artifact_byte_size,"
        "structured_artifact_media_type,markdown_artifact_path,markdown_artifact_sha256,"
        "markdown_artifact_byte_size,markdown_artifact_media_type,analysis_provenance_id "
        "FROM literature_contents "
        "WHERE literature_id=?",
        (command.literature_id.root,),
    ).fetchone()
    content = command.current_content
    lineage = command.current_content_lineage
    if content is None:
        if row is not None:
            raise NoUsableContentCleanupConflictError()
        _require_fts_projection(connection, command, expected_content_body="")
        return
    if row is None or lineage is None:
        raise NoUsableContentCleanupConflictError()
    structured = literature_content_artifact(content)
    expected = (
        content.literature_content_sha256.root,
        content.metadata_revision,
        content.metadata_sha256.root,
        lineage.primary_asset_id.root,
        lineage.primary_pdf_sha256.root,
        lineage.parser_result_sha256.root,
        _artifact_path(structured.sha256.root, structured.byte_size),
        structured.sha256.root,
        structured.byte_size,
        structured.media_type,
        _artifact_path(content.markdown.sha256.root, content.markdown.byte_size),
        content.markdown.sha256.root,
        content.markdown.byte_size,
        content.markdown.media_type,
        content.provenance.provenance_id.root,
    )
    if tuple(row) != expected:
        raise NoUsableContentCleanupConflictError()
    _require_artifact(connection, structured)
    _require_artifact(connection, content.markdown)
    _require_provenance(connection, content.provenance)
    _require_content_reference_texts(connection, content)
    _require_fts_projection(
        connection,
        command,
        expected_content_body=_content_search_body(content),
    )
    artifact_paths.update((str(row[6]), str(row[10])))
    provenance_ids.add(str(row[14]))


def _require_content_reference_texts(
    connection: sqlite3.Connection,
    content: LiteratureContent,
) -> None:
    rows = tuple(
        tuple(row)
        for row in connection.execute(
            "SELECT reference_index,reference_text "
            "FROM literature_content_reference_texts "
            "WHERE literature_content_sha256=? ORDER BY reference_index",
            (content.literature_content_sha256.root,),
        ).fetchall()
    )
    expected = tuple(enumerate(content.references))
    if rows != expected:
        raise NoUsableContentCleanupConflictError()


def _require_fts_projection(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
    *,
    expected_content_body: str,
) -> None:
    current = _current_metadata(connection, command.literature_id.root)
    if current is None:
        raise NoUsableContentCleanupConflictError()
    metadata, revision, digest = current
    if revision != command.metadata_revision or digest != command.metadata_sha256:
        raise NoUsableContentCleanupConflictError()
    rows = connection.execute(
        "SELECT literature_id,title,abstract,authors,affiliations,identifiers,keywords,"
        "venue,publisher,volume,issue,pages,content_body "
        "FROM literature_search_fts WHERE literature_id=?",
        (command.literature_id.root,),
    ).fetchall()
    if len(rows) != 1 or tuple(rows[0]) != _fts_projection(
        command.literature_id.root,
        metadata,
        expected_content_body,
    ):
        raise NoUsableContentCleanupConflictError()


def _fts_projection(
    literature_id: str,
    metadata: LiteratureMetadata,
    content_body: str,
) -> tuple[str, ...]:
    authors = tuple(
        value
        for author in metadata.authors
        for value in (
            author.display_name,
            author.given_name,
            author.family_name,
            author.orcid,
        )
        if value is not None
    )
    affiliations = tuple(
        value
        for author in metadata.authors
        for affiliation in author.affiliations
        for value in (affiliation.name, affiliation.ror)
        if value is not None
    )
    identifiers = tuple(
        value
        for identifier in metadata.identifiers
        for value in (identifier.namespace, identifier.value)
    )
    return (
        literature_id,
        fts5_index_text(metadata.title or ""),
        fts5_index_text(metadata.abstract or ""),
        _search_text(authors),
        _search_text(affiliations),
        _search_text(identifiers),
        _search_text(metadata.keywords),
        fts5_index_text(metadata.venue or ""),
        fts5_index_text(metadata.publisher or ""),
        fts5_index_text(metadata.volume or ""),
        fts5_index_text(metadata.issue or ""),
        fts5_index_text(metadata.pages or ""),
        content_body,
    )


def _search_text(values: tuple[str, ...]) -> str:
    return "\n".join(normalized for value in values if (normalized := fts5_index_text(value)))


def _content_search_body(content: LiteratureContent) -> str:
    values: list[str] = []
    for section in content.sections:
        if section.title is not None:
            values.append(section.title)
        if section.markdown:
            values.append(section.markdown)
        for subsection in section.subsections:
            values.extend((subsection.title, subsection.markdown))
    return _search_text(tuple(values))


def _require_artifact(
    connection: sqlite3.Connection,
    descriptor: ArtifactRef | ParserArtifactRef,
) -> None:
    path = content_addressed_reference(descriptor.sha256, descriptor.byte_size).root
    row = connection.execute(
        "SELECT sha256,byte_size,media_type,relative_path "
        "FROM artifact_objects WHERE relative_path=?",
        (path,),
    ).fetchone()
    if row is None or tuple(row) != (
        descriptor.sha256.root,
        descriptor.byte_size,
        descriptor.media_type,
        path,
    ):
        raise NoUsableContentCleanupConflictError()


def _require_provenance(
    connection: sqlite3.Connection,
    provenance: Provenance,
) -> None:
    row = connection.execute(
        "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,"
        "input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
        (provenance.provenance_id.root,),
    ).fetchone()
    expected = (
        provenance.provenance_id.root,
        provenance.source_kind.value,
        provenance.source_name,
        provenance.source_record_id,
        provenance.observed_at.root,
        None if provenance.input_sha256 is None else provenance.input_sha256.root,
        None if provenance.parameters_sha256 is None else provenance.parameters_sha256.root,
    )
    if row is None or tuple(row) != expected:
        raise NoUsableContentCleanupConflictError()


def _apply_reference_cleanup(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
) -> None:
    content = command.current_content
    if content is None:
        return
    cleanup = command.reference_cleanup
    token = command.reference_closure_token
    if cleanup is None or token is None:
        raise NoUsableContentCleanupIntegrityError()
    current_references = _references(connection, source_id=command.literature_id.root)
    current_supports = _supports(connection, current_references)
    current_token = content_reference_closure_token(
        command.literature_id,
        current_references,
        current_supports,
    )
    if current_token != token:
        raise NoUsableContentCleanupConflictError()
    _require_reference_decision(cleanup, current_references, current_supports)
    _execute_reference_cleanup(connection, command, cleanup)
    remaining = connection.execute(
        "SELECT 1 FROM content_reference_text_supports s "
        "JOIN literature_references r ON r.reference_id=s.reference_id "
        "WHERE r.source_literature_id=? AND s.literature_content_sha256=? LIMIT 1",
        (command.literature_id.root, content.literature_content_sha256.root),
    ).fetchone()
    if remaining is not None:
        raise NoUsableContentCleanupConflictError()


def _execute_reference_cleanup(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
    cleanup: ReferenceCleanupDecision,
) -> None:
    affected_reference_ids: set[str] = set()
    for support in cleanup.removed_supports:
        source = support.source
        assert isinstance(source, ContentReferenceTextSupport)
        cursor = connection.execute(
            "DELETE FROM content_reference_text_supports WHERE reference_id=? "
            "AND literature_content_sha256=? AND reference_index=?",
            (
                support.reference_id.root,
                source.literature_content_sha256.root,
                source.reference_index,
            ),
        )
        if cursor.rowcount != 1:
            raise NoUsableContentCleanupConflictError()
        affected_reference_ids.add(support.reference_id.root)
    deleted_ids = {item.root for item in cleanup.deleted_reference_ids}
    for reference_id in cleanup.deleted_reference_ids:
        if _support_count(connection, reference_id.root) != 0:
            raise NoUsableContentCleanupConflictError()
        cursor = connection.execute(
            "DELETE FROM literature_references WHERE reference_id=? AND source_literature_id=?",
            (reference_id.root, command.literature_id.root),
        )
        if cursor.rowcount != 1:
            raise NoUsableContentCleanupConflictError()
    for reference_id in affected_reference_ids - deleted_ids:
        if _support_count(connection, reference_id) == 0:
            raise NoUsableContentCleanupConflictError()


def _require_reference_decision(
    cleanup: ReferenceCleanupDecision,
    references: tuple[Reference, ...],
    supports: tuple[ReferenceSupport, ...],
) -> None:
    if cleanup.decision == "rejected":
        raise NoUsableContentCleanupIntegrityError()
    removed_supports = tuple(
        support
        for support in supports
        if isinstance(support.source, ContentReferenceTextSupport)
        and support.source.literature_content_sha256 == cleanup.old_content_sha256
    )
    if cleanup.removed_supports != removed_supports:
        raise NoUsableContentCleanupConflictError()

    removed_values = {support.model_dump_json() for support in removed_supports}
    remaining_reference_ids = {
        support.reference_id
        for support in supports
        if support.model_dump_json() not in removed_values
    }
    affected_reference_ids = {support.reference_id for support in removed_supports}
    deleted_reference_ids = tuple(
        reference.reference_id
        for reference in references
        if reference.reference_id in affected_reference_ids
        and reference.reference_id not in remaining_reference_ids
    )
    if cleanup.deleted_reference_ids != deleted_reference_ids:
        raise NoUsableContentCleanupConflictError()
    expected_decision = "cleaned" if removed_supports or deleted_reference_ids else "unchanged"
    if cleanup.decision != expected_decision:
        raise NoUsableContentCleanupConflictError()


def _delete_current_content(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
) -> None:
    content = command.current_content
    if content is None:
        return
    cursor = connection.execute(
        "DELETE FROM literature_contents WHERE literature_id=? AND literature_content_sha256=?",
        (command.literature_id.root, content.literature_content_sha256.root),
    )
    if cursor.rowcount != 1:
        raise NoUsableContentCleanupConflictError()
    shared = connection.execute(
        "SELECT 1 FROM literature_contents WHERE literature_content_sha256=? LIMIT 1",
        (content.literature_content_sha256.root,),
    ).fetchone()
    if shared is None:
        cursor = connection.execute(
            "DELETE FROM literature_content_reference_texts WHERE literature_content_sha256=?",
            (content.literature_content_sha256.root,),
        )
        if cursor.rowcount != len(content.references):
            raise NoUsableContentCleanupConflictError()


def _delete_parser_result(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
) -> None:
    resource_count = len(command.parser_result.resources)
    if resource_count:
        cursor = connection.execute(
            "DELETE FROM parser_result_resources WHERE source_asset_id=?",
            (command.primary_asset.asset_id.root,),
        )
        if cursor.rowcount != resource_count:
            raise NoUsableContentCleanupConflictError()
    cursor = connection.execute(
        "DELETE FROM parser_results WHERE source_asset_id=? AND result_sha256=?",
        (command.primary_asset.asset_id.root, command.parser_result.result_sha256.root),
    )
    if cursor.rowcount != 1:
        raise NoUsableContentCleanupConflictError()


def _delete_primary_relation(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
) -> None:
    cursor = connection.execute(
        "DELETE FROM literature_assets WHERE literature_asset_id=? AND literature_id=? "
        "AND asset_id=? AND role='primary-pdf'",
        (
            command.primary_relation.literature_asset_id.root,
            command.literature_id.root,
            command.primary_asset.asset_id.root,
        ),
    )
    if cursor.rowcount != 1:
        raise NoUsableContentCleanupConflictError()
    cursor = connection.execute(
        "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
        (command.literature_id.root,),
    )
    if cursor.rowcount != 0:
        raise NoUsableContentCleanupConflictError()


def _clear_fts_content(
    connection: sqlite3.Connection,
    command: NoUsableContentCleanupCommand,
) -> None:
    rows = connection.execute(
        "SELECT rowid,content_body FROM literature_search_fts WHERE literature_id=?",
        (command.literature_id.root,),
    ).fetchall()
    if len(rows) != 1:
        raise NoUsableContentCleanupIntegrityError()
    expected_body = (
        "" if command.current_content is None else _content_search_body(command.current_content)
    )
    if str(rows[0][1]) != expected_body:
        raise NoUsableContentCleanupConflictError()
    cursor = connection.execute(
        "UPDATE literature_search_fts SET content_body='' WHERE rowid=? AND content_body=?",
        (rows[0][0], expected_body),
    )
    if cursor.rowcount != 1:
        raise NoUsableContentCleanupConflictError()


def _retire_unreferenced_rows(
    connection: sqlite3.Connection,
    primary_asset_id: str,
    retired: _RetiredRows,
) -> None:
    # The exact Asset is retired only after its final formal relation is gone.
    # Parser/content rows have already been removed above.
    asset_referenced = connection.execute(
        "SELECT 1 FROM literature_assets WHERE asset_id=? LIMIT 1",
        (primary_asset_id,),
    ).fetchone()
    cursor = connection.execute(
        "DELETE FROM assets WHERE asset_id=? AND NOT EXISTS("
        "SELECT 1 FROM literature_assets WHERE asset_id=?)",
        (primary_asset_id, primary_asset_id),
    )
    expected_asset_deletes = 1 if asset_referenced is None else 0
    if cursor.rowcount != expected_asset_deletes:
        raise NoUsableContentCleanupConflictError()
    for path in sorted(retired.artifact_paths):
        if _artifact_is_referenced(connection, path):
            continue
        cursor = connection.execute(
            "DELETE FROM artifact_objects WHERE relative_path=?",
            (path,),
        )
        if cursor.rowcount != 1:
            raise NoUsableContentCleanupConflictError()
    for provenance_id in sorted(retired.provenance_ids):
        if _provenance_is_referenced(connection, provenance_id):
            continue
        cursor = connection.execute(
            "DELETE FROM provenances WHERE provenance_id=?",
            (provenance_id,),
        )
        if cursor.rowcount != 1:
            raise NoUsableContentCleanupConflictError()


def _artifact_is_referenced(connection: sqlite3.Connection, path: str) -> bool:
    row = connection.execute(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE relative_path=?) OR "
        "EXISTS(SELECT 1 FROM parser_results WHERE markdown_artifact_path=?) OR "
        "EXISTS(SELECT 1 FROM parser_result_resources WHERE artifact_path=?) OR "
        "EXISTS(SELECT 1 FROM literature_contents WHERE structured_artifact_path=? "
        "OR markdown_artifact_path=?)",
        (path, path, path, path, path),
    ).fetchone()
    if row is None or type(row[0]) is not int or row[0] not in {0, 1}:
        raise NoUsableContentCleanupIntegrityError()
    return bool(row[0])


def _provenance_is_referenced(connection: sqlite3.Connection, provenance_id: str) -> bool:
    row = connection.execute(
        "SELECT EXISTS(SELECT 1 FROM metadata_observations WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM provider_relation_observations WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM literature_assets WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM parser_results WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM literature_contents WHERE analysis_provenance_id=?)",
        (provenance_id,) * 5,
    ).fetchone()
    if row is None or type(row[0]) is not int or row[0] not in {0, 1}:
        raise NoUsableContentCleanupIntegrityError()
    return bool(row[0])


def _support_count(connection: sqlite3.Connection, reference_id: str) -> int:
    row = connection.execute(
        "SELECT (SELECT count(*) FROM provider_relation_reference_supports WHERE reference_id=?) "
        "+ (SELECT count(*) FROM metadata_reference_text_supports WHERE reference_id=?) "
        "+ (SELECT count(*) FROM content_reference_text_supports WHERE reference_id=?)",
        (reference_id, reference_id, reference_id),
    ).fetchone()
    if row is None or type(row[0]) is not int:
        raise NoUsableContentCleanupIntegrityError()
    return int(row[0])


def _artifact_path(sha256: str, byte_size: int) -> str:
    from sciretriever.model.primitives import Sha256

    return content_addressed_reference(Sha256(sha256), byte_size).root


def _stale_failure() -> StableFailure:
    return StableFailure(
        code="no-usable-content-cleanup-stale",
        reason="The managed PDF closure changed before cleanup committed.",
        action="Refresh this Literature and retry content completion.",
        retryable=False,
    )


def _storage_failure() -> StableFailure:
    return StableFailure(
        code="no-usable-content-cleanup-failed",
        reason="The managed PDF closure could not be removed atomically.",
        action="Check the local catalog and retry content completion.",
        retryable=True,
    )


__all__ = (
    "NO_USABLE_CONTENT_CLEANUP_FAILPOINTS",
    "NoUsableContentCleanupConflictError",
    "NoUsableContentCleanupIntegrityError",
    "NoUsableContentCleanupStorageError",
    "SqliteNoUsableContentCleanup",
)
