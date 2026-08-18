"""Elsevier Article/Object Retrieval authorized primary-PDF client."""

from __future__ import annotations

import re
import threading
import time
import xml.etree.ElementTree as ET
from contextlib import AbstractContextManager, closing
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import BinaryIO, Final

from sciretriever.acquisition.authorized import (
    AuthorizedClientFailure,
    AuthorizedClientFailureKind,
    AuthorizedDownloadLocator,
    AuthorizedDownloadMiss,
    AuthorizedDownloadResult,
    AuthorizedEntitlement,
    AuthorizedEvidenceKind,
    AuthorizedLookupDownloads,
    AuthorizedLookupMiss,
    AuthorizedLookupResult,
    AuthorizedLookupTarget,
    AuthorizedNormalMiss,
    AuthorizedPdfDownload,
)
from sciretriever.acquisition.planning import AccessRouteHint, AccessRouteHintKind
from sciretriever.acquisition.ports import TemporaryPdfContent
from sciretriever.logging.api import get_logger
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.network.admission import AccessFeedback, AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import Origin
from sciretriever.network.response_feedback import (
    FeedbackHeaderError,
    header_value,
    nonnegative_integer_header,
    quota_reset_deadline,
    retry_after_feedback,
)

_ORIGIN: Final[str] = "https://api.elsevier.com"
_ARTICLE_ROOTS: Final[dict[str, str]] = {
    "doi": f"{_ORIGIN}/content/article/doi?view=FULL",
    "pii": f"{_ORIGIN}/content/article/pii?view=FULL",
    "elsevier-article-eid": f"{_ORIGIN}/content/article/eid?view=FULL",
}
_OBJECT_EID_ROOT: Final[str] = f"{_ORIGIN}/content/object/eid"
_DIRECT_PDF_NAMESPACES: Final[dict[str, str]] = {
    "elsevier-article-pdf-doi": "doi",
    "elsevier-article-pdf-pii": "pii",
    "elsevier-article-pdf-eid": "elsevier-article-eid",
}
_CREDENTIAL_ORIGIN: Final[Origin] = Origin("https", "api.elsevier.com", 443)
_SCIENCEDIRECT_ARTICLE_ROOT: Final[str] = "https://www.sciencedirect.com/science/article/pii"
_ROUTE_KEY: Final[str] = "api:elsevier-article-object"
_PROFILE_ACCESS_KEY: Final[str] = "elsevier-sciencedirect"
_MAX_LOOKUP_BYTES: Final[int] = 32 * 1024 * 1024
_MAX_PDF_BYTES: Final[int] = 64 * 1024 * 1024
_MAX_CREDENTIAL_CHARS: Final[int] = 8_192
_MAX_XML_ELEMENTS: Final[int] = 250_000
_PII: Final[re.Pattern[str]] = re.compile(r"^S[0-9X]{15,24}$", re.ASCII)
_DOI: Final[re.Pattern[str]] = re.compile(
    r"^10\.[0-9]{4,9}/[^\s?#]{1,512}$",
    re.ASCII | re.IGNORECASE,
)
_ARTICLE_EID: Final[re.Pattern[str]] = re.compile(
    r"^1-s2\.0-[A-Za-z0-9][A-Za-z0-9._-]{1,255}$",
    re.ASCII,
)
_PDF_OBJECT_EID: Final[re.Pattern[str]] = re.compile(
    r"^1-s2\.0-[A-Za-z0-9][A-Za-z0-9._-]{1,500}\.pdf$",
    re.ASCII,
)
_SUPPLEMENT_MARKERS: Final[tuple[str, ...]] = (
    "appendix",
    "graphical",
    "-mmc",
    "_mmc",
    "supplement",
    "supplementary",
)
_LOGGER = get_logger(__name__)

ELSEVIER_ARTICLE_ACCESS_SCOPE: Final[AccessScope] = AccessScope(
    provider_name="elsevier",
    channel="api",
    service_name="article-retrieval-object",
)
ELSEVIER_ARTICLE_ACCESS_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    min_start_interval=0.1,
    burst_limit=50_000,
    window_seconds=604_800.0,
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


@dataclass(frozen=True, slots=True)
class _ArticleObjects:
    article_eid: str | None
    pii: str | None
    main_pdf_eids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _ServiceErrorResponse:
    outcome: AuthorizedNormalMiss | AuthorizedClientFailureKind


