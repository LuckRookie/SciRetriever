import base64
from dataclasses import FrozenInstanceError
from pathlib import Path
import sys
from typing import MutableMapping, cast
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.candidate_resolution import validate_resolved_candidates
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id, validate_resolver_cursor
from sciretriever.core.enums import AssetRole


def runtime(
    *, cursor: str = "rc1:record-1",
    url: str = "https://files.example.test/a.pdf?sig=first",
    priority: int = 0,
) -> RuntimeDownloadCandidate:
    candidate_id = make_download_candidate_id(
        "example", "resolver_1", AssetRole.PRIMARY_PDF, cursor
    )
    return RuntimeDownloadCandidate(
        download_candidate_id=candidate_id,
        source_candidate_id="example",
        resolver_id="resolver_1",
        provider="example",
        resolver_cursor=cursor,
        execution_url=url,
        page_url="https://example.test/article",
        request_headers={"Accept": "application/pdf"},
        referrer="https://example.test/article",
        auth_context_ref="institution_1",
        role=AssetRole.PRIMARY_PDF,
        media_type_hint="application/pdf",
        priority=priority,
        transport="https",
        access_method="resolver",
        expires_at="2026-07-22T12:00:00Z",
        redacted_url_identity="host:files.example.test",
        sanitized_provenance={"record": "stable-1", "nested": ["safe"]},
    )


class CandidateModelTests(TestCase):
    def test_runtime_is_frozen_slotted_hashable_and_copies_boundaries(self) -> None:
        headers = {"Accept": "application/pdf"}
        provenance = {"record": "stable"}
        value = runtime()
        separate = RuntimeDownloadCandidate(
            **{
                **{name: getattr(value, name) for name in value.__slots__},
                "request_headers": headers,
                "sanitized_provenance": provenance,
            }
        )
        headers["X-New"] = "changed"
        provenance["record"] = "changed"
        self.assertNotIn("X-New", separate.request_headers)
        self.assertEqual(separate.sanitized_provenance["record"], "stable")
        self.assertIsInstance(hash(separate), int)
        self.assertFalse(hasattr(separate, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            setattr(separate, "priority", 2)

    def test_identity_is_independent_of_fresh_signed_url(self) -> None:
        first = runtime(url="https://files.example.test/a.pdf?sig=first")
        second = runtime(url="https://files.example.test/a.pdf?sig=second")
        self.assertEqual(first.download_candidate_id, second.download_candidate_id)
        self.assertNotEqual(first.execution_url, second.execution_url)

    def test_cursor_rejects_urls_markers_bounds_and_reversible_authorization(self) -> None:
        invalid = (
            "rc1:", "rc1:https-example", "rc1:token-1", "rc1:key=value",
            "rc1:" + "a" * 253,
            "rc1:" + base64.b64encode(b"Authorization: Bearer fixed-secret").decode("ascii"),
        )
        for value in invalid:
            with self.subTest(value=value[:40]), self.assertRaises((TypeError, ValueError)):
                validate_resolver_cursor(value)

    def test_runtime_rejects_unsafe_urls_headers_mime_and_types(self) -> None:
        base = runtime()
        values = {name: getattr(base, name) for name in base.__slots__}
        failures = (
            {"download_candidate_id": "dc1_" + "0" * 64},
            {"execution_url": "http://example.test/a.pdf"},
            {"execution_url": "https://user@example.test/a.pdf"},
            {"execution_url": "https://example.test/a.pdf#part"},
            {"request_headers": {"Bad Header": "x"}},
            {"request_headers": {"Accept": "x\r\ny"}},
            {"request_headers": {"Host": "example.test"}},
            {"media_type_hint": "Application/PDF"},
            {"expires_at": "2026-07-22T12:00:00+00:00"},
            {"priority": True},
            {"role": "primary_pdf"},
        )
        for update in failures:
            with self.subTest(update=update), self.assertRaises((TypeError, ValueError)):
                RuntimeDownloadCandidate(**{**values, **update})

    def test_provenance_is_recursively_redacted_and_immutable(self) -> None:
        value = runtime()
        fields = {name: getattr(value, name) for name in value.__slots__}
        fields["sanitized_provenance"] = {
            "token": "fixed",
            "safe": {"url": "https://secret.test/a"},
        }
        candidate = RuntimeDownloadCandidate(**fields)
        self.assertEqual(candidate.sanitized_provenance["token"], "[REDACTED]")
        with self.assertRaises(TypeError):
            cast(MutableMapping[str, object], candidate.sanitized_provenance)["new"] = "value"

    def test_runtime_credentials_are_excluded_from_repr(self) -> None:
        value = runtime()
        fields = {name: getattr(value, name) for name in value.__slots__}
        fields.update({
            "execution_url": "https://files.example.test/a.pdf?api_key=url-secret",
            "request_headers": {"Authorization": "Bearer header-secret"},
            "request_params": {"api_key": "parameter-secret"},
        })
        rendered = repr(RuntimeDownloadCandidate(**fields))
        for secret in ("url-secret", "header-secret", "parameter-secret"):
            self.assertNotIn(secret, rendered)

    def test_fresh_resolver_output_is_deterministic_and_strict(self) -> None:
        first = runtime(cursor="rc1:record-1", priority=1)
        second = runtime(cursor="rc1:record-2", priority=0)
        self.assertEqual(
            validate_resolved_candidates(
                "example", AssetRole.PRIMARY_PDF, "resolver_1", (first, second)
            ),
            (second, first),
        )
        self.assertEqual(
            validate_resolved_candidates(
                "example", AssetRole.PRIMARY_PDF, "resolver_1", (first, first)
            ),
            (first,),
        )
        with self.assertRaises(ValueError):
            validate_resolved_candidates(
                "other",
                AssetRole.PRIMARY_PDF,
                "resolver_1",
                (first,),
            )
