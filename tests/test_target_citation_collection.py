from __future__ import annotations

import unittest

from target_citation_fixture import (
    CitationCollectionTestCase,
    FakeCitationPort,
    FixedCandidateBibliography,
)
from test_target_collection import FakeMetadataPort

from sciretriever.bibliography.api import (
    IdentityCandidate,
    IdentityCandidateSet,
)
from sciretriever.collection.api import (
    CausePageRequest,
    CitationCollectionRequest,
    CitationDiscoveryRequest,
    CitationRunInput,
    CollectionSeed,
    IdentifierSeed,
    PathPageRequest,
    ProviderDiscoveryResult,
    WorkSeed,
    WorkVersionSeed,
)
from sciretriever.collection.citation_input import (
    ValidatedCitationInput,
    citation_run_input_from_validated,
)
from sciretriever.collection.service import (
    CitationSource,
    CollectionService,
    CollectionServiceDependencies,
    MetadataSource,
)
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    canonical_json_bytes,
)
from sciretriever.literature_store.sqlite import (
    CollectionAcceptancePublisher,
    open_read_only_snapshot,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionId,
    WorkId,
    WorkVersionId,
    WorkVersionState,
    sha256_digest,
)


class TargetCitationCollectionTests(CitationCollectionTestCase):
    def test_persisted_invalid_primitive_is_translated_to_boundary_error(self) -> None:
        payload = CanonicalJsonObject(
            (
                ("depth", 1),
                ("direction", "references"),
                ("max_new", 1),
                ("providers", ("alpha",)),
                ("resolved_work_ids", ("not-a-uuid",)),
                ("seed_selectors", ()),
            )
        )
        encoded = canonical_json_bytes(payload)
        validated = ValidatedCitationInput(encoded.decode("ascii"), sha256_digest(encoded))

        with self.assertRaisesRegex(BoundaryError, "citation_input"):
            citation_run_input_from_validated(validated)

    def test_four_seed_kinds_resolve_dedupe_sort_and_persist_canonical_input(self) -> None:
        first_collection, first = self.add_work("10.1/a")
        _, second = self.add_work("10.1/b")
        target = self.service().create("citation-target", None, None)
        request = CitationCollectionRequest(
            (
                WorkSeed(second.work_id),
                WorkVersionSeed(first.work_version_id),
                IdentifierSeed(Identifier(namespace="doi", value="10.1/b")),
                CollectionSeed(first_collection.collection_id),
            ),
            ("alpha", "beta"),
            CitationDirection.BOTH,
            0,
            9,
        )

        requests: list[CitationDiscoveryRequest] = []
        sources = tuple(
            CitationSource(
                name,
                FakeCitationPort(self.catalog, {}, name, requests),
            )
            for name in ("alpha", "beta")
        )
        result = self.service(sources).run_citation(
            target.collection_id,
            request,
            WorkVersionState.LIGHT_TEXT_READY,
        )

        persisted = self.collections.get_citation_input(result.run_id)
        self.assertIsInstance(persisted, CitationRunInput)
        assert persisted is not None
        self.assertEqual(persisted.original_selectors, request.seed_selectors)
        self.assertEqual(
            tuple(map(str, persisted.resolved_work_ids)),
            tuple(sorted((str(first.work_id), str(second.work_id)))),
        )
        self.assertEqual(requests, [])
        self.assertEqual(
            (persisted.providers, persisted.direction, persisted.depth, persisted.max_new),
            (("alpha", "beta"), CitationDirection.BOTH, 0, 9),
        )
        self.assertEqual(result.stop_reason, "depth-limit")

    def test_invalid_seed_rejects_before_run_creation(self) -> None:
        target = self.service().create("invalid", None, None)
        empty = self.service().create("empty-seed", None, None)
        missing = "00000000-0000-4000-8000-000000000099"
        selectors = (
            WorkSeed(WorkId(missing)),
            WorkVersionSeed(WorkVersionId(missing)),
            IdentifierSeed(Identifier(namespace="doi", value="10.1/missing")),
            CollectionSeed(CollectionId(missing)),
            CollectionSeed(empty.collection_id),
        )
        source = CitationSource("alpha", FakeCitationPort(self.catalog, {}, "alpha", []))
        for selector in selectors:
            with self.subTest(selector=selector), self.assertRaises(BoundaryError):
                self.service((source,)).run_citation(
                    target.collection_id,
                    CitationCollectionRequest(
                        (selector,),
                        ("alpha",),
                        CitationDirection.REFERENCES,
                        1,
                        10,
                    ),
                    WorkVersionState.UNREVIEWED,
                )

        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE collection_id=?",
                    (str(target.collection_id),),
                ).fetchone(),
                (0,),
            )

    def test_ambiguous_identifier_rejects_before_run_creation(self) -> None:
        _, first = self.add_work("10.1/ambiguous-a")
        _, second = self.add_work("10.1/ambiguous-b")
        identifier = Identifier(namespace="doi", value="10.1/ambiguous")
        bibliography = FixedCandidateBibliography(
            self.bibliography,
            IdentityCandidateSet(
                (
                    IdentityCandidate(first.work_id, first.work_version_id, (identifier,)),
                    IdentityCandidate(second.work_id, second.work_version_id, (identifier,)),
                )
            ),
        )
        source = CitationSource("alpha", FakeCitationPort(self.catalog, {}, "alpha", []))
        service = CollectionService(
            CollectionServiceDependencies(
                self.collections,
                bibliography,
                CollectionAcceptancePublisher(self.catalog),
                lambda: self.bound.port.acquire_core_write(self.bound.identity),
                (
                    MetadataSource(
                        "seed",
                        FakeMetadataPort(
                            self.catalog,
                            ProviderDiscoveryResult("seed", (), None),
                            [],
                        ),
                    ),
                ),
                (source,),
            )
        )
        target = service.create("ambiguous", None, None)

        with self.assertRaises(BoundaryError):
            service.run_citation(
                target.collection_id,
                CitationCollectionRequest(
                    (IdentifierSeed(identifier),),
                    ("alpha",),
                    CitationDirection.REFERENCES,
                    1,
                    10,
                ),
                WorkVersionState.UNREVIEWED,
            )

        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE collection_id=?",
                    (str(target.collection_id),),
                ).fetchone(),
                (0,),
            )

    def test_cyclic_layers_keep_duplicate_paths_isolate_provider_failure_and_restart(self) -> None:
        _, first = self.add_work("10.1/a")
        _, second = self.add_work("10.1/b")
        _, third = self.add_work("10.1/c")
        _, fourth = self.add_work("10.1/d")
        identifiers = {
            str(first.work_id): Identifier(namespace="doi", value="10.1/a"),
            str(second.work_id): Identifier(namespace="doi", value="10.1/b"),
            str(third.work_id): Identifier(namespace="doi", value="10.1/c"),
            str(fourth.work_id): Identifier(namespace="doi", value="10.1/d"),
        }
        alpha_edges = {
            (str(first.work_id), CitationDirection.REFERENCES): (
                identifiers[str(third.work_id)],
                identifiers[str(second.work_id)],
                identifiers[str(second.work_id)],
            ),
            (str(second.work_id), CitationDirection.REFERENCES): (
                identifiers[str(first.work_id)],
                identifiers[str(fourth.work_id)],
            ),
            (str(third.work_id), CitationDirection.REFERENCES): (identifiers[str(fourth.work_id)],),
        }
        beta_edges = {
            (str(first.work_id), CitationDirection.REFERENCES): (identifiers[str(second.work_id)],),
            (str(third.work_id), CitationDirection.REFERENCES): (identifiers[str(fourth.work_id)],),
        }
        calls: list[CitationDiscoveryRequest] = []
        sources = (
            CitationSource("alpha", FakeCitationPort(self.catalog, alpha_edges, "alpha", calls)),
            CitationSource(
                "beta",
                FakeCitationPort(
                    self.catalog,
                    beta_edges,
                    "beta",
                    calls,
                    frozenset((str(second.work_id),)),
                ),
            ),
        )
        service = self.service(sources)
        target = service.create("cyclic", None, None)
        request = CitationCollectionRequest(
            (WorkSeed(first.work_id),),
            ("alpha", "beta"),
            CitationDirection.REFERENCES,
            2,
            10,
        )

        first_run = service.run_citation(
            target.collection_id,
            request,
            WorkVersionState.COMPLETED,
        )
        restarted = service.run_citation(
            target.collection_id,
            request,
            WorkVersionState.COMPLETED,
        )

        self.assertEqual(first_run.status.value, "partial")
        self.assertEqual(first_run.stop_reason, "depth-limit")
        self.assertEqual((first_run.counts.new_members, restarted.counts.new_members), (3, 0))
        self.assertEqual(tuple(item.source for item in first_run.source_results), ("alpha", "beta"))
        self.assertEqual(first_run.source_results[1].failure_code, "provider-unavailable")
        self.assertEqual(
            tuple((str(item.seed), item.direction) for item in calls[:6]),
            (
                (str(first.work_id), CitationDirection.REFERENCES),
                (str(first.work_id), CitationDirection.REFERENCES),
                (str(second.work_id), CitationDirection.REFERENCES),
                (str(second.work_id), CitationDirection.REFERENCES),
                (str(third.work_id), CitationDirection.REFERENCES),
                (str(third.work_id), CitationDirection.REFERENCES),
            ),
        )
        paths = self.collections.list_paths(PathPageRequest(target.collection_id, None, 100)).paths
        causes = self.collections.list_causes(
            CausePageRequest(target.collection_id, None, 100)
        ).causes
        fourth_paths = tuple(item for item in paths if item.work_ids[-1] == fourth.work_id)
        self.assertGreaterEqual(len(fourth_paths), 4)
        self.assertTrue(all(item.depth == len(item.work_ids) - 1 for item in paths))
        self.assertGreater(len(causes), 4)
        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_memberships WHERE collection_id=?",
                    (str(target.collection_id),),
                ).fetchone(),
                (4,),
            )
            self.assertEqual(connection.execute("SELECT count(*) FROM batch_runs").fetchone(), (0,))

    def test_max_new_and_no_new_are_distinct_durable_stops(self) -> None:
        _, seed = self.add_work("10.1/limit-seed")
        _, first = self.add_work("10.1/limit-a")
        _, second = self.add_work("10.1/limit-b")
        edges = {
            (str(seed.work_id), CitationDirection.REFERENCES): (
                Identifier(namespace="doi", value="10.1/limit-b"),
                Identifier(namespace="doi", value="10.1/limit-a"),
            )
        }
        calls: list[CitationDiscoveryRequest] = []
        source = CitationSource("alpha", FakeCitationPort(self.catalog, edges, "alpha", calls))
        service = self.service((source,))
        limited = service.create("limited", None, None)
        empty = service.create("empty-graph", None, None)

        max_run = service.run_citation(
            limited.collection_id,
            CitationCollectionRequest(
                (WorkSeed(seed.work_id),),
                ("alpha",),
                CitationDirection.REFERENCES,
                4,
                1,
            ),
            WorkVersionState.UNREVIEWED,
        )
        no_new_run = service.run_citation(
            empty.collection_id,
            CitationCollectionRequest(
                (WorkSeed(second.work_id),),
                ("alpha",),
                CitationDirection.REFERENCES,
                4,
                3,
            ),
            WorkVersionState.UNREVIEWED,
        )

        self.assertEqual((max_run.stop_reason, max_run.counts.new_members), ("max-new", 1))
        self.assertEqual((no_new_run.stop_reason, no_new_run.counts.new_members), ("no-new", 0))
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
