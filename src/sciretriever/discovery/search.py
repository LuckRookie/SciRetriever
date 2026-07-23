"""Concurrent metadata search with deterministic catalog ingestion."""

from __future__ import annotations

from concurrent.futures import Future
from dataclasses import dataclass
from hashlib import sha256
import json
from threading import Semaphore, Thread
from time import monotonic
from typing import Mapping

from sciretriever.catalog.library import (
    MetadataIngestionBatch,
    MetadataIngestionObservation,
    WorkRepository,
    normalize_title,
)
from sciretriever.catalog.records import WorkVersionRecord
from sciretriever.core.contracts import CandidateMetadata, Identifier, SearchSpec
from sciretriever.discovery.models import ProviderRecord
from sciretriever.discovery.normalize import clean_text, identifier_sort_key, normalize_record
from sciretriever.discovery.providers.base import DiscoveryProvider
from sciretriever.errors import ProviderSearchError, SearchError


DEFAULT_SEARCH_LIMIT = 100
DEFAULT_PROVIDER_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_CONCURRENCY = 8


@dataclass(frozen=True, slots=True)
class MetadataSearchRequest:
    query: str
    providers: tuple[str, ...]
    precedence: tuple[str, ...]
    limit: int = DEFAULT_SEARCH_LIMIT
    provider_timeout_seconds: float = DEFAULT_PROVIDER_TIMEOUT_SECONDS
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY

    def __post_init__(self) -> None:
        if not isinstance(self.query, str) or not self.query.strip():
            raise ValueError("query must be a non-blank string")
        if not self.providers or len(set(self.providers)) != len(self.providers):
            raise ValueError("providers must be a non-empty tuple of unique names")
        if set(self.precedence) != set(self.providers) or len(self.precedence) != len(self.providers):
            raise ValueError("precedence must contain every selected provider exactly once")
        if not isinstance(self.limit, int) or isinstance(self.limit, bool) or self.limit < 1:
            raise ValueError("limit must be a positive integer")
        if not isinstance(self.provider_timeout_seconds, (int, float)) or isinstance(self.provider_timeout_seconds, bool) or self.provider_timeout_seconds <= 0:
            raise ValueError("provider_timeout_seconds must be positive")
        if not isinstance(self.max_concurrency, int) or isinstance(self.max_concurrency, bool) or self.max_concurrency < 1:
            raise ValueError("max_concurrency must be a positive integer")


@dataclass(frozen=True, slots=True)
class MetadataSearchFailure:
    provider: str
    category: str
    message: str


@dataclass(frozen=True, slots=True)
class MetadataSearchResult:
    work_version: WorkVersionRecord
    providers: tuple[str, ...]
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata


@dataclass(frozen=True, slots=True)
class MetadataSearchOutput:
    results: tuple[MetadataSearchResult, ...]
    failures: tuple[MetadataSearchFailure, ...]


@dataclass(frozen=True, slots=True)
class _ObservedRecord:
    record: ProviderRecord
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    provider_record_id: str


@dataclass(frozen=True, slots=True)
class _PreparedResult:
    batch: MetadataIngestionBatch
    providers: tuple[str, ...]
    identifiers: tuple[Identifier, ...]


