"""Semantic Scholar Graph adapter for neutral Metadata observations and edges."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
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
    optional_nonblank_string,
    optional_nonnegative_integer,
    parse_bounded_json,
    require_json_array,
    require_json_object,
    retry_after_feedback,
    stabilize_provider_metadata_observation,
    stabilize_provider_relation_observation,
)
from sciretriever.metadata.providers._shared.failures import unknown_shape_failure
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

_PROVIDER_NAME = "semantic-scholar"
_ORIGIN = "https://api.semanticscholar.org"
_SEARCH_ENDPOINT = f"{_ORIGIN}/graph/v1/paper/search"
_PAPER_ENDPOINT = f"{_ORIGIN}/graph/v1/paper"
_CREDENTIAL_ORIGIN = Origin("https", "api.semanticscholar.org", 443)
_MAX_RESPONSE_BYTES = 4_194_304
# Evidence: docs/notes/providers/semantic-scholar.md, last checked 2026-08-07.
# Graph endpoints share one
# product budget, and new API keys begin at one request per second in total.
# Anonymous capacity is a shared pool, so it does not justify a looser policy.
ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1, min_start_interval=1.0)
_PAPER_FIELDS = (
    "paperId,externalIds,title,abstract,url,venue,publicationVenue,journal,year,"
    "publicationDate,publicationTypes,authors,referenceCount,citationCount,"
    "isOpenAccess,openAccessPdf"
)
_EXTERNAL_IDS = (
    ("DOI", "doi"),
    ("ArXiv", "arxiv"),
    ("PubMed", "pmid"),
    ("PubMedCentral", "pmcid"),
)
_PUBLICATION_TYPES = {
    "journalarticle": "journal-article",
    "conference": "conference-paper",
    "review": "review",
    "book": "book",
    "booksection": "book-section",
    "thesis": "thesis",
    "dataset": "dataset",
    "editorial": "editorial",
    "letterandcomments": "letter",
    "clinicaltrial": "clinical-trial",
    "casereport": "case-report",
    "metaanalysis": "meta-analysis",
}
_INLINE_METADATA_FIELDS = frozenset(
    {
        "title",
        "abstract",
        "venue",
        "publicationVenue",
        "journal",
        "year",
        "publicationDate",
        "publicationTypes",
        "authors",
        "referenceCount",
        "citationCount",
        "openAccessPdf",
    }
)

_ReferenceKind = Literal["references", "citations"]


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _RawPaper:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    expected: ProviderLiteratureKey | None = None


@dataclass(frozen=True, slots=True)
class _ReferenceTask:
    anchor: ProviderLiteratureKey
    request_id: str
    kind: _ReferenceKind


@dataclass(frozen=True, slots=True)
class _ReferenceCursor:
    task_index: int
    offset: int


@dataclass(frozen=True, slots=True)
class _RawReference:
    value: object
    anchor: ProviderLiteratureKey
    kind: _ReferenceKind
    input_sha256: Sha256
    observed_at: UtcTimestamp


class SemanticScholarAdapter:
    """Topic search, exact lookup, and directed reference queries for S2 Graph."""

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
        api_key: str | None = None,
        page_size: int = 100,
    ) -> None:
        effective_policy = _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("Semantic Scholar must share the HttpClient AccessCoordinator")
        _validate_factories(observation_id_factory, provenance_id_factory, clock)
        _validate_page_size(page_size)
        self._http_client = http_client
        self._access_coordinator = access_coordinator
        self._access_scope = access_scope
        self._access_policy = effective_policy
        self._observation_id_factory = observation_id_factory
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._api_key = _private_api_key(api_key)
        self._page_size = page_size

    def __repr__(self) -> str:
        return f"<SemanticScholarAdapter credentialed={self._api_key is not None}>"

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe Graph authentication and parsing with one documented paper."""

        def operation() -> None:
            response = self._request(
                f"{_PAPER_ENDPOINT}?{urlencode((('fields', 'paperId'),))}",
                path_parameter="DOI:10.1038/s41586-020-2649-2",
                probe=True,
            )
            root = require_json_object(
                parse_bounded_json(response.body, max_bytes=_MAX_RESPONSE_BYTES)
            )
            paper_id = root.get("paperId")
            if type(paper_id) is not str or not paper_id.strip():
                raise unknown_shape_failure()

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=self._api_key is not None,
        )

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        seen_items = 0

        def fetch_page(offset: int | None) -> metadata_ports._RawPage[_RawPaper, int]:
            nonlocal seen_items
            requested_offset = 0 if offset is None else offset
            parameters: list[tuple[str, str]] = [
                ("query", query.query),
                ("offset", str(requested_offset)),
                ("limit", str(self._page_size)),
                ("fields", _PAPER_FIELDS),
            ]
            year = _semantic_year(query)
            if year is not None:
                parameters.append(("year", year))
            response = self._request(f"{_SEARCH_ENDPOINT}?{urlencode(parameters)}")
            root = require_json_object(
                parse_bounded_json(
                    response.transport.body,
                    max_bytes=_MAX_RESPONSE_BYTES,
                )
            )
            total = _top_level_count(root.get("total"))
            returned_offset = _top_level_count(root.get("offset"))
            if returned_offset != requested_offset:
                raise _protocol_failure()
            values = require_json_array(root.get("data"))
            if len(values) > self._page_size:
                raise unknown_shape_failure()
            next_offset = _optional_next_offset(root.get("next"), requested_offset)
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawPaper(
                    value=value,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for value in values
            )
            seen_items += len(items)
            if not items and next_offset is not None:
                raise _protocol_failure()
            exhausted = not items or seen_items >= total or next_offset is None
            if exhausted:
                if next_offset is not None and seen_items >= total:
                    raise _protocol_failure()
                return metadata_ports._RawPage(items=items, next_cursor=None, exhausted=True)
            return metadata_ports._RawPage(
                items=items,
                next_cursor=next_offset,
                exhausted=False,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_raw_paper)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        request_id = _lookup_id(key)

        def fetch_page(cursor: None) -> metadata_ports._RawPage[_RawPaper, None]:
            if cursor is not None:
                raise TypeError("Semantic Scholar lookup has no cursor")
            response = self._request(
                f"{_PAPER_ENDPOINT}?{urlencode((('fields', _PAPER_FIELDS),))}",
                path_parameter=request_id,
            )
            raw = _RawPaper(
                value=require_json_object(
                    parse_bounded_json(
                        response.transport.body,
                        max_bytes=_MAX_RESPONSE_BYTES,
                    )
                ),
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                expected=key,
            )
            return metadata_ports._RawPage(items=(raw,), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_raw_paper)

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        if not isinstance(query, ReferenceQueryContext):
            raise TypeError("query must be a ReferenceQueryContext")
        tasks = _reference_tasks(query)

        def fetch_page(
            cursor: _ReferenceCursor | None,
        ) -> metadata_ports._RawPage[_RawReference, _ReferenceCursor]:
            state = cursor or _ReferenceCursor(task_index=0, offset=0)
            while state.task_index < len(tasks):
                task = tasks[state.task_index]
                parameters = (
                    ("offset", str(state.offset)),
                    ("limit", str(self._page_size)),
                    ("fields", _PAPER_FIELDS),
                )
                response = self._request(
                    f"{_PAPER_ENDPOINT}?{urlencode(parameters)}",
                    path_parameter=task.request_id,
                    path_parameter_suffix=task.kind,
                )
                root = require_json_object(
                    parse_bounded_json(
                        response.transport.body,
                        max_bytes=_MAX_RESPONSE_BYTES,
                    )
                )
                returned_offset = _top_level_count(root.get("offset"))
                if returned_offset != state.offset:
                    raise _protocol_failure()
                values = require_json_array(root.get("data"))
                if len(values) > self._page_size:
                    raise unknown_shape_failure()
                next_offset = _optional_next_offset(root.get("next"), state.offset)
                if not values and next_offset is not None:
                    raise _protocol_failure()
                next_cursor = (
                    _ReferenceCursor(state.task_index, next_offset)
                    if next_offset is not None
                    else _ReferenceCursor(state.task_index + 1, 0)
                )
                input_sha256 = sha256_digest(response.transport.body)
                items = tuple(
                    _RawReference(
                        value=value,
                        anchor=task.anchor,
                        kind=task.kind,
                        input_sha256=input_sha256,
                        observed_at=response.observed_at,
                    )
                    for value in values
                )
                if items:
                    exhausted = next_cursor.task_index >= len(tasks)
                    return metadata_ports._RawPage(
                        items=items,
                        next_cursor=None if exhausted else next_cursor,
                        exhausted=exhausted,
                    )
                state = next_cursor
            return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_raw_reference)

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        probe: Literal[False] = False,
    ) -> _ObservedResponse: ...

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        probe: Literal[True],
    ) -> TransportResponse: ...

    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        path_parameter_suffix: str | None = None,
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse:
        credentials = () if self._api_key is None else (("x-api-key", self._api_key),)
        allowed_origins = () if self._api_key is None else (_CREDENTIAL_ORIGIN,)
        observed_at: UtcTimestamp | None = None

        def response_feedback(response: TransportResponse) -> AccessFeedback | None:
            nonlocal observed_at
            observed_at = None if probe else self._observed_at()
            return retry_after_feedback(
                response.status,
                response.headers,
                wall_now=(
                    probe_feedback_wall_time(system_probe_wall_clock)
                    if observed_at is None
                    else _timestamp_datetime(observed_at)
                ),
            )

        result = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
            credential_headers=credentials,
            credential_allowed_origins=allowed_origins,
            path_parameter=path_parameter,
            path_parameter_suffix=path_parameter_suffix,
            max_response_bytes=_MAX_RESPONSE_BYTES,
            max_redirects=1,
            response_feedback=response_feedback,
        )
        if isinstance(result, AccessFailure):
            raise access_failure_to_provider_failure(result)
        if not isinstance(result, TransportResponse):
            raise TypeError("HttpClient returned an unsupported result")
        if result.status != 200:
            raise _http_status_failure(result.status)
        if probe:
            return result
        if observed_at is None:
            raise TypeError("HttpClient did not interpret response feedback")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _convert_raw_paper(self, envelope: _RawPaper) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawPaper):
            raise TypeError("raw Semantic Scholar paper must use the private envelope")
        paper = require_json_object(envelope.value)
        observation, key = self._paper_observation(
            paper,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        if envelope.expected is not None and not _keys_overlap(envelope.expected, key):
            raise _record_failure()
        return NeutralMetadataItem(
            observations=(stabilize_provider_metadata_observation(observation),),
            relations=(),
        )

    def _convert_raw_reference(self, envelope: _RawReference) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawReference):
            raise TypeError("raw Semantic Scholar edge must use the private envelope")
        edge = require_json_object(envelope.value)
        field_name = "citedPaper" if envelope.kind == "references" else "citingPaper"
        related = require_json_object(edge.get(field_name))
        related_key = _paper_key(related)
        source_record_id = related_key.record_id or _lookup_id(related_key)
        provenance = self._provenance(
            source_record_id=source_record_id,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        citing, cited = (
            (envelope.anchor, related_key)
            if envelope.kind == "references"
            else (related_key, envelope.anchor)
        )
        relations: tuple[ProviderRelationObservation, ...]
        if citing == cited:
            relations = ()
        else:
            relations = (
                ProviderRelationObservation(
                    observation_id=self._new_observation_id(),
                    provenance=provenance,
                    citing=citing,
                    cited=cited,
                ),
            )
        observations: tuple[MetadataObservation, ...] = ()
        if _has_inline_metadata(related):
            observation, _unused = self._paper_observation(
                related,
                input_sha256=envelope.input_sha256,
                observed_at=envelope.observed_at,
                provenance=provenance,
            )
            observations = (observation,)
        return NeutralMetadataItem(
            observations=tuple(
                stabilize_provider_metadata_observation(observation) for observation in observations
            ),
            relations=tuple(
                stabilize_provider_relation_observation(relation) for relation in relations
            ),
        )

    def _paper_observation(
        self,
        paper: dict[str, object],
        *,
        input_sha256: Sha256,
        observed_at: UtcTimestamp,
        provenance: Provenance | None = None,
    ) -> tuple[MetadataObservation, ProviderLiteratureKey]:
        key = _paper_key(paper)
        source_record_id = key.record_id or _lookup_id(key)
        source = provenance or self._provenance(
            source_record_id=source_record_id,
            input_sha256=input_sha256,
            observed_at=observed_at,
        )
        publication_date, publication_year = _publication_date(paper)
        journal = _optional_object(paper.get("journal"))
        publication_venue = _optional_object(paper.get("publicationVenue"))
        metadata = LiteratureMetadata(
            title=optional_nonblank_string(paper.get("title")),
            authors=_authors(paper.get("authors")),
            abstract=optional_nonblank_string(paper.get("abstract")),
            publication_date=publication_date,
            publication_year=publication_year,
            document_type=_document_type(paper.get("publicationTypes")),
            language=None,
            venue=_first_present(
                None if journal is None else optional_nonblank_string(journal.get("name")),
                None
                if publication_venue is None
                else optional_nonblank_string(publication_venue.get("name")),
                optional_nonblank_string(paper.get("venue")),
            ),
            publisher=None,
            volume=None if journal is None else optional_nonblank_string(journal.get("volume")),
            issue=None,
            pages=None if journal is None else optional_nonblank_string(journal.get("pages")),
            identifiers=key.identifiers,
            keywords=(),
        )
        observation = MetadataObservation(
            observation_id=self._new_observation_id(),
            provenance=source,
            metadata=metadata,
            version_role=None,
            version_links=(),
            declared_keywords=(),
            reference_texts=(),
            reference_count=optional_nonnegative_integer(paper.get("referenceCount")),
            cited_by_count=optional_nonnegative_integer(paper.get("citationCount")),
            asset_hints=_open_access_pdf(paper.get("openAccessPdf")),
        )
        return observation, key

    def _provenance(
        self,
        *,
        source_record_id: str,
        input_sha256: Sha256,
        observed_at: UtcTimestamp,
    ) -> Provenance:
        return Provenance(
            provenance_id=self._new_provenance_id(),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=_PROVIDER_NAME,
            source_record_id=source_record_id,
            observed_at=observed_at,
            input_sha256=input_sha256,
            parameters_sha256=None,
        )

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


def _provider_failure(
    *,
    code: str,
    reason: str,
    action: str,
    retryable: bool,
) -> MetadataProviderFailure:
    return MetadataProviderFailure(
        StableFailure(code=code, reason=reason, action=action, retryable=retryable)
    )


def _record_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-invalid-record",
        reason="The metadata provider returned a record that could not be converted safely.",
        action="Update the provider adapter before retrying this record.",
        retryable=False,
    )


