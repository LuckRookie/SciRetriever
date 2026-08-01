from pathlib import Path
import sys
from unittest import TestCase

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.models import AcquisitionTarget
from sciretriever.acquisition.translator import TranslatorRuleResolver
from sciretriever.config import TranslatorRuleConfig
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.network import HttpResponse


class Transport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, *, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers, timeout))
        return self.response

    def resolve_host(self, hostname):
        return ("192.0.2.1",)


def rule(**changes):
    values = {
        "name": "publisher",
        "landing_url_template": "https://landing.example/article/{doi_path}",
        "allowed_landing_hosts": (),
        "allowed_pdf_hosts": (),
    }
    values.update(changes)
    return TranslatorRuleConfig(**values)


class TranslatorResolverTests(TestCase):
    def target(self):
        return AcquisitionTarget((Identifier("doi", "10.1000/a/b"),))

    def resolver(self, body, *, response_url="https://landing.example/article/final", config=None, media_type="text/html"):
        response = HttpResponse(200, response_url, {"content-type": media_type}, body)
        transport = Transport(response)
        return TranslatorRuleResolver(transport, config or rule()), transport

    def test_static_selector_order_relative_resolution_and_runtime_privacy(self):
        body = (REPOSITORY / "tests/fixtures/acquisition/translator_landing.fixture").read_bytes()
        resolver, transport = self.resolver(body)
        candidates = resolver.resolve(self.target(), AssetRole.PRIMARY_PDF, timeout=3)
        self.assertEqual(transport.calls[0][0], "https://landing.example/article/10.1000/a/b")
        self.assertEqual([item.execution_url.split("/")[-1].split("?", 1)[0] for item in candidates], [
            "meta.pdf", "link.pdf", "frame.pdf", "embed.pdf", "object.pdf", "anchor.pdf",
        ])
        self.assertEqual(candidates[0].page_url, "https://landing.example/article/final")
        self.assertEqual(candidates[0].referrer, candidates[0].page_url)
        self.assertNotIn("token=secret", repr(candidates[0]))
        self.assertNotIn("article/final", repr(candidates[0]))
        self.assertFalse(any("ignored" in item.execution_url for item in candidates))

    def test_deduplicate_cap_allowlists_and_unsafe_or_supplementary_rejection(self):
        links = [f'<a href="https://pdf.example/paper-{index}.pdf">x</a>' for index in range(10)]
        body = ("".join([
            '<a href="https://evil.example/paper.pdf">x</a>',
            '<a href="https://user@pdf.example/paper.pdf">x</a>',
            '<a href="https://pdf.example/supplement.pdf">x</a>',
            links[0], links[0], *links[1:],
        ])).encode()
        config = rule(allowed_pdf_hosts=("pdf.example",))
        resolver, _ = self.resolver(body, config=config)
        candidates = resolver.resolve(self.target(), AssetRole.PRIMARY_PDF, timeout=1)
        self.assertEqual(len(candidates), 8)
        self.assertTrue(all("pdf.example" in item.execution_url for item in candidates))

    def test_final_landing_allowlist_and_pdf_evidence_are_enforced(self):
        resolver, _ = self.resolver(
            b'<a href="https://pdf.example/download?format=pdf">x</a>',
            response_url="https://redirect.example/final",
            config=rule(
                allowed_landing_hosts=("redirect.example",),
                allowed_pdf_hosts=("pdf.example",),
            ),
        )
        candidates = resolver.resolve(self.target(), AssetRole.PRIMARY_PDF, timeout=1)
        self.assertEqual(len(candidates), 1)
        rejected, _ = self.resolver(b'<a href="/paper.pdf">x</a>', response_url="https://evil.example/final")
        with self.assertRaisesRegex(Exception, "landing location rejected"):
            rejected.resolve(self.target(), AssetRole.PRIMARY_PDF, timeout=1)

    def test_challenge_not_found_non_html_no_doi_and_role_fail_stably(self):
        cases = (
            (b"<html>captcha verify you are human</html>", "text/html", "challenge unsupported"),
            (b"<html>article not found secret-query=x</html>", "text/html", "article not found"),
            (b"%PDF", "application/pdf", "was not HTML"),
        )
        for body, media_type, message in cases:
            resolver, _ = self.resolver(body, media_type=media_type)
            with self.subTest(message=message), self.assertRaisesRegex(Exception, message) as raised:
                resolver.resolve(self.target(), AssetRole.PRIMARY_PDF, timeout=1)
            self.assertNotIn("secret-query", str(raised.exception))
        resolver, _ = self.resolver(b"<html></html>")
        with self.assertRaises(Exception):
            resolver.resolve(AcquisitionTarget(()), AssetRole.PRIMARY_PDF, timeout=1)
        with self.assertRaisesRegex(Exception, "only primary PDF"):
            resolver.resolve(self.target(), AssetRole.XML, timeout=1)


if __name__ == "__main__":
    import unittest
    unittest.main()
