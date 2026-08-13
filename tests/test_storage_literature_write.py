from __future__ import annotations

import io
import sqlite3
import unittest
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.literature.content import (
    ContentAcceptanceReplacement,
    canonical_literature_content_json,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.ports import (
    ContentPublicationCommand,
    FallbackIdentityIndex,
    IdentityObservationPublicationCommand,
    LiteratureDeletionCommand,
    LiteratureIdentityToken,
    LiteratureObservation,
    MetaLiteratureIdentityToken,
    ReferencePublicationCommand,
    ReferenceSupportAppendCommand,
    StalePreconditionError,
    UserObservationIndex,
    content_reference_closure_token,
)
from sciretriever.literature.state import CurrentLiteratureFacts
from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureSection,
    LiteratureSectionRole,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.literature import (
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
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.sqlite.content_publication import (
    ContentPublicationConflictError,
    ContentPublicationError,
    SqliteContentPublication,
)
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_writer import (
    LiteratureWriter,
    LiteratureWriterIntegrityError,
)

_ID_1 = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_ID_4 = "423e4567-e89b-12d3-a456-426614174000"
_ID_5 = "523e4567-e89b-12d3-a456-426614174000"
_ID_6 = "623e4567-e89b-12d3-a456-426614174000"
_ID_7 = "723e4567-e89b-12d3-a456-426614174000"
_ID_8 = "823e4567-e89b-12d3-a456-426614174000"
_ID_9 = "923e4567-e89b-12d3-a456-426614174000"
_ID_10 = "a23e4567-e89b-12d3-a456-426614174000"
_ID_11 = "b23e4567-e89b-12d3-a456-426614174000"
_ID_12 = "c23e4567-e89b-12d3-a456-426614174000"
_ID_13 = "d23e4567-e89b-12d3-a456-426614174000"
_ID_14 = "e23e4567-e89b-12d3-a456-426614174000"
_ID_15 = "f23e4567-e89b-12d3-a456-426614174000"
_ID_16 = "023e4567-e89b-12d3-a456-426614174000"
_TIMESTAMP = UtcTimestamp("2026-08-10T12:34:56Z")
_HASH_A = Sha256("a" * 64)
_HASH_B = Sha256("b" * 64)
_HASH_C = Sha256("c" * 64)


def _fail_at(expected: str) -> Callable[[str], None]:
    def checkpoint(name: str) -> None:
        if name == expected:
            raise RuntimeError("failpoint")

    return checkpoint


class _StructuredContent:
    __slots__ = ("_payload",)

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        stream = io.BytesIO(self._payload)
        try:
            yield stream
        finally:
            stream.close()

    def __repr__(self) -> str:
        return "<_StructuredContent>"


def _provenance(
    identifier: str,
    *,
    kind: SourceKind = SourceKind.METADATA_PROVIDER,
    name: str = "fixture-provider",
    record_id: str | None = "record-1",
    input_hash: Sha256 | None = _HASH_A,
    parameters_hash: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(identifier),
        source_kind=kind,
        source_name=name,
        source_record_id=record_id,
        observed_at=_TIMESTAMP,
        input_sha256=input_hash,
        parameters_sha256=parameters_hash,
    )


def _metadata(*, title: str = "A paper", final: bool = False) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title,
        authors=(
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                affiliations=(),
            ),
        ),
        abstract="Abstract" if final else None,
        publication_date="2026-01-02" if final else None,
        publication_year=2026,
        document_type="journal-article",
        language="en",
        venue="Journal",
        publisher="Publisher",
        volume="1" if final else None,
        issue="2" if final else None,
        pages="1-10" if final else None,
        identifiers=(Identifier(namespace="doi", value="10.1000/example"),),
        keywords=("analysis", "testing") if final else ("declared",),
    )


def _literature(
    identifier: str,
    *,
    meta_id: str = _ID_2,
    metadata: LiteratureMetadata | None = None,
    role: VersionRole = VersionRole.OTHER,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(identifier),
        meta_literature_id=MetaLiteratureId(meta_id),
        version_role=role,
        metadata=metadata or _metadata(),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    identifier: str, metadata: LiteratureMetadata | None = None
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(identifier),
        provenance=_provenance(identifier),
        metadata=metadata or _metadata(),
        declared_keywords=("declared",),
        reference_texts=("Target paper.",),
        reference_count=1,
        cited_by_count=2,
    )


def _user_observation(identifier: str) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(identifier),
        provenance=_provenance(
            identifier,
            kind=SourceKind.USER,
            name="bibliographic-import",
            record_id=None,
            input_hash=None,
        ),
        metadata=_metadata(final=True),
    )


def _facts(literature: Literature) -> CurrentLiteratureFacts:
    return CurrentLiteratureFacts(
        literature=literature,
        metadata_revision=1,
        metadata_sha256=metadata_sha256(literature.metadata),
    )


def _identity_command(
    source: Literature,
    target: Literature,
    source_observation: MetadataObservation,
    target_observation: MetadataObservation,
    *,
    expected_tokens: tuple[LiteratureIdentityToken, ...] = (),
    expected_meta_tokens: tuple[MetaLiteratureIdentityToken, ...] = (),
    retired: tuple[MetaLiteratureId, ...] = (),
    clear_exhaustion: tuple[LiteratureId, ...] = (),
) -> IdentityObservationPublicationCommand:
    meta_by_id: dict[MetaLiteratureId, MetaLiterature] = {
        source.meta_literature_id: MetaLiterature(
            meta_literature_id=source.meta_literature_id,
            representative_literature_id=source.literature_id,
        )
    }
    if target.meta_literature_id not in meta_by_id:
        meta_by_id[target.meta_literature_id] = MetaLiterature(
            meta_literature_id=target.meta_literature_id,
            representative_literature_id=target.literature_id,
        )
    return IdentityObservationPublicationCommand(
        literatures=(source, target),
        meta_literatures=tuple(meta_by_id.values()),
        observations=(
            LiteratureObservation(
                literature_id=source.literature_id, observation=source_observation
            ),
            LiteratureObservation(
                literature_id=target.literature_id, observation=target_observation
            ),
        ),
        facts=(_facts(source), _facts(target)),
        expected_tokens=expected_tokens,
        expected_meta_tokens=expected_meta_tokens,
        retired_meta_literature_ids=retired,
        clear_automatic_pdf_exhaustion_for=clear_exhaustion,
    )


class LiteratureWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-literature-write-")
        self.addCleanup(self.temporary.cleanup)
        temporary_path = Path(self.temporary.name)
        self.catalog = temporary_path / "catalog.sqlite"
        self.engine = CatalogEngine(self.catalog)
        self.writer = LiteratureWriter(self.engine)
        self.storage_root = StorageRoot(temporary_path / "artifacts")
        self.artifact_store = ArtifactStore(self.storage_root)
        self.verified_reader = VerifiedReader(self.storage_root)
        self.content_publication = SqliteContentPublication(
            self.engine,
            self.artifact_store,
            self.verified_reader,
        )

    def _table_columns(self, name: str) -> tuple[str, ...]:
        with self.engine.read_snapshot() as connection:
            return tuple(row[1] for row in connection.execute(f'PRAGMA table_info("{name}")'))

    def test_fresh_schema_contains_only_relation_tables_and_no_json_or_status(self) -> None:
        with self.engine.read_snapshot() as connection:
            table_names = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            )
            schema_sql = "\n".join(
                row[0] or ""
                for row in connection.execute(
                    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
                )
            )
        self.assertIn("literatures", table_names)
        self.assertIn("literature_references", table_names)
        self.assertIn("content_reference_text_supports", table_names)
        self.assertIn("literature_search_fts", table_names)
        self.assertIn("literature_search_fts_data", table_names)
        self.assertNotIn("literature_sections", table_names)
        self.assertNotIn("literature_subsections", table_names)
        self.assertNotIn("literature_fallback_identity_authors", table_names)
        self.assertNotIn("JSON", schema_sql.upper())
        self.assertNotIn("DETAILS", schema_sql.upper())
        self.assertNotIn("VENDOR", schema_sql.upper())
        literature_columns = " ".join(self._table_columns("literatures"))
        self.assertNotIn("status", literature_columns.lower())
        self.assertEqual(
            self._table_columns("literature_fallback_identity_indexes"),
            ("literature_id", "fallback_identity_sha256"),
        )
        self.assertEqual(
            self._table_columns("literature_search_fts"),
            (
                "literature_id",
                "title",
                "abstract",
                "authors",
                "affiliations",
                "identifiers",
                "keywords",
                "venue",
                "publisher",
                "volume",
                "issue",
                "pages",
                "content_body",
            ),
        )
        content_columns = self._table_columns("literature_contents")
        for name in (
            "metadata_revision",
            "metadata_sha256",
            "primary_asset_id",
            "primary_asset_sha256",
            "parser_result_sha256",
            "structured_artifact_path",
            "structured_artifact_sha256",
            "structured_artifact_byte_size",
            "structured_artifact_media_type",
            "markdown_artifact_path",
            "markdown_artifact_sha256",
            "markdown_artifact_byte_size",
            "markdown_artifact_media_type",
        ):
            self.assertIn(name, content_columns)

    def test_identity_observation_metadata_and_ordered_children_are_atomic_and_idempotent(
        self,
    ) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        source_observation = _observation(_ID_4)
        target_observation = _observation(_ID_5)
        command = _identity_command(
            source,
            target,
            source_observation,
            target_observation,
        )
        self.writer.publish_identity_and_observation(command)
        self.writer.publish_identity_and_observation(command)
        replayed_source_observation = source_observation.model_copy(
            update={
                "provenance": source_observation.provenance.model_copy(
                    update={
                        "provenance_id": ProvenanceId(_ID_6),
                        "observed_at": UtcTimestamp("2026-08-10T12:35:56Z"),
                    }
                )
            }
        )
        self.writer.publish_identity_and_observation(
            _identity_command(
                source,
                target,
                replayed_source_observation,
                target_observation,
            )
        )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literatures").fetchone(), (2,)
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM metadata_observations").fetchone(),
                (2,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM literature_metadata_observations"
                ).fetchone(),
                (2,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM provenances").fetchone(),
                (2,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT provenance_id FROM metadata_observations WHERE observation_id=?",
                    (_ID_4,),
                ).fetchone(),
                (_ID_4,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT observed_at FROM provenances WHERE provenance_id=?",
                    (_ID_4,),
                ).fetchone(),
                (str(_TIMESTAMP),),
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM provenances WHERE provenance_id=?",
                    (_ID_6,),
                ).fetchone()
            )
            self.assertEqual(
                connection.execute(
                    "SELECT ordinal,display_name FROM literature_metadata_authors "
                    "WHERE literature_id=? ORDER BY ordinal",
                    (_ID_1,),
                ).fetchall(),
                [(0, "Ada Lovelace")],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT ordinal,namespace,value FROM literature_metadata_identifiers "
                    "WHERE literature_id=? ORDER BY ordinal",
                    (_ID_1,),
                ).fetchall(),
                [(0, "doi", "10.1000/example")],
            )

    def test_collision_indexes_and_current_metadata_fts_are_lossless_projections(self) -> None:
        source_metadata = _metadata().model_copy(update={"identifiers": ()})
        target_metadata = _metadata(title="Target title").model_copy(update={"identifiers": ()})
        source = _literature(_ID_1, metadata=source_metadata)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=target_metadata)
        source_observation = _user_observation(_ID_4).model_copy(
            update={
                "metadata": source_metadata,
                "reference_texts": ("observationneedle",),
            }
        )
        target_observation = _user_observation(_ID_5).model_copy(
            update={"metadata": target_metadata}
        )
        collision_hash = Sha256("d" * 64)
        command = _identity_command(
            source,
            target,
            source_observation,
            target_observation,
        ).model_copy(
            update={
                "fallback_identity_indexes": (
                    FallbackIdentityIndex(
                        literature_id=source.literature_id,
                        fallback_identity_sha256=collision_hash,
                    ),
                    FallbackIdentityIndex(
                        literature_id=target.literature_id,
                        fallback_identity_sha256=collision_hash,
                    ),
                ),
                "user_observation_indexes": (
                    UserObservationIndex(
                        observation_id=source_observation.observation_id,
                        semantic_sha256=collision_hash,
                    ),
                    UserObservationIndex(
                        observation_id=target_observation.observation_id,
                        semantic_sha256=collision_hash,
                    ),
                ),
            }
        )
        self.writer.publish_identity_and_observation(command)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_fallback_identity_indexes "
                    "WHERE fallback_identity_sha256=? ORDER BY literature_id",
                    (collision_hash.root,),
                ).fetchall(),
                [(_ID_1,), (_ID_3,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT observation_id FROM user_observation_semantic_indexes "
                    "WHERE semantic_sha256=? ORDER BY observation_id",
                    (collision_hash.root,),
                ).fetchall(),
                [(_ID_4,), (_ID_5,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'Target'"
                ).fetchall(),
                [(_ID_3,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'observationneedle'"
                ).fetchall(),
                [],
            )

    def test_user_and_provider_observations_preserve_source_provenance_without_payload_columns(
        self,
    ) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        command = _identity_command(source, target, _user_observation(_ID_4), _observation(_ID_5))
        self.writer.publish_identity_and_observation(command)
        with self.engine.read_snapshot() as connection:
            row = connection.execute(
                "SELECT source_kind,source_name,source_record_id,input_sha256,parameters_sha256 "
                "FROM provenances WHERE provenance_id=?",
                (_ID_4,),
            ).fetchone()
            self.assertEqual(row, ("user", "bibliographic-import", None, None, None))
            columns = self._table_columns("metadata_observations")
            self.assertNotIn("payload", columns)
            self.assertNotIn("details", columns)
            self.assertNotIn("json", columns)

    def test_primary_pdf_is_unique_pdf_only_while_other_roles_remain_many(self) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        self.writer.publish_identity_and_observation(
            _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        )
        asset_specs = (
            (_ID_10, Sha256("d" * 64), "application/pdf"),
            (_ID_11, Sha256("e" * 64), "application/pdf"),
            (_ID_12, Sha256("f" * 64), "text/html"),
        )
        with self.engine.write_transaction() as connection:
            connection.executemany(
                "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,"
                "relative_path) VALUES(?,?,?,?,?)",
                (
                    (
                        f"asset-{asset_id}",
                        digest.root,
                        2,
                        media_type,
                        f".objects/{digest.root[:2]}/{digest.root}-2",
                    )
                    for asset_id, digest, media_type in asset_specs
                ),
            )
        assets = tuple(
            Asset(
                asset_id=AssetId(asset_id),
                sha256=digest,
                size_bytes=2,
                media_type=media_type,
                path=RelativeArtifactPath(f".objects/{digest.root[:2]}/{digest.root}-2"),
            )
            for asset_id, digest, media_type in asset_specs
        )
        for asset in assets:
            self.writer.publish_asset(asset)
        provenance = _provenance(
            _ID_13,
            kind=SourceKind.ASSET_PROVIDER,
            name="fixture-assets",
            record_id="asset-record",
        )

        def relation(
            relation_id: str,
            literature: Literature,
            asset: Asset,
            role: AssetRole,
        ) -> LiteratureAsset:
            return LiteratureAsset(
                literature_asset_id=LiteratureAssetId(relation_id),
                literature_id=literature.literature_id,
                asset_id=asset.asset_id,
                role=role,
                provenance=provenance,
                source_url="https://example.test/file",
            )

        self.writer.publish_literature_asset(
            relation(_ID_6, source, assets[0], AssetRole.SUPPLEMENTARY_PDF)
        )
        self.writer.publish_literature_asset(
            relation(_ID_7, source, assets[1], AssetRole.SUPPLEMENTARY_PDF)
        )
        self.writer.publish_literature_asset(
            relation(_ID_8, source, assets[0], AssetRole.PRIMARY_PDF)
        )
        with self.assertRaises(LiteratureWriterIntegrityError):
            self.writer.publish_literature_asset(
                relation(_ID_9, source, assets[1], AssetRole.PRIMARY_PDF)
            )
        with self.assertRaises(LiteratureWriterIntegrityError):
            self.writer.publish_literature_asset(
                relation(_ID_14, target, assets[2], AssetRole.PRIMARY_PDF)
            )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT role,count(*) FROM literature_assets WHERE literature_id=? "
                    "GROUP BY role ORDER BY role",
                    (_ID_1,),
                ).fetchall(),
                [("primary-pdf", 1), ("supplementary-pdf", 2)],
            )

    def test_meta_membership_tokens_retire_old_meta_and_clear_exhaustion(self) -> None:
        source = _literature(_ID_1, meta_id=_ID_2)
        target = _literature(_ID_3, meta_id=_ID_4, metadata=_metadata(title="Target"))
        first = _identity_command(source, target, _observation(_ID_5), _observation(_ID_6))
        self.writer.publish_identity_and_observation(first)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO automatic_pdf_acquisition_exhaustions(literature_id) VALUES (?)",
                (_ID_1,),
            )
            connection.execute(
                "INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) "
                "VALUES(?,?,?,?)",
                ("topic-run", "topic", "COMPLETED", "2026-08-11T00:00:00Z"),
            )
            connection.execute(
                "INSERT INTO topic_discovery_inputs("
                "discovery_run_id,kind,query,year_from,year_to) VALUES(?,?,?,?,?)",
                ("topic-run", "topic", "topic", None, None),
            )
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?)",
                ("topic-run", _ID_2),
            )
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?)",
                ("topic-run", _ID_4),
            )
            connection.execute(
                "INSERT INTO topic_discovery_causes("
                "discovery_run_id,meta_literature_id,metadata_observation_id,"
                "actual_literature_id) VALUES(?,?,?,?)",
                ("topic-run", _ID_2, _ID_5, _ID_1),
            )
            connection.execute(
                "INSERT INTO topic_discovery_causes("
                "discovery_run_id,meta_literature_id,metadata_observation_id,"
                "actual_literature_id) VALUES(?,?,?,?)",
                ("topic-run", _ID_4, _ID_6, _ID_3),
            )
            connection.execute(
                "INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) "
                "VALUES(?,?,?,?)",
                ("citation-run", "citation", "COMPLETED", "2026-08-11T00:00:00Z"),
            )
            connection.execute(
                "INSERT INTO citation_discovery_inputs("
                "discovery_run_id,kind,direction,max_depth,result_limit) VALUES(?,?,?,?,?)",
                ("citation-run", "citation", "references", 1, 10),
            )
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?)",
                ("citation-run", _ID_2),
            )
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?)",
                ("citation-run", _ID_4),
            )
            connection.execute(
                "INSERT INTO citation_discovery_causes("
                "discovery_run_id,meta_literature_id,source_literature_id,"
                "target_literature_id,actual_literature_id,depth) VALUES(?,?,?,?,?,?)",
                ("citation-run", _ID_2, _ID_1, _ID_3, _ID_1, 1),
            )
            connection.execute(
                "INSERT INTO citation_discovery_causes("
                "discovery_run_id,meta_literature_id,source_literature_id,"
                "target_literature_id,actual_literature_id,depth) VALUES(?,?,?,?,?,?)",
                ("citation-run", _ID_4, _ID_1, _ID_3, _ID_3, 2),
            )
        updated_source = source.model_copy(update={"meta_literature_id": MetaLiteratureId(_ID_4)})
        updated_target = target.model_copy(update={"meta_literature_id": MetaLiteratureId(_ID_4)})
        new_meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_4),
            representative_literature_id=updated_source.literature_id,
        )
        command = IdentityObservationPublicationCommand(
            literatures=(updated_source, updated_target),
            meta_literatures=(new_meta,),
            observations=(),
            facts=(_facts(updated_source), _facts(updated_target)),
            expected_tokens=(
                LiteratureIdentityToken(
                    literature_id=source.literature_id,
                    meta_literature_id=source.meta_literature_id,
                    metadata_revision=1,
                    metadata_sha256=metadata_sha256(source.metadata),
                ),
                LiteratureIdentityToken(
                    literature_id=target.literature_id,
                    meta_literature_id=target.meta_literature_id,
                    metadata_revision=1,
                    metadata_sha256=metadata_sha256(target.metadata),
                ),
            ),
            expected_meta_tokens=(
                MetaLiteratureIdentityToken(
                    meta_literature_id=MetaLiteratureId(_ID_2),
                    representative_literature_id=source.literature_id,
                    member_literature_ids=(source.literature_id,),
                ),
                MetaLiteratureIdentityToken(
                    meta_literature_id=MetaLiteratureId(_ID_4),
                    representative_literature_id=target.literature_id,
                    member_literature_ids=(target.literature_id,),
                ),
            ),
            retired_meta_literature_ids=(MetaLiteratureId(_ID_2),),
            clear_automatic_pdf_exhaustion_for=(source.literature_id,),
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) "
                "VALUES(?,?,?,?)",
                ("unmapped-run", "topic", "COMPLETED", "2026-08-11T00:00:00Z"),
            )
            connection.execute(
                "INSERT INTO topic_discovery_inputs("
                "discovery_run_id,kind,query,year_from,year_to) VALUES(?,?,?,?,?)",
                ("unmapped-run", "topic", "unmapped", None, None),
            )
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?)",
                ("unmapped-run", _ID_2),
            )
        with self.assertRaises(LiteratureWriterIntegrityError):
            self.writer.publish_identity_and_observation(command)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (_ID_2,),
            )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM discovery_results WHERE discovery_run_id=?",
                ("unmapped-run",),
            )
            connection.execute(
                "DELETE FROM topic_discovery_inputs WHERE discovery_run_id=?",
                ("unmapped-run",),
            )
            connection.execute(
                "DELETE FROM discovery_runs WHERE discovery_run_id=?",
                ("unmapped-run",),
            )
        for checkpoint in (
            "identity-after-preconditions",
            "identity-after-current-metadata",
            "identity-after-observations",
            "identity-before-meta-retire",
            "identity-after-meta-retire",
            "identity-after",
        ):
            with self.subTest(checkpoint=checkpoint):
                crashing = LiteratureWriter(self.engine, failpoint=_fail_at(checkpoint))
                with self.assertRaises(RuntimeError):
                    crashing.publish_identity_and_observation(command)
                with self.engine.read_snapshot() as connection:
                    self.assertEqual(
                        connection.execute(
                            "SELECT meta_literature_id FROM literatures ORDER BY literature_id"
                        ).fetchall(),
                        [(_ID_2,), (_ID_4,)],
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT meta_literature_id FROM meta_literatures "
                            "ORDER BY meta_literature_id"
                        ).fetchall(),
                        [(_ID_2,), (_ID_4,)],
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT discovery_run_id,meta_literature_id "
                            "FROM discovery_results "
                            "ORDER BY discovery_run_id,meta_literature_id"
                        ).fetchall(),
                        [
                            ("citation-run", _ID_2),
                            ("citation-run", _ID_4),
                            ("topic-run", _ID_2),
                            ("topic-run", _ID_4),
                        ],
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT meta_literature_id,metadata_observation_id,"
                            "actual_literature_id FROM topic_discovery_causes "
                            "ORDER BY metadata_observation_id"
                        ).fetchall(),
                        [(_ID_2, _ID_5, _ID_1), (_ID_4, _ID_6, _ID_3)],
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT meta_literature_id,actual_literature_id,depth "
                            "FROM citation_discovery_causes ORDER BY depth"
                        ).fetchall(),
                        [(_ID_2, _ID_1, 1), (_ID_4, _ID_3, 2)],
                    )
        self.writer.publish_identity_and_observation(command)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM meta_literatures").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute(
                    "SELECT meta_literature_id FROM literatures ORDER BY literature_id"
                ).fetchall(),
                [(_ID_4,), (_ID_4,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM automatic_pdf_acquisition_exhaustions"
                ).fetchone(),
                (0,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT discovery_run_id,meta_literature_id FROM discovery_results "
                    "ORDER BY discovery_run_id"
                ).fetchall(),
                [("citation-run", _ID_4), ("topic-run", _ID_4)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT meta_literature_id,metadata_observation_id,actual_literature_id "
                    "FROM topic_discovery_causes ORDER BY metadata_observation_id"
                ).fetchall(),
                [(_ID_4, _ID_5, _ID_1), (_ID_4, _ID_6, _ID_3)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT meta_literature_id,source_literature_id,target_literature_id,"
                    "actual_literature_id,depth FROM citation_discovery_causes ORDER BY depth"
                ).fetchall(),
                [
                    (_ID_4, _ID_1, _ID_3, _ID_1, 1),
                    (_ID_4, _ID_1, _ID_3, _ID_3, 2),
                ],
            )

    def test_reference_and_support_are_idempotent_and_endpoint_fk_protected(self) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        self.writer.publish_identity_and_observation(
            _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        )
        relation = ProviderRelationObservation(
            observation_id=ObservationId(_ID_6),
            provenance=_provenance(_ID_6),
            citing=ProviderLiteratureKey(record_id="source"),
            cited=ProviderLiteratureKey(record_id="target"),
        )
        self.writer.publish_provider_relation_observation(relation)
        reference = Reference(
            reference_id=ReferenceId(_ID_7),
            source_literature_id=source.literature_id,
            target_literature_id=target.literature_id,
        )
        support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=ProviderRelationSupport(
                kind="provider_relation", observation_id=relation.observation_id
            ),
        )
        token_source = LiteratureIdentityToken(
            literature_id=source.literature_id,
            meta_literature_id=source.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(source.metadata),
        )
        token_target = token_source.model_copy(
            update={
                "literature_id": target.literature_id,
                "metadata_sha256": metadata_sha256(target.metadata),
            }
        )
        command = ReferencePublicationCommand(
            source_token=token_source,
            target_token=token_target,
            reference=reference,
            supports=(support,),
        )
        for checkpoint in ("reference-after-edge", "reference-after-supports"):
            with self.subTest(checkpoint=checkpoint):
                crashing = LiteratureWriter(
                    self.engine,
                    failpoint=_fail_at(checkpoint),
                )
                with self.assertRaises(RuntimeError):
                    crashing.publish_reference(command)
                with self.engine.read_snapshot() as connection:
                    self.assertEqual(
                        connection.execute("SELECT count(*) FROM literature_references").fetchone(),
                        (0,),
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT count(*) FROM provider_relation_reference_supports"
                        ).fetchone(),
                        (0,),
                    )
        self.writer.publish_reference(command)
        self.writer.publish_reference(command)
        metadata_support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=MetadataReferenceTextSupport(
                kind="metadata_reference_text",
                metadata_observation_id=ObservationId(_ID_4),
                reference_index=0,
            ),
        )
        append = ReferenceSupportAppendCommand(
            source_token=token_source,
            target_token=token_target,
            reference=reference,
            supports=(metadata_support,),
        )
        self.writer.append_reference_support(append)
        self.writer.append_reference_support(append)
        with self.assertRaises(StalePreconditionError):
            self.writer.append_reference_support(
                append.model_copy(
                    update={
                        "source_token": token_source.model_copy(update={"metadata_revision": 99})
                    }
                )
            )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_references").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM provider_relation_reference_supports"
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM metadata_reference_text_supports"
                ).fetchone(),
                (1,),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            with self.engine.write_transaction() as connection:
                connection.execute(
                    "INSERT INTO literature_references(reference_id,source_literature_id,"
                    "target_literature_id) "
                    "VALUES (?,?,?)",
                    (_ID_8, _ID_1, _ID_1),
                )
        with self.assertRaises(LiteratureWriterIntegrityError):
            self.writer.delete_literature(
                LiteratureDeletionCommand(
                    expected_token=token_source,
                    expected_meta_token=MetaLiteratureIdentityToken(
                        meta_literature_id=source.meta_literature_id,
                        representative_literature_id=source.literature_id,
                        member_literature_ids=(source.literature_id, target.literature_id),
                    ),
                    literature_id=source.literature_id,
                    replacement_representative_id=target.literature_id,
                )
            )

    def test_content_replacement_cleans_scoped_old_content_support_and_supportless_reference(
        self,
    ) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        self.writer.publish_identity_and_observation(
            _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        )
        final_metadata = _metadata(final=True)
        content = self._content(
            source,
            metadata=final_metadata,
            revision=2,
            body="replacementbody",
        )
        old_content = self._content(source, reference="Old target.")
        # Publish an old current content first, then a content-only reference.
        self._publish_content(source, old_content)
        relation = ProviderRelationObservation(
            observation_id=ObservationId(_ID_6),
            provenance=_provenance(_ID_6),
            citing=ProviderLiteratureKey(record_id="source"),
            cited=ProviderLiteratureKey(record_id="target"),
        )
        self.writer.publish_provider_relation_observation(relation)
        reference = Reference(
            reference_id=ReferenceId(_ID_7),
            source_literature_id=source.literature_id,
            target_literature_id=target.literature_id,
        )
        provider_support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=ProviderRelationSupport(
                kind="provider_relation", observation_id=relation.observation_id
            ),
        )
        token_source = LiteratureIdentityToken(
            literature_id=source.literature_id,
            meta_literature_id=source.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(source.metadata),
        )
        token_target = token_source.model_copy(
            update={
                "literature_id": target.literature_id,
                "metadata_sha256": metadata_sha256(target.metadata),
            },
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=token_source,
                target_token=token_target,
                reference=reference,
                supports=(provider_support,),
            )
        )
        # A directed pair is unique.  Use a second target to exercise a
        # content-only edge that becomes supportless after replacement.
        content_target = _literature(
            _ID_14, meta_id=_ID_2, metadata=_metadata(title="Other target")
        )
        self.writer.publish_identity_and_observation(
            _identity_command(source, content_target, _observation(_ID_14), _observation(_ID_15))
        )
        content_target_token = token_target.model_copy(
            update={
                "literature_id": content_target.literature_id,
                "meta_literature_id": content_target.meta_literature_id,
                "metadata_sha256": metadata_sha256(content_target.metadata),
            }
        )
        # The content-only reference uses a separate target and should disappear.
        content_reference = Reference(
            reference_id=ReferenceId(_ID_8),
            source_literature_id=source.literature_id,
            target_literature_id=content_target.literature_id,
        )
        content_support = ReferenceSupport(
            reference_id=content_reference.reference_id,
            source=ContentReferenceTextSupport(
                kind="content_reference_text",
                literature_content_sha256=old_content.literature_content_sha256,
                reference_index=0,
            ),
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=token_source,
                target_token=content_target_token,
                reference=content_reference,
                supports=(content_support,),
            )
        )
        replacement = self._replacement(source, content, final_metadata)
        cleanup = self._cleanup(
            source.literature_id,
            old_content.literature_content_sha256,
            references=(reference, content_reference),
            supports=(provider_support, content_support),
        )
        structured = self._prepare_content_dependencies(source, content)
        command = ContentPublicationCommand(
            expected_token=token_source,
            expected_primary_asset_id=AssetId(_ID_10),
            expected_primary_pdf_sha256=_HASH_A,
            expected_parser_result_sha256=_HASH_B,
            replacement=replacement,
            structured_artifact=structured,
            structured_content=self._structured_content(content),
            cleanup=cleanup,
            expected_reference_closure_token=content_reference_closure_token(
                source.literature_id,
                (reference, content_reference),
                (provider_support, content_support),
            ),
        )
        wrong_structured = ArtifactRef(
            sha256=Sha256("0" * 64),
            media_type="application/json",
            byte_size=1,
        )
        with self.assertRaises(ContentPublicationError):
            self.content_publication.publish_content(
                command.model_copy(update={"structured_artifact": wrong_structured})
            )
        incomplete_closure = content_reference_closure_token(
            source.literature_id,
            (content_reference,),
            (content_support,),
        )
        with self.assertRaises(StalePreconditionError):
            self.content_publication.publish_content(
                command.model_copy(update={"expected_reference_closure_token": incomplete_closure})
            )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT literature_content_sha256 FROM literature_contents "
                    "WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (old_content.literature_content_sha256.root,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM content_reference_text_supports"
                ).fetchone(),
                (1,),
            )
        for checkpoint in (
            "after-metadata-replacement",
            "after-cleanup",
            "after-binding",
        ):
            with self.subTest(checkpoint=checkpoint):
                crashing = SqliteContentPublication(
                    self.engine,
                    self.artifact_store,
                    self.verified_reader,
                    failpoint=_fail_at(checkpoint),
                )
                with self.assertRaises(ContentPublicationError):
                    crashing.publish_content(command)
                with self.engine.read_snapshot() as connection:
                    self.assertEqual(
                        connection.execute(
                            "SELECT metadata_revision,abstract FROM literature_metadata "
                            "WHERE literature_id=?",
                            (_ID_1,),
                        ).fetchone(),
                        (1, None),
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT literature_content_sha256 FROM literature_contents "
                            "WHERE literature_id=?",
                            (_ID_1,),
                        ).fetchone(),
                        (old_content.literature_content_sha256.root,),
                    )
                    self.assertEqual(
                        connection.execute("SELECT count(*) FROM literature_references").fetchone(),
                        (2,),
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT count(*) FROM content_reference_text_supports"
                        ).fetchone(),
                        (1,),
                    )
        self.content_publication.publish_content(command)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_contents").fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_references").fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM provider_relation_reference_supports"
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM content_reference_text_supports"
                ).fetchone(),
                (0,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'replacementbody'"
                ).fetchall(),
                [(_ID_1,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT metadata_revision,abstract,volume,issue,pages "
                    "FROM literature_metadata WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (2, "Abstract", "1", "2", "1-10"),
            )
            for term in ("Abstract", "analysis"):
                self.assertEqual(
                    connection.execute(
                        "SELECT literature_id FROM literature_search_fts "
                        "WHERE literature_search_fts MATCH ?",
                        (term,),
                    ).fetchall(),
                    [(_ID_1,)],
                )
            for term in ("Journal", "Publisher"):
                self.assertEqual(
                    {
                        row[0]
                        for row in connection.execute(
                            "SELECT literature_id FROM literature_search_fts "
                            "WHERE literature_search_fts MATCH ?",
                            (term,),
                        ).fetchall()
                    },
                    {_ID_1, _ID_3, _ID_14},
                )
            self.assertEqual(
                {
                    row[0]
                    for row in connection.execute(
                        "SELECT literature_id FROM literature_search_fts "
                        "WHERE literature_search_fts MATCH 'declared'"
                    ).fetchall()
                },
                {_ID_3, _ID_14},
            )
            structured_path = (
                f".objects/{structured.sha256.root[:2]}/"
                f"{structured.sha256.root}-{structured.byte_size}"
            )
            self.assertEqual(
                connection.execute(
                    "SELECT primary_asset_id,primary_asset_sha256,parser_result_sha256,"
                    "structured_artifact_path,structured_artifact_sha256,"
                    "structured_artifact_byte_size,structured_artifact_media_type,"
                    "markdown_artifact_sha256,markdown_artifact_byte_size,"
                    "markdown_artifact_media_type FROM literature_contents "
                    "WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (
                    _ID_10,
                    _HASH_A.root,
                    _HASH_B.root,
                    structured_path,
                    structured.sha256.root,
                    structured.byte_size,
                    "application/json",
                    content.markdown.sha256.root,
                    content.markdown.byte_size,
                    "text/markdown",
                ),
            )

    def test_shared_content_hash_projection_survives_one_literature_deletion(self) -> None:
        metadata = _metadata()
        source = _literature(_ID_1, metadata=metadata)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=metadata)
        self.writer.publish_identity_and_observation(
            _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        )
        content = self._content(source)
        self._publish_content(source, content)
        self._publish_content(target, content)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_contents").fetchone(),
                (2,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM literature_content_reference_texts "
                    "WHERE literature_content_sha256=?",
                    (content.literature_content_sha256.root,),
                ).fetchone(),
                (1,),
            )
        target_token = LiteratureIdentityToken(
            literature_id=target.literature_id,
            meta_literature_id=target.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(target.metadata),
        )
        self.writer.delete_literature(
            LiteratureDeletionCommand(
                expected_token=target_token,
                expected_meta_token=MetaLiteratureIdentityToken(
                    meta_literature_id=source.meta_literature_id,
                    representative_literature_id=source.literature_id,
                    member_literature_ids=(source.literature_id, target.literature_id),
                ),
                literature_id=target.literature_id,
            )
        )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT literature_id FROM literature_contents").fetchall(),
                [(_ID_1,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT reference_text FROM literature_content_reference_texts "
                    "WHERE literature_content_sha256=?",
                    (content.literature_content_sha256.root,),
                ).fetchall(),
                [("Target paper.",)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'body'"
                ).fetchall(),
                [(_ID_1,)],
            )

    def test_shared_hash_sources_keep_independent_support_and_fts_lifecycles(self) -> None:
        shared_metadata = _metadata()
        source_a = _literature(_ID_1, meta_id=_ID_2, metadata=shared_metadata)
        source_b = _literature(_ID_3, meta_id=_ID_4, metadata=shared_metadata)
        target_a = _literature(
            _ID_5,
            meta_id=_ID_6,
            metadata=_metadata(title="Target Alpha"),
        )
        target_b = _literature(
            _ID_7,
            meta_id=_ID_8,
            metadata=_metadata(title="Target Beta"),
        )
        self.writer.publish_identity_and_observation(
            _identity_command(
                source_a,
                target_a,
                _observation(_ID_10, shared_metadata),
                _observation(_ID_12, target_a.metadata),
            )
        )
        self.writer.publish_identity_and_observation(
            _identity_command(
                source_b,
                target_b,
                _observation(_ID_14, shared_metadata),
                _observation(_ID_15, target_b.metadata),
            )
        )
        shared_content = self._content(source_a, body="sharedbody")
        self._publish_content(source_a, shared_content)
        self._publish_content(source_b, shared_content)

        def token(literature: Literature) -> LiteratureIdentityToken:
            return LiteratureIdentityToken(
                literature_id=literature.literature_id,
                meta_literature_id=literature.meta_literature_id,
                metadata_revision=1,
                metadata_sha256=metadata_sha256(literature.metadata),
            )

        reference_a = Reference(
            reference_id=ReferenceId(_ID_6),
            source_literature_id=source_a.literature_id,
            target_literature_id=target_a.literature_id,
        )
        reference_b = Reference(
            reference_id=ReferenceId(_ID_8),
            source_literature_id=source_b.literature_id,
            target_literature_id=target_b.literature_id,
        )
        support_a = ReferenceSupport(
            reference_id=reference_a.reference_id,
            source=ContentReferenceTextSupport(
                kind="content_reference_text",
                literature_content_sha256=shared_content.literature_content_sha256,
                reference_index=0,
            ),
        )
        support_b = support_a.model_copy(update={"reference_id": reference_b.reference_id})
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=token(source_a),
                target_token=token(target_a),
                reference=reference_a,
                supports=(support_a,),
            )
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=token(source_b),
                target_token=token(target_b),
                reference=reference_b,
                supports=(support_b,),
            )
        )
        replacement_content = self._content(
            source_a,
            reference="Replacement only.",
            body="replacementonly",
        )
        cleanup = self._cleanup(
            source_a.literature_id,
            shared_content.literature_content_sha256,
            references=(reference_a,),
            supports=(support_a,),
        )
        structured = self._prepare_content_dependencies(source_a, replacement_content)
        self.content_publication.publish_content(
            ContentPublicationCommand(
                expected_token=token(source_a),
                expected_primary_asset_id=AssetId(_ID_10),
                expected_primary_pdf_sha256=_HASH_A,
                expected_parser_result_sha256=_HASH_B,
                replacement=self._replacement(source_a, replacement_content),
                structured_artifact=structured,
                structured_content=self._structured_content(replacement_content),
                cleanup=cleanup,
                expected_reference_closure_token=content_reference_closure_token(
                    source_a.literature_id,
                    (reference_a,),
                    (support_a,),
                ),
            )
        )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT reference_id FROM literature_references ORDER BY reference_id"
                ).fetchall(),
                [(_ID_8,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT reference_id,literature_content_sha256 "
                    "FROM content_reference_text_supports"
                ).fetchall(),
                [(_ID_8, shared_content.literature_content_sha256.root)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'sharedbody'"
                ).fetchall(),
                [(_ID_3,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'replacementonly'"
                ).fetchall(),
                [(_ID_1,)],
            )
        self.writer.delete_literature(
            LiteratureDeletionCommand(
                expected_token=token(source_a),
                expected_meta_token=MetaLiteratureIdentityToken(
                    meta_literature_id=source_a.meta_literature_id,
                    representative_literature_id=source_a.literature_id,
                    member_literature_ids=(source_a.literature_id,),
                ),
                literature_id=source_a.literature_id,
            )
        )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id,literature_content_sha256 FROM literature_contents"
                ).fetchall(),
                [(_ID_3, shared_content.literature_content_sha256.root)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT reference_text FROM literature_content_reference_texts "
                    "WHERE literature_content_sha256=?",
                    (shared_content.literature_content_sha256.root,),
                ).fetchall(),
                [("Target paper.",)],
            )
            self.assertEqual(
                connection.execute("SELECT reference_id FROM literature_references").fetchall(),
                [(_ID_8,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT reference_id,literature_content_sha256 "
                    "FROM content_reference_text_supports"
                ).fetchall(),
                [(_ID_8, shared_content.literature_content_sha256.root)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'sharedbody'"
                ).fetchall(),
                [(_ID_3,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'replacementonly'"
                ).fetchall(),
                [],
            )

    def test_same_hash_reanalysis_rebinds_artifact_without_dropping_support(self) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        self.writer.publish_identity_and_observation(
            _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        )
        content = self._content(source)
        self._publish_content(source, content)
        reference = Reference(
            reference_id=ReferenceId(_ID_7),
            source_literature_id=source.literature_id,
            target_literature_id=target.literature_id,
        )
        support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=ContentReferenceTextSupport(
                kind="content_reference_text",
                literature_content_sha256=content.literature_content_sha256,
                reference_index=0,
            ),
        )
        source_token = LiteratureIdentityToken(
            literature_id=source.literature_id,
            meta_literature_id=source.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(source.metadata),
        )
        target_token = LiteratureIdentityToken(
            literature_id=target.literature_id,
            meta_literature_id=target.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(target.metadata),
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=source_token,
                target_token=target_token,
                reference=reference,
                supports=(support,),
            )
        )
        reanalysis = content.model_copy(
            update={
                "provenance": _provenance(
                    _ID_15,
                    kind=SourceKind.ANALYSIS,
                    name="fixture-analysis-v2",
                    record_id=None,
                    input_hash=analysis_input_sha256(
                        _HASH_A,
                        _HASH_B,
                        metadata_sha256(source.metadata),
                    ),
                    parameters_hash=_HASH_C,
                )
            }
        )
        old_structured = literature_content_artifact(content)
        self._publish_content(source, reanalysis)
        new_structured = literature_content_artifact(reanalysis)
        self.assertNotEqual(old_structured, new_structured)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT analysis_provenance_id,structured_artifact_sha256 "
                    "FROM literature_contents WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (_ID_15, new_structured.sha256.root),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM literature_content_reference_texts "
                    "WHERE literature_content_sha256=?",
                    (content.literature_content_sha256.root,),
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM content_reference_text_supports WHERE reference_id=?",
                    (_ID_7,),
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT reference_text FROM literature_content_reference_texts "
                    "WHERE literature_content_sha256=?",
                    (content.literature_content_sha256.root,),
                ).fetchall(),
                [("Target paper.",)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'body'"
                ).fetchall(),
                [(_ID_1,)],
            )

    def test_shared_semantic_hash_does_not_couple_literature_analysis_bindings(self) -> None:
        shared_metadata = _metadata()
        source_a = _literature(_ID_1, meta_id=_ID_2, metadata=shared_metadata)
        source_b = _literature(_ID_3, meta_id=_ID_4, metadata=shared_metadata)
        target_a = _literature(
            _ID_5,
            meta_id=_ID_6,
            metadata=_metadata(title="Target Alpha"),
        )
        target_b = _literature(
            _ID_7,
            meta_id=_ID_8,
            metadata=_metadata(title="Target Beta"),
        )
        self.writer.publish_identity_and_observation(
            _identity_command(
                source_a,
                target_a,
                _observation(_ID_10, shared_metadata),
                _observation(_ID_12, target_a.metadata),
            )
        )
        self.writer.publish_identity_and_observation(
            _identity_command(
                source_b,
                target_b,
                _observation(_ID_14, shared_metadata),
                _observation(_ID_15, target_b.metadata),
            )
        )
        shared_content = self._content(source_a, body="sharedsemanticbody")
        self._publish_content(source_a, shared_content)
        self._publish_content(source_b, shared_content)

        def token(literature: Literature) -> LiteratureIdentityToken:
            return LiteratureIdentityToken(
                literature_id=literature.literature_id,
                meta_literature_id=literature.meta_literature_id,
                metadata_revision=1,
                metadata_sha256=metadata_sha256(literature.metadata),
            )

        reference_b = Reference(
            reference_id=ReferenceId(_ID_8),
            source_literature_id=source_b.literature_id,
            target_literature_id=target_b.literature_id,
        )
        support_b = ReferenceSupport(
            reference_id=reference_b.reference_id,
            source=ContentReferenceTextSupport(
                kind="content_reference_text",
                literature_content_sha256=shared_content.literature_content_sha256,
                reference_index=0,
            ),
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=token(source_b),
                target_token=token(target_b),
                reference=reference_b,
                supports=(support_b,),
            )
        )

        def source_b_state(connection: sqlite3.Connection) -> tuple[object, ...]:
            content_row = connection.execute(
                "SELECT * FROM literature_contents WHERE literature_id=?",
                (_ID_3,),
            ).fetchone()
            assert content_row is not None
            return (
                connection.execute(
                    "SELECT * FROM literature_metadata WHERE literature_id=?",
                    (_ID_3,),
                ).fetchone(),
                tuple(
                    connection.execute(
                        "SELECT * FROM literature_metadata_authors WHERE literature_id=? "
                        "ORDER BY ordinal",
                        (_ID_3,),
                    ).fetchall()
                ),
                tuple(
                    connection.execute(
                        "SELECT * FROM literature_metadata_author_affiliations "
                        "WHERE literature_id=? ORDER BY author_ordinal,affiliation_ordinal",
                        (_ID_3,),
                    ).fetchall()
                ),
                tuple(
                    connection.execute(
                        "SELECT * FROM literature_metadata_identifiers WHERE literature_id=? "
                        "ORDER BY ordinal",
                        (_ID_3,),
                    ).fetchall()
                ),
                tuple(
                    connection.execute(
                        "SELECT * FROM literature_metadata_keywords WHERE literature_id=? "
                        "ORDER BY ordinal",
                        (_ID_3,),
                    ).fetchall()
                ),
                tuple(content_row),
                connection.execute(
                    "SELECT p.* FROM literature_contents c JOIN provenances p "
                    "ON p.provenance_id=c.analysis_provenance_id WHERE c.literature_id=?",
                    (_ID_3,),
                ).fetchone(),
                tuple(
                    connection.execute(
                        "SELECT a.* FROM literature_contents c JOIN artifact_objects a "
                        "ON a.relative_path IN "
                        "(c.structured_artifact_path,c.markdown_artifact_path) "
                        "WHERE c.literature_id=? ORDER BY a.relative_path",
                        (_ID_3,),
                    ).fetchall()
                ),
                connection.execute(
                    "SELECT * FROM literature_references WHERE reference_id=?",
                    (_ID_8,),
                ).fetchone(),
                tuple(
                    connection.execute(
                        "SELECT * FROM content_reference_text_supports WHERE reference_id=?",
                        (_ID_8,),
                    ).fetchall()
                ),
                tuple(
                    connection.execute(
                        "SELECT * FROM literature_content_reference_texts "
                        "WHERE literature_content_sha256=? ORDER BY reference_index",
                        (shared_content.literature_content_sha256.root,),
                    ).fetchall()
                ),
                connection.execute(
                    "SELECT * FROM literature_search_fts WHERE literature_id=?",
                    (_ID_3,),
                ).fetchone(),
            )

        with self.engine.read_snapshot() as connection:
            before_b = source_b_state(connection)

        reanalysis = shared_content.model_copy(
            update={
                "metadata_revision": 2,
                "provenance": _provenance(
                    _ID_16,
                    kind=SourceKind.ANALYSIS,
                    name="fixture-analysis-v2",
                    record_id=None,
                    input_hash=analysis_input_sha256(
                        _HASH_A,
                        _HASH_B,
                        metadata_sha256(source_a.metadata),
                    ),
                    parameters_hash=_HASH_C,
                ),
            }
        )
        self.assertEqual(
            reanalysis.literature_content_sha256,
            shared_content.literature_content_sha256,
        )
        old_structured = literature_content_artifact(shared_content)
        new_structured = self._prepare_content_dependencies(source_a, reanalysis)
        self.assertNotEqual(new_structured, old_structured)
        self.content_publication.publish_content(
            ContentPublicationCommand(
                expected_token=token(source_a),
                expected_primary_asset_id=AssetId(_ID_10),
                expected_primary_pdf_sha256=_HASH_A,
                expected_parser_result_sha256=_HASH_B,
                replacement=self._replacement(source_a, reanalysis),
                structured_artifact=new_structured,
                structured_content=self._structured_content(reanalysis),
            )
        )

        with self.engine.read_snapshot() as connection:
            self.assertEqual(source_b_state(connection), before_b)
            self.assertEqual(
                connection.execute(
                    "SELECT literature_content_sha256,metadata_revision,"
                    "structured_artifact_sha256,analysis_provenance_id "
                    "FROM literature_contents WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (
                    shared_content.literature_content_sha256.root,
                    2,
                    new_structured.sha256.root,
                    _ID_16,
                ),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM literature_content_reference_texts "
                    "WHERE literature_content_sha256=?",
                    (shared_content.literature_content_sha256.root,),
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'sharedsemanticbody' "
                    "ORDER BY literature_id"
                ).fetchall(),
                [(_ID_1,), (_ID_3,)],
            )

    def test_content_hash_reference_text_contradiction_fails_closed(self) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        self.writer.publish_identity_and_observation(
            _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        )
        content = self._content(source)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO literature_content_reference_texts("
                "literature_content_sha256,reference_index,reference_text) VALUES(?,?,?)",
                (content.literature_content_sha256.root, 0, "Contradictory reference text."),
            )

        with self.assertRaises(ContentPublicationConflictError):
            self._publish_content(source, content)

        with self.engine.read_snapshot() as connection:
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM literature_contents WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone()
            )
            self.assertEqual(
                connection.execute(
                    "SELECT metadata_revision FROM literature_metadata WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT reference_text FROM literature_content_reference_texts "
                    "WHERE literature_content_sha256=?",
                    (content.literature_content_sha256.root,),
                ).fetchall(),
                [("Contradictory reference text.",)],
            )

    def test_delete_rewrites_representative_and_removes_empty_meta_atomically(self) -> None:
        source = _literature(_ID_1, meta_id=_ID_2)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        self.writer.publish_identity_and_observation(
            _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        )
        source_token = LiteratureIdentityToken(
            literature_id=source.literature_id,
            meta_literature_id=source.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(source.metadata),
        )
        target_token = LiteratureIdentityToken(
            literature_id=target.literature_id,
            meta_literature_id=target.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(target.metadata),
        )
        self.writer.delete_literature(
            LiteratureDeletionCommand(
                expected_token=source_token,
                expected_meta_token=MetaLiteratureIdentityToken(
                    meta_literature_id=source.meta_literature_id,
                    representative_literature_id=source.literature_id,
                    member_literature_ids=(source.literature_id, target.literature_id),
                ),
                literature_id=source.literature_id,
                replacement_representative_id=target.literature_id,
            )
        )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT representative_literature_id FROM meta_literatures "
                    "WHERE meta_literature_id=?",
                    (_ID_2,),
                ).fetchone(),
                (_ID_3,),
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM literatures WHERE literature_id=?", (_ID_1,)
                ).fetchone()
            )
        sole_command = LiteratureDeletionCommand(
            expected_token=target_token,
            expected_meta_token=MetaLiteratureIdentityToken(
                meta_literature_id=source.meta_literature_id,
                representative_literature_id=target.literature_id,
                member_literature_ids=(target.literature_id,),
            ),
            literature_id=target.literature_id,
        )
        for checkpoint in ("delete-after-literature", "delete-after-meta"):
            with self.subTest(checkpoint=checkpoint):
                crashing = LiteratureWriter(self.engine, failpoint=_fail_at(checkpoint))
                with self.assertRaises(RuntimeError):
                    crashing.delete_literature(sole_command)
                with self.engine.read_snapshot() as connection:
                    self.assertEqual(
                        connection.execute("SELECT count(*) FROM literatures").fetchone(),
                        (1,),
                    )
                    self.assertEqual(
                        connection.execute("SELECT count(*) FROM meta_literatures").fetchone(),
                        (1,),
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT literature_id FROM literature_search_fts"
                        ).fetchall(),
                        [(_ID_3,)],
                    )
        self.writer.delete_literature(sole_command)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literatures").fetchone(),
                (0,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM meta_literatures").fetchone(),
                (0,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_search_fts").fetchone(),
                (0,),
            )

    def test_stale_token_and_failpoint_rollback_leave_complete_old_state(self) -> None:
        source = _literature(_ID_1)
        target = _literature(_ID_3, meta_id=_ID_2, metadata=_metadata(title="Target"))
        command = _identity_command(source, target, _observation(_ID_4), _observation(_ID_5))
        self.writer.publish_identity_and_observation(command)
        stale = command.model_copy(
            update={
                "expected_tokens": (
                    LiteratureIdentityToken(
                        literature_id=source.literature_id,
                        meta_literature_id=source.meta_literature_id,
                        metadata_revision=99,
                        metadata_sha256=metadata_sha256(source.metadata),
                    ),
                )
            }
        )
        with self.assertRaises(StalePreconditionError):
            self.writer.publish_identity_and_observation(stale)

        def crash(name: str) -> None:
            if name == "identity-after":
                raise RuntimeError("failpoint")

        crashing = LiteratureWriter(self.engine, failpoint=crash)
        new_source = source.model_copy(update={"metadata": _metadata(final=True)})
        new_source_facts = CurrentLiteratureFacts(
            literature=new_source,
            metadata_revision=2,
            metadata_sha256=metadata_sha256(new_source.metadata),
        )
        crash_command = _identity_command(
            new_source,
            target,
            _observation(_ID_4),
            _observation(_ID_5),
            expected_tokens=(
                LiteratureIdentityToken(
                    literature_id=source.literature_id,
                    meta_literature_id=source.meta_literature_id,
                    metadata_revision=1,
                    metadata_sha256=metadata_sha256(source.metadata),
                ),
            ),
        ).model_copy(update={"facts": (new_source_facts, _facts(target))})
        with self.assertRaises(RuntimeError):
            crashing.publish_identity_and_observation(crash_command)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT metadata_revision,metadata_sha256,title FROM literature_metadata "
                    "WHERE literature_id=?",
                    (_ID_1,),
                ).fetchone(),
                (1, metadata_sha256(source.metadata).root, source.metadata.title),
            )

    def _content(
        self,
        literature: Literature,
        *,
        reference: str = "Target paper.",
        metadata: LiteratureMetadata | None = None,
        revision: int = 1,
        body: str = "body",
    ) -> LiteratureContent:
        sections = tuple(
            LiteratureSection(role=role, markdown=body)
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )
        current_metadata = literature.metadata if metadata is None else metadata
        metadata_hash = metadata_sha256(current_metadata)
        content_hash = content_sha256(
            metadata_sha256=metadata_hash,
            sections=sections,
            references=(reference,),
        )
        markdown_bytes = render_canonical_markdown(
            metadata=current_metadata,
            sections=sections,
            references=(reference,),
        )
        markdown = self.artifact_store.publish(
            markdown_bytes,
            sha256=sha256_digest(markdown_bytes),
            byte_size=len(markdown_bytes),
            media_type="text/markdown",
        )
        return LiteratureContent(
            literature_content_sha256=content_hash,
            metadata_revision=revision,
            metadata_sha256=metadata_hash,
            sections=sections,
            references=(reference,),
            markdown=ArtifactRef(
                sha256=markdown.sha256,
                media_type=markdown.media_type,
                byte_size=markdown.byte_size,
            ),
            provenance=_provenance(
                _ID_9 if revision == 1 else _ID_16,
                kind=SourceKind.ANALYSIS,
                name="fixture-analysis",
                record_id=None,
                input_hash=analysis_input_sha256(_HASH_A, _HASH_B, metadata_hash),
                parameters_hash=_HASH_B,
            ),
        )

    def _replacement(
        self,
        literature: Literature,
        content: LiteratureContent,
        metadata: LiteratureMetadata | None = None,
    ) -> ContentAcceptanceReplacement:
        return ContentAcceptanceReplacement(
            literature_id=literature.literature_id,
            metadata=literature.metadata if metadata is None else metadata,
            metadata_revision=content.metadata_revision,
            metadata_sha256=content.metadata_sha256,
            content=content,
        )

    def _publish_content(self, literature: Literature, content: LiteratureContent) -> None:
        structured = self._prepare_content_dependencies(literature, content)
        token = LiteratureIdentityToken(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
        )
        self.content_publication.publish_content(
            ContentPublicationCommand(
                expected_token=token,
                expected_primary_asset_id=AssetId(_ID_10),
                expected_primary_pdf_sha256=_HASH_A,
                expected_parser_result_sha256=_HASH_B,
                replacement=self._replacement(literature, content),
                structured_artifact=structured,
                structured_content=self._structured_content(content),
            )
        )

    @staticmethod
    def _structured_content(content: LiteratureContent) -> _StructuredContent:
        return _StructuredContent(canonical_literature_content_json(content))

    def _prepare_content_dependencies(
        self,
        literature: Literature,
        content: LiteratureContent,
    ) -> ArtifactRef:
        """Register the independent primary-PDF and ParserResult facts.

        Canonical Markdown exists only in the private ArtifactStore at this
        point.  The composite publication adapter owns its Catalog
        registration together with the structured JSON artifact.
        """
        asset_path = ".objects/aa/" + _HASH_A.root + "-1"
        parser_path = ".objects/bb/" + _HASH_B.root + "-1"
        structured = literature_content_artifact(content)
        with self.engine.write_transaction() as connection:
            connection.executemany(
                "INSERT OR IGNORE INTO artifact_objects(artifact_id,sha256,byte_size,"
                "media_type,relative_path) VALUES(?,?,?,?,?)",
                (
                    ("fixture-pdf", _HASH_A.root, 1, "application/pdf", asset_path),
                    ("fixture-parser-markdown", _HASH_B.root, 1, "text/markdown", parser_path),
                ),
            )
            connection.execute(
                "INSERT OR IGNORE INTO provenances(provenance_id,source_kind,source_name,"
                "source_record_id,observed_at,input_sha256,parameters_sha256) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    _ID_11,
                    "asset-provider",
                    "fixture-asset",
                    "asset-1",
                    str(_TIMESTAMP),
                    _HASH_A.root,
                    None,
                ),
            )
            connection.execute(
                "INSERT OR IGNORE INTO provenances(provenance_id,source_kind,source_name,"
                "source_record_id,observed_at,input_sha256,parameters_sha256) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    _ID_13,
                    "parser",
                    "fixture-parser",
                    None,
                    str(_TIMESTAMP),
                    _HASH_A.root,
                    _HASH_B.root,
                ),
            )
            connection.execute(
                "INSERT OR IGNORE INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                "VALUES(?,?,?,?,?)",
                (_ID_10, _HASH_A.root, 1, "application/pdf", asset_path),
            )
            connection.execute(
                "INSERT OR IGNORE INTO literature_assets(literature_asset_id,literature_id,"
                "asset_id,"
                "role,provenance_id,source_url) VALUES(?,?,?,?,?,?)",
                (
                    str(literature.literature_id),
                    str(literature.literature_id),
                    _ID_10,
                    "primary-pdf",
                    _ID_11,
                    None,
                ),
            )
            connection.execute(
                "INSERT OR IGNORE INTO parser_results(source_asset_id,source_sha256,result_sha256,"
                "page_count,markdown_artifact_path,markdown_sha256,markdown_byte_size,"
                "markdown_media_type,provenance_id,parser_version,mode,model_identity) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    _ID_10,
                    _HASH_A.root,
                    _HASH_B.root,
                    1,
                    parser_path,
                    _HASH_B.root,
                    1,
                    "text/markdown",
                    _ID_13,
                    "fixture",
                    None,
                    None,
                ),
            )
        return structured

    @staticmethod
    def _cleanup(
        source_literature_id: LiteratureId,
        old_hash: Sha256,
        *,
        references: tuple[Reference, ...],
        supports: tuple[ReferenceSupport, ...],
    ):
        from sciretriever.literature.references import decide_content_replacement_cleanup

        return decide_content_replacement_cleanup(
            source_literature_id,
            old_hash,
            references,
            supports,
        )


if __name__ == "__main__":
    unittest.main()
