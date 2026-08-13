"""Crossref REST adapter for capability-scoped neutral Metadata observations."""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from html.parser import HTMLParser
from typing import Literal, cast, overload
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
    interpreted_access_feedback,
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

_PROVIDER_NAME = "crossref"
_ORIGIN = "https://api.crossref.org"
_MAX_RESPONSE_BYTES = 1_048_576
_RATE_INTERVAL = re.compile(r"(?P<seconds>[0-9]+(?:\.[0-9]+)?)s?", re.ASCII)
PUBLIC_ACCESS_SCOPE = AccessScope(
    provider_name=_PROVIDER_NAME,
    channel="api",
    service_name="public",
)
POLITE_ACCESS_SCOPE = AccessScope(
    provider_name=_PROVIDER_NAME,
    channel="api",
    service_name="polite",
)
PUBLIC_BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=1, min_start_interval=0.2)
POLITE_BASELINE_ACCESS_POLICY = AccessPolicy(max_concurrency=3, min_start_interval=0.1)
_DATE_PRECEDENCE = (
    "published-print",
    "published-online",
    "published",
    "issued",
)
_VERSION_ROLES = {
    "vor": VersionRole.PUBLISHED,
    "version-of-record": VersionRole.PUBLISHED,
    "am": VersionRole.ACCEPTED_MANUSCRIPT,
    "accepted-manuscript": VersionRole.ACCEPTED_MANUSCRIPT,
}


@dataclass(frozen=True, slots=True)
class _RawWork:
    value: object
    input_sha256: Sha256
    observed_at: UtcTimestamp
    expected_doi: Identifier | None = None


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


class _JatsText(HTMLParser):
    """Extract inert text from a provider JATS fragment without resolving entities."""

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


