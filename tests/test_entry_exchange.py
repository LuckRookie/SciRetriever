from __future__ import annotations

import io
import os
import unittest
from collections.abc import Callable, Iterable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO, cast

from sciretriever.entry.exchange import BibliographyCodecs, BibliographyOperations
from sciretriever.entry.ports import (
    BibliographyDecodeResult,
    BibliographyEncodeResult,
    BibliographyFieldOmission,
    BibliographyRecordFailure,
    ExecutionCurrentFacts,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    SelectorSnapshot,
    UserOutputTarget,
)
from sciretriever.literature.api import LiteratureApi, ObservationAcceptanceResult
from sciretriever.literature.content import metadata_sha256
from sciretriever.literature.exchange import observation_from_bibliographic_record
from sciretriever.literature.metadata import MetadataProjectionDecision
from sciretriever.literature.state import CurrentLiteratureFacts
from sciretriever.model.execution import (
    BatchSelector,
    LiteratureSelector,
    QuerySelector,
)
from sciretriever.model.literature import (
    Affiliation,
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.record import BibliographicRecord
from sciretriever.model.report import (
    BibliographyFormat,
    StableFailure,
)
from sciretriever.storage.files.output import AtomicOutput

_TIME = UtcTimestamp("2026-08-12T08:30:00Z")


def _uuid(namespace: int, value: int) -> str:
    return f"{namespace:08x}-0000-4000-8000-{value:012x}"


def _literature_id(value: int) -> LiteratureId:
    return LiteratureId(_uuid(1, value))


def _meta_id(value: int) -> MetaLiteratureId:
    return MetaLiteratureId(_uuid(2, value))


def _failure(code: str = "fixture-record-failed") -> StableFailure:
    return StableFailure(
        code=code,
        reason="The bibliography record could not be converted safely.",
        action="Correct the record and retry the operation.",
        retryable=False,
    )


def _metadata(
    title: str = "A structured literature record",
    *,
    custom_identifier: bool = False,
) -> LiteratureMetadata:
    identifiers = [
        Identifier(namespace="doi", value="https://doi.org/10.1000/Exchange.TEST"),
        Identifier(namespace="arxiv", value="arXiv:2501.01234v2"),
        Identifier(namespace="pmid", value="123456"),
        Identifier(namespace="pmcid", value="pmc654321"),
        Identifier(namespace="isbn", value="978-1-4028-9462-6"),
        Identifier(namespace="issn", value="2049-3630"),
    ]
    if custom_identifier:
        identifiers.append(Identifier(namespace="local-catalog", value="private-42"))
    return LiteratureMetadata(
        title=title,
        authors=(
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                orcid="0000-0002-1825-0097",
                affiliations=(Affiliation(name="Analytical Engine Institute"),),
            ),
            Author(kind=AuthorKind.ORGANIZATION, display_name="Example Consortium"),
        ),
        abstract="A concise abstract.",
        publication_date="2026-08-12",
        publication_year=2026,
        document_type="journal-article",
        language="en",
        venue="Journal of Exchange",
        publisher="Example Press",
        volume="12",
        issue="3",
        pages="e42-e57",
        identifiers=tuple(identifiers),
        keywords=("retrieval", "metadata"),
    )


def _literature(
    value: int,
    meta_value: int,
    *,
    role: VersionRole = VersionRole.PUBLISHED,
    status: LiteratureStatus = LiteratureStatus.UNREVIEWED,
    metadata: LiteratureMetadata | None = None,
) -> Literature:
    return Literature(
        literature_id=_literature_id(value),
        meta_literature_id=_meta_id(meta_value),
        version_role=role,
        metadata=metadata or _metadata(f"Literature {value}"),
        status=status,
    )


def _current(literature: Literature) -> ExecutionCurrentFacts:
    return ExecutionCurrentFacts(
        current=CurrentLiteratureFacts(
            literature=literature,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
        )
    )


class _Clock:
    def now(self) -> UtcTimestamp:
        return _TIME


class _ImportIds:
    def __init__(self) -> None:
        self._observation = 0
        self._provenance = 0

    def new_observation_id(self) -> ObservationId:
        self._observation += 1
        return ObservationId(_uuid(3, self._observation))

    def new_provenance_id(self) -> ProvenanceId:
        self._provenance += 1
        return ProvenanceId(_uuid(4, self._provenance))


class _Lease(AbstractContextManager[None]):
    def __init__(self, events: list[str], failure: BaseException | None = None) -> None:
        self._events = events
        self._failure = failure

    def __enter__(self) -> None:
        self._events.append("admission")
        if self._failure is not None:
            raise self._failure

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        del exc_type, exc_value, traceback
        self._events.append("release")


class _Admission:
    def __init__(self, events: list[str], failure: BaseException | None = None) -> None:
        self._events = events
        self._failure = failure

    def acquire_nowait(self) -> AbstractContextManager[None]:
        return _Lease(self._events, self._failure)


