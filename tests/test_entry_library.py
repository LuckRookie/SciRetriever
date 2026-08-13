from __future__ import annotations

import ast
import inspect
import io
import os
import unittest
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from types import TracebackType
from typing import BinaryIO

import sciretriever.entry.library as library_module
from sciretriever.entry.library import LibraryOperations
from sciretriever.entry.ports import UserOutputTarget
from sciretriever.literature.api import (
    LiteratureApi,
    LiteratureArtifactReadError,
    LiteratureArtifactReference,
)
from sciretriever.literature.content import content_sha256, metadata_sha256
from sciretriever.literature.query import LiteratureCursorError
from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureSection,
    LiteratureSectionRole,
)
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureAssetView,
    LiteratureDetail,
    LiteratureMissingStep,
    LiteratureReferenceItem,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    LiteratureSearchItem,
    ReferenceDetail,
)
from sciretriever.model.literature import (
    Literature,
    LiteratureStatus,
    MetaLiterature,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.files.output import AtomicOutput, OutputConflictError
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.engine import CatalogEngine

_TIME = UtcTimestamp("2026-08-12T12:00:00Z")
_ROOT = Path(__file__).resolve().parents[1]


def _uuid(index: int) -> str:
    return f"00000000-0000-4000-8000-{index:012x}"


def _literature_id(index: int) -> LiteratureId:
    return LiteratureId(_uuid(index))


def _meta_id(index: int) -> MetaLiteratureId:
    return MetaLiteratureId(_uuid(10_000 + index))


def _provenance(
    index: int,
    *,
    source_kind: SourceKind,
    source_name: str,
    input_sha256: Sha256 | None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(20_000 + index)),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=None,
        observed_at=_TIME,
        input_sha256=input_sha256,
        parameters_sha256=(
            sha256_digest(f"parameters-{index}".encode())
            if source_kind in {SourceKind.PARSER, SourceKind.ANALYSIS}
            else None
        ),
    )


def _literature(
    index: int,
    *,
    meta_index: int,
    title: str,
    year: int,
    role: VersionRole = VersionRole.PUBLISHED,
    status: LiteratureStatus = LiteratureStatus.CONTENT_READY,
) -> Literature:
    return Literature(
        literature_id=_literature_id(index),
        meta_literature_id=_meta_id(meta_index),
        version_role=role,
        metadata=LiteratureMetadata(title=title, publication_year=year),
        status=status,
    )


def _search_item(
    literature: Literature,
    *,
    missing_step: LiteratureMissingStep | None = None,
) -> LiteratureSearchItem:
    return LiteratureSearchItem(
        literature=literature,
        metadata_revision=1,
        metadata_sha256=metadata_sha256(literature.metadata),
        missing_step=missing_step,
        needs_manual_pdf=False,
    )


class _LibraryNotFoundError(LookupError):
    pass


class _FakeLiteratureApi(LiteratureApi):
    """A local-only Literature boundary whose results are preassembled snapshots."""

    def __init__(
        self,
        *,
        search_pages: dict[tuple[str, str | None], LibrarySearchPage],
        detail: LiteratureDetail,
        reference_pages: dict[tuple[LiteratureId, str], LiteratureReferencePage],
        reference_detail: ReferenceDetail,
        artifact_opener: Callable[
            [LiteratureArtifactReference],
            AbstractContextManager[BinaryIO],
        ]
        | None = None,
    ) -> None:
        self.search_pages = search_pages
        self.detail = detail
        self.reference_pages = reference_pages
        self.reference_detail = reference_detail
        self.artifact_opener = artifact_opener
        self.search_requests: list[LibrarySearchRequest] = []
        self.detail_requests: list[LiteratureId] = []
        self.reference_requests: list[LiteratureReferenceRequest] = []
        self.reference_detail_requests: list[ReferenceId] = []
        self.artifact_requests: list[LiteratureArtifactReference] = []

    def search(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        self.search_requests.append(request)
        if request.cursor == "stale-or-wrongly-bound":
            raise LiteratureCursorError("invalid local library cursor")
        return self.search_pages[(request.sort, request.cursor)]

    def read_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        self.detail_requests.append(literature_id)
        if literature_id != self.detail.literature.literature_id:
            raise _LibraryNotFoundError("literature not found")
        return self.detail

    def read_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        self.reference_requests.append(request)
        try:
            return self.reference_pages[(request.literature_id, request.direction)]
        except KeyError:
            raise _LibraryNotFoundError("literature not found") from None

    def read_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail:
        self.reference_detail_requests.append(reference_id)
        if reference_id != self.reference_detail.reference.reference_id:
            raise _LibraryNotFoundError("reference not found")
        return self.reference_detail

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]:
        self.artifact_requests.append(reference)
        if self.artifact_opener is None:
            raise LiteratureArtifactReadError()
        return self.artifact_opener(reference)