class CrossrefAdapter:
    """Concrete Crossref implementation of TopicSearchPort and MetadataLookupPort."""

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
        mailto: str | None = None,
        page_size: int = 100,
    ) -> None:
        normalized_mailto = _normalize_mailto(mailto)
        baseline_scope = (
            POLITE_ACCESS_SCOPE if normalized_mailto is not None else PUBLIC_ACCESS_SCOPE
        )
        baseline_policy = (
            POLITE_BASELINE_ACCESS_POLICY
            if normalized_mailto is not None
            else PUBLIC_BASELINE_ACCESS_POLICY
        )
        _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
            expected_scope=baseline_scope,
        )
        _validate_factories(
            observation_id_factory,
            provenance_id_factory,
            clock,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("Crossref must share the HttpClient AccessCoordinator")
        _validate_page_size(page_size)

        self._http_client = http_client
        self._access_coordinator = access_coordinator
        self._access_scope = access_scope
        self._access_policy = AccessPolicy.strictest(baseline_policy, access_policy)
        self._observation_id_factory = observation_id_factory
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._mailto = normalized_mailto
        self._page_size = page_size

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe the configured Crossref pool with one count-only query."""

        def operation() -> None:
            parameters: list[tuple[str, str]] = [("query", "metadata"), ("rows", "0")]
            if self._mailto is not None:
                parameters.append(("mailto", self._mailto))
            response = self._request(
                f"{_ORIGIN}/works?{urlencode(parameters)}",
                probe=True,
            )
            root = require_json_object(
                parse_bounded_json(
                    response.body,
                    max_bytes=_MAX_RESPONSE_BYTES,
                )
            )
            if root.get("status") != "ok" or root.get("message-type") != "work-list":
                raise unknown_shape_failure()
            message = require_json_object(root.get("message"))
            _top_level_count(message.get("total-results"))
            require_json_array(message.get("items"))

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=False,
        )

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        if not isinstance(query, TopicSearchQuery):
            raise TypeError("query must be a TopicSearchQuery")
        seen_items = 0

        def fetch_page(cursor: str | None) -> metadata_ports._RawPage[_RawWork, str]:
            nonlocal seen_items
            parameters: list[tuple[str, str]] = [
                ("query", query.query),
                ("rows", str(self._page_size)),
                ("cursor", "*" if cursor is None else cursor),
            ]
            year_filter = _crossref_year_filter(query)
            if year_filter is not None:
                parameters.append(("filter", year_filter))
            if self._mailto is not None:
                parameters.append(("mailto", self._mailto))
            response = self._request(f"{_ORIGIN}/works?{urlencode(parameters)}")
            root = require_json_object(
                parse_bounded_json(response.transport.body, max_bytes=_MAX_RESPONSE_BYTES)
            )
            if root.get("status") != "ok" or root.get("message-type") != "work-list":
                raise unknown_shape_failure()
            message = require_json_object(root.get("message"))
            items = require_json_array(message.get("items"))
            total_results = _top_level_count(message.get("total-results"))
            input_sha256 = sha256_digest(response.transport.body)
            raw_items = tuple(
                _RawWork(
                    value=value,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for value in items
            )
            seen_items += len(raw_items)
            exhausted = not raw_items or seen_items >= total_results
            if exhausted:
                return metadata_ports._RawPage(
                    items=raw_items,
                    next_cursor=None,
                    exhausted=True,
                )
            next_cursor = _top_level_string(message.get("next-cursor"))
            return metadata_ports._RawPage(
                items=raw_items,
                next_cursor=next_cursor,
                exhausted=False,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_raw_work)

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        doi = _lookup_doi(key)

        def fetch_page(cursor: None) -> metadata_ports._RawPage[_RawWork, None]:
            if cursor is not None:
                raise TypeError("Crossref lookup has no cursor")
            parameters = [] if self._mailto is None else [("mailto", self._mailto)]
            suffix = "" if not parameters else "?" + urlencode(parameters)
            response = self._request(
                f"{_ORIGIN}/works{suffix}",
                path_parameter=doi.value,
            )
            root = require_json_object(
                parse_bounded_json(response.transport.body, max_bytes=_MAX_RESPONSE_BYTES)
            )
            if root.get("status") != "ok" or root.get("message-type") != "work":
                raise unknown_shape_failure()
            raw = _RawWork(
                value=root.get("message"),
                input_sha256=sha256_digest(response.transport.body),
                observed_at=response.observed_at,
                expected_doi=doi,
            )
            return metadata_ports._RawPage(
                items=(raw,),
                next_cursor=None,
                exhausted=True,
            )

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

    def _request(  # noqa: C901 -- one request boundary owns feedback and status stabilization
        self,
        url: str,
        *,
        path_parameter: str | None = None,
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse:
        observed_at: UtcTimestamp | None = None
        feedback_failure: MetadataProviderFailure | None = None

        def response_feedback(result: TransportResponse) -> AccessFeedback | None:
            nonlocal feedback_failure, observed_at
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
            if result.status != 429 or (feedback is not None and feedback.retry_after is not None):
                return feedback
            try:
                interval = _crossref_rate_interval(result.headers)
            except MetadataProviderFailure as error:
                feedback_failure = error
                return feedback
            if interval is None:
                return feedback
            return interpreted_access_feedback(
                monotonic_now=0.0,
                retry_after_seconds=interval,
                throttled=True,
            )

        result = self._http_client.request(
            self._access_scope,
            url,
            self._access_policy,
            headers=(Header(name="Accept", value="application/json"),),
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
            raise RuntimeError("HttpClient did not interpret the Crossref response")
        return _ObservedResponse(transport=result, observed_at=observed_at)

    def _convert_raw_work(self, envelope: _RawWork) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawWork):
            raise TypeError("raw Crossref item must use the private envelope")
        work = require_json_object(envelope.value)
        doi = _optional_doi(work.get("DOI"), strict=True)
        if envelope.expected_doi is not None and doi != envelope.expected_doi:
            raise _record_failure()
        work_url_hint = _landing_hint(work.get("URL"))
        resource_hint = _crossref_resource_hint(work.get("resource"))
        source_record_id = (
            doi.value if doi is not None else _first_hint_url(work_url_hint, resource_hint)
        )
        if source_record_id is None:
            raise _record_failure()

        provenance = Provenance(
            provenance_id=self._new_provenance_id(),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=_PROVIDER_NAME,
            source_record_id=source_record_id,
            observed_at=envelope.observed_at,
            input_sha256=envelope.input_sha256,
            parameters_sha256=None,
        )
        identifiers = () if doi is None else (doi,)
        authors = _crossref_authors(work.get("author"))
        publication_date, publication_year = _crossref_publication_date(work)
        metadata = LiteratureMetadata(
            title=_first_string(work.get("title")),
            authors=authors,
            abstract=_jats_text(work.get("abstract")),
            publication_date=publication_date,
            publication_year=publication_year,
            document_type=_document_type(work.get("type")),
            language=_optional_string(work.get("language")),
            venue=_first_string(work.get("container-title")),
            publisher=_optional_string(work.get("publisher")),
            volume=_optional_string(work.get("volume")),
            issue=_optional_string(work.get("issue")),
            pages=_pages(work),
            identifiers=identifiers,
            keywords=(),
        )
        reference_texts, cited_identifiers = _crossref_references(work.get("reference"))
        hints = (
            *_crossref_link_hints(work.get("link"), work.get("license")),
            *((work_url_hint,) if work_url_hint is not None else ()),
            *((resource_hint,) if resource_hint is not None else ()),
        )
        observation = stabilize_provider_metadata_observation(
            MetadataObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                metadata=metadata,
                version_role=None,
                version_links=(),
                declared_keywords=(),
                reference_texts=reference_texts,
                reference_count=optional_nonnegative_integer(work.get("reference-count")),
                cited_by_count=optional_nonnegative_integer(work.get("is-referenced-by-count")),
                asset_hints=hints,
            )
        )
        provenance = observation.provenance
        citing = ProviderLiteratureKey(
            record_id=source_record_id,
            identifiers=identifiers,
        )
        relations: list[ProviderRelationObservation] = []
        for cited_doi in cited_identifiers:
            cited = ProviderLiteratureKey(
                record_id=cited_doi.value,
                identifiers=(cited_doi,),
            )
            if cited == citing:
                continue
            relations.append(
                stabilize_provider_relation_observation(
                    ProviderRelationObservation(
                        observation_id=self._new_observation_id(),
                        provenance=provenance,
                        citing=citing,
                        cited=cited,
                    )
                )
            )
        return NeutralMetadataItem(
            observations=(observation,),
            relations=tuple(relations),
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
        action="Use a DOI registered by this metadata provider.",
        retryable=False,
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


def _normalize_mailto(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("mailto must be a string or None")
    candidate = value.strip()
    if (
        not candidate
        or candidate.count("@") != 1
        or any(character.isspace() or ord(character) < 32 for character in candidate)
    ):
        raise ValueError("mailto must be a nonblank contact email")
    return candidate


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
        raise ValueError("Crossref requires its exact API pool AccessScope")
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


def _crossref_year_filter(query: TopicSearchQuery) -> str | None:
    values: list[str] = []
    if query.year_from is not None:
        values.append(f"from-pub-date:{query.year_from:04d}-01-01")
    if query.year_to is not None:
        values.append(f"until-pub-date:{query.year_to:04d}-12-31")
    return ",".join(values) or None


def _top_level_count(value: object) -> int:
    if type(value) is not int or value < 0:
        raise unknown_shape_failure()
    return value


def _top_level_string(value: object) -> str:
    if type(value) is not str or not value.strip():
        raise unknown_shape_failure()
    return value


def _timestamp_datetime(value: UtcTimestamp) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _crossref_rate_interval(headers: tuple[Header, ...]) -> float | None:
    raw = header_value(headers, "X-Rate-Limit-Interval")
    if raw is None:
        return None
    matched = _RATE_INTERVAL.fullmatch(raw.strip().casefold())
    if matched is None:
        return None
    seconds = float(matched.group("seconds"))
    if not math.isfinite(seconds) or seconds <= 0:
        return None
    return seconds


def _lookup_doi(key: ProviderLiteratureKey) -> Identifier:
    identifiers = tuple(value for value in key.identifiers if value.namespace == "doi")
    canonical = tuple(dict.fromkeys(value.value for value in identifiers))
    if len(canonical) > 1:
        raise _lookup_key_failure()
    identifier = identifiers[0] if identifiers else None
    record_identifier: Identifier | None = None
    if key.record_id is not None:
        try:
            record_identifier = Identifier(namespace="doi", value=key.record_id)
        except ValidationError:
            if identifier is None:
                raise _lookup_key_failure() from None
    if identifier is not None and record_identifier is not None and identifier != record_identifier:
        raise _lookup_key_failure()
    result = identifier or record_identifier
    if result is None:
        raise _lookup_key_failure()
    return result


def _optional_doi(value: object, *, strict: bool) -> Identifier | None:
    if value is None:
        return None
    if type(value) is not str:
        if strict:
            raise _record_failure()
        return None
    try:
        return Identifier(namespace="doi", value=value)
    except ValidationError:
        if strict:
            raise _record_failure() from None
        return None


def _optional_string(value: object) -> str | None:
    return optional_nonblank_string(value)


def _first_string(value: object) -> str | None:
    if value is None:
        return None
    items = require_json_array(value)
    if not items:
        return None
    return optional_nonblank_string(items[0])


def _jats_text(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    parser = _JatsText()
    parser.feed(raw)
    parser.close()
    normalized = " ".join(" ".join(parser.parts).split())
    return normalized or None


def _crossref_authors(value: object) -> tuple[Author, ...]:
    if value is None:
        return ()
    authors: list[Author] = []
    for raw in require_json_array(value):
        item = require_json_object(raw)
        given = optional_nonblank_string(item.get("given"))
        family = optional_nonblank_string(item.get("family"))
        organization_name = optional_nonblank_string(item.get("name"))
        affiliations = _crossref_affiliations(item.get("affiliation"))
        try:
            if given is not None or family is not None:
                display_name = " ".join(part for part in (given, family) if part is not None)
                authors.append(
                    Author(
                        kind=AuthorKind.PERSON,
                        display_name=display_name,
                        given_name=given,
                        family_name=family,
                        orcid=_crossref_orcid(item.get("ORCID")),
                        affiliations=affiliations,
                    )
                )
            elif organization_name is not None:
                authors.append(
                    Author(
                        kind=AuthorKind.ORGANIZATION,
                        display_name=organization_name,
                        affiliations=affiliations,
                    )
                )
            else:
                raise _record_failure()
        except ValidationError:
            raise _record_failure() from None
    return tuple(authors)


def _crossref_affiliations(value: object) -> tuple[Affiliation, ...]:
    if value is None:
        return ()
    result: list[Affiliation] = []
    for raw in require_json_array(value):
        item = require_json_object(raw)
        name = optional_nonblank_string(item.get("name"))
        if name is not None:
            result.append(Affiliation(name=name, ror=None))
    return tuple(result)


def _crossref_orcid(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return raw
    if (
        parsed.scheme.casefold() in {"http", "https"}
        and parsed.hostname is not None
        and parsed.hostname.casefold() == "orcid.org"
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
    ):
        return parsed.path.strip("/")
    return raw


def _crossref_publication_date(work: dict[str, object]) -> tuple[str | None, int | None]:
    for field_name in _DATE_PRECEDENCE:
        if field_name not in work:
            continue
        value = work[field_name]
        if value is None:
            continue
        return _crossref_date_parts(value)
    return None, None


def _crossref_date_parts(value: object) -> tuple[str, int]:
    item = require_json_object(value)
    parts_groups = require_json_array(item.get("date-parts"))
    if not parts_groups:
        raise _record_failure()
    parts = require_json_array(parts_groups[0])
    if not 1 <= len(parts) <= 3 or any(type(part) is not int for part in parts):
        raise _record_failure()
    numbers = tuple(cast(int, part) for part in parts)
    year = numbers[0]
    if not 1 <= year <= 9999:
        raise _record_failure()
    if len(numbers) == 1:
        return f"{year:04d}", year
    month = numbers[1]
    if not 1 <= month <= 12:
        raise _record_failure()
    if len(numbers) == 2:
        return f"{year:04d}-{month:02d}", year
    day = numbers[2]
    try:
        date(year, month, day)
    except ValueError:
        raise _record_failure() from None
    return f"{year:04d}-{month:02d}-{day:02d}", year


def _document_type(value: object) -> str | None:
    raw = optional_nonblank_string(value)
    if raw is None:
        return None
    return raw.casefold()


def _pages(work: dict[str, object]) -> str | None:
    pages = optional_nonblank_string(work.get("page"))
    if pages is not None:
        return pages
    return optional_nonblank_string(work.get("article-number"))


def _crossref_references(
    value: object,
) -> tuple[tuple[str, ...], tuple[Identifier, ...]]:
    if value is None:
        return (), ()
    try:
        values = require_json_array(value)
    except MetadataProviderFailure:
        return (), ()
    texts: list[str] = []
    dois: list[Identifier] = []
    for raw in values:
        if type(raw) is not dict:
            continue
        item = require_json_object(raw)
        try:
            text = optional_nonblank_string(item.get("unstructured"))
        except MetadataProviderFailure:
            text = None
        if text is not None:
            texts.append(text)
        doi = _optional_doi(item.get("DOI"), strict=False)
        if doi is not None:
            dois.append(doi)
    return tuple(texts), tuple(dois)


def _crossref_link_hints(
    value: object,
    license_value: object,
) -> tuple[AssetHint, ...]:
    if type(value) is not list:
        return ()
    licenses = _aligned_licenses(license_value)
    result: list[AssetHint] = []
    for raw in value:
        if type(raw) is not dict:
            continue
        item = require_json_object(raw)
        media_type = item.get("content-type")
        if type(media_type) is not str:
            continue
        normalized_media_type = media_type.split(";", maxsplit=1)[0].strip().casefold()
        content_version = item.get("content-version")
        normalized_version = (
            content_version.strip().casefold()
            if type(content_version) is str and content_version.strip()
            else None
        )
        version_role = (
            _VERSION_ROLES.get(normalized_version) if normalized_version is not None else None
        )
        license_text = licenses.get(normalized_version) if normalized_version is not None else None
        if normalized_media_type == "application/pdf":
            hint = _asset_hint(
                item.get("URL"),
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=version_role,
                license_text=license_text,
            )
        elif normalized_media_type == "text/html":
            hint = _asset_hint(
                item.get("URL"),
                kind=AssetHintKind.LANDING_PAGE,
                media_type="text/html",
                asset_role=AssetRole.HTML,
                version_role=version_role,
                license_text=license_text,
            )
        else:
            hint = None
        if hint is not None:
            result.append(hint)
    return tuple(result)


def _aligned_licenses(value: object) -> dict[str, str]:
    if type(value) is not list:
        return {}
    candidates: dict[str, list[str]] = {}
    for raw in value:
        if type(raw) is not dict:
            continue
        item = require_json_object(raw)
        content_version = item.get("content-version")
        license_url = item.get("URL")
        if type(content_version) is not str or type(license_url) is not str:
            continue
        version = content_version.strip().casefold()
        safe_license = _safe_license_url(license_url)
        if version and safe_license is not None:
            candidates.setdefault(version, []).append(safe_license)
    return {version: values[0] for version, values in candidates.items() if len(values) == 1}


def _safe_license_url(value: str) -> str | None:
    candidate = value.strip()
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return None
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return None
    return candidate


def _landing_hint(value: object) -> AssetHint | None:
    return _asset_hint(
        value,
        kind=AssetHintKind.LANDING_PAGE,
        media_type=None,
        asset_role=None,
        version_role=None,
        license_text=None,
    )


def _crossref_resource_hint(value: object) -> AssetHint | None:
    if type(value) is not dict:
        return None
    resource = require_json_object(value)
    primary = resource.get("primary")
    if type(primary) is not dict:
        return None
    return _landing_hint(require_json_object(primary).get("URL"))


def _asset_hint(
    value: object,
    *,
    kind: AssetHintKind,
    media_type: str | None,
    asset_role: AssetRole | None,
    version_role: VersionRole | None,
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
            access_status=None,
            license=license_text,
        )
    except (ValidationError, ValueError):
        return None


def _first_hint_url(*values: AssetHint | None) -> str | None:
    return next((value.url for value in values if value is not None), None)


__all__ = ("CrossrefAdapter",)
