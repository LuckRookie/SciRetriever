from __future__ import annotations

import unittest
from typing import cast
from unittest import mock

from sciretriever.acquisition.authorized import (
    WILEY_AUTHORIZED_CONTRACT,
    AuthorizedClientFailure,
    AuthorizedClientFailureKind,
    AuthorizedDownloadLocator,
    AuthorizedEntitlement,
    AuthorizedEvidenceKind,
    AuthorizedLookupDownloads,
    AuthorizedLookupTarget,
)
from sciretriever.acquisition.planning import (
    AcquisitionPlanBuilder,
    PublisherAccessResolver,
    ResolutionEvidence,
    ResolutionEvidenceKind,
    RouteCapability,
    RouteReadiness,
    RouteSpec,
)
from sciretriever.acquisition.profile_catalog import (
    PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    WILEY_ACCESS_PROFILE,
)
from sciretriever.acquisition.providers.wiley import (
    WILEY_ACCESS_POLICY,
    WileyAuthorizedPdfClient,
)
from sciretriever.acquisition.sources.browser_rules import PRODUCTION_BROWSER_RULE_CATALOG
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.acquisition import AcquisitionPath
from sciretriever.network.admission import AccessCoordinator, AccessFeedback
from sciretriever.network.http import HttpClient

_SECRET = "synthetic-wiley-tdm-token"


class _NeverResolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        raise AssertionError(f"mocked Wiley client must not resolve {hostname!r}")


class _NeverTransport:
    def send(self, *args: object, **kwargs: object) -> object:
        del args, kwargs
        raise AssertionError("mocked Wiley client must not send HTTP")

    def close(self) -> None:
        pass


def _http_client() -> HttpClient:
    return HttpClient(
        resolver=_NeverResolver(),
        transport=cast(object, _NeverTransport()),  # type: ignore[arg-type]
        coordinator=AccessCoordinator(),
        max_retries=0,
    )


def _target(doi: str = "10.1002/(SICI)1234-5678") -> AuthorizedLookupTarget:
    return AuthorizedLookupTarget(
        evidence_kind=AuthorizedEvidenceKind.DOI_LANDING_ORIGIN,
        namespace="doi",
        value=doi,
        resolved_landing_origin="https://onlinelibrary.wiley.com",
    )


def _response(
    status: int,
    *,
    body: bytes = b"",
    media_type: str | None = None,
    headers: tuple[Header, ...] = (),
) -> TransportResponse:
    response_headers = headers + (
        () if media_type is None else (Header(name="Content-Type", value=media_type),)
    )
    return TransportResponse(
        status=status,
        final_url=(
            "https://api.wiley.com/onlinelibrary/tdm/v1/articles/10.1002%2F%28SICI%291234-5678"
        ),
        headers=response_headers,
        body=body,
    )


