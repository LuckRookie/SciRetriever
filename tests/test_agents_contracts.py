from __future__ import annotations

import unittest

from pydantic import BaseModel, ValidationError

from sciretriever.agents.api import (
    AgentCall,
    AgentCapability,
    AgentProvenance,
    AgentRole,
    AgentStructuredResult,
    AgentTextPart,
)
from sciretriever.model.access import (
    AccessFailure,
    BoundedByteStream,
    BrowserCapture,
    BrowserCaptureBatch,
    BrowserCaptureKind,
    BrowserRequest,
    Header,
    TransportRequest,
    TransportResponse,
)
from sciretriever.model.primitives import ProvenanceId, Sha256

_HASH = Sha256("a" * 64)
_ID = ProvenanceId("123e4567-e89b-12d3-a456-426614174000")


def _strict_model_contract(model: type[BaseModel]) -> None:
    assert model.__module__ in {
        "sciretriever.model.access",
        "sciretriever.model.access",
    }
    assert model.model_config.get("frozen") is True
    assert model.model_config.get("strict") is True
    assert model.model_config.get("extra") == "forbid"


class AccessModelTests(unittest.TestCase):
    def test_neutral_access_models_round_trip_and_are_bounded(self) -> None:
        header = Header(name="Accept", value="application/pdf")
        stream = BoundedByteStream(
            chunks=(b"%PDF", b"-fixture"),
            media_type="application/pdf",
            final_locator="opaque:download-result",
            size=12,
        )
        request = TransportRequest(
            method="GET",
            url="opaque:request",
            headers=(header,),
            body=None,
            timeout_seconds=2.5,
            max_response_bytes=64,
        )
        response = TransportResponse(
            status=200,
            final_url="opaque:response",
            headers=(header,),
            body=b"ok",
        )
        browser_request = BrowserRequest(
            url="https://example.invalid/article",
            timeout_seconds=3.0,
            max_response_bytes=64,
        )
        failure = AccessFailure(
            code="timeout",
            reason="the access operation timed out",
            action="retry later",
            retryable=True,
        )

        for model in (
            Header,
            BoundedByteStream,
            BrowserCapture,
            BrowserCaptureBatch,
            TransportRequest,
            TransportResponse,
            BrowserRequest,
            AccessFailure,
        ):
            _strict_model_contract(model)
        self.assertEqual(Header.model_validate_json(header.model_dump_json()), header)
        self.assertEqual(BoundedByteStream.model_validate_json(stream.model_dump_json()), stream)
        self.assertEqual(TransportRequest.model_validate_json(request.model_dump_json()), request)
        self.assertEqual(
            TransportResponse.model_validate_json(response.model_dump_json()), response
        )
        self.assertEqual(
            BrowserRequest.model_validate_json(browser_request.model_dump_json()), browser_request
        )
        self.assertEqual(AccessFailure.model_validate_json(failure.model_dump_json()), failure)
        self.assertEqual(b"".join(stream.chunks), b"%PDF-fixture")
        self.assertEqual(stream.size, sum(map(len, stream.chunks)))

    def test_browser_capture_batches_are_bounded_deduplicated_and_neutral(self) -> None:
        def capture(index: int, kind: BrowserCaptureKind) -> BrowserCapture:
            body = f"%PDF-fixture-{index}".encode()
            return BrowserCapture(
                kind=kind,
                stream=BoundedByteStream(
                    chunks=(body,),
                    media_type="application/pdf",
                    final_locator=f"https://example.invalid/pdf/{index}",
                    size=len(body),
                ),
            )

        captures = (
            capture(1, BrowserCaptureKind.DOWNLOAD),
            capture(2, BrowserCaptureKind.RESPONSE),
            capture(3, BrowserCaptureKind.POPUP),
        )
        batch = BrowserCaptureBatch(captures=captures)

        self.assertEqual(
            BrowserCaptureBatch.model_validate_json(batch.model_dump_json()),
            batch,
        )
        self.assertNotIn("example.invalid", repr(batch))
        self.assertNotIn("%PDF", repr(batch))
        with self.assertRaises(ValidationError):
            BrowserCaptureBatch(captures=())
        with self.assertRaises(ValidationError):
            BrowserCaptureBatch(
                captures=tuple(capture(index, BrowserCaptureKind.RESPONSE) for index in range(17))
            )
        with self.assertRaises(ValidationError):
            BrowserCaptureBatch(
                captures=(
                    capture(1, BrowserCaptureKind.DOWNLOAD),
                    capture(1, BrowserCaptureKind.RESPONSE),
                )
            )
        with self.assertRaises(ValidationError):
            BrowserCapture.model_validate(
                {
                    **capture(6, BrowserCaptureKind.RESPONSE).model_dump(),
                    "page": object(),
                }
            )

    def test_access_contracts_reject_secrets_external_objects_paths_and_dynamic_state(self) -> None:
        secret = "ACCESS-SECRET-SENTINEL"
        with self.assertRaises(ValidationError) as caught:
            Header(name="Authorization", value=secret)
        self.assertNotIn(secret, str(caught.exception))
        with self.assertRaises(ValidationError):
            Header(name="Cookie", value=secret)
        with self.assertRaises(ValidationError):
            Header(name="Set-Cookie", value=secret)

        sensitive_locators = (
            "https://example.invalid/article?token=" + secret,
            "https://example.invalid/article?api_key=" + secret,
            "https://example.invalid/article?email=" + secret,
            "https://example.invalid/article?api%5Fkey=" + secret,
            "https://example.invalid/article?signature=" + secret,
            "https://example.invalid/article?X-Amz-Signature=" + secret,
            "https://example.invalid/article?X-Goog-Credential=" + secret,
            "https://user:" + secret + "@example.invalid/article",
        )
        for locator in sensitive_locators:
            with self.subTest(locator=locator):
                with self.assertRaises(ValidationError) as caught:
                    TransportRequest(
                        method="GET",
                        url=locator,
                        headers=(),
                        body=None,
                        timeout_seconds=1.0,
                        max_response_bytes=1,
                    )
                self.assertNotIn(secret, str(caught.exception))
                with self.assertRaises(ValidationError):
                    BrowserRequest(url=locator, timeout_seconds=1.0, max_response_bytes=1)

        ordinary_query = TransportRequest(
            method="GET",
            url="https://example.invalid/article?q=token&page=2",
            headers=(),
            body=None,
            timeout_seconds=1.0,
            max_response_bytes=1,
        )
        self.assertEqual(
            ordinary_query.url,
            "https://example.invalid/article?q=token&page=2",
        )

        class _HostileObject:
            def __repr__(self) -> str:
                return "HOSTILE-OBJECT-SENTINEL"

        hostile = _HostileObject()
        dynamic_state = _HostileObject()
        hostile_cases = (
            lambda: TransportRequest(
                method="GET",
                url=hostile,  # type: ignore[arg-type]
                headers=(),
                body=None,
                timeout_seconds=1.0,
                max_response_bytes=1,
            ),
            lambda: TransportResponse(
                status=200,
                final_url="opaque:response",
                headers=hostile,  # type: ignore[arg-type]
                body=b"ok",
            ),
            lambda: BrowserRequest(
                url="opaque:browser",
                timeout_seconds=1.0,
                max_response_bytes=hostile,  # type: ignore[arg-type]
            ),
            lambda: AccessFailure(
                code="failure",
                reason="failure",
                action=dynamic_state,  # type: ignore[arg-type]
                retryable=True,
            ),
        )
        for constructor in hostile_cases:
            with self.assertRaises(ValidationError) as caught:
                constructor()
            self.assertNotIn("HOSTILE-OBJECT-SENTINEL", str(caught.exception))

        dynamic_cases = (
            {"permit": dynamic_state},
            {"next_allowed_at": dynamic_state},
            {"blocked_until": dynamic_state},
            {"quota_state": dynamic_state},
            {"window": dynamic_state},
        )
        for extra in dynamic_cases:
            with self.subTest(extra=tuple(extra)):
                with self.assertRaises(ValidationError) as caught:
                    TransportRequest(
                        method="GET",
                        url="opaque:request",
                        headers=(),
                        body=None,
                        timeout_seconds=1.0,
                        max_response_bytes=1,
                        **extra,  # type: ignore[arg-type]
                    )
                self.assertNotIn("HOSTILE-OBJECT-SENTINEL", str(caught.exception))

        for field in ("url", "final_url"):
            with self.subTest(field=field):
                values = {
                    "method": "GET",
                    "url": "opaque:request",
                    "headers": (),
                    "body": None,
                    "timeout_seconds": 1.0,
                    "max_response_bytes": 1,
                }
                if field == "url":
                    values[field] = "/private/absolute/path"
                    with self.assertRaises(ValidationError):
                        TransportRequest(**values)
                else:
                    with self.assertRaises(ValidationError):
                        TransportResponse(
                            status=200,
                            final_url="/private/absolute/path",
                            headers=(),
                            body=b"",
                        )

        for constructor in (
            lambda: TransportRequest(
                method="GET",
                url="opaque:request",
                headers=(),
                body=object(),  # type: ignore[arg-type]
                timeout_seconds=1.0,
                max_response_bytes=1,
            ),
            lambda: TransportResponse(
                status=200,
                final_url="opaque:response",
                headers=(),
                body=object(),  # type: ignore[arg-type]
            ),
            lambda: Header(name="Bad\nName", value="value"),
            lambda: AccessFailure(
                code="timeout",
                reason="timed out",
                action="retry",
                retryable=True,
                next_allowed_at="2026-08-10T12:00:00Z",  # type: ignore[call-arg]
            ),
            lambda: AccessFailure(
                code="network",
                reason="https://example.invalid/private?token=secret",
                action="retry",
                retryable=True,
            ),
            lambda: AccessFailure(
                code="network",
                reason="/private/absolute/path",
                action="retry",
                retryable=True,
            ),
        ):
            with self.assertRaises(ValidationError):
                constructor()

        self.assertNotIn(secret, repr(Header(name="Accept", value=secret)))

        safe_json = TransportRequest(
            method="GET",
            url="https://example.invalid/article?q=paper",
            headers=(Header(name="Accept", value="application/pdf"),),
            body=None,
            timeout_seconds=1.0,
            max_response_bytes=1,
        ).model_dump_json()
        self.assertNotIn(secret, safe_json)
        self.assertNotIn("Authorization", safe_json)

        self.assertEqual(
            set(BrowserRequest.model_fields),
            {"url", "timeout_seconds", "max_response_bytes"},
        )
        for forbidden in (
            "selector",
            "action",
            "page",
            "profile",
            "cookie",
            "permit",
            "quota",
        ):
            with self.subTest(forbidden=forbidden):
                with self.assertRaises(ValidationError):
                    BrowserRequest(
                        url="opaque:browser",
                        timeout_seconds=1.0,
                        max_response_bytes=1,
                        **{forbidden: "forbidden"},  # type: ignore[arg-type]
                    )

    def test_header_names_reject_provider_credential_aliases_without_echoing_secret(self) -> None:
        secret = "HEADER-SECRET-SENTINEL"
        for name in (
            "Api-Key",
            "API_KEY",
            "X-ELS-APIKey",
            "x_els_api_key",
            "X-ELS-Insttoken",
            "X-ELS-Inst-Token",
        ):
            with self.subTest(name=name):
                with self.assertRaises(ValidationError) as caught:
                    Header(name=name, value=secret)
                self.assertNotIn(secret, str(caught.exception))
                self.assertNotIn(secret, repr(caught.exception))

    def test_safe_header_names_round_trip_without_false_positive_rejection(self) -> None:
        for name in (
            "Content-Security-Policy",
            "ETag",
            "Accept",
            "User-Agent",
        ):
            with self.subTest(name=name):
                header = Header(name=name, value="safe-header-value")
                self.assertEqual(Header.model_validate_json(header.model_dump_json()), header)
                self.assertEqual(header.model_dump()["name"], name)
                self.assertEqual(header.model_dump()["value"], "safe-header-value")

    def test_header_names_reject_network_owned_authority_framing_and_hop_by_hop_fields(
        self,
    ) -> None:
        for name in (
            "Host",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
            "Keep-Alive",
            "Proxy-Authenticate",
            "Proxy-Authorization",
            "Proxy-Connection",
            "TE",
            "Trailer",
            "Upgrade",
        ):
            with self.subTest(name=name):
                with self.assertRaises(ValidationError):
                    Header(name=name, value="caller-controlled")

    def test_access_models_reject_unbounded_or_inconsistent_values(self) -> None:
        cases = (
            lambda: BoundedByteStream(
                chunks=(b"payload",),
                media_type="application/octet-stream",
                final_locator="opaque:final",
                size=6,
            ),
            lambda: BoundedByteStream(
                chunks=(b"payload",),
                media_type=" ",
                final_locator="opaque:final",
                size=7,
            ),
            lambda: TransportRequest(
                method="GET",
                url="opaque:request",
                headers=(),
                body=None,
                timeout_seconds=0,
                max_response_bytes=8,
            ),
            lambda: TransportResponse(
                status=700,
                final_url="opaque:response",
                headers=(),
                body=b"ok",
            ),
            lambda: AccessFailure(code=" ", reason="reason", action="retry", retryable=True),
        )
        for constructor in cases:
            with self.assertRaises(ValidationError):
                constructor()

    def test_access_failure_rejects_contact_email_assignments_without_echoing_values(
        self,
    ) -> None:
        secret = "failure-contact-sentinel@example.test"
        for separator in ("=", ":"):
            with self.subTest(separator=separator):
                with self.assertRaises(ValidationError) as caught:
                    AccessFailure(
                        code="provider-failure",
                        reason=f"email{separator}{secret}",
                        action="retry later",
                        retryable=True,
                    )
                self.assertNotIn(secret, str(caught.exception))
                self.assertNotIn(secret, repr(caught.exception))

    def test_header_tab_is_allowed_but_locators_and_failures_reject_all_c0(self) -> None:
        self.assertEqual(
            Header(name="Accept", value="application/\tpdf").value,
            "application/\tpdf",
        )
        with self.assertRaises(ValidationError):
            TransportRequest(
                method="GET",
                url="opaque:request\twith-tab",
                headers=(),
                body=None,
                timeout_seconds=1.0,
                max_response_bytes=1,
            )
        with self.assertRaises(ValidationError):
            BrowserRequest(
                url="opaque:request\twith-tab",
                timeout_seconds=1.0,
                max_response_bytes=1,
            )
        with self.assertRaises(ValidationError):
            AccessFailure(
                code="network",
                reason="timed\tout",
                action="retry",
                retryable=True,
            )


