from __future__ import annotations

import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from io import BytesIO
from typing import BinaryIO
from unittest.mock import patch

from sciretriever.acquisition.access_profiles import (
    PolicyEvidence,
    ProfileProductionStatus,
    PublisherAccessEvidence,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
)
from sciretriever.acquisition.api import CohortPreparationItem
from sciretriever.acquisition.browser_admission import (
    BrowserAdmissionConfiguration,
    BrowserAdmissionController,
    BrowserGroupAdmissionState,
    BrowserGroupReadiness,
)
from sciretriever.acquisition.cohort import (
    AcquisitionProgressPhase,
    AcquisitionProgressSnapshot,
    AcquisitionWorkItem,
    TieredCohortExecutor,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import (
    AcquisitionPlanBuilder,
    ProgressiveAcquisitionPlanner,
    PublisherAccessResolver,
    RouteCapability,
    RouteReadiness,
    RouteSpec,
)
from sciretriever.acquisition.ports import (
    AcquisitionExhaustionPublicationCommand,
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionRequest,
    AcquisitionSourceFailure,
    CancellationEvent,
    PrimaryPdfPreparation,
    TemporaryPdf,
)
from sciretriever.acquisition.routes import (
    AcquisitionRouteRegistry,
    RouteAdapterBinding,
    RouteExecutionContext,
)
from sciretriever.acquisition.tiered_service import TieredAcquisitionService
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionPath,
    Asset,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
    NoPrimaryPdf,
    PdfCandidate,
)
from sciretriever.model.literature import Literature, LiteratureStatus, VersionRole
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.network.browser_scheduler import (
    BrowserGroupPolicy,
    BrowserGroupScheduler,
    BrowserSchedulerCancellation,
)

_TIME = UtcTimestamp("2026-08-15T00:00:00Z")
_HASH = Sha256("a" * 64)


class _AdvancingBrowserClock:
    def __init__(self) -> None:
        self.current = 0.0

    def now(self) -> float:
        return self.current

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        del cancel_event
        self.current = max(self.current, deadline)


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _request(
    *,
    index: int = 1,
    resolved_landing_origin: str | None = None,
) -> AcquisitionRequest:
    literature = Literature(
        literature_id=LiteratureId(_id(index)),
        meta_literature_id=MetaLiteratureId(_id(index + 1)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(title="A tiered acquisition fixture"),
        status=LiteratureStatus.UNREVIEWED,
    )
    return AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
        resolved_landing_origin=resolved_landing_origin,
    )


class _TemporaryContent:
    def __init__(self) -> None:
        self.discard_count = 0

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        stream = BytesIO(b"%PDF-tiered-fixture")
        try:
            yield stream
        finally:
            stream.close()

    def discard(self) -> None:
        self.discard_count += 1


def _temporary(index: int, key: str) -> TemporaryPdf:
    return TemporaryPdf(
        candidate=PdfCandidate(
            candidate_key=key,
            source_name="fixture",
            acquisition_path=AcquisitionPath.PUBLIC,
            declared_media_type="application/pdf",
        ),
        content=_TemporaryContent(),
        safe_source_url=f"https://fixture.invalid/{index}.pdf",
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 100)),
            source_kind=SourceKind.ASSET_PROVIDER,
            source_name="fixture",
            source_record_id=key,
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
    )


class _Prepared:
    def __init__(self, request: AcquisitionRequest, temporary_pdf: TemporaryPdf) -> None:
        self.request = request
        self.temporary_pdf = temporary_pdf
        self.discard_count = 0
        self.discard_error: BaseException | None = None

    def discard(self) -> None:
        self.discard_count += 1
        if self.discard_error is not None:
            raise self.discard_error