def _lookup_key_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-unsupported-key",
        reason="The metadata provider cannot use the requested lookup key.",
        action="Use a Semantic Scholar paper ID or a supported literature identifier.",
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


def _validate_access_inputs(
    http_client: HttpClient,
    access_coordinator: AccessCoordinator,
    access_scope: AccessScope,
    access_policy: AccessPolicy,
) -> AccessPolicy:
    if not isinstance(http_client, HttpClient):
        raise TypeError("http_client must be an HttpClient")
    if not isinstance(access_coordinator, AccessCoordinator):
        raise TypeError("access_coordinator must be an AccessCoordinator")
    if not isinstance(access_scope, AccessScope):
        raise TypeError("access_scope must be an AccessScope")
    if access_scope != ACCESS_SCOPE:
        raise ValueError("Semantic Scholar requires the semantic-scholar api AccessScope")
    if not isinstance(access_policy, AccessPolicy):
        raise TypeError("access_policy must be an AccessPolicy")
    return AccessPolicy.strictest(BASELINE_ACCESS_POLICY, access_policy)


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


def _validate_page_size(page_size: int) -> None:
    if isinstance(page_size, bool) or not isinstance(page_size, int):
        raise TypeError("page_size must be an integer")
    if not 1 <= page_size <= 100:
        raise ValueError("page_size must be between 1 and 100")


