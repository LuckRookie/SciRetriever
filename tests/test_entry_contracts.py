from __future__ import annotations

import ast
import inspect
import io
import unittest
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import FrozenInstanceError
from os import PathLike
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, Literal, cast

from pydantic import ValidationError

import sciretriever.entry.api as entry_api
import sciretriever.entry.ports as entry_ports
from sciretriever.entry.execution import (
    ExecutionSnapshotError,
    TransientLiteratureExecution,
    TransientMetaExecution,
    candidate_order_key,
    execute_database_write,
    freeze_execution,
)
from sciretriever.entry.ports import (
    ExecutionCurrentFacts,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    ProviderRelationCandidatePage,
    ProviderRelationCandidateReadPort,
    ProviderRelationCandidateReadRequest,
    ProviderRelationCandidateRef,
    ProviderRelationSeedFacts,
)
from sciretriever.literature.api import LiteratureArtifactReference
from sciretriever.literature.content import metadata_sha256
from sciretriever.literature.ports import StalePreconditionError
from sciretriever.literature.state import CurrentLiteratureFacts, CurrentPrimaryPdf
from sciretriever.model.acquisition import (
    Asset,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
)
from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.discovery import (
    CitationDiscoveryInput,
    ProviderDiscoveryLimit,
    TopicDiscoveryInput,
)
from sciretriever.model.execution import (
    AllPendingSelector,
    BatchRequest,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    ReferenceDetail,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    AssetId,
    DiscoveryRunId,
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
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import (
    BibliographyFormat,
    DatabaseCompletionReport,
    DiscoveryReport,
    ExportReport,
    ImportReport,
    ManualPdfReport,
)

ROOT = Path(__file__).resolve().parents[1]
_TIME = UtcTimestamp("2026-08-12T12:00:00Z")
_HASH = Sha256("a" * 64)


def _id(index: int) -> LiteratureId:
    return LiteratureId(f"00000000-0000-4000-8000-{index:012x}")


def _meta_id(index: int) -> MetaLiteratureId:
    return MetaLiteratureId(f"10000000-0000-4000-8000-{index:012x}")


def _discovery_id(index: int) -> DiscoveryRunId:
    return DiscoveryRunId(f"20000000-0000-4000-8000-{index:012x}")


def _observation_id(index: int) -> ObservationId:
    return ObservationId(f"60000000-0000-4000-8000-{index:012x}")


def _provenance(index: int) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(f"30000000-0000-4000-8000-{index:012x}"),
        source_kind=SourceKind.USER,
        source_name="entry-contract-fixture",
        source_record_id=None,
        observed_at=_TIME,
        input_sha256=_HASH,
        parameters_sha256=None,
    )


def _metadata_observation(index: int) -> MetadataObservation:
    return MetadataObservation(
        observation_id=_observation_id(index),
        provenance=Provenance(
            provenance_id=ProvenanceId(f"70000000-0000-4000-8000-{index:012x}"),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name="entry-contract-provider",
            source_record_id=f"contract-record-{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(
            title=f"Relation seed {index}",
            identifiers=(Identifier(namespace="doi", value=f"10.1000/contract-{index}"),),
        ),
    )