class _ArticleShapeError(RuntimeError):
    __slots__ = ("category",)

    def __init__(self, category: str) -> None:
        if category not in {
            "conflicting-field",
            "malformed-xml",
            "response-too-complex",
            "unexpected-envelope",
            "unsafe-xml",
        }:
            raise ValueError("unsupported article response category")
        self.category = category
        super().__init__("Elsevier article response could not be interpreted")


def _failure(kind: AuthorizedClientFailureKind) -> AuthorizedClientFailure:
    return AuthorizedClientFailure(kind)


def _private_credential(value: object, *, field_name: str, required: bool) -> str | None:
    if value is None and not required:
        return None
    if type(value) is not str:
        raise TypeError(f"{field_name} must be a string" + (" or None" if not required else ""))
    candidate = value.strip()
    if (
        not candidate
        or len(candidate) > _MAX_CREDENTIAL_CHARS
        or any(ord(character) < 32 or ord(character) == 127 for character in candidate)
    ):
        raise ValueError(f"{field_name} must be a safe nonblank private value")
    return candidate


def _credential_headers(
    api_key: str,
    institution_token: str | None,
) -> tuple[tuple[str, str], ...]:
    values = [("X-ELS-APIKey", api_key)]
    if institution_token is not None:
        values.append(("X-ELS-Insttoken", institution_token))
    return tuple(values)


def _media_type(headers: tuple[Header, ...]) -> str | None:
    try:
        value = header_value(headers, "Content-Type")
    except FeedbackHeaderError:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA) from None
    if value is None:
        return None
    media_type = value.partition(";")[0].strip().casefold()
    if not media_type:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    return media_type


def _response_feedback(response: TransportResponse) -> AccessFeedback | None:
    try:
        wall_now = datetime.now(timezone.utc)
        standard = retry_after_feedback(
            response.status,
            response.headers,
            wall_now=wall_now,
        )
        remaining = nonnegative_integer_header(
            response.headers,
            "X-RateLimit-Remaining",
        )
        limit = nonnegative_integer_header(response.headers, "X-RateLimit-Limit")
        reset_at = quota_reset_deadline(
            header_value(response.headers, "X-RateLimit-Reset"),
            wall_now=wall_now,
            monotonic_now=time.monotonic(),
        )
    except FeedbackHeaderError:
        return _logged_feedback(AccessFeedback(throttled=True))
    throttled = response.status == 429 or remaining == 0
    if remaining is not None and reset_at is not None:
        if limit is not None and remaining > limit:
            return _logged_feedback(AccessFeedback(throttled=True))
        return _logged_feedback(
            AccessFeedback(
                retry_after=None if standard is None else standard.retry_after,
                quota_reset_at=reset_at,
                quota_remaining=remaining,
                quota_limit=limit,
                throttled=throttled,
            )
        )
    if standard is not None or throttled:
        return _logged_feedback(
            AccessFeedback(
                retry_after=None if standard is None else standard.retry_after,
                throttled=throttled,
            )
        )
    if response.status >= 500:
        return _logged_feedback(AccessFeedback(throttled=True))
    return None


def _logged_feedback(feedback: AccessFeedback) -> AccessFeedback:
    _LOGGER.debug(
        "event=authorized-quota-feedback provider_group=%s route_key=%s throttled=%s "
        "retry_after_seconds=%s quota_remaining=%s quota_limit=%s quota_reset=%s",
        ELSEVIER_ARTICLE_ACCESS_SCOPE.provider_name,
        _ROUTE_KEY,
        str(feedback.throttled).lower(),
        feedback.retry_after,
        feedback.quota_remaining,
        feedback.quota_limit,
        str(feedback.quota_reset_at is not None).lower(),
    )
    return feedback


def _elsevier_status(headers: tuple[Header, ...]) -> str | None:
    try:
        value = header_value(headers, "X-ELS-Status")
    except FeedbackHeaderError:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA) from None
    if value is None:
        return None
    return value.strip().casefold().replace("-", "_").replace(" ", "_")


