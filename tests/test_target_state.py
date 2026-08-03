from __future__ import annotations

import os
import unittest
from dataclasses import replace as dataclass_replace
from itertools import product
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import BaseModel
from target_state_fixture import (
    ANALYSIS_ID,
    LIGHT_HASH,
    LIGHT_ID,
    METADATA_ID,
    PRIMARY_ID,
    VERSION_ID,
    FakeRepository,
    RecordingPublisher,
    facts,
    insert_completed,
    light_ready_facts,
    submission,
)

from sciretriever.core.literature.acceptance import (
    CompletionRejectedError,
    validate_completion_submission_contract,
)
from sciretriever.core.literature.state import derive_missing_step, derive_work_version_state
from sciretriever.infrastructure.storage.sqlite import (
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.model.execution import TargetProjection, TargetResult
from sciretriever.model.primitives import (
    BatchRunId,
    MissingStep,
    Sha256,
    WorkVersionState,
)
from sciretriever.services.literature.api import accept_completion


def replace(value, **updates):
    if isinstance(value, BaseModel):
        candidate = value.model_copy(update=updates)
        return type(value).model_validate(candidate.model_dump())
    return dataclass_replace(value, **updates)


def completion_target() -> TargetProjection:
    return TargetProjection(
        batch_run_id=BatchRunId("00000000-0000-0000-0000-000000000099"),
        work_version_id=VERSION_ID,
        result=TargetResult(
            subject_type="work-version",
            subject_id=str(VERSION_ID),
            outcome="completed",
            initial_state="light-text-ready",
            target_state="completed",
            final_state="completed",
            stage="completion",
            failure=None,
        ),
        details=CanonicalJsonObject(()),
        failure_stages_to_clear=("analysis", "feedback"),
    )


class TargetStateTests(unittest.TestCase):
    def test_exhaustive_authoritative_facts_derive_state_and_missing_step(self) -> None:
        base = facts()
        expected_missing = {
            WorkVersionState.UNREVIEWED: MissingStep.PRIMARY_PDF,
            WorkVersionState.ASSET_READY: MissingStep.LIGHT_DOCUMENT,
            WorkVersionState.LIGHT_TEXT_READY: MissingStep.COMPLETION,
            WorkVersionState.COMPLETED: None,
        }
        for (
            primary,
            light,
            light_aligned,
            bundle,
            analysis_aligned,
            references,
            tags,
            current_metadata,
            completion_metadata,
        ) in product((False, True), repeat=9):
            current = base.model_copy(
                update={
                    "metadata_snapshot_id": METADATA_ID if current_metadata else None,
                    "metadata_revision": 1 if current_metadata else None,
                    "metadata_sha256": Sha256("2" * 64) if current_metadata else None,
                    "accepted_primary_id": PRIMARY_ID if primary else None,
                    "current_light_document_id": LIGHT_ID if light else None,
                    "current_light_sha256": LIGHT_HASH if light else None,
                    "current_light_primary_id": PRIMARY_ID if light and light_aligned else None,
                    "current_light_complete": light,
                    "completion_light_document_id": LIGHT_ID if bundle else None,
                    "completion_analysis_artifact_id": ANALYSIS_ID if bundle else None,
                    "analysis_light_document_id": LIGHT_ID if bundle and analysis_aligned else None,
                    "analysis_input_sha256": LIGHT_HASH if bundle and analysis_aligned else None,
                    "analysis_nine_categories_complete": bundle,
                    "completion_metadata_snapshot_id": METADATA_ID
                    if bundle and completion_metadata
                    else None,
                    "completion_reference_set_id": "references" if bundle else None,
                    "completion_reference_set_complete": bundle and references,
                    "completion_tag_set_id": "tags" if bundle else None,
                    "completion_tag_set_complete": bundle and tags,
                }
            )
            state = derive_work_version_state(current)
            expected_state = WorkVersionState.UNREVIEWED
            if primary:
                expected_state = WorkVersionState.ASSET_READY
            if primary and light and light_aligned:
                expected_state = WorkVersionState.LIGHT_TEXT_READY
            if (
                primary
                and light
                and light_aligned
                and bundle
                and analysis_aligned
                and references
                and tags
                and current_metadata
                and completion_metadata
            ):
                expected_state = WorkVersionState.COMPLETED
            self.assertEqual(state, expected_state)
            self.assertEqual(derive_missing_step(current), expected_missing[state])

    def test_sql_view_matches_repository_facts_and_ignores_non_authoritative_rows(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-task12-") as directory:
            root = Path(directory)
            os.chmod(root, 0o700)
            catalog = root / "catalog.sqlite"
            with create_or_open_catalog(catalog) as connection:
                insert_completed(connection)
                expected = connection.execute(
                    "SELECT state,missing_step FROM work_version_state_view "
                    "WHERE work_version_id=?",
                    (str(VERSION_ID),),
                ).fetchone()
                for statement in (
                    "INSERT INTO batch_runs(id,batch_type,status,scope_json,counts_json) "
                    "VALUES ('batch','process','failed','{}','{}')",
                    f"INSERT INTO current_failures VALUES ('failure','work-version',"
                    f"'{VERSION_ID}','analysis','x','x','x',1,CURRENT_TIMESTAMP)",
                    f"INSERT INTO parser_attempts VALUES ('attempt','{VERSION_ID}',NULL,"
                    f"'parser','{'9' * 64}',CURRENT_TIMESTAMP)",
                    f"INSERT INTO metadata_fts VALUES ('{VERSION_ID}','noise')",
                ):
                    connection.execute(statement)
                actual = connection.execute(
                    "SELECT state,missing_step FROM work_version_state_view "
                    "WHERE work_version_id=?",
                    (str(VERSION_ID),),
                ).fetchone()
                completed_facts = SqliteLiteratureRepository(catalog).get_version_facts(VERSION_ID)
                self.assertIsNotNone(completed_facts)
                assert completed_facts is not None
                self.assertEqual(
                    derive_work_version_state(completed_facts), WorkVersionState.COMPLETED
                )
                transitions = (
                    ("DELETE FROM completion_bundles", WorkVersionState.LIGHT_TEXT_READY),
                    (
                        "DELETE FROM work_version_current_light_document",
                        WorkVersionState.ASSET_READY,
                    ),
                    ("DELETE FROM analysis_artifacts", WorkVersionState.ASSET_READY),
                    ("DELETE FROM light_documents", WorkVersionState.ASSET_READY),
                    ("DELETE FROM accepted_primary_assets", WorkVersionState.UNREVIEWED),
                )
                observed_states: list[WorkVersionState] = []
                for statement, expected_state in transitions:
                    connection.execute(statement)
                    connection.commit()
                    row = connection.execute(
                        "SELECT state FROM work_version_state_view WHERE work_version_id=?",
                        (str(VERSION_ID),),
                    ).fetchone()
                    self.assertEqual(row, (expected_state.value,))
                    current = SqliteLiteratureRepository(catalog).get_version_facts(VERSION_ID)
                    self.assertIsNotNone(current)
                    assert current is not None
                    observed_states.append(derive_work_version_state(current))
            self.assertEqual(actual, expected)
            self.assertEqual(observed_states, [item[1] for item in transitions])

    def test_sql_view_requires_explicit_current_metadata_pointer(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-task12-metadata-") as directory:
            root = Path(directory)
            os.chmod(root, 0o700)
            catalog = root / "catalog.sqlite"
            with create_or_open_catalog(catalog) as connection:
                insert_completed(connection)
                connection.execute("DROP TRIGGER trg_completed_current_metadata_delete")
                connection.execute(
                    "DELETE FROM work_version_current_metadata WHERE work_version_id=?",
                    (str(VERSION_ID),),
                )
                connection.commit()
                row = connection.execute(
                    "SELECT state,missing_step FROM work_version_state_view "
                    "WHERE work_version_id=?",
                    (str(VERSION_ID),),
                ).fetchone()
            current = facts().model_copy(
                update={
                    "metadata_snapshot_id": None,
                    "metadata_revision": None,
                    "metadata_sha256": None,
                }
            )
            self.assertEqual(
                row, (WorkVersionState.LIGHT_TEXT_READY.value, MissingStep.COMPLETION.value)
            )
            self.assertEqual(derive_work_version_state(current), WorkVersionState.LIGHT_TEXT_READY)

    def test_accept_completion_rejects_stale_or_incomplete_before_publisher(self) -> None:
        publisher = RecordingPublisher()
        invalid_input = replace(submission(), light_document_sha256=Sha256("9" * 64))
        with self.assertRaises(CompletionRejectedError):
            validate_completion_submission_contract(invalid_input)
        invalid = (
            replace(submission(), metadata=replace(submission().metadata, expected_revision=2)),
        )
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaises(CompletionRejectedError):
                accept_completion(
                    FakeRepository(light_ready_facts()), publisher, candidate, completion_target()
                )
        self.assertEqual(publisher.calls, [])
        self.assertEqual(
            accept_completion(
                FakeRepository(light_ready_facts()), publisher, submission(), completion_target()
            ),
            "published",
        )
        self.assertEqual(
            accept_completion(
                FakeRepository(facts()), publisher, submission(), completion_target()
            ),
            "published",
        )


if __name__ == "__main__":
    unittest.main()
