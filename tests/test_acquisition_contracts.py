from __future__ import annotations

import inspect
import pickle
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from io import BytesIO
from typing import BinaryIO

import sciretriever.acquisition.api as acquisition_api
import sciretriever.acquisition.ports as acquisition_ports
from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
from sciretriever.acquisition.api import AcquisitionApi, PreparedAcquisition
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
    PrimaryPdfPreparationPort,
    TemporaryPdf,
)
from sciretriever.acquisition.routes import (
    AcquisitionRouteRegistry,
    RouteAdapterBinding,
    RouteExecutionContext,
)
from sciretriever.acquisition.routing import (
    RoutingEvidenceKind,
    build_acquisition_evidence,
)
from sciretriever.acquisition.tiered_service import TieredAcquisitionService
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionPath,
    Asset,
    AssetHint,
    AssetHintKind,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
    NoPrimaryPdf,
    PdfCandidate,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    AssetId,
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
from sciretriever.model.report import StableFailure

_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_HASH = Sha256("a" * 64)


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _failure(code: str, *, retryable: bool = True) -> StableFailure:
    return StableFailure(
        code=code,
        reason="The acquisition operation could not complete.",
        action="Check the local configuration and retry.",
        retryable=retryable,
    )


def _provenance(
    index: int,
    *,
    source_name: str,
    source_kind: SourceKind = SourceKind.ASSET_PROVIDER,
    source_record_id: str | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_id(index)),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=_TIME,
        input_sha256=_HASH,
        parameters_sha256=None,
    )


def _literature(
    *,
    identifiers: tuple[Identifier, ...] = (),
    publisher: str | None = None,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="A concrete paper",
            publisher=publisher,
            identifiers=identifiers,
        ),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(index: int, *, asset_hints: tuple[AssetHint, ...] = ()) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=_provenance(
            index + 100,
            source_name="fixture-metadata",
            source_kind=SourceKind.METADATA_PROVIDER,
            source_record_id=f"record-{index}",
        ),
        metadata=LiteratureMetadata(title="A source observation"),
        asset_hints=asset_hints,
    )


