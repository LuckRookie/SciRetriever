"""Typed invocation context and ownership wrapper for completion assembly."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.cli.acquisition_runtime import AcquisitionCliConfig
from sciretriever.cli.analysis_runtime import AnalysisCliRuntime
from sciretriever.errors import ConfigError

if TYPE_CHECKING:
    from sciretriever.cli.completion_runtime import CompletionRuntime


@dataclass(frozen=True, slots=True)
class CompletionInvocationContext:
    catalog: CatalogEngine
    storage_root: Path

    def __post_init__(self) -> None:
        root = self.storage_root.expanduser()
        if not root.is_dir() or root.is_symlink():
            raise ConfigError("storage root must be an existing real directory")
        object.__setattr__(self, "storage_root", root)


@dataclass(frozen=True, slots=True)
class CompletionRuntimeOptions:
    acquisition: AcquisitionCliConfig | None = None
    acquisition_timeout: float = 30.0
    analysis: AnalysisCliRuntime | None = None


@dataclass(frozen=True, slots=True)
class CommandCompletionRuntime:
    catalog: CatalogEngine
    completion: CompletionRuntime

    def close(self) -> None:
        self.catalog.dispose()


__all__ = (
    "CommandCompletionRuntime", "CompletionInvocationContext", "CompletionRuntimeOptions",
)