def _status_failure(response: TransportResponse) -> AuthorizedClientFailure | None:
    status = _elsevier_status(response.headers)
    if status is not None:
        if "quota" in status:
            return _failure(AuthorizedClientFailureKind.QUOTA)
        if "not_entitled" in status or "authorization" in status:
            return _failure(AuthorizedClientFailureKind.ENTITLEMENT)
        if "authentication" in status or "invalid_api" in status:
            return _failure(AuthorizedClientFailureKind.AUTHENTICATION)
    kinds = {
        401: AuthorizedClientFailureKind.AUTHENTICATION,
        403: AuthorizedClientFailureKind.ENTITLEMENT,
        429: AuthorizedClientFailureKind.QUOTA,
    }
    if response.status in kinds:
        return _failure(kinds[response.status])
    if response.status >= 500:
        return _failure(AuthorizedClientFailureKind.SERVICE)
    if response.status != 200:
        return _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    return None


def _local_name(tag: object) -> str:
    if not isinstance(tag, str):
        raise _ArticleShapeError("malformed-xml")
    return tag.rsplit("}", 1)[-1].split(":", 1)[-1].casefold()


def _node_text(node: ET.Element) -> str:
    return " ".join(" ".join(node.itertext()).split())


def _single_child_text(node: ET.Element, name: str) -> str | None:
    values = tuple(
        _node_text(child) for child in node if _local_name(child.tag) == name and _node_text(child)
    )
    if not values:
        return None
    if any(value != values[0] for value in values[1:]):
        raise _ArticleShapeError("conflicting-field")
    return values[0]


def _first_matching_text(
    root: ET.Element,
    names: tuple[str, ...],
    pattern: re.Pattern[str],
) -> str | None:
    for name in names:
        for node in root.iter():
            if _local_name(node.tag) != name:
                continue
            value = _node_text(node)
            if pattern.fullmatch(value) is not None:
                return value
    return None


def _main_pdf_eids(root: ET.Element) -> tuple[str, ...]:
    result: list[str] = []
    for node in root.iter():
        if _local_name(node.tag) != "web-pdf":
            continue
        purpose = _single_child_text(node, "web-pdf-purpose")
        extension = _single_child_text(node, "extension")
        filename = _single_child_text(node, "filename")
        eid = _single_child_text(node, "attachment-eid")
        if (
            purpose is None
            or purpose.casefold() != "main"
            or extension is None
            or extension.casefold() != "pdf"
            or filename is None
            or not filename.casefold().endswith(".pdf")
            or eid is None
            or _PDF_OBJECT_EID.fullmatch(eid) is None
        ):
            continue
        identity = f"{eid} {filename}".casefold()
        if any(marker in identity for marker in _SUPPLEMENT_MARKERS):
            continue
        if eid not in result:
            result.append(eid)
    return tuple(result)