def _request(
    *,
    literature: Literature | None = None,
    observations: tuple[MetadataObservation, ...] = (),
    excluded_candidate_keys: frozenset[str] = frozenset(),
    current_assets: tuple[LiteratureAsset, ...] = (),
) -> AcquisitionRequest:
    target = literature or _literature()
    return AcquisitionRequest(
        literature=target,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=target.literature_id,
            meta_literature_id=target.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(target.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
        current_assets=current_assets,
        excluded_candidate_keys=excluded_candidate_keys,
    )


class _Content:
    def __init__(self, payload: bytes = b"%PDF-fixture") -> None:
        self._payload = payload
        self.discard_count = 0

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        stream = BytesIO(self._payload)
        try:
            yield stream
        finally:
            stream.close()

    def discard(self) -> None:
        self.discard_count += 1


def _temporary(
    index: int,
    *,
    key: str,
    source_name: str,
    path: AcquisitionPath,
) -> TemporaryPdf:
    return TemporaryPdf(
        candidate=PdfCandidate(
            candidate_key=key,
            source_name=source_name,
            acquisition_path=path,
            declared_media_type="application/pdf",
        ),
        content=_Content(),
        safe_source_url="https://content.example.invalid/article.pdf",
        provenance=_provenance(index + 200, source_name=source_name),
    )


def _discard_count(temporary_pdf: TemporaryPdf) -> int:
    content = temporary_pdf.content
    if not isinstance(content, _Content):
        raise AssertionError("fixture content type changed")
    return content.discard_count


class _RouteItem:
    def __init__(self, key: str, temporary_pdf: TemporaryPdf | None) -> None:
        self.key = key
        self.temporary_pdf = temporary_pdf


class _RouteFake:
    def __init__(
        self,
        route_key: str,
        source_name: str,
        path: AcquisitionPath,
        *,
        events: list[str],
        items: tuple[_RouteItem, ...] = (),
        failure: AcquisitionFailure | None = None,
    ) -> None:
        self.route_key = route_key
        self.source_name = source_name
        self.acquisition_path = path
        self._events = events
        self._items = items
        self._failure = failure
        self.close_count = 0

    def execute(self, context: RouteExecutionContext) -> Iterator[RouteExecutionResult]:
        if not isinstance(context, RouteExecutionContext):
            raise TypeError("context must be RouteExecutionContext")
        delivered = False
        try:
            self._events.append(f"execute:{self.route_key}")
            if self._failure is not None:
                raise self._failure
            for item in self._items:
                if not context.candidate_keys.claim(item.key):
                    continue
                self._events.append(f"attempt:{self.route_key}:{item.key}")
                if item.temporary_pdf is not None:
                    delivered = True
                    yield RouteExecutionResult.delivered(item.temporary_pdf)
            if not delivered:
                yield RouteExecutionResult.normal_miss()
        finally:
            self.close_count += 1


class _Prepared:
    def __init__(self, request: AcquisitionRequest, temporary_pdf: TemporaryPdf) -> None:
        self.request = request
        self.temporary_pdf = temporary_pdf
        self.discard_count = 0

    def discard(self) -> None:
        self.discard_count += 1


class _Publication:
    def __init__(
        self,
        *,
        events: list[str],
        success_key: str | None = None,
        failure: AcquisitionFailure | None = None,
        after_prepare: object | None = None,
    ) -> None:
        self.events = events
        self.success_key = success_key
        self.failure = failure
        self.after_prepare = after_prepare
        self.prepared_values: list[_Prepared] = []

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PrimaryPdfPreparation | None:
        del cancel_event
        key = temporary_pdf.candidate.candidate_key
        self.events.append(f"prepare:{key}")
        if self.failure is not None:
            raise self.failure
        if key != self.success_key:
            return None
        prepared = _Prepared(request, temporary_pdf)
        self.prepared_values.append(prepared)
        callback = self.after_prepare
        if callable(callback):
            callback()
        return prepared

    def commit_primary_pdf(self, prepared: PrimaryPdfPreparation) -> AcquiredPrimaryPdf:
        if not isinstance(prepared, _Prepared):
            raise AssertionError("unexpected preparation")
        request = prepared.request
        temporary_pdf = prepared.temporary_pdf
        key = temporary_pdf.candidate.candidate_key
        self.events.append(f"publish:{key}")
        asset = Asset(
            asset_id=AssetId(_id(500)),
            sha256=_HASH,
            size_bytes=12,
            media_type="application/pdf",
            path=RelativeArtifactPath("assets/fixture.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_id(501)),
            literature_id=request.literature.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=temporary_pdf.provenance,
            source_url=temporary_pdf.safe_source_url,
        )
        return AcquiredPrimaryPdf(asset=asset, relation=relation, candidate_key=key)


class _Exhaustion:
    def __init__(self, *, events: list[str], failure: AcquisitionFailure | None = None) -> None:
        self.events = events
        self.failure = failure
        self.calls = 0
        self.commands: list[AcquisitionExhaustionPublicationCommand] = []

    def publish_exhaustion(
        self,
        command: AcquisitionExhaustionPublicationCommand,
    ) -> AutomaticPdfAcquisitionExhaustion:
        self.calls += 1
        self.commands.append(command)
        self.events.append("publish-exhaustion")
        if self.failure is not None:
            raise self.failure
        return AutomaticPdfAcquisitionExhaustion(literature_id=command.expected_facts.literature_id)


class _Clear:
    def __init__(self, *, events: list[str], failure: AcquisitionFailure | None = None) -> None:
        self.events = events
        self.failure = failure
        self.expected_facts: list[AcquisitionExpectedFacts] = []

    def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None:
        self.expected_facts.append(expected_facts)
        self.events.append("clear-exhaustion")
        if self.failure is not None:
            raise self.failure


class _CancelEvent:
    def __init__(self, *, cancelled: bool = False) -> None:
        self.cancelled = cancelled

    def is_set(self) -> bool:
        return self.cancelled


def _spec(
    route_key: str,
    path: AcquisitionPath,
    *,
    readiness: RouteReadiness = RouteReadiness.READY,
    required_identifier_namespaces: tuple[str, ...] = (),
) -> RouteSpec:
    capability = (
        RouteCapability.PUBLIC_PROTOCOL
        if path is AcquisitionPath.PUBLIC
        else RouteCapability.DIRECT_PDF
    )
    return RouteSpec(
        route_key=route_key,
        tier=path,
        capability=capability,
        readiness=readiness,
        required_identifier_namespaces=required_identifier_namespaces,
    )


def _binding(
    spec: RouteSpec,
    route: _RouteFake | None,
) -> RouteAdapterBinding:
    return RouteAdapterBinding(spec=spec, adapter=route)


def _api(
    bindings: tuple[RouteAdapterBinding, ...],
    publication: PrimaryPdfPreparationPort,
    exhaustion: _Exhaustion,
    *,
    clear: _Clear | None = None,
) -> AcquisitionApi:
    catalog = PublisherAccessProfileCatalog(())
    route_registry = AcquisitionRouteRegistry(
        profile_catalog=catalog,
        bindings=bindings,
    )
    planner = ProgressiveAcquisitionPlanner(
        resolver=PublisherAccessResolver(catalog),
        builder=AcquisitionPlanBuilder(catalog),
        route_specs=tuple(binding.spec for binding in bindings),
        doi_landing_resolver=None,
    )
    return AcquisitionApi(
        TieredAcquisitionService(
            route_registry=route_registry,
            planner=planner,
            publication_port=publication,
            exhaustion_port=exhaustion,
            exhaustion_clear_port=clear or _Clear(events=[]),
        )
    )


def _prepare_and_commit(api: AcquisitionApi, request: AcquisitionRequest) -> object:
    return api.commit_primary_pdf(api.prepare_primary_pdf(request))


class TieredAcquisitionContractTests(unittest.TestCase):
    def test_prepare_is_publication_free_and_commit_consumes_receipt_once(self) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/candidate",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        route = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(_RouteItem("public/candidate", temporary),),
        )
        publication = _Publication(events=events, success_key="public/candidate")
        api = _api(
            (_binding(_spec(route.route_key, route.acquisition_path), route),),
            publication,
            _Exhaustion(events=events),
        )

        prepared = api.prepare_primary_pdf(_request())

        self.assertIsInstance(prepared, PreparedAcquisition)
        self.assertNotIn("publish:public/candidate", events)
        self.assertEqual(_discard_count(temporary), 1)
        self.assertIsInstance(api.commit_primary_pdf(prepared), AcquiredPrimaryPdf)
        self.assertEqual(publication.prepared_values[0].discard_count, 1)
        with self.assertRaises(AcquisitionFailure):
            api.commit_primary_pdf(prepared)

    def test_receipt_is_opaque_service_bound_and_discard_is_idempotent(self) -> None:
        first = _api((), _Publication(events=[]), _Exhaustion(events=[]))
        other = _api((), _Publication(events=[]), _Exhaustion(events=[]))
        prepared = first.prepare_primary_pdf(_request())

        self.assertEqual(repr(prepared), "<PreparedAcquisition opaque>")
        self.assertEqual(prepared.__slots__, ("__weakref__",))
        self.assertFalse(hasattr(prepared, "__dict__"))
        with self.assertRaises(TypeError):
            pickle.dumps(prepared)
        with self.assertRaises(AcquisitionFailure):
            other.commit_primary_pdf(prepared)
        first.discard_prepared(prepared)
        first.discard_prepared(prepared)
        with self.assertRaises(AcquisitionFailure):
            first.commit_primary_pdf(prepared)

    def test_cancel_after_validation_discards_both_temporary_and_preparation(self) -> None:
        events: list[str] = []
        cancel = _CancelEvent()
        temporary = _temporary(
            1,
            key="public/candidate",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        route = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(_RouteItem("public/candidate", temporary),),
        )
        publication = _Publication(
            events=events,
            success_key="public/candidate",
            after_prepare=lambda: setattr(cancel, "cancelled", True),
        )
        exhaustion = _Exhaustion(events=events)
        api = _api(
            (_binding(_spec(route.route_key, route.acquisition_path), route),),
            publication,
            exhaustion,
        )

        with self.assertRaises(AcquisitionFailure) as raised:
            api.prepare_primary_pdf(_request(), cancel_event=cancel)

        self.assertEqual(raised.exception.failure.code, "acquisition-interrupted")
        self.assertEqual(_discard_count(temporary), 1)
        self.assertEqual(publication.prepared_values[0].discard_count, 1)
        self.assertEqual(exhaustion.calls, 0)

    def test_rejected_candidate_continues_but_success_stops_higher_tiers(self) -> None:
        events: list[str] = []
        first = _temporary(
            1,
            key="public/rejected",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        second = _temporary(
            2,
            key="public/accepted",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        public = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(
                _RouteItem("public/rejected", first),
                _RouteItem("public/accepted", second),
            ),
        )
        authorized = _RouteFake(
            "api:later",
            "api-later",
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            events=events,
        )
        result = _prepare_and_commit(
            _api(
                (
                    _binding(_spec(public.route_key, public.acquisition_path), public),
                    _binding(
                        _spec(authorized.route_key, authorized.acquisition_path),
                        authorized,
                    ),
                ),
                _Publication(events=events, success_key="public/accepted"),
                _Exhaustion(events=events),
            ),
            _request(),
        )

        self.assertIsInstance(result, AcquiredPrimaryPdf)
        self.assertEqual(_discard_count(first), 1)
        self.assertEqual(_discard_count(second), 1)
        self.assertIn("attempt:public:one:public/accepted", events)
        self.assertNotIn("execute:api:later", events)

    def test_transient_public_failure_defers_without_api_escalation_or_exhaustion(self) -> None:
        events: list[str] = []
        transient = AcquisitionSourceFailure(_failure("network-timeout"))
        public = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            failure=transient,
        )
        authorized = _RouteFake(
            "api:later",
            "api-later",
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            events=events,
        )
        exhaustion = _Exhaustion(events=events)
        api = _api(
            (
                _binding(_spec(public.route_key, public.acquisition_path), public),
                _binding(_spec(authorized.route_key, authorized.acquisition_path), authorized),
            ),
            _Publication(events=events),
            exhaustion,
        )

        with self.assertRaises(AcquisitionFailure) as raised:
            api.prepare_primary_pdf(_request())

        self.assertEqual(raised.exception.failure.code, "network-timeout")
        self.assertNotIn("execute:api:later", events)
        self.assertEqual(exhaustion.calls, 0)

    def test_unrelated_unconfigured_route_is_omitted_but_selected_route_requires_action(
        self,
    ) -> None:
        spec = _spec(
            "api:configured-only",
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            readiness=RouteReadiness.UNCONFIGURED,
            required_identifier_namespaces=("doi",),
        )
        exhaustion = _Exhaustion(events=[])
        api = _api(
            (_binding(spec, None),),
            _Publication(events=[]),
            exhaustion,
        )

        result = _prepare_and_commit(api, _request())
        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertEqual(exhaustion.calls, 1)

        with self.assertRaises(AcquisitionFailure) as raised:
            api.prepare_primary_pdf(
                _request(
                    literature=_literature(
                        identifiers=(Identifier(namespace="doi", value="10.1234/example"),)
                    )
                )
            )
        self.assertEqual(raised.exception.failure.code, "acquisition-route-unconfigured")
        self.assertEqual(exhaustion.calls, 1)

    def test_normal_miss_publishes_exhaustion_only_at_commit(self) -> None:
        events: list[str] = []
        route = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
        )
        exhaustion = _Exhaustion(events=events)
        api = _api(
            (_binding(_spec(route.route_key, route.acquisition_path), route),),
            _Publication(events=events),
            exhaustion,
        )

        prepared = api.prepare_primary_pdf(_request())
        self.assertEqual(exhaustion.calls, 0)
        result = api.commit_primary_pdf(prepared)

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertEqual(exhaustion.calls, 1)
        self.assertEqual(exhaustion.commands[0].observation_ids, ())

    def test_excluded_candidate_skips_attempt_and_exhausts_normally(self) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/excluded",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        route = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(_RouteItem("public/excluded", temporary),),
        )
        result = _prepare_and_commit(
            _api(
                (_binding(_spec(route.route_key, route.acquisition_path), route),),
                _Publication(events=events),
                _Exhaustion(events=events),
            ),
            _request(excluded_candidate_keys=frozenset({"public/excluded"})),
        )

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertNotIn("attempt:public:one:public/excluded", events)
        self.assertEqual(_discard_count(temporary), 0)

    def test_publication_and_exhaustion_failures_never_become_no_primary_pdf(self) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/candidate",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        route = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(_RouteItem("public/candidate", temporary),),
        )
        with self.assertRaises(AcquisitionFailure) as publication_error:
            _api(
                (_binding(_spec(route.route_key, route.acquisition_path), route),),
                _Publication(
                    events=events,
                    failure=AcquisitionFailure(_failure("primary-publication-failed")),
                ),
                _Exhaustion(events=events),
            ).prepare_primary_pdf(_request())
        self.assertEqual(publication_error.exception.failure.code, "primary-publication-failed")
        self.assertEqual(_discard_count(temporary), 1)

        exhaustion = _Exhaustion(
            events=[],
            failure=AcquisitionFailure(_failure("exhaustion-publication-failed")),
        )
        api = _api((), _Publication(events=[]), exhaustion)
        with self.assertRaises(AcquisitionFailure) as exhaustion_error:
            api.commit_primary_pdf(api.prepare_primary_pdf(_request()))
        self.assertEqual(
            exhaustion_error.exception.failure.code,
            "exhaustion-publication-failed",
        )
        self.assertEqual(exhaustion.calls, 1)

    def test_explicit_retry_clear_is_source_free_and_preserves_failure(self) -> None:
        events: list[str] = []
        route = _RouteFake(
            "public:one",
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
        )
        request = _request()
        clear = _Clear(events=events)
        api = _api(
            (_binding(_spec(route.route_key, route.acquisition_path), route),),
            _Publication(events=events),
            _Exhaustion(events=events),
            clear=clear,
        )

        api.clear_exhaustion_for_explicit_retry(request.expected_facts)

        self.assertEqual(clear.expected_facts, [request.expected_facts])
        self.assertEqual(events, ["clear-exhaustion"])
        self.assertEqual(route.close_count, 0)

        failure = AcquisitionFailure(_failure("exhaustion-clear-failed"))
        failing = _api(
            (),
            _Publication(events=[]),
            _Exhaustion(events=[]),
            clear=_Clear(events=[], failure=failure),
        )
        with self.assertRaises(AcquisitionFailure) as raised:
            failing.clear_exhaustion_for_explicit_retry(request.expected_facts)
        self.assertIs(raised.exception, failure)


