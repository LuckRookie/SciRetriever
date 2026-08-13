"""Clarivate Web of Science Starter v2 and Expanded Metadata adapters.

Starter and Expanded are intentionally separate products.  They share only
small neutral mechanics in this module: credential attachment, deterministic
provenance context, access feedback, and ID factories.  Their endpoints,
pagination, response parsers, and capability surfaces remain distinct.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Callable, Sequence
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
    invalid_record_failure,
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
from sciretriever.metadata.providers._shared.failures import unknown_shape_failure
from sciretriever.metadata.rules import (
    NeutralMetadataItem,
    ReferenceQueryContext,
    TopicSearchQuery,
)
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.literature import Affiliation, Author, AuthorKind, Identifier
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

_PROVIDER_NAME = "web-of-science"
_STARTER_PRODUCT = "starter-v2"
_EXPANDED_PRODUCT = "expanded-full-record"
_STARTER_ROOT = "https://api.clarivate.com/apis/wos-starter/v2"
_STARTER_DOCUMENTS = f"{_STARTER_ROOT}/documents"
_EXPANDED_ROOT = "https://wos-api.clarivate.com/api/wos"
_EXPANDED_ID = f"{_EXPANDED_ROOT}/id"
_EXPANDED_REFERENCES = f"{_EXPANDED_ROOT}/references"
_EXPANDED_CITING = f"{_EXPANDED_ROOT}/citing"
_STARTER_CREDENTIAL_ORIGIN = Origin("https", "api.clarivate.com", 443)
_EXPANDED_CREDENTIAL_ORIGIN = Origin("https", "wos-api.clarivate.com", 443)
_MAX_RESPONSE_BYTES = 4_194_304
_WOS_UID = re.compile(r"WOS:[A-Za-z0-9][A-Za-z0-9._-]*", re.ASCII)
_FOUR_DIGIT_YEAR = re.compile(r"[0-9]{4}", re.ASCII)
_NON_CORE_CITING_EDITIONS = frozenset(
    {
        "all databases",
        "alldb",
        "biosis",
        "medline",
        "pprn",
        "preprint citation index",
        "research commons",
    }
)

# Evidence: docs/notes/providers/web-of-science.md, last checked 2026-08-07.
# Starter's most conservative published plan allows one request per second.
STARTER_ACCESS_SCOPE = AccessScope(
    provider_name=_PROVIDER_NAME,
    channel="api",
    service_name="starter",
)
STARTER_BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=1.0,
)

# Expanded Basic currently permits two requests per second.  Concurrency stays
# at one so a process does not spend an institution's licensed quota in bursts.
EXPANDED_ACCESS_SCOPE = AccessScope(
    provider_name=_PROVIDER_NAME,
    channel="api",
    service_name="expanded",
)
EXPANDED_BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=0.5,
)

_ExpandedReferenceKind = Literal["references", "citing"]
_LookupOperation = Literal["uid", "DO", "PMID"]


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _LookupLocator:
    operation: _LookupOperation
    value: str


@dataclass(frozen=True, slots=True)
class _RawStarterDocument:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    lookup_locator: _LookupLocator | None = None


@dataclass(frozen=True, slots=True)
class _RawExpandedRecord:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    lookup_locator: _LookupLocator | None = None
    cited_anchor: ProviderLiteratureKey | None = None


@dataclass(frozen=True, slots=True)
class _ExpandedReferenceTask:
    anchor: ProviderLiteratureKey
    kind: _ExpandedReferenceKind


@dataclass(frozen=True, slots=True)
class _ExpandedReferenceCursor:
    task_index: int
    first_record: int


@dataclass(frozen=True, slots=True)
class _RawExpandedReference:
    value: object
    anchor: ProviderLiteratureKey
    input_sha256: Sha256
    observed_at: UtcTimestamp


class _WebOfScienceAdapterBase:
    """Private common mechanics; it is not a capability port itself."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        access_coordinator: AccessCoordinator,
        access_scope: AccessScope,
        access_policy: AccessPolicy,
        expected_scope: AccessScope,
        baseline_policy: AccessPolicy,
        product: str,
        credential_origin: Origin,
        observation_id_factory: Callable[[], ObservationId],
        provenance_id_factory: Callable[[], ProvenanceId],
        clock: Callable[[], UtcTimestamp],
        api_key: str | None = None,
        database: str,
        edition: str | None,
        page_size: int,
        maximum_page_size: int,
    ) -> None:
        _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
            expected_scope=expected_scope,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("Web of Science must share the HttpClient AccessCoordinator")
        _validate_factories(observation_id_factory, provenance_id_factory, clock)
        _validate_page_size(page_size, maximum=maximum_page_size)
        self._http_client = http_client
        self._access_coordinator = access_coordinator
        self._access_scope = access_scope
        self._access_policy = AccessPolicy.strictest(baseline_policy, access_policy)
        self._product = product
        self._credential_origin = credential_origin
        self._observation_id_factory = observation_id_factory
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._api_key = _private_api_key(api_key)
        self._database = _ordinary_parameter(database, field_name="database")
        self._edition = _optional_ordinary_parameter(edition, field_name="edition")
        self._parameters_sha256 = _provenance_parameters_sha256(
            product=product,
            database=self._database,
            edition=self._edition,
        )
        self._page_size = page_size

    def __repr__(self) -> str:
        return f"<{type(self).__name__} credentialed={self._api_key is not None}>"

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def _run_probe(self, operation: Callable[[], None]) -> MetadataProbeEvidence:
        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=self._api_key is not None,
        )

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
    def _request(  # noqa: C901 -- one request boundary owns feedback and status stabilization
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
                return _web_of_science_feedback(
                    response.status,
                    response.headers,
                    wall_now=(
                        probe_feedback_wall_time(system_probe_wall_clock)
                        if observed_at is None
                        else _timestamp_datetime(observed_at)
                    ),
                    expanded=self._product == _EXPANDED_PRODUCT,
                )
            except MetadataProviderFailure as error:
                feedback_failure = error
                return _conservative_feedback_after_failure(response.status)

        result = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
            credential_headers=(("X-ApiKey", self._api_key),),
            credential_allowed_origins=(self._credential_origin,),
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
            raise RuntimeError("HttpClient did not interpret the Web of Science response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

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


class WebOfScienceStarterAdapter(_WebOfScienceAdapterBase):
    """Web of Science Starter API v2 topic search and exact lookup."""

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
        database: str,
        edition: str | None = None,
        page_size: int = 50,
    ) -> None:
        super().__init__(
            http_client=http_client,
            access_coordinator=access_coordinator,
            access_scope=access_scope,
            access_policy=access_policy,
            expected_scope=STARTER_ACCESS_SCOPE,
            baseline_policy=STARTER_BASELINE_ACCESS_POLICY,
            product=_STARTER_PRODUCT,
            credential_origin=_STARTER_CREDENTIAL_ORIGIN,
            observation_id_factory=observation_id_factory,
            provenance_id_factory=provenance_id_factory,
            clock=clock,
            api_key=api_key,
            database=database,
            edition=edition,
            page_size=page_size,
            maximum_page_size=50,
        )

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe the configured Starter database with one minimal query."""

        def operation() -> None:
            response = self._request(
                _starter_search_url(
                    "TS=metadata",
                    database=self._database,
                    page_size=1,
                    page=1,
                ),
                probe=True,
            )
            _starter_page_body(
                response.body,
                requested_page=1,
                page_size=1,
                seen_items=0,
            )

        return self._run_probe(operation)

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        vendor_query = _topic_query(query)
        seen_items = 0

        def fetch_page(
            page: int | None,
        ) -> metadata_ports._RawPage[_RawStarterDocument, int]:
            nonlocal seen_items
            requested_page = 1 if page is None else page
            response = self._request(
                _starter_search_url(
                    vendor_query,
                    database=self._database,
                    page_size=self._page_size,
                    page=requested_page,
                )
            )
            assert response is not None
            values, total = _starter_page(
                response,
                requested_page=requested_page,
                page_size=self._page_size,
                seen_items=seen_items,
            )
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawStarterDocument(
                    value=value,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for value in values
            )
            seen_items += len(items)
            exhausted = seen_items >= total
            return metadata_ports._RawPage(
                items=items,
                next_cursor=None if exhausted else requested_page + 1,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_document)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        operation, value = _lookup_operation(key)
        locator = _LookupLocator(operation=operation, value=value)
        if operation == "uid":

            def fetch_uid(
                cursor: None,
            ) -> metadata_ports._RawPage[_RawStarterDocument, None]:
                if cursor is not None:
                    raise TypeError("Starter UID lookup has no cursor")
                response = self._request(
                    _STARTER_DOCUMENTS,
                    path_parameter=value,
                    allow_not_found=True,
                )
                if response is None:
                    return metadata_ports._RawPage(
                        items=(),
                        next_cursor=None,
                        exhausted=True,
                    )
                raw = _RawStarterDocument(
                    value=require_json_object(
                        parse_bounded_json(
                            response.transport.body,
                            max_bytes=_MAX_RESPONSE_BYTES,
                        )
                    ),
                    input_sha256=sha256_digest(response.transport.body),
                    observed_at=response.observed_at,
                    lookup_locator=locator,
                )
                return metadata_ports._RawPage(
                    items=(raw,),
                    next_cursor=None,
                    exhausted=True,
                )

            return metadata_ports._PagedRawItemSession(fetch_uid, self._convert_document)

        vendor_query = (
            f'DO="{_escape_query_literal(value)}"' if operation == "DO" else f"PMID={value}"
        )
        seen_items = 0

        def fetch_query(
            page: int | None,
        ) -> metadata_ports._RawPage[_RawStarterDocument, int]:
            nonlocal seen_items
            requested_page = 1 if page is None else page
            response = self._request(
                _starter_search_url(
                    vendor_query,
                    database=self._database,
                    page_size=self._page_size,
                    page=requested_page,
                ),
                allow_not_found=True,
            )
            if response is None:
                return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)
            values, total = _starter_page(
                response,
                requested_page=requested_page,
                page_size=self._page_size,
                seen_items=seen_items,
            )
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawStarterDocument(
                    value=item,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                    lookup_locator=locator,
                )
                for item in values
            )
            seen_items += len(items)
            exhausted = seen_items >= total
            return metadata_ports._RawPage(
                items=items,
                next_cursor=None if exhausted else requested_page + 1,
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_query, self._convert_document)

    def _convert_document(self, envelope: _RawStarterDocument) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawStarterDocument):
            raise TypeError("raw Starter document must use the private envelope")
        document = require_json_object(envelope.value)
        key = _starter_key(document)
        if envelope.lookup_locator is not None and not _locator_matches(
            envelope.lookup_locator, key
        ):
            raise invalid_record_failure()
        provenance = self._provenance(
            source_record_id=_required_record_id(key),
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        try:
            observation = MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=_starter_metadata(document, identifiers=key.identifiers),
                declared_keywords=_starter_keywords(document.get("keywords")),
                cited_by_count=_starter_cited_by_count(
                    document.get("citations"),
                    database=self._database,
                    edition=self._edition,
                ),
            )
        except ValidationError:
            raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=(stabilize_provider_metadata_observation(observation),),
            relations=(),
        )


class WebOfScienceExpandedAdapter(_WebOfScienceAdapterBase):
    """Web of Science API Expanded Full Record and citation adapter."""

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
        database: str,
        edition: str | None = None,
        page_size: int = 100,
    ) -> None:
        super().__init__(
            http_client=http_client,
            access_coordinator=access_coordinator,
            access_scope=access_scope,
            access_policy=access_policy,
            expected_scope=EXPANDED_ACCESS_SCOPE,
            baseline_policy=EXPANDED_BASELINE_ACCESS_POLICY,
            product=_EXPANDED_PRODUCT,
            credential_origin=_EXPANDED_CREDENTIAL_ORIGIN,
            observation_id_factory=observation_id_factory,
            provenance_id_factory=provenance_id_factory,
            clock=clock,
            api_key=api_key,
            database=database,
            edition=edition,
            page_size=page_size,
            maximum_page_size=100,
        )

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe the configured Expanded database with one Full Record query."""

        def operation() -> None:
            response = self._request(
                _expanded_search_url(
                    "TS=(metadata)",
                    database=self._database,
                    page_size=1,
                    first_record=1,
                ),
                probe=True,
            )
            _expanded_record_page_body(
                response.body,
                first_record=1,
                page_size=1,
                seen_items=0,
            )

        return self._run_probe(operation)

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        vendor_query = _topic_query(query)
        seen_items = 0

        def fetch_page(
            first_record: int | None,
        ) -> metadata_ports._RawPage[_RawExpandedRecord, int]:
            nonlocal seen_items
            requested_first = 1 if first_record is None else first_record
            response = self._request(
                _expanded_search_url(
                    vendor_query,
                    database=self._database,
                    page_size=self._page_size,
                    first_record=requested_first,
                )
            )
            assert response is not None
            values, total = _expanded_record_page(
                response,
                first_record=requested_first,
                page_size=self._page_size,
                seen_items=seen_items,
            )
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawExpandedRecord(
                    value=value,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for value in values
            )
            seen_items += len(items)
            exhausted = seen_items >= total
            return metadata_ports._RawPage(
                items=items,
                next_cursor=None if exhausted else requested_first + len(items),
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_record)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        operation, value = _lookup_operation(key)
        locator = _LookupLocator(operation=operation, value=value)
        if operation == "uid":

            def fetch_uid(
                cursor: None,
            ) -> metadata_ports._RawPage[_RawExpandedRecord, None]:
                if cursor is not None:
                    raise TypeError("Expanded UID lookup has no cursor")
                response = self._request(
                    _expanded_id_url(database=self._database),
                    path_parameter=value,
                    allow_not_found=True,
                )
                if response is None:
                    return metadata_ports._RawPage(
                        items=(),
                        next_cursor=None,
                        exhausted=True,
                    )
                values, total = _expanded_record_page(
                    response,
                    first_record=1,
                    page_size=self._page_size,
                    seen_items=0,
                )
                if total > 1 or len(values) > 1:
                    raise _protocol_failure()
                input_sha256 = sha256_digest(response.transport.body)
                items = tuple(
                    _RawExpandedRecord(
                        value=item,
                        input_sha256=input_sha256,
                        observed_at=response.observed_at,
                        lookup_locator=locator,
                    )
                    for item in values
                )
                return metadata_ports._RawPage(
                    items=items,
                    next_cursor=None,
                    exhausted=True,
                )

            return metadata_ports._PagedRawItemSession(fetch_uid, self._convert_record)

        vendor_query = f'{operation}=("{_escape_query_literal(value)}")'
        seen_items = 0

        def fetch_query(
            first_record: int | None,
        ) -> metadata_ports._RawPage[_RawExpandedRecord, int]:
            nonlocal seen_items
            requested_first = 1 if first_record is None else first_record
            response = self._request(
                _expanded_search_url(
                    vendor_query,
                    database=self._database,
                    page_size=self._page_size,
                    first_record=requested_first,
                ),
                allow_not_found=True,
            )
            if response is None:
                return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)
            values, total = _expanded_record_page(
                response,
                first_record=requested_first,
                page_size=self._page_size,
                seen_items=seen_items,
            )
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawExpandedRecord(
                    value=item,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                    lookup_locator=locator,
                )
                for item in values
            )
            seen_items += len(items)
            exhausted = seen_items >= total
            return metadata_ports._RawPage(
                items=items,
                next_cursor=None if exhausted else requested_first + len(items),
                exhausted=exhausted,
            )

        return metadata_ports._PagedRawItemSession(fetch_query, self._convert_record)

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        if not isinstance(query, ReferenceQueryContext):
            raise TypeError("query must be a ReferenceQueryContext")
        tasks = _expanded_reference_tasks(query)

        def fetch_page(
            cursor: _ExpandedReferenceCursor | None,
        ) -> metadata_ports._RawPage[
            _RawExpandedReference | _RawExpandedRecord,
            _ExpandedReferenceCursor,
        ]:
            state = cursor or _ExpandedReferenceCursor(task_index=0, first_record=1)
            while state.task_index < len(tasks):
                task = tasks[state.task_index]
                if task.kind == "citing" and not _expanded_supports_citing(
                    database=self._database,
                    edition=self._edition,
                ):
                    raise _unsupported_reference_direction_failure()
                if task.kind == "references":
                    response = self._request(
                        _expanded_reference_url(
                            database=self._database,
                            uid=_required_record_id(task.anchor),
                            page_size=self._page_size,
                            first_record=state.first_record,
                        )
                    )
                    assert response is not None
                    values, total = _expanded_reference_page(
                        response,
                        first_record=state.first_record,
                        page_size=self._page_size,
                    )
                    input_sha256 = sha256_digest(response.transport.body)
                    items: tuple[_RawExpandedReference | _RawExpandedRecord, ...] = tuple(
                        _RawExpandedReference(
                            value=value,
                            anchor=task.anchor,
                            input_sha256=input_sha256,
                            observed_at=response.observed_at,
                        )
                        for value in values
                    )
                else:
                    response = self._request(
                        _expanded_citing_url(
                            uid=_required_record_id(task.anchor),
                            page_size=self._page_size,
                            first_record=state.first_record,
                        )
                    )
                    assert response is not None
                    values, total = _expanded_record_page(
                        response,
                        first_record=state.first_record,
                        page_size=self._page_size,
                        seen_items=state.first_record - 1,
                    )
                    input_sha256 = sha256_digest(response.transport.body)
                    items = tuple(
                        _RawExpandedRecord(
                            value=value,
                            input_sha256=input_sha256,
                            observed_at=response.observed_at,
                            cited_anchor=task.anchor,
                        )
                        for value in values
                    )

                consumed_through = state.first_record - 1 + len(items)
                task_exhausted = consumed_through >= total
                if not items and not task_exhausted:
                    raise _protocol_failure()
                next_state = (
                    _ExpandedReferenceCursor(state.task_index + 1, 1)
                    if task_exhausted
                    else _ExpandedReferenceCursor(
                        state.task_index,
                        state.first_record + len(items),
                    )
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

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_reference_item)

    def _convert_reference_item(
        self,
        envelope: _RawExpandedReference | _RawExpandedRecord,
    ) -> NeutralMetadataItem:
        if isinstance(envelope, _RawExpandedRecord):
            return self._convert_record(envelope)
        if not isinstance(envelope, _RawExpandedReference):
            raise TypeError("raw Expanded relation must use the private envelope")
        reference = require_json_object(envelope.value)
        target = _expanded_reference_target(reference)
        if target is None or _keys_overlap(target, envelope.anchor):
            return NeutralMetadataItem()
        provenance = self._provenance(
            source_record_id=target.record_id or _first_identifier_position(target),
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        try:
            relation = ProviderRelationObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                citing=envelope.anchor,
                cited=target,
            )
        except ValidationError:
            raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=(),
            relations=(stabilize_provider_relation_observation(relation),),
        )

    def _convert_record(self, envelope: _RawExpandedRecord) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawExpandedRecord):
            raise TypeError("raw Expanded record must use the private envelope")
        record = require_json_object(envelope.value)
        key = _expanded_key(record)
        if envelope.lookup_locator is not None and not _locator_matches(
            envelope.lookup_locator, key
        ):
            raise invalid_record_failure()
        provenance = self._provenance(
            source_record_id=_required_record_id(key),
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        try:
            observation = MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=_expanded_metadata(record, identifiers=key.identifiers),
                declared_keywords=_expanded_keywords(record),
                reference_count=_expanded_reference_count(record),
                cited_by_count=_expanded_cited_by_count(
                    record,
                    database=self._database,
                    edition=self._edition,
                ),
            )
            relations: tuple[ProviderRelationObservation, ...] = ()
            if envelope.cited_anchor is not None and not _keys_overlap(
                key,
                envelope.cited_anchor,
            ):
                relations = (
                    ProviderRelationObservation(
                        observation_id=self._new_observation_id(),
                        provenance=provenance,
                        citing=key,
                        cited=envelope.cited_anchor,
                    ),
                )
        except ValidationError:
            raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=(stabilize_provider_metadata_observation(observation),),
            relations=tuple(
                stabilize_provider_relation_observation(relation) for relation in relations
            ),
        )


