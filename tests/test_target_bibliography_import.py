from __future__ import annotations

import ast
import unittest
from io import BytesIO
from pathlib import Path

from pydantic import BaseModel, ValidationError

import sciretriever.model.record as target_record
from sciretriever.interoperability.codecs import BibtexCodec, CslJsonCodec, RisCodec
from sciretriever.interoperability.import_preparation import prepare_import_record
from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import WorkId, WorkVersionId
from sciretriever.model.record import ImportIdentityResolution, ImportPreparationRequest

BIBTEX = (
    b"@article{x,title={Canonical Title},"
    b"author={Lovelace, Ada and Hopper, Grace},abstract={Summary},"
    b"year={2026},month={7},journal={Journal},volume={4},number={2},pages={10--20},"
    b"doi={https://doi.org/10.1000/Example},pmid={42},issn={1234-5678},language={en},"
    b"keywords={alpha; beta; alpha},tags={review; core},"
    b"references={First ref; Second ref},file={/private/paper.pdf},note={secret}}"
)
RIS = (
    b"TY  - JOUR\nTI  - Canonical Title\nAU  - Lovelace, Ada\nAU  - Hopper, Grace\n"
    b"AB  - Summary\nPY  - 2026\nDA  - 2026/07\nJO  - Journal\nVL  - 4\nIS  - 2\n"
    b"SP  - 10\nEP  - 20\nDO  - 10.1000/Example\nAN  - PMID:42\nSN  - 1234-5678\n"
    b"LA  - en\nKW  - alpha\nKW  - beta\nKW  - alpha\nN1  - tag:review\nN1  - tag:core\n"
    b"CR  - First ref\nCR  - Second ref\nL1  - /private/paper.pdf\nER  - \n"
)
CSL = (
    b'[{"id":"private-id","type":"article-journal","title":"Canonical Title",'
    b'"author":[{"family":"Lovelace","given":"Ada"},'
    b'{"family":"Hopper","given":"Grace"}],"abstract":"Summary",'
    b'"issued":{"date-parts":[[2026,7]]},"container-title":"Journal",'
    b'"volume":"4","issue":"2","page":"10-20","DOI":"10.1000/Example",'
    b'"PMID":"42","ISSN":"1234-5678","language":"en",'
    b'"keyword":"alpha; beta; alpha","categories":["review","core"],'
    b'"references":["First ref","Second ref"],"note":"secret",'
    b'"attachments":["/private/paper.pdf"]}]'
)


class FakeIdentity:
    def __init__(self, resolution: ImportIdentityResolution) -> None:
        self.resolution = resolution
        self.calls = 0

    def prepare_import(self, request: ImportPreparationRequest) -> ImportIdentityResolution:
        self.calls += 1
        return self.resolution


