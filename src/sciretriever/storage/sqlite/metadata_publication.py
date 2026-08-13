"""SQLite adapter for Metadata-owned relation publication."""

from __future__ import annotations

from sciretriever.model.metadata import ProviderRelationObservation
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter


class SqliteProviderRelationObservationPublication:
    """Delegate one relation transaction to the existing Literature writer."""

    def __init__(self, writer: LiteratureWriter) -> None:
        if not isinstance(writer, LiteratureWriter):
            raise TypeError("writer must be a LiteratureWriter")
        self._writer = writer

    def publish_provider_relation_observation(
        self,
        observation: ProviderRelationObservation,
    ) -> None:
        self._writer.publish_provider_relation_observation(observation)


__all__ = ("SqliteProviderRelationObservationPublication",)
