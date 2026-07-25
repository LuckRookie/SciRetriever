"""Fail-closed completion adapters for command runtimes without stage configuration."""

from sciretriever.completion import (
    AnalysisPromotionRequest, AnalysisPromotionResult, MetadataResolutionPolicy,
    OptionalAssetRequest, OptionalAssetResult, RequiredPrimaryResult,
)
from sciretriever.discovery.search_contracts import ExactMetadataOutput, ExactMetadataRequest
from sciretriever.errors import ConfigError


class UnconfiguredExactMetadata:
    def resolve(self, request: ExactMetadataRequest) -> ExactMetadataOutput:
        raise ConfigError("exact metadata is not configured")


class UnconfiguredRequiredPrimary:
    async def acquire(self, work_version_id: str) -> RequiredPrimaryResult:
        raise ConfigError("required acquisition is not configured")


class UnconfiguredOptionalAssets:
    async def acquire(self, request: OptionalAssetRequest) -> OptionalAssetResult:
        raise ConfigError("optional acquisition is not configured")


class UnconfiguredAnalysisPromotion:
    def promote(self, request: AnalysisPromotionRequest) -> AnalysisPromotionResult:
        raise ConfigError("analysis is not configured")


UNCONFIGURED_POLICY = MetadataResolutionPolicy(("unconfigured",), ("unconfigured",))


__all__ = (
    "UNCONFIGURED_POLICY", "UnconfiguredAnalysisPromotion", "UnconfiguredExactMetadata",
    "UnconfiguredOptionalAssets", "UnconfiguredRequiredPrimary",
)
