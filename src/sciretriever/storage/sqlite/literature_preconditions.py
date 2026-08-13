"""Scoped SQLite snapshots for Literature publication preconditions.

The adapter performs equality-index reads and reconstructs neutral Model
values only.  It never chooses an identity winner, resolves provider relation
endpoints, derives metadata precedence, or hides collisions.  Each public
method owns exactly one :class:`CatalogEngine` read snapshot.

Structured ``LiteratureContent`` remains an ArtifactStore document.  The
reader validates the complete Catalog descriptor through ``VerifiedReader``,
strictly rebuilds the Model from canonical JSON bytes, and checks every
current-row binding without creating relational section/body tables.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import TypeVar, cast

from sciretriever.literature.ports import (
    ContentReadContext,
    ContentReadRequest,
    CurrentContentLineage,
    CurrentFactsReadContext,
    CurrentFactsReadRequest,
    CurrentLiteratureFacts,
    CurrentPrimaryPdf,
    DeletionReadContext,
    DeletionReadRequest,
    IdentityReadContext,
    IdentityReadRequest,
    LiteratureObservation,
    ReferenceReadContext,
    ReferenceReadRequest,
    analysis_input_sha256,
    canonical_literature_content_json,
    content_reference_closure_token,
    derive_status,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.model.acquisition import (
    Asset,
    AssetHint,
    AssetHintKind,
    AssetRole,
    LiteratureAsset,
)
from sciretriever.model.analysis import ArtifactRef, LiteratureContent
from sciretriever.model.literature import (
    Affiliation,
    Author,
    AuthorKind,
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
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResource,
    ParserResult,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.files.paths import content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference

from .engine import CatalogEngine

_T = TypeVar("_T")


class LiteraturePreconditionReadError(RuntimeError):
    """A scoped snapshot or one of its artifact bindings is invalid."""

    _DEFAULT_MESSAGE = "literature precondition read failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._DEFAULT_MESSAGE)


def _run_read(engine: CatalogEngine, operation: Callable[[sqlite3.Connection], _T]) -> _T:
    try:
        with engine.read_snapshot() as connection:
            return operation(connection)
    except LiteraturePreconditionReadError:
        raise
    except Exception as error:
        # Catalog, SQLite, Pydantic, JSON and verified-file failures are all
        # deliberately path/data-free at this adapter boundary.
        raise LiteraturePreconditionReadError() from error


def _placeholders(values: tuple[object, ...]) -> str:
    if not values:
        raise LiteraturePreconditionReadError()
    return ",".join("?" for _ in values)


def _integer(value: object) -> int:
    if type(value) is not int:
        raise LiteraturePreconditionReadError()
    return cast(int, value)


def _provenance(connection: sqlite3.Connection, provenance_id: str) -> Provenance:
    row = connection.execute(
        "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,"
        "input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
        (provenance_id,),
    ).fetchone()
    if row is None:
        raise LiteraturePreconditionReadError()
    return Provenance(
        provenance_id=ProvenanceId(str(row[0])),
        source_kind=SourceKind(str(row[1])),
        source_name=str(row[2]),
        source_record_id=None if row[3] is None else str(row[3]),
        observed_at=UtcTimestamp(str(row[4])),
        input_sha256=None if row[5] is None else Sha256(str(row[5])),
        parameters_sha256=None if row[6] is None else Sha256(str(row[6])),
    )


def _metadata_children(
    connection: sqlite3.Connection,
    *,
    prefix: str,
    owner_column: str,
    owner_id: str,
) -> tuple[tuple[Author, ...], tuple[Identifier, ...], tuple[str, ...]]:
    author_rows = connection.execute(
        f"SELECT ordinal,kind,display_name,given_name,family_name,orcid "
        f"FROM {prefix}_authors WHERE {owner_column}=? ORDER BY ordinal",
        (owner_id,),
    ).fetchall()
    affiliation_rows = connection.execute(
        f"SELECT author_ordinal,affiliation_ordinal,name,ror "
        f"FROM {prefix}_author_affiliations WHERE {owner_column}=? "
        "ORDER BY author_ordinal,affiliation_ordinal",
        (owner_id,),
    ).fetchall()
    affiliations: dict[int, list[tuple[int, Affiliation]]] = {}
    for row in affiliation_rows:
        author_ordinal = int(row[0])
        affiliations.setdefault(author_ordinal, []).append(
            (
                int(row[1]),
                Affiliation(
                    name=str(row[2]),
                    ror=None if row[3] is None else str(row[3]),
                ),
            )
        )
    if set(affiliations).difference(range(len(author_rows))):
        raise LiteraturePreconditionReadError()
    authors: list[Author] = []
    for expected_ordinal, row in enumerate(author_rows):
        if int(row[0]) != expected_ordinal:
            raise LiteraturePreconditionReadError()
        author_affiliations = affiliations.get(expected_ordinal, [])
        if tuple(item[0] for item in author_affiliations) != tuple(range(len(author_affiliations))):
            raise LiteraturePreconditionReadError()
        authors.append(
            Author(
                kind=AuthorKind(str(row[1])),
                display_name=str(row[2]),
                given_name=None if row[3] is None else str(row[3]),
                family_name=None if row[4] is None else str(row[4]),
                orcid=None if row[5] is None else str(row[5]),
                affiliations=tuple(item[1] for item in author_affiliations),
            )
        )
    identifier_rows = connection.execute(
        f"SELECT ordinal,namespace,value FROM {prefix}_identifiers "
        f"WHERE {owner_column}=? ORDER BY ordinal",
        (owner_id,),
    ).fetchall()
    if tuple(int(row[0]) for row in identifier_rows) != tuple(range(len(identifier_rows))):
        raise LiteraturePreconditionReadError()
    identifiers = tuple(
        Identifier(namespace=str(row[1]), value=str(row[2])) for row in identifier_rows
    )
    keyword_rows = connection.execute(
        f"SELECT ordinal,keyword FROM {prefix}_keywords WHERE {owner_column}=? ORDER BY ordinal",
        (owner_id,),
    ).fetchall()
    if tuple(int(row[0]) for row in keyword_rows) != tuple(range(len(keyword_rows))):
        raise LiteraturePreconditionReadError()
    return tuple(authors), identifiers, tuple(str(row[1]) for row in keyword_rows)


def _metadata_from_scalar(
    connection: sqlite3.Connection,
    *,
    prefix: str,
    owner_column: str,
    owner_id: str,
    scalar: tuple[object, ...],
) -> LiteratureMetadata:
    authors, identifiers, keywords = _metadata_children(
        connection,
        prefix=prefix,
        owner_column=owner_column,
        owner_id=owner_id,
    )
    return LiteratureMetadata(
        title=None if scalar[0] is None else str(scalar[0]),
        authors=authors,
        abstract=None if scalar[1] is None else str(scalar[1]),
        publication_date=None if scalar[2] is None else str(scalar[2]),
        publication_year=None if scalar[3] is None else _integer(scalar[3]),
        document_type=None if scalar[4] is None else str(scalar[4]),
        language=None if scalar[5] is None else str(scalar[5]),
        venue=None if scalar[6] is None else str(scalar[6]),
        publisher=None if scalar[7] is None else str(scalar[7]),
        volume=None if scalar[8] is None else str(scalar[8]),
        issue=None if scalar[9] is None else str(scalar[9]),
        pages=None if scalar[10] is None else str(scalar[10]),
        identifiers=identifiers,
        keywords=keywords,
    )


def _current_metadata(
    connection: sqlite3.Connection,
    literature_id: str,
) -> tuple[LiteratureMetadata, int, Sha256] | None:
    row = connection.execute(
        "SELECT metadata_revision,metadata_sha256,title,abstract,publication_date,"
        "publication_year,document_type,language,venue,publisher,volume,issue,pages "
        "FROM literature_metadata WHERE literature_id=?",
        (literature_id,),
    ).fetchone()
    if row is None:
        return None
    metadata = _metadata_from_scalar(
        connection,
        prefix="literature_metadata",
        owner_column="literature_id",
        owner_id=literature_id,
        scalar=tuple(row[2:]),
    )
    revision = int(row[0])
    digest = Sha256(str(row[1]))
    if metadata_sha256(metadata) != digest:
        raise LiteraturePreconditionReadError()
    return metadata, revision, digest


def _metadata_observation(
    connection: sqlite3.Connection,
    observation_id: str,
) -> MetadataObservation | None:
    row = connection.execute(
        "SELECT provenance_id,version_role,reference_count,cited_by_count,title,abstract,"
        "publication_date,publication_year,document_type,language,venue,publisher,volume,issue,"
        "pages FROM metadata_observations WHERE observation_id=?",
        (observation_id,),
    ).fetchone()
    if row is None:
        return None
    metadata = _metadata_from_scalar(
        connection,
        prefix="metadata_observation",
        owner_column="observation_id",
        owner_id=observation_id,
        scalar=tuple(row[4:]),
    )
    declared_rows = connection.execute(
        "SELECT ordinal,keyword FROM metadata_observation_declared_keywords "
        "WHERE observation_id=? ORDER BY ordinal",
        (observation_id,),
    ).fetchall()
    reference_rows = connection.execute(
        "SELECT reference_index,reference_text FROM metadata_observation_reference_texts "
        "WHERE observation_id=? ORDER BY reference_index",
        (observation_id,),
    ).fetchall()
    if tuple(int(item[0]) for item in declared_rows) != tuple(range(len(declared_rows))):
        raise LiteraturePreconditionReadError()
    if tuple(int(item[0]) for item in reference_rows) != tuple(range(len(reference_rows))):
        raise LiteraturePreconditionReadError()
    hint_rows = connection.execute(
        "SELECT hint_ordinal,url,kind,media_type,asset_role,version_role,access_status,license "
        "FROM metadata_observation_asset_hints WHERE observation_id=? ORDER BY hint_ordinal",
        (observation_id,),
    ).fetchall()
    if tuple(int(item[0]) for item in hint_rows) != tuple(range(len(hint_rows))):
        raise LiteraturePreconditionReadError()
    hints = tuple(
        AssetHint(
            url=str(item[1]),
            kind=AssetHintKind(str(item[2])),
            media_type=None if item[3] is None else str(item[3]),
            asset_role=None if item[4] is None else AssetRole(str(item[4])),
            version_role=None if item[5] is None else VersionRole(str(item[5])),
            access_status=None if item[6] is None else str(item[6]),
            license=None if item[7] is None else str(item[7]),
        )
        for item in hint_rows
    )
    link_rows = connection.execute(
        "SELECT link_ordinal,record_id FROM metadata_observation_version_links "
        "WHERE observation_id=? ORDER BY link_ordinal",
        (observation_id,),
    ).fetchall()
    if tuple(int(item[0]) for item in link_rows) != tuple(range(len(link_rows))):
        raise LiteraturePreconditionReadError()
    link_identifier_rows = connection.execute(
        "SELECT link_ordinal,ordinal,namespace,value "
        "FROM metadata_observation_version_link_identifiers WHERE observation_id=? "
        "ORDER BY link_ordinal,ordinal",
        (observation_id,),
    ).fetchall()
    identifiers_by_link: dict[int, list[tuple[int, Identifier]]] = {}
    for item in link_identifier_rows:
        identifiers_by_link.setdefault(int(item[0]), []).append(
            (int(item[1]), Identifier(namespace=str(item[2]), value=str(item[3])))
        )
    if set(identifiers_by_link).difference(range(len(link_rows))):
        raise LiteraturePreconditionReadError()
    links: list[ProviderLiteratureKey] = []
    for expected_ordinal, item in enumerate(link_rows):
        values = identifiers_by_link.get(expected_ordinal, [])
        if tuple(value[0] for value in values) != tuple(range(len(values))):
            raise LiteraturePreconditionReadError()
        links.append(
            ProviderLiteratureKey(
                record_id=None if item[1] is None else str(item[1]),
                identifiers=tuple(value[1] for value in values),
            )
        )
    return MetadataObservation(
        observation_id=ObservationId(observation_id),
        provenance=_provenance(connection, str(row[0])),
        metadata=metadata,
        version_role=None if row[1] is None else VersionRole(str(row[1])),
        version_links=tuple(links),
        declared_keywords=tuple(str(item[1]) for item in declared_rows),
        reference_texts=tuple(str(item[1]) for item in reference_rows),
        reference_count=None if row[2] is None else int(row[2]),
        cited_by_count=None if row[3] is None else int(row[3]),
        asset_hints=hints,
    )


def _catalog_artifact(
    connection: sqlite3.Connection,
    path_value: object,
    sha_value: object,
    size_value: object,
    media_value: object,
) -> ArtifactReference:
    path = RelativeArtifactPath(str(path_value))
    sha256 = Sha256(str(sha_value))
    size = _integer(size_value)
    media_type = str(media_value)
    expected_path = content_addressed_reference(sha256, size)
    if path != expected_path:
        raise LiteraturePreconditionReadError()
    row = connection.execute(
        "SELECT sha256,byte_size,media_type FROM artifact_objects WHERE relative_path=?",
        (path.root,),
    ).fetchone()
    if row is None or tuple(row) != (sha256.root, size, media_type):
        raise LiteraturePreconditionReadError()
    return ArtifactReference(
        path=path,
        sha256=sha256,
        byte_size=size,
        media_type=media_type,
    )


def _primary_pdfs(
    connection: sqlite3.Connection,
    literature_id: str,
) -> tuple[CurrentPrimaryPdf, ...]:
    rows = connection.execute(
        "SELECT la.literature_asset_id,la.literature_id,la.asset_id,la.role,la.provenance_id,"
        "la.source_url,a.sha256,a.size_bytes,a.media_type,a.relative_path "
        "FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id "
        "WHERE la.literature_id=? AND la.role='primary-pdf' ORDER BY la.literature_asset_id",
        (literature_id,),
    ).fetchall()
    values: list[CurrentPrimaryPdf] = []
    for row in rows:
        artifact = _catalog_artifact(connection, row[9], row[6], row[7], row[8])
        asset = Asset(
            asset_id=AssetId(str(row[2])),
            sha256=artifact.sha256,
            size_bytes=artifact.byte_size,
            media_type=artifact.media_type,
            path=artifact.path,
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(str(row[0])),
            literature_id=LiteratureId(str(row[1])),
            asset_id=AssetId(str(row[2])),
            role=AssetRole(str(row[3])),
            provenance=_provenance(connection, str(row[4])),
            source_url=None if row[5] is None else str(row[5]),
        )
        values.append(CurrentPrimaryPdf(asset=asset, relation=relation))
    return tuple(values)


def _parser_result(
    connection: sqlite3.Connection,
    source_asset_id: AssetId,
) -> ParserResult | None:
    row = connection.execute(
        "SELECT source_asset_id,source_sha256,result_sha256,page_count,markdown_artifact_path,"
        "markdown_sha256,markdown_byte_size,markdown_media_type,provenance_id,parser_version,"
        "mode,model_identity FROM parser_results WHERE source_asset_id=?",
        (source_asset_id.root,),
    ).fetchone()
    if row is None:
        return None
    markdown = _catalog_artifact(connection, row[4], row[5], row[6], row[7])
    resource_rows = connection.execute(
        "SELECT ordinal,reference,artifact_path,artifact_sha256,artifact_byte_size,"
        "artifact_media_type FROM parser_result_resources WHERE source_asset_id=? "
        "ORDER BY ordinal",
        (source_asset_id.root,),
    ).fetchall()
    if tuple(int(item[0]) for item in resource_rows) != tuple(range(len(resource_rows))):
        raise LiteraturePreconditionReadError()
    resources: list[ParserResource] = []
    for item in resource_rows:
        artifact = _catalog_artifact(connection, item[2], item[3], item[4], item[5])
        resources.append(
            ParserResource(
                reference=str(item[1]),
                artifact=ParserArtifactRef(
                    sha256=artifact.sha256,
                    media_type=artifact.media_type,
                    byte_size=artifact.byte_size,
                ),
            )
        )
    if tuple(item.reference for item in resources) != tuple(
        sorted(item.reference for item in resources)
    ):
        raise LiteraturePreconditionReadError()
    provenance = _provenance(connection, str(row[8]))
    return ParserResult(
        source_asset_id=AssetId(str(row[0])),
        source_sha256=Sha256(str(row[1])),
        result_sha256=Sha256(str(row[2])),
        page_count=int(row[3]),
        markdown=ParserArtifactRef(
            sha256=markdown.sha256,
            media_type=markdown.media_type,
            byte_size=markdown.byte_size,
        ),
        resources=tuple(resources),
        provenance=ParserProvenance(
            provenance=provenance,
            parser_version=str(row[9]),
            mode=None if row[10] is None else str(row[10]),
            model_identity=None if row[11] is None else str(row[11]),
        ),
    )


def _literature_content(
    connection: sqlite3.Connection,
    verified_reader: VerifiedReader,
    literature_id: str,
    metadata_revision: int,
    metadata_digest: Sha256,
    primary_pdfs: tuple[CurrentPrimaryPdf, ...],
) -> tuple[LiteratureContent | None, CurrentContentLineage | None]:
    row = connection.execute(
        "SELECT literature_content_sha256,metadata_revision,metadata_sha256,primary_asset_id,"
        "primary_asset_sha256,parser_result_sha256,structured_artifact_path,"
        "structured_artifact_sha256,structured_artifact_byte_size,"
        "structured_artifact_media_type,markdown_artifact_path,markdown_artifact_sha256,"
        "markdown_artifact_byte_size,markdown_artifact_media_type,analysis_provenance_id "
        "FROM literature_contents WHERE literature_id=?",
        (literature_id,),
    ).fetchone()
    if row is None:
        return None, None
    structured = _catalog_artifact(connection, row[6], row[7], row[8], row[9])
    markdown = _catalog_artifact(connection, row[10], row[11], row[12], row[13])
    if structured.media_type != "application/json" or markdown.media_type != "text/markdown":
        raise LiteraturePreconditionReadError()
    with verified_reader.open(structured) as stream:
        encoded = stream.read()
    content = LiteratureContent.model_validate_json(encoded, strict=True)
    if canonical_literature_content_json(content) != encoded:
        raise LiteraturePreconditionReadError()
    if literature_content_artifact(content) != ArtifactRef(
        sha256=structured.sha256,
        byte_size=structured.byte_size,
        media_type=structured.media_type,
    ):
        raise LiteraturePreconditionReadError()
    expected_markdown = ArtifactRef(
        sha256=markdown.sha256,
        byte_size=markdown.byte_size,
        media_type=markdown.media_type,
    )
    if (
        content.literature_content_sha256 != Sha256(str(row[0]))
        or int(row[1]) != metadata_revision
        or Sha256(str(row[2])) != metadata_digest
        or content.metadata_revision != metadata_revision
        or content.metadata_sha256 != metadata_digest
        or content.markdown != expected_markdown
        or content.provenance.provenance_id != ProvenanceId(str(row[14]))
        or _provenance(connection, str(row[14])) != content.provenance
        or len(primary_pdfs) != 1
    ):
        raise LiteraturePreconditionReadError()
    primary = primary_pdfs[0].asset
    lineage = CurrentContentLineage(
        primary_asset_id=AssetId(str(row[3])),
        primary_pdf_sha256=Sha256(str(row[4])),
        parser_result_sha256=Sha256(str(row[5])),
    )
    if (
        primary.asset_id != lineage.primary_asset_id
        or primary.sha256 != lineage.primary_pdf_sha256
        or content.provenance.input_sha256
        != analysis_input_sha256(
            primary.sha256,
            lineage.parser_result_sha256,
            metadata_digest,
        )
    ):
        raise LiteraturePreconditionReadError()
    return content, lineage


def _facts(
    connection: sqlite3.Connection,
    verified_reader: VerifiedReader,
    literature_id: str,
) -> CurrentLiteratureFacts | None:
    row = connection.execute(
        "SELECT meta_literature_id,version_role FROM literatures WHERE literature_id=?",
        (literature_id,),
    ).fetchone()
    if row is None:
        return None
    current_metadata = _current_metadata(connection, literature_id)
    if current_metadata is None:
        raise LiteraturePreconditionReadError()
    metadata, revision, digest = current_metadata
    draft_literature = Literature(
        literature_id=LiteratureId(literature_id),
        meta_literature_id=MetaLiteratureId(str(row[0])),
        version_role=VersionRole(str(row[1])),
        metadata=metadata,
        status=LiteratureStatus.UNREVIEWED,
    )
    primaries = _primary_pdfs(connection, literature_id)
    parser = (
        _parser_result(connection, primaries[0].asset.asset_id) if len(primaries) == 1 else None
    )
    content, content_lineage = _literature_content(
        connection,
        verified_reader,
        literature_id,
        revision,
        digest,
        primaries,
    )
    result = CurrentLiteratureFacts(
        literature=draft_literature,
        metadata_revision=revision,
        metadata_sha256=digest,
        current_primary_pdfs=primaries,
        current_parser_result=parser,
        current_content=content,
        current_content_lineage=content_lineage,
    )
    return result.model_copy(
        update={"literature": draft_literature.model_copy(update={"status": derive_status(result)})}
    )


def _facts_for_ids(
    connection: sqlite3.Connection,
    verified_reader: VerifiedReader,
    literature_ids: set[str],
) -> tuple[CurrentLiteratureFacts, ...]:
    values: list[CurrentLiteratureFacts] = []
    for literature_id in sorted(literature_ids):
        item = _facts(connection, verified_reader, literature_id)
        if item is not None:
            values.append(item)
    return tuple(values)


def _meta_literatures(
    connection: sqlite3.Connection,
    meta_ids: set[str],
) -> tuple[MetaLiterature, ...]:
    if not meta_ids:
        return ()
    parameters = tuple(sorted(meta_ids))
    rows = connection.execute(
        "SELECT meta_literature_id,representative_literature_id FROM meta_literatures "
        f"WHERE meta_literature_id IN ({_placeholders(cast(tuple[object, ...], parameters))}) "
        "ORDER BY meta_literature_id",
        parameters,
    ).fetchall()
    if len(rows) != len(parameters):
        raise LiteraturePreconditionReadError()
    return tuple(
        MetaLiterature(
            meta_literature_id=MetaLiteratureId(str(row[0])),
            representative_literature_id=LiteratureId(str(row[1])),
        )
        for row in rows
    )


def _observations_for_literatures(
    connection: sqlite3.Connection,
    literature_ids: set[str],
) -> tuple[LiteratureObservation, ...]:
    if not literature_ids:
        return ()
    parameters = tuple(sorted(literature_ids))
    rows = connection.execute(
        "SELECT literature_id,observation_id FROM literature_metadata_observations "
        f"WHERE literature_id IN ({_placeholders(cast(tuple[object, ...], parameters))}) "
        "ORDER BY literature_id,observation_id",
        parameters,
    ).fetchall()
    values: list[LiteratureObservation] = []
    for row in rows:
        observation = _metadata_observation(connection, str(row[1]))
        if observation is None:
            raise LiteraturePreconditionReadError()
        values.append(
            LiteratureObservation(
                literature_id=LiteratureId(str(row[0])),
                observation=observation,
            )
        )
    return tuple(values)


def _references(
    connection: sqlite3.Connection,
    *,
    source_id: str | None = None,
    target_id: str | None = None,
    incident_id: str | None = None,
) -> tuple[Reference, ...]:
    if incident_id is not None:
        rows = connection.execute(
            "SELECT reference_id,source_literature_id,target_literature_id "
            "FROM literature_references WHERE source_literature_id=? OR target_literature_id=? "
            "ORDER BY reference_id",
            (incident_id, incident_id),
        ).fetchall()
    elif source_id is not None and target_id is not None:
        rows = connection.execute(
            "SELECT reference_id,source_literature_id,target_literature_id "
            "FROM literature_references WHERE source_literature_id=? AND target_literature_id=? "
            "ORDER BY reference_id",
            (source_id, target_id),
        ).fetchall()
    elif source_id is not None:
        rows = connection.execute(
            "SELECT reference_id,source_literature_id,target_literature_id "
            "FROM literature_references WHERE source_literature_id=? ORDER BY reference_id",
            (source_id,),
        ).fetchall()
    else:
        raise LiteraturePreconditionReadError()
    return tuple(
        Reference(
            reference_id=ReferenceId(str(row[0])),
            source_literature_id=LiteratureId(str(row[1])),
            target_literature_id=LiteratureId(str(row[2])),
        )
        for row in rows
    )


def _supports(
    connection: sqlite3.Connection,
    references: tuple[Reference, ...],
) -> tuple[ReferenceSupport, ...]:
    reference_ids = tuple(str(item.reference_id) for item in references)
    if not reference_ids:
        return ()
    placeholder = _placeholders(cast(tuple[object, ...], reference_ids))
    provider = tuple(
        ReferenceSupport(
            reference_id=ReferenceId(str(row[0])),
            source=ProviderRelationSupport(
                kind="provider_relation",
                observation_id=ObservationId(str(row[1])),
            ),
        )
        for row in connection.execute(
            "SELECT reference_id,observation_id FROM provider_relation_reference_supports "
            f"WHERE reference_id IN ({placeholder}) ORDER BY reference_id,observation_id",
            reference_ids,
        ).fetchall()
    )
    metadata = tuple(
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
            f"WHERE reference_id IN ({placeholder}) "
            "ORDER BY reference_id,metadata_observation_id,reference_index",
            reference_ids,
        ).fetchall()
    )
    content = tuple(
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
            f"WHERE reference_id IN ({placeholder}) "
            "ORDER BY reference_id,literature_content_sha256,reference_index",
            reference_ids,
        ).fetchall()
    )
    supports = (*provider, *metadata, *content)
    if {item.reference_id for item in supports} != {item.reference_id for item in references}:
        raise LiteraturePreconditionReadError()
    return supports


def _provider_relation(
    connection: sqlite3.Connection,
    observation_id: str,
) -> ProviderRelationObservation | None:
    row = connection.execute(
        "SELECT provenance_id FROM provider_relation_observations WHERE observation_id=?",
        (observation_id,),
    ).fetchone()
    if row is None:
        return None
    endpoint_rows = connection.execute(
        "SELECT endpoint_kind,record_id FROM provider_relation_endpoints "
        "WHERE observation_id=? ORDER BY endpoint_kind",
        (observation_id,),
    ).fetchall()
    if {str(item[0]) for item in endpoint_rows} != {"citing", "cited"}:
        raise LiteraturePreconditionReadError()
    endpoints: dict[str, ProviderLiteratureKey] = {}
    for item in endpoint_rows:
        kind = str(item[0])
        identifier_rows = connection.execute(
            "SELECT ordinal,namespace,value FROM provider_relation_endpoint_identifiers "
            "WHERE observation_id=? AND endpoint_kind=? ORDER BY ordinal",
            (observation_id, kind),
        ).fetchall()
        if tuple(int(value[0]) for value in identifier_rows) != tuple(range(len(identifier_rows))):
            raise LiteraturePreconditionReadError()
        endpoints[kind] = ProviderLiteratureKey(
            record_id=None if item[1] is None else str(item[1]),
            identifiers=tuple(
                Identifier(namespace=str(value[1]), value=str(value[2]))
                for value in identifier_rows
            ),
        )
    return ProviderRelationObservation(
        observation_id=ObservationId(observation_id),
        provenance=_provenance(connection, str(row[0])),
        citing=endpoints["citing"],
        cited=endpoints["cited"],
    )


class LiteraturePreconditionReader:
    """Implement Literature's scoped read Port over one Catalog and artifact root."""

    def __init__(self, engine: CatalogEngine, verified_reader: VerifiedReader) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if not isinstance(verified_reader, VerifiedReader):
            raise TypeError("verified_reader must be a VerifiedReader")
        self._engine = engine
        self._verified_reader = verified_reader

    def read_identity(self, request: IdentityReadRequest) -> IdentityReadContext:
        if not isinstance(request, IdentityReadRequest):
            raise TypeError("request must be IdentityReadRequest")
        return _run_read(self._engine, lambda connection: self._read_identity(connection, request))

    def _read_identity(  # noqa: C901
        self,
        connection: sqlite3.Connection,
        request: IdentityReadRequest,
    ) -> IdentityReadContext:
        seed_ids: set[str] = set()

        def add_observation_owners(observation_ids: set[str]) -> None:
            if not observation_ids:
                return
            parameters = tuple(sorted(observation_ids))
            rows = connection.execute(
                "SELECT literature_id,observation_id FROM literature_metadata_observations "
                f"WHERE observation_id IN ({_placeholders(cast(tuple[object, ...], parameters))})",
                parameters,
            ).fetchall()
            owners = {str(row[1]): str(row[0]) for row in rows}
            for observation_id in observation_ids:
                exists = connection.execute(
                    "SELECT 1 FROM metadata_observations WHERE observation_id=?",
                    (observation_id,),
                ).fetchone()
                if exists is not None and observation_id not in owners:
                    raise LiteraturePreconditionReadError()
            seed_ids.update(owners.values())

        add_observation_owners({request.observation_id.root})
        if request.provider_record_key is not None:
            provider_key = request.provider_record_key
            add_observation_owners(
                {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT o.observation_id FROM provenances p "
                        "JOIN metadata_observations o ON o.provenance_id=p.provenance_id "
                        "WHERE p.source_kind='metadata-provider' AND p.source_name=? "
                        "AND p.source_record_id=? ORDER BY o.observation_id",
                        (provider_key.source_name, provider_key.source_record_id),
                    ).fetchall()
                }
            )
        for namespace, value in request.stable_identifier_keys:
            seed_ids.update(
                str(row[0])
                for row in connection.execute(
                    "SELECT literature_id FROM literature_metadata_identifiers "
                    "WHERE namespace=? AND value=? ORDER BY literature_id",
                    (namespace, value),
                ).fetchall()
            )
        if request.fallback_identity_sha256 is not None:
            seed_ids.update(
                str(row[0])
                for row in connection.execute(
                    "SELECT literature_id FROM literature_fallback_identity_indexes "
                    "WHERE fallback_identity_sha256=? ORDER BY literature_id",
                    (request.fallback_identity_sha256.root,),
                ).fetchall()
            )
        if request.user_observation_semantic_sha256 is not None:
            add_observation_owners(
                {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT observation_id FROM user_observation_semantic_indexes "
                        "WHERE semantic_sha256=? ORDER BY observation_id",
                        (request.user_observation_semantic_sha256.root,),
                    ).fetchall()
                }
            )
        for key in request.version_link_keys:
            candidates: set[str] | None = None
            if key.record_id is not None:
                candidates = {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT o.observation_id FROM metadata_observations o "
                        "JOIN provenances p ON p.provenance_id=o.provenance_id "
                        "WHERE p.source_kind='metadata-provider' AND p.source_name=? "
                        "AND p.source_record_id=? ORDER BY o.observation_id",
                        (key.source_name, key.record_id),
                    ).fetchall()
                }
            for namespace, value in key.stable_identifier_keys:
                matches = {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT observation_id FROM metadata_observation_identifiers "
                        "WHERE namespace=? AND value=? ORDER BY observation_id",
                        (namespace, value),
                    ).fetchall()
                }
                candidates = matches if candidates is None else candidates.intersection(matches)
            add_observation_owners(candidates or set())

        if not seed_ids:
            return IdentityReadContext()
        parameters = tuple(sorted(seed_ids))
        seed_rows = connection.execute(
            "SELECT DISTINCT meta_literature_id FROM literatures "
            f"WHERE literature_id IN ({_placeholders(cast(tuple[object, ...], parameters))})",
            parameters,
        ).fetchall()
        meta_ids = {str(row[0]) for row in seed_rows}
        if not meta_ids:
            raise LiteraturePreconditionReadError()
        meta_parameters = tuple(sorted(meta_ids))
        meta_placeholders = _placeholders(cast(tuple[object, ...], meta_parameters))
        member_rows = connection.execute(
            "SELECT literature_id FROM literatures "
            f"WHERE meta_literature_id IN ({meta_placeholders}) "
            "ORDER BY literature_id",
            meta_parameters,
        ).fetchall()
        member_ids = {str(row[0]) for row in member_rows}
        facts = _facts_for_ids(connection, self._verified_reader, member_ids)
        return IdentityReadContext(
            literatures=tuple(item.literature for item in facts),
            meta_literatures=_meta_literatures(connection, meta_ids),
            observations=_observations_for_literatures(connection, member_ids),
            facts=facts,
        )

    def read_content(self, request: ContentReadRequest) -> ContentReadContext:
        if not isinstance(request, ContentReadRequest):
            raise TypeError("request must be ContentReadRequest")
        return _run_read(self._engine, lambda connection: self._read_content(connection, request))

    def _read_content(
        self,
        connection: sqlite3.Connection,
        request: ContentReadRequest,
    ) -> ContentReadContext:
        literature_id = request.literature_id.root
        facts = _facts_for_ids(connection, self._verified_reader, {literature_id})
        references = _references(connection, source_id=literature_id)
        supports = _supports(connection, references)
        return ContentReadContext(
            literatures=tuple(item.literature for item in facts),
            facts=facts,
            references=references,
            supports=supports,
            reference_closure_token=content_reference_closure_token(
                request.literature_id,
                references,
                supports,
            ),
        )

    def read_reference(self, request: ReferenceReadRequest) -> ReferenceReadContext:
        if not isinstance(request, ReferenceReadRequest):
            raise TypeError("request must be ReferenceReadRequest")
        return _run_read(
            self._engine,
            lambda connection: self._read_reference(connection, request),
        )

    def _read_reference(
        self,
        connection: sqlite3.Connection,
        request: ReferenceReadRequest,
    ) -> ReferenceReadContext:
        endpoint_ids = {
            request.source_literature_id.root,
            request.target_literature_id.root,
        }
        facts = _facts_for_ids(connection, self._verified_reader, endpoint_ids)
        observations: list[LiteratureObservation] = []
        seen_observations: set[str] = set()
        for observation_id, reference_index in request.metadata_reference_keys:
            row = connection.execute(
                "SELECT lmo.literature_id FROM metadata_observation_reference_texts t "
                "JOIN literature_metadata_observations lmo "
                "ON lmo.observation_id=t.observation_id "
                "WHERE t.observation_id=? AND t.reference_index=?",
                (observation_id.root, reference_index),
            ).fetchone()
            if row is None or observation_id.root in seen_observations:
                continue
            observation = _metadata_observation(connection, observation_id.root)
            if observation is None:
                raise LiteraturePreconditionReadError()
            observations.append(
                LiteratureObservation(
                    literature_id=LiteratureId(str(row[0])),
                    observation=observation,
                )
            )
            seen_observations.add(observation_id.root)
        provider_relations = tuple(
            item
            for observation_id in request.provider_relation_observation_ids
            if (item := _provider_relation(connection, observation_id.root)) is not None
        )
        references = _references(
            connection,
            source_id=request.source_literature_id.root,
            target_id=request.target_literature_id.root,
        )
        return ReferenceReadContext(
            literatures=tuple(item.literature for item in facts),
            observations=tuple(observations),
            provider_relations=provider_relations,
            facts=facts,
            references=references,
            supports=_supports(connection, references),
        )

    def read_deletion(self, request: DeletionReadRequest) -> DeletionReadContext:
        if not isinstance(request, DeletionReadRequest):
            raise TypeError("request must be DeletionReadRequest")
        return _run_read(
            self._engine,
            lambda connection: self._read_deletion(connection, request),
        )

    def _read_deletion(
        self,
        connection: sqlite3.Connection,
        request: DeletionReadRequest,
    ) -> DeletionReadContext:
        row = connection.execute(
            "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
            (request.literature_id.root,),
        ).fetchone()
        if row is None:
            return DeletionReadContext()
        meta_id = str(row[0])
        member_ids = {
            str(item[0])
            for item in connection.execute(
                "SELECT literature_id FROM literatures WHERE meta_literature_id=?",
                (meta_id,),
            ).fetchall()
        }
        facts = _facts_for_ids(connection, self._verified_reader, member_ids)
        return DeletionReadContext(
            literatures=tuple(item.literature for item in facts),
            meta_literatures=_meta_literatures(connection, {meta_id}),
            facts=facts,
            references=_references(connection, incident_id=request.literature_id.root),
        )

    def read_current_facts(self, request: CurrentFactsReadRequest) -> CurrentFactsReadContext:
        if not isinstance(request, CurrentFactsReadRequest):
            raise TypeError("request must be CurrentFactsReadRequest")
        return _run_read(
            self._engine,
            lambda connection: CurrentFactsReadContext(
                facts=_facts_for_ids(
                    connection,
                    self._verified_reader,
                    {request.literature_id.root},
                )
            ),
        )


__all__ = (
    "LiteraturePreconditionReadError",
    "LiteraturePreconditionReader",
)
