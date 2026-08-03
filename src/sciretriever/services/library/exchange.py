from __future__ import annotations

import sciretriever.model.record as record_models
from sciretriever.core.library import (
    export_eligible,
    prepare_export_record,
    select_export_candidates,
)
from sciretriever.model.library import ExportSelectionRequest

from .import_preparation import prepare_import_record
from .ports import (
    AtomicOutputPort,
    BibliographyCodec,
    BinaryInput,
    ImportIdentityPort,
    LibraryExportSelectionPort,
)


class LibraryExchangeService:
    def __init__(
        self,
        identity: ImportIdentityPort,
        selection: LibraryExportSelectionPort,
        output: AtomicOutputPort,
    ) -> None:
        self._identity = identity
        self._selection = selection
        self._output = output

    def import_records(
        self, codec: BibliographyCodec, stream: BinaryInput
    ) -> tuple[record_models.ImportPreparationOutcome, ...]:
        parsed = codec.read(stream)
        return tuple(prepare_import_record(self._identity, item) for item in parsed)

    def export_records(
        self, request: ExportSelectionRequest, codec: BibliographyCodec
    ) -> record_models.ExportEncodingResult:
        candidates = select_export_candidates(
            self._selection.select_snapshot(request), request.all_versions
        )
        prepared = tuple(
            prepare_export_record(candidate)
            for candidate in candidates
            if export_eligible(candidate)
        )
        records = tuple(item.record for item in prepared)
        omissions = tuple(omission for item in prepared for omission in item.omissions)
        context = self._output.acquire_output()
        with context as stream:
            encoded = codec.write(records, stream)
            result = encoded.model_copy(update={"omissions": encoded.omissions + omissions})
            context.publish()
        return result


__all__ = ("LibraryExchangeService",)
