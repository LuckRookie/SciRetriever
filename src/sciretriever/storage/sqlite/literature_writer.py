"""SQLite publication adapter for Literature-owned facts.

The Literature feature owns the decisions represented by the command models in
``sciretriever.literature.ports``.  This module only performs the short,
transactional translation of those already validated values into the
relationship schema.  It intentionally contains no identity matching,
metadata precedence, status derivation, parser/LLM work, or filesystem I/O.

Rows which represent source observations and technical artifacts are
immutable.  Replaying the same public Model is accepted, while reusing an ID
for a different value is rejected.  Current metadata, current ParserResult
and current LiteratureContent are replaceable projections; their complete
replacement is still one SQLite transaction.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import TypeAlias, TypeVar, cast

from sciretriever.literature.ports import (
    ContentAcceptanceReplacement,
    ContentPublicationCommand,
    ContentReferenceClosureToken,
    CurrentLiteratureFacts,
    FallbackIdentityIndex,
    IdentityObservationPublicationCommand,
    LiteratureDeletionCommand,
    LiteratureIdentityToken,
    LiteratureObservation,
    MetaLiteratureIdentityToken,
    ReferenceCleanupDecision,
    ReferencePublicationCommand,
    ReferenceSupportAppendCommand,
    StalePreconditionError,
    UserObservationIndex,
    analysis_input_sha256,
    content_reference_closure_token,
    fts5_index_text,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.model.acquisition import (
    Asset,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
)
from sciretriever.model.analysis import LiteratureContent
from sciretriever.model.literature import (
    Affiliation,
    Author,
    ContentReferenceTextSupport,
    Identifier,
    Literature,
    LiteratureStatus,
    MetadataReferenceTextSupport,
    MetaLiterature,
    ProviderRelationSupport,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import (
    MetadataObservation,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    Sha256,
    SourceKind,
)
from sciretriever.model.provenance import Provenance

from .engine import CatalogEngine

Checkpoint: TypeAlias = Callable[[str], None]
_T = TypeVar("_T")


class LiteratureWriterError(RuntimeError):
    """Base class for path-free Literature publication failures."""

    _DEFAULT_MESSAGE = "literature publication failed"

    def __init__(self, _message: object | None = None) -> None:
        # Do not echo SQL, paths, arbitrary callback messages, or model data at
        # this boundary.  The caller can classify the exception by type.
        super().__init__(self._DEFAULT_MESSAGE)


class LiteratureWriterIntegrityError(LiteratureWriterError):
    """A supplied Model cannot be represented by the target schema."""

    _DEFAULT_MESSAGE = "literature publication value is invalid"


class LiteratureWriterConflictError(LiteratureWriterError):
    """An immutable row or current binding conflicts with the supplied value."""

    _DEFAULT_MESSAGE = "literature publication conflicts with existing facts"


def _text(value: object) -> str:
    root = getattr(value, "root", None)
    if isinstance(root, str):
        return root
    value_text = getattr(value, "value", None)
    if isinstance(value_text, str):
        return value_text
    if isinstance(value, str):
        return value
    return str(value)


def _enum(value: object) -> str:
    return _text(value)


def _require_model(value: object, expected: type[_T]) -> _T:
    if not isinstance(value, expected):
        raise LiteratureWriterIntegrityError()
    return value


def _require_public(value: object, expected: type[_T], message: str) -> _T:
    if not isinstance(value, expected):
        raise TypeError(message)
    return value


def _sha(value: Sha256) -> str:
    return _require_model(cast(object, value), Sha256).root


def _id(value: object, expected: type[object]) -> str:
    if not isinstance(value, expected):
        raise LiteratureWriterIntegrityError()
    return _text(value)


def _as_tuple(value: object, expected: type[_T]) -> tuple[_T, ...]:
    if not isinstance(value, tuple):
        raise LiteratureWriterIntegrityError()
    items = cast(tuple[object, ...], value)
    if not all(isinstance(item, expected) for item in items):
        raise LiteratureWriterIntegrityError()
    return cast(tuple[_T, ...], items)


def _metadata_scalar_values(metadata: object) -> tuple[object, ...]:
    from sciretriever.model.metadata import LiteratureMetadata

    if not isinstance(metadata, LiteratureMetadata):
        raise LiteratureWriterIntegrityError()
    return (
        metadata.title,
        metadata.abstract,
        metadata.publication_date,
        metadata.publication_year,
        metadata.document_type,
        metadata.language,
        metadata.venue,
        metadata.publisher,
        metadata.volume,
        metadata.issue,
        metadata.pages,
    )


def _author_values(author: Author) -> tuple[object, ...]:
    author = _require_model(cast(object, author), Author)
    _require_model(cast(object, author.kind), object)  # deliberately scalar-only
    return (
        _enum(author.kind),
        author.display_name,
        author.given_name,
        author.family_name,
        author.orcid,
    )


def _ensure_unique_metadata_children(metadata: object) -> None:
    from sciretriever.model.metadata import LiteratureMetadata

    if not isinstance(metadata, LiteratureMetadata):
        raise LiteratureWriterIntegrityError()
    identifiers = tuple(metadata.identifiers)
    if len({(_text(item.namespace), item.value) for item in identifiers}) != len(identifiers):
        raise LiteratureWriterIntegrityError()
    if len(set(metadata.keywords)) != len(metadata.keywords):
        raise LiteratureWriterIntegrityError()
    for author in metadata.authors:
        author = _require_model(cast(object, author), Author)
        if len({(_text(item.name), item.ror) for item in author.affiliations}) != len(
            author.affiliations
        ):
            raise LiteratureWriterIntegrityError()


def _provenance_values(provenance: Provenance) -> tuple[object, ...]:
    provenance = _require_model(cast(object, provenance), Provenance)
    return (
        _id(provenance.provenance_id, ProvenanceId),
        _enum(provenance.source_kind),
        provenance.source_name,
        provenance.source_record_id,
        _text(provenance.observed_at),
        None if provenance.input_sha256 is None else _sha(provenance.input_sha256),
        None if provenance.parameters_sha256 is None else _sha(provenance.parameters_sha256),
    )


def _provider_provenance_semantic_values(provenance: Provenance) -> tuple[object, ...]:
    provenance = _require_model(cast(object, provenance), Provenance)
    return (
        _enum(provenance.source_kind),
        provenance.source_name,
        provenance.source_record_id,
        None if provenance.input_sha256 is None else _sha(provenance.input_sha256),
        None if provenance.parameters_sha256 is None else _sha(provenance.parameters_sha256),
    )


def _stored_provenance_semantic_values(
    connection: sqlite3.Connection,
    provenance_id: str,
) -> tuple[object, ...] | None:
    row = connection.execute(
        "SELECT source_kind,source_name,source_record_id,input_sha256,parameters_sha256 "
        "FROM provenances WHERE provenance_id=?",
        (provenance_id,),
    ).fetchone()
    return None if row is None else tuple(row)


def _same_stored_provider_provenance(
    connection: sqlite3.Connection,
    provenance_id: str,
    provenance: Provenance,
) -> bool:
    if provenance.source_kind is not SourceKind.METADATA_PROVIDER:
        return False
    return _stored_provenance_semantic_values(
        connection,
        provenance_id,
    ) == _provider_provenance_semantic_values(provenance)


def _register_provenance(connection: sqlite3.Connection, provenance: Provenance) -> None:
    values = _provenance_values(provenance)
    row = connection.execute(
        "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,"
        "input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
        (values[0],),
    ).fetchone()
    if row is None:
        connection.execute(
            "INSERT INTO provenances(provenance_id,source_kind,source_name,source_record_id,"
            "observed_at,input_sha256,parameters_sha256) VALUES(?,?,?,?,?,?,?)",
            values,
        )
    elif tuple(row) != values:
        stored_semantics = (row[1], row[2], row[3], row[5], row[6])
        if (
            provenance.source_kind is not SourceKind.METADATA_PROVIDER
            or stored_semantics != _provider_provenance_semantic_values(provenance)
        ):
            raise LiteratureWriterConflictError()


def _metadata_child_rows(
    connection: sqlite3.Connection,
    table_prefix: str,
    owner_column: str,
    owner_id: str,
) -> tuple[
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
]:
    """Read all normalized metadata children for immutable replay checking."""

    authors = tuple(
        connection.execute(
            f"SELECT ordinal,kind,display_name,given_name,family_name,orcid "
            f"FROM {table_prefix}_authors WHERE {owner_column}=? ORDER BY ordinal",
            (owner_id,),
        ).fetchall()
    )
    author_affiliations = tuple(
        connection.execute(
            f"SELECT author_ordinal,affiliation_ordinal,name,ror FROM "
            f"{table_prefix}_author_affiliations WHERE {owner_column}=? "
            "ORDER BY author_ordinal,affiliation_ordinal",
            (owner_id,),
        ).fetchall()
    )
    identifiers = tuple(
        connection.execute(
            f"SELECT ordinal,namespace,value FROM {table_prefix}_identifiers "
            f"WHERE {owner_column}=? ORDER BY ordinal",
            (owner_id,),
        ).fetchall()
    )
    keywords = tuple(
        connection.execute(
            f"SELECT ordinal,keyword FROM {table_prefix}_keywords "
            f"WHERE {owner_column}=? ORDER BY ordinal",
            (owner_id,),
        ).fetchall()
    )
    return authors, author_affiliations, identifiers, keywords


def _metadata_model_rows(
    metadata: object,
) -> tuple[
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
]:
    from sciretriever.model.metadata import LiteratureMetadata

    if not isinstance(metadata, LiteratureMetadata):
        raise LiteratureWriterIntegrityError()
    _ensure_unique_metadata_children(metadata)
    authors = tuple(
        (index, *_author_values(author)) for index, author in enumerate(metadata.authors)
    )
    affiliations = tuple(
        (
            author_index,
            affiliation_index,
            affiliation.name,
            affiliation.ror,
        )
        for author_index, author in enumerate(metadata.authors)
        for affiliation_index, affiliation in enumerate(author.affiliations)
        if isinstance(cast(object, affiliation), Affiliation)
    )
    if len(affiliations) != sum(len(author.affiliations) for author in metadata.authors):
        raise LiteratureWriterIntegrityError()
    identifiers = tuple(
        (index, identifier.namespace, identifier.value)
        for index, identifier in enumerate(metadata.identifiers)
        if isinstance(cast(object, identifier), Identifier)
    )
    if len(identifiers) != len(metadata.identifiers):
        raise LiteratureWriterIntegrityError()
    keywords = tuple((index, keyword) for index, keyword in enumerate(metadata.keywords))
    return authors, affiliations, identifiers, keywords


def _insert_metadata_children(
    connection: sqlite3.Connection,
    *,
    owner: str,
    metadata: object,
    prefix: str,
    owner_column: str,
) -> None:
    authors, affiliations, identifiers, keywords = _metadata_model_rows(metadata)
    author_table = f"{prefix}_authors"
    affiliation_table = f"{prefix}_author_affiliations"
    identifier_table = f"{prefix}_identifiers"
    keyword_table = f"{prefix}_keywords"
    connection.executemany(
        f"INSERT INTO {author_table}({owner_column},ordinal,kind,display_name,given_name,"
        f"family_name,orcid) VALUES(?,?,?,?,?,?,?)",
        ((owner, *cast(tuple[object, ...], row)) for row in authors),
    )
    connection.executemany(
        f"INSERT INTO {affiliation_table}({owner_column},author_ordinal,"
        f"affiliation_ordinal,name,ror) VALUES(?,?,?,?,?)",
        ((owner, *cast(tuple[object, ...], row)) for row in affiliations),
    )
    connection.executemany(
        f"INSERT INTO {identifier_table}({owner_column},ordinal,namespace,value) VALUES(?,?,?,?)",
        ((owner, *cast(tuple[object, ...], row)) for row in identifiers),
    )
    connection.executemany(
        f"INSERT INTO {keyword_table}({owner_column},ordinal,keyword) VALUES(?,?,?)",
        ((owner, *cast(tuple[object, ...], row)) for row in keywords),
    )


def _metadata_matches(
    connection: sqlite3.Connection,
    *,
    table: str,
    owner_id: str,
    metadata: object,
    revision: int | None = None,
    digest: Sha256 | None = None,
) -> bool:
    scalar = connection.execute(
        f"SELECT metadata_revision,metadata_sha256,title,abstract,publication_date,"
        f"publication_year,document_type,language,venue,publisher,volume,issue,pages "
        f"FROM {table} WHERE literature_id=?",
        (owner_id,),
    ).fetchone()
    if scalar is None:
        return False
    expected = (
        revision,
        None if digest is None else _sha(digest),
        *_metadata_scalar_values(metadata),
    )
    if tuple(scalar) != expected:
        return False
    prefix = "literature_metadata" if table == "literature_metadata" else "metadata_observation"
    children = _metadata_child_rows(
        connection,
        prefix,
        "literature_id" if table == "literature_metadata" else "observation_id",
        owner_id,
    )
    return children == _metadata_model_rows(metadata)


def _store_current_metadata(
    connection: sqlite3.Connection,
    literature: Literature,
    revision: int,
    digest: Sha256,
) -> None:
    literature = _require_model(cast(object, literature), Literature)
    digest = _require_model(cast(object, digest), Sha256)
    if type(revision) is not int or revision < 1:
        raise LiteratureWriterIntegrityError()
    if metadata_sha256(literature.metadata) != digest:
        raise LiteratureWriterIntegrityError()
    literature_id = _id(literature.literature_id, LiteratureId)
    if _metadata_matches(
        connection,
        table="literature_metadata",
        owner_id=literature_id,
        metadata=literature.metadata,
        revision=revision,
        digest=digest,
    ):
        _refresh_search_metadata(connection, literature)
        return
    existing = connection.execute(
        "SELECT metadata_revision FROM literature_metadata WHERE literature_id=?",
        (literature_id,),
    ).fetchone()
    if existing is not None and (type(existing[0]) is not int or revision <= existing[0]):
        raise LiteratureWriterConflictError()
    values = (
        literature_id,
        revision,
        _sha(digest),
        *_metadata_scalar_values(literature.metadata),
    )
    if existing is None:
        connection.execute(
            "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,"
            "title,abstract,publication_date,publication_year,document_type,language,venue,"
            "publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            values,
        )
    else:
        connection.execute(
            "UPDATE literature_metadata SET metadata_revision=?,metadata_sha256=?,title=?,"
            "abstract=?,publication_date=?,publication_year=?,document_type=?,language=?,venue=?,"
            "publisher=?,volume=?,issue=?,pages=? WHERE literature_id=?",
            (*values[1:], literature_id),
        )
        for table in (
            "literature_metadata_authors",
            "literature_metadata_author_affiliations",
            "literature_metadata_identifiers",
            "literature_metadata_keywords",
        ):
            connection.execute(f"DELETE FROM {table} WHERE literature_id=?", (literature_id,))
    _insert_metadata_children(
        connection,
        owner=literature_id,
        metadata=literature.metadata,
        prefix="literature_metadata",
        owner_column="literature_id",
    )
    _refresh_search_metadata(connection, literature)


def _search_text(values: object) -> str:
    if not isinstance(values, tuple):
        raise LiteratureWriterIntegrityError()
    items = cast(tuple[object, ...], values)
    return "\n".join(
        normalized
        for value in items
        if isinstance(value, str) and value
        if (normalized := fts5_index_text(value))
    )


def _refresh_search_metadata(
    connection: sqlite3.Connection,
    literature: Literature,
) -> None:
    """Replace only the current-metadata portion of Literature's FTS row."""

    literature = _require_model(cast(object, literature), Literature)
    literature_id = _id(literature.literature_id, LiteratureId)
    metadata = literature.metadata
    existing = connection.execute(
        "SELECT content_body FROM literature_search_fts WHERE literature_id=?",
        (literature_id,),
    ).fetchall()
    if len(existing) > 1:
        raise LiteratureWriterIntegrityError()
    content_body = "" if not existing else str(existing[0][0])
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
        for value in (_text(identifier.namespace), identifier.value)
    )
    connection.execute(
        "DELETE FROM literature_search_fts WHERE literature_id=?",
        (literature_id,),
    )
    connection.execute(
        "INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,"
        "identifiers,keywords,venue,publisher,volume,issue,pages,content_body) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            literature_id,
            fts5_index_text(metadata.title or ""),
            fts5_index_text(metadata.abstract or ""),
            _search_text(authors),
            _search_text(affiliations),
            _search_text(identifiers),
            _search_text(tuple(metadata.keywords)),
            fts5_index_text(metadata.venue or ""),
            fts5_index_text(metadata.publisher or ""),
            fts5_index_text(metadata.volume or ""),
            fts5_index_text(metadata.issue or ""),
            fts5_index_text(metadata.pages or ""),
            content_body,
        ),
    )