def _current(
    index: int,
    meta_index: int,
    *,
    role: VersionRole = VersionRole.PUBLISHED,
    primary: bool = False,
    exhausted: bool = False,
) -> ExecutionCurrentFacts:
    status = LiteratureStatus.ASSET_READY if primary else LiteratureStatus.UNREVIEWED
    literature = Literature(
        literature_id=_id(index),
        meta_literature_id=_meta_id(meta_index),
        version_role=role,
        metadata=LiteratureMetadata(title=f"Fixture literature {index}"),
        status=status,
    )
    primary_pdfs: tuple[CurrentPrimaryPdf, ...] = ()
    if primary:
        asset = Asset(
            asset_id=AssetId(f"40000000-0000-4000-8000-{index:012x}"),
            sha256=_HASH,
            size_bytes=10,
            media_type="application/pdf",
            path=RelativeArtifactPath(f"assets/{index}.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(f"50000000-0000-4000-8000-{index:012x}"),
            literature_id=literature.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=_provenance(index),
            source_url=None,
        )
        primary_pdfs = (CurrentPrimaryPdf(asset=asset, relation=relation),)
    return ExecutionCurrentFacts(
        current=CurrentLiteratureFacts(
            literature=literature,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            current_primary_pdfs=primary_pdfs,
        ),
        automatic_pdf_exhaustion=(
            AutomaticPdfAcquisitionExhaustion(literature_id=literature.literature_id)
            if exhausted
            else None
        ),
    )


def _meta_snapshot(
    meta_ids: tuple[MetaLiteratureId, ...],
    current: tuple[ExecutionCurrentFacts, ...],
) -> MetaSelectorSnapshot:
    unique_ids = tuple(dict.fromkeys(meta_ids))
    metas = tuple(
        MetaLiterature(
            meta_literature_id=meta_id,
            representative_literature_id=next(
                item.current.literature.literature_id
                for item in current
                if item.current.literature.meta_literature_id == meta_id
            ),
        )
        for meta_id in unique_ids
    )
    return MetaSelectorSnapshot(
        meta_literature_ids=meta_ids,
        meta_literatures=metas,
        current_facts=current,
    )


class _Lease(AbstractContextManager[None]):
    def __init__(self, events: list[str], failure: BaseException | None = None) -> None:
        self._events = events
        self._failure = failure

    def __enter__(self) -> None:
        self._events.append("admission")
        if self._failure is not None:
            raise self._failure

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self._events.append("release")


class _Admission:
    def __init__(self, events: list[str], failure: BaseException | None = None) -> None:
        self._events = events
        self._failure = failure

    def acquire_nowait(self) -> AbstractContextManager[None]:
        return _Lease(self._events, self._failure)


class _Recovery:
    def __init__(self, events: list[str], failure: BaseException | None = None) -> None:
        self._events = events
        self._failure = failure

    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        self._events.append("recovery")
        if self._failure is not None:
            raise self._failure
        return ()


class EntryApiSurfaceTests(unittest.TestCase):
    _METHOD_NAMES = (
        "discover_topic",
        "discover_citations",
        "complete_database",
        "admit_manual_pdf",
        "search_literature",
        "get_literature_detail",
        "list_literature_references",
        "get_reference_detail",
        "open_artifact",
        "export_artifact",
        "import_bibliography",
        "export_bibliography",
    )

    def test_public_api_is_one_explicitly_assembled_type_with_twelve_business_methods(
        self,
    ) -> None:
        self.assertEqual(entry_api.__all__, ("EntryApi",))
        self.assertTrue(inspect.isclass(entry_api.EntryApi))
        public_methods = tuple(
            name
            for name, value in entry_api.EntryApi.__dict__.items()
            if not name.startswith("_") and callable(value)
        )
        self.assertEqual(public_methods, self._METHOD_NAMES)
        for old_module_function in self._METHOD_NAMES:
            with self.subTest(name=old_module_function):
                self.assertFalse(hasattr(entry_api, old_module_function))

    def test_constructor_uses_twelve_precise_named_operations_once(self) -> None:
        signature = inspect.signature(entry_api.EntryApi.__init__)
        parameters = tuple(signature.parameters.values())[1:]
        self.assertEqual(
            tuple(parameter.name for parameter in parameters),
            tuple(f"{name}_operation" for name in self._METHOD_NAMES),
        )
        self.assertTrue(
            all(parameter.kind is inspect.Parameter.KEYWORD_ONLY for parameter in parameters)
        )
        self.assertNotIn("operations", signature.parameters)
        self.assertNotIn("service", signature.parameters)

    def test_public_method_signatures_contain_only_business_and_io_inputs(self) -> None:
        expected_parameters = {
            "discover_topic": ("self", "request"),
            "discover_citations": ("self", "request"),
            "complete_database": ("self", "request"),
            "admit_manual_pdf": ("self", "literature_id", "source"),
            "search_literature": ("self", "request"),
            "get_literature_detail": ("self", "literature_id"),
            "list_literature_references": ("self", "request"),
            "get_reference_detail": ("self", "reference_id"),
            "open_artifact": ("self", "reference"),
            "export_artifact": ("self", "reference", "target", "overwrite"),
            "import_bibliography": ("self", "format", "source"),
            "export_bibliography": (
                "self",
                "format",
                "selector",
                "target",
                "overwrite",
            ),
        }
        for name, expected in expected_parameters.items():
            with self.subTest(name=name):
                signature = inspect.signature(getattr(entry_api.EntryApi, name))
                self.assertEqual(tuple(signature.parameters), expected)
                self.assertNotIn("operation", signature.parameters)
                self.assertNotIn("adapter", signature.parameters)
                self.assertNotIn("client", signature.parameters)

    def test_all_twelve_operations_return_the_exact_injected_result(self) -> None:
        calls: list[tuple[object, ...]] = []

        def recorder(result: object) -> Callable[..., object]:
            def operation(*args: object) -> object:
                calls.append(args)
                return result

            return operation

        provider = ProviderDiscoveryLimit(provider_name="fixture", scan_limit=1)
        topic = TopicDiscoveryInput(kind="topic", query="materials", providers=(provider,))
        citation = CitationDiscoveryInput(
            kind="citation",
            seed_literature_ids=(_id(1),),
            direction="both",
            max_depth=1,
            result_limit=1,
            providers=(provider,),
        )
        batch = BatchRequest(
            selector=AllPendingSelector(kind="all-pending"),
            goal="CONTENT_READY",
        )
        export_scope = QuerySelector(kind="query", query=LibraryQuery())
        query_request = LibrarySearchRequest(query=LibraryQuery())
        reference_id = ReferenceId("60000000-0000-4000-8000-000000000001")
        artifact = ArtifactRef(sha256=_HASH, media_type="text/markdown", byte_size=1)
        source = cast(BinaryIO, io.BytesIO(b"fixture"))
        target = Path("entry-contract-output.fixture")

        discovery_report = cast(DiscoveryReport, object())
        completion_report = cast(DatabaseCompletionReport, object())
        manual_report = cast(ManualPdfReport, object())
        search_page = cast(LibrarySearchPage, object())
        detail = cast(LiteratureDetail, object())
        reference_page = cast(LiteratureReferencePage, object())
        reference_detail = cast(ReferenceDetail, object())
        artifact_context = cast(AbstractContextManager[BinaryIO], object())
        import_report = cast(ImportReport, object())
        export_report = cast(ExportReport, object())

        api = entry_api.EntryApi(
            discover_topic_operation=cast(
                Callable[[TopicDiscoveryInput], DiscoveryReport],
                recorder(discovery_report),
            ),
            discover_citations_operation=cast(
                Callable[[CitationDiscoveryInput], DiscoveryReport],
                recorder(discovery_report),
            ),
            complete_database_operation=cast(
                Callable[[BatchRequest], DatabaseCompletionReport],
                recorder(completion_report),
            ),
            admit_manual_pdf_operation=cast(
                Callable[[LiteratureId, BinaryIO], ManualPdfReport],
                recorder(manual_report),
            ),
            search_literature_operation=cast(
                Callable[[LibrarySearchRequest], LibrarySearchPage],
                recorder(search_page),
            ),
            get_literature_detail_operation=cast(
                Callable[[LiteratureId], LiteratureDetail],
                recorder(detail),
            ),
            list_literature_references_operation=cast(
                Callable[[LiteratureReferenceRequest], LiteratureReferencePage],
                recorder(reference_page),
            ),
            get_reference_detail_operation=cast(
                Callable[[ReferenceId], ReferenceDetail],
                recorder(reference_detail),
            ),
            open_artifact_operation=cast(
                Callable[
                    [LiteratureArtifactReference],
                    AbstractContextManager[BinaryIO],
                ],
                recorder(artifact_context),
            ),
            export_artifact_operation=cast(
                Callable[
                    [LiteratureArtifactReference, str | PathLike[str], bool],
                    None,
                ],
                recorder(None),
            ),
            import_bibliography_operation=cast(
                Callable[[BibliographyFormat, BinaryIO], ImportReport],
                recorder(import_report),
            ),
            export_bibliography_operation=cast(
                Callable[..., ExportReport],
                recorder(export_report),
            ),
        )

        self.assertIs(
            api.discover_topic(topic),
            discovery_report,
        )
        self.assertIs(
            api.discover_citations(citation),
            discovery_report,
        )
        self.assertIs(
            api.complete_database(batch),
            completion_report,
        )
        self.assertIs(
            api.admit_manual_pdf(_id(1), source),
            manual_report,
        )
        self.assertIs(
            api.search_literature(query_request),
            search_page,
        )
        self.assertIs(
            api.get_literature_detail(_id(1)),
            detail,
        )

        reference_request = cast(LiteratureReferenceRequest, object())
        self.assertIs(
            api.list_literature_references(reference_request),
            reference_page,
        )
        self.assertIs(
            api.get_reference_detail(reference_id),
            reference_detail,
        )
        self.assertIs(
            api.open_artifact(artifact),
            artifact_context,
        )
        self.assertIsNone(
            api.export_artifact(
                artifact,
                target,
                overwrite=True,
            )
        )
        self.assertIs(
            api.import_bibliography(BibliographyFormat.RIS, source),
            import_report,
        )
        self.assertIs(
            api.export_bibliography(
                BibliographyFormat.BIBTEX,
                export_scope,
                target,
                overwrite=True,
            ),
            export_report,
        )

        self.assertEqual(
            calls,
            [
                (topic,),
                (citation,),
                (batch,),
                (_id(1), source),
                (query_request,),
                (_id(1),),
                (reference_request,),
                (reference_id,),
                (artifact,),
                (artifact, target, True),
                (BibliographyFormat.RIS, source),
                (BibliographyFormat.BIBTEX, export_scope, target, True),
            ],
        )


class EntryProviderRelationCandidateContractTests(unittest.TestCase):
    def _valid_values(
        self,
    ) -> tuple[
        ProviderRelationCandidateReadRequest,
        tuple[ProviderRelationSeedFacts, ...],
        tuple[ProviderRelationCandidateRef, ...],
        ProviderRelationCandidatePage,
    ]:
        request = ProviderRelationCandidateReadRequest(
            seed_literature_ids=(_id(2), _id(1)),
            direction="both",
            provider_name="entry-contract-provider",
            limit=2,
            after_observation_id=_observation_id(9),
        )
        seed_facts = (
            ProviderRelationSeedFacts(
                literature_id=_id(2),
                metadata_observations=(_metadata_observation(2),),
            ),
            ProviderRelationSeedFacts(
                literature_id=_id(1),
                metadata_observations=(_metadata_observation(1),),
            ),
        )
        candidates = (
            ProviderRelationCandidateRef(
                observation_id=_observation_id(10),
                seed_endpoint="citing",
                candidate_seed_literature_ids=(_id(2), _id(1)),
            ),
            ProviderRelationCandidateRef(
                observation_id=_observation_id(10),
                seed_endpoint="cited",
                candidate_seed_literature_ids=(_id(1),),
            ),
            ProviderRelationCandidateRef(
                observation_id=_observation_id(11),
                seed_endpoint="cited",
                candidate_seed_literature_ids=(_id(2),),
            ),
        )
        page = ProviderRelationCandidatePage(
            seed_facts=seed_facts,
            candidates=candidates,
            next_after_observation_id=_observation_id(11),
        )
        return request, seed_facts, candidates, page

    def test_values_are_frozen_slotted_and_preserve_caller_order(self) -> None:
        request, seed_facts, candidates, page = self._valid_values()

        self.assertEqual(request.seed_literature_ids, (_id(2), _id(1)))
        self.assertEqual(
            tuple(item.literature_id for item in page.seed_facts),
            (_id(2), _id(1)),
        )
        self.assertEqual(candidates[0].candidate_seed_literature_ids, (_id(2), _id(1)))
        for value, field_name in (
            (request, "limit"),
            (seed_facts[0], "literature_id"),
            (candidates[0], "seed_endpoint"),
            (page, "next_after_observation_id"),
        ):
            with self.subTest(type=type(value).__name__):
                self.assertFalse(hasattr(value, "__dict__"))
                with self.assertRaises(FrozenInstanceError):
                    setattr(value, field_name, None)

    def test_request_rejects_open_or_weak_values(self) -> None:
        cases: tuple[Callable[[], object], ...] = (
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(),
                direction="references",
                provider_name="provider",
                limit=1,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(_id(1), _id(1)),
                direction="references",
                provider_name="provider",
                limit=1,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=cast(tuple[LiteratureId, ...], [_id(1)]),
                direction="references",
                provider_name="provider",
                limit=1,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=cast(tuple[LiteratureId, ...], (_meta_id(1),)),
                direction="references",
                provider_name="provider",
                limit=1,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(_id(1),),
                direction=cast(Literal["references", "cited-by", "both"], "outbound"),
                provider_name="provider",
                limit=1,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(_id(1),),
                direction="references",
                provider_name=" ",
                limit=1,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(_id(1),),
                direction="references",
                provider_name=cast(str, 1),
                limit=1,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(_id(1),),
                direction="references",
                provider_name="provider",
                limit=cast(int, True),
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(_id(1),),
                direction="references",
                provider_name="provider",
                limit=0,
            ),
            lambda: ProviderRelationCandidateReadRequest(
                seed_literature_ids=(_id(1),),
                direction="references",
                provider_name="provider",
                limit=1,
                after_observation_id=cast(ObservationId, _id(1)),
            ),
        )
        for index, build in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaises((TypeError, ValueError)):
                    build()

    def test_seed_facts_rejects_an_empty_observation_closure(self) -> None:
        with self.assertRaisesRegex(ValueError, "metadata_observations must be nonempty"):
            ProviderRelationSeedFacts(
                literature_id=_id(1),
                metadata_observations=(),
            )

    def test_nested_values_reject_duplicates_bad_types_and_open_ordering(self) -> None:
        _, seed_facts, candidates, _ = self._valid_values()
        invalid_seed_facts: tuple[Callable[[], object], ...] = (
            lambda: ProviderRelationSeedFacts(
                literature_id=cast(LiteratureId, _meta_id(1)),
                metadata_observations=(),
            ),
            lambda: ProviderRelationSeedFacts(
                literature_id=_id(1),
                metadata_observations=cast(
                    tuple[MetadataObservation, ...],
                    [_metadata_observation(1)],
                ),
            ),
            lambda: ProviderRelationSeedFacts(
                literature_id=_id(1),
                metadata_observations=(
                    _metadata_observation(1),
                    _metadata_observation(1),
                ),
            ),
        )
        invalid_candidates: tuple[Callable[[], object], ...] = (
            lambda: ProviderRelationCandidateRef(
                observation_id=cast(ObservationId, _id(1)),
                seed_endpoint="citing",
                candidate_seed_literature_ids=(_id(1),),
            ),
            lambda: ProviderRelationCandidateRef(
                observation_id=_observation_id(1),
                seed_endpoint=cast(Literal["citing", "cited"], "source"),
                candidate_seed_literature_ids=(_id(1),),
            ),
            lambda: ProviderRelationCandidateRef(
                observation_id=_observation_id(1),
                seed_endpoint="citing",
                candidate_seed_literature_ids=(),
            ),
            lambda: ProviderRelationCandidateRef(
                observation_id=_observation_id(1),
                seed_endpoint="citing",
                candidate_seed_literature_ids=(_id(1), _id(1)),
            ),
        )
        invalid_pages: tuple[Callable[[], object], ...] = (
            lambda: ProviderRelationCandidatePage(
                seed_facts=(),
                candidates=(),
                next_after_observation_id=None,
            ),
            lambda: ProviderRelationCandidatePage(
                seed_facts=(seed_facts[0], seed_facts[0]),
                candidates=(),
                next_after_observation_id=None,
            ),
            lambda: ProviderRelationCandidatePage(
                seed_facts=seed_facts,
                candidates=(
                    ProviderRelationCandidateRef(
                        observation_id=_observation_id(10),
                        seed_endpoint="citing",
                        candidate_seed_literature_ids=(_id(99),),
                    ),
                ),
                next_after_observation_id=None,
            ),
            lambda: ProviderRelationCandidatePage(
                seed_facts=seed_facts,
                candidates=(
                    ProviderRelationCandidateRef(
                        observation_id=_observation_id(10),
                        seed_endpoint="citing",
                        candidate_seed_literature_ids=(_id(1), _id(2)),
                    ),
                ),
                next_after_observation_id=None,
            ),
            lambda: ProviderRelationCandidatePage(
                seed_facts=seed_facts,
                candidates=(candidates[2], candidates[0]),
                next_after_observation_id=None,
            ),
            lambda: ProviderRelationCandidatePage(
                seed_facts=seed_facts,
                candidates=(candidates[1], candidates[0]),
                next_after_observation_id=None,
            ),
            lambda: ProviderRelationCandidatePage(
                seed_facts=seed_facts,
                candidates=(candidates[0], candidates[0]),
                next_after_observation_id=None,
            ),
            lambda: ProviderRelationCandidatePage(
                seed_facts=seed_facts,
                candidates=(candidates[2],),
                next_after_observation_id=_observation_id(10),
            ),
        )
        for category, cases in (
            ("seed", invalid_seed_facts),
            ("candidate", invalid_candidates),
            ("page", invalid_pages),
        ):
            for index, build in enumerate(cases):
                with self.subTest(category=category, index=index):
                    with self.assertRaises((TypeError, ValueError)):
                        build()

    def test_candidate_reader_protocol_is_runtime_checkable_and_exported(self) -> None:
        request, _, _, page = self._valid_values()

        class CandidateReader:
            request: ProviderRelationCandidateReadRequest | None = None

            def read_provider_relation_candidates(
                self,
                value: ProviderRelationCandidateReadRequest,
            ) -> ProviderRelationCandidatePage:
                self.request = value
                return page

        reader = CandidateReader()
        self.assertIsInstance(reader, ProviderRelationCandidateReadPort)
        self.assertIs(reader.read_provider_relation_candidates(request), page)
        self.assertIs(reader.request, request)
        for name in (
            "ProviderRelationCandidateReadRequest",
            "ProviderRelationSeedFacts",
            "ProviderRelationCandidateRef",
            "ProviderRelationCandidatePage",
            "ProviderRelationCandidateReadPort",
        ):
            self.assertIn(name, entry_ports.__all__)


