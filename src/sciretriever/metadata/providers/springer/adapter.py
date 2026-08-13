"""Springer Nature Meta API v2 JSON topic-search and DOI-lookup adapter.

This adapter deliberately targets the documented ``/meta/v2/json`` product,
revision checked on 2026-08-07.  Open Access JATS and licensed Full Text XML
are separate products and are not represented as metadata or acquired PDFs.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, overload
from urllib.parse import urlencode, urlsplit

from pydantic import ValidationError

from sciretriever.metadata import ports as metadata_ports
from sciretriever.metadata.ports import MetadataProviderFailure, RawItemSession
from sciretriever.metadata.probe import (
    MetadataProbeEvidence,
    probe_feedback_wall_time,
    run_metadata_probe,
    system_probe_wall_clock,
)
from sciretriever.metadata.providers._shared import (
    access_failure_to_provider_failure,
    header_value,
    invalid_record_failure,
    optional_nonblank_string,
    parse_bounded_json,
    require_json_array,
    require_json_object,
    retry_after_feedback,
    stabilize_provider_metadata_observation,
)
from sciretriever.metadata.providers._shared.failures import unknown_shape_failure
from sciretriever.metadata.rules import NeutralMetadataItem, TopicSearchQuery
from sciretriever.model.access import (
    AccessFailure,
    Header,
    TransportResponse,
    has_sensitive_query_parameter,
)
from sciretriever.model.acquisition import (
    AssetHint,
    AssetHintKind,
    AssetRole,
)
from sciretriever.model.literature import Author, AuthorKind, Identifier
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
)
from sciretriever.model.primitives import (
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessFeedback,
    AccessPolicy,
    AccessScope,
)
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import Origin

_PROVIDER_NAME = "springer"
_ORIGIN = "https://api.springernature.com"
_META_V2_ENDPOINT = f"{_ORIGIN}/meta/v2/json"
_CREDENTIAL_ORIGIN = Origin("https", "api.springernature.com", 443)
_MAX_RESPONSE_BYTES = 4_194_304
_YEAR_PREFIX = re.compile(r"^(?P<year>[0-9]{4})(?:-|$)", re.ASCII)

ADAPTER_REVISION = "meta-v2-json-2026-08-07"
ACCESS_SCOPE = AccessScope(
    provider_name=_PROVIDER_NAME,
    channel="api",
    service_name="meta-v2",
)
BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=0.6,
    burst_limit=500,
    window_seconds=86_400.0,
)

_DOCUMENT_TYPES = {
    "article": "journal-article",
    "book": "book",
    "chapter": "book-chapter",
    "conference paper": "conference-paper",
    "protocol": "protocol",
    "reference work entry": "reference-entry",
}


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _RawSpringerRecord:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    expected: ProviderLiteratureKey | None = None


class SpringerMetaV2Adapter:
    """Springer Nature Meta API v2 JSON search and DOI lookup."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        access_coordinator: AccessCoordinator,
        access_scope: AccessScope,
        access_policy: AccessPolicy,
        observation_id_factory: Callable[[], ObservationId],
        provenance_id_factory: Callable[[], ProvenanceId],
        clock: Callable[[], UtcTimestamp],
        api_key: str | None,
        page_size: int = 25,
    ) -> None:
        _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("Springer Nature must share the HttpClient AccessCoordinator")
        _validate_factories(observation_id_factory, provenance_id_factory, clock)
        _validate_page_size(page_size)
        self._http_client = http_client
        self._access_coordinator = access_coordinator
        self._access_scope = access_scope
        self._access_policy = AccessPolicy.strictest(
            BASELINE_ACCESS_POLICY,
            access_policy,
        )
        self._observation_id_factory = observation_id_factory
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._api_key = _private_api_key(api_key)
        self._page_size = page_size
        self._parameters_sha256 = sha256_digest(ADAPTER_REVISION.encode("utf-8"))

    def __repr__(self) -> str:
        return f"<SpringerMetaV2Adapter credentialed={self._api_key is not None}>"

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe Meta API v2 with one minimal metadata query."""

        def operation() -> None:
            response = self._request(
                _META_V2_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("q", 'keyword:"metadata"'),
                        ("s", "1"),
                        ("p", "1"),
                    )
                ),
                probe=True,
            )
            _meta_page(
                response.body,
                requested_start=1,
                requested_page_size=1,
            )

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=self._api_key is not None,
        )

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        provider_query = _topic_query(query)
        seen_items = 0

        def fetch_page(
            start: int | None,
        ) -> metadata_ports._RawPage[_RawSpringerRecord, int]:
            nonlocal seen_items
            requested_start = 1 if start is None else start
            response = self._request(
                _META_V2_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("q", provider_query),
                        ("s", str(requested_start)),
                        ("p", str(self._page_size)),
                    )
                )
            )
            assert response is not None
            values, total = _meta_page(
                response.transport.body,
                requested_start=requested_start,
                requested_page_size=self._page_size,
            )
            if requested_start != seen_items + 1:
                raise _protocol_failure()
            if not values:
                if total == 0 and seen_items == 0:
                    return metadata_ports._RawPage(
                        items=(),
                        next_cursor=None,
                        exhausted=True,
                    )
                raise _protocol_failure()
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawSpringerRecord(
                    value=value,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for value in values
            )
            seen_items += len(items)
            if seen_items > total:
                raise _protocol_failure()
            exhausted = seen_items == total
            return metadata_ports._RawPage(
                items=items,
                next_cursor=None if exhausted else seen_items + 1,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        doi = _lookup_doi(key)

        def fetch_page(
            cursor: None,
        ) -> metadata_ports._RawPage[_RawSpringerRecord, None]:
            if cursor is not None:
                raise TypeError("Springer Nature DOI lookup has no cursor")
            response = self._request(
                _META_V2_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("q", f"doi:{doi.value}"),
                        ("s", "1"),
                        ("p", "1"),
                    )
                ),
                allow_not_found=True,
            )
            if response is None:
                return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)
            values, total = _meta_page(
                response.transport.body,
                requested_start=1,
                requested_page_size=1,
            )
            if total == 0:
                return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)
            if total != 1 or len(values) != 1:
                raise _protocol_failure()
            raw = _RawSpringerRecord(
                value=values[0],
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                expected=key,
            )
            return metadata_ports._RawPage(items=(raw,), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    @overload
    def _request(
        self,
        url: str,
        *,
        allow_not_found: Literal[False] = False,
        probe: Literal[False] = False,
    ) -> _ObservedResponse: ...

    @overload
    def _request(
        self,
        url: str,
        *,
        allow_not_found: Literal[True],
        probe: Literal[False] = False,
    ) -> _ObservedResponse | None: ...

    @overload
    def _request(
        self,
        url: str,
        *,
        allow_not_found: bool = False,
        probe: Literal[True],
    ) -> TransportResponse: ...

    def _request(  # noqa: C901 -- one request boundary owns feedback and status stabilization
        self,
        url: str,
        *,
        allow_not_found: bool = False,
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse | None:
        if self._api_key is None:
            raise _credentials_missing_failure()
        observed_at: UtcTimestamp | None = None
        feedback_failure: MetadataProviderFailure | None = None

        def response_feedback(response: TransportResponse) -> AccessFeedback | None:
            nonlocal observed_at, feedback_failure
            observed_at = None if probe else self._observed_at()
            try:
                return _springer_feedback(
                    response.status,
                    response.headers,
                    wall_now=(
                        probe_feedback_wall_time(system_probe_wall_clock)
                        if observed_at is None
                        else _timestamp_datetime(observed_at)
                    ),
                )
            except MetadataProviderFailure as error:
                feedback_failure = error
                return AccessFeedback(throttled=True)

        result = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
            credential_query=(("api_key", self._api_key),),
            credential_allowed_origins=(_CREDENTIAL_ORIGIN,),
            max_response_bytes=_MAX_RESPONSE_BYTES,
            max_redirects=1,
            response_feedback=response_feedback,
        )
        if isinstance(result, AccessFailure):
            raise access_failure_to_provider_failure(result)
        if not isinstance(result, TransportResponse):
            raise TypeError("HttpClient returned an unsupported result")
        if feedback_failure is not None:
            raise feedback_failure
        if not probe and allow_not_found and result.status == 404:
            return None
        if result.status != 200:
            raise _http_status_failure(result.status)
        if probe:
            return result
        if observed_at is None:
            raise RuntimeError("HttpClient did not interpret the Springer response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _convert_record(self, envelope: _RawSpringerRecord) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawSpringerRecord):
            raise TypeError("raw Springer item must use the private envelope")
        record = require_json_object(envelope.value)
        source_record_id = _source_record_id(record)
        identifiers = _identifiers(record, source_record_id=source_record_id)
        current = ProviderLiteratureKey(
            record_id=source_record_id,
            identifiers=identifiers,
        )
        if envelope.expected is not None and not _keys_overlap(envelope.expected, current):
            raise invalid_record_failure()
        publication_date = optional_nonblank_string(record.get("publicationDate"))
        publication_year = _publication_year(record.get("year"), publication_date)
        provenance = self._provenance(
            source_record_id=source_record_id,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        try:
            observation = MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=LiteratureMetadata(
                    title=optional_nonblank_string(record.get("title")),
                    authors=_creators(record.get("creators")),
                    abstract=optional_nonblank_string(record.get("abstract")),
                    publication_date=publication_date,
                    publication_year=publication_year,
                    document_type=_document_type(record.get("contentType")),
                    language=optional_nonblank_string(record.get("language")),
                    venue=_first_text(
                        record.get("publicationName"),
                        record.get("journalTitle"),
                    ),
                    publisher=optional_nonblank_string(record.get("publisher")),
                    volume=optional_nonblank_string(record.get("volume")),
                    issue=optional_nonblank_string(record.get("number")),
                    pages=optional_nonblank_string(record.get("startingPage")),
                    identifiers=identifiers,
                    keywords=(),
                ),
                version_role=None,
                version_links=(),
                declared_keywords=(),
                reference_texts=(),
                reference_count=None,
                cited_by_count=None,
                asset_hints=_asset_hints(record.get("url")),
            )
        except ValidationError:
            raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=(stabilize_provider_metadata_observation(observation),),
            relations=(),
        )

    def _provenance(
        self,
        *,
        source_record_id: str,
        input_sha256: Sha256,
        observed_at: UtcTimestamp,
    ) -> Provenance:
        try:
            return Provenance(
                provenance_id=self._new_provenance_id(),
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name=_PROVIDER_NAME,
                source_record_id=source_record_id,
                observed_at=observed_at,
                input_sha256=input_sha256,
                parameters_sha256=self._parameters_sha256,
            )
        except ValidationError:
            raise invalid_record_failure() from None

    def _new_observation_id(self) -> ObservationId:
        value = self._observation_id_factory()
        if not isinstance(value, ObservationId):
            raise TypeError("observation_id_factory must return ObservationId")
        return value

    def _new_provenance_id(self) -> ProvenanceId:
        value = self._provenance_id_factory()
        if not isinstance(value, ProvenanceId):
            raise TypeError("provenance_id_factory must return ProvenanceId")
        return value

    def _observed_at(self) -> UtcTimestamp:
        value = self._clock()
        if not isinstance(value, UtcTimestamp):
            raise TypeError("clock must return UtcTimestamp")
        return value


def _meta_page(
    payload: bytes,
    *,
    requested_start: int,
    requested_page_size: int,
) -> tuple[tuple[object, ...], int]:
    root = require_json_object(parse_bounded_json(payload, max_bytes=_MAX_RESPONSE_BYTES))
    if "result" not in root or "records" not in root:
        raise unknown_shape_failure()
    summaries = require_json_array(root.get("result"))
    if len(summaries) != 1:
        raise unknown_shape_failure()
    summary = require_json_object(summaries[0])
    required = ("total", "start", "pageLength", "recordsDisplayed")
    if any(name not in summary for name in required):
        raise unknown_shape_failure()
    total = _vendor_integer(summary.get("total"))
    start = _vendor_integer(summary.get("start"))
    page_length = _vendor_integer(summary.get("pageLength"))
    records_displayed = _vendor_integer(summary.get("recordsDisplayed"))
    values = require_json_array(root.get("records"))
    if (
        start != requested_start
        or page_length != requested_page_size
        or records_displayed != len(values)
        or len(values) > requested_page_size
    ):
        raise _protocol_failure()
    return values, total


def _topic_query(query: TopicSearchQuery) -> str:
    normalized = " ".join(query.query.split())
    escaped = normalized.replace("\\", "\\\\").replace('"', '\\"')
    clauses = [f'keyword:"{escaped}"']
    if query.year_from is not None and query.year_to is not None:
        clauses.append(f"year:{query.year_from} TO {query.year_to}")
    elif query.year_from is not None:
        clauses.append(f"year:{query.year_from} TO 9999")
    elif query.year_to is not None:
        clauses.append(f"year:1 TO {query.year_to}")
    return " AND ".join(clauses)


def _lookup_doi(key: ProviderLiteratureKey) -> Identifier:
    for identifier in key.identifiers:
        if identifier.namespace == "doi":
            return identifier
    if key.record_id is not None and key.record_id.casefold().startswith("doi:"):
        try:
            return Identifier(namespace="doi", value=key.record_id)
        except ValidationError:
            pass
    raise _lookup_key_failure()


def _source_record_id(record: dict[str, object]) -> str:
    value = optional_nonblank_string(record.get("identifier"))
    if value is None:
        raise invalid_record_failure()
    return value


def _identifiers(
    record: dict[str, object],
    *,
    source_record_id: str,
) -> tuple[Identifier, ...]:
    raw_doi = optional_nonblank_string(record.get("doi"))
    if raw_doi is None and source_record_id.casefold().startswith("doi:"):
        raw_doi = source_record_id
    if raw_doi is None:
        return ()
    try:
        return (Identifier(namespace="doi", value=raw_doi),)
    except ValidationError:
        raise invalid_record_failure() from None


def _creators(value: object) -> tuple[Author, ...]:
    if value is None:
        return ()
    result: list[Author] = []
    for raw_item in require_json_array(value):
        item = require_json_object(raw_item)
        display_name = optional_nonblank_string(item.get("creator"))
        if display_name is None:
            continue
        try:
            result.append(
                Author(
                    kind=AuthorKind.UNKNOWN,
                    display_name=display_name,
                )
            )
        except ValidationError:
            raise invalid_record_failure() from None
    return tuple(result)


def _document_type(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    return _DOCUMENT_TYPES.get(raw.casefold(), raw)


def _publication_year(value: object, publication_date: str | None) -> int | None:
    if value is not None:
        return _year_value(value)
    if publication_date is None:
        return None
    match = _YEAR_PREFIX.match(publication_date)
    return None if match is None else _year_value(match.group("year"))


def _year_value(value: object) -> int:
    year = _vendor_integer(value)
    if not 1 <= year <= 9999:
        raise invalid_record_failure()
    return year


def _asset_hints(value: object) -> tuple[AssetHint, ...]:
    if value is None:
        return ()
    result: list[AssetHint] = []
    for raw_item in require_json_array(value):
        item = require_json_object(raw_item)
        url = optional_nonblank_string(item.get("value"))
        if url is None or not _is_safe_https_url(url):
            continue
        raw_format = optional_nonblank_string(item.get("format"))
        format_name = None if raw_format is None else raw_format.casefold()
        if format_name == "pdf":
            hint = AssetHint(
                url=url,
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
            )
        elif format_name in {"html", "htm"}:
            hint = AssetHint(
                url=url,
                kind=AssetHintKind.LANDING_PAGE,
                media_type="text/html",
            )
        elif format_name in {"xml", "jats"}:
            hint = AssetHint(
                url=url,
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/xml",
                asset_role=AssetRole.XML,
            )
        else:
            hint = AssetHint(url=url, kind=AssetHintKind.LANDING_PAGE)
        if hint not in result:
            result.append(hint)
    return tuple(result)


def _is_safe_https_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return (
            parsed.scheme == "https"
            and bool(parsed.netloc)
            and parsed.username is None
            and parsed.password is None
            and not has_sensitive_query_parameter(parsed.query)
        )
    except (TypeError, ValueError):
        return False


def _first_text(*values: object) -> str | None:
    for value in values:
        text = optional_nonblank_string(value)
        if text is not None:
            return text
    return None


def _keys_overlap(left: ProviderLiteratureKey, right: ProviderLiteratureKey) -> bool:
    if (
        left.record_id is not None
        and right.record_id is not None
        and left.record_id == right.record_id
    ):
        return True
    return any(identifier in right.identifiers for identifier in left.identifiers)


def _vendor_integer(value: object) -> int:
    if type(value) is int:
        candidate = value
    elif type(value) is str and value.isdigit():
        candidate = int(value, 10)
    else:
        raise invalid_record_failure()
    if candidate < 0:
        raise invalid_record_failure()
    return candidate


def _springer_feedback(
    status: int,
    headers: Sequence[Header],
    *,
    wall_now: datetime,
) -> AccessFeedback | None:
    standard = retry_after_feedback(status, headers, wall_now=wall_now)
    remaining = _nonnegative_header_number(
        _first_header(
            headers,
            "X-RateLimit-Remaining",
            "RateLimit-Remaining",
        )
    )
    throttled = status == 429 or remaining == 0
    if standard is not None or throttled:
        return AccessFeedback(
            retry_after=None if standard is None else standard.retry_after,
            throttled=throttled,
        )
    if status >= 500:
        return AccessFeedback(throttled=True)
    return standard


def _first_header(headers: Sequence[Header], *names: str) -> str | None:
    for name in names:
        value = header_value(headers, name)
        if value is not None:
            return value
    return None


def _nonnegative_header_number(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        candidate = float(value)
    except ValueError:
        return None
    if candidate < 0 or candidate == float("inf") or candidate != candidate:
        return None
    return candidate


def _timestamp_datetime(value: UtcTimestamp) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _private_api_key(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("api_key must be a string or None")
    if not value.strip() or any(character in value for character in "\r\n\x00"):
        raise ValueError("api_key must be a nonblank private value")
    return value


def _validate_access_inputs(
    http_client: HttpClient,
    access_coordinator: AccessCoordinator,
    access_scope: AccessScope,
    access_policy: AccessPolicy,
) -> None:
    if not isinstance(http_client, HttpClient):
        raise TypeError("http_client must be an HttpClient")
    if not isinstance(access_coordinator, AccessCoordinator):
        raise TypeError("access_coordinator must be an AccessCoordinator")
    if not isinstance(access_scope, AccessScope):
        raise TypeError("access_scope must be an AccessScope")
    if access_scope != ACCESS_SCOPE:
        raise ValueError("Springer Nature requires the Meta API v2 AccessScope")
    if not isinstance(access_policy, AccessPolicy):
        raise TypeError("access_policy must be an AccessPolicy")


def _validate_factories(
    observation_id_factory: Callable[[], ObservationId],
    provenance_id_factory: Callable[[], ProvenanceId],
    clock: Callable[[], UtcTimestamp],
) -> None:
    if not callable(observation_id_factory):
        raise TypeError("observation_id_factory must be callable")
    if not callable(provenance_id_factory):
        raise TypeError("provenance_id_factory must be callable")
    if not callable(clock):
        raise TypeError("clock must be callable")


def _validate_page_size(value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("page_size must be an integer")
    if not 1 <= value <= 25:
        raise ValueError("page_size must be between 1 and 25 for the basic Meta plan")


def _provider_failure(
    *,
    code: str,
    reason: str,
    action: str,
    retryable: bool,
) -> MetadataProviderFailure:
    return MetadataProviderFailure(
        StableFailure(
            code=code,
            reason=reason,
            action=action,
            retryable=retryable,
        )
    )


def _credentials_missing_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-credentials-missing",
        reason="The metadata provider requires a configured private API key.",
        action="Configure the provider credential before retrying this capability.",
        retryable=False,
    )


def _lookup_key_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-unsupported-key",
        reason="The metadata provider cannot use the requested lookup key.",
        action="Use a DOI for Springer Nature Meta API lookup.",
        retryable=False,
    )


def _protocol_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-protocol",
        reason="The metadata provider returned an inconsistent page boundary.",
        action="Retry the request or update the provider adapter.",
        retryable=True,
    )


def _http_status_failure(status: int) -> MetadataProviderFailure:
    if status == 401:
        return _provider_failure(
            code="metadata-provider-authentication",
            reason="The metadata provider did not accept the configured credential.",
            action="Review provider credential readiness before retrying.",
            retryable=False,
        )
    if status == 403:
        return _provider_failure(
            code="metadata-provider-entitlement",
            reason="The configured account cannot use the requested metadata product.",
            action="Review the provider product entitlement before retrying.",
            retryable=False,
        )
    if status == 429:
        return _provider_failure(
            code="metadata-provider-throttled",
            reason="The metadata provider temporarily throttled this access scope.",
            action="Retry after the shared provider access policy permits another request.",
            retryable=True,
        )
    return _provider_failure(
        code="metadata-provider-http-status",
        reason="The metadata provider returned an unsuccessful HTTP status.",
        action="Retry the metadata request or review provider readiness.",
        retryable=status >= 500,
    )


__all__ = (
    "ACCESS_SCOPE",
    "ADAPTER_REVISION",
    "BASELINE_ACCESS_POLICY",
    "SpringerMetaV2Adapter",
)
