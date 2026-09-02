from __future__ import annotations

import http.client
import logging
import pickle
import socket
import ssl
import threading
import unittest
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable, cast
from unittest.mock import patch

import sciretriever.network.http as network_http_module
from sciretriever.model.access import AccessFailure, Header, TransportRequest, TransportResponse
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessFeedback,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
    HostPermit,
)
from sciretriever.network.http import HttpClient, SecureHttpTransport
from sciretriever.network.policy import (
    AddressClass,
    DestinationPolicy,
    Origin,
    ResolvedDestination,
    ResourceBudget,
    resolve_destination,
)

_HOST_POLICY = DestinationPolicy(
    allowed_classes=frozenset({AddressClass.PUBLIC}),
)
_LOOPBACK_POLICY = DestinationPolicy(
    allowed_schemes=frozenset({"http", "https"}),
    allowed_classes=frozenset({AddressClass.LOOPBACK}),
    allowed_addresses=frozenset({"127.0.0.1"}),
)


class _Resolver:
    def __init__(self, answers: dict[str, tuple[str, ...]]) -> None:
        self.answers = answers
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return self.answers[hostname]


class _RebindingResolver(_Resolver):
    def __init__(self, answers: dict[str, list[tuple[str, ...]]]) -> None:
        super().__init__({})
        self.sequential_answers = answers

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return self.sequential_answers[hostname].pop(0)


@dataclass
class _RawResponse:
    status: int
    headers: tuple[Header, ...]
    body: bytes | Iterable[bytes]
    closed: bool = False

    def close(self) -> None:
        self.closed = True


