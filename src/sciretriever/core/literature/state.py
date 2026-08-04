from __future__ import annotations

from typing_extensions import assert_never

from sciretriever.model.literature import VersionFacts
from sciretriever.model.primitives import MissingStep, WorkVersionState


def derive_work_version_state(facts: VersionFacts) -> WorkVersionState:
    primary_ready = facts.accepted_primary_id is not None
    light_ready = bool(
        primary_ready
        and facts.current_light_document_id is not None
        and facts.current_light_sha256 is not None
        and facts.current_light_primary_id == facts.accepted_primary_id
        and facts.current_light_complete
    )
    completion_ready = bool(
        light_ready
        and facts.metadata_snapshot_id is not None
        and facts.metadata_revision is not None
        and facts.metadata_sha256 is not None
        and facts.completion_light_document_id is not None
        and facts.completion_light_document_id == facts.current_light_document_id
        and facts.completion_analysis_artifact_id is not None
        and facts.analysis_light_document_id is not None
        and facts.analysis_light_document_id == facts.current_light_document_id
        and facts.analysis_input_sha256 is not None
        and facts.analysis_input_sha256 == facts.current_light_sha256
        and facts.analysis_nine_categories_complete
        and facts.completion_metadata_snapshot_id is not None
        and facts.completion_metadata_snapshot_id == facts.metadata_snapshot_id
        and facts.completion_reference_set_id is not None
        and facts.completion_reference_set_complete
        and facts.completion_tag_set_id is not None
        and facts.completion_tag_set_complete
    )
    if completion_ready:
        return WorkVersionState.COMPLETED
    if light_ready:
        return WorkVersionState.LIGHT_TEXT_READY
    if primary_ready:
        return WorkVersionState.ASSET_READY
    return WorkVersionState.UNREVIEWED


def derive_missing_step(facts: VersionFacts) -> MissingStep | None:
    match derive_work_version_state(facts):
        case WorkVersionState.UNREVIEWED:
            return MissingStep.PRIMARY_PDF
        case WorkVersionState.ASSET_READY:
            return MissingStep.LIGHT_DOCUMENT
        case WorkVersionState.LIGHT_TEXT_READY:
            return MissingStep.COMPLETION
        case WorkVersionState.COMPLETED:
            return None
        case unreachable:
            assert_never(unreachable)


__all__ = ("derive_missing_step", "derive_work_version_state")
