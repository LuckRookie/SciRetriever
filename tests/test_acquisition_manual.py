from __future__ import annotations

import hashlib
import inspect
import io
import os
import stat
import threading
import unittest
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from unittest import mock

from PyPDF2 import PdfWriter

from sciretriever.acquisition import manual as manual_module
from sciretriever.acquisition.manual import (
    ManualPdfAdmissionService,
    ManualPdfInputError,
)
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    PrimaryPdfPublicationResult,
)
from sciretriever.acquisition.rules import (
    PdfValidationCancelled,
    PdfValidationCode,
    PdfValidationError,
    PdfValidationStagingError,
    ValidatedPdf,
)
from sciretriever.model.acquisition import (
    AcceptedManualPdf,
    Asset,
    AssetRole,
    LiteratureAsset,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging

_TIMESTAMP = UtcTimestamp("2026-08-11T12:00:00Z")


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


_LITERATURE_ID = LiteratureId(_uuid(1))
_OTHER_LITERATURE_ID = LiteratureId(_uuid(2))
_META_LITERATURE_ID = MetaLiteratureId(_uuid(3))


def _pdf_bytes(*, pages: int = 1, encrypted: bool = False) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    if encrypted:
        writer.encrypt(user_password="fixture-password")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _expected() -> AcquisitionExpectedFacts:
    return AcquisitionExpectedFacts(
        literature_id=_LITERATURE_ID,
        meta_literature_id=_META_LITERATURE_ID,
        metadata_revision=7,
        metadata_sha256=Sha256("a" * 64),
        expected_no_primary_pdf=True,
    )


def _automatic_provenance(index: int, digest: Sha256) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(100 + index)),
        source_kind=SourceKind.ASSET_PROVIDER,
        source_name="fixture-provider",
        source_record_id=f"record-{index}",
        observed_at=_TIMESTAMP,
        input_sha256=digest,
        parameters_sha256=None,
    )


def _current_relation(*, role: AssetRole = AssetRole.PRIMARY_PDF) -> LiteratureAsset:
    digest = Sha256("b" * 64)
    return LiteratureAsset(
        literature_asset_id=LiteratureAssetId(_uuid(200)),
        literature_id=_LITERATURE_ID,
        asset_id=AssetId(_uuid(201)),
        role=role,
        provenance=_automatic_provenance(1, digest),
        source_url="https://provider.test/paper.pdf",
    )


def _system_failure(code: str = "fixture-publication-failed") -> AcquisitionFailure:
    return AcquisitionFailure(
        StableFailure(
            code=code,
            reason="The fixture publication did not complete.",
            action="Retry after refreshing the Literature facts.",
            retryable=True,
        )
    )


class _ReadOnlyTrap:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self._offset = 0
        self.requests: list[int] = []
        self.private_locator = "/private/user/manual-secret-paper.pdf"

    @property
    def name(self) -> str:
        raise AssertionError("manual admission inspected the caller's path")

    def read(self, size: int = -1, /) -> bytes:
        if size <= 0:
            raise AssertionError("manual admission attempted an unbounded read")
        self.requests.append(size)
        start = self._offset
        self._offset = min(len(self._payload), start + size)
        return self._payload[start : self._offset]

    def close(self) -> None:
        raise AssertionError("manual admission closed its caller-owned reader")

    def fileno(self) -> int:
        raise AssertionError("manual admission inspected the caller's descriptor")

    def seek(self, *_args: object) -> int:
        raise AssertionError("manual admission sought on its caller-owned reader")

    def truncate(self, *_args: object) -> int:
        raise AssertionError("manual admission truncated its caller-owned reader")

    def write(self, _data: object) -> int:
        raise AssertionError("manual admission wrote to its caller-owned reader")


class _ExplodingReader:
    name = "/private/user/manual-secret-paper.pdf"

    def read(self, size: int = -1, /) -> bytes:
        del size
        raise OSError(
            "/private/user/manual-secret-paper.pdf "
            "https://provider.test/file?token=runtime-secret PRIVATE-PDF-BYTES"
        )


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


@dataclass(frozen=True, slots=True)
class _PublicationCall:
    expected_facts: AcquisitionExpectedFacts
    provenance: Provenance
    source_url: str | None
    payload: bytes
    sha256: Sha256
    byte_size: int
    media_type: str


