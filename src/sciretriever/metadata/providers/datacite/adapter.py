"""DataCite JSON:API adapter for neutral Metadata provider capabilities."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, overload
from urllib.parse import parse_qsl, urlencode, urlsplit

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
from sciretriever.metadata.providers._shared.failures import (
    invalid_record_failure,
    unknown_shape_failure,
)
from sciretriever.metadata.rules import (
    NeutralMetadataItem,
    ReferenceQueryContext,
    TopicSearchQuery,
    relation_matches_query,
)
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
    VersionRole,
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

_PROVIDER_NAME = "datacite"
_ORIGIN = "https://api.datacite.org"
_DOIS_ENDPOINT = f"{_ORIGIN}/dois"
_MAX_RESPONSE_BYTES = 1_048_576

ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=0.6,
    burst_limit=500,
    window_seconds=300.0,
)

_LITERATURE_TYPES: dict[str, tuple[str, VersionRole | None]] = {
    "book": ("book", None),
    "bookchapter": ("book-chapter", None),
    "conferencepaper": ("conference-paper", None),
    "conferenceproceeding": ("proceedings", None),
    "datapaper": ("data-paper", None),
    "dissertation": ("dissertation", None),
    "journalarticle": ("journal-article", None),
    "peerreview": ("peer-review", None),
    "preprint": ("preprint", VersionRole.PREPRINT),
    "report": ("report", None),
    "standard": ("standard", None),
    "text": ("text", None),
}
_OUTGOING_RELATIONS = frozenset({"references", "cites"})
_INCOMING_RELATIONS = frozenset({"isreferencedby", "iscitedby"})
_VERSION_RELATIONS = frozenset(
    {
        "hasversion",
        "isnewversionof",
        "ispreviousversionof",
        "isversionof",
    }
)
_SUPPORTED_RELATIONS = _OUTGOING_RELATIONS | _INCOMING_RELATIONS | _VERSION_RELATIONS


@dataclass(frozen=True, slots=True)
class _RawDoi:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    expected_doi: Identifier | None = None
    reference_query: ReferenceQueryContext | None = None


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _ConvertedRelations:
    relations: tuple[tuple[ProviderLiteratureKey, ProviderLiteratureKey], ...]
    version_links: tuple[ProviderLiteratureKey, ...]


class DataCiteAdapter:
    """DataCite literature-scoped search, DOI lookup, and embedded relations."""

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
            raise ValueError("DataCite must share the HttpClient AccessCoordinator")
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
        """Probe JSON:API with one documented, stable DOI record."""

        def operation() -> None:
            response = self._request(
                _DOIS_ENDPOINT,
                path_parameter="10.5281/zenodo.3727209",
                probe=True,
            )
            data = require_json_object(_single_response_body(response.body))
            if data.get("type") != "dois" or optional_nonblank_string(data.get("id")) is None:
                raise unknown_shape_failure()

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=False,
        )

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        provider_query = _topic_query(query)
        requested_cursors: set[str] = set()

        def fetch_page(cursor: str | None) -> metadata_ports._RawPage[_RawDoi, str]:
            cursor_value = "1" if cursor is None else _page_cursor(cursor)
            if cursor_value in requested_cursors:
                raise _protocol_failure()
            requested_cursors.add(cursor_value)
            if cursor is None:
                url = (
                    _DOIS_ENDPOINT
                    + "?"
                    + urlencode(
                        (
                            ("query", provider_query),
                            ("page[size]", str(self._page_size)),
                            ("page[cursor]", "1"),
                            ("affiliation", "true"),
                            ("publisher", "true"),
                        )
                    )
                )
            else:
                url = _validated_next_link(cursor)
            response = self._request(url)
            items, next_link = _list_response(response)
            input_sha256 = sha256_digest(response.transport.body)
            raw_items = tuple(
                _RawDoi(
                    value=item,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for item in items
            )
            if not raw_items and next_link is not None:
                raise _protocol_failure()
            exhausted = next_link is None
            return metadata_ports._RawPage(
                items=raw_items,
                next_cursor=None if exhausted else next_link,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_doi)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        doi = _lookup_doi(key)

        def fetch_page(cursor: None) -> metadata_ports._RawPage[_RawDoi, None]:
            if cursor is not None:
                raise TypeError("DataCite lookup has no cursor")
            response = self._doi_request(doi)
            raw = _RawDoi(
                value=_single_response(response),
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                expected_doi=doi,
            )
            return metadata_ports._RawPage(items=(raw,), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_doi)

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        if not isinstance(query, ReferenceQueryContext):
            raise TypeError("query must be a ReferenceQueryContext")
        dois = tuple(_lookup_doi(key) for key in query.keys)

        def fetch_page(cursor: int | None) -> metadata_ports._RawPage[_RawDoi, int]:
            index = 0 if cursor is None else cursor
            if index >= len(dois):
                return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)
            doi = dois[index]
            response = self._doi_request(doi)
            raw = _RawDoi(
                value=_single_response(response),
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                expected_doi=doi,
                reference_query=query,
            )
            next_index = index + 1
            exhausted = next_index >= len(dois)
            return metadata_ports._RawPage(
                items=(raw,),
                next_cursor=None if exhausted else next_index,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_doi)

    def _doi_request(self, doi: Identifier) -> _ObservedResponse:
        return self._request(
            _DOIS_ENDPOINT
            + "?"
            + urlencode(
                (
                    ("affiliation", "true"),
                    ("publisher", "true"),
                )
            ),
            path_parameter=doi.value,
        )

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

    def _request(
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse:
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
            headers=(Header(name="Accept", value="application/vnd.api+json"),),
            path_parameter=path_parameter,
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
            raise RuntimeError("HttpClient did not interpret the DataCite response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _convert_doi(self, envelope: _RawDoi) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawDoi):
            raise TypeError("raw DataCite item must use the private envelope")
        data = require_json_object(envelope.value)
        if data.get("type") != "dois":
            raise invalid_record_failure()
        source_record_id = optional_nonblank_string(data.get("id"))
        if source_record_id is None:
            raise invalid_record_failure()
        attributes = require_json_object(data.get("attributes"))
        doi = _record_doi(source_record_id, attributes.get("doi"))
        if envelope.expected_doi is not None and doi != envelope.expected_doi:
            raise invalid_record_failure()
        if doi is not None:
            source_record_id = doi.value
        resource = _resource_type(attributes.get("types"))
        if resource is None:
            return NeutralMetadataItem()
        document_type, version_role = resource
        identifiers = () if doi is None else (doi,)
        current = ProviderLiteratureKey(
            record_id=source_record_id,
            identifiers=identifiers,
        )
        relations = _relations(data, attributes, current=current)
        provenance = self._provenance(
            source_record_id=source_record_id,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        try:
            metadata = LiteratureMetadata(
                title=_title(attributes.get("titles")),
                authors=_creators(attributes.get("creators")),
                abstract=_abstract(attributes.get("descriptions")),
                publication_date=_publication_date(attributes.get("dates")),
                publication_year=_publication_year(attributes.get("publicationYear")),
                document_type=document_type,
                language=optional_nonblank_string(attributes.get("language")),
                venue=_container_value(attributes.get("container"), "title"),
                publisher=_publisher(attributes.get("publisher")),
                volume=_container_value(attributes.get("container"), "volume"),
                issue=_container_value(attributes.get("container"), "issue"),
                pages=_pages(attributes.get("container")),
                identifiers=identifiers,
                keywords=(),
            )
            observation = MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=metadata,
                version_role=version_role,
                version_links=relations.version_links,
                declared_keywords=(),
                reference_texts=(),
                reference_count=optional_nonnegative_integer(attributes.get("referenceCount")),
                cited_by_count=optional_nonnegative_integer(attributes.get("citationCount")),
                asset_hints=_asset_hints(attributes),
            )
        except ValidationError:
            raise invalid_record_failure() from None
        relation_models = self._relation_observations(
            relations.relations,
            provenance=provenance,
            query=envelope.reference_query,
        )
        return NeutralMetadataItem(
            observations=(stabilize_provider_metadata_observation(observation),),
            relations=tuple(
                stabilize_provider_relation_observation(relation) for relation in relation_models
            ),
        )

    def _relation_observations(
        self,
        edges: tuple[tuple[ProviderLiteratureKey, ProviderLiteratureKey], ...],
        *,
        provenance: Provenance,
        query: ReferenceQueryContext | None,
    ) -> tuple[ProviderRelationObservation, ...]:
        result: list[ProviderRelationObservation] = []
        for citing, cited in edges:
            try:
                relation = ProviderRelationObservation(
                    observation_id=self._new_observation_id(),
                    provenance=provenance,
                    citing=citing,
                    cited=cited,
                )
            except ValidationError:
                raise invalid_record_failure() from None
            if query is None or relation_matches_query(relation, query):
                result.append(relation)
        return tuple(result)

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


def _list_response(response: _ObservedResponse) -> tuple[tuple[object, ...], str | None]:
    root = require_json_object(
        parse_bounded_json(response.transport.body, max_bytes=_MAX_RESPONSE_BYTES)
    )
    if "data" not in root or "links" not in root:
        raise unknown_shape_failure()
    items = require_json_array(root.get("data"))
    links = require_json_object(root.get("links"))
    next_link = optional_nonblank_string(links.get("next"))
    if next_link is not None:
        next_link = _validated_next_link(next_link)
    return items, next_link


def _single_response(response: _ObservedResponse) -> object:
    return _single_response_body(response.transport.body)


def _single_response_body(body: bytes) -> object:
    root = require_json_object(parse_bounded_json(body, max_bytes=_MAX_RESPONSE_BYTES))
    if "data" not in root:
        raise unknown_shape_failure()
    return root.get("data")


def _validated_next_link(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise unknown_shape_failure() from None
    if (
        parsed.scheme != "https"
        or parsed.hostname != "api.datacite.org"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.path != "/dois"
        or parsed.fragment
    ):
        raise unknown_shape_failure()
    try:
        if has_sensitive_query_parameter(parsed.query):
            raise unknown_shape_failure()
    except (TypeError, ValueError):
        raise unknown_shape_failure() from None
    _page_cursor(value)
    return value


def _page_cursor(value: str) -> str:
    try:
        parsed = urlsplit(value)
        fields = parse_qsl(
            parsed.query,
            keep_blank_values=True,
            strict_parsing=False,
            encoding="utf-8",
            errors="strict",
        )
    except (UnicodeDecodeError, ValueError):
        raise unknown_shape_failure() from None
    cursors = tuple(item for name, item in fields if name == "page[cursor]")
    if len(cursors) != 1 or not cursors[0]:
        raise unknown_shape_failure()
    return cursors[0]


def _topic_query(query: TopicSearchQuery) -> str:
    clauses = [f"({query.query})"]
    if query.year_from is not None or query.year_to is not None:
        lower = query.year_from or 1
        upper = query.year_to or 9999
        clauses.append(f"publicationYear:[{lower} TO {upper}]")
    return " AND ".join(clauses)


def _lookup_doi(key: ProviderLiteratureKey) -> Identifier:
    for identifier in key.identifiers:
        if identifier.namespace == "doi":
            return identifier
    if key.record_id is not None:
        try:
            return Identifier(namespace="doi", value=key.record_id)
        except ValidationError:
            pass
    raise _lookup_key_failure()


def _record_doi(source_record_id: str, raw_doi: object) -> Identifier | None:
    value = optional_nonblank_string(raw_doi)
    if value is None and source_record_id.casefold().startswith("10."):
        value = source_record_id
    if value is None:
        return None
    try:
        return Identifier(namespace="doi", value=value)
    except ValidationError:
        raise invalid_record_failure() from None


def _resource_type(value: object) -> tuple[str, VersionRole | None] | None:
    if value is None:
        return None
    types = require_json_object(value)
    general = optional_nonblank_string(types.get("resourceTypeGeneral"))
    if general is None:
        return None
    return _LITERATURE_TYPES.get(general.casefold())


def _title(value: object) -> str | None:
    if value is None:
        return None
    titles = require_json_array(value)
    fallback: str | None = None
    for raw_title in titles:
        title = require_json_object(raw_title)
        text = optional_nonblank_string(title.get("title"))
        if text is None:
            continue
        title_type = optional_nonblank_string(title.get("titleType"))
        if title_type is None and fallback is None:
            fallback = text
        elif title_type is not None and title_type.casefold() == "title":
            return text
    return fallback


def _creators(value: object) -> tuple[Author, ...]:
    if value is None:
        return ()
    raw_creators = require_json_array(value)
    result: list[Author] = []
    for raw_creator in raw_creators:
        creator = require_json_object(raw_creator)
        display_name = optional_nonblank_string(creator.get("name"))
        if display_name is None:
            continue
        name_type = optional_nonblank_string(creator.get("nameType"))
        folded_type = name_type.casefold() if name_type is not None else ""
        if folded_type == "personal":
            kind = AuthorKind.PERSON
            given_name = optional_nonblank_string(creator.get("givenName"))
            family_name = optional_nonblank_string(creator.get("familyName"))
        elif folded_type == "organizational":
            kind = AuthorKind.ORGANIZATION
            given_name = None
            family_name = None
        else:
            kind = AuthorKind.UNKNOWN
            given_name = None
            family_name = None
        try:
            converted = Author(
                kind=kind,
                display_name=display_name,
                given_name=given_name,
                family_name=family_name,
                orcid=_creator_orcid(creator.get("nameIdentifiers")),
                affiliations=_creator_affiliations(creator.get("affiliation")),
            )
            if converted.kind is AuthorKind.UNKNOWN and converted.orcid is not None:
                converted = converted.model_copy(update={"kind": AuthorKind.PERSON})
            result.append(converted)
        except ValidationError:
            raise invalid_record_failure() from None
    return tuple(result)


def _creator_orcid(value: object) -> str | None:
    if value is None:
        return None
    for raw_identifier in require_json_array(value):
        identifier = require_json_object(raw_identifier)
        scheme = optional_nonblank_string(identifier.get("nameIdentifierScheme"))
        if scheme is None or scheme.casefold() != "orcid":
            continue
        raw = optional_nonblank_string(identifier.get("nameIdentifier"))
        if raw is None:
            continue
        prefix = "https://orcid.org/"
        return raw[len(prefix) :] if raw.casefold().startswith(prefix) else raw
    return None


def _creator_affiliations(value: object) -> tuple[Affiliation, ...]:
    if value is None:
        return ()
    result: list[Affiliation] = []
    for raw_affiliation in require_json_array(value):
        if type(raw_affiliation) is str:
            name = optional_nonblank_string(raw_affiliation)
            ror = None
        else:
            affiliation = require_json_object(raw_affiliation)
            name = optional_nonblank_string(affiliation.get("name"))
            scheme = optional_nonblank_string(affiliation.get("affiliationIdentifierScheme"))
            identifier = optional_nonblank_string(affiliation.get("affiliationIdentifier"))
            ror = (
                _bare_ror(identifier) if scheme is not None and scheme.casefold() == "ror" else None
            )
        if name is None:
            continue
        try:
            item = Affiliation(name=name, ror=ror)
        except ValidationError:
            raise invalid_record_failure() from None
        if item not in result:
            result.append(item)
    return tuple(result)


def _bare_ror(value: str | None) -> str | None:
    if value is None:
        return None
    prefix = "https://ror.org/"
    return value[len(prefix) :] if value.casefold().startswith(prefix) else value


def _abstract(value: object) -> str | None:
    if value is None:
        return None
    for raw_description in require_json_array(value):
        description = require_json_object(raw_description)
        kind = optional_nonblank_string(description.get("descriptionType"))
        if kind is not None and kind.casefold() == "abstract":
            return optional_nonblank_string(description.get("description"))
    return None


def _publication_date(value: object) -> str | None:
    if value is None:
        return None
    dates = require_json_array(value)
    for accepted in ("published", "issued"):
        for raw_date in dates:
            date = require_json_object(raw_date)
            date_type = optional_nonblank_string(date.get("dateType"))
            if date_type is not None and date_type.casefold() == accepted:
                return optional_nonblank_string(date.get("date"))
    return None


def _publication_year(value: object) -> int | None:
    if value is None:
        return None
    if type(value) is not int or not 1 <= value <= 9999:
        raise invalid_record_failure()
    return value


def _publisher(value: object) -> str | None:
    if value is None or type(value) is str:
        return optional_nonblank_string(value)
    publisher = require_json_object(value)
    return optional_nonblank_string(publisher.get("name"))


def _container_value(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    container = require_json_object(value)
    return optional_nonblank_string(container.get(field_name))


def _pages(value: object) -> str | None:
    first = _container_value(value, "firstPage")
    last = _container_value(value, "lastPage")
    if first is not None and last is not None:
        return first if first == last else f"{first}-{last}"
    return first or last


def _relations(
    data: dict[str, object],
    attributes: dict[str, object],
    *,
    current: ProviderLiteratureKey,
) -> _ConvertedRelations:
    edges: list[tuple[ProviderLiteratureKey, ProviderLiteratureKey]] = []
    versions: list[ProviderLiteratureKey] = []
    _append_related_identifier_relations(
        attributes.get("relatedIdentifiers"),
        current=current,
        edges=edges,
        versions=versions,
    )
    _append_jsonapi_relationship_relations(
        data.get("relationships"),
        current=current,
        edges=edges,
        versions=versions,
    )
    return _ConvertedRelations(relations=tuple(edges), version_links=tuple(versions))


def _append_related_identifier_relations(
    value: object,
    *,
    current: ProviderLiteratureKey,
    edges: list[tuple[ProviderLiteratureKey, ProviderLiteratureKey]],
    versions: list[ProviderLiteratureKey],
) -> None:
    if value is None:
        return
    for raw_related in require_json_array(value):
        related = require_json_object(raw_related)
        identifier_type = optional_nonblank_string(related.get("relatedIdentifierType"))
        if identifier_type is None or identifier_type.casefold() != "doi":
            continue
        relation_type = optional_nonblank_string(related.get("relationType"))
        folded = relation_type.casefold() if relation_type is not None else ""
        if folded not in _SUPPORTED_RELATIONS:
            continue
        key = _doi_key(related.get("relatedIdentifier"))
        if key is None or key == current:
            continue
        if folded in _OUTGOING_RELATIONS:
            _append_unique(edges, (current, key))
        elif folded in _INCOMING_RELATIONS:
            _append_unique(edges, (key, current))
        elif folded in _VERSION_RELATIONS and key not in versions:
            versions.append(key)


def _append_jsonapi_relationship_relations(
    value: object,
    *,
    current: ProviderLiteratureKey,
    edges: list[tuple[ProviderLiteratureKey, ProviderLiteratureKey]],
    versions: list[ProviderLiteratureKey],
) -> None:
    if value is None:
        return
    relationships = require_json_object(value)
    for name, direction in (("references", "out"), ("citations", "in")):
        for key in _relationship_keys(relationships.get(name)):
            if key == current:
                continue
            edge = (current, key) if direction == "out" else (key, current)
            _append_unique(edges, edge)
    for name in ("versions", "versionOf"):
        for key in _relationship_keys(relationships.get(name)):
            if key != current and key not in versions:
                versions.append(key)


def _relationship_keys(value: object) -> tuple[ProviderLiteratureKey, ...]:
    if value is None:
        return ()
    relationship = require_json_object(value)
    raw_data = relationship.get("data")
    if raw_data is None:
        return ()
    raw_values = require_json_array(raw_data) if type(raw_data) is list else (raw_data,)
    result: list[ProviderLiteratureKey] = []
    for raw_value in raw_values:
        linkage = require_json_object(raw_value)
        if linkage.get("type") != "dois":
            continue
        key = _doi_key(linkage.get("id"))
        if key is not None and key not in result:
            result.append(key)
    return tuple(result)


def _doi_key(value: object) -> ProviderLiteratureKey | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    try:
        identifier = Identifier(namespace="doi", value=raw)
        return ProviderLiteratureKey(
            record_id=identifier.value,
            identifiers=(identifier,),
        )
    except ValidationError:
        raise invalid_record_failure() from None


def _append_unique(
    values: list[tuple[ProviderLiteratureKey, ProviderLiteratureKey]],
    value: tuple[ProviderLiteratureKey, ProviderLiteratureKey],
) -> None:
    if value not in values:
        values.append(value)


def _asset_hints(attributes: dict[str, object]) -> tuple[AssetHint, ...]:
    result: list[AssetHint] = []
    landing = optional_nonblank_string(attributes.get("url"))
    if landing is not None:
        try:
            result.append(AssetHint(url=landing, kind=AssetHintKind.LANDING_PAGE))
        except ValidationError:
            raise invalid_record_failure() from None
    content = attributes.get("contentUrl")
    if content is None:
        raw_values: tuple[object, ...] = ()
    elif type(content) is list:
        raw_values = require_json_array(content)
    else:
        raw_values = (content,)
    for raw_value in raw_values:
        url = optional_nonblank_string(raw_value)
        if url is None:
            continue
        try:
            hint = AssetHint(url=url, kind=AssetHintKind.DIRECT_FILE)
        except ValidationError:
            raise invalid_record_failure() from None
        if hint not in result:
            result.append(hint)
    return tuple(result)


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
        raise ValueError("DataCite requires the shared datacite API AccessScope")
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
        action="Use a DOI registered by this metadata provider.",
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


__all__ = ("ACCESS_SCOPE", "BASELINE_ACCESS_POLICY", "DataCiteAdapter")
