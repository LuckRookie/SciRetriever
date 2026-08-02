from __future__ import annotations

from typing import Protocol

import sciretriever.model.execution as execution_models
import sciretriever.model.literature as literature_models
import sciretriever.model.record as record_models


class ImportIdentityService(Protocol):
    def prepare_import(
        self, request: record_models.ImportPreparationRequest
    ) -> record_models.ImportIdentityResolution: ...


def _request(
    record: record_models.ImportedBibliographicRecord,
) -> record_models.ImportPreparationRequest:
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


def prepare_import_record(
    identity: ImportIdentityService,
    parsed: record_models.RecordParseResult,
) -> record_models.ImportPreparationOutcome:
    if parsed.failure is not None:
        return record_models.ImportPreparationOutcome(
            ordinal=parsed.ordinal,
            result=execution_models.ImportResult(
                record_index=parsed.ordinal,
                work_id=None,
                work_version_id=None,
                outcome="rejected",
                omissions=(),
                failure=parsed.failure,
            ),
            work_id=None,
            work_version_id=None,
            prepared=None,
            references=(),
            tags=(),
            failure=parsed.failure,
        )
    resolution = identity.prepare_import(_request(parsed.record))
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


__all__ = (
    "ImportIdentityService",
    "prepare_import_record",
)