def _service_error_response(root: ET.Element) -> _ServiceErrorResponse:
    statuses = tuple(child for child in root if _local_name(child.tag) == "status")
    if len(statuses) != 1:
        raise _ArticleShapeError("unexpected-envelope")
    status_code = _single_child_text(statuses[0], "statuscode")
    if status_code is None:
        raise _ArticleShapeError("unexpected-envelope")
    normalized = status_code.strip().upper().replace("-", "_").replace(" ", "_")
    outcomes: Final[dict[str, AuthorizedNormalMiss | AuthorizedClientFailureKind]] = {
        "RESOURCE_NOT_FOUND": AuthorizedNormalMiss.HTTP_404,
        "AUTHENTICATION_ERROR": AuthorizedClientFailureKind.AUTHENTICATION,
        "INVALID_API_KEY": AuthorizedClientFailureKind.AUTHENTICATION,
        "INVALID_APIKEY": AuthorizedClientFailureKind.AUTHENTICATION,
        "AUTHORIZATION_ERROR": AuthorizedClientFailureKind.ENTITLEMENT,
        "ENTITLEMENT_ERROR": AuthorizedClientFailureKind.ENTITLEMENT,
        "NOT_ENTITLED": AuthorizedClientFailureKind.ENTITLEMENT,
        "QUOTA_EXCEEDED": AuthorizedClientFailureKind.QUOTA,
        "RATE_LIMIT_EXCEEDED": AuthorizedClientFailureKind.QUOTA,
        "SYSTEM_ERROR": AuthorizedClientFailureKind.SERVICE,
        "SERVICE_UNAVAILABLE": AuthorizedClientFailureKind.SERVICE,
        "INVALID_INPUT": AuthorizedClientFailureKind.RESPONSE_SCHEMA,
        "INVALID_REQUEST": AuthorizedClientFailureKind.RESPONSE_SCHEMA,
    }
    return _ServiceErrorResponse(
        outcome=outcomes.get(normalized, AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    )


def _parse_article_objects(
    payload: bytes,
) -> _ArticleObjects | _ServiceErrorResponse:
    if type(payload) is not bytes:
        raise TypeError("payload must be bytes")
    folded = payload.lower()
    if b"<!doctype" in folded or b"<!entity" in folded:
        raise _ArticleShapeError("unsafe-xml")
    try:
        root = ET.fromstring(payload)
    except (ET.ParseError, ValueError):
        raise _ArticleShapeError("malformed-xml") from None
    element_count = sum(1 for _node in root.iter())
    if element_count > _MAX_XML_ELEMENTS:
        raise _ArticleShapeError("response-too-complex")
    root_name = _local_name(root.tag)
    if root_name == "service-error":
        return _service_error_response(root)
    if root_name != "full-text-retrieval-response":
        raise _ArticleShapeError("unexpected-envelope")
    return _ArticleObjects(
        article_eid=_first_matching_text(root, ("eid",), _ARTICLE_EID),
        pii=_first_matching_text(root, ("pii-unformatted", "pii"), _PII),
        main_pdf_eids=_main_pdf_eids(root),
    )


def _lookup_request(target: AuthorizedLookupTarget) -> tuple[str, str]:
    if target.evidence_kind is AuthorizedEvidenceKind.DOI_LANDING_ORIGIN:
        if target.namespace != "doi" or target.confirmed_origin not in {
            "https://linkinghub.elsevier.com",
            "https://www.sciencedirect.com",
        }:
            raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
        return _ARTICLE_ROOTS["doi"], target.value
    if target.evidence_kind is not AuthorizedEvidenceKind.STABLE_PROVIDER_LOCATOR:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    if target.namespace == "pii" and _PII.fullmatch(target.value) is not None:
        return _ARTICLE_ROOTS["pii"], target.value
    if (
        target.namespace == "elsevier-article-eid"
        and _ARTICLE_EID.fullmatch(target.value) is not None
    ):
        return _ARTICLE_ROOTS["elsevier-article-eid"], target.value
    raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)


def _direct_pdf_locator(
    target: AuthorizedLookupTarget,
    objects: _ArticleObjects | None,
) -> AuthorizedDownloadLocator:
    _lookup_request(target)
    namespaces = {
        "doi": "elsevier-article-pdf-doi",
        "pii": "elsevier-article-pdf-pii",
        "elsevier-article-eid": "elsevier-article-pdf-eid",
    }
    namespace = namespaces.get(target.namespace)
    if namespace is None:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    source_record_id = target.value
    if objects is not None:
        source_record_id = objects.article_eid or objects.pii or source_record_id
    return AuthorizedDownloadLocator(
        namespace=namespace,
        value=target.value,
        declared_media_type="application/pdf",
        source_record_id=source_record_id,
    )


def _download_request(locator: AuthorizedDownloadLocator) -> tuple[str, str]:
    if (
        locator.namespace == "elsevier-main-pdf-object"
        and _PDF_OBJECT_EID.fullmatch(locator.value) is not None
    ):
        return _OBJECT_EID_ROOT, locator.value
    target_namespace = _DIRECT_PDF_NAMESPACES.get(locator.namespace)
    if target_namespace is None:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    valid = (
        _DOI.fullmatch(locator.value) is not None
        if target_namespace == "doi"
        else _PII.fullmatch(locator.value) is not None
        if target_namespace == "pii"
        else _ARTICLE_EID.fullmatch(locator.value) is not None
    )
    if not valid:
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA)
    return _ARTICLE_ROOTS[target_namespace], locator.value


def _representation(media_type: str | None) -> str:
    if media_type == "application/pdf":
        return "pdf"
    if media_type in {"application/xml", "text/xml"} or (
        media_type is not None and media_type.endswith("+xml")
    ):
        return "xml"
    if media_type == "application/json" or (
        media_type is not None and media_type.endswith("+json")
    ):
        return "json"
    if media_type in {"text/html", "application/xhtml+xml"}:
        return "html"
    if media_type is None:
        return "missing"
    return "other"