class _BufferedAtomicOutput:
    """Test Port that delegates final publication to the real atomic writer."""

    def __init__(self, *, failpoint: Callable[[str], None] | None = None) -> None:
        self.calls: list[tuple[str, bool]] = []
        self.published = 0
        self.aborted = 0
        self._writer = AtomicOutput(max_bytes=1024 * 1024)
        self._failpoint = failpoint

    @contextmanager
    def open_atomic(
        self,
        target: UserOutputTarget,
        *,
        overwrite: bool,
    ) -> Iterator[BinaryIO]:
        self.calls.append((os.fspath(target), overwrite))
        staged = io.BytesIO()
        try:
            try:
                yield staged
            except BaseException:
                self.aborted += 1
                raise
            try:
                self._writer.write(
                    target,
                    staged.getvalue(),
                    overwrite=overwrite,
                    failpoint=self._failpoint,
                )
            except BaseException:
                self.aborted += 1
                raise
            self.published += 1
        finally:
            staged.close()


class _ManagedBytes(AbstractContextManager[BinaryIO]):
    def __init__(self, payload: bytes, *, exit_error: BaseException | None = None) -> None:
        self._payload = payload
        self._exit_error = exit_error
        self.stream: io.BytesIO | None = None

    def __enter__(self) -> BinaryIO:
        self.stream = io.BytesIO(self._payload)
        return self.stream

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        del exc_type, exc_value, traceback
        if self.stream is not None:
            self.stream.close()
        if self._exit_error is not None:
            raise self._exit_error
        return False


