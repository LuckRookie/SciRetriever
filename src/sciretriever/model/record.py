"""Format-neutral bibliography records exchanged at the codec boundary.

Codecs for BibTeX/BibLaTeX, RIS, and CSL JSON convert one external record to
the existing :class:`LiteratureMetadata` model before handing it to the
Literature module.  This file therefore keeps only that metadata and the
record's input position; it does not retain source files, paths, bytes,
external-tool identities, import batches, or a second metadata schema.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from sciretriever.model.metadata import LiteratureMetadata


class _RecordModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class BibliographicRecord(_RecordModel):
    """One codec-normalized bibliography record and its input ordinal."""

    record_index: int = Field(strict=True, ge=0)
    metadata: LiteratureMetadata


__all__ = ("BibliographicRecord",)
