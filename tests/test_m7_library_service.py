from __future__ import annotations

import unittest
from types import TracebackType

from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.library import ExportCandidate, ExportSelectionRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import BibliographyFormat, WorkId, WorkVersionId
from sciretriever.model.record import (
    ExportEncodingResult,
    ImportedBibliographicRecord,
    ImportIdentityResolution,
    ImportPreparationRequest,
    RecordParseResult,
)
from sciretriever.services.library import (
    AtomicOutputContext,
    AtomicOutputPort,
    BibliographyCodec,
    BinaryInput,
    BinaryOutput,
    ImportIdentityPort,
    LibraryExchangeService,
    LibraryExportSelectionPort,
    prepare_import_record,
)


class RecordingIdentity(ImportIdentityPort):
    def __init__(self) -> None:
        self.request: ImportPreparationRequest | None = None

    def prepare_import(self, request: ImportPreparationRequest) -> ImportIdentityResolution:
        self.request = request
        return ImportIdentityResolution(
            work_id=WorkId("00000000-0000-0000-0000-000000000001"),
            work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000002"),
            result="created",
            completed=False,
            prepared=None,
        )


class RecordingCodec(BibliographyCodec):
    format = BibliographyFormat.RIS

    def __init__(self, parsed: tuple[RecordParseResult, ...] = ()) -> None:
        self.parsed = parsed
        self.records: tuple[ImportedBibliographicRecord, ...] = ()

    def read(self, stream: BinaryInput) -> tuple[RecordParseResult, ...]:
        stream.read()
        return self.parsed

    def write(
        self, records: tuple[ImportedBibliographicRecord, ...], stream: BinaryOutput
    ) -> ExportEncodingResult:
        self.records = records
        bytes_written = stream.write(b"encoded")
        return ExportEncodingResult(
            record_count=len(records), bytes_written=bytes_written, omissions=()
        )


class MemoryStream:
    def __init__(self) -> None:
        self.value = bytearray()

    def read(self, size: int = -1) -> bytes:
        return bytes(self.value if size < 0 else self.value[:size])

    def write(self, value: bytes) -> int:
        self.value.extend(value)
        return len(value)

    def getvalue(self) -> bytes:
        return bytes(self.value)


class RecordingSelection(LibraryExportSelectionPort):
    def __init__(self) -> None:
        self.request: ExportSelectionRequest | None = None

    def select_snapshot(self, request: ExportSelectionRequest) -> tuple[ExportCandidate, ...]:
        self.request = request
        return ()


class RecordingOutputContext(AtomicOutputContext):
    def __init__(self) -> None:
        self.stream = MemoryStream()
        self.published = False

    def __enter__(self) -> BinaryOutput:
        return self.stream

    def publish(self) -> None:
        self.published = True

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None


class RecordingOutput(AtomicOutputPort):
    def __init__(self) -> None:
        self.context = RecordingOutputContext()

    def acquire_output(self) -> RecordingOutputContext:
        return self.context


class M7LibraryServiceTests(unittest.TestCase):
    def test_import_preparation_uses_library_port_and_preserves_exchange_fields(self) -> None:
        identity = RecordingIdentity()
        parsed = RecordParseResult(
            ordinal=4,
            record=ImportedBibliographicRecord(
                title="Imported title",
                authors=("Ada Lovelace",),
                identifiers=(Identifier(namespace="doi", value="10.1000/example"),),
                abstract="Abstract",
                keywords=("keyword",),
                tags=("tag",),
                references=("reference",),
            ),
            failure=None,
        )

        outcome = prepare_import_record(identity, parsed)

        self.assertIsNotNone(identity.request)
        assert identity.request is not None
        self.assertEqual(identity.request.metadata.title, "Imported title")
        self.assertEqual(identity.request.identifiers, parsed.record.identifiers)
        self.assertEqual(outcome.result.outcome, "created")
        self.assertEqual(outcome.references, parsed.record.references)
        self.assertEqual(outcome.tags, parsed.record.tags)
        self.assertEqual(
            outcome.work_version_id,
            WorkVersionId("00000000-0000-0000-0000-000000000002"),
        )

    def test_import_records_preserves_parser_failures_per_record(self) -> None:
        parsed = RecordParseResult(
            ordinal=2,
            record=ImportedBibliographicRecord(
                title="Imported title",
                authors=(),
                identifiers=(),
                abstract=None,
                keywords=(),
                tags=(),
                references=(),
            ),
            failure=None,
        )
        failed = parsed.model_copy(
            update={
                "ordinal": 3,
                "failure": FailureEvidence(
                    code="malformed-record",
                    reason=Reason(value="bad record"),
                    action=Action(value="review input"),
                    retryable=False,
                ),
            }
        )
        identity = RecordingIdentity()
        service = LibraryExchangeService(
            identity,
            RecordingSelection(),
            RecordingOutput(),
        )

        outcomes = service.import_records(RecordingCodec((parsed, failed)), MemoryStream())

        self.assertEqual(tuple(item.result.outcome for item in outcomes), ("created", "rejected"))
        self.assertIsNotNone(outcomes[1].failure)
        assert outcomes[1].failure is not None
        self.assertEqual(outcomes[1].failure.code, "malformed-record")

    def test_export_uses_one_selection_request_and_publishes_atomically(self) -> None:
        selection = RecordingSelection()
        output = RecordingOutput()
        codec = RecordingCodec()
        service = LibraryExchangeService(RecordingIdentity(), selection, output)
        request = ExportSelectionRequest(filters=QueryFilterV1(), all_versions=False)

        result = service.export_records(request, codec)

        self.assertEqual(result.record_count, 0)
        self.assertEqual(selection.request, request)
        self.assertTrue(output.context.published)
        self.assertEqual(output.context.stream.getvalue(), b"encoded")


if __name__ == "__main__":
    unittest.main()
