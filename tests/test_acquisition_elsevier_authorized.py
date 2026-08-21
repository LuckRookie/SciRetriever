from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any, cast
from unittest import mock

from sciretriever.acquisition.authorized import (
    ELSEVIER_AUTHORIZED_CONTRACT,
    AuthorizedClientFailure,
    AuthorizedClientFailureKind,
    AuthorizedDownloadLocator,
    AuthorizedDownloadMiss,
    AuthorizedEntitlement,
    AuthorizedEvidenceKind,
    AuthorizedLookupDownloads,
    AuthorizedLookupMiss,
    AuthorizedLookupTarget,
    AuthorizedNormalMiss,
    AuthorizedPdfDownload,
    AuthorizedPdfSource,
)
from sciretriever.acquisition.outcomes import RouteOutcome
from sciretriever.acquisition.planning import (
    AccessRouteHint,
    AccessRouteHintKind,
    PublisherAccessResolver,
    ResolutionEvidence,
    ResolutionEvidenceKind,
)
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionSourceFailure,
    CandidateKeyTracker,
)
from sciretriever.acquisition.profile_catalog import (
    ELSEVIER_ACCESS_PROFILE,
    PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
)
from sciretriever.acquisition.providers.elsevier import (
    ELSEVIER_ARTICLE_ACCESS_POLICY,
    ELSEVIER_ARTICLE_ACCESS_SCOPE,
    ElsevierAuthorizedPdfClient,
)
from sciretriever.acquisition.routes import RouteExecutionContext
from sciretriever.acquisition.routing import AcquisitionRequest, build_acquisition_evidence
from sciretriever.acquisition.sources.browser_rules import PRODUCTION_BROWSER_RULE_CATALOG
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    UtcTimestamp,
)
from sciretriever.network.admission import AccessCoordinator, AccessFeedback
from sciretriever.network.http import HttpClient

_FIXTURES = Path(__file__).parent / "fixtures" / "acquisition" / "elsevier"
_API_KEY = "synthetic-elsevier-api-key"
_INSTITUTION_TOKEN = "synthetic-elsevier-institution-token"
_PII = "S0014579301033130"
_ARTICLE_EID = "1-s2.0-S0014579301033130"
_MAIN_OBJECT_EID = "1-s2.0-S0014579301033130-main.pdf"
_TIME = UtcTimestamp("2026-08-15T00:00:00Z")


class _NeverResolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        raise AssertionError(f"mocked Elsevier client must not resolve {hostname!r}")


class _NeverTransport:
    def send(self, *args: object, **kwargs: object) -> object:
        del args, kwargs
        raise AssertionError("mocked Elsevier client must not send HTTP")

    def close(self) -> None:
        pass


def _http_client() -> HttpClient:
    return HttpClient(
        resolver=_NeverResolver(),
        transport=cast(Any, _NeverTransport()),
        coordinator=AccessCoordinator(),
        max_retries=0,
    )


def _fixture(name: str) -> bytes:
    return (_FIXTURES / name).read_bytes()


def _response(
    status: int,
    *,
    body: bytes = b"",
    media_type: str | None = None,
    headers: tuple[Header, ...] = (),
    final_url: str = "https://api.elsevier.com/content/article/pii/S0014579301033130",
) -> TransportResponse:
    response_headers = headers + (
        () if media_type is None else (Header(name="Content-Type", value=media_type),)
    )
    return TransportResponse(
        status=status,
        final_url=final_url,
        headers=response_headers,
        body=body,
    )


def _stable_target(
    namespace: str = "pii",
    value: str = _PII,
) -> AuthorizedLookupTarget:
    return AuthorizedLookupTarget(
        evidence_kind=AuthorizedEvidenceKind.STABLE_PROVIDER_LOCATOR,
        namespace=namespace,
        value=value,
    )


def _doi_target() -> AuthorizedLookupTarget:
    return AuthorizedLookupTarget(
        evidence_kind=AuthorizedEvidenceKind.DOI_LANDING_ORIGIN,
        namespace="doi",
        value="10.1016/S0014-5793(01)03313-0",
        confirmed_origin="https://www.sciencedirect.com",
    )


def _locator(value: str = _MAIN_OBJECT_EID) -> AuthorizedDownloadLocator:
    return AuthorizedDownloadLocator(
        namespace="elsevier-main-pdf-object",
        value=value,
        declared_media_type="application/pdf",
        source_record_id=_ARTICLE_EID,
    )


def _direct_locator(
    *,
    namespace: str = "elsevier-article-pdf-pii",
    value: str = _PII,
) -> AuthorizedDownloadLocator:
    return AuthorizedDownloadLocator(
        namespace=namespace,
        value=value,
        declared_media_type="application/pdf",
        source_record_id=value,
    )


def _service_error_xml(status_code: str, private_message: str) -> bytes:
    return (
        "<service-error><status>"
        f"<statusCode>{status_code}</statusCode>"
        f"<statusText>{private_message}</statusText>"
        "</status></service-error>"
    ).encode()


