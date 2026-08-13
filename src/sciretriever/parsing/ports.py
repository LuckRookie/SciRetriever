"""Path-free Ports and staged values owned by the Parsing capability.

The only Parser adapter Port is :class:`ParserPort`.  Storage interaction is
kept behind one separate result-store Port so parser implementations never see
Catalog rows, artifact paths, or publication mechanics.
"""

from __future__ import annotations

import threading
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import BinaryIO, Protocol, runtime_checkable

from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserRequest,
    ParserResult,
)
from sciretriever.model.primitives import AssetId, Sha256
from sciretriever.model.report import StableFailure


class ParsingFailure(RuntimeError):
    """A stable, redacted Parsing failure suitable for an Entry target result."""

    _MESSAGE = "literature parsing failed"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure


@runtime_checkable
class ParserArtifactContent(Protocol):
    """A path-free, repeatably openable staged artifact capability."""

    def open(self) -> AbstractContextManager[BinaryIO]: ...


@runtime_checkable
class ParserArtifactCleanup(Protocol):
    """Optional idempotent release for a staged artifact capability.

    In-memory readers need not implement this capability.  Adapters backed by
    private temporary resources can implement it without exposing a path.
    """

    def discard(self) -> None: ...


@dataclass(frozen=True, slots=True)
class StagedParserArtifact:
    """One declared immutable artifact plus its private staged byte capability."""

    artifact: ParserArtifactRef
    content: ParserArtifactContent = field(repr=False)

    def discard(self) -> None:
        """Idempotently release an owned staged capability when it supports cleanup."""

        cleanup = self.content
        if isinstance(cleanup, ParserArtifactCleanup):
            cleanup.discard()


@dataclass(frozen=True, slots=True)
class StagedParserResource:
    """One normalized local Markdown reference and its staged artifact."""

    reference: str
    artifact: StagedParserArtifact


@dataclass(frozen=True, slots=True)
class StagedParserOutput:
    """Parser-neutral staged output returned by exactly one selected adapter.

    This is an untrusted Parsing-boundary value.  Deliberately light
    construction permits the service rules to reject malformed adapter output
    as one stable structure failure rather than leaking raw validation errors.
    """

    source_asset_id: AssetId
    source_sha256: Sha256
    page_count: int
    markdown: StagedParserArtifact
    resources: tuple[StagedParserResource, ...]
    provenance: ParserProvenance


@dataclass(frozen=True, slots=True)
class ParserResultPublicationCommand:
    """Validated staged artifacts and manifest offered to the future P3 adapter."""

    result: ParserResult
    markdown: StagedParserArtifact = field(repr=False)
    resources: tuple[StagedParserResource, ...] = field(repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.result, ParserResult):
            raise TypeError("result must be a ParserResult")
        if not isinstance(self.markdown, StagedParserArtifact):
            raise TypeError("markdown must be a StagedParserArtifact")
        if not isinstance(self.resources, tuple) or any(
            not isinstance(resource, StagedParserResource) for resource in self.resources
        ):
            raise TypeError("resources must be a tuple of StagedParserResource values")
        if self.markdown.artifact != self.result.markdown:
            raise ValueError("staged Markdown must match the ParserResult")
        staged_resources = tuple(
            (resource.reference, resource.artifact.artifact) for resource in self.resources
        )
        result_resources = tuple(
            (resource.reference, resource.artifact) for resource in self.result.resources
        )
        if staged_resources != result_resources:
            raise ValueError("staged resources must match the ParserResult")

    def discard(self) -> None:
        """Release every private staged capability; repeated calls are safe."""

        self.markdown.discard()
        for resource in self.resources:
            resource.artifact.discard()


@runtime_checkable
class ParserPort(Protocol):
    """The single explicit Parser adapter capability used for one PDF."""

    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput: ...


@runtime_checkable
class ParserResultStorePort(Protocol):
    """Minimal P3-facing current-primary and current-result Storage boundary."""

    def current_primary_matches(
        self,
        source_asset_id: AssetId,
        source_sha256: Sha256,
    ) -> bool: ...

    def publish_current(self, command: ParserResultPublicationCommand) -> ParserResult: ...

    def read_current(self, source_asset_id: AssetId) -> ParserResult | None: ...


__all__ = (
    "ParserArtifactContent",
    "ParserArtifactCleanup",
    "ParserPort",
    "ParserResultPublicationCommand",
    "ParserResultStorePort",
    "ParsingFailure",
    "StagedParserArtifact",
    "StagedParserOutput",
    "StagedParserResource",
)
