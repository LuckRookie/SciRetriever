from __future__ import annotations

import unittest
from typing import cast
from unittest import mock

from sciretriever.acquisition.authorized import (
    CORE_AUTHORIZED_CONTRACT,
    AuthorizedClientFailure,
    AuthorizedClientFailureKind,
    AuthorizedDownloadLocator,
    AuthorizedEntitlement,
    AuthorizedEvidenceKind,
    AuthorizedLookupDownloads,
    AuthorizedLookupTarget,
)
from sciretriever.acquisition.providers.core import CoreAuthorizedPdfClient
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.network.admission import AccessCoordinator, AccessFeedback
from sciretriever.network.http import HttpClient

_SECRET = "synthetic-core-secret"


class _NeverResolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        raise AssertionError(f"mocked CORE client must not resolve {hostname!r}")


class _NeverTransport:
    def send(self, *args: object, **kwargs: object) -> object:
        del args, kwargs
        raise AssertionError("mocked CORE client must not send HTTP")

    def close(self) -> None:
        pass


def _http_client() -> HttpClient:
    return HttpClient(
        resolver=_NeverResolver(),
        transport=cast(object, _NeverTransport()),  # type: ignore[arg-type]
        coordinator=AccessCoordinator(),
        max_retries=0,
    )


def _target(*, entity: str = "work", identifier: str = "143262545") -> AuthorizedLookupTarget:
    return AuthorizedLookupTarget(
        evidence_kind=AuthorizedEvidenceKind.PROVIDER_RECORD_IDENTITY,
        namespace=f"core-{entity}",
        value=identifier,
        provider_record_source="core",
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
        final_url="https://api.core.ac.uk/v3/works/143262545/download",
        headers=response_headers,
        body=body,
    )


class CoreAuthorizedPdfClientTests(unittest.TestCase):
    def test_contract_uses_only_exact_core_record_identities(self) -> None:
        self.assertEqual(CORE_AUTHORIZED_CONTRACT.required_credential_fields, ("api_key",))
        self.assertTrue(CORE_AUTHORIZED_CONTRACT.download_proves_entitlement)
        self.assertEqual(CORE_AUTHORIZED_CONTRACT.stable_locator_namespaces, ())
        self.assertEqual(CORE_AUTHORIZED_CONTRACT.doi_landing_origins, ())

        client = CoreAuthorizedPdfClient(http_client=_http_client(), api_key=_SECRET)
        lookup = client.lookup(_target())

        self.assertIsInstance(lookup, AuthorizedLookupDownloads)
        result = cast(AuthorizedLookupDownloads, lookup)
        self.assertIs(result.entitlement, AuthorizedEntitlement.UNKNOWN)
        self.assertEqual(result.downloads[0].namespace, "core-work-pdf")
        self.assertEqual(result.downloads[0].source_record_id, "work:143262545")
        self.assertNotIn(_SECRET, repr(client))

        output = cast(
            AuthorizedLookupDownloads,
            client.lookup(_target(entity="output", identifier="repository-item_1.2-3")),
        )
        self.assertEqual(output.downloads[0].value, "repository-item_1.2-3")

    def test_download_uses_private_header_and_exact_pdf_endpoint(self) -> None:
        http_client = _http_client()
        response = _response(200, body=b"%PDF-1.7 fixture", media_type="application/pdf")
        with mock.patch.object(http_client, "request", return_value=response) as request:
            client = CoreAuthorizedPdfClient(http_client=http_client, api_key=_SECRET)
            lookup = cast(AuthorizedLookupDownloads, client.lookup(_target()))
            result = client.download(lookup.downloads[0])

        self.assertIs(result.entitlement, AuthorizedEntitlement.GRANTED)  # type: ignore[union-attr]
        args, kwargs = request.call_args
        self.assertEqual(args[1], "https://api.core.ac.uk/v3/works")
        self.assertEqual(kwargs["path_parameter"], "143262545")
        self.assertEqual(kwargs["path_parameter_suffix"], "download")
        self.assertEqual(kwargs["credential_headers"], (("Authorization", f"Bearer {_SECRET}"),))
        self.assertEqual(kwargs["max_redirects"], 0)
        feedback = kwargs["response_feedback"]
        self.assertEqual(
            feedback(
                _response(
                    429,
                    headers=(
                        Header(name="Retry-After", value="5"),
                        Header(name="X-RateLimit-Retry-After", value="8"),
                        Header(name="X-RateLimit-Remaining", value="0"),
                        Header(name="X-RateLimit-Limit", value="100"),
                    ),
                )
            ),
            AccessFeedback(retry_after=8.0, throttled=True),
        )
        self.assertEqual(
            feedback(
                _response(
                    429,
                    headers=(
                        Header(name="X-RateLimit-Remaining", value="0"),
                        Header(name="x-ratelimit-remaining", value="1"),
                    ),
                )
            ),
            AccessFeedback(throttled=True),
        )
        result.content.discard()  # type: ignore[union-attr]

    def test_download_statuses_keep_miss_auth_entitlement_quota_and_service_distinct(self) -> None:
        cases = (
            (404, None),
            (401, AuthorizedClientFailureKind.AUTHENTICATION),
            (403, AuthorizedClientFailureKind.ENTITLEMENT),
            (429, AuthorizedClientFailureKind.QUOTA),
            (503, AuthorizedClientFailureKind.SERVICE),
        )
        locator = AuthorizedDownloadLocator(
            namespace="core-output-pdf",
            value="571215426",
            declared_media_type="application/pdf",
            source_record_id="output:571215426",
        )
        for status, expected in cases:
            http_client = _http_client()
            with (
                self.subTest(status=status),
                mock.patch.object(http_client, "request", return_value=_response(status)),
            ):
                client = CoreAuthorizedPdfClient(http_client=http_client, api_key=_SECRET)
                if expected is None:
                    self.assertEqual(client.download(locator).reason.value, "http-404")  # type: ignore[union-attr]
                    continue
                with self.assertRaises(AuthorizedClientFailure) as caught:
                    client.download(locator)
                self.assertIs(caught.exception.kind, expected)

    def test_network_failure_and_non_pdf_response_fail_closed(self) -> None:
        locator = AuthorizedDownloadLocator(
            namespace="core-work-pdf",
            value="143262545",
            declared_media_type="application/pdf",
            source_record_id="work:143262545",
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
                client = CoreAuthorizedPdfClient(http_client=http_client, api_key=_SECRET)
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
