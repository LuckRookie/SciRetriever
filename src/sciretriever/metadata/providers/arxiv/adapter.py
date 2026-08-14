"""arXiv Atom adapter for capability-scoped neutral Metadata observations."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, overload
from urllib.parse import urlencode, urlsplit
from xml.etree import ElementTree

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
    parse_bounded_xml,
    require_xml_root,
    retry_after_feedback,
    stabilize_provider_metadata_observation,
    xml_children,
)
from sciretriever.metadata.providers._shared.failures import unknown_shape_failure
from sciretriever.metadata.rules import NeutralMetadataItem, TopicSearchQuery
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

_PROVIDER_NAME = "arxiv"
_ENDPOINT = "https://export.arxiv.org/api/query"
_MAX_RESPONSE_BYTES = 1_048_576
ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1, min_start_interval=3.0)
_ATOM = "http://www.w3.org/2005/Atom"
_OPEN_SEARCH = "http://a9.com/-/spec/opensearch/1.1/"
_ARXIV = "http://arxiv.org/schemas/atom"
_FEED = f"{{{_ATOM}}}feed"
_ENTRY = f"{{{_ATOM}}}entry"
_ID = f"{{{_ATOM}}}id"
_TITLE = f"{{{_ATOM}}}title"
_SUMMARY = f"{{{_ATOM}}}summary"
_PUBLISHED = f"{{{_ATOM}}}published"
_AUTHOR = f"{{{_ATOM}}}author"
_NAME = f"{{{_ATOM}}}name"
_LINK = f"{{{_ATOM}}}link"
_AFFILIATION = f"{{{_ARXIV}}}affiliation"
_DOI = f"{{{_ARXIV}}}doi"
_TOTAL_RESULTS = f"{{{_OPEN_SEARCH}}}totalResults"
_START_INDEX = f"{{{_OPEN_SEARCH}}}startIndex"
_ITEMS_PER_PAGE = f"{{{_OPEN_SEARCH}}}itemsPerPage"
_REVISION = re.compile(r"(?P<revision>v[1-9][0-9]*)$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class _RawEntry:
    element: ElementTree.Element
    input_sha256: Sha256
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _ArxivRecord:
    identifier: Identifier
    source_record_id: str


class ArxivAdapter:
    """Concrete arXiv implementation of TopicSearchPort and MetadataLookupPort."""

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
            raise ValueError("arXiv must share the HttpClient AccessCoordinator")
        _validate_factories(
            observation_id_factory,
            provenance_id_factory,
            clock,
        )
        _validate_page_size(page_size)

        self._http_client = http_client
        self._access_coordinator = access_coordinator
        self._access_scope = access_scope
        self._access_policy = AccessPolicy.strictest(BASELINE_ACCESS_POLICY, access_policy)
        self._observation_id_factory = observation_id_factory
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._page_size = page_size

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe the documented Atom endpoint with one stable arXiv ID."""

        def operation() -> None:
            parameters = (("id_list", "2106.14834"), ("max_results", "1"))
            response = self._request(
                f"{_ENDPOINT}?{urlencode(parameters)}",
                probe=True,
            )
            root = require_xml_root(
                parse_bounded_xml(response.body, max_bytes=_MAX_RESPONSE_BYTES),
                _FEED,
            )
            for child in root:
                if _local_name(child.tag) == "entry" and child.tag != _ENTRY:
                    raise unknown_shape_failure()
            _required_feed_count(root, _TOTAL_RESULTS)
            _required_feed_count(root, _START_INDEX)
            _required_feed_count(root, _ITEMS_PER_PAGE)

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=False,
        )

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        search_query = _arxiv_topic_query(query)

        def fetch_page(cursor: int | None) -> metadata_ports._RawPage[_RawEntry, int]:
            requested_start = 0 if cursor is None else cursor
            parameters = (
                ("search_query", search_query),
                ("start", str(requested_start)),
                ("max_results", str(self._page_size)),
                ("sortBy", "relevance"),
                ("sortOrder", "descending"),
            )
            response = self._request(f"{_ENDPOINT}?{urlencode(parameters)}")
            return self._feed_page(response, requested_start=requested_start)

        return metadata_ports._PagedRawItemSession(
            fetch_page,
            lambda raw: self._convert_raw_entry(raw, expected=None),
        )

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        expected = _lookup_record(key)

        def fetch_page(cursor: int | None) -> metadata_ports._RawPage[_RawEntry, int]:
            requested_start = 0 if cursor is None else cursor
            parameters = (
                ("id_list", expected.source_record_id),
                ("start", str(requested_start)),
                ("max_results", str(self._page_size)),
            )
            response = self._request(f"{_ENDPOINT}?{urlencode(parameters)}")
            return self._feed_page(response, requested_start=requested_start)

        return metadata_ports._PagedRawItemSession(
            fetch_page,
            lambda raw: self._convert_raw_entry(raw, expected=expected),
        )

    @overload
    def _request(self, url: str, *, probe: Literal[False] = False) -> _ObservedResponse: ...

    @overload
    def _request(self, url: str, *, probe: Literal[True]) -> TransportResponse: ...

    def _request(
        self,
        url: str,
        *,
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse:
        observed_at: UtcTimestamp | None = None

        def response_feedback(result: TransportResponse) -> AccessFeedback | None:
            nonlocal observed_at
            observed_at = None if probe else self._observed_at()
            feedback = retry_after_feedback(
                result.status,
                result.headers,
                wall_now=(
                    probe_feedback_wall_time(system_probe_wall_clock)
                    if observed_at is None
                    else _timestamp_datetime(observed_at)
                ),
            )
            if feedback is None and result.status >= 500:
                return AccessFeedback(throttled=True)
            return feedback

        result = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            headers=(
                Header(
                    name="Accept",
                    value="application/atom+xml, application/xml;q=0.9",
                ),
            ),
            max_response_bytes=_MAX_RESPONSE_BYTES,
            max_redirects=0,
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
            raise RuntimeError("HttpClient did not interpret the arXiv response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _feed_page(
        self,
        response: _ObservedResponse,
        *,
        requested_start: int,
    ) -> metadata_ports._RawPage[_RawEntry, int]:
        root = require_xml_root(
            parse_bounded_xml(response.transport.body, max_bytes=_MAX_RESPONSE_BYTES),
            _FEED,
        )
        for child in root:
            if _local_name(child.tag) == "entry" and child.tag != _ENTRY:
                raise unknown_shape_failure()
        total_results = _required_feed_count(root, _TOTAL_RESULTS)
        start_index = _required_feed_count(root, _START_INDEX)
        items_per_page = _required_feed_count(root, _ITEMS_PER_PAGE)
        if start_index != requested_start:
            raise _protocol_failure()
        entries = xml_children(root, _ENTRY)
        if len(entries) > self._page_size or (total_results > 0 and items_per_page == 0):
            raise unknown_shape_failure()
        input_sha256 = sha256_digest(response.transport.body)
        raw_items = tuple(
            _RawEntry(
                element=entry,
                input_sha256=input_sha256,
                observed_at=response.observed_at,
            )
            for entry in entries
        )
        consumed = start_index + len(raw_items)
        if consumed > total_results:
            raise unknown_shape_failure()
        if consumed >= total_results:
            return metadata_ports._RawPage(
                items=raw_items,
                next_cursor=None,
                exhausted=True,
            )
        return metadata_ports._RawPage(
            items=raw_items,
            next_cursor=consumed,
            exhausted=False,
        )

    def _convert_raw_entry(
        self,
        envelope: _RawEntry,
        *,
        expected: _ArxivRecord | None,
    ) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawEntry):
            raise TypeError("raw arXiv item must use the private envelope")
        entry = envelope.element
        if entry.tag != _ENTRY:
            raise unknown_shape_failure()
        record = _entry_record(_required_entry_text(entry, _ID))
        if expected is not None:
            if record.identifier != expected.identifier:
                raise _record_failure()
            if _has_revision(expected.source_record_id) and (
                record.source_record_id != expected.source_record_id
            ):
                raise _record_failure()
        provenance = Provenance(
            provenance_id=self._new_provenance_id(),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=_PROVIDER_NAME,
            source_record_id=record.source_record_id,
            observed_at=envelope.observed_at,
            input_sha256=envelope.input_sha256,
            parameters_sha256=None,
        )
        published_date, published_year = _published(entry)
        doi = _entry_doi(entry)
        identifiers = (record.identifier,) if doi is None else (record.identifier, doi)
        metadata = LiteratureMetadata(
            title=_optional_entry_text(entry, _TITLE),
            authors=_authors(entry),
            abstract=_optional_entry_text(entry, _SUMMARY),
            publication_date=published_date,
            publication_year=published_year,
            document_type="preprint",
            language=None,
            venue=None,
            publisher=None,
            volume=None,
            issue=None,
            pages=None,
            identifiers=identifiers,
            keywords=(),
        )
        observation = stabilize_provider_metadata_observation(
            MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=metadata,
                version_role=VersionRole.PREPRINT,
                version_links=(),
                declared_keywords=(),
                reference_texts=(),
                reference_count=None,
                cited_by_count=None,
                asset_hints=_entry_asset_hints(entry),
            )
        )
        return NeutralMetadataItem(observations=(observation,), relations=())

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
        StableFailure(
            code=code,
            reason=reason,
            action=action,
            retryable=retryable,
        )
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
        action="Use an arXiv record key or arXiv identifier.",
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
        raise ValueError("arXiv requires its exact API AccessScope")
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