class EntryCandidateOrderingTests(unittest.TestCase):
    def test_completion_then_parser_then_pdf_then_role_then_id(self) -> None:
        content = candidate_order_key(
            status=LiteratureStatus.CONTENT_READY,
            has_aligned_parser_result=True,
            has_current_primary_pdf=True,
            version_role=VersionRole.OTHER,
            literature_id=_id(9),
        )
        parser = candidate_order_key(
            status=LiteratureStatus.ASSET_READY,
            has_aligned_parser_result=True,
            has_current_primary_pdf=True,
            version_role=VersionRole.OTHER,
            literature_id=_id(8),
        )
        primary = candidate_order_key(
            status=LiteratureStatus.ASSET_READY,
            has_aligned_parser_result=False,
            has_current_primary_pdf=True,
            version_role=VersionRole.PUBLISHED,
            literature_id=_id(7),
        )
        unreviewed = candidate_order_key(
            status=LiteratureStatus.UNREVIEWED,
            has_aligned_parser_result=False,
            has_current_primary_pdf=False,
            version_role=VersionRole.PUBLISHED,
            literature_id=_id(6),
        )
        self.assertLess(content, parser)
        self.assertLess(parser, primary)
        self.assertLess(primary, unreviewed)

        published = candidate_order_key(
            status=LiteratureStatus.UNREVIEWED,
            has_aligned_parser_result=False,
            has_current_primary_pdf=False,
            version_role=VersionRole.PUBLISHED,
            literature_id=_id(5),
        )
        preprint = candidate_order_key(
            status=LiteratureStatus.UNREVIEWED,
            has_aligned_parser_result=False,
            has_current_primary_pdf=False,
            version_role=VersionRole.PREPRINT,
            literature_id=_id(1),
        )
        later_id = candidate_order_key(
            status=LiteratureStatus.UNREVIEWED,
            has_aligned_parser_result=False,
            has_current_primary_pdf=False,
            version_role=VersionRole.PUBLISHED,
            literature_id=_id(6),
        )
        self.assertLess(published, preprint)
        self.assertLess(published, later_id)


