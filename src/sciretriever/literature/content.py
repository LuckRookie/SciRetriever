"""Literature-owned final content acceptance decisions.

Analysis forms one neutral ``LiteratureContentProposal`` without an output
revision or final ``LiteratureContent``.  This module does not call Analysis,
read artifacts, write SQL, publish files, render Markdown, or retain a draft.
It rechecks the current Literature facts, assigns the next authoritative
metadata revision, and returns one immutable decision for Storage to publish
in one transaction.

The neutral Model already owns the closed section/content contract.  The code
here only adds the Literature boundary: concrete Literature identity, the
unique current primary PDF, current ParserResult, metadata revision/hash,
analysis input lineage, and the already-rendered Markdown artifact descriptor.
"""

from __future__ import annotations

import json
from typing import Literal, TypeAlias, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sciretriever.literature.state import (
    CurrentLiteratureFacts,
    derive_status,
)
from sciretriever.model.acquisition import AssetRole
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureContentProposal,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.literature import LiteratureStatus
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import LiteratureId, Sha256, SourceKind, sha256_digest
from sciretriever.model.provenance import Provenance


class _ContentDecisionModel(BaseModel):
    """Closed, immutable, strict contracts local to content acceptance."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


ContentAcceptanceReason: TypeAlias = Literal[
    "literature-mismatch",
    "primary-pdf-missing",
    "primary-pdf-publication-conflict",
    "primary-pdf-mismatch",
    "parser-result-missing",
    "parser-result-mismatch",
    "metadata-revision-stale",
    "metadata-hash-stale",
    "metadata-not-admissible",
    "content-metadata-mismatch",
    "content-hash-mismatch",
    "content-provenance-mismatch",
    "markdown-artifact-mismatch",
]


class ContentAcceptanceReplacement(_ContentDecisionModel):
    """The complete current view that a successful decision replaces."""

    literature_id: LiteratureId
    metadata: LiteratureMetadata
    metadata_revision: int = Field(strict=True, ge=1)
    metadata_sha256: Sha256
    content: LiteratureContent

    @model_validator(mode="after")
    def validate_whole_view(self) -> "ContentAcceptanceReplacement":
        if self.content.metadata_revision != self.metadata_revision:
            raise ValueError("replacement revision must match content revision")
        if self.content.metadata_sha256 != self.metadata_sha256:
            raise ValueError("replacement metadata hash must match content")
        return self


class ContentAcceptanceDecision(_ContentDecisionModel):
    """A pure accepted replacement or a stable fail-closed rejection."""

    decision: Literal["accepted", "rejected"]
    literature_id: LiteratureId
    status: LiteratureStatus
    replacement: ContentAcceptanceReplacement | None = None
    reason: ContentAcceptanceReason | None = None
    old_content_sha256_to_cleanup: Sha256 | None = None

    @model_validator(mode="after")
    def validate_decision_pairing(self) -> "ContentAcceptanceDecision":
        if self.decision == "accepted":
            if self.replacement is None or self.reason is not None:
                raise ValueError("accepted decision requires a replacement and no reason")
            if self.status is not LiteratureStatus.CONTENT_READY:
                raise ValueError("accepted content must be CONTENT_READY")
        elif self.replacement is not None or self.reason is None:
            raise ValueError("rejected decision requires a reason and no replacement")
        return self


def metadata_sha256(metadata: object) -> Sha256:
    """Hash one complete ``LiteratureMetadata`` using stable JSON ordering."""

    if not isinstance(metadata, LiteratureMetadata):
        raise TypeError("metadata must be LiteratureMetadata")
    payload = metadata.model_dump(mode="json")
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


def canonical_literature_content_json(content: object) -> bytes:
    """Serialize one accepted structured LiteratureContent deterministically.

    These bytes are the ArtifactStore representation of the complete current
    structured content.  SQLite keeps only their descriptor/binding plus the
    small reference-text/FTS projections required by the accepted Storage
    design; it must not create section or subsection tables.
    """

    if not isinstance(content, LiteratureContent):
        raise TypeError("content must be LiteratureContent")
    payload = content.model_dump(mode="json")
    serialized = json.dumps(
        payload,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return serialized.encode("utf-8")


def literature_content_artifact(content: LiteratureContent) -> ArtifactRef:
    """Return the descriptor for canonical structured LiteratureContent bytes."""

    serialized = canonical_literature_content_json(content)
    return ArtifactRef(
        sha256=sha256_digest(serialized),
        media_type="application/json",
        byte_size=len(serialized),
    )


def _reject(
    facts: CurrentLiteratureFacts,
    proposal: LiteratureContentProposal,
    reason: ContentAcceptanceReason,
) -> ContentAcceptanceDecision:
    return ContentAcceptanceDecision(
        decision="rejected",
        literature_id=proposal.literature_id,
        status=derive_status(facts),
        reason=reason,
    )


def decide_content_acceptance(  # noqa: C901
    facts: object,
    proposal: object,
) -> ContentAcceptanceDecision:
    """Return one complete replacement decision or a stable rejection.

    This function performs no publication.  A caller can safely retry a
    rejected decision after rereading current facts; no old current metadata,
    content or support is represented as changed on the rejected path.
    """

    if not isinstance(facts, CurrentLiteratureFacts):
        raise TypeError("facts must be CurrentLiteratureFacts")
    if not isinstance(proposal, LiteratureContentProposal):
        raise TypeError("proposal must be LiteratureContentProposal")

    if proposal.literature_id != facts.literature.literature_id:
        return _reject(facts, proposal, "literature-mismatch")
    if not facts.current_primary_pdfs:
        return _reject(facts, proposal, "primary-pdf-missing")
    if len(facts.current_primary_pdfs) != 1:
        return _reject(facts, proposal, "primary-pdf-publication-conflict")
    primary = facts.current_primary_pdfs[0]
    if (
        primary.relation.literature_id != facts.literature.literature_id
        or primary.relation.role is not AssetRole.PRIMARY_PDF
        or primary.relation.asset_id != primary.asset.asset_id
        or primary.asset.media_type != "application/pdf"
    ):
        return _reject(facts, proposal, "primary-pdf-publication-conflict")
    if (
        proposal.primary_asset_id != primary.asset.asset_id
        or proposal.primary_pdf_sha256 != primary.asset.sha256
    ):
        return _reject(facts, proposal, "primary-pdf-mismatch")

    parser = facts.current_parser_result
    if parser is None:
        return _reject(facts, proposal, "parser-result-missing")
    if (
        parser.source_asset_id != primary.asset.asset_id
        or parser.source_sha256 != primary.asset.sha256
        or parser.result_sha256 != proposal.parser_result_sha256
    ):
        return _reject(facts, proposal, "parser-result-mismatch")

    if proposal.input_metadata_revision != facts.metadata_revision:
        return _reject(facts, proposal, "metadata-revision-stale")
    if proposal.input_metadata_sha256 != facts.metadata_sha256:
        return _reject(facts, proposal, "metadata-hash-stale")

    final_metadata = cast(object, proposal.final_metadata)
    if not isinstance(final_metadata, LiteratureMetadata):
        return _reject(facts, proposal, "metadata-not-admissible")
    if final_metadata.title is None and not any(
        identifier.namespace == "doi" for identifier in final_metadata.identifiers
    ):
        return _reject(facts, proposal, "metadata-not-admissible")

    try:
        expected_metadata_hash = metadata_sha256(final_metadata)
    except (UnicodeError, TypeError, ValueError):
        return _reject(facts, proposal, "content-metadata-mismatch")
    if proposal.metadata_sha256 != expected_metadata_hash:
        return _reject(facts, proposal, "content-metadata-mismatch")

    try:
        expected_content_hash = content_sha256(
            metadata_sha256=proposal.metadata_sha256,
            sections=proposal.sections,
            references=proposal.references,
        )
    except (UnicodeError, TypeError, ValueError):
        return _reject(facts, proposal, "content-hash-mismatch")
    if proposal.literature_content_sha256 != expected_content_hash:
        return _reject(facts, proposal, "content-hash-mismatch")

    expected_input = analysis_input_sha256(
        primary.asset.sha256,
        parser.result_sha256,
        expected_metadata_hash,
    )
    provenance = cast(object, proposal.provenance)
    if (
        not isinstance(provenance, Provenance)
        or provenance.source_kind is not SourceKind.ANALYSIS
        or provenance.source_record_id is not None
        or provenance.input_sha256 != expected_input
        or provenance.parameters_sha256 is None
    ):
        return _reject(facts, proposal, "content-provenance-mismatch")

    markdown = cast(object, proposal.markdown)
    if (
        not isinstance(markdown, ArtifactRef)
        or markdown.media_type != "text/markdown"
        or markdown.byte_size <= 0
    ):
        return _reject(facts, proposal, "markdown-artifact-mismatch")

    next_revision = facts.metadata_revision + 1
    try:
        content = LiteratureContent(
            literature_content_sha256=proposal.literature_content_sha256,
            metadata_revision=next_revision,
            metadata_sha256=proposal.metadata_sha256,
            sections=proposal.sections,
            references=proposal.references,
            markdown=markdown,
            provenance=provenance,
        )
    except (TypeError, ValueError):
        return _reject(facts, proposal, "content-hash-mismatch")
    replacement = ContentAcceptanceReplacement(
        literature_id=proposal.literature_id,
        metadata=final_metadata,
        metadata_revision=next_revision,
        metadata_sha256=proposal.metadata_sha256,
        content=content,
    )
    old_content_sha256 = None
    if facts.current_content is not None:
        old_hash = facts.current_content.literature_content_sha256
        if old_hash != content.literature_content_sha256:
            old_content_sha256 = old_hash
    return ContentAcceptanceDecision(
        decision="accepted",
        literature_id=proposal.literature_id,
        status=LiteratureStatus.CONTENT_READY,
        replacement=replacement,
        old_content_sha256_to_cleanup=old_content_sha256,
    )


__all__ = (
    "ContentAcceptanceDecision",
    "ContentAcceptanceReason",
    "ContentAcceptanceReplacement",
    "canonical_literature_content_json",
    "decide_content_acceptance",
    "literature_content_artifact",
    "metadata_sha256",
)