class MetadataSearchService:
    def __init__(self, providers: Mapping[str, DiscoveryProvider], repository: WorkRepository) -> None:
        self._providers = dict(providers)
        self._repository = repository

    def search(self, request: MetadataSearchRequest) -> MetadataSearchOutput:
        missing = sorted(set(request.providers) - self._providers.keys())
        if missing:
            raise ValueError(f"missing metadata search providers: {', '.join(missing)}")
        records, failures = self._collect(request)
        if not records and failures:
            detail = "; ".join(f"{failure.provider}:{failure.category}" for failure in failures)
            raise SearchError(f"all metadata search providers failed: {detail}")

        observed = tuple(self._normalize(record) for record in records)
        usable = tuple(item for item in observed if item is not None)
        ambiguous_titles, ambiguous_identifiers = _ambiguities(usable)
        groups = self._merge(
            usable,
            request.precedence,
            ambiguous_titles,
            ambiguous_identifiers,
        )[: request.limit]
        prepared = tuple(
            self._prepare(
                group,
                request.precedence,
                ambiguous_titles,
                ambiguous_identifiers,
            )
            for group in groups
        )
        versions = self._repository.ingest_metadata_batches(
            tuple(item.batch for item in prepared)
        )
        results = tuple(
            self._result(item, version) for item, version in zip(prepared, versions)
        )
        return MetadataSearchOutput(results, failures)

    def _collect(
        self, request: MetadataSearchRequest
    ) -> tuple[tuple[ProviderRecord, ...], tuple[MetadataSearchFailure, ...]]:
        def run(provider_name: str) -> tuple[ProviderRecord, ...]:
            provider = self._providers[provider_name]
            if provider.name != provider_name:
                raise ValueError(f"provider mapping key {provider_name!r} is owned by {provider.name!r}")
            result = provider.search(SearchSpec(request.query, (provider_name,), request.limit))
            if not isinstance(result, tuple) or not all(isinstance(item, ProviderRecord) for item in result):
                raise TypeError(f"provider {provider_name!r} returned invalid ProviderRecord values")
            for item in result:
                if item.provider != provider_name:
                    raise ValueError(
                        f"provider {provider_name!r} returned a record for {item.provider!r}"
                    )
            return result

        futures: dict[str, Future[tuple[ProviderRecord, ...]]] = {}
        slots = Semaphore(min(request.max_concurrency, len(request.providers)))

        def start(name: str) -> None:
            future: Future[tuple[ProviderRecord, ...]] = Future()
            futures[name] = future

            def invoke() -> None:
                with slots:
                    if not future.set_running_or_notify_cancel():
                        return
                    try:
                        future.set_result(run(name))
                    except BaseException as error:
                        future.set_exception(error)

            thread = Thread(
                target=invoke,
                name=f"metadata-search-{name}",
                daemon=True,
            )
            thread.start()

        for provider_name in request.providers:
            start(provider_name)
        deadlines = {
            name: monotonic() + float(request.provider_timeout_seconds)
            for name in request.providers
        }
        records: list[ProviderRecord] = []
        failures: list[MetadataSearchFailure] = []
        try:
            for name in sorted(futures):
                future = futures[name]
                remaining = max(0.0, deadlines[name] - monotonic())
                try:
                    provider_records = future.result(timeout=remaining)
                except TimeoutError:
                    future.cancel()
                    failures.append(MetadataSearchFailure(name, "timeout", "provider deadline exceeded"))
                except ProviderSearchError as error:
                    failures.append(MetadataSearchFailure(
                        name, error.category.value, "provider search failed"
                    ))
                except Exception:
                    failures.append(MetadataSearchFailure(
                        name, "provider_error", "provider search failed"
                    ))
                else:
                    records.extend(provider_records)
        finally:
            for future in futures.values():
                future.cancel()
        records.sort(key=_raw_record_key)
        failures.sort(key=lambda item: item.provider)
        return tuple(records), tuple(failures)

    @staticmethod
    def _normalize(record: ProviderRecord) -> _ObservedRecord | None:
        candidate = normalize_record(record)
        if candidate is None:
            return None
        return _ObservedRecord(
            record=record,
            identifiers=candidate.identifiers,
            metadata=candidate.metadata,
            provider_record_id=_provider_record_id(record, candidate.identifiers, candidate.metadata),
        )

    @staticmethod
    def _merge(
        records: tuple[_ObservedRecord, ...],
        precedence: tuple[str, ...],
        ambiguous_titles: frozenset[str],
        ambiguous_identifiers: frozenset[Identifier],
    ) -> tuple[tuple[_ObservedRecord, ...], ...]:
        groups: list[list[_ObservedRecord]] = []
        for record in records:
            matches = [
                index
                for index, group in enumerate(groups)
                if _records_match(
                    record, group, ambiguous_titles, ambiguous_identifiers
                )
            ]
            if not matches:
                groups.append([record])
                continue
            combined = [record]
            for index in reversed(matches):
                combined.extend(groups.pop(index))
            groups.append(combined)
        order = {provider: index for index, provider in enumerate(precedence)}
        normalized_groups = [
            tuple(sorted(group, key=lambda item: (order[item.record.provider], _raw_record_key(item.record))))
            for group in groups
        ]
        return tuple(sorted(
            normalized_groups,
            key=lambda group: (
                order[group[0].record.provider],
                group[0].record.rank,
                _group_key(group),
            ),
        ))

    @staticmethod
    def _prepare(
        group: tuple[_ObservedRecord, ...],
        precedence: tuple[str, ...],
        ambiguous_titles: frozenset[str],
        ambiguous_identifiers: frozenset[Identifier],
    ) -> _PreparedResult:
        metadata = _canonical_metadata(group)
        if metadata.title is None:
            raise SearchError("merged metadata result has no title")
        identifiers = tuple(sorted(
            {
                identifier
                for item in group
                for identifier in item.identifiers
                if identifier not in ambiguous_identifiers
            },
            key=identifier_sort_key,
        ))
        observations = tuple(_observation(item) for item in group)
        providers = tuple(dict.fromkeys(item.record.provider for item in group))
        has_ambiguous_title = any(
            item.metadata.title is not None
            and normalize_title(item.metadata.title) in ambiguous_titles
            for item in group
        )
        has_ambiguous_identifier = any(
            identifier in ambiguous_identifiers
            for item in group
            for identifier in item.identifiers
        )
        return _PreparedResult(
            MetadataIngestionBatch(
                metadata.title,
                identifiers,
                observations,
                precedence,
                (
                    "conflicting DOI bridge evidence"
                    if has_ambiguous_title or has_ambiguous_identifier
                    else None
                ),
            ),
            providers,
            identifiers,
        )

    def _result(
        self, prepared: _PreparedResult, version: WorkVersionRecord
    ) -> MetadataSearchResult:
        persisted_metadata = self._repository.get_canonical_metadata(version.id)
        return MetadataSearchResult(
            version,
            prepared.providers,
            prepared.identifiers,
            persisted_metadata,
        )


