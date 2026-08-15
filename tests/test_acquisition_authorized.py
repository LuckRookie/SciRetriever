from __future__ import annotations

import hashlib
import json
import re
import unittest
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from typing import BinaryIO, cast

from PyPDF2 import PdfWriter

import sciretriever.acquisition.api as acquisition_api
import sciretriever.acquisition.authorized as authorized
from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
from sciretriever.acquisition.authorized import (
    AuthorizedClientFailure,
    AuthorizedClientFailureKind,
    AuthorizedDownloadLocator,
    AuthorizedDownloadMiss,
    AuthorizedDownloadResult,
    AuthorizedEntitlement,
    AuthorizedEvidenceKind,
    AuthorizedLookupDownloads,
    AuthorizedLookupMiss,
    AuthorizedLookupResult,
    AuthorizedLookupTarget,
    AuthorizedNormalMiss,
    AuthorizedPdfDownload,
    AuthorizedPdfSource,
    AuthorizedProviderClient,
    AuthorizedProviderContract,
    AuthorizedRecordIdentityRule,
    authorized_route_status,
)
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
    CandidateKeyTracker,
    PrimaryPdfPreparation,
    PrimaryPdfPreparationPort,
    PrimaryPdfPublicationResult,
    TemporaryPdf,
    ValidatedPdfContent,
    ValidatedPrimaryPdfPublicationCommand,
)
from sciretriever.acquisition.publication import (
    PrimaryPdfPublisher,
    ValidatedPrimaryPdfPublisher,
)
from sciretriever.acquisition.routes import AcquisitionRouteRegistry, RouteAdapterBinding
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
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
from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging

_FIXTURES = Path(__file__).parent / "fixtures" / "acquisition" / "authorized"
_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_KEY_PATTERN = re.compile(r"^authorized:fixture-authorized:(lookup|download):[0-9a-f]{64}$")
_PRIVATE_SENTINEL = "PRIVATE-CREDENTIAL-SENTINEL"
_ENDPOINT_SENTINEL = "https://private-api.example.test/secret-product"
_PDF_VALIDATION_STAGING = SystemPdfValidationStaging()


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _valid_pdf() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


def _fixture(name: str) -> dict[str, object]:
    value = cast(object, json.loads((_FIXTURES / name).read_text(encoding="utf-8")))
    if type(value) is not dict:
        raise AssertionError("authorized fixture must be a JSON object")
    return cast(dict[str, object], value)


def _contract(
    *,
    normal_miss_reasons: frozenset[AuthorizedNormalMiss] | None = None,
) -> AuthorizedProviderContract:
    return AuthorizedProviderContract(
        source_name="fixture-authorized",
        product_name="fixture-primary-pdf-product",
        contract_revision="fixture-contract-v1",
        required_credential_fields=("api_key", "institution_token", "api_metric"),
        stable_locator_namespaces=("pii", "future-document"),
        provider_record_identity_rules=(
            AuthorizedRecordIdentityRule(
                provider_name="fixture-metadata",
                record_id_prefix="document:",
                target_namespace="fixture-document",
            ),
        ),
        doi_landing_origins=("https://publisher.example.test",),
        download_locator_namespaces=("fixture-pdf",),
        normal_miss_reasons=(
            frozenset(AuthorizedNormalMiss) if normal_miss_reasons is None else normal_miss_reasons
        ),
    )


def _pii_target(value: str = "S123456789") -> AuthorizedLookupTarget:
    return AuthorizedLookupTarget(
        evidence_kind=AuthorizedEvidenceKind.STABLE_PROVIDER_LOCATOR,
        namespace="pii",
        value=value,
    )


def _observation(
    index: int,
    *,
    provider_name: str,
    record_id: str,
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 100)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider_name,
            source_record_id=record_id,
            observed_at=_TIME,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title="Fixture observation"),
    )


def _request(
    *,
    identifiers: tuple[Identifier, ...] = (),
    observations: tuple[MetadataObservation, ...] = (),
    publisher: str | None = None,
    resolved_landing_origin: str | None = None,
    excluded_candidate_keys: frozenset[str] = frozenset(),
) -> tuple[AcquisitionRequest, AcquisitionEvidence]:
    literature = Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="Authorized fixture",
            publisher=publisher,
            identifiers=identifiers,
        ),
        status=LiteratureStatus.UNREVIEWED,
    )
    request = AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
        resolved_landing_origin=resolved_landing_origin,
        excluded_candidate_keys=excluded_candidate_keys,
    )
    return request, build_acquisition_evidence(request)


