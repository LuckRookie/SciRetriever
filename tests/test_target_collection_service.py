from __future__ import annotations

import unittest

from target_citation_fixture import CitationCollectionTestCase, FakeCitationPort
from test_target_collection import FakeMetadataPort, observation

import sciretriever.services.collection as collection_package
from sciretriever.literature_store.sqlite import (
    CollectionAcceptancePublisher,
    SqliteLiteratureRepository,
)
from sciretriever.model.collection import (
    CitationCollectionRequest,
    MembershipPageRequest,
    TopicConditions,
    WorkSeed,
)
from sciretriever.model.literature import Identifier, IdentityCandidateQuery
from sciretriever.model.primitives import CitationDirection, WorkVersionState
from sciretriever.model.sources import ProviderDiscoveryResult
from sciretriever.services.collection import api as collection_api
from sciretriever.services.collection.api import (
    CitationSource,
    CollectionService,
    CollectionServiceDependencies,
    MetadataSource,
)


class TargetCollectionServiceApiTests(CitationCollectionTestCase):
    def test_public_exports_are_the_narrow_use_case_surface(self) -> None:
        expected = (
            "CitationSource",
            "CollectionRuleError",
            "CollectionService",
            "CollectionServiceDependencies",
            "MetadataSource",
        )
        self.assertEqual(collection_api.__all__, expected)
        self.assertEqual(collection_package.__all__, expected)

    def test_topic_and_citation_use_cases_run_through_sqlite(self) -> None:
        metadata = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="topic",
                observations=(observation("topic", "topic-seed", "10.1/seed"),),
                failure=None,
            ),
            [],
        )
        citation = FakeCitationPort(self.catalog, {}, "citation", [])
        service = CollectionService(
            CollectionServiceDependencies(
                self.collections,
                self.bibliography,
                CollectionAcceptancePublisher(self.catalog),
                lambda: self.bound.port.acquire_core_write(self.bound.identity),
                (MetadataSource("topic", metadata),),
                (CitationSource("citation", citation),),
            )
        )
        target = service.create("Target", None, None)
        topic = service.create("Topic", None, TopicConditions(query="topic"))

        topic_result = service.run_topic(topic.collection_id, WorkVersionState.UNREVIEWED)
        seed = (
            SqliteLiteratureRepository(self.catalog)
            .find_identity_candidates(
                IdentityCandidateQuery(
                    identifiers=(Identifier(namespace="doi", value="10.1/seed"),)
                )
            )
            .candidates[0]
            .work_id
        )
        citation.edges[(str(seed), CitationDirection.REFERENCES)] = (
            Identifier(namespace="doi", value="10.1/target"),
        )
        citation_result = service.run_citation(
            target.collection_id,
            CitationCollectionRequest(
                seed_selectors=(WorkSeed(work_id=seed),),
                providers=("citation",),
                direction=CitationDirection.REFERENCES,
                depth=1,
                max_new=2,
            ),
            WorkVersionState.UNREVIEWED,
        )

        self.assertEqual(topic_result.status.value, "completed")
        self.assertEqual(citation_result.stop_reason, "depth-limit")
        self.assertEqual(
            len(
                self.collections.list_memberships(
                    MembershipPageRequest(
                        collection_id=topic.collection_id,
                        after_work_id=None,
                        limit=100,
                    )
                ).members
            ),
            1,
        )
        self.assertEqual(
            len(
                self.collections.list_memberships(
                    MembershipPageRequest(
                        collection_id=target.collection_id,
                        after_work_id=None,
                        limit=100,
                    )
                ).members
            ),
            2,
        )
        with self.bound.port.acquire_core_write(self.bound.identity):
            pass


if __name__ == "__main__":
    unittest.main()
