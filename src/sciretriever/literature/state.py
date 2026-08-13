"""Pure Literature state derivation from the committed current facts.

The Literature status is deliberately not a mutable field owned by this
module.  Storage supplies a read-only snapshot of the concrete Literature,
its current primary PDF publication, the current ParserResult and the one
current LiteratureContent.  This module only validates the relationships
needed for the projection and returns the status that follows from them.

No parser result, reference, support row, failure, attempt or execution fact
can advance a Literature state.  In particular, a ParserResult is useful
input for Analysis but is not a product result in its own right.
"""

from __future__ import annotations

from typing import cast

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import LiteratureContent
from sciretriever.model.analysis import analysis_input_sha256 as _analysis_input_sha256
from sciretriever.model.literature import Literature, LiteratureStatus
from sciretriever.model.parsing import ParserResult
from sciretriever.model.primitives import (
    AssetId,
    LiteratureId,
    Sha256,
)


class _StateModel(BaseModel):
    """Closed, immutable, strict contracts local to state projection."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class CurrentPrimaryPdf(_StateModel):
    """One already-published primary-PDF Asset/relation pair.

    The tuple of these values on :class:`CurrentLiteratureFacts` is allowed to
    contain more than one item so a damaged or conflicting publication can be
    represented and rejected by a business decision with a stable reason,
    rather than being hidden by a uniqueness check in this read-side value.
    """

    asset: Asset
    relation: LiteratureAsset

    @model_validator(mode="after")
    def validate_primary_pair(self) -> "CurrentPrimaryPdf":
        if self.relation.role is not AssetRole.PRIMARY_PDF:
            raise ValueError("current primary PDF relation must use primary-pdf role")
        if self.relation.asset_id != self.asset.asset_id:
            raise ValueError("current primary PDF relation must point to its Asset")
        if self.asset.media_type != "application/pdf":
            raise ValueError("current primary PDF Asset must use application/pdf")
        return self


class CurrentContentLineage(_StateModel):
    """The immutable input binding stored when current content was generated.

    This is a read projection of ``literature_contents`` rather than a second
    content Model or a pointer to the replaceable current ParserResult.  It
    lets pure status derivation validate the accepted Analysis provenance
    after a successful reparse has installed a different current result.
    """

    primary_asset_id: AssetId
    primary_pdf_sha256: Sha256
    parser_result_sha256: Sha256


class CurrentLiteratureFacts(_StateModel):
    """The minimal committed snapshot needed for status and content decisions.

    ``literature.status`` is intentionally not consulted by
    :func:`derive_status`; it is a read projection field in the neutral Model,
    while this snapshot's status is derived from the facts below.  A tuple is
    used for primary PDFs so an invalid publication conflict can be handled
    fail-closed by the owning business operation.
    """

    literature: Literature
    metadata_revision: int = Field(strict=True, ge=1)
    metadata_sha256: Sha256
    current_primary_pdfs: tuple[CurrentPrimaryPdf, ...] = ()
    current_parser_result: ParserResult | None = None
    current_content: LiteratureContent | None = None
    current_content_lineage: CurrentContentLineage | None = None

    @field_validator("current_primary_pdfs", mode="before")
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(cast(list[object], value))
        return value

    @model_validator(mode="after")
    def validate_content_lineage_pair(self) -> "CurrentLiteratureFacts":
        if (self.current_content is None) != (self.current_content_lineage is None):
            raise ValueError("current content and its generation lineage must be paired")
        return self


def _is_valid_primary_for(
    primary: CurrentPrimaryPdf,
    literature_id: LiteratureId,
) -> bool:
    return (
        primary.relation.literature_id == literature_id
        and primary.asset.asset_id == primary.relation.asset_id
        and primary.relation.role is AssetRole.PRIMARY_PDF
        and primary.asset.media_type == "application/pdf"
    )


def _content_is_aligned(
    facts: CurrentLiteratureFacts,
    primary: CurrentPrimaryPdf,
) -> bool:
    content = facts.current_content
    lineage = facts.current_content_lineage
    if content is None or lineage is None:
        return False
    if (
        lineage.primary_asset_id != primary.asset.asset_id
        or lineage.primary_pdf_sha256 != primary.asset.sha256
    ):
        return False
    if content.metadata_revision != facts.metadata_revision:
        return False
    if content.metadata_sha256 != facts.metadata_sha256:
        return False
    expected_input = _analysis_input_sha256(
        primary.asset.sha256,
        lineage.parser_result_sha256,
        facts.metadata_sha256,
    )
    return content.provenance.input_sha256 == expected_input


def derive_status(facts: object) -> LiteratureStatus:
    """Derive ``UNREVIEWED``, ``ASSET_READY`` or ``CONTENT_READY``.

    The function is pure: it reads no status column, files, database or
    parser/LLM state.  A conflicting primary publication is treated as no
    valid current PDF and therefore cannot make a Literature content-ready.
    """

    if not isinstance(facts, CurrentLiteratureFacts):
        raise TypeError("facts must be CurrentLiteratureFacts")
    if len(facts.current_primary_pdfs) != 1:
        return LiteratureStatus.UNREVIEWED
    primary = facts.current_primary_pdfs[0]
    if not _is_valid_primary_for(primary, facts.literature.literature_id):
        return LiteratureStatus.UNREVIEWED
    if _content_is_aligned(facts, primary):
        return LiteratureStatus.CONTENT_READY
    return LiteratureStatus.ASSET_READY


__all__ = (
    "CurrentContentLineage",
    "CurrentLiteratureFacts",
    "CurrentPrimaryPdf",
    "derive_status",
)