class _MemoryContent:
    def __init__(self, payload: bytes, *, fail_discard: bool = False) -> None:
        self.payload = payload
        self.fail_discard = fail_discard
        self.discard_count = 0

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        stream = BytesIO(self.payload)
        try:
            yield stream
        finally:
            stream.close()

    def discard(self) -> None:
        self.discard_count += 1
        if self.fail_discard:
            raise RuntimeError("fixture cleanup failed")


class _ClientFake:
    def __init__(
        self,
        lookup_actions: Iterable[object],
        download_actions: Iterable[object] = (),
    ) -> None:
        self.lookup_actions = list(lookup_actions)
        self.download_actions = list(download_actions)
        self.lookup_calls: list[object] = []
        self.download_calls: list[AuthorizedDownloadLocator] = []

    def __repr__(self) -> str:
        return f"<_ClientFake {_PRIVATE_SENTINEL} {_ENDPOINT_SENTINEL}>"

    def lookup(self, target: AuthorizedLookupTarget) -> AuthorizedLookupResult:
        self.lookup_calls.append(target)
        action = self.lookup_actions.pop(0)
        if isinstance(action, AuthorizedClientFailure):
            raise action
        return cast(AuthorizedLookupResult, action)

    def download(self, locator: AuthorizedDownloadLocator) -> AuthorizedDownloadResult:
        self.download_calls.append(locator)
        action = self.download_actions.pop(0)
        if isinstance(action, AuthorizedClientFailure):
            raise action
        return cast(AuthorizedDownloadResult, action)


class _FixtureClient:
    def __init__(
        self,
        fixture_name: str,
        *,
        payload: bytes | None = None,
        fail_discard: bool = False,
    ) -> None:
        self.record = _fixture(fixture_name)
        self.payload = _valid_pdf() if payload is None else payload
        self.fail_discard = fail_discard
        self.lookup_calls: list[object] = []
        self.download_calls: list[AuthorizedDownloadLocator] = []
        self.contents: list[_MemoryContent] = []

    def lookup(self, target: AuthorizedLookupTarget) -> AuthorizedLookupResult:
        self.lookup_calls.append(target)
        outcome = self.record.get("outcome")
        if outcome == "no-primary":
            return AuthorizedLookupMiss(
                target=target,
                reason=AuthorizedNormalMiss.NO_PRIMARY,
            )
        if outcome != "primary-pdf":
            raise AuthorizedClientFailure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
        namespace = self.record.get("locator_namespace")
        value = self.record.get("locator_value")
        media_type = self.record.get("media_type")
        source_record_id = self.record.get("source_record_id")
        if (
            not isinstance(namespace, str)
            or not isinstance(value, str)
            or not isinstance(media_type, str)
            or not isinstance(source_record_id, str)
        ):
            raise AuthorizedClientFailure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
        return AuthorizedLookupDownloads(
            target=target,
            entitlement=AuthorizedEntitlement.GRANTED,
            downloads=(
                AuthorizedDownloadLocator(
                    namespace=namespace,
                    value=value,
                    declared_media_type=media_type,
                    source_record_id=source_record_id,
                ),
            ),
        )

    def download(self, locator: AuthorizedDownloadLocator) -> AuthorizedDownloadResult:
        self.download_calls.append(locator)
        content = _MemoryContent(self.payload, fail_discard=self.fail_discard)
        self.contents.append(content)
        return AuthorizedPdfDownload(
            locator=locator,
            content=content,
            media_type=locator.declared_media_type,
            safe_source_url="https://publisher.example.test/content/article.pdf",
        )


def _source(
    client: object,
    *,
    contract: AuthorizedProviderContract | None = None,
) -> AuthorizedPdfSource:
    return AuthorizedPdfSource(
        contract=_contract() if contract is None else contract,
        client=cast(AuthorizedProviderClient, client),
        provenance_id_factory=lambda: ProvenanceId(_id(300)),
        clock=lambda: _TIME,
    )


def _locator(
    value: str = "primary-object-v1",
    *,
    media_type: str | None = "application/pdf",
) -> AuthorizedDownloadLocator:
    return AuthorizedDownloadLocator(
        namespace="fixture-pdf",
        value=value,
        declared_media_type=media_type,
        source_record_id="PII:S123456789",
    )


