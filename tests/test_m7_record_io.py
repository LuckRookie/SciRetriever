from __future__ import annotations

import stat
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.infrastructure.io import (
    AtomicFileOutputPort,
    AtomicOutputSecurityError,
    BibtexCodec,
    CslJsonCodec,
    RisCodec,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.record import ImportedBibliographicRecord


class _WriteFailure(RuntimeError):
    pass


class M7RecordIoTests(unittest.TestCase):
    @staticmethod
    def record(*, custom_identifier: bool = False) -> ImportedBibliographicRecord:
        identifiers = (
            Identifier(namespace="doi", value="10.1000/example"),
            Identifier(namespace="pmid", value="42"),
            Identifier(namespace="pmcid", value="PMC42"),
            Identifier(namespace="arxiv", value="2401.12345"),
            Identifier(namespace="isbn", value="978-0-00-000000-0"),
            Identifier(namespace="issn", value="1234-5678"),
        )
        if custom_identifier:
            identifiers += (Identifier(namespace="handle", value="hdl:20.5000/example"),)
        return ImportedBibliographicRecord(
            title="A deterministic title",
            authors=("Lovelace, Ada", "Hopper, Grace"),
            identifiers=identifiers,
            abstract="A short abstract.",
            keywords=("alpha", "beta"),
            tags=("review", "core"),
            references=("First reference", "Second reference"),
            institutions=("Analytical Engine",),
            year=2026,
            month=7,
            venue="Journal of Examples",
            volume="4",
            issue="2",
            pages="10-20",
            item_type="article",
            language="en",
        )

    def test_codecs_write_deterministic_round_trip_records(self) -> None:
        record = self.record()
        canonical_record = record.model_copy(update={"tags": ("core", "review")})
        for codec in (BibtexCodec(), RisCodec(), CslJsonCodec()):
            first = BytesIO()
            second = BytesIO()
            first_result = codec.write((record,), first)
            second_result = codec.write((record,), second)

            self.assertEqual(first.getvalue(), second.getvalue())
            self.assertEqual(first_result, second_result)
            self.assertEqual(first_result.record_count, 1)
            self.assertEqual(first_result.bytes_written, len(first.getvalue()))
            parsed = codec.read(BytesIO(first.getvalue()))
            self.assertEqual(tuple(item.failure for item in parsed), (None,))
            self.assertEqual(parsed[0].record, canonical_record)

    def test_codecs_report_unrepresentable_identifier_namespaces(self) -> None:
        record = self.record(custom_identifier=True)
        for codec in (BibtexCodec(), RisCodec(), CslJsonCodec()):
            output = BytesIO()
            result = codec.write((record,), output)

            self.assertEqual(
                tuple((item.field, item.reason) for item in result.omissions),
                (("identifiers", "unsupported-namespace:handle"),),
            )
            parsed = codec.read(BytesIO(output.getvalue()))
            self.assertEqual(
                tuple(identifier.namespace for identifier in parsed[0].record.identifiers),
                ("doi", "pmid", "pmcid", "arxiv", "isbn", "issn"),
            )

    def test_csl_reports_institutions_without_an_author_affiliation_slot(self) -> None:
        record = self.record().model_copy(update={"authors": ()})
        output = BytesIO()

        result = CslJsonCodec().write((record,), output)

        self.assertEqual(
            tuple((item.field, item.reason) for item in result.omissions),
            (("institutions", "no-author-affiliation-slot"),),
        )

    def test_biblatex_date_and_journaltitle_are_neutral_fields(self) -> None:
        payload = (
            b"@online{example,title={BibLaTeX title},author={Doe, Jane},"
            b"date={2024-07-03},journaltitle={A journal},eprint={2401.12345},"
            b"eprinttype={arxiv}}"
        )

        result = BibtexCodec().read(BytesIO(payload))[0]

        self.assertIsNone(result.failure)
        self.assertEqual(result.record.title, "BibLaTeX title")
        self.assertEqual(result.record.year, 2024)
        self.assertEqual(result.record.month, 7)
        self.assertEqual(result.record.venue, "A journal")
        self.assertEqual(
            result.record.identifiers[0], Identifier(namespace="arxiv", value="2401.12345")
        )

    def test_malformed_records_are_isolated_for_each_codec(self) -> None:
        bibtex = (
            b"@article{good,title={First}}\n"
            b"@article{broken,title={Unclosed\n"
            b"@article{good2,title={Second}}\n"
        )
        ris = (
            b"TY  - JOUR\nTI  - First\nER  - \n"
            b"TY  - JOUR\nTI  - \nER  - \n"
            b"TY  - JOUR\nTI  - Second\nER  - \n"
        )
        csl = b'[{"title":"First"},{"title":7},{"title":"Second"}]'
        cases = ((BibtexCodec(), bibtex), (RisCodec(), ris), (CslJsonCodec(), csl))
        for codec, payload in cases:
            results = codec.read(BytesIO(payload))

            self.assertEqual(len(results), 3)
            self.assertEqual(tuple(item.failure is None for item in results), (True, False, True))
            self.assertEqual(
                tuple(item.record.title for item in results if item.failure is None),
                ("First", "Second"),
            )

    def test_ris_record_without_er_does_not_absorb_next_record(self) -> None:
        payload = b"TY  - JOUR\nTI  - Broken\nTY  - JOUR\nTI  - Good\nER  - \n"

        results = RisCodec().read(BytesIO(payload))

        self.assertEqual(tuple(item.failure is None for item in results), (False, True))
        self.assertEqual(results[1].record.title, "Good")

    def test_input_bound_is_preserved_for_each_codec(self) -> None:
        payload = b"x" * (8 * 1024 * 1024 + 1)
        for codec in (BibtexCodec(), RisCodec(), CslJsonCodec()):
            result = codec.read(BytesIO(payload))[0]

            self.assertIsNotNone(result.failure)
            assert result.failure is not None
            self.assertEqual(result.failure.code, "input-too-large")

    def test_atomic_output_publishes_owner_only_and_cleans_staging(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o755)
            target = root / "export.ris"
            port = AtomicFileOutputPort(target)
            context = port.acquire_output()

            with context as stream:
                stream.write(b"published")
                context.publish()
            target_bytes = target.read_bytes()

            self.assertEqual(target_bytes, b"published")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(tuple(root.glob("*.stage")), ())

    def test_atomic_output_failure_keeps_old_target_and_cleans_staging(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "export.ris"
            target.write_bytes(b"old")
            target.chmod(0o600)
            port = AtomicFileOutputPort(target)

            with self.assertRaises(_WriteFailure):
                with port.acquire_output() as stream:
                    stream.write(b"new")
                    raise _WriteFailure("write failed")

            self.assertEqual(target.read_bytes(), b"old")
            self.assertEqual(tuple(root.glob("*.stage")), ())

    def test_atomic_output_rejects_target_appearance_after_binding(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "export.ris"
            port = AtomicFileOutputPort(target)
            target.write_bytes(b"appeared")
            target.chmod(0o600)
            context = port.acquire_output()

            with self.assertRaises(AtomicOutputSecurityError):
                with context as stream:
                    stream.write(b"new")

            self.assertEqual(target.read_bytes(), b"appeared")
            self.assertEqual(tuple(root.glob("*.stage")), ())

    def test_atomic_output_rejects_symlink_hardlink_and_unsafe_parent(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "export.ris"
            source = root / "source.ris"
            source.write_bytes(b"source")
            source.chmod(0o600)
            target.hardlink_to(source)
            with self.assertRaises(AtomicOutputSecurityError):
                AtomicFileOutputPort(target).acquire_output()

            target.unlink()
            target.symlink_to(source)
            with self.assertRaises(AtomicOutputSecurityError):
                AtomicFileOutputPort(target).acquire_output()

            target.unlink()
            alias = root / "alias"
            alias.mkdir()
            unsafe_parent = root / "unsafe-parent"
            unsafe_parent.symlink_to(alias, target_is_directory=True)
            with self.assertRaises(AtomicOutputSecurityError):
                AtomicFileOutputPort(unsafe_parent / "export.ris").acquire_output()

            root.chmod(0o770)
            with self.assertRaises(AtomicOutputSecurityError):
                AtomicFileOutputPort(target).acquire_output()


if __name__ == "__main__":
    unittest.main()