def _validate_page_size(page_size: int) -> None:
    if isinstance(page_size, bool) or not isinstance(page_size, int):
        raise TypeError("page_size must be an integer")
    if not 1 <= page_size <= 1_000:
        raise ValueError("page_size must be between 1 and 1000")


def _arxiv_topic_query(query: TopicSearchQuery) -> str:
    topic = f"all:({query.query})"
    if query.year_from is None and query.year_to is None:
        return topic
    year_from = 1 if query.year_from is None else query.year_from
    year_to = 9999 if query.year_to is None else query.year_to
    date_range = f"submittedDate:[{year_from:04d}01010000 TO {year_to:04d}12312359]"
    return f"{date_range} AND {topic}"


def _required_feed_count(root: ElementTree.Element, tag: str) -> int:
    values = xml_children(root, tag)
    if len(values) != 1:
        raise unknown_shape_failure()
    text = _element_text(values[0])
    if text is None or not text.isascii() or not text.isdecimal():
        raise unknown_shape_failure()
    return int(text, 10)


def _local_name(tag: object) -> str | None:
    if type(tag) is not str:
        return None
    return tag.rsplit("}", maxsplit=1)[-1]


def _element_text(element: ElementTree.Element) -> str | None:
    normalized = " ".join("".join(element.itertext()).split())
    return normalized or None