class _CommitPort:
    def __init__(self) -> None:
        self.commands: list[ValidatedPrimaryPdfPublicationCommand] = []

    def commit_validated_primary_pdf(
        self,
        command: ValidatedPrimaryPdfPublicationCommand,
        validated_pdf: ValidatedPdfContent,
    ) -> PrimaryPdfPublicationResult:
        self.commands.append(command)
        asset = Asset(
            asset_id=command.proposed_asset_id,
            sha256=validated_pdf.sha256,
            size_bytes=validated_pdf.byte_size,
            media_type=validated_pdf.media_type,
            path=RelativeArtifactPath("assets/fixture-authorized.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=command.proposed_literature_asset_id,
            literature_id=command.expected_facts.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=command.provenance,
            source_url=command.source_url,
        )
        return PrimaryPdfPublicationResult(asset=asset, relation=relation)


class _ExhaustionPort:
    def __init__(self) -> None:
        self.calls = 0

    def publish_exhaustion(
        self,
        command: AcquisitionExhaustionPublicationCommand,
    ) -> AutomaticPdfAcquisitionExhaustion:
        self.calls += 1
        return AutomaticPdfAcquisitionExhaustion(literature_id=command.expected_facts.literature_id)


class _ClearPort:
    def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None:
        del expected_facts


class _NullPublicationPort:
    def __init__(self) -> None:
        self.calls = 0

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: object | None = None,
    ) -> None:
        self.calls += 1
        del request, temporary_pdf, cancel_event

    def commit_primary_pdf(self, prepared: PrimaryPdfPreparation) -> AcquiredPrimaryPdf:
        del prepared
        raise AssertionError("null preparation must never commit")


def _service(
    source: AuthorizedPdfSource,
    *,
    publication_port: PrimaryPdfPreparationPort,
    exhaustion_port: _ExhaustionPort,
) -> TieredAcquisitionService:
    status = authorized_route_status(
        source.contract,
        product_ready=True,
        access_policy_ready=True,
        present_credential_fields=frozenset({"api_key", "institution_token", "api_metric"}),
    )
    if status.readiness is not RouteReadiness.READY:
        raise AssertionError("fixture authorized route must be ready")
    catalog = PublisherAccessProfileCatalog(())
    spec = RouteSpec(
        route_key=source.route_key,
        tier=AcquisitionPath.AUTHORIZED_PROVIDER_API,
        capability=RouteCapability.DIRECT_PDF,
        readiness=RouteReadiness.READY,
    )
    return TieredAcquisitionService(
        route_registry=AcquisitionRouteRegistry(
            profile_catalog=catalog,
            bindings=(RouteAdapterBinding(spec=spec, adapter=source),),
        ),
        planner=ProgressiveAcquisitionPlanner(
            resolver=PublisherAccessResolver(catalog),
            builder=AcquisitionPlanBuilder(catalog),
            route_specs=(spec,),
            doi_landing_resolver=None,
        ),
        publication_port=publication_port,
        exhaustion_port=exhaustion_port,
        exhaustion_clear_port=_ClearPort(),
    )


