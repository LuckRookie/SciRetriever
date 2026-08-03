from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final
from uuid import uuid4

import sciretriever.model.collection as collection_models
from sciretriever.core.collection import (
    CollectionRuleError,
    validate_topic_condition_set,
    validated_topic_conditions,
)
from sciretriever.model.collection import (
    CitationCollectionRequest,
    CollectionDefinition,
    CreateCollectionDefinition,
)
from sciretriever.model.primitives import CollectionId, UtcTimestamp, WorkVersionState

from .citation import CitationCollectionUseCase
from .ports import (
    CitationDiscoveryPort,
    Clock,
    CollectionAcceptancePublisher,
    CollectionRepository,
    CoreWriteAcquirer,
    LiteratureServicePort,
    MetadataDiscoveryPort,
)
from .topic import TopicCollectionUseCase

_DEFAULT_CLOCK: Final[Clock]


def _system_clock() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return UtcTimestamp(value)


_DEFAULT_CLOCK = _system_clock


@dataclass(frozen=True, slots=True)
class MetadataSource:
    name: str
    port: MetadataDiscoveryPort

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise CollectionRuleError.for_field("metadata source", "must have a nonblank name")


@dataclass(frozen=True, slots=True)
class CitationSource:
    name: str
    port: CitationDiscoveryPort

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise CollectionRuleError.for_field("citation source", "must have a nonblank name")


@dataclass(frozen=True, slots=True)
class CollectionServiceDependencies:
    repository: CollectionRepository
    literature: LiteratureServicePort
    publisher: CollectionAcceptancePublisher
    acquire_core_write: CoreWriteAcquirer
    metadata_sources: tuple[MetadataSource, ...]
    citation_sources: tuple[CitationSource, ...] = ()
    clock: Clock = _DEFAULT_CLOCK

    def __post_init__(self) -> None:
        metadata_names = tuple(item.name for item in self.metadata_sources)
        if not metadata_names or len(set(metadata_names)) != len(metadata_names):
            raise CollectionRuleError.for_field("metadata sources", "must be nonempty and unique")
        citation_names = tuple(item.name for item in self.citation_sources)
        if len(set(citation_names)) != len(citation_names):
            raise CollectionRuleError.for_field("citation sources", "must be unique")


class CollectionService:
    def __init__(self, dependencies: CollectionServiceDependencies) -> None:
        self._dependencies = dependencies

    def create(
        self,
        name: str,
        description: str | None,
        topic_conditions: collection_models.TopicConditions | None,
    ) -> CollectionDefinition:
        if not isinstance(name, str) or not name.strip():
            raise CollectionRuleError.for_field("name", "must be nonblank text")
        if description is not None and (
            not isinstance(description, str) or not description.strip()
        ):
            raise CollectionRuleError.for_field("description", "must be nonblank text when present")
        definition = CollectionDefinition(
            collection_id=CollectionId(str(uuid4())),
            name=name.strip(),
            description=None if description is None else description.strip(),
            topic_conditions=(
                None if topic_conditions is None else validated_topic_conditions(topic_conditions)
            ),
            created_at=self._dependencies.clock(),
        )
        return self._dependencies.repository.create_definition(
            CreateCollectionDefinition(definition=definition)
        )

    def get(self, collection_id: CollectionId) -> CollectionDefinition | None:
        definition = self._dependencies.repository.get_definition(collection_id)
        if definition is not None and definition.topic_conditions is not None:
            validate_topic_condition_set(definition.topic_conditions)
        return definition

    def run_topic(
        self,
        collection_id: CollectionId,
        requested_advance_to: WorkVersionState,
    ) -> collection_models.CollectionRunRecord:
        return TopicCollectionUseCase(self._dependencies).execute(
            collection_id, requested_advance_to
        )

    def run_citation(
        self,
        collection_id: CollectionId,
        request: CitationCollectionRequest,
        requested_advance_to: WorkVersionState,
    ) -> collection_models.CollectionRunRecord:
        with self._dependencies.acquire_core_write():
            return CitationCollectionUseCase(self._dependencies).execute(
                collection_id, request, requested_advance_to
            )


__all__ = (
    "CitationSource",
    "CollectionRuleError",
    "CollectionService",
    "CollectionServiceDependencies",
    "MetadataSource",
)