def _content_search_body(content: LiteratureContent) -> str:
    content = _require_model(cast(object, content), LiteratureContent)
    values: list[str] = []
    for section in content.sections:
        if section.title is not None:
            values.append(section.title)
        if section.markdown:
            values.append(section.markdown)
        for subsection in section.subsections:
            values.extend((subsection.title, subsection.markdown))
    return _search_text(tuple(values))


def _refresh_search_content(
    connection: sqlite3.Connection,
    literature_id: str,
    content: LiteratureContent,
) -> None:
    rows = connection.execute(
        "SELECT rowid FROM literature_search_fts WHERE literature_id=?",
        (literature_id,),
    ).fetchall()
    if len(rows) != 1:
        raise LiteratureWriterIntegrityError()
    connection.execute(
        "UPDATE literature_search_fts SET content_body=? WHERE rowid=?",
        (_content_search_body(content), rows[0][0]),
    )


def _observation_metadata_values(observation: MetadataObservation) -> tuple[object, ...]:
    return (
        _id(observation.observation_id, ObservationId),
        _id(observation.provenance.provenance_id, ProvenanceId),
        None if observation.version_role is None else _enum(observation.version_role),
        observation.reference_count,
        observation.cited_by_count,
        *_metadata_scalar_values(observation.metadata),
    )


def _observation_children(
    connection: sqlite3.Connection, observation_id: str
) -> tuple[
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
]:
    metadata_children = _metadata_child_rows(
        connection,
        "metadata_observation",
        "observation_id",
        observation_id,
    )
    declared = tuple(
        connection.execute(
            "SELECT ordinal,keyword FROM metadata_observation_declared_keywords "
            "WHERE observation_id=? ORDER BY ordinal",
            (observation_id,),
        ).fetchall()
    )
    references = tuple(
        connection.execute(
            "SELECT reference_index,reference_text FROM metadata_observation_reference_texts "
            "WHERE observation_id=? ORDER BY reference_index",
            (observation_id,),
        ).fetchall()
    )
    hints = tuple(
        connection.execute(
            "SELECT hint_ordinal,url,kind,media_type,asset_role,version_role,access_status,license "
            "FROM metadata_observation_asset_hints WHERE observation_id=? ORDER BY hint_ordinal",
            (observation_id,),
        ).fetchall()
    )
    links = tuple(
        connection.execute(
            "SELECT link_ordinal,record_id FROM metadata_observation_version_links "
            "WHERE observation_id=? ORDER BY link_ordinal",
            (observation_id,),
        ).fetchall()
    )
    link_identifiers = tuple(
        connection.execute(
            "SELECT link_ordinal,ordinal,namespace,value "
            "FROM metadata_observation_version_link_identifiers WHERE observation_id=? "
            "ORDER BY link_ordinal,ordinal",
            (observation_id,),
        ).fetchall()
    )
    return metadata_children, declared, references, hints, links, link_identifiers


def _observation_model_children(
    observation: MetadataObservation,
) -> tuple[
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
    tuple[object, ...],
]:
    metadata_children = _metadata_model_rows(observation.metadata)
    declared = tuple((index, value) for index, value in enumerate(observation.declared_keywords))
    references = tuple((index, value) for index, value in enumerate(observation.reference_texts))
    hints = tuple(
        (
            index,
            hint.url,
            _enum(hint.kind),
            hint.media_type,
            None if hint.asset_role is None else _enum(hint.asset_role),
            None if hint.version_role is None else _enum(hint.version_role),
            hint.access_status,
            hint.license,
        )
        for index, hint in enumerate(observation.asset_hints)
    )
    links = tuple((index, link.record_id) for index, link in enumerate(observation.version_links))
    link_identifiers = tuple(
        (link_index, identifier_index, identifier.namespace, identifier.value)
        for link_index, link in enumerate(observation.version_links)
        for identifier_index, identifier in enumerate(link.identifiers)
    )
    return metadata_children, declared, references, hints, links, link_identifiers