class AgentsModelTests(unittest.TestCase):
    def _provenance(self) -> AgentProvenance:
        return AgentProvenance(
            provider="fixture-provider",
            model="fixture-model",
            input_sha256=_HASH,
            parameters_sha256=_HASH,
        )

    def _call(self) -> AgentCall:
        return AgentCall(
            role=AgentRole.ANALYSIS,
            required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
            input_sha256=_HASH,
            text_parts=(
                AgentTextPart(media_type="text/plain", text="instruction"),
                AgentTextPart(media_type="application/json", text='{"document":"fixture"}'),
            ),
            response_schema='{"type":"object","additionalProperties":false}',
            max_output_tokens=64,
        )

    def test_agents_contracts_are_neutral_bounded_and_round_trip(self) -> None:
        call = self._call()
        response = AgentStructuredResult(
            result='{"outcome":"usable"}',
            provenance=self._provenance(),
        )
        self.assertEqual(call.role, AgentRole.ANALYSIS)
        self.assertEqual(call.text_parts[-1].text, '{"document":"fixture"}')
        self.assertEqual(response.value, {"outcome": "usable"})
        self.assertEqual(response.provenance.provider, "fixture-provider")

    def test_agents_contracts_reject_business_kind_vendor_objects_and_secret_fields(self) -> None:
        with self.assertRaises((TypeError, ValueError)):
            AgentCall(
                role=AgentRole.ANALYSIS,
                required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                input_sha256=_HASH,
                text_parts=(AgentTextPart(media_type="text/plain", text="instruction"),),
                response_schema='{"type":"object","additionalProperties":false}',
                max_output_tokens=64,
                kind="metadata",  # type: ignore[call-arg]
            )
        with self.assertRaises(ValueError):
            AgentStructuredResult(result='{"x":1,"x":2}', provenance=self._provenance())
        self.assertNotIn("ACCESS-SECRET-SENTINEL", repr(self._call()))

    def test_agents_provenance_has_only_neutral_identity_and_usage(self) -> None:
        self.assertEqual(
            set(AgentProvenance.__dataclass_fields__),
            {"provider", "model", "input_sha256", "parameters_sha256", "usage"},
        )
        self.assertEqual(
            set(AgentStructuredResult.__dataclass_fields__),
            {"result", "provenance"},
        )


if __name__ == "__main__":
    unittest.main()