class _Recovery:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        self._events.append("recovery")
        return ()


class _Cancellation:
    def __init__(self) -> None:
        self.cancelled = False

    def is_set(self) -> bool:
        return self.cancelled


class _FakeLiteratureApi(LiteratureApi):
    """Public-boundary fake; Entry never sees Literature private rules."""

    def __init__(
        self,
        decisions: tuple[str, ...] = (),
        *,
        deduplicated: tuple[bool, ...] = (),
        after_accept: Callable[[int], None] | None = None,
    ) -> None:
        self.decisions = decisions
        self.deduplicated = deduplicated
        self.after_accept = after_accept
        self.accepted: list[tuple[BibliographicRecord, ObservationId, Provenance]] = []

    def accept_bibliographic_record(
        self,
        record: BibliographicRecord,
        *,
        observation_id: ObservationId,
        provenance: Provenance,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        self.accepted.append((record, observation_id, provenance))
        index = len(self.accepted) - 1
        del provider_precedence
        decision = self.decisions[index]
        if decision == "raise":
            raise RuntimeError("private database path and diagnostic")
        if self.after_accept is not None:
            self.after_accept(index)
        if decision == "rejected":
            return ObservationAcceptanceResult(
                decision="rejected",
                reason="stable-identifier-conflict",
            )
        if decision not in {"created", "enriched", "matched"}:
            raise AssertionError("unsupported fixture decision")

        meta_value = 1 if index == 0 else 2
        literature = _literature(
            index + 1,
            meta_value,
            status=(
                LiteratureStatus.CONTENT_READY
                if decision == "enriched"
                else LiteratureStatus.UNREVIEWED
            ),
            metadata=record.metadata,
        )
        meta = MetaLiterature(
            meta_literature_id=literature.meta_literature_id,
            representative_literature_id=literature.literature_id,
        )
        observation = observation_from_bibliographic_record(
            record,
            observation_id=observation_id,
            provenance=provenance,
        )
        is_deduplicated = self.deduplicated[index] if index < len(self.deduplicated) else False
        if decision == "enriched":
            projection = MetadataProjectionDecision(
                outcome="preserved",
                metadata=record.metadata,
                metadata_revision=1,
                projection_preserved=True,
                observations_projection_changed=True,
            )
        elif decision == "matched":
            projection = MetadataProjectionDecision(
                outcome="unchanged",
                metadata=record.metadata,
                metadata_revision=1,
            )
        else:
            projection = MetadataProjectionDecision(
                outcome="projected",
                metadata=record.metadata,
                metadata_revision=1,
                changed=True,
                observations_projection_changed=True,
            )
        return ObservationAcceptanceResult(
            decision=cast(str, decision),  # type: ignore[arg-type]
            literature=literature,
            meta_literature=meta,
            observation=observation,
            projection=projection,
            metadata_revision=1,
            deduplicated=is_deduplicated,
        )


class _ForeignSelectionLiteratureApi(_FakeLiteratureApi):
    def __init__(self, foreign: Literature) -> None:
        super().__init__()
        self.foreign = foreign

    def select_export_literatures(
        self,
        meta_literature: MetaLiterature,
        members: Iterable[Literature],
        *,
        all_versions: bool = False,
    ) -> tuple[Literature, ...]:
        del meta_literature, members, all_versions
        return (self.foreign,)


class _SelectorReader:
    def __init__(self, snapshot: SelectorSnapshot) -> None:
        self.snapshot = snapshot
        self.requests: list[BatchSelector] = []

    def read_selector(self, selector: BatchSelector) -> SelectorSnapshot:
        self.requests.append(selector)
        return self.snapshot


class _BufferedAtomicOutput:
    def __init__(
        self,
        *,
        failpoint: Callable[[str], None] | None = None,
        interrupt_on_exit: bool = False,
    ) -> None:
        self.calls: list[tuple[str, bool]] = []
        self.published = 0
        self.aborted = 0
        self._writer = AtomicOutput(max_bytes=1024 * 1024)
        self._failpoint = failpoint
        self._interrupt_on_exit = interrupt_on_exit

    @contextmanager
    def open_atomic(
        self,
        target: UserOutputTarget,
        *,
        overwrite: bool,
    ) -> Iterator[BinaryIO]:
        self.calls.append((os.fspath(target), overwrite))
        staged = io.BytesIO()
        try:
            try:
                yield staged
                if self._interrupt_on_exit:
                    raise KeyboardInterrupt
                self._writer.write(
                    target,
                    staged.getvalue(),
                    overwrite=overwrite,
                    failpoint=self._failpoint,
                )
            except BaseException:
                self.aborted += 1
                raise
            self.published += 1
        finally:
            staged.close()


class _PartialCodec:
    def decode(
        self,
        format: BibliographyFormat,
        source: BinaryIO,
    ) -> BibliographyDecodeResult:
        del format, source
        return BibliographyDecodeResult(items=())

    def encode(
        self,
        format: BibliographyFormat,
        records: tuple[BibliographicRecord, ...],
        destination: BinaryIO,
    ) -> BibliographyEncodeResult:
        del format
        destination.write(b"one complete encoded record\n")
        return BibliographyEncodeResult(
            encoded_record_indexes=(records[0].record_index,),
            failures=(
                BibliographyRecordFailure(
                    record_index=records[1].record_index,
                    failure=_failure(),
                ),
            ),
            omissions=(
                BibliographyFieldOmission(
                    record_index=records[0].record_index,
                    field="authors.affiliations",
                    reason="The selected format cannot express author affiliations.",
                ),
            ),
        )


class _InconsistentCodec(_PartialCodec):
    def encode(
        self,
        format: BibliographyFormat,
        records: tuple[BibliographicRecord, ...],
        destination: BinaryIO,
    ) -> BibliographyEncodeResult:
        del format, records
        destination.write(b"inconsistent staged bytes\n")
        return BibliographyEncodeResult(
            encoded_record_indexes=(999,),
            failures=(),
            omissions=(),
        )


class _DuplicateOmissionCodec(_PartialCodec):
    def encode(
        self,
        format: BibliographyFormat,
        records: tuple[BibliographicRecord, ...],
        destination: BinaryIO,
    ) -> BibliographyEncodeResult:
        del format
        destination.write(b"apparently valid staged bytes\n")
        duplicated = BibliographyFieldOmission(
            record_index=records[0].record_index,
            field="authors.orcid",
            reason="The selected format cannot express author ORCID values.",
        )
        return BibliographyEncodeResult(
            encoded_record_indexes=(records[0].record_index,),
            failures=(),
            omissions=(duplicated, duplicated),
        )


class _UnsafeOmissionCodec(_PartialCodec):
    def encode(
        self,
        format: BibliographyFormat,
        records: tuple[BibliographicRecord, ...],
        destination: BinaryIO,
    ) -> BibliographyEncodeResult:
        del format
        destination.write(b"apparently publishable staged bytes\n")
        return BibliographyEncodeResult(
            encoded_record_indexes=(records[0].record_index,),
            failures=(),
            omissions=(
                BibliographyFieldOmission(
                    record_index=records[0].record_index,
                    field="authors.kind",
                    reason="Inspect file:///private/catalog after RuntimeError: unsafe diagnostic.",
                ),
            ),
        )


def _meta_snapshot(literatures: tuple[Literature, ...]) -> MetaSelectorSnapshot:
    meta_ids = tuple(dict.fromkeys(item.meta_literature_id for item in literatures))
    metas: list[MetaLiterature] = []
    for meta_id in meta_ids:
        members = tuple(item for item in literatures if item.meta_literature_id == meta_id)
        representative = min(
            members,
            key=lambda item: (
                {
                    VersionRole.PUBLISHED: 0,
                    VersionRole.ACCEPTED_MANUSCRIPT: 1,
                    VersionRole.PREPRINT: 2,
                    VersionRole.OTHER: 3,
                }[item.version_role],
                str(item.literature_id),
            ),
        )
        metas.append(
            MetaLiterature(
                meta_literature_id=meta_id,
                representative_literature_id=representative.literature_id,
            )
        )
    return MetaSelectorSnapshot(
        meta_literature_ids=meta_ids,
        meta_literatures=tuple(metas),
        current_facts=tuple(_current(item) for item in literatures),
    )


def _explicit_snapshot(literatures: tuple[Literature, ...]) -> LiteratureSelectorSnapshot:
    return LiteratureSelectorSnapshot(
        literature_ids=tuple(item.literature_id for item in literatures),
        current_facts=tuple(_current(item) for item in literatures),
    )


def _operations(
    *,
    literature: LiteratureApi,
    snapshot: SelectorSnapshot,
    codec: object | None = None,
    output: object | None = None,
    cancel: _Cancellation | None = None,
    admission_failure: BaseException | None = None,
) -> tuple[BibliographyOperations, _SelectorReader, list[str]]:
    events: list[str] = []
    ids = _ImportIds()
    reader = _SelectorReader(snapshot)
    operations = BibliographyOperations(
        literature=literature,
        codec=cast(object, codec or BibliographyCodecs()),  # type: ignore[arg-type]
        output=cast(object, output or _BufferedAtomicOutput()),  # type: ignore[arg-type]
        selector_reader=reader,
        clock=_Clock(),
        write_admission=_Admission(events, admission_failure),
        recovery=_Recovery(events),
        observation_id_factory=ids.new_observation_id,
        provenance_id_factory=ids.new_provenance_id,
        cancel_event=cancel,
    )
    return operations, reader, events


class BibliographyCodecTests(unittest.TestCase):
    def setUp(self) -> None:
        self.codecs = BibliographyCodecs(max_input_bytes=1024 * 1024)

    def test_bibtex_parse_is_per_record_and_preserves_neutral_fields(self) -> None:
        payload = b"""@article{one,
  title={First title},
  author={Lovelace, Ada and {Example Consortium}},
  doi={https://doi.org/10.1000/FIRST},
  date={2026-08-12},
  journaltitle={Journal One},
  publisher={Press One},
  keywords={metadata; retrieval}
}
@article{broken,
  title={Unbalanced title}
@book{three,
  title={Third title},
  isbn={978-1-4028-9462-6},
  year={2024}
}
"""

        result = self.codecs.decode(BibliographyFormat.BIBTEX, io.BytesIO(payload))

        self.assertEqual(tuple(item.record_index for item in result.items), (0, 1, 2))
        first = cast(BibliographicRecord, result.items[0])
        self.assertEqual(first.metadata.title, "First title")
        self.assertEqual(first.metadata.publication_date, "2026-08-12")
        self.assertEqual(first.metadata.publication_year, 2026)
        self.assertEqual(first.metadata.publisher, "Press One")
        self.assertEqual(first.metadata.identifiers[0].value, "10.1000/first")
        self.assertEqual(
            tuple(author.display_name for author in first.metadata.authors),
            ("Lovelace, Ada", "Example Consortium"),
        )
        self.assertIsInstance(result.items[1], BibliographyRecordFailure)
        third = cast(BibliographicRecord, result.items[2])
        self.assertEqual(third.metadata.title, "Third title")

    def test_ris_parse_is_per_record_and_does_not_treat_accession_as_identity(self) -> None:
        payload = b"""TY  - JOUR
TI  - First RIS title
AU  - Lovelace, Ada
DO  - 10.1000/ris
AN  - provider-private-record
PY  - 2026
PB  - RIS Press
ER  -

TY  - JOUR
TI  - Missing terminator

TY  - BOOK
TI  - Third RIS title
SN  - 978-1-4028-9462-6
ER  -
"""

        result = self.codecs.decode(BibliographyFormat.RIS, io.BytesIO(payload))

        self.assertEqual(tuple(item.record_index for item in result.items), (0, 1, 2))
        first = cast(BibliographicRecord, result.items[0])
        self.assertEqual(first.metadata.title, "First RIS title")
        self.assertEqual(first.metadata.publisher, "RIS Press")
        self.assertEqual(
            tuple((item.namespace, item.value) for item in first.metadata.identifiers),
            (("doi", "10.1000/ris"),),
        )
        self.assertIsInstance(result.items[1], BibliographyRecordFailure)
        self.assertEqual(
            cast(BibliographicRecord, result.items[2]).metadata.title, "Third RIS title"
        )

    def test_csl_json_parse_is_per_record_and_keeps_structured_authors(self) -> None:
        payload = b"""[
  {"title":"First CSL title","type":"article-journal","DOI":"10.1000/csl",
   "author":[{"given":"Ada","family":"Lovelace","ORCID":"0000-0002-1825-0097",
              "affiliation":[{"name":"Engine Institute"}]}],
   "issued":{"date-parts":[[2026,8,12]]},"publisher":"CSL Press"},
  42,
  {"title":"Third CSL title","type":"book"}
]"""

        result = self.codecs.decode(BibliographyFormat.CSL_JSON, io.BytesIO(payload))

        self.assertEqual(tuple(item.record_index for item in result.items), (0, 1, 2))
        first = cast(BibliographicRecord, result.items[0])
        self.assertEqual(first.metadata.publication_date, "2026-08-12")
        self.assertEqual(first.metadata.authors[0].given_name, "Ada")
        self.assertEqual(first.metadata.authors[0].family_name, "Lovelace")
        self.assertEqual(first.metadata.authors[0].affiliations[0].name, "Engine Institute")
        self.assertIsInstance(result.items[1], BibliographyRecordFailure)
        self.assertEqual(
            cast(BibliographicRecord, result.items[2]).metadata.title, "Third CSL title"
        )

    def test_each_format_encodes_individual_records_and_reports_field_omissions(self) -> None:
        records = (
            BibliographicRecord(record_index=0, metadata=_metadata(custom_identifier=True)),
            BibliographicRecord(record_index=1, metadata=_metadata("Second record")),
        )

        for format in BibliographyFormat:
            with self.subTest(format=format.value):
                destination = io.BytesIO()
                encoded = self.codecs.encode(format, records, destination)

                self.assertEqual(encoded.encoded_record_indexes, (0, 1))
                self.assertEqual(encoded.failures, ())
                self.assertTrue(destination.getvalue())
                self.assertTrue(
                    any(item.field.startswith("identifiers") for item in encoded.omissions)
                )
                if format is not BibliographyFormat.CSL_JSON:
                    self.assertTrue(
                        any(item.field == "authors.orcid" for item in encoded.omissions)
                    )
                    self.assertTrue(
                        any(item.field == "authors.affiliations" for item in encoded.omissions)
                    )

                decoded = self.codecs.decode(format, io.BytesIO(destination.getvalue()))
                self.assertEqual(len(decoded.items), 2)
                first = cast(BibliographicRecord, decoded.items[0])
                self.assertEqual(first.metadata.title, records[0].metadata.title)
                self.assertEqual(first.metadata.publication_year, 2026)
                self.assertEqual(first.metadata.publisher, "Example Press")
                self.assertIn(
                    Identifier(namespace="doi", value="10.1000/exchange.test"),
                    first.metadata.identifiers,
                )

    def test_unpaired_surrogate_is_an_individual_encode_failure_in_every_format(self) -> None:
        records = (
            BibliographicRecord(
                record_index=0,
                metadata=LiteratureMetadata(title="\ud800"),
            ),
            BibliographicRecord(
                record_index=1,
                metadata=LiteratureMetadata(title="Valid scalar text"),
            ),
        )

        for format in BibliographyFormat:
            with self.subTest(format=format.value):
                destination = io.BytesIO()
                encoded = self.codecs.encode(format, records, destination)

                self.assertEqual(encoded.encoded_record_indexes, (1,))
                self.assertEqual(tuple(item.record_index for item in encoded.failures), (0,))
                destination.getvalue().decode("utf-8", errors="strict")

    def test_csl_valid_surrogate_pair_is_materialized_as_one_unicode_scalar(self) -> None:
        result = self.codecs.decode(
            BibliographyFormat.CSL_JSON,
            io.BytesIO(rb'{"title":"Smile \ud83d\ude00"}'),
        )

        record = cast(BibliographicRecord, result.items[0])
        self.assertEqual(record.metadata.title, "Smile \U0001f600")

    def test_ris_reports_author_kind_loss_and_preserves_author_order(self) -> None:
        record = BibliographicRecord(
            record_index=0,
            metadata=LiteratureMetadata(
                title="RIS author kinds",
                authors=(
                    Author(
                        kind=AuthorKind.ORGANIZATION,
                        display_name="Example Consortium",
                    ),
                    Author(
                        kind=AuthorKind.PERSON,
                        display_name="Ada Lovelace",
                        given_name="Ada",
                        family_name="Lovelace",
                    ),
                ),
            ),
        )
        destination = io.BytesIO()

        encoded = self.codecs.encode(BibliographyFormat.RIS, (record,), destination)
        decoded = self.codecs.decode(
            BibliographyFormat.RIS,
            io.BytesIO(destination.getvalue()),
        )

        self.assertEqual(tuple(item.field for item in encoded.omissions), ("authors.kind",))
        decoded_record = cast(BibliographicRecord, decoded.items[0])
        self.assertEqual(
            tuple(author.display_name for author in decoded_record.metadata.authors),
            ("Example Consortium", "Lovelace, Ada"),
        )
        self.assertEqual(
            tuple(author.kind for author in decoded_record.metadata.authors),
            (AuthorKind.UNKNOWN, AuthorKind.PERSON),
        )

    def test_invalid_document_bytes_become_stable_redacted_record_failure(self) -> None:
        for format, payload in (
            (BibliographyFormat.BIBTEX, b"not bibliography"),
            (BibliographyFormat.RIS, b"not RIS"),
            (BibliographyFormat.CSL_JSON, b"{not json"),
        ):
            with self.subTest(format=format.value):
                result = self.codecs.decode(format, io.BytesIO(payload))
                self.assertEqual(len(result.items), 1)
                failure = cast(BibliographyRecordFailure, result.items[0]).failure
                self.assertNotIn("not bibliography", repr(failure))
                self.assertNotIn("not RIS", repr(failure))
                self.assertNotIn("{not json", repr(failure))


class BibliographyImportOperationTests(unittest.TestCase):
    def test_import_maps_all_literature_outcomes_and_never_filters_duplicate_records(self) -> None:
        literature = _FakeLiteratureApi(
            ("created", "enriched", "matched", "matched", "rejected"),
            deduplicated=(False, False, False, True, False),
        )
        operations, _reader, events = _operations(
            literature=literature,
            snapshot=_meta_snapshot((_literature(90, 90),)),
        )
        source = io.BytesIO(
            b"["
            b'{"title":"Created","DOI":"10.1000/created"},'
            b'{"title":"Enriched","DOI":"10.1000/shared"},'
            b'{"title":"Provider-equal","DOI":"10.1000/shared"},'
            b'{"title":"Provider-equal","DOI":"10.1000/shared"},'
            b'{"title":"Conflict","DOI":"10.1000/shared","PMID":"999"}'
            b"]"
        )

        report = operations.import_bibliography(BibliographyFormat.CSL_JSON, source)

        self.assertEqual(report.end.kind, "finished")
        self.assertEqual(report.input_record_count, 5)
        self.assertEqual(
            tuple(getattr(item, "outcome", "rejected") for item in report.records),
            ("created", "enriched", "matched", "matched", "rejected"),
        )
        self.assertEqual(report.not_processed_record_indexes, ())
        self.assertEqual(report.accepted_meta_literature_ids, (_meta_id(1), _meta_id(2)))
        self.assertEqual(len(literature.accepted), 5)
        self.assertEqual(events, ["admission", "recovery", "release"])
        self.assertEqual(len({str(item[1]) for item in literature.accepted}), 5)
        self.assertEqual(len({str(item[2].provenance_id) for item in literature.accepted}), 5)
        for _record, _observation_id, provenance in literature.accepted:
            self.assertIs(provenance.source_kind, SourceKind.USER)
            self.assertEqual(provenance.source_name, "bibliographic-import")
            self.assertIsNone(provenance.source_record_id)
            self.assertIsNone(provenance.input_sha256)
            self.assertIsNone(provenance.parameters_sha256)
            self.assertEqual(provenance.observed_at, _TIME)

    def test_single_format_error_does_not_rollback_other_records(self) -> None:
        literature = _FakeLiteratureApi(("created", "created"))
        operations, _reader, _events = _operations(
            literature=literature,
            snapshot=_meta_snapshot((_literature(90, 90),)),
        )
        source = io.BytesIO(b'[{"title":"One"},42,{"title":"Three","DOI":"10.1000/three"}]')

        report = operations.import_bibliography(BibliographyFormat.CSL_JSON, source)

        self.assertEqual(report.end.kind, "finished")
        self.assertEqual(tuple(item.record_index for item in report.records), (0, 1, 2))
        self.assertEqual(report.records[1].kind, "rejected")
        self.assertEqual(tuple(item[0].record_index for item in literature.accepted), (0, 2))
        self.assertEqual(len(report.accepted_meta_literature_ids), 2)

    def test_csl_duplicate_key_failure_is_local_to_its_top_level_record(self) -> None:
        bad_records = (
            b'{"title":"Bad","title":"Duplicate"}',
            b'{"title":"Bad","author":[{"literal":"One","literal":"Two"}]}',
        )
        for bad_record in bad_records:
            with self.subTest(bad_record=bad_record):
                literature = _FakeLiteratureApi(("created", "created"))
                operations, _reader, events = _operations(
                    literature=literature,
                    snapshot=_meta_snapshot((_literature(90, 90),)),
                )
                source = io.BytesIO(b'[{"title":"First"},' + bad_record + b',{"title":"Third"}]')

                report = operations.import_bibliography(BibliographyFormat.CSL_JSON, source)

                self.assertEqual(report.end.kind, "finished")
                self.assertEqual(report.input_record_count, 3)
                self.assertEqual(tuple(item.record_index for item in report.records), (0, 1, 2))
                self.assertEqual(
                    tuple(item.kind for item in report.records),
                    ("accepted", "rejected", "accepted"),
                )
                self.assertEqual(report.not_processed_record_indexes, ())
                self.assertEqual(
                    tuple(item[0].record_index for item in literature.accepted),
                    (0, 2),
                )
                self.assertEqual(events, ["admission", "recovery", "release"])

    def test_csl_unpaired_surrogate_failure_keeps_the_following_good_record(self) -> None:
        literature = _FakeLiteratureApi(("created",))
        operations, _reader, _events = _operations(
            literature=literature,
            snapshot=_meta_snapshot((_literature(90, 90),)),
        )

        report = operations.import_bibliography(
            BibliographyFormat.CSL_JSON,
            io.BytesIO(rb'[{"title":"\ud800"},{"title":"Good scalar text"}]'),
        )

        self.assertEqual(report.end.kind, "finished")
        self.assertEqual(report.input_record_count, 2)
        self.assertEqual(tuple(item.kind for item in report.records), ("rejected", "accepted"))
        self.assertEqual(tuple(item[0].record_index for item in literature.accepted), (1,))
        self.assertEqual(report.not_processed_record_indexes, ())

    def test_controlled_interruption_keeps_completed_results_and_partitions_the_rest(self) -> None:
        cancel = _Cancellation()

        def stop_after_first(index: int) -> None:
            if index == 0:
                cancel.cancelled = True

        literature = _FakeLiteratureApi(
            ("created", "created", "created"),
            after_accept=stop_after_first,
        )
        operations, _reader, _events = _operations(
            literature=literature,
            snapshot=_meta_snapshot((_literature(90, 90),)),
            cancel=cancel,
        )

        report = operations.import_bibliography(
            BibliographyFormat.CSL_JSON,
            io.BytesIO(b'[{"title":"One"},{"title":"Two"},{"title":"Three"}]'),
        )

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(tuple(item.record_index for item in report.records), (0,))
        self.assertEqual(report.not_processed_record_indexes, (1, 2))
        self.assertEqual(report.accepted_meta_literature_ids, (_meta_id(1),))

    def test_operation_failure_is_redacted_and_keeps_prior_atomic_acceptance(self) -> None:
        literature = _FakeLiteratureApi(("created", "raise", "created"))
        operations, _reader, _events = _operations(
            literature=literature,
            snapshot=_meta_snapshot((_literature(90, 90),)),
        )

        report = operations.import_bibliography(
            BibliographyFormat.CSL_JSON,
            io.BytesIO(b'[{"title":"One"},{"title":"Two"},{"title":"Three"}]'),
        )

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(tuple(item.record_index for item in report.records), (0,))
        self.assertEqual(report.not_processed_record_indexes, (1, 2))
        self.assertNotIn("private database", repr(report))


class BibliographyExportOperationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-entry-exchange-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)

    def test_default_scope_exports_metadata_only_representatives_atomically(self) -> None:
        representative = _literature(
            1,
            1,
            role=VersionRole.PUBLISHED,
            status=LiteratureStatus.UNREVIEWED,
        )
        content_ready_preprint = _literature(
            2,
            1,
            role=VersionRole.PREPRINT,
            status=LiteratureStatus.CONTENT_READY,
        )
        output = _BufferedAtomicOutput()
        operations, reader, _events = _operations(
            literature=_FakeLiteratureApi(),
            snapshot=_meta_snapshot((content_ready_preprint, representative)),
            output=output,
        )
        target = self.root / "library.json"

        report = operations.export_bibliography(
            BibliographyFormat.CSL_JSON,
            None,
            target,
        )

        self.assertEqual(report.end.kind, "finished")
        self.assertEqual(report.selected_literature_ids, (representative.literature_id,))
        self.assertEqual(report.published_literature_ids, (representative.literature_id,))
        self.assertEqual(report.not_published_literature_ids, ())
        self.assertEqual(report.bytes_written, len(target.read_bytes()))
        self.assertEqual(output.published, 1)
        self.assertIsInstance(reader.requests[0], QuerySelector)
        self.assertEqual(
            cast(QuerySelector, reader.requests[0]).query.model_dump(),
            {
                "text": None,
                "title": None,
                "author": None,
                "author_orcids": (),
                "identifiers": (),
                "publication_year_from": None,
                "publication_year_to": None,
                "venue": None,
                "publisher": None,
                "document_types": (),
                "languages": (),
                "keywords": (),
                "version_roles": (),
                "statuses": (),
                "missing_steps": (),
                "needs_manual_pdf": None,
                "discovery_run_ids": (),
            },
        )

    def test_explicit_literatures_preserve_order_and_map_skips_and_omissions(self) -> None:
        first = _literature(1, 1)
        second = _literature(2, 2)
        output = _BufferedAtomicOutput()
        operations, _reader, _events = _operations(
            literature=_FakeLiteratureApi(),
            snapshot=_explicit_snapshot((second, first)),
            codec=_PartialCodec(),
            output=output,
        )
        target = self.root / "selected.ris"

        report = operations.export_bibliography(
            BibliographyFormat.RIS,
            LiteratureSelector(
                kind="literatures",
                literature_ids=(second.literature_id, first.literature_id),
            ),
            target,
        )

        self.assertEqual(
            report.selected_literature_ids,
            (second.literature_id, first.literature_id),
        )
        self.assertEqual(report.published_literature_ids, (second.literature_id,))
        self.assertEqual(
            tuple(item.literature_id for item in report.skipped), (first.literature_id,)
        )
        self.assertEqual(report.omissions[0].literature_id, second.literature_id)
        self.assertEqual(report.bytes_written, len(target.read_bytes()))

    def test_representative_selection_cannot_escape_the_frozen_snapshot(self) -> None:
        literature = _literature(1, 1)
        foreign = _literature(2, 2)
        output = _BufferedAtomicOutput()
        operations, _reader, _events = _operations(
            literature=_ForeignSelectionLiteratureApi(foreign),
            snapshot=_meta_snapshot((literature,)),
            output=output,
        )
        target = self.root / "escaped.json"

        report = operations.export_bibliography(
            BibliographyFormat.CSL_JSON,
            None,
            target,
        )

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(report.selected_literature_ids, ())
        self.assertFalse(target.exists())
        self.assertEqual(output.calls, [])

    def test_inconsistent_codec_result_aborts_without_a_secondary_report_failure(self) -> None:
        literature = _literature(1, 1)
        target = self.root / "existing.ris"
        old = b"old complete bibliography\n"
        target.write_bytes(old)
        os.chmod(target, 0o600)
        output = _BufferedAtomicOutput()
        operations, _reader, _events = _operations(
            literature=_FakeLiteratureApi(),
            snapshot=_meta_snapshot((literature,)),
            codec=_InconsistentCodec(),
            output=output,
        )

        report = operations.export_bibliography(
            BibliographyFormat.RIS,
            None,
            target,
            overwrite=True,
        )

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(report.published_literature_ids, ())
        self.assertEqual(report.not_published_literature_ids, (literature.literature_id,))
        self.assertEqual(report.skipped, ())
        self.assertIsNone(report.bytes_written)
        self.assertEqual(target.read_bytes(), old)
        self.assertEqual(output.published, 0)
        self.assertEqual(output.aborted, 1)

    def test_duplicate_codec_omissions_abort_before_atomic_publication(self) -> None:
        literature = _literature(1, 1)
        target = self.root / "existing.ris"
        old = b"old complete bibliography\n"
        target.write_bytes(old)
        os.chmod(target, 0o600)
        output = _BufferedAtomicOutput()
        operations, _reader, _events = _operations(
            literature=_FakeLiteratureApi(),
            snapshot=_meta_snapshot((literature,)),
            codec=_DuplicateOmissionCodec(),
            output=output,
        )

        report = operations.export_bibliography(
            BibliographyFormat.RIS,
            None,
            target,
            overwrite=True,
        )

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(report.published_literature_ids, ())
        self.assertEqual(report.not_published_literature_ids, (literature.literature_id,))
        self.assertEqual(report.omissions, ())
        self.assertEqual(target.read_bytes(), old)
        self.assertEqual(output.published, 0)
        self.assertEqual(output.aborted, 1)

    def test_unsafe_omission_is_validated_before_real_atomic_overwrite(self) -> None:
        literature = _literature(1, 1)
        target = self.root / "existing.ris"
        old = b"old complete bibliography\n"
        target.write_bytes(old)
        os.chmod(target, 0o600)
        output = _BufferedAtomicOutput()
        operations, _reader, _events = _operations(
            literature=_FakeLiteratureApi(),
            snapshot=_meta_snapshot((literature,)),
            codec=_UnsafeOmissionCodec(),
            output=output,
        )

        report = operations.export_bibliography(
            BibliographyFormat.RIS,
            None,
            target,
            overwrite=True,
        )

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(report.published_literature_ids, ())
        self.assertEqual(report.not_published_literature_ids, (literature.literature_id,))
        self.assertEqual(report.omissions, ())
        self.assertEqual(target.read_bytes(), old)
        self.assertEqual(output.published, 0)
        self.assertEqual(output.aborted, 1)
        self.assertNotIn("file://", repr(report))

    def test_publication_failure_keeps_old_target_and_never_claims_success(self) -> None:
        literature = _literature(1, 1, metadata=_metadata(custom_identifier=True))
        target = self.root / "existing.bib"
        old = b"old complete bibliography\n"
        target.write_bytes(old)
        os.chmod(target, 0o600)

        def fail_before_publish(name: str) -> None:
            if name == "before-publish":
                raise RuntimeError("private staging failure")

        output = _BufferedAtomicOutput(failpoint=fail_before_publish)
        operations, _reader, _events = _operations(
            literature=_FakeLiteratureApi(),
            snapshot=_meta_snapshot((literature,)),
            output=output,
        )

        report = operations.export_bibliography(
            BibliographyFormat.BIBTEX,
            None,
            target,
            overwrite=True,
        )

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(report.published_literature_ids, ())
        self.assertEqual(report.not_published_literature_ids, (literature.literature_id,))
        self.assertIsNone(report.bytes_written)
        self.assertEqual(target.read_bytes(), old)
        self.assertEqual(output.published, 0)
        self.assertEqual(output.aborted, 1)
        self.assertNotIn("private staging", repr(report))

    def test_publication_interruption_keeps_old_target_and_marks_all_encoded_objects_unpublished(
        self,
    ) -> None:
        literature = _literature(1, 1)
        target = self.root / "existing.json"
        old = b"old complete bibliography\n"
        target.write_bytes(old)
        os.chmod(target, 0o600)
        output = _BufferedAtomicOutput(interrupt_on_exit=True)
        operations, _reader, _events = _operations(
            literature=_FakeLiteratureApi(),
            snapshot=_meta_snapshot((literature,)),
            output=output,
        )

        report = operations.export_bibliography(
            BibliographyFormat.CSL_JSON,
            None,
            target,
            overwrite=True,
        )

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(report.published_literature_ids, ())
        self.assertEqual(report.not_published_literature_ids, (literature.literature_id,))
        self.assertIsNone(report.bytes_written)
        self.assertEqual(target.read_bytes(), old)
        self.assertEqual(output.published, 0)


if __name__ == "__main__":
    unittest.main()
