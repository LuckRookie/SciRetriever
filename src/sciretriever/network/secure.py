"""Bounded pinned-IP HTTPS transport with redirect policy enforcement."""

from __future__ import annotations

import http.client
import socket
import ssl
from types import MappingProxyType
from typing import Callable, Mapping, Protocol
from urllib.parse import urljoin, urlsplit, urlunsplit

from sciretriever.network.http import HttpResponse, QueryParams, url_with_params
from sciretriever.network.policy import NetworkPolicyError, UrlPolicy

NetworkError = NetworkPolicyError


MAX_RESPONSE_BYTES = 100 * 1024 * 1024
MAX_ERROR_BODY_BYTES = 64 * 1024
READ_CHUNK_SIZE = 64 * 1024
MAX_REDIRECTS = 5
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_SENSITIVE_HEADER_NAMES = frozenset({"authorization", "proxy-authorization", "cookie", "cookie2"})


def _sensitive_header(name: str) -> bool:
    lowered = name.lower()
    compact = lowered.replace("-", "").replace("_", "")
    return (
        lowered in _SENSITIVE_HEADER_NAMES
        or "apikey" in compact
        or compact.endswith("token")
        or compact.startswith("xels")
    )


def _without_sensitive_headers(headers: Mapping[str, str]) -> Mapping[str, str]:
    return MappingProxyType({key: value for key, value in headers.items() if not _sensitive_header(key)})


def _content_length(headers: Mapping[str, str]) -> int | None:
    value = next((value for key, value in headers.items() if key.lower() == "content-length"), None)
    if value is None:
        return None
    try:
        length = int(value)
    except ValueError as error:
        raise NetworkError("invalid HTTP Content-Length") from error
    if length < 0:
        raise NetworkError("invalid HTTP Content-Length")
    return length


class _Readable(Protocol):
    def read(self, n: int = -1) -> bytes: ...


def _read_bounded(stream: _Readable, headers: Mapping[str, str], max_bytes: int) -> bytes:
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    declared = _content_length(headers)
    if declared is not None and declared > max_bytes:
        raise NetworkError(f"HTTP response exceeds {max_bytes} bytes")
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = stream.read(min(READ_CHUNK_SIZE, max_bytes - size + 1))
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > max_bytes:
            raise NetworkError(f"HTTP response exceeds {max_bytes} bytes")
        chunks.append(chunk)


class DialResponse(Protocol):
    status: int

    def getheaders(self) -> list[tuple[str, str]]: ...

    def read(self, n: int = -1) -> bytes: ...

    def close(self) -> None: ...


class HttpsDialer(Protocol):
    def get(
        self,
        hostname: str,
        address: str,
        port: int,
        target: str,
        *,
        timeout: float,
        headers: Mapping[str, str],
    ) -> DialResponse: ...


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, address: str, port: int, timeout: float) -> None:
        context = ssl.create_default_context()
        super().__init__(hostname, port=port, timeout=timeout, context=context)
        self._address = address
        self._tls_context = context

    def connect(self) -> None:
        raw_socket = socket.create_connection((self._address, self.port), self.timeout)
        try:
            self.sock = self._tls_context.wrap_socket(raw_socket, server_hostname=self.host)
        except Exception:
            raw_socket.close()
            raise


class _ConnectionResponse:
    def __init__(self, connection: _PinnedHTTPSConnection, response: http.client.HTTPResponse) -> None:
        self._connection = connection
        self._response = response
        self.status = response.status

    def getheaders(self) -> list[tuple[str, str]]:
        return self._response.getheaders()

    def read(self, n: int = -1) -> bytes:
        return self._response.read(n)

    def close(self) -> None:
        try:
            self._response.close()
        finally:
            self._connection.close()


class PinnedHttpsDialer:
    """Connect to a validated IP while verifying TLS for the original hostname."""

    def get(
        self,
        hostname: str,
        address: str,
        port: int,
        target: str,
        *,
        timeout: float,
        headers: Mapping[str, str],
    ) -> DialResponse:
        connection = _PinnedHTTPSConnection(hostname, address, port, timeout)
        try:
            connection.request("GET", target, headers=dict(headers))
            return _ConnectionResponse(connection, connection.getresponse())
        except Exception:
            connection.close()
            raise


