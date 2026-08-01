from __future__ import annotations

import unittest
from io import BytesIO

from sciretriever.interoperability.codecs import (
    BibtexCodec,
    CslJsonCodec,
    EndnoteXmlCodec,
    RisCodec,
)
from sciretriever.interoperability.import_preparation import (
    ImportIdentityResolution,
    ImportPreparationRequest,
    prepare_import_record,
)
from sciretriever.interoperability.publisher_contracts import ImportResult
from sciretriever.kernel import WorkId, WorkVersionId

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
ENDNOTE = (
    b'<?xml version="1.0" encoding="UTF-8"?><xml><records><record>'
    b'<ref-type name="Journal Article">17</ref-type><titles>'
    b"<title>Canonical Title</title><secondary-title>Journal</secondary-title></titles>"
    b"<contributors><authors><author>Lovelace, Ada</author>"
    b"<author>Hopper, Grace</author></authors></contributors><abstract>Summary</abstract>"
    b"<dates><year>2026</year><month>7</month></dates><volume>4</volume>"
    b"<number>2</number><pages>10-20</pages>"
    b"<electronic-resource-num>10.1000/Example</electronic-resource-num>"
    b"<accession-num>PMID:42</accession-num><isbn>1234-5678</isbn>"
    b"<language>en</language><keywords><keyword>alpha</keyword><keyword>beta</keyword>"
    b"<keyword>alpha</keyword></keywords><custom1>review</custom1><custom2>core</custom2>"
    b"<references><reference>First ref</reference><reference>Second ref</reference>"
    b"</references><notes>secret</notes><urls><pdf-urls>"
    b"<url>/private/paper.pdf</url></pdf-urls></urls></record></records></xml>"
)


class FakeIdentity:
    __slots__ = ("calls", "resolution")

    def __init__(self, resolution: ImportIdentityResolution) -> None:
        self.resolution = resolution
        self.calls = 0

    def prepare_import(self, request: ImportPreparationRequest) -> ImportIdentityResolution:
        self.calls += 1
        return self.resolution


