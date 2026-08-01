from __future__ import annotations

from contextlib import ExitStack, contextmanager
import hashlib
from pathlib import Path
from typing import Iterator
from unittest.mock import patch

from sciretriever.catalog import LibraryReadRepository
from sciretriever.cli.config_check import check_config
from sciretriever.cli.runtime_readiness import ProbeIdentity, RuntimeReadiness
from sciretriever.config import ConfigCheckMode, load_config
from sciretriever.core.export import (
    ExportDestination, ExportFormat, PackageExportRequest, PackageExportSelector,
    ReadingExportReferences, ReadingExportRequest, ReadingExportSelector,
)
from sciretriever.core.export_publication import ExportPublication, publish_export
from sciretriever.errors import ConfigError
from sciretriever.packaging import (
    PackageExporter, PackagePipeline, PackagePublicationResult,
)

from test_runtime_readiness_wp6 import RecordingProbe
from wp6_acceptance_runtime import AcceptanceRuntime


FIXED_NOW = "2026-07-26T00:00:00.000Z"
CLOCK_MODULES = (
    "sciretriever.packaging.publisher", "sciretriever.references.service",
    "sciretriever.catalog.manual_tag_curation", "sciretriever.catalog.manual_metadata_curation",
    "sciretriever.catalog.curation_records", "sciretriever.catalog.processing",
    "sciretriever.catalog.artifacts", "sciretriever.catalog.canonical_projection",
    "sciretriever.catalog.library", "sciretriever.catalog.diagnostics",
    "sciretriever.catalog.domain_runs", "sciretriever.catalog.repository",
    "sciretriever.catalog.identity", "sciretriever.catalog.analysis",
    "sciretriever.catalog.assets", "sciretriever.catalog.asset_diagnostics",
    "sciretriever.catalog.parser_attempts",
)


@contextmanager
def fixed_clock() -> Iterator[None]:
    with ExitStack() as stack:
        for module in CLOCK_MODULES:
            stack.enter_context(patch(f"{module}.utc_now_rfc3339", return_value=FIXED_NOW))
        yield


def check_offline_and_runtime(root: Path, injection: str | None) -> bool:
    path = root / "config.toml"
    body = "schema_version = 1\n" if injection != "config" else "schema_version = [\n"
    path.write_text(body, encoding="utf-8")
    before = path.read_bytes()
    try:
        config = load_config(path)
    except ConfigError:
        return injection == "config"
    offline = check_config(config, env={}, mode=ConfigCheckMode.OFFLINE)
    calls: list[tuple[str, float]] = []
    readiness = RuntimeReadiness(
        llm=RecordingProbe(calls, "llm", ProbeIdentity("unused"))
    )
    runtime = check_config(
        config, env={}, mode=ConfigCheckMode.RUNTIME, readiness=readiness,
    )
    return (
        offline["status"] == "ready" and runtime["status"] == "ready"
        and path.read_bytes() == before and not calls
    )


def export_reading_views(root: Path, runtime: AcceptanceRuntime, version_id: str) -> None:
    repository = LibraryReadRepository(runtime.catalog)
    requests = tuple(ReadingExportRequest(
        ReadingExportSelector(work_version_id=version_id), references, ExportFormat.JSON,
        ExportDestination.parse(root / name, runtime.catalog.path),
    ) for references, name in (
        (ReadingExportReferences.OMIT, "reading-off.json"),
        (ReadingExportReferences.INCLUDE, "reading-on.json"),
    ))
    results = tuple(repository.exact_lookup(
        work_version_id=version_id,
        include_references=request.references is ReadingExportReferences.INCLUDE,
    ) for request in requests)
    if results[0].items[0].references is not None or not results[1].items[0].references:
        raise AssertionError("reading reference policy was not applied")
    for request, result in zip(requests, results, strict=True):
        publish_export(ExportPublication(
            request.destination.path, runtime.catalog.path,
            (result.to_json() + "\n").encode("utf-8"),
        ))
    if requests[0].destination.path.read_bytes() == requests[1].destination.path.read_bytes():
        raise AssertionError("reading exports did not preserve reference selection")


def export_old_and_new_packages(
    root: Path,
    runtime: AcceptanceRuntime,
    version_id: str,
    old: PackagePublicationResult,
    injection: str | None,
) -> tuple[str, str]:
    pipeline = PackagePipeline(runtime.catalog, runtime.raw_store, runtime.derived_store)
    current = pipeline.run(work_version_id=version_id)
    if not current.created or current.record.version != old.record.version + 1:
        raise AssertionError("reanalysis did not publish one new package")
    destination = root / "package-old.json"
    if injection == "export":
        victim = root / "immutable.json"
        victim.write_bytes(b"preserved")
        destination.hardlink_to(victim)
    exporter = PackageExporter(runtime.catalog, runtime.derived_store)
    exported = exporter.export(PackageExportRequest(
        PackageExportSelector(version_id, old.record.version, old.record.sha256),
        ExportDestination.parse(destination, runtime.catalog.path),
    ))
    replayed = exporter.export(PackageExportRequest(
        PackageExportSelector(version_id, current.record.version, current.record.sha256),
        ExportDestination.parse(root / "package-current.json", runtime.catalog.path),
    ))
    package_bytes_sha = hashlib.sha256(exported.package_bytes).hexdigest()
    export_sha = hashlib.sha256(destination.read_bytes()).hexdigest()
    if package_bytes_sha != export_sha or replayed.package_version != current.record.version:
        raise AssertionError("package export bytes diverged")
    return package_bytes_sha, export_sha


__all__ = (
    "check_offline_and_runtime", "export_old_and_new_packages", "export_reading_views",
    "fixed_clock",
)