def _starter_search_url(
    query: str,
    *,
    database: str,
    page_size: int,
    page: int,
) -> str:
    parameters = (
        ("q", query),
        ("db", database),
        ("limit", str(page_size)),
        ("page", str(page)),
    )
    return f"{_STARTER_DOCUMENTS}?{urlencode(parameters)}"


def _expanded_search_url(
    query: str,
    *,
    database: str,
    page_size: int,
    first_record: int,
) -> str:
    parameters = (
        ("databaseId", database),
        ("usrQuery", query),
        ("count", str(page_size)),
        ("firstRecord", str(first_record)),
        ("optionView", "FR"),
    )
    return f"{_EXPANDED_ROOT}/?{urlencode(parameters)}"


def _expanded_id_url(*, database: str) -> str:
    return f"{_EXPANDED_ID}?{urlencode((('databaseId', database), ('optionView', 'FR')))}"


def _expanded_reference_url(
    *,
    database: str,
    uid: str,
    page_size: int,
    first_record: int,
) -> str:
    parameters = (
        ("databaseId", database),
        ("uniqueId", uid),
        ("count", str(page_size)),
        ("firstRecord", str(first_record)),
    )
    return f"{_EXPANDED_REFERENCES}?{urlencode(parameters)}"


def _expanded_citing_url(*, uid: str, page_size: int, first_record: int) -> str:
    parameters = (
        ("databaseId", "WOS"),
        ("uniqueId", uid),
        ("count", str(page_size)),
        ("firstRecord", str(first_record)),
        ("optionView", "FR"),
    )
    return f"{_EXPANDED_CITING}?{urlencode(parameters)}"


