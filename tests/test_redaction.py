from pathlib import Path
import sys
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.diagnostics import REDACTED, redact, redact_text, redact_url


class RedactionTests(TestCase):
    def test_url_headers_and_recursive_values_are_redacted(self):
        secret = "FIXED-SENSITIVE-MARKER"
        value = {
            "url": f"https://example.test/file?visible=yes&signature={secret}&email=user@example.test#fragment",
            "headers": {
                "Authorization": f"Bearer {secret}",
                "Cookie": f"session={secret}",
                "X-Api-Key": secret,
                "Accept": "application/pdf",
            },
            "nested": [{"password": secret}, f"token={secret} user@example.test"],
            "response_body": f"BODY-{secret}",
        }
        sanitized = redact(value)
        rendered = repr(sanitized)
        self.assertNotIn(secret, rendered)
        self.assertNotIn("user@example.test", rendered)
        self.assertNotIn("BODY-", rendered)
        self.assertIn(REDACTED, rendered)
        self.assertNotIn("visible=yes", rendered)

    def test_exception_text_and_oversized_content_are_bounded(self):
        marker = "RAW-EXCEPTION-MARKER"
        sanitized = redact_text(
            RuntimeError(f"Authorization: Bearer secret https://x.test/a?token=secret user@example.test {marker} " + "x" * 1000),
            limit=120,
        )
        self.assertLessEqual(len(sanitized), 120)
        self.assertNotIn("Bearer secret", sanitized)
        self.assertNotIn("user@example.test", sanitized)

    def test_url_fragment_and_sensitive_query_values_are_removed(self):
        sanitized = redact_url("https://x.test/a?token=secret&plain=value#session-secret")
        self.assertNotIn("secret", sanitized)
        self.assertNotIn("#", sanitized)
        self.assertEqual(sanitized, "https://x.test")
        userinfo = redact_url("https://user:password@example.test/a?plain=value")
        self.assertNotIn("user", userinfo)
        self.assertNotIn("password", userinfo)
        non_http = redact_url("ftp://example.test/a?token=secret&plain=value")
        self.assertNotIn("secret", non_http)
        self.assertEqual(non_http, "ftp://example.test")

    def test_url_paths_are_not_persisted_as_diagnostics(self):
        marker = "PATH-CREDENTIAL-MARKER"
        sanitized = redact_url(
            f"https://example.test/access/{marker}/article?plain={marker}"
        )
        self.assertEqual(sanitized, "https://example.test")
        self.assertNotIn(marker, redact_text(f"failed at {sanitized}"))

    def test_exception_objects_and_error_fields_never_preserve_arbitrary_markers(self):
        marker = "ARBITRARY-RAW-MARKER"
        sanitized = redact(
            {
                "context": RuntimeError(marker),
                "error_context": marker,
                "response_body": marker,
                "nested": [{"exception_message": marker}],
            }
        )
        self.assertNotIn(marker, repr(sanitized))

    def test_small_and_invalid_text_limits_are_strict(self):
        for limit in range(0, 12):
            with self.subTest(limit=limit):
                self.assertLessEqual(len(redact_text("x" * 30, limit=limit)), limit)
        with self.assertRaises(ValueError):
            redact_text("value", limit=-1)


if __name__ == "__main__":
    import unittest

    unittest.main()
