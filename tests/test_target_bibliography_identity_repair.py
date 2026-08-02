from __future__ import annotations

import unittest
from dataclasses import replace

from test_target_bibliography_identity import (
    FakeAcceptancePublisher,
    TargetBibliographyIdentityTests,
    observation,
)

from sciretriever.bibliography.identity import prepare_initial_ingest
from sciretriever.bibliography.identity_model import InitialMetadata
from sciretriever.literature_store.sqlite import create_or_open_catalog
from sciretriever.model.literature import Identifier


class TargetBibliographyIdentityRepairTests(TargetBibliographyIdentityTests):
    def test_incomplete_identifier_free_metadata_never_exact_matches(self) -> None:
        complete = InitialMetadata(
            "Exact Identity", ("Ada Lovelace", "Grace Hopper"), 2026, "journal-article"
        )
        incomplete = (
            replace(complete, title=None),
            replace(complete, authors=()),
            replace(complete, year=None),
            replace(complete, item_type=None),
        )
        for index, metadata in enumerate(incomplete):
            catalog, repository = self.prepare_catalog(f"incomplete-{index}")
            first_observation = replace(observation("one", "1", ()), metadata=metadata)
            second_observation = replace(observation("two", "2", ()), metadata=metadata)
            first = prepare_initial_ingest(repository, (first_observation,))
            FakeAcceptancePublisher(catalog).publish(first)
            second = prepare_initial_ingest(repository, (second_observation,))
            self.assertNotEqual(second.work_version_id, first.work_version_id)

    def test_shared_identifiers_with_blockers_use_distinct_replayable_identity(self) -> None:
        identifiers = (
            Identifier(namespace="doi", value="10.1/shared"),
            Identifier(namespace="pmid", value="42"),
        )
        variants = (
            observation("two", "2", (), title="Other", authors=("Different",)),
            observation("two", "2", (), year=2025),
            observation("two", "2", (), item_type="book"),
        )
        for namespace_index, identifier in enumerate(identifiers):
            for variant_index, variant in enumerate(variants):
                catalog, repository = self.prepare_catalog(
                    f"blocked-{namespace_index}-{variant_index}"
                )
                first = prepare_initial_ingest(
                    repository, (observation("one", "1", (identifier,)),)
                )
                FakeAcceptancePublisher(catalog).publish(first)
                incoming = replace(variant, identifiers=(identifier,))
                second = prepare_initial_ingest(repository, (incoming,))
                self.assertNotEqual(second.work_version_id, first.work_version_id)
                self.assertFalse(second.identifiers)
                self.assertTrue(
                    all(
                        item.left_version_id != item.right_version_id
                        for item in second.review_relations
                    )
                )
                FakeAcceptancePublisher(catalog).publish(second)
                replay = prepare_initial_ingest(repository, (incoming,))
                self.assertEqual(replay.work_version_id, second.work_version_id)

    def test_role_reduction_is_order_independent_and_persisted(self) -> None:
        pairs = (
            ("preprint", "formal", "formal"),
            ("formal", "preprint", "formal"),
            ("other", "accepted-manuscript", "accepted-manuscript"),
            ("accepted-manuscript", "other", "accepted-manuscript"),
        )
        for index, (first_role, second_role, expected) in enumerate(pairs):
            catalog, repository = self.prepare_catalog(f"role-{index}")
            identifier = Identifier(namespace="doi", value=f"10.1/role-{index}")
            first = prepare_initial_ingest(
                repository, (observation("one", "1", (identifier,), role=first_role),)
            )
            FakeAcceptancePublisher(catalog).publish(first)
            second = prepare_initial_ingest(
                repository, (observation("two", "2", (identifier,), role=second_role),)
            )
            self.assertEqual(second.version_role, expected)
            FakeAcceptancePublisher(catalog).publish(second)
            with create_or_open_catalog(catalog) as connection:
                stored = connection.execute(
                    "SELECT version_role FROM work_versions WHERE id=?",
                    (str(second.work_version_id),),
                ).fetchone()
            self.assertEqual(stored, (expected,))


if __name__ == "__main__":
    unittest.main()
