from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from sciretriever.kernel.errors import BoundaryError


@dataclass(frozen=True, slots=True)
class RelativeArtifactPath:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str):
            raise BoundaryError.for_field("artifact_path", "must be a string")
        parsed = urlsplit(self.value)
        path = PurePosixPath(self.value)
        invalid = (
            not self.value
            or "\\" in self.value
            or bool(parsed.scheme or parsed.netloc or parsed.query or parsed.fragment)
            or path.is_absolute()
            or self.value != path.as_posix()
            or any(part in {"", ".", ".."} for part in self.value.split("/"))
        )
        if invalid:
            raise BoundaryError.for_field(
                "artifact_path", "must be a normalized relative POSIX path without traversal"
            )

    def __str__(self) -> str:
        return self.value