def _read_projection_fixtures() -> tuple[
    LiteratureDetail,
    dict[tuple[str, str | None], LibrarySearchPage],
    dict[tuple[LiteratureId, str], LiteratureReferencePage],
    ReferenceDetail,
]:
    source = _literature(
        1,
        meta_index=1,
        title="Current published version",
        year=2026,
        status=LiteratureStatus.UNREVIEWED,
    )
    same_work_preprint = _literature(
        2,
        meta_index=1,
        title="Current preprint version",
        year=2025,
        role=VersionRole.PREPRINT,
        status=LiteratureStatus.UNREVIEWED,
    )
    cited = _literature(
        3,
        meta_index=2,
        title="Cited local work",
        year=2024,
        status=LiteratureStatus.UNREVIEWED,
    )
    source_item = _search_item(source, missing_step="primary-pdf")
    preprint_item = _search_item(same_work_preprint, missing_step="primary-pdf")
    cited_item = _search_item(cited, missing_step="primary-pdf")
    first_page = LibrarySearchPage(
        items=(source_item, preprint_item),
        total_count=3,
        next_cursor="opaque-next-page",
    )
    second_page = LibrarySearchPage(
        items=(cited_item,),
        total_count=3,
        next_cursor=None,
    )
    empty_asset_detail = LiteratureDetail(
        literature=source,
        meta_literature=MetaLiterature(
            meta_literature_id=source.meta_literature_id,
            representative_literature_id=source.literature_id,
        ),
        metadata_revision=1,
        metadata_sha256=source_item.metadata_sha256,
        missing_step="primary-pdf",
        needs_manual_pdf=False,
        metadata_observations=(),
        primary_pdf=None,
        additional_assets=(),
        parser_result=None,
        content=None,
        other_versions=(preprint_item,),
        reference_count=1,
        cited_by_count=0,
    )
    reference = Reference(
        reference_id=ReferenceId(_uuid(30_001)),
        source_literature_id=source.literature_id,
        target_literature_id=cited.literature_id,
    )
    supports = (
        ReferenceSupport.model_validate(
            {
                "reference_id": reference.reference_id,
                "source": {
                    "kind": "provider_relation",
                    "observation_id": ObservationId(_uuid(40_001)),
                },
            }
        ),
        ReferenceSupport.model_validate(
            {
                "reference_id": reference.reference_id,
                "source": {
                    "kind": "provider_relation",
                    "observation_id": ObservationId(_uuid(40_002)),
                },
            }
        ),
    )
    forward = LiteratureReferencePage(
        items=(
            LiteratureReferenceItem(
                reference=reference,
                related_literature=cited_item,
                support_count=2,
            ),
        ),
        total_count=1,
        next_cursor=None,
    )
    reverse = LiteratureReferencePage(
        items=(
            LiteratureReferenceItem(
                reference=reference,
                related_literature=source_item,
                support_count=2,
            ),
        ),
        total_count=1,
        next_cursor=None,
    )
    reference_detail = ReferenceDetail(
        reference=reference,
        source=source_item,
        target=cited_item,
        supports=supports,
    )
    return (
        empty_asset_detail,
        {
            ("publication-year-desc", None): first_page,
            ("publication-year-desc", "opaque-next-page"): second_page,
        },
        {
            (source.literature_id, "references"): forward,
            (cited.literature_id, "cited-by"): reverse,
        },
        reference_detail,
    )