class _PublicationPort:
    def __init__(self, accepted_key: str | None) -> None:
        self.accepted_key = accepted_key
        self.prepared_values: list[_Prepared] = []
        self.seen_keys: list[str] = []
        self.committed_values: list[_Prepared] = []

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PrimaryPdfPreparation | None:
        del cancel_event
        key = temporary_pdf.candidate.candidate_key
        self.seen_keys.append(key)
        if key != self.accepted_key:
            return None
        prepared = _Prepared(request, temporary_pdf)
        self.prepared_values.append(prepared)
        return prepared

    def commit_primary_pdf(self, prepared: PrimaryPdfPreparation) -> AcquiredPrimaryPdf:
        if not isinstance(prepared, _Prepared):
            raise AssertionError("unexpected prepared value")
        self.committed_values.append(prepared)
        request = prepared.request
        temporary_pdf = prepared.temporary_pdf
        asset = Asset(
            asset_id=AssetId(_id(500)),
            sha256=_HASH,
            size_bytes=20,
            media_type="application/pdf",
            path=RelativeArtifactPath("assets/tiered-fixture.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_id(501)),
            literature_id=request.literature.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=temporary_pdf.provenance,
            source_url=temporary_pdf.safe_source_url,
        )
        return AcquiredPrimaryPdf(
            asset=asset,
            relation=relation,
            candidate_key=temporary_pdf.candidate.candidate_key,
        )


class _ExhaustionPort:
    def __init__(self) -> None:
        self.commands: list[AcquisitionExhaustionPublicationCommand] = []

    def publish_exhaustion(
        self,
        command: AcquisitionExhaustionPublicationCommand,
    ) -> AutomaticPdfAcquisitionExhaustion:
        self.commands.append(command)
        return AutomaticPdfAcquisitionExhaustion(literature_id=command.expected_facts.literature_id)


class _ExhaustionClearPort:
    def __init__(self) -> None:
        self.expected_facts: list[AcquisitionExpectedFacts] = []

    def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None:
        self.expected_facts.append(expected_facts)


class _ResultIterator:
    def __init__(
        self,
        results: tuple[RouteExecutionResult, ...],
        *,
        fail_close: bool,
    ) -> None:
        self._results = iter(results)
        self._fail_close = fail_close
        self.close_count = 0

    def __iter__(self) -> _ResultIterator:
        return self

    def __next__(self) -> RouteExecutionResult:
        return next(self._results)

    def close(self) -> None:
        self.close_count += 1
        if self._fail_close:
            raise RuntimeError("fixture close failure")


class _RouteAdapter:
    source_name = "fixture"
    acquisition_path = AcquisitionPath.PUBLIC
    route_key = "public:fixture"

    def __init__(
        self,
        temporary_pdfs: tuple[TemporaryPdf, ...],
        *,
        fail_close: bool = False,
    ) -> None:
        self._temporary_pdfs = temporary_pdfs
        self._fail_close = fail_close
        self.iterators: list[_ResultIterator] = []

    def execute(self, context: RouteExecutionContext) -> _ResultIterator:
        results = tuple(
            RouteExecutionResult.delivered(temporary_pdf)
            for temporary_pdf in self._temporary_pdfs
            if context.candidate_keys.claim(temporary_pdf.candidate.candidate_key)
        )
        iterator = _ResultIterator(results, fail_close=self._fail_close)
        self.iterators.append(iterator)
        return iterator


class _FailureMatrixRouteAdapter:
    source_name = "fixture"

    def __init__(
        self,
        *,
        route_key: str,
        acquisition_path: AcquisitionPath,
        trace: list[str],
        failure: StableFailure | None = None,
    ) -> None:
        self.route_key = route_key
        self.acquisition_path = acquisition_path
        self._trace = trace
        self._failure = failure

    def execute(
        self,
        context: RouteExecutionContext,
    ) -> tuple[RouteExecutionResult, ...]:
        del context
        self._trace.append(self.route_key)
        if self._failure is not None:
            raise AcquisitionSourceFailure(self._failure)
        return (RouteExecutionResult.normal_miss(),)


def _service(
    adapter: _RouteAdapter,
    publication: _PublicationPort,
    exhaustion: _ExhaustionPort,
) -> TieredAcquisitionService:
    catalog = PublisherAccessProfileCatalog(())
    route = RouteSpec(
        route_key=adapter.route_key,
        tier=AcquisitionPath.PUBLIC,
        capability=RouteCapability.DIRECT_PDF,
        readiness=RouteReadiness.READY,
    )
    registry = AcquisitionRouteRegistry(
        profile_catalog=catalog,
        bindings=(RouteAdapterBinding(spec=route, adapter=adapter),),
    )
    planner = ProgressiveAcquisitionPlanner(
        resolver=PublisherAccessResolver(catalog),
        builder=AcquisitionPlanBuilder(catalog),
        route_specs=registry.route_specs,
        doi_landing_resolver=None,
    )
    return TieredAcquisitionService(
        route_registry=registry,
        planner=planner,
        publication_port=publication,
        exhaustion_port=exhaustion,
        exhaustion_clear_port=_ExhaustionClearPort(),
    )


def _failure_matrix_service(
    failure: StableFailure,
    trace: list[str],
    exhaustion: _ExhaustionPort,
) -> TieredAcquisitionService:
    profile = PublisherAccessProfile(
        access_key="fixture-publisher",
        platform_key="fixture-platform",
        landing_origins=("https://publisher.test",),
        asset_origins=("https://publisher.test",),
        stable_locator_namespaces=(),
        provider_record_names=(),
        weak_doi_prefixes=(),
        weak_publisher_names=(),
        public_route_keys=("public:fixture",),
        api_route_keys=("api:fixture",),
        browser_route_key="browser:fixture",
        browser_allowed_origins=("https://publisher.test",),
        browser_rate_limit_group="fixture-publisher",
        browser_session_key="fixture-publisher",
        browser_rule_id="fixture-publisher",
        browser_rule_revision=1,
        policy_evidence=PolicyEvidence.PROJECT_CONSERVATIVE,
        policy_revision="2026-08-15",
        production_status=ProfileProductionStatus.FIXTURE_VERIFIED,
        evidence=PublisherAccessEvidence(
            display_name="Fixture Publisher",
            product_name="Fixture access platform",
            official_references=("https://publisher.test/docs",),
            access_terms_references=("https://publisher.test/terms",),
            rate_limit_references=("https://publisher.test/rate-limits",),
            verification_date=date(2026, 8, 15),
            evidence_revision="fixture-publisher-v1",
            notes_reference="docs/notes/providers/wiley.md",
            fixture_reference="tests/fixtures/acquisition/profiles/fixture-publisher.json",
        ),
        browser_policy=BrowserGroupPolicy(
            rate_limit_group="fixture-publisher",
            policy_revision="2026-08-15",
            minimum_start_interval=1.0,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=3,
        ),
    )
    catalog = PublisherAccessProfileCatalog((profile,))
    adapters = (
        _FailureMatrixRouteAdapter(
            route_key="public:fixture",
            acquisition_path=AcquisitionPath.PUBLIC,
            trace=trace,
        ),
        _FailureMatrixRouteAdapter(
            route_key="api:fixture",
            acquisition_path=AcquisitionPath.AUTHORIZED_PROVIDER_API,
            trace=trace,
            failure=failure,
        ),
        _FailureMatrixRouteAdapter(
            route_key="browser:fixture",
            acquisition_path=AcquisitionPath.CONTROLLED_BROWSER,
            trace=trace,
        ),
    )
    routes = (
        RouteSpec(
            route_key="public:fixture",
            tier=AcquisitionPath.PUBLIC,
            capability=RouteCapability.DIRECT_PDF,
            readiness=RouteReadiness.READY,
        ),
        RouteSpec(
            route_key="api:fixture",
            tier=AcquisitionPath.AUTHORIZED_PROVIDER_API,
            capability=RouteCapability.DIRECT_PDF,
            readiness=RouteReadiness.READY,
            profile_access_key="fixture-publisher",
            quota_group="fixture-api",
        ),
        RouteSpec(
            route_key="browser:fixture",
            tier=AcquisitionPath.CONTROLLED_BROWSER,
            capability=RouteCapability.BROWSER_PDF,
            readiness=RouteReadiness.READY,
            profile_access_key="fixture-publisher",
            risk_group="fixture-publisher",
        ),
    )
    registry = AcquisitionRouteRegistry(
        profile_catalog=catalog,
        bindings=tuple(
            RouteAdapterBinding(spec=route, adapter=adapter)
            for route, adapter in zip(routes, adapters, strict=True)
        ),
    )
    planner = ProgressiveAcquisitionPlanner(
        resolver=PublisherAccessResolver(catalog),
        builder=AcquisitionPlanBuilder(catalog),
        route_specs=registry.route_specs,
        doi_landing_resolver=None,
    )
    return TieredAcquisitionService(
        route_registry=registry,
        planner=planner,
        publication_port=_PublicationPort(None),
        exhaustion_port=exhaustion,
        exhaustion_clear_port=_ExhaustionClearPort(),
        cohort_executor=TieredCohortExecutor(
            browser_scheduler=BrowserGroupScheduler(
                clock=_AdvancingBrowserClock(),
                max_concurrency=4,
            ),
            browser_admission=BrowserAdmissionController(
                BrowserAdmissionConfiguration(
                    explicitly_enabled=True,
                    execution_confirmed=True,
                    runtime_ready=True,
                    groups=(
                        BrowserGroupAdmissionState(
                            policy=BrowserGroupPolicy(
                                rate_limit_group="fixture-publisher",
                                policy_revision="fixture-v1",
                                minimum_start_interval=0.0,
                                rate_limit_cooldown=60.0,
                                runtime_failure_threshold=3,
                            ),
                            session_key="fixture-publisher",
                            readiness=BrowserGroupReadiness.READY,
                        ),
                    ),
                )
            ),
        ),
    )


def _discard_count(temporary_pdf: TemporaryPdf) -> int:
    content = temporary_pdf.content
    if not isinstance(content, _TemporaryContent):
        raise AssertionError("fixture content type changed")
    return content.discard_count


class TieredAcquisitionServiceTests(unittest.TestCase):
    def test_cohort_observer_receives_the_same_public_receipt_before_return(self) -> None:
        accepted = _temporary(1, "fixture:accepted")
        publication = _PublicationPort("fixture:accepted")
        service = _service(_RouteAdapter((accepted,)), publication, _ExhaustionPort())
        observed = []

        cohort = service.prepare_primary_pdf_cohort(
            (_request(),),
            on_prepared=lambda items: observed.extend(items),
        )

        self.assertEqual(observed, [cohort.items[0]])
        receipt = cohort.items[0].prepared
        self.assertIsNotNone(receipt)
        if receipt is None:
            self.fail("public terminal item did not expose its receipt")
        self.assertIsInstance(service.commit_primary_pdf(receipt), AcquiredPrimaryPdf)

    def test_cohort_observer_error_discards_every_new_receipt(self) -> None:
        accepted = _temporary(1, "fixture:accepted")
        publication = _PublicationPort("fixture:accepted")
        service = _service(_RouteAdapter((accepted,)), publication, _ExhaustionPort())
        observer_error = RuntimeError("fixture observer failure")

        def reject(_items: object) -> None:
            raise observer_error

        with self.assertRaises(RuntimeError) as raised:
            service.prepare_primary_pdf_cohort(
                (_request(index=1), _request(index=10)),
                on_prepared=reject,
            )

        self.assertIs(raised.exception, observer_error)
        self.assertEqual(
            tuple(prepared.discard_count for prepared in publication.prepared_values),
            (1, 1),
        )

    def test_progress_and_escalation_observers_run_before_browser_adapter(self) -> None:
        trace: list[str] = []
        exhaustion = _ExhaustionPort()
        service = _failure_matrix_service(
            StableFailure(
                code="acquisition-authorized-entitlement",
                reason="The fixture API does not grant this article entitlement.",
                action="Continue only through explicitly enabled institutional access.",
                retryable=False,
            ),
            trace,
            exhaustion,
        )
        progress: list[AcquisitionProgressSnapshot] = []

        def observe_progress(snapshot: AcquisitionProgressSnapshot) -> None:
            progress.append(snapshot)
            trace.append(f"progress:{snapshot.tier.value}:{snapshot.phase.value}")

        def observe_escalation(summary: object) -> None:
            trace.append("browser-summary")
            self.assertNotIn("browser:fixture", trace)
            self.assertEqual(len(getattr(summary, "groups")), 1)

        cohort = service.prepare_primary_pdf_cohort(
            (_request(resolved_landing_origin="https://publisher.test"),),
            on_progress=observe_progress,
            on_browser_escalation=observe_escalation,
        )

        self.assertEqual(
            trace,
            [
                "progress:public:started",
                "public:fixture",
                "progress:public:finished",
                "progress:authorized-provider-api:started",
                "api:fixture",
                "progress:authorized-provider-api:finished",
                "browser-summary",
                "progress:controlled-browser:started",
                "browser:fixture",
                "progress:controlled-browser:finished",
            ],
        )
        self.assertEqual(
            tuple(snapshot.phase for snapshot in progress),
            (
                AcquisitionProgressPhase.STARTED,
                AcquisitionProgressPhase.FINISHED,
            )
            * 3,
        )
        receipt = cohort.items[0].prepared
        self.assertIsNotNone(receipt)
        assert receipt is not None
        self.assertIsInstance(service.commit_primary_pdf(receipt), NoPrimaryPdf)

    def test_escalation_observer_failure_prevents_browser_adapter_io(self) -> None:
        trace: list[str] = []
        service = _failure_matrix_service(
            StableFailure(
                code="acquisition-authorized-entitlement",
                reason="The fixture API does not grant this article entitlement.",
                action="Continue only through explicitly enabled institutional access.",
                retryable=False,
            ),
            trace,
            _ExhaustionPort(),
        )
        observer_error = RuntimeError("fixture Browser summary observer failed")

        def reject(_summary: object) -> None:
            raise observer_error

        with self.assertRaises(RuntimeError) as raised:
            service.prepare_primary_pdf_cohort(
                (_request(resolved_landing_origin="https://publisher.test"),),
                on_browser_escalation=reject,
            )

        self.assertIs(raised.exception, observer_error)
        self.assertEqual(trace, ["public:fixture", "api:fixture"])

    def test_cohort_observer_cleanup_error_wins_after_all_receipts_are_attempted(
        self,
    ) -> None:
        accepted = _temporary(1, "fixture:accepted")
        publication = _PublicationPort("fixture:accepted")
        service = _service(_RouteAdapter((accepted,)), publication, _ExhaustionPort())
        observer_error = RuntimeError("fixture observer failure")
        cleanup_error = AssertionError("fixture receipt cleanup failure")

        def reject(_items: object) -> None:
            publication.prepared_values[0].discard_error = cleanup_error
            raise observer_error

        with self.assertRaises(AcquisitionFailure) as raised:
            service.prepare_primary_pdf_cohort(
                (_request(index=1), _request(index=10)),
                on_prepared=reject,
            )

        self.assertEqual(
            raised.exception.failure.code,
            "acquisition-temporary-cleanup-failed",
        )
        self.assertEqual(
            tuple(prepared.discard_count for prepared in publication.prepared_values),
            (1, 1),
        )

    def test_partial_final_cohort_construction_discards_every_preparation(self) -> None:
        accepted = _temporary(1, "fixture:accepted")
        publication = _PublicationPort("fixture:accepted")
        service = _service(_RouteAdapter((accepted,)), publication, _ExhaustionPort())
        construction_error = RuntimeError("fixture final cohort construction failure")
        original_prepare = (
            TieredAcquisitionService._prepare_cohort_item  # pyright: ignore[reportPrivateUsage]
        )
        call_count = 0

        def fail_second_item(
            current_service: TieredAcquisitionService,
            item: AcquisitionWorkItem,
            frozen: object,
        ) -> CohortPreparationItem:
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise construction_error
            return original_prepare(
                current_service,
                item,
                frozen,
            )

        with (
            patch.object(
                TieredAcquisitionService,
                "_prepare_cohort_item",
                new=fail_second_item,
            ),
            self.assertRaises(RuntimeError) as raised,
        ):
            service.prepare_primary_pdf_cohort(
                (_request(index=1), _request(index=10)),
            )

        self.assertIs(raised.exception, construction_error)
        self.assertEqual(
            tuple(prepared.discard_count for prepared in publication.prepared_values),
            (1, 1),
        )

    def test_rejected_candidate_is_cleaned_and_the_route_continues(self) -> None:
        rejected = _temporary(1, "fixture:rejected")
        accepted = _temporary(2, "fixture:accepted")
        adapter = _RouteAdapter((rejected, accepted))
        publication = _PublicationPort("fixture:accepted")
        exhaustion = _ExhaustionPort()
        service = _service(adapter, publication, exhaustion)

        receipt = service.prepare_primary_pdf(_request())
        result = service.commit_primary_pdf(receipt)

        self.assertIsInstance(result, AcquiredPrimaryPdf)
        assert isinstance(result, AcquiredPrimaryPdf)
        self.assertEqual(result.candidate_key, "fixture:accepted")
        self.assertEqual(publication.seen_keys, ["fixture:rejected", "fixture:accepted"])
        self.assertEqual(_discard_count(rejected), 1)
        self.assertEqual(_discard_count(accepted), 1)
        self.assertEqual(publication.prepared_values[0].discard_count, 1)
        self.assertEqual(adapter.iterators[0].close_count, 1)
        self.assertEqual(exhaustion.commands, [])

    def test_normal_miss_prepares_exhaustion_only_at_the_commit_boundary(self) -> None:
        rejected = _temporary(1, "fixture:rejected")
        adapter = _RouteAdapter((rejected,))
        publication = _PublicationPort(None)
        exhaustion = _ExhaustionPort()
        service = _service(adapter, publication, exhaustion)

        receipt = service.prepare_primary_pdf(_request())

        self.assertEqual(exhaustion.commands, [])
        self.assertIsInstance(service.commit_primary_pdf(receipt), NoPrimaryPdf)
        self.assertEqual(len(exhaustion.commands), 1)
        self.assertEqual(_discard_count(rejected), 1)

    def test_iterator_close_failure_discards_an_already_prepared_candidate(self) -> None:
        accepted = _temporary(1, "fixture:accepted")
        adapter = _RouteAdapter((accepted,), fail_close=True)
        publication = _PublicationPort("fixture:accepted")
        exhaustion = _ExhaustionPort()
        service = _service(adapter, publication, exhaustion)

        with self.assertRaises(AcquisitionFailure) as raised:
            service.prepare_primary_pdf(_request())

        self.assertEqual(raised.exception.failure.code, "acquisition-temporary-cleanup-failed")
        self.assertEqual(_discard_count(accepted), 1)
        self.assertEqual(publication.prepared_values[0].discard_count, 1)
        self.assertEqual(adapter.iterators[0].close_count, 1)
        self.assertEqual(exhaustion.commands, [])

    def test_receipt_is_single_use_and_discard_after_commit_is_idempotent(self) -> None:
        accepted = _temporary(1, "fixture:accepted")
        publication = _PublicationPort("fixture:accepted")
        service = _service(_RouteAdapter((accepted,)), publication, _ExhaustionPort())
        receipt = service.prepare_primary_pdf(_request())

        service.commit_primary_pdf(receipt)
        service.discard_prepared(receipt)

        self.assertEqual(publication.prepared_values[0].discard_count, 1)
        with self.assertRaises(AcquisitionFailure) as raised:
            service.commit_primary_pdf(receipt)
        self.assertEqual(raised.exception.failure.code, "acquisition-port-contract")

    def test_post_commit_receipt_cleanup_failure_never_publishes_exhaustion(self) -> None:
        accepted = _temporary(1, "fixture:accepted")
        publication = _PublicationPort("fixture:accepted")
        exhaustion = _ExhaustionPort()
        service = _service(_RouteAdapter((accepted,)), publication, exhaustion)
        receipt = service.prepare_primary_pdf(_request())
        publication.prepared_values[0].discard_error = RuntimeError(
            "post-commit receipt cleanup sentinel"
        )

        with self.assertRaises(AcquisitionFailure) as raised:
            service.commit_primary_pdf(receipt)

        self.assertEqual(raised.exception.failure.code, "acquisition-temporary-cleanup-failed")
        self.assertEqual(publication.committed_values, publication.prepared_values)
        self.assertEqual(publication.prepared_values[0].discard_count, 1)
        self.assertEqual(exhaustion.commands, [])

    def test_debug_logging_covers_validation_publication_and_resource_cleanup(self) -> None:
        accepted = _temporary(1, "fixture:accepted")
        publication = _PublicationPort("fixture:accepted")
        service = _service(
            _RouteAdapter((accepted,)),
            publication,
            _ExhaustionPort(),
        )

        with self.assertLogs(
            "sciretriever.acquisition.tiered_service",
            level="DEBUG",
        ) as captured:
            receipt = service.prepare_primary_pdf(_request())
            service.commit_primary_pdf(receipt)

        output = "\n".join(captured.output)
        self.assertIn("event=acquisition-pdf-validation-started", output)
        self.assertIn("event=acquisition-pdf-validation-finished", output)
        self.assertIn("resource=temporary-pdf", output)
        self.assertIn("resource=route-iterator", output)
        self.assertIn("resource=prepared-pdf", output)
        self.assertIn("outcome=primary-pdf-committed", output)
        self.assertIn("candidate_id=sha256:", output)
        self.assertNotIn("fixture:accepted", output)
        self.assertNotIn("%PDF-tiered-fixture", output)
        self.assertNotIn("https://fixture.invalid", output)

    def test_external_exception_repr_never_enters_acquisition_logs(self) -> None:
        secret = "token=PRIVATE-ROUTE-EXCEPTION"
        private_url = "https://private.test/article?signature=PRIVATE-SIGNATURE"
        adapter = _RouteAdapter(())
        service = _service(adapter, _PublicationPort(None), _ExhaustionPort())

        with (
            patch.object(
                adapter,
                "execute",
                side_effect=RuntimeError(f"{secret} {private_url}"),
            ),
            self.assertLogs("sciretriever.acquisition", level="DEBUG") as captured,
        ):
            cohort = service.prepare_primary_pdf_cohort((_request(),))

        item = cohort.items[0]
        self.assertIsNotNone(item.failure)
        assert item.failure is not None
        self.assertEqual(item.failure.code, "acquisition-route-contract")
        output = "\n".join(captured.output)
        self.assertIn("code=acquisition-route-contract", output)
        self.assertIn(item.failure.reason, output)
        self.assertIn(item.failure.action, output)
        for forbidden in (
            secret,
            private_url,
            "PRIVATE-ROUTE-EXCEPTION",
            "PRIVATE-SIGNATURE",
            "RuntimeError(",
        ):
            self.assertNotIn(forbidden, output)

    def test_authorized_failure_matrix_controls_browser_admission_and_exhaustion(self) -> None:
        from sciretriever.acquisition.cohort import WorkItemDisposition

        cases = (
            (
                "acquisition-authorized-quota",
                True,
                WorkItemDisposition.DEFERRED,
                False,
            ),
            (
                "acquisition-authorized-access",
                True,
                WorkItemDisposition.DEFERRED,
                False,
            ),
            (
                "acquisition-authorized-service",
                True,
                WorkItemDisposition.DEFERRED,
                False,
            ),
            (
                "acquisition-authorized-cancelled",
                True,
                WorkItemDisposition.DEFERRED,
                False,
            ),
            (
                "acquisition-authorized-response-schema",
                False,
                WorkItemDisposition.FAILED,
                False,
            ),
            (
                "acquisition-authorized-authentication",
                False,
                WorkItemDisposition.ACTION_REQUIRED,
                False,
            ),
            (
                "acquisition-authorized-credential-missing",
                False,
                WorkItemDisposition.ACTION_REQUIRED,
                False,
            ),
            (
                "acquisition-authorized-entitlement",
                False,
                WorkItemDisposition.EXHAUSTED,
                True,
            ),
        )
        for code, retryable, expected_disposition, browser_allowed in cases:
            with self.subTest(code=code):
                trace: list[str] = []
                exhaustion = _ExhaustionPort()
                service = _failure_matrix_service(
                    StableFailure(
                        code=code,
                        reason="A synthetic authorized route outcome occurred.",
                        action="Follow the stable failure classification.",
                        retryable=retryable,
                    ),
                    trace,
                    exhaustion,
                )

                result = service.prepare_primary_pdf_cohort(
                    (_request(resolved_landing_origin="https://publisher.test"),)
                )
                item = result.items[0]

                self.assertEqual(item.disposition, expected_disposition)
                self.assertEqual(
                    "browser:fixture" in trace,
                    browser_allowed,
                )
                self.assertEqual(
                    bool(result.browser_escalation.groups),
                    browser_allowed,
                )
                if browser_allowed:
                    self.assertEqual(
                        result.browser_escalation.groups[0].paper_count,
                        1,
                    )
                    self.assertIsNotNone(item.prepared)
                    assert item.prepared is not None
                    self.assertIsInstance(service.commit_primary_pdf(item.prepared), NoPrimaryPdf)
                    self.assertEqual(len(exhaustion.commands), 1)
                else:
                    self.assertIsNone(item.prepared)
                    self.assertIsNotNone(item.failure)
                    assert item.failure is not None
                    self.assertEqual(item.failure.code, code)
                    self.assertEqual(exhaustion.commands, [])


if __name__ == "__main__":
    unittest.main()