def _http_status_class(status: int) -> str:
    if 100 <= status < 200:
        return "informational"
    if status < 300:
        return "success"
    if status < 400:
        return "redirection"
    if status < 500:
        return "client-error"
    return "server-error"


def _log_response_classification(
    *,
    stage: str,
    http_status: int,
    representation: str,
    envelope: str,
    disposition: str,
    failure_kind: AuthorizedClientFailureKind | None = None,
) -> None:
    _LOGGER.debug(
        "event=elsevier-authorized-response-classified provider_group=elsevier "
        "route_key=%s stage=%s http_status=%d http_status_class=%s "
        "representation=%s envelope=%s disposition=%s failure_kind=%s",
        _ROUTE_KEY,
        stage,
        http_status,
        _http_status_class(http_status),
        representation,
        envelope,
        disposition,
        "-" if failure_kind is None else failure_kind.value,
    )


def _service_error_outcome(
    response: _ServiceErrorResponse,
    *,
    stage: str,
    http_status: int,
    representation: str,
) -> AuthorizedNormalMiss:
    outcome = response.outcome
    if isinstance(outcome, AuthorizedNormalMiss):
        _log_response_classification(
            stage=stage,
            http_status=http_status,
            representation=representation,
            envelope="service-error",
            disposition="miss",
        )
        return outcome
    _log_response_classification(
        stage=stage,
        http_status=http_status,
        representation=representation,
        envelope="service-error",
        disposition="failure",
        failure_kind=outcome,
    )
    raise _failure(outcome)


def _body_starts_with_xml(payload: bytes) -> bool:
    return payload[:1024].lstrip().startswith(b"<")


def _route_hints(
    target: AuthorizedLookupTarget,
    objects: _ArticleObjects,
) -> tuple[AccessRouteHint, ...]:
    pii = objects.pii or (target.value if target.namespace == "pii" else None)
    article_eid = objects.article_eid or (
        target.value if target.namespace == "elsevier-article-eid" else None
    )
    result: list[AccessRouteHint] = []
    if pii is not None:
        result.extend(
            (
                AccessRouteHint(
                    kind=AccessRouteHintKind.CANONICAL_LANDING,
                    value=f"{_SCIENCEDIRECT_ARTICLE_ROOT}/{pii}",
                    source_route_key=_ROUTE_KEY,
                    profile_access_key=_PROFILE_ACCESS_KEY,
                ),
                AccessRouteHint(
                    kind=AccessRouteHintKind.STABLE_ARTICLE_ID,
                    value=pii,
                    source_route_key=_ROUTE_KEY,
                    profile_access_key=_PROFILE_ACCESS_KEY,
                    namespace="pii",
                ),
            )
        )
    if article_eid is not None:
        result.append(
            AccessRouteHint(
                kind=AccessRouteHintKind.STABLE_ARTICLE_ID,
                value=article_eid,
                source_route_key=_ROUTE_KEY,
                profile_access_key=_PROFILE_ACCESS_KEY,
                namespace="elsevier-article-eid",
            )
        )
    return tuple(result)


def _direct_pdf_lookup(
    target: AuthorizedLookupTarget,
    *,
    objects: _ArticleObjects | None,
) -> AuthorizedLookupDownloads:
    return AuthorizedLookupDownloads(
        target=target,
        entitlement=AuthorizedEntitlement.UNKNOWN,
        downloads=(_direct_pdf_locator(target, objects),),
        hints=() if objects is None else _route_hints(target, objects),
    )


