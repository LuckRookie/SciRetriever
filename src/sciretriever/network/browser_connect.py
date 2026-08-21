"""Private headed-display and byte-tunnel support for the Playwright adapter.

The CONNECT proxy in this module never terminates TLS and never parses an
HTTPS request.  Chromium produces TLS, HTTP/2, request headers, Cookies and
redirect behaviour; the proxy only pins an already-admitted hostname/port to
the exact numeric address supplied by :mod:`network.browser` and forwards
opaque bytes.  This preserves the Network DNS/SSRF boundary without replacing
the browser protocol stack with Python HTTP.

Linux headed sessions share one process-local Xvfb display.  A lease keeps the
display alive only while at least one Publisher Browser session exists.  No
display, proxy endpoint, profile path or vendor error crosses the Network
adapter boundary.
"""

from __future__ import annotations

import ipaddress
import os
import select
import selectors
import shutil
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit

_START_TIMEOUT_SECONDS: Final[float] = 15.0
_CONNECT_TIMEOUT_SECONDS: Final[float] = 15.0
_CLIENT_HEADER_LIMIT: Final[int] = 64 * 1024
_RELAY_CHUNK_BYTES: Final[int] = 64 * 1024
_THREAD_JOIN_SECONDS: Final[float] = 5.0


class BrowserNativeTransportError(RuntimeError):
    """Payload-free failure from the headed display or CONNECT tunnel."""


def _transport_error() -> BrowserNativeTransportError:
    return BrowserNativeTransportError("controlled Browser native transport failed")


def xvfb_executable_available() -> bool:
    """Return static Xvfb file availability without starting a display."""

    if not sys.platform.startswith("linux"):
        return True
    executable = shutil.which("Xvfb")
    return executable is not None and os.path.isfile(executable) and os.access(executable, os.X_OK)


class _XvfbManager:
    __slots__ = ("_lock", "_process", "_display", "_leases")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._display: str | None = None
        self._leases = 0

    def acquire(self) -> HeadedDisplayLease:
        if not sys.platform.startswith("linux"):
            return HeadedDisplayLease(self, None, managed=False)
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None or self._display is None:
                self._stop_locked()
                self._process, self._display = self._start_locked()
            self._leases += 1
            return HeadedDisplayLease(self, self._display, managed=True)

    def release(self, *, managed: bool) -> None:
        if not managed:
            return
        with self._lock:
            if self._leases <= 0:
                raise _transport_error()
            self._leases -= 1
            if self._leases == 0:
                self._stop_locked()

    @staticmethod
    def _start_locked() -> tuple[subprocess.Popen[bytes], str]:
        executable = shutil.which("Xvfb")
        if executable is None:
            raise _transport_error()
        process, read_fd = _launch_xvfb(executable)
        try:
            return process, _read_xvfb_display(process, read_fd)
        except BaseException:
            _stop_process(process)
            raise
        finally:
            os.close(read_fd)

    def _stop_locked(self) -> None:
        process = self._process
        self._process = None
        self._display = None
        self._leases = 0
        if process is not None:
            _stop_process(process)


def _launch_xvfb(executable: str) -> tuple[subprocess.Popen[bytes], int]:
    read_fd, write_fd = os.pipe()
    try:
        process = subprocess.Popen(
            (
                executable,
                "-displayfd",
                str(write_fd),
                "-screen",
                "0",
                "1920x1080x24",
                "-nolisten",
                "tcp",
                "-noreset",
            ),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            pass_fds=(write_fd,),
        )
    except (OSError, ValueError):
        os.close(read_fd)
        raise _transport_error() from None
    finally:
        os.close(write_fd)
    return process, read_fd