class EntryLibraryReadTests(unittest.TestCase):
    def setUp(self) -> None:
        detail, pages, reference_pages, reference_detail = _read_projection_fixtures()
        self.detail = detail
        self.pages = pages
        self.reference_pages = reference_pages
        self.reference_detail = reference_detail
        self.api = _FakeLiteratureApi(
            search_pages=pages,
            detail=detail,
            reference_pages=reference_pages,
            reference_detail=reference_detail,
        )
        self.output = _BufferedAtomicOutput()
        self.operations = LibraryOperations(literature=self.api, output=self.output)

    def test_operation_surface_is_the_frozen_thin_local_library_slice(self) -> None:
        self.assertEqual(library_module.__all__, ("LibraryOperations",))
        public_methods = {
            name
            for name, value in LibraryOperations.__dict__.items()
            if callable(value) and not name.startswith("_")
        }
        self.assertEqual(
            public_methods,
            {
                "search_literature",
                "get_literature_detail",
                "list_literature_references",
                "get_reference_detail",
                "open_artifact",
                "export_artifact",
            },
        )
        self.assertEqual(
            tuple(inspect.signature(LibraryOperations.export_artifact).parameters),
            ("self", "reference", "target", "overwrite"),
        )

        source_path = _ROOT / "src/sciretriever/entry/library.py"
        source = source_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=source_path.as_posix())
        imported_modules = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module is not None
        }
        self.assertFalse(
            any(
                module.startswith(
                    (
                        "sciretriever.metadata",
                        "sciretriever.acquisition",
                        "sciretriever.parsing",
                        "sciretriever.analysis",
                        "sciretriever.network",
                        "sciretriever.storage",
                    )
                )
                for module in imported_modules
            )
        )
        self.assertNotIn("sciretriever.model.discovery", imported_modules)
        for forbidden in (
            "DiscoveryRun",
            "Report",
            "sqlite3",
            "SELECT ",
            "Provider",
            "derive_status",
            "cited_by_edges",
        ):
            self.assertNotIn(forbidden, source)

    def test_search_forwards_sort_and_cursor_and_returns_concrete_versions(self) -> None:
        request = LibrarySearchRequest(
            query=LibraryQuery(text="current"),
            sort="publication-year-desc",
            limit=2,
        )

        first = self.operations.search_literature(request)
        second_request = LibrarySearchRequest(
            query=request.query,
            sort=request.sort,
            limit=request.limit,
            cursor=first.next_cursor,
        )
        second = self.operations.search_literature(second_request)

        self.assertIs(first, self.pages[("publication-year-desc", None)])
        self.assertIs(second, self.pages[("publication-year-desc", "opaque-next-page")])
        self.assertEqual(
            tuple(item.literature.literature_id for item in first.items),
            (_literature_id(1), _literature_id(2)),
        )
        self.assertEqual(
            first.items[0].literature.meta_literature_id,
            first.items[1].literature.meta_literature_id,
        )
        self.assertNotEqual(
            first.items[0].literature.literature_id,
            first.items[1].literature.literature_id,
        )
        self.assertEqual(self.api.search_requests, [request, second_request])
        self.assertEqual(self.output.calls, [])

    def test_stale_cursor_fails_closed_without_becoming_an_empty_page(self) -> None:
        request = LibrarySearchRequest(
            query=LibraryQuery(text="current"),
            sort="publication-year-desc",
            limit=2,
            cursor="stale-or-wrongly-bound",
        )

        with self.assertRaises(LiteratureCursorError):
            self.operations.search_literature(request)

        self.assertEqual(self.api.search_requests, [request])
        self.assertEqual(self.output.calls, [])

    def test_detail_reference_directions_support_counts_and_detail_are_unchanged(self) -> None:
        source_id = self.reference_detail.reference.source_literature_id
        target_id = self.reference_detail.reference.target_literature_id
        forward_request = LiteratureReferenceRequest(
            literature_id=source_id,
            direction="references",
        )
        reverse_request = LiteratureReferenceRequest(
            literature_id=target_id,
            direction="cited-by",
        )

        detail = self.operations.get_literature_detail(source_id)
        forward = self.operations.list_literature_references(forward_request)
        reverse = self.operations.list_literature_references(reverse_request)
        relation = self.operations.get_reference_detail(
            self.reference_detail.reference.reference_id
        )

        self.assertIs(detail, self.detail)
        self.assertIs(forward, self.reference_pages[(source_id, "references")])
        self.assertIs(reverse, self.reference_pages[(target_id, "cited-by")])
        self.assertIs(relation, self.reference_detail)
        self.assertIs(forward.items[0].reference, reverse.items[0].reference)
        self.assertEqual(forward.items[0].support_count, 2)
        self.assertEqual(reverse.items[0].support_count, 2)
        self.assertEqual(len(relation.supports), 2)
        self.assertEqual(self.api.detail_requests, [source_id])
        self.assertEqual(self.api.reference_requests, [forward_request, reverse_request])
        self.assertEqual(
            self.api.reference_detail_requests,
            [self.reference_detail.reference.reference_id],
        )
        self.assertEqual(self.output.calls, [])

    def test_unknown_literature_and_reference_propagate_stable_not_found(self) -> None:
        missing_literature = _literature_id(999)
        missing_reference = ReferenceId(_uuid(999))

        with self.assertRaises(_LibraryNotFoundError):
            self.operations.get_literature_detail(missing_literature)
        with self.assertRaises(_LibraryNotFoundError):
            self.operations.list_literature_references(
                LiteratureReferenceRequest(
                    literature_id=missing_literature,
                    direction="references",
                )
            )
        with self.assertRaises(_LibraryNotFoundError):
            self.operations.get_reference_detail(missing_reference)

        self.assertEqual(self.output.calls, [])


class EntryLibraryArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-entry-library-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.root = StorageRoot(self.base / "artifacts")
        self.store = ArtifactStore(self.root, max_artifact_bytes=1024 * 1024)
        self.verified_reader = VerifiedReader(self.root, max_artifact_bytes=1024 * 1024)
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.reader = LiteratureArtifactReader(self.engine, self.verified_reader)
        self.pdf_payload = b"%PDF-1.7\nlocal fixture\n"
        self.parser_payload = b"# Parser Markdown\n\nParsed body.\n"
        self.content_payload = b"# Metadata\n\n# Canonical content\n"
        self.pdf_object = self._publish("entry-pdf", self.pdf_payload, "application/pdf")
        self.parser_object = self._publish(
            "entry-parser",
            self.parser_payload,
            "text/markdown",
        )
        self.content_object = self._publish(
            "entry-content",
            self.content_payload,
            "text/markdown",
        )
        self.detail = self._detail()
        reference = Reference(
            reference_id=ReferenceId(_uuid(50_001)),
            source_literature_id=self.detail.literature.literature_id,
            target_literature_id=_literature_id(502),
        )
        source_item = _search_item(self.detail.literature)
        target_item = _search_item(
            _literature(
                502,
                meta_index=502,
                title="Artifact relation target",
                year=2020,
            )
        )
        support = ReferenceSupport.model_validate(
            {
                "reference_id": reference.reference_id,
                "source": {
                    "kind": "provider_relation",
                    "observation_id": ObservationId(_uuid(50_002)),
                },
            }
        )
        reference_detail = ReferenceDetail(
            reference=reference,
            source=source_item,
            target=target_item,
            supports=(support,),
        )
        self.api = _FakeLiteratureApi(
            search_pages={
                ("publication-year-desc", None): LibrarySearchPage(
                    items=(source_item,),
                    total_count=1,
                )
            },
            detail=self.detail,
            reference_pages={},
            reference_detail=reference_detail,
            artifact_opener=self.reader.open_artifact,
        )
        self.output = _BufferedAtomicOutput()
        self.operations = LibraryOperations(literature=self.api, output=self.output)

    def _publish(self, artifact_id: str, payload: bytes, media_type: str) -> ArtifactReference:
        reference = self.store.publish(
            payload,
            sha256=sha256_digest(payload),
            byte_size=len(payload),
            media_type=media_type,
        )
        with self.verified_reader.acquire(reference) as lease:
            register_artifact(self.engine, artifact_id, lease)
        return reference

    def _detail(self) -> LiteratureDetail:
        literature = _literature(
            501,
            meta_index=501,
            title="Artifact fixture",
            year=2026,
        )
        asset = Asset(
            asset_id=AssetId(_uuid(60_001)),
            sha256=self.pdf_object.sha256,
            size_bytes=self.pdf_object.byte_size,
            media_type=self.pdf_object.media_type,
            path=self.pdf_object.path,
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                "VALUES(?,?,?,?,?)",
                (
                    str(asset.asset_id),
                    str(asset.sha256),
                    asset.size_bytes,
                    asset.media_type,
                    str(asset.path),
                ),
            )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_uuid(60_002)),
            literature_id=literature.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=_provenance(
                1,
                source_kind=SourceKind.USER,
                source_name="manual-pdf",
                input_sha256=asset.sha256,
            ),
            source_url=None,
        )
        parser_markdown = ParserArtifactRef(
            sha256=self.parser_object.sha256,
            media_type=self.parser_object.media_type,
            byte_size=self.parser_object.byte_size,
        )
        parser_provenance = ParserProvenance(
            provenance=_provenance(
                2,
                source_kind=SourceKind.PARSER,
                source_name="fixture-parser",
                input_sha256=asset.sha256,
            ),
            parser_version="1.0",
        )
        parser_result = ParserResult(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            page_count=1,
            markdown=parser_markdown,
            resources=(),
            result_sha256=parser_result_sha256(
                source_asset_id=asset.asset_id,
                source_sha256=asset.sha256,
                page_count=1,
                markdown=parser_markdown,
                resources=(),
                provenance=parser_provenance,
            ),
            provenance=parser_provenance,
        )
        metadata_hash = metadata_sha256(literature.metadata)
        sections = (
            LiteratureSection(
                role=LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                markdown="Background",
            ),
            LiteratureSection(
                role=LiteratureSectionRole.METHODS,
                markdown="Methods",
            ),
            LiteratureSection(
                role=LiteratureSectionRole.DATA,
                markdown="Data",
            ),
            LiteratureSection(
                role=LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
                markdown="Conclusions",
            ),
        )
        content = LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=metadata_hash,
                sections=sections,
                references=("Local reference text",),
            ),
            metadata_revision=1,
            metadata_sha256=metadata_hash,
            sections=sections,
            references=("Local reference text",),
            markdown=ArtifactRef(
                sha256=self.content_object.sha256,
                media_type=self.content_object.media_type,
                byte_size=self.content_object.byte_size,
            ),
            provenance=_provenance(
                3,
                source_kind=SourceKind.ANALYSIS,
                source_name="fixture-model",
                input_sha256=sha256_digest(b"analysis-input"),
            ),
        )
        return LiteratureDetail(
            literature=literature,
            meta_literature=MetaLiterature(
                meta_literature_id=literature.meta_literature_id,
                representative_literature_id=literature.literature_id,
            ),
            metadata_revision=1,
            metadata_sha256=metadata_hash,
            missing_step=None,
            needs_manual_pdf=False,
            metadata_observations=(),
            primary_pdf=LiteratureAssetView(asset=asset, literature_asset=relation),
            additional_assets=(),
            parser_result=parser_result,
            content=content,
            other_versions=(),
            reference_count=1,
            cited_by_count=0,
        )

    def _detail_artifacts(self) -> tuple[LiteratureArtifactReference, ...]:
        primary_pdf = self.detail.primary_pdf
        parser_result = self.detail.parser_result
        content = self.detail.content
        self.assertIsNotNone(primary_pdf)
        self.assertIsNotNone(parser_result)
        self.assertIsNotNone(content)
        assert primary_pdf is not None
        assert parser_result is not None
        assert content is not None
        return (primary_pdf.asset, parser_result.markdown, content.markdown)

    def test_pdf_parser_markdown_and_content_markdown_open_as_managed_verified_streams(
        self,
    ) -> None:
        expected_payloads = (
            self.pdf_payload,
            self.parser_payload,
            self.content_payload,
        )

        for reference, expected in zip(self._detail_artifacts(), expected_payloads, strict=True):
            with self.subTest(reference=type(reference).__name__):
                context = self.operations.open_artifact(reference)
                with context as stream:
                    self.assertEqual(stream.read(), expected)
                    self.assertFalse(stream.closed)
                self.assertTrue(stream.closed)

        self.assertEqual(self.api.artifact_requests, list(self._detail_artifacts()))
        self.assertEqual(self.output.calls, [])

    def test_pdf_parser_and_content_artifacts_export_through_atomic_output(self) -> None:
        expected_payloads = (
            self.pdf_payload,
            self.parser_payload,
            self.content_payload,
        )

        for index, (reference, expected) in enumerate(
            zip(self._detail_artifacts(), expected_payloads, strict=True)
        ):
            target = self.base / f"export-{index}.bin"
            self.operations.export_artifact(reference, target)
            self.assertEqual(target.read_bytes(), expected)

        self.assertEqual(
            self.output.calls,
            [(str(self.base / f"export-{index}.bin"), False) for index in range(3)],
        )
        self.assertEqual(self.output.published, 3)

    def test_existing_target_is_rejected_by_default_and_explicit_overwrite_is_atomic(self) -> None:
        reference = self._detail_artifacts()[2]
        target = self.base / "content.md"
        old_payload = b"old complete content\n"
        target.write_bytes(old_payload)
        os.chmod(target, 0o600)

        with self.assertRaises(OutputConflictError):
            self.operations.export_artifact(reference, target)
        self.assertEqual(target.read_bytes(), old_payload)

        self.operations.export_artifact(reference, target, overwrite=True)
        self.assertEqual(target.read_bytes(), self.content_payload)

        target.write_bytes(old_payload)
        os.chmod(target, 0o600)

        def fail_before_publish(name: str) -> None:
            if name == "before-publish":
                raise RuntimeError("injected atomic publication failure")

        failing_output = _BufferedAtomicOutput(failpoint=fail_before_publish)
        failing_operations = LibraryOperations(literature=self.api, output=failing_output)
        with self.assertRaisesRegex(RuntimeError, "injected atomic publication failure"):
            failing_operations.export_artifact(reference, target, overwrite=True)
        self.assertEqual(target.read_bytes(), old_payload)
        self.assertEqual(failing_output.published, 0)

    def test_export_waits_for_verified_reader_exit_and_rechecks_copied_identity(self) -> None:
        reference = self._detail_artifacts()[2]
        target = self.base / "protected-content.md"
        old_payload = b"old protected content\n"
        target.write_bytes(old_payload)
        os.chmod(target, 0o600)

        for context in (
            _ManagedBytes(b"wrong bytes with the same boundary type"),
            _ManagedBytes(
                self.content_payload,
                exit_error=LiteratureArtifactReadError(),
            ),
        ):
            with self.subTest(context=context):
                api = _FakeLiteratureApi(
                    search_pages=self.api.search_pages,
                    detail=self.detail,
                    reference_pages={},
                    reference_detail=self.api.reference_detail,
                    artifact_opener=lambda _reference, managed=context: managed,
                )
                output = _BufferedAtomicOutput()
                operations = LibraryOperations(literature=api, output=output)

                with self.assertRaises(LiteratureArtifactReadError):
                    operations.export_artifact(reference, target, overwrite=True)

                self.assertEqual(target.read_bytes(), old_payload)
                self.assertEqual(output.published, 0)
                self.assertEqual(output.aborted, 1)

    def test_tamper_escape_hash_size_and_media_mismatches_fail_closed(self) -> None:
        content_reference = self._detail_artifacts()[2]
        assert isinstance(content_reference, ArtifactRef)
        target = self.base / "unchanged.md"
        old_payload = b"old user target\n"
        target.write_bytes(old_payload)
        os.chmod(target, 0o600)

        escaped_path = RelativeArtifactPath.model_construct(root="../outside.pdf")
        escaped_asset = Asset.model_construct(
            asset_id=AssetId(_uuid(60_001)),
            sha256=self.pdf_object.sha256,
            size_bytes=self.pdf_object.byte_size,
            media_type=self.pdf_object.media_type,
            path=escaped_path,
        )
        invalid_references: tuple[LiteratureArtifactReference, ...] = (
            escaped_asset,
            content_reference.model_copy(update={"sha256": Sha256("f" * 64)}),
            content_reference.model_copy(update={"byte_size": content_reference.byte_size + 1}),
            content_reference.model_copy(update={"media_type": "application/x-wrong"}),
        )

        for reference in invalid_references:
            with self.subTest(reference=reference):
                with self.assertRaises(LiteratureArtifactReadError):
                    self.operations.export_artifact(reference, target, overwrite=True)
                self.assertEqual(target.read_bytes(), old_payload)

        content_path = self.root.canonical_path / str(self.content_object.path)
        content_path.write_bytes(b"tampered artifact bytes")
        os.chmod(content_path, 0o600)
        with self.assertRaises(LiteratureArtifactReadError):
            self.operations.export_artifact(content_reference, target, overwrite=True)
        self.assertEqual(target.read_bytes(), old_payload)


if __name__ == "__main__":
    unittest.main()