def _starter_page(
    response: _ObservedResponse,
    *,
    requested_page: int,
    page_size: int,
    seen_items: int,
) -> tuple[tuple[object, ...], int]:
    return _starter_page_body(
        response.transport.body,
        requested_page=requested_page,
        page_size=page_size,
        seen_items=seen_items,
    )


def _starter_page_body(
    body: bytes,
    *,
    requested_page: int,
    page_size: int,
    seen_items: int,
) -> tuple[tuple[object, ...], int]:
    root = require_json_object(parse_bounded_json(body, max_bytes=_MAX_RESPONSE_BYTES))
    if "metadata" not in root or "hits" not in root:
        raise unknown_shape_failure()
    metadata = require_json_object(root.get("metadata"))
    if not {"total", "page", "limit"} <= metadata.keys():
        raise unknown_shape_failure()
    total = strict_nonnegative_integer(metadata.get("total"))
    returned_page = strict_nonnegative_integer(metadata.get("page"))
    returned_limit = strict_nonnegative_integer(metadata.get("limit"))
    if returned_page != requested_page or returned_limit != page_size:
        raise _protocol_failure()
    values = require_json_array(root.get("hits"))
    if len(values) > page_size or seen_items + len(values) > total:
        raise _protocol_failure()
    if not values and seen_items < total:
        raise _protocol_failure()
    return values, total


