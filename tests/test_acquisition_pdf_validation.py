from __future__ import annotations

import io
import os
import stat
import tempfile
import threading
import unittest
from collections.abc import Iterator
from contextlib import AbstractContextManager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO
from unittest import mock

from PyPDF2 import PdfWriter

from sciretriever.acquisition import rules
from sciretriever.acquisition.rules import (
    PdfValidationCancelled,
    PdfValidationCode,
    PdfValidationError,
    PdfValidationStagingError,
    validate_pdf,
)
from sciretriever.model.access import BoundedByteStream
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.staging import StagingFile, create_staging
from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging


def _pdf_bytes(*, pages: int = 1, encrypted: bool = False) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    if encrypted:
        writer.encrypt(user_password="fixture-password")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class _NamedBytesIO(io.BytesIO):
    def __init__(self, payload: bytes, name: str) -> None:
        super().__init__(payload)
        self.name = name


class _GuardedReadable:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self._offset = 0
        self.requests: list[int] = []

    def read(self, size: int = -1, /) -> bytes:
        if size < 0:
            raise AssertionError("validation attempted an unbounded read")
        self.requests.append(size)
        start = self._offset
        self._offset = min(len(self._payload), start + size)
        return self._payload[start : self._offset]


class _InfiniteReadable:
    def __init__(self) -> None:
        self.total_returned = 0
        self.requests: list[int] = []

    def read(self, size: int = -1, /) -> bytes:
        if size < 0:
            raise AssertionError("validation attempted an unbounded read")
        self.requests.append(size)
        self.total_returned += size
        return b"x" * size


class _CancelDuringRead:
    def __init__(self, event: threading.Event, payload: bytes) -> None:
        self._event = event
        self._payload = payload
        self._used = False

    def read(self, size: int = -1, /) -> bytes:
        if self._used:
            return b""
        self._used = True
        self._event.set()
        return self._payload[:size]


class _ExplodingReadable:
    name = "/private/user/secret-paper.pdf"

    def read(self, size: int = -1, /) -> bytes:
        del size
        raise OSError(
            "/private/user/secret-paper.pdf "
            "https://provider.test/file?token=runtime-secret PRIVATE-PDF-BYTES"
        )


class _CountingChunks:
    def __init__(self, chunks: tuple[bytes, ...]) -> None:
        self._chunks = chunks
        self.yielded = 0

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self._chunks:
            self.yielded += 1
            yield chunk


class _TrackingStage:
    def __init__(self, stage: StagingFile, *, fail_close: bool) -> None:
        self._stage = stage
        self._fail_close = fail_close
        self.close_calls = 0

    def write(self, data: bytes) -> int:
        return self._stage.write(data)

    def flush(self) -> None:
        self._stage.flush()

    def open(self) -> AbstractContextManager[int]:
        return self._stage.open()

    def close(self) -> None:
        self.close_calls += 1
        close = getattr(self._stage, "close")
        if not callable(close):
            raise AssertionError("staging file has no close capability")
        close()
        if self._fail_close:
            raise OSError("private staged-file cleanup detail")


class _TrackingTemporaryDirectory:
    def __init__(
        self,
        temporary_directory: TemporaryDirectory[str],
        *,
        fail_cleanup: bool,
    ) -> None:
        self._temporary_directory = temporary_directory
        self._fail_cleanup = fail_cleanup
        self.cleanup_calls = 0

    @property
    def name(self) -> str:
        return self._temporary_directory.name

    def cleanup(self) -> None:
        self.cleanup_calls += 1
        self._temporary_directory.cleanup()
        if self._fail_cleanup:
            raise OSError("private temporary-root cleanup detail")


class PdfValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._sandbox = tempfile.TemporaryDirectory(prefix="sciretriever-a2-tests-")
        self.stage_parent = Path(self._sandbox.name) / "staging-parent"
        self.stage_parent.mkdir(mode=0o700)
        self.staging = SystemPdfValidationStaging(parent=self.stage_parent)

    def tearDown(self) -> None:
        self._sandbox.cleanup()

    def _staging_directories(self) -> tuple[Path, ...]:
        return tuple(self.stage_parent.iterdir())

    def _assert_clean(self) -> None:
        self.assertEqual(self._staging_directories(), ())

    def _assert_invalid(
        self,
        source: object,
        code: PdfValidationCode,
        *,
        max_bytes: int = 1024 * 1024,
        declared_media_type: str | None = None,
        candidate_rejection: bool = True,
    ) -> PdfValidationError:
        with self.assertRaises(PdfValidationError) as raised:
            validate_pdf(
                source,
                staging=self.staging,
                candidate_belongs_to_literature=True,
                max_bytes=max_bytes,
                declared_media_type=declared_media_type,
            )
        self.assertIs(raised.exception.code, code)
        self.assertEqual(raised.exception.is_candidate_rejection, candidate_rejection)
        self._assert_clean()
        return raised.exception

    def test_valid_one_page_short_pdf_passes_without_or_with_wrong_media_type(self) -> None:
        payload = _pdf_bytes()
        for declaration in (None, "text/html", "application/javascript"):
            with self.subTest(declaration=declaration):
                with validate_pdf(
                    _GuardedReadable(payload),
                    staging=self.staging,
                    candidate_belongs_to_literature=True,
                    max_bytes=len(payload),
                    declared_media_type=declaration,
                ) as validated:
                    self.assertEqual(validated.byte_size, len(payload))
                    self.assertEqual(validated.media_type, "application/pdf")
                    with validated.open() as stream:
                        self.assertEqual(stream.read(), payload)
                    self.assertNotIn(str(self.stage_parent), repr(validated))
                    self.assertFalse(hasattr(validated, "path"))
                self._assert_clean()

    def test_bounded_byte_stream_declaration_does_not_override_actual_bytes(self) -> None:
        payload = _pdf_bytes()
        stream = BoundedByteStream(
            chunks=(payload[:17], payload[17:]),
            media_type="text/html",
            final_locator="https://provider.test/article",
            size=len(payload),
        )
        with validate_pdf(
            stream,
            staging=self.staging,
            candidate_belongs_to_literature=True,
            max_bytes=len(payload),
        ) as validated:
            self.assertEqual(validated.byte_size, stream.size)
        self._assert_clean()

    def test_lightly_nonconforming_reader_readable_pdf_is_not_over_rejected(self) -> None:
        payload = b"\n\t " + _pdf_bytes() + b"\ntrailing-garbage"
        with validate_pdf(
            (payload[:9], payload[9:]),
            staging=self.staging,
            candidate_belongs_to_literature=True,
            max_bytes=len(payload),
        ) as validated:
            self.assertEqual(validated.byte_size, len(payload))
        self._assert_clean()

    def test_empty_html_javascript_and_fake_pdf_name_are_rejected_by_bytes(self) -> None:
        cases: tuple[tuple[object, PdfValidationCode, str | None], ...] = (
            (b"", PdfValidationCode.EMPTY, "application/pdf"),
            (b"<html><body>access denied</body></html>", PdfValidationCode.NOT_PDF, None),
            (b"javascript:window.location='/login'", PdfValidationCode.NOT_PDF, None),
            (
                _NamedBytesIO(b"<html>not a pdf</html>", "/private/user/fake.pdf"),
                PdfValidationCode.NOT_PDF,
                "application/pdf",
            ),
        )
        for source, code, declaration in cases:
            with self.subTest(code=code, declaration=declaration):
                error = self._assert_invalid(
                    source,
                    code,
                    declared_media_type=declaration,
                )
                self.assertNotIn("/private/user", repr(error))

    def test_corrupt_xref_reader_failure_is_rejected(self) -> None:
        payload = _pdf_bytes()[:-20]
        self._assert_invalid(payload, PdfValidationCode.READER_ERROR)

    def test_page_tree_failure_is_rejected(self) -> None:
        class BrokenPages:
            def __len__(self) -> int:
                raise RuntimeError("private page-tree diagnostics")

        class BrokenReader:
            is_encrypted = False
            pages = BrokenPages()

        with mock.patch.object(rules, "PdfReader", return_value=BrokenReader()):
            error = self._assert_invalid(_pdf_bytes(), PdfValidationCode.PAGE_TREE_ERROR)
        self.assertNotIn("private page-tree diagnostics", repr(error))

    def test_zero_page_pdf_is_rejected(self) -> None:
        self._assert_invalid(_pdf_bytes(pages=0), PdfValidationCode.NO_PAGES)

    def test_password_required_encrypted_pdf_is_rejected(self) -> None:
        self._assert_invalid(_pdf_bytes(encrypted=True), PdfValidationCode.ENCRYPTED)

    def test_exact_byte_budget_succeeds_and_first_excess_byte_fails_closed(self) -> None:
        payload = _pdf_bytes()
        readable = _GuardedReadable(payload)
        with validate_pdf(
            readable,
            staging=self.staging,
            candidate_belongs_to_literature=True,
            max_bytes=len(payload),
        ) as validated:
            self.assertEqual(validated.byte_size, len(payload))
        self.assertTrue(readable.requests)
        self.assertLessEqual(max(readable.requests), len(payload) + 1)
        self._assert_clean()

        chunks = _CountingChunks((payload, b"x", b"must-not-be-requested"))
        self._assert_invalid(
            chunks,
            PdfValidationCode.BYTE_BUDGET_EXCEEDED,
            max_bytes=len(payload),
        )
        self.assertEqual(chunks.yielded, 2)

    def test_unbounded_source_is_read_in_bounded_chunks_only(self) -> None:
        source = _InfiniteReadable()
        limit = 4096
        self._assert_invalid(
            source,
            PdfValidationCode.BYTE_BUDGET_EXCEEDED,
            max_bytes=limit,
        )
        self.assertTrue(source.requests)
        self.assertLessEqual(max(source.requests), limit + 1)
        self.assertEqual(source.total_returned, limit + 1)

    def test_cancel_during_read_cleans_staging_and_raises_stable_failure(self) -> None:
        event = threading.Event()
        with self.assertRaises(PdfValidationCancelled) as raised:
            validate_pdf(
                _CancelDuringRead(event, _pdf_bytes()),
                staging=self.staging,
                candidate_belongs_to_literature=True,
                max_bytes=1024 * 1024,
                cancel_event=event,
            )
        self.assertEqual(str(raised.exception), "PDF validation cancelled")
        self._assert_clean()

    def test_cancel_at_reader_boundary_cleans_staging_and_does_not_return_success(self) -> None:
        event = threading.Event()

        def cancel_reader(stream: BinaryIO, *, strict: bool) -> object:
            del stream, strict
            event.set()
            return object()

        with mock.patch.object(rules, "PdfReader", side_effect=cancel_reader):
            with self.assertRaises(PdfValidationCancelled):
                validate_pdf(
                    _pdf_bytes(),
                    staging=self.staging,
                    candidate_belongs_to_literature=True,
                    max_bytes=1024 * 1024,
                    cancel_event=event,
                )
        self._assert_clean()

    def test_invalid_pdf_cleanup_failure_is_staging_error_and_both_cleanup_steps_run(
        self,
    ) -> None:
        stages: list[_TrackingStage] = []
        directories: list[_TrackingTemporaryDirectory] = []

        def create_tracking_stage(root: StorageRoot) -> _TrackingStage:
            stage = _TrackingStage(create_staging(root), fail_close=True)
            stages.append(stage)
            return stage

        def create_tracking_directory(
            *, prefix: str, dir: Path | None = None
        ) -> _TrackingTemporaryDirectory:
            directory = _TrackingTemporaryDirectory(
                TemporaryDirectory(prefix=prefix, dir=dir),
                fail_cleanup=False,
            )
            directories.append(directory)
            return directory

        staging = SystemPdfValidationStaging(
            parent=self.stage_parent,
            temporary_directory_factory=create_tracking_directory,
            stage_factory=create_tracking_stage,
        )
        with self.assertRaises(PdfValidationStagingError) as raised:
            validate_pdf(
                b"<html>not a PDF</html>",
                staging=staging,
                candidate_belongs_to_literature=True,
                max_bytes=1024 * 1024,
            )

        self.assertEqual(str(raised.exception), "PDF validation staging failed")
        self.assertEqual([stage.close_calls for stage in stages], [1])
        self.assertEqual([directory.cleanup_calls for directory in directories], [1])
        self._assert_clean()

    def test_reader_failure_with_temporary_cleanup_failure_is_staging_error_after_stage_close(
        self,
    ) -> None:
        stages: list[_TrackingStage] = []
        directories: list[_TrackingTemporaryDirectory] = []

        def create_tracking_stage(root: StorageRoot) -> _TrackingStage:
            stage = _TrackingStage(create_staging(root), fail_close=False)
            stages.append(stage)
            return stage

        def create_tracking_directory(
            *, prefix: str, dir: Path | None = None
        ) -> _TrackingTemporaryDirectory:
            directory = _TrackingTemporaryDirectory(
                TemporaryDirectory(prefix=prefix, dir=dir),
                fail_cleanup=True,
            )
            directories.append(directory)
            return directory

        staging = SystemPdfValidationStaging(
            parent=self.stage_parent,
            temporary_directory_factory=create_tracking_directory,
            stage_factory=create_tracking_stage,
        )
        with mock.patch.object(rules, "PdfReader", side_effect=ValueError("private reader detail")):
            with self.assertRaises(PdfValidationStagingError) as raised:
                validate_pdf(
                    _pdf_bytes(),
                    staging=staging,
                    candidate_belongs_to_literature=True,
                    max_bytes=1024 * 1024,
                )

        self.assertEqual(str(raised.exception), "PDF validation staging failed")
        self.assertEqual([stage.close_calls for stage in stages], [1])
        self.assertEqual([directory.cleanup_calls for directory in directories], [1])
        self._assert_clean()

    def test_cancellation_with_cleanup_failure_is_staging_error_not_normal_rejection(self) -> None:
        stages: list[_TrackingStage] = []
        directories: list[_TrackingTemporaryDirectory] = []

        def create_tracking_stage(root: StorageRoot) -> _TrackingStage:
            stage = _TrackingStage(create_staging(root), fail_close=True)
            stages.append(stage)
            return stage

        def create_tracking_directory(
            *, prefix: str, dir: Path | None = None
        ) -> _TrackingTemporaryDirectory:
            directory = _TrackingTemporaryDirectory(
                TemporaryDirectory(prefix=prefix, dir=dir),
                fail_cleanup=False,
            )
            directories.append(directory)
            return directory

        event = threading.Event()
        staging = SystemPdfValidationStaging(
            parent=self.stage_parent,
            temporary_directory_factory=create_tracking_directory,
            stage_factory=create_tracking_stage,
        )
        with self.assertRaises(PdfValidationStagingError):
            validate_pdf(
                _CancelDuringRead(event, _pdf_bytes()),
                staging=staging,
                candidate_belongs_to_literature=True,
                max_bytes=1024 * 1024,
                cancel_event=event,
            )

        self.assertEqual([stage.close_calls for stage in stages], [1])
        self.assertEqual([directory.cleanup_calls for directory in directories], [1])
        self._assert_clean()

    def test_candidate_association_must_be_explicitly_true(self) -> None:
        for association in (False, None, 1):
            with self.subTest(association=association):
                with self.assertRaises(PdfValidationError) as raised:
                    validate_pdf(
                        _pdf_bytes(),
                        staging=self.staging,
                        candidate_belongs_to_literature=association,  # type: ignore[arg-type]
                        max_bytes=1024 * 1024,
                    )
                self.assertIs(
                    raised.exception.code,
                    PdfValidationCode.ASSOCIATION_NOT_ESTABLISHED,
                )
                self._assert_clean()

    def test_success_context_exit_is_idempotent_and_removes_owner_only_stage(self) -> None:
        validated = validate_pdf(
            _pdf_bytes(),
            staging=self.staging,
            candidate_belongs_to_literature=True,
            max_bytes=1024 * 1024,
        )
        roots = self._staging_directories()
        self.assertEqual(len(roots), 1)
        root = roots[0]
        self.assertTrue(root.name.startswith("sciretriever-pdf-"))
        directories = (root, root / "root", root / "root" / ".staging")
        files = tuple((root / "root" / ".staging").iterdir())
        self.assertEqual(len(files), 1)
        for directory in directories:
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertEqual(directory.stat().st_uid, os.geteuid())
        self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)
        self.assertEqual(files[0].stat().st_uid, os.geteuid())

        with validated:
            pass
        validated.close()
        validated.discard()
        self._assert_clean()
        with self.assertRaises(PdfValidationError) as raised:
            with validated.open():
                pass
        self.assertIs(raised.exception.code, PdfValidationCode.RESULT_CLOSED)

    def test_open_context_preserves_consumer_failure_and_outer_context_still_cleans(self) -> None:
        marker = RuntimeError("consumer publication failed")
        with self.assertRaises(RuntimeError) as raised:
            with validate_pdf(
                _pdf_bytes(),
                staging=self.staging,
                candidate_belongs_to_literature=True,
                max_bytes=1024 * 1024,
            ) as validated:
                with validated.open():
                    raise marker
        self.assertIs(raised.exception, marker)
        self._assert_clean()

    def test_failure_repr_does_not_echo_path_locator_or_private_bytes(self) -> None:
        error = self._assert_invalid(
            _ExplodingReadable(),
            PdfValidationCode.SOURCE_ERROR,
            candidate_rejection=False,
        )
        self.assertFalse(error.is_candidate_rejection)
        rendered = f"{error!s} {error!r}"
        for private_value in (
            "/private/user/secret-paper.pdf",
            "provider.test",
            "runtime-secret",
            "PRIVATE-PDF-BYTES",
        ):
            self.assertNotIn(private_value, rendered)


if __name__ == "__main__":
    unittest.main()