class EntrySelectorFreezingTests(unittest.TestCase):
    def test_all_six_selectors_freeze_their_correct_target_kind(self) -> None:
        meta_id = _meta_id(1)
        current = _current(1, 1)
        meta_snapshot = _meta_snapshot((meta_id,), (current,))
        meta_selectors = (
            AllPendingSelector(kind="all-pending"),
            DiscoveryRunSelector(
                kind="discovery-run",
                discovery_run_id=_discovery_id(1),
            ),
            ImportReportSelector(
                kind="import-report",
                meta_literature_ids=(meta_id,),
            ),
            QuerySelector(kind="query", query=LibraryQuery()),
            MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(meta_id,),
            ),
        )
        for selector in meta_selectors:
            with self.subTest(kind=selector.kind):
                frozen = freeze_execution(
                    BatchRequest(selector=selector, goal="CONTENT_READY"),
                    meta_snapshot,
                )
                self.assertEqual(len(frozen), 1)
                self.assertIsInstance(frozen[0], TransientMetaExecution)
                target = cast(TransientMetaExecution, frozen[0])
                self.assertEqual(target.target.meta_literature_id, meta_id)
                self.assertEqual(
                    tuple(candidate.literature_id for candidate in target.candidates),
                    (_id(1),),
                )

        literature_selector = LiteratureSelector(
            kind="literatures",
            literature_ids=(_id(1),),
        )
        frozen = freeze_execution(
            BatchRequest(selector=literature_selector, goal="CONTENT_READY"),
            LiteratureSelectorSnapshot(
                literature_ids=(_id(1),),
                current_facts=(current,),
            ),
        )
        self.assertEqual(len(frozen), 1)
        self.assertIsInstance(frozen[0], TransientLiteratureExecution)
        target = cast(TransientLiteratureExecution, frozen[0])
        self.assertEqual(target.target.literature_id, _id(1))
        self.assertEqual(target.candidate.literature_id, _id(1))

    def test_import_report_selector_rejects_an_empty_id_tuple(self) -> None:
        with self.assertRaises(ValidationError):
            ImportReportSelector(kind="import-report", meta_literature_ids=())

    def test_meta_scope_deduplicates_and_excludes_whole_meta_when_one_member_reaches_goal(
        self,
    ) -> None:
        first_meta = _meta_id(1)
        second_meta = _meta_id(2)
        snapshot = _meta_snapshot(
            (first_meta, first_meta, second_meta),
            (
                _current(1, 1, primary=True),
                _current(2, 1),
                _current(3, 2),
            ),
        )

        frozen = freeze_execution(
            BatchRequest(
                selector=AllPendingSelector(kind="all-pending"),
                goal="ASSET_READY",
            ),
            snapshot,
        )

        self.assertEqual(len(frozen), 1)
        remaining = cast(TransientMetaExecution, frozen[0])
        self.assertEqual(remaining.target.meta_literature_id, second_meta)
        self.assertEqual(
            tuple(candidate.literature_id for candidate in remaining.candidates),
            (_id(3),),
        )

    def test_all_pending_filters_only_the_exhausted_no_pdf_candidate(self) -> None:
        meta_id = _meta_id(1)
        snapshot = _meta_snapshot(
            (meta_id,),
            (
                _current(1, 1, exhausted=True),
                _current(2, 1),
            ),
        )

        frozen = freeze_execution(
            BatchRequest(
                selector=AllPendingSelector(kind="all-pending"),
                goal="CONTENT_READY",
            ),
            snapshot,
        )

        self.assertEqual(len(frozen), 1)
        target = cast(TransientMetaExecution, frozen[0])
        self.assertEqual(target.target.meta_literature_id, meta_id)
        self.assertEqual(
            tuple(candidate.literature_id for candidate in target.candidates),
            (_id(2),),
        )

    def test_all_pending_omits_a_meta_when_every_no_pdf_candidate_is_exhausted(self) -> None:
        meta_id = _meta_id(1)
        snapshot = _meta_snapshot(
            (meta_id,),
            (
                _current(1, 1, exhausted=True),
                _current(2, 1, exhausted=True),
            ),
        )

        frozen = freeze_execution(
            BatchRequest(
                selector=AllPendingSelector(kind="all-pending"),
                goal="CONTENT_READY",
            ),
            snapshot,
        )

        self.assertEqual(frozen, ())

    def test_explicit_wide_selectors_keep_exhaustion_for_needs_manual_pdf(self) -> None:
        meta_id = _meta_id(1)
        snapshot = _meta_snapshot((meta_id,), (_current(1, 1, exhausted=True),))
        selectors = (
            DiscoveryRunSelector(
                kind="discovery-run",
                discovery_run_id=_discovery_id(1),
            ),
            ImportReportSelector(
                kind="import-report",
                meta_literature_ids=(meta_id,),
            ),
            QuerySelector(kind="query", query=LibraryQuery()),
            MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(meta_id,),
            ),
        )
        for selector in selectors:
            with self.subTest(kind=selector.kind):
                frozen = freeze_execution(
                    BatchRequest(selector=selector, goal="CONTENT_READY"),
                    snapshot,
                )
                self.assertEqual(len(frozen), 1)
                target = cast(TransientMetaExecution, frozen[0])
                self.assertIsNotNone(target.candidates[0].current.automatic_pdf_exhaustion)

    def test_explicit_literature_keeps_exhaustion_for_later_retry(self) -> None:
        current = _current(1, 1, exhausted=True)
        frozen = freeze_execution(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_id(1),),
                ),
                goal="CONTENT_READY",
            ),
            LiteratureSelectorSnapshot(
                literature_ids=(_id(1),),
                current_facts=(current,),
            ),
        )

        self.assertEqual(len(frozen), 1)
        target = cast(TransientLiteratureExecution, frozen[0])
        self.assertIsNotNone(target.candidate.current.automatic_pdf_exhaustion)

    def test_primary_pdf_and_automatic_exhaustion_is_an_inconsistent_snapshot(self) -> None:
        current = _current(1, 1, primary=True, exhausted=True)

        with self.assertRaises(ExecutionSnapshotError):
            freeze_execution(
                BatchRequest(
                    selector=LiteratureSelector(
                        kind="literatures",
                        literature_ids=(_id(1),),
                    ),
                    goal="CONTENT_READY",
                ),
                LiteratureSelectorSnapshot(
                    literature_ids=(_id(1),),
                    current_facts=(current,),
                ),
            )

    def test_freezing_orders_progress_before_role_and_stable_literature_id(self) -> None:
        meta_id = _meta_id(1)
        snapshot = _meta_snapshot(
            (meta_id,),
            (
                _current(4, 1, role=VersionRole.PREPRINT),
                _current(3, 1, role=VersionRole.PUBLISHED),
                _current(2, 1, role=VersionRole.PUBLISHED),
                _current(1, 1, role=VersionRole.OTHER, primary=True),
            ),
        )

        frozen = freeze_execution(
            BatchRequest(
                selector=AllPendingSelector(kind="all-pending"),
                goal="CONTENT_READY",
            ),
            snapshot,
        )

        target = cast(TransientMetaExecution, frozen[0])
        self.assertEqual(
            tuple(candidate.literature_id for candidate in target.candidates),
            (_id(1), _id(2), _id(3), _id(4)),
        )

    def test_explicit_literature_scope_never_regroups_or_adds_a_sibling(self) -> None:
        selected = _current(1, 1, role=VersionRole.PREPRINT)
        sibling = _current(2, 1, role=VersionRole.PUBLISHED, primary=True)
        request = BatchRequest(
            selector=LiteratureSelector(kind="literatures", literature_ids=(_id(1),)),
            goal="CONTENT_READY",
        )

        frozen = freeze_execution(
            request,
            LiteratureSelectorSnapshot(
                literature_ids=(_id(1),),
                current_facts=(selected,),
            ),
        )

        self.assertEqual(len(frozen), 1)
        target = cast(TransientLiteratureExecution, frozen[0])
        self.assertEqual(target.candidate.literature_id, _id(1))
        with self.assertRaises(ExecutionSnapshotError):
            freeze_execution(
                request,
                LiteratureSelectorSnapshot(
                    literature_ids=(_id(1),),
                    current_facts=(selected, sibling),
                ),
            )

    def test_frozen_tuple_does_not_absorb_later_reader_additions_and_is_immutable(self) -> None:
        mutable_reader_facts = [_current(1, 1)]
        snapshot = _meta_snapshot((_meta_id(1),), tuple(mutable_reader_facts))
        frozen = freeze_execution(
            BatchRequest(
                selector=AllPendingSelector(kind="all-pending"),
                goal="CONTENT_READY",
            ),
            snapshot,
        )

        mutable_reader_facts.append(_current(2, 1, primary=True))

        self.assertIsInstance(frozen, tuple)
        target = cast(TransientMetaExecution, frozen[0])
        self.assertEqual(
            tuple(candidate.literature_id for candidate in target.candidates),
            (_id(1),),
        )
        with self.assertRaises(FrozenInstanceError):
            setattr(target, "candidates", ())