def _request(
    *,
    namespace: str = "pii",
    value: str = _PII,
    resolved_landing_origin: str | None = None,
) -> AcquisitionRequest:
    literature = Literature(
        literature_id=LiteratureId("00000001-0000-4000-8000-000000000000"),
        meta_literature_id=MetaLiteratureId("00000002-0000-4000-8000-000000000000"),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="Elsevier authorized fixture",
            identifiers=(Identifier(namespace=namespace, value=value),),
        ),
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


def _source(client: ElsevierAuthorizedPdfClient) -> AuthorizedPdfSource:
    return AuthorizedPdfSource(
        contract=ELSEVIER_AUTHORIZED_CONTRACT,
        client=client,
        provenance_id_factory=lambda: ProvenanceId("00000003-0000-4000-8000-000000000000"),
        clock=lambda: _TIME,
    )


def _context(request: AcquisitionRequest) -> RouteExecutionContext:
    return RouteExecutionContext(
        request=request,
        evidence=build_acquisition_evidence(request),
        route_hints=(),
        candidate_keys=CandidateKeyTracker(),
    )


class ElsevierAuthorizedPdfClientTests(unittest.TestCase):
    def test_api_contract_and_profile_do_not_accept_scopus_identity(self) -> None:
        self.assertEqual(ELSEVIER_AUTHORIZED_CONTRACT.required_credential_fields, ("api_key",))
        self.assertEqual(
            ELSEVIER_AUTHORIZED_CONTRACT.stable_locator_namespaces,
            ("pii", "elsevier-article-eid"),
        )
        self.assertEqual(ELSEVIER_AUTHORIZED_CONTRACT.provider_record_identity_rules, ())
        self.assertEqual(
            ELSEVIER_AUTHORIZED_CONTRACT.download_locator_namespaces,
            (
                "elsevier-main-pdf-object",
                "elsevier-article-pdf-doi",
                "elsevier-article-pdf-pii",
                "elsevier-article-pdf-eid",
            ),
        )
        self.assertTrue(ELSEVIER_AUTHORIZED_CONTRACT.download_proves_entitlement)
        self.assertEqual(
            ELSEVIER_AUTHORIZED_CONTRACT.route_hint_profile_access_key,
            "elsevier-sciencedirect",
        )
        self.assertEqual(
            ELSEVIER_ACCESS_PROFILE.api_route_keys,
            ("api:elsevier-article-object",),
        )
        self.assertEqual(
            ELSEVIER_ACCESS_PROFILE.browser_route_key,
            "browser:elsevier-sciencedirect",
        )
        self.assertEqual(ELSEVIER_ACCESS_PROFILE.provider_record_names, ())
        self.assertEqual(
            tuple(rule.rule_id for rule in PRODUCTION_BROWSER_RULE_CATALOG.rules),
            (
                "acs-publications-pdf",
                "aip-publishing-pdf",
                "sciencedirect-pdf",
                "iopscience-pdf",
                "oxford-academic-pdf",
                "rsc-publishing-pdf",
                "science-aaas-pdf",
                "springerlink-pdf",
                "wiley-online-library-pdf",
            ),
        )

    def test_full_xml_lookup_uses_exact_doi_pii_and_article_eid_endpoints(self) -> None:
        cases = (
            (
                _doi_target(),
                "https://api.elsevier.com/content/article/doi?view=FULL",
                "10.1016/S0014-5793(01)03313-0",
            ),
            (
                _stable_target(),
                "https://api.elsevier.com/content/article/pii?view=FULL",
                _PII,
            ),
            (
                _stable_target("elsevier-article-eid", _ARTICLE_EID),
                "https://api.elsevier.com/content/article/eid?view=FULL",
                _ARTICLE_EID,
            ),
        )
        for target, endpoint, path_parameter in cases:
            http_client = _http_client()
            with (
                self.subTest(namespace=target.namespace),
                mock.patch.object(
                    http_client,
                    "request",
                    return_value=_response(
                        200,
                        body=_fixture("article-full-main.xml"),
                        media_type="application/xml;charset=UTF-8",
                    ),
                ) as request,
            ):
                client = ElsevierAuthorizedPdfClient(
                    http_client=http_client,
                    api_key=_API_KEY,
                    institution_token=_INSTITUTION_TOKEN,
                )
                result = cast(AuthorizedLookupDownloads, client.lookup(target))

                args, kwargs = request.call_args
                self.assertEqual(
                    args, (ELSEVIER_ARTICLE_ACCESS_SCOPE, endpoint, ELSEVIER_ARTICLE_ACCESS_POLICY)
                )
                self.assertEqual(kwargs["path_parameter"], path_parameter)
                self.assertEqual(
                    kwargs["headers"], (Header(name="Accept", value="application/xml"),)
                )
                self.assertEqual(
                    kwargs["credential_headers"],
                    (
                        ("X-ELS-APIKey", _API_KEY),
                        ("X-ELS-Insttoken", _INSTITUTION_TOKEN),
                    ),
                )
                self.assertEqual(kwargs["max_redirects"], 0)
                self.assertEqual(kwargs["max_response_bytes"], 32 * 1024 * 1024)
                self.assertEqual(
                    tuple(locator.value for locator in result.downloads),
                    (
                        _MAIN_OBJECT_EID,
                        "1-s2.0-S0014579301033130-main2.pdf",
                    ),
                )
                self.assertTrue(
                    all(
                        locator.namespace == "elsevier-main-pdf-object"
                        and locator.declared_media_type == "application/pdf"
                        for locator in result.downloads
                    )
                )
                self.assertIs(result.entitlement, AuthorizedEntitlement.UNKNOWN)
                self.assertEqual(
                    tuple((hint.kind, hint.namespace, hint.value) for hint in result.hints),
                    (
                        (
                            AccessRouteHintKind.CANONICAL_LANDING,
                            None,
                            f"https://www.sciencedirect.com/science/article/pii/{_PII}",
                        ),
                        (AccessRouteHintKind.STABLE_ARTICLE_ID, "pii", _PII),
                        (
                            AccessRouteHintKind.STABLE_ARTICLE_ID,
                            "elsevier-article-eid",
                            _ARTICLE_EID,
                        ),
                    ),
                )
                self.assertTrue(
                    all(
                        hint.source_route_key == "api:elsevier-article-object"
                        and hint.profile_access_key == "elsevier-sciencedirect"
                        for hint in result.hints
                    )
                )
                self.assertNotIn(_API_KEY, repr(client))
                self.assertNotIn(_INSTITUTION_TOKEN, repr(client))

    def test_lookup_accepts_no_institution_token_and_rejects_scopus_or_wrong_origin(self) -> None:
        http_client = _http_client()
        with mock.patch.object(
            http_client,
            "request",
            return_value=_response(
                200,
                body=_fixture("article-no-primary.xml"),
                media_type="application/xml",
            ),
        ) as request:
            client = ElsevierAuthorizedPdfClient(http_client=http_client, api_key=_API_KEY)
            result = cast(AuthorizedLookupDownloads, client.lookup(_stable_target()))
        self.assertEqual(
            request.call_args.kwargs["credential_headers"], (("X-ELS-APIKey", _API_KEY),)
        )
        self.assertEqual(
            tuple(locator.namespace for locator in result.downloads),
            ("elsevier-article-pdf-pii",),
        )
        self.assertEqual(len(result.hints), 3)

        invalid_targets = (
            _stable_target("elsevier-article-eid", "2-s2.0-85000000000"),
            _stable_target("scopus-eid", "2-s2.0-85000000000"),
            AuthorizedLookupTarget(
                evidence_kind=AuthorizedEvidenceKind.DOI_LANDING_ORIGIN,
                namespace="doi",
                value="10.1016/example",
                confirmed_origin="https://example.org",
            ),
        )
        client = ElsevierAuthorizedPdfClient(http_client=_http_client(), api_key=_API_KEY)
        for target in invalid_targets:
            with self.subTest(target=target), self.assertRaises(AuthorizedClientFailure) as caught:
                client.lookup(target)
            self.assertIs(caught.exception.kind, AuthorizedClientFailureKind.RESPONSE_SCHEMA)

    def test_xml_parser_excludes_non_main_arbitrary_and_supplement_objects(self) -> None:
        http_client = _http_client()
        with mock.patch.object(
            http_client,
            "request",
            return_value=_response(
                200,
                body=_fixture("article-full-main.xml"),
                media_type="application/vnd.elsevier.article+xml",
            ),
        ):
            result = cast(
                AuthorizedLookupDownloads,
                ElsevierAuthorizedPdfClient(
                    http_client=http_client,
                    api_key=_API_KEY,
                ).lookup(_stable_target()),
            )
        values = tuple(locator.value for locator in result.downloads)
        self.assertEqual(values, (_MAIN_OBJECT_EID, "1-s2.0-S0014579301033130-main2.pdf"))
        self.assertFalse(
            any(
                marker in value.casefold()
                for value in values
                for marker in ("mmc", "supplement", "graphical", "arbitrary")
            )
        )

    def test_unusable_full_xml_uses_the_exact_article_pdf_representation_fallback(
        self,
    ) -> None:
        cases = (
            (b"<broken", "application/xml", "malformed-xml"),
            (
                b'<!DOCTYPE article [<!ENTITY secret "value">]><article>&secret;</article>',
                "application/xml",
                "unsafe-xml",
            ),
            (b"<html/>", "text/html", "non-xml-representation"),
            (b"<article/>", None, "non-xml-representation"),
            (
                (
                    b"<article><web-pdf><web-pdf-purpose>MAIN</web-pdf-purpose>"
                    b"<web-pdf-purpose>SUPPLEMENT</web-pdf-purpose>"
                    b"</web-pdf></article>"
                ),
                "application/xml",
                "unexpected-envelope",
            ),
        )
        for payload, media_type, expected_envelope in cases:
            http_client = _http_client()
            with (
                self.subTest(expected_envelope=expected_envelope),
                mock.patch.object(
                    http_client,
                    "request",
                    return_value=_response(200, body=payload, media_type=media_type),
                ),
                self.assertLogs(
                    "sciretriever.acquisition.providers.elsevier",
                    level="DEBUG",
                ) as captured,
            ):
                result = cast(
                    AuthorizedLookupDownloads,
                    ElsevierAuthorizedPdfClient(
                        http_client=http_client,
                        api_key=_API_KEY,
                    ).lookup(_stable_target()),
                )
            self.assertEqual(
                result.downloads,
                (
                    AuthorizedDownloadLocator(
                        namespace="elsevier-article-pdf-pii",
                        value=_PII,
                        declared_media_type="application/pdf",
                        source_record_id=_PII,
                    ),
                ),
            )
            rendered = "\n".join(captured.output)
            self.assertIn("event=elsevier-authorized-response-classified", rendered)
            self.assertIn("stage=lookup", rendered)
            self.assertIn(f"envelope={expected_envelope}", rendered)
            self.assertIn("disposition=fallback-direct-pdf", rendered)
            self.assertNotIn(payload.decode(errors="ignore"), rendered)

    def test_xml_service_error_envelopes_preserve_miss_and_failure_categories(self) -> None:
        cases = (
            ("RESOURCE_NOT_FOUND", None),
            ("AUTHENTICATION_ERROR", AuthorizedClientFailureKind.AUTHENTICATION),
            ("AUTHORIZATION_ERROR", AuthorizedClientFailureKind.ENTITLEMENT),
            ("QUOTA_EXCEEDED", AuthorizedClientFailureKind.QUOTA),
            ("SYSTEM_ERROR", AuthorizedClientFailureKind.SERVICE),
            ("INVALID_INPUT", AuthorizedClientFailureKind.RESPONSE_SCHEMA),
            ("PRIVATE_UNKNOWN", AuthorizedClientFailureKind.RESPONSE_SCHEMA),
        )
        for index, (status_code, expected) in enumerate(cases):
            private_message = f"private-vendor-message-{index}"
            http_client = _http_client()
            client = ElsevierAuthorizedPdfClient(http_client=http_client, api_key=_API_KEY)
            with (
                self.subTest(status_code=status_code),
                mock.patch.object(
                    http_client,
                    "request",
                    return_value=_response(
                        200,
                        body=_service_error_xml(status_code, private_message),
                        media_type="application/xml",
                    ),
                ) as request,
                self.assertLogs(
                    "sciretriever.acquisition.providers.elsevier",
                    level="DEBUG",
                ) as captured,
            ):
                if expected is None:
                    result = client.lookup(_stable_target())
                    self.assertIsInstance(result, AuthorizedLookupMiss)
                    assert isinstance(result, AuthorizedLookupMiss)
                    self.assertIs(result.reason, AuthorizedNormalMiss.HTTP_404)
                else:
                    with self.assertRaises(AuthorizedClientFailure) as caught:
                        client.lookup(_stable_target())
                    self.assertIs(caught.exception.kind, expected)
            self.assertEqual(request.call_count, 1)
            rendered = "\n".join(captured.output)
            self.assertIn("envelope=service-error", rendered)
            self.assertNotIn(status_code, rendered)
            self.assertNotIn(private_message, rendered)
            self.assertNotIn(_API_KEY, rendered)

    def test_lookup_and_download_statuses_preserve_miss_auth_entitlement_quota_and_service(
        self,
    ) -> None:
        cases = (
            (404, None),
            (401, AuthorizedClientFailureKind.AUTHENTICATION),
            (403, AuthorizedClientFailureKind.ENTITLEMENT),
            (429, AuthorizedClientFailureKind.QUOTA),
            (503, AuthorizedClientFailureKind.SERVICE),
            (400, AuthorizedClientFailureKind.RESPONSE_SCHEMA),
        )
        for operation in ("lookup", "download"):
            for status, expected in cases:
                http_client = _http_client()
                client = ElsevierAuthorizedPdfClient(http_client=http_client, api_key=_API_KEY)
                with (
                    self.subTest(operation=operation, status=status),
                    mock.patch.object(
                        http_client,
                        "request",
                        return_value=_response(
                            status,
                            body=b"private-status-body-sentinel",
                            headers=(
                                Header(
                                    name="X-ELS-Status",
                                    value=(
                                        "QUOTA_EXCEEDED"
                                        if status == 429
                                        else "private-vendor-status-sentinel"
                                    ),
                                ),
                            ),
                        ),
                    ),
                    self.assertLogs(
                        "sciretriever.acquisition.providers.elsevier",
                        level="DEBUG",
                    ) as captured,
                ):
                    if expected is None:
                        result = (
                            client.lookup(_stable_target())
                            if operation == "lookup"
                            else client.download(_locator())
                        )
                        self.assertIsInstance(
                            result, (AuthorizedLookupMiss, AuthorizedDownloadMiss)
                        )
                        if isinstance(result, (AuthorizedLookupMiss, AuthorizedDownloadMiss)):
                            self.assertIs(result.reason, AuthorizedNormalMiss.HTTP_404)
                    else:
                        with self.assertRaises(AuthorizedClientFailure) as caught:
                            if operation == "lookup":
                                client.lookup(_stable_target())
                            else:
                                client.download(_locator())
                        self.assertIs(caught.exception.kind, expected)
                rendered = "\n".join(captured.output)
                self.assertIn(f"http_status={status}", rendered)
                self.assertIn(
                    "http_status_class=" + ("client-error" if status < 500 else "server-error"),
                    rendered,
                )
                self.assertNotIn("private-status-body-sentinel", rendered)
                self.assertNotIn("private-vendor-status-sentinel", rendered)
                self.assertNotIn(_API_KEY, rendered)

        http_client = _http_client()
        with (
            mock.patch.object(
                http_client,
                "request",
                return_value=_response(
                    307,
                    body=b"private-redirection-body-sentinel",
                    headers=(Header(name="X-ELS-Status", value="private-redirection-status"),),
                ),
            ),
            self.assertLogs(
                "sciretriever.acquisition.providers.elsevier",
                level="DEBUG",
            ) as captured,
            self.assertRaises(AuthorizedClientFailure) as caught,
        ):
            ElsevierAuthorizedPdfClient(
                http_client=http_client,
                api_key=_API_KEY,
            ).lookup(_stable_target())
        self.assertIs(caught.exception.kind, AuthorizedClientFailureKind.RESPONSE_SCHEMA)
        rendered = "\n".join(captured.output)
        self.assertIn("http_status=307", rendered)
        self.assertIn("http_status_class=redirection", rendered)
        self.assertNotIn("private-redirection-body-sentinel", rendered)
        self.assertNotIn("private-redirection-status", rendered)

        for status_text, expected in (
            ("QUOTA_EXCEEDED", AuthorizedClientFailureKind.QUOTA),
            ("NOT_ENTITLED", AuthorizedClientFailureKind.ENTITLEMENT),
            ("AUTHENTICATION_ERROR", AuthorizedClientFailureKind.AUTHENTICATION),
        ):
            http_client = _http_client()
            with (
                self.subTest(status_text=status_text),
                mock.patch.object(
                    http_client,
                    "request",
                    return_value=_response(
                        200,
                        headers=(Header(name="X-ELS-Status", value=status_text),),
                    ),
                ),
                self.assertRaises(AuthorizedClientFailure) as caught,
            ):
                ElsevierAuthorizedPdfClient(
                    http_client=http_client,
                    api_key=_API_KEY,
                ).lookup(_stable_target())
            self.assertIs(caught.exception.kind, expected)

    def test_object_download_uses_same_scope_private_headers_and_no_content_threshold(self) -> None:
        http_client = _http_client()
        payload = b"x"
        response = _response(
            200,
            body=payload,
            media_type="application/pdf",
            final_url=f"https://api.elsevier.com/content/object/eid/{_MAIN_OBJECT_EID}",
        )
        with mock.patch.object(http_client, "request", return_value=response) as request:
            result = cast(
                AuthorizedPdfDownload,
                ElsevierAuthorizedPdfClient(
                    http_client=http_client,
                    api_key=_API_KEY,
                    institution_token=_INSTITUTION_TOKEN,
                ).download(_locator()),
            )

        args, kwargs = request.call_args
        self.assertEqual(
            args,
            (
                ELSEVIER_ARTICLE_ACCESS_SCOPE,
                "https://api.elsevier.com/content/object/eid",
                ELSEVIER_ARTICLE_ACCESS_POLICY,
            ),
        )
        self.assertEqual(kwargs["path_parameter"], _MAIN_OBJECT_EID)
        self.assertEqual(kwargs["headers"], (Header(name="Accept", value="application/pdf"),))
        self.assertEqual(
            kwargs["credential_headers"],
            (
                ("X-ELS-APIKey", _API_KEY),
                ("X-ELS-Insttoken", _INSTITUTION_TOKEN),
            ),
        )
        self.assertEqual(kwargs["max_response_bytes"], 64 * 1024 * 1024)
        self.assertEqual(kwargs["max_redirects"], 0)
        self.assertIs(result.entitlement, AuthorizedEntitlement.GRANTED)
        self.assertEqual(result.media_type, "application/pdf")
        with result.content.open() as stream:
            self.assertEqual(stream.read(), payload)
        result.content.discard()

    def test_direct_article_pdf_download_uses_the_exact_verified_identity_endpoint(
        self,
    ) -> None:
        cases = (
            (
                _direct_locator(
                    namespace="elsevier-article-pdf-doi",
                    value="10.1016/S0014-5793(01)03313-0",
                ),
                "https://api.elsevier.com/content/article/doi?view=FULL",
                "10.1016/S0014-5793(01)03313-0",
            ),
            (
                _direct_locator(),
                "https://api.elsevier.com/content/article/pii?view=FULL",
                _PII,
            ),
            (
                _direct_locator(
                    namespace="elsevier-article-pdf-eid",
                    value=_ARTICLE_EID,
                ),
                "https://api.elsevier.com/content/article/eid?view=FULL",
                _ARTICLE_EID,
            ),
        )
        for locator, endpoint, path_parameter in cases:
            http_client = _http_client()
            payload = b"%PDF-1.7 synthetic candidate for unified validation"
            with (
                self.subTest(namespace=locator.namespace),
                mock.patch.object(
                    http_client,
                    "request",
                    return_value=_response(
                        200,
                        body=payload,
                        media_type="application/pdf",
                    ),
                ) as request,
            ):
                result = cast(
                    AuthorizedPdfDownload,
                    ElsevierAuthorizedPdfClient(
                        http_client=http_client,
                        api_key=_API_KEY,
                        institution_token=_INSTITUTION_TOKEN,
                    ).download(locator),
                )

            args, kwargs = request.call_args
            self.assertEqual(
                args,
                (
                    ELSEVIER_ARTICLE_ACCESS_SCOPE,
                    endpoint,
                    ELSEVIER_ARTICLE_ACCESS_POLICY,
                ),
            )
            self.assertEqual(kwargs["path_parameter"], path_parameter)
            self.assertEqual(kwargs["headers"], (Header(name="Accept", value="application/pdf"),))
            self.assertEqual(result.locator, locator)
            self.assertEqual(result.media_type, "application/pdf")
            with result.content.open() as stream:
                self.assertEqual(stream.read(), payload)
            result.content.discard()

    def test_download_xml_service_error_is_classified_before_pdf_validation(self) -> None:
        cases = (
            ("RESOURCE_NOT_FOUND", None),
            ("AUTHENTICATION_ERROR", AuthorizedClientFailureKind.AUTHENTICATION),
            ("AUTHORIZATION_ERROR", AuthorizedClientFailureKind.ENTITLEMENT),
            ("QUOTA_EXCEEDED", AuthorizedClientFailureKind.QUOTA),
            ("SYSTEM_ERROR", AuthorizedClientFailureKind.SERVICE),
            ("INVALID_INPUT", AuthorizedClientFailureKind.RESPONSE_SCHEMA),
        )
        for index, (status_code, expected) in enumerate(cases):
            private_message = f"private-object-error-{index}"
            http_client = _http_client()
            with (
                self.subTest(status_code=status_code),
                mock.patch.object(
                    http_client,
                    "request",
                    return_value=_response(
                        200,
                        body=_service_error_xml(status_code, private_message),
                        media_type="application/xml",
                    ),
                ),
                self.assertLogs(
                    "sciretriever.acquisition.providers.elsevier",
                    level="DEBUG",
                ) as captured,
            ):
                client = ElsevierAuthorizedPdfClient(
                    http_client=http_client,
                    api_key=_API_KEY,
                )
                if expected is None:
                    result = client.download(_direct_locator())
                    self.assertIsInstance(result, AuthorizedDownloadMiss)
                    assert isinstance(result, AuthorizedDownloadMiss)
                    self.assertIs(result.reason, AuthorizedNormalMiss.HTTP_404)
                else:
                    with self.assertRaises(AuthorizedClientFailure) as caught:
                        client.download(_direct_locator())
                    self.assertIs(caught.exception.kind, expected)
            rendered = "\n".join(captured.output)
            self.assertIn("stage=download", rendered)
            self.assertIn("envelope=service-error", rendered)
            self.assertNotIn(status_code, rendered)
            self.assertNotIn(private_message, rendered)
            self.assertNotIn(_API_KEY, rendered)

    def test_download_rejects_invalid_object_identity_or_namespace(self) -> None:
        client = ElsevierAuthorizedPdfClient(http_client=_http_client(), api_key=_API_KEY)
        for invalid in (
            AuthorizedDownloadLocator(
                namespace="elsevier-main-pdf-object",
                value="2-s2.0-85000000000",
                declared_media_type="application/pdf",
                source_record_id=None,
            ),
            AuthorizedDownloadLocator(
                namespace="elsevier-supplement-object",
                value=_MAIN_OBJECT_EID,
                declared_media_type="application/pdf",
                source_record_id=None,
            ),
        ):
            with (
                self.subTest(invalid=invalid),
                self.assertRaises(AuthorizedClientFailure) as caught,
            ):
                client.download(invalid)
            self.assertIs(caught.exception.kind, AuthorizedClientFailureKind.RESPONSE_SCHEMA)

    def test_official_rate_policy_and_feedback_are_conservative_and_fail_closed(self) -> None:
        self.assertEqual(ELSEVIER_ARTICLE_ACCESS_POLICY.max_concurrency, 1)
        self.assertEqual(ELSEVIER_ARTICLE_ACCESS_POLICY.min_start_interval, 0.1)
        self.assertEqual(ELSEVIER_ARTICLE_ACCESS_POLICY.burst_limit, 50_000)
        self.assertEqual(ELSEVIER_ARTICLE_ACCESS_POLICY.window_seconds, 604_800.0)

        http_client = _http_client()
        with mock.patch.object(
            http_client,
            "request",
            return_value=_response(404),
        ) as request:
            ElsevierAuthorizedPdfClient(http_client=http_client, api_key=_API_KEY).lookup(
                _stable_target()
            )
        feedback = request.call_args.kwargs["response_feedback"]
        with self.assertLogs(
            "sciretriever.acquisition.providers.elsevier",
            level="DEBUG",
        ) as captured:
            retry_feedback = feedback(
                _response(
                    429,
                    headers=(
                        Header(name="Retry-After", value="7"),
                        Header(name="X-RateLimit-Remaining", value="0"),
                        Header(name="X-RateLimit-Limit", value="50000"),
                    ),
                )
            )
            quota = feedback(
                _response(
                    200,
                    headers=(
                        Header(name="X-RateLimit-Remaining", value="49999"),
                        Header(name="X-RateLimit-Limit", value="50000"),
                        Header(name="X-RateLimit-Reset", value="4102444800"),
                    ),
                )
            )
            conflicting_feedback = feedback(
                _response(
                    200,
                    headers=(
                        Header(name="X-RateLimit-Remaining", value="1"),
                        Header(name="x-ratelimit-remaining", value="2"),
                    ),
                )
            )
            service_feedback = feedback(_response(503))
        self.assertEqual(
            retry_feedback,
            AccessFeedback(retry_after=7.0, throttled=True),
        )
        self.assertIsNotNone(quota)
        assert quota is not None
        self.assertEqual(quota.quota_remaining, 49_999)
        self.assertEqual(quota.quota_limit, 50_000)
        self.assertIsNotNone(quota.quota_reset_at)
        self.assertFalse(quota.throttled)
        self.assertEqual(
            conflicting_feedback,
            AccessFeedback(throttled=True),
        )
        self.assertEqual(service_feedback, AccessFeedback(throttled=True))
        log_output = "\n".join(captured.output)
        self.assertIn("event=authorized-quota-feedback", log_output)
        self.assertIn("provider_group=elsevier", log_output)
        self.assertIn("route_key=api:elsevier-article-object", log_output)
        self.assertIn("quota_remaining=49999", log_output)
        self.assertIn("quota_limit=50000", log_output)
        self.assertNotIn(_API_KEY, log_output)
        self.assertNotIn(_INSTITUTION_TOKEN, log_output)

    def test_network_and_credential_failures_are_closed_and_secret_free(self) -> None:
        http_client = _http_client()
        for response, expected in (
            (
                AccessFailure(
                    code="timeout",
                    reason="bounded access failed",
                    action="retry",
                    retryable=True,
                ),
                AuthorizedClientFailureKind.ACCESS,
            ),
            (
                AccessFailure(
                    code="cancelled",
                    reason="cancelled",
                    action="stop",
                    retryable=False,
                ),
                AuthorizedClientFailureKind.CANCELLED,
            ),
        ):
            with (
                self.subTest(expected=expected),
                mock.patch.object(http_client, "request", return_value=response),
                self.assertRaises(AuthorizedClientFailure) as caught,
            ):
                ElsevierAuthorizedPdfClient(
                    http_client=http_client,
                    api_key=_API_KEY,
                ).lookup(_stable_target())
            self.assertIs(caught.exception.kind, expected)

        for api_key, institution_token in (
            ("", None),
            ("  ", None),
            ("key\nvalue", None),
            (_API_KEY, "token\nvalue"),
        ):
            with self.subTest(api_key=repr(api_key)), self.assertRaises((TypeError, ValueError)):
                ElsevierAuthorizedPdfClient(
                    http_client=_http_client(),
                    api_key=api_key,
                    institution_token=institution_token,
                )


