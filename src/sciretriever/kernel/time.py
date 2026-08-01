from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from sciretriever.kernel.errors import BoundaryError

_RFC3339_UTC = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})T(?P<time>\d{2}:\d{2}:\d{2})"
    r"(?P<fraction>\.\d+)?Z$"
)


@dataclass(frozen=True, slots=True)
class UtcTimestamp:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or _RFC3339_UTC.fullmatch(self.value) is None:
            raise BoundaryError.for_field("timestamp", "must be RFC3339 UTC ending in Z")
        try:
            datetime.fromisoformat(self.value[:-1] + "+00:00")
        except ValueError as error:
            raise BoundaryError.for_field("timestamp", "must be a valid UTC date-time") from error

    @classmethod
    def now(cls) -> UtcTimestamp:
        value = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return cls(value)

    def __str__(self) -> str:
        return self.value
