import asyncio
from io import BytesIO
from pathlib import Path
import sys
import threading
import time
from typing import Mapping
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from PyPDF2 import PdfWriter

from sciretriever.acquisition.candidate_executor import CandidateExecutionStatus, CandidateExecutor
from sciretriever.acquisition.identity_validation import ContentIdentityValidator
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget, HttpResponse
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.network import QueryParams


def pdf_bytes() -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": "candidate executor" * 100})
    writer.write(stream)
    return stream.getvalue()


def candidate() -> RuntimeDownloadCandidate:
    cursor = "rc1:record-1"
    return RuntimeDownloadCandidate(
        download_candidate_id=make_download_candidate_id(
            "source_1", "resolver_1", AssetRole.PRIMARY_PDF, cursor
        ),
        source_candidate_id="source_1",
        resolver_id="resolver_1",
        provider="example",
        resolver_cursor=cursor,
        execution_url="https://files.example.test/a.pdf?signature=SECRET",
        request_headers={"Accept": "application/pdf"},
        role=AssetRole.PRIMARY_PDF,
        priority=0,
        transport="https",
        access_method="resolver",
        redacted_url_identity="host:files.example.test",
        sanitized_provenance={"record": "stable-1"},
        media_type_hint="application/pdf",
    )


class FakeTransport:
    def __init__(self, response: HttpResponse, *, delay: float = 0.0) -> None:
        self.response = response
        self.delay = delay
        self.calls = 0
        self.last_url: str | None = None
        self.last_headers: Mapping[str, str] | None = None
        self.last_timeout: float | None = None

    def get(
        self,
        url: str,
        *,
        params: QueryParams | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        self.calls += 1
        self.last_url = url
        self.last_headers = headers
        self.last_timeout = timeout
        if self.delay:
            time.sleep(self.delay)
        return self.response

    def resolve_host(self, hostname: str) -> tuple[str, ...]:
        return ("192.0.2.1",)


class CandidateExecutorTests(TestCase):
    def test_validates_content_and_projects_only_safe_source_data(self) -> None:
        transport = FakeTransport(
            HttpResponse(200, "https://origin.test/leak?token=SECRET", {"content-type": "application/pdf"}, pdf_bytes())
        )
        result = asyncio.run(CandidateExecutor(transport).execute(candidate(), timeout=1.0))
        self.assertEqual(result.status, CandidateExecutionStatus.VALIDATED)
        assert result.content is not None
        self.assertEqual(result.content.source_url, "candidate://host:files.example.test")
        self.assertEqual(result.content.provenance, {"record": "stable-1"})
        self.assertNotIn("SECRET", repr(result))
        self.assertEqual(
            transport.last_url,
            "https://files.example.test/a.pdf?signature=SECRET",
        )
        self.assertEqual(transport.last_headers, {"Accept": "application/pdf"})
        self.assertGreater(transport.last_timeout or 0, 0)

    def test_invalid_content_is_failed_without_exposing_bytes(self) -> None:
        transport = FakeTransport(
            HttpResponse(200, "https://origin.test", {"content-type": "application/pdf"}, b"not a pdf")
        )
        result = asyncio.run(CandidateExecutor(transport).execute(candidate(), timeout=1.0))
        self.assertEqual(result.status, CandidateExecutionStatus.FAILED)
        self.assertIsNone(result.content)

    def test_identity_failures_use_stable_generic_messages(self) -> None:
        cases = (
            (pdf_bytes(), "article identity could not be confirmed"),
            (pdf_bytes(), "article identity does not match acquisition target"),
        )
        targets = (
            AcquisitionTarget((Identifier("doi", "10.1000/expected"),)),
            AcquisitionTarget((Identifier("doi", "10.1000/expected"),)),
        )
        bodies = [cases[0][0], self._pdf_with_doi("10.1000/wrong")]
        for body, expected_message, target in zip(bodies, (item[1] for item in cases), targets):
            with self.subTest(message=expected_message):
                transport = FakeTransport(HttpResponse(
                    200, "https://origin.test", {"content-type": "application/pdf"}, body
                ))
                result = asyncio.run(CandidateExecutor(
                    transport, identity_validator=ContentIdentityValidator()
                ).execute(candidate(), timeout=1.0, target=target))
                self.assertEqual(result.status, CandidateExecutionStatus.FAILED)
                self.assertEqual(str(result.error), expected_message)
                self.assertNotIn("10.1000", repr(result))

    @staticmethod
    def _pdf_with_doi(doi: str) -> bytes:
        stream = BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        writer.add_blank_page(width=72, height=72)
        writer.add_metadata({"/Subject": f"doi: {doi} " + "evidence" * 200})
        writer.write(stream)
        return stream.getvalue()

    def test_http_retryability_and_retry_after_are_projected(self) -> None:
        cases = (
            (429, {"retry-after": "17"}, CandidateExecutionStatus.RETRYABLE, 17),
            (404, {}, CandidateExecutionStatus.FAILED, None),
        )
        for status, headers, expected_status, retry_after in cases:
            with self.subTest(status=status):
                transport = FakeTransport(
                    HttpResponse(status, "https://origin.test", headers, b"")
                )
                result = asyncio.run(
                    CandidateExecutor(transport).execute(candidate(), timeout=1.0)
                )
                self.assertEqual(result.status, expected_status)
                self.assertEqual(result.retry_after, retry_after)
                self.assertIsNone(result.content)

    def test_timeout_returns_without_accepting_late_worker_result(self) -> None:
        transport = FakeTransport(
            HttpResponse(200, "https://origin.test", {"content-type": "application/pdf"}, pdf_bytes()),
            delay=0.2,
        )
        started = time.monotonic()
        result = asyncio.run(CandidateExecutor(transport).execute(candidate(), timeout=0.01))
        elapsed = time.monotonic() - started
        self.assertEqual(result.status, CandidateExecutionStatus.INTERRUPTED)
        self.assertEqual(transport.calls, 1)
        self.assertLess(elapsed, 0.1)

    def test_external_cancellation_propagates_without_waiting_for_worker(self) -> None:
        started = threading.Event()
        release = threading.Event()

        class BlockingTransport(FakeTransport):
            def get(
                self,
                url: str,
                *,
                params: QueryParams | None = None,
                headers: Mapping[str, str] | None = None,
                timeout: float | None = None,
            ) -> HttpResponse:
                self.calls += 1
                started.set()
                if not release.wait(1.0):
                    raise TimeoutError("test worker did not receive cleanup signal")
                return self.response

        async def cancel_running_candidate() -> None:
            transport = BlockingTransport(
                HttpResponse(
                    200,
                    "https://origin.test",
                    {"content-type": "application/pdf"},
                    pdf_bytes(),
                )
            )
            task = asyncio.create_task(
                CandidateExecutor(transport).execute(candidate(), timeout=1.0)
            )
            self.assertTrue(await asyncio.to_thread(started.wait, 0.5))
            task.cancel()
            cancelled_at = time.monotonic()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertLess(time.monotonic() - cancelled_at, 0.1)
            release.set()
            self.assertEqual(transport.calls, 1)

        asyncio.run(cancel_running_candidate())

    def test_rejects_invalid_timeout_before_transport(self) -> None:
        transport = FakeTransport(
            HttpResponse(200, "https://origin.test", {"content-type": "application/pdf"}, pdf_bytes())
        )
        for timeout in (0, -1, float("inf"), True):
            with self.subTest(timeout=timeout), self.assertRaises((TypeError, ValueError)):
                asyncio.run(CandidateExecutor(transport).execute(candidate(), timeout=timeout))
        self.assertEqual(transport.calls, 0)


if __name__ == "__main__":
    import unittest

    unittest.main()
