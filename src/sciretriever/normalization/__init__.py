"""Deterministic format-independent normalization API."""

from .contracts import NormalizationDraft, NormalizationParameters, RawNormalizationInput, SourceUnit
from .normalizer import NORMALIZER_VERSION, normalize_inputs
from .service import NORMALIZED_CONTENT_MEDIA_TYPE, NormalizationResult, NormalizationService

__all__ = (
    "NORMALIZER_VERSION",
    "NORMALIZED_CONTENT_MEDIA_TYPE",
    "NormalizationDraft",
    "NormalizationParameters",
    "NormalizationResult",
    "NormalizationService",
    "RawNormalizationInput",
    "SourceUnit",
    "normalize_inputs",
)
