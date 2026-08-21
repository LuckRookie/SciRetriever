"""Bounded, policy-checked HTTP execution at the Network boundary.

The client in this module deliberately depends on an injected resolver and
transport.  It never performs DNS or socket I/O itself, which keeps the
security boundary testable without contacting a real provider.  The injected
transport receives an already-resolved destination and must connect only to
the supplied address set; it must not follow redirects or resolve the host a
second time on its own.

Only the neutral models from :mod:`sciretriever.model.access` leave this
boundary.  Transport objects, permits, credentials, response streams and
underlying exceptions remain private to this module and its adapter.
"""

from __future__ import annotations

import http.client
import ipaddress
import math
import re
import socket
import ssl
import threading
import time
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Callable, NoReturn, Protocol, TypeVar, cast
from urllib.parse import parse_qsl, unquote_to_bytes, urlencode, urlsplit

from sciretriever.logging.api import get_logger
from sciretriever.model.access import (
    AccessFailure,
    Header,
    TransportRequest,
    TransportResponse,
)

from .admission import (
    AccessCancelled,
    AccessCoordinator,
    AccessFeedback,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
)
from .policy import (
    BudgetUsage,
    DestinationPolicy,
    NormalizedURL,
    Origin,
    PolicyError,
    ResolvedDestination,
    ResolverLike,
    ResourceBudget,
    append_opaque_path_parameter,
    evaluate_redirect,
    normalize_url,
    resolve_destination,
)

Clock = Callable[[], float]
Sleeper = Callable[[float], None]
HeaderInput = Mapping[str, str] | Sequence[Header | tuple[str, str]]
CredentialQueryInput = Mapping[str, str] | Sequence[tuple[str, str]]
ResponseFeedbackInterpreter = Callable[[TransportResponse], AccessFeedback | None]
RedirectTargetGuard = Callable[[str], None]
RedirectAccessProfileResolver = Callable[
    [NormalizedURL],
    tuple[AccessScope, AccessPolicy],
]

_IDEMPOTENT_METHODS = frozenset({"DELETE", "GET", "HEAD", "OPTIONS", "PUT", "TRACE"})
_CREDENTIAL_NAMES = frozenset(
    {
        "authorization",
        "cookie",
        "proxy-authorization",
        "x-api-key",
        "x-apikey",
        "x-els-apikey",
        "x-insttoken",
        "x-els-insttoken",
        "wiley-tdm-client-token",
    }
)
_QUERY_CREDENTIAL_NAMES = frozenset({"api_key", "email"})
_QUERY_CREDENTIAL_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_AUTHORIZATION_CREDENTIAL = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+[ \t]+(.+?)[ \t]*$")
_AUTHORIZATION_CREDENTIAL_NAMES = frozenset({"authorization", "proxy-authorization"})
# Deterministic request-local limits for the private decoding closure.  The
# component and state caps also bound discovered/pending resident text to at
# most 4,194,304 characters, while the smaller scan budget normally fails
# closed first.
_ALIAS_GUARD_MAX_COMPONENT_CHARS = 16_384
_ALIAS_GUARD_MAX_STATES = 256
_ALIAS_GUARD_MAX_SCAN_CHARS = 1_048_576
_ALIAS_GUARD_MAX_VALUES = 64
_NETWORK_OWNED_HEADER_NAMES = frozenset(
    {
        "host",
        "contentlength",
        "transferencoding",
        "connection",
        "keepalive",
        "proxyauthenticate",
        "proxyauthorization",
        "proxyconnection",
        "te",
        "trailer",
        "upgrade",
    }
)
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_T = TypeVar("_T")
_LOGGER = get_logger(__name__)


