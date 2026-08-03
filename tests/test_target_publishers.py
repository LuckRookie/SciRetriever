# noqa: SIZE_OK - the failpoint matrix covers every publisher variant in one fixture suite
from __future__ import annotations

import unittest
from dataclasses import replace as dataclass_replace

from pydantic import BaseModel

from sciretriever.core import assets as core_assets
from sciretriever.core.collection import CollectionRuleError, validate_collection_acceptance
from sciretriever.core.execution import (
    ExecutionRejectedError,
    canonical_import_record_projection,
    canonical_target_projection,
    validate_content_acceptance_command,
    validate_import_acceptance_command,
)
from sciretriever.core.literature.acceptance import (
    CompletionRejectedError,
    validate_completion_submission_contract,
)
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.literature_store.sqlite import (
    CompletionPublisher,
    ContentAcceptancePublisher,
    StalePublicationError,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.assets import PrimaryPdfAcceptance
from sciretriever.model.collection import CollectionAcceptance
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.execution import ContentAcceptanceCommand, ImportAcceptanceCommand
from sciretriever.model.literature import CompletionSubmission
from sciretriever.model.primitives import (
    RelativeArtifactPath,
    Sha256,
    WorkId,
    WorkVersionId,
)
from tests.target_publisher_support import ScenarioFactory


def replace(value, **updates):
    if isinstance(value, BaseModel):
        return value.model_copy(update=updates)
    return dataclass_replace(value, **updates)


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
        with self.assertRaises(CollectionRuleError):
            validate_collection_acceptance(
                CollectionAcceptance(
                    bibliography=collection.command.bibliography,
                    membership=collection.command.membership.model_copy(
                        update={"work_id": other_work}
                    ),
                    causes=(),
                    paths=(),
                )
            )

        imported = self.factory.imported()
        assert isinstance(imported.command, ImportAcceptanceCommand)
        other_version = WorkVersionId("00000000-0000-0000-0000-000000000002")
        with self.assertRaises(ExecutionRejectedError):
            validate_import_acceptance_command(
                ImportAcceptanceCommand(
                    bibliography=imported.command.bibliography,
                    references=imported.command.references,
                    tags=imported.command.tags,
                    record=replace(imported.command.record, work_version_id=other_version),
                )
            )

        primary = self.factory.primary()
        assert isinstance(primary.command, ContentAcceptanceCommand)
        with self.assertRaises(ExecutionRejectedError):
            validate_content_acceptance_command(
                ContentAcceptanceCommand(
                    acceptance=primary.command.acceptance,
                    target=replace(primary.command.target, work_version_id=other_version),
                )
            )

        completion = self.factory.completion()
        assert isinstance(completion.command, CompletionSubmission)
        with self.assertRaises(CompletionRejectedError):
            validate_completion_submission_contract(
                replace(completion.command, work_version_id=other_version)
            )
        with self.assertRaises(CompletionRejectedError):
            validate_completion_submission_contract(
                replace(
                    completion.command,
                    references=replace(
                        completion.command.references, work_version_id=other_version
                    ),
                )
            )

    def test_adapters_defensively_reject_tampered_cross_identity_commands(self) -> None:
        other_work = WorkId("00000000-0000-0000-0000-000000000001")
        other_version = WorkVersionId("00000000-0000-0000-0000-000000000002")
        scenarios = (
            self.factory.collection(),
            self.factory.imported(),
            self.factory.primary(),
            self.factory.completion(),
        )
        collection = scenarios[0].command
        assert isinstance(collection, CollectionAcceptance)
        object.__setattr__(
            collection,
            "membership",
            collection.membership.model_copy(update={"work_id": other_work}),
        )
        imported = scenarios[1].command
        assert isinstance(imported, ImportAcceptanceCommand)
        object.__setattr__(
            imported, "record", replace(imported.record, work_version_id=other_version)
        )
        content = scenarios[2].command
        assert isinstance(content, ContentAcceptanceCommand)
        object.__setattr__(
            content, "target", replace(content.target, work_version_id=other_version)
        )
        completion = scenarios[3].command
        assert isinstance(completion, CompletionSubmission)
        object.__setattr__(completion, "work_version_id", other_version)
        for scenario in scenarios:
            with self.subTest(authority=scenario.authority_table):
                with self.assertRaises(StalePublicationError):
                    scenario.invoke()

    def test_asset_validation_precedes_execution_alignment(self) -> None:
        scenario = self.factory.primary()
        assert isinstance(scenario.command, ContentAcceptanceCommand)
        acceptance = scenario.command.acceptance
        assert isinstance(acceptance, PrimaryPdfAcceptance)
        invalid_artifact = acceptance.artifact.model_copy(
            update={"path": RelativeArtifactPath("primary/ff/" + "f" * 64)}
        )
        invalid_acceptance = acceptance.model_copy(update={"artifact": invalid_artifact})
        with self.assertRaises(core_assets.AssetRuleError):
            core_assets.validate_content_acceptance(invalid_acceptance)
        other_version = WorkVersionId("00000000-0000-0000-0000-000000000002")
        command = ContentAcceptanceCommand(
            acceptance=invalid_acceptance,
            target=replace(scenario.command.target, work_version_id=other_version),
        )
        with self.assertRaises(StalePublicationError) as raised:
            assert isinstance(scenario.publisher, ContentAcceptancePublisher)
            scenario.publisher.publish(command)
        self.assertIn("published artifact identity is inconsistent", str(raised.exception))

    def test_content_publisher_rejects_result_after_batch_terminalization(self) -> None:
        scenario = self.factory.primary()
        assert isinstance(scenario.command, ContentAcceptanceCommand)
        batch_run_id = str(scenario.command.target.batch_run_id)
        with create_or_open_catalog(scenario.path) as connection:
            before = connection.execute(
                "SELECT started,result_json FROM batch_targets WHERE batch_run_id=?",
                (batch_run_id,),
            ).fetchone()
            connection.execute("UPDATE batch_runs SET status='failed' WHERE id=?", (batch_run_id,))
            connection.commit()

        with self.assertRaises(StalePublicationError):
            scenario.invoke()

        with open_read_only_snapshot(scenario.path) as connection:
            accepted = connection.execute("SELECT COUNT(*) FROM accepted_primary_assets").fetchone()
            after = connection.execute(
                "SELECT started,result_json FROM batch_targets WHERE batch_run_id=?",
                (batch_run_id,),
            ).fetchone()
        self.assertEqual(accepted, (0,))
        self.assertEqual(after, before)

    def test_completion_publisher_rejects_result_after_batch_terminalization(self) -> None:
        scenario = self.factory.completion()
        assert scenario.target is not None
        batch_run_id = str(scenario.target.batch_run_id)
        with create_or_open_catalog(scenario.path) as connection:
            before = connection.execute(
                "SELECT started,result_json FROM batch_targets WHERE batch_run_id=?",
                (batch_run_id,),
            ).fetchone()
            connection.execute("UPDATE batch_runs SET status='failed' WHERE id=?", (batch_run_id,))
            connection.commit()

        with self.assertRaises(StalePublicationError):
            scenario.invoke()

        with open_read_only_snapshot(scenario.path) as connection:
            bundles = connection.execute("SELECT COUNT(*) FROM completion_bundles").fetchone()
            after = connection.execute(
                "SELECT started,result_json FROM batch_targets WHERE batch_run_id=?",
                (batch_run_id,),
            ).fetchone()
        self.assertEqual(bundles, (0,))
        self.assertEqual(after, before)

    def test_pairwise_result_enums_with_identical_details_persist_differently(self) -> None:
        details = CanonicalJsonObject((("reason", "same"),))
        cases = (
            (self.factory.primary, ("partially-advanced", "failed")),
            (self.factory.imported, ("created", "rejected")),
        )
        for builder, result_values in cases:
            stored: list[str] = []
            for result_value in result_values:
                scenario = builder()
                command = scenario.command
                if isinstance(command, ContentAcceptanceCommand):
                    command = replace(
                        command,
                        target=replace(
                            command.target,
                            result=command.target.result.model_copy(
                                update={"outcome": result_value}
                            ),
                            details=details,
                        ),
                    )
                else:
                    assert isinstance(command, ImportAcceptanceCommand)
                    command = replace(
                        command,
                        record=replace(
                            command.record,
                            result=command.record.result.model_copy(
                                update={"outcome": result_value}
                            ),
                            details=details,
                        ),
                    )
                replace(scenario, command=command).invoke()
                with open_read_only_snapshot(scenario.path) as reader:
                    stored.append(
                        reader.execute("SELECT result_json FROM batch_targets").fetchone()[0]
                    )
            with self.subTest(builder=builder.__name__):
                self.assertNotEqual(stored[0], stored[1])
                self.assertIn(f'"result":"{result_values[0]}"', stored[0])
                self.assertIn(f'"result":"{result_values[1]}"', stored[1])
                self.assertIn('"details":{"reason":"same"}', stored[0])

    def test_result_details_cannot_supply_a_second_discriminator(self) -> None:
        contradictory = CanonicalJsonObject((("result", "failed"),))
        primary = self.factory.primary()
        assert isinstance(primary.command, ContentAcceptanceCommand)
        with self.assertRaises(ExecutionRejectedError):
            canonical_target_projection(replace(primary.command.target, details=contradictory))
        imported = self.factory.imported()
        assert isinstance(imported.command, ImportAcceptanceCommand)
        with self.assertRaises(ExecutionRejectedError):
            canonical_import_record_projection(
                replace(imported.command.record, details=contradictory)
            )

    def test_owner_contracts_reject_false_structured_payload_identity(self) -> None:
        completion = self.factory.completion()
        assert isinstance(completion.command, CompletionSubmission)
        metadata = completion.command.metadata
        tampered = metadata.model_copy(update={"sha256": Sha256("0" * 64)})
        candidate = completion.command.model_copy(update={"metadata": tampered})
        assert isinstance(completion.publisher, CompletionPublisher)
        assert completion.target is not None
        with self.assertRaises(StalePublicationError):
            completion.publisher.publish_completion(candidate, completion.target)
        light = self.factory.light()
        assert isinstance(light.command, ContentAcceptanceCommand)
        accepted_light = light.command.acceptance
        assert isinstance(accepted_light, LightDocumentAcceptance)
        tampered_light = replace(
            accepted_light,
            document=CanonicalJsonObject((("tampered", True),)),
        )
        with self.assertRaises(StalePublicationError):
            assert isinstance(light.publisher, ContentAcceptancePublisher)
            light.publisher.publish(
                ContentAcceptanceCommand(
                    acceptance=tampered_light,
                    target=light.command.target,
                )
            )
        analysis = completion.command.analysis
        with self.assertRaises(CompletionRejectedError):
            validate_completion_submission_contract(
                completion.command.model_copy(
                    update={
                        "analysis": replace(
                            analysis, proposal=CanonicalJsonObject((("tampered", True),))
                        )
                    }
                )
            )
        with self.assertRaises(CompletionRejectedError):
            validate_completion_submission_contract(
                completion.command.model_copy(
                    update={"analysis": replace(analysis, artifact_size=analysis.artifact_size + 1)}
                )
            )
        with self.assertRaises(CompletionRejectedError):
            validate_completion_submission_contract(
                completion.command.model_copy(
                    update={"analysis": replace(analysis, artifact_sha256=Sha256("1" * 64))}
                )
            )

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
            with (
                self.subTest(authority=scenario.authority_table),
                self.assertRaises(StalePublicationError),
            ):
                scenario.invoke()

        result = self.factory.primary()
        assert isinstance(result.command, ContentAcceptanceCommand)
        object.__setattr__(
            result.command.target,
            "details",
            CanonicalJsonObject((("result", "failed"),)),
        )
        with self.assertRaises(StalePublicationError):
            result.invoke()

    def test_every_write_and_commit_failpoint_is_atomic_for_every_variant(self) -> None:
        builders = (
            self.factory.collection,
            self.factory.imported,
            self.factory.primary,
            self.factory.light,
            self.factory.completion,
        )
        expected_writes = {
            "collection": 10,
            "imported": 12,
            "primary": 6,
            "light": 7,
            "completion": 14,
        }
        for builder in builders:
            with self.subTest(builder=builder.__name__):
                points: list[str] = []
                old_visibility: list[int] = []

                def observe(point: str) -> None:
                    points.append(point)
                    if point == "before-commit":
                        with open_read_only_snapshot(scenario.path) as reader:
                            old_visibility.append(
                                reader.execute(
                                    f"SELECT count(*) FROM {scenario.authority_table}"
                                ).fetchone()[0]
                            )

                scenario = builder(observe)
                scenario.invoke()
                with open_read_only_snapshot(scenario.path) as reader:
                    new_visibility = reader.execute(
                        f"SELECT count(*) FROM {scenario.authority_table}"
                    ).fetchone()[0]
                self.assertEqual((old_visibility, new_visibility), ([0], 1))
                self.assertEqual(points[-1], "before-commit")
                self.assertEqual(len(points) - 1, expected_writes[builder.__name__])
                for point_name in points:
                    failed = builder(
                        lambda point, expected=point_name: (
                            (_ for _ in ()).throw(InjectedFailure(point))
                            if point == expected
                            else None
                        )
                    )
                    with self.assertRaises(InjectedFailure):
                        failed.invoke()
                    with open_read_only_snapshot(failed.path) as reader:
                        self.assertEqual(
                            reader.execute(
                                f"SELECT count(*) FROM {failed.authority_table}"
                            ).fetchone(),
                            (0,),
                        )


if __name__ == "__main__":
    unittest.main()
