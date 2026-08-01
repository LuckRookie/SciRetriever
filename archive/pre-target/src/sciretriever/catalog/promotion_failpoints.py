"""Catalog-owned test instrumentation for atomic analysis promotion."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


PROMOTION_FAILPOINTS = (
    "before_current_analysis_write",
    "before_generated_metadata_delete",
    "before_generated_metadata_insert",
    "before_canonical_projection_write",
    "before_reference_delete",
    "before_reference_insert",
    "before_generated_tag_delete",
    "before_generated_tag_insert",
    "before_prior_run_delete",
    "before_prior_artifact_delete",
)


@dataclass(frozen=True, slots=True)
class PromotionFailpoint:
    callback: Callable[[str], None] | None = None

    def before(self, point: str) -> None:
        if point not in PROMOTION_FAILPOINTS:
            raise ValueError(f"unknown promotion failpoint: {point}")
        if self.callback is not None:
            self.callback(point)


__all__ = ("PROMOTION_FAILPOINTS", "PromotionFailpoint")
