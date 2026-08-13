"""Public Europe PMC core lookup for primary-PDF locators."""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Iterable, Iterator
from typing import NoReturn, Protocol, cast
from urllib.parse import urlencode

from sciretriever.acquisition.ports import (
    AcquisitionFailure,
    CandidateKeyTracker,
    TemporaryPdf,
)
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
from sciretriever.network.policy import PolicyError, normalize_url

_PROVIDER_NAME = "europe-pmc"
_ENDPOINT = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
_MAX_RESPONSE_BYTES = 2_097_152

ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
# Europe PMC publishes no fixed numeric quota; this is the project's safety floor.
BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1, min_start_interval=1.0)


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


class EuropePmcPdfSource:
    """Discover only explicitly declared PDF-style Europe PMC full-text URLs."""

    source_name = _PROVIDER_NAME
    acquisition_path = AcquisitionPath.PUBLIC

    def __init__(
        self,
        *,
        http_client: HttpClient,
        access_scope: AccessScope,
        access_policy: AccessPolicy,
        locator_fetcher: PublicLocatorFetcher,
        cancel_event: threading.Event | None = None,
    ) -> None:
        _validate_dependencies(
            http_client=http_client,
            access_scope=access_scope,
            access_policy=access_policy,
            locator_fetcher=locator_fetcher,
            cancel_event=cancel_event,
        )
        self._http_client = http_client
        self._access_scope = access_scope
        self._access_policy = AccessPolicy.strictest(BASELINE_ACCESS_POLICY, access_policy)
        self._locator_fetcher = locator_fetcher
        self._cancel_event = cancel_event

    def is_applicable(self, evidence: AcquisitionEvidence) -> bool:
        if not isinstance(evidence, AcquisitionEvidence):
            raise TypeError("evidence must be AcquisitionEvidence")
        return bool(_pmcid_tasks(evidence))

    def acquire(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        _validate_acquire_inputs(request, evidence, candidate_keys)
        for pmcid in _pmcid_tasks(evidence):
            lookup_key = f"europe-pmc/public/lookup/{pmcid}"
            if not candidate_keys.claim(lookup_key):
                continue
            response = self._lookup(pmcid)
            if response is None:
                continue
            for locator in _pdf_locators(response.body, expected_pmcid=pmcid):
                digest = hashlib.sha256(locator.encode("utf-8")).hexdigest()
                deliveries = self._locator_fetcher.acquire(
                    locator=locator,
                    candidate_key=f"europe-pmc/public/pdf/{digest}",
                    source_name=self.source_name,
                    source_record_id=pmcid,
                    declared_media_type="application/pdf",
                    candidate_keys=candidate_keys,
                    allow_static_landing_discovery=False,
                )
                yield from _yield_and_close(deliveries)

    def _lookup(self, pmcid: str) -> TransportResponse | None:
        query = urlencode(
            (
                ("query", f"PMCID:{pmcid}"),
                ("resultType", "core"),
                ("format", "json"),
                ("pageSize", "1"),
                ("cursorMark", "*"),
            )
        )
        result = self._http_client.request(
            self._access_scope,
            f"{_ENDPOINT}?{query}",
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
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


def _pmcid_tasks(evidence: AcquisitionEvidence) -> tuple[str, ...]:
    result: list[str] = []
    for identifier in evidence.identifiers:
        if identifier.namespace == "pmcid" and identifier.value not in result:
            result.append(identifier.value)
    for identity in evidence.provider_record_identities:
        if identity.provider_name.casefold() != _PROVIDER_NAME:
            continue
        pmcid = _try_pmc_identity(identity.record_id)
        if pmcid is not None and pmcid not in result:
            result.append(pmcid)
    return tuple(result)


def _try_pmc_identity(value: str) -> str | None:
    candidate = value.strip()
    explicit_pmc_source = candidate.casefold().startswith("pmc:")
    if explicit_pmc_source:
        candidate = candidate[4:].strip()
        if candidate.isdigit():
            candidate = f"PMC{candidate}"
    try:
        return Identifier(namespace="pmcid", value=candidate).value
    except (TypeError, ValueError):
        return None


def _pdf_locators(payload: bytes, *, expected_pmcid: str) -> tuple[str, ...]:
    root = _json_object(_parse_json(payload))
    record = _single_search_record(root)
    if record is None:
        return ()
    _require_matching_pmcid(record, expected_pmcid=expected_pmcid)
    descriptors = _full_text_descriptors(record)
    locators: list[str] = []
    for descriptor in descriptors:
        style = descriptor.get("documentStyle")
        if not isinstance(style, str):
            raise _protocol_failure()
        if style.casefold() != "pdf":
            continue
        value = descriptor.get("url")
        if not isinstance(value, str):
            raise _protocol_failure()
        locator = _safe_https_locator(value)
        if locator not in locators:
            locators.append(locator)
    return tuple(locators)


def _single_search_record(root: dict[str, object]) -> dict[str, object] | None:
    hit_count = root.get("hitCount")
    if type(hit_count) is not int or hit_count < 0:
        raise _protocol_failure()
    result_list_value = root.get("resultList")
    if result_list_value is None and hit_count == 0:
        return None
    result_list = _json_object(result_list_value)
    results_value = result_list.get("result")
    if results_value is None and hit_count == 0:
        return None
    results = _json_array(results_value)
    if len(results) > 1 or (hit_count > 0 and not results):
        raise _protocol_failure()
    if not results:
        return None
    return _json_object(results[0])


def _require_matching_pmcid(record: dict[str, object], *, expected_pmcid: str) -> None:
    pmcid_value = record.get("pmcid")
    if not isinstance(pmcid_value, str):
        raise _protocol_failure()
    try:
        actual_pmcid = Identifier(namespace="pmcid", value=pmcid_value).value
    except (TypeError, ValueError):
        raise _protocol_failure() from None
    if actual_pmcid != expected_pmcid:
        raise _protocol_failure()


def _full_text_descriptors(record: dict[str, object]) -> tuple[dict[str, object], ...]:
    full_text_list_value = record.get("fullTextUrlList")
    if full_text_list_value is None:
        return ()
    full_text_list = _json_object(full_text_list_value)
    urls_value = full_text_list.get("fullTextUrl")
    if urls_value is None:
        return ()
    return tuple(_json_object(item) for item in _json_array(urls_value))


def _parse_json(payload: bytes) -> object:
    if type(payload) is not bytes:
        raise TypeError("Europe PMC payload must be bytes")
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


def _safe_https_locator(value: str) -> str:
    try:
        locator = normalize_url(value)
    except (PolicyError, TypeError, ValueError):
        raise _protocol_failure() from None
    if locator.scheme != "https":
        raise _protocol_failure()
    return locator.url


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
        raise ValueError("access_scope must use the shared europe-pmc API identity")
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
) -> AcquisitionFailure:
    return AcquisitionFailure(
        StableFailure(
            code=code,
            reason=reason,
            action=action,
            retryable=retryable,
        )
    )


def _access_failure(value: AccessFailure) -> AcquisitionFailure:
    if value.code == "cancelled":
        return _failure(
            code="acquisition-interrupted",
            reason="Automatic PDF acquisition was interrupted before commit.",
            action="Retry the operation when ready.",
            retryable=True,
        )
    return _failure(
        code="acquisition-europe-pmc-access",
        reason="The Europe PMC API could not be reached through the safe access boundary.",
        action="Retry the acquisition request or review Europe PMC readiness.",
        retryable=value.retryable,
    )


def _http_status_failure(status: int) -> AcquisitionFailure:
    return _failure(
        code="acquisition-europe-pmc-http-status",
        reason="The Europe PMC API returned an unsuccessful HTTP status.",
        action="Retry the acquisition request or review Europe PMC readiness.",
        retryable=status == 429 or status >= 500,
    )


def _protocol_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-europe-pmc-protocol",
        reason="The Europe PMC API returned an unsafe or inconsistent response.",
        action="Update the Europe PMC acquisition Source before retrying.",
        retryable=False,
    )


def _evidence_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-europe-pmc-evidence-mismatch",
        reason="The Europe PMC routing evidence does not belong to the acquisition request.",
        action="Rebuild routing evidence from the current acquisition request.",
        retryable=False,
    )


def _cleanup_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-europe-pmc-cleanup",
        reason="The Europe PMC locator iterator could not be cleaned up safely.",
        action="Retry after checking the acquisition runtime.",
        retryable=True,
    )


__all__ = (
    "ACCESS_SCOPE",
    "BASELINE_ACCESS_POLICY",
    "EuropePmcPdfSource",
    "PublicLocatorFetcher",
)
