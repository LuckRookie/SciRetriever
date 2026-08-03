from __future__ import annotations

import sciretriever.model.execution as execution_models
import sciretriever.model.literature as literature_models
import sciretriever.model.record as record_models
from sciretriever.model.execution import FailureEvidence


def prepare_import_request(
    record: record_models.ImportedBibliographicRecord,
) -> record_models.ImportPreparationRequest:
    """Convert a parsed bibliography record into the identity request contract."""
    return record_models.ImportPreparationRequest(
        metadata=literature_models.InitialMetadata(
            title=record.title,
            authors=record.authors,
            year=record.year,
            item_type=record.item_type,
            abstract=record.abstract,
            venue=record.venue,
            language=record.language,
            keywords=record.keywords,
        ),
        identifiers=record.identifiers,
        references=record.references,
        tags=record.tags,
    )


def prepare_import_outcome(
    parsed: record_models.RecordParseResult,
    resolution: record_models.ImportIdentityResolution,
) -> record_models.ImportPreparationOutcome:
    """Apply Library import outcome rules to one parsed record and identity result."""
    if resolution.completed:
        return record_models.ImportPreparationOutcome(
            ordinal=parsed.ordinal,
            result=execution_models.ImportResult(
                record_index=parsed.ordinal,
                work_id=str(resolution.work_id),
                work_version_id=resolution.work_version_id,
                outcome="duplicate",
                omissions=(),
                failure=None,
            ),
            work_id=resolution.work_id,
            work_version_id=resolution.work_version_id,
            prepared=None,
            references=(),
            tags=(),
            failure=None,
        )
    return record_models.ImportPreparationOutcome(
        ordinal=parsed.ordinal,
        result=execution_models.ImportResult(
            record_index=parsed.ordinal,
            work_id=str(resolution.work_id),
            work_version_id=resolution.work_version_id,
            outcome=resolution.result,
            omissions=(),
            failure=None,
        ),
        work_id=resolution.work_id,
        work_version_id=resolution.work_version_id,
        prepared=resolution.prepared,
        references=parsed.record.references,
        tags=parsed.record.tags,
        failure=None,
    )


def reject_import_outcome(
    ordinal: int,
    failure: FailureEvidence,
) -> record_models.ImportPreparationOutcome:
    """Create the rejected outcome for a parser failure."""
    return record_models.ImportPreparationOutcome(
        ordinal=ordinal,
        result=execution_models.ImportResult(
            record_index=ordinal,
            work_id=None,
            work_version_id=None,
            outcome="rejected",
            omissions=(),
            failure=failure,
        ),
        work_id=None,
        work_version_id=None,
        prepared=None,
        references=(),
        tags=(),
        failure=failure,
    )


__all__ = ("prepare_import_outcome", "prepare_import_request", "reject_import_outcome")