def _interpret_lookup_response(
    target: AuthorizedLookupTarget,
    response: TransportResponse,
) -> AuthorizedLookupResult:
    if response.status == 404:
        _log_response_classification(
            stage="lookup",
            http_status=response.status,
            representation="missing",
            envelope="http-not-found",
            disposition="miss",
        )
        return AuthorizedLookupMiss(target=target, reason=AuthorizedNormalMiss.HTTP_404)
    failure = _status_failure(response)
    if failure is not None:
        _log_response_classification(
            stage="lookup",
            http_status=response.status,
            representation="missing",
            envelope="http-status",
            disposition="failure",
            failure_kind=failure.kind,
        )
        raise failure
    try:
        media_type = _media_type(response.headers)
    except AuthorizedClientFailure as error:
        _log_response_classification(
            stage="lookup",
            http_status=response.status,
            representation="missing",
            envelope="conflicting-content-type",
            disposition="fallback-direct-pdf",
            failure_kind=error.kind,
        )
        return _direct_pdf_lookup(target, objects=None)
    representation = _representation(media_type)
    if representation != "xml":
        _log_response_classification(
            stage="lookup",
            http_status=response.status,
            representation=representation,
            envelope="non-xml-representation",
            disposition="fallback-direct-pdf",
        )
        return _direct_pdf_lookup(target, objects=None)
    return _interpret_lookup_xml(
        target,
        response.body,
        http_status=response.status,
        representation=representation,
    )


def _interpret_lookup_xml(
    target: AuthorizedLookupTarget,
    payload: bytes,
    *,
    http_status: int,
    representation: str,
) -> AuthorizedLookupResult:
    try:
        parsed = _parse_article_objects(payload)
    except _ArticleShapeError as error:
        _log_response_classification(
            stage="lookup",
            http_status=http_status,
            representation=representation,
            envelope=error.category,
            disposition="fallback-direct-pdf",
        )
        return _direct_pdf_lookup(target, objects=None)
    if isinstance(parsed, _ServiceErrorResponse):
        miss = _service_error_outcome(
            parsed,
            stage="lookup",
            http_status=http_status,
            representation=representation,
        )
        return AuthorizedLookupMiss(target=target, reason=miss)
    objects = parsed
    if not objects.main_pdf_eids:
        _log_response_classification(
            stage="lookup",
            http_status=http_status,
            representation=representation,
            envelope="full-text-no-main-object",
            disposition="fallback-direct-pdf",
        )
        return _direct_pdf_lookup(target, objects=objects)
    _log_response_classification(
        stage="lookup",
        http_status=http_status,
        representation=representation,
        envelope="full-text-main-object",
        disposition="object-locators",
    )
    source_record_id = objects.article_eid or objects.pii or target.value
    return AuthorizedLookupDownloads(
        target=target,
        entitlement=AuthorizedEntitlement.UNKNOWN,
        downloads=tuple(
            AuthorizedDownloadLocator(
                namespace="elsevier-main-pdf-object",
                value=eid,
                declared_media_type="application/pdf",
                source_record_id=source_record_id,
            )
            for eid in objects.main_pdf_eids
        ),
        hints=_route_hints(target, objects),
    )


def _interpret_xml_download(
    locator: AuthorizedDownloadLocator,
    payload: bytes,
    *,
    http_status: int,
    representation: str,
) -> AuthorizedDownloadResult:
    try:
        parsed = _parse_article_objects(payload)
    except _ArticleShapeError as error:
        _log_response_classification(
            stage="download",
            http_status=http_status,
            representation=representation,
            envelope=error.category,
            disposition="failure",
            failure_kind=AuthorizedClientFailureKind.RESPONSE_SCHEMA,
        )
        raise _failure(AuthorizedClientFailureKind.RESPONSE_SCHEMA) from None
    if isinstance(parsed, _ServiceErrorResponse):
        miss = _service_error_outcome(
            parsed,
            stage="download",
            http_status=http_status,
            representation=representation,
        )
        return AuthorizedDownloadMiss(locator=locator, reason=miss)
    _log_response_classification(
        stage="download",
        http_status=http_status,
        representation=representation,
        envelope="full-text-xml",
        disposition="failure",
        failure_kind=AuthorizedClientFailureKind.NON_PDF_PRODUCT,
    )
    raise _failure(AuthorizedClientFailureKind.NON_PDF_PRODUCT)