class ElsevierAuthorizedSourceTests(unittest.TestCase):
    def test_source_emits_safe_hints_with_pdf_and_leaves_bytes_for_unified_validation(self) -> None:
        http_client = _http_client()
        with mock.patch.object(
            http_client,
            "request",
            side_effect=(
                _response(
                    200,
                    body=_fixture("article-full-main.xml"),
                    media_type="application/xml",
                ),
                _response(
                    200,
                    body=b"tiny-payload-for-downstream-pdf-reader",
                    media_type="application/pdf",
                    final_url=f"https://api.elsevier.com/content/object/eid/{_MAIN_OBJECT_EID}",
                ),
                _response(404),
            ),
        ):
            source = _source(
                ElsevierAuthorizedPdfClient(
                    http_client=http_client,
                    api_key=_API_KEY,
                )
            )
            results = tuple(source.execute(_context(_request())))

        self.assertEqual(tuple(result.outcome for result in results), (RouteOutcome.PDF_DELIVERED,))
        delivered = results[0]
        self.assertEqual(len(delivered.hints), 3)
        self.assertIsNotNone(delivered.temporary_pdf)
        temporary = delivered.temporary_pdf
        assert temporary is not None
        self.assertEqual(temporary.candidate.source_name, "elsevier")
        self.assertEqual(temporary.candidate.declared_media_type, "application/pdf")
        with temporary.content.open() as stream:
            self.assertEqual(stream.read(), b"tiny-payload-for-downstream-pdf-reader")
        temporary.content.discard()

    def test_normal_no_primary_preserves_hints_for_later_browser_planning(self) -> None:
        http_client = _http_client()
        with mock.patch.object(
            http_client,
            "request",
            side_effect=(
                _response(
                    200,
                    body=_fixture("article-no-primary.xml"),
                    media_type="application/xml",
                ),
                _response(404),
            ),
        ) as request:
            results = tuple(
                _source(
                    ElsevierAuthorizedPdfClient(
                        http_client=http_client,
                        api_key=_API_KEY,
                    )
                ).execute(_context(_request()))
            )

        self.assertEqual(request.call_count, 2)
        self.assertEqual(tuple(result.outcome for result in results), (RouteOutcome.HINTS,))
        self.assertEqual(len(results[0].hints), 3)
        self.assertTrue(
            all(hint.profile_access_key == "elsevier-sciencedirect" for hint in results[0].hints)
        )
        self.assertEqual(
            ELSEVIER_ACCESS_PROFILE.browser_route_key,
            "browser:elsevier-sciencedirect",
        )

    def test_source_falls_back_from_unusable_xml_to_direct_article_pdf(self) -> None:
        http_client = _http_client()
        private_payload = b"<broken-private-article-response"
        pdf_payload = b"%PDF-1.7 candidate for the unified validator"
        with (
            mock.patch.object(
                http_client,
                "request",
                side_effect=(
                    _response(
                        200,
                        body=private_payload,
                        media_type="application/xml",
                    ),
                    _response(
                        200,
                        body=pdf_payload,
                        media_type="application/pdf",
                    ),
                ),
            ) as request,
            self.assertLogs(
                "sciretriever.acquisition.providers.elsevier",
                level="DEBUG",
            ) as captured,
        ):
            results = tuple(
                _source(
                    ElsevierAuthorizedPdfClient(
                        http_client=http_client,
                        api_key=_API_KEY,
                    )
                ).execute(_context(_request()))
            )

        self.assertEqual(request.call_count, 2)
        self.assertEqual(tuple(result.outcome for result in results), (RouteOutcome.PDF_DELIVERED,))
        temporary = results[0].temporary_pdf
        self.assertIsNotNone(temporary)
        assert temporary is not None
        with temporary.content.open() as stream:
            self.assertEqual(stream.read(), pdf_payload)
        temporary.content.discard()
        rendered = "\n".join(captured.output)
        self.assertIn("envelope=malformed-xml", rendered)
        self.assertIn("disposition=fallback-direct-pdf", rendered)
        self.assertIn("stage=download", rendered)
        self.assertIn("envelope=pdf", rendered)
        self.assertNotIn(private_payload.decode(), rendered)
        self.assertNotIn(_API_KEY, rendered)

    def test_generic_source_rejects_non_pdf_object_and_misbound_route_hints(self) -> None:
        http_client = _http_client()
        with (
            mock.patch.object(
                http_client,
                "request",
                side_effect=(
                    _response(
                        200,
                        body=_fixture("article-full-main.xml"),
                        media_type="application/xml",
                    ),
                    _response(200, body=b"<html/>", media_type="text/html"),
                    _response(404),
                ),
            ),
            self.assertRaises(AcquisitionSourceFailure) as caught,
        ):
            tuple(
                _source(
                    ElsevierAuthorizedPdfClient(
                        http_client=http_client,
                        api_key=_API_KEY,
                    )
                ).execute(_context(_request()))
            )
        self.assertEqual(caught.exception.failure.code, "acquisition-authorized-non-pdf-product")

        client = ElsevierAuthorizedPdfClient(http_client=_http_client(), api_key=_API_KEY)
        target = _stable_target()
        bad_hint = AccessRouteHint(
            kind=AccessRouteHintKind.STABLE_ARTICLE_ID,
            value=_PII,
            source_route_key="api:wrong-route",
            profile_access_key="elsevier-sciencedirect",
            namespace="pii",
        )
        with (
            mock.patch.object(
                ElsevierAuthorizedPdfClient,
                "lookup",
                return_value=AuthorizedLookupMiss(
                    target=target,
                    reason=AuthorizedNormalMiss.NO_PRIMARY,
                    hints=(bad_hint,),
                ),
            ),
            self.assertRaises(AcquisitionSourceFailure) as hint_failure,
        ):
            tuple(_source(client).execute(_context(_request())))
        self.assertEqual(
            hint_failure.exception.failure.code,
            "acquisition-authorized-response-schema",
        )


