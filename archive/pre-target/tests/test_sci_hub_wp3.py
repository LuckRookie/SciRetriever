from pathlib import Path
import sys
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.models import AcquisitionTarget
from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.acquisition.sci_hub import SciHubResolver
from sciretriever.config import SciHubConfig
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.errors import AcquisitionError
from sciretriever.network import HttpResponse


FIXTURE = REPOSITORY / "tests" / "fixtures" / "acquisition" / "sci_hub_landing.fixture"


class Transport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers, timeout))
        return self.response

    def resolve_host(self, hostname):
        del hostname
        return ("192.0.2.1",)


def target(*, doi: str | None = "10.1000/example", role=AssetRole.PRIMARY_PDF):
    identifiers = () if doi is None else (Identifier("doi", doi),)
    return AcquisitionTarget(identifiers, role=role)


def resolver(response, *, allowed=("pdf.test",)):
    transport = Transport(response)
    config = SciHubConfig(True, "https://authorized.test/base", allowed)
    return SciHubResolver(transport, config), transport


class SciHubResolverTests(TestCase):
    def test_fixture_order_relative_resolution_dedup_and_allowlist(self):
        response = HttpResponse(
            200, "https://authorized.test/final/landing", {"content-type": "text/html; charset=utf-8"},
            FIXTURE.read_bytes(),
        )
        subject, transport = resolver(response)
        candidates = subject.resolve(target(doi="10.1000/a b"), AssetRole.PRIMARY_PDF, timeout=2.5)
        self.assertEqual([item.execution_url for item in candidates], [
            "https://authorized.test/meta.pdf",
            "https://authorized.test/relative.pdf",
            "https://authorized.test/frame/pdf/file",
            "https://pdf.test/embed.pdf",
            "https://authorized.test/final/download?format=pdf",
        ])
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0][0], "https://authorized.test/base/10.1000/a%20b")
        self.assertEqual(transport.calls[0][3], 2.5)

    def test_duplicate_collapse_and_eight_cap_are_deterministic(self):
        links = '<meta name="citation_pdf_url" content="/zero.pdf">' + ''.join(
            f'<a href="/{index}.pdf">x</a>' for index in range(10)
        ) + '<a href="/zero.pdf">duplicate</a>'
        subject, _ = resolver(HttpResponse(
            200, "https://authorized.test/page", {"content-type": "text/html"}, links.encode()
        ))
        candidates = subject.resolve(target(), AssetRole.PRIMARY_PDF, timeout=1)
        self.assertEqual(len(candidates), 8)
        self.assertEqual(candidates[0].execution_url, "https://authorized.test/zero.pdf")
        self.assertEqual([item.priority for item in candidates], list(range(8)))

    def test_no_candidate_not_found_and_challenge_are_generic_and_do_not_leak(self):
        secret = "DO-NOT-LEAK-BODY-OR-CREDENTIAL"
        cases = (
            (f"<html>{secret}</html>", "no acceptable PDF location"),
            (f"<html>article not found {secret}</html>", "article not found"),
            (f'<html>captcha {secret}<input type="password"></html>', "challenge unsupported"),
            (f'<html><script id="cf-chl-widget">{secret}</script></html>', "challenge unsupported"),
        )
        for index, (body, message) in enumerate(cases):
            with self.subTest(index=index):
                subject, _ = resolver(HttpResponse(
                    200, "https://authorized.test/page", {"content-type": "text/html"}, body.encode()
                ))
                with self.assertRaisesRegex(ProviderAcquisitionError, message) as raised:
                    subject.resolve(target(), AssetRole.PRIMARY_PDF, timeout=1)
                self.assertNotIn(secret, str(raised.exception))
                self.assertNotIn("https://", str(raised.exception))

    def test_non_2xx_non_html_doi_and_role_fail_without_extra_fetches(self):
        cases = (
            (HttpResponse(503, "https://authorized.test/page", {}, b"secret"), target(), AssetRole.PRIMARY_PDF, "HTTP 503"),
            (HttpResponse(200, "https://authorized.test/page", {"content-type": "text/plain"}, b"secret"), target(), AssetRole.PRIMARY_PDF, "was not HTML"),
        )
        for response, item, role, message in cases:
            subject, transport = resolver(response)
            with self.subTest(message=message), self.assertRaisesRegex(ProviderAcquisitionError, message):
                subject.resolve(item, role, timeout=1)
            self.assertEqual(len(transport.calls), 1)

        subject, transport = resolver(HttpResponse(200, "https://authorized.test/page", {}, b""))
        with self.assertRaisesRegex(AcquisitionError, "doi"):
            subject.resolve(target(doi=None), AssetRole.PRIMARY_PDF, timeout=1)
        with self.assertRaisesRegex(ProviderAcquisitionError, "only primary PDF"):
            subject.resolve(target(role=AssetRole.XML), AssetRole.XML, timeout=1)
        self.assertEqual(transport.calls, [])

    def test_direct_pdf_requires_allowed_final_https_url(self):
        accepted, _ = resolver(HttpResponse(
            200, "https://pdf.test/runtime?id=secret", {"content-type": "application/pdf"}, b"not-read-here"
        ))
        candidates = accepted.resolve(target(), AssetRole.PRIMARY_PDF, timeout=1)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].execution_url, "https://pdf.test/runtime?id=secret")
        self.assertNotIn("runtime", repr(candidates[0]))

        for url in (
            "http://authorized.test/file.pdf",
            "https://evil.test/file.pdf",
            "https://user:password@authorized.test/file.pdf",
            "https://authorized.test/file.pdf#fragment",
        ):
            subject, _ = resolver(HttpResponse(200, url, {"content-type": "application/pdf"}, b"secret"))
            with self.subTest(url=url), self.assertRaisesRegex(ProviderAcquisitionError, "rejected"):
                subject.resolve(target(), AssetRole.PRIMARY_PDF, timeout=1)

    def test_constructor_requires_enabled_config(self):
        transport = Transport(HttpResponse(200, "https://authorized.test", {}, b""))
        for config in (SciHubConfig(), SciHubConfig(False, "https://authorized.test", ())):
            with self.assertRaisesRegex(ValueError, "enabled configuration"):
                SciHubResolver(transport, config)


if __name__ == "__main__":
    import unittest
    unittest.main()