class _FakeTransport:
    def __init__(self, actions: Iterable[object]) -> None:
        self.actions = list(actions)
        self.calls: list[dict[str, object]] = []
        self.closed = False

    def send(
        self,
        request: object,
        destination: object,
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
        if callable(action):
            return action(request, destination, headers, cancel_event)
        if isinstance(action, BaseException):
            raise action
        return action

    def close(self) -> None:
        self.closed = True


class _RecordingCoordinator(AccessCoordinator):
    def __init__(self, *, clock: _AdvancingClock | None = None) -> None:
        super().__init__(clock=clock)
        self.scope_acquires = 0
        self.scopes: list[AccessScope] = []
        self.host_acquires = 0

    def acquire_scope(
        self,
        scope: AccessScope,
        policy: AccessPolicy | None = None,
        *,
        operator_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
    ) -> AccessPermit:
        self.scope_acquires += 1
        self.scopes.append(scope)
        return super().acquire_scope(
            scope,
            policy,
            operator_policy=operator_policy,
            cancel_event=cancel_event,
            timeout=timeout,
        )

    def _acquire_host(
        self,
        owner: AccessPermit,
        host: str,
        *,
        host_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> HostPermit:
        self.host_acquires += 1
        return super()._acquire_host(
            owner,
            host,
            host_policy=host_policy,
            cancel_event=cancel_event,
            timeout=timeout,
        )


class _AdvancingClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class _FakeSocket:
    def __init__(self) -> None:
        self.closed = False
        self.connected_to: tuple[object, ...] | None = None
        self.timeouts: list[float | None] = []
        self.sent: list[bytes] = []

    def settimeout(self, value: float | None) -> None:
        self.timeouts.append(value)

    def connect(self, address: tuple[object, ...]) -> None:
        self.connected_to = address

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


class _BlockingSocket(_FakeSocket):
    def __init__(self, phase: str, entered: threading.Event) -> None:
        super().__init__()
        self.phase = phase
        self.entered = entered
        self.closed_event = threading.Event()
        self.operation_finished = threading.Event()

    def connect(self, address: tuple[object, ...]) -> None:
        if self.phase != "connect":
            super().connect(address)
            return
        self.connected_to = address
        self._block_until_closed()

    def sendall(self, data: bytes) -> None:
        if self.phase != "send":
            super().sendall(data)
            return
        self.sent.append(data)
        self._block_until_closed()

    def close(self) -> None:
        super().close()
        self.closed_event.set()

    def _block_until_closed(self) -> None:
        self.entered.set()
        self.closed_event.wait(1.0)
        self.operation_finished.set()
        raise OSError("socket closed")


class _WrappedFakeSocket(_FakeSocket):
    def __init__(self, raw: _FakeSocket) -> None:
        super().__init__()
        self.raw = raw

    def close(self) -> None:
        self.closed = True
        self.raw.close()


class _PortMappedSocket:
    """Test-only socket that maps policy's port 80 to an ephemeral server."""

    def __init__(self, raw: socket.socket, port: int) -> None:
        self.raw = raw
        self.port = port

    def settimeout(self, value: float | None) -> None:
        self.raw.settimeout(value)

    def connect(self, address: tuple[object, ...]) -> None:
        self.raw.connect((cast(str, address[0]), self.port))

    def sendall(self, data: bytes) -> None:
        self.raw.sendall(data)

    def makefile(self, *args: Any, **kwargs: Any) -> Any:
        return self.raw.makefile(*args, **kwargs)

    def close(self) -> None:
        self.raw.close()


class _FakeTLSContext:
    def __init__(
        self,
        wrapped: list[_WrappedFakeSocket],
        server_hostnames: list[str | None] | None = None,
    ) -> None:
        self.wrapped = wrapped
        self.server_hostnames = server_hostnames

    def wrap_socket(self, raw: _FakeSocket, *, server_hostname: str | None) -> _WrappedFakeSocket:
        result = _WrappedFakeSocket(raw)
        self.wrapped.append(result)
        if self.server_hostnames is not None:
            self.server_hostnames.append(server_hostname)
        return result


class _FakeHttpResponse:
    status = 200

    def __init__(self, sock: socket.socket) -> None:
        del sock
        self.closed = False

    def begin(self) -> None:
        return None

    def getheaders(self) -> list[tuple[str, str]]:
        return []

    def read(self, amount: int = -1) -> bytes:
        del amount
        return b""

    def close(self) -> None:
        self.closed = True


class _BlockingHttpResponse:
    status = 200

    def __init__(self, phase: str, entered: threading.Event) -> None:
        self.phase = phase
        self.entered = entered
        self.closed = False
        self.closed_event = threading.Event()
        self.operation_finished = threading.Event()

    def begin(self) -> None:
        if self.phase == "begin":
            self._block_until_closed()

    def getheaders(self) -> list[tuple[str, str]]:
        if self.phase == "header":
            self._block_until_closed()
        return []

    def read(self, amount: int = -1) -> bytes:
        del amount
        if self.phase == "body":
            self._block_until_closed()
        return b""

    def close(self) -> None:
        self.closed = True
        self.closed_event.set()

    def _block_until_closed(self) -> None:
        self.entered.set()
        self.closed_event.wait(1.0)
        self.operation_finished.set()
        raise OSError("response closed")


class _BlockingTLSContext:
    def __init__(self, entered: threading.Event, *, blocking: bool) -> None:
        self.entered = entered
        self.blocking = blocking
        self.operation_finished = threading.Event()

    def wrap_socket(self, raw: _BlockingSocket, *, server_hostname: str | None) -> object:
        del server_hostname
        if not self.blocking:
            return raw
        self.entered.set()
        raw.closed_event.wait(1.0)
        self.operation_finished.set()
        raise ssl.SSLError("TLS socket closed")


def _response(
    status: int = 200,
    *,
    body: bytes = b"ok",
    location: str | None = None,
) -> _RawResponse:
    headers = () if location is None else (Header(name="Location", value=location),)
    return _RawResponse(status=status, headers=headers, body=body)


def _response_value(value: TransportResponse | AccessFailure) -> TransportResponse:
    if not isinstance(value, TransportResponse):
        raise AssertionError(f"expected response, got {type(value).__name__}")
    return value


def _failure_value(value: TransportResponse | AccessFailure) -> AccessFailure:
    if not isinstance(value, AccessFailure):
        raise AssertionError(f"expected failure, got {type(value).__name__}")
    return value


def _safe_request_from_call(call: dict[str, object]) -> TransportRequest:
    request = call["request"]
    if not isinstance(request, TransportRequest):
        raise AssertionError("transport did not receive a TransportRequest")
    return request


def _wire_target_from_call(call: dict[str, object]) -> str:
    request = _safe_request_from_call(call)
    destination = call["destination"]
    if not isinstance(destination, ResolvedDestination):
        raise AssertionError("transport did not receive a verified destination")
    renderer = call["request_target_renderer"]
    render = getattr(renderer, "render", None)
    if not callable(render):
        raise AssertionError("transport did not receive a request-target renderer")
    target = render(request, destination)
    if not isinstance(target, str):
        raise AssertionError("request-target renderer did not return text")
    return target


def _credential_origin(hostname: str = "example.test") -> Origin:
    return Origin("https", hostname, 443)


def _nested_percent_encoding(value: str, *, layers: int) -> str:
    if layers < 1:
        raise ValueError("layers must be positive")
    encoded = "".join(f"%{byte:02X}" for byte in value.encode("utf-8"))
    for _ in range(layers - 1):
        encoded = encoded.replace("%", "%25")
    return encoded


class NetworkHttpTests(unittest.TestCase):
    def _client(
        self,
        transport: _FakeTransport,
        resolver: _Resolver,
        *,
        destination_policy: DestinationPolicy = _HOST_POLICY,
        coordinator: AccessCoordinator | None = None,
        clock: _AdvancingClock | None = None,
    ) -> HttpClient:
        return HttpClient(
            resolver=resolver,
            transport=transport,
            coordinator=coordinator or AccessCoordinator(),
            destination_policy=destination_policy,
            clock=clock,
        )

    def test_missing_http_module_is_replaced_by_secure_bounded_request(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"payload")])
        client = self._client(transport, resolver)
        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )

        self.assertEqual(result.body, b"payload")
        self.assertEqual(len(transport.calls), 1)
        call = transport.calls[0]
        self.assertEqual(call["tls_server_hostname"], "example.test")
        destination = cast(ResolvedDestination, call["destination"])
        self.assertEqual(destination.addresses, ("93.184.216.34",))

    def test_request_logging_has_safe_terminal_elapsed_and_suppresses_credentials(self) -> None:
        scope = AccessScope("fixture-provider", "api", "metadata")
        policy = AccessPolicy(max_concurrency=1)
        success_client = self._client(
            _FakeTransport([_response(body=b"payload")]),
            _Resolver({"example.test": ("93.184.216.34",)}),
        )

        with self.assertLogs("sciretriever.network.http", level="DEBUG") as captured:
            success = _response_value(
                success_client.request(
                    scope,
                    "https://example.test/private-path-must-not-log",
                    policy,
                )
            )

        self.assertEqual(success.body, b"payload")
        output = "\n".join(captured.output)
        self.assertIn("event=network-request-started", output)
        self.assertIn("provider=fixture-provider channel=api service=metadata", output)
        self.assertIn("event=network-request-finished", output)
        self.assertIn("status=200 response_bytes=7", output)
        self.assertRegex(output, r"elapsed_ms=\d+")
        self.assertNotIn("private-path-must-not-log", output)
        self.assertTrue(all(record.levelno == logging.DEBUG for record in captured.records))

        failed_client = self._client(
            _FakeTransport([OSError("PRIVATE-TRANSPORT-SENTINEL")]),
            _Resolver({"example.test": ("93.184.216.34",)}),
        )
        with self.assertLogs("sciretriever.network.http", level="DEBUG") as failed_logs:
            failure = _failure_value(
                failed_client.request(
                    scope,
                    "https://example.test/another-private-path",
                    policy,
                )
            )
        failure_output = "\n".join(failed_logs.output)
        self.assertEqual(failure.code, "transport")
        self.assertIn("event=network-request-failed", failure_output)
        self.assertIn("code=transport retryable=true", failure_output)
        self.assertRegex(failure_output, r"elapsed_ms=\d+")
        self.assertNotIn("PRIVATE-TRANSPORT-SENTINEL", failure_output)
        self.assertNotIn("another-private-path", failure_output)
        terminal = next(
            record
            for record in failed_logs.records
            if "event=network-request-failed" in record.getMessage()
        )
        self.assertEqual(terminal.levelno, logging.WARNING)

        credential_client = self._client(
            _FakeTransport([_response(body=b"credentialed")]),
            _Resolver({"example.test": ("93.184.216.34",)}),
        )
        with self.assertNoLogs("sciretriever.network.http", level="DEBUG"):
            credentialed = _response_value(
                credential_client.request(
                    scope,
                    "https://example.test/credentialed",
                    policy,
                    credential_headers={"Authorization": "Bearer PRIVATE-CREDENTIAL"},
                    credential_allowed_origins=(_credential_origin(),),
                )
            )
        self.assertEqual(credentialed.body, b"credentialed")

    def test_default_clients_reject_nondefault_ports_before_dns_or_transport(self) -> None:
        cases = (
            (
                "https://example.test:8443/resource",
                _HOST_POLICY,
            ),
            (
                "http://example.test:8000/resource",
                DestinationPolicy(
                    allowed_schemes=frozenset({"http"}),
                    allowed_classes=frozenset({AddressClass.PUBLIC}),
                ),
            ),
        )
        for url, destination_policy in cases:
            with self.subTest(url=url):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])

                result = _failure_value(
                    self._client(
                        transport,
                        resolver,
                        destination_policy=destination_policy,
                    ).request(
                        AccessScope("fixture-provider", "api"),
                        url,
                        AccessPolicy(max_concurrency=1),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])

    def test_explicit_exact_port_reaches_transport_and_survives_opaque_path(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"done")])
        destination_policy = DestinationPolicy(
            allowed_ports=frozenset({("https", 8443)}),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
        )

        result = _response_value(
            self._client(
                transport,
                resolver,
                destination_policy=destination_policy,
            ).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test:8443/tasks",
                AccessPolicy(max_concurrency=1),
                path_parameter="fixture/task",
            )
        )

        expected = "https://example.test:8443/tasks/fixture%2Ftask"
        call = transport.calls[0]
        request = _safe_request_from_call(call)
        destination = cast(ResolvedDestination, call["destination"])
        self.assertEqual(request.url, expected)
        self.assertEqual(destination.url.url, expected)
        self.assertEqual(destination.url.port, 8443)
        self.assertEqual(destination.origin.text, "https://example.test:8443")
        self.assertEqual(result.final_url, expected)

    def test_nondefault_https_credential_origin_is_exactly_port_bound(self) -> None:
        secret = "custom-port-bearer-sentinel"
        destination_policy = DestinationPolicy(
            allowed_ports=frozenset({("https", 8443)}),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
        )
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"done")])
        client = self._client(
            transport,
            resolver,
            destination_policy=destination_policy,
        )

        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test:8443/resource",
                AccessPolicy(max_concurrency=1),
                credential_headers={"Authorization": f"Bearer {secret}"},
                credential_allowed_origins=(Origin("https", "example.test", 8443),),
            )
        )

        self.assertEqual(result.final_url, "https://example.test:8443/resource")
        self.assertEqual(
            transport.calls[0]["headers"],
            (("Authorization", f"Bearer {secret}"),),
        )

        wrong_transport = _FakeTransport([_response()])
        wrong = _failure_value(
            self._client(
                wrong_transport,
                _Resolver({"example.test": ("93.184.216.34",)}),
                destination_policy=destination_policy,
            ).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test:8443/resource",
                AccessPolicy(max_concurrency=1),
                credential_headers={"Authorization": f"Bearer {secret}"},
                credential_allowed_origins=(Origin("https", "example.test", 443),),
            )
        )
        self.assertEqual(wrong.code, "policy")
        self.assertEqual(wrong_transport.calls, [])
        self.assertNotIn(secret, repr(wrong))

    def test_cross_port_redirect_is_rejected_or_strips_credentials(self) -> None:
        secret = "cross-port-header-sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        one_port_transport = _FakeTransport(
            [_response(302, location="https://example.test:9443/next")]
        )
        one_port_policy = DestinationPolicy(
            allowed_ports=frozenset({("https", 8443)}),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
        )

        rejected = _failure_value(
            self._client(
                one_port_transport,
                resolver,
                destination_policy=one_port_policy,
            ).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test:8443/start",
                AccessPolicy(max_concurrency=1),
                credential_headers={"Authorization": f"Bearer {secret}"},
                credential_allowed_origins=(Origin("https", "example.test", 8443),),
            )
        )
        self.assertEqual(rejected.code, "policy")
        self.assertEqual(len(one_port_transport.calls), 1)

        both_ports_transport = _FakeTransport(
            [
                _response(302, location="https://example.test:9443/next"),
                _response(body=b"done"),
            ]
        )
        both_ports_policy = DestinationPolicy(
            allowed_ports=frozenset(
                {
                    ("https", 8443),
                    ("https", 9443),
                }
            ),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
        )

        result = _response_value(
            self._client(
                both_ports_transport,
                _Resolver({"example.test": ("93.184.216.34",)}),
                destination_policy=both_ports_policy,
            ).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test:8443/start",
                AccessPolicy(max_concurrency=1),
                credential_headers={"Authorization": f"Bearer {secret}"},
                credential_allowed_origins=(Origin("https", "example.test", 8443),),
            )
        )

        self.assertEqual(result.final_url, "https://example.test:9443/next")
        self.assertEqual(
            [call["headers"] for call in both_ports_transport.calls],
            [(("Authorization", f"Bearer {secret}"),), ()],
        )
        self.assertEqual(
            [
                cast(ResolvedDestination, call["destination"]).url.port
                for call in both_ports_transport.calls
            ],
            [8443, 9443],
        )

    def test_secure_transport_connects_and_renders_host_at_exact_nondefault_port(self) -> None:
        sockets: list[_FakeSocket] = []

        def socket_factory(family: int, kind: int) -> _FakeSocket:
            del family, kind
            sock = _FakeSocket()
            sockets.append(sock)
            return sock

        destination_policy = DestinationPolicy(
            allowed_schemes=frozenset({"http"}),
            allowed_ports=frozenset({("http", 8000)}),
            allowed_classes=frozenset({AddressClass.PUBLIC}),
        )
        transport = SecureHttpTransport(socket_factory=socket_factory)
        client = HttpClient(
            resolver=_Resolver({"example.test": ("93.184.216.34",)}),
            transport=transport,
            coordinator=AccessCoordinator(),
            destination_policy=destination_policy,
        )

        with patch.object(http.client, "HTTPResponse", _FakeHttpResponse):
            result = _response_value(
                client.request(
                    AccessScope("fixture-provider", "api"),
                    "http://example.test:8000/resource",
                    AccessPolicy(max_concurrency=1),
                )
            )

        self.assertEqual(result.final_url, "http://example.test:8000/resource")
        self.assertEqual(sockets[0].connected_to, ("93.184.216.34", 8000))
        wire_request = sockets[0].sent[0].decode("ascii")
        self.assertIn("Host: example.test:8000\r\n", wire_request)
        self.assertEqual(wire_request.count("Host:"), 1)
        self.assertEqual(transport._sockets, {})

    def test_response_feedback_is_applied_before_the_scope_permit_is_released(self) -> None:
        clock = _AdvancingClock()
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(429), _response(body=b"resumed")])
        coordinator = AccessCoordinator(clock=clock)
        client = self._client(
            transport,
            resolver,
            coordinator=coordinator,
            clock=clock,
        )
        scope = AccessScope("fixture-provider", "api")
        policy = AccessPolicy(max_concurrency=1)
        interpreted: list[TransportResponse] = []

        def response_feedback(response: TransportResponse) -> AccessFeedback:
            interpreted.append(response)
            self.assertEqual(len(coordinator._active_scope_permits), 1)
            return AccessFeedback(retry_after=5.0, throttled=True)

        result = _response_value(
            client.request(
                scope,
                "https://example.test/resource",
                policy,
                response_feedback=response_feedback,
            )
        )

        self.assertEqual(result.status, 429)
        self.assertEqual(interpreted, [result])
        self.assertEqual(coordinator._active_scope_permits, {})
        with self.assertRaises(AdmissionTimeout):
            coordinator.acquire_scope(scope, timeout=0.01)
        clock.advance(5.0)
        coordinator.wake()
        resumed = _response_value(client.request(scope, "https://example.test/resource", policy))
        self.assertEqual(resumed.body, b"resumed")

    def test_encoded_ascii_space_query_reaches_the_transport(self) -> None:
        urls = (
            "https://example.test/search?query=retrieval+systems",
            "https://example.test/search?query=retrieval%20systems",
            (
                "https://example.test/search?search_query="
                "submittedDate:%5B202601010000+TO+202601312359%5D"
            ),
        )
        for url in urls:
            with self.subTest(url=url):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])
                client = self._client(transport, resolver)

                result = _response_value(
                    client.request(
                        AccessScope("fixture-provider", "api"),
                        url,
                        AccessPolicy(max_concurrency=1),
                    )
                )

                self.assertEqual(_safe_request_from_call(transport.calls[0]).url, url)
                destination = cast(ResolvedDestination, transport.calls[0]["destination"])
                self.assertEqual(destination.url.url, url)
                self.assertEqual(result.final_url, url)

        invalid = (
            "https://example.test/search?query=retrieval systems",
            "https://example.test/search?query=retrieval%09systems",
            "https://example.test/search?query=retrieval%C2%A0systems",
        )
        for url in invalid:
            with self.subTest(url=url):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])
                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        url,
                        AccessPolicy(max_concurrency=1),
                    )
                )
                self.assertEqual(result.code, "policy")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])

    def test_network_encodes_one_opaque_path_parameter_in_the_actual_url(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"payload")])
        coordinator = _RecordingCoordinator()
        client = self._client(
            transport,
            resolver,
            coordinator=coordinator,
        )
        expected_url = "https://example.test/works/10.1038%2Fs41586-020-2649-2"

        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/works",
                AccessPolicy(max_concurrency=1),
                path_parameter="10.1038/s41586-020-2649-2",
                budget=ResourceBudget(max_response_bytes=7, max_navigations=1),
            )
        )

        call = transport.calls[0]
        self.assertEqual(_safe_request_from_call(call).url, expected_url)
        self.assertEqual(_wire_target_from_call(call), "/works/10.1038%2Fs41586-020-2649-2")
        destination = cast(ResolvedDestination, call["destination"])
        self.assertEqual(destination.url.url, expected_url)
        self.assertEqual(result.final_url, expected_url)
        self.assertEqual(result.body, b"payload")
        self.assertEqual(resolver.calls, ["example.test"] * 3)
        self.assertEqual(coordinator.scope_acquires, 1)
        self.assertEqual(coordinator.host_acquires, 1)

    def test_network_appends_one_safe_literal_after_the_opaque_parameter(self) -> None:
        for suffix in ("references", "citations"):
            with self.subTest(suffix=suffix):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response(body=b"payload")])
                coordinator = _RecordingCoordinator()
                expected_url = (
                    f"https://example.test/graph/v1/paper/DOI:10.1038%2Fs41586-020-2649-2/{suffix}"
                )

                result = _response_value(
                    self._client(
                        transport,
                        resolver,
                        coordinator=coordinator,
                    ).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/graph/v1/paper",
                        AccessPolicy(max_concurrency=1),
                        path_parameter="DOI:10.1038/s41586-020-2649-2",
                        path_parameter_suffix=suffix,
                    )
                )

                call = transport.calls[0]
                self.assertEqual(_safe_request_from_call(call).url, expected_url)
                self.assertEqual(
                    _wire_target_from_call(call),
                    f"/graph/v1/paper/DOI:10.1038%2Fs41586-020-2649-2/{suffix}",
                )
                destination = cast(ResolvedDestination, call["destination"])
                self.assertEqual(destination.url.url, expected_url)
                self.assertEqual(result.final_url, expected_url)
                self.assertEqual(resolver.calls, ["example.test"] * 3)
                self.assertEqual(coordinator.scope_acquires, 1)
                self.assertEqual(coordinator.host_acquires, 1)

    def test_opaque_path_parameter_keeps_response_budgets(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        response = _response(body=b"oversized")
        transport = _FakeTransport([response])
        coordinator = _RecordingCoordinator()

        result = _failure_value(
            self._client(
                transport,
                resolver,
                coordinator=coordinator,
            ).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/works",
                AccessPolicy(max_concurrency=1),
                path_parameter="10.1038/s41586-020-2649-2",
                path_parameter_suffix="citations",
                budget=ResourceBudget(max_response_bytes=4),
            )
        )

        self.assertEqual(result.code, "oversize")
        self.assertTrue(response.closed)
        self.assertEqual(resolver.calls, ["example.test"] * 3)
        self.assertEqual(coordinator.scope_acquires, 1)
        self.assertEqual(coordinator.host_acquires, 1)

    def test_opaque_path_parameter_rejects_unsafe_input_before_dns(self) -> None:
        invalid = (
            "",
            "   ",
            "../x",
            "/a",
            "a/",
            "a//b",
            "a/./b",
            "a/../b",
            "a\\b",
            "a/\x00/b",
            "a/\u200b/b",
            "%2E%2E/x",
            "%252E%252E%252Fx",
            "a%2F%2Fb",
        )
        for path_parameter in invalid:
            with self.subTest(path_parameter=repr(path_parameter)):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])

                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/works",
                        AccessPolicy(max_concurrency=1),
                        path_parameter=path_parameter,
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])

        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])
        manual_result = _failure_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/works/10.1038%2Fs41586-020-2649-2",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(manual_result.code, "policy")
        self.assertEqual(resolver.calls, [])
        self.assertEqual(transport.calls, [])

    def test_opaque_path_suffix_rejects_unsafe_input_before_dns(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])
        missing_parameter = _failure_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/graph/v1/paper",
                AccessPolicy(max_concurrency=1),
                path_parameter_suffix="references",
            )
        )
        self.assertEqual(missing_parameter.code, "policy")
        self.assertEqual(resolver.calls, [])
        self.assertEqual(transport.calls, [])

        invalid: tuple[object, ...] = (
            "",
            ".",
            "..",
            "/",
            "references/citations",
            "references\\citations",
            "%72eferences",
            "references?limit=1",
            "references#fragment",
            " references",
            "references ",
            "references\t",
            "references\n",
            "references\u200b",
            "références",
            7,
        )
        for suffix in invalid:
            with self.subTest(suffix=repr(suffix)):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])
                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/graph/v1/paper",
                        AccessPolicy(max_concurrency=1),
                        path_parameter="CorpusId:123",
                        path_parameter_suffix=cast(Any, suffix),
                    )
                )
                self.assertEqual(result.code, "policy")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])

    def test_opaque_path_parameter_and_private_query_remain_separate(self) -> None:
        credential = "opaque-path-private-sentinel"
        encoded_alias = "opaque%2Dpath%2Dprivate%2Dsentinel"
        for path_parameter in (credential, encoded_alias):
            with self.subTest(path_parameter=path_parameter):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])
                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/works",
                        AccessPolicy(max_concurrency=1),
                        path_parameter=f"10.1038/{path_parameter}",
                        credential_query={"api_key": credential},
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )
                self.assertEqual(result.code, "policy")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])
                self.assertNotIn(credential, repr(result))

        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])
        suffix_alias = _failure_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/graph/v1/paper",
                AccessPolicy(max_concurrency=1),
                path_parameter="CorpusId:123",
                path_parameter_suffix=credential,
                credential_query={"api_key": credential},
                credential_allowed_origins=(_credential_origin(),),
            )
        )
        self.assertEqual(suffix_alias.code, "policy")
        self.assertEqual(resolver.calls, [])
        self.assertEqual(transport.calls, [])
        self.assertNotIn(credential, repr(suffix_alias))

        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])
        result = _response_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/works",
                AccessPolicy(max_concurrency=1),
                path_parameter="10.1038/s41586-020-2649-2",
                path_parameter_suffix="references",
                credential_query={"api_key": credential},
                credential_allowed_origins=(_credential_origin(),),
            )
        )
        call = transport.calls[0]
        self.assertEqual(
            _wire_target_from_call(call),
            (f"/works/10.1038%2Fs41586-020-2649-2/references?api_key={credential}"),
        )
        self.assertEqual(_wire_target_from_call(call).count("api_key="), 1)
        self.assertNotIn(credential, _safe_request_from_call(call).url)
        self.assertNotIn(credential, result.final_url)

    def test_redirect_cannot_reintroduce_a_handwritten_encoded_separator(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        response = _response(
            302,
            location="https://example.test/works/10.1038%2Fredirected",
        )
        transport = _FakeTransport([response, _response()])

        result = _failure_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/works",
                AccessPolicy(max_concurrency=1),
                path_parameter="10.1038/original",
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(len(transport.calls), 1)
        self.assertTrue(response.closed)

    def test_network_owns_authority_framing_and_hop_by_hop_headers(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        forbidden = (
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
        )
        for name in forbidden:
            with self.subTest(name=name):
                transport = _FakeTransport([_response()])
                client = self._client(transport, resolver)
                result = _failure_value(
                    client.request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/resource",
                        AccessPolicy(max_concurrency=1),
                        headers={name: "caller-controlled"},
                        body=b"payload",
                    )
                )
                self.assertEqual(result.code, "policy")
                self.assertEqual(transport.calls, [])

        transport = _FakeTransport([_response()])
        client = self._client(transport, resolver)
        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                credential_headers={"Proxy-Authorization": "credential"},
            )
        )
        self.assertEqual(result.code, "policy")
        self.assertEqual(transport.calls, [])

    def test_redirects_are_manual_and_recheck_destination_each_hop(self) -> None:
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [_response(302, location="https://other.test/next"), _response(body=b"done")]
        )
        client = self._client(transport, resolver)
        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
            )
        )

        self.assertEqual(result.body, b"done")
        self.assertEqual(
            [cast(TransportRequest, call["request"]).url for call in transport.calls],
            [
                "https://example.test/start",
                "https://other.test/next",
            ],
        )
        self.assertEqual(resolver.calls.count("example.test"), 3)
        self.assertEqual(resolver.calls.count("other.test"), 3)

    def test_redirect_access_profile_releases_and_readmits_cross_scope(self) -> None:
        clock = _AdvancingClock()
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [_response(302, location="https://other.test/next"), _response(429)]
        )
        coordinator = _RecordingCoordinator(clock=clock)
        client = self._client(transport, resolver, coordinator=coordinator, clock=clock)
        initial_scope = AccessScope("provider-a", "web")
        target_scope = AccessScope("provider-b", "web")
        policy = AccessPolicy(max_concurrency=1)
        resolved_targets: list[str] = []

        def redirect_access_profile(target: object) -> tuple[AccessScope, AccessPolicy]:
            hostname = getattr(target, "hostname", None)
            resolved_targets.append(str(hostname))
            if hostname != "other.test":
                raise ValueError("unexpected redirect host")
            return target_scope, policy

        result = _response_value(
            client.request(
                initial_scope,
                "https://example.test/start",
                policy,
                redirect_access_profile=redirect_access_profile,
                response_feedback=lambda _response: AccessFeedback(
                    retry_after=5.0,
                    throttled=True,
                ),
            )
        )

        self.assertEqual(result.status, 429)
        self.assertEqual(resolved_targets, ["other.test"])
        self.assertEqual(coordinator.scopes, [initial_scope, target_scope])
        self.assertEqual(coordinator.scope_acquires, 2)
        self.assertEqual(coordinator.host_acquires, 2)
        self.assertEqual(coordinator._active_scope_permits, {})
        self.assertEqual(coordinator._active_host_permits, {})
        self.assertEqual(coordinator._scope_states[initial_scope].blocked_until, 0.0)
        self.assertEqual(coordinator._scope_states[target_scope].blocked_until, 5.0)

    def test_redirect_access_profile_failure_is_neutral_and_releases_permits(self) -> None:
        target_secret = "redirect-profile-sentinel"
        first = _response(
            302,
            location=f"https://other.test/next?opaque={target_secret}",
        )
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport([first, _response(body=b"must-not-be-sent")])
        coordinator = _RecordingCoordinator()

        def reject_profile(_target: object) -> tuple[AccessScope, AccessPolicy]:
            raise RuntimeError(f"private profile decision {target_secret}")

        result = _failure_value(
            self._client(transport, resolver, coordinator=coordinator).request(
                AccessScope("provider-a", "web"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                redirect_access_profile=reject_profile,
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(len(transport.calls), 1)
        self.assertTrue(first.closed)
        self.assertEqual(coordinator.scope_acquires, 1)
        self.assertEqual(coordinator.host_acquires, 1)
        self.assertEqual(coordinator._active_scope_permits, {})
        self.assertEqual(coordinator._active_host_permits, {})
        self.assertNotIn(target_secret, repr(result))
        self.assertNotIn(target_secret, result.model_dump_json())

    def test_redirect_target_guard_rejects_before_target_dns_or_transport_and_releases_permits(
        self,
    ) -> None:
        target_secret = "redirect-target-sentinel"
        target = f"https://other.test/next?opaque={target_secret}"
        first = _response(302, location=target)
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport([first, _response(body=b"must-not-be-sent")])
        coordinator = _RecordingCoordinator()
        guarded_targets: list[str] = []

        def reject_target(value: str) -> None:
            guarded_targets.append(value)
            raise RuntimeError(f"private redirect decision for {value}")

        result = _failure_value(
            self._client(transport, resolver, coordinator=coordinator).request(
                AccessScope("fixture-provider", "web"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1, cooldown_after_completion=30.0),
                redirect_target_guard=reject_target,
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(guarded_targets, [target])
        self.assertNotIn("other.test", resolver.calls)
        self.assertEqual(len(transport.calls), 1)
        self.assertTrue(first.closed)
        self.assertEqual(coordinator.scope_acquires, 1)
        self.assertEqual(coordinator.host_acquires, 1)
        self.assertEqual(coordinator._active_scope_permits, {})
        self.assertEqual(coordinator._active_host_permits, {})
        self.assertNotIn(target_secret, repr(result))
        self.assertNotIn(target_secret, result.model_dump_json())

    def test_encoded_redirect_separator_opt_in_requires_an_explicit_guard(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])

        result = _failure_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                allow_guarded_redirect_encoded_path_separators=True,
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(resolver.calls, [])
        self.assertEqual(transport.calls, [])

    def test_redirect_loop_stops_at_limit_and_releases_one_scope_permit_per_hop(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        responses = [
            _response(302, location="https://example.test/loop"),
            _response(302, location="https://example.test/loop"),
            _response(302, location="https://example.test/loop"),
        ]
        transport = _FakeTransport(responses)
        coordinator = _RecordingCoordinator()
        client = self._client(transport, resolver, coordinator=coordinator)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/loop",
                AccessPolicy(max_concurrency=1),
                max_redirects=2,
            )
        )

        self.assertEqual(result.code, "redirect_limit")
        self.assertEqual(coordinator.scope_acquires, 1)
        self.assertEqual(coordinator.host_acquires, 3)
        self.assertEqual(coordinator._active_scope_permits, {})
        self.assertEqual(coordinator._active_host_permits, {})
        self.assertTrue(all(response.closed for response in responses))

    def test_no_follow_returns_first_redirect_without_resolving_its_target(self) -> None:
        first = _response(302, location="https://other.test/article")
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport([first])

        result = _response_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "web"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                follow_redirects=False,
            )
        )

        self.assertEqual(result.status, 302)
        self.assertEqual(result.final_url, "https://example.test/start")
        self.assertEqual(len(transport.calls), 1)
        self.assertNotIn("other.test", resolver.calls)
        self.assertTrue(first.closed)

    def test_no_follow_flag_is_strictly_boolean(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])

        result = _failure_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "web"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                follow_redirects=0,  # type: ignore[arg-type]
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(resolver.calls, [])
        self.assertEqual(transport.calls, [])

    def test_web_request_holds_one_scope_across_redirects_and_applies_final_cooldown(self) -> None:
        clock = _AdvancingClock()
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [
                _response(302, location="https://other.test/next"),
                _response(body=b"done"),
                _response(body=b"again"),
            ]
        )
        coordinator = _RecordingCoordinator(clock=clock)
        client = self._client(transport, resolver, coordinator=coordinator, clock=clock)
        scope = AccessScope("fixture-provider", "web")
        policy = AccessPolicy(max_concurrency=1, cooldown_after_completion=30.0)

        first = _response_value(client.request(scope, "https://example.test/start", policy))
        self.assertEqual(first.body, b"done")
        self.assertEqual(coordinator.scope_acquires, 1)
        self.assertEqual(coordinator.host_acquires, 2)
        self.assertEqual(coordinator._active_scope_permits, {})
        self.assertEqual(coordinator._active_host_permits, {})

        acquired = threading.Event()
        results: list[TransportResponse | AccessFailure] = []

        def wait_for_next_flow() -> None:
            results.append(client.request(scope, "https://example.test/next", policy))
            acquired.set()

        worker = threading.Thread(target=wait_for_next_flow)
        worker.start()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(29.9)
        coordinator.wake()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(0.1)
        coordinator.wake()
        self.assertTrue(acquired.wait(1.0))
        worker.join(1.0)

        self.assertFalse(worker.is_alive())
        self.assertEqual(len(results), 1)
        self.assertEqual(_response_value(results[0]).body, b"again")

    def test_cross_origin_redirect_strips_private_credentials(self) -> None:
        secret = "AUTHORIZATION-SENTINEL"
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [_response(302, location="https://other.test/next"), _response()]
        )
        client = self._client(transport, resolver)
        result = client.request(
            AccessScope("fixture-provider", "api"),
            "https://example.test/start",
            AccessPolicy(max_concurrency=1),
            credential_headers={"Authorization": f"Bearer {secret}"},
            credential_allowed_origins=(_credential_origin(),),
        )

        self.assertFalse(isinstance(result, AccessFailure))
        self.assertEqual(transport.calls[0]["headers"], (("Authorization", f"Bearer {secret}"),))
        self.assertEqual(transport.calls[1]["headers"], ())
        first_request = cast(TransportRequest, transport.calls[0]["request"])
        self.assertEqual(first_request.headers, ())
        self.assertNotIn(secret, repr(first_request))
        self.assertNotIn(secret, repr(result))

    def test_elsevier_api_key_header_is_private_and_cross_origin_safe(self) -> None:
        secret = "elsevier-api-key-" + "sentinel"
        header_name = "x-eLs-aPiKeY"
        resolver = _Resolver(
            {
                "api.elsevier.com": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [
                _response(302, location="https://other.test/next"),
                _response(body=b"done"),
            ]
        )
        client = self._client(transport, resolver)

        with self.assertNoLogs("sciretriever.network", level="DEBUG"):
            result = _response_value(
                client.request(
                    AccessScope("elsevier", "api"),
                    "https://api.elsevier.com/content/search/scopus",
                    AccessPolicy(max_concurrency=1),
                    credential_headers={header_name: secret},
                    credential_allowed_origins=(Origin("https", "api.elsevier.com", 443),),
                )
            )

        self.assertEqual(result.body, b"done")
        self.assertEqual(transport.calls[0]["headers"], ((header_name, secret),))
        self.assertEqual(transport.calls[1]["headers"], ())
        for call in transport.calls:
            safe_request = _safe_request_from_call(call)
            self.assertEqual(safe_request.headers, ())
            self.assertNotIn(secret, repr(safe_request))
            self.assertNotIn(secret, safe_request.model_dump_json())
        self.assertNotIn(secret, repr(result))
        self.assertNotIn(secret, result.model_dump_json())
        self.assertNotIn(secret, repr(client))

    def test_wiley_tdm_token_header_is_private_and_cross_origin_safe(self) -> None:
        secret = "12345678-1234-4234-9234-123456789abc"
        header_name = "Wiley-TDM-Client-Token"
        redirect_target = (
            "https://alm.wiley.com/alm/api/v2/download/synthetic%252Fopaque%253Dlocator"
        )
        resolver = _Resolver(
            {
                "api.wiley.com": ("93.184.216.34",),
                "alm.wiley.com": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [
                _response(302, location=redirect_target),
                _response(body=b"done"),
            ]
        )
        client = self._client(transport, resolver)
        guarded_targets: list[str] = []

        def guard_target(value: str) -> None:
            guarded_targets.append(value)
            if value != redirect_target:
                raise ValueError("unexpected Wiley redirect target")

        with self.assertNoLogs("sciretriever.network", level="DEBUG"):
            result = _response_value(
                client.request(
                    AccessScope("wiley", "api"),
                    "https://api.wiley.com/onlinelibrary/tdm/v1/articles/example",
                    AccessPolicy(max_concurrency=1),
                    credential_headers={header_name: secret},
                    credential_allowed_origins=(Origin("https", "api.wiley.com", 443),),
                    max_redirects=1,
                    redirect_target_guard=guard_target,
                    allow_guarded_redirect_encoded_path_separators=True,
                )
            )

        self.assertEqual(result.body, b"done")
        self.assertEqual(guarded_targets, [redirect_target])
        self.assertEqual(transport.calls[0]["headers"], ((header_name, secret),))
        self.assertEqual(transport.calls[1]["headers"], ())
        for call in transport.calls:
            safe_request = _safe_request_from_call(call)
            self.assertEqual(safe_request.headers, ())
            self.assertNotIn(secret, repr(safe_request))
            self.assertNotIn(secret, safe_request.model_dump_json())
        self.assertNotIn(secret, repr(result))
        self.assertNotIn(secret, result.model_dump_json())
        self.assertNotIn(secret, repr(client))

    def test_every_private_header_requires_an_explicit_matching_initial_origin(self) -> None:
        header_names = (
            "Authorization",
            "Cookie",
            "X-API-Key",
            "X-APIKey",
            "X-ELS-APIKey",
            "X-Insttoken",
            "X-ELS-Insttoken",
            "Wiley-TDM-Client-Token",
        )
        for header_name in header_names:
            for allowed_origins in ((), (_credential_origin("other.test"),)):
                with self.subTest(header_name=header_name, allowed_origins=allowed_origins):
                    secret = f"origin-bound-{header_name.casefold()}-sentinel"
                    resolver = _Resolver({"example.test": ("93.184.216.34",)})
                    transport = _FakeTransport([_response()])
                    client = self._client(transport, resolver)

                    with self.assertNoLogs("sciretriever.network", level="DEBUG"):
                        result = _failure_value(
                            client.request(
                                AccessScope("fixture-provider", "api"),
                                "https://example.test/resource",
                                AccessPolicy(max_concurrency=1),
                                credential_headers={header_name: secret},
                                credential_allowed_origins=allowed_origins,
                            )
                        )

                    self.assertEqual(result.code, "policy")
                    self.assertEqual(
                        result.reason,
                        "network policy rejected the destination",
                    )
                    self.assertEqual(transport.calls, [])
                    self.assertNotIn(secret, repr(result))
                    self.assertNotIn(secret, result.model_dump_json())
                    self.assertNotIn(secret, repr(client))

    def test_every_private_header_sends_only_for_a_matching_https_origin(self) -> None:
        header_names = (
            "Authorization",
            "Cookie",
            "X-API-Key",
            "X-APIKey",
            "X-ELS-APIKey",
            "X-Insttoken",
            "X-ELS-Insttoken",
            "Wiley-TDM-Client-Token",
        )
        for header_name in header_names:
            with self.subTest(header_name=header_name):
                secret = f"matching-origin-{header_name.casefold()}-sentinel"
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response(body=b"done")])
                client = self._client(transport, resolver)

                with self.assertNoLogs("sciretriever.network", level="DEBUG"):
                    result = _response_value(
                        client.request(
                            AccessScope("fixture-provider", "api"),
                            "HTTPS://EXAMPLE.TEST/resource",
                            AccessPolicy(max_concurrency=1),
                            credential_headers={header_name: secret},
                            credential_allowed_origins=(_credential_origin(),),
                        )
                    )

                self.assertEqual(result.body, b"done")
                self.assertEqual(len(transport.calls), 1)
                call = transport.calls[0]
                self.assertEqual(call["headers"], ((header_name, secret),))
                safe_request = _safe_request_from_call(call)
                self.assertEqual(safe_request.headers, ())
                self.assertEqual(safe_request.url, "https://example.test/resource")
                self.assertNotIn(secret, safe_request.url)
                self.assertNotIn(secret, repr(safe_request))
                self.assertNotIn(secret, safe_request.model_dump_json())
                self.assertNotIn(secret, result.final_url)
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())
                self.assertNotIn(secret, repr(client))

    def test_private_header_rejects_non_https_or_noncanonical_allowed_origins(self) -> None:
        secret = "invalid-header-origin-sentinel"
        invalid_origins = (
            Origin("http", "example.test", 80),
            Origin("HTTPS", "example.test", 443),
            Origin("https", "EXAMPLE.TEST", 443),
        )
        for invalid_origin in invalid_origins:
            with self.subTest(invalid_origin=invalid_origin):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])

                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/resource",
                        AccessPolicy(max_concurrency=1),
                        credential_headers={"Authorization": f"Bearer {secret}"},
                        credential_allowed_origins=(invalid_origin,),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(
                    result.reason,
                    "network policy rejected the destination",
                )
                self.assertEqual(transport.calls, [])
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_request_without_private_headers_does_not_require_credential_origins(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"done")])

        result = _response_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                credential_headers=(),
                credential_allowed_origins=(),
            )
        )

        self.assertEqual(result.body, b"done")
        self.assertEqual(len(transport.calls), 1)

    def test_same_origin_redirect_forwards_private_credentials(self) -> None:
        secret = "same-origin-sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport(
            [_response(302, location="https://example.test/next"), _response()]
        )
        client = self._client(transport, resolver)

        result = client.request(
            AccessScope("fixture-provider", "api"),
            "https://example.test/start",
            AccessPolicy(max_concurrency=1),
            credential_headers={"Authorization": f"Bearer {secret}"},
            credential_allowed_origins=(_credential_origin(),),
        )

        self.assertFalse(isinstance(result, AccessFailure))
        self.assertEqual(transport.calls[1]["headers"], (("Authorization", f"Bearer {secret}"),))

    def test_cross_origin_redirect_never_restores_private_headers(self) -> None:
        secret = "header-monotonic-sentinel"
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [
                _response(302, location="https://other.test/next"),
                _response(302, location="https://example.test/return"),
                _response(body=b"done"),
            ]
        )
        client = self._client(transport, resolver)

        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                credential_headers={"Authorization": f"Bearer {secret}"},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(result.body, b"done")
        self.assertEqual(
            [call["headers"] for call in transport.calls],
            [(("Authorization", f"Bearer {secret}"),), (), ()],
        )
        self.assertNotIn(secret, repr(result))

    def test_public_api_key_query_remains_rejected_by_url_policy(self) -> None:
        secret = "public-" + "api-key-sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])
        client = self._client(transport, resolver)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                f"https://example.test/resource?api_key={secret}",
                AccessPolicy(max_concurrency=1),
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(transport.calls, [])
        self.assertNotIn(secret, repr(result))
        self.assertNotIn(secret, result.model_dump_json())

    def test_private_email_query_is_wire_only_and_stripped_after_cross_origin_redirect(
        self,
    ) -> None:
        contact_email = "wire-only-sentinel@example.test"
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [
                _response(302, location="https://other.test/next"),
                _response(body=b"done"),
            ]
        )

        result = _response_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource?q=plain",
                AccessPolicy(max_concurrency=1),
                credential_query={"email": contact_email},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        safe_requests = [_safe_request_from_call(call) for call in transport.calls]
        wire_targets = [_wire_target_from_call(call) for call in transport.calls]
        self.assertEqual(wire_targets[0].count("email="), 1)
        self.assertNotIn("email=", wire_targets[1])
        self.assertTrue(all(contact_email not in request.url for request in safe_requests))
        self.assertNotIn(contact_email, result.final_url)
        self.assertNotIn(contact_email, repr(result))
        self.assertNotIn(contact_email, result.model_dump_json())
        self.assertNotIn(contact_email, repr(transport.calls))

    def test_public_email_query_and_private_email_alias_fail_before_dns_or_transport(self) -> None:
        contact_email = "alias-sentinel@example.test"
        public_resolver = _Resolver({"example.test": ("93.184.216.34",)})
        public_transport = _FakeTransport([_response()])
        public_result = _failure_value(
            self._client(public_transport, public_resolver).request(
                AccessScope("fixture-provider", "api"),
                f"https://example.test/resource?email={contact_email}",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(public_result.code, "policy")
        self.assertEqual(public_resolver.calls, [])
        self.assertEqual(public_transport.calls, [])

        alias_resolver = _Resolver({"example.test": ("93.184.216.34",)})
        alias_transport = _FakeTransport([_response()])
        alias_result = _failure_value(
            self._client(alias_transport, alias_resolver).request(
                AccessScope("fixture-provider", "api"),
                f"https://example.test/resource?trace={contact_email}",
                AccessPolicy(max_concurrency=1),
                credential_query={"email": contact_email},
                credential_allowed_origins=(_credential_origin(),),
            )
        )
        self.assertEqual(alias_result.code, "policy")
        self.assertEqual(alias_resolver.calls, [])
        self.assertEqual(alias_transport.calls, [])
        self.assertNotIn(contact_email, repr(alias_result))
        self.assertNotIn(contact_email, alias_result.model_dump_json())

    def test_private_query_value_cannot_alias_ordinary_url_or_headers(self) -> None:
        secret = "private-query-alias-sentinel"
        public_inputs: tuple[tuple[str, dict[str, str]], ...] = (
            (f"https://{secret}.example.test/resource", {}),
            ("https://private%2Dquery%2Dalias%2Dsentinel.example.test/resource", {}),
            (f"https://example.test/{secret}", {}),
            (f"https://example.test/resource?q={secret}", {}),
            ("https://example.test/private%2Dquery%2Dalias%2Dsentinel", {}),
            ("https://example.test/resource?q=private%2Dquery%2Dalias%2Dsentinel", {}),
            ("https://example.test/resource", {"X-Trace": secret}),
        )
        for url, headers in public_inputs:
            with self.subTest(url=url, headers=tuple(headers)):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])
                client = self._client(transport, resolver)

                result = _failure_value(
                    client.request(
                        AccessScope("fixture-provider", "api"),
                        url,
                        AccessPolicy(max_concurrency=1),
                        headers=headers,
                        credential_query={"api_key": secret},
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(result.reason, "network policy rejected the destination")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_every_private_header_value_guards_all_initial_public_inputs(self) -> None:
        header_names = (
            "Authorization",
            "Cookie",
            "X-API-Key",
            "X-APIKey",
            "X-ELS-APIKey",
            "X-Insttoken",
            "X-ELS-Insttoken",
            "Wiley-TDM-Client-Token",
        )
        for header_name in header_names:
            secret = f"initial-alias-{header_name.casefold()}-sentinel"
            private_value = f"Bearer {secret}" if header_name == "Authorization" else secret
            public_inputs: tuple[tuple[str, dict[str, str], str | None, str | None], ...] = (
                (f"https://{secret}.example.test/resource", {}, None, None),
                (f"https://example.test/resource?trace={secret}", {}, None, None),
                ("https://example.test/resource", {}, secret, None),
                ("https://example.test/resource", {}, "CorpusId:123", secret),
                ("https://example.test/resource", {"X-Trace": secret}, None, None),
            )
            for url, headers, path_parameter, path_parameter_suffix in public_inputs:
                with self.subTest(
                    header_name=header_name,
                    url=url,
                    headers=tuple(headers),
                    path_parameter=path_parameter,
                    path_parameter_suffix=path_parameter_suffix,
                ):
                    resolver = _Resolver({"example.test": ("93.184.216.34",)})
                    transport = _FakeTransport([_response(body=b"must-not-be-sent")])

                    result = _failure_value(
                        self._client(transport, resolver).request(
                            AccessScope("fixture-provider", "api"),
                            url,
                            AccessPolicy(max_concurrency=1),
                            headers=headers,
                            credential_headers={header_name: private_value},
                            credential_allowed_origins=(_credential_origin(),),
                            path_parameter=path_parameter,
                            path_parameter_suffix=path_parameter_suffix,
                        )
                    )

                    self.assertEqual(result.code, "policy")
                    self.assertEqual(result.reason, "network policy rejected the destination")
                    self.assertEqual(resolver.calls, [])
                    self.assertEqual(transport.calls, [])
                    self.assertNotIn(secret, repr(result))
                    self.assertNotIn(secret, result.model_dump_json())

    def test_credential_alias_guard_decodes_to_stability_and_handles_query_form_plus(
        self,
    ) -> None:
        cases = (
            (
                "private-query-in-path",
                "deep-query-alias-sentinel",
                {
                    "url": (
                        "https://example.test/resource/"
                        + _nested_percent_encoding("deep-query-alias-sentinel", layers=7)
                    ),
                    "credential_query": {"api_key": "deep-query-alias-sentinel"},
                },
            ),
            (
                "private-header-in-query",
                "deep-header-alias-sentinel",
                {
                    "url": (
                        "https://example.test/resource?trace="
                        + _nested_percent_encoding("deep-header-alias-sentinel", layers=7)
                    ),
                    "credential_headers": {"X-API-Key": "deep-header-alias-sentinel"},
                },
            ),
            (
                "form-plus-after-nested-percent-decoding",
                "nested form alias sentinel",
                {
                    "url": (
                        "https://example.test/resource?trace="
                        + _nested_percent_encoding("nested+form+alias+sentinel", layers=7)
                    ),
                    "credential_query": {"api_key": "nested form alias sentinel"},
                },
            ),
            (
                "form-space-and-literal-plus-use-their-layer-order",
                "mixed form+alias sentinel",
                {
                    "url": (
                        "https://example.test/resource?trace="
                        + _nested_percent_encoding(
                            "mixed+form%2Balias+sentinel",
                            layers=7,
                        )
                    ),
                    "credential_query": {"api_key": "mixed form+alias sentinel"},
                },
            ),
        )
        for name, secret, request_options in cases:
            with self.subTest(name=name):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response(body=b"must-not-be-sent")])

                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        cast(str, request_options["url"]),
                        AccessPolicy(max_concurrency=1),
                        credential_headers=cast(
                            dict[str, str], request_options.get("credential_headers", {})
                        ),
                        credential_query=cast(
                            dict[str, str], request_options.get("credential_query", {})
                        ),
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_credential_alias_guard_fails_closed_on_ambiguous_nested_percent_text(self) -> None:
        secret = "unrelated-private-sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"must-not-be-sent")])

        result = _failure_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource?trace=%2525GG",
                AccessPolicy(max_concurrency=1),
                credential_headers={"X-API-Key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(resolver.calls, [])
        self.assertEqual(transport.calls, [])
        self.assertNotIn(secret, repr(result))
        self.assertNotIn(secret, result.model_dump_json())

    def test_alias_guard_survives_cross_origin_stripping_on_later_redirects(self) -> None:
        cases = (
            (
                "authorization-token-in-path",
                "redirect-authorization-token-sentinel",
                {
                    "credential_headers": {
                        "Authorization": "Bearer redirect-authorization-token-sentinel"
                    }
                },
                (
                    "https://third.test/next/"
                    + _nested_percent_encoding("redirect-authorization-token-sentinel", layers=7)
                ),
            ),
            (
                "query-value-with-form-plus",
                "redirect query alias sentinel",
                {"credential_query": {"api_key": "redirect query alias sentinel"}},
                (
                    "https://third.test/next?trace="
                    + _nested_percent_encoding("redirect+query+alias+sentinel", layers=7)
                ),
            ),
        )
        for name, secret, request_options, alias_destination in cases:
            with self.subTest(name=name):
                resolver = _Resolver(
                    {
                        "example.test": ("93.184.216.34",),
                        "other.test": ("1.1.1.1",),
                        "third.test": ("8.8.8.8",),
                    }
                )
                transport = _FakeTransport(
                    [
                        _response(302, location="https://other.test/safe"),
                        _response(302, location=alias_destination),
                        _response(body=b"must-not-be-sent"),
                    ]
                )

                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/start",
                        AccessPolicy(max_concurrency=1),
                        credential_headers=cast(
                            dict[str, str], request_options.get("credential_headers", {})
                        ),
                        credential_query=cast(
                            dict[str, str], request_options.get("credential_query", {})
                        ),
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(len(transport.calls), 2)
                self.assertEqual(transport.calls[1]["headers"], ())
                self.assertNotIn("api_key=", _wire_target_from_call(transport.calls[1]))
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_redirect_authority_alias_is_rejected_before_dns_even_after_stripping(self) -> None:
        cases = (
            ("query-first-redirect", "query-predns-sentinel", "query", False),
            ("authorization-first-redirect", "authorization-predns-sentinel", "header", False),
            ("query-after-stripping", "query-stripped-predns-sentinel", "query", True),
            (
                "authorization-after-stripping",
                "authorization-stripped-predns-sentinel",
                "header",
                True,
            ),
        )
        for name, secret, credential_kind, after_stripping in cases:
            with self.subTest(name=name):
                dangerous_hostname = f"{secret}.danger.test"
                resolver = _Resolver(
                    {
                        "example.test": ("93.184.216.34",),
                        "other.test": ("1.1.1.1",),
                        dangerous_hostname: ("8.8.8.8",),
                    }
                )
                dangerous_redirect = _response(
                    302,
                    location=f"https://{dangerous_hostname}/next",
                )
                actions = (
                    [_response(302, location="https://other.test/safe"), dangerous_redirect]
                    if after_stripping
                    else [dangerous_redirect]
                )
                transport = _FakeTransport([*actions, _response(body=b"must-not-be-sent")])
                credential_headers = (
                    {"Authorization": f"Bearer {secret}"} if credential_kind == "header" else {}
                )
                credential_query = {"api_key": secret} if credential_kind == "query" else {}

                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/start",
                        AccessPolicy(max_concurrency=1),
                        credential_headers=credential_headers,
                        credential_query=credential_query,
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

                expected_transport_calls = 2 if after_stripping else 1
                self.assertEqual(result.code, "policy")
                self.assertEqual(len(transport.calls), expected_transport_calls)
                self.assertNotIn(dangerous_hostname, resolver.calls)
                if after_stripping:
                    self.assertEqual(transport.calls[1]["headers"], ())
                    self.assertNotIn("api_key=", _wire_target_from_call(transport.calls[1]))
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_alias_guard_resource_boundaries_allow_bounded_work(self) -> None:
        max_component_chars = cast(
            int,
            getattr(cast(Any, network_http_module), "_ALIAS_GUARD_MAX_COMPONENT_CHARS"),
        )
        max_states = cast(
            int,
            getattr(cast(Any, network_http_module), "_ALIAS_GUARD_MAX_STATES"),
        )
        secret = "bounded-resource-private-sentinel"

        component_resolver = _Resolver({"example.test": ("93.184.216.34",)})
        component_transport = _FakeTransport([_response(body=b"component-boundary")])
        component_result = _response_value(
            self._client(component_transport, component_resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/" + "a" * (max_component_chars - 1),
                AccessPolicy(max_concurrency=1),
                credential_headers={"X-API-Key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )
        self.assertEqual(component_result.body, b"component-boundary")
        self.assertEqual(len(component_transport.calls), 1)

        state_resolver = _Resolver({"example.test": ("93.184.216.34",)})
        state_transport = _FakeTransport([_response(body=b"state-boundary")])
        state_result = _response_value(
            self._client(state_transport, state_resolver).request(
                AccessScope("fixture-provider", "api"),
                (
                    "https://example.test/resource?trace="
                    + _nested_percent_encoding("z", layers=max_states - 1)
                ),
                AccessPolicy(max_concurrency=1),
                credential_headers={"X-API-Key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )
        self.assertEqual(state_result.body, b"state-boundary")
        self.assertEqual(len(state_transport.calls), 1)

        alias = "bounded-deep-alias-sentinel"
        alias_resolver = _Resolver({"example.test": ("93.184.216.34",)})
        alias_transport = _FakeTransport([_response(body=b"must-not-be-sent")])
        alias_result = _failure_value(
            self._client(alias_transport, alias_resolver).request(
                AccessScope("fixture-provider", "api"),
                (
                    "https://example.test/resource?trace="
                    + _nested_percent_encoding(alias, layers=32)
                ),
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": alias},
                credential_allowed_origins=(_credential_origin(),),
            )
        )
        self.assertEqual(alias_result.code, "policy")
        self.assertEqual(alias_resolver.calls, [])
        self.assertEqual(alias_transport.calls, [])
        self.assertNotIn(alias, repr(alias_result))
        self.assertNotIn(alias, alias_result.model_dump_json())

    def test_alias_guard_resource_overflow_fails_closed_before_dns_or_transport(self) -> None:
        max_component_chars = cast(
            int,
            getattr(cast(Any, network_http_module), "_ALIAS_GUARD_MAX_COMPONENT_CHARS"),
        )
        max_states = cast(
            int,
            getattr(cast(Any, network_http_module), "_ALIAS_GUARD_MAX_STATES"),
        )
        secret = "overflow-resource-private-sentinel"
        urls = (
            "https://example.test/resource?trace=" + "a" * (max_component_chars + 1),
            (
                "https://example.test/resource?trace="
                + _nested_percent_encoding("z", layers=max_states)
            ),
            (
                "https://example.test/resource?trace="
                + _nested_percent_encoding("ordinary", layers=max_states - 1)
            ),
        )
        for url in urls:
            with self.subTest(url_length=len(url)):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response(body=b"must-not-be-sent")])

                result = _failure_value(
                    self._client(transport, resolver).request(
                        AccessScope("fixture-provider", "api"),
                        url,
                        AccessPolicy(max_concurrency=1),
                        credential_headers={"X-API-Key": secret},
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(resolver.calls, [])
                self.assertEqual(transport.calls, [])
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_normal_non_alias_request_with_private_credentials_is_not_rejected(self) -> None:
        header_secret = "normal-header-private-sentinel"
        query_secret = "normal-query-private-sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"done")])

        result = _response_value(
            self._client(transport, resolver).request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource/ordinary%2520value?trace=unrelated%252Btext+here",
                AccessPolicy(max_concurrency=1),
                headers={"X-Trace": "ordinary-public-value"},
                credential_headers={"Authorization": f"Bearer {header_secret}"},
                credential_query={"api_key": query_secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(result.body, b"done")
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(
            transport.calls[0]["headers"],
            (("X-Trace", "ordinary-public-value"), ("Authorization", f"Bearer {header_secret}")),
        )
        self.assertEqual(_wire_target_from_call(transport.calls[0]).count("api_key="), 1)
        for secret in (header_secret, query_secret):
            self.assertNotIn(secret, repr(result))
            self.assertNotIn(secret, result.model_dump_json())

    def test_query_credential_only_enters_private_request_target_renderer(self) -> None:
        secret = "runtime query sentinel&/+"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(body=b"payload")])
        client = self._client(transport, resolver)

        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource?q=plain",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(len(transport.calls), 1)
        call = transport.calls[0]
        safe_request = _safe_request_from_call(call)
        self.assertIs(call["request"], safe_request)
        self.assertIsInstance(call["request"], TransportRequest)
        self.assertEqual(safe_request.url, "https://example.test/resource?q=plain")
        self.assertEqual(
            _wire_target_from_call(call),
            "/resource?q=plain&api_key=runtime+query+sentinel%26%2F%2B",
        )
        self.assertEqual(_wire_target_from_call(call).count("api_key="), 1)
        self.assertNotIn(secret, safe_request.model_dump_json())
        self.assertNotIn(secret, repr(call["request"]))
        self.assertNotIn(secret, repr(call))
        self.assertTrue(hasattr(call["request"], "model_dump"))
        renderer = call["request_target_renderer"]
        self.assertNotIn(secret, repr(renderer))
        with self.assertRaises(TypeError):
            pickle.dumps(renderer)
        destination = cast(ResolvedDestination, call["destination"])
        self.assertNotIn(secret, destination.url.url)
        self.assertNotIn(secret, repr(destination))
        self.assertNotIn(secret, result.final_url)
        self.assertNotIn(secret, repr(result))
        self.assertNotIn(secret, result.model_dump_json())

    def test_alternate_transport_receives_real_request_and_explicit_renderer(self) -> None:
        secret = "alternate-transport-query-sentinel"

        class _ModelTransport:
            def __init__(self) -> None:
                self.request: TransportRequest | None = None
                self.request_dump: dict[str, object] | None = None
                self.target: str | None = None

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
                del (
                    headers,
                    connect_timeout_seconds,
                    read_timeout_seconds,
                    tls_server_hostname,
                    cancel_event,
                )
                self.request = request
                self.request_dump = request.model_dump()
                render = getattr(request_target_renderer, "render", None)
                if not callable(render):
                    raise AssertionError("renderer capability is missing")
                target = render(request, destination)
                if not isinstance(target, str):
                    raise AssertionError("renderer returned a non-string target")
                self.target = target
                return _response(body=b"alternate")

        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _ModelTransport()
        client = HttpClient(
            resolver=resolver,
            transport=transport,
            coordinator=AccessCoordinator(),
            destination_policy=_HOST_POLICY,
        )

        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource?q=plain",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertIsInstance(transport.request, TransportRequest)
        self.assertIsNotNone(transport.request_dump)
        self.assertEqual(
            transport.target,
            f"/resource?q=plain&api_key={secret}",
        )
        self.assertNotIn(secret, cast(TransportRequest, transport.request).url)
        self.assertNotIn(secret, repr(transport.request))
        self.assertNotIn(secret, result.final_url)

    def test_same_origin_redirect_keeps_query_credential_exactly_once_per_hop(self) -> None:
        secret = "same-origin-query-" + "sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport(
            [_response(302, location="/next?cursor=2"), _response(body=b"done")]
        )
        client = self._client(transport, resolver)

        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                credential_query=(("api_key", secret),),
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        targets = [_wire_target_from_call(call) for call in transport.calls]
        self.assertEqual(len(targets), 2)
        self.assertTrue(all(target.count("api_key=") == 1 for target in targets))
        self.assertTrue(all(secret in target for target in targets))
        self.assertEqual(targets[1], f"/next?cursor=2&api_key={secret}")
        for call in transport.calls:
            self.assertNotIn(secret, _safe_request_from_call(call).url)
        self.assertNotIn(secret, result.final_url)
        self.assertNotIn(secret, repr(result))

    def test_cross_origin_redirect_strips_query_credential_and_never_restores_it(self) -> None:
        secret = "cross-origin-query-" + "sentinel"
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
            }
        )
        transport = _FakeTransport(
            [
                _response(302, location="https://other.test/next"),
                ConnectionError(f"retry-{secret}"),
                _response(302, location="https://example.test/return"),
                _response(body=b"done"),
            ]
        )
        destination_policy = DestinationPolicy(
            allowed_classes=frozenset({AddressClass.PUBLIC}),
            allowed_origins=frozenset({_credential_origin("other.test")}),
        )
        client = self._client(
            transport,
            resolver,
            destination_policy=destination_policy,
        )

        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
                max_retries=1,
            )
        )

        targets = [_wire_target_from_call(call) for call in transport.calls]
        self.assertEqual(len(targets), 4)
        self.assertEqual(targets[0].count("api_key="), 1)
        for target in targets[1:]:
            self.assertNotIn("api_key=", target)
            self.assertNotIn(secret, target)
        self.assertNotIn(secret, result.final_url)
        self.assertNotIn(secret, repr(result))

    def test_sensitive_redirect_location_is_rejected_as_public_url_input(self) -> None:
        credential_secret = "redirect-request-" + "sentinel"
        location_secret = "redirect-location-" + "sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response(302, location=f"/next?api_key={location_secret}")])
        client = self._client(transport, resolver)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": credential_secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(_wire_target_from_call(transport.calls[0]).count("api_key="), 1)
        for secret in (credential_secret, location_secret):
            self.assertNotIn(secret, repr(result))
            self.assertNotIn(secret, result.model_dump_json())

    def test_cross_origin_redirect_cannot_reflect_query_credential_under_safe_name(self) -> None:
        secret = "reflected-query-credential-" + "sentinel"
        reflected_values = (secret, secret.replace("-", "%2D", 1))
        for reflected_value in reflected_values:
            with self.subTest(reflected_value=reflected_value):
                resolver = _Resolver(
                    {
                        "example.test": ("93.184.216.34",),
                        "other.test": ("1.1.1.1",),
                    }
                )
                transport = _FakeTransport(
                    [
                        _response(
                            302,
                            location=f"https://other.test/next?cursor={reflected_value}",
                        ),
                        _response(body=b"must-not-be-sent"),
                    ]
                )
                client = self._client(transport, resolver)

                result = _failure_value(
                    client.request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/start",
                        AccessPolicy(max_concurrency=1),
                        credential_query={"api_key": secret},
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(len(transport.calls), 1)
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_query_credential_reflection_guard_survives_cross_origin_stripping(self) -> None:
        secret = "stripped-query-credential-" + "sentinel"
        resolver = _Resolver(
            {
                "example.test": ("93.184.216.34",),
                "other.test": ("1.1.1.1",),
                "third.test": ("8.8.8.8",),
            }
        )
        transport = _FakeTransport(
            [
                _response(302, location="https://other.test/safe"),
                _response(302, location=f"https://third.test/next?trace={secret}"),
                _response(body=b"must-not-be-sent"),
            ]
        )
        client = self._client(transport, resolver)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/start",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(len(transport.calls), 2)
        self.assertNotIn(secret, _wire_target_from_call(transport.calls[1]))
        self.assertNotIn(secret, repr(result))
        self.assertNotIn(secret, result.model_dump_json())

    def test_query_credential_requires_an_explicit_matching_initial_origin(self) -> None:
        secret = "origin-bound-query-" + "sentinel"
        for allowed_origins in ((), (_credential_origin("other.test"),)):
            with self.subTest(allowed_origins=allowed_origins):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])
                client = self._client(transport, resolver)

                result = _failure_value(
                    client.request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/resource",
                        AccessPolicy(max_concurrency=1),
                        credential_query={"api_key": secret},
                        credential_allowed_origins=allowed_origins,
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(transport.calls, [])
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_dns_rebinding_fails_before_query_credential_reaches_transport(self) -> None:
        secret = "dns-rebind-query-" + "sentinel"
        resolver = _RebindingResolver({"example.test": [("93.184.216.34",), ("127.0.0.1",)]})
        transport = _FakeTransport([_response()])
        client = self._client(transport, resolver)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(transport.calls, [])
        self.assertEqual(resolver.calls, ["example.test", "example.test"])
        self.assertNotIn(secret, repr(result))

    def test_idempotent_retry_replays_query_credential_once_but_statuses_do_not_retry(
        self,
    ) -> None:
        secret = "retry-query-" + "sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        retry_transport = _FakeTransport([ConnectionError(secret), _response(body=b"done")])
        retry_client = self._client(retry_transport, resolver)

        retry_result = _response_value(
            retry_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource?cursor=1",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
                max_retries=1,
            )
        )

        self.assertEqual(len(retry_transport.calls), 2)
        retry_targets = [_wire_target_from_call(call) for call in retry_transport.calls]
        self.assertTrue(all(target.count("api_key=") == 1 for target in retry_targets))
        self.assertTrue(all(secret in target for target in retry_targets))
        self.assertNotIn(secret, repr(retry_result))

        for status in (401, 403, 429):
            with self.subTest(status=status):
                status_transport = _FakeTransport([_response(status), _response()])
                status_client = self._client(status_transport, resolver)
                status_result = _response_value(
                    status_client.request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/resource",
                        AccessPolicy(max_concurrency=1),
                        credential_query={"api_key": secret},
                        credential_allowed_origins=(_credential_origin(),),
                        max_retries=5,
                    )
                )
                self.assertEqual(status_result.status, status)
                self.assertEqual(len(status_transport.calls), 1)
                self.assertEqual(
                    _wire_target_from_call(status_transport.calls[0]).count("api_key="), 1
                )
                self.assertNotIn(secret, repr(status_result))

        post_transport = _FakeTransport([ConnectionError(secret), _response()])
        post_client = self._client(post_transport, resolver)
        post_result = _failure_value(
            post_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                method="POST",
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
                max_retries=5,
            )
        )
        self.assertEqual(post_result.code, "transport")
        self.assertEqual(len(post_transport.calls), 1)
        self.assertNotIn(secret, repr(post_result))

    def test_query_credential_failures_and_lifecycle_results_never_echo_secret(self) -> None:
        secret = "lifecycle-query-" + "sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        cases: tuple[tuple[str, _FakeTransport, int | None, int | None, str], ...] = (
            ("timeout", _FakeTransport([TimeoutError(secret)]), 0, None, "timeout"),
            ("exception", _FakeTransport([RuntimeError(secret)]), 0, None, "transport"),
            (
                "redirect-limit",
                _FakeTransport(
                    [
                        _response(302, location="/again"),
                        _response(302, location="/again"),
                    ]
                ),
                None,
                1,
                "redirect_limit",
            ),
        )
        for name, transport, max_retries, max_redirects, expected_code in cases:
            with self.subTest(name=name):
                client = self._client(transport, resolver)
                result = _failure_value(
                    client.request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/resource",
                        AccessPolicy(max_concurrency=1),
                        credential_query={"api_key": secret},
                        credential_allowed_origins=(_credential_origin(),),
                        max_retries=max_retries,
                        max_redirects=max_redirects,
                    )
                )
                self.assertEqual(result.code, expected_code)
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())
                self.assertNotIn(secret, repr(client))
                self.assertTrue(
                    all(
                        _wire_target_from_call(call).count("api_key=") == 1
                        for call in transport.calls
                    )
                )

        closed_transport = _FakeTransport([_response()])
        closed_client = self._client(closed_transport, resolver)
        closed_client.close()
        closed_result = _failure_value(
            closed_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )
        self.assertEqual(closed_result.code, "closed")
        self.assertEqual(closed_transport.calls, [])
        self.assertNotIn(secret, repr(closed_result))
        self.assertNotIn(secret, closed_result.model_dump_json())

    def test_invalid_query_credential_inputs_fail_closed_with_fixed_errors(self) -> None:
        secret = "invalid-query-" + "sentinel"
        invalid_inputs: tuple[object, ...] = (
            {"token": secret},
            {"Api_Key": secret},
            {"api-key": secret},
            {"api_key": ""},
            {"api_key": "   "},
            {"api_key": secret + "\r"},
            {"api_key": secret + "\n"},
            {"api_key": secret + "\x00"},
            {"api_key": secret + "\x7f"},
            {"api_key": secret + "\x85"},
            {"api_key": secret + "\u200b"},
            {"api_key": 42},
            (("api_key", secret), ("api_key", secret + "-duplicate")),
            (("api_key", secret), ("token", secret)),
        )
        for credential_query in invalid_inputs:
            with self.subTest(kind=type(credential_query).__name__):
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                transport = _FakeTransport([_response()])
                client = self._client(transport, resolver)
                result = _failure_value(
                    client.request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/resource",
                        AccessPolicy(max_concurrency=1),
                        credential_query=cast(Any, credential_query),
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

                self.assertEqual(result.code, "policy")
                self.assertEqual(result.reason, "network policy rejected the destination")
                self.assertEqual(transport.calls, [])
                self.assertNotIn(secret, repr(result))
                self.assertNotIn(secret, result.model_dump_json())

    def test_query_credential_cannot_override_public_query_key(self) -> None:
        public_secret = "public-override-" + "sentinel"
        private_secret = "private-override-" + "sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])
        client = self._client(transport, resolver)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                f"https://example.test/resource?api%5Fkey={public_secret}",
                AccessPolicy(max_concurrency=1),
                credential_query={"api_key": private_secret},
                credential_allowed_origins=(_credential_origin(),),
            )
        )

        self.assertEqual(result.code, "policy")
        self.assertEqual(transport.calls, [])
        for secret in (public_secret, private_secret):
            self.assertNotIn(secret, repr(result))
            self.assertNotIn(secret, result.model_dump_json())

    def test_private_dns_and_rebinding_fail_closed_without_leaking_details(self) -> None:
        private_resolver = _Resolver({"private.test": ("127.0.0.1",)})
        private_transport = _FakeTransport([_response()])
        private_client = self._client(private_transport, private_resolver)
        private_result = _failure_value(
            private_client.request(
                AccessScope("fixture-provider", "api"),
                "https://private.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertIsInstance(private_result, AccessFailure)
        self.assertEqual(private_result.code, "policy")
        self.assertEqual(private_transport.calls, [])

        rebinding_resolver = _Resolver({"example.test": ("93.184.216.34", "127.0.0.1")})
        rebinding_transport = _FakeTransport([_response()])
        rebinding_client = self._client(rebinding_transport, rebinding_resolver)
        rebinding_result = _failure_value(
            rebinding_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertIsInstance(rebinding_result, AccessFailure)
        self.assertEqual(rebinding_result.code, "policy")

    def test_signed_query_and_transport_types_do_not_cross_the_neutral_boundary(self) -> None:
        secret = "short-lived-signature-sentinel"
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([_response()])
        client = self._client(transport, resolver)

        signed_result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                f"https://example.test/resource?X-Amz-Signature={secret}",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(signed_result.code, "policy")
        self.assertEqual(transport.calls, [])
        self.assertNotIn(secret, repr(signed_result))

        malformed_transport = _FakeTransport([object()])
        malformed_client = self._client(malformed_transport, resolver)
        malformed_result = _failure_value(
            malformed_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(malformed_result.code, "response")

        exception_transport = _FakeTransport([RuntimeError(secret)])
        exception_client = self._client(exception_transport, resolver)
        exception_result = _failure_value(
            exception_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(exception_result.code, "transport")
        self.assertNotIn(secret, repr(exception_result))

    def test_response_is_bounded_and_closed_when_oversize(self) -> None:
        oversized = _RawResponse(status=200, headers=(), body=b"123456789")
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([oversized])
        client = self._client(transport, resolver)
        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                max_response_bytes=4,
            )
        )

        self.assertIsInstance(result, AccessFailure)
        self.assertEqual(result.code, "oversize")
        self.assertTrue(oversized.closed)

    def test_connect_timeout_is_a_stable_failure_and_does_not_retry_status(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([TimeoutError("connect-secret")])
        client = self._client(transport, resolver)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                max_retries=0,
            )
        )

        self.assertEqual(result.code, "timeout")
        self.assertEqual(len(transport.calls), 1)
        self.assertNotIn("connect-secret", repr(result))

    def test_read_timeout_and_stream_error_close_the_raw_response(self) -> None:
        read_timeout_response = _RawResponse(status=200, headers=(), body=self._timeout_stream())
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        timeout_transport = _FakeTransport([read_timeout_response])
        timeout_client = self._client(timeout_transport, resolver)
        timeout_result = _failure_value(
            timeout_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(timeout_result.code, "timeout")
        self.assertTrue(read_timeout_response.closed)

        stream_error_response = _RawResponse(status=200, headers=(), body=self._error_stream())
        stream_transport = _FakeTransport([stream_error_response])
        stream_client = self._client(stream_transport, resolver)
        stream_result = _failure_value(
            stream_client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/stream",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(stream_result.code, "transport")
        self.assertTrue(stream_error_response.closed)

    @staticmethod
    def _timeout_stream() -> Iterable[bytes]:
        yield b"partial"
        raise TimeoutError("read-secret")

    @staticmethod
    def _error_stream() -> Iterable[bytes]:
        yield b"partial"
        raise RuntimeError("stream-secret")

    def test_overall_timeout_is_checked_during_body_stream(self) -> None:
        clock = _AdvancingClock()

        def slow_stream() -> Iterable[bytes]:
            yield b"first"
            clock.advance(2.0)
            yield b"second"

        raw_response = _RawResponse(status=200, headers=(), body=slow_stream())
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([raw_response])
        client = self._client(transport, resolver, clock=clock)

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/slow",
                AccessPolicy(max_concurrency=1),
                overall_timeout_seconds=1.0,
            )
        )

        self.assertEqual(result.code, "timeout")
        self.assertTrue(raw_response.closed)

    def test_cancelled_request_cleans_response_and_does_not_accept_late_result(self) -> None:
        cancelled = threading.Event()
        late_response = _RawResponse(status=200, headers=(), body=b"late")

        def return_late(
            request: TransportRequest,
            destination: object,
            headers: tuple[tuple[str, str], ...],
            cancel_event: threading.Event | None,
        ) -> _RawResponse:
            del request, destination, headers
            cancelled.set()
            self.assertIs(cancel_event, cancelled)
            return late_response

        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        transport = _FakeTransport([return_late])
        client = self._client(transport, resolver)
        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
                cancel_event=cancelled,
            )
        )

        self.assertIsInstance(result, AccessFailure)
        self.assertEqual(result.code, "cancelled")
        self.assertTrue(late_response.closed)

    def test_only_idempotent_connection_failures_retry_and_status_is_not_retried(self) -> None:
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        retry_transport = _FakeTransport([ConnectionError("secret-sentinel"), _response()])
        retry_client = self._client(retry_transport, resolver)
        retry_result = retry_client.request(
            AccessScope("fixture-provider", "api"),
            "https://example.test/resource",
            AccessPolicy(max_concurrency=1),
            max_retries=1,
        )
        self.assertFalse(isinstance(retry_result, AccessFailure))
        self.assertEqual(len(retry_transport.calls), 2)

        no_retry_transport = _FakeTransport([ConnectionError("secret-sentinel")])
        no_retry_client = self._client(no_retry_transport, resolver)
        no_retry_result = no_retry_client.request(
            AccessScope("fixture-provider", "api"),
            "https://example.test/resource",
            AccessPolicy(max_concurrency=1),
            method="POST",
            max_retries=5,
        )
        self.assertIsInstance(no_retry_result, AccessFailure)
        self.assertEqual(len(no_retry_transport.calls), 1)
        self.assertNotIn("secret-sentinel", repr(no_retry_result))

    def test_loopback_fixture_can_use_explicit_policy_and_client_closes_transport(self) -> None:
        resolver = _Resolver({"local.test": ("127.0.0.1",)})
        transport = _FakeTransport([_response(body=b"fixture")])
        client = self._client(transport, resolver, destination_policy=_LOOPBACK_POLICY)
        result = _response_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://local.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )
        self.assertEqual(result.body, b"fixture")
        client.close()
        self.assertTrue(transport.closed)

    def test_plain_http_loopback_integration_uses_explicit_operator_policy(self) -> None:
        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                payload = b"controlled-loopback"
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: object) -> None:
                del format, args

        server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server_thread = threading.Thread(target=server.serve_forever)
        server_thread.start()
        try:
            server_port = int(server.server_address[1])

            def socket_factory(family: int, kind: int) -> _PortMappedSocket:
                return _PortMappedSocket(socket.socket(family, kind), server_port)

            transport = SecureHttpTransport(socket_factory=socket_factory)
            resolver = _Resolver({"local.test": ("127.0.0.1",)})
            client = HttpClient(
                resolver=resolver,
                transport=transport,
                coordinator=AccessCoordinator(),
                destination_policy=_LOOPBACK_POLICY,
            )
            result = _response_value(
                client.request(
                    AccessScope("fixture-provider", "api"),
                    "http://local.test/resource",
                    AccessPolicy(max_concurrency=1),
                )
            )
            self.assertEqual(result.body, b"controlled-loopback")
            self.assertEqual(result.status, 200)
            client.close()
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join(1.0)
        self.assertFalse(server_thread.is_alive())

    def test_secure_transport_tracks_the_tls_wrapper_and_closes_all_sockets(self) -> None:
        raw_sockets: list[_FakeSocket] = []
        wrapped_sockets: list[_WrappedFakeSocket] = []
        server_hostnames: list[str | None] = []

        def socket_factory(family: int, kind: int) -> _FakeSocket:
            del family, kind
            sock = _FakeSocket()
            raw_sockets.append(sock)
            return sock

        transport = SecureHttpTransport(
            socket_factory=socket_factory,
            ssl_context_factory=lambda: _FakeTLSContext(wrapped_sockets, server_hostnames),
        )
        resolved = resolve_destination(
            "https://example.test/resource",
            lambda hostname: ("93.184.216.34",),
            policy=_HOST_POLICY,
        )
        request = TransportRequest(
            method="GET",
            url=resolved.url.url,
            headers=(),
            body=None,
            timeout_seconds=1.0,
            max_response_bytes=128,
        )

        with patch.object(http.client, "HTTPResponse", _FakeHttpResponse):
            raw_response = transport.send(
                request,
                resolved,
                headers=(),
                connect_timeout_seconds=1.0,
                read_timeout_seconds=1.0,
                tls_server_hostname="example.test",
                cancel_event=None,
            )

        self.assertEqual(len(raw_sockets), 1)
        self.assertEqual(len(wrapped_sockets), 1)
        self.assertEqual(server_hostnames, ["example.test"])
        self.assertEqual(tuple(transport._sockets.values()), (wrapped_sockets[0],))
        self.assertEqual(raw_sockets[0].connected_to, ("93.184.216.34", 443))
        self.assertIn(b"Host: example.test", wrapped_sockets[0].sent[0])

        close = getattr(raw_response, "close")
        close()
        self.assertEqual(transport._sockets, {})
        self.assertTrue(raw_sockets[0].closed)
        self.assertTrue(wrapped_sockets[0].closed)

    def test_secure_transport_generates_authority_and_framing_from_verified_destination(
        self,
    ) -> None:
        raw_sockets: list[_FakeSocket] = []
        wrapped_sockets: list[_WrappedFakeSocket] = []

        def socket_factory(family: int, kind: int) -> _FakeSocket:
            del family, kind
            sock = _FakeSocket()
            raw_sockets.append(sock)
            return sock

        transport = SecureHttpTransport(
            socket_factory=socket_factory,
            ssl_context_factory=lambda: _FakeTLSContext(wrapped_sockets, []),
        )
        resolved = resolve_destination(
            "https://example.test/resource",
            lambda hostname: ("93.184.216.34",),
            policy=_HOST_POLICY,
        )
        request = TransportRequest(
            method="POST",
            url=resolved.url.url,
            headers=(),
            body=b"payload",
            timeout_seconds=1.0,
            max_response_bytes=128,
        )

        with patch.object(http.client, "HTTPResponse", _FakeHttpResponse):
            raw_response = transport.send(
                request,
                resolved,
                headers=(),
                connect_timeout_seconds=1.0,
                read_timeout_seconds=1.0,
                tls_server_hostname="example.test",
                cancel_event=None,
            )

        wire_request = wrapped_sockets[0].sent[0].decode("ascii")
        self.assertEqual(wire_request.count("Host:"), 1)
        self.assertIn("Host: example.test\r\n", wire_request)
        self.assertEqual(wire_request.count("Content-Length:"), 1)
        self.assertIn("Content-Length: 7\r\n", wire_request)
        self.assertEqual(wire_request.count("Connection:"), 1)
        self.assertIn("Connection: close\r\n", wire_request)
        getattr(raw_response, "close")()

    def test_secure_transport_encodes_private_query_only_in_actual_request_target(self) -> None:
        secret = "wire runtime sentinel&/+"
        raw_sockets: list[_FakeSocket] = []
        wrapped_sockets: list[_WrappedFakeSocket] = []

        def socket_factory(family: int, kind: int) -> _FakeSocket:
            del family, kind
            sock = _FakeSocket()
            raw_sockets.append(sock)
            return sock

        transport = SecureHttpTransport(
            socket_factory=socket_factory,
            ssl_context_factory=lambda: _FakeTLSContext(wrapped_sockets, []),
        )
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        client = HttpClient(
            resolver=resolver,
            transport=transport,
            coordinator=AccessCoordinator(),
            destination_policy=_HOST_POLICY,
        )

        with patch.object(http.client, "HTTPResponse", _FakeHttpResponse):
            result = _response_value(
                client.request(
                    AccessScope("fixture-provider", "api"),
                    "https://example.test/resource?q=plain",
                    AccessPolicy(max_concurrency=1),
                    credential_query={"api_key": secret},
                    credential_allowed_origins=(_credential_origin(),),
                )
            )

        wire_request = wrapped_sockets[0].sent[0].decode("ascii")
        self.assertTrue(
            wire_request.startswith(
                "GET /resource?q=plain&api_key=wire+runtime+sentinel%26%2F%2B HTTP/1.1\r\n"
            )
        )
        self.assertEqual(wire_request.count("api_key="), 1)
        self.assertNotIn(secret, result.final_url)
        self.assertNotIn(secret, repr(result))
        self.assertNotIn(secret, result.model_dump_json())
        self.assertEqual(transport._sockets, {})
        client.close()

    def test_private_target_renderer_runs_only_after_connect_and_tls(self) -> None:
        secret = "renderer-order-query-sentinel"
        renderer_type = getattr(cast(Any, network_http_module), "_RequestTargetRenderer")
        original_render = renderer_type.render
        render_states: list[tuple[tuple[object, ...] | None, int, tuple[str | None, ...]]] = []
        current_raw_sockets: list[_FakeSocket] = []
        current_wrapped_sockets: list[_WrappedFakeSocket] = []
        current_server_hostnames: list[str | None] = []

        def observing_render(
            renderer: object,
            request: TransportRequest,
            destination: ResolvedDestination,
        ) -> str:
            render_states.append(
                (
                    current_raw_sockets[-1].connected_to,
                    len(current_wrapped_sockets),
                    tuple(current_server_hostnames),
                )
            )
            return cast(str, original_render(renderer, request, destination))

        class _ConnectFailureSocket(_FakeSocket):
            def connect(self, address: tuple[object, ...]) -> None:
                self.connected_to = address
                raise OSError("connect failed")

        class _BrokenTLSContext:
            def wrap_socket(
                self,
                raw: _FakeSocket,
                *,
                server_hostname: str | None,
            ) -> object:
                del raw, server_hostname
                raise ssl.SSLError("TLS failed")

        with patch.object(renderer_type, "render", new=observing_render):
            connect_transport = SecureHttpTransport(
                socket_factory=lambda family, kind: self._record_socket(
                    current_raw_sockets,
                    _ConnectFailureSocket(),
                    family,
                    kind,
                ),
                ssl_context_factory=lambda: _FakeTLSContext(
                    current_wrapped_sockets,
                    current_server_hostnames,
                ),
            )
            connect_result = _failure_value(
                HttpClient(
                    resolver=_Resolver({"example.test": ("93.184.216.34",)}),
                    transport=connect_transport,
                    coordinator=AccessCoordinator(),
                    destination_policy=_HOST_POLICY,
                ).request(
                    AccessScope("fixture-provider", "api"),
                    "https://example.test/resource",
                    AccessPolicy(max_concurrency=1),
                    credential_query={"api_key": secret},
                    credential_allowed_origins=(_credential_origin(),),
                    max_retries=0,
                )
            )
            self.assertEqual(connect_result.code, "transport")
            self.assertEqual(render_states, [])

            current_raw_sockets.clear()
            current_wrapped_sockets.clear()
            current_server_hostnames.clear()
            tls_transport = SecureHttpTransport(
                socket_factory=lambda family, kind: self._record_socket(
                    current_raw_sockets,
                    _FakeSocket(),
                    family,
                    kind,
                ),
                ssl_context_factory=_BrokenTLSContext,
            )
            tls_result = _failure_value(
                HttpClient(
                    resolver=_Resolver({"example.test": ("1.1.1.1", "93.184.216.34")}),
                    transport=tls_transport,
                    coordinator=AccessCoordinator(),
                    destination_policy=_HOST_POLICY,
                ).request(
                    AccessScope("fixture-provider", "api"),
                    "https://example.test/resource",
                    AccessPolicy(max_concurrency=1),
                    credential_query={"api_key": secret},
                    credential_allowed_origins=(_credential_origin(),),
                )
            )
            self.assertEqual(tls_result.code, "tls")
            self.assertEqual(render_states, [])
            self.assertEqual(len(current_raw_sockets), 1)

            current_raw_sockets.clear()
            current_wrapped_sockets.clear()
            current_server_hostnames.clear()
            success_transport = SecureHttpTransport(
                socket_factory=lambda family, kind: self._record_socket(
                    current_raw_sockets,
                    _FakeSocket(),
                    family,
                    kind,
                ),
                ssl_context_factory=lambda: _FakeTLSContext(
                    current_wrapped_sockets,
                    current_server_hostnames,
                ),
            )
            with patch.object(http.client, "HTTPResponse", _FakeHttpResponse):
                success_result = _response_value(
                    HttpClient(
                        resolver=_Resolver({"example.test": ("93.184.216.34",)}),
                        transport=success_transport,
                        coordinator=AccessCoordinator(),
                        destination_policy=_HOST_POLICY,
                    ).request(
                        AccessScope("fixture-provider", "api"),
                        "https://example.test/resource",
                        AccessPolicy(max_concurrency=1),
                        credential_query={"api_key": secret},
                        credential_allowed_origins=(_credential_origin(),),
                    )
                )

        self.assertEqual(success_result.status, 200)
        self.assertEqual(
            render_states,
            [(("93.184.216.34", 443), 1, ("example.test",))],
        )

    @staticmethod
    def _record_socket(
        sockets: list[_FakeSocket],
        sock: _FakeSocket,
        family: int,
        kind: int,
    ) -> _FakeSocket:
        del family, kind
        sockets.append(sock)
        return sock

    def test_secure_transport_falls_back_only_before_request_bytes_start(self) -> None:
        secret = "pre-send-fallback-query-sentinel"
        raw_sockets: list[_FakeSocket] = []
        wrapped_sockets: list[_WrappedFakeSocket] = []

        class _ConnectFailureSocket(_FakeSocket):
            def connect(self, address: tuple[object, ...]) -> None:
                self.connected_to = address
                raise OSError("connect failed")

        def socket_factory(family: int, kind: int) -> _FakeSocket:
            del family, kind
            sock: _FakeSocket
            if not raw_sockets:
                sock = _ConnectFailureSocket()
            else:
                sock = _FakeSocket()
            raw_sockets.append(sock)
            return sock

        transport = SecureHttpTransport(
            socket_factory=socket_factory,
            ssl_context_factory=lambda: _FakeTLSContext(wrapped_sockets, []),
        )
        client = HttpClient(
            resolver=_Resolver({"example.test": ("1.1.1.1", "93.184.216.34")}),
            transport=transport,
            coordinator=AccessCoordinator(),
            destination_policy=_HOST_POLICY,
        )

        with patch.object(http.client, "HTTPResponse", _FakeHttpResponse):
            result = _response_value(
                client.request(
                    AccessScope("fixture-provider", "api"),
                    "https://example.test/resource",
                    AccessPolicy(max_concurrency=1),
                    method="POST",
                    credential_query={"api_key": secret},
                    credential_allowed_origins=(_credential_origin(),),
                    max_retries=0,
                )
            )

        self.assertEqual(result.status, 200)
        self.assertEqual(len(raw_sockets), 2)
        self.assertEqual(raw_sockets[0].sent, [])
        self.assertTrue(raw_sockets[0].closed)
        self.assertEqual(len(wrapped_sockets), 1)
        self.assertEqual(len(wrapped_sockets[0].sent), 1)
        self.assertIn(secret.encode("ascii"), wrapped_sockets[0].sent[0])

    def test_secure_transport_never_falls_back_after_request_may_have_started(self) -> None:
        secret = "post-send-no-fallback-query-sentinel"
        for failure_phase in ("send", "begin", "read"):
            with self.subTest(failure_phase=failure_phase):
                raw_sockets: list[_FakeSocket] = []
                wrapped_sockets: list[_WrappedFakeSocket] = []

                class _PossiblySentSocket(_WrappedFakeSocket):
                    def sendall(self, data: bytes) -> None:
                        super().sendall(data)
                        if failure_phase == "send":
                            raise OSError("send outcome is unknown")

                class _TLSContext:
                    def wrap_socket(
                        self,
                        raw: _FakeSocket,
                        *,
                        server_hostname: str | None,
                    ) -> _PossiblySentSocket:
                        del server_hostname
                        result = _PossiblySentSocket(raw)
                        wrapped_sockets.append(result)
                        return result

                class _BeginFailureResponse(_FakeHttpResponse):
                    def begin(self) -> None:
                        if failure_phase == "begin":
                            raise OSError("response begin failed after send")
                        super().begin()

                    def read(self, amount: int = -1) -> bytes:
                        if failure_phase == "read":
                            raise OSError("response read failed after send")
                        return super().read(amount)

                def socket_factory(family: int, kind: int) -> _FakeSocket:
                    del family, kind
                    sock = _FakeSocket()
                    raw_sockets.append(sock)
                    return sock

                transport = SecureHttpTransport(
                    socket_factory=socket_factory,
                    ssl_context_factory=_TLSContext,
                )
                client = HttpClient(
                    resolver=_Resolver({"example.test": ("1.1.1.1", "93.184.216.34")}),
                    transport=transport,
                    coordinator=AccessCoordinator(),
                    destination_policy=_HOST_POLICY,
                )

                with patch.object(http.client, "HTTPResponse", _BeginFailureResponse):
                    result = _failure_value(
                        client.request(
                            AccessScope("fixture-provider", "api"),
                            "https://example.test/resource",
                            AccessPolicy(max_concurrency=1),
                            method="POST",
                            credential_query={"api_key": secret},
                            credential_allowed_origins=(_credential_origin(),),
                            max_retries=0,
                        )
                    )

                self.assertEqual(result.code, "transport")
                self.assertEqual(len(raw_sockets), 1)
                self.assertEqual(len(wrapped_sockets), 1)
                self.assertEqual(len(wrapped_sockets[0].sent), 1)
                self.assertIn(secret.encode("ascii"), wrapped_sockets[0].sent[0])
                self.assertEqual(transport._sockets, {})
                self.assertNotIn(secret, repr(result))

    def test_secure_transport_cancellation_closes_blocking_socket_tls_and_response_operations(
        self,
    ) -> None:
        for phase in ("connect", "tls", "send", "begin", "header", "body"):
            with self.subTest(phase=phase):
                entered = threading.Event()
                sockets: list[_BlockingSocket] = []
                tls_context = _BlockingTLSContext(entered, blocking=phase == "tls")

                def socket_factory(family: int, kind: int) -> _BlockingSocket:
                    del family, kind
                    socket = _BlockingSocket(phase, entered)
                    sockets.append(socket)
                    return socket

                transport = SecureHttpTransport(
                    socket_factory=socket_factory,
                    ssl_context_factory=lambda: tls_context,
                )
                resolver = _Resolver({"example.test": ("93.184.216.34",)})
                client = HttpClient(
                    resolver=resolver,
                    transport=transport,
                    coordinator=AccessCoordinator(),
                    destination_policy=_HOST_POLICY,
                )
                response = _BlockingHttpResponse(phase, entered)
                cancel_event = threading.Event()
                results: list[TransportResponse | AccessFailure] = []

                def run_request() -> None:
                    results.append(
                        client.request(
                            AccessScope("fixture-provider", "api"),
                            "https://example.test/resource",
                            AccessPolicy(max_concurrency=1),
                            body=b"payload",
                            connect_timeout_seconds=60.0,
                            read_timeout_seconds=60.0,
                            overall_timeout_seconds=60.0,
                            cancel_event=cancel_event,
                        )
                    )

                response_patch = patch.object(
                    http.client,
                    "HTTPResponse",
                    lambda raw_socket: response,
                )
                with response_patch:
                    worker = threading.Thread(target=run_request)
                    worker.start()
                    self.assertTrue(entered.wait(1.0))
                    cancel_event.set()
                    worker.join(1.0)

                self.assertFalse(worker.is_alive())
                self.assertEqual(len(results), 1)
                self.assertEqual(_failure_value(results[0]).code, "cancelled")
                self.assertTrue(sockets[0].closed)
                if phase in ("connect", "send"):
                    self.assertTrue(sockets[0].operation_finished.is_set())
                elif phase == "tls":
                    self.assertTrue(tls_context.operation_finished.is_set())
                else:
                    self.assertTrue(response.closed)
                    self.assertTrue(response.operation_finished.is_set())

    def test_secure_transport_tls_failure_closes_socket_and_maps_without_exception_leak(
        self,
    ) -> None:
        sockets: list[_FakeSocket] = []

        def socket_factory(family: int, kind: int) -> _FakeSocket:
            del family, kind
            sock = _FakeSocket()
            sockets.append(sock)
            return sock

        def broken_context() -> object:
            class _BrokenContext:
                def wrap_socket(
                    self,
                    raw: _FakeSocket,
                    *,
                    server_hostname: str | None,
                ) -> object:
                    del raw, server_hostname
                    raise ssl.SSLError("tls-secret")

            return _BrokenContext()

        secure_transport = SecureHttpTransport(
            socket_factory=socket_factory,
            ssl_context_factory=broken_context,
        )
        resolver = _Resolver({"example.test": ("93.184.216.34",)})
        client = HttpClient(
            resolver=resolver,
            transport=secure_transport,
            coordinator=AccessCoordinator(),
            destination_policy=_HOST_POLICY,
        )

        result = _failure_value(
            client.request(
                AccessScope("fixture-provider", "api"),
                "https://example.test/resource",
                AccessPolicy(max_concurrency=1),
            )
        )

        self.assertEqual(result.code, "tls")
        self.assertNotIn("tls-secret", repr(result))
        self.assertEqual(len(sockets), 1)
        self.assertTrue(sockets[0].closed)
        self.assertEqual(secure_transport._sockets, {})


if __name__ == "__main__":
    unittest.main()