def _store_observation(
    connection: sqlite3.Connection,
    link: LiteratureObservation,
) -> None:
    link = _require_model(cast(object, link), LiteratureObservation)
    observation = link.observation
    literature_id = _id(link.literature_id, LiteratureId)
    observation_id = _id(observation.observation_id, ObservationId)
    values = _observation_metadata_values(observation)
    _ensure_unique_metadata_children(observation.metadata)
    existing = connection.execute(
        "SELECT observation_id,provenance_id,version_role,reference_count,cited_by_count,title,"
        "abstract,publication_date,publication_year,document_type,language,venue,publisher,"
        "volume,issue,pages FROM metadata_observations WHERE observation_id=?",
        (observation_id,),
    ).fetchone()
    if existing is None:
        _register_provenance(connection, observation.provenance)
        connection.execute(
            "INSERT INTO metadata_observations(observation_id,provenance_id,version_role,"
            "reference_count,cited_by_count,title,abstract,publication_date,publication_year,"
            "document_type,language,venue,publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,"
            "?,?,?,?,?,?,?,?)",
            values,
        )
        _insert_metadata_children(
            connection,
            owner=observation_id,
            metadata=observation.metadata,
            prefix="metadata_observation",
            owner_column="observation_id",
        )
        _insert_observation_children(connection, observation)
    else:
        children_match = _observation_children(
            connection,
            observation_id,
        ) == _observation_model_children(observation)
        exact_match = tuple(existing) == values and children_match
        provider_replay = (
            observation.provenance.source_kind is SourceKind.METADATA_PROVIDER
            and tuple(existing[2:]) == values[2:]
            and children_match
            and _same_stored_provider_provenance(
                connection,
                str(existing[1]),
                observation.provenance,
            )
        )
        if not exact_match and not provider_replay:
            raise LiteratureWriterConflictError()
        if exact_match:
            _register_provenance(connection, observation.provenance)
    owner = connection.execute(
        "SELECT literature_id FROM literature_metadata_observations WHERE observation_id=?",
        (observation_id,),
    ).fetchone()
    if owner is None:
        connection.execute(
            "INSERT INTO literature_metadata_observations(literature_id,observation_id) "
            "VALUES(?,?)",
            (literature_id, observation_id),
        )
    elif owner[0] != literature_id:
        raise LiteratureWriterConflictError()


def _insert_observation_children(
    connection: sqlite3.Connection,
    observation: MetadataObservation,
) -> None:
    observation_id = _id(observation.observation_id, ObservationId)
    connection.executemany(
        "INSERT INTO metadata_observation_declared_keywords(observation_id,ordinal,keyword) "
        "VALUES(?,?,?)",
        (
            (observation_id, index, value)
            for index, value in enumerate(observation.declared_keywords)
        ),
    )
    connection.executemany(
        "INSERT INTO metadata_observation_reference_texts(observation_id,reference_index,"
        "reference_text) VALUES(?,?,?)",
        ((observation_id, index, value) for index, value in enumerate(observation.reference_texts)),
    )
    connection.executemany(
        "INSERT INTO metadata_observation_asset_hints(observation_id,hint_ordinal,url,kind,"
        "media_type,asset_role,version_role,access_status,license) VALUES(?,?,?,?,?,?,?,?,?)",
        (
            (
                observation_id,
                index,
                hint.url,
                _enum(hint.kind),
                hint.media_type,
                None if hint.asset_role is None else _enum(hint.asset_role),
                None if hint.version_role is None else _enum(hint.version_role),
                hint.access_status,
                hint.license,
            )
            for index, hint in enumerate(observation.asset_hints)
        ),
    )
    connection.executemany(
        "INSERT INTO metadata_observation_version_links(observation_id,link_ordinal,record_id) "
        "VALUES(?,?,?)",
        (
            (observation_id, index, link.record_id)
            for index, link in enumerate(observation.version_links)
        ),
    )
    connection.executemany(
        "INSERT INTO metadata_observation_version_link_identifiers(observation_id,link_ordinal,"
        "ordinal,namespace,value) VALUES(?,?,?,?,?)",
        (
            (observation_id, link_index, identifier_index, identifier.namespace, identifier.value)
            for link_index, link in enumerate(observation.version_links)
            for identifier_index, identifier in enumerate(link.identifiers)
        ),
    )


def _fallback_index_values(
    index: FallbackIdentityIndex,
) -> tuple[str, str]:
    index = _require_model(cast(object, index), FallbackIdentityIndex)
    return (
        _id(index.literature_id, LiteratureId),
        _sha(index.fallback_identity_sha256),
    )


def _replace_fallback_identity_index(
    connection: sqlite3.Connection,
    literature_id: str,
    index: FallbackIdentityIndex | None,
) -> None:
    if index is not None and _id(index.literature_id, LiteratureId) != literature_id:
        raise LiteratureWriterIntegrityError()
    connection.execute(
        "DELETE FROM literature_fallback_identity_indexes WHERE literature_id=?",
        (literature_id,),
    )
    if index is None:
        return
    owner, digest = _fallback_index_values(index)
    connection.execute(
        "INSERT INTO literature_fallback_identity_indexes("
        "literature_id,fallback_identity_sha256) VALUES(?,?)",
        (owner, digest),
    )


def _store_user_observation_index(
    connection: sqlite3.Connection,
    index: UserObservationIndex,
) -> None:
    index = _require_model(cast(object, index), UserObservationIndex)
    observation_id = _id(index.observation_id, ObservationId)
    values = (observation_id, _sha(index.semantic_sha256))
    source = connection.execute(
        "SELECT p.source_kind FROM metadata_observations o "
        "JOIN provenances p ON p.provenance_id=o.provenance_id "
        "WHERE o.observation_id=?",
        (observation_id,),
    ).fetchone()
    if source != ("user",):
        raise LiteratureWriterIntegrityError()
    existing = connection.execute(
        "SELECT observation_id,semantic_sha256 FROM user_observation_semantic_indexes "
        "WHERE observation_id=?",
        (observation_id,),
    ).fetchone()
    if existing is None:
        connection.execute(
            "INSERT INTO user_observation_semantic_indexes(observation_id,semantic_sha256) "
            "VALUES(?,?)",
            values,
        )
    elif tuple(existing) != values:
        raise LiteratureWriterConflictError()


def _token_values(token: LiteratureIdentityToken) -> tuple[str, str, int | None, str | None]:
    token = _require_model(cast(object, token), LiteratureIdentityToken)
    metadata_digest = cast(object, token.metadata_sha256)
    return (
        _id(token.literature_id, LiteratureId),
        _id(token.meta_literature_id, MetaLiteratureId),
        token.metadata_revision,
        None if metadata_digest is None else _sha(cast(Sha256, metadata_digest)),
    )


def _check_token(connection: sqlite3.Connection, token: LiteratureIdentityToken) -> bool:
    literature_id, meta_id, revision, digest = _token_values(token)
    row = connection.execute(
        "SELECT l.meta_literature_id,m.metadata_revision,m.metadata_sha256 "
        "FROM literatures l LEFT JOIN literature_metadata m ON m.literature_id=l.literature_id "
        "WHERE l.literature_id=?",
        (literature_id,),
    ).fetchone()
    actual = None if row is None else (row[0], row[1], row[2])
    expected = (meta_id, revision, digest)
    if actual != expected:
        raise StalePreconditionError()
    return row is not None


def _meta_token_values(token: MetaLiteratureIdentityToken) -> tuple[str, str, tuple[str, ...]]:
    token = _require_model(cast(object, token), MetaLiteratureIdentityToken)
    return (
        _id(token.meta_literature_id, MetaLiteratureId),
        _id(token.representative_literature_id, LiteratureId),
        tuple(_id(item, LiteratureId) for item in token.member_literature_ids),
    )


def _check_meta_token(connection: sqlite3.Connection, token: MetaLiteratureIdentityToken) -> None:
    meta_id, representative_id, expected_members = _meta_token_values(token)
    row = connection.execute(
        "SELECT representative_literature_id FROM meta_literatures WHERE meta_literature_id=?",
        (meta_id,),
    ).fetchone()
    members = tuple(
        item[0]
        for item in connection.execute(
            "SELECT literature_id FROM literatures WHERE meta_literature_id=? "
            "ORDER BY literature_id",
            (meta_id,),
        ).fetchall()
    )
    actual = None if row is None else (row[0], members)
    if actual != (representative_id, expected_members):
        raise StalePreconditionError()


def _ensure_literature_row(
    connection: sqlite3.Connection,
    literature: Literature,
) -> None:
    literature = _require_model(cast(object, literature), Literature)
    literature_id = _id(literature.literature_id, LiteratureId)
    meta_id = _id(literature.meta_literature_id, MetaLiteratureId)
    values = (literature_id, meta_id, _enum(literature.version_role))
    existing = connection.execute(
        "SELECT literature_id,meta_literature_id,version_role FROM literatures "
        "WHERE literature_id=?",
        (literature_id,),
    ).fetchone()
    if existing is None:
        connection.execute(
            "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?)",
            values,
        )
    elif tuple(existing) != values:
        connection.execute(
            "UPDATE literatures SET meta_literature_id=?,version_role=? WHERE literature_id=?",
            (meta_id, _enum(literature.version_role), literature_id),
        )


def _ensure_meta_row(connection: sqlite3.Connection, meta: MetaLiterature) -> None:
    meta = _require_model(cast(object, meta), MetaLiterature)
    values = (
        _id(meta.meta_literature_id, MetaLiteratureId),
        _id(meta.representative_literature_id, LiteratureId),
    )
    existing = connection.execute(
        "SELECT meta_literature_id,representative_literature_id FROM meta_literatures "
        "WHERE meta_literature_id=?",
        (values[0],),
    ).fetchone()
    if existing is None:
        connection.execute(
            "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) "
            "VALUES(?,?)",
            values,
        )
    elif tuple(existing) != values:
        connection.execute(
            "UPDATE meta_literatures SET representative_literature_id=? WHERE meta_literature_id=?",
            (values[1], values[0]),
        )


