"""OpenCitations Meta and Index adapter for neutral Metadata facts."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal, TypeAlias, overload

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
from sciretriever.metadata.rules import NeutralMetadataItem, ReferenceQueryContext
from sciretriever.model.access import AccessFailure, Header, TransportResponse
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

_PROVIDER_NAME = "opencitations"
_ORIGIN = "https://api.opencitations.net"
_META_ENDPOINT = f"{_ORIGIN}/meta/v1/metadata"
_INDEX_ENDPOINT = f"{_ORIGIN}/index/v2"
_CREDENTIAL_ORIGIN = Origin("https", "api.opencitations.net", 443)
_MAX_RESPONSE_BYTES = 4_194_304

# Evidence: docs/notes/providers/opencitations.md, last checked 2026-08-07.
# Meta and Index share the documented per-IP budget of 180 requests/minute.
ACCESS_SCOPE = AccessScope(provider_name=_PROVIDER_NAME, channel="api")
BASELINE_ACCESS_POLICY = AccessPolicy(
    max_concurrency=1,
    min_start_interval=1.0 / 3.0,
    burst_limit=180,
    window_seconds=60.0,
)

_INDEX_PRODUCTS = frozenset({"coci", "croci", "doci", "poci"})
_OMID = re.compile(r"^br/(\d+)$", re.IGNORECASE)
_OPENALEX = re.compile(r"^w(\d+)$", re.IGNORECASE)
_YEAR = re.compile(r"^(\d{4})$")
_YEAR_MONTH = re.compile(r"^(\d{4})-(\d{2})$")
_FULL_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PREFIXED_PID_GROUP = re.compile(r"^\[([^\]\r\n]+)\]\s*=>\s*(.+)$", re.DOTALL)
_DOCUMENT_TYPES = {
    "book": "book",
    "book chapter": "book-section",
    "book part": "book-section",
    "book section": "book-section",
    "conference paper": "conference-paper",
    "dataset": "dataset",
    "dissertation": "thesis",
    "editorial": "editorial",
    "journal article": "journal-article",
    "letter": "letter",
    "peer review": "review",
    "posted content": "preprint",
    "proceedings article": "conference-paper",
    "reference entry": "reference-entry",
    "report": "report",
    "review": "review",
    "standard": "standard",
    "thesis": "thesis",
}

_ReferenceKind: TypeAlias = Literal["references", "citations"]
_LocatorNamespace: TypeAlias = Literal["omid", "doi", "pmid"]


@dataclass(frozen=True, slots=True)
class _ObservedResponse:
    transport: TransportResponse
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _SelectedLocator:
    namespace: _LocatorNamespace
    value: str

    @property
    def request_id(self) -> str:
        return self.value if self.namespace == "omid" else f"{self.namespace}:{self.value}"


@dataclass(frozen=True, slots=True)
class _RawMetaRecord:
    value: object
    expected: _SelectedLocator
    input_sha256: Sha256
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _ReferenceTask:
    anchor: _SelectedLocator
    kind: _ReferenceKind


@dataclass(frozen=True, slots=True)
class _ReferenceCursor:
    task_index: int


@dataclass(frozen=True, slots=True)
class _RawEdge:
    value: object
    anchor: _SelectedLocator
    kind: _ReferenceKind
    input_sha256: Sha256
    observed_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class _ParsedPids:
    identifiers: tuple[Identifier, ...]
    omid: str | None
    openalex: str | None

    def provider_key(self) -> ProviderLiteratureKey:
        record_id = self.omid if self.omid is not None else self.openalex
        try:
            return ProviderLiteratureKey(
                record_id=record_id,
                identifiers=self.identifiers,
            )
        except ValidationError:
            raise invalid_record_failure() from None


@dataclass(frozen=True, slots=True)
class _ParsedPidToken:
    identifier: Identifier | None = None
    omid: str | None = None
    openalex: str | None = None


class OpenCitationsAdapter:
    """Exact Meta lookup and directed Index reference queries."""

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
        token: str | None = None,
    ) -> None:
        effective_policy = _validate_access_inputs(
            http_client,
            access_coordinator,
            access_scope,
            access_policy,
        )
        if http_client._coordinator is not access_coordinator:
            raise ValueError("OpenCitations must share the HttpClient AccessCoordinator")
        _validate_factories(observation_id_factory, provenance_id_factory, clock)
        self._http_client = http_client
        self._access_coordinator = access_coordinator
        self._access_scope = access_scope
        self._access_policy = effective_policy
        self._observation_id_factory = observation_id_factory
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._token = _private_token(token)

    def __repr__(self) -> str:
        return f"<OpenCitationsAdapter credentialed={self._token is not None}>"

    @property
    def provider_name(self) -> str:
        return _PROVIDER_NAME

    def probe_metadata(self) -> MetadataProbeEvidence:
        """Probe only the accepted Meta lookup product, never the Index."""

        def operation() -> None:
            response = self._request(
                _META_ENDPOINT,
                path_parameter="doi:10.1007/978-1-4020-9632-7",
                probe=True,
            )
            values = require_json_array(
                parse_bounded_json(response.body, max_bytes=_MAX_RESPONSE_BYTES)
            )
            if len(values) > 1:
                raise unknown_shape_failure()
            for value in values:
                record = require_json_object(value)
                if optional_nonblank_string(record.get("id")) is None:
                    raise unknown_shape_failure()

        return run_metadata_probe(
            _PROVIDER_NAME,
            operation,
            credential_present=self._token is not None,
        )

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        if not isinstance(key, ProviderLiteratureKey):
            raise TypeError("key must be a ProviderLiteratureKey")
        selected_locator = _select_locator(key)

        def fetch_page(cursor: None) -> metadata_ports._RawPage[_RawMetaRecord, None]:
            if cursor is not None:
                raise TypeError("OpenCitations Meta lookup has no cursor")
            response = self._request(
                _META_ENDPOINT,
                path_parameter=selected_locator.request_id,
            )
            values = require_json_array(
                parse_bounded_json(
                    response.transport.body,
                    max_bytes=_MAX_RESPONSE_BYTES,
                )
            )
            if len(values) > 1:
                raise unknown_shape_failure()
            input_sha256 = sha256_digest(response.transport.body)
            items = tuple(
                _RawMetaRecord(
                    value=value,
                    expected=selected_locator,
                    input_sha256=input_sha256,
                    observed_at=response.observed_at,
                )
                for value in values
            )
            return metadata_ports._RawPage(
                items=items,
                next_cursor=None,
                exhausted=True,
            )

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_meta_record)

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        if not isinstance(query, ReferenceQueryContext):
            raise TypeError("query must be a ReferenceQueryContext")
        tasks = _reference_tasks(query)

        def fetch_page(
            cursor: _ReferenceCursor | None,
        ) -> metadata_ports._RawPage[_RawEdge, _ReferenceCursor]:
            state = cursor or _ReferenceCursor(task_index=0)
            while state.task_index < len(tasks):
                task = tasks[state.task_index]
                response = self._request(
                    f"{_INDEX_ENDPOINT}/{task.kind}",
                    path_parameter=task.anchor.request_id,
                )
                values = require_json_array(
                    parse_bounded_json(
                        response.transport.body,
                        max_bytes=_MAX_RESPONSE_BYTES,
                    )
                )
                input_sha256 = sha256_digest(response.transport.body)
                items = tuple(
                    _RawEdge(
                        value=value,
                        anchor=task.anchor,
                        kind=task.kind,
                        input_sha256=input_sha256,
                        observed_at=response.observed_at,
                    )
                    for value in values
                )
                next_cursor = _ReferenceCursor(task_index=state.task_index + 1)
                if items:
                    exhausted = next_cursor.task_index >= len(tasks)
                    return metadata_ports._RawPage(
                        items=items,
                        next_cursor=None if exhausted else next_cursor,
                        exhausted=exhausted,
                    )
                state = next_cursor
            return metadata_ports._RawPage(items=(), next_cursor=None, exhausted=True)

        return metadata_ports._PagedRawItemSession(fetch_page, self._convert_edge)

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str,
        probe: Literal[False] = False,
    ) -> _ObservedResponse: ...

    @overload
    def _request(
        self,
        url: str,
        *,
        path_parameter: str,
        probe: Literal[True],
    ) -> TransportResponse: ...

    def _request(
        self,
        url: str,
        *,
        path_parameter: str,
        probe: bool = False,
    ) -> _ObservedResponse | TransportResponse:
        credentials = () if self._token is None else (("authorization", self._token),)
        allowed_origins = () if self._token is None else (_CREDENTIAL_ORIGIN,)
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

    def _convert_meta_record(self, envelope: _RawMetaRecord) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawMetaRecord):
            raise TypeError("raw OpenCitations Meta item must use the private envelope")
        record = require_json_object(envelope.value)
        key = _meta_record_key(record)
        if not _matches_selected_locator(envelope.expected, key):
            raise invalid_record_failure()
        provenance = self._provenance(
            source_record_id=_source_record_id(key),
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        publication_date, publication_year = _publication_date(record.get("pub_date"))
        try:
            metadata = LiteratureMetadata(
                title=optional_nonblank_string(record.get("title")),
                authors=_authors(record.get("author")),
                abstract=None,
                publication_date=publication_date,
                publication_year=publication_year,
                document_type=_document_type(record.get("type")),
                language=None,
                venue=_named_entity_text(record.get("venue")),
                publisher=_named_entity_text(record.get("publisher")),
                volume=optional_nonblank_string(record.get("volume")),
                issue=optional_nonblank_string(record.get("issue")),
                pages=optional_nonblank_string(record.get("page")),
                identifiers=key.identifiers,
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
                reference_count=None,
                cited_by_count=None,
                asset_hints=(),
            )
        except ValidationError:
            raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=(stabilize_provider_metadata_observation(observation),),
            relations=(),
        )

    def _convert_edge(self, envelope: _RawEdge) -> NeutralMetadataItem:
        if not isinstance(envelope, _RawEdge):
            raise TypeError("raw OpenCitations Index item must use the private envelope")
        record = require_json_object(envelope.value)
        source_record_id = _citation_record_id(record.get("oci"))
        citing = _provider_key_from_pid_string(record.get("citing"))
        cited = _provider_key_from_pid_string(record.get("cited"))
        anchor_endpoint = citing if envelope.kind == "references" else cited
        if not _matches_selected_locator(envelope.anchor, anchor_endpoint):
            raise invalid_record_failure()
        if _keys_overlap(citing, cited):
            raise invalid_record_failure()
        provenance = self._provenance(
            source_record_id=source_record_id,
            input_sha256=envelope.input_sha256,
            observed_at=envelope.observed_at,
        )
        try:
            relation = ProviderRelationObservation(
                observation_id=self._new_observation_id(),
                provenance=provenance,
                citing=citing,
                cited=cited,
            )
        except ValidationError:
            raise invalid_record_failure() from None
        return NeutralMetadataItem(
            observations=(),
            relations=(stabilize_provider_relation_observation(relation),),
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


def _select_locator(key: ProviderLiteratureKey) -> _SelectedLocator:
    if key.record_id is not None:
        omid = _optional_omid(key.record_id)
        if omid is not None:
            return _SelectedLocator(namespace="omid", value=omid)
    for namespace in ("doi", "pmid"):
        for identifier in key.identifiers:
            if identifier.namespace == namespace:
                return _SelectedLocator(
                    namespace=namespace,
                    value=identifier.value,
                )
    raise _lookup_key_failure()


def _lookup_id(key: ProviderLiteratureKey) -> str:
    return _select_locator(key).request_id


def _reference_tasks(query: ReferenceQueryContext) -> tuple[_ReferenceTask, ...]:
    kinds: tuple[_ReferenceKind, ...]
    if query.direction == "references":
        kinds = ("references",)
    elif query.direction == "cited-by":
        kinds = ("citations",)
    else:
        kinds = ("references", "citations")
    return tuple(
        _ReferenceTask(anchor=_select_locator(key), kind=kind)
        for key in query.keys
        for kind in kinds
    )


def _meta_record_key(record: dict[str, object]) -> ProviderLiteratureKey:
    value = optional_nonblank_string(record.get("id"))
    if value is None:
        raise invalid_record_failure()
    return _parse_pid_string(value, allow_prefixes=False).provider_key()


def _provider_key_from_pid_string(value: object) -> ProviderLiteratureKey:
    candidate = optional_nonblank_string(value)
    if candidate is None:
        raise invalid_record_failure()
    return _parse_pid_string(candidate, allow_prefixes=True).provider_key()


def _parse_pid_string(value: str, *, allow_prefixes: bool) -> _ParsedPids:
    tokens = _pid_tokens(value, allow_prefixes=allow_prefixes)
    identifiers: list[Identifier] = []
    omids: list[str] = []
    openalex_ids: list[str] = []
    for token in tokens:
        parsed = _parse_pid_token(token)
        if parsed.identifier is not None and parsed.identifier not in identifiers:
            identifiers.append(parsed.identifier)
        if parsed.omid is not None and parsed.omid not in omids:
            omids.append(parsed.omid)
        if parsed.openalex is not None and parsed.openalex not in openalex_ids:
            openalex_ids.append(parsed.openalex)
    if len(omids) > 1 or len(openalex_ids) > 1:
        raise invalid_record_failure()
    return _ParsedPids(
        identifiers=tuple(identifiers),
        omid=omids[0] if omids else None,
        openalex=openalex_ids[0] if openalex_ids else None,
    )


def _parse_pid_token(token: str) -> _ParsedPidToken:
    namespace, separator, raw_value = token.partition(":")
    namespace = namespace.casefold()
    if not separator or not namespace or not raw_value:
        raise invalid_record_failure()
    if namespace in {"doi", "pmid"}:
        try:
            identifier = Identifier(namespace=namespace, value=raw_value)
        except ValidationError:
            raise invalid_record_failure() from None
        return _ParsedPidToken(identifier=identifier)
    if namespace == "omid":
        return _ParsedPidToken(omid=_normalize_omid_value(raw_value))
    if namespace == "openalex":
        return _ParsedPidToken(openalex=_normalize_openalex_value(raw_value))
    if namespace == "isbn":
        # ISBN is a known Meta PID, but SciRetriever has no ISBN identity
        # contract in this milestone.  It is intentionally not retained.
        return _ParsedPidToken()
    raise invalid_record_failure()


def _pid_tokens(value: str, *, allow_prefixes: bool) -> tuple[str, ...]:
    candidate = value.strip()
    if not candidate:
        raise invalid_record_failure()
    if candidate.startswith("["):
        if not allow_prefixes:
            raise invalid_record_failure()
        tokens: list[str] = []
        groups = candidate.split(";")
        for group in groups:
            match = _PREFIXED_PID_GROUP.fullmatch(group.strip())
            if match is None or match.group(1).strip().casefold() not in _INDEX_PRODUCTS:
                raise invalid_record_failure()
            group_tokens = match.group(2).split()
            if not group_tokens:
                raise invalid_record_failure()
            tokens.extend(group_tokens)
        return tuple(tokens)
    if "=>" in candidate or ";" in candidate:
        raise invalid_record_failure()
    plain_tokens = tuple(candidate.split())
    if not plain_tokens:
        raise invalid_record_failure()
    return plain_tokens


def _normalize_omid_value(value: str) -> str:
    match = _OMID.fullmatch(value)
    if match is None:
        raise invalid_record_failure()
    return f"omid:br/{match.group(1)}"


def _optional_omid(value: str) -> str | None:
    namespace, separator, raw_value = value.partition(":")
    if not separator or namespace.casefold() != "omid":
        return None
    match = _OMID.fullmatch(raw_value)
    return None if match is None else f"omid:br/{match.group(1)}"


def _normalize_openalex_value(value: str) -> str:
    match = _OPENALEX.fullmatch(value)
    if match is None:
        raise invalid_record_failure()
    return f"openalex:W{match.group(1)}"


def _optional_normalized_record_id(value: str) -> str:
    omid = _optional_omid(value)
    if omid is not None:
        return omid
    namespace, separator, raw_value = value.partition(":")
    if separator and namespace.casefold() == "openalex":
        match = _OPENALEX.fullmatch(raw_value)
        if match is not None:
            return f"openalex:W{match.group(1)}"
    return value


def _keys_overlap(left: ProviderLiteratureKey, right: ProviderLiteratureKey) -> bool:
    if left.record_id is not None and right.record_id is not None:
        if _optional_normalized_record_id(left.record_id) == _optional_normalized_record_id(
            right.record_id
        ):
            return True
    return any(identifier in right.identifiers for identifier in left.identifiers)


def _matches_selected_locator(
    locator: _SelectedLocator,
    key: ProviderLiteratureKey,
) -> bool:
    if locator.namespace == "omid":
        return key.record_id is not None and _optional_omid(key.record_id) == locator.value
    return any(
        identifier.namespace == locator.namespace and identifier.value == locator.value
        for identifier in key.identifiers
    )


def _source_record_id(key: ProviderLiteratureKey) -> str:
    return key.record_id if key.record_id is not None else _lookup_id(key)


def _authors(value: object) -> tuple[Author, ...]:
    candidate = optional_nonblank_string(value)
    if candidate is None:
        return ()
    items = candidate.split(";")
    if any(not item.strip() for item in items):
        raise invalid_record_failure()
    return tuple(_author_item(item.strip()) for item in items)


def _author_item(value: str) -> Author:
    name, bracket = _split_named_entity(value)
    valid_orcids: list[str] = []
    if bracket is not None:
        for token in bracket.split():
            namespace, separator, raw_value = token.partition(":")
            if not separator or namespace.casefold() != "orcid":
                continue
            try:
                author = Author(
                    kind=AuthorKind.PERSON,
                    display_name=name,
                    given_name=None,
                    family_name=None,
                    orcid=raw_value,
                    affiliations=(),
                )
            except ValidationError:
                continue
            if author.orcid is not None and author.orcid not in valid_orcids:
                valid_orcids.append(author.orcid)
    kind = AuthorKind.PERSON if len(valid_orcids) == 1 else AuthorKind.UNKNOWN
    orcid = valid_orcids[0] if len(valid_orcids) == 1 else None
    try:
        return Author(
            kind=kind,
            display_name=name,
            given_name=None,
            family_name=None,
            orcid=orcid,
            affiliations=(),
        )
    except ValidationError:
        raise invalid_record_failure() from None


def _named_entity_text(value: object) -> str | None:
    candidate = optional_nonblank_string(value)
    if candidate is None:
        return None
    name, _bracket = _split_named_entity(candidate)
    return name


def _split_named_entity(value: str) -> tuple[str, str | None]:
    name, marker, remainder = value.partition("[")
    name = name.strip()
    if not name:
        raise invalid_record_failure()
    if not marker:
        return name, None
    if not remainder.endswith("]") or "[" in remainder or "]" in remainder[:-1]:
        raise invalid_record_failure()
    return name, remainder[:-1].strip()


def _publication_date(value: object) -> tuple[str | None, int | None]:
    candidate = optional_nonblank_string(value)
    if candidate is None:
        return None, None
    year_match = _YEAR.fullmatch(candidate)
    if year_match is not None:
        year = int(year_match.group(1))
        if not 1 <= year <= 9999:
            raise invalid_record_failure()
        return candidate, year
    month_match = _YEAR_MONTH.fullmatch(candidate)
    if month_match is not None:
        year = int(month_match.group(1))
        month = int(month_match.group(2))
        try:
            date(year, month, 1)
        except ValueError:
            raise invalid_record_failure() from None
        return candidate, year
    if _FULL_DATE.fullmatch(candidate) is not None:
        try:
            parsed = date.fromisoformat(candidate)
        except ValueError:
            raise invalid_record_failure() from None
        return candidate, parsed.year
    raise invalid_record_failure()


def _document_type(value: object) -> str | None:
    candidate = optional_nonblank_string(value)
    if candidate is None:
        return None
    normalized = " ".join(candidate.casefold().replace("-", " ").split())
    return _DOCUMENT_TYPES.get(normalized)


def _citation_record_id(value: object) -> str:
    candidate = optional_nonblank_string(value)
    if candidate is None or any(character.isspace() for character in candidate):
        raise invalid_record_failure()
    return candidate


def _timestamp_datetime(value: UtcTimestamp) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _private_token(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("token must be a string or None")
    if not value.strip() or any(character in value for character in "\r\n\x00"):
        raise ValueError("token must be a nonblank private value")
    return value


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
        raise ValueError("OpenCitations requires the opencitations api AccessScope")
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
        action="Use an OpenCitations OMID, DOI, or PMID lookup key.",
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


__all__ = (
    "ACCESS_SCOPE",
    "BASELINE_ACCESS_POLICY",
    "OpenCitationsAdapter",
)
