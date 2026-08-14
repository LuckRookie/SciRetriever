"""CORE API v3 registered-user primary-PDF download client."""

from __future__ import annotations

import re
import threading
from contextlib import AbstractContextManager, closing
from io import BytesIO
from typing import BinaryIO, Final

from sciretriever.acquisition.authorized import (
    AuthorizedClientFailure,
    AuthorizedClientFailureKind,
    AuthorizedDownloadLocator,
    AuthorizedDownloadMiss,
    AuthorizedDownloadResult,
    AuthorizedEntitlement,
    AuthorizedLookupDownloads,
    AuthorizedLookupResult,
    AuthorizedLookupTarget,
    AuthorizedNormalMiss,
    AuthorizedPdfDownload,
)
from sciretriever.acquisition.ports import TemporaryPdfContent
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.network.admission import AccessFeedback, AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import Origin

_ORIGIN: Final[str] = "https://api.core.ac.uk"
_V3_ROOT: Final[str] = f"{_ORIGIN}/v3"
_CREDENTIAL_ORIGIN: Final[Origin] = Origin("https", "api.core.ac.uk", 443)
_MAX_PDF_BYTES: Final[int] = 64 * 1024 * 1024
_IDENTIFIER: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9._-]+", re.ASCII)

# CORE's token allowance is shared across metadata and PDF operations.  These
# values intentionally match the anonymous safety floor used by its Metadata
# adapter; an account may have a larger allowance, but local policy never
# assumes that larger entitlement.
CORE_ACCESS_SCOPE: Final[AccessScope] = AccessScope(provider_name="core", channel="api")
CORE_ACCESS_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    min_start_interval=6.0,
    burst_limit=10,
    window_seconds=60.0,
)


class _MemoryPdfContent:
    """Bounded response bytes with deterministic idempotent cleanup."""

    __slots__ = ("_lock", "_payload")

    def __init__(self, payload: bytes) -> None:
        if type(payload) is not bytes:
            raise TypeError("payload must be bytes")
        self._payload: bytes | None = payload
        self._lock = threading.Lock()

    def open(self) -> AbstractContextManager[BinaryIO]:
        with self._lock:
            payload = self._payload
        if payload is None:
            raise RuntimeError("temporary PDF content is closed")
        return closing(BytesIO(payload))

    def discard(self) -> None:
        with self._lock:
            self._payload = None


def _failure(kind: AuthorizedClientFailureKind) -> AuthorizedClientFailure:
    return AuthorizedClientFailure(kind)


def _locator_for(target: AuthorizedLookupTarget) -> AuthorizedDownloadLocator:
    namespaces = {
        "core-work": ("works", "core-work-pdf", "work"),
        "core-output": ("outputs", "core-output-pdf", "output"),
    }
    selected = namespaces.get(target.namespace)
    if selected is None or _IDENTIFIER.fullmatch(target.value) is None:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    _entity, locator_namespace, record_kind = selected
    return AuthorizedDownloadLocator(
        namespace=locator_namespace,
        value=target.value,
        declared_media_type="application/pdf",
        source_record_id=f"{record_kind}:{target.value}",
    )


def _media_type(headers: tuple[Header, ...]) -> str | None:
    values = [
        header.value.partition(";")[0].strip().casefold()
        for header in headers
        if header.name.casefold() == "content-type"
    ]
    if not values:
        return None
    if not values[0] or any(value != values[0] for value in values[1:]):
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    return values[0]


def _normal_miss(
    locator: AuthorizedDownloadLocator,
    status: int,
) -> AuthorizedDownloadMiss:
    reasons = {
        204: AuthorizedNormalMiss.HTTP_204,
        404: AuthorizedNormalMiss.HTTP_404,
        410: AuthorizedNormalMiss.HTTP_410,
    }
    return AuthorizedDownloadMiss(locator=locator, reason=reasons[status])


def _response_feedback(response: TransportResponse) -> AccessFeedback | None:
    if response.status == 429:
        return AccessFeedback(throttled=True)
    if response.status >= 500:
        return AccessFeedback(throttled=True)
    return None


def _successful_download(
    locator: AuthorizedDownloadLocator,
    response: TransportResponse,
) -> AuthorizedPdfDownload:
    content: TemporaryPdfContent = _MemoryPdfContent(response.body)
    return AuthorizedPdfDownload(
        locator=locator,
        content=content,
        media_type=_media_type(response.headers),
        safe_source_url=response.final_url,
        entitlement=AuthorizedEntitlement.GRANTED,
    )


def _interpret_response(
    locator: AuthorizedDownloadLocator,
    response: TransportResponse,
) -> AuthorizedDownloadResult:
    if response.status in {204, 404, 410}:
        return _normal_miss(locator, response.status)
    failures = {
        401: AuthorizedClientFailureKind.AUTHENTICATION,
        403: AuthorizedClientFailureKind.ENTITLEMENT,
        429: AuthorizedClientFailureKind.QUOTA,
    }
    if response.status in failures:
        raise _failure(failures[response.status])
    if response.status >= 500:
        raise _failure(AuthorizedClientFailureKind.SERVICE)
    if response.status != 200:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    return _successful_download(locator, response)


class CoreAuthorizedPdfClient:
    """Translate CORE's registered-key download endpoint into neutral decisions."""

    __slots__ = ("_api_key", "_cancel_event", "_http_client")

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str,
        cancel_event: threading.Event | None = None,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if type(api_key) is not str or not api_key.strip():
            raise ValueError("api_key must be nonblank")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        self._http_client = http_client
        self._api_key = api_key.strip()
        self._cancel_event = cancel_event

    def __repr__(self) -> str:
        return "<CoreAuthorizedPdfClient>"

    def lookup(self, target: AuthorizedLookupTarget) -> AuthorizedLookupResult:
        if not isinstance(target, AuthorizedLookupTarget):
            raise TypeError("target must be an AuthorizedLookupTarget")
        locator = _locator_for(target)
        return AuthorizedLookupDownloads(
            target=target,
            entitlement=AuthorizedEntitlement.UNKNOWN,
            downloads=(locator,),
        )

    def download(self, locator: AuthorizedDownloadLocator) -> AuthorizedDownloadResult:
        if not isinstance(locator, AuthorizedDownloadLocator):
            raise TypeError("locator must be an AuthorizedDownloadLocator")
        entities = {
            "core-work-pdf": "works",
            "core-output-pdf": "outputs",
        }
        entity = entities.get(locator.namespace)
        if entity is None or _IDENTIFIER.fullmatch(locator.value) is None:
            raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
        result = self._http_client.request(
            CORE_ACCESS_SCOPE,
            f"{_V3_ROOT}/{entity}",
            CORE_ACCESS_POLICY,
            headers=(Header(name="Accept", value="application/pdf"),),
            credential_headers=(("Authorization", f"Bearer {self._api_key}"),),
            credential_allowed_origins=(_CREDENTIAL_ORIGIN,),
            path_parameter=locator.value,
            path_parameter_suffix="download",
            max_response_bytes=_MAX_PDF_BYTES,
            max_redirects=0,
            cancel_event=self._cancel_event,
            response_feedback=_response_feedback,
        )
        if isinstance(result, AccessFailure):
            kind = (
                AuthorizedClientFailureKind.CANCELLED
                if result.code == "cancelled"
                else AuthorizedClientFailureKind.ACCESS
            )
            raise _failure(kind)
        if not isinstance(result, TransportResponse):
            raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
        return _interpret_response(locator, result)


__all__ = (
    "CORE_ACCESS_POLICY",
    "CORE_ACCESS_SCOPE",
    "CoreAuthorizedPdfClient",
)
