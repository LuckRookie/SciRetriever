from __future__ import annotations

import unittest

from pydantic import ValidationError

import sciretriever.model.report as report_module
from sciretriever.model.acquisition import (
    AcceptedManualPdf,
    Asset,
    AssetRole,
    LiteratureAsset,
)
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
from sciretriever.model.execution import BatchGoal
from sciretriever.model.primitives import (
    AssetId,
    DiscoveryRunId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import (
    AcceptedImportRecord,
    AcceptedManualPdfReportResult,
    BibliographyFormat,
    DatabaseCompletionReport,
    DiscoveryProviderReport,
    DiscoveryReport,
    ExportReport,
    FailedReportEnd,
    FinishedReportEnd,
    GoalReachedTarget,
    ImportReport,
    InterruptedReportEnd,
    ManualPdfReport,
    MetaLiteratureCompletionTarget,
    NeedsManualPdfTarget,
    RejectedImportRecord,
    RejectedManualPdfReportResult,
    StableFailure,
)

_ID = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_ID_4 = "423e4567-e89b-12d3-a456-426614174000"
_ID_5 = "523e4567-e89b-12d3-a456-426614174000"
_HASH = "a" * 64
_TIMESTAMP = UtcTimestamp("2026-08-10T12:34:56.123Z")


def _failure() -> StableFailure:
    return StableFailure(
        code="provider-unavailable",
        reason="The provider did not respond",
        action="Retry this operation",
        retryable=True,
    )


def _manual_pdf() -> AcceptedManualPdf:
    asset = Asset(
        asset_id=AssetId(_ID_3),
        sha256=Sha256(_HASH),
        size_bytes=12,
        media_type="application/pdf",
        path=RelativeArtifactPath("pdf/manual.pdf"),
    )
    relation = LiteratureAsset(
        literature_asset_id=LiteratureAssetId(_ID_4),
        literature_id=LiteratureId(_ID),
        asset_id=AssetId(_ID_3),
        role=AssetRole.PRIMARY_PDF,
        provenance=Provenance(
            provenance_id=ProvenanceId(_ID_5),
            source_kind=SourceKind.USER,
            source_name="manual-pdf",
            source_record_id=None,
            observed_at=_TIMESTAMP,
            input_sha256=Sha256(_HASH),
            parameters_sha256=None,
        ),
        source_url=None,
    )
    return AcceptedManualPdf(asset=asset, relation=relation)


class DiscoveryModelTests(unittest.TestCase):
    def test_topic_and_citation_inputs_are_bounded_and_closed(self) -> None:
        provider = ProviderDiscoveryLimit(provider_name=" crossref ", scan_limit=2)
        topic = TopicDiscoveryInput(
            kind="topic",
            query="  quantum materials  ",
            year_from=2020,
            year_to=2026,
            providers=(provider,),
        )
        self.assertEqual(topic.query, "quantum materials")
        self.assertEqual(topic.providers, (provider,))

        citation = CitationDiscoveryInput(
            kind="citation",
            seed_literature_ids=(LiteratureId(_ID), LiteratureId(_ID)),
            direction="both",
            max_depth=0,
            result_limit=10,
            providers=(provider,),
        )
        self.assertEqual(citation.seed_literature_ids, (LiteratureId(_ID),))

        for invalid in (
            {"kind": "topic", "query": " ", "providers": [provider]},
            {
                "kind": "topic",
                "query": "q",
                "year_from": 2027,
                "year_to": 2026,
                "providers": [provider],
            },
            {"kind": "topic", "query": "q", "providers": [provider, provider]},
            {
                "kind": "citation",
                "seed_literature_ids": [],
                "direction": "both",
                "max_depth": 0,
                "result_limit": 1,
                "providers": [provider],
            },
            {
                "kind": "citation",
                "seed_literature_ids": [LiteratureId(_ID)],
                "direction": "both",
                "max_depth": -1,
                "result_limit": 1,
                "providers": [provider],
            },
            {
                "kind": "citation",
                "seed_literature_ids": [LiteratureId(_ID)],
                "direction": "both",
                "max_depth": 0,
                "result_limit": 0,
                "providers": [provider],
            },
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValidationError):
                    (
                        TopicDiscoveryInput
                        if invalid["kind"] == "topic"
                        else CitationDiscoveryInput
                    ).model_validate(invalid)

        with self.assertRaises(ValidationError):
            ProviderDiscoveryLimit(provider_name="p", scan_limit=0)

    def test_discovery_run_source_result_and_causes_keep_only_target_facts(self) -> None:
        provider = ProviderDiscoveryLimit(provider_name="crossref", scan_limit=2)
        topic_input = TopicDiscoveryInput(kind="topic", query="q", providers=(provider,))
        run = DiscoveryRun(
            discovery_run_id=DiscoveryRunId(_ID),
            input=topic_input,
            status="RUNNING",
            started_at=_TIMESTAMP,
        )
        self.assertEqual(run.status, "RUNNING")
        source = DiscoverySourceResult(
            discovery_run_id=DiscoveryRunId(_ID),
            provider_name="crossref",
            outcome="FAILED",
            failure=_failure(),
        )
        self.assertEqual(source.failure, _failure())
        with self.assertRaises(ValidationError):
            DiscoverySourceResult(
                discovery_run_id=DiscoveryRunId(_ID),
                provider_name="crossref",
                outcome="EXHAUSTED",
                failure=_failure(),
            )

        topic_cause = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=DiscoveryRunId(_ID),
            meta_literature_id=MetaLiteratureId(_ID_2),
            metadata_observation_id=ObservationId(_ID_3),
        )
        citation_cause = CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=DiscoveryRunId(_ID),
            meta_literature_id=MetaLiteratureId(_ID_2),
            source_literature_id=LiteratureId(_ID),
            target_literature_id=LiteratureId(_ID_2),
            depth=1,
        )
        self.assertEqual(topic_cause.kind, "topic")
        self.assertEqual(citation_cause.depth, 1)
        with self.assertRaises(ValidationError):
            CitationDiscoveryCause(
                kind="citation",
                discovery_run_id=DiscoveryRunId(_ID),
                meta_literature_id=MetaLiteratureId(_ID_2),
                source_literature_id=LiteratureId(_ID),
                target_literature_id=LiteratureId(_ID),
                depth=1,
            )
        with self.assertRaises(ValidationError):
            CitationDiscoveryCause(
                kind="citation",
                discovery_run_id=DiscoveryRunId(_ID),
                meta_literature_id=MetaLiteratureId(_ID_2),
                source_literature_id=LiteratureId(_ID),
                target_literature_id=LiteratureId(_ID_2),
                depth=0,
            )

        result = DiscoveryResult(
            discovery_run_id=DiscoveryRunId(_ID),
            meta_literature_id=MetaLiteratureId(_ID_2),
        )
        self.assertEqual(result.meta_literature_id, MetaLiteratureId(_ID_2))

    def test_stable_failure_is_redacted_and_closed(self) -> None:
        failure = StableFailure(
            code="  timeout  ",
            reason="  Provider timed out  ",
            action="retry later",
            retryable=True,
        )
        self.assertEqual(failure.code, "timeout")
        for field, value in (
            ("reason", "https://example.test/private?token=SECRET"),
            ("reason", "Traceback (most recent call last): secret"),
            ("action", "token=SECRET"),
            ("reason", "/home/user/private.pdf"),
        ):
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValidationError) as caught:
                    StableFailure(
                        code=value if field == "code" else "x",
                        reason=value if field == "reason" else "safe",
                        action=value if field == "action" else "safe",
                        retryable=False,
                    )
                self.assertNotIn("SECRET", str(caught.exception))

        with self.assertRaises(ValidationError):
            StableFailure(code="x", reason="safe", action="safe", retryable=False, details={})  # type: ignore[call-arg]

    def test_reports_use_operation_specific_shapes_and_end_values(self) -> None:
        self.assertFalse(hasattr(report_module, "BatchGoal"))
        self.assertIs(
            DatabaseCompletionReport.model_fields["goal"].annotation,
            BatchGoal,
        )
        report = DiscoveryReport(
            kind="discovery",
            end=FinishedReportEnd(kind="finished"),
            discovery_run_id=DiscoveryRunId(_ID),
            run_status="PARTIAL",
            providers=(
                DiscoveryProviderReport(
                    provider_name="crossref",
                    raw_item_count=2,
                    accepted_observation_count=1,
                    outcome="EXHAUSTED",
                ),
                DiscoveryProviderReport(
                    provider_name="openalex",
                    raw_item_count=1,
                    accepted_observation_count=0,
                    outcome="FAILED",
                    failure=_failure(),
                ),
            ),
            discovery_result_count=1,
            new_meta_literature_count=1,
            new_literature_count=1,
            new_metadata_observation_count=1,
        )
        self.assertEqual(
            tuple(item.provider_name for item in report.providers),
            ("crossref", "openalex"),
        )
        with self.assertRaises(ValidationError):
            DiscoveryProviderReport(
                provider_name="crossref",
                raw_item_count=0,
                accepted_observation_count=0,
                outcome="FAILED",
            )

        target = MetaLiteratureCompletionTarget(
            kind="meta-literature",
            meta_literature_id=MetaLiteratureId(_ID_2),
        )
        completion = DatabaseCompletionReport(
            kind="database-completion",
            end=InterruptedReportEnd(kind="interrupted"),
            goal="CONTENT_READY",
            goal_reached=(GoalReachedTarget(target=target, literature_id=LiteratureId(_ID)),),
            needs_manual_pdf=(
                NeedsManualPdfTarget(
                    target=MetaLiteratureCompletionTarget(
                        kind="meta-literature", meta_literature_id=MetaLiteratureId(_ID_3)
                    ),
                    literature_ids=(LiteratureId(_ID_2),),
                ),
            ),
            failed=(),
            interrupted=(),
            not_started=(),
            no_usable_content_literature_ids=(LiteratureId(_ID), LiteratureId(_ID)),
        )
        self.assertEqual(completion.no_usable_content_literature_ids, (LiteratureId(_ID),))
        with self.assertRaises(ValidationError):
            DatabaseCompletionReport(
                kind="database-completion",
                end=InterruptedReportEnd(kind="interrupted"),
                goal="CONTENT_READY",
                goal_reached=(GoalReachedTarget(target=target, literature_id=LiteratureId(_ID)),),
                needs_manual_pdf=(
                    NeedsManualPdfTarget(target=target, literature_ids=(LiteratureId(_ID_2),)),
                ),
                failed=(),
                interrupted=(),
                not_started=(),
                no_usable_content_literature_ids=(),
            )

    def test_manual_pdf_result_must_match_finished_end(self) -> None:
        accepted = ManualPdfReport(
            kind="manual-pdf",
            end=FinishedReportEnd(kind="finished"),
            literature_id=LiteratureId(_ID),
            result=AcceptedManualPdfReportResult(kind="accepted", accepted=_manual_pdf()),
        )
        self.assertEqual(accepted.result.kind, "accepted")  # type: ignore[union-attr]
        rejected = ManualPdfReport(
            kind="manual-pdf",
            end=FinishedReportEnd(kind="finished"),
            literature_id=LiteratureId(_ID),
            result=RejectedManualPdfReportResult(kind="rejected", failure=_failure()),
        )
        self.assertEqual(rejected.result.kind, "rejected")  # type: ignore[union-attr]
        for end, result in (
            (FinishedReportEnd(kind="finished"), None),
            (InterruptedReportEnd(kind="interrupted"), accepted.result),
            (FailedReportEnd(kind="failed", failure=_failure()), accepted.result),
        ):
            with self.subTest(end=end, result=result):
                with self.assertRaises(ValidationError):
                    ManualPdfReport(
                        kind="manual-pdf",
                        end=end,
                        literature_id=LiteratureId(_ID),
                        result=result,
                    )

    def test_import_partitions_indexes_and_accepted_ids(self) -> None:
        accepted = AcceptedImportRecord(
            kind="accepted",
            record_index=0,
            outcome="created",
            meta_literature_id=MetaLiteratureId(_ID_2),
            literature_id=LiteratureId(_ID),
        )
        report = ImportReport(
            kind="import",
            end=InterruptedReportEnd(kind="interrupted"),
            format=BibliographyFormat.BIBTEX,
            input_record_count=2,
            records=(accepted,),
            not_processed_record_indexes=(1,),
            accepted_meta_literature_ids=(MetaLiteratureId(_ID_2), MetaLiteratureId(_ID_2)),
        )
        self.assertEqual(report.accepted_meta_literature_ids, (MetaLiteratureId(_ID_2),))
        with self.assertRaises(ValidationError):
            ImportReport(
                kind="import",
                end=FinishedReportEnd(kind="finished"),
                format=BibliographyFormat.BIBTEX,
                input_record_count=2,
                records=(accepted,),
                not_processed_record_indexes=(1,),
                accepted_meta_literature_ids=(MetaLiteratureId(_ID_3),),
            )
        with self.assertRaises(ValidationError):
            ImportReport(
                kind="import",
                end=FinishedReportEnd(kind="finished"),
                format=BibliographyFormat.BIBTEX,
                input_record_count=2,
                records=(),
                not_processed_record_indexes=(0,),
                accepted_meta_literature_ids=(),
            )
        rejected = RejectedImportRecord(
            kind="rejected",
            record_index=1,
            failure=_failure(),
        )
        interrupted = ImportReport(
            kind="import",
            end=InterruptedReportEnd(kind="interrupted"),
            format=BibliographyFormat.RIS,
            input_record_count=2,
            records=(accepted, rejected),
            not_processed_record_indexes=(),
            accepted_meta_literature_ids=(MetaLiteratureId(_ID_2),),
        )
        self.assertEqual(len(interrupted.records), 2)

    def test_export_partitions_and_atomic_publication_fields(self) -> None:
        export = ExportReport(
            kind="export",
            end=FinishedReportEnd(kind="finished"),
            format=BibliographyFormat.CSL_JSON,
            selected_literature_ids=(LiteratureId(_ID), LiteratureId(_ID)),
            published_literature_ids=(LiteratureId(_ID),),
            skipped=(),
            not_published_literature_ids=(),
            omissions=(),
            bytes_written=10,
        )
        self.assertEqual(export.selected_literature_ids, (LiteratureId(_ID),))
        for overrides in (
            {"end": InterruptedReportEnd(kind="interrupted"), "bytes_written": 10},
            {
                "end": FailedReportEnd(kind="failed", failure=_failure()),
                "published_literature_ids": (LiteratureId(_ID),),
                "bytes_written": None,
            },
            {
                "published_literature_ids": (),
                "not_published_literature_ids": (),
                "bytes_written": 10,
            },
        ):
            values: dict[str, object] = {
                "kind": "export",
                "end": FinishedReportEnd(kind="finished"),
                "format": "bibtex",
                "selected_literature_ids": (LiteratureId(_ID),),
                "published_literature_ids": (LiteratureId(_ID),),
                "skipped": (),
                "not_published_literature_ids": (),
                "omissions": (),
                "bytes_written": 10,
            }
            values.update(overrides)
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValidationError):
                    ExportReport.model_validate(values)

    def test_models_are_frozen_and_reject_unknown_operational_fields(self) -> None:
        provider = ProviderDiscoveryLimit(provider_name="p", scan_limit=1)
        with self.assertRaises(ValidationError):
            TopicDiscoveryInput(kind="topic", query="q", providers=(provider,), cursor="x")  # type: ignore[call-arg]
        with self.assertRaises(ValidationError):
            DiscoveryRun.model_validate(
                {
                    "discovery_run_id": DiscoveryRunId(_ID),
                    "input": TopicDiscoveryInput(kind="topic", query="q", providers=(provider,)),
                    "status": "RUNNING",
                    "started_at": _TIMESTAMP,
                    "finished_at": _TIMESTAMP,
                }
            )
        run = DiscoveryRun(
            discovery_run_id=DiscoveryRunId(_ID),
            input=TopicDiscoveryInput(kind="topic", query="q", providers=(provider,)),
            status="RUNNING",
            started_at=_TIMESTAMP,
        )
        with self.assertRaises(ValidationError):
            run.status = "FAILED"  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
