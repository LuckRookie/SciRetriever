"""Europe PMC REST adapter for neutral Metadata provider capabilities."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
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
    optional_nonblank_string,
    optional_nonnegative_integer,
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
from sciretriever.model.literature import (
    Affiliation,
    Author,
    AuthorKind,
    Identifier,
)
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

_PROVIDER_NAME = "europe-pmc"
_ORIGIN = "https://www.ebi.ac.uk"
_REST_ROOT = f"{_ORIGIN}/europepmc/webservices/rest"
_SEARCH_ENDPOINT = f"{_REST_ROOT}/search"
_MAX_RESPONSE_BYTES = 1_048_576
_SOURCE = re.compile(r"[A-Z][A-Z0-9_-]*", re.ASCII)
_YEAR = re.compile(r"[0-9]{4}", re.ASCII)
ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")

# Europe PMC publishes no current fixed anonymous numeric quota.  This is a
# project safety floor, not a claim about the provider's entitlement policy.
BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=1.0,
)

_DOCUMENT_TYPES = {
    "book": "book",
    "book chapter": "book-chapter",
    "clinical trial": "clinical-trial",
    "conference paper": "conference-paper",
    "dissertation": "dissertation",
    "journal article": "journal-article",
    "meta-analysis": "journal-article",
    "preprint": "preprint",
    "review": "review",
    "systematic review": "review",
}


@dataclass(frozen=True, slots=True)
class _RawRecord:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    expected: ProviderLiteratureKey | None = None


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _ReferenceTask:
    current: ProviderLiteratureKey
    source: str
    record_id: str
    kind: str


@dataclass(frozen=True, slots=True)
class _ReferenceCursor:
    task_index: int
    page: int


@dataclass(frozen=True, slots=True)
class _RawRelationItem:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    current: ProviderLiteratureKey
    kind: str


@dataclass(frozen=True, slots=True)
class _RecordPosition:
    record_id: str | None
    identifiers: tuple[Identifier, ...]

    @property
    def key(self) -> ProviderLiteratureKey:
        return ProviderLiteratureKey(
            record_id=self.record_id,
            identifiers=self.identifiers,
        )


class _MarkupText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        del attrs
        if tag.casefold() in {"script", "style"}:
            self._ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() in {"script", "style"} and self._ignored_depth:
            self._ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            self.parts.append(data)


class EuropePmcAdapter:
    """Europe PMC search, stable lookup, and bidirectional relation queries."""

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
    ) -> None:
        _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("Europe PMC must share the HttpClient AccessCoordinator")
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

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe public REST search with one documented PMCID."""

        def operation() -> None:
            response = self._request(
                _SEARCH_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("query", "PMCID:PMC7759461"),
                        ("resultType", "core"),
                        ("format", "json"),
                        ("pageSize", "1"),
                        ("cursorMark", "*"),
                    )
                ),
                probe=True,
            )
            _search_response_body(response.body)

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=False,
        )

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        provider_query = _topic_query(query)
        seen_items = 0

        def fetch_page(cursor: str | None) -> metadata_ports._RawPage[_RawRecord, str]:
            nonlocal seen_items
            response = self._request(
                _SEARCH_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("query", provider_query),
                        ("resultType", "core"),
                        ("format", "json"),
                        ("pageSize", str(self._page_size)),
                        ("cursorMark", "*" if cursor is None else cursor),
                    )
                )
            )
            items, hit_count, next_cursor = _search_response(response)
            input_sha256 = sha256_digest(response.transport.body)
            raw_items = tuple(
                _RawRecord(
                    value=item,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for item in items
            )
            seen_items += len(raw_items)
            if not raw_items:
                if seen_items < hit_count:
                    raise _protocol_failure()
                return metadata_ports._RawPage(
                    items=(),
                    next_cursor=None,
                    exhausted=True,
                )
            if seen_items >= hit_count:
                return metadata_ports._RawPage(
                    items=raw_items,
                    next_cursor=None,
                    exhausted=True,
                )
            requested_cursor = "*" if cursor is None else cursor
            if next_cursor is None or next_cursor == requested_cursor:
                raise _protocol_failure()
            return metadata_ports._RawPage(
                items=raw_items,
                next_cursor=next_cursor,
                exhausted=False,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        query = _lookup_query(key)

        def fetch_page(cursor: None) -> metadata_ports._RawPage[_RawRecord, None]:
            if cursor is not None:
                raise TypeError("Europe PMC lookup has no cursor")
            response = self._request(
                _SEARCH_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("query", query),
                        ("resultType", "core"),
                        ("format", "json"),
                        ("pageSize", "1"),
                        ("cursorMark", "*"),
                    )
                )
            )
            items, _hit_count, _next_cursor = _search_response(response)
            input_sha256 = sha256_digest(response.transport.body)
            raw_items = tuple(
                _RawRecord(
                    value=item,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                    expected=key,
                )
                for item in items[:1]
            )
            return metadata_ports._RawPage(
                items=raw_items,
                next_cursor=None,
                exhausted=True,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        if not isinstance(query, ReferenceQueryContext):
            raise TypeError("query must be a ReferenceQueryContext")
        tasks = _reference_tasks(query)

        def fetch_page(
            cursor: _ReferenceCursor | None,
        ) -> metadata_ports._RawPage[_RawRelationItem, _ReferenceCursor]:
            current_cursor = cursor or _ReferenceCursor(task_index=0, page=1)
            while current_cursor.task_index < len(tasks):
                task = tasks[current_cursor.task_index]
                response = self._request(
                    f"{_REST_ROOT}/{task.source}",
                    path_parameter=task.record_id,
                    path_parameter_suffix=task.kind,
                    query=(
                        ("format", "json"),
                        ("pageSize", str(self._page_size)),
                        ("page", str(current_cursor.page)),
                    ),
                )
                items, hit_count, offset = _relation_response(response, kind=task.kind)
                expected_offset = (current_cursor.page - 1) * self._page_size
                if offset is not None and offset != expected_offset:
                    raise _protocol_failure()
                input_sha256 = sha256_digest(response.transport.body)
                raw_items = tuple(
                    _RawRelationItem(
                        value=item,
                        input_sha256=input_sha256,
                        observed_at=response.observed_at,
                        current=task.current,
                        kind=task.kind,
                    )
                    for item in items
                )
                consumed = expected_offset + len(raw_items)
                if consumed < hit_count:
                    if not raw_items:
                        raise _protocol_failure()
                    next_cursor = _ReferenceCursor(
                        task_index=current_cursor.task_index,
                        page=current_cursor.page + 1,
                    )
                else:
                    next_cursor = _ReferenceCursor(
                        task_index=current_cursor.task_index + 1,
                        page=1,
                    )
                if raw_items:
                    exhausted = next_cursor.task_index >= len(tasks)
                    return metadata_ports._RawPage(
                        items=raw_items,
                        next_cursor=None if exhausted else next_cursor,
                        exhausted=exhausted,
                    )
                current_cursor = next_cursor
            return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(
            fetch_page,
            self._convert_relation_item,
        )

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        query: tuple[tuple[str, str], ...] = (),
        probe: Literal[False] = False,
    ) -> _ObservedResponse: ...

    @overload
    def _request(  # noqa: C901 -- one request boundary owns feedback and status stabilization
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        query: tuple[tuple[str, str], ...] = (),
        probe: Literal[True],
    ) -> TransportResponse: ...

    def _request(  # noqa: C901 -- one request boundary owns feedback and status stabilization
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        query: tuple[tuple[str, str], ...] = (),
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse:
        if query:
            url += "?" + urlencode(query)
        observed_at: UtcTimestamp | None = None
        feedback_failure: MetadataProviderFailure | None = None

        def response_feedback(response: TransportResponse) -> AccessFeedback | None:
            nonlocal observed_at, feedback_failure
            observed_at = None if probe else self._observed_at()
            try:
                feedback = retry_after_feedback(
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
            path_parameter=path_parameter,
            path_parameter_suffix=path_parameter_suffix,
            max_response_bytes=_MAX_RESPONSE_BYTES,
            max_redirects=0,
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
            raise RuntimeError("HttpClient did not interpret the Europe PMC response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _convert_record(self, envelope: _RawRecord) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawRecord):
            raise TypeError("raw Europe PMC item must use the private envelope")
        record = require_json_object(envelope.value)
        position = _record_position(record)
        if envelope.expected is not None and not _positions_overlap(
            envelope.expected,
            position.key,
        ):
            raise invalid_record_failure()
        observation = self._observation_from_record(
            record,
            position=position,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        return NeutralMetadataItem(observations=(observation,), relations=())

    def _observation_from_record(
        self,
        record: dict[str, object],
        *,
        position: _RecordPosition,
        input_sha256: Sha256,
        observed_at: UtcTimestamp,
    ) -> MetadataObservation:
        provenance = self._provenance(
            source_record_id=_required_position_record_id(position),
            input_sha256=input_sha256,
            observed_at=observed_at,
        )
        publication_date, publication_year = _publication(record)
        try:
            metadata = LiteratureMetadata(
                title=optional_nonblank_string(record.get("title")),
                authors=_authors(record.get("authorList")),
                abstract=_markup_text(record.get("abstractText")),
                publication_date=publication_date,
                publication_year=publication_year,
                document_type=_document_type(record.get("pubTypeList")),
                language=optional_nonblank_string(record.get("language")),
                venue=_journal_value(record, "title"),
                publisher=None,
                volume=_journal_info_value(record, "volume"),
                issue=_journal_info_value(record, "issue"),
                pages=optional_nonblank_string(record.get("pageInfo")),
                identifiers=position.identifiers,
                keywords=(),
            )
            observation = MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=metadata,
                version_role=None,
                version_links=(),
                declared_keywords=_keywords(record.get("keywordList")),
                reference_texts=(),
                reference_count=None,
                cited_by_count=optional_nonnegative_integer(record.get("citedByCount")),
                asset_hints=_asset_hints(record.get("fullTextUrlList")),
            )
            return stabilize_provider_metadata_observation(observation)
        except ValidationError:
            raise invalid_record_failure() from None

    def _convert_relation_item(self, envelope: _RawRelationItem) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawRelationItem):
            raise TypeError("raw Europe PMC relation item must use the private envelope")
        item = require_json_object(envelope.value)
        current_provenance = self._provenance(
            source_record_id=_require_record_id(envelope.current),
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        observations: list[MetadataObservation] = []
        raw_text = (
            optional_nonblank_string(item.get("unstructuredInformation"))
            if envelope.kind == "references"
            else None
        )
        if raw_text is not None:
            try:
                observations.append(
                    MetadataObservation(
                        observation_id=self._new_observation_id(),
                        provenance=current_provenance,
                        metadata=LiteratureMetadata(
                            identifiers=envelope.current.identifiers,
                        ),
                        reference_texts=(raw_text,),
                    )
                )
            except ValidationError:
                raise invalid_record_failure() from None

        related = _optional_relation_position(item)
        relations: tuple[ProviderRelationObservation, ...] = ()
        if related is not None:
            related_provenance = (
                current_provenance
                if related.record_id is None
                else self._provenance(
                    source_record_id=related.record_id,
                    input_sha256=envelope.input_sha256,
                    observed_at=envelope.observed_at,
                )
            )
            inline = _inline_metadata(item, identifiers=related.identifiers)
            try:
                observations.append(
                    MetadataObservation(
                        observation_id=self._new_observation_id(),
                        provenance=related_provenance,
                        metadata=inline,
                    )
                )
                if envelope.kind == "references":
                    citing, cited = envelope.current, related.key
                else:
                    citing, cited = related.key, envelope.current
                if citing != cited:
                    relations = (
                        ProviderRelationObservation(
                            observation_id=self._new_observation_id(),
                            provenance=current_provenance,
                            citing=citing,
                            cited=cited,
                        ),
                    )
            except ValidationError:
                raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=tuple(
                stabilize_provider_metadata_observation(observation) for observation in observations
            ),
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
) -> tuple[tuple[object, ...], int, str | None]:
    return _search_response_body(response.transport.body)


def _search_response_body(
    body: bytes,
) -> tuple[tuple[object, ...], int, str | None]:
    root = require_json_object(parse_bounded_json(body, max_bytes=_MAX_RESPONSE_BYTES))
    if "hitCount" not in root or "resultList" not in root:
        raise unknown_shape_failure()
    hit_count = strict_nonnegative_integer(root.get("hitCount"))
    result_list = require_json_object(root.get("resultList"))
    items = require_json_array(result_list.get("result"))
    next_cursor = optional_nonblank_string(root.get("nextCursorMark"))
    return items, hit_count, next_cursor


def _relation_response(
    response: _ObservedResponse,
    *,
    kind: str,
) -> tuple[tuple[object, ...], int, int | None]:
    root = require_json_object(
        parse_bounded_json(response.transport.body, max_bytes=_MAX_RESPONSE_BYTES)
    )
    if "hitCount" not in root:
        raise unknown_shape_failure()
    hit_count = strict_nonnegative_integer(root.get("hitCount"))
    container_name = "referenceList" if kind == "references" else "citationList"
    item_name = "reference" if kind == "references" else "citation"
    container = require_json_object(root.get(container_name))
    items = require_json_array(container.get(item_name))
    request = require_json_object(root.get("request"))
    offset = optional_nonnegative_integer(request.get("offSet"))
    return items, hit_count, offset


def _topic_query(query: TopicSearchQuery) -> str:
    clauses = [f"({query.query})"]
    if query.year_from is not None or query.year_to is not None:
        lower = query.year_from or 1
        upper = query.year_to or 9999
        clauses.append(f"FIRST_PDATE:[{lower:04d}-01-01 TO {upper:04d}-12-31]")
    return " AND ".join(clauses)


def _lookup_query(key: ProviderLiteratureKey) -> str:
    for identifier in key.identifiers:
        if identifier.namespace == "pmcid":
            return f"PMCID:{identifier.value}"
    for identifier in key.identifiers:
        if identifier.namespace == "pmid":
            return f"EXT_ID:{identifier.value} AND SRC:MED"
    for identifier in key.identifiers:
        if identifier.namespace == "doi":
            return f'DOI:"{identifier.value}"'
    if key.record_id is not None:
        source, record_id = _split_record_id(key.record_id)
        return f"EXT_ID:{record_id} AND SRC:{source}"
    raise _lookup_key_failure()


def _reference_tasks(query: ReferenceQueryContext) -> tuple[_ReferenceTask, ...]:
    kinds = {
        "references": ("references",),
        "cited-by": ("citations",),
        "both": ("references", "citations"),
    }[query.direction]
    tasks: list[_ReferenceTask] = []
    for key in query.keys:
        source, record_id = _reference_position(key)
        current = ProviderLiteratureKey(
            record_id=f"{source}:{record_id}",
            identifiers=key.identifiers,
        )
        tasks.extend(
            _ReferenceTask(
                current=current,
                source=source,
                record_id=record_id,
                kind=kind,
            )
            for kind in kinds
        )
    return tuple(tasks)


def _reference_position(key: ProviderLiteratureKey) -> tuple[str, str]:
    if key.record_id is not None:
        return _split_record_id(key.record_id)
    for identifier in key.identifiers:
        if identifier.namespace == "pmid":
            return "MED", identifier.value
        if identifier.namespace == "pmcid":
            return "PMC", identifier.value
    raise _lookup_key_failure()


def _split_record_id(value: str) -> tuple[str, str]:
    source, separator, record_id = value.partition(":")
    source = source.strip().upper()
    record_id = record_id.strip()
    if not separator or _SOURCE.fullmatch(source) is None or not record_id:
        raise _lookup_key_failure()
    return source, record_id


def _record_position(record: dict[str, object]) -> _RecordPosition:
    source = optional_nonblank_string(record.get("source"))
    record_id = optional_nonblank_string(record.get("id"))
    if source is None or record_id is None:
        raise invalid_record_failure()
    source = source.upper()
    if _SOURCE.fullmatch(source) is None:
        raise invalid_record_failure()
    identifiers = _record_identifiers(record)
    return _RecordPosition(
        record_id=f"{source}:{record_id}",
        identifiers=identifiers,
    )


def _optional_relation_position(record: dict[str, object]) -> _RecordPosition | None:
    source = optional_nonblank_string(record.get("source"))
    record_id = optional_nonblank_string(record.get("id"))
    identifiers = _record_identifiers(record)
    if source is not None or record_id is not None:
        if source is None or record_id is None:
            raise invalid_record_failure()
        source = source.upper()
        if _SOURCE.fullmatch(source) is None:
            raise invalid_record_failure()
        provider_record_id = f"{source}:{record_id}"
    elif identifiers:
        provider_record_id = None
    else:
        return None
    return _RecordPosition(
        record_id=provider_record_id,
        identifiers=identifiers,
    )


def _record_identifiers(record: dict[str, object]) -> tuple[Identifier, ...]:
    values: list[Identifier] = []
    for field_name, namespace in (("pmid", "pmid"), ("pmcid", "pmcid"), ("doi", "doi")):
        raw = optional_nonblank_string(record.get(field_name))
        if raw is None:
            continue
        try:
            identifier = Identifier(namespace=namespace, value=raw)
        except ValidationError:
            raise invalid_record_failure() from None
        if identifier not in values:
            values.append(identifier)
    return tuple(values)


def _positions_overlap(
    expected: ProviderLiteratureKey,
    actual: ProviderLiteratureKey,
) -> bool:
    if expected.record_id is not None:
        try:
            source, record_id = _split_record_id(expected.record_id)
        except MetadataProviderFailure:
            pass
        else:
            if actual.record_id == f"{source}:{record_id}":
                return True
    return any(identifier in actual.identifiers for identifier in expected.identifiers)


def _publication(record: dict[str, object]) -> tuple[str | None, int | None]:
    publication_date = optional_nonblank_string(record.get("firstPublicationDate"))
    if publication_date is None:
        publication_date = _journal_info_value(record, "dateOfPublication")
    raw_year = record.get("pubYear")
    if raw_year is None:
        match = _YEAR.match(publication_date or "")
        return publication_date, int(match.group()) if match is not None else None
    if type(raw_year) is int:
        year = raw_year
    elif type(raw_year) is str and _YEAR.fullmatch(raw_year.strip()) is not None:
        year = int(raw_year.strip())
    else:
        raise invalid_record_failure()
    if not 1 <= year <= 9999:
        raise invalid_record_failure()
    return publication_date, year


def _authors(value: object) -> tuple[Author, ...]:
    if value is None:
        return ()
    container = require_json_object(value)
    raw_authors = require_json_array(container.get("author"))
    result: list[Author] = []
    for raw_author in raw_authors:
        author = require_json_object(raw_author)
        collective_name = optional_nonblank_string(author.get("collectiveName"))
        display_name = collective_name or optional_nonblank_string(author.get("fullName"))
        if display_name is None:
            continue
        kind = AuthorKind.ORGANIZATION if collective_name is not None else AuthorKind.UNKNOWN
        given_name = (
            None
            if collective_name is not None
            else optional_nonblank_string(author.get("firstName"))
        )
        family_name = (
            None
            if collective_name is not None
            else optional_nonblank_string(author.get("lastName"))
        )
        try:
            converted = Author(
                kind=kind,
                display_name=display_name,
                given_name=given_name,
                family_name=family_name,
                orcid=_nested_orcid(author.get("authorId")),
                affiliations=_affiliations(author.get("authorAffiliationDetailsList")),
            )
            if collective_name is None and converted.orcid is not None:
                converted = converted.model_copy(update={"kind": AuthorKind.PERSON})
            result.append(converted)
        except ValidationError:
            raise invalid_record_failure() from None
    return tuple(result)


def _nested_orcid(value: object) -> str | None:
    if value is None:
        return None
    author_id = require_json_object(value)
    identifier_type = optional_nonblank_string(author_id.get("type"))
    if identifier_type is None or identifier_type.casefold() != "orcid":
        return None
    raw = optional_nonblank_string(author_id.get("value"))
    if raw is None:
        return None
    prefix = "https://orcid.org/"
    return raw[len(prefix) :] if raw.casefold().startswith(prefix) else raw


def _affiliations(value: object) -> tuple[Affiliation, ...]:
    if value is None:
        return ()
    container = require_json_object(value)
    raw_values = require_json_array(container.get("authorAffiliation"))
    result: list[Affiliation] = []
    for raw_value in raw_values:
        affiliation = require_json_object(raw_value)
        name = optional_nonblank_string(affiliation.get("affiliation"))
        if name is None:
            continue
        try:
            result.append(Affiliation(name=name))
        except ValidationError:
            raise invalid_record_failure() from None
    return tuple(result)


def _markup_text(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    parser = _MarkupText()
    try:
        parser.feed(raw)
        parser.close()
    except (AssertionError, ValueError):
        raise invalid_record_failure() from None
    normalized = " ".join(" ".join(parser.parts).split())
    return normalized or None


def _document_type(value: object) -> str | None:
    if value is None:
        return None
    container = require_json_object(value)
    raw_types = require_json_array(container.get("pubType"))
    for raw_type in raw_types:
        candidate = optional_nonblank_string(raw_type)
        if candidate is not None and candidate.casefold() in _DOCUMENT_TYPES:
            return _DOCUMENT_TYPES[candidate.casefold()]
    return None


def _keywords(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    container = require_json_object(value)
    raw_values = require_json_array(container.get("keyword"))
    return tuple(
        candidate
        for item in raw_values
        if (candidate := optional_nonblank_string(item)) is not None
    )


def _journal_info(record: dict[str, object]) -> dict[str, object] | None:
    value = record.get("journalInfo")
    return None if value is None else require_json_object(value)


def _journal_info_value(record: dict[str, object], field_name: str) -> str | None:
    value = _journal_info(record)
    return None if value is None else optional_nonblank_string(value.get(field_name))


def _journal_value(record: dict[str, object], field_name: str) -> str | None:
    info = _journal_info(record)
    if info is None or info.get("journal") is None:
        return None
    journal = require_json_object(info.get("journal"))
    return optional_nonblank_string(journal.get(field_name))


def _asset_hints(value: object) -> tuple[AssetHint, ...]:
    if value is None:
        return ()
    container = require_json_object(value)
    raw_values = require_json_array(container.get("fullTextUrl"))
    result: list[AssetHint] = []
    for raw_value in raw_values:
        item = require_json_object(raw_value)
        url = optional_nonblank_string(item.get("url"))
        style = optional_nonblank_string(item.get("documentStyle"))
        if url is None or style is None:
            continue
        normalized_style = style.casefold()
        if normalized_style == "pdf":
            hint = AssetHint(
                url=url,
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                access_status=optional_nonblank_string(item.get("availability")),
            )
        elif normalized_style == "html":
            hint = AssetHint(
                url=url,
                kind=AssetHintKind.LANDING_PAGE,
                media_type="text/html",
                asset_role=AssetRole.HTML,
                access_status=optional_nonblank_string(item.get("availability")),
            )
        elif normalized_style == "doi":
            hint = AssetHint(
                url=url,
                kind=AssetHintKind.LANDING_PAGE,
                access_status=optional_nonblank_string(item.get("availability")),
            )
        else:
            continue
        if hint not in result:
            result.append(hint)
    return tuple(result)


def _inline_metadata(
    item: dict[str, object],
    *,
    identifiers: tuple[Identifier, ...],
) -> LiteratureMetadata:
    raw_year = item.get("pubYear")
    if raw_year is None:
        year = None
    elif type(raw_year) is int and 1 <= raw_year <= 9999:
        year = raw_year
    elif type(raw_year) is str and _YEAR.fullmatch(raw_year.strip()) is not None:
        year = int(raw_year.strip())
    else:
        raise invalid_record_failure()
    try:
        return LiteratureMetadata(
            title=optional_nonblank_string(item.get("title")),
            publication_year=year,
            venue=optional_nonblank_string(item.get("journalAbbreviation")),
            volume=optional_nonblank_string(item.get("volume")),
            issue=optional_nonblank_string(item.get("issue")),
            pages=optional_nonblank_string(item.get("pageInfo")),
            identifiers=identifiers,
        )
    except ValidationError:
        raise invalid_record_failure() from None


def _require_record_id(key: ProviderLiteratureKey) -> str:
    if key.record_id is None:
        raise _lookup_key_failure()
    return key.record_id


def _required_position_record_id(position: _RecordPosition) -> str:
    if position.record_id is None:
        raise invalid_record_failure()
    return position.record_id


def _conservative_feedback_after_failure(status: int) -> AccessFeedback | None:
    if status == 429:
        return AccessFeedback(throttled=True)
    return None


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
        raise ValueError("Europe PMC requires the shared europe-pmc API AccessScope")
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
    if not 1 <= value <= 1_000:
        raise ValueError("page_size must be between 1 and 1000")


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
        action="Use a Europe PMC record key, PMID, PMCID, or DOI.",
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


__all__ = ("ACCESS_SCOPE", "BASELINE_ACCESS_POLICY", "EuropePmcAdapter")
