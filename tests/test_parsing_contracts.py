from __future__ import annotations

import dataclasses
import io
import threading
import unittest
from contextlib import AbstractContextManager, closing
from dataclasses import replace
from typing import BinaryIO, cast

from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserRequest,
    ParserResource,
    ParserResult,
    StorageObjectRef,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.parsing.api import ParsingApi, PreparedParsing
from sciretriever.parsing.ports import (
    ParserArtifactContent,
    ParserPort,
    ParserResultPublicationCommand,
    ParserResultStorePort,
    ParsingFailure,
    StagedParserArtifact,
    StagedParserOutput,
    StagedParserResource,
)
from sciretriever.parsing.rules import ParserStructureError, prepare_parser_result
from sciretriever.parsing.service import ParsingService

_ASSET_ID = AssetId("00000001-e89b-12d3-a456-426614174000")
_OTHER_ASSET_ID = AssetId("00000002-e89b-12d3-a456-426614174000")
_PROVENANCE_ID = ProvenanceId("00000003-e89b-12d3-a456-426614174000")
_REPLAY_PROVENANCE_ID = ProvenanceId("00000004-e89b-12d3-a456-426614174000")
_TIME = UtcTimestamp("2026-08-12T00:00:00Z")
_REPLAY_TIME = UtcTimestamp("2026-08-12T00:00:01Z")
_PDF_BYTES = b"%PDF-1.7\nfixture"
_PNG = b"\x89PNG\r\n\x1a\nfixture-image"
_PDF_SHA256 = sha256_digest(_PDF_BYTES)
_PARAMETERS_SHA256 = sha256_digest(b"fake-parser-1.0\x00fixture-rules-v1")
_SECRET_PATH = "/private/users/alice/parser/runtime/output.md"
_SECRET_URL = "https://parser.test/tasks/private-task-token"


class _BytesContent:
    def __init__(self, payload: bytes, *, private_path: str = _SECRET_PATH) -> None:
        self._payload = payload
        self._private_path = private_path
        self.open_calls = 0

    def open(self) -> AbstractContextManager[BinaryIO]:
        self.open_calls += 1
        return closing(io.BytesIO(self._payload))

    def __repr__(self) -> str:
        return f"_BytesContent(private_path={self._private_path!r})"


class _BrokenContent:
    def open(self) -> AbstractContextManager[BinaryIO]:
        raise OSError(f"cannot read {_SECRET_PATH} from {_SECRET_URL}")


class _DiscardableContent(_BytesContent):
    def __init__(
        self,
        payload: bytes,
        *,
        cancel_on_open: threading.Event | None = None,
    ) -> None:
        super().__init__(payload)
        self.cancel_on_open = cancel_on_open
        self.discard_calls = 0

    def open(self) -> AbstractContextManager[BinaryIO]:
        if self.cancel_on_open is not None:
            self.cancel_on_open.set()
        return super().open()

    def discard(self) -> None:
        if self.discard_calls == 0:
            self.discard_calls = 1


def _artifact(
    payload: bytes,
    media_type: str,
    *,
    content: ParserArtifactContent | None = None,
) -> StagedParserArtifact:
    return StagedParserArtifact(
        artifact=ParserArtifactRef(
            sha256=sha256_digest(payload),
            media_type=media_type,
            byte_size=len(payload),
        ),
        content=_BytesContent(payload) if content is None else content,
    )


def _provenance(*, input_sha256: Sha256 = _PDF_SHA256) -> ParserProvenance:
    return ParserProvenance(
        provenance=Provenance(
            provenance_id=_PROVENANCE_ID,
            source_kind=SourceKind.PARSER,
            source_name="fake-parser",
            source_record_id=None,
            observed_at=_TIME,
            input_sha256=input_sha256,
            parameters_sha256=_PARAMETERS_SHA256,
        ),
        parser_version="1.0",
        mode="fixture",
        model_identity=None,
    )


def _request(*, content: StorageObjectRef | None = None) -> ParserRequest:
    return ParserRequest(
        source_asset_id=_ASSET_ID,
        source_sha256=_PDF_SHA256,
        media_type="application/pdf",
        content_ref=_BytesContent(_PDF_BYTES) if content is None else content,
    )


def _output(
    request: ParserRequest,
    *,
    markdown_bytes: bytes = b"# Parsed\n\nBody ![figure](resources/figure.png)\n",
    resource_bytes: bytes = _PNG,
) -> StagedParserOutput:
    resource = StagedParserResource(
        reference="resources/figure.png",
        artifact=_artifact(resource_bytes, "image/png"),
    )
    return StagedParserOutput(
        source_asset_id=request.source_asset_id,
        source_sha256=request.source_sha256,
        page_count=2,
        markdown=_artifact(markdown_bytes, "text/markdown"),
        resources=(resource,),
        provenance=_provenance(input_sha256=request.source_sha256),
    )


