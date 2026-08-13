"""Consistent Catalog recheck for the complete current Analysis input.

The adapter distinguishes ordinary stale state from malformed current facts.
Missing Literature, primary PDF, or ParserResult facts are normal ``False``
results.  Duplicate, dangling, non-PDF, or internally inconsistent rows are
stable adapter failures and are never reported as mere staleness.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import NoReturn

from sciretriever.analysis.ports import ContentInputIdentity
from sciretriever.model.primitives import AssetId, LiteratureId, Sha256
from sciretriever.storage.files.paths import StoragePathError, content_addressed_reference

from .engine import CatalogEngine


class AnalysisCurrentInputError(RuntimeError):
    """Stable, path-free failure for an invalid current-input Catalog shape."""

    _MESSAGE = "analysis current input verification failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)

    def __repr__(self) -> str:
        return "<AnalysisCurrentInputError>"


def _fail() -> NoReturn:
    raise AnalysisCurrentInputError() from None


def _runtime_object(value: object) -> object:
    """Erase trusted static types before validating an external boundary."""

    return value


@dataclass(frozen=True, slots=True)
class _MetadataState:
    revision: int
    sha256: Sha256


@dataclass(frozen=True, slots=True)
class _PrimaryState:
    asset_id: AssetId
    sha256: Sha256


@dataclass(frozen=True, slots=True)
class _ParserState:
    result_sha256: Sha256


def _literature_id(value: object) -> LiteratureId:
    if type(value) is not str:
        _fail()
    try:
        return LiteratureId(value)
    except (TypeError, ValueError):
        _fail()


def _asset_id(value: object) -> AssetId:
    if type(value) is not str:
        _fail()
    try:
        return AssetId(value)
    except (TypeError, ValueError):
        _fail()


def _sha256(value: object) -> Sha256:
    if type(value) is not str:
        _fail()
    try:
        return Sha256(value)
    except (TypeError, ValueError):
        _fail()


def _positive_integer(value: object) -> int:
    if type(value) is not int or value <= 0:
        _fail()
    return value


def _metadata_state(
    connection: sqlite3.Connection,
    literature_id: LiteratureId,
) -> _MetadataState | None:
    rows = connection.execute(
        "SELECT l.literature_id,m.metadata_revision,m.metadata_sha256 "
        "FROM literatures l LEFT JOIN literature_metadata m "
        "ON m.literature_id=l.literature_id WHERE l.literature_id=?",
        (literature_id.root,),
    ).fetchall()
    if not rows:
        return None
    if len(rows) != 1 or len(rows[0]) != 3:
        _fail()
    row = rows[0]
    stored_literature_id = _literature_id(row[0])
    if stored_literature_id != literature_id or row[1] is None or row[2] is None:
        _fail()
    return _MetadataState(
        revision=_positive_integer(row[1]),
        sha256=_sha256(row[2]),
    )


def _primary_state(
    connection: sqlite3.Connection,
    literature_id: LiteratureId,
) -> _PrimaryState | None:
    rows = connection.execute(
        "SELECT la.asset_id,a.asset_id,a.sha256,a.size_bytes,a.media_type "
        "FROM literature_assets la LEFT JOIN assets a ON a.asset_id=la.asset_id "
        "WHERE la.literature_id=? AND la.role='primary-pdf'",
        (literature_id.root,),
    ).fetchall()
    if not rows:
        return None
    if len(rows) != 1 or len(rows[0]) != 5:
        _fail()
    row = rows[0]
    relation_asset_id = _asset_id(row[0])
    stored_asset_id = _asset_id(row[1])
    digest = _sha256(row[2])
    _positive_integer(row[3])
    if relation_asset_id != stored_asset_id or row[4] != "application/pdf":
        _fail()
    return _PrimaryState(asset_id=stored_asset_id, sha256=digest)


def _parser_state(
    connection: sqlite3.Connection,
    primary: _PrimaryState,
) -> _ParserState | None:
    rows = connection.execute(
        "SELECT source_asset_id,source_sha256,result_sha256,page_count,"
        "markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type "
        "FROM parser_results WHERE source_asset_id=?",
        (primary.asset_id.root,),
    ).fetchall()
    if not rows:
        return None
    if len(rows) != 1 or len(rows[0]) != 8:
        _fail()
    row = rows[0]
    source_asset_id = _asset_id(row[0])
    source_sha256 = _sha256(row[1])
    result_sha256 = _sha256(row[2])
    _positive_integer(row[3])
    if type(row[4]) is not str:
        _fail()
    markdown_sha256 = _sha256(row[5])
    markdown_byte_size = _positive_integer(row[6])
    if row[7] != "text/markdown":
        _fail()
    try:
        markdown_path = content_addressed_reference(markdown_sha256, markdown_byte_size)
    except (StoragePathError, TypeError, ValueError):
        _fail()
    if (
        source_asset_id != primary.asset_id
        or source_sha256 != primary.sha256
        or row[4] != markdown_path.root
    ):
        _fail()
    return _ParserState(result_sha256=result_sha256)


def _matches_current_input(
    connection: sqlite3.Connection,
    identity: ContentInputIdentity,
) -> bool:
    metadata = _metadata_state(connection, identity.literature_id)
    if metadata is None:
        return False
    primary = _primary_state(connection, identity.literature_id)
    if primary is None:
        return False
    parser = _parser_state(connection, primary)
    if parser is None:
        return False
    return (
        metadata.revision == identity.input_metadata_revision
        and metadata.sha256 == identity.input_metadata_sha256
        and primary.asset_id == identity.primary_asset_id
        and primary.sha256 == identity.primary_pdf_sha256
        and parser.result_sha256 == identity.parser_result_sha256
    )


class SqliteAnalysisCurrentInputs:
    """Implement Analysis's complete current-input CAS recheck."""

    __slots__ = ("_engine",)

    def __init__(self, engine: CatalogEngine) -> None:
        engine_value = _runtime_object(engine)
        if not isinstance(engine_value, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        self._engine = engine_value

    def __repr__(self) -> str:
        return "<SqliteAnalysisCurrentInputs>"

    def current_input_matches(self, identity: ContentInputIdentity) -> bool:
        identity_value = _runtime_object(identity)
        if not isinstance(identity_value, ContentInputIdentity):
            raise TypeError("identity must be a ContentInputIdentity")
        try:
            with self._engine.read_snapshot() as connection:
                result = _matches_current_input(connection, identity_value)
        except AnalysisCurrentInputError:
            raise
        except sqlite3.Error:
            _fail()
        except Exception:
            _fail()
        return result


__all__ = (
    "AnalysisCurrentInputError",
    "SqliteAnalysisCurrentInputs",
)
