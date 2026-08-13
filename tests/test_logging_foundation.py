"""Direct contract tests for the isolated logging foundation."""

from __future__ import annotations

import io
import logging
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

from sciretriever.logging.api import configure_logging, get_logger
from sciretriever.logging.redaction import redact_text


class _ExplodingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        raise RuntimeError("formatter sentinel")


class _ExplodingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        raise RuntimeError("filter sentinel")


class _ExplodingStream(io.StringIO):
    def write(self, value: str) -> int:
        raise OSError("stream sentinel")


class LoggingFoundationTests(unittest.TestCase):
    """The tests deliberately exercise the process-global logging registry."""

    def setUp(self) -> None:
        self.project_logger = logging.getLogger("sciretriever")
        self.root_logger = logging.getLogger()
        self.project_snapshot = (
            list(self.project_logger.handlers),
            self.project_logger.level,
            self.project_logger.propagate,
            self.project_logger.disabled,
        )
        self.root_snapshot = (
            list(self.root_logger.handlers),
            self.root_logger.level,
            self.root_logger.propagate,
            self.root_logger.disabled,
        )

    def tearDown(self) -> None:
        self.project_logger.handlers[:] = self.project_snapshot[0]
        self.project_logger.setLevel(self.project_snapshot[1])
        self.project_logger.propagate = self.project_snapshot[2]
        self.project_logger.disabled = self.project_snapshot[3]
        self.root_logger.handlers[:] = self.root_snapshot[0]
        self.root_logger.setLevel(self.root_snapshot[1])
        self.root_logger.propagate = self.root_snapshot[2]
        self.root_logger.disabled = self.root_snapshot[3]

    def _configured_handler(self) -> logging.Handler:
        configure_logging(level=logging.DEBUG)
        self.assertEqual(len(self.project_logger.handlers), 1)
        return self.project_logger.handlers[0]

    def test_import_has_no_configuration_side_effects(self) -> None:
        """Importing package/API must not call basicConfig or install handlers."""

        root = Path(__file__).resolve().parents[1]
        source = """
import logging

root = logging.getLogger()
project = logging.getLogger('sciretriever')
before = (list(root.handlers), root.level, list(project.handlers), project.level, project.propagate)
def fail(*args, **kwargs):
    raise AssertionError('basicConfig was called')
logging.basicConfig = fail
import sciretriever.logging
import sciretriever.logging.api
after = (list(root.handlers), root.level, list(project.handlers), project.level, project.propagate)
assert before == after
"""
        completed = subprocess.run(
            [sys.executable, "-c", source],
            cwd=root,
            env={"PYTHONPATH": str(root / "src")},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "")

    def test_get_logger_validates_namespace_and_has_no_side_effects(self) -> None:
        before = (
            list(self.project_logger.handlers),
            self.project_logger.level,
            self.project_logger.propagate,
        )

        logger = get_logger("  sciretriever.metadata.providers  ")

        self.assertIs(logger, logging.getLogger("sciretriever.metadata.providers"))
        self.assertEqual(logger.name, "sciretriever.metadata.providers")
        self.assertEqual(
            before,
            (
                list(self.project_logger.handlers),
                self.project_logger.level,
                self.project_logger.propagate,
            ),
        )
        for invalid in (
            "",
            " ",
            "sciretriever.",
            "sciretrieverx.module",
            "other.module",
            "sciretriever module",
            "sciretriever..module",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    get_logger(invalid)
        with self.assertRaises(TypeError):
            get_logger(None)  # type: ignore[arg-type]

    def test_configure_only_changes_project_logger_not_root(self) -> None:
        root_handler = logging.StreamHandler(io.StringIO())
        self.root_logger.addHandler(root_handler)
        before_root = (
            list(self.root_logger.handlers),
            self.root_logger.level,
            self.root_logger.propagate,
            self.root_logger.disabled,
        )
        self.project_logger.handlers.clear()
        self.project_logger.setLevel(logging.NOTSET)
        self.project_logger.propagate = True

        configure_logging(level=logging.INFO)

        self.assertEqual(
            before_root,
            (
                list(self.root_logger.handlers),
                self.root_logger.level,
                self.root_logger.propagate,
                self.root_logger.disabled,
            ),
        )
        self.assertEqual(self.project_logger.level, logging.INFO)
        self.assertFalse(self.project_logger.propagate)
        self.assertEqual(len(self.project_logger.handlers), 1)
        self.assertIsInstance(self.project_logger.handlers[0], logging.StreamHandler)

    def test_logging_is_stderr_only_and_does_not_duplicate_on_reconfigure(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        logger = get_logger("sciretriever.logging.test")
        with redirect_stdout(stdout), redirect_stderr(stderr):
            configure_logging(level=logging.INFO)
            first_handler = self.project_logger.handlers[0]
            configure_logging(level=logging.INFO)
            second_handler = self.project_logger.handlers[0]
            logger.info("progress sentinel")

        self.assertIs(first_handler, second_handler)
        self.assertEqual(len(self.project_logger.handlers), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue().count("progress sentinel"), 1)

    def test_final_filter_redacts_secret_header_cookie_query_and_exception(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        logger = get_logger("sciretriever.network.test")
        secret = "SECRET_SENTINEL"
        exception_secret = "EXCEPTION_SENTINEL"
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self._configured_handler()
            logger.error(
                "request secret=%s headers=%r cookie=%s url=%s query=%r",
                secret,
                {"Authorization": secret, "X-Api-Key": secret},
                secret,
                "https://example.test/download?token=" + secret + "&page=1",
                {"access_token": secret, "page": "1"},
            )
            try:
                raise RuntimeError(exception_secret)
            except RuntimeError:
                logger.exception("provider request failed")

        output = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(secret, output)
        self.assertNotIn(exception_secret, output)
        self.assertNotIn("Traceback", output)
        self.assertIn("provider request failed", output)

    def test_redact_text_removes_url_userinfo_with_and_without_query(self) -> None:
        username = "alice"
        password = "PASSWORD_SENTINEL"
        token = "TOKEN_SENTINEL"
        original_netloc = f"{username}:{password}@example.test"
        text = redact_text(
            " ".join(
                (
                    f"https://{original_netloc}/path",
                    f"https://{original_netloc}/path?token={token}&page=1#fragment",
                    f"https://{original_netloc}/path#fragment?token={token}",
                )
            )
        )

        self.assertNotIn(username, text)
        self.assertNotIn(password, text)
        self.assertNotIn(token, text)
        self.assertNotIn(original_netloc, text)
        self.assertIn("https://example.test/path", text)
        self.assertIn("page=1#fragment", text)
        self.assertIn("https://example.test/path#fragment?token=<redacted>", text)

    def test_configured_handler_does_not_emit_url_userinfo_or_query_secrets(self) -> None:
        stderr = io.StringIO()
        logger = get_logger("sciretriever.logging.url_userinfo")
        username = "alice"
        password = "PASSWORD_SENTINEL"
        token = "TOKEN_SENTINEL"
        original_netloc = f"{username}:{password}@example.test"
        url = f"https://{original_netloc}/path?token={token}&page=1#fragment"

        with redirect_stderr(stderr):
            self._configured_handler()
            logger.error("request URL: %s", url)

        output = stderr.getvalue()
        self.assertNotIn(username, output)
        self.assertNotIn(password, output)
        self.assertNotIn(token, output)
        self.assertNotIn(original_netloc, output)
        self.assertIn("https://example.test/path", output)
        self.assertIn("page=1#fragment", output)

    def test_formatter_filter_and_output_failures_do_not_change_business_result(self) -> None:
        logger = get_logger("sciretriever.logging.failure")
        handler = self._configured_handler()

        def business_operation() -> dict[str, Any]:
            logger.info("diagnostic")
            return {"accepted": True}

        original_formatter = handler.formatter
        handler.setFormatter(_ExplodingFormatter())
        self.assertEqual(business_operation(), {"accepted": True})

        handler.setFormatter(original_formatter)
        handler.filters[:] = [_ExplodingFilter()]
        self.assertEqual(business_operation(), {"accepted": True})

        handler.filters.clear()
        handler.setStream(_ExplodingStream())  # type: ignore[attr-defined]
        self.assertEqual(business_operation(), {"accepted": True})


if __name__ == "__main__":
    unittest.main()
