"""OpenAlex Works adapter for neutral Metadata observations and directed edges."""

from __future__ import annotations

import re
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
from sciretriever.network.policy import Origin

_PROVIDER_NAME = "openalex"
_ORIGIN = "https://api.openalex.org"
_WORKS_ENDPOINT = f"{_ORIGIN}/works"
_CREDENTIAL_ORIGIN = Origin("https", "api.openalex.org", 443)
_MAX_RESPONSE_BYTES = 4_194_304
# Evidence: docs/notes/providers/openalex.md, last checked 2026-08-07.
# OpenAlex uses a shared,
# cost-based account/usage budget rather than a stable fixed request rate.
# One request per second is this project's conservative safety floor, not a
# claim about an official quota; runtime usage and throttling feedback still apply.
ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1, min_start_interval=1.0)
_WORK_SELECT = (
    "id,doi,ids,title,type,language,publication_year,publication_date,"
    "abstract_inverted_index,authorships,primary_location,best_oa_location,"
    "locations,biblio,referenced_works,referenced_works_count,cited_by_count"
)
_WORK_ID = re.compile(r"^W[1-9][0-9]*$", re.ASCII)
_DOCUMENT_TYPES = frozenset(
    {
        "article",
        "book",
        "book-chapter",
        "conference-paper",
        "dataset",
        "dissertation",
        "editorial",
        "letter",
        "paratext",
        "preprint",
        "report",
        "review",
        "standard",
    }
)
_VERSION_ROLES = {
    "publishedversion": VersionRole.PUBLISHED,
    "acceptedversion": VersionRole.ACCEPTED_MANUSCRIPT,
    "submittedversion": VersionRole.PREPRINT,
}

_WorkMode = Literal["normal", "references", "cited-by"]
_ReferenceKind = Literal["references", "cited-by"]


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _RawWork:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    mode: _WorkMode = "normal"
    anchor: ProviderLiteratureKey | None = None
    expected: ProviderLiteratureKey | None = None


@dataclass(frozen=True, slots=True)
class _ReferenceTask:
    anchor: ProviderLiteratureKey
    request_id: str
    work_id: str | None
    kind: _ReferenceKind


@dataclass(frozen=True, slots=True)
class _ReferenceCursor:
    task_index: int
    cursor: str | None = None


