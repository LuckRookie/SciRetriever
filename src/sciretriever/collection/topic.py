from __future__ import annotations

from dataclasses import dataclass

from sciretriever.collection.model import ValidatedTopicConditionSet
from sciretriever.kernel import BoundaryError, CanonicalJsonObject, Sha256, canonical_json_bytes


@dataclass(frozen=True, slots=True)
class TopicConditions:
    query: str
    year_from: int | None = None
    year_to: int | None = None
    limit: int = 1000

    def __post_init__(self) -> None:
        if not isinstance(self.query, str) or not self.query.strip():
            raise BoundaryError.for_field("query", "must be nonblank text")
        if not isinstance(self.limit, int) or isinstance(self.limit, bool) or self.limit < 1:
            raise BoundaryError.for_field("limit", "must be a positive integer")
        years = tuple(value for value in (self.year_from, self.year_to) if value is not None)
        if any(
            not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 9999
            for value in years
        ):
            raise BoundaryError.for_field("year", "must be from 1 through 9999")
        if (
            self.year_from is not None
            and self.year_to is not None
            and self.year_from > self.year_to
        ):
            raise BoundaryError.for_field("year range", "must be ordered")

    def validated(self) -> ValidatedTopicConditionSet:
        value = CanonicalJsonObject(
            (
                ("limit", self.limit),
                ("query", self.query.strip()),
                ("year_from", self.year_from),
                ("year_to", self.year_to),
            )
        )
        payload = canonical_json_bytes(value)
        return ValidatedTopicConditionSet(payload.decode("ascii"), Sha256.from_bytes(payload))


__all__ = ("TopicConditions",)
