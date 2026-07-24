from io import BytesIO
from pathlib import Path
import sys
from unittest import TestCase, mock

from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.identity_validation import (
    ContentIdentityValidator, IdentityDisposition, MAX_METADATA_FIELDS, MAX_PDF_PAGES,
    MAX_TEXT_CHARACTERS,
)
from sciretriever.acquisition.models import AcquisitionTarget, ProviderContent
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole


TITLE = "Bounded catalytic reaction identity validation study"
DOI = "10.1234/bounded.2024"


def target(
    *, doi: str | None = DOI, title: str | None = TITLE,
    authors: tuple[str, ...] = ("Ada Lovelace",), year: int | None = 2024,
    role: AssetRole = AssetRole.PRIMARY_PDF,
):
    identifiers = () if doi is None else (Identifier("doi", doi),)
    return AcquisitionTarget(identifiers, role=role, title=title, authors=authors, publication_year=year)


def pdf_bytes(*, metadata=None, text="", encrypted=False, pages=2):
    stream = BytesIO()
    writer = PdfWriter()
    for index in range(pages):
        writer.add_blank_page(width=612, height=792)
        page = writer.pages[-1]
        if text and index == 0:
            content = DecodedStreamObject()
            content.set_data(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii"))
            page[NameObject("/Contents")] = writer._add_object(content)
            page[NameObject("/Resources")] = DictionaryObject({
                NameObject("/Font"): DictionaryObject({
                    NameObject("/F1"): DictionaryObject({
                        NameObject("/Type"): NameObject("/Font"),
                        NameObject("/Subtype"): NameObject("/Type1"),
                        NameObject("/BaseFont"): NameObject("/Helvetica"),
                    })
                })
            })
    if metadata:
        writer.add_metadata(metadata)
    if encrypted:
        writer.encrypt("secret")
    writer.write(stream)
    return stream.getvalue()


def content(data, role=AssetRole.PRIMARY_PDF, media_type="application/pdf", format="pdf"):
    return ProviderContent(role, media_type, format, "candidate://safe", "fixture", data)


class ContentIdentityValidatorTests(TestCase):
    def setUp(self):
        self.validator = ContentIdentityValidator()

    def assert_disposition(self, expected, acquired, expected_target=None):
        result = self.validator.validate(acquired, expected_target or target())
        self.assertEqual(result.disposition, expected)

    def test_pdf_metadata_and_first_page_doi_pass(self):
        self.assert_disposition(
            IdentityDisposition.PASS,
            content(pdf_bytes(metadata={"/Subject": f"doi: {DOI}"})),
        )
        self.assert_disposition(
            IdentityDisposition.PASS,
            content(pdf_bytes(text=f"Article DOI https://doi.org/{DOI}.")),
        )

    def test_exact_high_title_and_corroborated_title_pass(self):
        self.assert_disposition(
            IdentityDisposition.PASS,
            content(pdf_bytes(metadata={"/Title": TITLE})),
            target(doi=None),
        )
        partial = "Bounded catalytic reaction identity methods"
        self.assert_disposition(
            IdentityDisposition.PASS,
            content(pdf_bytes(metadata={"/Title": partial, "/Author": "Ada Lovelace", "/CreationDate": "2024"})),
            target(doi=None),
        )

    def test_declared_doi_and_metadata_title_conflicts_mismatch(self):
        self.assert_disposition(
            IdentityDisposition.MISMATCH,
            content(pdf_bytes(metadata={"/Subject": "doi: 10.9999/wrong"})),
        )
        self.assert_disposition(
            IdentityDisposition.MISMATCH,
            content(pdf_bytes(metadata={"/Title": "Completely unrelated geological survey report"})),
            target(doi=None),
        )

    def test_shorter_declared_title_inside_target_does_not_pass(self):
        expected = "Catalytic reaction framework for quantum molecular optimization"
        acquired = content(pdf_bytes(metadata={
            "/Title": "Catalytic reaction framework",
        }))
        self.assert_disposition(
            IdentityDisposition.UNCONFIRMED,
            acquired,
            target(doi=None, title=expected, authors=(), year=None),
        )

    def test_scanned_encrypted_and_malformed_are_generic_unconfirmed(self):
        cases = (
            content(pdf_bytes()),
            content(pdf_bytes(encrypted=True)),
            content(b"%PDF-1.7 parser-secret\n%%EOF"),
        )
        for acquired in cases:
            with self.subTest(size=len(acquired.data)):
                result = self.validator.validate(acquired, target())
                self.assertEqual(result.disposition, IdentityDisposition.UNCONFIRMED)
                self.assertNotIn("secret", repr(result))

    def test_pdf_page_and_character_bounds(self):
        pages = [mock.Mock() for _ in range(MAX_PDF_PAGES + 2)]
        for page in pages:
            page.extract_text.return_value = "x" * (MAX_TEXT_CHARACTERS + 10)
        reader = mock.Mock(pages=pages, metadata={}, is_encrypted=False)
        with mock.patch("sciretriever.acquisition.identity_validation.PdfReader", return_value=reader):
            self.assert_disposition(IdentityDisposition.UNCONFIRMED, content(b"ignored"))
        pages[0].extract_text.assert_called_once_with()
        for page in pages[1:]:
            page.extract_text.assert_not_called()

    def test_xml_jats_and_html_metadata_visible_text(self):
        xml = f"""<article><front><article-meta>
        <article-id pub-id-type='doi'>{DOI}</article-id><title-group><article-title>Bounded <italic>catalytic reaction</italic> identity validation study</article-title></title-group>
        <contrib><name><surname>Lovelace</surname></name></contrib><pub-date><year>2024</year></pub-date>
        </article-meta></front><body><p>bounded text</p></body></article>""".encode()
        self.assert_disposition(
            IdentityDisposition.PASS,
            content(xml, AssetRole.XML, "application/jats+xml", "xml"),
            target(role=AssetRole.XML),
        )
        html = f"""<html><head><meta name='citation_title' content='{TITLE}'>
        <meta name='citation_author' content='Ada Lovelace'><meta name='citation_publication_date' content='2024'>
        </head><body>Article DOI: {DOI}<script>private body</script></body></html>""".encode()
        self.assert_disposition(
            IdentityDisposition.PASS,
            content(html, AssetRole.HTML, "text/html", "html"),
            target(role=AssetRole.HTML),
        )

    def test_xml_character_budget_ignores_late_identity_without_leaking(self):
        late_doi = "10.1234/late-secret-identity"
        xml = (
            "<article>" + ("x" * MAX_TEXT_CHARACTERS)
            + f"<article-id>{late_doi}</article-id></article>"
        ).encode()
        result = self.validator.validate(
            content(xml, AssetRole.XML, "application/jats+xml", "xml"),
            target(doi=late_doi, title=None, authors=(), year=None, role=AssetRole.XML),
        )
        self.assertEqual(result.disposition, IdentityDisposition.UNCONFIRMED)
        self.assertNotIn("late-secret", repr(result))

    def test_xml_metadata_count_cap_does_not_declare_late_doi(self):
        late_doi = "10.1234/after-field-cap"
        fillers = "".join(
            f"<article-title>filler title {index}</article-title>"
            for index in range(MAX_METADATA_FIELDS)
        )
        xml = f"<article>{fillers}<article-id>{late_doi}</article-id></article>".encode()
        self.assert_disposition(
            IdentityDisposition.UNCONFIRMED,
            content(xml, AssetRole.XML, "application/jats+xml", "xml"),
            target(
                doi="10.1234/expected-not-present", title=None, authors=(),
                year=None, role=AssetRole.XML,
            ),
        )

    def test_html_metadata_aggregate_cap_ignores_late_identity(self):
        late_doi = "10.1234/after-html-meta-cap"
        fillers = "".join(
            f"<meta name='citation_title' content='filler title {index}'>"
            for index in range(MAX_METADATA_FIELDS)
        )
        html = (
            f"<html><head>{fillers}<meta name='citation_doi' content='{late_doi}'>"
            "</head><body>ordinary article text</body></html>"
        ).encode()
        self.assert_disposition(
            IdentityDisposition.UNCONFIRMED,
            content(html, AssetRole.HTML, "text/html", "html"),
            target(doi=late_doi, title=None, authors=(), year=None, role=AssetRole.HTML),
        )

    def test_all_supported_roles_use_target_identity(self):
        for role in (AssetRole.PRIMARY_PDF, AssetRole.SUPPLEMENTARY_PDF):
            with self.subTest(role=role):
                self.assert_disposition(
                    IdentityDisposition.PASS,
                    content(pdf_bytes(metadata={"/Subject": DOI}), role),
                    target(role=role),
                )


if __name__ == "__main__":
    import unittest
    unittest.main()