class OpenAlexAdapter:
    """Topic search, exact lookup, and directed reference queries for Works."""

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
            raise ValueError("OpenAlex must share the HttpClient AccessCoordinator")
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
        return f"<OpenAlexAdapter credentialed={self._api_key is not None}>"

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe the Works product with one documented singleton lookup."""

        def operation() -> None:
            response = self._request(
                f"{_WORKS_ENDPOINT}?{urlencode((('select', 'id'),))}",
                path_parameter="W3035965352",
                probe=True,
            )
            root = require_json_object(
                parse_bounded_json(response.body, max_bytes=_MAX_RESPONSE_BYTES)
            )
            work_id = root.get("id")
            if type(work_id) is not str or not work_id.strip():
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

        def fetch_page(cursor: str | None) -> metadata_ports._RawPage[_RawWork, str]:
            nonlocal seen_items
            requested_cursor = "*" if cursor is None else cursor
            parameters: list[tuple[str, str]] = [
                ("search", query.query),
                ("cursor", requested_cursor),
                ("per_page", str(self._page_size)),
                ("select", _WORK_SELECT),
            ]
            year_filter = _openalex_year_filter(query)
            if year_filter is not None:
                parameters.append(("filter", year_filter))
            response = self._request(f"{_WORKS_ENDPOINT}?{urlencode(parameters)}")
            values, next_cursor, count = _list_page(
                response.transport.body,
                requested_cursor=requested_cursor,
                page_size=self._page_size,
            )
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawWork(
                    value=value,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for value in values
            )
            seen_items += len(items)
            exhausted = not items or seen_items >= count or next_cursor is None
            if exhausted:
                if next_cursor is not None and seen_items >= count:
                    raise _protocol_failure()
                return metadata_ports._RawPage(items=items, next_cursor=None, exhausted=True)
            return metadata_ports._RawPage(
                items=items,
                next_cursor=next_cursor,
                exhausted=False,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_raw_work)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        request_id = _lookup_id(key)

        def fetch_page(cursor: None) -> metadata_ports._RawPage[_RawWork, None]:
            if cursor is not None:
                raise TypeError("OpenAlex lookup has no cursor")
            response = self._request(
                f"{_WORKS_ENDPOINT}?{urlencode((('select', _WORK_SELECT),))}",
                path_parameter=request_id,
            )
            raw = _RawWork(
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

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_raw_work)

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        if not isinstance(query, ReferenceQueryContext):
            raise TypeError("query must be a ReferenceQueryContext")
        tasks = _reference_tasks(query)

        def fetch_page(
            cursor: _ReferenceCursor | None,
        ) -> metadata_ports._RawPage[_RawWork, _ReferenceCursor]:
            state = cursor or _ReferenceCursor(task_index=0)
            while state.task_index < len(tasks):
                task = tasks[state.task_index]
                if task.kind == "references":
                    response = self._request(
                        f"{_WORKS_ENDPOINT}?{urlencode((('select', _WORK_SELECT),))}",
                        path_parameter=task.request_id,
                    )
                    item = _RawWork(
                        value=require_json_object(
                            parse_bounded_json(
                                response.transport.body,
                                max_bytes=_MAX_RESPONSE_BYTES,
                            )
                        ),
                        input_sha256=sha256_digest(response.transport.body),
                        observed_at=response.observed_at,
                        mode="references",
                        anchor=task.anchor,
                        expected=task.anchor,
                    )
                    next_state = _ReferenceCursor(task_index=state.task_index + 1)
                    exhausted = next_state.task_index >= len(tasks)
                    return metadata_ports._RawPage(
                        items=(item,),
                        next_cursor=None if exhausted else next_state,
                        exhausted=exhausted,
                    )

                requested_cursor = "*" if state.cursor is None else state.cursor
                if task.work_id is None:
                    raise TypeError("cited-by task requires an OpenAlex Work ID")
                parameters = (
                    ("filter", f"cites:{task.work_id}"),
                    ("cursor", requested_cursor),
                    ("per_page", str(self._page_size)),
                    ("select", _WORK_SELECT),
                )
                response = self._request(f"{_WORKS_ENDPOINT}?{urlencode(parameters)}")
                values, next_page_cursor, _count = _list_page(
                    response.transport.body,
                    requested_cursor=requested_cursor,
                    page_size=self._page_size,
                )
                next_state = (
                    _ReferenceCursor(state.task_index, next_page_cursor)
                    if next_page_cursor is not None
                    else _ReferenceCursor(state.task_index + 1)
                )
                input_sha256 = sha256_digest(response.transport.body)
                items = tuple(
                    _RawWork(
                        value=value,
                        input_sha256=input_sha256,
                        observed_at=response.observed_at,
                        mode="cited-by",
                        anchor=task.anchor,
                    )
                    for value in values
                )
                if items:
                    exhausted = next_state.task_index >= len(tasks)
                    return metadata_ports._RawPage(
                        items=items,
                        next_cursor=None if exhausted else next_state,
                        exhausted=exhausted,
                    )
                state = next_state
            return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_raw_work)

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
        private_query = () if self._api_key is None else (("api_key", self._api_key),)
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
            credential_query=private_query,
            credential_allowed_origins=allowed_origins,
            path_parameter=path_parameter,
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

    def _convert_raw_work(self, envelope: _RawWork) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawWork):
            raise TypeError("raw OpenAlex work must use the private envelope")
        work = require_json_object(envelope.value)
        provenance = self._provenance(
            source_record_id=_work_record_id(work.get("id")),
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        current_key = _work_key(work)
        if envelope.expected is not None and not _keys_overlap(
            envelope.expected,
            current_key,
        ):
            raise _record_failure()
        publication_date, publication_year = _publication_date(work)
        biblio = _optional_object(work.get("biblio"))
        primary_location = _optional_object(work.get("primary_location"))
        primary_source = (
            None if primary_location is None else _optional_object(primary_location.get("source"))
        )
        metadata = LiteratureMetadata(
            title=optional_nonblank_string(work.get("title")),
            authors=_authorships(work.get("authorships")),
            abstract=_abstract(work.get("abstract_inverted_index")),
            publication_date=publication_date,
            publication_year=publication_year,
            document_type=_document_type(work.get("type")),
            language=_normalized_language(work.get("language")),
            venue=(
                None
                if primary_source is None
                else optional_nonblank_string(primary_source.get("display_name"))
            ),
            publisher=None,
            volume=None if biblio is None else optional_nonblank_string(biblio.get("volume")),
            issue=None if biblio is None else optional_nonblank_string(biblio.get("issue")),
            pages=_pages(biblio),
            identifiers=current_key.identifiers,
            keywords=(),
        )
        observation = MetadataObservation(
            observation_id=self._new_observation_id(),
            provenance=provenance,
            metadata=metadata,
            version_role=None,
            version_links=(),
            declared_keywords=(),
            reference_texts=(),
            reference_count=optional_nonnegative_integer(work.get("referenced_works_count")),
            cited_by_count=optional_nonnegative_integer(work.get("cited_by_count")),
            asset_hints=_location_hints(work),
        )
        if envelope.mode == "cited-by":
            if envelope.anchor is None:
                raise TypeError("cited-by work requires an anchor")
            relation_pairs = ((current_key, envelope.anchor),)
        else:
            citing = envelope.anchor if envelope.mode == "references" else current_key
            if citing is None:
                raise TypeError("referenced work requires a citing key")
            relation_pairs = tuple(
                (citing, target) for target in _referenced_work_keys(work.get("referenced_works"))
            )
        relations = tuple(
            ProviderRelationObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                citing=citing,
                cited=cited,
            )
            for citing, cited in relation_pairs
            if citing != cited
        )
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
        action="Use an OpenAlex Work ID or a supported literature identifier.",
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
        raise ValueError("OpenAlex requires the openalex api AccessScope")
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


def _timestamp_datetime(value: UtcTimestamp) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _openalex_year_filter(query: TopicSearchQuery) -> str | None:
    values: list[str] = []
    if query.year_from is not None:
        values.append(f"from_publication_date:{query.year_from:04d}-01-01")
    if query.year_to is not None:
        values.append(f"to_publication_date:{query.year_to:04d}-12-31")
    return ",".join(values) or None


def _list_page(
    payload: bytes,
    *,
    requested_cursor: str,
    page_size: int,
) -> tuple[tuple[object, ...], str | None, int]:
    root = require_json_object(parse_bounded_json(payload, max_bytes=_MAX_RESPONSE_BYTES))
    meta = require_json_object(root.get("meta"))
    values = require_json_array(root.get("results"))
    if len(values) > page_size:
        raise unknown_shape_failure()
    count = _top_level_count(meta.get("count"))
    per_page = _top_level_count(meta.get("per_page"))
    if per_page != page_size or "page" not in meta or meta.get("page") is not None:
        raise unknown_shape_failure()
    next_cursor = _optional_cursor(meta.get("next_cursor"))
    if next_cursor == requested_cursor or (not values and next_cursor is not None):
        raise _protocol_failure()
    return values, next_cursor, count


def _top_level_count(value: object) -> int:
    if type(value) is not int or value < 0:
        raise unknown_shape_failure()
    return value


def _optional_cursor(value: object) -> str | None:
    if value is None:
        return None
    if type(value) is not str or not value.strip():
        raise unknown_shape_failure()
    return value


def _lookup_id(key: ProviderLiteratureKey) -> str:
    if key.record_id is not None:
        try:
            return _bare_work_id(key.record_id)
        except MetadataProviderFailure:
            raise _lookup_key_failure() from None
    for namespace in ("doi", "pmid", "pmcid"):
        for identifier in key.identifiers:
            if identifier.namespace == namespace:
                if namespace == "doi":
                    return f"doi:{identifier.value}"
                return f"{namespace}:{identifier.value}"
    raise _lookup_key_failure()


def _reference_tasks(query: ReferenceQueryContext) -> tuple[_ReferenceTask, ...]:
    kinds: tuple[_ReferenceKind, ...]
    if query.direction == "references":
        kinds = ("references",)
    elif query.direction == "cited-by":
        kinds = ("cited-by",)
    else:
        kinds = ("references", "cited-by")
    tasks: list[_ReferenceTask] = []
    for key in query.keys:
        request_id = _lookup_id(key)
        for kind in kinds:
            work_id: str | None = None
            if kind == "cited-by":
                try:
                    work_id = _work_id_from_key(key)
                except MetadataProviderFailure:
                    raise _lookup_key_failure() from None
            tasks.append(
                _ReferenceTask(
                    anchor=key,
                    request_id=request_id,
                    work_id=work_id,
                    kind=kind,
                )
            )
    return tuple(tasks)


def _work_id_from_key(key: ProviderLiteratureKey) -> str:
    if key.record_id is None:
        raise _lookup_key_failure()
    return _bare_work_id(key.record_id)


def _work_record_id(value: object) -> str:
    if type(value) is not str:
        raise _record_failure()
    return f"https://openalex.org/{_bare_work_id(value)}"


def _bare_work_id(value: str) -> str:
    candidate = value.strip()
    if _WORK_ID.fullmatch(candidate) is not None:
        return candidate
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        raise _record_failure() from None
    if (
        parsed.scheme.casefold() != "https"
        or parsed.hostname is None
        or parsed.hostname.casefold() != "openalex.org"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise _record_failure()
    work_id = parsed.path.strip("/")
    if _WORK_ID.fullmatch(work_id) is None:
        raise _record_failure()
    return work_id


def _work_key(work: dict[str, object]) -> ProviderLiteratureKey:
    return ProviderLiteratureKey(
        record_id=_work_record_id(work.get("id")),
        identifiers=_work_identifiers(work),
    )


def _keys_overlap(left: ProviderLiteratureKey, right: ProviderLiteratureKey) -> bool:
    if left.record_id is not None and right.record_id is not None:
        try:
            if _bare_work_id(left.record_id) == _bare_work_id(right.record_id):
                return True
        except MetadataProviderFailure:
            if left.record_id == right.record_id:
                return True
    return any(identifier in right.identifiers for identifier in left.identifiers)


def _work_identifiers(work: dict[str, object]) -> tuple[Identifier, ...]:
    result: list[Identifier] = []

    def append(namespace: str, value: str) -> None:
        try:
            identifier = Identifier(namespace=namespace, value=value)
        except ValidationError:
            raise _record_failure() from None
        if identifier not in result:
            result.append(identifier)

    root_doi = work.get("doi")
    if root_doi is not None:
        if type(root_doi) is not str:
            raise _record_failure()
        append("doi", root_doi)
    ids_value = work.get("ids")
    if ids_value is None:
        return tuple(result)
    ids = require_json_object(ids_value)
    for vendor_name, namespace in (("doi", "doi"), ("pmid", "pmid"), ("pmcid", "pmcid")):
        raw = ids.get(vendor_name)
        if raw is None:
            continue
        if type(raw) is not str:
            raise _record_failure()
        unwrapped = raw if namespace == "doi" else _unwrap_ncbi_identifier(raw, namespace=namespace)
        append(namespace, unwrapped)
    return tuple(result)


def _unwrap_ncbi_identifier(value: str, *, namespace: str) -> str:
    candidate = value.strip()
    if not candidate.casefold().startswith(("http://", "https://")):
        return candidate
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        raise _record_failure() from None
    if (
        parsed.scheme.casefold() != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise _record_failure()
    path = parsed.path.strip("/")
    if namespace == "pmid":
        if (
            parsed.hostname is None
            or parsed.hostname.casefold() != "pubmed.ncbi.nlm.nih.gov"
            or "/" in path
        ):
            raise _record_failure()
        return path
    prefix = "pmc/articles/"
    if (
        parsed.hostname is None
        or parsed.hostname.casefold() != "www.ncbi.nlm.nih.gov"
        or not path.casefold().startswith(prefix)
    ):
        raise _record_failure()
    return path[len(prefix) :]


def _abstract(value: object) -> str | None:
    if value is None:
        return None
    index = require_json_object(value)
    if not index:
        return None
    positions: dict[int, str] = {}
    for raw_token, raw_positions in index.items():
        token = raw_token.strip()
        if not token:
            raise _record_failure()
        values = require_json_array(raw_positions)
        if not values:
            raise _record_failure()
        for position in values:
            if type(position) is not int or position < 0 or position in positions:
                raise _record_failure()
            positions[position] = token
    if tuple(sorted(positions)) != tuple(range(len(positions))):
        raise _record_failure()
    return " ".join(positions[position] for position in range(len(positions)))


def _authorships(value: object) -> tuple[Author, ...]:
    if value is None:
        return ()
    result: list[Author] = []
    for raw in require_json_array(value):
        authorship = require_json_object(raw)
        author = require_json_object(authorship.get("author"))
        display_name = optional_nonblank_string(author.get("display_name"))
        if display_name is None:
            display_name = optional_nonblank_string(authorship.get("raw_author_name"))
        if display_name is None:
            raise _record_failure()
        orcid = _aligned_orcid(author.get("orcid"), authorship.get("raw_orcid"))
        affiliations = _institutions(authorship.get("institutions"))
        try:
            result.append(
                Author(
                    kind=AuthorKind.PERSON if orcid is not None else AuthorKind.UNKNOWN,
                    display_name=display_name,
                    given_name=None,
                    family_name=None,
                    orcid=orcid,
                    affiliations=affiliations,
                )
            )
        except ValidationError:
            raise _record_failure() from None
    return tuple(result)


def _aligned_orcid(primary: object, raw: object) -> str | None:
    values: list[str] = []
    for value in (primary, raw):
        if value is None:
            continue
        if type(value) is not str:
            raise _record_failure()
        candidate = _bare_orcid(value)
        if candidate not in values:
            values.append(candidate)
    if len(values) > 1:
        raise _record_failure()
    return values[0] if values else None


def _bare_orcid(value: str) -> str:
    candidate = value.strip()
    if not candidate.casefold().startswith(("http://", "https://")):
        return candidate
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        raise _record_failure() from None
    if (
        parsed.scheme.casefold() != "https"
        or parsed.hostname != "orcid.org"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise _record_failure()
    return parsed.path.strip("/")


def _institutions(value: object) -> tuple[Affiliation, ...]:
    if value is None:
        return ()
    result: list[Affiliation] = []
    for raw in require_json_array(value):
        institution = require_json_object(raw)
        name = optional_nonblank_string(institution.get("display_name"))
        if name is None:
            continue
        ror_value = institution.get("ror")
        ror: str | None = None
        if ror_value is not None:
            if type(ror_value) is not str:
                raise _record_failure()
            ror = _bare_ror(ror_value)
        try:
            result.append(Affiliation(name=name, ror=ror))
        except ValidationError:
            raise _record_failure() from None
    return tuple(result)


def _bare_ror(value: str) -> str:
    candidate = value.strip()
    if not candidate.casefold().startswith(("http://", "https://")):
        return candidate
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        raise _record_failure() from None
    if (
        parsed.scheme.casefold() != "https"
        or parsed.hostname != "ror.org"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise _record_failure()
    return parsed.path.strip("/")


def _publication_date(work: dict[str, object]) -> tuple[str | None, int | None]:
    raw_date = optional_nonblank_string(work.get("publication_date"))
    year = optional_nonnegative_integer(work.get("publication_year"))
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
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    candidate = raw.casefold()
    return candidate if candidate in _DOCUMENT_TYPES else None


def _normalized_language(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    return None if raw is None else raw.casefold()


def _optional_object(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    return require_json_object(value)


def _pages(biblio: dict[str, object] | None) -> str | None:
    if biblio is None:
        return None
    first = optional_nonblank_string(biblio.get("first_page"))
    last = optional_nonblank_string(biblio.get("last_page"))
    if first is None:
        return last
    if last is None or last == first:
        return first
    return f"{first}-{last}"


def _referenced_work_keys(value: object) -> tuple[ProviderLiteratureKey, ...]:
    if value is None:
        return ()
    result: list[ProviderLiteratureKey] = []
    for raw in require_json_array(value):
        if type(raw) is not str:
            raise _record_failure()
        key = ProviderLiteratureKey(record_id=f"https://openalex.org/{_bare_work_id(raw)}")
        if key not in result:
            result.append(key)
    return tuple(result)


def _location_hints(work: dict[str, object]) -> tuple[AssetHint, ...]:
    location_values: list[object] = [
        work.get("primary_location"),
        work.get("best_oa_location"),
    ]
    raw_locations = work.get("locations")
    if raw_locations is not None:
        location_values.extend(require_json_array(raw_locations))
    result: list[AssetHint] = []
    for raw in location_values:
        if raw is None or type(raw) is not dict:
            continue
        location = require_json_object(raw)
        version_role = _location_version(location.get("version"))
        access_status = _location_access(location.get("is_oa"))
        license_text = _discard_bad_optional_text(location.get("license"))
        for field_name, kind, media_type, asset_role in (
            ("landing_page_url", AssetHintKind.LANDING_PAGE, None, None),
            (
                "pdf_url",
                AssetHintKind.DIRECT_FILE,
                "application/pdf",
                AssetRole.PRIMARY_PDF,
            ),
        ):
            hint = _asset_hint(
                location.get(field_name),
                kind=kind,
                media_type=media_type,
                asset_role=asset_role,
                version_role=version_role,
                access_status=access_status,
                license_text=license_text,
            )
            if hint is not None and hint not in result:
                result.append(hint)
    return tuple(result)


def _location_version(value: object) -> VersionRole | None:
    raw = _discard_bad_optional_text(value)
    return None if raw is None else _VERSION_ROLES.get(raw.casefold())


def _location_access(value: object) -> str | None:
    if value is True:
        return "open"
    if value is False:
        return "closed"
    return None


def _asset_hint(
    value: object,
    *,
    kind: AssetHintKind,
    media_type: str | None,
    asset_role: AssetRole | None,
    version_role: VersionRole | None,
    access_status: str | None,
    license_text: str | None,
) -> AssetHint | None:
    if type(value) is not str:
        return None
    try:
        if urlsplit(value.strip()).scheme.casefold() != "https":
            return None
        return AssetHint(
            url=value,
            kind=kind,
            media_type=media_type,
            asset_role=asset_role,
            version_role=version_role,
            access_status=access_status,
            license=license_text,
        )
    except (ValidationError, ValueError):
        return None


def _discard_bad_optional_text(value: object) -> str | None:
    if type(value) is not str:
        return None
    return value.strip() or None


__all__ = (
    "ACCESS_SCOPE",
    "BASELINE_ACCESS_POLICY",
    "OpenAlexAdapter",
)
