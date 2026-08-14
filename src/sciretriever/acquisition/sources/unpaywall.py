"""Public Unpaywall DOI lookup for ordered OA PDF and landing locators."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import unicodedata
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import NoReturn, Protocol, cast

from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.ports import (
    AcquisitionFailure,
    AcquisitionSourceFailure,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.routes import RouteExecutionContext, delivery_results
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.acquisition import AcquisitionPath
from sciretriever.model.literature import Identifier
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import AccessFeedback, AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import Origin, PolicyError, normalize_url

_PROVIDER_NAME = "unpaywall"
_ENDPOINT = "https://api.unpaywall.org/v2"
_API_ORIGIN = Origin("https", "api.unpaywall.org", 443)
_MAX_RESPONSE_BYTES = 2_097_152
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", re.ASCII)
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")

ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    burst_limit=100_000,
    window_seconds=86_400.0,
)


class PublicLocatorFetcher(Protocol):
    """The package-internal A5 handoff used by public protocol Sources."""

    def acquire(
        self,
        *,
        locator: str,
        candidate_key: str,
        source_name: str,
        source_record_id: str | None,
        declared_media_type: str | None,
        candidate_keys: CandidateKeyTracker,
        allow_static_landing_discovery: bool,
    ) -> Iterable[TemporaryPdf]: ...


class _DuplicateJsonKey(ValueError):
    pass


class _InvalidJsonConstant(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class _LocatorTask:
    locator: str
    declared_media_type: str | None
    allow_static_landing_discovery: bool


class UnpaywallPdfSource:
    """Resolve canonical DOIs through Unpaywall without exposing contact email."""

    source_name = _PROVIDER_NAME
    acquisition_path = AcquisitionPath.PUBLIC
    route_key = "public:unpaywall"

    def __init__(
        self,
        *,
        http_client: HttpClient,
        access_scope: AccessScope,
        access_policy: AccessPolicy,
        locator_fetcher: PublicLocatorFetcher,
        contact_email: str,
        cancel_event: threading.Event | None = None,
    ) -> None:
        _validate_dependencies(
            http_client=http_client,
            access_scope=access_scope,
            access_policy=access_policy,
            locator_fetcher=locator_fetcher,
            cancel_event=cancel_event,
        )
        self._contact_email = _contact_email(contact_email)
        self._http_client = http_client
        self._access_scope = access_scope
        self._access_policy = AccessPolicy.strictest(BASELINE_ACCESS_POLICY, access_policy)
        self._locator_fetcher = locator_fetcher
        self._cancel_event = cancel_event

    def __repr__(self) -> str:
        return "<UnpaywallPdfSource ready=True>"

    def execute(self, context: RouteExecutionContext) -> Iterable[RouteExecutionResult]:
        if not isinstance(context, RouteExecutionContext):
            raise TypeError("context must be RouteExecutionContext")
        return delivery_results(
            self._deliveries(context.request, context.evidence, context.candidate_keys)
        )

    def _deliveries(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        _validate_acquire_inputs(request, evidence, candidate_keys)
        first_failure: AcquisitionSourceFailure | None = None
        for doi in _doi_tasks(evidence):
            try:
                lookup_key = f"unpaywall/public/lookup/{doi}"
                if not candidate_keys.claim(lookup_key):
                    continue
                response = self._lookup(doi)
                if response is None:
                    continue
                tasks = _locator_tasks(response.body, expected_doi=doi)
            except AcquisitionSourceFailure as error:
                if first_failure is None:
                    first_failure = error
                continue
            for task in tasks:
                digest = hashlib.sha256(task.locator.encode("utf-8")).hexdigest()
                kind = "pdf" if task.declared_media_type is not None else "landing"
                try:
                    deliveries = self._locator_fetcher.acquire(
                        locator=task.locator,
                        candidate_key=f"unpaywall/public/{kind}/{digest}",
                        source_name=self.source_name,
                        source_record_id=doi,
                        declared_media_type=task.declared_media_type,
                        candidate_keys=candidate_keys,
                        allow_static_landing_discovery=task.allow_static_landing_discovery,
                    )
                    yield from _yield_and_close(deliveries)
                except AcquisitionSourceFailure as error:
                    if first_failure is None:
                        first_failure = error
        if first_failure is not None:
            raise first_failure

    def _lookup(self, doi: str) -> TransportResponse | None:
        result = self._http_client.request(
            self._access_scope,
            _ENDPOINT,
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
            credential_query={"email": self._contact_email},
            credential_allowed_origins=(_API_ORIGIN,),
            path_parameter=doi,
            max_response_bytes=_MAX_RESPONSE_BYTES,
            max_redirects=0,
            cancel_event=self._cancel_event,
            response_feedback=_throttling_feedback,
        )
        if isinstance(result, AccessFailure):
            raise _access_failure(result)
        if not isinstance(result, TransportResponse):
            raise _protocol_failure()
        if result.status == 404:
            return None
        if result.status != 200:
            raise _http_status_failure(result.status)
        return result


def _doi_tasks(evidence: AcquisitionEvidence) -> tuple[str, ...]:
    result: list[str] = []
    for identifier in evidence.identifiers:
        if identifier.namespace == "doi" and identifier.value not in result:
            result.append(identifier.value)
    return tuple(result)


def _locator_tasks(payload: bytes, *, expected_doi: str) -> tuple[_LocatorTask, ...]:
    root = _json_object(_parse_json(payload))
    if not _record_is_open_access(root, expected_doi=expected_doi):
        return ()
    locations = _ordered_locations(root)
    return _tasks_from_locations(locations)


def _record_is_open_access(root: dict[str, object], *, expected_doi: str) -> bool:
    doi_value = root.get("doi")
    if not isinstance(doi_value, str):
        raise _protocol_failure()
    try:
        actual_doi = Identifier(namespace="doi", value=doi_value).value
    except (TypeError, ValueError):
        raise _protocol_failure() from None
    if actual_doi != expected_doi:
        raise _protocol_failure()
    is_oa = root.get("is_oa")
    if type(is_oa) is not bool:
        raise _protocol_failure()
    return is_oa


def _tasks_from_locations(locations: tuple[dict[str, object], ...]) -> tuple[_LocatorTask, ...]:
    result: list[_LocatorTask] = []
    url_positions: dict[str, int] = {}
    for location in locations:
        if _location_is_embargoed(location):
            continue
        pdf = _optional_locator(location, "url_for_pdf")
        landing = _optional_locator(location, "url_for_landing_page")
        generic = _optional_locator(location, "url")
        if pdf is not None:
            _append_locator(
                result,
                url_positions,
                locator=pdf,
                declared_media_type="application/pdf",
                allow_static_landing_discovery=False,
            )
        if landing is not None:
            _append_locator(
                result,
                url_positions,
                locator=landing,
                declared_media_type=None,
                allow_static_landing_discovery=True,
            )
        elif pdf is None and generic is not None:
            _append_locator(
                result,
                url_positions,
                locator=generic,
                declared_media_type=None,
                allow_static_landing_discovery=True,
            )
    return tuple(result)


def _ordered_locations(root: dict[str, object]) -> tuple[dict[str, object], ...]:
    result: list[dict[str, object]] = []
    best = root.get("best_oa_location")
    if best is not None:
        result.append(_json_object(best))
    locations_value = root.get("oa_locations")
    if locations_value is not None:
        for value in _json_array(locations_value):
            location = _json_object(value)
            if location not in result:
                result.append(location)
    first = root.get("first_oa_location")
    if first is not None:
        location = _json_object(first)
        if location not in result:
            result.append(location)
    return tuple(result)


def _location_is_embargoed(location: dict[str, object]) -> bool:
    for key in ("is_embargoed", "is_under_embargo"):
        value = location.get(key)
        if value is not None and type(value) is not bool:
            raise _protocol_failure()
        if value is True:
            return True
    return False


def _optional_locator(location: dict[str, object], key: str) -> str | None:
    value = location.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _protocol_failure()
    try:
        locator = normalize_url(value)
    except (PolicyError, TypeError, ValueError):
        raise _protocol_failure() from None
    if locator.scheme != "https":
        raise _protocol_failure()
    return locator.url


def _append_locator(
    result: list[_LocatorTask],
    url_positions: dict[str, int],
    *,
    locator: str,
    declared_media_type: str | None,
    allow_static_landing_discovery: bool,
) -> None:
    existing_position = url_positions.get(locator)
    if existing_position is not None:
        existing = result[existing_position]
        result[existing_position] = _LocatorTask(
            locator=locator,
            declared_media_type=(existing.declared_media_type or declared_media_type),
            allow_static_landing_discovery=(
                existing.allow_static_landing_discovery or allow_static_landing_discovery
            ),
        )
        return
    url_positions[locator] = len(result)
    result.append(
        _LocatorTask(
            locator=locator,
            declared_media_type=declared_media_type,
            allow_static_landing_discovery=allow_static_landing_discovery,
        )
    )


def _parse_json(payload: bytes) -> object:
    if type(payload) is not bytes:
        raise TypeError("Unpaywall payload must be bytes")
    if len(payload) > _MAX_RESPONSE_BYTES:
        raise _protocol_failure()
    try:
        text = payload.decode("utf-8")
        return cast(
            object,
            json.loads(
                text,
                object_pairs_hook=_unique_json_object,
                parse_constant=_reject_json_constant,
            ),
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        _DuplicateJsonKey,
        _InvalidJsonConstant,
    ):
        raise _protocol_failure() from None


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey
        result[key] = value
    return result


def _reject_json_constant(value: str) -> NoReturn:
    del value
    raise _InvalidJsonConstant


def _json_object(value: object) -> dict[str, object]:
    if type(value) is not dict:
        raise _protocol_failure()
    return cast(dict[str, object], value)


def _json_array(value: object) -> tuple[object, ...]:
    if type(value) is not list:
        raise _protocol_failure()
    return tuple(cast(list[object], value))


def _contact_email(value: str) -> str:
    if type(value) is not str:
        raise TypeError("contact_email must be a string")
    candidate = unicodedata.normalize("NFC", value.strip())
    if (
        not candidate
        or len(candidate) > 254
        or _CONTROL.search(candidate) is not None
        or _EMAIL.fullmatch(candidate) is None
    ):
        raise ValueError("contact_email must be a valid contact address")
    try:
        candidate.encode("ascii", "strict")
    except UnicodeError:
        raise ValueError("contact_email must be a valid contact address") from None
    return candidate


def _yield_and_close(deliveries: Iterable[TemporaryPdf]) -> Iterator[TemporaryPdf]:
    try:
        iterator = iter(deliveries)
    except TypeError:
        raise _protocol_failure() from None
    try:
        while True:
            try:
                yield next(iterator)
            except StopIteration:
                return
            except AcquisitionFailure:
                raise
            except Exception:
                raise _cleanup_failure() from None
    finally:
        close = getattr(iterator, "close", None)
        if close is not None:
            if not callable(close):
                raise _protocol_failure()
            try:
                close()
            except AcquisitionFailure:
                raise
            except Exception:
                raise _cleanup_failure() from None


def _validate_dependencies(
    *,
    http_client: HttpClient,
    access_scope: AccessScope,
    access_policy: AccessPolicy,
    locator_fetcher: PublicLocatorFetcher,
    cancel_event: threading.Event | None,
) -> None:
    if not callable(getattr(http_client, "request", None)):
        raise TypeError("http_client must expose request()")
    if access_scope != ACCESS_SCOPE:
        raise ValueError("access_scope must use the shared unpaywall API identity")
    if not isinstance(access_policy, AccessPolicy):
        raise TypeError("access_policy must be AccessPolicy")
    if not callable(getattr(locator_fetcher, "acquire", None)):
        raise TypeError("locator_fetcher must expose acquire()")
    if cancel_event is not None and not isinstance(cancel_event, threading.Event):
        raise TypeError("cancel_event must be a threading.Event or None")


def _validate_acquire_inputs(
    request: AcquisitionRequest,
    evidence: AcquisitionEvidence,
    candidate_keys: CandidateKeyTracker,
) -> None:
    if not isinstance(request, AcquisitionRequest):
        raise TypeError("request must be AcquisitionRequest")
    if not isinstance(evidence, AcquisitionEvidence):
        raise TypeError("evidence must be AcquisitionEvidence")
    if not isinstance(candidate_keys, CandidateKeyTracker):
        raise TypeError("candidate_keys must be CandidateKeyTracker")
    if evidence != build_acquisition_evidence(request):
        raise _evidence_failure()


def _throttling_feedback(response: TransportResponse) -> AccessFeedback | None:
    if response.status == 429 or response.status >= 500:
        return AccessFeedback(throttled=True)
    return None


def _failure(
    *,
    code: str,
    reason: str,
    action: str,
    retryable: bool,
    isolated: bool = False,
) -> AcquisitionFailure:
    failure = StableFailure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )
    failure_type = AcquisitionSourceFailure if isolated else AcquisitionFailure
    return failure_type(failure)


def _access_failure(value: AccessFailure) -> AcquisitionFailure:
    if value.code == "cancelled":
        return _failure(
            code="acquisition-interrupted",
            reason="Automatic PDF acquisition was interrupted before commit.",
            action="Retry the operation when ready.",
            retryable=True,
        )
    return _failure(
        code="acquisition-unpaywall-access",
        reason="The Unpaywall API could not be reached through the safe access boundary.",
        action="Retry the acquisition request or review Unpaywall readiness.",
        retryable=value.retryable,
        isolated=True,
    )


def _http_status_failure(status: int) -> AcquisitionFailure:
    return _failure(
        code="acquisition-unpaywall-http-status",
        reason="The Unpaywall API returned an unsuccessful HTTP status.",
        action="Retry the acquisition request or review Unpaywall readiness.",
        retryable=status == 429 or status >= 500,
        isolated=True,
    )


def _protocol_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-unpaywall-protocol",
        reason="The Unpaywall API returned an unsafe or inconsistent response.",
        action="Update the Unpaywall acquisition Source before retrying.",
        retryable=False,
        isolated=True,
    )


def _evidence_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-unpaywall-evidence-mismatch",
        reason="The Unpaywall routing evidence does not belong to the acquisition request.",
        action="Rebuild routing evidence from the current acquisition request.",
        retryable=False,
    )


def _cleanup_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-unpaywall-cleanup",
        reason="The Unpaywall locator iterator could not be cleaned up safely.",
        action="Retry after checking the acquisition runtime.",
        retryable=True,
    )


__all__ = (
    "ACCESS_SCOPE",
    "BASELINE_ACCESS_POLICY",
    "PublicLocatorFetcher",
    "UnpaywallPdfSource",
)