def _entry_values(
    entry: ElementTree.Element,
    tag: str,
) -> tuple[ElementTree.Element, ...]:
    return xml_children(entry, tag)


def _required_entry_text(entry: ElementTree.Element, tag: str) -> str:
    values = _entry_values(entry, tag)
    if len(values) != 1:
        raise _record_failure()
    text = _element_text(values[0])
    if text is None:
        raise _record_failure()
    return text


def _optional_entry_text(entry: ElementTree.Element, tag: str) -> str | None:
    values = _entry_values(entry, tag)
    if len(values) > 1:
        raise _record_failure()
    return None if not values else _element_text(values[0])


def _arxiv_locator(value: str) -> _ArxivRecord:
    candidate = value.strip()
    if not candidate:
        raise _lookup_key_failure()
    try:
        identifier = Identifier(namespace="arxiv", value=candidate)
    except ValidationError:
        raise _lookup_key_failure() from None
    unwrapped = _unwrap_arxiv_locator(candidate)
    if unwrapped.casefold().endswith(".pdf"):
        unwrapped = unwrapped[:-4]
    matched = _REVISION.search(unwrapped)
    revision = matched.group("revision").casefold() if matched is not None else ""
    return _ArxivRecord(
        identifier=identifier,
        source_record_id=f"{identifier.value}{revision}",
    )


