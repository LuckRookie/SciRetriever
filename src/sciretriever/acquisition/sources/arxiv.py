"""Public arXiv Atom discovery for primary-PDF candidates.

The Source owns only the arXiv lookup protocol and hands every discovered PDF
locator to the injected public locator fetcher.  It never validates or
publishes PDF bytes itself.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlencode, urlsplit
from xml.etree import ElementTree

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
from sciretriever.network.policy import PolicyError, normalize_url

_PROVIDER_NAME = "arxiv"
_ENDPOINT = "https://export.arxiv.org/api/query"
_MAX_RESPONSE_BYTES = 1_048_576
_ATOM_NAMESPACE = "http://www.w3.org/2005/Atom"
_FEED = f"{{{_ATOM_NAMESPACE}}}feed"
_ENTRY = f"{{{_ATOM_NAMESPACE}}}entry"
_ID = f"{{{_ATOM_NAMESPACE}}}id"
_LINK = f"{{{_ATOM_NAMESPACE}}}link"
_REVISION = re.compile(r"(?P<revision>v[1-9][0-9]*)$", re.IGNORECASE)

ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1, min_start_interval=3.0)


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


@dataclass(frozen=True, slots=True)
class _ArxivRecord:
    base_id: str
    source_record_id: str
    revision: str | None


class ArxivPdfSource:
    """Discover version-aligned official arXiv PDF locators through Atom."""

    source_name = _PROVIDER_NAME
    acquisition_path = AcquisitionPath.PUBLIC
    route_key = "public:arxiv"

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
        for requested in _lookup_tasks(evidence):
            try:
                lookup_key = f"arxiv/public/lookup/{requested.source_record_id}"
                if not candidate_keys.claim(lookup_key):
                    continue
                response = self._lookup(requested)
                if response is None:
                    continue
                discovered = _parse_lookup_response(response.body, requested=requested)
                if discovered is None:
                    continue
                record, locator = discovered
                deliveries = self._locator_fetcher.acquire(
                    locator=locator,
                    candidate_key=f"arxiv/public/{record.source_record_id}",
                    source_name=self.source_name,
                    source_record_id=record.source_record_id,
                    declared_media_type="application/pdf",
                    candidate_keys=candidate_keys,
                    allow_static_landing_discovery=False,
                )
                yield from _yield_and_close(deliveries)
            except AcquisitionSourceFailure as error:
                if first_failure is None:
                    first_failure = error
        if first_failure is not None:
            raise first_failure

    def _lookup(self, requested: _ArxivRecord) -> TransportResponse | None:
        query = urlencode(
            (
                ("id_list", requested.source_record_id),
                ("max_results", "1"),
            )
        )
        result = self._http_client.request(
            self._access_scope,
            f"{_ENDPOINT}?{query}",
            self._access_policy,
            headers=(
                Header(
                    name="Accept",
                    value="application/atom+xml, application/xml;q=0.9",
                ),
            ),
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


def _lookup_tasks(evidence: AcquisitionEvidence) -> tuple[_ArxivRecord, ...]:
    versioned: list[_ArxivRecord] = []
    unversioned_records: list[_ArxivRecord] = []
    for identity in evidence.provider_record_identities:
        if identity.provider_name.casefold() != _PROVIDER_NAME:
            continue
        record = _try_arxiv_record(identity.record_id)
        if record is None:
            continue
        target = versioned if record.revision is not None else unversioned_records
        if record not in target:
            target.append(record)

    covered_bases = {record.base_id for record in versioned}
    bases: list[_ArxivRecord] = []
    for identifier in evidence.identifiers:
        if identifier.namespace != "arxiv":
            continue
        record = _ArxivRecord(identifier.value, identifier.value, None)
        if record.base_id not in covered_bases and record not in bases:
            bases.append(record)
    for record in unversioned_records:
        if record.base_id not in covered_bases and record not in bases:
            bases.append(record)
    return tuple((*versioned, *bases))


def _try_arxiv_record(value: str) -> _ArxivRecord | None:
    try:
        return _arxiv_record(value)
    except (TypeError, ValueError):
        return None


def _arxiv_record(value: str) -> _ArxivRecord:
    if type(value) is not str:
        raise TypeError("arXiv record must be a string")
    candidate = value.strip()
    if not candidate:
        raise ValueError("arXiv record must be nonblank")
    lowered = candidate.casefold()
    if lowered.startswith("arxiv:"):
        candidate = candidate[6:].strip()
    elif lowered.startswith(("http://", "https://")):
        parsed = urlsplit(candidate)
        if (
            parsed.scheme.casefold() not in {"http", "https"}
            or parsed.hostname is None
            or parsed.hostname.casefold() != "arxiv.org"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("arXiv record URL is not official")
        path = parsed.path.lstrip("/")
        if path.startswith("abs/"):
            candidate = path[4:]
        elif path.startswith("pdf/"):
            candidate = path[4:]
        else:
            raise ValueError("arXiv record URL path is unsupported")
    if candidate.casefold().endswith(".pdf"):
        candidate = candidate[:-4]
    match = _REVISION.search(candidate)
    revision = None if match is None else match.group("revision").casefold()
    base_candidate = candidate if match is None else candidate[: match.start()]
    base_id = Identifier(namespace="arxiv", value=base_candidate).value
    source_record_id = base_id if revision is None else f"{base_id}{revision}"
    return _ArxivRecord(
        base_id=base_id,
        source_record_id=source_record_id,
        revision=revision,
    )


def _parse_lookup_response(
    payload: bytes,
    *,
    requested: _ArxivRecord,
) -> tuple[_ArxivRecord, str] | None:
    root = _parse_atom(payload)
    if root.tag != _FEED:
        raise _protocol_failure()
    entry = _single_entry(root)
    if entry is None:
        return None
    actual = _matched_entry_record(entry, requested=requested)
    locator = _entry_pdf_locator(entry, actual=actual)
    return None if locator is None else (actual, locator)


def _single_entry(root: ElementTree.Element) -> ElementTree.Element | None:
    entries = tuple(child for child in root if child.tag == _ENTRY)
    if len(entries) > 1:
        raise _protocol_failure()
    return None if not entries else entries[0]


def _matched_entry_record(
    entry: ElementTree.Element,
    *,
    requested: _ArxivRecord,
) -> _ArxivRecord:
    identifiers = tuple(child for child in entry if child.tag == _ID)
    if len(identifiers) != 1 or identifiers[0].text is None:
        raise _protocol_failure()
    try:
        actual = _arxiv_record(identifiers[0].text)
    except (TypeError, ValueError):
        raise _protocol_failure() from None
    if actual.revision is None or actual.base_id != requested.base_id:
        raise _protocol_failure()
    if requested.revision is not None and actual.source_record_id != requested.source_record_id:
        raise _protocol_failure()
    return actual


def _entry_pdf_locator(
    entry: ElementTree.Element,
    *,
    actual: _ArxivRecord,
) -> str | None:
    pdf_locators: list[str] = []
    for child in entry:
        if child.tag != _LINK:
            continue
        media_type = child.attrib.get("type")
        if not isinstance(media_type, str) or media_type.casefold() != "application/pdf":
            continue
        href = child.attrib.get("href")
        if not isinstance(href, str):
            raise _protocol_failure()
        locator, locator_record = _official_pdf_locator(href)
        if locator_record.source_record_id != actual.source_record_id:
            raise _protocol_failure()
        if locator not in pdf_locators:
            pdf_locators.append(locator)
    if not pdf_locators:
        return None
    if len(pdf_locators) != 1:
        raise _protocol_failure()
    return pdf_locators[0]


def _parse_atom(payload: bytes) -> ElementTree.Element:
    if type(payload) is not bytes:
        raise TypeError("arXiv payload must be bytes")
    if len(payload) > _MAX_RESPONSE_BYTES:
        raise _protocol_failure()
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        raise _protocol_failure() from None
    folded = text.casefold()
    if "<!doctype" in folded or "<!entity" in folded:
        raise _unsafe_xml_failure()
    try:
        return ElementTree.fromstring(text)
    except ElementTree.ParseError:
        raise _protocol_failure() from None


def _official_pdf_locator(value: str) -> tuple[str, _ArxivRecord]:
    try:
        normalized = normalize_url(value)
        parsed = urlsplit(normalized.url)
        if (
            normalized.scheme != "https"
            or normalized.hostname != "arxiv.org"
            or normalized.port != 443
            or parsed.query
            or not normalized.path.startswith("/pdf/")
        ):
            raise PolicyError()
        record = _arxiv_record(normalized.path.removeprefix("/pdf/"))
    except (PolicyError, TypeError, ValueError):
        raise _protocol_failure() from None
    if record.revision is None:
        raise _protocol_failure()
    return normalized.url, record


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
        raise ValueError("access_scope must use the shared arxiv API identity")
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
        code="acquisition-arxiv-access",
        reason="The arXiv API could not be reached through the safe access boundary.",
        action="Retry the acquisition request or review arXiv readiness.",
        retryable=value.retryable,
        isolated=True,
    )


def _http_status_failure(status: int) -> AcquisitionFailure:
    return _failure(
        code="acquisition-arxiv-http-status",
        reason="The arXiv API returned an unsuccessful HTTP status.",
        action="Retry the acquisition request or review arXiv readiness.",
        retryable=status == 429 or status >= 500,
        isolated=True,
    )


def _protocol_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-arxiv-protocol",
        reason="The arXiv API returned an unsafe or inconsistent response.",
        action="Update the arXiv acquisition Source before retrying.",
        retryable=False,
        isolated=True,
    )


def _evidence_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-arxiv-evidence-mismatch",
        reason="The arXiv routing evidence does not belong to the acquisition request.",
        action="Rebuild routing evidence from the current acquisition request.",
        retryable=False,
    )


def _unsafe_xml_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-arxiv-unsafe-xml",
        reason="The arXiv API returned unsupported XML declarations.",
        action="Update the arXiv acquisition Source before retrying.",
        retryable=False,
        isolated=True,
    )


def _cleanup_failure() -> AcquisitionFailure:
    return _failure(
        code="acquisition-arxiv-cleanup",
        reason="The arXiv locator iterator could not be cleaned up safely.",
        action="Retry after checking the acquisition runtime.",
        retryable=True,
    )


__all__ = (
    "ACCESS_SCOPE",
    "BASELINE_ACCESS_POLICY",
    "ArxivPdfSource",
    "PublicLocatorFetcher",
)
