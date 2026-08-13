"""CORE API v3 adapter for neutral Metadata provider capabilities."""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, overload
from urllib.parse import urlencode

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
    interpreted_access_feedback,
    optional_nonblank_string,
    parse_bounded_json,
    require_json_array,
    require_json_object,
    retry_after_feedback,
    stabilize_provider_metadata_observation,
    stabilize_provider_relation_observation,
    strict_nonnegative_integer,
)
from sciretriever.metadata.providers._shared.failures import (
    invalid_record_failure,
    unknown_shape_failure,
)
from sciretriever.metadata.rules import (
    NeutralMetadataItem,
    ReferenceQueryContext,
    TopicSearchQuery,
)
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
from sciretriever.model.literature import Author, AuthorKind, Identifier
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
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

_PROVIDER_NAME = "core"
_ORIGIN = "https://api.core.ac.uk"
_V3_ROOT = f"{_ORIGIN}/v3"
_SEARCH_WORKS = f"{_V3_ROOT}/search/works"
_CREDENTIAL_ORIGIN = Origin("https", "api.core.ac.uk", 443)
_MAX_RESPONSE_BYTES = 1_048_576
_CORE_RECORD_ID = re.compile(r"[A-Za-z0-9._-]+", re.ASCII)
_ISO_DATE = re.compile(r"(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})")

ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=6.0,
    burst_limit=10,
    window_seconds=60.0,
)

_DOCUMENT_TYPES = {
    "book": "book",
    "book chapter": "book-chapter",
    "conference paper": "conference-paper",
    "conference proceeding": "proceedings",
    "dissertation": "dissertation",
    "journal article": "journal-article",
    "preprint": "preprint",
    "report": "report",
    "research article": "journal-article",
    "review": "review",
    "thesis": "dissertation",
}


@dataclass(frozen=True, slots=True)
class _LookupTarget:
    entity: str
    locator: str
    expected: ProviderLiteratureKey


@dataclass(frozen=True, slots=True)
class _RawCoreRecord:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    entity: str
    expected: ProviderLiteratureKey | None = None


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


