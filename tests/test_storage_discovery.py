from __future__ import annotations

import unittest
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.entry.execution import execute_database_write
from sciretriever.entry.ports import (
    DiscoveryPublicationPort,
    DiscoveryRunReadPort,
    DiscoveryRunRecoveryPort,
    DiscoveryRunRepositoryPort,
)
from sciretriever.literature.content import metadata_sha256
from sciretriever.literature.ports import (
    IdentityObservationPublicationCommand,
    LiteratureIdentityToken,
    LiteratureObservation,
    MetaLiteratureIdentityToken,
)
from sciretriever.literature.state import CurrentLiteratureFacts
from sciretriever.model.discovery import (
    CitationDiscoveryCause,
    CitationDiscoveryInput,
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    ProviderDiscoveryLimit,
    TopicDiscoveryCause,
    TopicDiscoveryInput,
)
from sciretriever.model.literature import (
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.storage.sqlite.discovery_repository import (
    DiscoveryRepositoryConflictError,
    DiscoveryRepositoryError,
    DiscoveryRepositoryIntegrityError,
    DiscoveryRunNotFoundError,
    SqliteDiscoveryRepository,
)
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

_STARTED_AT = UtcTimestamp("2026-08-12T09:30:00Z")
_DISCOVERY_TABLES = (
    "discovery_runs",
    "topic_discovery_inputs",
    "citation_discovery_inputs",
    "citation_discovery_seeds",
    "discovery_run_providers",
    "discovery_source_results",
    "discovery_results",
    "topic_discovery_causes",
    "citation_discovery_causes",
)


def _uuid(value: int) -> str:
    return str(uuid.UUID(int=value))


def _run_id(value: int) -> DiscoveryRunId:
    return DiscoveryRunId(_uuid(value))


def _meta_id(value: int) -> MetaLiteratureId:
    return MetaLiteratureId(_uuid(1_000 + value))


def _literature_id(value: int) -> LiteratureId:
    return LiteratureId(_uuid(2_000 + value))


def _observation_id(value: int) -> ObservationId:
    return ObservationId(_uuid(3_000 + value))


def _providers(*values: tuple[str, int]) -> tuple[ProviderDiscoveryLimit, ...]:
    return tuple(
        ProviderDiscoveryLimit(provider_name=name, scan_limit=limit) for name, limit in values
    )


def _topic_run(
    identifier: int,
    *,
    providers: tuple[ProviderDiscoveryLimit, ...] | None = None,
    status: str = "RUNNING",
) -> DiscoveryRun:
    return DiscoveryRun(
        discovery_run_id=_run_id(identifier),
        input=TopicDiscoveryInput(
            kind="topic",
            query="bounded quantum materials",
            year_from=2021,
            year_to=2026,
            providers=providers or _providers(("openalex", 17)),
        ),
        status=status,  # type: ignore[arg-type]
        started_at=_STARTED_AT,
    )


def _citation_run(
    identifier: int,
    seeds: tuple[LiteratureId, ...],
    *,
    direction: str = "both",
    max_depth: int = 2,
    result_limit: int = 10,
    providers: tuple[ProviderDiscoveryLimit, ...] | None = None,
) -> DiscoveryRun:
    return DiscoveryRun(
        discovery_run_id=_run_id(identifier),
        input=CitationDiscoveryInput(
            kind="citation",
            seed_literature_ids=seeds,
            direction=direction,  # type: ignore[arg-type]
            max_depth=max_depth,
            result_limit=result_limit,
            providers=providers or _providers(("opencitations", 25)),
        ),
        status="RUNNING",
        started_at=_STARTED_AT,
    )


def _fail_at(expected: str) -> Callable[[str], None]:
    def failpoint(name: str) -> None:
        if name == expected:
            raise RuntimeError("private failpoint diagnostic /tmp/catalog.sqlite")

    return failpoint


def _identity_literature(
    literature_id: LiteratureId,
    meta_literature_id: MetaLiteratureId,
    title: str,
) -> Literature:
    return Literature(
        literature_id=literature_id,
        meta_literature_id=meta_literature_id,
        version_role=VersionRole.OTHER,
        metadata=LiteratureMetadata(title=title),
        status=LiteratureStatus.UNREVIEWED,
    )


def _identity_observation(identifier: int, title: str) -> MetadataObservation:
    observation_id = _observation_id(identifier)
    return MetadataObservation(
        observation_id=observation_id,
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(9_000 + identifier)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name="identity-fixture",
            source_record_id=f"identity-{identifier}",
            observed_at=_STARTED_AT,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title=title),
    )


def _current_facts(literature: Literature) -> CurrentLiteratureFacts:
    return CurrentLiteratureFacts(
        literature=literature,
        metadata_revision=1,
        metadata_sha256=metadata_sha256(literature.metadata),
    )


class _RecordingAdmission:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    @contextmanager
    def acquire_nowait(self) -> Iterator[None]:
        self._events.append("admission")
        try:
            yield
        finally:
            self._events.append("release")


class StorageDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-discovery-repository-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = Path(self.temporary.name) / "catalog.sqlite"
        self.engine = CatalogEngine(self.catalog)
        self.repository = SqliteDiscoveryRepository(self.engine)

    def _run_rows(self, discovery_run_id: DiscoveryRunId) -> tuple[object, ...]:
        with self.engine.read_snapshot() as connection:
            return tuple(
                (
                    table_name,
                    tuple(
                        tuple(row)
                        for row in connection.execute(
                            f"SELECT * FROM {table_name} WHERE discovery_run_id=? ORDER BY rowid",
                            (discovery_run_id.root,),
                        ).fetchall()
                    ),
                )
                for table_name in _DISCOVERY_TABLES
            )

    def _all_discovery_rows(self) -> tuple[object, ...]:
        with self.engine.read_snapshot() as connection:
            return tuple(
                (
                    table_name,
                    tuple(
                        tuple(row)
                        for row in connection.execute(
                            f"SELECT * FROM {table_name} ORDER BY rowid"
                        ).fetchall()
                    ),
                )
                for table_name in _DISCOVERY_TABLES
            )

    def _assert_run_has_no_rows(self, discovery_run_id: DiscoveryRunId) -> None:
        self.assertEqual(
            self._run_rows(discovery_run_id),
            tuple((table_name, ()) for table_name in _DISCOVERY_TABLES),
        )

    def _insert_literatures(
        self,
        *groups: tuple[MetaLiteratureId, tuple[LiteratureId, ...]],
    ) -> None:
        with self.engine.write_transaction() as connection:
            for meta_literature_id, literature_ids in groups:
                self.assertTrue(literature_ids)
                connection.execute(
                    "INSERT INTO meta_literatures("
                    "meta_literature_id,representative_literature_id) VALUES (?,?)",
                    (meta_literature_id.root, literature_ids[0].root),
                )
                connection.executemany(
                    "INSERT INTO literatures("
                    "literature_id,meta_literature_id,version_role) VALUES (?,?,?)",
                    (
                        (literature_id.root, meta_literature_id.root, "other")
                        for literature_id in literature_ids
                    ),
                )

    def _insert_owned_observation(
        self,
        observation_id: ObservationId,
        literature_id: LiteratureId,
        *,
        provenance_offset: int,
    ) -> None:
        provenance_id = _uuid(4_000 + provenance_offset)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO provenances("
                "provenance_id,source_kind,source_name,source_record_id,observed_at,"
                "input_sha256,parameters_sha256) VALUES (?,?,?,?,?,?,?)",
                (
                    provenance_id,
                    "metadata-provider",
                    "fixture-provider",
                    f"record-{provenance_offset}",
                    _STARTED_AT.root,
                    None,
                    None,
                ),
            )
            connection.execute(
                "INSERT INTO metadata_observations(observation_id,provenance_id,title) "
                "VALUES (?,?,?)",
                (observation_id.root, provenance_id, "Observed title"),
            )
            connection.execute(
                "INSERT INTO literature_metadata_observations(literature_id,observation_id) "
                "VALUES (?,?)",
                (literature_id.root, observation_id.root),
            )

    def _insert_unowned_observation(
        self,
        observation_id: ObservationId,
        *,
        provenance_offset: int,
    ) -> None:
        provenance_id = _uuid(4_500 + provenance_offset)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO provenances("
                "provenance_id,source_kind,source_name,source_record_id,observed_at) "
                "VALUES (?,?,?,?,?)",
                (
                    provenance_id,
                    "metadata-provider",
                    "fixture-provider",
                    f"record-unowned-{provenance_offset}",
                    _STARTED_AT.root,
                ),
            )
            connection.execute(
                "INSERT INTO metadata_observations(observation_id,provenance_id,title) "
                "VALUES (?,?,?)",
                (observation_id.root, provenance_id, "Unowned title"),
            )

    def _insert_supported_reference(
        self,
        source_literature_id: LiteratureId,
        target_literature_id: LiteratureId,
        *,
        fixture_offset: int,
    ) -> None:
        provenance_id = _uuid(5_000 + fixture_offset)
        observation_id = _uuid(6_000 + fixture_offset)
        reference_id = _uuid(7_000 + fixture_offset)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO provenances("
                "provenance_id,source_kind,source_name,source_record_id,observed_at) "
                "VALUES (?,?,?,?,?)",
                (
                    provenance_id,
                    "metadata-provider",
                    "fixture-provider",
                    f"relation-{fixture_offset}",
                    _STARTED_AT.root,
                ),
            )
            connection.execute(
                "INSERT INTO provider_relation_observations(observation_id,provenance_id) "
                "VALUES (?,?)",
                (observation_id, provenance_id),
            )
            connection.execute(
                "INSERT INTO literature_references("
                "reference_id,source_literature_id,target_literature_id) VALUES (?,?,?)",
                (reference_id, source_literature_id.root, target_literature_id.root),
            )
            connection.execute(
                "INSERT INTO provider_relation_reference_supports("
                "reference_id,observation_id) VALUES (?,?)",
                (reference_id, observation_id),
            )

    def _insert_unsupported_reference(
        self,
        source_literature_id: LiteratureId,
        target_literature_id: LiteratureId,
        *,
        fixture_offset: int,
    ) -> None:
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO literature_references("
                "reference_id,source_literature_id,target_literature_id) VALUES (?,?,?)",
                (
                    _uuid(8_000 + fixture_offset),
                    source_literature_id.root,
                    target_literature_id.root,
                ),
            )

    @staticmethod
    def _source_result(
        run: DiscoveryRun,
        provider_name: str,
        outcome: str,
        *,
        failure: StableFailure | None = None,
    ) -> DiscoverySourceResult:
        return DiscoverySourceResult(
            discovery_run_id=run.discovery_run_id,
            provider_name=provider_name,
            outcome=outcome,  # type: ignore[arg-type]
            failure=failure,
        )

    def test_adapter_implements_all_entry_ports_and_reuses_a_fresh_manifest(self) -> None:
        self.assertIsInstance(self.repository, DiscoveryRunRepositoryPort)
        self.assertIsInstance(self.repository, DiscoveryRunReadPort)
        self.assertIsInstance(self.repository, DiscoveryPublicationPort)
        self.assertIsInstance(self.repository, DiscoveryRunRecoveryPort)

        run = _topic_run(1)
        self.repository.create(run)
        reopened = SqliteDiscoveryRepository(CatalogEngine.open(self.catalog))
        self.assertEqual(reopened.read(run.discovery_run_id).run, run)

    def test_topic_round_trip_preserves_input_order_failure_and_idempotent_cause(self) -> None:
        meta_literature_id = _meta_id(1)
        literature_id = _literature_id(1)
        observation_id = _observation_id(1)
        second_observation_id = _observation_id(2)
        self._insert_literatures((meta_literature_id, (literature_id,)))
        self._insert_owned_observation(observation_id, literature_id, provenance_offset=1)
        self._insert_owned_observation(
            second_observation_id,
            literature_id,
            provenance_offset=2,
        )
        providers = _providers(("first", 7), ("second", 11), ("third", 13))
        run = _topic_run(2, providers=providers)
        self.repository.create(run)

        failure = StableFailure(
            code="provider-unavailable",
            reason="Provider unavailable",
            action="Retry later",
            retryable=True,
        )
        source_results = (
            self._source_result(run, "first", "EXHAUSTED"),
            self._source_result(run, "second", "SCAN_LIMIT_REACHED"),
            self._source_result(run, "third", "FAILED", failure=failure),
        )
        for source_result in source_results:
            self.repository.publish_source_result(source_result)

        result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=meta_literature_id,
        )
        cause = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=meta_literature_id,
            metadata_observation_id=observation_id,
        )
        self.repository.publish_result_and_cause(result, cause)
        self.repository.publish_result_and_cause(result, cause)
        second_cause = cause.model_copy(update={"metadata_observation_id": second_observation_id})
        self.repository.publish_result_and_cause(result, second_cause)
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.finalize(run.discovery_run_id, "COMPLETED")
        finalized = self.repository.finalize(run.discovery_run_id, "PARTIAL")

        snapshot = self.repository.read(run.discovery_run_id)
        self.assertEqual(snapshot.run, finalized)
        self.assertEqual(snapshot.run.status, "PARTIAL")
        self.assertEqual(snapshot.run.input, run.input)
        self.assertEqual(snapshot.source_results, source_results)
        self.assertEqual(snapshot.results, (result,))
        self.assertEqual(snapshot.causes, (cause, second_cause))
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM topic_discovery_causes WHERE discovery_run_id=?",
                    (run.discovery_run_id.root,),
                ).fetchone(),
                (2,),
            )

    def test_citation_round_trip_preserves_seeds_and_direct_depth_chain(self) -> None:
        seed_meta = _meta_id(10)
        first_meta = _meta_id(11)
        second_meta = _meta_id(12)
        seed = _literature_id(10)
        second_seed = _literature_id(13)
        first = _literature_id(11)
        second = _literature_id(12)
        self._insert_literatures(
            (seed_meta, (seed, second_seed)),
            (first_meta, (first,)),
            (second_meta, (second,)),
        )
        self._insert_supported_reference(seed, first, fixture_offset=10)
        self._insert_supported_reference(first, second, fixture_offset=11)
        run = _citation_run(
            3,
            (seed, second_seed),
            direction="references",
            max_depth=2,
            providers=_providers(("relations", 31), ("lookup", 19)),
        )
        self.repository.create(run)

        first_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=first_meta,
        )
        first_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=first_meta,
            source_literature_id=seed,
            target_literature_id=first,
            depth=1,
        )
        second_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=second_meta,
        )
        second_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=second_meta,
            source_literature_id=first,
            target_literature_id=second,
            depth=2,
        )
        self.repository.publish_result_and_cause(first_result, first_cause)
        self.repository.publish_result_and_cause(first_result, first_cause)
        self.repository.publish_result_and_cause(second_result, second_cause)
        for provider in ("relations", "lookup"):
            self.repository.publish_source_result(self._source_result(run, provider, "EXHAUSTED"))
        self.repository.finalize(run.discovery_run_id, "COMPLETED")

        snapshot = self.repository.read(run.discovery_run_id)
        self.assertEqual(snapshot.run.input, run.input)
        self.assertEqual(snapshot.results, (first_result, second_result))
        self.assertEqual(snapshot.causes, (first_cause, second_cause))

    def test_citation_read_survives_later_legal_seed_and_result_meta_convergence(self) -> None:
        seed_meta = _meta_id(110)
        target_meta = _meta_id(111)
        seed_id = _literature_id(110)
        target_id = _literature_id(111)
        seed = _identity_literature(seed_id, seed_meta, "Seed title")
        target = _identity_literature(target_id, target_meta, "Target title")
        seed_observation = _identity_observation(110, "Seed title")
        target_observation = _identity_observation(111, "Target title")
        writer = LiteratureWriter(self.engine)
        writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(seed, target),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=seed_meta,
                        representative_literature_id=seed_id,
                    ),
                    MetaLiterature(
                        meta_literature_id=target_meta,
                        representative_literature_id=target_id,
                    ),
                ),
                observations=(
                    LiteratureObservation(
                        literature_id=seed_id,
                        observation=seed_observation,
                    ),
                    LiteratureObservation(
                        literature_id=target_id,
                        observation=target_observation,
                    ),
                ),
                facts=(_current_facts(seed), _current_facts(target)),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )
        self._insert_supported_reference(seed_id, target_id, fixture_offset=110)

        run = _citation_run(33, (seed_id,), direction="references", max_depth=1)
        self.repository.create(run)
        result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=target_meta,
        )
        cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=target_meta,
            source_literature_id=seed_id,
            target_literature_id=target_id,
            depth=1,
        )
        self.repository.publish_result_and_cause(result, cause)
        self.repository.publish_source_result(
            self._source_result(run, "opencitations", "EXHAUSTED")
        )
        self.repository.finalize(run.discovery_run_id, "COMPLETED")
        before_merge = self.repository.read(run.discovery_run_id)

        updated_seed = seed.model_copy(update={"meta_literature_id": target_meta})
        updated_target = target.model_copy(update={"meta_literature_id": target_meta})
        writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(updated_seed, updated_target),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=target_meta,
                        representative_literature_id=target_id,
                    ),
                ),
                observations=(),
                facts=(_current_facts(updated_seed), _current_facts(updated_target)),
                expected_tokens=(
                    LiteratureIdentityToken(
                        literature_id=seed_id,
                        meta_literature_id=seed_meta,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(seed.metadata),
                    ),
                    LiteratureIdentityToken(
                        literature_id=target_id,
                        meta_literature_id=target_meta,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(target.metadata),
                    ),
                ),
                expected_meta_tokens=(
                    MetaLiteratureIdentityToken(
                        meta_literature_id=seed_meta,
                        representative_literature_id=seed_id,
                        member_literature_ids=(seed_id,),
                    ),
                    MetaLiteratureIdentityToken(
                        meta_literature_id=target_meta,
                        representative_literature_id=target_id,
                        member_literature_ids=(target_id,),
                    ),
                ),
                retired_meta_literature_ids=(seed_meta,),
            )
        )

        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
                    (seed_id.root,),
                ).fetchone(),
                (target_meta.root,),
            )
        after_merge = self.repository.read(run.discovery_run_id)
        self.assertEqual(after_merge, before_merge)
        self.assertEqual(after_merge.results, (result,))
        self.assertEqual(after_merge.causes, (cause,))

    def test_zero_result_run_can_complete(self) -> None:
        run = _topic_run(4)
        self.repository.create(run)
        source = self._source_result(run, "openalex", "EXHAUSTED")
        self.repository.publish_source_result(source)
        self.repository.finalize(run.discovery_run_id, "COMPLETED")
        snapshot = self.repository.read(run.discovery_run_id)
        self.assertEqual(snapshot.source_results, (source,))
        self.assertEqual(snapshot.results, ())
        self.assertEqual(snapshot.causes, ())

    def test_all_failed_and_explicit_interrupted_terminal_states_round_trip(self) -> None:
        failure = StableFailure(
            code="provider-unavailable",
            reason="Provider unavailable",
            action="Retry later",
            retryable=True,
        )
        failed = _topic_run(
            28,
            providers=_providers(("first", 3), ("second", 5)),
        )
        self.repository.create(failed)
        for provider_name in ("first", "second"):
            self.repository.publish_source_result(
                self._source_result(failed, provider_name, "FAILED", failure=failure)
            )
        self.assertEqual(
            self.repository.finalize(failed.discovery_run_id, "FAILED").status,
            "FAILED",
        )
        self.assertEqual(self.repository.read(failed.discovery_run_id).run.status, "FAILED")

        interrupted = _topic_run(29)
        self.repository.create(interrupted)
        self.assertEqual(
            self.repository.finalize(interrupted.discovery_run_id, "INTERRUPTED").status,
            "INTERRUPTED",
        )
        self.assertEqual(
            self.repository.read(interrupted.discovery_run_id).source_results,
            (),
        )

    def test_citation_cause_outlives_reference_and_exact_replay_needs_no_current_edge(self) -> None:
        seed_meta = _meta_id(14)
        target_meta = _meta_id(15)
        seed = _literature_id(14)
        target = _literature_id(15)
        self._insert_literatures((seed_meta, (seed,)), (target_meta, (target,)))
        self._insert_supported_reference(seed, target, fixture_offset=14)
        run = _citation_run(26, (seed,), direction="references", max_depth=1)
        self.repository.create(run)
        result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=target_meta,
        )
        cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=target_meta,
            source_literature_id=seed,
            target_literature_id=target,
            depth=1,
        )
        self.repository.publish_result_and_cause(result, cause)
        with self.engine.write_transaction() as connection:
            reference_id = connection.execute(
                "SELECT reference_id FROM literature_references "
                "WHERE source_literature_id=? AND target_literature_id=?",
                (seed.root, target.root),
            ).fetchone()
            self.assertIsNotNone(reference_id)
            connection.execute(
                "DELETE FROM provider_relation_reference_supports WHERE reference_id=?",
                (reference_id[0],),  # type: ignore[index]
            )
            connection.execute(
                "DELETE FROM literature_references WHERE reference_id=?",
                (reference_id[0],),  # type: ignore[index]
            )

        self.repository.publish_result_and_cause(result, cause)
        self.repository.publish_source_result(
            self._source_result(run, "opencitations", "EXHAUSTED")
        )
        self.repository.finalize(run.discovery_run_id, "COMPLETED")
        snapshot = self.repository.read(run.discovery_run_id)
        self.assertEqual(snapshot.results, (result,))
        self.assertEqual(snapshot.causes, (cause,))

    def test_source_result_must_be_declared_unique_and_running(self) -> None:
        run = _topic_run(5)
        self.repository.create(run)
        source = self._source_result(run, "openalex", "EXHAUSTED")
        self.repository.publish_source_result(source)
        for duplicate in (
            source,
            self._source_result(run, "openalex", "SCAN_LIMIT_REACHED"),
        ):
            with self.subTest(duplicate=duplicate.outcome):
                with self.assertRaises(DiscoveryRepositoryConflictError):
                    self.repository.publish_source_result(duplicate)
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_source_result(
                self._source_result(run, "not-declared", "EXHAUSTED")
            )
        self.repository.finalize(run.discovery_run_id, "COMPLETED")
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_source_result(
                self._source_result(run, "openalex", "SCAN_LIMIT_REACHED")
            )

    def test_terminal_run_rejects_result_replay_refinalization_and_recreation(self) -> None:
        meta_literature_id = _meta_id(20)
        literature_id = _literature_id(20)
        observation_id = _observation_id(20)
        self._insert_literatures((meta_literature_id, (literature_id,)))
        self._insert_owned_observation(observation_id, literature_id, provenance_offset=20)
        run = _topic_run(6)
        self.repository.create(run)
        result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=meta_literature_id,
        )
        cause = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=meta_literature_id,
            metadata_observation_id=observation_id,
        )
        self.repository.publish_result_and_cause(result, cause)
        self.repository.publish_source_result(self._source_result(run, "openalex", "EXHAUSTED"))
        self.repository.finalize(run.discovery_run_id, "COMPLETED")

        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(result, cause)
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.finalize(run.discovery_run_id, "COMPLETED")
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.finalize(run.discovery_run_id, "INTERRUPTED")
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.create(run)

    def test_create_requires_running_and_rolls_back_missing_citation_seed(self) -> None:
        with self.assertRaises(DiscoveryRepositoryIntegrityError):
            self.repository.create(_topic_run(7, status="COMPLETED"))
        missing_seed_run = _citation_run(8, (_literature_id(999),))
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.create(missing_seed_run)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM discovery_runs WHERE discovery_run_id=?",
                    (missing_seed_run.discovery_run_id.root,),
                ).fetchone(),
                (0,),
            )

    def test_create_fully_revalidates_copied_run_and_writes_no_partial_input(self) -> None:
        seed = _literature_id(998)
        seed_meta = _meta_id(998)
        self._insert_literatures((seed_meta, (seed,)))
        topic = _topic_run(30)
        citation_without_providers = _citation_run(31, (seed,))
        citation_without_seeds = _citation_run(32, (seed,))
        forged_runs = (
            topic.model_copy(
                update={
                    "input": topic.input.model_copy(update={"providers": ()}),
                }
            ),
            citation_without_providers.model_copy(
                update={
                    "input": citation_without_providers.input.model_copy(update={"providers": ()}),
                }
            ),
            citation_without_seeds.model_copy(
                update={
                    "input": citation_without_seeds.input.model_copy(
                        update={"seed_literature_ids": ()}
                    ),
                }
            ),
        )

        for forged in forged_runs:
            with self.subTest(run=forged.discovery_run_id.root):
                with self.assertRaises(DiscoveryRepositoryIntegrityError):
                    self.repository.create(forged)
                self._assert_run_has_no_rows(forged.discovery_run_id)

    def test_topic_cause_requires_matching_owned_observation_and_run_kind(self) -> None:
        first_meta = _meta_id(30)
        second_meta = _meta_id(31)
        first_literature = _literature_id(30)
        second_literature = _literature_id(31)
        owned = _observation_id(30)
        unowned = _observation_id(31)
        self._insert_literatures(
            (first_meta, (first_literature,)),
            (second_meta, (second_literature,)),
        )
        self._insert_owned_observation(owned, first_literature, provenance_offset=30)
        self._insert_unowned_observation(unowned, provenance_offset=31)
        run = _topic_run(9)
        self.repository.create(run)

        first_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=second_meta,
        )
        mismatched = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=second_meta,
            metadata_observation_id=owned,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(first_result, mismatched)
        unowned_cause = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=second_meta,
            metadata_observation_id=unowned,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(first_result, unowned_cause)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM discovery_results WHERE discovery_run_id=?",
                    (run.discovery_run_id.root,),
                ).fetchone(),
                (0,),
            )

        citation_run = _citation_run(10, (first_literature,))
        self.repository.create(citation_run)
        wrong_kind_result = DiscoveryResult(
            discovery_run_id=citation_run.discovery_run_id,
            meta_literature_id=first_meta,
        )
        wrong_kind_cause = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=citation_run.discovery_run_id,
            meta_literature_id=first_meta,
            metadata_observation_id=owned,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(wrong_kind_result, wrong_kind_cause)

    def test_citation_cause_requires_seed_exclusion_direction_depth_chain_and_support(self) -> None:
        seed_meta = _meta_id(40)
        target_meta = _meta_id(41)
        later_meta = _meta_id(42)
        seed = _literature_id(40)
        target = _literature_id(41)
        later = _literature_id(42)
        self._insert_literatures(
            (seed_meta, (seed,)),
            (target_meta, (target,)),
            (later_meta, (later,)),
        )
        self._insert_supported_reference(target, seed, fixture_offset=40)
        self._insert_unsupported_reference(seed, later, fixture_offset=41)
        run = _citation_run(11, (seed,), direction="references", max_depth=2)
        self.repository.create(run)

        seed_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=seed_meta,
        )
        seed_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=seed_meta,
            source_literature_id=target,
            target_literature_id=seed,
            depth=1,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(seed_result, seed_cause)

        wrong_direction_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=target_meta,
        )
        wrong_direction_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=target_meta,
            source_literature_id=target,
            target_literature_id=seed,
            depth=1,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(wrong_direction_result, wrong_direction_cause)

        unsupported_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=later_meta,
        )
        unsupported_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=later_meta,
            source_literature_id=seed,
            target_literature_id=later,
            depth=1,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(unsupported_result, unsupported_cause)

        self._insert_supported_reference(seed, target, fixture_offset=42)
        too_deep_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=target_meta,
            source_literature_id=seed,
            target_literature_id=target,
            depth=2,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(wrong_direction_result, too_deep_cause)

        valid_cause = too_deep_cause.model_copy(update={"depth": 1})
        self.repository.publish_result_and_cause(wrong_direction_result, valid_cause)
        disconnected = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=later_meta,
            source_literature_id=seed,
            target_literature_id=later,
            depth=2,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(unsupported_result, disconnected)

    def test_citation_result_limit_and_ambiguous_actual_endpoint_fail_closed(self) -> None:
        seed_meta = _meta_id(50)
        first_meta = _meta_id(51)
        second_meta = _meta_id(52)
        shared_meta = _meta_id(53)
        seed = _literature_id(50)
        first = _literature_id(51)
        second = _literature_id(52)
        shared_first = _literature_id(53)
        shared_second = _literature_id(54)
        self._insert_literatures(
            (seed_meta, (seed,)),
            (first_meta, (first,)),
            (second_meta, (second,)),
            (shared_meta, (shared_first, shared_second)),
        )
        self._insert_supported_reference(seed, first, fixture_offset=50)
        self._insert_supported_reference(seed, second, fixture_offset=51)
        self._insert_supported_reference(shared_first, shared_second, fixture_offset=52)
        run = _citation_run(12, (seed,), result_limit=1)
        self.repository.create(run)

        first_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=first_meta,
        )
        first_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=first_meta,
            source_literature_id=seed,
            target_literature_id=first,
            depth=1,
        )
        self.repository.publish_result_and_cause(first_result, first_cause)
        second_result = DiscoveryResult(
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=second_meta,
        )
        second_cause = first_cause.model_copy(
            update={
                "meta_literature_id": second_meta,
                "target_literature_id": second,
            }
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(second_result, second_cause)

        ambiguous_run = _citation_run(13, (seed,))
        self.repository.create(ambiguous_run)
        ambiguous_result = DiscoveryResult(
            discovery_run_id=ambiguous_run.discovery_run_id,
            meta_literature_id=shared_meta,
        )
        ambiguous_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=ambiguous_run.discovery_run_id,
            meta_literature_id=shared_meta,
            source_literature_id=shared_first,
            target_literature_id=shared_second,
            depth=1,
        )
        with self.assertRaises(DiscoveryRepositoryConflictError):
            self.repository.publish_result_and_cause(ambiguous_result, ambiguous_cause)

    def test_publication_requires_matching_result_and_cause_identity(self) -> None:
        meta_literature_id = _meta_id(60)
        literature_id = _literature_id(60)
        observation_id = _observation_id(60)
        self._insert_literatures((meta_literature_id, (literature_id,)))
        self._insert_owned_observation(observation_id, literature_id, provenance_offset=60)
        first = _topic_run(14)
        second = _topic_run(15)
        self.repository.create(first)
        self.repository.create(second)
        result = DiscoveryResult(
            discovery_run_id=first.discovery_run_id,
            meta_literature_id=meta_literature_id,
        )
        wrong_run = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=second.discovery_run_id,
            meta_literature_id=meta_literature_id,
            metadata_observation_id=observation_id,
        )
        with self.assertRaises(DiscoveryRepositoryIntegrityError):
            self.repository.publish_result_and_cause(result, wrong_run)

    def test_each_write_failpoint_rolls_back_the_whole_transaction(self) -> None:
        seed_meta = _meta_id(120)
        topic_meta = _meta_id(121)
        citation_meta = _meta_id(122)
        seed = _literature_id(120)
        topic_literature = _literature_id(121)
        citation_target = _literature_id(122)
        topic_observation = _observation_id(120)
        self._insert_literatures(
            (seed_meta, (seed,)),
            (topic_meta, (topic_literature,)),
            (citation_meta, (citation_target,)),
        )
        self._insert_owned_observation(
            topic_observation,
            topic_literature,
            provenance_offset=120,
        )
        self._insert_supported_reference(seed, citation_target, fixture_offset=120)

        topic_create = _topic_run(34)
        for checkpoint in (
            "create-after-run",
            "create-after-input",
            "create-after-providers",
            "create-before-commit",
        ):
            with self.subTest(operation="topic-create", checkpoint=checkpoint):
                before = self._run_rows(topic_create.discovery_run_id)
                with self.assertRaises(DiscoveryRepositoryError):
                    SqliteDiscoveryRepository(
                        self.engine,
                        failpoint=_fail_at(checkpoint),
                    ).create(topic_create)
                self.assertEqual(self._run_rows(topic_create.discovery_run_id), before)

        citation_create = _citation_run(35, (seed,))
        for checkpoint in (
            "create-after-run",
            "create-after-input",
            "create-after-seeds",
            "create-after-providers",
            "create-before-commit",
        ):
            with self.subTest(operation="citation-create", checkpoint=checkpoint):
                before = self._run_rows(citation_create.discovery_run_id)
                with self.assertRaises(DiscoveryRepositoryError):
                    SqliteDiscoveryRepository(
                        self.engine,
                        failpoint=_fail_at(checkpoint),
                    ).create(citation_create)
                self.assertEqual(self._run_rows(citation_create.discovery_run_id), before)

        topic_run = _topic_run(36)
        self.repository.create(topic_run)
        topic_source = self._source_result(topic_run, "openalex", "EXHAUSTED")
        for checkpoint in ("source-after-insert", "source-before-commit"):
            with self.subTest(operation="source", checkpoint=checkpoint):
                before = self._run_rows(topic_run.discovery_run_id)
                with self.assertRaises(DiscoveryRepositoryError):
                    SqliteDiscoveryRepository(
                        self.engine,
                        failpoint=_fail_at(checkpoint),
                    ).publish_source_result(topic_source)
                self.assertEqual(self._run_rows(topic_run.discovery_run_id), before)

        topic_result = DiscoveryResult(
            discovery_run_id=topic_run.discovery_run_id,
            meta_literature_id=topic_meta,
        )
        topic_cause = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=topic_run.discovery_run_id,
            meta_literature_id=topic_meta,
            metadata_observation_id=topic_observation,
        )
        for checkpoint in (
            "result-after-result",
            "result-after-cause",
            "result-before-commit",
        ):
            with self.subTest(operation="topic-result", checkpoint=checkpoint):
                before = self._run_rows(topic_run.discovery_run_id)
                with self.assertRaises(DiscoveryRepositoryError):
                    SqliteDiscoveryRepository(
                        self.engine,
                        failpoint=_fail_at(checkpoint),
                    ).publish_result_and_cause(topic_result, topic_cause)
                self.assertEqual(self._run_rows(topic_run.discovery_run_id), before)

        citation_run = _citation_run(37, (seed,), direction="references", max_depth=1)
        self.repository.create(citation_run)
        citation_result = DiscoveryResult(
            discovery_run_id=citation_run.discovery_run_id,
            meta_literature_id=citation_meta,
        )
        citation_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=citation_run.discovery_run_id,
            meta_literature_id=citation_meta,
            source_literature_id=seed,
            target_literature_id=citation_target,
            depth=1,
        )
        for checkpoint in (
            "result-after-result",
            "result-after-cause",
            "result-before-commit",
        ):
            with self.subTest(operation="citation-result", checkpoint=checkpoint):
                before = self._run_rows(citation_run.discovery_run_id)
                with self.assertRaises(DiscoveryRepositoryError):
                    SqliteDiscoveryRepository(
                        self.engine,
                        failpoint=_fail_at(checkpoint),
                    ).publish_result_and_cause(citation_result, citation_cause)
                self.assertEqual(self._run_rows(citation_run.discovery_run_id), before)

        self.repository.publish_source_result(topic_source)
        self.repository.publish_result_and_cause(topic_result, topic_cause)
        for checkpoint in ("finalize-after-update", "finalize-before-commit"):
            with self.subTest(operation="finalize", checkpoint=checkpoint):
                before = self._run_rows(topic_run.discovery_run_id)
                with self.assertRaises(DiscoveryRepositoryError):
                    SqliteDiscoveryRepository(
                        self.engine,
                        failpoint=_fail_at(checkpoint),
                    ).finalize(topic_run.discovery_run_id, "COMPLETED")
                self.assertEqual(self._run_rows(topic_run.discovery_run_id), before)

        for checkpoint in ("recovery-after-update", "recovery-before-commit"):
            with self.subTest(operation="recovery", checkpoint=checkpoint):
                before = self._all_discovery_rows()
                with self.assertRaises(DiscoveryRepositoryError):
                    SqliteDiscoveryRepository(
                        self.engine,
                        failpoint=_fail_at(checkpoint),
                    ).interrupt_visible_running()
                self.assertEqual(self._all_discovery_rows(), before)

    def test_finalize_rejects_broken_result_closure_and_rolls_back_status(self) -> None:
        meta_literature_id = _meta_id(71)
        literature_id = _literature_id(71)
        self._insert_literatures((meta_literature_id, (literature_id,)))
        run = _topic_run(27)
        self.repository.create(run)
        self.repository.publish_source_result(self._source_result(run, "openalex", "EXHAUSTED"))
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES (?,?)",
                (run.discovery_run_id.root, meta_literature_id.root),
            )
        with self.assertRaises(DiscoveryRepositoryIntegrityError):
            self.repository.finalize(run.discovery_run_id, "COMPLETED")
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT status FROM discovery_runs WHERE discovery_run_id=?",
                    (run.discovery_run_id.root,),
                ).fetchone(),
                ("RUNNING",),
            )

    def test_read_uses_one_snapshot_when_a_concurrent_writer_commits(self) -> None:
        run = _topic_run(18)
        self.repository.create(run)
        source = self._source_result(run, "openalex", "EXHAUSTED")
        published = False

        def publish_after_snapshot(name: str) -> None:
            nonlocal published
            if name == "read-after-run" and not published:
                published = True
                self.repository.publish_source_result(source)

        reader = SqliteDiscoveryRepository(self.engine, failpoint=publish_after_snapshot)
        first_snapshot = reader.read(run.discovery_run_id)
        self.assertTrue(published)
        self.assertEqual(first_snapshot.source_results, ())
        self.assertEqual(self.repository.read(run.discovery_run_id).source_results, (source,))

    def test_recovery_interrupts_visible_running_runs_in_stable_order(self) -> None:
        first = _topic_run(21)
        second = _topic_run(19)
        terminal = _topic_run(20)
        for run in (first, second, terminal):
            self.repository.create(run)
        self.repository.publish_source_result(
            self._source_result(terminal, "openalex", "EXHAUSTED")
        )
        self.repository.finalize(terminal.discovery_run_id, "COMPLETED")

        interrupted = self.repository.interrupt_visible_running()
        expected = tuple(
            DiscoveryRunId(value)
            for value in sorted((first.discovery_run_id.root, second.discovery_run_id.root))
        )
        self.assertEqual(interrupted, expected)
        self.assertEqual(self.repository.read(first.discovery_run_id).run.status, "INTERRUPTED")
        self.assertEqual(self.repository.read(second.discovery_run_id).run.status, "INTERRUPTED")
        self.assertEqual(self.repository.read(terminal.discovery_run_id).run.status, "COMPLETED")
        self.assertEqual(self.repository.interrupt_visible_running(), ())

    def test_recovery_failpoint_rolls_back_all_status_changes(self) -> None:
        runs = (_topic_run(22), _topic_run(23))
        for run in runs:
            self.repository.create(run)
        failing = SqliteDiscoveryRepository(
            self.engine,
            failpoint=_fail_at("recovery-after-update"),
        )
        with self.assertRaises(DiscoveryRepositoryError):
            failing.interrupt_visible_running()
        self.assertEqual(
            tuple(self.repository.read(run.discovery_run_id).run.status for run in runs),
            ("RUNNING", "RUNNING"),
        )

    def test_real_recovery_runs_before_prepare_and_business_write(self) -> None:
        events: list[str] = []
        first = _topic_run(41)
        second = _topic_run(42)
        terminal = _topic_run(43)
        for run in (first, second, terminal):
            self.repository.create(run)
        self.repository.publish_source_result(
            self._source_result(terminal, "openalex", "EXHAUSTED")
        )
        self.repository.finalize(terminal.discovery_run_id, "COMPLETED")

        def recovery_checkpoint(name: str) -> None:
            if name == "recovery-after-update":
                events.append("recovery")

        recovery = SqliteDiscoveryRepository(
            self.engine,
            failpoint=recovery_checkpoint,
        )

        def prepare() -> tuple[str, str, str]:
            events.append("prepare")
            return (
                self.repository.read(first.discovery_run_id).run.status,
                self.repository.read(second.discovery_run_id).run.status,
                self.repository.read(terminal.discovery_run_id).run.status,
            )

        def execute(prepared: tuple[str, str, str]) -> str:
            self.assertEqual(prepared, ("INTERRUPTED", "INTERRUPTED", "COMPLETED"))
            events.append("execute")
            return "written"

        result = execute_database_write(
            admission=_RecordingAdmission(events),
            recovery=recovery,
            prepare=prepare,
            execute=execute,
        )

        self.assertEqual(result, "written")
        self.assertEqual(
            events,
            ["admission", "recovery", "prepare", "execute", "release"],
        )
        self.assertEqual(self.repository.read(terminal.discovery_run_id).run.status, "COMPLETED")

    def test_real_recovery_failure_prevents_prepare_and_execute_and_rolls_back(self) -> None:
        events: list[str] = []
        runs = (_topic_run(44), _topic_run(45))
        for run in runs:
            self.repository.create(run)
        before = self._all_discovery_rows()

        with self.assertRaises(DiscoveryRepositoryError):
            execute_database_write(
                admission=_RecordingAdmission(events),
                recovery=SqliteDiscoveryRepository(
                    self.engine,
                    failpoint=_fail_at("recovery-before-commit"),
                ),
                prepare=lambda: events.append("prepare"),
                execute=lambda _prepared: events.append("execute"),
            )

        self.assertEqual(events, ["admission", "release"])
        self.assertEqual(self._all_discovery_rows(), before)
        self.assertEqual(
            tuple(self.repository.read(run.discovery_run_id).run.status for run in runs),
            ("RUNNING", "RUNNING"),
        )

    def test_read_fails_closed_for_unknown_and_semantically_broken_rows(self) -> None:
        missing = _run_id(999)
        with self.assertRaisesRegex(DiscoveryRunNotFoundError, "^discovery run was not found$"):
            self.repository.read(missing)

        run = _topic_run(24, providers=_providers(("first", 1), ("second", 2)))
        self.repository.create(run)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE discovery_run_providers SET provider_ordinal=9 "
                "WHERE discovery_run_id=? AND provider_name='second'",
                (run.discovery_run_id.root,),
            )
        with self.assertRaises(DiscoveryRepositoryIntegrityError) as caught:
            self.repository.read(run.discovery_run_id)
        rendered = str(caught.exception)
        self.assertEqual(rendered, "discovery repository contains invalid facts")
        self.assertNotIn(run.discovery_run_id.root, rendered)
        self.assertNotIn(str(self.catalog), rendered)
        self.assertNotIn("SELECT", rendered)

    def test_read_rejects_unsafe_stable_failure_without_leaking_it(self) -> None:
        run = _topic_run(25)
        self.repository.create(run)
        sentinel = "/private/users/alice/token.txt"
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO discovery_source_results("
                "discovery_run_id,provider_name,outcome,failure_code,failure_reason,"
                "failure_action,failure_retryable) VALUES (?,?,?,?,?,?,?)",
                (
                    run.discovery_run_id.root,
                    "openalex",
                    "FAILED",
                    "unsafe",
                    sentinel,
                    "Retry later",
                    0,
                ),
            )
        with self.assertRaises(DiscoveryRepositoryIntegrityError) as caught:
            self.repository.read(run.discovery_run_id)
        self.assertEqual(str(caught.exception), "discovery repository contains invalid facts")
        self.assertNotIn(sentinel, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
