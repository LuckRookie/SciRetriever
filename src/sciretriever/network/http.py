"""Canonical bounded HTTP response and standard-library request transport."""

from __future__ import annotations

from dataclasses import dataclass
from email.message import Message
from typing import ContextManager, Iterator, Mapping, Protocol, Sequence
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
QueryValue = str | int | float | bool | None
QueryParams = Mapping[str, QueryValue | Sequence[QueryValue]] | Sequence[tuple[str, QueryValue]]


class ResponseTooLargeError(OSError):
    def __init__(self, max_response_bytes: int) -> None:
        super().__init__(f"HTTP response exceeds {max_response_bytes} byte limit")
        self.max_response_bytes = max_response_bytes


class Headers(Mapping[str, str]):
    """Case-insensitive immutable headers retaining duplicate field values."""

    def __init__(self, values: Mapping[str, str] | Sequence[tuple[str, str]]) -> None:
        self._items = tuple(values.items()) if isinstance(values, Mapping) else tuple(values)
        self._normalized = {
            name.lower(): ", ".join(value for key, value in self._items if key.lower() == name.lower())
            for name, _ in self._items
        }

    def __getitem__(self, key: str) -> str:
        return self._normalized[key.lower()]

    def __iter__(self) -> Iterator[str]:
        return iter(self._normalized)

    def __len__(self) -> int:
        return len(self._normalized)

    def items_all(self) -> tuple[tuple[str, str], ...]:
        return self._items


@dataclass(frozen=True, slots=True, init=False)
class HttpResponse:
    status: int
    headers: Headers
    body: bytes
    url: str

    def __init__(self, status: int, second: object, third: object, fourth: object) -> None:
        # Discovery historically used status, headers, body, url; Acquisition used
        # status, url, headers, body. Accept both while exposing one concrete model.
        if isinstance(second, str):
            url, headers, body = second, third, fourth
        else:
            headers, body, url = second, third, fourth
        if not isinstance(status, int) or isinstance(status, bool):
            raise TypeError("HTTP status must be an integer")
        if not isinstance(url, str) or not isinstance(body, bytes):
            raise TypeError("HTTP response URL/body have invalid types")
        if not isinstance(headers, (Mapping, tuple, list)):
            raise TypeError("HTTP response headers have an invalid type")
        object.__setattr__(self, "status", status)
        object.__setattr__(self, "headers", Headers(headers))
        object.__setattr__(self, "body", body)
        object.__setattr__(self, "url", url)

    def header(self, name: str) -> str | None:
        return self.headers.get(name)


class Transport(Protocol):
    def get(self, url: str, *, params: QueryParams | None = None,
            headers: Mapping[str, str] | None = None,
            timeout: float | None = None) -> HttpResponse: ...


class _ReadableResponse(Protocol):
    headers: Message
    status: int
    def read(self, amount: int = -1) -> bytes: ...
    def geturl(self) -> str: ...


class OpenUrl(Protocol):
    def __call__(self, request: Request, *, timeout: float | None = None) -> ContextManager[_ReadableResponse]: ...


def _open(request: Request, *, timeout: float | None = None) -> ContextManager[_ReadableResponse]:
    return urlopen(request) if timeout is None else urlopen(request, timeout=timeout)


def url_with_params(url: str, params: QueryParams | None) -> str:
    if not params:
        return url
    split = urlsplit(url)
    query = parse_qsl(split.query, keep_blank_values=True)
    encoded = urlencode(params, doseq=isinstance(params, Mapping))
    query.extend(parse_qsl(encoded, keep_blank_values=True))
    return urlunsplit((split.scheme, split.netloc, split.path, urlencode(query), split.fragment))


class UrllibTransport:
    """Bounded urllib transport for fixed, trusted metadata API endpoints."""

    def __init__(self, *, opener: OpenUrl | None = None,
                 max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES) -> None:
        if not isinstance(max_response_bytes, int) or isinstance(max_response_bytes, bool):
            raise TypeError("max_response_bytes must be an integer")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be greater than zero")
        self._opener = opener or _open
        self._max_response_bytes = max_response_bytes

    def get(self, url: str, *, params: QueryParams | None = None,
            headers: Mapping[str, str] | None = None,
            timeout: float | None = None) -> HttpResponse:
        if urlsplit(url).scheme.lower() != "https":
            raise ValueError("HTTP requests must use HTTPS")
        request = Request(url_with_params(url, params), headers=dict(headers or {}), method="GET")
        with self._opener(request, timeout=timeout) as response:
            body = response.read(self._max_response_bytes + 1)
            if len(body) > self._max_response_bytes:
                raise ResponseTooLargeError(self._max_response_bytes)
            return HttpResponse(response.status, tuple(response.headers.items()), body, response.geturl())