def _system_resolver(hostname: str) -> tuple[str, ...]:
    return tuple(sorted({str(item[4][0]) for item in socket.getaddrinfo(hostname, 443)}))


class SecureHttpsTransport:
    """Pinned HTTPS transport for policy-controlled external URLs."""

    def __init__(
        self,
        policy: UrlPolicy | None = None,
        *,
        max_bytes: int = MAX_RESPONSE_BYTES,
        max_redirects: int = MAX_REDIRECTS,
        default_timeout: float = 30.0,
        resolver: Callable[[str], tuple[str, ...]] = _system_resolver,
        dialer: HttpsDialer | None = None,
    ) -> None:
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
            raise ValueError("max_bytes must be a positive integer")
        if not isinstance(max_redirects, int) or isinstance(max_redirects, bool) or max_redirects < 0:
            raise ValueError("max_redirects must be a nonnegative integer")
        if default_timeout <= 0:
            raise ValueError("default_timeout must be positive")
        self.policy = policy or UrlPolicy()
        self.max_bytes = max_bytes
        self.max_redirects = max_redirects
        self.default_timeout = default_timeout
        self._resolver = resolver
        self._dialer = dialer or PinnedHttpsDialer()

    def resolve_host(self, hostname: str) -> tuple[str, ...]:
        return self._resolver(hostname)

    @staticmethod
    def _request_target(url: str) -> str:
        parsed = urlsplit(url)
        return urlunsplit(("", "", parsed.path or "/", parsed.query, ""))

    @staticmethod
    def _headers(values: Mapping[str, str] | None) -> Mapping[str, str]:
        normalized = {"User-Agent": "SciRetriever/2"}
        for key, value in (values or {}).items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise TypeError("HTTP headers must map strings to strings")
            if not key or any(char in key for char in "\r\n:") or any(char in value for char in "\r\n"):
                raise NetworkError("invalid HTTP request header")
            if key.lower() == "host":
                raise NetworkError("Host header is controlled by the pinned transport")
            normalized[key] = value
        return MappingProxyType(normalized)

    def get(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        current = url_with_params(url, params)
        request_timeout = self.default_timeout if timeout is None else timeout
        request_headers = self._headers(headers)
        for redirect_count in range(self.max_redirects + 1):
            parsed = urlsplit(current)
            hostname = parsed.hostname or ""
            addresses = self.resolve_host(hostname)
            self.policy.validate(current, addresses)
            response = None
            try:
                response = self._dialer.get(
                    hostname,
                    addresses[0],
                    parsed.port or 443,
                    self._request_target(current),
                    timeout=request_timeout,
                    headers=request_headers,
                )
                headers = {key.lower(): value for key, value in response.getheaders()}
                if response.status in REDIRECT_STATUSES:
                    location = headers.get("location")
                    if not location:
                        raise NetworkError("redirect response is missing Location")
                    if redirect_count >= self.max_redirects:
                        raise NetworkError("HTTP redirect limit exceeded")
                    redirected = urljoin(current, location)
                    redirect_parts = urlsplit(redirected)
                    current_origin = (parsed.hostname, parsed.port or 443)
                    redirect_origin = (redirect_parts.hostname, redirect_parts.port or 443)
                    if redirect_origin != current_origin:
                        request_headers = _without_sensitive_headers(request_headers)
                    current = redirected
                    continue
                success = 200 <= response.status < 300
                limit = self.max_bytes if success else MAX_ERROR_BODY_BYTES
                try:
                    body = _read_bounded(response, headers, limit)
                except NetworkError:
                    if success:
                        raise
                    body = b""
                return HttpResponse(
                    response.status,
                    current,
                    headers,
                    body,
                )
            except (http.client.HTTPException, OSError, ssl.SSLError) as error:
                raise NetworkError(f"HTTP transport failed: {error}") from error
            finally:
                if response is not None:
                    response.close()
        raise NetworkError("HTTP redirect limit exceeded")


__all__ = (
    "MAX_REDIRECTS",
    "MAX_RESPONSE_BYTES",
    "PinnedHttpsDialer",
    "SecureHttpsTransport",
)