def _ensure_discovery_result(
    connection: sqlite3.Connection,
    run_id: str,
    meta_literature_id: str,
) -> None:
    if (
        connection.execute(
            "SELECT 1 FROM discovery_results WHERE discovery_run_id=? AND meta_literature_id=?",
            (run_id, meta_literature_id),
        ).fetchone()
        is None
    ):
        connection.execute(
            "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?)",
            (run_id, meta_literature_id),
        )


def _normalize_topic_discovery_cause_memberships(
    connection: sqlite3.Connection,
    placeholders: str,
    ordered_literature_ids: tuple[str, ...],
) -> set[tuple[str, str]]:
    moved_result_pairs: set[tuple[str, str]] = set()
    rows = connection.execute(
        "SELECT cause.discovery_run_id,cause.meta_literature_id,"
        "cause.metadata_observation_id,cause.actual_literature_id,"
        "actual.meta_literature_id,owner.literature_id "
        "FROM topic_discovery_causes AS cause "
        "LEFT JOIN literatures AS actual "
        "ON actual.literature_id=cause.actual_literature_id "
        "LEFT JOIN literature_metadata_observations AS owner "
        "ON owner.observation_id=cause.metadata_observation_id "
        f"WHERE cause.actual_literature_id IN ({placeholders})",
        ordered_literature_ids,
    ).fetchall()
    for row in rows:
        run_id, old_meta_id, observation_id, actual_id = map(str, row[:4])
        current_meta_id = row[4]
        if current_meta_id is None or row[5] != actual_id:
            raise LiteratureWriterIntegrityError()
        current_meta_id = str(current_meta_id)
        if current_meta_id == old_meta_id:
            continue
        _ensure_discovery_result(connection, run_id, current_meta_id)
        connection.execute(
            "UPDATE topic_discovery_causes SET meta_literature_id=? "
            "WHERE discovery_run_id=? AND meta_literature_id=? "
            "AND metadata_observation_id=? AND actual_literature_id=?",
            (current_meta_id, run_id, old_meta_id, observation_id, actual_id),
        )
        moved_result_pairs.add((run_id, old_meta_id))
    return moved_result_pairs


def _normalize_citation_discovery_cause_memberships(
    connection: sqlite3.Connection,
    placeholders: str,
    ordered_literature_ids: tuple[str, ...],
) -> set[tuple[str, str]]:
    moved_result_pairs: set[tuple[str, str]] = set()
    rows = connection.execute(
        "SELECT cause.discovery_run_id,cause.meta_literature_id,"
        "cause.source_literature_id,cause.target_literature_id,"
        "cause.actual_literature_id,cause.depth,actual.meta_literature_id "
        "FROM citation_discovery_causes AS cause "
        "LEFT JOIN literatures AS actual "
        "ON actual.literature_id=cause.actual_literature_id "
        f"WHERE cause.actual_literature_id IN ({placeholders})",
        ordered_literature_ids,
    ).fetchall()
    for row in rows:
        run_id, old_meta_id, source_id, target_id, actual_id = map(str, row[:5])
        depth = int(row[5])
        current_meta_id = row[6]
        if current_meta_id is None or actual_id not in {source_id, target_id}:
            raise LiteratureWriterIntegrityError()
        current_meta_id = str(current_meta_id)
        if current_meta_id == old_meta_id:
            continue
        _ensure_discovery_result(connection, run_id, current_meta_id)
        connection.execute(
            "UPDATE citation_discovery_causes SET meta_literature_id=? "
            "WHERE discovery_run_id=? AND meta_literature_id=? "
            "AND source_literature_id=? AND target_literature_id=? "
            "AND actual_literature_id=? AND depth=?",
            (
                current_meta_id,
                run_id,
                old_meta_id,
                source_id,
                target_id,
                actual_id,
                depth,
            ),
        )
        moved_result_pairs.add((run_id, old_meta_id))
    return moved_result_pairs


def _normalize_discovery_cause_memberships(
    connection: sqlite3.Connection,
    literature_ids: set[str],
    retired_meta_literature_ids: tuple[MetaLiteratureId, ...],
) -> None:
    """Keep DiscoveryResult/cause closure aligned with Literature Meta moves.

    ``actual_literature_id`` is an existing cause meaning normalized into a
    physical key, not a second history fact.  A Meta reorganization therefore
    moves each affected cause and its result row to that concrete endpoint's
    current Meta.  Existing target results are reused; old result rows are
    removed only after their last cause moved.  A retired Meta with a cause-
    less result cannot be mapped and is rejected rather than silently lost.
    """

    moved_result_pairs: set[tuple[str, str]] = set()
    if literature_ids:
        placeholders = ",".join("?" for _ in literature_ids)
        ordered_ids = tuple(sorted(literature_ids))
        moved_result_pairs.update(
            _normalize_topic_discovery_cause_memberships(
                connection,
                placeholders,
                ordered_ids,
            )
        )
        moved_result_pairs.update(
            _normalize_citation_discovery_cause_memberships(
                connection,
                placeholders,
                ordered_ids,
            )
        )

    for run_id, old_meta_id in sorted(moved_result_pairs):
        remaining = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM topic_discovery_causes "
            "WHERE discovery_run_id=? AND meta_literature_id=?) "
            "OR EXISTS(SELECT 1 FROM citation_discovery_causes "
            "WHERE discovery_run_id=? AND meta_literature_id=?)",
            (run_id, old_meta_id, run_id, old_meta_id),
        ).fetchone()
        if remaining == (0,):
            connection.execute(
                "DELETE FROM discovery_results WHERE discovery_run_id=? AND meta_literature_id=?",
                (run_id, old_meta_id),
            )

    for retired_id in retired_meta_literature_ids:
        retired_text = _id(retired_id, MetaLiteratureId)
        if (
            connection.execute(
                "SELECT 1 FROM discovery_results WHERE meta_literature_id=?",
                (retired_text,),
            ).fetchone()
            is not None
        ):
            raise LiteratureWriterIntegrityError()


def _check_command_shapes(command: object, expected: type[object]) -> None:
    if not isinstance(command, expected):
        raise TypeError(f"command must be {expected.__name__}")


def _run_write(
    engine: CatalogEngine,
    operation: Callable[[sqlite3.Connection], object],
) -> object:
    engine = _require_public(cast(object, engine), CatalogEngine, "engine must be a CatalogEngine")
    try:
        with engine.write_transaction() as connection:
            return operation(connection)
    except (LiteratureWriterError, StalePreconditionError):
        raise
    except sqlite3.IntegrityError as error:
        raise LiteratureWriterIntegrityError() from error
    except sqlite3.Error as error:
        raise LiteratureWriterError() from error