class WileyAuthorizedPdfClientTests(unittest.TestCase):
    def test_profile_keeps_tdm_api_ready_and_browser_unregistered(self) -> None:
        self.assertEqual(WILEY_ACCESS_PROFILE.api_route_keys, ("api:wiley-tdm-v1",))
        self.assertIsNone(WILEY_ACCESS_PROFILE.browser_route_key)
        self.assertEqual(PRODUCTION_BROWSER_RULE_CATALOG.rules, ())
        resolution = PublisherAccessResolver(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG).resolve(
            (
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                    value="https://onlinelibrary.wiley.com",
                    source="doi-landing",
                ),
            )
        )
        builder = AcquisitionPlanBuilder(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG)
        api_route = RouteSpec(
            route_key="api:wiley-tdm-v1",
            tier=AcquisitionPath.AUTHORIZED_PROVIDER_API,
            capability=RouteCapability.DIRECT_PDF,
            readiness=RouteReadiness.READY,
            profile_access_key="wiley-online-library",
            quota_group="wiley-api",
        )
        plan = builder.build(resolution=resolution, route_specs=(api_route,))
        self.assertEqual(plan.routes, (api_route,))
        browser_route = RouteSpec(
            route_key="browser:wiley-online-library",
            tier=AcquisitionPath.CONTROLLED_BROWSER,
            capability=RouteCapability.BROWSER_PDF,
            readiness=RouteReadiness.READY,
            profile_access_key="wiley-online-library",
            risk_group="wiley-online-library",
        )
        with self.assertRaisesRegex(ValueError, "risk group"):
            builder.build(resolution=resolution, route_specs=(browser_route,))

    def test_contract_requires_exact_resolved_wol_doi_evidence(self) -> None:
        self.assertEqual(
            WILEY_AUTHORIZED_CONTRACT.required_credential_fields,
            ("tdm_api_token",),
        )
        self.assertEqual(
            WILEY_AUTHORIZED_CONTRACT.doi_landing_origins,
            ("https://onlinelibrary.wiley.com",),
        )
        self.assertTrue(WILEY_AUTHORIZED_CONTRACT.download_proves_entitlement)

        client = WileyAuthorizedPdfClient(http_client=_http_client(), tdm_api_token=_SECRET)
        lookup = cast(AuthorizedLookupDownloads, client.lookup(_target()))

        self.assertIs(lookup.entitlement, AuthorizedEntitlement.UNKNOWN)
        self.assertEqual(lookup.downloads[0].namespace, "wiley-tdm-pdf")
        self.assertEqual(lookup.downloads[0].source_record_id, "10.1002/(SICI)1234-5678")
        self.assertNotIn(_SECRET, repr(client))

        wrong_origin = AuthorizedLookupTarget(
            evidence_kind=AuthorizedEvidenceKind.DOI_LANDING_ORIGIN,
            namespace="doi",
            value="10.1002/example",
            resolved_landing_origin="https://example.org",
        )
        with self.assertRaises(AuthorizedClientFailure):
            client.lookup(wrong_origin)

    def test_download_uses_private_token_and_network_owned_doi_encoding(self) -> None:
        http_client = _http_client()
        response = _response(200, body=b"%PDF-1.7 fixture", media_type="application/pdf")
        with mock.patch.object(http_client, "request", return_value=response) as request:
            client = WileyAuthorizedPdfClient(
                http_client=http_client,
                tdm_api_token=_SECRET,
            )
            lookup = cast(AuthorizedLookupDownloads, client.lookup(_target()))
            result = client.download(lookup.downloads[0])

        self.assertIs(result.entitlement, AuthorizedEntitlement.GRANTED)  # type: ignore[union-attr]
        self.assertIsNone(result.safe_source_url)  # type: ignore[union-attr]
        args, kwargs = request.call_args
        self.assertEqual(
            args[1],
            "https://api.wiley.com/onlinelibrary/tdm/v1/articles",
        )
        self.assertEqual(kwargs["path_parameter"], "10.1002/(SICI)1234-5678")
        self.assertEqual(
            kwargs["credential_headers"],
            (("Wiley-TDM-Client-Token", _SECRET),),
        )
        self.assertEqual(kwargs["max_redirects"], 1)
        self.assertIs(kwargs["allow_guarded_redirect_encoded_path_separators"], True)
        redirect_guard = kwargs["redirect_target_guard"]
        self.assertTrue(callable(redirect_guard))
        redirect_guard("https://alm.wiley.com/alm/api/v2/download/synthetic%2Fopaque%3Dlocator")
        for target in (
            "https://other.test/alm/api/v2/download/synthetic%2Flocator",
            "https://alm.wiley.com/other/download/synthetic%2Flocator",
            "https://alm.wiley.com/alm/api/v2/download/synthetic%2Flocator?secret=value",
        ):
            with self.subTest(target=target), self.assertRaises(ValueError):
                redirect_guard(target)
        self.assertEqual(WILEY_ACCESS_POLICY.max_concurrency, 3)
        self.assertEqual(WILEY_ACCESS_POLICY.burst_limit, 60)
        self.assertEqual(WILEY_ACCESS_POLICY.window_seconds, 600.0)
        feedback = kwargs["response_feedback"]
        self.assertEqual(
            feedback(
                _response(
                    429,
                    headers=(Header(name="Retry-After", value="7"),),
                )
            ),
            AccessFeedback(retry_after=7.0, throttled=True),
        )
        self.assertEqual(
            feedback(_response(503)),
            AccessFeedback(throttled=True),
        )
        result.content.discard()  # type: ignore[union-attr]

    def test_statuses_keep_miss_auth_entitlement_quota_and_service_distinct(self) -> None:
        cases = (
            (404, None),
            (401, AuthorizedClientFailureKind.AUTHENTICATION),
            (403, AuthorizedClientFailureKind.ENTITLEMENT),
            (429, AuthorizedClientFailureKind.QUOTA),
            (503, AuthorizedClientFailureKind.SERVICE),
            (400, AuthorizedClientFailureKind.RESPONSE_SCHEMA),
        )
        locator = AuthorizedDownloadLocator(
            namespace="wiley-tdm-pdf",
            value="10.1002/example",
            declared_media_type="application/pdf",
            source_record_id="10.1002/example",
        )
        for status, expected in cases:
            http_client = _http_client()
            with (
                self.subTest(status=status),
                mock.patch.object(http_client, "request", return_value=_response(status)),
            ):
                client = WileyAuthorizedPdfClient(
                    http_client=http_client,
                    tdm_api_token=_SECRET,
                )
                if expected is None:
                    self.assertEqual(client.download(locator).reason.value, "http-404")  # type: ignore[union-attr]
                    continue
                with self.assertRaises(AuthorizedClientFailure) as caught:
                    client.download(locator)
                self.assertIs(caught.exception.kind, expected)

    def test_token_shape_is_provider_owned_and_unsafe_local_values_fail_closed(self) -> None:
        client = WileyAuthorizedPdfClient(
            http_client=_http_client(),
            tdm_api_token="not-a-uuid",
        )
        self.assertNotIn("not-a-uuid", repr(client))
        for invalid in ("", "   ", "token\nvalue"):
            with self.subTest(invalid=invalid), self.assertRaises((TypeError, ValueError)):
                WileyAuthorizedPdfClient(http_client=_http_client(), tdm_api_token=invalid)

    def test_network_failure_and_non_pdf_response_reach_neutral_validation(self) -> None:

        locator = AuthorizedDownloadLocator(
            namespace="wiley-tdm-pdf",
            value="10.1002/example",
            declared_media_type="application/pdf",
            source_record_id="10.1002/example",
        )
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
            (_response(200, body=b"<html/>", media_type="text/html"), None),
        ):
            http_client = _http_client()
            with mock.patch.object(http_client, "request", return_value=response):
                client = WileyAuthorizedPdfClient(
                    http_client=http_client,
                    tdm_api_token=_SECRET,
                )
                if expected is not None:
                    with self.assertRaises(AuthorizedClientFailure) as caught:
                        client.download(locator)
                    self.assertIs(caught.exception.kind, expected)
                    continue
                download = client.download(locator)
                self.assertEqual(download.media_type, "text/html")  # type: ignore[union-attr]
                download.content.discard()  # type: ignore[union-attr]


if __name__ == "__main__":
    unittest.main()