class _Transport(Protocol):
    def send(
        self,
        request: TransportRequest,
        destination: ResolvedDestination,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: _RequestTargetRenderer,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> object:
        """Send one request to the already verified connection target.

        ``request`` is always the real, secret-free ``TransportRequest``.
        Implementations must invoke ``request_target_renderer`` only after the
        verified connection (and HTTPS TLS/SNI handshake) succeeds, immediately
        before constructing the request line.
        """


class _Closable(Protocol):
    def close(self) -> object:
        """Release the underlying response/session resources."""


class _SocketLike(Protocol):
    def settimeout(self, value: float | None, /) -> None: ...

    def connect(self, address: Any, /) -> None: ...

    def sendall(self, data: bytes, /) -> None: ...

    def close(self, /) -> None: ...


class _TransportCancelled(Exception):
    pass


@dataclass(frozen=True, slots=True, repr=False)
class _BoundQueryCredential:
    """Process-local credential bound to one already verified origin."""

    pairs: tuple[tuple[str, str], ...] = field(repr=False)
    origin: Origin


@dataclass(frozen=True, slots=True, repr=False)
class _CredentialAliasGuard:
    """Keep credential aliases private while checking every public locator."""

    values: tuple[str, ...] = field(repr=False)

    def __repr__(self) -> str:
        return "<_CredentialAliasGuard>"

    def reject_url(self, value: str) -> None:
        _reject_credential_alias_in_url(value, self.values)

    def reject_structured_path(self, value: str | None, *, input_name: str) -> None:
        _reject_credential_alias_in_structured_path_value(
            value,
            self.values,
            input_name=input_name,
        )


@dataclass(frozen=True, slots=True, repr=False)
class _CombinedRedirectTargetGuard:
    credential_alias_guard: _CredentialAliasGuard = field(repr=False)
    caller_guard: RedirectTargetGuard | None = field(repr=False)

    def __call__(self, target_url: str) -> None:
        self.credential_alias_guard.reject_url(target_url)
        if self.caller_guard is not None:
            self.caller_guard(target_url)


class _RequestTargetRenderer:
    """Render one private request target at the final wire boundary.

    The capability is deliberately not a Pydantic value, is safe to represent,
    and refuses generic serialisation.  It retains only the process-local query
    binding needed to render a target from the separately supplied safe request
    and verified destination.
    """

    __slots__ = ("_credential",)

    def __init__(self, credential: _BoundQueryCredential | None) -> None:
        self._credential = credential

    def __repr__(self) -> str:
        return "<_RequestTargetRenderer>"

    def __reduce__(self) -> NoReturn:
        raise TypeError("private request target renderer is not serialisable")

    def render(
        self,
        request: TransportRequest,
        destination: ResolvedDestination,
    ) -> str:
        if not isinstance(request, TransportRequest):
            raise TypeError("request target renderer requires a TransportRequest")
        if not isinstance(destination, ResolvedDestination):
            raise TypeError("request target renderer requires a verified destination")
        if request.url != destination.url.url:
            raise ValueError("request target destination mismatch")
        credential = self._credential
        if credential is None:
            return _safe_request_target(request.url)
        if destination.origin != credential.origin:
            raise ValueError("query credential origin binding failed")
        return _credential_wire_target(request.url, credential)


class SystemResolver:
    """Resolve every A/AAAA address using the operating system resolver."""

    def resolve(self, hostname: str) -> tuple[str, ...]:
        values = socket.getaddrinfo(
            hostname,
            None,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
        )
        addresses: set[str] = set()
        for family, _, _, _, sockaddr in values:
            if family in (socket.AF_INET, socket.AF_INET6) and sockaddr:
                address = sockaddr[0]
                if isinstance(address, str):
                    addresses.add(address)
        if not addresses:
            raise OSError("resolver returned no address")
        return tuple(sorted(addresses))


class _SecureResponse:
    __slots__ = (
        "status",
        "headers",
        "body",
        "_response",
        "_socket",
        "_transport",
        "_closed",
    )

    def __init__(
        self,
        response: http.client.HTTPResponse,
        sock: _SocketLike,
        transport: SecureHttpTransport,
        cancel_event: threading.Event | None,
    ) -> None:
        self.status = response.status
        self._response = response
        self._socket = sock
        self._transport = transport
        self._closed = False
        self.headers = tuple(
            _run_interruptibly(
                response.getheaders,
                cancel_event,
                abort=self.close,
            )
        )
        self.body = self._iter_body(cancel_event)

    def _iter_body(self, cancel_event: threading.Event | None) -> Iterable[bytes]:
        try:
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise _TransportCancelled()
                chunk = _run_interruptibly(
                    lambda: self._response.read(64 * 1024),
                    cancel_event,
                    abort=self.close,
                )
                if not chunk:
                    return
                yield chunk
        finally:
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._response.close()
        finally:
            try:
                self._socket.close()
            finally:
                self._transport._forget_socket(self._socket)


class SecureHttpTransport:
    """Standard-library transport bound to verified destination IPs.

    It does not resolve hostnames, follow redirects, or expose response and
    session objects to callers. HTTPS uses the default validating context and
    the verified hostname for SNI and certificate validation.
    """

    def __init__(
        self,
        *,
        socket_factory: Callable[..., Any] = socket.socket,
        ssl_context_factory: Callable[[], object] = ssl.create_default_context,
    ) -> None:
        self._socket_factory = socket_factory
        self._ssl_context_factory = ssl_context_factory
        self._lock = threading.Lock()
        self._sockets: dict[int, _SocketLike] = {}

    def send(
        self,
        request: TransportRequest,
        destination: ResolvedDestination,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: _RequestTargetRenderer | None = None,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> object:
        if cancel_event is not None and cancel_event.is_set():
            raise _TransportCancelled()
        if destination.url.scheme == "https" and tls_server_hostname != destination.hostname:
            raise ssl.SSLError("TLS hostname binding failed")
        if destination.url.scheme not in ("http", "https"):
            raise OSError("unsupported transport scheme")
        renderer = request_target_renderer or _RequestTargetRenderer(None)
        if not isinstance(renderer, _RequestTargetRenderer):
            raise TypeError("request_target_renderer is not valid")
        last_error: OSError | None = None
        for address in destination.addresses:
            try:
                sock = self._connect_one_address(
                    destination,
                    address,
                    connect_timeout_seconds=connect_timeout_seconds,
                    read_timeout_seconds=read_timeout_seconds,
                    tls_server_hostname=tls_server_hostname,
                    cancel_event=cancel_event,
                )
            except ssl.SSLError:
                raise
            except OSError as error:
                # Address fallback is safe only while no request byte could
                # have been handed to a socket.
                last_error = error
                continue
            try:
                return self._send_connected(
                    request,
                    destination,
                    sock,
                    headers=headers,
                    request_target_renderer=renderer,
                    cancel_event=cancel_event,
                )
            except http.client.HTTPException:
                # Do not try another address after sendall may have started.
                # Mapping to OSError preserves HttpClient's existing outer,
                # method-aware connection retry decision.
                raise OSError("HTTP protocol error") from None
        if last_error is not None:
            raise last_error
        raise OSError("no verified destination address")

    def _connect_one_address(
        self,
        destination: ResolvedDestination,
        address: str,
        *,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> _SocketLike:
        sock: _SocketLike | None = None
        try:
            if cancel_event is not None and cancel_event.is_set():
                raise _TransportCancelled()
            sock = self._new_socket(address)
            _run_interruptibly(
                lambda: sock.settimeout(connect_timeout_seconds),
                cancel_event,
                abort=lambda: _close_socket(sock),
            )
            _run_interruptibly(
                lambda: sock.connect(_socket_address(address, destination.url.port)),
                cancel_event,
                abort=lambda: _close_socket(sock),
            )
            if destination.url.scheme == "https":
                raw_socket = sock
                sock = _run_interruptibly(
                    lambda: self._wrap_tls_socket(raw_socket, tls_server_hostname),
                    cancel_event,
                    abort=lambda: _close_socket(raw_socket),
                )
            _run_interruptibly(
                lambda: sock.settimeout(read_timeout_seconds),
                cancel_event,
                abort=lambda: _close_socket(sock),
            )
            return sock
        except BaseException:
            _close_socket(sock)
            if sock is not None:
                self._forget_socket(sock)
            raise

    def _send_connected(
        self,
        request: TransportRequest,
        destination: ResolvedDestination,
        sock: _SocketLike,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: _RequestTargetRenderer,
        cancel_event: threading.Event | None,
    ) -> object:
        try:
            wire_request = _wire_request(
                request,
                headers,
                destination,
                request_target_renderer,
            )
            _run_interruptibly(
                lambda: sock.sendall(wire_request),
                cancel_event,
                abort=lambda: _close_socket(sock),
            )
            response = http.client.HTTPResponse(cast(socket.socket, sock))
            _run_interruptibly(
                response.begin,
                cancel_event,
                abort=lambda: _abort_response(response, sock),
            )
            return _SecureResponse(response, sock, self, cancel_event)
        except BaseException:
            _close_socket(sock)
            if sock is not None:
                self._forget_socket(sock)
            raise

    def _wrap_tls_socket(
        self,
        sock: _SocketLike,
        server_hostname: str | None,
    ) -> _SocketLike:
        context = self._ssl_context_factory()
        wrap_socket = getattr(context, "wrap_socket", None)
        if not callable(wrap_socket):
            raise ssl.SSLError("TLS context is not usable")
        wrapped = cast(_SocketLike, wrap_socket(sock, server_hostname=server_hostname))
        self._replace_socket(sock, wrapped)
        return wrapped

    def close(self) -> None:
        with self._lock:
            sockets = tuple(self._sockets.values())
            self._sockets.clear()
        for sock in sockets:
            _close_socket(sock)

    def _new_socket(self, address: str) -> _SocketLike:
        family = socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET
        sock = cast(_SocketLike, self._socket_factory(family, socket.SOCK_STREAM))
        self._track_socket(sock)
        return sock

    def _track_socket(self, sock: _SocketLike) -> None:
        with self._lock:
            self._sockets[id(sock)] = sock

    def _forget_socket(self, sock: _SocketLike) -> None:
        with self._lock:
            self._sockets.pop(id(sock), None)

    def _replace_socket(self, old: _SocketLike, new: _SocketLike) -> None:
        with self._lock:
            self._sockets.pop(id(old), None)
            self._sockets[id(new)] = new


def _socket_address(address: str, port: int) -> tuple[object, ...]:
    if ipaddress.ip_address(address).version == 6:
        return (address, port, 0, 0)
    return (address, port)


def _wire_request(
    request: TransportRequest,
    headers: tuple[tuple[str, str], ...],
    destination: ResolvedDestination,
    request_target_renderer: _RequestTargetRenderer,
) -> bytes:
    target = request_target_renderer.render(request, destination)
    if not target.startswith("/") or "\r" in target or "\n" in target or "\x00" in target:
        raise ValueError("private wire request target is invalid")
    header_pairs = list(headers)
    if any(_is_network_owned_header(name) for name, _ in header_pairs):
        raise ValueError("caller cannot provide network-owned headers")
    host = destination.hostname
    authority = f"[{host}]" if ":" in host else host
    default_port = 443 if destination.url.scheme == "https" else 80
    if destination.url.port != default_port:
        authority += f":{destination.url.port}"
    header_pairs.append(("Host", authority))
    header_pairs.append(("Connection", "close"))
    if request.body is not None:
        header_pairs.append(("Content-Length", str(len(request.body))))
    lines = [f"{request.method} {target} HTTP/1.1"]
    lines.extend(f"{name}: {value}" for name, value in header_pairs)
    payload = "\r\n".join(lines).encode("ascii") + b"\r\n\r\n"
    return payload + (request.body or b"")


def _safe_request_target(url: str) -> str:
    parsed = urlsplit(url)
    target = parsed.path or "/"
    if parsed.query:
        target += f"?{parsed.query}"
    return target


def _close_socket(sock: _SocketLike | None) -> None:
    if sock is not None:
        try:
            sock.close()
        except Exception:
            pass


def _abort_response(response: object, sock: _SocketLike | None) -> None:
    _close_resource(response)
    _close_socket(sock)


def _run_interruptibly(
    operation: Callable[[], _T],
    cancel_event: threading.Event | None,
    *,
    abort: Callable[[], None] | None,
) -> _T:
    """Run one blocking operation with active cancellation and cleanup."""

    if cancel_event is None:
        return operation()

    if cancel_event.is_set():
        _raise_transport_cancelled(abort)

    completed = threading.Event()
    values: list[_T] = []
    errors: list[BaseException] = []

    def run() -> None:
        try:
            values.append(operation())
        except BaseException as error:
            errors.append(error)
        finally:
            completed.set()

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    while not completed.wait(0.01):
        if cancel_event.is_set():
            _raise_transport_cancelled(abort, worker=worker, values=values)
    worker.join()
    if cancel_event.is_set():
        _raise_transport_cancelled(abort, values=values)
    if errors:
        raise errors[0]
    if not values:
        raise RuntimeError("blocking operation returned no result")
    return values[0]


def _raise_transport_cancelled(
    abort: Callable[[], None] | None,
    *,
    worker: threading.Thread | None = None,
    values: Sequence[object] | None = None,
) -> NoReturn:
    if abort is not None:
        try:
            abort()
        except Exception:
            pass
    if worker is not None:
        worker.join()
    if values:
        _close_resource(values[0])
    raise _TransportCancelled()


@dataclass(frozen=True, slots=True)
class _RequestSettings:
    connect_timeout_seconds: float
    read_timeout_seconds: float
    overall_timeout_seconds: float
    max_response_bytes: int
    max_redirects: int
    max_retries: int


@dataclass(frozen=True, slots=True, repr=False)
class _PreparedRequest:
    method: str
    safe_headers: tuple[Header, ...]
    private_headers: tuple[tuple[str, str], ...]
    credential_query: _BoundQueryCredential | None
    credential_alias_guard: _CredentialAliasGuard
    body: bytes | None
    settings: _RequestSettings
    destination_policy: DestinationPolicy
    budget: ResourceBudget
    current: ResolvedDestination
    redirect_target_guard: RedirectTargetGuard | None
    redirect_access_profile: RedirectAccessProfileResolver | None
    allow_guarded_redirect_encoded_path_separators: bool


@dataclass(frozen=True, slots=True)
class _HopResult:
    response: TransportResponse | AccessFailure
    usage: BudgetUsage
    next_destination: ResolvedDestination | None = None
    forward_credentials: bool = False
    same_origin: bool = False


@dataclass(slots=True, repr=False)
class _ScopeLease:
    """The currently admitted provider scope for one redirecting request."""

    scope: AccessScope
    policy: AccessPolicy
    permit: AccessPermit | None


class _RequestAbort(Exception):
    def __init__(self, code: str) -> None:
        self.code = code


def _strict_bool(value: object, *, field_name: str) -> bool:
    if type(value) is not bool:
        raise TypeError(f"{field_name} must be a bool")
    return value


class HttpClient:
    """Execute safe HTTP requests through one shared admission coordinator."""

    def __init__(
        self,
        *,
        resolver: ResolverLike,
        transport: _Transport,
        coordinator: AccessCoordinator,
        destination_policy: DestinationPolicy | None = None,
        connect_timeout_seconds: float = 10.0,
        read_timeout_seconds: float = 30.0,
        overall_timeout_seconds: float = 60.0,
        max_response_bytes: int = 1_048_576,
        max_redirects: int = 5,
        max_retries: int = 1,
        clock: Clock | None = None,
        sleeper: Sleeper | None = None,
    ) -> None:
        if not hasattr(transport, "send") or not callable(transport.send):
            raise TypeError("transport must expose send()")
        if not isinstance(coordinator, AccessCoordinator):
            raise TypeError("coordinator must be an AccessCoordinator")
        if destination_policy is not None and not isinstance(destination_policy, DestinationPolicy):
            raise TypeError("destination_policy must be a DestinationPolicy")
        self._resolver = resolver
        self._transport = transport
        self._coordinator = coordinator
        self._destination_policy = destination_policy or DestinationPolicy()
        self._defaults = self._settings(
            connect_timeout_seconds=connect_timeout_seconds,
            read_timeout_seconds=read_timeout_seconds,
            overall_timeout_seconds=overall_timeout_seconds,
            max_response_bytes=max_response_bytes,
            max_redirects=max_redirects,
            max_retries=max_retries,
        )
        self._clock = clock or time.monotonic
        self._sleeper = sleeper or time.sleep
        self._closed = False
        self._close_lock = threading.Lock()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        self.close()
        return False

    def __repr__(self) -> str:
        return f"<HttpClient closed={self._closed}>"

    def close(self) -> None:
        """Close the injected session/connection pool without exposing errors."""

        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            close = getattr(self._transport, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass

    def request(
        self,
        scope: AccessScope,
        url: str,
        policy: AccessPolicy,
        *,
        method: str = "GET",
        headers: HeaderInput = (),
        credential_headers: HeaderInput = (),
        credential_query: CredentialQueryInput = (),
        credential_allowed_origins: Iterable[Origin] = (),
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        body: bytes | None = None,
        destination_policy: DestinationPolicy | None = None,
        budget: ResourceBudget | None = None,
        connect_timeout_seconds: float | None = None,
        read_timeout_seconds: float | None = None,
        overall_timeout_seconds: float | None = None,
        max_response_bytes: int | None = None,
        max_redirects: int | None = None,
        follow_redirects: bool = True,
        max_retries: int | None = None,
        cancel_event: threading.Event | None = None,
        response_feedback: ResponseFeedbackInterpreter | None = None,
        redirect_target_guard: RedirectTargetGuard | None = None,
        redirect_access_profile: RedirectAccessProfileResolver | None = None,
        allow_guarded_redirect_encoded_path_separators: bool = False,
    ) -> TransportResponse | AccessFailure:
        """Run one bounded request and return only a neutral access result.

        Redirects are processed one hop at a time by default.  Each followed
        hop is resolved, rechecked and admitted before the injected transport
        is called.  ``follow_redirects=False`` returns the first neutral 3xx
        response without resolving or contacting its target.  A
        response status is returned to the adapter unchanged; this layer does
        not interpret provider status codes or response bodies.  A private
        header or query credential requires an explicit matching initial HTTPS
        origin.  Query credentials are attached only to the transport's actual
        request target.  An optional response feedback interpreter runs on the
        final neutral response while the scope permit is still held; its
        neutral feedback is applied as one atomic part of releasing that
        permit.  An optional redirect target guard receives each absolute
        redirect target before target DNS resolution or transport and can fail
        closed without exposing its exception or target through the result.
        A caller may separately opt a guarded Provider-issued opaque redirect
        into encoded path separators.  That narrow mode requires a target
        guard; ordinary and unguarded redirect URLs remain strict.  A
        request-local redirect access-profile resolver may assign each safely
        normalized redirect target to a provider scope and policy.  A target
        in the same scope tightens that scope in place; a target in another
        scope releases the previous complete-flow permit and obtains the new
        one before the next transport hop.
        """

        if self._closed:
            return _failure("closed")
        if response_feedback is not None and not callable(response_feedback):
            return _failure("policy")
        if redirect_target_guard is not None and not callable(redirect_target_guard):
            return _failure("policy")
        if redirect_access_profile is not None and not callable(redirect_access_profile):
            return _failure("policy")
        try:
            follow_redirects = _strict_bool(
                follow_redirects,
                field_name="follow_redirects",
            )
            settings = self._request_settings(
                connect_timeout_seconds=connect_timeout_seconds,
                read_timeout_seconds=read_timeout_seconds,
                overall_timeout_seconds=overall_timeout_seconds,
                max_response_bytes=max_response_bytes,
                max_redirects=max_redirects,
                max_retries=max_retries,
            )
            deadline = self._clock() + settings.overall_timeout_seconds
            prepared = self._prepare_request(
                scope,
                url,
                policy,
                method=method,
                headers=headers,
                credential_headers=credential_headers,
                credential_query=credential_query,
                credential_allowed_origins=credential_allowed_origins,
                path_parameter=path_parameter,
                path_parameter_suffix=path_parameter_suffix,
                body=body,
                destination_policy=destination_policy,
                budget=budget,
                settings=settings,
                cancel_event=cancel_event,
                deadline=deadline,
                redirect_target_guard=redirect_target_guard,
                redirect_access_profile=redirect_access_profile,
                allow_guarded_redirect_encoded_path_separators=(
                    allow_guarded_redirect_encoded_path_separators
                ),
            )
        except _RequestAbort as error:
            return _failure(error.code)
        except (PolicyError, TypeError, ValueError):
            return _failure("policy")

        diagnostics_enabled = not prepared.private_headers and prepared.credential_query is None
        diagnostic_started_ns = time.monotonic_ns()
        _log_network_request_started(
            scope,
            prepared,
            enabled=diagnostics_enabled,
        )

        scope_permit = self._acquire_scope_permit(
            scope,
            policy,
            cancel_event=cancel_event,
            deadline=deadline,
        )
        if isinstance(scope_permit, AccessFailure):
            return _logged_access_result(
                scope,
                scope_permit,
                enabled=diagnostics_enabled,
                started_ns=diagnostic_started_ns,
            )
        lease = _ScopeLease(scope=scope, policy=policy, permit=scope_permit)
        feedback: AccessFeedback | None = None
        try:
            result = self._run_hops(
                lease,
                prepared,
                follow_redirects=follow_redirects,
                cancel_event=cancel_event,
                deadline=deadline,
            )
            if response_feedback is not None and isinstance(result, TransportResponse):
                feedback = response_feedback(result)
                if feedback is not None and not isinstance(feedback, AccessFeedback):
                    raise TypeError("response_feedback must return AccessFeedback or None")
            return _logged_access_result(
                lease.scope,
                result,
                enabled=diagnostics_enabled,
                started_ns=diagnostic_started_ns,
            )
        finally:
            self._release_scope_lease(lease, feedback)

    def _acquire_scope_permit(
        self,
        scope: AccessScope,
        policy: AccessPolicy,
        *,
        cancel_event: threading.Event | None,
        deadline: float,
    ) -> AccessPermit | AccessFailure:
        try:
            return self._coordinator.acquire_scope(
                scope,
                policy,
                cancel_event=cancel_event,
                timeout=self._remaining(deadline),
            )
        except AccessCancelled:
            return _failure("cancelled")
        except AdmissionTimeout:
            return _failure("timeout")
        except _RequestAbort as error:
            return _failure(error.code)
        except (PolicyError, TypeError, ValueError):
            return _failure("policy")
        except Exception:
            return _failure("admission")

    def _run_hops(
        self,
        lease: _ScopeLease,
        prepared: _PreparedRequest,
        *,
        follow_redirects: bool,
        cancel_event: threading.Event | None,
        deadline: float,
    ) -> TransportResponse | AccessFailure:
        usage = BudgetUsage()
        redirects = 0
        current = prepared.current
        forwarded_credentials = prepared.private_headers
        forwarded_query = prepared.credential_query
        while True:
            scope_permit = lease.permit
            if scope_permit is None:
                return _failure("admission")
            try:
                prepared.credential_alias_guard.reject_url(current.url.url)
            except (TypeError, ValueError):
                return _failure("policy")
            hop = self._request_hop(
                scope_permit=scope_permit,
                current=current,
                request_method=prepared.method,
                safe_headers=prepared.safe_headers,
                private_headers=forwarded_credentials,
                credential_query=forwarded_query,
                credential_alias_guard=prepared.credential_alias_guard,
                body=prepared.body,
                settings=prepared.settings,
                destination_policy=prepared.destination_policy,
                effective_budget=prepared.budget,
                usage=usage,
                cancel_event=cancel_event,
                deadline=deadline,
                redirects=redirects,
                follow_redirects=follow_redirects,
                redirect_target_guard=prepared.redirect_target_guard,
                allow_guarded_redirect_encoded_path_separators=(
                    prepared.allow_guarded_redirect_encoded_path_separators
                ),
            )
            if hop.next_destination is None:
                return hop.response
            try:
                prepared.credential_alias_guard.reject_url(hop.next_destination.url.url)
            except (TypeError, ValueError):
                return _failure("policy")
            profile_failure = self._readmit_redirect_scope(
                lease,
                hop.next_destination,
                prepared.redirect_access_profile,
                cancel_event=cancel_event,
                deadline=deadline,
            )
            if profile_failure is not None:
                return profile_failure
            usage = hop.usage
            current = hop.next_destination
            forwarded_credentials = forwarded_credentials if hop.forward_credentials else ()
            forwarded_query = forwarded_query if hop.same_origin else None
            redirects += 1

    def _prepare_request(
        self,
        scope: AccessScope,
        url: str,
        policy: AccessPolicy,
        *,
        method: str,
        headers: HeaderInput,
        credential_headers: HeaderInput,
        credential_query: CredentialQueryInput,
        credential_allowed_origins: Iterable[Origin],
        path_parameter: str | None,
        path_parameter_suffix: str | None,
        body: bytes | None,
        destination_policy: DestinationPolicy | None,
        budget: ResourceBudget | None,
        settings: _RequestSettings,
        cancel_event: threading.Event | None,
        deadline: float,
        redirect_target_guard: RedirectTargetGuard | None,
        redirect_access_profile: RedirectAccessProfileResolver | None,
        allow_guarded_redirect_encoded_path_separators: bool,
    ) -> _PreparedRequest:
        if cancel_event is not None and not hasattr(cancel_event, "is_set"):
            raise TypeError("cancel_event must expose is_set()")
        if type(allow_guarded_redirect_encoded_path_separators) is not bool:
            raise TypeError("allow_guarded_redirect_encoded_path_separators must be a bool")
        if allow_guarded_redirect_encoded_path_separators and redirect_target_guard is None:
            raise ValueError(
                "allow_guarded_redirect_encoded_path_separators requires redirect_target_guard"
            )
        self._check_request_state(cancel_event, deadline)
        private_query = _normalise_private_query(credential_query)
        private_headers = _normalise_private_headers(credential_headers)
        credential_alias_guard = _credential_alias_guard(private_headers, private_query)
        request_method = _normalise_method(method)
        credential_alias_guard.reject_url(url)
        credential_alias_guard.reject_structured_path(
            path_parameter,
            input_name="path_parameter",
        )
        credential_alias_guard.reject_structured_path(
            path_parameter_suffix,
            input_name="path_parameter_suffix",
        )
        if path_parameter_suffix is not None and path_parameter is None:
            raise ValueError("path_parameter_suffix requires path_parameter")
        safe_headers = _normalise_safe_headers(
            headers,
            private_values=credential_alias_guard.values,
        )
        allowed_credential_origins = _normalise_credential_origins(credential_allowed_origins)
        if body is not None and type(body) is not bytes:
            raise ValueError("body must be bytes or None")
        if not isinstance(scope, AccessScope) or not isinstance(policy, AccessPolicy):
            raise TypeError("scope and policy must be canonical access values")
        effective_destination_policy = (
            self._destination_policy if destination_policy is None else destination_policy
        )
        if not isinstance(effective_destination_policy, DestinationPolicy):
            raise TypeError("destination_policy must be a DestinationPolicy")
        effective_budget = _effective_budget(budget, settings.max_response_bytes)
        if effective_budget.max_response_bytes is not None:
            settings = replace(
                settings,
                max_response_bytes=min(
                    settings.max_response_bytes,
                    effective_budget.max_response_bytes,
                ),
            )
        normalized_url = normalize_url(
            url,
            allowed_schemes=effective_destination_policy.allowed_schemes,
            allowed_ports=effective_destination_policy.allowed_ports,
        )
        if path_parameter is not None:
            normalized_url = append_opaque_path_parameter(
                normalized_url,
                path_parameter,
                suffix=path_parameter_suffix,
            )
        credential_alias_guard.reject_url(normalized_url.url)
        current = resolve_destination(
            normalized_url,
            self._resolver,
            policy=effective_destination_policy,
        )
        bound_query = _bind_private_query(
            private_query,
            current,
            allowed_credential_origins,
        )
        bound_headers = _bind_private_headers(
            private_headers,
            current,
            allowed_credential_origins,
        )
        self._check_request_state(cancel_event, deadline)
        return _PreparedRequest(
            method=request_method,
            safe_headers=safe_headers,
            private_headers=bound_headers,
            credential_query=bound_query,
            credential_alias_guard=credential_alias_guard,
            body=body,
            settings=settings,
            destination_policy=effective_destination_policy,
            budget=effective_budget,
            current=current,
            redirect_target_guard=redirect_target_guard,
            redirect_access_profile=redirect_access_profile,
            allow_guarded_redirect_encoded_path_separators=(
                allow_guarded_redirect_encoded_path_separators
            ),
        )

    def _readmit_redirect_scope(
        self,
        lease: _ScopeLease,
        target: ResolvedDestination,
        resolver: RedirectAccessProfileResolver | None,
        *,
        cancel_event: threading.Event | None,
        deadline: float,
    ) -> AccessFailure | None:
        if resolver is None:
            return None
        try:
            profile = resolver(target.url)
            if type(profile) is not tuple or len(profile) != 2:
                raise TypeError("redirect access profile must be a scope-policy tuple")
            target_scope, target_policy = profile
            if not isinstance(target_scope, AccessScope) or not isinstance(
                target_policy,
                AccessPolicy,
            ):
                raise TypeError("redirect access profile contains invalid values")
            if target_scope == lease.scope:
                lease.policy = self._coordinator.register(target_scope, target_policy)
                return None
        except (PolicyError, TypeError, ValueError):
            return _failure("policy")
        except Exception:
            return _failure("policy")

        self._release_scope_lease(lease)
        lease.scope = target_scope
        lease.policy = target_policy
        target_permit = self._acquire_scope_permit(
            target_scope,
            target_policy,
            cancel_event=cancel_event,
            deadline=deadline,
        )
        if isinstance(target_permit, AccessFailure):
            return target_permit
        lease.permit = target_permit
        try:
            lease.policy = self._coordinator.policy_for(target_scope)
        except Exception:
            self._release_scope_lease(lease)
            return _failure("admission")
        return None

    @staticmethod
    def _release_scope_lease(
        lease: _ScopeLease,
        feedback: AccessFeedback | None = None,
    ) -> None:
        permit = lease.permit
        lease.permit = None
        if permit is None:
            return
        try:
            permit.release(feedback)
        except Exception:
            pass

    def _request_hop(
        self,
        *,
        scope_permit: AccessPermit,
        current: ResolvedDestination,
        request_method: str,
        safe_headers: tuple[Header, ...],
        private_headers: tuple[tuple[str, str], ...],
        credential_query: _BoundQueryCredential | None,
        credential_alias_guard: _CredentialAliasGuard,
        body: bytes | None,
        settings: _RequestSettings,
        destination_policy: DestinationPolicy,
        effective_budget: ResourceBudget,
        usage: BudgetUsage,
        cancel_event: threading.Event | None,
        deadline: float,
        redirects: int,
        follow_redirects: bool,
        redirect_target_guard: RedirectTargetGuard | None,
        allow_guarded_redirect_encoded_path_separators: bool,
    ) -> _HopResult:
        try:
            self._check_request_state(cancel_event, deadline)
            current = resolve_destination(
                current.url,
                self._resolver,
                policy=destination_policy,
                previous=current,
            )
            host_permit = scope_permit.acquire_host(
                current.hostname,
                cancel_event=cancel_event,
                timeout=self._remaining(deadline),
            )
        except AccessCancelled:
            return _HopResult(_failure("cancelled"), usage)
        except AdmissionTimeout:
            return _HopResult(_failure("timeout"), usage)
        except _RequestAbort as error:
            return _HopResult(_failure(error.code), usage)
        except (PolicyError, TypeError, ValueError):
            return _HopResult(_failure("policy"), usage)
        except Exception:
            return _HopResult(_failure("admission"), usage)

        raw_response: object | None = None
        try:
            raw_response = self._send_with_retries(
                request_method,
                current,
                safe_headers,
                private_headers,
                credential_query,
                body,
                settings,
                destination_policy,
                cancel_event,
                deadline,
            )
            return self._process_hop_response(
                raw_response,
                current=current,
                settings=settings,
                destination_policy=destination_policy,
                effective_budget=effective_budget,
                usage=usage,
                cancel_event=cancel_event,
                deadline=deadline,
                redirects=redirects,
                follow_redirects=follow_redirects,
                credential_alias_guard=credential_alias_guard,
                redirect_target_guard=redirect_target_guard,
                allow_guarded_redirect_encoded_path_separators=(
                    allow_guarded_redirect_encoded_path_separators
                ),
            )
        except _RequestAbort as error:
            return _HopResult(_failure(error.code), usage)
        except (PolicyError, TypeError, ValueError):
            return _HopResult(_failure("policy"), usage)
        except Exception:
            return _HopResult(_failure("transport"), usage)
        finally:
            _close_resource(raw_response)
            try:
                host_permit.release()
            except Exception:
                pass

    def _process_hop_response(
        self,
        raw_response: object,
        *,
        current: ResolvedDestination,
        settings: _RequestSettings,
        destination_policy: DestinationPolicy,
        effective_budget: ResourceBudget,
        usage: BudgetUsage,
        cancel_event: threading.Event | None,
        deadline: float,
        redirects: int,
        follow_redirects: bool,
        credential_alias_guard: _CredentialAliasGuard,
        redirect_target_guard: RedirectTargetGuard | None,
        allow_guarded_redirect_encoded_path_separators: bool,
    ) -> _HopResult:
        response, elapsed = self._materialize_response(
            raw_response,
            current,
            settings.max_response_bytes,
            cancel_event,
            deadline,
        )
        try:
            next_usage = effective_budget.consume(
                response_bytes=0 if isinstance(response, AccessFailure) else len(response.body),
                navigations=1,
                elapsed_seconds=elapsed,
                usage=usage,
            )
        except PolicyError:
            return _HopResult(_failure("budget"), usage)
        if isinstance(response, AccessFailure):
            return _HopResult(response, next_usage)
        self._check_request_state(cancel_event, deadline)
        if not follow_redirects:
            return _HopResult(response, next_usage)
        return self._redirect_result(
            response,
            current=current,
            settings=settings,
            destination_policy=destination_policy,
            usage=next_usage,
            redirects=redirects,
            credential_alias_guard=credential_alias_guard,
            redirect_target_guard=redirect_target_guard,
            allow_guarded_redirect_encoded_path_separators=(
                allow_guarded_redirect_encoded_path_separators
            ),
        )

    def _redirect_result(
        self,
        response: TransportResponse,
        *,
        current: ResolvedDestination,
        settings: _RequestSettings,
        destination_policy: DestinationPolicy,
        usage: BudgetUsage,
        redirects: int,
        credential_alias_guard: _CredentialAliasGuard,
        redirect_target_guard: RedirectTargetGuard | None,
        allow_guarded_redirect_encoded_path_separators: bool,
    ) -> _HopResult:
        if response.status not in _REDIRECT_STATUSES:
            return _HopResult(response, usage)
        location = _header_value(response.headers, "location")
        if location is None:
            return _HopResult(response, usage)
        if redirects >= settings.max_redirects:
            return _HopResult(_failure("redirect_limit"), usage)
        decision = evaluate_redirect(
            current,
            location,
            self._resolver,
            policy=destination_policy,
            target_guard=_CombinedRedirectTargetGuard(
                credential_alias_guard=credential_alias_guard,
                caller_guard=redirect_target_guard,
            ),
            allow_guarded_encoded_path_separators=(allow_guarded_redirect_encoded_path_separators),
        )
        return _HopResult(
            response,
            usage,
            next_destination=decision.destination,
            forward_credentials=decision.forward_credentials,
            same_origin=decision.same_origin,
        )

    def _send_with_retries(
        self,
        method: str,
        destination: ResolvedDestination,
        safe_headers: tuple[Header, ...],
        private_headers: tuple[tuple[str, str], ...],
        credential_query: _BoundQueryCredential | None,
        body: bytes | None,
        settings: _RequestSettings,
        destination_policy: DestinationPolicy,
        cancel_event: threading.Event | None,
        deadline: float,
    ) -> object:
        retry_allowed = method in _IDEMPOTENT_METHODS
        attempts = settings.max_retries if retry_allowed else 0
        for attempt in range(attempts + 1):
            self._check_request_state(cancel_event, deadline)
            verified = resolve_destination(
                destination.url,
                self._resolver,
                policy=destination_policy,
                previous=destination,
            )
            remaining = self._remaining(deadline)
            timeout = min(settings.read_timeout_seconds, remaining)
            request = TransportRequest(
                method=method,
                url=verified.url.url,
                headers=safe_headers,
                body=body,
                timeout_seconds=timeout,
                max_response_bytes=settings.max_response_bytes,
            )
            if credential_query is not None:
                if verified.origin != credential_query.origin:
                    raise ValueError("query credential origin binding failed")
            request_target_renderer = _RequestTargetRenderer(credential_query)
            try:
                return self._transport.send(
                    request,
                    verified,
                    headers=tuple((header.name, header.value) for header in safe_headers)
                    + private_headers,
                    request_target_renderer=request_target_renderer,
                    connect_timeout_seconds=min(settings.connect_timeout_seconds, remaining),
                    read_timeout_seconds=timeout,
                    tls_server_hostname=verified.hostname
                    if verified.url.scheme == "https"
                    else None,
                    cancel_event=cancel_event,
                )
            except ssl.SSLError:
                return _failure("tls")
            except _TransportCancelled:
                return _failure("cancelled")
            except (ConnectionError, TimeoutError, OSError) as error:
                if attempt >= attempts:
                    return _failure("timeout" if isinstance(error, TimeoutError) else "transport")
                self._sleeper(0.0)
        return _failure("transport")

    def _materialize_response(
        self,
        raw_response: object,
        destination: ResolvedDestination,
        max_response_bytes: int,
        cancel_event: threading.Event | None,
        deadline: float,
    ) -> tuple[TransportResponse | AccessFailure, float]:
        started = self._clock()
        self._check_request_state(cancel_event, deadline)
        if isinstance(raw_response, AccessFailure):
            return raw_response, max(0.0, self._clock() - started)
        status = getattr(raw_response, "status", None)
        headers = getattr(raw_response, "headers", None)
        body = getattr(raw_response, "body", None)
        if type(status) is not int or not 100 <= status <= 599:
            return _failure("response"), max(0.0, self._clock() - started)
        try:
            safe_response_headers = _normalise_response_headers(headers)
            chunks = _read_bounded_body(
                body,
                max_response_bytes,
                cancel_event,
                check_state=lambda: self._check_request_state(cancel_event, deadline),
            )
            response = TransportResponse(
                status=status,
                final_url=destination.url.url,
                headers=safe_response_headers,
                body=b"".join(chunks),
            )
        except _RequestAbort as error:
            return _failure(error.code), max(0.0, self._clock() - started)
        except _TransportCancelled:
            return _failure("cancelled"), max(0.0, self._clock() - started)
        except ssl.SSLError:
            return _failure("tls"), max(0.0, self._clock() - started)
        except TimeoutError:
            return _failure("timeout"), max(0.0, self._clock() - started)
        except (TypeError, ValueError):
            return _failure("response"), max(0.0, self._clock() - started)
        except OSError:
            return _failure("transport"), max(0.0, self._clock() - started)
        return response, max(0.0, self._clock() - started)

    def _request_settings(self, **overrides: float | int | None) -> _RequestSettings:
        values: dict[str, float | int] = {
            "connect_timeout_seconds": self._defaults.connect_timeout_seconds,
            "read_timeout_seconds": self._defaults.read_timeout_seconds,
            "overall_timeout_seconds": self._defaults.overall_timeout_seconds,
            "max_response_bytes": self._defaults.max_response_bytes,
            "max_redirects": self._defaults.max_redirects,
            "max_retries": self._defaults.max_retries,
        }
        for name, value in overrides.items():
            if value is not None:
                values[name] = value
        return self._settings(
            connect_timeout_seconds=cast(float, values["connect_timeout_seconds"]),
            read_timeout_seconds=cast(float, values["read_timeout_seconds"]),
            overall_timeout_seconds=cast(float, values["overall_timeout_seconds"]),
            max_response_bytes=cast(int, values["max_response_bytes"]),
            max_redirects=cast(int, values["max_redirects"]),
            max_retries=cast(int, values["max_retries"]),
        )

    @staticmethod
    def _settings(
        *,
        connect_timeout_seconds: float | int,
        read_timeout_seconds: float | int,
        overall_timeout_seconds: float | int,
        max_response_bytes: int,
        max_redirects: int,
        max_retries: int,
    ) -> _RequestSettings:
        for name, value in (
            ("connect_timeout_seconds", connect_timeout_seconds),
            ("read_timeout_seconds", read_timeout_seconds),
            ("overall_timeout_seconds", overall_timeout_seconds),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a number")
            if not math.isfinite(float(value)) or float(value) <= 0:
                raise ValueError(f"{name} must be positive")
        for name, value in (
            ("max_response_bytes", max_response_bytes),
            ("max_redirects", max_redirects),
            ("max_retries", max_retries),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if max_response_bytes == 0:
            raise ValueError("max_response_bytes must be positive")
        return _RequestSettings(
            connect_timeout_seconds=float(connect_timeout_seconds),
            read_timeout_seconds=float(read_timeout_seconds),
            overall_timeout_seconds=float(overall_timeout_seconds),
            max_response_bytes=max_response_bytes,
            max_redirects=max_redirects,
            max_retries=max_retries,
        )

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise _RequestAbort("timeout")
        return remaining

    def _check_request_state(
        self,
        cancel_event: threading.Event | None,
        deadline: float,
    ) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise _RequestAbort("cancelled")
        self._remaining(deadline)


def _normalise_method(value: str) -> str:
    if type(value) is not str:
        raise TypeError("method must be a string")
    candidate = value.strip().upper()
    if not candidate or any(
        not (character.isalnum() or character in "!#$%&'*+-.^_`|~") for character in candidate
    ):
        raise ValueError("method must be an HTTP token")
    return candidate


def _normalise_safe_headers(
    value: HeaderInput,
    *,
    private_values: tuple[str, ...] = (),
) -> tuple[Header, ...]:
    items: Iterable[Header | tuple[str, str]]
    if isinstance(value, Mapping):
        items = tuple(value.items())
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        items = value
    else:
        raise TypeError("headers must be a mapping or sequence")
    result: list[Header] = []
    for item in items:
        if isinstance(item, Header):
            _reject_credential_value_alias(
                item.name,
                item.value,
                private_values=private_values,
                input_name="ordinary header",
            )
            header = item
        elif isinstance(item, tuple) and len(item) == 2:
            name, header_value = item
            if type(name) is str and type(header_value) is str:
                _reject_credential_value_alias(
                    name,
                    header_value,
                    private_values=private_values,
                    input_name="ordinary header",
                )
            header = Header(name=item[0], value=item[1])
        else:
            raise TypeError("header entries must be Header values or pairs")
        if _is_network_owned_header(header.name):
            raise ValueError("caller cannot provide network-owned headers")
        result.append(header)
    return tuple(result)


def _credential_alias_guard(
    private_headers: tuple[tuple[str, str], ...],
    private_query: tuple[tuple[str, str], ...],
) -> _CredentialAliasGuard:
    values: list[str] = []
    seen: set[str] = set()

    def remember(value: str) -> None:
        if not value or value in seen:
            return
        if len(values) >= _ALIAS_GUARD_MAX_VALUES:
            raise ValueError("credential alias guard exceeded its resource limit")
        seen.add(value)
        values.append(value)

    for _, value in private_query:
        remember(value)
    for name, value in private_headers:
        remember(value)
        stripped = value.strip(" \t")
        remember(stripped)
        if name.casefold() in _AUTHORIZATION_CREDENTIAL_NAMES:
            match = _AUTHORIZATION_CREDENTIAL.fullmatch(stripped)
            if match is not None:
                remember(match.group(1))
    return _CredentialAliasGuard(tuple(values))


def _reject_credential_alias_in_url(
    value: str,
    private_values: tuple[str, ...],
) -> None:
    if not private_values:
        return
    if type(value) is not str:
        raise TypeError("url must be a string")
    try:
        parsed = urlsplit(value)
    except (UnicodeError, ValueError):
        raise ValueError("ordinary URL could not be checked") from None
    for component, plus_as_space in (
        (parsed.netloc, False),
        (parsed.path, False),
        (parsed.query, True),
    ):
        if _url_component_contains_private_value(
            component,
            private_values,
            plus_as_space=plus_as_space,
        ):
            raise ValueError("ordinary URL cannot contain a credential alias")


def _url_component_contains_private_value(
    component: str,
    private_values: tuple[str, ...],
    *,
    plus_as_space: bool,
) -> bool:
    # Percent decoding strictly decreases string length.  The query form
    # transition preserves length but removes every current ``+``.  Every edge
    # therefore decreases the lexicographic measure (length, plus count), so
    # this closure reaches all stable spellings without a fixed round limit.
    if len(component) > _ALIAS_GUARD_MAX_COMPONENT_CHARS:
        raise ValueError("ordinary URL could not be checked")
    pending = [component]
    discovered = {component}
    scan_chars = 0

    def schedule(candidate: str) -> None:
        if candidate in discovered:
            return
        if len(discovered) >= _ALIAS_GUARD_MAX_STATES:
            raise ValueError("ordinary URL could not be checked")
        discovered.add(candidate)
        pending.append(candidate)

    while pending:
        candidate = pending.pop()
        eligible_values = tuple(
            private_value
            for private_value in private_values
            if len(private_value) <= len(candidate)
        )
        candidate_work = len(candidate) * (len(eligible_values) + 3) + sum(
            len(private_value) for private_value in eligible_values
        )
        if candidate_work > _ALIAS_GUARD_MAX_SCAN_CHARS - scan_chars:
            raise ValueError("ordinary URL could not be checked")
        scan_chars += candidate_work
        if any(private_value in candidate for private_value in eligible_values):
            return True
        if plus_as_space and "+" in candidate:
            schedule(candidate.replace("+", " "))
        if "%" in candidate:
            schedule(_decode_percent_layer(candidate))
    return False


def _decode_percent_layer(value: str) -> str:
    index = 0
    while index < len(value):
        if value[index] != "%":
            index += 1
            continue
        if (
            index + 2 >= len(value)
            or value[index + 1] not in "0123456789abcdefABCDEF"
            or value[index + 2] not in "0123456789abcdefABCDEF"
        ):
            raise ValueError("ordinary URL could not be checked")
        index += 3
    try:
        decoded = unquote_to_bytes(value).decode("utf-8", "strict")
    except UnicodeError:
        raise ValueError("ordinary URL could not be checked") from None
    # Every valid percent escape occupies three input characters and decodes
    # to at most one Unicode character.  Strictly decreasing length therefore
    # proves that repeated decoding reaches a stable spelling without a fixed
    # round limit.  Any violation means the alias decision is not trustworthy.
    if len(decoded) >= len(value):
        raise ValueError("ordinary URL could not be checked")
    return decoded


def _reject_credential_alias_in_structured_path_value(
    value: str | None,
    private_values: tuple[str, ...],
    *,
    input_name: str,
) -> None:
    if value is None or not private_values:
        return
    if type(value) is not str:
        raise TypeError(f"{input_name} must be a string or None")
    if _url_component_contains_private_value(
        value,
        private_values,
        plus_as_space=False,
    ):
        raise ValueError(f"{input_name} cannot contain a credential alias")


def _reject_credential_value_alias(
    *public_values: str,
    private_values: tuple[str, ...],
    input_name: str,
) -> None:
    if any(
        private_value in public_value
        for private_value in private_values
        for public_value in public_values
    ):
        raise ValueError(f"{input_name} cannot contain a credential alias")


def _normalise_private_headers(value: HeaderInput) -> tuple[tuple[str, str], ...]:
    items: Iterable[Header | tuple[str, str]]
    if isinstance(value, Mapping):
        items = tuple(value.items())
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        items = value
    else:
        raise TypeError("credential_headers must be a mapping or sequence")
    return tuple(_normalise_private_header(item) for item in items)


def _normalise_private_header(item: Header | tuple[str, str]) -> tuple[str, str]:
    if isinstance(item, Header):
        name, header_value = item.name, item.value
    elif isinstance(item, tuple) and len(item) == 2:
        name, header_value = item
    else:
        raise TypeError("credential header entries must be pairs")
    if type(name) is not str or type(header_value) is not str:
        raise TypeError("credential header names and values must be strings")
    if re.fullmatch(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+", name) is None:
        raise ValueError("credential header name is not a token")
    if any(character in header_value for character in "\r\n\x00"):
        raise ValueError("credential header value contains a control character")
    if _is_network_owned_header(name):
        raise ValueError("caller cannot provide network-owned headers")
    if name.casefold() not in _CREDENTIAL_NAMES:
        raise ValueError("credential header name is not supported")
    return name, header_value


def _normalise_private_query(
    value: CredentialQueryInput,
) -> tuple[tuple[str, str], ...]:
    items = _private_query_items(value)
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in items:
        name, credential_value = _normalise_private_query_pair(item)
        if name in seen:
            raise ValueError("credential_query contains a duplicate name")
        seen.add(name)
        result.append((name, credential_value))
    return tuple(result)


def _private_query_items(value: CredentialQueryInput) -> tuple[object, ...]:
    try:
        if isinstance(value, Mapping):
            return tuple(value.items())
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            return tuple(value)
        else:
            raise TypeError("credential_query must be a mapping or pair sequence")
    except (TypeError, ValueError):
        raise
    except Exception:
        raise ValueError("credential_query could not be read") from None


def _normalise_private_query_pair(item: object) -> tuple[str, str]:
    if type(item) is not tuple or len(item) != 2:
        raise TypeError("credential_query entries must be pairs")
    name, credential_value = item
    if type(name) is not str or type(credential_value) is not str:
        raise TypeError("credential_query names and values must be strings")
    if name not in _QUERY_CREDENTIAL_NAMES:
        raise ValueError("credential_query name is not supported")
    if not credential_value.strip():
        raise ValueError("credential_query value must be nonblank")
    if _QUERY_CREDENTIAL_CONTROL.search(credential_value) is not None or any(
        unicodedata.category(character) in {"Cc", "Cf"} for character in credential_value
    ):
        raise ValueError("credential_query value contains a control character")
    try:
        credential_value.encode("utf-8", "strict")
    except UnicodeError:
        raise ValueError("credential_query value is not valid Unicode") from None
    return name, credential_value


def _normalise_credential_origins(value: Iterable[Origin]) -> frozenset[Origin]:
    if isinstance(value, (str, bytes, bytearray, Mapping)):
        raise TypeError("credential_allowed_origins must be an origin iterable")
    try:
        origins = tuple(value)
    except Exception:
        raise ValueError("credential_allowed_origins could not be read") from None
    result: set[Origin] = set()
    for origin in origins:
        if type(origin) is not Origin:
            raise TypeError("credential_allowed_origins must contain Origin values")
        if origin.scheme != "https":
            raise ValueError("credential_allowed_origins contains an invalid origin")
        try:
            canonical = normalize_url(
                origin.text,
                allowed_schemes=("https",),
                allowed_ports=(("https", origin.port),),
            ).origin
        except PolicyError:
            raise ValueError("credential_allowed_origins contains an invalid origin") from None
        if canonical != origin:
            raise ValueError("credential_allowed_origins contains an invalid origin")
        result.add(origin)
    return frozenset(result)


def _bind_private_headers(
    pairs: tuple[tuple[str, str], ...],
    destination: ResolvedDestination,
    allowed_origins: frozenset[Origin],
) -> tuple[tuple[str, str], ...]:
    if pairs and destination.origin not in allowed_origins:
        raise ValueError("header credential is not allowed for the initial origin")
    return pairs


def _bind_private_query(
    pairs: tuple[tuple[str, str], ...],
    destination: ResolvedDestination,
    allowed_origins: frozenset[Origin],
) -> _BoundQueryCredential | None:
    if not pairs:
        return None
    if destination.origin not in allowed_origins:
        raise ValueError("query credential is not allowed for the initial origin")
    public_names = {
        name.casefold().replace("-", "_")
        for name, _ in parse_qsl(
            destination.url.query,
            keep_blank_values=True,
            strict_parsing=False,
        )
    }
    if any(name.casefold().replace("-", "_") in public_names for name, _ in pairs):
        raise ValueError("query credential cannot override a public query name")
    return _BoundQueryCredential(pairs=pairs, origin=destination.origin)


def _credential_wire_target(url: str, credential: _BoundQueryCredential) -> str:
    target = _safe_request_target(url)
    encoded = urlencode(credential.pairs, doseq=False, safe="", encoding="utf-8")
    if not encoded:
        raise ValueError("query credential could not be encoded")
    separator = "&" if urlsplit(url).query else "?"
    return f"{target}{separator}{encoded}"


def _is_network_owned_header(name: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", name.casefold())
    return normalized in _NETWORK_OWNED_HEADER_NAMES


def _normalise_response_headers(value: object) -> tuple[Header, ...]:
    if isinstance(value, Mapping):
        items: Iterable[object] = tuple(value.items())
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        items = value
    else:
        raise TypeError("response headers are not valid")
    result: list[Header] = []
    for item in items:
        if isinstance(item, Header):
            result.append(item)
            continue
        if not isinstance(item, tuple) or len(item) != 2:
            continue
        name, header_value = item
        try:
            result.append(Header(name=name, value=header_value))
        except (TypeError, ValueError):
            # Credential-bearing response headers, including Set-Cookie, do
            # not cross the neutral model boundary.
            continue
    return tuple(result)


def _read_bounded_body(
    body: object,
    max_response_bytes: int,
    cancel_event: threading.Event | None,
    *,
    check_state: Callable[[], None] | None = None,
) -> tuple[bytes, ...]:
    if type(body) is bytes:
        return _read_bytes_body(body, max_response_bytes, check_state)
    if isinstance(body, (bytearray, memoryview)):
        raise TypeError("response body must be bytes or an iterable of bytes")
    if body is None:
        raise TypeError("response body is missing")
    try:
        iterator = iter(cast(Iterable[object], body))
    except TypeError:
        raise TypeError("response body is not iterable") from None
    return _read_iterable_body(
        iterator,
        max_response_bytes,
        cancel_event,
        check_state,
    )


def _read_bytes_body(
    body: bytes,
    max_response_bytes: int,
    check_state: Callable[[], None] | None,
) -> tuple[bytes, ...]:
    if check_state is not None:
        check_state()
    if len(body) > max_response_bytes:
        raise _RequestAbort("oversize")
    return (body,)


def _read_iterable_body(
    iterator: Iterable[object],
    max_response_bytes: int,
    cancel_event: threading.Event | None,
    check_state: Callable[[], None] | None,
) -> tuple[bytes, ...]:
    chunks: list[bytes] = []
    total = 0
    for chunk in iterator:
        if check_state is not None:
            check_state()
        elif cancel_event is not None and cancel_event.is_set():
            raise _RequestAbort("cancelled")
        if type(chunk) is not bytes:
            raise TypeError("response chunks must be bytes")
        total += len(chunk)
        if total > max_response_bytes:
            raise _RequestAbort("oversize")
        chunks.append(chunk)
    if check_state is not None:
        check_state()
    return tuple(chunks)


def _header_value(headers: Sequence[Header], name: str) -> str | None:
    target = name.casefold()
    for header in headers:
        if header.name.casefold() == target:
            return header.value
    return None


def _effective_budget(budget: ResourceBudget | None, max_response_bytes: int) -> ResourceBudget:
    if budget is None:
        return ResourceBudget(max_response_bytes=max_response_bytes)
    if not isinstance(budget, ResourceBudget):
        raise TypeError("budget must be a ResourceBudget")
    if budget.max_response_bytes is None:
        return ResourceBudget(
            max_response_bytes=max_response_bytes,
            max_navigations=budget.max_navigations,
            max_downloads=budget.max_downloads,
            max_total_seconds=budget.max_total_seconds,
        )
    return budget


def _close_resource(value: object | None) -> None:
    if value is None:
        return
    close = getattr(value, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def _logged_access_result(
    scope: object,
    result: TransportResponse | AccessFailure,
    *,
    enabled: bool,
    started_ns: int,
) -> TransportResponse | AccessFailure:
    """Emit only scope-level, secret-free diagnostics for one final request result."""

    if not enabled:
        return result
    if isinstance(scope, AccessScope):
        provider_name = scope.provider_name
        channel = scope.channel
        service_name = scope.service_name or "-"
    else:
        provider_name = "invalid"
        channel = "invalid"
        service_name = "-"
    if isinstance(result, AccessFailure):
        _LOGGER.warning(
            "event=network-request-failed provider=%s channel=%s service=%s "
            "elapsed_ms=%d code=%s retryable=%s reason=%s action=%s",
            provider_name,
            channel,
            service_name,
            _elapsed_ms(started_ns),
            result.code,
            str(result.retryable).lower(),
            result.reason,
            result.action,
        )
        return result
    _LOGGER.debug(
        "event=network-request-finished provider=%s channel=%s service=%s "
        "status=%d response_bytes=%d elapsed_ms=%d",
        provider_name,
        channel,
        service_name,
        result.status,
        len(result.body),
        _elapsed_ms(started_ns),
    )
    return result


def _log_network_request_started(
    scope: AccessScope,
    prepared: _PreparedRequest,
    *,
    enabled: bool,
) -> None:
    """Record a secret-free request step when the request carries no credentials."""

    if not enabled:
        return
    _LOGGER.debug(
        "event=network-request-started provider=%s channel=%s service=%s method=%s",
        scope.provider_name,
        scope.channel,
        scope.service_name or "-",
        prepared.method,
    )


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.monotonic_ns() - started_ns) // 1_000_000)


def _failure(code: str) -> AccessFailure:
    text = {
        "admission": ("access admission failed", "retry the operation later", True),
        "cancelled": ("access operation cancelled", "retry when ready", True),
        "closed": ("access client is closed", "create a new client", False),
        "oversize": ("response exceeded the configured limit", "reduce the response size", False),
        "policy": (
            "network policy rejected the destination",
            "check the configured destination",
            False,
        ),
        "redirect_limit": ("redirect limit exceeded", "check the source locator", False),
        "response": ("network response was invalid", "retry the operation later", True),
        "timeout": ("network operation timed out", "retry the operation later", True),
        "tls": ("TLS validation failed", "check the destination certificate", False),
        "transport": ("network transport failed", "retry the operation later", True),
    }
    reason, action, retryable = text.get(
        code,
        ("network access failed", "retry the operation later", True),
    )
    return AccessFailure(code=code, reason=reason, action=action, retryable=retryable)


__all__ = (
    "HttpClient",
    "RedirectAccessProfileResolver",
    "RedirectTargetGuard",
    "ResponseFeedbackInterpreter",
    "SecureHttpTransport",
    "SystemResolver",
)
