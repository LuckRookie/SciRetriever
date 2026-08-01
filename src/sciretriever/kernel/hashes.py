from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from sciretriever.kernel.errors import BoundaryError

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class Sha256:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or _SHA256.fullmatch(self.value) is None:
            raise BoundaryError.for_field("sha256", "must be lowercase 64-hex SHA-256")

    @classmethod
    def from_bytes(cls, value: bytes) -> Sha256:
        if not isinstance(value, bytes):
            raise BoundaryError.for_field("value", "must be bytes")
        return cls(hashlib.sha256(value).hexdigest())

    def __str__(self) -> str:
        return self.value
