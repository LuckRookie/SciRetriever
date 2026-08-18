"""Capability-scoped Metadata provider and publication ports.

There is intentionally no catch-all MetadataProvider and no CitationProvider.
Each optional capability opens a short-lived, lazy raw-item session.  The
session owns all vendor pagination state; cursors, pages, request/response
objects, and vendor SDK values never cross the public :mod:`metadata.api`
boundary or enter a scan result.  Metadata-owned publication collaboration is
also declared here so Storage can implement that Port without importing a
Metadata runtime module.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Generic, Protocol, TypeVar, cast, runtime_checkable

from sciretriever.metadata.rules import (
    NeutralMetadataItem,
    ReferenceQueryContext,
    TopicSearchQuery,
    _pagination_loop_failure,
    _provider_protocol_failure,
)
from sciretriever.model.metadata import ProviderLiteratureKey, ProviderRelationObservation
from sciretriever.model.report import StableFailure

MAX_PROVIDER_RELATION_PUBLICATION_BATCH: Final[int] = 256


@runtime_checkable
class ProviderRelationObservationPublicationPort(Protocol):
    """Persist one non-empty bounded batch of validated relation facts."""

    def publish_provider_relation_observations(
        self,
        observations: tuple[ProviderRelationObservation, ...],
    ) -> None: ...


class MetadataProviderFailure(RuntimeError):
    """An expected provider/protocol failure already stabilized and redacted."""

    _MESSAGE = "metadata provider call failed"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure


@dataclass(frozen=True, slots=True)
class RawItemDelivery:
    """One unconverted item and whether exhaustion is already proven after it."""

    raw_item: object
    source_exhausted_after: bool


@runtime_checkable
class RawItemSession(Protocol):
    """Package-level, non-persistent raw-item scan state owned by an adapter."""

    def pull_raw_item(self) -> RawItemDelivery | None:
        """Return the next unconverted item, or ``None`` for proven exhaustion."""
        ...

    def convert_raw_item(self, raw_item: object) -> NeutralMetadataItem:
        """Convert one item only after Metadata has consumed its scan budget."""
        ...


@runtime_checkable
class TopicSearchPort(Protocol):
    """Optional provider capability for neutral topic searches."""

    @property
    def provider_name(self) -> str: ...

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession: ...


@runtime_checkable
class MetadataLookupPort(Protocol):
    """Optional exact lookup capability for one explicit provider key."""

    @property
    def provider_name(self) -> str: ...

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession: ...


@runtime_checkable
class ReferenceQueryPort(Protocol):
    """Optional Metadata capability for citing/cited relation queries."""

    @property
    def provider_name(self) -> str: ...

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession: ...


_RawItemT = TypeVar("_RawItemT")
_CursorT = TypeVar("_CursorT")


@dataclass(frozen=True, slots=True)
class _RawPage(Generic[_RawItemT, _CursorT]):
    """Adapter-package-only mechanical page; never part of Metadata API/results."""

    items: tuple[_RawItemT, ...]
    next_cursor: _CursorT | None
    exhausted: bool


class _PagedRawItemSession(Generic[_RawItemT, _CursorT]):
    """Reusable lazy pagination guard for provider adapters.

    This helper deliberately remains package-internal.  It hides the vendor
    cursor type from MetadataService, pulls no page at construction time, and
    never fetches another page unless the service asks for another raw item.
    """

    def __init__(
        self,
        fetch_page: Callable[[_CursorT | None], _RawPage[_RawItemT, _CursorT]],
        convert_item: Callable[[_RawItemT], NeutralMetadataItem],
    ) -> None:
        if not callable(fetch_page):
            raise TypeError("fetch_page must be callable")
        if not callable(convert_item):
            raise TypeError("convert_item must be callable")
        self._fetch_page = fetch_page
        self._convert_item = convert_item
        self._next_cursor: _CursorT | None = None
        self._seen_cursors: list[_CursorT] = []
        self._items: tuple[_RawItemT, ...] = ()
        self._item_index = 0
        self._current_page_exhausted = False
        self._finished = False

    def pull_raw_item(self) -> RawItemDelivery | None:
        if self._finished:
            return None
        if self._item_index >= len(self._items):
            self._load_next_page()
            if self._finished:
                return None

        raw_item = self._items[self._item_index]
        self._item_index += 1
        is_last_in_page = self._item_index == len(self._items)
        source_exhausted_after = is_last_in_page and self._current_page_exhausted
        if source_exhausted_after:
            self._finished = True
        return RawItemDelivery(
            raw_item=raw_item,
            source_exhausted_after=source_exhausted_after,
        )

    def convert_raw_item(self, raw_item: object) -> NeutralMetadataItem:
        # The raw value came from this session's typed page fetcher.  Keeping
        # the cast here prevents its vendor type from escaping into Service.
        return self._convert_item(cast(_RawItemT, raw_item))

    def _load_next_page(self) -> None:
        page = self._fetch_page(self._next_cursor)
        if not isinstance(page, _RawPage):
            raise TypeError("fetch_page must return a _RawPage")
        if not isinstance(page.items, tuple):
            raise TypeError("raw page items must be a tuple")
        if not isinstance(page.exhausted, bool):
            raise TypeError("raw page exhausted must be bool")

        if page.exhausted:
            if page.next_cursor is not None:
                raise MetadataProviderFailure(_provider_protocol_failure())
        else:
            if page.next_cursor is None:
                raise MetadataProviderFailure(_provider_protocol_failure())
            if not page.items:
                raise MetadataProviderFailure(_pagination_loop_failure())
            if any(page.next_cursor == previous for previous in self._seen_cursors):
                raise MetadataProviderFailure(_pagination_loop_failure())
            self._seen_cursors.append(page.next_cursor)

        self._items = page.items
        self._item_index = 0
        self._current_page_exhausted = page.exhausted
        self._next_cursor = page.next_cursor
        if not page.items and page.exhausted:
            self._finished = True


__all__ = (
    "MAX_PROVIDER_RELATION_PUBLICATION_BATCH",
    "MetadataLookupPort",
    "MetadataProviderFailure",
    "ProviderRelationObservationPublicationPort",
    "RawItemDelivery",
    "RawItemSession",
    "ReferenceQueryPort",
    "TopicSearchPort",
)