class LiteratureWriter:
    """Implement Literature's atomic publication Ports over ``CatalogEngine``."""

    def __init__(
        self,
        engine: CatalogEngine,
        *,
        failpoint: Checkpoint | None = None,
    ) -> None:
        engine = _require_public(
            cast(object, engine),
            CatalogEngine,
            "engine must be a CatalogEngine",
        )
        if failpoint is not None and not callable(failpoint):
            raise TypeError("failpoint must be callable")
        self._engine = engine
        self._failpoint = failpoint

    def _checkpoint(self, name: str) -> None:
        if self._failpoint is not None:
            self._failpoint(name)

    def publish_identity_and_observation(
        self,
        command: IdentityObservationPublicationCommand,
    ) -> None:
        _check_command_shapes(command, IdentityObservationPublicationCommand)

        def operation(connection: sqlite3.Connection) -> None:
            self._publish_identity(connection, command)
            self._checkpoint("identity-after")

        _run_write(self._engine, operation)

    def _publish_identity(  # noqa: C901
        self,
        connection: sqlite3.Connection,
        command: IdentityObservationPublicationCommand,
    ) -> None:
        literatures = _as_tuple(command.literatures, Literature)
        metas = _as_tuple(command.meta_literatures, MetaLiterature)
        links = _as_tuple(command.observations, LiteratureObservation)
        facts = _as_tuple(command.facts, CurrentLiteratureFacts)
        expected_tokens = _as_tuple(command.expected_tokens, LiteratureIdentityToken)
        expected_meta_tokens = _as_tuple(command.expected_meta_tokens, MetaLiteratureIdentityToken)
        fallback_indexes = _as_tuple(command.fallback_identity_indexes, FallbackIdentityIndex)
        user_indexes = _as_tuple(command.user_observation_indexes, UserObservationIndex)
        retired = _as_tuple(command.retired_meta_literature_ids, MetaLiteratureId)
        clear = _as_tuple(command.clear_automatic_pdf_exhaustion_for, LiteratureId)
        if not (
            literatures
            or metas
            or links
            or facts
            or fallback_indexes
            or user_indexes
            or retired
            or clear
        ):
            raise LiteratureWriterIntegrityError()
        if len({item.literature_id for item in literatures}) != len(literatures):
            raise LiteratureWriterIntegrityError()
        if len({item.meta_literature_id for item in metas}) != len(metas):
            raise LiteratureWriterIntegrityError()
        if len({item.observation.observation_id for item in links}) != len(links):
            raise LiteratureWriterIntegrityError()
        if len({item.literature.literature_id for item in facts}) != len(facts):
            raise LiteratureWriterIntegrityError()
        fallback_by_id = {_id(item.literature_id, LiteratureId): item for item in fallback_indexes}
        user_by_id = {_id(item.observation_id, ObservationId): item for item in user_indexes}
        if len(fallback_by_id) != len(fallback_indexes) or len(user_by_id) != len(user_indexes):
            raise LiteratureWriterIntegrityError()

        expected_by_id = {_id(item.literature_id, LiteratureId): item for item in expected_tokens}
        expected_meta_by_id = {
            _id(item.meta_literature_id, MetaLiteratureId): item for item in expected_meta_tokens
        }
        if len(expected_by_id) != len(expected_tokens) or len(expected_meta_by_id) != len(
            expected_meta_tokens
        ):
            raise LiteratureWriterIntegrityError()
        for token in expected_tokens:
            _check_token(connection, token)
        for token in expected_meta_tokens:
            _check_meta_token(connection, token)
        self._checkpoint("identity-after-preconditions")

        # New Meta rows must exist before their deferred Literature FKs are
        # checked.  For updates, the expected Meta token above is the CAS
        # guard; an unguarded changed existing Meta is a conflict.
        for meta in metas:
            meta_id = _id(meta.meta_literature_id, MetaLiteratureId)
            existing = connection.execute(
                "SELECT representative_literature_id FROM meta_literatures "
                "WHERE meta_literature_id=?",
                (meta_id,),
            ).fetchone()
            desired = _id(meta.representative_literature_id, LiteratureId)
            if (
                existing is not None
                and existing[0] != desired
                and meta_id not in expected_meta_by_id
            ):
                raise StalePreconditionError()
            _ensure_meta_row(connection, meta)

        supplied_ids = {_id(item.literature_id, LiteratureId) for item in literatures}
        if not set(fallback_by_id).issubset(supplied_ids):
            raise LiteratureWriterIntegrityError()
        for literature in literatures:
            literature_id = _id(literature.literature_id, LiteratureId)
            existing = connection.execute(
                "SELECT meta_literature_id,version_role FROM literatures WHERE literature_id=?",
                (literature_id,),
            ).fetchone()
            desired = (
                _id(literature.meta_literature_id, MetaLiteratureId),
                _enum(literature.version_role),
            )
            if (
                existing is not None
                and tuple(existing) != desired
                and literature_id not in expected_by_id
            ):
                raise StalePreconditionError()
            if literature.meta_literature_id not in {item.meta_literature_id for item in metas}:
                # A member can continue to point to an existing Meta omitted
                # from this command, but a brand-new target must be explicit.
                meta_exists = connection.execute(
                    "SELECT 1 FROM meta_literatures WHERE meta_literature_id=?",
                    (_id(literature.meta_literature_id, MetaLiteratureId),),
                ).fetchone()
                if meta_exists is None:
                    raise LiteratureWriterIntegrityError()
            _ensure_literature_row(connection, literature)

        _normalize_discovery_cause_memberships(connection, supplied_ids, retired)

        # The command's facts are the only source of the current metadata
        # token.  They must refer to one of the submitted concrete rows.
        for item in facts:
            if not hasattr(item, "literature") or not hasattr(item, "metadata_revision"):
                raise LiteratureWriterIntegrityError()
            fact_literature = _require_model(cast(object, item.literature), Literature)
            literature_id = _id(fact_literature.literature_id, LiteratureId)
            if literature_id not in supplied_ids:
                raise LiteratureWriterIntegrityError()
            if fact_literature != next(
                value
                for value in literatures
                if value.literature_id == fact_literature.literature_id
            ):
                raise LiteratureWriterIntegrityError()
            if type(item.metadata_revision) is not int or item.metadata_revision < 1:
                raise LiteratureWriterIntegrityError()
            metadata_digest = _require_model(cast(object, item.metadata_sha256), Sha256)
            _store_current_metadata(
                connection,
                fact_literature,
                item.metadata_revision,
                metadata_digest,
            )
        if len(facts) != len(literatures):
            raise LiteratureWriterIntegrityError()
        for literature_id in supplied_ids:
            _replace_fallback_identity_index(
                connection,
                literature_id,
                fallback_by_id.get(literature_id),
            )
        self._checkpoint("identity-after-current-metadata")

        for link in links:
            link_id = _id(link.literature_id, LiteratureId)
            if (
                link_id not in supplied_ids
                and connection.execute(
                    "SELECT 1 FROM literatures WHERE literature_id=?", (link_id,)
                ).fetchone()
                is None
            ):
                raise LiteratureWriterIntegrityError()
            _store_observation(connection, link)
        link_ids = {_id(item.observation.observation_id, ObservationId) for item in links}
        if not set(user_by_id).issubset(link_ids):
            raise LiteratureWriterIntegrityError()
        for index in user_indexes:
            _store_user_observation_index(connection, index)
        self._checkpoint("identity-after-observations")

        # Every submitted Meta must point to a member after all membership
        # changes.  This is a cross-row invariant not expressible in DDL.
        for meta in metas:
            meta_id = _id(meta.meta_literature_id, MetaLiteratureId)
            representative = _id(meta.representative_literature_id, LiteratureId)
            member = connection.execute(
                "SELECT 1 FROM literatures WHERE literature_id=? AND meta_literature_id=?",
                (representative, meta_id),
            ).fetchone()
            if member is None:
                raise LiteratureWriterIntegrityError()

        self._checkpoint("identity-before-meta-retire")
        for retired_id in retired:
            meta_id = _id(retired_id, MetaLiteratureId)
            if meta_id not in expected_meta_by_id:
                raise StalePreconditionError()
            if (
                connection.execute(
                    "SELECT 1 FROM literatures WHERE meta_literature_id=?", (meta_id,)
                ).fetchone()
                is not None
            ):
                raise LiteratureWriterIntegrityError()
            connection.execute(
                "DELETE FROM meta_literatures WHERE meta_literature_id=?", (meta_id,)
            )
        self._checkpoint("identity-after-meta-retire")

        for literature_id in clear:
            if (
                connection.execute(
                    "SELECT 1 FROM literatures WHERE literature_id=?",
                    (_id(literature_id, LiteratureId),),
                ).fetchone()
                is None
            ):
                raise LiteratureWriterIntegrityError()
            connection.execute(
                "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
                (_id(literature_id, LiteratureId),),
            )

    def apply_content_transaction(  # noqa: C901
        self,
        connection: object,
        command: ContentPublicationCommand,
    ) -> None:
        """Apply an already leased content command in a caller-owned transaction.

        This is a Storage-internal transaction helper, not a Literature
        publication Port.  ``SqliteContentPublication`` is the only public
        business writer and must register verified artifact leases before
        invoking this method.
        """

        if not isinstance(connection, sqlite3.Connection):
            raise TypeError("connection must be sqlite3.Connection")
        _check_command_shapes(command, ContentPublicationCommand)
        token = command.expected_token
        _check_token(connection, token)
        replacement = cast(object, command.replacement)
        if not isinstance(replacement, ContentAcceptanceReplacement):
            raise LiteratureWriterIntegrityError()
        literature_id = _id(replacement.literature_id, LiteratureId)
        if literature_id != _id(token.literature_id, LiteratureId):
            raise LiteratureWriterIntegrityError()
        primary_asset_id = _id(command.expected_primary_asset_id, AssetId)
        primary_pdf_sha256 = _sha(command.expected_primary_pdf_sha256)
        parser_result_sha256 = _sha(command.expected_parser_result_sha256)
        current_inputs = connection.execute(
            "SELECT a.asset_id,a.sha256,pr.result_sha256 FROM literature_assets la "
            "JOIN assets a ON a.asset_id=la.asset_id "
            "LEFT JOIN parser_results pr ON pr.source_asset_id=a.asset_id "
            "WHERE la.literature_id=? AND la.role='primary-pdf' "
            "ORDER BY la.literature_asset_id",
            (literature_id,),
        ).fetchall()
        expected_inputs = (primary_asset_id, primary_pdf_sha256, parser_result_sha256)
        if len(current_inputs) != 1 or tuple(current_inputs[0]) != expected_inputs:
            raise StalePreconditionError()
        expected_analysis_input = analysis_input_sha256(
            command.expected_primary_pdf_sha256,
            command.expected_parser_result_sha256,
            replacement.metadata_sha256,
        )
        if replacement.content.provenance.input_sha256 != expected_analysis_input:
            raise LiteratureWriterIntegrityError()
        current_content = connection.execute(
            "SELECT literature_content_sha256 FROM literature_contents WHERE literature_id=?",
            (literature_id,),
        ).fetchone()
        cleanup = command.cleanup
        replacement_hash = _sha(replacement.content.literature_content_sha256)
        if current_content is not None and current_content[0] != replacement_hash:
            if cleanup is None or _sha(cleanup.old_content_sha256) != current_content[0]:
                raise StalePreconditionError()
        elif cleanup is not None:
            raise StalePreconditionError()
        if cleanup is not None:
            expected_closure = command.expected_reference_closure_token
            if not isinstance(expected_closure, ContentReferenceClosureToken):
                raise LiteratureWriterIntegrityError()
            if _current_reference_closure_token(connection, literature_id) != expected_closure:
                raise StalePreconditionError()
        self._checkpoint("after-cas")
        self._replace_current_metadata(
            connection,
            replacement,
            token,
        )
        _replace_fallback_identity_index(
            connection,
            literature_id,
            command.fallback_identity_index,
        )
        self._checkpoint("after-metadata-replacement")
        if cleanup is not None:
            self._apply_cleanup(connection, cleanup, literature_id)
        self._checkpoint("after-cleanup")
        self._store_content_row(connection, command)
        self._checkpoint("after-binding")

    def _replace_current_metadata(
        self,
        connection: sqlite3.Connection,
        replacement: ContentAcceptanceReplacement,
        token: LiteratureIdentityToken,
    ) -> None:
        literature_id = _id(replacement.literature_id, LiteratureId)
        current = connection.execute(
            "SELECT meta_literature_id,version_role FROM literatures WHERE literature_id=?",
            (literature_id,),
        ).fetchone()
        if current is None:
            raise StalePreconditionError()
        literature = Literature(
            literature_id=replacement.literature_id,
            meta_literature_id=token.meta_literature_id,
            version_role=VersionRole.OTHER,
            metadata=replacement.metadata,
            status=LiteratureStatus.CONTENT_READY,
        )
        # Preserve the existing version role; no status column is persisted.
        literature = literature.model_copy(update={"version_role": VersionRole(current[1])})
        _store_current_metadata(
            connection,
            literature,
            replacement.metadata_revision,
            replacement.metadata_sha256,
        )

    def _store_content_row(  # noqa: C901
        self,
        connection: sqlite3.Connection,
        command: ContentPublicationCommand,
    ) -> None:
        replacement = command.replacement
        content = cast(object, replacement.content)
        if not isinstance(content, LiteratureContent):
            raise LiteratureWriterIntegrityError()
        literature_id = _id(replacement.literature_id, LiteratureId)
        content_hash = _sha(content.literature_content_sha256)
        metadata_hash = _sha(replacement.metadata_sha256)
        if (
            content.metadata_revision != replacement.metadata_revision
            or content.metadata_sha256 != replacement.metadata_sha256
        ):
            raise LiteratureWriterIntegrityError()
        _register_provenance(connection, content.provenance)
        structured = command.structured_artifact
        if structured != literature_content_artifact(content):
            raise LiteratureWriterIntegrityError()
        structured_path = _artifact_path(structured.sha256, structured.byte_size)
        _require_artifact(
            connection,
            structured_path,
            structured.sha256,
            structured.byte_size,
            structured.media_type,
        )
        markdown_path = _artifact_path(content.markdown.sha256, content.markdown.byte_size)
        _require_artifact(
            connection,
            markdown_path,
            content.markdown.sha256,
            content.markdown.byte_size,
            content.markdown.media_type,
        )
        primary_asset_id = _id(command.expected_primary_asset_id, AssetId)
        primary_asset_sha256 = _sha(command.expected_primary_pdf_sha256)
        parser_result_hash = _sha(command.expected_parser_result_sha256)
        values = (
            literature_id,
            content_hash,
            replacement.metadata_revision,
            metadata_hash,
            primary_asset_id,
            primary_asset_sha256,
            parser_result_hash,
            structured_path,
            _sha(structured.sha256),
            structured.byte_size,
            structured.media_type,
            markdown_path,
            _sha(content.markdown.sha256),
            content.markdown.byte_size,
            content.markdown.media_type,
            _id(content.provenance.provenance_id, ProvenanceId),
        )
        existing = connection.execute(
            "SELECT literature_id,literature_content_sha256,metadata_revision,metadata_sha256,"
            "primary_asset_id,primary_asset_sha256,parser_result_sha256,"
            "structured_artifact_path,structured_artifact_sha256,structured_artifact_byte_size,"
            "structured_artifact_media_type,markdown_artifact_path,markdown_artifact_sha256,"
            "markdown_artifact_byte_size,markdown_artifact_media_type,analysis_provenance_id "
            "FROM literature_contents WHERE literature_id=?",
            (literature_id,),
        ).fetchone()
        old_content_hash = None if existing is None else str(existing[1])
        expected_references = tuple(enumerate(content.references))
        # The semantic hash keys only the shared reference-text projection.
        # Artifact and provenance bindings remain local to each Literature row.
        current_references = tuple(
            connection.execute(
                "SELECT reference_index,reference_text "
                "FROM literature_content_reference_texts "
                "WHERE literature_content_sha256=? ORDER BY reference_index",
                (content_hash,),
            ).fetchall()
        )
        hash_is_bound = connection.execute(
            "SELECT 1 FROM literature_contents WHERE literature_content_sha256=? LIMIT 1",
            (content_hash,),
        ).fetchone()
        if current_references and current_references != expected_references:
            raise LiteratureWriterConflictError()
        if not current_references and expected_references and hash_is_bound is not None:
            raise LiteratureWriterConflictError()
        if hash_is_bound is None:
            connection.executemany(
                "INSERT INTO literature_content_reference_texts("
                "literature_content_sha256,reference_index,reference_text) VALUES(?,?,?)",
                (
                    (content_hash, reference_index, reference_text)
                    for reference_index, reference_text in expected_references
                ),
            )
        if existing is None:
            connection.execute(
                "INSERT INTO literature_contents(literature_id,literature_content_sha256,"
                "metadata_revision,metadata_sha256,primary_asset_id,primary_asset_sha256,"
                "parser_result_sha256,structured_artifact_path,structured_artifact_sha256,"
                "structured_artifact_byte_size,structured_artifact_media_type,"
                "markdown_artifact_path,markdown_artifact_sha256,markdown_artifact_byte_size,"
                "markdown_artifact_media_type,analysis_provenance_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                values,
            )
        elif tuple(existing) != values:
            connection.execute(
                "UPDATE literature_contents SET literature_content_sha256=?,metadata_revision=?,"
                "metadata_sha256=?,primary_asset_id=?,primary_asset_sha256=?,"
                "parser_result_sha256=?,structured_artifact_path=?,structured_artifact_sha256=?,"
                "structured_artifact_byte_size=?,structured_artifact_media_type=?,"
                "markdown_artifact_path=?,markdown_artifact_sha256=?,markdown_artifact_byte_size=?,"
                "markdown_artifact_media_type=?,analysis_provenance_id=? WHERE literature_id=?",
                (*values[1:], literature_id),
            )
        _refresh_search_content(connection, literature_id, content)
        if old_content_hash is not None and old_content_hash != content_hash:
            _delete_orphan_content_projection(connection, old_content_hash)

    @staticmethod
    def _apply_cleanup(  # noqa: C901
        connection: sqlite3.Connection,
        cleanup: ReferenceCleanupDecision,
        literature_id: str,
    ) -> None:
        cleanup = _require_model(cast(object, cleanup), ReferenceCleanupDecision)
        if cleanup.decision == "rejected":
            raise LiteratureWriterIntegrityError()
        if _id(cleanup.source_literature_id, LiteratureId) != literature_id:
            raise LiteratureWriterIntegrityError()
        old_hash = _sha(cleanup.old_content_sha256)
        affected_reference_ids: set[str] = set()
        seen_supports: set[tuple[object, ...]] = set()
        for support in cleanup.removed_supports:
            support = _require_model(cast(object, support), ReferenceSupport)
            source = support.source
            if (
                not isinstance(source, ContentReferenceTextSupport)
                or _sha(source.literature_content_sha256) != old_hash
            ):
                raise LiteratureWriterIntegrityError()
            reference_id = _id(support.reference_id, ReferenceId)
            owner = connection.execute(
                "SELECT source_literature_id FROM literature_references WHERE reference_id=?",
                (reference_id,),
            ).fetchone()
            if owner != (literature_id,):
                raise StalePreconditionError()
            location = (
                reference_id,
                old_hash,
                source.reference_index,
            )
            if location in seen_supports:
                raise LiteratureWriterIntegrityError()
            seen_supports.add(location)
            if _delete_support(connection, support) != 1:
                raise StalePreconditionError()
            affected_reference_ids.add(reference_id)
        remaining_old = connection.execute(
            "SELECT 1 FROM content_reference_text_supports s "
            "JOIN literature_references r ON r.reference_id=s.reference_id "
            "WHERE r.source_literature_id=? AND s.literature_content_sha256=? LIMIT 1",
            (literature_id, old_hash),
        ).fetchone()
        if remaining_old is not None:
            raise StalePreconditionError()
        deleted_ids = tuple(_id(item, ReferenceId) for item in cleanup.deleted_reference_ids)
        if len(set(deleted_ids)) != len(deleted_ids):
            raise LiteratureWriterIntegrityError()
        for reference_id in cleanup.deleted_reference_ids:
            ref_id = _id(reference_id, ReferenceId)
            owner = connection.execute(
                "SELECT source_literature_id FROM literature_references WHERE reference_id=?",
                (ref_id,),
            ).fetchone()
            if owner != (literature_id,) or _reference_support_count(connection, ref_id) != 0:
                raise StalePreconditionError()
            connection.execute(
                "DELETE FROM literature_references WHERE reference_id=?",
                (ref_id,),
            )
        deleted_set = set(deleted_ids)
        for reference_id in affected_reference_ids - deleted_set:
            if _reference_support_count(connection, reference_id) == 0:
                raise StalePreconditionError()

    def publish_reference(self, command: ReferencePublicationCommand) -> None:
        _check_command_shapes(command, ReferencePublicationCommand)

        def operation(connection: sqlite3.Connection) -> None:
            self._publish_reference(connection, command, append=False)
            self._checkpoint("reference-after")

        _run_write(self._engine, operation)

    def append_reference_support(self, command: ReferenceSupportAppendCommand) -> None:
        _check_command_shapes(command, ReferenceSupportAppendCommand)

        def operation(connection: sqlite3.Connection) -> None:
            self._publish_reference(connection, command, append=True)
            self._checkpoint("reference-append-after")

        _run_write(self._engine, operation)

    def _publish_reference(  # noqa: C901
        self,
        connection: sqlite3.Connection,
        command: ReferencePublicationCommand | ReferenceSupportAppendCommand,
        *,
        append: bool,
    ) -> None:
        _check_token(connection, command.source_token)
        _check_token(connection, command.target_token)
        reference = _require_model(cast(object, command.reference), Reference)
        source_id = _id(reference.source_literature_id, LiteratureId)
        target_id = _id(reference.target_literature_id, LiteratureId)
        if source_id == target_id:
            raise LiteratureWriterIntegrityError()
        if (
            _id(command.source_token.literature_id, LiteratureId) != source_id
            or _id(command.target_token.literature_id, LiteratureId) != target_id
        ):
            raise LiteratureWriterIntegrityError()
        supports = _as_tuple(command.supports, ReferenceSupport)
        if not supports:
            raise LiteratureWriterIntegrityError()
        reference_id = _id(reference.reference_id, ReferenceId)
        for support in supports:
            if _id(support.reference_id, ReferenceId) != reference_id:
                raise LiteratureWriterIntegrityError()
            _validate_support_source(connection, support, source_id)
        by_id = connection.execute(
            "SELECT reference_id,source_literature_id,target_literature_id "
            "FROM literature_references "
            "WHERE reference_id=?",
            (reference_id,),
        ).fetchone()
        by_pair = connection.execute(
            "SELECT reference_id,source_literature_id,target_literature_id "
            "FROM literature_references "
            "WHERE source_literature_id=? AND target_literature_id=?",
            (source_id, target_id),
        ).fetchone()
        expected_row = (reference_id, source_id, target_id)
        if append and by_id is None:
            raise StalePreconditionError()
        if by_id is not None and tuple(by_id) != expected_row:
            raise LiteratureWriterConflictError()
        if by_pair is not None and tuple(by_pair) != expected_row:
            raise LiteratureWriterConflictError()
        if by_id is None and by_pair is None:
            connection.execute(
                "INSERT INTO literature_references(reference_id,source_literature_id,"
                "target_literature_id) "
                "VALUES(?,?,?)",
                expected_row,
            )
        self._checkpoint("reference-after-edge")
        for support in supports:
            _insert_support(connection, support)
        if _reference_support_count(connection, reference_id) == 0:
            raise LiteratureWriterIntegrityError()
        self._checkpoint("reference-after-supports")

    def publish_provider_relation_observation(
        self,
        observation: ProviderRelationObservation,
    ) -> None:
        observation = _require_public(
            cast(object, observation),
            ProviderRelationObservation,
            "observation must be ProviderRelationObservation",
        )

        def operation(connection: sqlite3.Connection) -> None:
            _store_provider_relation(connection, observation)
            self._checkpoint("provider-relation-after")

        _run_write(self._engine, operation)

    def publish_asset(self, asset: Asset) -> None:
        asset = _require_public(cast(object, asset), Asset, "asset must be Asset")

        def operation(connection: sqlite3.Connection) -> None:
            _store_asset(connection, asset)
            self._checkpoint("asset-after")

        _run_write(self._engine, operation)

    def publish_literature_asset(self, relation: LiteratureAsset) -> None:
        relation = _require_public(
            cast(object, relation),
            LiteratureAsset,
            "relation must be LiteratureAsset",
        )

        def operation(connection: sqlite3.Connection) -> None:
            _store_literature_asset(connection, relation)
            self._checkpoint("literature-asset-after")

        _run_write(self._engine, operation)

    def publish_exhaustion(self, exhaustion: AutomaticPdfAcquisitionExhaustion) -> None:
        exhaustion = _require_public(
            cast(object, exhaustion),
            AutomaticPdfAcquisitionExhaustion,
            "exhaustion must be AutomaticPdfAcquisitionExhaustion",
        )

        def operation(connection: sqlite3.Connection) -> None:
            literature_id = _id(exhaustion.literature_id, LiteratureId)
            if (
                connection.execute(
                    "SELECT 1 FROM literatures WHERE literature_id=?", (literature_id,)
                ).fetchone()
                is None
            ):
                raise LiteratureWriterIntegrityError()
            connection.execute(
                "INSERT OR IGNORE INTO automatic_pdf_acquisition_exhaustions(literature_id) "
                "VALUES(?)",
                (literature_id,),
            )
            self._checkpoint("exhaustion-after")

        _run_write(self._engine, operation)

    def clear_exhaustion(self, literature_id: LiteratureId) -> None:
        literature_id = _require_public(
            cast(object, literature_id),
            LiteratureId,
            "literature_id must be LiteratureId",
        )

        def operation(connection: sqlite3.Connection) -> None:
            connection.execute(
                "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
                (_id(literature_id, LiteratureId),),
            )

        _run_write(self._engine, operation)

    def delete_literature(self, command: LiteratureDeletionCommand) -> None:
        _check_command_shapes(command, LiteratureDeletionCommand)

        def operation(connection: sqlite3.Connection) -> None:
            self._delete_literature(connection, command)
            self._checkpoint("delete-after")

        _run_write(self._engine, operation)

    def _delete_literature(
        self,
        connection: sqlite3.Connection,
        command: LiteratureDeletionCommand,
    ) -> None:
        literature_id = _id(command.literature_id, LiteratureId)
        if literature_id != _id(command.expected_token.literature_id, LiteratureId):
            raise LiteratureWriterIntegrityError()
        _check_token(connection, command.expected_token)
        _check_meta_token(connection, command.expected_meta_token)
        meta_id = _id(command.expected_meta_token.meta_literature_id, MetaLiteratureId)
        if (
            connection.execute(
                "SELECT 1 FROM literature_references WHERE source_literature_id=? "
                "OR target_literature_id=?",
                (literature_id, literature_id),
            ).fetchone()
            is not None
        ):
            raise LiteratureWriterIntegrityError()
        members = tuple(
            row[0]
            for row in connection.execute(
                "SELECT literature_id FROM literatures WHERE meta_literature_id=? "
                "ORDER BY literature_id",
                (meta_id,),
            ).fetchall()
        )
        replacement = command.replacement_representative_id
        replacement_id = None if replacement is None else _id(replacement, LiteratureId)
        representative_id = _id(
            command.expected_meta_token.representative_literature_id,
            LiteratureId,
        )
        sole_member = members == (literature_id,)
        if representative_id == literature_id and not sole_member:
            if (
                replacement_id is None
                or replacement_id == literature_id
                or replacement_id not in members
            ):
                raise LiteratureWriterIntegrityError()
            connection.execute(
                "UPDATE meta_literatures SET representative_literature_id=? "
                "WHERE meta_literature_id=?",
                (replacement_id, meta_id),
            )
        elif replacement_id is not None:
            raise LiteratureWriterIntegrityError()
        content_row = connection.execute(
            "SELECT literature_content_sha256 FROM literature_contents WHERE literature_id=?",
            (literature_id,),
        ).fetchone()
        if sole_member:
            # The representative FK is intentionally RESTRICT for ordinary
            # maintenance. This validated two-row deletion is the explicit
            # exception: defer all checks until both rows are gone.
            connection.execute("PRAGMA defer_foreign_keys=ON")
        connection.execute("DELETE FROM literatures WHERE literature_id=?", (literature_id,))
        connection.execute(
            "DELETE FROM literature_search_fts WHERE literature_id=?",
            (literature_id,),
        )
        self._checkpoint("delete-after-literature")
        if content_row is not None:
            _delete_orphan_content_projection(connection, str(content_row[0]))
        if sole_member:
            connection.execute(
                "DELETE FROM meta_literatures WHERE meta_literature_id=?", (meta_id,)
            )
        self._checkpoint("delete-after-meta")


