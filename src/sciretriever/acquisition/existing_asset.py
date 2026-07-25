"""Validated import of one local asset for an existing WorkVersion."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import os
from pathlib import Path
import stat

from sciretriever.acquisition.models import ProviderContent
from sciretriever.acquisition.validation import validate_content
from sciretriever.catalog.assets import AssetRepository
from sciretriever.core.enums import AssetRole
from sciretriever.core.ids import validate_uuid
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
    work_version_id: str
    raw_asset_id: str
    sha256: str


class ExistingAssetImporter:
    def __init__(
        self,
        assets: AssetRepository,
        coordinator: AssetAcceptanceCoordinator,
        *,
        max_bytes: int = MAX_ASSET_BYTES,
    ) -> None:
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
            raise ValueError("max_bytes must be a positive integer")
        self.assets = assets
        self.coordinator = coordinator
        self.max_bytes = max_bytes

    @staticmethod
    def resolve_asset(path: str | Path, *, asset_root: str | Path | None = None) -> Path:
        supplied = Path(path).expanduser()
        if asset_root is None and not supplied.is_absolute():
            raise ValueError("relative asset paths require an asset root")
        root = None if asset_root is None else Path(asset_root).expanduser().resolve(strict=True)
        if supplied.is_absolute():
            candidate = supplied
        else:
            if root is None:
                raise ValueError("relative asset paths require an asset root")
            candidate = root / supplied
        resolved = candidate.resolve(strict=True)
        if root is not None and not resolved.is_relative_to(root):
            raise ValueError("asset path escapes the configured asset root")
        metadata = candidate.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError("asset must be an existing regular file, not a symlink")
        return resolved

    def _snapshot(self, path: Path) -> bytes:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > self.max_bytes:
                raise ValueError("asset is not a bounded regular file")
            data = os.read(descriptor, self.max_bytes + 1)
            if len(data) > self.max_bytes:
                raise ValueError("asset exceeds the configured read bound")
            return data
        finally:
            os.close(descriptor)

    def import_asset(
        self,
        path: str | Path,
        work_version_id: str,
        role: AssetRole,
        *,
        asset_root: str | Path | None = None,
        source_id: str | None = None,
    ) -> ExistingAssetImportResult:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        if not self.assets.work_version_exists(work_version_id):
            raise ValueError(f"WorkVersion does not exist: {work_version_id}")
        if role not in _ROLE_FORMAT:
            raise ValueError("unsupported asset role")
        resolved_path = self.resolve_asset(path, asset_root=asset_root)
        existing = self.coordinator.existing_asset_id(work_version_id, role)
        if existing is not None:
            raw = self.assets.get_raw_asset(existing)
            if raw is None:
                raise RuntimeError("accepted asset link references a missing RawAsset")
            return ExistingAssetImportResult("replayed", work_version_id, raw.id, raw.sha256)
        media_type, format_name = _ROLE_FORMAT[role]
        data = self._snapshot(resolved_path)
        provenance = {"method": "existing-asset-import", "source_id": source_id}
        content = ProviderContent(
            role, media_type, format_name, "import://existing-asset",
            "existing-asset-import", data, provenance,
        )
        validate_content(content, role)
        accepted = self.coordinator.accept(
            BytesIO(data), work_version_id, role, media_type, format_name, provenance
        )
        return ExistingAssetImportResult(
            "replayed" if accepted.reused_content else "imported",
            work_version_id,
            accepted.raw_asset.id,
            accepted.raw_asset.sha256,
        )


__all__ = ("ExistingAssetImportResult", "ExistingAssetImporter", "MAX_ASSET_BYTES")