class EntryWriteStartTests(unittest.TestCase):
    def test_admission_recovery_prepare_write_and_release_order(self) -> None:
        events: list[str] = []

        def prepare() -> str:
            events.append("snapshot")
            return "prepared"

        def write(prepared: str) -> str:
            self.assertEqual(prepared, "prepared")
            events.append("write")
            return "result"

        result = execute_database_write(
            admission=_Admission(events),
            recovery=_Recovery(events),
            prepare=prepare,
            execute=write,
        )

        self.assertEqual(result, "result")
        self.assertEqual(events, ["admission", "recovery", "snapshot", "write", "release"])

    def test_admission_failure_prevents_recovery_prepare_and_write(self) -> None:
        events: list[str] = []
        conflict = RuntimeError("conflict")

        with self.assertRaises(RuntimeError) as raised:
            execute_database_write(
                admission=_Admission(events, conflict),
                recovery=_Recovery(events),
                prepare=lambda: events.append("snapshot"),
                execute=lambda _prepared: events.append("write"),
            )

        self.assertIs(raised.exception, conflict)
        self.assertEqual(events, ["admission"])

    def test_recovery_failure_prevents_prepare_and_write_but_releases(self) -> None:
        events: list[str] = []
        failure = RuntimeError("recovery failed")

        with self.assertRaises(RuntimeError) as raised:
            execute_database_write(
                admission=_Admission(events),
                recovery=_Recovery(events, failure),
                prepare=lambda: events.append("snapshot"),
                execute=lambda _prepared: events.append("write"),
            )

        self.assertIs(raised.exception, failure)
        self.assertEqual(events, ["admission", "recovery", "release"])

    def test_reader_failure_prevents_business_write_and_releases(self) -> None:
        events: list[str] = []
        failure = RuntimeError("reader failed")

        def prepare() -> None:
            events.append("snapshot")
            raise failure

        with self.assertRaises(RuntimeError) as raised:
            execute_database_write(
                admission=_Admission(events),
                recovery=_Recovery(events),
                prepare=prepare,
                execute=lambda _prepared: events.append("write"),
            )

        self.assertIs(raised.exception, failure)
        self.assertEqual(events, ["admission", "recovery", "snapshot", "release"])

    def test_unknown_broken_duplicate_and_stale_snapshots_produce_zero_business_writes(
        self,
    ) -> None:
        meta_id = _meta_id(1)
        current = _current(1, 1)
        request = BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(meta_id,),
            ),
            goal="CONTENT_READY",
        )
        unknown = MetaSelectorSnapshot(
            meta_literature_ids=(meta_id,),
            meta_literatures=(),
            current_facts=(),
        )
        broken_membership = MetaSelectorSnapshot(
            meta_literature_ids=(meta_id,),
            meta_literatures=(
                MetaLiterature(
                    meta_literature_id=meta_id,
                    representative_literature_id=_id(99),
                ),
            ),
            current_facts=(current,),
        )
        duplicate_facts = MetaSelectorSnapshot(
            meta_literature_ids=(meta_id,),
            meta_literatures=(
                MetaLiterature(
                    meta_literature_id=meta_id,
                    representative_literature_id=_id(1),
                ),
            ),
            current_facts=(current, current),
        )
        aligned_primary = _current(1, 1, primary=True)
        primary = aligned_primary.current.current_primary_pdfs[0]
        misaligned_relation = primary.relation.model_copy(update={"literature_id": _id(2)})
        misaligned = ExecutionCurrentFacts(
            current=CurrentLiteratureFacts(
                literature=aligned_primary.current.literature,
                metadata_revision=aligned_primary.current.metadata_revision,
                metadata_sha256=aligned_primary.current.metadata_sha256,
                current_primary_pdfs=(
                    CurrentPrimaryPdf(
                        asset=primary.asset,
                        relation=misaligned_relation,
                    ),
                ),
            )
        )
        misaligned_facts = MetaSelectorSnapshot(
            meta_literature_ids=(meta_id,),
            meta_literatures=(
                MetaLiterature(
                    meta_literature_id=meta_id,
                    representative_literature_id=_id(1),
                ),
            ),
            current_facts=(misaligned,),
        )
        cases: tuple[tuple[str, Callable[[], object], type[BaseException]], ...] = (
            (
                "unknown",
                lambda: freeze_execution(request, unknown),
                ExecutionSnapshotError,
            ),
            (
                "broken-membership",
                lambda: freeze_execution(request, broken_membership),
                ExecutionSnapshotError,
            ),
            (
                "duplicate-facts",
                lambda: freeze_execution(request, duplicate_facts),
                ExecutionSnapshotError,
            ),
            (
                "misaligned-facts",
                lambda: freeze_execution(request, misaligned_facts),
                ExecutionSnapshotError,
            ),
            (
                "stale-precondition",
                lambda: (_ for _ in ()).throw(StalePreconditionError()),
                StalePreconditionError,
            ),
        )
        for label, reader, expected_error in cases:
            with self.subTest(label=label):
                events: list[str] = []
                write_count = 0

                def prepare() -> object:
                    events.append("snapshot")
                    return reader()

                def execute(_prepared: object) -> None:
                    nonlocal write_count
                    write_count += 1
                    events.append("write")

                with self.assertRaises(expected_error):
                    execute_database_write(
                        admission=_Admission(events),
                        recovery=_Recovery(events),
                        prepare=prepare,
                        execute=execute,
                    )

                self.assertEqual(write_count, 0)
                self.assertEqual(
                    events,
                    ["admission", "recovery", "snapshot", "release"],
                )


