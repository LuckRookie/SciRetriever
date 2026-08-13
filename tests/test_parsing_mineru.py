from __future__ import annotations

import ast
import base64
import io
import json
import tempfile
import threading
import unittest
import zipfile
from contextlib import AbstractContextManager, closing
from pathlib import Path
from typing import Any, BinaryIO, Iterable, cast
from unittest.mock import patch

from PyPDF2 import PdfWriter

from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.parsing import ParserRequest
from sciretriever.model.primitives import (
    AssetId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import ResolvedDestination
from sciretriever.parsing.adapters.mineru import (
    MinerUAdapterBounds,
    MinerUAdapterError,
    MinerUArchiveResult,
    MinerUHealth,
    MinerUProtocol2Bounds,
    MinerUProtocol2Error,
    MinerUProtocol2ServiceClient,
    MinerUServicePort,
    MinerUTask,
    OperatorManagedMinerUAdapter,
)
from sciretriever.parsing.adapters.mineru_converter import (
    MinerUConversionBounds,
    MinerUConversionError,
    convert_mineru_archive,
)
from sciretriever.parsing.archive import ParserArchiveBounds
from sciretriever.parsing.markdown import MarkdownConversionBounds
from sciretriever.parsing.ports import ParserPort
from sciretriever.parsing.resources import ParserResourceBounds

_FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "parsing" / "mineru"
_ASSET_ID = AssetId("10000001-e89b-12d3-a456-426614174000")
_PROVENANCE_ID = ProvenanceId("10000002-e89b-12d3-a456-426614174000")
_TIME = UtcTimestamp("2026-08-12T06:07:08Z")
_TASK_ID = "fixture-task-0001"
_MODEL_IDENTITY = "operator-vlm-model@fixture-revision"
_ARCHIVE_SENTINEL = b"PRIVATE-ARCHIVE-SENTINEL"
_PRIVATE_PATH = "/srv/mineru/private/tasks/fixture-task-0001/result.zip"
_REMOTE_SECRET = "protocol2-runtime-secret-sentinel"
_REAL_TEMPORARY_DIRECTORY = tempfile.TemporaryDirectory


class _BytesContent:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.open_calls = 0

    def open(self) -> AbstractContextManager[BinaryIO]:
        self.open_calls += 1
        return closing(io.BytesIO(self._payload))

    def __repr__(self) -> str:
        return "_BytesContent(<redacted>)"


class _TemporaryRecorder:
    def __init__(self) -> None:
        self.paths: list[Path] = []

    def __call__(self, *, prefix: str) -> tempfile.TemporaryDirectory[str]:
        temporary = _REAL_TEMPORARY_DIRECTORY(prefix=prefix)
        self.paths.append(Path(temporary.name))
        return temporary


def _fixture(name: str) -> bytes:
    return (_FIXTURE_ROOT / name).read_bytes()


def _pdf(page_count: int = 2) -> bytes:
    writer = PdfWriter()
    for _index in range(page_count):
        writer.add_blank_page(width=612, height=792)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _entries() -> list[tuple[str | zipfile.ZipInfo, bytes]]:
    image = base64.b64decode(_fixture("figure.png.base64").strip(), validate=True)
    return [
        ("document.md", _fixture("document.md")),
        ("document_middle.json", _fixture("document_middle.json")),
        ("document_model.json", _fixture("document_model.json")),
        ("document_content_list.json", _fixture("document_content_list.json")),
        ("images/figure.png", image),
        ("images/unreferenced.png", image),
        ("private/debug.json", _ARCHIVE_SENTINEL),
        ("document_layout.pdf", b"%PDF-1.7\nprivate layout"),
        ("document_origin.pdf", b"%PDF-1.7\nprivate origin"),
        ("document_span.pdf", b"%PDF-1.7\nprivate span"),
    ]


def _zip(entries: list[tuple[str | zipfile.ZipInfo, bytes]] | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, payload in _entries() if entries is None else entries:
            archive.writestr(name, payload)
    return output.getvalue()


def _replaced_archive(**replacements: bytes | None) -> bytes:
    entries = {cast(str, name): payload for name, payload in _entries() if isinstance(name, str)}
    aliases = {
        "document_middle": "document_middle.json",
        "document_model": "document_model.json",
        "document_content_list": "document_content_list.json",
    }
    for name, payload in replacements.items():
        name = aliases.get(name, name)
        if payload is None:
            entries.pop(name, None)
        else:
            entries[name] = payload
    return _zip(list(entries.items()))


def _request(
    payload: bytes | None = None,
    *,
    declared_sha256: Sha256 | None = None,
) -> tuple[ParserRequest, _BytesContent]:
    pdf = _pdf() if payload is None else payload
    content = _BytesContent(pdf)
    request = ParserRequest(
        source_asset_id=_ASSET_ID,
        source_sha256=sha256_digest(pdf) if declared_sha256 is None else declared_sha256,
        media_type="application/pdf",
        content_ref=content,
    )
    return request, content


def _read(content: object) -> bytes:
    opener = getattr(content, "open")
    with opener() as stream:
        return cast(bytes, stream.read())


class _FakeMinerUService:
    def __init__(
        self,
        *,
        health: object | None = None,
        submit: object | None = None,
        polls: tuple[object, ...] | None = None,
        archive: object | None = None,
    ) -> None:
        self.health_value = (
            MinerUHealth(status="healthy", release="3.4.4", api_protocol=2)
            if health is None
            else health
        )
        self.submit_value = (
            MinerUTask(task_id=_TASK_ID, state="pending") if submit is None else submit
        )
        self.poll_values = list(
            (
                MinerUTask(task_id=_TASK_ID, state="processing"),
                MinerUTask(task_id=_TASK_ID, state="completed"),
            )
            if polls is None
            else polls
        )
        self.archive_value = (
            MinerUArchiveResult(state="completed", payload=_zip()) if archive is None else archive
        )
        self.calls: list[str] = []
        self.submit_calls = 0
        self.submitted_pdf_sha256: Sha256 | None = None
        self.submitted_profile: str | None = None
        self.poll_task_ids: list[str] = []
        self.archive_task_ids: list[str] = []
        self.cancel_events: list[threading.Event | None] = []

    @staticmethod
    def _value(value: object) -> object:
        if isinstance(value, BaseException):
            raise value
        return value

    def health(
        self,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUHealth:
        self.calls.append("health")
        self.cancel_events.append(cancel_event)
        self.health_timeout = timeout_seconds
        return cast(MinerUHealth, self._value(self.health_value))

    def submit(
        self,
        pdf: bytes,
        *,
        profile: str,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUTask:
        self.calls.append("submit")
        self.cancel_events.append(cancel_event)
        self.submit_calls += 1
        self.submitted_pdf_sha256 = sha256_digest(pdf)
        self.submitted_profile = profile
        self.submit_timeout = timeout_seconds
        return cast(MinerUTask, self._value(self.submit_value))

    def poll(
        self,
        task_id: str,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUTask | None:
        self.calls.append("poll")
        self.cancel_events.append(cancel_event)
        self.poll_task_ids.append(task_id)
        self.poll_timeout = timeout_seconds
        if not self.poll_values:
            raise AssertionError("unexpected poll")
        return cast(MinerUTask | None, self._value(self.poll_values.pop(0)))

    def archive(
        self,
        task_id: str,
        *,
        timeout_seconds: float,
        cancel_event: threading.Event | None = None,
    ) -> MinerUArchiveResult:
        self.calls.append("archive")
        self.cancel_events.append(cancel_event)
        self.archive_task_ids.append(task_id)
        self.archive_timeout = timeout_seconds
        return cast(MinerUArchiveResult, self._value(self.archive_value))


def _adapter(
    service: MinerUServicePort,
    *,
    profile: str = "vlm-engine",
    model_identity: str = _MODEL_IDENTITY,
    bounds: MinerUAdapterBounds | None = None,
    conversion_bounds: MinerUConversionBounds | None = None,
) -> OperatorManagedMinerUAdapter:
    return OperatorManagedMinerUAdapter(
        service=service,
        profile=profile,
        model_identity=model_identity,
        provenance_id_factory=lambda: _PROVENANCE_ID,
        clock=lambda: _TIME,
        bounds=bounds,
        conversion_bounds=conversion_bounds,
    )


class _ProtocolResponse:
    def __init__(
        self,
        status: int,
        *,
        body: bytes = b"",
        media_type: str | None = None,
        headers: tuple[Header, ...] = (),
    ) -> None:
        content_type = (
            () if media_type is None else (Header(name="Content-Type", value=media_type),)
        )
        self.status = status
        self.headers = (*content_type, *headers)
        self.body = body
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _ProtocolResolver:
    def __init__(self, answers: dict[str, tuple[str, ...]] | None = None) -> None:
        self.answers = {} if answers is None else answers
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return self.answers[hostname]


class _ProtocolTransport:
    def __init__(self, actions: Iterable[object]) -> None:
        self.actions = list(actions)
        self.calls: list[dict[str, object]] = []
        self.closed = False

    def send(
        self,
        request: TransportRequest,
        destination: ResolvedDestination,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: object,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> object:
        self.calls.append(
            {
                "request": request,
                "destination": destination,
                "headers": headers,
                "request_target_renderer": request_target_renderer,
                "connect_timeout_seconds": connect_timeout_seconds,
                "read_timeout_seconds": read_timeout_seconds,
                "tls_server_hostname": tls_server_hostname,
                "cancel_event": cancel_event,
            }
        )
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        return action

    def close(self) -> None:
        self.closed = True


def _wire_json(status: int, payload: object) -> _ProtocolResponse:
    return _ProtocolResponse(
        status,
        body=json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8"),
        media_type="application/json",
    )


def _protocol_client(
    actions: Iterable[object],
    *,
    base_url: str = "http://127.0.0.1",
    connection_mode: str = "loopback",
    bearer_token: str | None = None,
    remote_upload_authorized: bool = False,
    bounds: MinerUProtocol2Bounds | None = None,
    resolver_answers: dict[str, tuple[str, ...]] | None = None,
) -> tuple[MinerUProtocol2ServiceClient, _ProtocolTransport, _ProtocolResolver, HttpClient]:
    transport = _ProtocolTransport(actions)
    resolver = _ProtocolResolver(resolver_answers)
    http_client = HttpClient(
        resolver=resolver,
        transport=cast(Any, transport),
        coordinator=AccessCoordinator(),
    )
    client = MinerUProtocol2ServiceClient(
        http_client=http_client,
        base_url=base_url,
        connection_mode=connection_mode,
        access_scope=AccessScope("mineru", "api", "protocol-2"),
        access_policy=AccessPolicy(max_concurrency=1),
        bearer_token=bearer_token,
        remote_upload_authorized=remote_upload_authorized,
        bounds=bounds,
    )
    return client, transport, resolver, http_client


def _safe_request(call: dict[str, object]) -> TransportRequest:
    request = call["request"]
    if not isinstance(request, TransportRequest):
        raise AssertionError("protocol transport did not receive TransportRequest")
    return request


class MinerUProtocol2ClientTests(unittest.TestCase):
    def test_wire_fixtures_convert_to_neutral_health_and_task_values(self) -> None:
        health_wire = cast(object, json.loads(_fixture("health.json")))
        task_wire = cast(dict[str, object], json.loads(_fixture("task-sequence.json")))
        submit_wire = cast(dict[str, object], task_wire["submit"])
        polls_wire = cast(list[object], task_wire["poll"])
        client, _transport, _resolver, _http = _protocol_client(
            [
                _wire_json(200, health_wire),
                _wire_json(202, submit_wire),
                _wire_json(200, polls_wire[0]),
            ]
        )

        health = client.health(timeout_seconds=1.0)
        submitted = client.submit(_pdf(), profile="vlm-engine", timeout_seconds=1.0)
        polled = client.poll(_TASK_ID, timeout_seconds=1.0)

        self.assertEqual(
            health,
            MinerUHealth(status="healthy", release="3.4.4", api_protocol=2),
        )
        self.assertEqual(submitted, MinerUTask(task_id=_TASK_ID, state="pending"))
        self.assertEqual(polled, MinerUTask(task_id=_TASK_ID, state="processing"))
        self.assertIsInstance(client, MinerUServicePort)

    def test_paths_multipart_fields_and_result_archive_are_exact_and_bounded(self) -> None:
        archive = _zip()
        client, transport, _resolver, _http = _protocol_client(
            [
                _wire_json(200, json.loads(_fixture("health.json"))),
                _wire_json(202, {"task_id": _TASK_ID, "status": "pending"}),
                _wire_json(200, {"task_id": _TASK_ID, "status": "completed"}),
                _ProtocolResponse(200, body=archive, media_type="application/zip"),
            ]
        )
        pdf = _pdf()

        client.health(timeout_seconds=2.0)
        submitted = client.submit(pdf, profile="vlm-engine", timeout_seconds=3.0)
        polled = client.poll(submitted.task_id, timeout_seconds=4.0)
        result = client.archive(submitted.task_id, timeout_seconds=5.0)

        self.assertEqual(polled, MinerUTask(task_id=_TASK_ID, state="completed"))
        self.assertEqual(result, MinerUArchiveResult(state="completed", payload=archive))
        self.assertEqual(
            [
                (cast(TransportRequest, call["request"]).method, _safe_request(call).url)
                for call in transport.calls
            ],
            [
                ("GET", "http://127.0.0.1/health"),
                ("POST", "http://127.0.0.1/tasks"),
                ("GET", f"http://127.0.0.1/tasks/{_TASK_ID}"),
                ("GET", f"http://127.0.0.1/tasks/{_TASK_ID}/result"),
            ],
        )
        submit_request = _safe_request(transport.calls[1])
        self.assertIsNotNone(submit_request.body)
        body = cast(bytes, submit_request.body)
        expected_fields = cast(dict[str, str], json.loads(_fixture("submit-fields.json")))
        for name, value in expected_fields.items():
            self.assertIn(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("ascii"),
                body,
            )
        self.assertIn(b'name="files"; filename="document.pdf"', body)
        self.assertIn(b"Content-Type: application/pdf\r\n\r\n" + pdf, body)
        submit_content_types = [
            header.value
            for header in submit_request.headers
            if header.name.casefold() == "content-type"
        ]
        self.assertEqual(len(submit_content_types), 1)
        self.assertTrue(submit_content_types[0].startswith("multipart/form-data; boundary="))

    def test_same_cancellation_event_reaches_every_http_phase(self) -> None:
        client, transport, _resolver, _http = _protocol_client(
            [
                _wire_json(200, json.loads(_fixture("health.json"))),
                _wire_json(202, {"task_id": _TASK_ID, "status": "pending"}),
                _wire_json(200, {"task_id": _TASK_ID, "status": "completed"}),
                _ProtocolResponse(200, body=_zip(), media_type="application/zip"),
            ]
        )
        request, _content = _request()
        cancel_event = threading.Event()

        output = _adapter(client).parse(request, cancel_event=cancel_event)

        self.assertEqual(output.source_asset_id, request.source_asset_id)
        self.assertEqual(len(transport.calls), 4)
        self.assertTrue(all(call["cancel_event"] is cancel_event for call in transport.calls))

    def test_precancelled_http_phase_stops_before_transport(self) -> None:
        client, transport, _resolver, _http = _protocol_client(
            [_wire_json(200, json.loads(_fixture("health.json")))]
        )
        cancel_event = threading.Event()
        cancel_event.set()

        with self.assertRaises(MinerUProtocol2Error) as caught:
            client.health(timeout_seconds=120.0, cancel_event=cancel_event)

        self.assertEqual(caught.exception.code, "access-failed")
        self.assertEqual(transport.calls, [])

    def test_loopback_port_8000_drives_the_full_fixture_lifecycle(self) -> None:
        client, transport, _resolver, _http = _protocol_client(
            [
                _wire_json(200, json.loads(_fixture("health.json"))),
                _wire_json(202, {"task_id": _TASK_ID, "status": "pending"}),
                _wire_json(200, {"task_id": _TASK_ID, "status": "processing"}),
                _wire_json(200, {"task_id": _TASK_ID, "status": "completed"}),
                _ProtocolResponse(200, body=_zip(), media_type="application/zip"),
            ],
            base_url="http://127.0.0.1:8000",
        )
        request, _content = _request()

        output = _adapter(client).parse(request)

        self.assertEqual(_read(output.markdown.content), _fixture("document.md"))
        self.assertEqual(len(transport.calls), 5)
        for call in transport.calls:
            self.assertTrue(_safe_request(call).url.startswith("http://127.0.0.1:8000/"))
            destination = cast(ResolvedDestination, call["destination"])
            self.assertEqual(destination.url.port, 8000)
            self.assertEqual(destination.origin.text, "http://127.0.0.1:8000")

    def test_localhost_port_8000_uses_loopback_resolution_and_retains_authority(self) -> None:
        client, transport, resolver, _http = _protocol_client(
            [_wire_json(200, json.loads(_fixture("health.json")))],
            base_url="http://localhost:8000",
            resolver_answers={"localhost": ("127.0.0.1",)},
        )

        health = client.health(timeout_seconds=1.0)

        self.assertEqual(health.release, "3.4.4")
        self.assertEqual(_safe_request(transport.calls[0]).url, "http://localhost:8000/health")
        self.assertTrue(resolver.calls)
        self.assertTrue(all(host == "localhost" for host in resolver.calls))

    def test_remote_custom_https_port_binds_bearer_to_the_exact_origin(self) -> None:
        client, transport, _resolver, _http = _protocol_client(
            [_wire_json(200, json.loads(_fixture("health.json")))],
            base_url="https://mineru.example:8443/private/base",
            connection_mode="remote",
            bearer_token=_REMOTE_SECRET,
            remote_upload_authorized=True,
            resolver_answers={"mineru.example": ("93.184.216.34",)},
        )

        health = client.health(timeout_seconds=1.0)

        self.assertEqual(health.release, "3.4.4")
        call = transport.calls[0]
        self.assertEqual(
            _safe_request(call).url,
            "https://mineru.example:8443/private/base/health",
        )
        destination = cast(ResolvedDestination, call["destination"])
        self.assertEqual(destination.url.port, 8443)
        self.assertEqual(destination.origin.text, "https://mineru.example:8443")
        self.assertIn(
            ("Authorization", f"Bearer {_REMOTE_SECRET}"),
            cast(tuple[tuple[str, str], ...], call["headers"]),
        )

    def test_remote_custom_port_redirect_cannot_retarget_bearer_to_another_port(self) -> None:
        response = _ProtocolResponse(
            302,
            headers=(
                Header(
                    name="Location",
                    value="https://mineru.example:9443/private/base/health",
                ),
            ),
        )
        client, transport, resolver, _http = _protocol_client(
            [response],
            base_url="https://mineru.example:8443/private/base",
            connection_mode="remote",
            bearer_token=_REMOTE_SECRET,
            remote_upload_authorized=True,
            resolver_answers={"mineru.example": ("93.184.216.34",)},
        )

        with self.assertRaises(MinerUProtocol2Error) as caught:
            client.health(timeout_seconds=1.0)

        self.assertEqual(caught.exception.code, "access-failed")
        self.assertEqual(len(transport.calls), 1)
        self.assertIn(
            ("Authorization", f"Bearer {_REMOTE_SECRET}"),
            cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"]),
        )
        self.assertTrue(all(host == "mineru.example" for host in resolver.calls))
        self.assertNotIn("9443", repr(caught.exception))

    def test_concrete_client_drives_full_adapter_fixture_lifecycle(self) -> None:
        client, transport, _resolver, _http = _protocol_client(
            [
                _wire_json(200, json.loads(_fixture("health.json"))),
                _wire_json(202, {"task_id": _TASK_ID, "status": "pending"}),
                _wire_json(200, {"task_id": _TASK_ID, "status": "processing"}),
                _wire_json(200, {"task_id": _TASK_ID, "status": "completed"}),
                _ProtocolResponse(200, body=_zip(), media_type="application/zip"),
            ]
        )
        request, _content = _request()

        output = _adapter(client).parse(request)

        self.assertEqual(output.source_sha256, request.source_sha256)
        self.assertEqual(_read(output.markdown.content), _fixture("document.md"))
        self.assertEqual(tuple(item.reference for item in output.resources), ("images/figure.png",))
        self.assertEqual(
            [_safe_request(call).method for call in transport.calls],
            ["GET", "POST", "GET", "GET", "GET"],
        )

    def test_resume_with_concrete_client_polls_without_resubmission(self) -> None:
        client, transport, _resolver, _http = _protocol_client(
            [
                _wire_json(200, json.loads(_fixture("health.json"))),
                _wire_json(200, {"task_id": _TASK_ID, "status": "completed"}),
                _ProtocolResponse(200, body=_zip(), media_type="application/zip"),
            ]
        )
        request, _content = _request()

        output = _adapter(client).resume(request, _TASK_ID)

        self.assertEqual(
            [_safe_request(call).method for call in transport.calls], ["GET", "GET", "GET"]
        )
        self.assertEqual(_read(output.markdown.content), _fixture("document.md"))
        self.assertFalse(any(_safe_request(call).method == "POST" for call in transport.calls))

    def test_archive_statuses_map_to_pending_expired_failed_and_completed(self) -> None:
        cases: tuple[tuple[int, str], ...] = (
            (202, "pending"),
            (404, "expired"),
            (409, "failed"),
        )
        for status, state in cases:
            with self.subTest(status=status):
                client, _transport, _resolver, _http = _protocol_client([_ProtocolResponse(status)])
                self.assertEqual(
                    client.archive(_TASK_ID, timeout_seconds=1.0),
                    MinerUArchiveResult(state=state),
                )

    def test_health_json_is_closed_strict_and_content_typed(self) -> None:
        invalid: tuple[_ProtocolResponse, ...] = (
            _wire_json(
                200,
                {
                    "status": "healthy",
                    "version": "3.4.4",
                    "protocol_version": 2,
                    "extra": True,
                },
            ),
            _wire_json(200, {"status": "healthy", "version": "3.4.4"}),
            _wire_json(
                200,
                {"status": "healthy", "version": "3.4.4", "protocol_version": True},
            ),
            _ProtocolResponse(
                200,
                body=b'{"status":"healthy","version":"3.4.4","protocol_version":2,"status":"bad"}',
                media_type="application/json",
            ),
            _ProtocolResponse(
                200,
                body=b'{"status":"healthy","version":"3.4.4","protocol_version":NaN}',
                media_type="application/json",
            ),
            _ProtocolResponse(
                200,
                body=_fixture("health.json"),
                media_type="text/plain",
            ),
            _wire_json(204, json.loads(_fixture("health.json"))),
        )
        for response in invalid:
            with self.subTest(status=response.status, body_size=len(response.body)):
                client, _transport, _resolver, _http = _protocol_client([response])
                with self.assertRaises(MinerUProtocol2Error) as caught:
                    client.health(timeout_seconds=1.0)
                self.assertIn(caught.exception.code, {"protocol-invalid", "status-invalid"})

    def test_task_contract_is_closed_identity_aligned_and_opaque_path_is_safe(self) -> None:
        client, transport, _resolver, _http = _protocol_client([_ProtocolResponse(404)])
        self.assertIsNone(client.poll(_TASK_ID, timeout_seconds=1.0))
        self.assertEqual(
            _safe_request(transport.calls[0]).url, f"http://127.0.0.1/tasks/{_TASK_ID}"
        )

        invalid_payloads = (
            {"task_id": _TASK_ID, "status": "pending", "extra": True},
            {"task_id": _TASK_ID, "status": "cancelled"},
            {"task_id": "../private", "status": "pending"},
            {"task_id": "different-task", "status": "completed"},
        )
        for payload in invalid_payloads:
            with self.subTest(payload_keys=tuple(payload)):
                client, _transport, _resolver, _http = _protocol_client([_wire_json(200, payload)])
                with self.assertRaises(MinerUProtocol2Error):
                    client.poll(_TASK_ID, timeout_seconds=1.0)

        client, transport, _resolver, _http = _protocol_client([])
        with self.assertRaises(MinerUProtocol2Error) as caught:
            client.poll("../private", timeout_seconds=1.0)
        self.assertEqual(caught.exception.code, "task-invalid")
        self.assertEqual(transport.calls, [])

    def test_submit_rejects_profile_budget_status_and_malformed_task(self) -> None:
        pdf = _pdf()
        client, transport, _resolver, _http = _protocol_client(
            [],
            bounds=MinerUProtocol2Bounds(max_upload_bytes=len(pdf) - 1),
        )
        with self.assertRaises(MinerUProtocol2Error) as caught:
            client.submit(pdf, profile="vlm-engine", timeout_seconds=1.0)
        self.assertEqual(caught.exception.code, "upload-budget")
        self.assertEqual(transport.calls, [])

        client, transport, _resolver, _http = _protocol_client([])
        with self.assertRaises(MinerUProtocol2Error) as caught:
            client.submit(pdf, profile="pipeline", timeout_seconds=1.0)
        self.assertEqual(caught.exception.code, "profile-invalid")
        self.assertEqual(transport.calls, [])

        invalid = (
            _wire_json(200, {"task_id": _TASK_ID, "status": "pending"}),
            _wire_json(202, {"task_id": _TASK_ID, "status": "pending", "extra": 1}),
            _ProtocolResponse(202, body=b"{}", media_type="text/plain"),
        )
        for response in invalid:
            with self.subTest(status=response.status):
                client, _transport, _resolver, _http = _protocol_client([response])
                with self.assertRaises(MinerUProtocol2Error):
                    client.submit(pdf, profile="vlm-engine", timeout_seconds=1.0)

    def test_archive_requires_zip_media_nonempty_payload_and_response_budget(self) -> None:
        bounds = MinerUProtocol2Bounds(max_archive_bytes=64)
        invalid = (
            _ProtocolResponse(200, body=_zip(), media_type="text/plain"),
            _ProtocolResponse(200, body=b"", media_type="application/zip"),
            _ProtocolResponse(200, body=b"not-a-zip", media_type="application/zip"),
            _ProtocolResponse(200, body=b"PK\x03\x04" + b"x" * 80, media_type="application/zip"),
            _ProtocolResponse(201, body=b"", media_type="application/json"),
        )
        for response in invalid:
            with self.subTest(status=response.status, body_size=len(response.body)):
                client, _transport, _resolver, _http = _protocol_client(
                    [response],
                    bounds=bounds,
                )
                with self.assertRaises(MinerUProtocol2Error) as caught:
                    client.archive(_TASK_ID, timeout_seconds=1.0)
                self.assertIn(
                    caught.exception.code,
                    {"archive-invalid", "protocol-invalid", "response-budget", "status-invalid"},
                )

    def test_loopback_and_remote_security_are_delegated_to_network_boundaries(self) -> None:
        with self.assertRaises(MinerUProtocol2Error):
            _protocol_client(
                [],
                base_url="http://127.0.0.1",
                connection_mode="loopback",
                bearer_token=_REMOTE_SECRET,
            )
        with self.assertRaises(MinerUProtocol2Error):
            _protocol_client(
                [],
                base_url="https://mineru.example/private/base",
                connection_mode="remote",
                bearer_token=_REMOTE_SECRET,
                remote_upload_authorized=False,
                resolver_answers={"mineru.example": ("93.184.216.34",)},
            )

        client, transport, _resolver, _http = _protocol_client(
            [_wire_json(200, json.loads(_fixture("health.json")))],
            base_url="https://mineru.example/private/base",
            connection_mode="remote",
            bearer_token=_REMOTE_SECRET,
            remote_upload_authorized=True,
            resolver_answers={"mineru.example": ("93.184.216.34",)},
        )
        health = client.health(timeout_seconds=1.0)
        self.assertEqual(health.release, "3.4.4")
        call = transport.calls[0]
        self.assertIn(
            ("Authorization", f"Bearer {_REMOTE_SECRET}"),
            cast(tuple[tuple[str, str], ...], call["headers"]),
        )
        request = _safe_request(call)
        self.assertNotIn(_REMOTE_SECRET, repr(request))
        self.assertNotIn(_REMOTE_SECRET, request.model_dump_json())
        self.assertNotIn(_REMOTE_SECRET, repr(client))
        self.assertNotIn("private/base", repr(client))

        private_client, _transport, _resolver, _http = _protocol_client(
            [],
            base_url="https://mineru.example/private/base",
            connection_mode="remote",
            bearer_token=_REMOTE_SECRET,
            remote_upload_authorized=True,
            resolver_answers={"mineru.example": ("127.0.0.1",)},
        )
        with self.assertRaises(MinerUProtocol2Error) as caught:
            private_client.health(timeout_seconds=1.0)
        self.assertEqual(caught.exception.code, "access-failed")

    def test_redirect_and_access_failures_are_stable_and_redacted(self) -> None:
        response = _ProtocolResponse(
            302,
            headers=(Header(name="Location", value="https://other.example/private/result"),),
        )
        client, transport, resolver, _http = _protocol_client(
            [response],
            base_url="https://mineru.example/private/base",
            connection_mode="remote",
            bearer_token=_REMOTE_SECRET,
            remote_upload_authorized=True,
            resolver_answers={
                "mineru.example": ("93.184.216.34",),
                "other.example": ("1.1.1.1",),
            },
        )

        with self.assertRaises(MinerUProtocol2Error) as caught:
            client.health(timeout_seconds=1.0)

        rendered = f"{caught.exception!s} {caught.exception!r} {client!r}"
        self.assertEqual(caught.exception.code, "access-failed")
        self.assertNotIn(_REMOTE_SECRET, rendered)
        self.assertNotIn("private/base", rendered)
        self.assertNotIn("private/result", rendered)
        self.assertEqual(len(transport.calls), 1)
        self.assertNotIn("other.example", resolver.calls)


class ParsingMinerUTests(unittest.TestCase):
    def test_fixtures_fix_wire_344_protocol_2_lifecycle(self) -> None:
        health = cast(object, json.loads(_fixture("health.json")))
        sequence = cast(object, json.loads(_fixture("task-sequence.json")))

        self.assertEqual(
            health,
            {"protocol_version": 2, "status": "healthy", "version": "3.4.4"},
        )
        self.assertEqual(
            sequence,
            {
                "submit": {"status": "pending", "task_id": _TASK_ID},
                "poll": [
                    {"status": "processing", "task_id": _TASK_ID},
                    {"status": "completed", "task_id": _TASK_ID},
                ],
            },
        )

    def test_happy_path_is_parser_neutral_and_private_staging_is_cleaned(self) -> None:
        request, content = _request()
        service = _FakeMinerUService()
        adapter = _adapter(service)
        recorder = _TemporaryRecorder()

        self.assertIsInstance(service, MinerUServicePort)
        self.assertIsInstance(adapter, ParserPort)
        with patch(
            "sciretriever.parsing.archive.tempfile.TemporaryDirectory",
            new=recorder,
        ):
            output = adapter.parse(request)

        self.assertEqual(service.calls, ["health", "submit", "poll", "poll", "archive"])
        self.assertEqual(service.submit_calls, 1)
        self.assertEqual(service.submitted_pdf_sha256, request.source_sha256)
        self.assertEqual(service.submitted_profile, "vlm-engine")
        self.assertEqual(service.poll_task_ids, [_TASK_ID, _TASK_ID])
        self.assertEqual(service.archive_task_ids, [_TASK_ID])
        self.assertEqual(content.open_calls, 1)
        self.assertEqual(output.source_asset_id, request.source_asset_id)
        self.assertEqual(output.source_sha256, request.source_sha256)
        self.assertEqual(output.page_count, 2)
        self.assertEqual(_read(output.markdown.content), _fixture("document.md"))
        self.assertEqual(tuple(item.reference for item in output.resources), ("images/figure.png",))
        self.assertTrue(
            _read(output.resources[0].artifact.content).startswith(b"\x89PNG\r\n\x1a\n")
        )
        self.assertEqual(output.provenance.parser_version, "3.4.4")
        self.assertEqual(output.provenance.mode, "vlm-engine")
        self.assertEqual(output.provenance.model_identity, _MODEL_IDENTITY)
        provenance = output.provenance.provenance
        self.assertEqual(provenance.provenance_id, _PROVENANCE_ID)
        self.assertIs(provenance.source_kind, SourceKind.PARSER)
        self.assertEqual(provenance.source_name, "mineru")
        self.assertIsNone(provenance.source_record_id)
        self.assertEqual(provenance.observed_at, _TIME)
        self.assertEqual(provenance.input_sha256, request.source_sha256)
        self.assertIsNotNone(provenance.parameters_sha256)
        self.assertNotIn(_TASK_ID, repr(output))
        self.assertNotIn(_ARCHIVE_SENTINEL.decode(), repr(output))
        self.assertTrue(recorder.paths)
        self.assertTrue(all(not path.exists() for path in recorder.paths))

        # Returned capabilities are in-memory and remain valid after archive cleanup.
        self.assertEqual(_read(output.markdown.content), _fixture("document.md"))
        self.assertTrue(_read(output.resources[0].artifact.content).startswith(b"\x89PNG"))

    def test_resume_polls_known_task_without_submit_or_task_persistence(self) -> None:
        request, _content = _request()
        service = _FakeMinerUService(submit=AssertionError("resume must not submit"))

        output = _adapter(service).resume(request, _TASK_ID)

        self.assertEqual(service.calls, ["health", "poll", "poll", "archive"])
        self.assertEqual(service.submit_calls, 0)
        self.assertNotIn(_TASK_ID, repr(output))
        self.assertIsNone(output.provenance.provenance.source_record_id)
        self.assertFalse(hasattr(output, "task_id"))

    def test_profile_and_health_contract_fail_closed_without_fallback(self) -> None:
        with self.assertRaises(ValueError):
            _adapter(_FakeMinerUService(), profile="pipeline")
        with self.assertRaises(ValueError):
            _adapter(_FakeMinerUService(), profile="hybrid-high")

        rejected = (
            MinerUHealth(status="starting", release="3.4.4", api_protocol=2),
            MinerUHealth(status="healthy", release="4.0.0", api_protocol=2),
            MinerUHealth(status="healthy", release="3.4.4", api_protocol=3),
            object(),
        )
        for health in rejected:
            with self.subTest(health=type(health).__name__):
                request, _content = _request()
                service = _FakeMinerUService(health=health)
                with self.assertRaises(MinerUAdapterError) as caught:
                    _adapter(service).parse(request)
                self.assertEqual(caught.exception.code, "service-contract-invalid")
                self.assertEqual(service.calls, ["health"])

    def test_task_lifecycle_is_bounded_and_identity_aligned(self) -> None:
        cases: tuple[tuple[str, object, tuple[object, ...], str], ...] = (
            (
                "submit-type",
                object(),
                (),
                "task-invalid",
            ),
            (
                "submit-failed",
                MinerUTask(task_id=_TASK_ID, state="failed"),
                (),
                "task-failed",
            ),
            (
                "poll-missing",
                MinerUTask(task_id=_TASK_ID, state="pending"),
                (None,),
                "task-missing",
            ),
            (
                "poll-mismatch",
                MinerUTask(task_id=_TASK_ID, state="pending"),
                (MinerUTask(task_id="different-task", state="completed"),),
                "task-invalid",
            ),
            (
                "poll-failed",
                MinerUTask(task_id=_TASK_ID, state="pending"),
                (MinerUTask(task_id=_TASK_ID, state="failed"),),
                "task-failed",
            ),
        )
        for name, submit, polls, code in cases:
            with self.subTest(name=name):
                request, _content = _request()
                service = _FakeMinerUService(submit=submit, polls=polls)
                with self.assertRaises(MinerUAdapterError) as caught:
                    _adapter(service).parse(request)
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn(_TASK_ID, f"{caught.exception!s} {caught.exception!r}")
                self.assertNotIn(_PRIVATE_PATH, f"{caught.exception!s} {caught.exception!r}")

        request, _content = _request()
        service = _FakeMinerUService(
            polls=(
                MinerUTask(task_id=_TASK_ID, state="processing"),
                MinerUTask(task_id=_TASK_ID, state="processing"),
            )
        )
        with self.assertRaises(MinerUAdapterError) as caught:
            _adapter(service, bounds=MinerUAdapterBounds(max_poll_attempts=2)).parse(request)
        self.assertEqual(caught.exception.code, "poll-limit")
        self.assertEqual(service.calls.count("poll"), 2)
        self.assertNotIn("archive", service.calls)

        request, _content = _request()
        completed = _FakeMinerUService(
            submit=MinerUTask(task_id=_TASK_ID, state="completed"),
            polls=(),
        )
        _adapter(completed).parse(request)
        self.assertEqual(completed.calls, ["health", "submit", "archive"])

    def test_task_id_and_archive_pairing_are_strict(self) -> None:
        invalid_task_ids = ("", "../private", "x" * 257, "task\nsecret")
        for task_id in invalid_task_ids:
            with self.subTest(task_id_length=len(task_id)):
                request, _content = _request()
                service = _FakeMinerUService()
                with self.assertRaises(MinerUAdapterError) as caught:
                    _adapter(service).resume(request, task_id)
                self.assertEqual(caught.exception.code, "task-invalid")
                self.assertEqual(service.calls, [])

        results = (
            (MinerUArchiveResult(state="pending", payload=None), "archive-unavailable"),
            (MinerUArchiveResult(state="expired", payload=None), "archive-unavailable"),
            (MinerUArchiveResult(state="completed", payload=None), "archive-unavailable"),
            (MinerUArchiveResult(state="pending", payload=_zip()), "archive-unavailable"),
            (object(), "archive-unavailable"),
        )
        for result, code in results:
            with self.subTest(result_type=type(result).__name__):
                request, _content = _request()
                service = _FakeMinerUService(archive=result)
                with self.assertRaises(MinerUAdapterError) as caught:
                    _adapter(service).parse(request)
                self.assertEqual(caught.exception.code, code)

    def test_local_pdf_validation_and_budgets_precede_all_service_io(self) -> None:
        valid_pdf = _pdf()
        cases: tuple[tuple[str, bytes, Sha256 | None, MinerUAdapterBounds, str], ...] = (
            (
                "hash-mismatch",
                valid_pdf,
                Sha256("f" * 64),
                MinerUAdapterBounds(),
                "input-invalid",
            ),
            (
                "not-pdf",
                b"not a PDF",
                None,
                MinerUAdapterBounds(),
                "input-invalid",
            ),
            (
                "truncated-pdf",
                b"%PDF-1.7\ntruncated",
                None,
                MinerUAdapterBounds(),
                "input-invalid",
            ),
            (
                "byte-budget",
                valid_pdf,
                None,
                MinerUAdapterBounds(max_input_bytes=len(valid_pdf) - 1),
                "input-budget",
            ),
            (
                "page-budget",
                valid_pdf,
                None,
                MinerUAdapterBounds(max_pages=1),
                "input-budget",
            ),
        )
        for name, payload, declared_sha256, bounds, code in cases:
            with self.subTest(name=name):
                request, _content = _request(payload, declared_sha256=declared_sha256)
                service = _FakeMinerUService()
                with self.assertRaises(MinerUAdapterError) as caught:
                    _adapter(service, bounds=bounds).parse(request)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(service.calls, [])

    def test_service_and_archive_failures_are_content_free(self) -> None:
        failures = (
            _FakeMinerUService(health=RuntimeError(f"secret {_PRIVATE_PATH}")),
            _FakeMinerUService(submit=RuntimeError(f"secret {_PRIVATE_PATH}")),
            _FakeMinerUService(polls=(RuntimeError(f"secret {_PRIVATE_PATH}"),)),
            _FakeMinerUService(archive=RuntimeError(f"secret {_PRIVATE_PATH}")),
            _FakeMinerUService(
                archive=MinerUArchiveResult(
                    state="completed",
                    payload=b"not-a-zip " + _ARCHIVE_SENTINEL,
                )
            ),
        )
        for service in failures:
            request, _content = _request()
            with self.assertRaises(MinerUAdapterError) as caught:
                _adapter(service).parse(request)
            rendered = f"{caught.exception!s} {caught.exception!r}"
            self.assertNotIn(_PRIVATE_PATH, rendered)
            self.assertNotIn(_TASK_ID, rendered)
            self.assertNotIn(_ARCHIVE_SENTINEL.decode(), rendered)

    def test_parameter_hash_is_deterministic_and_covers_effective_options(self) -> None:
        request, _content = _request()
        first = _adapter(_FakeMinerUService()).parse(request)
        second = _adapter(_FakeMinerUService()).parse(request)
        other_model = _adapter(
            _FakeMinerUService(), model_identity="operator-vlm-model@other-revision"
        ).parse(request)
        other_bounds = _adapter(
            _FakeMinerUService(),
            bounds=MinerUAdapterBounds(max_poll_attempts=3),
        ).parse(request)

        first_hash = first.provenance.provenance.parameters_sha256
        self.assertEqual(first_hash, second.provenance.provenance.parameters_sha256)
        self.assertNotEqual(first_hash, other_model.provenance.provenance.parameters_sha256)
        self.assertNotEqual(first_hash, other_bounds.provenance.provenance.parameters_sha256)

    def test_converter_filters_private_outputs_and_outlives_archive_context(self) -> None:
        recorder = _TemporaryRecorder()
        with patch(
            "sciretriever.parsing.archive.tempfile.TemporaryDirectory",
            new=recorder,
        ):
            converted = convert_mineru_archive(_zip(), expected_page_count=2)

        self.assertEqual(converted.page_count, 2)
        self.assertEqual(_read(converted.markdown.content), _fixture("document.md"))
        self.assertEqual(
            tuple(resource.reference for resource in converted.resources),
            ("images/figure.png",),
        )
        self.assertNotIn("json", repr(converted).casefold())
        self.assertNotIn("layout", repr(converted).casefold())
        self.assertNotIn("origin", repr(converted).casefold())
        self.assertTrue(all(not path.exists() for path in recorder.paths))
        self.assertTrue(_read(converted.resources[0].artifact.content).startswith(b"\x89PNG"))

    def test_converter_rejects_archive_and_primary_role_ambiguity(self) -> None:
        traversal = zipfile.ZipInfo("../private.json")
        traversal.external_attr = 0o100600 << 16
        cases: tuple[tuple[str, bytes, str], ...] = (
            ("truncated", b"PK\x03\x04truncated", "archive-invalid"),
            (
                "missing-middle",
                _replaced_archive(document_middle=None),
                "primary-output-invalid",
            ),
            (
                "second-middle",
                _zip([*_entries(), ("other_middle.json", b'{"_backend":"vlm"}')]),
                "primary-output-invalid",
            ),
            (
                "unsafe-member",
                _zip([*_entries(), (traversal, b"private")]),
                "archive-invalid",
            ),
        )
        for name, payload, code in cases:
            with self.subTest(name=name):
                with self.assertRaises(MinerUConversionError) as caught:
                    convert_mineru_archive(payload, expected_page_count=2)
                self.assertEqual(caught.exception.code, code)

        payload = _zip()
        bounds = MinerUConversionBounds(
            archive_bounds=ParserArchiveBounds(max_archive_bytes=len(payload) - 1)
        )
        with self.assertRaises(MinerUConversionError) as caught:
            convert_mineru_archive(payload, expected_page_count=2, bounds=bounds)
        self.assertEqual(caught.exception.code, "archive-budget")

    def test_converter_rejects_strict_json_and_json_budgets(self) -> None:
        duplicate_middle = (
            b'{"_backend":"vlm","_backend":"vlm","pdf_info":[{"page_idx":0},{"page_idx":1}]}'
        )
        nonfinite_model = b'{"score": NaN}'
        deep_model = json.dumps({"a": {"b": {"c": {"d": 1}}}}).encode()
        cases: tuple[tuple[str, bytes, MinerUConversionBounds, str], ...] = (
            (
                "duplicate-key",
                _replaced_archive(document_middle=duplicate_middle),
                MinerUConversionBounds(),
                "json-invalid",
            ),
            (
                "nonfinite",
                _replaced_archive(document_model=nonfinite_model),
                MinerUConversionBounds(),
                "json-invalid",
            ),
            (
                "depth",
                _replaced_archive(document_model=deep_model),
                MinerUConversionBounds(max_json_depth=3),
                "json-budget",
            ),
            (
                "bytes",
                _zip(),
                MinerUConversionBounds(max_json_bytes=32),
                "json-budget",
            ),
            (
                "elements",
                _zip(),
                MinerUConversionBounds(max_json_elements=8),
                "json-budget",
            ),
            (
                "strings",
                _zip(),
                MinerUConversionBounds(max_json_string_characters=16),
                "json-budget",
            ),
        )
        for name, payload, bounds, code in cases:
            with self.subTest(name=name):
                with self.assertRaises(MinerUConversionError) as caught:
                    convert_mineru_archive(payload, expected_page_count=2, bounds=bounds)
                self.assertEqual(caught.exception.code, code)

    def test_converter_rejects_backend_page_order_and_image_mismatches(self) -> None:
        backend = _fixture("document_middle.json").replace(b'"vlm"', b'"pipeline"', 1)
        one_page = _fixture("document_middle.json").replace(
            b',\n    {\n      "discarded_blocks": [],\n      "page_idx": 1,\n'
            b'      "page_size": [612, 792],\n      "para_blocks": []\n    }',
            b"",
            1,
        )
        out_of_order = b'[{"page_idx":1},{"page_idx":0}]'
        unsafe_image = _fixture("document_middle.json").replace(
            b'"images/figure.png"', b'"../private.png"'
        )
        missing_image = _fixture("document_middle.json").replace(
            b'"images/figure.png"', b'"images/missing.png"'
        )
        non_image_path = _fixture("document_middle.json").replace(
            b'"images/figure.png"', b'"document_model.json"'
        )
        private_middle_markdown = (
            b"# Invalid private reference\n\n![private](document_middle.json)\n"
        )
        private_model_markdown = b"# Invalid private reference\n\n![private](document_model.json)\n"
        private_content_markdown = (
            b"# Invalid private reference\n\n![private](document_content_list.json)\n"
        )
        private_layout_markdown = (
            b"# Invalid private reference\n\n![private](document_layout.pdf)\n"
        )
        private_origin_markdown = (
            b"# Invalid private reference\n\n![private](document_origin.pdf)\n"
        )
        private_span_markdown = b"# Invalid private reference\n\n![private](document_span.pdf)\n"
        bad_png_entries = _entries()
        bad_png_entries = [
            (name, b"not a png" if name == "images/figure.png" else payload)
            for name, payload in bad_png_entries
        ]
        cases: tuple[tuple[str, bytes, str], ...] = (
            (
                "backend",
                _replaced_archive(document_middle=backend),
                "backend-mismatch",
            ),
            (
                "page-count",
                _replaced_archive(document_middle=one_page),
                "page-mismatch",
            ),
            (
                "content-order",
                _replaced_archive(document_content_list=out_of_order),
                "content-list-invalid",
            ),
            (
                "unsafe-image",
                _replaced_archive(document_middle=unsafe_image),
                "resource-invalid",
            ),
            (
                "missing-image",
                _replaced_archive(document_middle=missing_image),
                "resource-invalid",
            ),
            (
                "non-image-path",
                _replaced_archive(document_middle=non_image_path),
                "resource-invalid",
            ),
            (
                "private-middle-reference",
                _replaced_archive(**{"document.md": private_middle_markdown}),
                "resource-invalid",
            ),
            (
                "private-model-reference",
                _replaced_archive(**{"document.md": private_model_markdown}),
                "resource-invalid",
            ),
            (
                "private-content-list-reference",
                _replaced_archive(**{"document.md": private_content_markdown}),
                "resource-invalid",
            ),
            (
                "private-layout-reference",
                _replaced_archive(**{"document.md": private_layout_markdown}),
                "resource-invalid",
            ),
            (
                "private-origin-reference",
                _replaced_archive(**{"document.md": private_origin_markdown}),
                "resource-invalid",
            ),
            (
                "private-span-reference",
                _replaced_archive(**{"document.md": private_span_markdown}),
                "resource-invalid",
            ),
            ("media-mismatch", _zip(bad_png_entries), "resource-invalid"),
        )
        for name, payload, code in cases:
            with self.subTest(name=name):
                with self.assertRaises(MinerUConversionError) as caught:
                    convert_mineru_archive(payload, expected_page_count=2)
                self.assertEqual(caught.exception.code, code)

    def test_conversion_and_adapter_bounds_are_strict_positive_values(self) -> None:
        constructors = (
            lambda: MinerUAdapterBounds(max_input_bytes=0),
            lambda: MinerUAdapterBounds(max_pages=True),
            lambda: MinerUConversionBounds(max_json_elements=0),
            lambda: MinerUConversionBounds(max_json_string_characters=-1),
        )
        for constructor in constructors:
            with self.subTest(constructor=constructor):
                with self.assertRaises((TypeError, ValueError)):
                    constructor()

        # Nested P2 limits are part of the converter's effective contract.
        conversion = MinerUConversionBounds(
            archive_bounds=ParserArchiveBounds(max_archive_bytes=1024),
            markdown_bounds=MarkdownConversionBounds(max_markdown_bytes=1024),
            resource_bounds=ParserResourceBounds(max_resource_bytes=1024),
        )
        self.assertEqual(conversion.archive_bounds.max_archive_bytes, 1024)
        self.assertEqual(conversion.markdown_bounds.max_markdown_bytes, 1024)
        self.assertEqual(conversion.resource_bounds.max_resource_bytes, 1024)

    def test_adapter_source_has_no_direct_http_or_legacy_contract(self) -> None:
        forbidden_imports = {"httpx", "requests", "socket", "urllib", "urllib3"}
        forbidden_terms = ("LightDocumentV1", "ManifestBlock", "resume_task_id=")
        for name in ("mineru.py", "mineru_converter.py"):
            source = (
                Path(__file__).parents[1] / "src" / "sciretriever" / "parsing" / "adapters" / name
            ).read_text(encoding="utf-8")
            tree = ast.parse(source)
            imported: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(alias.name.split(".", maxsplit=1)[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module is not None:
                    imported.add(node.module.split(".", maxsplit=1)[0])
            self.assertTrue(imported.isdisjoint(forbidden_imports), name)
            for term in forbidden_terms:
                self.assertNotIn(term, source, name)


if __name__ == "__main__":
    unittest.main()