def _unwrap_arxiv_locator(value: str) -> str:
    candidate = value.strip()
    if candidate.casefold().startswith("arxiv:"):
        return candidate[6:].strip()
    if candidate.casefold().startswith(("http://", "https://")):
        parsed = urlsplit(candidate)
        path = parsed.path.lstrip("/")
        if path.startswith("abs/"):
            return path[4:]
        if path.startswith("pdf/"):
            return path[4:]
    return candidate


def _entry_record(value: str) -> _ArxivRecord:
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise _record_failure() from None
    if (
        parsed.scheme.casefold() not in {"http", "https"}
        or parsed.hostname is None
        or parsed.hostname.casefold() != "arxiv.org"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/abs/")
    ):
        raise _record_failure()
    try:
        return _arxiv_locator(value)
    except MetadataProviderFailure:
        raise _record_failure() from None


def _lookup_record(key: ProviderLiteratureKey) -> _ArxivRecord:
    identifiers = tuple(value for value in key.identifiers if value.namespace == "arxiv")
    canonical = tuple(dict.fromkeys(value.value for value in identifiers))
    if len(canonical) > 1:
        raise _lookup_key_failure()
    identifier = identifiers[0] if identifiers else None
    record = _arxiv_locator(key.record_id) if key.record_id is not None else None
    if record is not None and identifier is not None and record.identifier != identifier:
        raise _lookup_key_failure()
    if record is not None:
        return record
    if identifier is None:
        raise _lookup_key_failure()
    return _ArxivRecord(
        identifier=identifier,
        source_record_id=identifier.value,
    )


def _has_revision(value: str) -> bool:
    return _REVISION.search(value) is not None


def _published(entry: ElementTree.Element) -> tuple[str | None, int | None]:
    raw = _optional_entry_text(entry, _PUBLISHED)
    if raw is None:
        return None, None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise _record_failure() from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _record_failure()
    utc_date = parsed.astimezone(timezone.utc).date()
    return utc_date.isoformat(), utc_date.year


def _entry_doi(entry: ElementTree.Element) -> Identifier | None:
    raw = _optional_entry_text(entry, _DOI)
    if raw is None:
        return None
    try:
        return Identifier(namespace="doi", value=raw)
    except ValidationError:
        raise _record_failure() from None


def _authors(entry: ElementTree.Element) -> tuple[Author, ...]:
    result: list[Author] = []
    for element in _entry_values(entry, _AUTHOR):
        name = _required_entry_text(element, _NAME)
        affiliations = tuple(
            Affiliation(name=text)
            for value in _entry_values(element, _AFFILIATION)
            if (text := _element_text(value)) is not None
        )
        try:
            result.append(
                Author(
                    kind=AuthorKind.UNKNOWN,
                    display_name=name,
                    given_name=None,
                    family_name=None,
                    orcid=None,
                    affiliations=affiliations,
                )
            )
        except ValidationError:
            raise _record_failure() from None
    return tuple(result)


def _entry_asset_hints(entry: ElementTree.Element) -> tuple[AssetHint, ...]:
    result: list[AssetHint] = []
    for element in _entry_values(entry, _LINK):
        href = element.attrib.get("href")
        relation = element.attrib.get("rel")
        media_type = element.attrib.get("type")
        normalized_media = (
            media_type.split(";", maxsplit=1)[0].strip().casefold()
            if media_type is not None
            else None
        )
        if normalized_media == "application/pdf":
            hint = _asset_hint(
                href,
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
            )
        elif relation is not None and relation.strip().casefold() == "alternate":
            hint = _asset_hint(
                href,
                kind=AssetHintKind.LANDING_PAGE,
                media_type=normalized_media,
                asset_role=(AssetRole.HTML if normalized_media == "text/html" else None),
            )
        else:
            hint = None
        if hint is not None:
            result.append(hint)
    return tuple(result)


def _asset_hint(
    value: object,
    *,
    kind: AssetHintKind,
    media_type: str | None,
    asset_role: AssetRole | None,
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
            version_role=VersionRole.PREPRINT,
            access_status=None,
            license=None,
        )
    except (ValidationError, ValueError):
        return None


__all__ = ("ArxivAdapter",)
