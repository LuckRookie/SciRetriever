from __future__ import annotations

from typing import Protocol

from sciretriever.model.collection import CollectionAcceptance
from sciretriever.model.execution import (
    ContentAcceptanceCommand,
)


class CollectionAcceptancePublisher(Protocol):
    def publish(self, command: CollectionAcceptance) -> None: ...


class ContentAcceptancePublisher(Protocol):
    def publish(self, command: ContentAcceptanceCommand) -> None: ...


__all__ = (
    "CollectionAcceptancePublisher",
    "ContentAcceptancePublisher",
)