def _private_api_key(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("api_key must be a string or None")
    if not value.strip() or any(character in value for character in "\r\n\x00"):
        raise ValueError("api_key must be a nonblank private value")
    return value


def _semantic_year(query: TopicSearchQuery) -> str | None:
    if query.year_from is None and query.year_to is None:
        return None
    if query.year_from is None:
        return f"-{query.year_to}"
    if query.year_to is None:
        return f"{query.year_from}-"
    if query.year_from == query.year_to:
        return str(query.year_from)
    return f"{query.year_from}-{query.year_to}"


def _top_level_count(value: object) -> int:
    if type(value) is not int or value < 0:
        raise unknown_shape_failure()
    return value


def _optional_next_offset(value: object, current: int) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value <= current:
        raise _protocol_failure()
    return value


def _timestamp_datetime(value: UtcTimestamp) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _lookup_id(key: ProviderLiteratureKey) -> str:
    if key.record_id is not None:
        return key.record_id
    prefixes = {
        "doi": "DOI",
        "arxiv": "ARXIV",
        "pmid": "PMID",
        "pmcid": "PMCID",
    }
    for namespace in ("doi", "arxiv", "pmid", "pmcid"):
        for identifier in key.identifiers:
            if identifier.namespace == namespace:
                return f"{prefixes[namespace]}:{identifier.value}"
    raise _lookup_key_failure()


def _reference_tasks(query: ReferenceQueryContext) -> tuple[_ReferenceTask, ...]:
    kinds: tuple[_ReferenceKind, ...]
    if query.direction == "references":
        kinds = ("references",)
    elif query.direction == "cited-by":
        kinds = ("citations",)
    else:
        kinds = ("references", "citations")
    return tuple(
        _ReferenceTask(anchor=key, request_id=_lookup_id(key), kind=kind)
        for key in query.keys
        for kind in kinds
    )


def _paper_key(paper: dict[str, object]) -> ProviderLiteratureKey:
    paper_id = optional_nonblank_string(paper.get("paperId"))
    identifiers = _external_identifiers(paper.get("externalIds"))
    if paper_id is None and not identifiers:
        raise _record_failure()
    return ProviderLiteratureKey(record_id=paper_id, identifiers=identifiers)


def _keys_overlap(left: ProviderLiteratureKey, right: ProviderLiteratureKey) -> bool:
    if (
        left.record_id is not None
        and right.record_id is not None
        and left.record_id == right.record_id
    ):
        return True
    return any(identifier in right.identifiers for identifier in left.identifiers)


def _external_identifiers(value: object) -> tuple[Identifier, ...]:
    if value is None:
        return ()
    values = require_json_object(value)
    result: list[Identifier] = []
    for vendor_name, namespace in _EXTERNAL_IDS:
        raw = values.get(vendor_name)
        if raw is None:
            continue
        if type(raw) is not str:
            raise _record_failure()
        try:
            identifier = Identifier(namespace=namespace, value=raw)
        except ValidationError:
            raise _record_failure() from None
        if identifier not in result:
            result.append(identifier)
    return tuple(result)


def _authors(value: object) -> tuple[Author, ...]:
    if value is None:
        return ()
    result: list[Author] = []
    for raw in require_json_array(value):
        author = require_json_object(raw)
        name = optional_nonblank_string(author.get("name"))
        if name is None:
            raise _record_failure()
        try:
            result.append(
                Author(
                    kind=AuthorKind.UNKNOWN,
                    display_name=name,
                    given_name=None,
                    family_name=None,
                    orcid=None,
                    affiliations=(),
                )
            )
        except ValidationError:
            raise _record_failure() from None
    return tuple(result)


def _publication_date(paper: dict[str, object]) -> tuple[str | None, int | None]:
    raw_date = optional_nonblank_string(paper.get("publicationDate"))
    raw_year = paper.get("year")
    year = optional_nonnegative_integer(raw_year)
    if year is not None and not 1 <= year <= 9999:
        raise _record_failure()
    if raw_date is None:
        return None, year
    try:
        parsed = date.fromisoformat(raw_date)
    except ValueError:
        raise _record_failure() from None
    if year is not None and year != parsed.year:
        raise _record_failure()
    return parsed.isoformat(), parsed.year


def _document_type(value: object) -> str | None:
    if value is None:
        return None
    for raw in require_json_array(value):
        candidate = optional_nonblank_string(raw)
        if candidate is None:
            continue
        mapped = _PUBLICATION_TYPES.get(candidate.replace("-", "").casefold())
        if mapped is not None:
            return mapped
    return None


def _optional_object(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    return require_json_object(value)


def _first_present(*values: str | None) -> str | None:
    return next((value for value in values if value is not None), None)


def _open_access_pdf(value: object) -> tuple[AssetHint, ...]:
    if value is None:
        return ()
    if type(value) is not dict:
        raise _record_failure()
    item = require_json_object(value)
    raw_url = item.get("url")
    if type(raw_url) is not str:
        return ()
    status = _discard_bad_optional_text(item.get("status"))
    license_text = _discard_bad_optional_text(item.get("license"))
    try:
        if urlsplit(raw_url.strip()).scheme.casefold() != "https":
            return ()
        return (
            AssetHint(
                url=raw_url,
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=None,
                access_status=status,
                license=license_text,
            ),
        )
    except (ValidationError, ValueError):
        return ()


def _discard_bad_optional_text(value: object) -> str | None:
    if type(value) is not str:
        return None
    return value.strip() or None


def _has_inline_metadata(paper: dict[str, object]) -> bool:
    if _external_identifiers(paper.get("externalIds")):
        return True
    return any(paper.get(field_name) is not None for field_name in _INLINE_METADATA_FIELDS)


__all__ = (
    "ACCESS_SCOPE",
    "BASELINE_ACCESS_POLICY",
    "SemanticScholarAdapter",
)
