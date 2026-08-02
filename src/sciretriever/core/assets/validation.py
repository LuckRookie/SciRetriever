from __future__ import annotations

from typing import Final

from .errors import AssetRuleError

DEFAULT_ASSET_CHUNK_SIZE: Final = 1024 * 1024


def validate_asset_policy(
    min_pdf_bytes: int,
    max_asset_bytes: int,
    chunk_size: int = DEFAULT_ASSET_CHUNK_SIZE,
) -> None:
    """Validate the positive and ordered limits used by asset acquisition."""
    if min_pdf_bytes <= 0:
        raise AssetRuleError.for_field("min_pdf_bytes", "must be positive")
    if max_asset_bytes <= 0:
        raise AssetRuleError.for_field("max_asset_bytes", "must be positive")
    if max_asset_bytes < min_pdf_bytes:
        raise AssetRuleError.for_field("max_asset_bytes", "must be at least min_pdf_bytes")
    if chunk_size <= 0:
        raise AssetRuleError.for_field("chunk_size", "must be positive")
    if chunk_size > max_asset_bytes:
        raise AssetRuleError.for_field("chunk_size", "must not exceed max_asset_bytes")


__all__ = ("DEFAULT_ASSET_CHUNK_SIZE", "validate_asset_policy")