def _expanded_record_page(
    response: _ObservedResponse,
    *,
    first_record: int,
    page_size: int,
    seen_items: int,
) -> tuple[tuple[object, ...], int]:
    return _expanded_record_page_body(
        response.transport.body,
        first_record=first_record,
        page_size=page_size,
        seen_items=seen_items,
    )


def _expanded_record_page_body(
    body: bytes,
    *,
    first_record: int,
    page_size: int,
    seen_items: int,
) -> tuple[tuple[object, ...], int]:
    root = require_json_object(parse_bounded_json(body, max_bytes=_MAX_RESPONSE_BYTES))
    if "Data" not in root or "QueryResult" not in root:
        raise unknown_shape_failure()
    data = require_json_object(root.get("Data"))
    records = require_json_object(data.get("Records"))
    record_container = require_json_object(records.get("records"))
    values = require_json_array(record_container.get("REC"))
    query_result = require_json_object(root.get("QueryResult"))
    if "RecordsFound" not in query_result:
        raise unknown_shape_failure()
    total = strict_nonnegative_integer(query_result.get("RecordsFound"))
    if first_record < 1 or seen_items != first_record - 1:
        raise _protocol_failure()
    if len(values) > page_size or seen_items + len(values) > total:
        raise _protocol_failure()
    if not values and seen_items < total:
        raise _protocol_failure()
    return values, total


def _expanded_reference_page(
    response: _ObservedResponse,
    *,
    first_record: int,
    page_size: int,
) -> tuple[tuple[object, ...], int]:
    root = require_json_object(
        parse_bounded_json(response.transport.body, max_bytes=_MAX_RESPONSE_BYTES)
    )
    if "Data" not in root or "QueryResult" not in root:
        raise unknown_shape_failure()
    values = require_json_array(root.get("Data"))
    query_result = require_json_object(root.get("QueryResult"))
    if "RecordsFound" not in query_result:
        raise unknown_shape_failure()
    total = strict_nonnegative_integer(query_result.get("RecordsFound"))
    seen_items = first_record - 1
    if first_record < 1 or len(values) > page_size or seen_items + len(values) > total:
        raise _protocol_failure()
    if not values and seen_items < total:
        raise _protocol_failure()
    return values, total


def _topic_query(query: TopicSearchQuery) -> str:
    literal = _escape_query_literal(query.query)
    clauses = [f'TS=("{literal}")']
    if query.year_from is not None or query.year_to is not None:
        lower = 1 if query.year_from is None else query.year_from
        upper = 9999 if query.year_to is None else query.year_to
        clauses.append(f"PY=({lower:04d}-{upper:04d})")
    return " AND ".join(clauses)


def _escape_query_literal(value: str) -> str:
    if type(value) is not str:
        raise TypeError("query literal must be a string")
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _lookup_operation(key: ProviderLiteratureKey) -> tuple[_LookupOperation, str]:
    if key.record_id is not None:
        return "uid", _normalized_wos_uid(key.record_id)
    for identifier in key.identifiers:
        if identifier.namespace == "doi":
            return "DO", identifier.value
    for identifier in key.identifiers:
        if identifier.namespace == "pmid":
            return "PMID", identifier.value
    raise _lookup_key_failure()