class EntryStaticBoundaryTests(unittest.TestCase):
    def test_persistence_ports_cannot_accept_reports_or_transient_execution_values(self) -> None:
        forbidden = (
            "DiscoveryReport",
            "DatabaseCompletionReport",
            "ManualPdfReport",
            "ImportReport",
            "ExportReport",
            "FrozenLiteratureCandidate",
            "TransientExecution",
            "CompletionTarget",
        )
        port_names = (
            "DiscoveryRunRepositoryPort",
            "DiscoveryRunReadPort",
            "DiscoveryPublicationPort",
            "SelectorSnapshotReadPort",
            "CurrentFactsSnapshotReadPort",
            "ProviderRelationCandidateReadPort",
            "WriteAdmissionPort",
            "DiscoveryRunRecoveryPort",
            "ClockPort",
            "BibliographyCodecPort",
            "AtomicUserOutputPort",
        )
        for port_name in port_names:
            port = getattr(entry_ports, port_name)
            for method_name, method in port.__dict__.items():
                if method_name.startswith("_") or not callable(method):
                    continue
                signature = str(inspect.signature(method))
                with self.subTest(port=port_name, method=method_name):
                    for name in forbidden:
                        self.assertNotIn(name, signature)
                    self.assertNotIn("dict[", signature)
                    self.assertNotIn("Mapping[", signature)

    def test_recovery_port_has_no_legacy_compatibility_name(self) -> None:
        self.assertIn("DiscoveryRunRecoveryPort", entry_ports.__all__)
        self.assertTrue(hasattr(entry_ports, "DiscoveryRunRecoveryPort"))
        self.assertNotIn("LegacyDiscoveryRunRecoveryPort", entry_ports.__all__)
        self.assertFalse(hasattr(entry_ports, "LegacyDiscoveryRunRecoveryPort"))

    def test_entry_sources_have_no_forbidden_architecture_or_adapter_dependencies(self) -> None:
        relative_paths = (
            "src/sciretriever/entry/api.py",
            "src/sciretriever/entry/ports.py",
            "src/sciretriever/entry/execution.py",
        )
        forbidden_terms = (
            "BatchRun",
            "BatchTarget",
            "CollectionSelector",
            "CollectionRun",
            "ImportRun",
            "LegacyDiscoveryRunRecoveryPort",
            "selected_ids",
            "selected_ids_json",
        )
        for relative_path in relative_paths:
            source = (ROOT / relative_path).read_text(encoding="utf-8")
            tree = ast.parse(source)
            with self.subTest(path=relative_path):
                for term in forbidden_terms:
                    self.assertNotIn(term, source)
                self.assertNotIn("sciretriever.storage", source)
                self.assertNotIn("sciretriever.model.configuration", source)
                self.assertNotIn("sqlite", source.casefold())
                self.assertFalse(
                    any(
                        isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Name)
                        and node.func.id.endswith("Adapter")
                        for node in ast.walk(tree)
                    )
                )
                self.assertFalse(
                    any(
                        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and any(argument.arg == "details" for argument in node.args.args)
                        for node in ast.walk(tree)
                    )
                )


if __name__ == "__main__":
    unittest.main()
