"""Deterministic format-independent normalization API."""

from .contracts import NormalizationDraft, NormalizationParameters, PdfBoundingBox, PdfEvidenceLocator, PdfPageGeometry, PdfSourceUnit, RawNormalizationInput, SourceUnit
from .normalizer import NORMALIZER_VERSION, normalize_inputs
from .service import NORMALIZED_CONTENT_MEDIA_TYPE, NormalizationResult, NormalizationService
from .mineru_archive import admit_mineru_archive
from .mineru_client import MinerUClient, MinerUHttpResponse, MinerUTransport, RequestsMinerUTransport
from .mineru_contracts import MinerUArchiveEntry, MinerUHealth, MinerUResult, MinerUResultState, MinerUTask, MinerUTaskStatus, ValidatedMinerUArchive
from .mineru_service import MINERU_PARSER_MEDIA_TYPE, MinerUParsingResult, MinerUParsingService
from .mineru_source_map import MINERU_SOURCE_MAP_KIND, MINERU_SOURCE_MAP_MEDIA_TYPE, MinerUSourceMap, MinerUSourceMapResult, MinerUSourceMapService

__all__ = (
    "NORMALIZER_VERSION",
    "NORMALIZED_CONTENT_MEDIA_TYPE",
    "MINERU_PARSER_MEDIA_TYPE",
    "MINERU_SOURCE_MAP_KIND",
    "MINERU_SOURCE_MAP_MEDIA_TYPE",
    "MinerUArchiveEntry",
    "MinerUClient",
    "MinerUHealth",
    "MinerUHttpResponse",
    "MinerUParsingResult",
    "MinerUParsingService",
    "MinerUSourceMap",
    "MinerUSourceMapResult",
    "MinerUSourceMapService",
    "MinerUResult",
    "MinerUResultState",
    "MinerUTask",
    "MinerUTaskStatus",
    "MinerUTransport",
    "NormalizationDraft",
    "NormalizationParameters",
    "NormalizationResult",
    "NormalizationService",
    "PdfBoundingBox",
    "PdfEvidenceLocator",
    "PdfPageGeometry",
    "PdfSourceUnit",
    "RawNormalizationInput",
    "SourceUnit",
    "RequestsMinerUTransport",
    "ValidatedMinerUArchive",
    "admit_mineru_archive",
    "normalize_inputs",
)
