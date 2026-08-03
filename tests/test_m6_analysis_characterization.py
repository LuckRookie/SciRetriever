from __future__ import annotations

import json
import unittest
from typing import Final

from target_analysis_support import (
    analysis_request,
    anthropic_adapter,
    complete_document,
    openai_adapter,
    proposal_value,
)
from target_completion_support import (
    PreparedCompletion,
    authority_snapshot,
    prepare_completion,
    publish_completion_submission,
)
from target_publisher_support import ScenarioFactory

from sciretriever.adapters.analysis import AnalysisAdapterError
from sciretriever.core.analysis import (
    AnalysisValidationError,
    analysis_bytes,
    analysis_json_schema,
    validate_analysis_text,
)
from sciretriever.core.literature.acceptance import CompletionRejectedError
from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.literature_store.sqlite import (
    CompletionPublisher,
    SqliteLiteratureRepository,
)
from sciretriever.model.analysis import AnalysisBounds
from sciretriever.model.literature import CompletionOutcome, CompletionSubmission
from sciretriever.model.primitives import Sha256
from sciretriever.services.literature.api import accept_completion

NINE_CATEGORIES: Final = frozenset(
    {
        "final_bibliography",
        "classification",
        "content_overview",
        "research_objectives",
        "methods",
        "key_results",
        "conclusions_and_limitations",
        "keywords_and_tags",
        "references",
    }
)


class InjectedFailure(RuntimeError):
    pass


class M6AnalysisCharacterizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    @staticmethod
    def _submission(prepared: PreparedCompletion) -> CompletionSubmission:
        return publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )

    def test_given_analysis_schema_when_reading_it_then_exact_nine_categories_are_closed(
        self,
    ) -> None:
        schema = analysis_json_schema()
        required = schema["required"]
        properties = schema["properties"]
        assert isinstance(required, list)
        assert isinstance(properties, dict)

        expected_fields = NINE_CATEGORIES | {"schema_version"}
        self.assertEqual(set(required), expected_fields)
        self.assertEqual(set(properties), expected_fields)
        self.assertFalse(schema["additionalProperties"])

        invalid = proposal_value()
        invalid["unexpected"] = "not-a-category"
        with self.assertRaisesRegex(AnalysisAdapterError, "analysis_invalid_output"):
            openai_adapter(invalid).analyze(analysis_request(complete_document()))

    def test_given_same_proposal_when_providers_return_then_canonical_bytes_and_neutral_result(
        self,
    ) -> None:
        openai_result = openai_adapter(proposal_value()).analyze(
            analysis_request(complete_document())
        )
        anthropic_result = anthropic_adapter(proposal_value()).analyze(
            analysis_request(complete_document())
        )

        self.assertEqual(openai_result.proposal, anthropic_result.proposal)
        self.assertEqual(
            analysis_bytes(openai_result.proposal), analysis_bytes(anthropic_result.proposal)
        )
        self.assertEqual(
            (openai_result.provenance.provider, anthropic_result.provenance.provider),
            ("openai", "anthropic"),
        )
        self.assertEqual(openai_result.provenance.model, anthropic_result.provenance.model)

    def test_given_evidence_outside_document_when_validating_text_then_alignment_is_rejected(
        self,
    ) -> None:
        invalid = proposal_value()
        overview = invalid["content_overview"]
        assert isinstance(overview, dict)
        summary = overview["summary"]
        assert isinstance(summary, dict)
        evidence = summary["evidence"]
        assert isinstance(evidence, list)
        locator = evidence[0]
        assert isinstance(locator, dict)
        locator["char_end"] = 6

        with self.assertRaises(AnalysisValidationError) as raised:
            validate_analysis_text(
                json.dumps(invalid),
                complete_document(),
                AnalysisBounds(max_input_characters=200_000, max_source_units=100),
            )

        self.assertEqual(raised.exception.code, "analysis_invalid_evidence")

    def test_given_changed_completion_input_when_accepting_then_input_alignment_is_rejected(
        self,
    ) -> None:
        prepared = prepare_completion(self.factory)
        submission = self._submission(prepared)
        invalid = submission.model_copy(update={"light_document_sha256": Sha256("9" * 64)})

        with self.assertRaisesRegex(CompletionRejectedError, "analysis artifact"):
            accept_completion(
                SqliteLiteratureRepository(prepared.path),
                prepared.publisher,
                invalid,
                prepared.target,
            )

    def test_given_valid_completion_when_published_twice_then_all_facts_publish_once_and_replay(
        self,
    ) -> None:
        prepared = prepare_completion(self.factory)
        submission = self._submission(prepared)

        first = accept_completion(
            SqliteLiteratureRepository(prepared.path),
            prepared.publisher,
            submission,
            prepared.target,
        )
        replay = accept_completion(
            SqliteLiteratureRepository(prepared.path),
            prepared.publisher,
            submission,
            prepared.target,
        )
        snapshot = authority_snapshot(
            prepared.path,
            str(prepared.context.work_version_id),
            str(prepared.target.batch_run_id),
        )

        self.assertEqual((first, replay), (CompletionOutcome.PUBLISHED, CompletionOutcome.REPLAYED))
        self.assertEqual(snapshot.state, (("completed",),))
        self.assertEqual(
            (
                len(snapshot.analyses),
                len(snapshot.metadata),
                len(snapshot.references),
                len(snapshot.tags),
                len(snapshot.bundles),
                len(snapshot.fts),
            ),
            (1, 2, 1, 1, 1, 3),
        )
        self.assertEqual(snapshot.target[0][0], 1)

    def test_given_commit_failure_when_publishing_then_authority_stays_old_and_retry_publishes(
        self,
    ) -> None:
        def fail_before_commit(point: str) -> None:
            if point == "before-commit":
                raise InjectedFailure(point)

        prepared = prepare_completion(self.factory, fail_before_commit)
        submission = self._submission(prepared)
        before = authority_snapshot(
            prepared.path,
            str(prepared.context.work_version_id),
            str(prepared.target.batch_run_id),
        )

        with self.assertRaises(InjectedFailure):
            accept_completion(
                SqliteLiteratureRepository(prepared.path),
                prepared.publisher,
                submission,
                prepared.target,
            )

        self.assertEqual(
            authority_snapshot(
                prepared.path,
                str(prepared.context.work_version_id),
                str(prepared.target.batch_run_id),
            ),
            before,
        )
        retry = accept_completion(
            SqliteLiteratureRepository(prepared.path),
            CompletionPublisher(prepared.path),
            submission,
            prepared.target,
        )
        self.assertEqual(retry, CompletionOutcome.PUBLISHED)


if __name__ == "__main__":
    unittest.main()