class TargetBibliographyImportTests(unittest.TestCase):
    @staticmethod
    def representative_record() -> target_record.ImportedBibliographicRecord:
        return target_record.ImportedBibliographicRecord(
            title="Canonical Title",
            authors=("Lovelace, Ada", "Hopper, Grace"),
            identifiers=(
                Identifier(namespace="doi", value="10.1000/example"),
                Identifier(namespace="pmid", value="42"),
            ),
            abstract="Summary",
            keywords=("alpha", "beta"),
            tags=("review", "core"),
            references=("First ref", "Second ref"),
            institutions=("Example University",),
            year=2026,
            month=7,
            venue="Journal",
            volume="4",
            issue="2",
            pages="10-20",
            item_type="article",
            language="en",
        )

    def test_record_contracts_are_owned_by_target_model_without_legacy_duplicates(self) -> None:
        target_names = {
            "ExportEncodingResult",
            "ExportOmission",
            "ImportedBibliographicRecord",
            "RecordParseResult",
        }
        legacy_module = __import__("sciretriever.interoperability.model", fromlist=("model",))
        legacy_path = (
            Path(__file__).parents[1] / "src" / "sciretriever" / "interoperability" / "model.py"
        )
        tree = ast.parse(legacy_path.read_text(encoding="utf-8"))
        legacy_definitions = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        }

        self.assertEqual(legacy_definitions & target_names, set())
        for name in target_names:
            contract = getattr(target_record, name)
            self.assertTrue(issubclass(contract, BaseModel))
            self.assertIs(contract.__module__, target_record.__name__)
            self.assertTrue(contract.model_config["frozen"])
            self.assertTrue(contract.model_config["strict"])
            self.assertEqual(contract.model_config["extra"], "forbid")
            self.assertNotIn(name, legacy_module.__dict__)

    def test_record_and_results_round_trip_deterministically(self) -> None:
        record = self.representative_record()
        record_json = record.model_dump_json()

        self.assertEqual(
            target_record.ImportedBibliographicRecord.model_validate_json(record_json), record
        )
        self.assertEqual(
            target_record.ImportedBibliographicRecord.model_validate_json(
                record_json
            ).model_dump_json(),
            record_json,
        )

        failure = FailureEvidence(
            code="malformed-record",
            reason=Reason(value="record is malformed"),
            action=Action(value="Correct the record."),
            retryable=False,
        )
        parsed = target_record.RecordParseResult(ordinal=2, record=record, failure=failure)
        encoded = target_record.ExportEncodingResult(
            record_count=1,
            bytes_written=len(record_json.encode("utf-8")),
            omissions=(target_record.ExportOmission(field="attachments", reason="not portable"),),
        )

        self.assertEqual(
            target_record.RecordParseResult.model_validate_json(parsed.model_dump_json()), parsed
        )
        self.assertEqual(
            target_record.ExportEncodingResult.model_validate_json(encoded.model_dump_json()),
            encoded,
        )

    def test_unknown_coercible_and_out_of_range_record_fields_are_rejected(self) -> None:
        record = self.representative_record()
        unknown = record.model_dump(mode="json")
        unknown["private_path"] = "/private/paper.pdf"
        with self.assertRaises(ValidationError):
            target_record.ImportedBibliographicRecord.model_validate(unknown)

        coercible = record.model_dump(mode="json")
        coercible["year"] = "2026"
        with self.assertRaises(ValidationError):
            target_record.ImportedBibliographicRecord.model_validate(coercible)

        out_of_range = record.model_dump(mode="json")
        out_of_range["month"] = 13
        with self.assertRaises(ValidationError):
            target_record.ImportedBibliographicRecord.model_validate(out_of_range)

        with self.assertRaises(ValidationError):
            record.title = "Changed"

    def test_three_formats_converge_without_private_fields(self) -> None:
        codecs_and_bytes = (
            (BibtexCodec(), BIBTEX),
            (RisCodec(), RIS),
            (CslJsonCodec(), CSL),
        )

        records = tuple(
            codec.read(BytesIO(payload))[0].record for codec, payload in codecs_and_bytes
        )

        self.assertTrue(all(record == records[0] for record in records))
        self.assertNotIn("private", repr(records[0]).lower())
        self.assertNotIn("secret", repr(records[0]).lower())

    def test_malformed_bibtex_record_does_not_stop_sibling(self) -> None:
        payload = BIBTEX + b"\n@article{broken,title={" + b"\n" + BIBTEX.replace(b"{x,", b"{y,")

        results = BibtexCodec().read(BytesIO(payload))

        self.assertEqual(tuple(item.failure is None for item in results), (True, False, True))

    def test_malformed_csl_json_is_rejected_without_private_bytes(self) -> None:
        result = CslJsonCodec().read(BytesIO(b"[\xff]"))

        self.assertIsNotNone(result[0].failure)
        self.assertNotIn("private", repr(result[0]).lower())

    def test_csl_empty_array_is_one_explicit_rejection(self) -> None:
        result = CslJsonCodec().read(BytesIO(b"[]"))

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].failure.code if result[0].failure else None, "empty-input")

    def test_bom_marked_utf16_is_decoded_without_loss(self) -> None:
        encoded = BIBTEX.decode("utf-8").encode("utf-16")

        result = BibtexCodec().read(BytesIO(encoded))[0]

        self.assertIsNone(result.failure)

    def test_completed_match_is_duplicate_without_prepared_mutation(self) -> None:
        parsed = BibtexCodec().read(BytesIO(BIBTEX))[0]
        identity = FakeIdentity(
            ImportIdentityResolution(
                work_id=WorkId("00000000-0000-0000-0000-000000000001"),
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000002"),
                result="enriched",
                completed=True,
                prepared=None,
            )
        )

        outcome = prepare_import_record(identity, parsed)

        self.assertEqual(outcome.result.outcome, "duplicate")
        self.assertIsNone(outcome.prepared)
        self.assertEqual(identity.calls, 1)

    def test_replay_and_mixed_format_use_identity_result_without_writes(self) -> None:
        identity = FakeIdentity(
            ImportIdentityResolution(
                work_id=WorkId("00000000-0000-0000-0000-000000000001"),
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000002"),
                result="duplicate",
                completed=False,
                prepared=None,
            )
        )
        parsed = (
            BibtexCodec().read(BytesIO(BIBTEX))[0],
            RisCodec().read(BytesIO(RIS))[0],
            CslJsonCodec().read(BytesIO(CSL))[0],
        )

        outcomes = tuple(prepare_import_record(identity, item) for item in parsed + parsed)

        self.assertEqual({item.result.outcome for item in outcomes}, {"duplicate"})
        self.assertEqual(identity.calls, 6)

    def test_import_preparation_consumes_target_record_contract(self) -> None:
        resolution = ImportIdentityResolution(
            work_id=WorkId("00000000-0000-0000-0000-000000000001"),
            work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000002"),
            result="enriched",
            completed=True,
            prepared=None,
        )
        identity = FakeIdentity(resolution)
        record = target_record.ImportedBibliographicRecord(
            title="Canonical Title",
            authors=("Lovelace, Ada",),
            identifiers=(),
            abstract=None,
            keywords=(),
            tags=(),
            references=(),
        )
        parsed = target_record.RecordParseResult(
            ordinal=0,
            record=record,
            failure=None,
        )

        outcome = prepare_import_record(identity, parsed)

        self.assertEqual(outcome.result.outcome, "duplicate")
        self.assertIsNone(outcome.prepared)
        self.assertEqual(identity.calls, 1)


if __name__ == "__main__":
    unittest.main()
