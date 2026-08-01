from __future__ import annotations

import os
import unittest
from itertools import permutations
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.bibliography.identity import prepare_initial_ingest
from sciretriever.bibliography.identity_model import (
    BibliographicObservation,
    InitialMetadata,
    VersionRelationEvidence,
)
from sciretriever.kernel import Identifier, UtcTimestamp
from sciretriever.literature_store.sqlite import (
    SqliteBibliographyRepository,
    create_or_open_catalog,
)


def observation(
    provider: str,
    record: str,
    identifiers: tuple[Identifier, ...],
    *,
    title: str = "Exact Identity",
    authors: tuple[str, ...] = ("Ada Lovelace", "Grace Hopper"),
    year: int = 2026,
    item_type: str = "journal-article",
    priority: int = 0,
    role: str = "formal",
    relation: VersionRelationEvidence | None = None,
) -> BibliographicObservation:
    return BibliographicObservation(
        provider=provider,
        provider_record_id=record,
        source_priority=priority,
        observed_at=UtcTimestamp("2026-07-31T00:00:00Z"),
        identifiers=identifiers,
        metadata=InitialMetadata(title, authors, year, item_type, f"abstract-{provider}"),
        version_role=role,
        version_relation=relation,
    )


class StaleRoleError(RuntimeError):
    pass


class FakeAcceptancePublisher:
    def __init__(self, catalog: Path) -> None:
        self.catalog = catalog

    def publish(self, prepared) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "INSERT OR IGNORE INTO works(id) VALUES(?)", (str(prepared.work_id),)
            )
            connection.execute(
                "INSERT OR IGNORE INTO work_versions(id,work_id,version_role) VALUES(?,?,?)",
                (str(prepared.work_version_id), str(prepared.work_id), prepared.version_role),
            )
            if prepared.role_update is not None:
                update = prepared.role_update
                cursor = connection.execute(
                    "UPDATE work_versions SET version_role=? WHERE id=? AND version_role=?",
                    (update.role, str(update.work_version_id), update.expected_role),
                )
                if cursor.rowcount != 1:
                    raise StaleRoleError
            for identity in prepared.superseded_identities:
                connection.execute(
                    "UPDATE stable_identifiers SET work_version_id=? WHERE work_version_id=?",
                    (str(prepared.work_version_id), str(identity.work_version_id)),
                )
                connection.execute(
                    "UPDATE metadata_observations SET work_version_id=? WHERE work_version_id=?",
                    (str(prepared.work_version_id), str(identity.work_version_id)),
                )
                connection.execute(
                    "DELETE FROM work_representative_versions WHERE work_id=?",
                    (str(identity.work_id),),
                )
                connection.execute(
                    "DELETE FROM work_versions WHERE id=?", (str(identity.work_version_id),)
                )
                connection.execute(
                    "DELETE FROM works WHERE id=? "
                    "AND NOT EXISTS(SELECT 1 FROM work_versions WHERE work_id=?)",
                    (str(identity.work_id), str(identity.work_id)),
                )
            for identifier in prepared.identifiers:
                connection.execute(
                    "INSERT OR IGNORE INTO stable_identifiers"
                    "(id,work_version_id,namespace,value) VALUES(?,?,?,?)",
                    (
                        str(identifier.identifier_id),
                        str(prepared.work_version_id),
                        identifier.value.namespace,
                        identifier.value.value,
                    ),
                )
            for item in prepared.observations:
                connection.execute(
                    "INSERT OR IGNORE INTO metadata_observations"
                    "(id,work_version_id,provider,provider_record_id,payload_sha256,payload_json,"
                    "observed_at) VALUES(?,?,?,?,?,?,?)",
                    (
                        str(item.observation_id),
                        str(prepared.work_version_id),
                        item.provider,
                        item.provider_record_id,
                        str(item.payload_sha256),
                        item.payload_json,
                        str(item.observed_at),
                    ),
                )
            if prepared.metadata_snapshot is not None:
                snapshot = prepared.metadata_snapshot
                connection.execute(
                    "INSERT OR IGNORE INTO metadata_snapshots"
                    "(id,work_version_id,revision,sha256,values_json,provenance_json) "
                    "VALUES(?,?,?,?,?,?)",
                    (
                        str(snapshot.snapshot_id),
                        str(prepared.work_version_id),
                        snapshot.revision,
                        str(snapshot.sha256),
                        snapshot.values_json,
                        snapshot.provenance_json,
                    ),
                )
                connection.execute(
                    "INSERT INTO work_version_current_metadata"
                    "(work_version_id,metadata_snapshot_id) VALUES(?,?) "
                    "ON CONFLICT(work_version_id) DO UPDATE SET "
                    "metadata_snapshot_id=excluded.metadata_snapshot_id",
                    (str(prepared.work_version_id), str(snapshot.snapshot_id)),
                )
            connection.execute(
                "INSERT INTO work_representative_versions(work_id,work_version_id) VALUES(?,?) "
                "ON CONFLICT(work_id) DO UPDATE SET work_version_id=excluded.work_version_id",
                (str(prepared.work_id), str(prepared.representative_version_id)),
            )
            for relation in prepared.version_relations:
                connection.execute(
                    "INSERT OR IGNORE INTO work_version_relations"
                    "(id,left_version_id,right_version_id,relation) VALUES(?,?,?,?)",
                    (
                        str(relation.relation_id),
                        str(relation.left_version_id),
                        str(relation.right_version_id),
                        relation.relation,
                    ),
                )
            connection.commit()


class TargetBibliographyIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task11-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)

    def prepare_catalog(self, name: str) -> tuple[Path, SqliteBibliographyRepository]:
        catalog = self.root / f"{name}.sqlite"
        with create_or_open_catalog(catalog):
            pass
        return catalog, SqliteBibliographyRepository(catalog)

    def test_three_exact_routes_are_deterministic_across_provider_permutations(self) -> None:
        doi = Identifier("doi", "10.1000/exact")
        pmid = Identifier("pmid", "42")
        records = (
            observation("crossref", "c", (doi,), priority=0),
            observation("pubmed", "p", (pmid,), priority=1),
            observation("bridge", "b", (doi, pmid), priority=2),
        )
        outcomes: set[tuple[str, str, str]] = set()
        for index, ordered in enumerate(permutations(records)):
            catalog, repository = self.prepare_catalog(str(index))
            prepared = prepare_initial_ingest(repository, (ordered[0],))
            FakeAcceptancePublisher(catalog).publish(prepared)
            for item in ordered[1:]:
                prepared = prepare_initial_ingest(repository, (item,))
                FakeAcceptancePublisher(catalog).publish(prepared)
            replay = prepare_initial_ingest(repository, tuple(reversed(ordered)))
            current = next(
                item
                for item in repository.list_identity_records()
                if item.work_version_id == prepared.work_version_id
            )
            outcomes.add(
                (
                    str(prepared.work_id),
                    str(prepared.work_version_id),
                    repr(current.current_metadata),
                )
            )
            self.assertEqual(
                (replay.work_id, replay.work_version_id),
                (prepared.work_id, prepared.work_version_id),
            )
            self.assertEqual(len(repository.list_observations(prepared.work_version_id)), 3)
        self.assertEqual(len(outcomes), 1, outcomes)
        catalog, repository = self.prepare_catalog("metadata-tuple")
        first = prepare_initial_ingest(repository, (observation("one", "1", ()),))
        FakeAcceptancePublisher(catalog).publish(first)
        second = prepare_initial_ingest(repository, (observation("two", "2", ()),))
        self.assertEqual(second.work_version_id, first.work_version_id)

    def test_conflict_blockers_keep_versions_separate_with_review_evidence(self) -> None:
        blockers = (
            (
                observation("a", "1", (Identifier("doi", "10.1/a"),)),
                observation("b", "2", (Identifier("doi", "10.1/b"),)),
            ),
            (
                observation("a", "1", (), title="Alpha", authors=("A",)),
                observation("b", "2", (), title="Beta", authors=("B",)),
            ),
            (observation("a", "1", (), year=2025), observation("b", "2", (), year=2026)),
            (
                observation("a", "1", (), item_type="article"),
                observation("b", "2", (), item_type="book"),
            ),
        )
        for index, pair in enumerate(blockers):
            catalog, repository = self.prepare_catalog(f"conflict-{index}")
            first = prepare_initial_ingest(repository, (pair[0],))
            FakeAcceptancePublisher(catalog).publish(first)
            second = prepare_initial_ingest(repository, (pair[1],))
            self.assertNotEqual(second.work_version_id, first.work_version_id)
            self.assertTrue(second.review_relations)

    def test_fuzzy_title_only_creates_neutral_review_and_never_merges(self) -> None:
        catalog, repository = self.prepare_catalog("fuzzy")
        first = prepare_initial_ingest(
            repository, (observation("a", "1", (), title="A Study of Catalysis"),)
        )
        FakeAcceptancePublisher(catalog).publish(first)
        second = prepare_initial_ingest(
            repository, (observation("b", "2", (), title="Study of Catalysis"),)
        )
        self.assertNotEqual(second.work_version_id, first.work_version_id)
        self.assertEqual(second.review_relations[0].relation, "possible-duplicate")

    def test_explicit_version_relation_shares_work_but_preserves_versions_and_roles(self) -> None:
        catalog, repository = self.prepare_catalog("relations")
        preprint_id = Identifier("arxiv", "2601.00001")
        preprint = prepare_initial_ingest(
            repository, (observation("arxiv", "p", (preprint_id,), role="preprint"),)
        )
        FakeAcceptancePublisher(catalog).publish(preprint)
        formal = observation(
            "crossref",
            "f",
            (Identifier("doi", "10.1/formal"),),
            role="formal",
            relation=VersionRelationEvidence(preprint_id, "published-version-of"),
        )
        published = prepare_initial_ingest(repository, (formal,))
        FakeAcceptancePublisher(catalog).publish(published)
        self.assertEqual(published.work_id, preprint.work_id)
        self.assertNotEqual(published.work_version_id, preprint.work_version_id)
        self.assertEqual(published.representative_version_id, published.work_version_id)
        self.assertEqual(published.version_relations[0].right_version_id, preprint.work_version_id)
        with create_or_open_catalog(catalog) as connection:
            rows = connection.execute(
                "SELECT version_role FROM work_versions ORDER BY version_role"
            ).fetchall()
        self.assertEqual(rows, [("formal",), ("preprint",)])


if __name__ == "__main__":
    unittest.main()