def _artifact_path(sha256: Sha256, byte_size: int) -> str:
    from sciretriever.storage.files.paths import content_addressed_reference

    try:
        return _text(content_addressed_reference(sha256, byte_size))
    except (TypeError, ValueError) as error:
        raise LiteratureWriterIntegrityError() from error


def _require_artifact(
    connection: sqlite3.Connection,
    path: str,
    sha256: Sha256,
    byte_size: int,
    media_type: str,
) -> None:
    row = connection.execute(
        "SELECT sha256,byte_size,media_type FROM artifact_objects WHERE relative_path=?",
        (path,),
    ).fetchone()
    expected = (_sha(sha256), byte_size, media_type)
    if row is None or tuple(row) != expected:
        raise LiteratureWriterIntegrityError()


def _delete_orphan_content_projection(
    connection: sqlite3.Connection,
    content_sha256: str,
) -> None:
    if (
        connection.execute(
            "SELECT 1 FROM literature_contents WHERE literature_content_sha256=? LIMIT 1",
            (content_sha256,),
        ).fetchone()
        is not None
    ):
        return
    connection.execute(
        "DELETE FROM literature_content_reference_texts WHERE literature_content_sha256=?",
        (content_sha256,),
    )


def _reference_support_count(connection: sqlite3.Connection, reference_id: str) -> int:
    row = connection.execute(
        "SELECT "
        "(SELECT count(*) FROM provider_relation_reference_supports WHERE reference_id=?) + "
        "(SELECT count(*) FROM metadata_reference_text_supports WHERE reference_id=?) + "
        "(SELECT count(*) FROM content_reference_text_supports WHERE reference_id=?)",
        (reference_id, reference_id, reference_id),
    ).fetchone()
    if row is None or type(row[0]) is not int:
        raise LiteratureWriterIntegrityError()
    return row[0]


