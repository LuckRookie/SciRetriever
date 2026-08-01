"""Atomic publication of discovery download manifests."""

from __future__ import annotations

from collections.abc import Mapping
import os
from pathlib import Path
import tempfile
from typing import Iterable

from sciretriever.catalog.repository import ReadOnlyCatalogView
from sciretriever.core.contracts import DownloadManifestEntry, SearchSpec
from sciretriever.discovery.labeling import Labeler
from sciretriever.discovery.pipeline import DiscoveryOutput, discover
from sciretriever.discovery.providers.base import DiscoveryProvider


def _fsync_directory(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        return
    try:
        try:
            os.fsync(descriptor)
        except OSError:
            pass
    finally:
        os.close(descriptor)


def write_manifest(entries: Iterable[DownloadManifestEntry], output: str | os.PathLike[str]) -> None:
    """Atomically replace output with compact JSONL serialized from entries."""
    destination = Path(output)
    parent = destination.parent
    if not parent.is_dir():
        raise FileNotFoundError(f"manifest parent directory does not exist: {parent}")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            for entry in entries:
                if not isinstance(entry, DownloadManifestEntry):
                    raise TypeError("entries must contain DownloadManifestEntry values")
                stream.write(entry.to_json_line())
                stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise
    _fsync_directory(parent)


def discover_to_jsonl(
    spec: SearchSpec,
    output: str | os.PathLike[str],
    *,
    providers: Mapping[str, DiscoveryProvider],
    catalog: ReadOnlyCatalogView,
    labeler: Labeler,
    intake_run_id: str,
    retrieved_at: str,
    provider_timeout_seconds: float = 30.0,
) -> DiscoveryOutput:
    """Complete discovery before atomically publishing its manifest."""
    entries = discover(
        spec,
        providers=providers,
        catalog=catalog,
        labeler=labeler,
        intake_run_id=intake_run_id,
        retrieved_at=retrieved_at,
        provider_timeout_seconds=provider_timeout_seconds,
    )
    write_manifest(entries, output)
    return entries


__all__ = ("discover_to_jsonl", "write_manifest")