def _result(
    request: ParserRequest,
    *,
    markdown_bytes: bytes = b"# Old parser result\n",
) -> ParserResult:
    markdown = ParserArtifactRef(
        sha256=sha256_digest(markdown_bytes),
        media_type="text/markdown",
        byte_size=len(markdown_bytes),
    )
    provenance = _provenance(input_sha256=request.source_sha256)
    result_sha256 = parser_result_sha256(
        source_asset_id=request.source_asset_id,
        source_sha256=request.source_sha256,
        page_count=1,
        markdown=markdown,
        resources=(),
        provenance=provenance,
    )
    return ParserResult(
        source_asset_id=request.source_asset_id,
        source_sha256=request.source_sha256,
        page_count=1,
        markdown=markdown,
        resources=(),
        result_sha256=result_sha256,
        provenance=provenance,
    )


def _with_new_attempt_identity(result: ParserResult) -> ParserResult:
    parser_provenance = result.provenance
    shared = parser_provenance.provenance
    replay_provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=_REPLAY_PROVENANCE_ID,
            source_kind=shared.source_kind,
            source_name=shared.source_name,
            source_record_id=shared.source_record_id,
            observed_at=_REPLAY_TIME,
            input_sha256=shared.input_sha256,
            parameters_sha256=shared.parameters_sha256,
        ),
        parser_version=parser_provenance.parser_version,
        mode=parser_provenance.mode,
        model_identity=parser_provenance.model_identity,
    )
    return ParserResult(
        source_asset_id=result.source_asset_id,
        source_sha256=result.source_sha256,
        page_count=result.page_count,
        markdown=result.markdown,
        resources=result.resources,
        result_sha256=result.result_sha256,
        provenance=replay_provenance,
    )


class _FakeParser:
    def __init__(self, output: object) -> None:
        self.output = output
        self.calls: list[ParserRequest] = []
        self.cancel_events: list[threading.Event | None] = []

    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        self.calls.append(request)
        self.cancel_events.append(cancel_event)
        if isinstance(self.output, BaseException):
            raise self.output
        return cast(StagedParserOutput, self.output)


class _UnexpectedFallbackParser:
    def __init__(self) -> None:
        self.calls = 0

    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        del request
        del cancel_event
        self.calls += 1
        raise AssertionError("a fallback parser must never run")


class _CancelDuringParser:
    def __init__(self, output: StagedParserOutput) -> None:
        self.output = output
        self.calls = 0

    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        del request
        self.calls += 1
        if cancel_event is None:
            raise AssertionError("Parser did not receive the cancellation event")
        cancel_event.set()
        return self.output


class _FakeStore:
    def __init__(
        self,
        *,
        matches: tuple[object, ...] = (True, True),
        current_result: ParserResult | None = None,
        publication_error: BaseException | None = None,
        publication_result: object | None = None,
    ) -> None:
        self._matches = list(matches)
        self.current_result = current_result
        self.publication_error = publication_error
        self.publication_result = publication_result
        self.match_calls: list[tuple[AssetId, Sha256]] = []
        self.publication_calls: list[ParserResultPublicationCommand] = []
        self.read_calls: list[AssetId] = []
        self.primary_pdf_preserved = True
        self.cleanup_calls = 0

    def current_primary_matches(
        self,
        source_asset_id: AssetId,
        source_sha256: Sha256,
    ) -> bool:
        self.match_calls.append((source_asset_id, source_sha256))
        if not self._matches:
            raise AssertionError("unexpected current-primary recheck")
        value = self._matches.pop(0)
        if isinstance(value, BaseException):
            raise value
        return cast(bool, value)

    def publish_current(self, command: ParserResultPublicationCommand) -> ParserResult:
        self.publication_calls.append(command)
        if self.publication_error is not None:
            raise self.publication_error
        if self.publication_result is not None:
            return cast(ParserResult, self.publication_result)
        self.current_result = command.result
        return command.result

    def read_current(self, source_asset_id: AssetId) -> ParserResult | None:
        self.read_calls.append(source_asset_id)
        return self.current_result

    def cleanup_primary_pdf_or_old_result(self) -> None:
        self.cleanup_calls += 1
        self.primary_pdf_preserved = False
        self.current_result = None


def _service(
    parser: object,
    store: object,
) -> ParsingService:
    return ParsingService(
        parser=cast(ParserPort, parser),
        result_store=cast(ParserResultStorePort, store),
    )


def _rendered_failure(error: ParsingFailure) -> str:
    return f"{error!s} {error!r} {error.failure.model_dump_json()}"