def _current_reference_closure_token(
    connection: sqlite3.Connection,
    source_literature_id: str,
) -> ContentReferenceClosureToken:
    references = tuple(
        Reference(
            reference_id=ReferenceId(str(row[0])),
            source_literature_id=LiteratureId(str(row[1])),
            target_literature_id=LiteratureId(str(row[2])),
        )
        for row in connection.execute(
            "SELECT reference_id,source_literature_id,target_literature_id "
            "FROM literature_references WHERE source_literature_id=? ORDER BY reference_id",
            (source_literature_id,),
        ).fetchall()
    )
    reference_ids = tuple(str(item.reference_id) for item in references)
    if not reference_ids:
        supports: tuple[ReferenceSupport, ...] = ()
    else:
        placeholders = ",".join("?" for _ in reference_ids)
        provider_supports = tuple(
            ReferenceSupport(
                reference_id=ReferenceId(str(row[0])),
                source=ProviderRelationSupport(
                    kind="provider_relation",
                    observation_id=ObservationId(str(row[1])),
                ),
            )
            for row in connection.execute(
                "SELECT reference_id,observation_id "
                "FROM provider_relation_reference_supports "
                f"WHERE reference_id IN ({placeholders}) ORDER BY reference_id,observation_id",
                reference_ids,
            ).fetchall()
        )
        metadata_supports = tuple(
            ReferenceSupport(
                reference_id=ReferenceId(str(row[0])),
                source=MetadataReferenceTextSupport(
                    kind="metadata_reference_text",
                    metadata_observation_id=ObservationId(str(row[1])),
                    reference_index=int(row[2]),
                ),
            )
            for row in connection.execute(
                "SELECT reference_id,metadata_observation_id,reference_index "
                "FROM metadata_reference_text_supports "
                f"WHERE reference_id IN ({placeholders}) "
                "ORDER BY reference_id,metadata_observation_id,reference_index",
                reference_ids,
            ).fetchall()
        )
        content_supports = tuple(
            ReferenceSupport(
                reference_id=ReferenceId(str(row[0])),
                source=ContentReferenceTextSupport(
                    kind="content_reference_text",
                    literature_content_sha256=Sha256(str(row[1])),
                    reference_index=int(row[2]),
                ),
            )
            for row in connection.execute(
                "SELECT reference_id,literature_content_sha256,reference_index "
                "FROM content_reference_text_supports "
                f"WHERE reference_id IN ({placeholders}) "
                "ORDER BY reference_id,literature_content_sha256,reference_index",
                reference_ids,
            ).fetchall()
        )
        supports = (*provider_supports, *metadata_supports, *content_supports)
    try:
        return content_reference_closure_token(
            LiteratureId(source_literature_id),
            references,
            supports,
        )
    except (TypeError, ValueError) as error:
        raise LiteratureWriterIntegrityError() from error