def _records_match(
    record: _ObservedRecord,
    group: list[_ObservedRecord],
    ambiguous_titles: frozenset[str],
    ambiguous_identifiers: frozenset[Identifier],
) -> bool:
    record_dois = {item.value for item in record.identifiers if item.namespace == "doi"}
    group_dois = {
        identifier.value for item in group for identifier in item.identifiers if identifier.namespace == "doi"
    }
    if record_dois and group_dois and record_dois != group_dois:
        return False
    identifiers = set(record.identifiers) - ambiguous_identifiers
    group_identifiers = {
        identifier
        for item in group
        for identifier in item.identifiers
        if identifier not in ambiguous_identifiers
    }
    if identifiers.intersection(group_identifiers):
        return True
    if record.metadata.title is None:
        return False
    title = normalize_title(record.metadata.title)
    if title in ambiguous_titles and (record_dois or group_dois):
        return False
    if not all(item.metadata.title is not None and normalize_title(item.metadata.title) == title for item in group):
        return False
    return True


def _ambiguities(
    records: tuple[_ObservedRecord, ...]
) -> tuple[frozenset[str], frozenset[Identifier]]:
    title_dois: dict[str, set[str]] = {}
    identifier_dois: dict[Identifier, set[str]] = {}
    for item in records:
        dois = {
            identifier.value
            for identifier in item.identifiers
            if identifier.namespace == "doi"
        }
        if not dois:
            continue
        if item.metadata.title is not None:
            title_dois.setdefault(normalize_title(item.metadata.title), set()).update(dois)
        for identifier in item.identifiers:
            if identifier.namespace != "doi":
                identifier_dois.setdefault(identifier, set()).update(dois)
    ambiguous_titles = {
        title for title, dois in title_dois.items() if len(dois) > 1
    }
    ambiguous_identifiers = {
        identifier
        for identifier, dois in identifier_dois.items()
        if len(dois) > 1
    }
    for item in records:
        if any(identifier.namespace == "doi" for identifier in item.identifiers):
            continue
        linked_dois: set[str] = set()
        title = (
            normalize_title(item.metadata.title)
            if item.metadata.title is not None
            else None
        )
        if title is not None:
            linked_dois.update(title_dois.get(title, ()))
        for identifier in item.identifiers:
            linked_dois.update(identifier_dois.get(identifier, ()))
        if len(linked_dois) > 1:
            if title is not None:
                ambiguous_titles.add(title)
            ambiguous_identifiers.update(
                identifier
                for identifier in item.identifiers
                if identifier.namespace != "doi"
            )
    return frozenset(ambiguous_titles), frozenset(ambiguous_identifiers)