def _locator_matches(locator: _LookupLocator, key: ProviderLiteratureKey) -> bool:
    if locator.operation == "uid":
        return key.record_id == locator.value
    namespace = "doi" if locator.operation == "DO" else "pmid"
    return any(
        identifier.namespace == namespace and identifier.value == locator.value
        for identifier in key.identifiers
    )


def _expanded_reference_tasks(
    query: ReferenceQueryContext,
) -> tuple[_ExpandedReferenceTask, ...]:
    if query.direction == "references":
        kinds: tuple[_ExpandedReferenceKind, ...] = ("references",)
    elif query.direction == "cited-by":
        kinds = ("citing",)
    else:
        kinds = ("references", "citing")
    return tuple(
        _ExpandedReferenceTask(anchor=_reference_anchor(key), kind=kind)
        for key in query.keys
        for kind in kinds
    )


def _reference_anchor(key: ProviderLiteratureKey) -> ProviderLiteratureKey:
    if key.record_id is None:
        raise _lookup_key_failure()
    try:
        return ProviderLiteratureKey(
            record_id=_normalized_wos_uid(key.record_id),
            identifiers=key.identifiers,
        )
    except ValidationError:
        raise _lookup_key_failure() from None


def _starter_key(document: dict[str, object]) -> ProviderLiteratureKey:
    uid = _required_wos_uid(document.get("uid"))
    identifiers_object = _optional_object(document.get("identifiers"))
    identifiers = () if identifiers_object is None else _flat_identifiers(identifiers_object)
    try:
        return ProviderLiteratureKey(record_id=uid, identifiers=identifiers)
    except ValidationError:
        raise invalid_record_failure() from None


def _expanded_key(record: dict[str, object]) -> ProviderLiteratureKey:
    uid = _required_wos_uid(record.get("UID"))
    identifiers = _expanded_identifiers(record)
    try:
        return ProviderLiteratureKey(record_id=uid, identifiers=identifiers)
    except ValidationError:
        raise invalid_record_failure() from None


def _expanded_reference_target(
    reference: dict[str, object],
) -> ProviderLiteratureKey | None:
    raw_uid = optional_nonblank_string(reference.get("UID"))
    uid = None if raw_uid is None else _normalized_wos_uid(raw_uid)
    raw_doi = optional_nonblank_string(reference.get("doi"))
    identifiers: tuple[Identifier, ...] = ()
    if raw_doi is not None:
        identifiers = (_identifier("doi", raw_doi),)
    if uid is None and not identifiers:
        return None
    try:
        return ProviderLiteratureKey(record_id=uid, identifiers=identifiers)
    except ValidationError:
        raise invalid_record_failure() from None


def _keys_overlap(left: ProviderLiteratureKey, right: ProviderLiteratureKey) -> bool:
    if left.record_id is not None and right.record_id is not None:
        try:
            if _normalized_wos_uid(left.record_id) == _normalized_wos_uid(right.record_id):
                return True
        except MetadataProviderFailure:
            pass
    return any(identifier in right.identifiers for identifier in left.identifiers)


def _required_record_id(key: ProviderLiteratureKey) -> str:
    if key.record_id is None:
        raise invalid_record_failure()
    return key.record_id


def _first_identifier_position(key: ProviderLiteratureKey) -> str:
    if not key.identifiers:
        raise invalid_record_failure()
    first = key.identifiers[0]
    return f"{first.namespace}:{first.value}"


def _required_wos_uid(value: object) -> str:
    candidate = optional_nonblank_string(value)
    if candidate is None:
        raise invalid_record_failure()
    try:
        return _normalized_wos_uid(candidate)
    except MetadataProviderFailure:
        raise invalid_record_failure() from None


def _normalized_wos_uid(value: str) -> str:
    if type(value) is not str:
        raise _lookup_key_failure()
    candidate = unicodedata.normalize("NFC", value.strip())
    if _WOS_UID.fullmatch(candidate) is None:
        raise _lookup_key_failure()
    return candidate


def _starter_metadata(
    document: dict[str, object],
    *,
    identifiers: tuple[Identifier, ...],
) -> LiteratureMetadata:
    source = _optional_object(document.get("source"))
    try:
        return LiteratureMetadata(
            title=optional_nonblank_string(document.get("title")),
            authors=_starter_authors(document.get("names")),
            abstract=None,
            publication_date=None,
            publication_year=(
                None if source is None else _optional_year(source.get("publishYear"))
            ),
            document_type=_first_string(document.get("types")),
            language=None,
            venue=(None if source is None else optional_nonblank_string(source.get("sourceTitle"))),
            publisher=None,
            volume=None if source is None else optional_nonblank_string(source.get("volume")),
            issue=None if source is None else optional_nonblank_string(source.get("issue")),
            pages=_starter_pages(source),
            identifiers=identifiers,
            keywords=(),
        )
    except ValidationError:
        raise invalid_record_failure() from None


def _starter_authors(value: object) -> tuple[Author, ...]:
    names = _optional_object(value)
    if names is None or "authors" not in names:
        return ()
    raw_authors = require_json_array(names.get("authors"))
    result: list[Author] = []
    for raw_author in raw_authors:
        author = require_json_object(raw_author)
        display_name = optional_nonblank_string(author.get("displayName"))
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


def _starter_pages(source: dict[str, object] | None) -> str | None:
    if source is None:
        return None
    pages = _optional_object(source.get("pages"))
    if pages is not None:
        page_range = optional_nonblank_string(pages.get("range"))
        if page_range is not None:
            return page_range
    return optional_nonblank_string(source.get("articleNumber"))


def _starter_keywords(value: object) -> tuple[str, ...]:
    keywords = _optional_object(value)
    if keywords is None or "authorKeywords" not in keywords:
        return ()
    return _string_values(keywords.get("authorKeywords"))


def _starter_cited_by_count(
    value: object,
    *,
    database: str,
    edition: str | None,
) -> int | None:
    if value is None:
        return None
    targets = _collection_targets(database, edition)
    counts: dict[str, list[int]] = {}
    for raw_item in require_json_array(value):
        item = require_json_object(raw_item)
        collection = optional_nonblank_string(item.get("db"))
        if collection is None:
            continue
        count = optional_nonnegative_integer(item.get("count"))
        if count is not None:
            counts.setdefault(collection.casefold(), []).append(count)
    return _selected_collection_count(counts, targets)