class AuthorizedProviderBoundaryTests(unittest.TestCase):
    def test_production_catalog_contains_only_verified_primary_pdf_apis(self) -> None:
        self.assertEqual(
            set(authorized.PRODUCTION_AUTHORIZED_PROVIDER_CATALOG),
            {"core", "elsevier", "wiley"},
        )
        self.assertIs(
            authorized.PRODUCTION_AUTHORIZED_PROVIDER_CATALOG["core"],
            authorized.CORE_AUTHORIZED_CONTRACT,
        )
        self.assertIs(
            authorized.PRODUCTION_AUTHORIZED_PROVIDER_CATALOG["elsevier"],
            authorized.ELSEVIER_AUTHORIZED_CONTRACT,
        )
        self.assertEqual(
            authorized.UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS,
            frozenset({"springer"}),
        )
        exported = set(authorized.__all__)
        self.assertIn("ELSEVIER_AUTHORIZED_CONTRACT", exported)
        self.assertIn("WILEY_AUTHORIZED_CONTRACT", exported)
        self.assertFalse(any("Springer" in name for name in exported))

    def test_secret_free_readiness_precedes_io_but_does_not_claim_entitlement(self) -> None:
        contract = _contract()
        cases = (
            (
                None,
                True,
                True,
                frozenset[str](),
                "acquisition-authorized-source-unsupported",
            ),
            (
                contract,
                False,
                True,
                frozenset({"api_key", "institution_token", "api_metric"}),
                "acquisition-authorized-product-not-ready",
            ),
            (
                contract,
                True,
                False,
                frozenset({"api_key", "institution_token", "api_metric"}),
                "acquisition-authorized-access-policy-missing",
            ),
            (
                contract,
                True,
                True,
                frozenset({"api_key", "institution_token"}),
                "acquisition-authorized-credential-missing",
            ),
        )
        for contract_value, product, policy, fields, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                result = authorized_route_status(
                    contract_value,
                    product_ready=product,
                    access_policy_ready=policy,
                    present_credential_fields=fields,
                )
                self.assertIsNot(result.readiness, RouteReadiness.READY)
                failure = result.failure
                if failure is None:
                    raise AssertionError("non-ready state must have a stable failure")
                self.assertEqual(failure.code, expected_code)

        ready = authorized_route_status(
            contract,
            product_ready=True,
            access_policy_ready=True,
            present_credential_fields=frozenset({"api_key", "institution_token", "api_metric"}),
        )
        self.assertIs(ready.readiness, RouteReadiness.READY)
        self.assertIsNone(ready.failure)
        self.assertFalse(hasattr(ready, "entitlement"))
        self.assertNotIn(_PRIVATE_SENTINEL, repr(contract))

    def test_contract_lookup_accepts_only_recognized_strong_evidence(self) -> None:
        strong_requests = (
            _request(identifiers=(Identifier(namespace="pii", value="S123456789"),)),
            _request(identifiers=(Identifier(namespace="future-document", value="DOC-2026-1"),)),
            _request(
                observations=(
                    _observation(
                        10,
                        provider_name="fixture-metadata",
                        record_id="document:REC-1",
                    ),
                )
            ),
            _request(
                identifiers=(Identifier(namespace="doi", value="10.5555/example"),),
                resolved_landing_origin="https://publisher.example.test",
            ),
        )
        for request_value, evidence in strong_requests:
            with self.subTest(priority=evidence.priority):
                client = _FixtureClient("no-primary.json")
                source = _source(client)
                self.assertEqual(
                    list(
                        source._deliveries(
                            request_value,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    ),
                    [],
                )
                self.assertEqual(len(client.lookup_calls), 1)

    def test_publisher_prefix_scopus_source_and_wrong_origin_do_not_create_lookups(self) -> None:
        weak_requests = (
            _request(publisher="Fixture Publisher"),
            _request(
                publisher="Fixture Publisher",
                identifiers=(Identifier(namespace="doi", value="10.5555/example"),),
            ),
            _request(
                observations=(
                    _observation(
                        11,
                        provider_name="fixture-metadata",
                        record_id="SCOPUS_ID:2-s2.0-123",
                    ),
                )
            ),
            _request(
                observations=(
                    _observation(
                        12,
                        provider_name="elsevier",
                        record_id="2-s2.0-123",
                    ),
                )
            ),
            _request(
                identifiers=(Identifier(namespace="doi", value="10.5555/example"),),
                resolved_landing_origin="https://other-publisher.example.test",
            ),
        )
        for request_value, evidence in weak_requests:
            with self.subTest(priority=evidence.priority):
                client = _ClientFake(())
                source = _source(client)
                self.assertEqual(
                    list(
                        source._deliveries(
                            request_value,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    ),
                    [],
                )
                self.assertEqual(client.lookup_calls, [])

    def test_target_selection_is_local_and_evidence_mismatch_fails_before_client_io(self) -> None:
        client = _FixtureClient("no-primary.json")
        source = _source(client)
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        self.assertEqual(
            list(source._deliveries(request, evidence, CandidateKeyTracker())),
            [],
        )
        self.assertEqual(len(client.lookup_calls), 1)

        other_request, other_evidence = _request(
            identifiers=(Identifier(namespace="future-document", value="DOC-2"),)
        )
        self.assertEqual(request.literature.literature_id, other_request.literature.literature_id)
        with self.assertRaises(AcquisitionFailure) as caught:
            list(source._deliveries(request, other_evidence, CandidateKeyTracker()))
        self.assertEqual(caught.exception.failure.code, "acquisition-authorized-evidence-mismatch")
        self.assertEqual(len(client.lookup_calls), 1)

    def test_lookup_decision_for_another_target_fails_before_download_or_publication(
        self,
    ) -> None:
        request, _evidence = _request(identifiers=(Identifier(namespace="pii", value="A"),))
        locator_for_b = AuthorizedDownloadLocator(
            namespace="fixture-pdf",
            value="object-for-B",
            declared_media_type="application/pdf",
            source_record_id="PII:B",
        )
        content_for_b = _MemoryContent(_valid_pdf())
        client = _ClientFake(
            (
                AuthorizedLookupDownloads(
                    target=_pii_target("B"),
                    entitlement=AuthorizedEntitlement.GRANTED,
                    downloads=(locator_for_b,),
                ),
            ),
            (
                AuthorizedPdfDownload(
                    locator=locator_for_b,
                    content=content_for_b,
                    media_type="application/pdf",
                    safe_source_url=None,
                ),
            ),
        )
        publication = _NullPublicationPort()
        exhaustion = _ExhaustionPort()

        with self.assertRaises(AcquisitionFailure) as caught:
            _service(
                _source(client),
                publication_port=publication,
                exhaustion_port=exhaustion,
            ).prepare_primary_pdf(request)

        self.assertEqual(caught.exception.failure.code, "acquisition-authorized-response-schema")
        self.assertEqual(client.download_calls, [])
        self.assertEqual(publication.calls, 0)
        self.assertEqual(exhaustion.calls, 0)
        self.assertEqual(content_for_b.discard_count, 0)

    def test_every_lookup_and_download_outcome_echoes_the_requested_identity(self) -> None:
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="A"),))

        lookup_miss_for_b = _ClientFake(
            (
                AuthorizedLookupMiss(
                    target=_pii_target("B"),
                    reason=AuthorizedNormalMiss.HTTP_404,
                ),
            )
        )
        with self.assertRaises(AcquisitionFailure) as lookup_miss_failure:
            list(
                _source(lookup_miss_for_b)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            lookup_miss_failure.exception.failure.code,
            "acquisition-authorized-response-schema",
        )
        self.assertEqual(lookup_miss_for_b.download_calls, [])

        locator_for_a = AuthorizedDownloadLocator(
            namespace="fixture-pdf",
            value="object-for-A",
            declared_media_type="application/pdf",
            source_record_id="PII:A",
        )
        locator_for_b = AuthorizedDownloadLocator(
            namespace="fixture-pdf",
            value="object-for-B",
            declared_media_type="application/pdf",
            source_record_id="PII:B",
        )
        matching_lookup = AuthorizedLookupDownloads(
            target=_pii_target("A"),
            entitlement=AuthorizedEntitlement.GRANTED,
            downloads=(locator_for_a,),
        )

        download_miss_for_b = _ClientFake(
            (matching_lookup,),
            (
                AuthorizedDownloadMiss(
                    locator=locator_for_b,
                    reason=AuthorizedNormalMiss.HTTP_404,
                ),
            ),
        )
        with self.assertRaises(AcquisitionFailure) as download_miss_failure:
            list(
                _source(download_miss_for_b)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            download_miss_failure.exception.failure.code,
            "acquisition-authorized-response-schema",
        )
        self.assertEqual(download_miss_for_b.download_calls, [locator_for_a])

        mismatched_content = _MemoryContent(_valid_pdf())
        download_pdf_for_b = _ClientFake(
            (matching_lookup,),
            (
                AuthorizedPdfDownload(
                    locator=locator_for_b,
                    content=mismatched_content,
                    media_type="application/pdf",
                    safe_source_url=None,
                ),
            ),
        )
        with self.assertRaises(AcquisitionFailure) as download_pdf_failure:
            list(
                _source(download_pdf_for_b)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            download_pdf_failure.exception.failure.code,
            "acquisition-authorized-response-schema",
        )
        self.assertEqual(download_pdf_for_b.download_calls, [locator_for_a])
        self.assertEqual(mismatched_content.discard_count, 1)

    def test_lookup_and_download_use_independent_digest_claims_and_only_download_is_candidate(
        self,
    ) -> None:
        client = _FixtureClient("success.json")
        source = _source(client)
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        tracker = CandidateKeyTracker()

        deliveries = list(source._deliveries(request, evidence, tracker))

        self.assertEqual(len(deliveries), 1)
        temporary = deliveries[0]
        keys = tracker.tried_candidate_keys
        self.assertEqual(len(keys), 2)
        self.assertTrue(all(_KEY_PATTERN.fullmatch(key) is not None for key in keys))
        lookup_key = next(key for key in keys if ":lookup:" in key)
        download_key = next(key for key in keys if ":download:" in key)
        self.assertNotEqual(lookup_key, download_key)
        self.assertEqual(temporary.candidate.candidate_key, download_key)
        self.assertIs(
            temporary.candidate.acquisition_path,
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
        )
        self.assertEqual(temporary.provenance.source_name, "fixture-authorized")
        self.assertEqual(temporary.provenance.source_record_id, "PII:S123456789")
        for private_value in (
            "S123456789",
            "primary-object-v1",
            _PRIVATE_SENTINEL,
            _ENDPOINT_SENTINEL,
        ):
            self.assertTrue(all(private_value not in key for key in keys))
        temporary.content.discard()

    def test_excluded_lookup_or_download_is_checked_before_its_own_io(self) -> None:
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        first_client = _FixtureClient("success.json")
        first_tracker = CandidateKeyTracker()
        first = list(_source(first_client)._deliveries(request, evidence, first_tracker))[0]
        first.content.discard()
        lookup_key = next(key for key in first_tracker.tried_candidate_keys if ":lookup:" in key)
        download_key = next(
            key for key in first_tracker.tried_candidate_keys if ":download:" in key
        )

        lookup_blocked = _FixtureClient("success.json")
        self.assertEqual(
            list(
                _source(lookup_blocked)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker((lookup_key,)),
                )
            ),
            [],
        )
        self.assertEqual(lookup_blocked.lookup_calls, [])
        self.assertEqual(lookup_blocked.download_calls, [])

        download_blocked = _FixtureClient("success.json")
        self.assertEqual(
            list(
                _source(download_blocked)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker((download_key,)),
                )
            ),
            [],
        )
        self.assertEqual(len(download_blocked.lookup_calls), 1)
        self.assertEqual(download_blocked.download_calls, [])

    def test_only_contract_listed_miss_outcomes_end_normally(self) -> None:
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        for reason in AuthorizedNormalMiss:
            with self.subTest(reason=reason):
                client = _ClientFake((AuthorizedLookupMiss(target=_pii_target(), reason=reason),))
                self.assertEqual(
                    list(
                        _source(client)._deliveries(
                            request,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    ),
                    [],
                )

        restrictive = _contract(normal_miss_reasons=frozenset({AuthorizedNormalMiss.HTTP_404}))
        with self.assertRaises(AcquisitionFailure) as caught:
            list(
                _source(
                    _ClientFake(
                        (
                            AuthorizedLookupMiss(
                                target=_pii_target(),
                                reason=AuthorizedNormalMiss.HTTP_204,
                            ),
                        )
                    ),
                    contract=restrictive,
                )._deliveries(request, evidence, CandidateKeyTracker())
            )
        self.assertEqual(caught.exception.failure.code, "acquisition-authorized-response-schema")

    def test_download_stage_preserves_miss_failure_and_pdf_response_distinctions(self) -> None:
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        locator = _locator()
        lookup = AuthorizedLookupDownloads(
            target=_pii_target(),
            entitlement=AuthorizedEntitlement.GRANTED,
            downloads=(locator,),
        )

        normal_miss = _ClientFake(
            (lookup,),
            (
                AuthorizedDownloadMiss(
                    locator=locator,
                    reason=AuthorizedNormalMiss.HTTP_410,
                ),
            ),
        )
        self.assertEqual(
            list(
                _source(normal_miss)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker(),
                )
            ),
            [],
        )
        self.assertEqual(normal_miss.download_calls, [locator])

        denied = _ClientFake(
            (lookup,),
            (AuthorizedClientFailure(AuthorizedClientFailureKind.ENTITLEMENT),),
        )
        with self.assertRaises(AcquisitionFailure) as denied_failure:
            list(_source(denied)._deliveries(request, evidence, CandidateKeyTracker()))
        self.assertEqual(
            denied_failure.exception.failure.code,
            "acquisition-authorized-entitlement",
        )

        xml_content = _MemoryContent(b"<article/>")
        xml_response = _ClientFake(
            (lookup,),
            (
                AuthorizedPdfDownload(
                    locator=locator,
                    content=xml_content,
                    media_type="application/jats+xml",
                    safe_source_url=None,
                ),
            ),
        )
        with self.assertRaises(AcquisitionFailure) as xml_failure:
            list(
                _source(xml_response)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            xml_failure.exception.failure.code,
            "acquisition-authorized-non-pdf-product",
        )
        self.assertEqual(xml_content.discard_count, 1)

    def test_runtime_failures_have_distinct_stable_semantics(self) -> None:
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        cases = (
            (
                AuthorizedClientFailureKind.AUTHENTICATION,
                "acquisition-authorized-authentication",
                False,
            ),
            (
                AuthorizedClientFailureKind.ENTITLEMENT,
                "acquisition-authorized-entitlement",
                False,
            ),
            (AuthorizedClientFailureKind.QUOTA, "acquisition-authorized-quota", True),
            (AuthorizedClientFailureKind.SERVICE, "acquisition-authorized-service", True),
            (
                AuthorizedClientFailureKind.RESPONSE_SCHEMA,
                "acquisition-authorized-response-schema",
                False,
            ),
            (AuthorizedClientFailureKind.ACCESS, "acquisition-authorized-access", True),
            (AuthorizedClientFailureKind.CANCELLED, "acquisition-authorized-cancelled", True),
            (AuthorizedClientFailureKind.CLEANUP, "acquisition-authorized-cleanup", True),
        )
        for kind, expected_code, retryable in cases:
            with self.subTest(kind=kind):
                source = _source(_ClientFake((AuthorizedClientFailure(kind),)))
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(source._deliveries(request, evidence, CandidateKeyTracker()))
                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertIs(caught.exception.failure.retryable, retryable)

    def test_specific_entitlement_must_be_granted_after_authentication(self) -> None:
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        for entitlement, expected_code in (
            (AuthorizedEntitlement.DENIED, "acquisition-authorized-entitlement"),
            (AuthorizedEntitlement.UNKNOWN, "acquisition-authorized-entitlement-unproven"),
        ):
            client = _ClientFake(
                (
                    AuthorizedLookupDownloads(
                        target=_pii_target(),
                        entitlement=entitlement,
                        downloads=(_locator(),),
                    ),
                )
            )
            with self.subTest(entitlement=entitlement):
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        _source(client)._deliveries(
                            request,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertEqual(client.download_calls, [])

    def test_xml_jats_ambiguous_and_malformed_responses_are_system_failures(self) -> None:
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        for fixture_name, expected_code in (
            ("xml-only.json", "acquisition-authorized-non-pdf-product"),
            ("jats-only.json", "acquisition-authorized-non-pdf-product"),
            ("ambiguous.json", "acquisition-authorized-primary-pdf-ambiguous"),
            ("schema-invalid.json", "acquisition-authorized-response-schema"),
        ):
            client = _FixtureClient(fixture_name)
            with self.subTest(fixture_name=fixture_name):
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        _source(client)._deliveries(
                            request,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertEqual(client.download_calls, [])

    def test_happy_path_uses_unified_pdf_validation_and_publication(self) -> None:
        request, _evidence = _request(
            identifiers=(Identifier(namespace="pii", value="S123456789"),)
        )
        client = _FixtureClient("success.json")
        source = _source(client)
        commit = _CommitPort()
        publication = PrimaryPdfPublisher(
            ValidatedPrimaryPdfPublisher(
                commit,
                artifact_id_factory=lambda: "fixture-artifact",
                asset_id_factory=lambda: AssetId(_id(400)),
                literature_asset_id_factory=lambda: LiteratureAssetId(_id(401)),
            ),
            staging=_PDF_VALIDATION_STAGING,
        )
        exhaustion = _ExhaustionPort()

        service = _service(
            source,
            publication_port=publication,
            exhaustion_port=exhaustion,
        )
        prepared = service.prepare_primary_pdf(request)
        result = service.commit_primary_pdf(prepared)

        self.assertIsInstance(result, AcquiredPrimaryPdf)
        acquired = cast(AcquiredPrimaryPdf, result)
        self.assertEqual(acquired.asset.sha256, Sha256(hashlib.sha256(_valid_pdf()).hexdigest()))
        self.assertEqual(acquired.relation.provenance.source_name, "fixture-authorized")
        self.assertEqual(acquired.relation.provenance.source_record_id, "PII:S123456789")
        self.assertEqual(exhaustion.calls, 0)
        self.assertEqual(len(commit.commands), 1)
        self.assertGreaterEqual(client.contents[0].discard_count, 1)

    def test_one_target_access_failure_does_not_hide_a_later_authorized_target(self) -> None:
        request, _evidence = _request(
            identifiers=(
                Identifier(namespace="pii", value="A"),
                Identifier(namespace="future-document", value="B"),
            )
        )
        second_target = AuthorizedLookupTarget(
            evidence_kind=AuthorizedEvidenceKind.STABLE_PROVIDER_LOCATOR,
            namespace="future-document",
            value="B",
        )
        locator = _locator("object-for-B")
        content = _MemoryContent(_valid_pdf())
        client = _ClientFake(
            (
                AuthorizedClientFailure(AuthorizedClientFailureKind.ACCESS),
                AuthorizedLookupDownloads(
                    target=second_target,
                    entitlement=AuthorizedEntitlement.GRANTED,
                    downloads=(locator,),
                ),
            ),
            (
                AuthorizedPdfDownload(
                    locator=locator,
                    content=content,
                    media_type="application/pdf",
                    safe_source_url=None,
                ),
            ),
        )
        commit = _CommitPort()
        publication = PrimaryPdfPublisher(
            ValidatedPrimaryPdfPublisher(commit),
            staging=_PDF_VALIDATION_STAGING,
        )
        exhaustion = _ExhaustionPort()
        service = _service(
            _source(client),
            publication_port=publication,
            exhaustion_port=exhaustion,
        )

        prepared = service.prepare_primary_pdf(request)
        result = service.commit_primary_pdf(prepared)

        self.assertIsInstance(result, AcquiredPrimaryPdf)
        self.assertEqual(client.lookup_calls, [_pii_target("A"), second_target])
        self.assertEqual(client.download_calls, [locator])
        self.assertEqual(exhaustion.calls, 0)
        self.assertEqual(len(commit.commands), 1)
        self.assertGreaterEqual(content.discard_count, 1)

    def test_declared_pdf_with_invalid_bytes_is_a_normal_candidate_miss_after_a2(self) -> None:
        request, _evidence = _request(
            identifiers=(Identifier(namespace="pii", value="S123456789"),)
        )
        client = _FixtureClient("success.json", payload=b"<html>not a PDF</html>")
        source = _source(client)
        commit = _CommitPort()
        publication = PrimaryPdfPublisher(
            ValidatedPrimaryPdfPublisher(commit),
            staging=_PDF_VALIDATION_STAGING,
        )
        exhaustion = _ExhaustionPort()

        service = _service(
            source,
            publication_port=publication,
            exhaustion_port=exhaustion,
        )
        prepared = service.prepare_primary_pdf(request)
        result = service.commit_primary_pdf(prepared)

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertEqual(exhaustion.calls, 1)
        self.assertEqual(commit.commands, [])

    def test_runtime_cancellation_and_temporary_cleanup_never_publish_exhaustion(self) -> None:
        request, _evidence = _request(
            identifiers=(Identifier(namespace="pii", value="S123456789"),)
        )
        cancelled_source = _source(
            _ClientFake((AuthorizedClientFailure(AuthorizedClientFailureKind.CANCELLED),))
        )
        cancelled_exhaustion = _ExhaustionPort()
        with self.assertRaises(AcquisitionFailure) as cancelled:
            _service(
                cancelled_source,
                publication_port=_NullPublicationPort(),
                exhaustion_port=cancelled_exhaustion,
            ).prepare_primary_pdf(request)
        self.assertEqual(cancelled.exception.failure.code, "acquisition-authorized-cancelled")
        self.assertEqual(cancelled_exhaustion.calls, 0)

        cleanup_client = _FixtureClient("success.json", fail_discard=True)
        cleanup_exhaustion = _ExhaustionPort()
        with self.assertRaises(AcquisitionFailure) as cleanup:
            _service(
                _source(cleanup_client),
                publication_port=_NullPublicationPort(),
                exhaustion_port=cleanup_exhaustion,
            ).prepare_primary_pdf(request)
        self.assertIn(
            cleanup.exception.failure.code,
            {"acquisition-authorized-cleanup", "acquisition-temporary-cleanup-failed"},
        )
        self.assertEqual(cleanup_exhaustion.calls, 0)

    def test_short_circuit_close_cleans_current_content_without_preparing_later_download(
        self,
    ) -> None:
        first = _locator("first")
        second = _locator("second")
        first_content = _MemoryContent(_valid_pdf())
        client = _ClientFake(
            (
                AuthorizedLookupDownloads(
                    target=_pii_target(),
                    entitlement=AuthorizedEntitlement.GRANTED,
                    downloads=(first, second),
                ),
            ),
            (
                AuthorizedPdfDownload(
                    locator=first,
                    content=first_content,
                    media_type="application/pdf",
                    safe_source_url=None,
                ),
            ),
        )
        request, evidence = _request(identifiers=(Identifier(namespace="pii", value="S123456789"),))
        iterator = _source(client)._deliveries(request, evidence, CandidateKeyTracker())
        first_delivery = next(iterator)
        self.assertEqual(first_delivery.candidate.source_name, "fixture-authorized")
        close = getattr(iterator, "close")
        close()

        self.assertEqual(client.download_calls, [first])
        self.assertEqual(first_content.discard_count, 1)

    def test_client_http_credentials_and_vendor_types_do_not_cross_public_boundary(self) -> None:
        client = _FixtureClient("success.json")
        source = _source(client)
        self.assertEqual(source.route_key, "api:fixture-authorized")
        self.assertNotIn(_PRIVATE_SENTINEL, repr(source))
        self.assertNotIn(_ENDPOINT_SENTINEL, repr(source))
        self.assertNotIn("AuthorizedPdfSource", vars(acquisition_api))
        self.assertTrue(
            {"Header", "HttpClient", "TransportRequest", "TransportResponse"}.isdisjoint(
                vars(authorized)
            )
        )
        public_fields = {name for name in source.__slots__ if not name.startswith("_")}
        self.assertEqual(public_fields, set())


if __name__ == "__main__":
    unittest.main()