ResultFactory = Callable[
    [AcquisitionExpectedFacts, ValidatedPdf, Provenance, str | None],
    object,
]


def _publication_result(
    expected_facts: AcquisitionExpectedFacts,
    validated_pdf: ValidatedPdf,
    provenance: Provenance,
    source_url: str | None,
) -> PrimaryPdfPublicationResult:
    asset = Asset(
        asset_id=AssetId(_uuid(300)),
        sha256=validated_pdf.sha256,
        size_bytes=validated_pdf.byte_size,
        media_type=validated_pdf.media_type,
        path=RelativeArtifactPath(f"objects/{validated_pdf.sha256.root}.pdf"),
    )
    relation = LiteratureAsset(
        literature_asset_id=LiteratureAssetId(_uuid(301)),
        literature_id=expected_facts.literature_id,
        asset_id=asset.asset_id,
        role=AssetRole.PRIMARY_PDF,
        provenance=provenance,
        source_url=source_url,
    )
    return PrimaryPdfPublicationResult(asset=asset, relation=relation)


class _RecordingPublisher:
    def __init__(
        self,
        *,
        failure: BaseException | None = None,
        on_publish: Callable[[ValidatedPdf], None] | None = None,
        result_factory: ResultFactory = _publication_result,
    ) -> None:
        self.failure = failure
        self.on_publish = on_publish
        self.result_factory = result_factory
        self.calls: list[_PublicationCall] = []

    def publish_validated_primary_pdf(
        self,
        *,
        expected_facts: AcquisitionExpectedFacts,
        validated_pdf: ValidatedPdf,
        provenance: Provenance,
        source_url: str | None,
    ) -> PrimaryPdfPublicationResult:
        if self.on_publish is not None:
            self.on_publish(validated_pdf)
        with validated_pdf.open() as stream:
            payload = stream.read()
        self.calls.append(
            _PublicationCall(
                expected_facts=expected_facts,
                provenance=provenance,
                source_url=source_url,
                payload=payload,
                sha256=validated_pdf.sha256,
                byte_size=validated_pdf.byte_size,
                media_type=validated_pdf.media_type,
            )
        )
        if self.failure is not None:
            raise self.failure
        return cast(
            PrimaryPdfPublicationResult,
            self.result_factory(expected_facts, validated_pdf, provenance, source_url),
        )


@dataclass(frozen=True, slots=True)
class _FileSnapshot:
    metadata: os.stat_result
    digest: bytes
    mode: int


def _snapshot(path: Path) -> _FileSnapshot:
    metadata = path.stat()
    return _FileSnapshot(
        metadata=metadata,
        digest=hashlib.sha256(path.read_bytes()).digest(),
        mode=stat.S_IMODE(metadata.st_mode),
    )


class ManualPdfAdmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._sandbox = TemporaryDirectory(prefix="sciretriever-a4-tests-")
        self.sandbox = Path(self._sandbox.name)
        self.stage_parent = self.sandbox / "staging-parent"
        self.stage_parent.mkdir(mode=0o700)
        self.staging = SystemPdfValidationStaging(parent=self.stage_parent)

    def tearDown(self) -> None:
        try:
            self.assertEqual(tuple(self.stage_parent.iterdir()), ())
        finally:
            self._sandbox.cleanup()

    def _service(
        self,
        publisher: _RecordingPublisher,
        *,
        max_pdf_bytes: int = 1024 * 1024,
        provenance_id_factory: Callable[[], ProvenanceId] | None = None,
        clock: Callable[[], UtcTimestamp] | None = None,
    ) -> ManualPdfAdmissionService:
        return ManualPdfAdmissionService(
            publication_port=publisher,
            staging=self.staging,
            provenance_id_factory=provenance_id_factory or (lambda: ProvenanceId(_uuid(400))),
            clock=clock or (lambda: _TIMESTAMP),
            max_pdf_bytes=max_pdf_bytes,
        )

    def _assert_file_unchanged(self, path: Path, before: _FileSnapshot) -> None:
        after = path.stat()
        self.assertTrue(os.path.samestat(before.metadata, after))
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), before.digest)
        self.assertEqual(stat.S_IMODE(after.st_mode), before.mode)

    def test_valid_one_page_pdf_uses_manual_candidate_neutral_publication(self) -> None:
        payload = _pdf_bytes()
        source = _ReadOnlyTrap(payload)
        publisher = _RecordingPublisher()
        service = self._service(publisher)

        accepted = service.accept_manual_pdf(
            expected_facts=_expected(),
            current_assets=(),
            source=source,
        )

        self.assertIsInstance(accepted, AcceptedManualPdf)
        self.assertEqual(len(publisher.calls), 1)
        call = publisher.calls[0]
        self.assertEqual(call.expected_facts, _expected())
        self.assertEqual(call.payload, payload)
        self.assertEqual(call.sha256, sha256_digest(payload))
        self.assertEqual(call.byte_size, len(payload))
        self.assertEqual(call.media_type, "application/pdf")
        self.assertIs(call.provenance.source_kind, SourceKind.USER)
        self.assertEqual(call.provenance.source_name, "manual-pdf")
        self.assertIsNone(call.provenance.source_record_id)
        self.assertEqual(call.provenance.observed_at, _TIMESTAMP)
        self.assertEqual(call.provenance.input_sha256, call.sha256)
        self.assertIsNone(call.provenance.parameters_sha256)
        self.assertIsNone(call.source_url)
        self.assertEqual(accepted.asset.sha256, call.sha256)
        self.assertEqual(accepted.relation.provenance, call.provenance)
        self.assertTrue(source.requests)
        self.assertTrue(all(0 < size <= 1024 * 1024 for size in source.requests))

    def test_reader_has_no_path_or_automatic_candidate_surface(self) -> None:
        payload = _pdf_bytes()
        source = _ReadOnlyTrap(payload)
        publisher = _RecordingPublisher()
        service = self._service(publisher)

        accepted = service.accept_manual_pdf(
            expected_facts=_expected(),
            current_assets=(),
            source=source,
        )

        rendered = accepted.model_dump_json() + repr(publisher.calls)
        self.assertNotIn(source.private_locator, rendered)
        self.assertNotIn("path", inspect.signature(service.accept_manual_pdf).parameters)
        self.assertFalse(hasattr(accepted, "candidate_key"))
        self.assertFalse(hasattr(accepted, "acquisition_path"))
        for forbidden in ("PdfCandidate", "AcquisitionPath", "TemporaryPdf", "NoPrimaryPdf"):
            self.assertNotIn(forbidden, manual_module.__dict__)

    def test_owner_only_stage_and_caller_owned_file_are_preserved(self) -> None:
        payload = _pdf_bytes()
        user_path = self.sandbox / "manual-secret-original.pdf"
        user_path.write_bytes(payload)
        user_path.chmod(0o640)
        before = _snapshot(user_path)

        def inspect_stage(validated_pdf: ValidatedPdf) -> None:
            self.assertFalse(validated_pdf.closed)
            roots = tuple(self.stage_parent.iterdir())
            self.assertEqual(len(roots), 1)
            root = roots[0]
            directories = (root, root / "root", root / "root" / ".staging")
            files = tuple(directories[-1].iterdir())
            self.assertEqual(len(files), 1)
            for directory in directories:
                metadata = directory.stat()
                self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o700)
                self.assertEqual(metadata.st_uid, os.geteuid())
            metadata = files[0].stat()
            self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
            self.assertEqual(metadata.st_uid, os.geteuid())
            self.assertNotIn(user_path.name, files[0].name)

        publisher = _RecordingPublisher(on_publish=inspect_stage)
        with user_path.open("rb") as source:
            accepted = self._service(publisher).accept_manual_pdf(
                expected_facts=_expected(),
                current_assets=(),
                source=source,
            )
            self.assertFalse(source.closed)

        self._assert_file_unchanged(user_path, before)
        self.assertNotIn(str(user_path), accepted.model_dump_json())
        self.assertEqual(tuple(self.stage_parent.iterdir()), ())

    def test_existing_primary_rejects_before_source_factories_or_staging(self) -> None:
        payload = _pdf_bytes()
        source = _ReadOnlyTrap(payload)
        publisher = _RecordingPublisher()
        factory_calls = 0
        clock_calls = 0

        def provenance_id_factory() -> ProvenanceId:
            nonlocal factory_calls
            factory_calls += 1
            return ProvenanceId(_uuid(401))

        def clock() -> UtcTimestamp:
            nonlocal clock_calls
            clock_calls += 1
            return _TIMESTAMP

        service = self._service(
            publisher,
            provenance_id_factory=provenance_id_factory,
            clock=clock,
        )
        with self.assertRaises(ManualPdfInputError) as raised:
            service.accept_manual_pdf(
                expected_facts=_expected(),
                current_assets=(_current_relation(),),
                source=source,
            )

        self.assertEqual(raised.exception.failure.code, "manual-pdf-target-has-primary")
        self.assertEqual(source.requests, [])
        self.assertEqual(factory_calls, 0)
        self.assertEqual(clock_calls, 0)
        self.assertEqual(publisher.calls, [])
        self.assertEqual(tuple(self.stage_parent.iterdir()), ())

    def test_invalid_pdf_matrix_is_normal_input_rejection(self) -> None:
        valid = _pdf_bytes()
        cases = (
            ("empty", b"", 1024 * 1024),
            ("html", b"<html>access denied</html>", 1024 * 1024),
            ("corrupt", valid[:-20], 1024 * 1024),
            ("encrypted", _pdf_bytes(encrypted=True), 1024 * 1024),
            ("zero-page", _pdf_bytes(pages=0), 1024 * 1024),
            ("over-budget", valid, len(valid) - 1),
        )
        for name, payload, budget in cases:
            with self.subTest(name=name):
                source = io.BytesIO(payload)
                publisher = _RecordingPublisher()
                with self.assertRaises(ManualPdfInputError) as raised:
                    self._service(publisher, max_pdf_bytes=budget).accept_manual_pdf(
                        expected_facts=_expected(),
                        current_assets=(),
                        source=source,
                    )
                self.assertEqual(raised.exception.failure.code, "manual-pdf-invalid")
                self.assertFalse(source.closed)
                self.assertEqual(publisher.calls, [])
                self.assertEqual(tuple(self.stage_parent.iterdir()), ())

    def test_reader_error_is_stable_rejection_without_private_diagnostics(self) -> None:
        publisher = _RecordingPublisher()
        with self.assertRaises(ManualPdfInputError) as raised:
            self._service(publisher).accept_manual_pdf(
                expected_facts=_expected(),
                current_assets=(),
                source=_ExplodingReader(),
            )

        rendered = (
            f"{raised.exception!s} {raised.exception!r} "
            f"{raised.exception.failure.model_dump_json()}"
        )
        for private in (
            "/private/user/manual-secret-paper.pdf",
            "provider.test",
            "runtime-secret",
            "PRIVATE-PDF-BYTES",
        ):
            self.assertNotIn(private, rendered)
        self.assertEqual(raised.exception.failure.code, "manual-pdf-invalid")
        self.assertEqual(publisher.calls, [])

    def test_cancellation_propagates_and_cleans_internal_stage(self) -> None:
        event = threading.Event()
        publisher = _RecordingPublisher()
        with self.assertRaises(PdfValidationCancelled):
            self._service(publisher).accept_manual_pdf(
                expected_facts=_expected(),
                current_assets=(),
                source=_CancelDuringRead(event, _pdf_bytes()),
                cancel_event=event,
            )
        self.assertEqual(publisher.calls, [])
        self.assertEqual(tuple(self.stage_parent.iterdir()), ())

    def test_staging_failure_is_a_system_failure(self) -> None:
        publisher = _RecordingPublisher()
        with mock.patch.object(
            manual_module,
            "validate_pdf",
            side_effect=PdfValidationStagingError(),
        ):
            with self.assertRaises(AcquisitionFailure) as raised:
                self._service(publisher).accept_manual_pdf(
                    expected_facts=_expected(),
                    current_assets=(),
                    source=_ReadOnlyTrap(_pdf_bytes()),
                )
        self.assertEqual(raised.exception.failure.code, "manual-pdf-staging-failed")
        self.assertEqual(publisher.calls, [])

    def test_validation_contract_error_is_not_an_input_rejection(self) -> None:
        publisher = _RecordingPublisher()
        with mock.patch.object(
            manual_module,
            "validate_pdf",
            side_effect=PdfValidationError(PdfValidationCode.ASSOCIATION_NOT_ESTABLISHED),
        ):
            with self.assertRaises(AcquisitionFailure) as raised:
                self._service(publisher).accept_manual_pdf(
                    expected_facts=_expected(),
                    current_assets=(),
                    source=_ReadOnlyTrap(_pdf_bytes()),
                )
        self.assertEqual(raised.exception.failure.code, "manual-pdf-validation-contract")
        self.assertEqual(publisher.calls, [])

    def test_a3_stale_failure_propagates_and_stage_is_cleaned(self) -> None:
        marker = _system_failure("fixture-stale-current-facts")
        publisher = _RecordingPublisher(failure=marker)
        source = io.BytesIO(_pdf_bytes())
        with self.assertRaises(AcquisitionFailure) as raised:
            self._service(publisher).accept_manual_pdf(
                expected_facts=_expected(),
                current_assets=(),
                source=source,
            )

        self.assertIs(raised.exception, marker)
        self.assertEqual(len(publisher.calls), 1)
        self.assertFalse(source.closed)
        self.assertEqual(tuple(self.stage_parent.iterdir()), ())

    def test_unexpected_publication_failure_is_redacted_system_failure(self) -> None:
        marker = RuntimeError(
            "/private/user/manual-secret.pdf token=runtime-secret PRIVATE-PDF-BYTES"
        )
        publisher = _RecordingPublisher(failure=marker)
        with self.assertRaises(AcquisitionFailure) as raised:
            self._service(publisher).accept_manual_pdf(
                expected_facts=_expected(),
                current_assets=(),
                source=io.BytesIO(_pdf_bytes()),
            )

        rendered = f"{raised.exception!s} {raised.exception!r} {raised.exception.failure!r}"
        for private in ("/private/user", "runtime-secret", "PRIVATE-PDF-BYTES"):
            self.assertNotIn(private, rendered)
        self.assertEqual(raised.exception.failure.code, "manual-pdf-publication-failed")
        self.assertEqual(tuple(self.stage_parent.iterdir()), ())

    def test_publication_result_contract_violations_fail_closed(self) -> None:
        def wrong_object(
            _expected_facts: AcquisitionExpectedFacts,
            _validated_pdf: ValidatedPdf,
            _provenance: Provenance,
            _source_url: str | None,
        ) -> object:
            return object()

        def wrong_literature(
            expected_facts: AcquisitionExpectedFacts,
            validated_pdf: ValidatedPdf,
            provenance: Provenance,
            source_url: str | None,
        ) -> object:
            result = _publication_result(
                expected_facts,
                validated_pdf,
                provenance,
                source_url,
            )
            relation = result.relation.model_copy(update={"literature_id": _OTHER_LITERATURE_ID})
            return PrimaryPdfPublicationResult(asset=result.asset, relation=relation)

        for name, factory in (
            ("wrong-object", wrong_object),
            ("wrong-literature", wrong_literature),
        ):
            with self.subTest(name=name):
                publisher = _RecordingPublisher(result_factory=factory)
                with self.assertRaises(AcquisitionFailure) as raised:
                    self._service(publisher).accept_manual_pdf(
                        expected_facts=_expected(),
                        current_assets=(),
                        source=io.BytesIO(_pdf_bytes()),
                    )
                self.assertEqual(raised.exception.failure.code, "manual-pdf-publication-contract")
                self.assertEqual(tuple(self.stage_parent.iterdir()), ())

    def test_provenance_factory_contract_failure_cleans_validated_stage(self) -> None:
        publisher = _RecordingPublisher()
        service = self._service(
            publisher,
            provenance_id_factory=lambda: cast(ProvenanceId, "not-a-provenance-id"),
        )
        with self.assertRaises(AcquisitionFailure) as raised:
            service.accept_manual_pdf(
                expected_facts=_expected(),
                current_assets=(),
                source=io.BytesIO(_pdf_bytes()),
            )

        self.assertEqual(raised.exception.failure.code, "manual-pdf-contract")
        self.assertEqual(publisher.calls, [])
        self.assertEqual(tuple(self.stage_parent.iterdir()), ())


if __name__ == "__main__":
    unittest.main()
