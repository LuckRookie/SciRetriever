"""Bounded concurrent collection from configured metadata providers."""

from __future__ import annotations

from concurrent.futures import Future
from dataclasses import dataclass
from threading import Semaphore, Thread
from time import monotonic
from typing import Mapping

from sciretriever.core.contracts import SearchSpec
from .models import ProviderRecord
from .providers.base import DiscoveryProvider
from .search_contracts import MetadataSearchFailure
from .search_records import raw_record_key
from sciretriever.errors import ProviderSearchError


@dataclass(frozen=True, slots=True)
class ProviderCollectionRequest:
    query: str
    providers: tuple[str, ...]
    limit: int
    provider_timeout_seconds: float
    max_concurrency: int


@dataclass(frozen=True, slots=True)
class ProviderCollection:
    records: tuple[ProviderRecord, ...]
    failures: tuple[MetadataSearchFailure, ...]


class ProviderCollector:
    """Collect deterministic records while bounding each provider deadline."""

    def __init__(self, providers: Mapping[str, DiscoveryProvider]) -> None:
        self._providers = dict(providers)

    def collect(self, request: ProviderCollectionRequest) -> ProviderCollection:
        missing = sorted(set(request.providers) - self._providers.keys())
        if missing:
            raise ValueError(f"missing metadata search providers: {', '.join(missing)}")

        futures: dict[str, Future[tuple[ProviderRecord, ...]]] = {}
        slots = Semaphore(min(request.max_concurrency, len(request.providers)))
        for provider_name in request.providers:
            future: Future[tuple[ProviderRecord, ...]] = Future()
            futures[provider_name] = future
            thread = Thread(
                target=self._invoke,
                args=(provider_name, request, future, slots),
                name=f"metadata-search-{provider_name}",
                daemon=True,
            )
            thread.start()

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
                    failures.append(MetadataSearchFailure(
                        name, "timeout", "provider deadline exceeded"
                    ))
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
        records.sort(key=raw_record_key)
        failures.sort(key=lambda item: item.provider)
        return ProviderCollection(tuple(records), tuple(failures))

    def _invoke(
        self,
        provider_name: str,
        request: ProviderCollectionRequest,
        future: Future[tuple[ProviderRecord, ...]],
        slots: Semaphore,
    ) -> None:
        with slots:
            if not future.set_running_or_notify_cancel():
                return
            try:
                future.set_result(self._run(provider_name, request))
            except BaseException as error:
                future.set_exception(error)

    def _run(
        self, provider_name: str, request: ProviderCollectionRequest
    ) -> tuple[ProviderRecord, ...]:
        provider = self._providers[provider_name]
        if provider.name != provider_name:
            raise ValueError(
                f"provider mapping key {provider_name!r} is owned by {provider.name!r}"
            )
        result = provider.search(SearchSpec(request.query, (provider_name,), request.limit))
        if not isinstance(result, tuple) or not all(
            isinstance(item, ProviderRecord) for item in result
        ):
            raise TypeError(f"provider {provider_name!r} returned invalid ProviderRecord values")
        for item in result:
            if item.provider != provider_name:
                raise ValueError(
                    f"provider {provider_name!r} returned a record for {item.provider!r}"
                )
        return result


__all__ = ("ProviderCollectionRequest", "ProviderCollector")
