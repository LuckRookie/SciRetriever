from __future__ import annotations

import sciretriever.model.record as record_models
from sciretriever.core.library import (
    prepare_import_outcome,
    prepare_import_request,
    reject_import_outcome,
)

from .ports import ImportIdentityPort


def prepare_import_record(
    identity: ImportIdentityPort,
    parsed: record_models.RecordParseResult,
) -> record_models.ImportPreparationOutcome:
    if parsed.failure is not None:
        return reject_import_outcome(parsed.ordinal, parsed.failure)
    resolution = identity.prepare_import(prepare_import_request(parsed.record))
    return prepare_import_outcome(parsed, resolution)


__all__ = ("prepare_import_record",)
