"""Normal-lifecycle import of one explicitly supplied existing asset."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import os
from pathlib import Path
import stat
import time

from sciretriever.acquisition.admission import AdmissionService
from sciretriever.acquisition.models import ProviderContent
from sciretriever.acquisition.validation import validate_content
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.repository import CatalogRepository
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.core.enums import AssetRole, AttemptOutcome, JobState
from sciretriever.errors import CatalogError
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator


MAX_ASSET_BYTES = 100 * 1024 * 1024
_ROLE_FORMAT = {
    AssetRole.PRIMARY_PDF: ("application/pdf", "pdf"),
    AssetRole.SUPPLEMENTARY_PDF: ("application/pdf", "pdf"),
    AssetRole.XML: ("application/xml", "xml"),
    AssetRole.HTML: ("text/html", "html"),
}


@dataclass(frozen=True, slots=True)
class ExistingAssetImportResult:
    disposition: str
    work_id: str
    raw_asset_id: str
    sha256: str


class ExistingAssetImporter:
    def __init__(
        self,
        admission: AdmissionService,
        catalog: CatalogRepository,
        jobs: JobRepository,
        assets: AssetRepository,
        coordinator: AssetAcceptanceCoordinator,
        *,
        max_bytes: int = MAX_ASSET_BYTES,
    ) -> None:
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
            raise ValueError("max_bytes must be a positive integer")
        self.admission = admission
        if not isinstance(catalog, CatalogRepository):
            raise TypeError("catalog must be a CatalogRepository")
        self.catalog = catalog
        self.jobs = jobs
        self.assets = assets
        self.coordinator = coordinator
        self.max_bytes = max_bytes

    @staticmethod
    def resolve_asset(path: str | Path, *, asset_root: str | Path | None = None) -> Path:
        supplied = Path(path).expanduser()
        root: Path | None = None
        if asset_root is not None:
            root_path = Path(asset_root).expanduser().absolute()
            ExistingAssetImporter._reject_symlink_components(root_path)
            root_metadata = root_path.lstat()
            if not stat.S_ISDIR(root_metadata.st_mode):
                raise ValueError("asset root must be an existing real directory")
            root = root_path.resolve(strict=True)
            candidate = supplied if supplied.is_absolute() else root_path / supplied
            resolved = candidate.resolve(strict=True)
            if not resolved.is_relative_to(root):
                raise ValueError("asset path escapes the configured asset root")
            supplied = candidate
        elif supplied.is_absolute():
            resolved = supplied.resolve(strict=True)
        else:
            raise ValueError("relative asset paths require an asset root")
        ExistingAssetImporter._reject_symlink_components(supplied.absolute())
        metadata = supplied.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError("asset must be an existing regular file, not a symlink")
        return resolved

    @staticmethod
    def _reject_symlink_components(path: Path) -> None:
        absolute = Path(os.path.abspath(path))
        current = Path(absolute.anchor)
        for component in absolute.parts[1:]:
            current /= component
            try:
                metadata = current.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(metadata.st_mode):
                raise ValueError("asset path must not contain symlink components")

    def _snapshot(self, path: Path) -> bytes:
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
            raise ValueError("asset must be a regular file")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError("asset must be a regular file")
            if (metadata.st_dev, metadata.st_ino) != (before.st_dev, before.st_ino):
                raise ValueError("asset changed before it could be read")
            if metadata.st_size > self.max_bytes:
                raise ValueError("asset exceeds the configured read bound")
            chunks: list[bytes] = []
            remaining = self.max_bytes + 1
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            if len(data) > self.max_bytes:
                raise ValueError("asset exceeds the configured read bound")
            after = os.fstat(descriptor)
            if (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
            ):
                raise ValueError("asset changed while being read")
            return data
        finally:
            os.close(descriptor)

    def import_asset(
        self,
        path: str | Path,
        identifiers: tuple[Identifier, ...],
        role: AssetRole,
        metadata: CandidateMetadata | None = None,
        *,
        asset_root: str | Path | None = None,
        source_id: str | None = None,
    ) -> ExistingAssetImportResult:
        if not identifiers:
            raise ValueError("at least one identifier is required")
        if not isinstance(role, AssetRole) or role not in _ROLE_FORMAT:
            raise ValueError("unsupported asset role")
        media_type, format_name = _ROLE_FORMAT[role]
        replay = self._authoritative_replay(identifiers, role)
        if replay is not None:
            return replay
        resolved = self.resolve_asset(path, asset_root=asset_root)
        data = self._snapshot(resolved)
        provenance = {"method": "existing-asset-import", "source_id": source_id}
        content = ProviderContent(role, media_type, format_name, "legacy://existing-asset", "legacy-import", data, provenance)
        validate_content(content, role)
        admission = self.admission.admit(
            identifiers,
            metadata,
            provider="legacy-import",
            asset_role=role,
            provenance=provenance,
        )
        if admission.reused_asset_id is not None:
            raw = self.assets.get_raw_asset(admission.reused_asset_id)
            if raw is None:
                raise RuntimeError("authoritative reused asset is missing")
            return ExistingAssetImportResult("replayed", admission.work_id, raw.id, raw.sha256)
        if admission.job_id is None or not self.jobs.claim_job(admission.job_id):
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                replay = self._authoritative_replay(identifiers, role)
                if replay is not None:
                    return replay
                job = None if admission.job_id is None else self.jobs.get_job(admission.job_id)
                if job is None or job.state in {
                    JobState.SUCCEEDED,
                    JobState.FAILED,
                    JobState.CANCELLED,
                    JobState.RETRYABLE,
                    JobState.PAUSED,
                }:
                    state = "missing" if job is None else job.state.value
                    raise RuntimeError(f"existing import job ended without an accepted asset: {state}")
                time.sleep(0.05)
            raise RuntimeError("existing import job could not be claimed")
        attempt = self.jobs.start_attempt(admission.job_id, "legacy-import", source_url="legacy://existing-asset")
        try:
            accepted = self.coordinator.accept(
                BytesIO(data), admission.work_id, admission.job_id, role, media_type, format_name,
                provenance, attempt_id=attempt.id,
            )
        except Exception as error:
            self._close_failed_attempt(attempt.id, admission.job_id, error)
            raise
        try:
            self.jobs.finish_attempt_and_job(attempt.id, AttemptOutcome.SUCCEEDED, JobState.SUCCEEDED)
        except CatalogError:
            finished_attempt = self.jobs.get_attempt(attempt.id)
            finished_job = self.jobs.get_job(admission.job_id)
            replay = self._authoritative_replay(identifiers, role)
            if not (
                finished_attempt is not None
                and finished_attempt.outcome is AttemptOutcome.SUCCEEDED
                and finished_job is not None
                and finished_job.state is JobState.SUCCEEDED
                and replay is not None
                and replay.raw_asset_id == accepted.raw_asset.id
            ):
                self.jobs.succeed_nonterminal_jobs_for_work(admission.work_id, role)
                raise
        except Exception:
            self.jobs.succeed_nonterminal_jobs_for_work(admission.work_id, role)
            raise
        disposition = "replayed" if accepted.reused_content else "imported"
        return ExistingAssetImportResult(disposition, admission.work_id, accepted.raw_asset.id, accepted.raw_asset.sha256)

    def _authoritative_replay(
        self,
        identifiers: tuple[Identifier, ...],
        role: AssetRole,
    ) -> ExistingAssetImportResult | None:
        works = tuple(
            work
            for identifier in identifiers
            if (work := self.catalog.lookup_work(identifier)) is not None
        )
        if len(works) != len(identifiers):
            return None
        work_ids = {work.id for work in works}
        if len(work_ids) != 1:
            return None
        work_id = next(iter(work_ids))
        link = next(
            (item for item in self.assets.get_work_assets(work_id) if item.asset_role is role),
            None,
        )
        if link is None:
            return None
        raw = self.assets.get_raw_asset(link.raw_asset_id)
        if raw is None:
            raise RuntimeError("authoritative reused asset is missing")
        return ExistingAssetImportResult("replayed", work_id, raw.id, raw.sha256)

    def _close_failed_attempt(self, attempt_id: str, job_id: str, error: Exception) -> None:
        details = {"error_type": type(error).__name__, "message": str(error)}
        try:
            self.jobs.finish_attempt_and_job(
                attempt_id,
                AttemptOutcome.FAILED,
                JobState.FAILED,
                details=details,
            )
            return
        except Exception:
            attempt = self.jobs.get_attempt(attempt_id)
            if attempt is not None and attempt.finished_at is None:
                self.jobs.finish_attempt(attempt_id, AttemptOutcome.FAILED, details=details)
            job = self.jobs.get_job(job_id)
            if job is not None and job.state is JobState.ACTIVE:
                self.jobs.complete_job_and_requests(job_id, JobState.FAILED)


__all__ = ("ExistingAssetImportResult", "ExistingAssetImporter", "MAX_ASSET_BYTES")
