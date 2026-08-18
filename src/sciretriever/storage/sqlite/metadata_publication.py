"""SQLite adapter for Metadata-owned relation publication."""

from __future__ import annotations

from sciretriever.metadata.ports import MAX_PROVIDER_RELATION_PUBLICATION_BATCH
from sciretriever.model.metadata import ProviderRelationObservation
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter


class SqliteProviderRelationObservationPublication:
    """Delegate one bounded relation transaction to the Literature writer."""

    def __init__(self, writer: LiteratureWriter) -> None:
        if not isinstance(writer, LiteratureWriter):
            raise TypeError("writer must be a LiteratureWriter")
        self._writer = writer

    def publish_provider_relation_observations(
        self,
        observations: tuple[ProviderRelationObservation, ...],
    ) -> None:
        if not isinstance(observations, tuple) or any(
            not isinstance(observation, ProviderRelationObservation) for observation in observations
        ):
            raise TypeError("observations must be a tuple of ProviderRelationObservation")
        if not observations:
            raise ValueError("observations must not be empty")
        if len(observations) > MAX_PROVIDER_RELATION_PUBLICATION_BATCH:
            raise ValueError("observations exceed the bounded publication batch")
        self._writer.publish_provider_relation_observations(observations)


__all__ = ("SqliteProviderRelationObservationPublication",)