def _prepare_and_commit(
    service: ParsingService,
    request: ParserRequest,
    *,
    cancel_event: threading.Event | None = None,
) -> ParserResult:
    prepared = service.prepare_current_primary(request, cancel_event=cancel_event)
    return service.commit_current_primary(prepared)


def _content_bytes(content: ParserArtifactContent) -> bytes:
    with content.open() as stream:
        return stream.read()


class ParsingContractsTests(unittest.TestCase):
    def test_parser_request_is_fixed_pdf_only_and_exposes_no_storage_path(self) -> None:
        content = _BytesContent(_PDF_BYTES)
        request = _request(content=content)

        self.assertEqual(
            tuple(field.name for field in dataclasses.fields(ParserRequest)),
            ("source_asset_id", "source_sha256", "media_type", "content_ref"),
        )
        self.assertEqual(request.source_asset_id, _ASSET_ID)
        self.assertEqual(request.source_sha256, _PDF_SHA256)
        self.assertEqual(request.media_type, "application/pdf")
        self.assertIs(request.content_ref, content)
        self.assertIsInstance(content, ParserArtifactContent)
        self.assertNotIn(_SECRET_PATH, repr(request))
        self.assertFalse(hasattr(request, "path"))

        with self.assertRaises((TypeError, ValueError)):
            ParserRequest(
                source_asset_id=_ASSET_ID,
                source_sha256=_PDF_SHA256,
                media_type="text/html",
                content_ref=content,
            )
        with self.assertRaises((TypeError, ValueError)):
            ParserRequest(
                source_asset_id=_ASSET_ID,
                source_sha256=_PDF_SHA256,
                media_type="application/pdf",
                content_ref=cast(StorageObjectRef, _SECRET_PATH),
            )

    def test_parser_and_store_ports_are_runtime_checkable_and_parser_is_singular(self) -> None:
        request = _request()
        parser = _FakeParser(_output(request))
        store = _FakeStore()

        self.assertIsInstance(parser, ParserPort)
        self.assertIsInstance(store, ParserResultStorePort)
        with self.assertRaises(TypeError):
            ParsingService(
                parser=cast(ParserPort, (parser, _UnexpectedFallbackParser())),
                result_store=store,
            )

        result = _prepare_and_commit(_service(parser, store), request)

        self.assertIsInstance(result, ParserResult)
        self.assertEqual(parser.calls, [request])
        self.assertEqual(len(store.publication_calls), 1)

    def test_fake_parser_markdown_and_resources_form_one_neutral_result(self) -> None:
        request = _request()
        output = _output(request)
        parser = _FakeParser(output)
        store = _FakeStore()
        api = ParsingApi(_service(parser, store))

        prepared = api.prepare_current_primary(request)
        self.assertIsInstance(prepared, PreparedParsing)
        self.assertEqual(store.publication_calls, [])
        result = api.commit_current_primary(prepared)

        self.assertEqual(result.source_asset_id, request.source_asset_id)
        self.assertEqual(result.source_sha256, request.source_sha256)
        self.assertEqual(result.page_count, 2)
        self.assertEqual(result.markdown, output.markdown.artifact)
        self.assertEqual(
            result.resources,
            (
                ParserResource(
                    reference=output.resources[0].reference,
                    artifact=output.resources[0].artifact.artifact,
                ),
            ),
        )
        self.assertEqual(result.provenance, output.provenance)
        self.assertEqual(
            result.result_sha256,
            parser_result_sha256(
                source_asset_id=result.source_asset_id,
                source_sha256=result.source_sha256,
                page_count=result.page_count,
                markdown=result.markdown,
                resources=result.resources,
                provenance=result.provenance,
            ),
        )
        self.assertEqual(store.match_calls, [(_ASSET_ID, _PDF_SHA256)] * 2)
        self.assertEqual(parser.calls, [request])
        self.assertEqual(api.read_current_result(_ASSET_ID), result)
        self.assertEqual(store.read_calls, [_ASSET_ID])
        self.assertFalse(hasattr(result, "markdown_text"))
        self.assertFalse(hasattr(result, "content_decision"))
        self.assertFalse(hasattr(result, "references"))

        command = store.publication_calls[0]
        self.assertIsNot(command.markdown.content, output.markdown.content)
        self.assertIsNot(
            command.resources[0].artifact.content,
            output.resources[0].artifact.content,
        )
        self.assertEqual(
            (_content_bytes(command.markdown.content),) * 2,
            (
                _content_bytes(command.markdown.content),
                _content_bytes(command.markdown.content),
            ),
        )
        self.assertEqual(
            _content_bytes(command.resources[0].artifact.content),
            _PNG,
        )
        self.assertNotIn(_SECRET_PATH, repr(command.markdown.content))
        self.assertNotIn(_SECRET_PATH, repr(command.resources[0].artifact.content))

    def test_prepared_handle_is_opaque_service_bound_and_single_consume(self) -> None:
        request = _request()
        first_store = _FakeStore()
        first = _service(_FakeParser(_output(request)), first_store)
        second = _service(_FakeParser(_output(request)), _FakeStore())

        prepared = first.prepare_current_primary(request)

        self.assertEqual(first_store.publication_calls, [])
        self.assertEqual(repr(prepared), "<PreparedParsing>")
        self.assertEqual(prepared.__slots__, ("__weakref__",))
        self.assertFalse(hasattr(prepared, "result"))
        self.assertFalse(hasattr(prepared, "command"))
        self.assertFalse(hasattr(prepared, "resources"))
        self.assertFalse(hasattr(prepared, "task_id"))
        with self.assertRaises(TypeError):
            prepared.__reduce__()
        with self.assertRaises(ParsingFailure) as crossed:
            second.commit_current_primary(prepared)
        self.assertEqual(crossed.exception.failure.code, "parsing-port-contract")

        committed = first.commit_current_primary(prepared)
        self.assertIsInstance(committed, ParserResult)
        self.assertEqual(len(first_store.publication_calls), 1)
        with self.assertRaises(ParsingFailure) as consumed:
            first.commit_current_primary(prepared)
        self.assertEqual(consumed.exception.failure.code, "parsing-port-contract")
        with self.assertRaises(ParsingFailure) as forged:
            first.commit_current_primary(PreparedParsing())
        self.assertEqual(forged.exception.failure.code, "parsing-port-contract")

    def test_discard_is_idempotent_and_commit_after_discard_is_rejected(self) -> None:
        request = _request()
        output = _output(request)
        markdown_content = _DiscardableContent(_content_bytes(output.markdown.content))
        resource_content = _DiscardableContent(_PNG)
        staged = replace(
            output,
            markdown=_artifact(
                _content_bytes(output.markdown.content),
                "text/markdown",
                content=markdown_content,
            ),
            resources=(
                replace(
                    output.resources[0],
                    artifact=_artifact(
                        _PNG,
                        "image/png",
                        content=resource_content,
                    ),
                ),
            ),
        )
        store = _FakeStore()
        service = _service(_FakeParser(staged), store)

        prepared = service.prepare_current_primary(request)
        self.assertEqual(markdown_content.discard_calls, 1)
        self.assertEqual(resource_content.discard_calls, 1)
        service.discard_prepared(prepared)
        service.discard_prepared(prepared)

        self.assertEqual(store.publication_calls, [])
        with self.assertRaises(ParsingFailure) as raised:
            service.commit_current_primary(prepared)
        self.assertEqual(raised.exception.failure.code, "parsing-port-contract")

    def test_cancellation_before_parser_during_parser_and_after_parser_never_publishes(
        self,
    ) -> None:
        request = _request()

        before_event = threading.Event()
        before_event.set()
        before_parser = _FakeParser(_output(request))
        before_store = _FakeStore()
        with self.assertRaises(ParsingFailure) as before:
            _service(before_parser, before_store).prepare_current_primary(
                request,
                cancel_event=before_event,
            )
        self.assertEqual(before.exception.failure.code, "parsing-cancelled")
        self.assertEqual(before_parser.calls, [])
        self.assertEqual(before_store.publication_calls, [])

        during_event = threading.Event()
        during_store = _FakeStore()
        during_parser = _CancelDuringParser(_output(request))
        with self.assertRaises(ParsingFailure) as during:
            _service(during_parser, during_store).prepare_current_primary(
                request,
                cancel_event=during_event,
            )
        self.assertEqual(during.exception.failure.code, "parsing-cancelled")
        self.assertEqual(during_parser.calls, 1)
        self.assertEqual(during_store.publication_calls, [])

        after_event = threading.Event()
        after_output = _output(request)
        markdown_payload = _content_bytes(after_output.markdown.content)
        cleanup = _DiscardableContent(markdown_payload, cancel_on_open=after_event)
        after_output = replace(
            after_output,
            markdown=_artifact(
                markdown_payload,
                "text/markdown",
                content=cleanup,
            ),
        )
        after_store = _FakeStore()
        after_parser = _FakeParser(after_output)
        with self.assertRaises(ParsingFailure) as after:
            _service(after_parser, after_store).prepare_current_primary(
                request,
                cancel_event=after_event,
            )
        self.assertEqual(after.exception.failure.code, "parsing-cancelled")
        self.assertEqual(after_parser.cancel_events, [after_event])
        self.assertEqual(cleanup.discard_calls, 1)
        self.assertEqual(after_store.publication_calls, [])

    def test_service_rejects_invalid_resource_media_without_replacing_current_facts(self) -> None:
        request = _request()
        invalid_signature = _output(request, resource_bytes=b"PNG fixture")
        valid = _output(request)
        extension_media_mismatch = replace(
            valid,
            markdown=_artifact(
                b"# Parsed\n\nBody ![figure](resources/figure.jpg)\n",
                "text/markdown",
            ),
            resources=(replace(valid.resources[0], reference="resources/figure.jpg"),),
        )

        for label, staged in (
            ("invalid-signature", invalid_signature),
            ("extension-media-mismatch", extension_media_mismatch),
        ):
            with self.subTest(label=label):
                with self.assertRaises(ParserStructureError) as direct:
                    prepare_parser_result(request, staged)
                self.assertEqual(str(direct.exception), "staged parser output is invalid")
                self.assertNotIn(_SECRET_PATH, repr(direct.exception))
                self.assertNotIn("PNG fixture", repr(direct.exception))

                old = _result(request)
                parser = _FakeParser(staged)
                store = _FakeStore(matches=(True,), current_result=old)
                with self.assertRaises(ParsingFailure) as raised:
                    _service(parser, store).prepare_current_primary(request)

                self.assertEqual(raised.exception.failure.code, "parsing-structure-invalid")
                self.assertEqual(parser.calls, [request])
                self.assertEqual(store.match_calls, [(_ASSET_ID, _PDF_SHA256)])
                self.assertEqual(store.publication_calls, [])
                self.assertEqual(store.current_result, old)
                self.assertTrue(store.primary_pdf_preserved)
                self.assertEqual(store.cleanup_calls, 0)
                rendered = _rendered_failure(raised.exception)
                self.assertNotIn(_SECRET_PATH, rendered)
                self.assertNotIn(_SECRET_URL, rendered)
                self.assertNotIn("PNG fixture", rendered)

    def test_markdown_local_reference_set_must_exactly_match_declared_resources(self) -> None:
        request = _request()
        valid = _output(request)
        declared_other = replace(valid.resources[0], reference="resources/other.png")
        cases = (
            (
                "missing-resource",
                replace(valid, resources=()),
            ),
            (
                "unreferenced-resource",
                replace(
                    valid,
                    markdown=_artifact(b"# Parsed without a local resource\n", "text/markdown"),
                ),
            ),
            (
                "set-mismatch",
                replace(valid, resources=(declared_other,)),
            ),
            (
                "noncanonical-reference",
                replace(
                    valid,
                    markdown=_artifact(
                        b"![figure](./resources/figure.png)\n",
                        "text/markdown",
                    ),
                ),
            ),
            (
                "external-resource",
                replace(
                    valid,
                    markdown=_artifact(
                        b"![private](https://example.invalid/private.png)\n",
                        "text/markdown",
                    ),
                    resources=(),
                ),
            ),
            (
                "encoded-escape",
                replace(
                    valid,
                    markdown=_artifact(
                        b"![private](%252e%252e/private.png)\n",
                        "text/markdown",
                    ),
                    resources=(),
                ),
            ),
            (
                "html-prefixed-src-bypass",
                replace(
                    valid,
                    markdown=_artifact(
                        b'<img data-src="resources/figure.png" src="../../escape.png">\n',
                        "text/markdown",
                    ),
                ),
            ),
            (
                "html-source-prefixed-src-bypass",
                replace(
                    valid,
                    markdown=_artifact(
                        b'<source data-src="resources/figure.png" '
                        b'src="https://external.invalid/x.png">\n',
                        "text/markdown",
                    ),
                ),
            ),
            (
                "html-quoted-attribute-src-bypass",
                replace(
                    valid,
                    markdown=_artifact(
                        b'<img title=\'literal src="safe.png"\' src="../../escape.png">\n',
                        "text/markdown",
                    ),
                ),
            ),
            (
                "html-duplicate-src",
                replace(
                    valid,
                    markdown=_artifact(
                        b'<img src="resources/figure.png" SRC="resources/other.png">\n',
                        "text/markdown",
                    ),
                ),
            ),
        )

        for label, staged in cases:
            with self.subTest(label=label):
                with self.assertRaises(ParserStructureError):
                    prepare_parser_result(request, staged)

                old = _result(request)
                parser = _FakeParser(staged)
                store = _FakeStore(matches=(True,), current_result=old)
                with self.assertRaises(ParsingFailure) as raised:
                    _service(parser, store).prepare_current_primary(request)
                self.assertEqual(raised.exception.failure.code, "parsing-structure-invalid")
                self.assertEqual(parser.calls, [request])
                self.assertEqual(store.match_calls, [(_ASSET_ID, _PDF_SHA256)])
                self.assertEqual(store.publication_calls, [])
                self.assertEqual(store.current_result, old)
                self.assertTrue(store.primary_pdf_preserved)
                self.assertEqual(store.cleanup_calls, 0)
                rendered = _rendered_failure(raised.exception)
                self.assertNotIn(_SECRET_PATH, rendered)
                self.assertNotIn(_SECRET_URL, rendered)
                self.assertNotIn("example.invalid", rendered)
                self.assertNotIn("%252e%252e", rendered)
                self.assertNotIn("resources/other.png", rendered)

        data_src_only = replace(
            valid,
            markdown=_artifact(
                b'<img data-src="resources/figure.png" xlink:src="resources/other.png">\n',
                "text/markdown",
            ),
            resources=(),
        )
        store = _FakeStore()
        result = _prepare_and_commit(_service(_FakeParser(data_src_only), store), request)
        self.assertEqual(result.resources, ())
        self.assertEqual(len(store.publication_calls), 1)

        for boolean_attribute in ("hidden", "ismap"):
            with self.subTest(boolean_attribute=boolean_attribute):
                boolean_before_src = _output(
                    request,
                    markdown_bytes=(
                        f'<img {boolean_attribute} src="resources/figure.png">\n'.encode()
                    ),
                )
                store = _FakeStore()
                result = _prepare_and_commit(
                    _service(_FakeParser(boolean_before_src), store),
                    request,
                )
                self.assertEqual(
                    tuple(resource.reference for resource in result.resources),
                    ("resources/figure.png",),
                )
                self.assertEqual(len(store.publication_calls), 1)

        repeated = replace(
            valid,
            markdown=_artifact(
                b"![first](resources/figure.png)\n![second](resources/figure.png)\n",
                "text/markdown",
            ),
        )
        store = _FakeStore()
        result = _prepare_and_commit(_service(_FakeParser(repeated), store), request)
        self.assertEqual(
            tuple(resource.reference for resource in result.resources),
            ("resources/figure.png",),
        )
        self.assertEqual(len(store.publication_calls), 1)

    def test_markdown_bytes_must_be_nonempty_utf8_and_match_their_artifact(self) -> None:
        request = _request()
        valid = _output(request)
        wrong_hash = replace(
            valid.markdown,
            artifact=valid.markdown.artifact.model_copy(
                update={"sha256": sha256_digest(b"different bytes")}
            ),
        )
        wrong_size = replace(
            valid.markdown,
            artifact=valid.markdown.artifact.model_copy(
                update={"byte_size": valid.markdown.artifact.byte_size + 1}
            ),
        )
        wrong_media = replace(
            valid.markdown,
            artifact=valid.markdown.artifact.model_copy(update={"media_type": "text/plain"}),
        )
        cases = (
            replace(valid, markdown=_artifact(b"\xff", "text/markdown")),
            replace(valid, markdown=_artifact(b" \n\t", "text/markdown")),
            replace(valid, markdown=wrong_hash),
            replace(valid, markdown=wrong_size),
            replace(valid, markdown=wrong_media),
            replace(
                valid,
                markdown=StagedParserArtifact(valid.markdown.artifact, _BrokenContent()),
            ),
        )

        for staged in cases:
            with self.subTest(staged=staged.markdown.artifact):
                old = _result(request)
                store = _FakeStore(matches=(True,), current_result=old)
                with self.assertRaises(ParsingFailure) as raised:
                    _service(_FakeParser(staged), store).prepare_current_primary(request)
                self.assertEqual(raised.exception.failure.code, "parsing-structure-invalid")
                self.assertEqual(store.current_result, old)
                self.assertTrue(store.primary_pdf_preserved)
                self.assertEqual(store.cleanup_calls, 0)
                self.assertEqual(store.publication_calls, [])
                rendered = _rendered_failure(raised.exception)
                self.assertNotIn(_SECRET_PATH, rendered)
                self.assertNotIn(_SECRET_URL, rendered)

    def test_page_resources_provenance_and_input_must_align(self) -> None:
        request = _request()
        valid = _output(request)
        duplicate_resource = valid.resources[0]
        unsafe_resource = replace(duplicate_resource, reference="../private/resource.png")
        wrong_resource_hash = replace(
            duplicate_resource,
            artifact=replace(
                duplicate_resource.artifact,
                artifact=duplicate_resource.artifact.artifact.model_copy(
                    update={"sha256": sha256_digest(b"wrong-resource")}
                ),
            ),
        )
        wrong_input_provenance = valid.provenance.model_copy(
            update={
                "provenance": valid.provenance.provenance.model_copy(
                    update={"input_sha256": sha256_digest(b"wrong-input")}
                )
            }
        )
        path_provenance = valid.provenance.model_copy(
            update={
                "provenance": valid.provenance.provenance.model_copy(
                    update={"source_name": _SECRET_PATH}
                )
            }
        )
        cases = (
            replace(valid, page_count=0),
            replace(valid, resources=(unsafe_resource,)),
            replace(valid, resources=(duplicate_resource, duplicate_resource)),
            replace(valid, resources=(wrong_resource_hash,)),
            replace(valid, provenance=wrong_input_provenance),
            replace(valid, provenance=path_provenance),
            replace(valid, source_asset_id=_OTHER_ASSET_ID),
            replace(valid, source_sha256=sha256_digest(b"another PDF")),
        )

        for staged in cases:
            with self.subTest(staged=staged):
                old = _result(request)
                store = _FakeStore(matches=(True,), current_result=old)
                with self.assertRaises(ParsingFailure) as raised:
                    _service(_FakeParser(staged), store).prepare_current_primary(request)
                self.assertEqual(raised.exception.failure.code, "parsing-structure-invalid")
                self.assertEqual(store.current_result, old)
                self.assertTrue(store.primary_pdf_preserved)
                self.assertEqual(store.cleanup_calls, 0)
                self.assertEqual(store.publication_calls, [])
                self.assertNotIn(_SECRET_PATH, _rendered_failure(raised.exception))

    def test_parser_identity_paths_fail_before_hash_or_publication(self) -> None:
        request = _request()
        valid = _output(request)
        invalid_identities = (
            "../private/model.bin",
            "./model",
            ".",
            "..",
            "organization/./model",
            "organization/../model",
            "organization//model",
            r"dir\model.bin",
            r"C:\private\model.bin",
            r"C:private\model.bin",
            "C:/private/model.bin",
            "~/model",
            "/absolute/model",
            "https://host/model",
            " model",
            "model ",
            "model\x00identity",
            "model\nidentity",
            "model\x85identity",
        )

        for field in ("parser_version", "mode", "model_identity"):
            for identity in invalid_identities:
                with self.subTest(field=field, identity=identity):
                    staged = replace(
                        valid,
                        provenance=valid.provenance.model_copy(update={field: identity}),
                    )
                    with self.assertRaises(ParserStructureError) as caught:
                        prepare_parser_result(request, staged)
                    rendered = f"{caught.exception!s} {caught.exception!r}"
                    self.assertEqual(
                        str(caught.exception),
                        "staged parser output is invalid",
                    )
                    self.assertNotIn(identity, rendered)

        legal = replace(
            valid,
            provenance=valid.provenance.model_copy(
                update={
                    "parser_version": "3.4.4",
                    "mode": "vlm-engine",
                    "model_identity": "organization/model@revision",
                }
            ),
        )
        command = prepare_parser_result(request, legal)
        self.assertEqual(command.result.provenance.parser_version, "3.4.4")
        self.assertEqual(command.result.provenance.mode, "vlm-engine")
        self.assertEqual(
            command.result.provenance.model_identity,
            "organization/model@revision",
        )

        for field in ("parser_version", "mode", "model_identity"):
            staged = replace(
                valid,
                provenance=valid.provenance.model_copy(update={field: "../private/model.bin"}),
            )
            old = _result(request)
            store = _FakeStore(matches=(True,), current_result=old)
            with self.subTest(service_field=field), self.assertRaises(ParsingFailure) as caught:
                _service(_FakeParser(staged), store).prepare_current_primary(request)
            self.assertEqual(caught.exception.failure.code, "parsing-structure-invalid")
            self.assertEqual(store.publication_calls, [])
            self.assertEqual(store.current_result, old)
            self.assertTrue(store.primary_pdf_preserved)

    def test_stale_current_primary_is_checked_before_parser_and_before_commit(self) -> None:
        request = _request()
        old = _result(request)

        before_parser = _FakeStore(matches=(False,), current_result=old)
        parser = _FakeParser(_output(request))
        with self.assertRaises(ParsingFailure) as raised:
            _service(parser, before_parser).prepare_current_primary(request)
        self.assertEqual(raised.exception.failure.code, "parsing-current-primary-stale")
        self.assertEqual(parser.calls, [])
        self.assertEqual(before_parser.publication_calls, [])

        before_commit = _FakeStore(matches=(True, False), current_result=old)
        parser = _FakeParser(_output(request))
        service = _service(parser, before_commit)
        prepared = service.prepare_current_primary(request)
        self.assertEqual(before_commit.publication_calls, [])
        with self.assertRaises(ParsingFailure) as raised:
            service.commit_current_primary(prepared)
        self.assertEqual(raised.exception.failure.code, "parsing-current-primary-stale")
        self.assertEqual(parser.calls, [request])
        self.assertEqual(before_commit.publication_calls, [])

        for store in (before_parser, before_commit):
            self.assertEqual(store.current_result, old)
            self.assertTrue(store.primary_pdf_preserved)
            self.assertEqual(store.cleanup_calls, 0)

    def test_parser_and_publication_failures_are_stable_and_preserve_old_facts(self) -> None:
        request = _request()
        old = _result(request)
        cases = (
            (
                _FakeParser(RuntimeError(f"parser failed at {_SECRET_PATH} {_SECRET_URL}")),
                _FakeStore(matches=(True,), current_result=old),
                "parsing-parser-failed",
            ),
            (
                _FakeParser(_output(request)),
                _FakeStore(
                    current_result=old,
                    publication_error=OSError(f"commit failed at {_SECRET_PATH} {_SECRET_URL}"),
                ),
                "parsing-publication-failed",
            ),
        )

        for parser, store, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(ParsingFailure) as raised:
                    _prepare_and_commit(_service(parser, store), request)
                self.assertEqual(raised.exception.failure.code, code)
                self.assertEqual(store.current_result, old)
                self.assertTrue(store.primary_pdf_preserved)
                self.assertEqual(store.cleanup_calls, 0)
                rendered = _rendered_failure(raised.exception)
                self.assertNotIn(_SECRET_PATH, rendered)
                self.assertNotIn(_SECRET_URL, rendered)

    def test_service_accepts_existing_canonical_replay_with_new_attempt_identity(self) -> None:
        request = _request()
        output = _output(request)
        offered = prepare_parser_result(request, output).result
        existing = _with_new_attempt_identity(offered)
        store = _FakeStore(current_result=existing, publication_result=existing)

        committed = _prepare_and_commit(_service(_FakeParser(output), store), request)

        self.assertEqual(existing.result_sha256, offered.result_sha256)
        self.assertNotEqual(existing.provenance, offered.provenance)
        self.assertEqual(committed, existing)
        self.assertEqual(store.current_result, existing)
        self.assertEqual(len(store.publication_calls), 1)

    def test_store_contract_failures_do_not_turn_into_results_or_cleanup(self) -> None:
        request = _request()
        old = _result(request)
        invalid_match = _FakeStore(matches=("yes",), current_result=old)
        with self.assertRaises(ParsingFailure) as raised:
            _service(_FakeParser(_output(request)), invalid_match).prepare_current_primary(request)
        self.assertEqual(raised.exception.failure.code, "parsing-port-contract")

        invalid_commit = _FakeStore(current_result=old, publication_result=object())
        with self.assertRaises(ParsingFailure) as raised:
            service = _service(_FakeParser(_output(request)), invalid_commit)
            service.commit_current_primary(service.prepare_current_primary(request))
        self.assertEqual(raised.exception.failure.code, "parsing-port-contract")

        wrong_result = _FakeStore(current_result=old, publication_result=old)
        with self.assertRaises(ParsingFailure) as raised:
            service = _service(_FakeParser(_output(request)), wrong_result)
            service.commit_current_primary(service.prepare_current_primary(request))
        self.assertEqual(raised.exception.failure.code, "parsing-port-contract")

        offered = prepare_parser_result(request, _output(request)).result
        forged_same_hash = ParserResult.model_construct(
            source_asset_id=offered.source_asset_id,
            source_sha256=offered.source_sha256,
            page_count=offered.page_count + 1,
            markdown=offered.markdown,
            resources=offered.resources,
            result_sha256=offered.result_sha256,
            provenance=offered.provenance,
        )
        wrong_same_hash = _FakeStore(
            current_result=old,
            publication_result=forged_same_hash,
        )
        with self.assertRaises(ParsingFailure) as raised:
            service = _service(_FakeParser(_output(request)), wrong_same_hash)
            service.commit_current_primary(service.prepare_current_primary(request))
        self.assertEqual(raised.exception.failure.code, "parsing-port-contract")

        mismatched = _result(
            ParserRequest(
                source_asset_id=_OTHER_ASSET_ID,
                source_sha256=_PDF_SHA256,
                media_type="application/pdf",
                content_ref=_BytesContent(_PDF_BYTES),
            )
        )
        wrong_source = _FakeStore(current_result=old, publication_result=mismatched)
        with self.assertRaises(ParsingFailure) as raised:
            service = _service(_FakeParser(_output(request)), wrong_source)
            service.commit_current_primary(service.prepare_current_primary(request))
        self.assertEqual(raised.exception.failure.code, "parsing-port-contract")

        invalid_read = _FakeStore(current_result=mismatched)
        with self.assertRaises(ParsingFailure) as raised:
            ParsingApi(_service(_FakeParser(_output(request)), invalid_read)).read_current_result(
                _ASSET_ID
            )
        self.assertEqual(raised.exception.failure.code, "parsing-port-contract")

        for store in (
            invalid_match,
            invalid_commit,
            wrong_result,
            wrong_same_hash,
            wrong_source,
            invalid_read,
        ):
            self.assertTrue(store.primary_pdf_preserved)
            self.assertEqual(store.cleanup_calls, 0)


if __name__ == "__main__":
    unittest.main()
