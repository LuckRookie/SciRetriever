from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from sciretriever.model.library_views import LibrarySummary


class _LibraryPageModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class LibraryPageRequest(_LibraryPageModel):
    limit: int = Field(ge=1, le=1000)
    cursor: str | None
    include_all_versions: bool


class LibraryPage(_LibraryPageModel):
    items: tuple[LibrarySummary, ...]
    next_cursor: str | None


__all__ = ("LibraryPage", "LibraryPageRequest")
