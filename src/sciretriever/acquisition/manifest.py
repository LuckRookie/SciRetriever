"""Streaming reader for strict DownloadManifest JSONL."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from sciretriever.core.contracts import DownloadManifestEntry
from sciretriever.errors import ValidationError


def read_manifest(path: str | Path) -> Iterator[DownloadManifestEntry]:
    source = Path(path)
    with source.open("r", encoding="utf-8", newline="") as stream:
        for line_number, line in enumerate(stream, 1):
            try:
                yield DownloadManifestEntry.from_json_line(line)
            except (TypeError, ValueError) as error:
                raise ValidationError(
                    f"{source}: line {line_number}: {error}"
                ) from error


__all__ = ("read_manifest",)