def _flat_identifiers(value: dict[str, object]) -> tuple[Identifier, ...]:
    result: list[Identifier] = []
    for field_name, namespace in (("doi", "doi"), ("pmid", "pmid")):
        raw = optional_nonblank_string(value.get(field_name))
        if raw is None:
            continue
        identifier = _identifier(namespace, raw)
        if identifier not in result:
            result.append(identifier)
    return tuple(result)


def _expanded_metadata(
    record: dict[str, object],
    *,
    identifiers: tuple[Identifier, ...],
) -> LiteratureMetadata:
    static_data = require_json_object(record.get("static_data"))
    summary = require_json_object(static_data.get("summary"))
    full_record = _optional_object(static_data.get("fullrecord_metadata")) or {}
    pub_info = _optional_object(summary.get("pub_info"))
    publication_date, publication_year = _expanded_publication(pub_info)
    addresses = _expanded_addresses(full_record.get("addresses"))
    try:
        return LiteratureMetadata(
            title=_expanded_title(summary, kind="item"),
            authors=_expanded_authors(summary.get("names"), addresses=addresses),
            abstract=_expanded_abstract(full_record.get("abstracts")),
            publication_date=publication_date,
            publication_year=publication_year,
            document_type=_expanded_document_type(summary.get("doctypes")),
            language=_expanded_language(full_record),
            venue=_expanded_title(summary, kind="source"),
            publisher=_expanded_publisher(summary.get("publishers")),
            volume=None if pub_info is None else _first_field(pub_info, "vol", "volume"),
            issue=None if pub_info is None else optional_nonblank_string(pub_info.get("issue")),
            pages=_expanded_pages(pub_info),
            identifiers=identifiers,
            keywords=(),
        )
    except ValidationError:
        raise invalid_record_failure() from None


def _expanded_title(summary: dict[str, object], *, kind: str) -> str | None:
    titles = _optional_object(summary.get("titles"))
    if titles is None or "title" not in titles:
        return None
    for raw_title in require_json_array(titles.get("title")):
        title = require_json_object(raw_title)
        title_type = optional_nonblank_string(title.get("type"))
        if title_type is not None and title_type.casefold() == kind.casefold():
            content = optional_nonblank_string(title.get("content"))
            if content is not None:
                return content
    return None


def _expanded_publication(
    pub_info: dict[str, object] | None,
) -> tuple[str | None, int | None]:
    if pub_info is None:
        return None, None
    publication_date = _first_field(
        pub_info,
        "sortdate",
        "_sortdate",
        "coverdate",
        "_coverdate",
        "early_access_date",
    )
    raw_year = pub_info.get("pubyear", pub_info.get("year"))
    year = _optional_year(raw_year)
    if year is None and publication_date is not None:
        match = _FOUR_DIGIT_YEAR.match(publication_date)
        year = None if match is None else int(match.group())
    return publication_date, year


def _expanded_pages(pub_info: dict[str, object] | None) -> str | None:
    if pub_info is None:
        return None
    raw_page = pub_info.get("page")
    if raw_page is not None:
        page = require_json_object(raw_page)
        content = optional_nonblank_string(page.get("content"))
        if content is not None:
            return content
        begin = optional_nonblank_string(page.get("page_begin"))
        end = optional_nonblank_string(page.get("page_end"))
        if begin is not None and end is not None:
            return begin if begin == end else f"{begin}-{end}"
        if begin is not None:
            return begin
    return _first_field(pub_info, "art_no", "article_no")


def _expanded_document_type(value: object) -> str | None:
    doctypes = _optional_object(value)
    if doctypes is None or "doctype" not in doctypes:
        return None
    return _first_string(doctypes.get("doctype"))


def _expanded_publisher(value: object) -> str | None:
    publishers = _optional_object(value)
    if publishers is None or "publisher" not in publishers:
        return None
    for raw_publisher in require_json_array(publishers.get("publisher")):
        publisher = require_json_object(raw_publisher)
        names = _optional_object(publisher.get("names"))
        if names is None or "name" not in names:
            continue
        for raw_name in require_json_array(names.get("name")):
            name = require_json_object(raw_name)
            display = _first_field(name, "display_name", "full_name")
            if display is not None:
                return display
    return None


def _expanded_addresses(value: object) -> dict[int, Affiliation]:
    addresses = _optional_object(value)
    if addresses is None or "address_name" not in addresses:
        return {}
    result: dict[int, Affiliation] = {}
    for raw_address in require_json_array(addresses.get("address_name")):
        address = require_json_object(raw_address)
        specification = require_json_object(address.get("address_spec"))
        number = _positive_sequence_number(specification.get("addr_no"), required=True)
        assert number is not None
        name = optional_nonblank_string(specification.get("full_address"))
        if name is None:
            name = _preferred_organization(specification.get("organizations"))
        if name is None:
            continue
        try:
            affiliation = Affiliation(name=name)
        except ValidationError:
            raise invalid_record_failure() from None
        previous = result.get(number)
        if previous is not None and previous != affiliation:
            raise invalid_record_failure()
        result[number] = affiliation
    return result


def _preferred_organization(value: object) -> str | None:
    organizations = _optional_object(value)
    if organizations is None or "organization" not in organizations:
        return None
    fallback: str | None = None
    for raw_organization in require_json_array(organizations.get("organization")):
        organization = require_json_object(raw_organization)
        content = optional_nonblank_string(organization.get("content"))
        if content is None:
            continue
        fallback = content if fallback is None else fallback
        preferred = optional_nonblank_string(organization.get("pref"))
        if preferred is not None and preferred.casefold() in {"y", "yes", "true"}:
            return content
    return fallback


def _expanded_authors(
    value: object,
    *,
    addresses: dict[int, Affiliation],
) -> tuple[Author, ...]:
    names = _optional_object(value)
    if names is None or "name" not in names:
        return ()
    ordered: list[tuple[int, int, dict[str, object]]] = []
    for index, raw_name in enumerate(require_json_array(names.get("name"))):
        name = require_json_object(raw_name)
        role = optional_nonblank_string(name.get("role"))
        if role is None or role.casefold() != "author":
            continue
        sequence = _positive_sequence_number(name.get("seq_no"), required=False)
        ordered.append((sequence if sequence is not None else 1_000_000 + index, index, name))
    ordered.sort(key=lambda item: (item[0], item[1]))

    result: list[Author] = []
    for _sequence, _index, name in ordered:
        display_name = _first_field(name, "display_name", "full_name")
        if display_name is None:
            continue
        given_name = optional_nonblank_string(name.get("first_name"))
        family_name = optional_nonblank_string(name.get("last_name"))
        orcid = _optional_orcid(name.get("orcid_id"))
        kind = (
            AuthorKind.PERSON
            if given_name is not None or family_name is not None or orcid is not None
            else AuthorKind.UNKNOWN
        )
        affiliations = tuple(
            addresses[number]
            for number in _address_numbers(name.get("addr_no"))
            if number in addresses
        )
        affiliations = tuple(dict.fromkeys(affiliations))
        try:
            result.append(
                Author(
                    kind=kind,
                    display_name=display_name,
                    given_name=given_name,
                    family_name=family_name,
                    orcid=orcid,
                    affiliations=affiliations,
                )
            )
        except ValidationError:
            raise invalid_record_failure() from None
    return tuple(result)