def _validate_support_source(
    connection: sqlite3.Connection,
    support: ReferenceSupport,
    source_literature_id: str,
) -> None:
    source = cast(object, support.source)
    if isinstance(source, ProviderRelationSupport):
        if (
            connection.execute(
                "SELECT 1 FROM provider_relation_observations WHERE observation_id=?",
                (_id(source.observation_id, ObservationId),),
            ).fetchone()
            is None
        ):
            raise LiteratureWriterIntegrityError()
        return
    if isinstance(source, MetadataReferenceTextSupport):
        row = connection.execute(
            "SELECT lmo.literature_id FROM metadata_observation_reference_texts t "
            "JOIN literature_metadata_observations lmo ON lmo.observation_id=t.observation_id "
            "WHERE t.observation_id=? AND t.reference_index=?",
            (_id(source.metadata_observation_id, ObservationId), source.reference_index),
        ).fetchone()
        if row is None or row[0] != source_literature_id:
            raise LiteratureWriterIntegrityError()
        return
    if isinstance(source, ContentReferenceTextSupport):
        row = connection.execute(
            "SELECT c.literature_id FROM literature_content_reference_texts t "
            "JOIN literature_contents c "
            "ON c.literature_content_sha256=t.literature_content_sha256 "
            "WHERE c.literature_id=? AND t.literature_content_sha256=? "
            "AND t.reference_index=?",
            (
                source_literature_id,
                _sha(source.literature_content_sha256),
                source.reference_index,
            ),
        ).fetchone()
        if row is None or row[0] != source_literature_id:
            raise LiteratureWriterIntegrityError()
        return
    raise LiteratureWriterIntegrityError()


def _insert_support(connection: sqlite3.Connection, support: ReferenceSupport) -> None:
    reference_id = _id(support.reference_id, ReferenceId)
    source = cast(object, support.source)
    if isinstance(source, ProviderRelationSupport):
        table = "provider_relation_reference_supports"
        values = (reference_id, _id(source.observation_id, ObservationId))
    elif isinstance(source, MetadataReferenceTextSupport):
        table = "metadata_reference_text_supports"
        values = (
            reference_id,
            _id(source.metadata_observation_id, ObservationId),
            source.reference_index,
        )
    elif isinstance(source, ContentReferenceTextSupport):
        table = "content_reference_text_supports"
        values = (
            reference_id,
            _sha(source.literature_content_sha256),
            source.reference_index,
        )
    else:
        raise LiteratureWriterIntegrityError()
    placeholders = ",".join("?" for _ in values)
    existing = connection.execute(
        f"SELECT 1 FROM {table} WHERE "
        + " AND ".join(f"{column}=?" for column in _support_columns(source)),
        _support_key(values, source),
    ).fetchone()
    if existing is None:
        connection.execute(f"INSERT INTO {table} VALUES({placeholders})", values)


def _support_columns(source: object) -> tuple[str, ...]:
    if isinstance(source, ProviderRelationSupport):
        return ("reference_id", "observation_id")
    if isinstance(source, MetadataReferenceTextSupport):
        return ("reference_id", "metadata_observation_id", "reference_index")
    if isinstance(source, ContentReferenceTextSupport):
        return ("reference_id", "literature_content_sha256", "reference_index")
    raise LiteratureWriterIntegrityError()


def _support_key(values: tuple[object, ...], source: object) -> tuple[object, ...]:
    del source
    return values


def _delete_support(connection: sqlite3.Connection, support: ReferenceSupport) -> int:
    source = cast(object, support.source)
    columns = _support_columns(source)
    values: tuple[object, ...]
    if isinstance(source, ProviderRelationSupport):
        values = (_id(support.reference_id, ReferenceId), _id(source.observation_id, ObservationId))
        table = "provider_relation_reference_supports"
    elif isinstance(source, MetadataReferenceTextSupport):
        values = (
            _id(support.reference_id, ReferenceId),
            _id(source.metadata_observation_id, ObservationId),
            source.reference_index,
        )
        table = "metadata_reference_text_supports"
    elif isinstance(source, ContentReferenceTextSupport):
        values = (
            _id(support.reference_id, ReferenceId),
            _sha(source.literature_content_sha256),
            source.reference_index,
        )
        table = "content_reference_text_supports"
    else:
        raise LiteratureWriterIntegrityError()
    cursor = connection.execute(
        f"DELETE FROM {table} WHERE " + " AND ".join(f"{column}=?" for column in columns),
        values,
    )
    return cursor.rowcount


def _store_provider_relation(
    connection: sqlite3.Connection,
    observation: ProviderRelationObservation,
) -> None:
    observation_id = _id(observation.observation_id, ObservationId)
    existing = connection.execute(
        "SELECT observation_id,provenance_id FROM provider_relation_observations "
        "WHERE observation_id=?",
        (observation_id,),
    ).fetchone()
    endpoint_values = (
        ("citing", observation.citing),
        ("cited", observation.cited),
    )
    expected_endpoints = tuple(
        (
            kind,
            key.record_id,
            tuple(
                (index, item.namespace, item.value) for index, item in enumerate(key.identifiers)
            ),
        )
        for kind, key in endpoint_values
    )
    if existing is None:
        _register_provenance(connection, observation.provenance)
        connection.execute(
            "INSERT INTO provider_relation_observations(observation_id,provenance_id) VALUES(?,?)",
            (observation_id, _id(observation.provenance.provenance_id, ProvenanceId)),
        )
        for kind, key in endpoint_values:
            connection.execute(
                "INSERT INTO provider_relation_endpoints(observation_id,endpoint_kind,record_id) "
                "VALUES(?,?,?)",
                (observation_id, kind, key.record_id),
            )
            connection.executemany(
                "INSERT INTO provider_relation_endpoint_identifiers(observation_id,endpoint_kind,"
                "ordinal,namespace,value) VALUES(?,?,?,?,?)",
                (
                    (observation_id, kind, index, identifier.namespace, identifier.value)
                    for index, identifier in enumerate(key.identifiers)
                ),
            )
        return
    if not _same_stored_provider_provenance(
        connection,
        str(existing[1]),
        observation.provenance,
    ):
        raise LiteratureWriterConflictError()
    actual_endpoints: list[tuple[object, ...]] = []
    for kind, _ in endpoint_values:
        row = connection.execute(
            "SELECT endpoint_kind,record_id FROM provider_relation_endpoints "
            "WHERE observation_id=? AND endpoint_kind=?",
            (observation_id, kind),
        ).fetchone()
        ids = tuple(
            connection.execute(
                "SELECT ordinal,namespace,value FROM provider_relation_endpoint_identifiers "
                "WHERE observation_id=? AND endpoint_kind=? ORDER BY ordinal",
                (observation_id, kind),
            ).fetchall()
        )
        actual_endpoints.append((kind, None if row is None else row[1], ids))
    if _normalized_relation_endpoints(tuple(actual_endpoints)) != _normalized_relation_endpoints(
        expected_endpoints
    ):
        raise LiteratureWriterConflictError()


def _normalized_relation_endpoints(
    values: tuple[tuple[object, ...], ...],
) -> tuple[tuple[object, ...], ...]:
    normalized: list[tuple[object, ...]] = []
    for endpoint_values in values:
        if len(endpoint_values) != 3 or not isinstance(endpoint_values[2], tuple):
            raise LiteratureWriterIntegrityError()
        identifiers: list[tuple[str, str]] = []
        identifier_values = cast(tuple[object, ...], endpoint_values[2])
        for item in identifier_values:
            if not isinstance(item, tuple):
                raise LiteratureWriterIntegrityError()
            identifier = cast(tuple[object, ...], item)
            if len(identifier) != 3:
                raise LiteratureWriterIntegrityError()
            identifiers.append((str(identifier[1]), str(identifier[2])))
        normalized.append((endpoint_values[0], endpoint_values[1], tuple(sorted(identifiers))))
    return tuple(normalized)


def _store_asset(connection: sqlite3.Connection, asset: Asset) -> None:
    asset_id = _id(asset.asset_id, AssetId)
    path = _text(asset.path)
    _require_artifact(
        connection,
        path,
        asset.sha256,
        asset.size_bytes,
        asset.media_type,
    )
    values = (asset_id, _sha(asset.sha256), asset.size_bytes, asset.media_type, path)
    existing = connection.execute(
        "SELECT asset_id,sha256,size_bytes,media_type,relative_path FROM assets WHERE asset_id=?",
        (asset_id,),
    ).fetchone()
    if existing is None:
        connection.execute(
            "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
            "VALUES(?,?,?,?,?)",
            values,
        )
    elif tuple(existing) != values:
        raise LiteratureWriterConflictError()


def _store_literature_asset(connection: sqlite3.Connection, relation: LiteratureAsset) -> None:
    relation_id = _id(relation.literature_asset_id, LiteratureAssetId)
    values = (
        relation_id,
        _id(relation.literature_id, LiteratureId),
        _id(relation.asset_id, AssetId),
        _enum(relation.role),
        _id(relation.provenance.provenance_id, ProvenanceId),
        relation.source_url,
    )
    _register_provenance(connection, relation.provenance)
    if _enum(relation.role) == "primary-pdf":
        asset = connection.execute(
            "SELECT media_type FROM assets WHERE asset_id=?",
            (_id(relation.asset_id, AssetId),),
        ).fetchone()
        if asset != ("application/pdf",):
            raise LiteratureWriterIntegrityError()
    existing = connection.execute(
        "SELECT literature_asset_id,literature_id,asset_id,role,provenance_id,source_url "
        "FROM literature_assets WHERE literature_asset_id=?",
        (relation_id,),
    ).fetchone()
    if existing is None:
        connection.execute(
            "INSERT INTO literature_assets(literature_asset_id,literature_id,asset_id,role,"
            "provenance_id,source_url) VALUES(?,?,?,?,?,?)",
            values,
        )
    elif tuple(existing) != values:
        raise LiteratureWriterConflictError()


__all__ = (
    "LiteratureWriter",
    "LiteratureWriterConflictError",
    "LiteratureWriterError",
    "LiteratureWriterIntegrityError",
)