def _read_xvfb_display(process: subprocess.Popen[bytes], read_fd: int) -> str:
    deadline = time.monotonic() + _START_TIMEOUT_SECONDS
    payload = bytearray()
    while b"\n" not in payload:
        remaining = deadline - time.monotonic()
        if remaining <= 0.0 or process.poll() is not None:
            raise _transport_error()
        ready, _, _ = select.select((read_fd,), (), (), min(remaining, 0.25))
        if not ready:
            continue
        chunk = os.read(read_fd, 32)
        if not chunk:
            raise _transport_error()
        payload.extend(chunk)
        if len(payload) > 32:
            raise _transport_error()
    number = bytes(payload).split(b"\n", 1)[0]
    if not number.isdigit():
        raise _transport_error()
    return f":{number.decode('ascii')}"


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=_THREAD_JOIN_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        process.kill()
        try:
            process.wait(timeout=_THREAD_JOIN_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            pass


_XVFB_MANAGER = _XvfbManager()


class HeadedDisplayLease:
    """One reference to the shared process-local headed display."""

    __slots__ = ("_manager", "display", "_managed", "_closed")

    def __init__(self, manager: _XvfbManager, display: str | None, *, managed: bool) -> None:
        self._manager = manager
        self.display = display
        self._managed = managed
        self._closed = False

    def environment(self) -> dict[str, str]:
        values = dict(os.environ)
        if self.display is not None:
            values["DISPLAY"] = self.display
            values.pop("WAYLAND_DISPLAY", None)
        return values

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._manager.release(managed=self._managed)

    def __enter__(self) -> HeadedDisplayLease:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        del exc_type, exc_value, traceback
        self.close()
        return False


def acquire_headed_display() -> HeadedDisplayLease:
    """Acquire the shared Xvfb display used by headed Linux Chromium."""

    return _XVFB_MANAGER.acquire()


@dataclass(frozen=True, slots=True)
class _ProxyBinding:
    scheme: str
    hostname: str
    port: int
    address: str


def _binding(value: object) -> _ProxyBinding:
    scheme = getattr(value, "scheme", None)
    hostname = getattr(value, "hostname", None)
    port = getattr(value, "port", None)
    address = getattr(value, "address", None)
    verified = getattr(value, "verified_addresses", None)
    authority = getattr(value, "authority", None)
    server_name = getattr(value, "tls_server_name", None)
    if (
        type(scheme) is not str
        or scheme not in {"http", "https"}
        or type(hostname) is not str
        or not hostname
        or type(port) is not int
        or not 1 <= port <= 65535
        or type(address) is not str
        or not isinstance(verified, tuple)
        or address not in verified
        or authority != hostname
        or server_name != hostname
    ):
        raise _transport_error()
    try:
        canonical_address = str(ipaddress.ip_address(address))
    except ValueError:
        raise _transport_error() from None
    if canonical_address != address:
        raise _transport_error()
    return _ProxyBinding(scheme, hostname.casefold(), port, address)


def _parse_authority(value: str) -> tuple[str, int]:
    try:
        parsed = urlsplit(f"//{value}")
        hostname = parsed.hostname
        port = parsed.port
    except (UnicodeError, ValueError):
        raise _transport_error() from None
    if (
        hostname is None
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise _transport_error()
    return hostname.casefold(), port


def _exact_connection(address: str, port: int) -> socket.socket:
    parsed = ipaddress.ip_address(address)
    family = socket.AF_INET6 if parsed.version == 6 else socket.AF_INET
    connection = socket.socket(family, socket.SOCK_STREAM)
    connection.settimeout(_CONNECT_TIMEOUT_SECONDS)
    try:
        connection.connect((address, port))
    except BaseException:
        connection.close()
        raise
    connection.settimeout(None)
    return connection


@dataclass(slots=True)
class _LaneTransportState:
    transferred_bytes: int = 0
    failed: bool = False


@dataclass(slots=True)
class _Authorization:
    binding: _ProxyBinding
    owners: set[object]


@dataclass(slots=True)
class _TrackedConnection:
    key: tuple[str, str, int] | None
    owners: set[object]


class BrowserConnectProxy:
    """Loopback-only CONNECT proxy with independent article-lane ownership.

    Chromium supplies no page identity in a CONNECT request. Authorizations
    are therefore merged only when every active lane pins an authority to the
    same numeric destination. Connection ownership is reference-counted: one
    lane ending cannot close a tunnel still authorized by another lane.
    """

    __slots__ = (
        "_listener",
        "_thread",
        "_stop",
        "_lock",
        "_authorizations",
        "_connections",
        "_workers",
        "_lanes",
        "_maximum_article_bytes",
        "_failed",
        "_closed",
        "server_url",
    )

    def __init__(self, *, maximum_article_bytes: int) -> None:
        if type(maximum_article_bytes) is not int or maximum_article_bytes < 1:
            raise TypeError("maximum_article_bytes must be a positive integer")
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(64)
            listener.settimeout(0.25)
        except BaseException:
            listener.close()
            raise _transport_error() from None
        self._listener = listener
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._authorizations: dict[tuple[str, str, int], _Authorization] = {}
        self._connections: dict[socket.socket, _TrackedConnection] = {}
        self._workers: set[threading.Thread] = set()
        self._lanes: dict[object, _LaneTransportState] = {}
        self._maximum_article_bytes = maximum_article_bytes
        self._failed = False
        self._closed = False
        port = listener.getsockname()[1]
        self.server_url = f"http://127.0.0.1:{port}"
        self._thread = threading.Thread(
            target=self._serve,
            name="sciretriever-browser-connect",
            daemon=True,
        )
        self._thread.start()

    @staticmethod
    def _lane_token(value: object) -> object:
        if value is None:
            raise _transport_error()
        try:
            hash(value)
        except (TypeError, ValueError):
            raise _transport_error() from None
        return value

    def begin_lane(self, lane_token: object) -> object:
        token = self._lane_token(lane_token)
        with self._lock:
            if self._closed or token in self._lanes:
                raise _transport_error()
            self._lanes[token] = _LaneTransportState()
        return lane_token

    def authorize(self, lane_token: object, value: object) -> object:
        token = self._lane_token(lane_token)
        binding = _binding(value)
        key = (binding.scheme, binding.hostname, binding.port)
        with self._lock:
            if self._closed or token not in self._lanes:
                raise _transport_error()
            authorization = self._authorizations.get(key)
            if authorization is None:
                authorization = _Authorization(binding, {token})
                self._authorizations[key] = authorization
            else:
                if authorization.binding != binding:
                    raise _transport_error()
                authorization.owners.add(token)
            for tracked in self._connections.values():
                if tracked.key == key:
                    tracked.owners.add(token)
        return value

    def end_lane(self, lane_token: object) -> bool:
        token = self._lane_token(lane_token)
        with self._lock:
            if self._closed:
                return False
            state = self._lanes.pop(token, None)
            if state is None:
                return False
            for key, authorization in tuple(self._authorizations.items()):
                authorization.owners.discard(token)
                if not authorization.owners:
                    self._authorizations.pop(key, None)
            stale: list[socket.socket] = []
            for connection, tracked in self._connections.items():
                owned = token in tracked.owners
                tracked.owners.discard(token)
                if owned and not tracked.owners:
                    stale.append(connection)
            failed = state.failed
        self._close_sockets(tuple(stale))
        return not failed

    def close(self) -> None:
        with self._lock:
            if self._closed:
                if self._failed:
                    raise _transport_error()
                return
            self._closed = True
            self._authorizations.clear()
            self._lanes.clear()
            connections = tuple(self._connections)
        self._stop.set()
        try:
            self._listener.close()
        except OSError:
            pass
        self._close_sockets(connections)
        self._thread.join(_THREAD_JOIN_SECONDS)
        with self._lock:
            workers = tuple(self._workers)
        for worker in workers:
            worker.join(_THREAD_JOIN_SECONDS)
        with self._lock:
            failed = (
                self._failed
                or self._thread.is_alive()
                or any(worker.is_alive() for worker in self._workers)
            )
        if failed:
            raise _transport_error()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                client, _address = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if not self._stop.is_set():
                    self._mark_failed()
                return
            worker = threading.Thread(
                target=self._serve_client,
                args=(client,),
                name="sciretriever-browser-connect-client",
                daemon=True,
            )
            with self._lock:
                self._workers.add(worker)
                self._connections[client] = _TrackedConnection(None, set())
            worker.start()

    def _serve_client(self, client: socket.socket) -> None:
        upstream: socket.socket | None = None
        try:
            client.settimeout(_CONNECT_TIMEOUT_SECONDS)
            header, remainder = self._read_header(client)
            first_line, *header_lines = header.split(b"\r\n")
            try:
                method, target, version = first_line.decode("ascii").split(" ", 2)
            except (UnicodeError, ValueError):
                raise _transport_error() from None
            if version not in {"HTTP/1.0", "HTTP/1.1"}:
                raise _transport_error()
            if method == "CONNECT":
                hostname, port = _parse_authority(target)
                key = ("https", hostname, port)
                binding, owners = self._authorized(key)
                upstream = _exact_connection(binding.address, binding.port)
                self._track(client, key, owners)
                self._track(upstream, key, owners)
                client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                if remainder:
                    upstream.sendall(remainder)
                    self._consume(len(remainder), owners)
                self._relay(client, upstream)
                return
            parsed = urlsplit(target)
            hostname = parsed.hostname
            if (
                parsed.scheme.casefold() != "http"
                or hostname is None
                or parsed.username is not None
                or parsed.password is not None
                or parsed.fragment
            ):
                raise _transport_error()
            port = parsed.port or 80
            key = ("http", hostname.casefold(), port)
            binding, owners = self._authorized(key)
            upstream = _exact_connection(binding.address, binding.port)
            self._track(client, key, owners)
            self._track(upstream, key, owners)
            path = parsed.path or "/"
            if parsed.query:
                path = f"{path}?{parsed.query}"
            filtered = tuple(
                line
                for line in header_lines
                if not line.lower().startswith((b"proxy-connection:", b"proxy-authorization:"))
            )
            request = b" ".join(
                (method.encode("ascii"), path.encode("ascii"), version.encode("ascii"))
            )
            payload = request + b"\r\n" + b"\r\n".join(filtered) + b"\r\n\r\n" + remainder
            upstream.sendall(payload)
            self._consume(len(payload), owners)
            self._relay(client, upstream)
        except BaseException:
            try:
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
        finally:
            self._untrack(client)
            if upstream is not None:
                self._untrack(upstream)
            self._close_sockets((client,) if upstream is None else (client, upstream))
            with self._lock:
                self._workers.discard(threading.current_thread())

    @staticmethod
    def _read_header(client: socket.socket) -> tuple[bytes, bytes]:
        payload = bytearray()
        while b"\r\n\r\n" not in payload:
            chunk = client.recv(min(_RELAY_CHUNK_BYTES, _CLIENT_HEADER_LIMIT + 1 - len(payload)))
            if not chunk:
                raise _transport_error()
            payload.extend(chunk)
            if len(payload) > _CLIENT_HEADER_LIMIT:
                raise _transport_error()
        header, remainder = bytes(payload).split(b"\r\n\r\n", 1)
        return header, remainder

    def _authorized(
        self,
        key: tuple[str, str, int],
    ) -> tuple[_ProxyBinding, frozenset[object]]:
        with self._lock:
            authorization = self._authorizations.get(key)
            if self._closed or authorization is None:
                raise _transport_error()
            owners = frozenset(owner for owner in authorization.owners if owner in self._lanes)
            if not owners:
                raise _transport_error()
            return authorization.binding, owners

    def _relay(self, client: socket.socket, upstream: socket.socket) -> None:
        client.setblocking(False)
        upstream.setblocking(False)
        relay = selectors.DefaultSelector()
        try:
            relay.register(client, selectors.EVENT_READ, upstream)
            relay.register(upstream, selectors.EVENT_READ, client)
            while not self._stop.is_set():
                owners = self._connection_owners(client)
                if not owners:
                    return
                events = relay.select(0.25)
                for key, _mask in events:
                    source = key.fileobj
                    target = key.data
                    if not isinstance(source, socket.socket) or not isinstance(
                        target, socket.socket
                    ):
                        raise _transport_error()
                    try:
                        chunk = source.recv(_RELAY_CHUNK_BYTES)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        return
                    self._consume(len(chunk), owners)
                    target.sendall(chunk)
        finally:
            relay.close()

    def _connection_owners(self, connection: socket.socket) -> frozenset[object]:
        with self._lock:
            tracked = self._connections.get(connection)
            if self._closed or tracked is None:
                return frozenset()
            return frozenset(owner for owner in tracked.owners if owner in self._lanes)

    def _consume(self, amount: int, owners: frozenset[object]) -> None:
        with self._lock:
            active = tuple(owner for owner in owners if owner in self._lanes)
            if not active:
                raise _transport_error()
            exceeded = False
            for owner in active:
                state = self._lanes[owner]
                state.transferred_bytes += amount
                if state.transferred_bytes > self._maximum_article_bytes:
                    state.failed = True
                    exceeded = True
            if exceeded:
                raise _transport_error()

    def _track(
        self,
        value: socket.socket,
        key: tuple[str, str, int],
        owners: frozenset[object],
    ) -> None:
        with self._lock:
            if self._closed:
                raise _transport_error()
            self._connections[value] = _TrackedConnection(key, set(owners))

    def _untrack(self, value: socket.socket) -> None:
        with self._lock:
            self._connections.pop(value, None)

    def _mark_failed(self) -> None:
        with self._lock:
            self._failed = True

    @staticmethod
    def _close_sockets(values: tuple[socket.socket, ...]) -> None:
        for value in values:
            try:
                value.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                value.close()
            except OSError:
                pass


__all__ = (
    "BrowserConnectProxy",
    "BrowserNativeTransportError",
    "HeadedDisplayLease",
    "acquire_headed_display",
    "xvfb_executable_available",
)