def _select(group: tuple[_ObservedRecord, ...], getter):
    for item in group:
        value = getter(item)
        if value is not None and value != ():
            return value
    return None


def _canonical_metadata(group: tuple[_ObservedRecord, ...]) -> CandidateMetadata:
    keywords = {
        keyword.casefold(): keyword
        for item in reversed(group)
        for keyword in item.metadata.keywords
    }
    return CandidateMetadata(
        title=_select(group, lambda item: item.metadata.title),
        abstract=_select(group, lambda item: item.metadata.abstract),
        authors=_select(group, lambda item: item.metadata.authors) or (),
        year=_select(group, lambda item: item.metadata.year),
        venue=_select(group, lambda item: item.metadata.venue),
        keywords=tuple(keywords[key] for key in sorted(keywords)),
    )


def _observation(item: _ObservedRecord) -> MetadataIngestionObservation:
    fields: list[tuple[str, object]] = []
    values = {
        "title": item.metadata.title,
        "abstract": item.metadata.abstract,
        "authors": item.metadata.authors,
        "year": item.metadata.year,
        "venue": item.metadata.venue,
        "publisher": clean_text(item.record.publisher),
        "publication_date": clean_text(item.record.publication_date),
        "open_access_status": clean_text(item.record.open_access_status),
        "keywords": item.metadata.keywords,
    }
    fields.extend((name, value) for name, value in values.items() if value is not None and value != ())
    fields.extend((identifier.namespace, identifier.value) for identifier in item.identifiers)
    return MetadataIngestionObservation(
        provider=item.record.provider,
        provider_record_id=item.provider_record_id,
        fields=tuple(sorted(fields, key=lambda pair: (pair[0], str(pair[1])))),
        provenance=(("provider", item.record.provider), ("provider_record_id", item.provider_record_id)),
    )


def _provider_record_id(
    record: ProviderRecord, identifiers: tuple[Identifier, ...], metadata: CandidateMetadata
) -> str:
    explicit = clean_text(record.provider_record_id)
    if explicit is not None:
        return explicit
    if identifiers:
        identifier = min(identifiers, key=identifier_sort_key)
        return f"{identifier.namespace}:{identifier.value}"
    payload = {
        "provider": record.provider,
        "title": metadata.title,
        "abstract": metadata.abstract,
        "authors": metadata.authors,
        "year": metadata.year,
        "venue": metadata.venue,
        "publisher": clean_text(record.publisher),
        "publication_date": clean_text(record.publication_date),
        "open_access_status": clean_text(record.open_access_status),
        "keywords": metadata.keywords,
    }
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()
    return f"synthetic:sha256:{sha256(encoded).hexdigest()}"


def _raw_record_key(record: ProviderRecord) -> tuple[object, ...]:
    return (
        record.provider.casefold(), record.provider, record.rank, record.raw_identifiers,
        record.title or "", record.abstract or "", record.authors, record.year or -1,
        record.venue or "", record.publisher or "", record.publication_date or "",
        record.keywords,
        record.open_access_status or "",
        record.provider_record_id or "",
    )


def _group_key(group: tuple[_ObservedRecord, ...]) -> tuple[object, ...]:
    identifiers = tuple(sorted(
        {(identifier.namespace, identifier.value) for item in group for identifier in item.identifiers}
    ))
    title = next((item.metadata.title for item in group if item.metadata.title is not None), "")
    ranks = tuple((item.record.provider, item.record.rank) for item in group)
    return identifiers, title.casefold(), ranks


__all__ = (
    "DEFAULT_MAX_CONCURRENCY",
    "DEFAULT_PROVIDER_TIMEOUT_SECONDS",
    "DEFAULT_SEARCH_LIMIT",
    "MetadataSearchFailure",
    "MetadataSearchOutput",
    "MetadataSearchRequest",
    "MetadataSearchResult",
    "MetadataSearchService",
)
