"""Scopus Search and Abstract Retrieval JSON adapter.

The adapter revision records the official response families checked on
2026-08-07.  Scopus is an aggregate metadata index: its records and links do
not assert that Elsevier owns, licenses, or has downloaded any full text.
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
    stabilize_provider_relation_observation,
)
from sciretriever.metadata.providers._shared.failures import unknown_shape_failure
from sciretriever.metadata.rules import NeutralMetadataItem, TopicSearchQuery
from sciretriever.model.access import (
    AccessFailure,
    Header,
    TransportResponse,
    has_sensitive_query_parameter,
)
from sciretriever.model.acquisition import AssetHint, AssetHintKind
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
from sciretriever.network.policy import Origin

_PROVIDER_NAME = "elsevier"
_ORIGIN = "https://api.elsevier.com"
_SEARCH_ENDPOINT = f"{_ORIGIN}/content/search/scopus"
_ABSTRACT_ROOT = f"{_ORIGIN}/content/abstract"
_CREDENTIAL_ORIGIN = Origin("https", "api.elsevier.com", 443)
_MAX_RESPONSE_BYTES = 4_194_304
_EID = re.compile(r"^2-s2\.0-[1-9][0-9]*$", re.ASCII)
_SCOPUS_ID = re.compile(r"^SCOPUS_ID:([1-9][0-9]*)$", re.IGNORECASE | re.ASCII)
_YEAR_PREFIX = re.compile(r"^(?P<year>[0-9]{4})(?:-|$)", re.ASCII)

ADAPTER_REVISION = "scopus-json-2026-08-07"
ACCESS_SCOPE = AccessScope(
    provider_name=_PROVIDER_NAME,
    channel="api",
    service_name="scopus",
)
BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=0.125,
    burst_limit=10_000,
    window_seconds=604_800.0,
)

_RecordMode = Literal["search", "abstract"]

_DOCUMENT_TYPES = {
    "article": "journal-article",
    "book": "book",
    "book chapter": "book-chapter",
    "conference paper": "conference-paper",
    "conference review": "conference-paper",
    "editorial": "editorial",
    "erratum": "correction",
    "letter": "letter",
    "note": "note",
    "review": "review",
    "short survey": "review",
}


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _RawScopusRecord:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    mode: _RecordMode
    expected: ProviderLiteratureKey | None = None


@dataclass(frozen=True, slots=True)
class _LookupTarget:
    endpoint: str
    path_parameter: str
    expected: ProviderLiteratureKey


class ElsevierScopusAdapter:
    """Scopus topic search and exact Abstract Retrieval lookup."""

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
        institution_token: str | None = None,
        page_size: int = 25,
    ) -> None:
        _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("Elsevier must share the HttpClient AccessCoordinator")
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
        self._institution_token = _private_institution_token(institution_token)
        self._page_size = page_size

    def __repr__(self) -> str:
        return (
            f"<ElsevierScopusAdapter api_key_configured={self._api_key is not None} "
            "institution_token_configured="
            f"{self._institution_token is not None}>"
        )

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe the selected Scopus product with one minimal search result."""

        def operation() -> None:
            response = self._request(
                _SEARCH_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("query", 'TITLE-ABS-KEY("metadata")'),
                        ("cursor", "*"),
                        ("count", "1"),
                        ("view", "COMPLETE"),
                    )
                ),
                probe=True,
            )
            _search_page(
                response.body,
                requested_cursor="*",
                page_size=1,
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
            cursor: str | None,
        ) -> metadata_ports._RawPage[_RawScopusRecord, str]:
            nonlocal seen_items
            requested_cursor = "*" if cursor is None else cursor
            response = self._request(
                _SEARCH_ENDPOINT
                + "?"
                + urlencode(
                    (
                        ("query", provider_query),
                        ("cursor", requested_cursor),
                        ("count", str(self._page_size)),
                        ("view", "COMPLETE"),
                    )
                )
            )
            assert response is not None
            values, next_cursor, total, start = _search_page(
                response.transport.body,
                requested_cursor=requested_cursor,
                page_size=self._page_size,
            )
            if start != seen_items:
                raise _protocol_failure()
            if not values:
                if total == 0 and seen_items == 0 and next_cursor is None:
                    return metadata_ports._RawPage(
                        items=(),
                        next_cursor=None,
                        exhausted=True,
                    )
                raise _protocol_failure()
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawScopusRecord(
                    value=value,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                    mode="search",
                )
                for value in values
            )
            seen_items += len(items)
            if next_cursor is None:
                if seen_items != total:
                    raise _protocol_failure()
                exhausted = True
            else:
                if seen_items >= total:
                    raise _protocol_failure()
                exhausted = False
            return metadata_ports._RawPage(
                items=items,
                next_cursor=None if exhausted else next_cursor,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        target = _lookup_target(key)

        def fetch_page(
            cursor: None,
        ) -> metadata_ports._RawPage[_RawScopusRecord, None]:
            if cursor is not None:
                raise TypeError("Scopus Abstract Retrieval lookup has no cursor")
            response = self._request(
                f"{target.endpoint}?{urlencode((('view', 'FULL'),))}",
                path_parameter=target.path_parameter,
                allow_not_found=True,
            )
            if response is None:
                return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)
            root = require_json_object(
                parse_bounded_json(
                    response.transport.body,
                    max_bytes=_MAX_RESPONSE_BYTES,
                )
            )
            if "abstracts-retrieval-response" not in root:
                raise unknown_shape_failure()
            value = root.get("abstracts-retrieval-response")
            require_json_object(value)
            raw = _RawScopusRecord(
                value=value,
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                mode="abstract",
                expected=target.expected,
            )
            return metadata_ports._RawPage(items=(raw,), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        allow_not_found: Literal[False] = False,
        probe: Literal[False] = False,
    ) -> _ObservedResponse: ...

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        allow_not_found: Literal[True],
        probe: Literal[False] = False,
    ) -> _ObservedResponse | None: ...

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        allow_not_found: bool = False,
        probe: Literal[True],
    ) -> TransportResponse: ...

    def _request(  # noqa: C901 -- one request boundary owns feedback and status stabilization
        self,
        url: str,
        *,
        path_parameter: str | None = None,
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
                return _elsevier_feedback(
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

        credential_headers = _elsevier_credential_headers(
            self._api_key,
            self._institution_token,
        )
        result = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
            credential_headers=credential_headers,
            credential_allowed_origins=(_CREDENTIAL_ORIGIN,),
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
        if not probe and allow_not_found and result.status == 404:
            return None
        if result.status != 200:
            raise _http_status_failure(result.status)
        if probe:
            return result
        if observed_at is None:
            raise RuntimeError("HttpClient did not interpret the Elsevier response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _convert_record(self, envelope: _RawScopusRecord) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawScopusRecord):
            raise TypeError("raw Scopus item must use the private envelope")
        record = require_json_object(envelope.value)
        coredata = (
            require_json_object(record.get("coredata")) if envelope.mode == "abstract" else record
        )
        source_record_id = _source_record_id(coredata)
        identifiers = _identifiers(coredata)
        current = ProviderLiteratureKey(
            record_id=source_record_id,
            identifiers=identifiers,
        )
        if envelope.expected is not None and not _matches_expected(
            envelope.expected,
            current,
            aliases=_record_aliases(coredata),
        ):
            raise invalid_record_failure()
        affiliations = _affiliation_map(
            record.get("affiliation")
            if envelope.mode == "abstract"
            else coredata.get("affiliation")
        )
        raw_authors: object
        if envelope.mode == "abstract":
            authors_container = record.get("authors")
            raw_authors = (
                None
                if authors_container is None
                else require_json_object(authors_container).get("author")
            )
        else:
            raw_authors = coredata.get("author")
        reference_texts, targets, reference_count = (
            _bibliography(record) if envelope.mode == "abstract" else ((), (), None)
        )
        provenance = self._provenance(
            source_record_id=source_record_id,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
            mode=envelope.mode,
        )
        publication_date = optional_nonblank_string(coredata.get("prism:coverDate"))
        try:
            observation = MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=LiteratureMetadata(
                    title=optional_nonblank_string(coredata.get("dc:title")),
                    authors=_authors(raw_authors, affiliations),
                    abstract=optional_nonblank_string(coredata.get("dc:description")),
                    publication_date=publication_date,
                    publication_year=_publication_year(publication_date),
                    document_type=_document_type(coredata),
                    language=optional_nonblank_string(coredata.get("language")),
                    venue=optional_nonblank_string(coredata.get("prism:publicationName")),
                    publisher=optional_nonblank_string(coredata.get("dc:publisher")),
                    volume=optional_nonblank_string(coredata.get("prism:volume")),
                    issue=optional_nonblank_string(coredata.get("prism:issueIdentifier")),
                    pages=optional_nonblank_string(coredata.get("prism:pageRange")),
                    identifiers=identifiers,
                    keywords=(),
                ),
                version_role=None,
                version_links=(),
                declared_keywords=_declared_keywords(
                    record.get("authkeywords")
                    if envelope.mode == "abstract"
                    else coredata.get("authkeywords")
                ),
                reference_texts=reference_texts,
                reference_count=reference_count,
                cited_by_count=_optional_vendor_integer(coredata.get("citedby-count")),
                asset_hints=_asset_hints(coredata.get("link")),
            )
        except ValidationError:
            raise invalid_record_failure() from None
        relations: list[ProviderRelationObservation] = []
        for target in targets:
            if _keys_overlap(current, target):
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
        mode: _RecordMode,
    ) -> Provenance:
        parameters = sha256_digest(f"{ADAPTER_REVISION}:{mode}".encode("utf-8"))
        try:
            return Provenance(
                provenance_id=self._new_provenance_id(),
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name=_PROVIDER_NAME,
                source_record_id=source_record_id,
                observed_at=observed_at,
                input_sha256=input_sha256,
                parameters_sha256=parameters,
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


def _search_page(
    payload: bytes,
    *,
    requested_cursor: str,
    page_size: int,
) -> tuple[tuple[object, ...], str | None, int, int]:
    root = require_json_object(parse_bounded_json(payload, max_bytes=_MAX_RESPONSE_BYTES))
    if "search-results" not in root:
        raise unknown_shape_failure()
    results = require_json_object(root.get("search-results"))
    required = (
        "opensearch:totalResults",
        "opensearch:startIndex",
        "opensearch:itemsPerPage",
        "cursor",
        "entry",
    )
    if any(name not in results for name in required):
        raise unknown_shape_failure()
    total = _vendor_integer(results.get("opensearch:totalResults"))
    start = _vendor_integer(results.get("opensearch:startIndex"))
    reported_count = _vendor_integer(results.get("opensearch:itemsPerPage"))
    values = require_json_array(results.get("entry"))
    if reported_count != len(values) or len(values) > page_size:
        raise _protocol_failure()
    cursor = require_json_object(results.get("cursor"))
    current = optional_nonblank_string(cursor.get("@current"))
    if current != requested_cursor:
        raise _protocol_failure()
    next_cursor = optional_nonblank_string(cursor.get("@next"))
    if next_cursor == requested_cursor:
        raise _protocol_failure()
    return values, next_cursor, total, start


def _topic_query(query: TopicSearchQuery) -> str:
    escaped = " ".join(query.query.split()).replace("\\", "\\\\").replace('"', '\\"')
    clauses = [f'TITLE-ABS-KEY("{escaped}")']
    if query.year_from is not None:
        clauses.append(f"PUBYEAR AFT {query.year_from - 1}")
    if query.year_to is not None:
        clauses.append(f"PUBYEAR BEF {query.year_to + 1}")
    return " AND ".join(clauses)


def _lookup_target(key: ProviderLiteratureKey) -> _LookupTarget:
    if key.record_id is not None:
        record_id = key.record_id.strip()
        if _EID.fullmatch(record_id) is not None:
            return _LookupTarget(
                endpoint=f"{_ABSTRACT_ROOT}/eid",
                path_parameter=record_id,
                expected=key,
            )
        scopus_match = _SCOPUS_ID.fullmatch(record_id)
        if scopus_match is not None:
            return _LookupTarget(
                endpoint=f"{_ABSTRACT_ROOT}/scopus_id",
                path_parameter=scopus_match.group(1),
                expected=key,
            )
    for identifier in key.identifiers:
        endpoint_name = {"doi": "doi", "pmid": "pubmed_id"}.get(identifier.namespace)
        if endpoint_name is not None:
            return _LookupTarget(
                endpoint=f"{_ABSTRACT_ROOT}/{endpoint_name}",
                path_parameter=identifier.value,
                expected=key,
            )
    raise _lookup_key_failure()


def _source_record_id(record: dict[str, object]) -> str:
    eid = optional_nonblank_string(record.get("eid"))
    if eid is not None:
        if _EID.fullmatch(eid) is None:
            raise invalid_record_failure()
        return eid
    scopus_id = optional_nonblank_string(record.get("dc:identifier"))
    if scopus_id is None or _SCOPUS_ID.fullmatch(scopus_id) is None:
        raise invalid_record_failure()
    return f"SCOPUS_ID:{_SCOPUS_ID.fullmatch(scopus_id).group(1)}"  # type: ignore[union-attr]


def _record_aliases(record: dict[str, object]) -> tuple[str, ...]:
    values: list[str] = []
    for name in ("eid", "dc:identifier"):
        value = optional_nonblank_string(record.get(name))
        if value is not None:
            values.append(value)
    return tuple(values)


def _identifiers(record: dict[str, object]) -> tuple[Identifier, ...]:
    result: list[Identifier] = []
    _append_identifier(result, "doi", record.get("prism:doi"), strict=True)
    _append_identifier(result, "pmid", record.get("pubmed-id"), strict=True)
    _append_identifier(result, "pmid", record.get("pubmed_id"), strict=True)
    return tuple(result)


def _append_identifier(
    values: list[Identifier],
    namespace: str,
    raw_value: object,
    *,
    strict: bool,
) -> None:
    raw = optional_nonblank_string(raw_value)
    if raw is None:
        return
    try:
        identifier = Identifier(namespace=namespace, value=raw)
    except ValidationError:
        if strict:
            raise invalid_record_failure() from None
        return
    if identifier not in values:
        values.append(identifier)


def _affiliation_map(value: object) -> dict[str, Affiliation | None]:
    if value is None:
        return {}
    result: dict[str, Affiliation | None] = {}
    for raw_item in require_json_array(value):
        item = require_json_object(raw_item)
        record_id = _first_text(item.get("@id"), item.get("afid"))
        name = _first_text(
            item.get("affilname"),
            item.get("affiliation-name"),
            item.get("dc:title"),
        )
        if record_id is None or name is None:
            continue
        try:
            affiliation = Affiliation(name=name)
        except ValidationError:
            raise invalid_record_failure() from None
        if record_id in result:
            result[record_id] = None
        else:
            result[record_id] = affiliation
    return result


def _authors(
    value: object,
    affiliations: dict[str, Affiliation | None],
) -> tuple[Author, ...]:
    if value is None:
        return ()
    result: list[Author] = []
    for raw_item in require_json_array(value):
        item = require_json_object(raw_item)
        display_name = _first_text(
            item.get("ce:indexed-name"),
            item.get("authname"),
            item.get("preferred-name"),
        )
        given_name = _first_text(item.get("ce:given-name"), item.get("given-name"))
        family_name = _first_text(item.get("ce:surname"), item.get("surname"))
        if display_name is None:
            if given_name is None and family_name is None:
                continue
            display_name = " ".join(part for part in (given_name, family_name) if part is not None)
        orcid = _orcid(item.get("orcid"))
        kind = (
            AuthorKind.PERSON
            if given_name is not None or family_name is not None or orcid is not None
            else AuthorKind.UNKNOWN
        )
        aligned: list[Affiliation] = []
        raw_refs = item.get("affiliation")
        if raw_refs is None:
            raw_refs = item.get("afid")
        if raw_refs is not None:
            for raw_ref in require_json_array(raw_refs):
                reference = (
                    _first_text(
                        require_json_object(raw_ref).get("@id"),
                        require_json_object(raw_ref).get("$"),
                    )
                    if type(raw_ref) is dict
                    else optional_nonblank_string(raw_ref)
                )
                affiliation = None if reference is None else affiliations.get(reference)
                if affiliation is not None and affiliation not in aligned:
                    aligned.append(affiliation)
        try:
            result.append(
                Author(
                    kind=kind,
                    display_name=display_name,
                    given_name=given_name,
                    family_name=family_name,
                    orcid=orcid,
                    affiliations=tuple(aligned),
                )
            )
        except ValidationError:
            raise invalid_record_failure() from None
    return tuple(result)


def _orcid(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    prefix = "https://orcid.org/"
    return raw[len(prefix) :] if raw.casefold().startswith(prefix) else raw


def _declared_keywords(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if type(value) is str:
        keyword = optional_nonblank_string(value)
        return () if keyword is None else (keyword,)
    container = require_json_object(value)
    raw_values = container.get("author-keyword")
    if raw_values is None:
        return ()
    result: list[str] = []
    for raw_item in require_json_array(raw_values):
        keyword = _text_value(raw_item)
        if keyword is not None and keyword not in result:
            result.append(keyword)
    return tuple(result)


def _bibliography(
    record: dict[str, object],
) -> tuple[
    tuple[str, ...],
    tuple[ProviderLiteratureKey, ...],
    int | None,
]:
    item = _optional_object(record.get("item"))
    bibrecord = None if item is None else _optional_object(item.get("bibrecord"))
    tail = None if bibrecord is None else _optional_object(bibrecord.get("tail"))
    bibliography = None if tail is None else _optional_object(tail.get("bibliography"))
    if bibliography is None:
        return (), (), None
    reference_count = _optional_vendor_integer(bibliography.get("@refcount"))
    raw_references = bibliography.get("reference")
    if raw_references is None:
        return (), (), reference_count
    texts: list[str] = []
    targets: list[ProviderLiteratureKey] = []
    for raw_reference in require_json_array(raw_references):
        reference = require_json_object(raw_reference)
        text = _text_value(reference.get("ref-fulltext"))
        if text is not None:
            texts.append(text)
        target = _reference_target(reference)
        if target is not None and target not in targets:
            targets.append(target)
    return tuple(texts), tuple(targets), reference_count


def _reference_target(
    reference: dict[str, object],
) -> ProviderLiteratureKey | None:
    info = _optional_object(reference.get("ref-info"))
    id_list = None if info is None else _optional_object(info.get("refd-itemidlist"))
    raw_values = None if id_list is None else id_list.get("itemid")
    if raw_values is None:
        return None
    identifiers: list[Identifier] = []
    record_id: str | None = None
    for raw_item in require_json_array(raw_values):
        item = require_json_object(raw_item)
        id_type = optional_nonblank_string(item.get("@idtype"))
        value = _text_value(item)
        if id_type is None or value is None:
            continue
        folded = id_type.casefold().replace("-", "_")
        namespace = {
            "doi": "doi",
            "pmid": "pmid",
            "pubmed": "pmid",
            "pubmed_id": "pmid",
            "pmcid": "pmcid",
            "arxiv": "arxiv",
        }.get(folded)
        if namespace is not None:
            _append_identifier(identifiers, namespace, value, strict=False)
            continue
        if folded in {"eid", "scopus", "scopus_id"}:
            if _EID.fullmatch(value) is not None:
                record_id = value
            elif value.isdigit() and int(value) > 0:
                record_id = f"SCOPUS_ID:{value}"
    if record_id is None and not identifiers:
        return None
    try:
        return ProviderLiteratureKey(
            record_id=record_id,
            identifiers=tuple(identifiers),
        )
    except ValidationError:
        raise invalid_record_failure() from None


def _asset_hints(value: object) -> tuple[AssetHint, ...]:
    if value is None:
        return ()
    result: list[AssetHint] = []
    for raw_item in require_json_array(value):
        item = require_json_object(raw_item)
        reference = optional_nonblank_string(item.get("@ref"))
        url = optional_nonblank_string(item.get("@href"))
        if (
            reference is None
            or reference.casefold() not in {"scopus", "full-text"}
            or url is None
            or not _is_safe_https_url(url)
        ):
            continue
        try:
            hint = AssetHint(url=url, kind=AssetHintKind.LANDING_PAGE)
        except ValidationError:
            continue
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


def _document_type(record: dict[str, object]) -> str | None:
    raw = _first_text(record.get("subtypeDescription"), record.get("subtype"))
    if raw is None:
        return None
    return _DOCUMENT_TYPES.get(raw.casefold(), raw)


def _publication_year(publication_date: str | None) -> int | None:
    if publication_date is None:
        return None
    match = _YEAR_PREFIX.match(publication_date)
    if match is None:
        return None
    year = int(match.group("year"))
    return year if 1 <= year <= 9999 else None


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


def _optional_vendor_integer(value: object) -> int | None:
    return None if value is None else _vendor_integer(value)


def _first_text(*values: object) -> str | None:
    for value in values:
        text = _text_value(value)
        if text is not None:
            return text
    return None


def _text_value(value: object) -> str | None:
    if value is None or type(value) is str:
        return optional_nonblank_string(value)
    if type(value) is dict:
        return optional_nonblank_string(require_json_object(value).get("$"))
    raise invalid_record_failure()


def _optional_object(value: object) -> dict[str, object] | None:
    return None if value is None else require_json_object(value)


def _matches_expected(
    expected: ProviderLiteratureKey,
    actual: ProviderLiteratureKey,
    *,
    aliases: tuple[str, ...],
) -> bool:
    if expected.record_id is not None and (
        expected.record_id == actual.record_id
        or expected.record_id.casefold() in {alias.casefold() for alias in aliases}
    ):
        return True
    return any(identifier in actual.identifiers for identifier in expected.identifiers)


def _keys_overlap(left: ProviderLiteratureKey, right: ProviderLiteratureKey) -> bool:
    if (
        left.record_id is not None
        and right.record_id is not None
        and left.record_id == right.record_id
    ):
        return True
    return any(identifier in right.identifiers for identifier in left.identifiers)


def _elsevier_feedback(
    status: int,
    headers: Sequence[Header],
    *,
    wall_now: datetime,
) -> AccessFeedback | None:
    standard = retry_after_feedback(status, headers, wall_now=wall_now)
    remaining = _nonnegative_header_integer(header_value(headers, "X-RateLimit-Remaining"))
    throttled = status == 429 or remaining == 0
    if standard is not None or throttled:
        return AccessFeedback(
            retry_after=None if standard is None else standard.retry_after,
            throttled=throttled,
        )
    if status >= 500:
        return AccessFeedback(throttled=True)
    return standard


def _nonnegative_header_integer(value: str | None) -> int | None:
    if value is None:
        return None
    candidate = value.strip()
    if not candidate.isdigit():
        return None
    return int(candidate, 10)


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


def _private_institution_token(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("institution_token must be a string or None")
    if not value.strip() or any(
        ord(character) < 32 or ord(character) == 127 for character in value
    ):
        raise ValueError("institution_token must be a nonblank private value")
    return value


def _elsevier_credential_headers(
    api_key: str,
    institution_token: str | None,
) -> tuple[tuple[str, str], ...]:
    api_key_header = ("X-ELS-APIKey", api_key)
    if institution_token is None:
        return (api_key_header,)
    return (api_key_header, ("X-ELS-Insttoken", institution_token))


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
        raise ValueError("Elsevier requires the shared Scopus API AccessScope")
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
        raise ValueError("page_size must be between 1 and 25 for COMPLETE view")


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
        action="Use a Scopus EID, Scopus ID, DOI, or PMID.",
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
    "ElsevierScopusAdapter",
)