class AcquisitionBoundaryShapeTests(unittest.TestCase):
    def test_request_has_one_ports_owned_definition_and_public_api_export(self) -> None:
        self.assertIs(acquisition_ports.AcquisitionRequest, AcquisitionRequest)
        self.assertIs(acquisition_api.AcquisitionRequest, AcquisitionRequest)
        self.assertEqual(AcquisitionRequest.__module__, "sciretriever.acquisition.ports")

    def test_evidence_is_local_ordered_and_contains_no_route_execution(self) -> None:
        hint = AssetHint(
            url="https://repository.example.invalid/paper.pdf",
            kind=AssetHintKind.DIRECT_FILE,
            media_type="application/pdf",
            asset_role=AssetRole.PRIMARY_PDF,
        )
        request = _request(
            literature=_literature(
                publisher="Example Publisher",
                identifiers=(
                    Identifier(namespace="doi", value="10.1016/example"),
                    Identifier(namespace="pii", value="S012345678900001X"),
                ),
            ),
            observations=(_observation(10, asset_hints=(hint,)),),
        )

        evidence = build_acquisition_evidence(request)

        self.assertEqual(
            evidence.priority,
            (
                RoutingEvidenceKind.ASSET_HINT,
                RoutingEvidenceKind.STABLE_PROVIDER_LOCATOR,
                RoutingEvidenceKind.PROVIDER_RECORD_IDENTITY,
                RoutingEvidenceKind.WEAK_PUBLISHER_OR_DOI_PREFIX,
            ),
        )
        self.assertEqual(evidence.asset_hints[0].hint, hint)
        self.assertEqual(evidence.stable_provider_locators[0].namespace, "pii")
        self.assertEqual(evidence.weak_hints.publisher, "Example Publisher")
        self.assertEqual(evidence.weak_hints.doi_prefixes, ("10.1016",))

    def test_public_ports_expose_route_execution_and_no_legacy_source_contract(self) -> None:
        exposed = " ".join(
            (
                str(inspect.signature(AcquisitionApi.prepare_primary_pdf)),
                str(inspect.signature(AcquisitionApi.commit_primary_pdf)),
                str(inspect.signature(AcquisitionApi.discard_prepared)),
                str(inspect.signature(RouteExecutionContext)),
                str(
                    inspect.signature(
                        acquisition_ports.PrimaryPdfPreparationPort.prepare_primary_pdf
                    )
                ),
            )
        )
        for forbidden in (
            "AccessFailure",
            "BoundedByteStream",
            "Browser",
            "Http",
            "TransportRequest",
            "TransportResponse",
            "Vendor",
        ):
            self.assertNotIn(forbidden, exposed)
            self.assertFalse(hasattr(acquisition_api, forbidden))
            self.assertFalse(hasattr(acquisition_ports, forbidden))
        for legacy in (
            "PdfSource",
            "PdfSourceBinding",
            "SourceReadiness",
            "DoiLandingOriginResolver",
        ):
            self.assertFalse(hasattr(acquisition_ports, legacy))


if __name__ == "__main__":
    unittest.main()
