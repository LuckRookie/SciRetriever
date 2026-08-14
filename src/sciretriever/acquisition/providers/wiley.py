"""Wiley Online Library TDM API primary-PDF download client."""

from __future__ import annotations

import threading
from contextlib import AbstractContextManager, closing
from io import BytesIO
from typing import BinaryIO, Final
from urllib.parse import urlsplit

from sciretriever.acquisition.authorized import (
    AuthorizedClientFailure,
    AuthorizedClientFailureKind,
    AuthorizedDownloadLocator,
    AuthorizedDownloadMiss,
    AuthorizedDownloadResult,
    AuthorizedEntitlement,
    AuthorizedEvidenceKind,
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

_ORIGIN: Final[str] = "https://api.wiley.com"
_ARTICLES_ROOT: Final[str] = f"{_ORIGIN}/onlinelibrary/tdm/v1/articles"
_CREDENTIAL_ORIGIN: Final[Origin] = Origin("https", "api.wiley.com", 443)
_WOL_ORIGIN: Final[str] = "https://onlinelibrary.wiley.com"
_ALM_HOST: Final[str] = "alm.wiley.com"
_ALM_DOWNLOAD_PREFIX: Final[tuple[str, ...]] = ("", "alm", "api", "v2", "download")
_MAX_PDF_BYTES: Final[int] = 64 * 1024 * 1024
_MAX_TOKEN_CHARS: Final[int] = 8_192
_MAX_ALM_LOCATOR_CHARS: Final[int] = 4_096

WILEY_ACCESS_SCOPE: Final[AccessScope] = AccessScope(provider_name="wiley", channel="api")
WILEY_ACCESS_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=3,
    min_start_interval=1.0 / 3.0,
    burst_limit=60,
    window_seconds=600.0,
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


def _response_feedback(response: TransportResponse) -> AccessFeedback | None:
    return AccessFeedback(throttled=True) if response.status == 429 else None


def _guard_alm_download_redirect(target_url: str) -> None:
    """Allow only Wiley's observed one-hop, token-free ALM download locator."""

    if type(target_url) is not str:
        raise ValueError("Wiley redirect target must be a string")
    try:
        parsed = urlsplit(target_url)
        port = parsed.port
    except (UnicodeError, ValueError):
        raise ValueError("Wiley redirect target is invalid") from None
    if (
        parsed.scheme.casefold() != "https"
        or parsed.hostname is None
        or parsed.hostname.casefold() != _ALM_HOST
        or port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Wiley redirect target is outside the ALM download endpoint")
    segments = tuple(parsed.path.split("/"))
    if len(segments) != len(_ALM_DOWNLOAD_PREFIX) + 1:
        raise ValueError("Wiley redirect target path is invalid")
    if segments[:-1] != _ALM_DOWNLOAD_PREFIX:
        raise ValueError("Wiley redirect target path is invalid")
    locator = segments[-1]
    if (
        not locator
        or len(locator) > _MAX_ALM_LOCATOR_CHARS
        or "\\" in locator
        or any(ord(character) < 32 or ord(character) == 127 for character in locator)
    ):
        raise ValueError("Wiley redirect locator is invalid")


def _locator_for(target: AuthorizedLookupTarget) -> AuthorizedDownloadLocator:
    if (
        target.evidence_kind is not AuthorizedEvidenceKind.DOI_LANDING_ORIGIN
        or target.namespace != "doi"
        or target.resolved_landing_origin != _WOL_ORIGIN
    ):
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    return AuthorizedDownloadLocator(
        namespace="wiley-tdm-pdf",
        value=target.value,
        declared_media_type="application/pdf",
        source_record_id=target.value,
    )


def _interpret_response(
    locator: AuthorizedDownloadLocator,
    response: TransportResponse,
) -> AuthorizedDownloadResult:
    if response.status == 404:
        return AuthorizedDownloadMiss(locator=locator, reason=AuthorizedNormalMiss.HTTP_404)
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
    content: TemporaryPdfContent = _MemoryPdfContent(response.body)
    return AuthorizedPdfDownload(
        locator=locator,
        content=content,
        media_type=_media_type(response.headers),
        # The final ALM URL is a short-lived opaque locator.  DOI provenance
        # already identifies the source record, so the signed path must not be
        # promoted into a persistent LiteratureAsset source URL.
        safe_source_url=None,
        entitlement=AuthorizedEntitlement.GRANTED,
    )


class WileyAuthorizedPdfClient:
    """Translate Wiley's DOI download endpoint into neutral decisions."""

    __slots__ = ("_cancel_event", "_http_client", "_tdm_api_token")

    def __init__(
        self,
        *,
        http_client: HttpClient,
        tdm_api_token: str,
        cancel_event: threading.Event | None = None,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if type(tdm_api_token) is not str:
            raise TypeError("tdm_api_token must be a string")
        token = tdm_api_token.strip()
        if (
            not token
            or len(token) > _MAX_TOKEN_CHARS
            or any(ord(character) < 32 or ord(character) == 127 for character in token)
        ):
            raise ValueError("tdm_api_token must be a safe nonblank token")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        self._http_client = http_client
        self._tdm_api_token = token
        self._cancel_event = cancel_event

    def __repr__(self) -> str:
        return "<WileyAuthorizedPdfClient>"

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
        if locator.namespace != "wiley-tdm-pdf":
            raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
        result = self._http_client.request(
            WILEY_ACCESS_SCOPE,
            _ARTICLES_ROOT,
            WILEY_ACCESS_POLICY,
            headers=(Header(name="Accept", value="application/pdf"),),
            credential_headers=(("Wiley-TDM-Client-Token", self._tdm_api_token),),
            credential_allowed_origins=(_CREDENTIAL_ORIGIN,),
            path_parameter=locator.value,
            max_response_bytes=_MAX_PDF_BYTES,
            max_redirects=1,
            cancel_event=self._cancel_event,
            response_feedback=_response_feedback,
            redirect_target_guard=_guard_alm_download_redirect,
            allow_guarded_redirect_encoded_path_separators=True,
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
    "WILEY_ACCESS_POLICY",
    "WILEY_ACCESS_SCOPE",
    "WileyAuthorizedPdfClient",
)
