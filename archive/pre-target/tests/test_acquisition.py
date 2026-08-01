from importlib import import_module
from io import BytesIO
from pathlib import Path
import sys
from unittest import TestCase

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition import AcquisitionTarget, DirectHttpsResolver, HttpResponse, ProviderContent, UrlPolicy, validate_primary_pdf
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.acquisition.transport import _read_bounded
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.core.validation import normalize_media_type
from sciretriever.errors import AcquisitionError, ProviderErrorCategory, ValidationError
from sciretriever.network import url_with_params


def pdf_bytes(*, pages: int = 2) -> bytes:
    stream = BytesIO()
    writer = import_module("PyPDF2").PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": "acquisition validation" * 100})
    writer.write(stream)
    return stream.getvalue()


class FakeTransport:
    def __init__(self, responses: dict[str, HttpResponse]) -> None:
        self.responses = responses
        self.urls: list[str] = []

    def resolve_host(self, hostname: str) -> tuple[str, ...]:
        del hostname
        return ("192.0.2.1",)

    def get(self, url: str, *, params=None, headers=None, timeout=None) -> HttpResponse:
        del params, headers, timeout
        self.urls.append(url)
        return self.responses[url]


class CountingReader:
    def __init__(self, size: int) -> None:
        self.remaining = size
        self.read_bytes = 0

    def read(self, n: int = -1) -> bytes:
        amount = min(n, self.remaining)
        self.remaining -= amount
        self.read_bytes += amount
        return b"x" * amount


class AcquisitionTests(TestCase):
    def test_bounded_body_stops_before_full_response(self) -> None:
        reader = CountingReader(10_000)
        with self.assertRaises(AcquisitionError):
            _read_bounded(reader, {}, 100)
        self.assertLess(reader.read_bytes, 10_000)

    def test_pdf_validation_accepts_valid_and_rejects_bad_payloads(self) -> None:
        validate_primary_pdf(ProviderContent(AssetRole.PRIMARY_PDF, "application/pdf", "pdf", "test://pdf", "test", pdf_bytes()))
        for data, media_type in (
            (b"not-pdf", "application/pdf"),
            (pdf_bytes(pages=1)[:-20], "application/pdf"),
            (pdf_bytes(), "text/html"),
        ):
            with self.subTest(media_type=media_type), self.assertRaises(ValidationError):
                validate_primary_pdf(ProviderContent(AssetRole.PRIMARY_PDF, media_type, "pdf", "test://pdf", "test", data))

    def test_media_type_normalization_is_strict(self) -> None:
        self.assertEqual(normalize_media_type("Application/PDF; charset=utf-8"), "application/pdf")
        for value in ("", "application", "application/!pdf", "text/plain\r\nX: y"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_media_type(value)

    def test_url_policy_rejects_unsafe_urls_and_redirect_targets(self) -> None:
        policy = UrlPolicy()
        for url, addresses in (
            ("http://example.test/a", ("192.0.2.1",)),
            ("https://user@example.test/a", ("192.0.2.1",)),
            ("https://example.test/a", ("127.0.0.1",)),
            ("https://example.test/a", ("169.254.1.1",)),
        ):
            with self.subTest(url=url), self.assertRaises(AcquisitionError):
                policy.validate(url, addresses)

    def test_direct_resolver_returns_neutral_candidate_without_downloading(self) -> None:
        url = "https://files.example.test/article.pdf"
        candidate = DirectHttpsResolver().resolve(
            AcquisitionTarget((), direct_url=url), AssetRole.PRIMARY_PDF, timeout=1.0
        )[0]
        self.assertEqual(candidate.execution_url, url)
        self.assertIs(candidate.role, AssetRole.PRIMARY_PDF)

    def test_provider_status_classification(self) -> None:
        expected = {
            404: (ProviderErrorCategory.CLIENT, False),
            429: (ProviderErrorCategory.RATE_LIMIT, True),
            503: (ProviderErrorCategory.SERVER, True),
        }
        for status, result in expected.items():
            response = HttpResponse(status, "https://example.test", {}, b"")
            error = ProviderAcquisitionError.for_response("example", response)
            self.assertEqual((error.category, error.retryable), result)

    def test_query_encoding_does_not_mutate_identifier(self) -> None:
        identifier = Identifier("doi", "10.1000/a b")
        url = url_with_params("https://example.test", {"doi": identifier.value})
        self.assertIn("doi=10.1000%2Fa+b", url)
        self.assertEqual(identifier.value, "10.1000/a b")


if __name__ == "__main__":
    import unittest
    unittest.main()