class CoreAdapter:
    """CORE v3 Work search, Work/Output lookup, and outgoing references."""

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
        page_size: int = 100,
        api_key: str | None = None,
    ) -> None:
        _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("CORE must share the HttpClient AccessCoordinator")
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
        self._page_size = page_size
        self._api_key = _normalize_api_key(api_key)

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe CORE Works using its verified one-result DOI query."""

        def operation() -> None:
            response = self._request(
                _SEARCH_WORKS
                + "?"
                + urlencode(
                    (
                        ("q", 'doi:"10.1038/s41597-023-02208-w"'),
                        ("offset", "0"),
                        ("limit", "1"),
                    )
                ),
                probe=True,
            )
            _items, _total_hits, response_limit, response_offset = _search_response_body(
                response.body
            )
            if response_limit != 1 or response_offset != 0:
                raise unknown_shape_failure()

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=self._api_key is not None,
        )

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        provider_query = _topic_query(query)

        def fetch_page(cursor: int | None) -> metadata_ports._RawPage[_RawCoreRecord, int]:
            requested_offset = 0 if cursor is None else cursor
            response = self._request(
                _SEARCH_WORKS
                + "?"
                + urlencode(
                    (
                        ("q", provider_query),
                        ("offset", str(requested_offset)),
                        ("limit", str(self._page_size)),
                    )
                )
            )
            items, total_hits, response_limit, response_offset = _search_response(response)
            if response_limit != self._page_size or response_offset != requested_offset:
                raise _protocol_failure()
            if len(items) > response_limit:
                raise _protocol_failure()
            input_sha256 = sha256_digest(response.transport.body)
            raw_items = tuple(
                _RawCoreRecord(
                    value=item,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                    entity="work",
                )
                for item in items
            )
            consumed = requested_offset + len(raw_items)
            if not raw_items and requested_offset < total_hits:
                raise _protocol_failure()
            exhausted = consumed >= total_hits
            return metadata_ports._RawPage(
                items=raw_items,
                next_cursor=None if exhausted else consumed,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        target = _lookup_target(key)

        def fetch_page(cursor: None) -> metadata_ports._RawPage[_RawCoreRecord, None]:
            if cursor is not None:
                raise TypeError("CORE lookup has no cursor")
            response = self._entity_request(target)
            raw = _RawCoreRecord(
                value=_single_response(response),
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                entity=target.entity,
                expected=target.expected,
            )
            return metadata_ports._RawPage(items=(raw,), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        if not isinstance(query, ReferenceQueryContext):
            raise TypeError("query must be a ReferenceQueryContext")
        if query.direction != "references":
            raise _unsupported_reference_direction_failure()
        targets = tuple(_lookup_target(key) for key in query.keys)

        def fetch_page(cursor: int | None) -> metadata_ports._RawPage[_RawCoreRecord, int]:
            index = 0 if cursor is None else cursor
            if index >= len(targets):
                return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)
            target = targets[index]
            response = self._entity_request(target)
            raw = _RawCoreRecord(
                value=_single_response(response),
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                entity=target.entity,
                expected=target.expected,
            )
            next_index = index + 1
            exhausted = next_index >= len(targets)
            return metadata_ports._RawPage(
                items=(raw,),
                next_cursor=None if exhausted else next_index,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def _entity_request(self, target: _LookupTarget) -> _ObservedResponse:
        endpoint = f"{_V3_ROOT}/{target.entity}s"
        return self._request(endpoint, path_parameter=target.locator)

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        probe: Literal[False] = False,
    ) -> _ObservedResponse: ...

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        probe: Literal[True],
    ) -> TransportResponse: ...

    def _request(  # noqa: C901 -- one request boundary owns feedback and status stabilization
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse:
        credential_headers: tuple[tuple[str, str], ...] = ()
        credential_allowed_origins: tuple[Origin, ...] = ()
        if self._api_key is not None:
            credential_headers = (("Authorization", f"Bearer {self._api_key}"),)
            credential_allowed_origins = (_CREDENTIAL_ORIGIN,)
        observed_at: UtcTimestamp | None = None
        feedback_failure: MetadataProviderFailure | None = None

        def response_feedback(response: TransportResponse) -> AccessFeedback | None:
            nonlocal observed_at, feedback_failure
            observed_at = None if probe else self._observed_at()
            try:
                feedback = _core_feedback(
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
                return _conservative_feedback_after_failure(response.status)
            if feedback is None and response.status >= 500:
                return AccessFeedback(throttled=True)
            return feedback

        result = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
            credential_headers=credential_headers,
            credential_allowed_origins=credential_allowed_origins,
            path_parameter=path_parameter,
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
        if result.status != 200:
            raise _http_status_failure(result.status)
        if probe:
            return result
        if observed_at is None:
            raise RuntimeError("HttpClient did not interpret the CORE response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _convert_record(self, envelope: _RawCoreRecord) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawCoreRecord):
            raise TypeError("raw CORE item must use the private envelope")
        record = require_json_object(envelope.value)
        source_record_id = _source_record_id(envelope.entity, record.get("id"))
        identifiers = _identifiers(record)
        current = ProviderLiteratureKey(
            record_id=source_record_id,
            identifiers=identifiers,
        )
        if envelope.expected is not None and not _positions_overlap(
            envelope.expected,
            current,
        ):
            raise invalid_record_failure()
        provenance = self._provenance(
            source_record_id=source_record_id,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        reference_texts, targets = _references(record.get("references"))
        try:
            observation = MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=LiteratureMetadata(
                    title=optional_nonblank_string(record.get("title")),
                    authors=_authors(record.get("authors")),
                    abstract=optional_nonblank_string(record.get("abstract")),
                    publication_date=_publication_date(record.get("publishedDate")),
                    publication_year=_publication_year(record.get("yearPublished")),
                    document_type=_document_type(record.get("documentType")),
                    language=optional_nonblank_string(record.get("language")),
                    venue=_venue(record.get("journals")),
                    publisher=optional_nonblank_string(record.get("publisher")),
                    volume=None,
                    issue=None,
                    pages=None,
                    identifiers=identifiers,
                    keywords=(),
                ),
                version_role=None,
                version_links=(),
                declared_keywords=(),
                reference_texts=reference_texts,
                reference_count=None,
                cited_by_count=None,
                asset_hints=_asset_hints(record, entity=envelope.entity),
            )
        except ValidationError:
            raise invalid_record_failure() from None
        relations: list[ProviderRelationObservation] = []
        for target in targets:
            if target == current:
                continue
            try:
                relations.append(
                    ProviderRelationObservation(
                        observation_id=self._new_observation_id(),
                        provenance=provenance,
                        citing=current,
                        cited=target,
                    )
                )
            except ValidationError:
                raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=(stabilize_provider_metadata_observation(observation),),
            relations=tuple(
                stabilize_provider_relation_observation(relation) for relation in relations
            ),
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
                parameters_sha256=None,
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


def _search_response(
    response: _ObservedResponse,
) -> tuple[tuple[object, ...], int, int, int]:
    return _search_response_body(response.transport.body)


def _search_response_body(
    body: bytes,
) -> tuple[tuple[object, ...], int, int, int]:
    root = require_json_object(parse_bounded_json(body, max_bytes=_MAX_RESPONSE_BYTES))
    required = ("totalHits", "limit", "offset", "results")
    if any(name not in root for name in required):
        raise unknown_shape_failure()
    total_hits = strict_nonnegative_integer(root.get("totalHits"))
    limit = strict_nonnegative_integer(root.get("limit"))
    offset = strict_nonnegative_integer(root.get("offset"))
    if limit < 1:
        raise unknown_shape_failure()
    return require_json_array(root.get("results")), total_hits, limit, offset


def _single_response(response: _ObservedResponse) -> object:
    return require_json_object(
        parse_bounded_json(response.transport.body, max_bytes=_MAX_RESPONSE_BYTES)
    )


def _topic_query(query: TopicSearchQuery) -> str:
    clauses = [_quoted_query_text(query.query)]
    if query.year_from is not None or query.year_to is not None:
        lower = query.year_from or 1
        upper = query.year_to or 9999
        clauses.append(f"yearPublished:[{lower} TO {upper}]")
    return " AND ".join(clauses)


def _quoted_query_text(value: str) -> str:
    normalized = " ".join(value.split())
    escaped = normalized.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _lookup_target(key: ProviderLiteratureKey) -> _LookupTarget:
    if key.record_id is not None:
        prefix, separator, raw_locator = key.record_id.partition(":")
        if separator and prefix.casefold() in {"work", "output"}:
            entity = prefix.casefold()
            locator = raw_locator.strip()
        elif not separator:
            entity = "work"
            locator = key.record_id
        else:
            raise _lookup_key_failure()
        if _CORE_RECORD_ID.fullmatch(locator) is None:
            raise _lookup_key_failure()
        expected = ProviderLiteratureKey(
            record_id=f"{entity}:{locator}",
            identifiers=key.identifiers,
        )
        return _LookupTarget(entity=entity, locator=locator, expected=expected)
    for identifier in key.identifiers:
        if identifier.namespace == "doi":
            return _LookupTarget(entity="work", locator=identifier.value, expected=key)
    raise _lookup_key_failure()


def _source_record_id(entity: str, value: object) -> str:
    if type(value) is int:
        raw = str(value)
    else:
        raw = optional_nonblank_string(value)
    if raw is None or _CORE_RECORD_ID.fullmatch(raw) is None:
        raise invalid_record_failure()
    return f"{entity}:{raw}"


def _identifiers(record: dict[str, object]) -> tuple[Identifier, ...]:
    result: list[Identifier] = []
    _append_identifier(result, "doi", record.get("doi"))
    _append_identifier(result, "arxiv", record.get("arxivId"))
    _append_identifier(result, "pmid", record.get("pubmedId"))
    raw_identifiers = record.get("identifiers")
    if raw_identifiers is not None:
        for raw_identifier in require_json_array(raw_identifiers):
            item = require_json_object(raw_identifier)
            namespace = optional_nonblank_string(item.get("type"))
            if namespace is None:
                continue
            folded = namespace.casefold()
            if folded == "pubmed":
                folded = "pmid"
            if folded in {"doi", "arxiv", "pmid", "pmcid"}:
                _append_identifier(result, folded, item.get("identifier"))
    return tuple(result)


def _append_identifier(result: list[Identifier], namespace: str, value: object) -> None:
    if type(value) is int and namespace == "pmid":
        raw = str(value)
    else:
        raw = optional_nonblank_string(value)
    if raw is None:
        return
    try:
        identifier = Identifier(namespace=namespace, value=raw)
    except ValidationError:
        raise invalid_record_failure() from None
    if identifier not in result:
        result.append(identifier)


def _authors(value: object) -> tuple[Author, ...]:
    if value is None:
        return ()
    result: list[Author] = []
    for raw_author in require_json_array(value):
        author = require_json_object(raw_author)
        display_name = optional_nonblank_string(author.get("name"))
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


def _publication_date(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    match = _ISO_DATE.match(raw)
    return match.group("date") if match is not None else raw


def _publication_year(value: object) -> int | None:
    if value is None:
        return None
    if type(value) is not int or not 1 <= value <= 9999:
        raise invalid_record_failure()
    return value


def _document_type(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    return _DOCUMENT_TYPES.get(raw.casefold())


def _venue(value: object) -> str | None:
    if value is None:
        return None
    for raw_journal in require_json_array(value):
        journal = require_json_object(raw_journal)
        title = optional_nonblank_string(journal.get("title"))
        if title is not None:
            return title
    return None


def _references(
    value: object,
) -> tuple[tuple[str, ...], tuple[ProviderLiteratureKey, ...]]:
    if value is None:
        return (), ()
    texts: list[str] = []
    targets: list[ProviderLiteratureKey] = []
    for raw_reference in require_json_array(value):
        reference = require_json_object(raw_reference)
        raw_text = optional_nonblank_string(reference.get("raw"))
        if raw_text is not None:
            texts.append(raw_text)
        target = _reference_target(reference)
        if target is not None and target not in targets:
            targets.append(target)
    return tuple(texts), tuple(targets)


def _reference_target(reference: dict[str, object]) -> ProviderLiteratureKey | None:
    raw_record_id = reference.get("id")
    if type(raw_record_id) is int:
        record_id = str(raw_record_id)
    else:
        record_id = optional_nonblank_string(raw_record_id)
    if record_id is not None and _CORE_RECORD_ID.fullmatch(record_id) is None:
        record_id = None
    raw_doi = optional_nonblank_string(reference.get("doi"))
    identifiers: tuple[Identifier, ...]
    if raw_doi is None:
        identifiers = ()
    else:
        try:
            identifiers = (Identifier(namespace="doi", value=raw_doi),)
        except ValidationError:
            raise invalid_record_failure() from None
    if record_id is None and not identifiers:
        return None
    try:
        return ProviderLiteratureKey(
            record_id=None if record_id is None else f"work:{record_id}",
            identifiers=identifiers,
        )
    except ValidationError:
        raise invalid_record_failure() from None


def _asset_hints(
    record: dict[str, object],
    *,
    entity: str,
) -> tuple[AssetHint, ...]:
    license_value = optional_nonblank_string(record.get("license")) if entity == "output" else None
    result: list[AssetHint] = []
    download_url = optional_nonblank_string(record.get("downloadUrl"))
    if download_url is not None:
        _append_hint(
            result,
            AssetHint(
                url=download_url,
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                license=license_value,
            ),
        )
    raw_source_urls = record.get("sourceFulltextUrls")
    if raw_source_urls is not None:
        for raw_url in require_json_array(raw_source_urls):
            url = optional_nonblank_string(raw_url)
            if url is None:
                continue
            _append_hint(
                result,
                AssetHint(
                    url=url,
                    kind=AssetHintKind.DIRECT_FILE,
                    license=license_value,
                ),
            )
    raw_links = record.get("links")
    if raw_links is not None:
        for raw_link in require_json_array(raw_links):
            link = require_json_object(raw_link)
            link_type = optional_nonblank_string(link.get("type"))
            url = optional_nonblank_string(link.get("url"))
            if link_type is None or url is None:
                continue
            folded = link_type.casefold()
            if folded == "download":
                hint = AssetHint(
                    url=url,
                    kind=AssetHintKind.DIRECT_FILE,
                    media_type="application/pdf",
                    asset_role=AssetRole.PRIMARY_PDF,
                    license=license_value,
                )
            elif folded in {"display", "reader"}:
                hint = AssetHint(
                    url=url,
                    kind=AssetHintKind.LANDING_PAGE,
                    license=license_value,
                )
            else:
                continue
            _append_hint(result, hint)
    return tuple(result)


def _append_hint(values: list[AssetHint], value: AssetHint) -> None:
    if value.url not in {item.url for item in values}:
        values.append(value)


def _positions_overlap(
    expected: ProviderLiteratureKey,
    actual: ProviderLiteratureKey,
) -> bool:
    if expected.record_id is not None and expected.record_id == actual.record_id:
        return True
    return any(identifier in actual.identifiers for identifier in expected.identifiers)


def _core_feedback(
    status: int,
    headers: tuple[Header, ...],
    *,
    wall_now: datetime,
) -> AccessFeedback | None:
    standard = retry_after_feedback(status, headers, wall_now=wall_now)
    custom_delay = _nonnegative_header_number(header_value(headers, "X-RateLimit-Retry-After"))
    remaining = _nonnegative_header_number(header_value(headers, "X-RateLimit-Remaining"))
    quota_exhausted = remaining == 0.0 if remaining is not None else False
    if standard is not None and standard.retry_after is not None:
        return standard
    if custom_delay is not None:
        return interpreted_access_feedback(
            monotonic_now=0.0,
            retry_after_seconds=custom_delay,
            throttled=status == 429 or quota_exhausted,
        )
    if standard is not None:
        return standard
    if quota_exhausted:
        return AccessFeedback(throttled=True)
    return None


def _nonnegative_header_number(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except ValueError:
        return None
    if not math.isfinite(result) or result < 0:
        return None
    return result


def _conservative_feedback_after_failure(status: int) -> AccessFeedback | None:
    if status == 429:
        return AccessFeedback(throttled=True)
    return None


def _normalize_api_key(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("api_key must be a string or None")
    candidate = value.strip()
    if not candidate:
        raise ValueError("api_key must be nonblank when supplied")
    if any(ord(character) < 32 or ord(character) == 127 for character in candidate):
        raise ValueError("api_key must not contain control characters")
    return candidate


def _timestamp_datetime(value: UtcTimestamp) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


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
        raise ValueError("CORE requires the shared core API AccessScope")
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
    if type(value) is not int:
        raise TypeError("page_size must be an integer")
    if not 1 <= value <= 100:
        raise ValueError("page_size must be between 1 and 100")


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


def _lookup_key_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-unsupported-key",
        reason="The metadata provider cannot use the requested lookup key.",
        action="Use a CORE Work/Output key or DOI.",
        retryable=False,
    )


def _unsupported_reference_direction_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-unsupported-reference-direction",
        reason="The metadata provider does not expose this reference direction.",
        action="Use the outgoing references direction for this provider.",
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
    if status == 429:
        return _provider_failure(
            code="metadata-provider-throttled",
            reason="The metadata provider temporarily throttled this access scope.",
            action="Retry after the shared provider access policy permits another request.",
            retryable=True,
        )
    if status in {401, 403}:
        return _provider_failure(
            code="metadata-provider-access-denied",
            reason="The metadata provider did not allow this request.",
            action="Review provider readiness before retrying the metadata request.",
            retryable=False,
        )
    return _provider_failure(
        code="metadata-provider-http-status",
        reason="The metadata provider returned an unsuccessful HTTP status.",
        action="Retry the metadata request or review provider readiness.",
        retryable=status >= 500,
    )


__all__ = ("ACCESS_SCOPE", "BASELINE_ACCESS_POLICY", "CoreAdapter")