class ElsevierPublisherResolutionTests(unittest.TestCase):
    def test_only_landing_asset_pii_or_article_eid_strongly_resolve_profile(self) -> None:
        cases = (
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                value="https://www.sciencedirect.com",
                source="doi-landing",
            ),
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.ASSET_ORIGIN,
                value="https://pdf.sciencedirectassets.com",
                source="asset-hint",
            ),
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.STABLE_PROVIDER_LOCATOR,
                value=_PII,
                source="metadata",
                namespace="pii",
            ),
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.STABLE_PROVIDER_LOCATOR,
                value=_ARTICLE_EID,
                source="metadata",
                namespace="elsevier-article-eid",
            ),
        )
        resolver = PublisherAccessResolver(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG)
        for evidence in cases:
            with self.subTest(kind=evidence.kind, namespace=evidence.namespace):
                resolution = resolver.resolve((evidence,))
                self.assertEqual(resolution.access_key, "elsevier-sciencedirect")
                self.assertEqual(resolution.selected_evidence_kind, evidence.kind)

    def test_scopus_record_and_weak_elsevier_text_do_not_prove_access_provider(self) -> None:
        resolver = PublisherAccessResolver(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG)
        for evidence in (
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.PROVIDER_RECORD_IDENTITY,
                value="2-s2.0-85000000000",
                source="metadata",
                namespace="elsevier",
            ),
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.STABLE_PROVIDER_LOCATOR,
                value="2-s2.0-85000000000",
                source="metadata",
                namespace="scopus-eid",
            ),
        ):
            with self.subTest(namespace=evidence.namespace):
                resolution = resolver.resolve((evidence,))
                self.assertIsNone(resolution.access_key)
                self.assertEqual(resolution.weak_candidate_keys, ())

        weak = resolver.resolve(
            (
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.DOI_PREFIX,
                    value="10.1016",
                    source="metadata",
                ),
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.PUBLISHER_TEXT,
                    value="Elsevier",
                    source="metadata",
                ),
            )
        )
        self.assertIsNone(weak.access_key)
        self.assertEqual(weak.weak_candidate_keys, ("elsevier-sciencedirect",))


if __name__ == "__main__":
    unittest.main()