class TargetBibliographyImportTests(unittest.TestCase):
    def test_four_formats_converge_without_private_fields(self) -> None:
        codecs_and_bytes = (
            (BibtexCodec(), BIBTEX),
            (RisCodec(), RIS),
            (CslJsonCodec(), CSL),
            (EndnoteXmlCodec(), ENDNOTE),
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

    def test_endnote_rejects_dtd_and_utf8_rejects_malformed_bytes(self) -> None:
        xxe = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><xml><records/></xml>'

        xml_result = EndnoteXmlCodec().read(BytesIO(xxe))
        byte_result = CslJsonCodec().read(BytesIO(b"[\xff]"))

        self.assertIsNotNone(xml_result[0].failure)
        self.assertIsNotNone(byte_result[0].failure)

    def test_endnote_rejects_utf16_declarations_before_entity_expansion(self) -> None:
        declarations = (
            '<!DOCTYPE xml [<!ENTITY x "EXPANDED">]>',
            '<! DoCtYpE xml [<! EnTiTy x SYSTEM "file:///etc/passwd">]>',
            '<!DOCTYPE xml PUBLIC "external" "https://example.invalid/x">',
            '<!DOCTYPE xml [<!ENTITY a "1234567890"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>',
        )
        codecs = ("utf-16-le", "utf-16-be")

        results = tuple(
            EndnoteXmlCodec().read(
                BytesIO(
                    (b"\xff\xfe" if encoding.endswith("le") else b"\xfe\xff")
                    + (
                        f'<?xml version="1.0" encoding="UTF-16"?>{declaration}'
                        "<xml><records><record><titles><title>&x;</title></titles></record></records></xml>"
                    ).encode(encoding)
                )
            )[0]
            for declaration in declarations
            for encoding in codecs
        )

        self.assertTrue(all(item.failure is not None for item in results))

    def test_endnote_namespace_variants_map_identically_and_reject_unknown_namespace(self) -> None:
        body = (
            "<records><record><titles><title>Namespaced</title></titles>"
            "<references><reference>R</reference></references></record></records>"
        )
        default = f'<xml xmlns="urn:endnote">{body}</xml>'.encode()
        prefixed = (
            f'<e:xml xmlns:e="urn:endnote">'
            f"{body.replace('<', '<e:').replace('<e:/', '</e:')}</e:xml>"
        ).encode()
        unknown = f'<xml xmlns="urn:unknown">{body}</xml>'.encode()
        collision = (
            b"<xml><record><title>Wrong</title></record><records><record><titles>"
            b"<title>Namespaced</title></titles></record></records></xml>"
        )

        default_record = EndnoteXmlCodec().read(BytesIO(default))[0]
        prefixed_record = EndnoteXmlCodec().read(BytesIO(prefixed))[0]
        unknown_result = EndnoteXmlCodec().read(BytesIO(unknown))[0]
        collision_result = EndnoteXmlCodec().read(BytesIO(collision))

        self.assertEqual(default_record.record, prefixed_record.record)
        self.assertIsNotNone(unknown_result.failure)
        self.assertEqual(len(collision_result), 1)
        self.assertEqual(collision_result[0].record.title, "Namespaced")

    def test_endnote_encoding_contract_rejects_mismatch_and_nul_but_accepts_benign_utf16(
        self,
    ) -> None:
        benign = (
            '<?xml version="1.0" encoding="UTF-16"?><xml><records><record><titles>'
            "<title>Benign</title></titles></record></records></xml>"
        )
        declared_le = benign.replace('encoding="UTF-16"', 'encoding="UTF-16LE"').encode("utf-16-le")
        mismatched_bom = b"\xff\xfe" + benign.replace(
            'encoding="UTF-16"', 'encoding="UTF-16BE"'
        ).encode("utf-16-le")
        mismatch = b'<?xml version="1.0" encoding="UTF-16"?><xml><records/></xml>'
        unsupported = b'<?xml version="1.0" encoding="ISO-8859-1"?><xml><records/></xml>'
        nul = b'<?xml version="1.0"?><xml>\x00<records/></xml>'

        good = tuple(
            EndnoteXmlCodec().read(BytesIO(value))[0]
            for value in (
                b"\xff\xfe" + benign.encode("utf-16-le"),
                b"\xfe\xff" + benign.encode("utf-16-be"),
                declared_le,
            )
        )
        bad = tuple(
            EndnoteXmlCodec().read(BytesIO(value))[0]
            for value in (
                mismatched_bom,
                mismatch,
                unsupported,
                nul,
            )
        )

        self.assertTrue(all(item.failure is None for item in good))
        self.assertTrue(all(item.failure is not None for item in bad))

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
                WorkId("00000000-0000-0000-0000-000000000001"),
                WorkVersionId("00000000-0000-0000-0000-000000000002"),
                ImportResult.ENRICHED,
                True,
                None,
            )
        )

        outcome = prepare_import_record(identity, parsed)

        self.assertEqual(outcome.result, ImportResult.DUPLICATE)
        self.assertIsNone(outcome.prepared)
        self.assertEqual(identity.calls, 1)

    def test_replay_and_mixed_format_use_identity_result_without_writes(self) -> None:
        identity = FakeIdentity(
            ImportIdentityResolution(
                WorkId("00000000-0000-0000-0000-000000000001"),
                WorkVersionId("00000000-0000-0000-0000-000000000002"),
                ImportResult.DUPLICATE,
                False,
                None,
            )
        )
        parsed = (
            BibtexCodec().read(BytesIO(BIBTEX))[0],
            RisCodec().read(BytesIO(RIS))[0],
            CslJsonCodec().read(BytesIO(CSL))[0],
            EndnoteXmlCodec().read(BytesIO(ENDNOTE))[0],
        )

        outcomes = tuple(prepare_import_record(identity, item) for item in parsed + parsed)

        self.assertEqual({item.result for item in outcomes}, {ImportResult.DUPLICATE})
        self.assertEqual(identity.calls, 8)


if __name__ == "__main__":
    unittest.main()
