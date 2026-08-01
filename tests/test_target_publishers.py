from __future__ import annotations

from dataclasses import replace
import unittest

from sciretriever.batching.api import (
    ContentAcceptanceCommand, ImportAcceptanceCommand,
    TargetResult,
)
from sciretriever.bibliography.api import CompletionSubmission, FinalMetadataFact
from sciretriever.collection.api import CollectionAcceptance
from sciretriever.content.api import ArtifactKind, LightDocumentAcceptance
from sciretriever.interoperability.ports import ImportResult
from sciretriever.kernel import BoundaryError, CanonicalJsonObject, Sha256, WorkId, WorkVersionId
from sciretriever.literature_store.sqlite import StalePublicationError, open_read_only_snapshot
from target_publisher_support import ScenarioFactory


class InjectedFailure(RuntimeError):
    pass


class TargetPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    def test_owner_commands_reject_cross_identity_combinations(self) -> None:
        collection = self.factory.collection()
        assert isinstance(collection.command, CollectionAcceptance)
        other_work = WorkId("00000000-0000-0000-0000-000000000001")
        with self.assertRaises(BoundaryError):
            CollectionAcceptance(collection.command.bibliography, replace(collection.command.membership, work_id=other_work), (), ())

        imported = self.factory.imported()
        assert isinstance(imported.command, ImportAcceptanceCommand)
        other_version = WorkVersionId("00000000-0000-0000-0000-000000000002")
        with self.assertRaises(BoundaryError):
            ImportAcceptanceCommand(imported.command.bibliography, imported.command.references, imported.command.tags, replace(imported.command.record, work_version_id=other_version))

        primary = self.factory.primary()
        assert isinstance(primary.command, ContentAcceptanceCommand)
        with self.assertRaises(BoundaryError):
            ContentAcceptanceCommand(primary.command.acceptance, replace(primary.command.target, work_version_id=other_version))

        completion = self.factory.completion()
        assert isinstance(completion.command, CompletionSubmission)
        with self.assertRaises(BoundaryError):
            replace(completion.command, work_version_id=other_version)
        with self.assertRaises(BoundaryError):
            replace(completion.command, references=replace(completion.command.references, work_version_id=other_version))

    def test_adapters_defensively_reject_tampered_cross_identity_commands(self) -> None:
        other_work = WorkId("00000000-0000-0000-0000-000000000001")
        other_version = WorkVersionId("00000000-0000-0000-0000-000000000002")
        scenarios = (
            self.factory.collection(), self.factory.imported(), self.factory.primary(),
            self.factory.completion(),
        )
        collection = scenarios[0].command
        assert isinstance(collection, CollectionAcceptance)
        object.__setattr__(collection, "membership", replace(collection.membership, work_id=other_work))
        imported = scenarios[1].command
        assert isinstance(imported, ImportAcceptanceCommand)
        object.__setattr__(imported, "record", replace(imported.record, work_version_id=other_version))
        content = scenarios[2].command
        assert isinstance(content, ContentAcceptanceCommand)
        object.__setattr__(content, "target", replace(content.target, work_version_id=other_version))
        completion = scenarios[3].command
        assert isinstance(completion, CompletionSubmission)
        object.__setattr__(completion, "work_version_id", other_version)
        for scenario in scenarios:
            with self.subTest(authority=scenario.authority_table):
                with self.assertRaises(StalePublicationError):
                    scenario.invoke()

    def test_pairwise_result_enums_with_identical_details_persist_differently(self) -> None:
        details = CanonicalJsonObject((("reason", "same"),))
        cases = (
            (self.factory.primary, TargetResult.PARTIALLY_ADVANCED, TargetResult.FAILED),
            (self.factory.imported, ImportResult.CREATED, ImportResult.REJECTED),
        )
        for builder, first_result, second_result in cases:
            stored: list[str] = []
            for result in (first_result, second_result):
                scenario = builder()
                command = scenario.command
                if isinstance(command, ContentAcceptanceCommand):
                    command = replace(command, target=replace(command.target, result=result, details=details))
                else:
                    assert isinstance(command, ImportAcceptanceCommand)
                    command = replace(command, record=replace(command.record, result=result, details=details))
                replace(scenario, command=command).invoke()
                with open_read_only_snapshot(scenario.path) as reader:
                    stored.append(reader.execute("SELECT result_json FROM batch_targets").fetchone()[0])
            with self.subTest(builder=builder.__name__):
                self.assertNotEqual(stored[0], stored[1])
                self.assertIn(f'"result":"{first_result.value}"', stored[0])
                self.assertIn(f'"result":"{second_result.value}"', stored[1])
                self.assertIn('"details":{"reason":"same"}', stored[0])

    def test_result_details_cannot_supply_a_second_discriminator(self) -> None:
        contradictory = CanonicalJsonObject((("result", "failed"),))
        primary = self.factory.primary()
        assert isinstance(primary.command, ContentAcceptanceCommand)
        with self.assertRaises(BoundaryError):
            replace(primary.command.target, details=contradictory)
        imported = self.factory.imported()
        assert isinstance(imported.command, ImportAcceptanceCommand)
        with self.assertRaises(BoundaryError):
            replace(imported.command.record, details=contradictory)

    def test_owner_contracts_reject_false_structured_payload_identity(self) -> None:
        completion = self.factory.completion()
        assert isinstance(completion.command, CompletionSubmission)
        metadata = completion.command.metadata
        with self.assertRaises(BoundaryError):
            FinalMetadataFact(
                metadata.work_version_id, metadata.expected_snapshot_id,
                metadata.expected_revision, metadata.expected_sha256, metadata.snapshot_id,
                metadata.revision, Sha256("0" * 64), metadata.values, metadata.provenance,
            )
        light = self.factory.light()
        assert isinstance(light.command, ContentAcceptanceCommand)
        accepted_light = light.command.acceptance
        assert isinstance(accepted_light, LightDocumentAcceptance)
        with self.assertRaises(BoundaryError):
            replace(accepted_light, document=CanonicalJsonObject((("tampered", True),)))
        analysis = completion.command.analysis
        with self.assertRaises(BoundaryError):
            replace(analysis, proposal=CanonicalJsonObject((("tampered", True),)))
        with self.assertRaises(BoundaryError):
            replace(analysis, artifact_size=analysis.artifact_size + 1)
        with self.assertRaises(BoundaryError):
            replace(analysis, artifact_sha256=Sha256("1" * 64))

    def test_adapters_recompute_structured_payload_identity_before_begin(self) -> None:
        scenarios = (self.factory.light(), self.factory.completion(), self.factory.completion())
        light_command = scenarios[0].command
        assert isinstance(light_command, ContentAcceptanceCommand)
        light = light_command.acceptance
        assert isinstance(light, LightDocumentAcceptance)
        object.__setattr__(light, "document", CanonicalJsonObject((("tampered", True),)))
        completion_command = scenarios[1].command
        assert isinstance(completion_command, CompletionSubmission)
        analysis = completion_command.analysis
        object.__setattr__(analysis, "proposal", CanonicalJsonObject((("tampered", True),)))
        metadata_command = scenarios[2].command
        assert isinstance(metadata_command, CompletionSubmission)
        object.__setattr__(metadata_command.metadata, "sha256", Sha256("0" * 64))
        for scenario in scenarios:
            with self.subTest(authority=scenario.authority_table), self.assertRaises(StalePublicationError):
                scenario.invoke()

        result = self.factory.primary()
        assert isinstance(result.command, ContentAcceptanceCommand)
        object.__setattr__(
            result.command.target, "details", CanonicalJsonObject((("result", "failed"),)),
        )
        with self.assertRaises(StalePublicationError):
            result.invoke()

    def test_every_write_and_commit_failpoint_is_atomic_for_every_variant(self) -> None:
        builders = (
            self.factory.collection, self.factory.imported, self.factory.primary,
            self.factory.light, self.factory.completion,
        )
        expected_writes = {
            "collection": 10, "imported": 12, "primary": 6,
            "light": 7, "completion": 14,
        }
        for builder in builders:
            with self.subTest(builder=builder.__name__):
                points: list[str] = []
                old_visibility: list[int] = []

                def observe(point: str) -> None:
                    points.append(point)
                    if point == "before-commit":
                        with open_read_only_snapshot(scenario.path) as reader:
                            old_visibility.append(reader.execute(f"SELECT count(*) FROM {scenario.authority_table}").fetchone()[0])

                scenario = builder(observe)
                scenario.invoke()
                with open_read_only_snapshot(scenario.path) as reader:
                    new_visibility = reader.execute(f"SELECT count(*) FROM {scenario.authority_table}").fetchone()[0]
                self.assertEqual((old_visibility, new_visibility), ([0], 1))
                self.assertEqual(points[-1], "before-commit")
                self.assertEqual(len(points) - 1, expected_writes[builder.__name__])
                for point_name in points:
                    failed = builder(lambda point, expected=point_name: (_ for _ in ()).throw(InjectedFailure(point)) if point == expected else None)
                    with self.assertRaises(InjectedFailure):
                        failed.invoke()
                    with open_read_only_snapshot(failed.path) as reader:
                        self.assertEqual(reader.execute(f"SELECT count(*) FROM {failed.authority_table}").fetchone(), (0,))


if __name__ == "__main__":
    unittest.main()