def _interpret_download_response(
    locator: AuthorizedDownloadLocator,
    response: TransportResponse,
) -> AuthorizedDownloadResult:
    if response.status == 404:
        _log_response_classification(
            stage="download",
            http_status=response.status,
            representation="missing",
            envelope="http-not-found",
            disposition="miss",
        )
        return AuthorizedDownloadMiss(locator=locator, reason=AuthorizedNormalMiss.HTTP_404)
    failure = _status_failure(response)
    if failure is not None:
        _log_response_classification(
            stage="download",
            http_status=response.status,
            representation="missing",
            envelope="http-status",
            disposition="failure",
            failure_kind=failure.kind,
        )
        raise failure
    try:
        media_type = _media_type(response.headers)
    except AuthorizedClientFailure as error:
        _log_response_classification(
            stage="download",
            http_status=response.status,
            representation="missing",
            envelope="conflicting-content-type",
            disposition="failure",
            failure_kind=error.kind,
        )
        raise
    representation = _representation(media_type)
    if representation == "xml" or (
        representation == "pdf" and _body_starts_with_xml(response.body)
    ):
        return _interpret_xml_download(
            locator,
            response.body,
            http_status=response.status,
            representation=representation,
        )
    if representation != "pdf":
        kind = (
            AuthorizedClientFailureKind.NON_PDF_PRODUCT
            if representation in {"html", "json"}
            else AuthorizedClientFailureKind.AMBIGUOUS_PRIMARY_PDF
        )
        _log_response_classification(
            stage="download",
            http_status=response.status,
            representation=representation,
            envelope="non-pdf-representation",
            disposition="failure",
            failure_kind=kind,
        )
        raise _failure(kind)
    _log_response_classification(
        stage="download",
        http_status=response.status,
        representation=representation,
        envelope="pdf",
        disposition="candidate",
    )
    content: TemporaryPdfContent = _MemoryPdfContent(response.body)
    return AuthorizedPdfDownload(
        locator=locator,
        content=content,
        media_type=media_type,
        safe_source_url=response.final_url,
        entitlement=AuthorizedEntitlement.GRANTED,
    )


class ElsevierAuthorizedPdfClient:
    """Translate FULL article XML and MAIN object EIDs into neutral PDF decisions."""

    __slots__ = ("_api_key", "_cancel_event", "_http_client", "_institution_token")

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str,
        institution_token: str | None = None,
        cancel_event: threading.Event | None = None,
    ) -> None:
        if not isinstance(http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        private_key = _private_credential(api_key, field_name="api_key", required=True)
        if private_key is None:
            raise ValueError("api_key must be configured")
        self._http_client = http_client
        self._api_key = private_key
        self._institution_token = _private_credential(
            institution_token,
            field_name="institution_token",
            required=False,
        )
        self._cancel_event = cancel_event

    def __repr__(self) -> str:
        return "<ElsevierAuthorizedPdfClient>"

    def lookup(self, target: AuthorizedLookupTarget) -> AuthorizedLookupResult:
        if not isinstance(target, AuthorizedLookupTarget):
            raise TypeError("target must be an AuthorizedLookupTarget")
        endpoint, path_parameter = _lookup_request(target)
        result = self._http_client.request(
            ELSEVIER_ARTICLE_ACCESS_SCOPE,
            endpoint,
            ELSEVIER_ARTICLE_ACCESS_POLICY,
            headers=(Header(name="Accept", value="application/xml"),),
            credential_headers=_credential_headers(
                self._api_key,
                self._institution_token,
            ),
            credential_allowed_origins=(_CREDENTIAL_ORIGIN,),
            path_parameter=path_parameter,
            max_response_bytes=_MAX_LOOKUP_BYTES,
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
        return _interpret_lookup_response(target, result)

    def download(self, locator: AuthorizedDownloadLocator) -> AuthorizedDownloadResult:
        if not isinstance(locator, AuthorizedDownloadLocator):
            raise TypeError("locator must be an AuthorizedDownloadLocator")
        endpoint, path_parameter = _download_request(locator)
        result = self._http_client.request(
            ELSEVIER_ARTICLE_ACCESS_SCOPE,
            endpoint,
            ELSEVIER_ARTICLE_ACCESS_POLICY,
            headers=(Header(name="Accept", value="application/pdf"),),
            credential_headers=_credential_headers(
                self._api_key,
                self._institution_token,
            ),
            credential_allowed_origins=(_CREDENTIAL_ORIGIN,),
            path_parameter=path_parameter,
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
        return _interpret_download_response(locator, result)


__all__ = (
    "ELSEVIER_ARTICLE_ACCESS_POLICY",
    "ELSEVIER_ARTICLE_ACCESS_SCOPE",
    "ElsevierAuthorizedPdfClient",
)