def _address_numbers(value: object) -> tuple[int, ...]:
    if value is None:
        return ()
    result: list[int] = []
    for item in require_json_array(value):
        number = _positive_sequence_number(item, required=True)
        assert number is not None
        if number not in result:
            result.append(number)
    return tuple(result)


def _positive_sequence_number(value: object, *, required: bool) -> int | None:
    if value is None:
        if required:
            raise invalid_record_failure()
        return None
    if type(value) is int:
        candidate = value
    elif type(value) is str and value.strip().isdigit():
        candidate = int(value.strip())
    else:
        raise invalid_record_failure()
    if candidate < 1:
        raise invalid_record_failure()
    return candidate


def _optional_orcid(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    prefix = "https://orcid.org/"
    candidate = raw[len(prefix) :] if raw.casefold().startswith(prefix) else raw
    try:
        validated = Author(
            kind=AuthorKind.PERSON,
            display_name="ORCID holder",
            orcid=candidate,
        )
    except ValidationError:
        raise invalid_record_failure() from None
    return validated.orcid


def _expanded_abstract(value: object) -> str | None:
    abstracts = _optional_object(value)
    if abstracts is None or "abstract" not in abstracts:
        return None
    paragraphs: list[str] = []
    for raw_abstract in require_json_array(abstracts.get("abstract")):
        abstract = require_json_object(raw_abstract)
        abstract_text = _optional_object(abstract.get("abstract_text"))
        if abstract_text is None or "p" not in abstract_text:
            continue
        for raw_paragraph in require_json_array(abstract_text.get("p")):
            paragraph = optional_nonblank_string(raw_paragraph)
            if paragraph is not None:
                paragraphs.append(paragraph)
    return "\n\n".join(paragraphs) or None


def _expanded_language(full_record: dict[str, object]) -> str | None:
    for field_name in ("normalized_languages", "languages"):
        languages = _optional_object(full_record.get(field_name))
        if languages is None or "language" not in languages:
            continue
        fallback: str | None = None
        for raw_language in require_json_array(languages.get("language")):
            language = require_json_object(raw_language)
            content = optional_nonblank_string(language.get("content"))
            if content is None:
                continue
            fallback = content if fallback is None else fallback
            language_type = optional_nonblank_string(language.get("type"))
            if language_type is not None and language_type.casefold() == "primary":
                return content
        if fallback is not None:
            return fallback
    return None


def _expanded_keywords(record: dict[str, object]) -> tuple[str, ...]:
    static_data = require_json_object(record.get("static_data"))
    full_record = _optional_object(static_data.get("fullrecord_metadata"))
    if full_record is None:
        return ()
    keywords = _optional_object(full_record.get("keywords"))
    if keywords is None or "keyword" not in keywords:
        return ()
    return _string_values(keywords.get("keyword"))


def _expanded_identifiers(record: dict[str, object]) -> tuple[Identifier, ...]:
    result: list[Identifier] = []
    static_data = require_json_object(record.get("static_data"))
    item = _optional_object(static_data.get("item"))
    if item is not None:
        _append_expanded_identifier_container(result, item.get("identifiers"))
    dynamic_data = _optional_object(record.get("dynamic_data"))
    if dynamic_data is not None:
        cluster = _optional_object(dynamic_data.get("cluster_related"))
        if cluster is not None:
            _append_expanded_identifier_container(result, cluster.get("identifiers"))
    return tuple(result)


def _append_expanded_identifier_container(
    result: list[Identifier],
    value: object,
) -> None:
    identifiers = _optional_object(value)
    if identifiers is None or "identifier" not in identifiers:
        return
    for raw_item in require_json_array(identifiers.get("identifier")):
        item = require_json_object(raw_item)
        identifier_type = optional_nonblank_string(item.get("type"))
        raw_value = optional_nonblank_string(item.get("value"))
        if identifier_type is None or raw_value is None:
            continue
        namespace = identifier_type.casefold()
        if namespace not in {"doi", "pmid"}:
            continue
        identifier = _identifier(namespace, raw_value)
        if identifier not in result:
            result.append(identifier)


def _expanded_reference_count(record: dict[str, object]) -> int | None:
    static_data = require_json_object(record.get("static_data"))
    full_record = _optional_object(static_data.get("fullrecord_metadata"))
    if full_record is None:
        return None
    references = _optional_object(full_record.get("refs"))
    if references is None:
        return None
    return optional_nonnegative_integer(references.get("count"))


def _expanded_cited_by_count(
    record: dict[str, object],
    *,
    database: str,
    edition: str | None,
) -> int | None:
    dynamic_data = _optional_object(record.get("dynamic_data"))
    if dynamic_data is None:
        return None
    citation_related = _optional_object(dynamic_data.get("citation_related"))
    if citation_related is None:
        return None
    count_list = _optional_object(citation_related.get("tc_list"))
    if count_list is None or "silo_tc" not in count_list:
        return None
    targets = _collection_targets(database, edition)
    counts: dict[str, list[int]] = {}
    for raw_count in require_json_array(count_list.get("silo_tc")):
        count = require_json_object(raw_count)
        collection = optional_nonblank_string(count.get("coll_id"))
        if collection is None:
            continue
        local_count = optional_nonnegative_integer(count.get("local_count"))
        if local_count is not None:
            counts.setdefault(collection.casefold(), []).append(local_count)
    return _selected_collection_count(counts, targets)


def _collection_targets(database: str, edition: str | None) -> tuple[str, ...]:
    if edition is not None:
        return (edition.casefold(),)
    return (database.casefold(),)


def _expanded_supports_citing(*, database: str, edition: str | None) -> bool:
    if database.casefold() != "wos":
        return False
    return edition is None or edition.casefold() not in _NON_CORE_CITING_EDITIONS


def _single_collection_count(values: list[int]) -> int | None:
    if not values:
        return None
    if any(value != values[0] for value in values[1:]):
        raise invalid_record_failure()
    return values[0]


def _selected_collection_count(
    counts: dict[str, list[int]],
    targets: tuple[str, ...],
) -> int | None:
    for target in targets:
        if target in counts:
            return _single_collection_count(counts[target])
    return None


def _identifier(namespace: str, value: str) -> Identifier:
    try:
        return Identifier(namespace=namespace, value=value)
    except ValidationError:
        raise invalid_record_failure() from None


def _optional_object(value: object) -> dict[str, object] | None:
    return None if value is None else require_json_object(value)


def _first_string(value: object) -> str | None:
    if value is None:
        return None
    for item in require_json_array(value):
        candidate = optional_nonblank_string(item)
        if candidate is not None:
            return candidate
    return None


def _string_values(value: object) -> tuple[str, ...]:
    result: list[str] = []
    for item in require_json_array(value):
        candidate = optional_nonblank_string(item)
        if candidate is not None and candidate not in result:
            result.append(candidate)
    return tuple(result)


def _first_field(value: dict[str, object], *field_names: str) -> str | None:
    for field_name in field_names:
        candidate = optional_nonblank_string(value.get(field_name))
        if candidate is not None:
            return candidate
    return None


def _optional_year(value: object) -> int | None:
    if value is None:
        return None
    if type(value) is int:
        year = value
    elif type(value) is str and _FOUR_DIGIT_YEAR.fullmatch(value.strip()) is not None:
        year = int(value.strip())
    else:
        raise invalid_record_failure()
    if not 1 <= year <= 9999:
        raise invalid_record_failure()
    return year


def _private_api_key(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("api_key must be a string or None")
    candidate = value.strip()
    if not candidate:
        return None
    if any(ord(character) < 32 or ord(character) == 127 for character in candidate):
        raise ValueError("api_key must not contain control characters")
    return candidate


def _ordinary_parameter(value: str, *, field_name: str) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be a string")
    candidate = unicodedata.normalize("NFC", value.strip())
    if not candidate:
        raise ValueError(f"{field_name} must be nonblank")
    if len(candidate) > 128 or any(
        ord(character) < 32 or ord(character) == 127 for character in candidate
    ):
        raise ValueError(f"{field_name} must be a safe ordinary parameter")
    return candidate


def _optional_ordinary_parameter(value: str | None, *, field_name: str) -> str | None:
    return None if value is None else _ordinary_parameter(value, field_name=field_name)


def _provenance_parameters_sha256(
    *,
    product: str,
    database: str,
    edition: str | None,
) -> Sha256:
    encoded = json.dumps(
        {
            "database": database,
            "edition": edition,
            "product": product,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


def _web_of_science_feedback(
    status: int,
    headers: Sequence[Header],
    *,
    wall_now: datetime,
    expanded: bool,
) -> AccessFeedback | None:
    standard = retry_after_feedback(status, headers, wall_now=wall_now)
    if not expanded:
        return standard
    record_remaining = _nonnegative_header_number(
        header_value(headers, "X-REC-AmtPerYear-Remaining")
    )
    request_remaining = _nonnegative_header_number(
        header_value(headers, "X-REQ-ReqPerSec-Remaining")
    )
    exhausted = record_remaining == 0.0 or request_remaining == 0.0
    if standard is None:
        return AccessFeedback(throttled=True) if exhausted else None
    if not exhausted or standard.throttled:
        return standard
    return AccessFeedback(
        retry_after=standard.retry_after,
        blocked_until=standard.blocked_until,
        quota_reset_at=standard.quota_reset_at,
        throttled=True,
    )


def _conservative_feedback_after_failure(status: int) -> AccessFeedback | None:
    if status == 429:
        return AccessFeedback(throttled=True)
    return None


def _nonnegative_header_number(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        candidate = float(value)
    except ValueError:
        return None
    if not math.isfinite(candidate) or candidate < 0:
        return None
    return candidate


def _timestamp_datetime(value: UtcTimestamp) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _validate_access_inputs(
    http_client: HttpClient,
    access_coordinator: AccessCoordinator,
    access_scope: AccessScope,
    access_policy: AccessPolicy,
    *,
    expected_scope: AccessScope,
) -> None:
    if not isinstance(http_client, HttpClient):
        raise TypeError("http_client must be an HttpClient")
    if not isinstance(access_coordinator, AccessCoordinator):
        raise TypeError("access_coordinator must be an AccessCoordinator")
    if not isinstance(access_scope, AccessScope):
        raise TypeError("access_scope must be an AccessScope")
    if access_scope != expected_scope:
        raise ValueError("Web of Science requires the exact API product AccessScope")
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


def _validate_page_size(value: int, *, maximum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("page_size must be an integer")
    if not 1 <= value <= maximum:
        raise ValueError(f"page_size must be between 1 and {maximum}")


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
        reason="The metadata provider requires a configured API credential.",
        action="Configure the provider credential before retrying this capability.",
        retryable=False,
    )


def _lookup_key_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-unsupported-key",
        reason="The metadata provider cannot use the requested lookup key.",
        action="Use a Web of Science UID, DOI, or PMID.",
        retryable=False,
    )


def _unsupported_reference_direction_failure() -> MetadataProviderFailure:
    return _provider_failure(
        code="metadata-provider-unsupported-reference-direction",
        reason="The selected Web of Science database does not expose this citation direction.",
        action="Use WOS Core Collection for citing-item queries.",
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
            code="metadata-provider-authentication-failed",
            reason="The metadata provider did not accept the configured credential.",
            action="Review the provider credential before retrying.",
            retryable=False,
        )
    if status == 403:
        return _provider_failure(
            code="metadata-provider-entitlement-denied",
            reason="The metadata provider did not allow the selected product operation.",
            action="Review the product, database, edition, and institution entitlement.",
            retryable=False,
        )
    if status == 429:
        return _provider_failure(
            code="metadata-provider-throttled",
            reason="The metadata provider temporarily throttled this access scope.",
            action="Retry after the shared provider access policy permits another request.",
            retryable=True,
        )
    if status == 400:
        return _provider_failure(
            code="metadata-provider-query-rejected",
            reason="The metadata provider rejected the query or request parameters.",
            action="Review the provider query and ordinary product configuration.",
            retryable=False,
        )
    return _provider_failure(
        code="metadata-provider-http-status",
        reason="The metadata provider returned an unsuccessful HTTP status.",
        action="Retry the metadata request or review provider readiness.",
        retryable=status >= 500,
    )


__all__ = (
    "EXPANDED_ACCESS_SCOPE",
    "EXPANDED_BASELINE_ACCESS_POLICY",
    "STARTER_ACCESS_SCOPE",
    "STARTER_BASELINE_ACCESS_POLICY",
    "WebOfScienceExpandedAdapter",
    "WebOfScienceStarterAdapter",
)
