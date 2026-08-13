from __future__ import annotations

import importlib
import inspect
import io
import json
import sys
import tempfile
import unittest
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import BinaryIO
from unittest.mock import Mock, call, patch

from sciretriever.entry.ports import UserOutputConflictError
from sciretriever.model.configuration import (
    Configuration,
    ConfigurationProbeResult,
    ConfigurationProbeSummary,
    CredentialFieldSpec,
    ProbeOutcome,
    ProviderCapability,
    ProviderName,
)
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
    LiteratureReferenceRequest,
)
from sciretriever.model.literature import Identifier, LiteratureStatus, VersionRole
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ReferenceId,
)
from sciretriever.model.report import (
    BibliographyFormat,
    FailedReportEnd,
    ImportReport,
    InterruptedReportEnd,
    StableFailure,
)

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_COMMANDS = {
    "discover": ("topic", "citations"),
    "complete": (),
    "literature": ("search", "show", "references", "cited-by"),
    "import": ("metadata", "pdf"),
    "export": ("metadata", "pdf", "content"),
    "config": ("set", "remove", "status", "test"),
}
FORBIDDEN_COMMANDS = {
    "collection",
    "process",
    "exchange",
    "bibliography",
    "artifact",
    "metadata",
    "acquisition",
    "parsing",
    "analysis",
    "storage",
    "catalog",
    "download",
}
LITERATURE_ID = "00000000-0000-0000-0000-000000000001"
OTHER_LITERATURE_ID = "00000000-0000-0000-0000-000000000002"
META_LITERATURE_ID = "00000000-0000-0000-0000-000000000003"
OTHER_META_LITERATURE_ID = "00000000-0000-0000-0000-000000000004"
DISCOVERY_RUN_ID = "00000000-0000-0000-0000-000000000005"
REFERENCE_ID = "00000000-0000-0000-0000-000000000006"


def _cli_module():
    return importlib.import_module("sciretriever.entry.cli.main")


def _invoke(*arguments: str) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = _cli_module().main(list(arguments))
    return code, stdout.getvalue(), stderr.getvalue()


class _BinaryStandardInput:
    def __init__(self, payload: bytes) -> None:
        self.buffer = io.BytesIO(payload)


class _BinaryStandardOutput(io.StringIO):
    def __init__(self) -> None:
        super().__init__()
        self.binary_buffer = io.BytesIO()

    @property
    def buffer(self) -> BinaryIO:
        return self.binary_buffer


def _invoke_binary_output(*arguments: str) -> tuple[int, str, bytes, str]:
    stdout = _BinaryStandardOutput()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = _cli_module().main(list(arguments))
    return code, stdout.getvalue(), stdout.binary_buffer.getvalue(), stderr.getvalue()


def _positional_commands(help_text: str) -> set[str]:
    lines = help_text.splitlines()
    try:
        command_header = lines.index("  COMMAND")
    except ValueError:
        return set()
    commands: set[str] = set()
    for line in lines[command_header + 1 :]:
        if not line.startswith("    "):
            break
        commands.add(line.split()[0])
    return commands


class _SearchEntryApi:
    def __init__(self) -> None:
        self.requests: list[LibrarySearchRequest] = []

    def search_literature(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        self.requests.append(request)
        return LibrarySearchPage(items=(), total_count=0, next_cursor=None)


class _ObjectGraph:
    def __init__(self, entry_api: _SearchEntryApi) -> None:
        self.entry_api = entry_api


class _RecordingEntryApi:
    def __init__(self) -> None:
        self.topic_requests: list[TopicDiscoveryInput] = []
        self.citation_requests: list[CitationDiscoveryInput] = []
        self.batch_requests: list[BatchRequest] = []
        self.search_requests: list[LibrarySearchRequest] = []
        self.detail_ids: list[LiteratureId] = []
        self.reference_requests: list[LiteratureReferenceRequest] = []
        self.reference_detail_ids: list[ReferenceId] = []
        self.imports: list[tuple[BibliographyFormat, bytes]] = []
        self.manual_pdfs: list[tuple[LiteratureId, bytes]] = []
        self.bibliography_exports: list[tuple[object, object, object, bool]] = []
        self.artifact_exports: list[tuple[object, object, bool]] = []
        self.artifact_opens: list[object] = []
        self.detail_result: object = {"operation": "show"}
        self.artifact_payload = b"artifact-bytes"

    def discover_topic(self, request: TopicDiscoveryInput) -> dict[str, str]:
        self.topic_requests.append(request)
        return {"operation": "topic"}

    def discover_citations(self, request: CitationDiscoveryInput) -> dict[str, str]:
        self.citation_requests.append(request)
        return {"operation": "citations"}

    def complete_database(self, request: BatchRequest) -> dict[str, str]:
        self.batch_requests.append(request)
        return {"operation": "complete"}

    def search_literature(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        self.search_requests.append(request)
        return LibrarySearchPage(items=(), total_count=0, next_cursor=None)

    def get_literature_detail(self, literature_id: LiteratureId) -> object:
        self.detail_ids.append(literature_id)
        return self.detail_result

    def list_literature_references(self, request: LiteratureReferenceRequest) -> dict[str, str]:
        self.reference_requests.append(request)
        return {"operation": "references"}

    def get_reference_detail(self, reference_id: ReferenceId) -> dict[str, str]:
        self.reference_detail_ids.append(reference_id)
        return {"operation": "reference-detail"}

    def import_bibliography(self, format: BibliographyFormat, source: BinaryIO) -> dict[str, str]:
        self.imports.append((format, source.read()))
        return {"operation": "import-metadata"}

    def admit_manual_pdf(self, literature_id: LiteratureId, source: BinaryIO) -> dict[str, str]:
        self.manual_pdfs.append((literature_id, source.read()))
        return {"operation": "import-pdf"}

    def export_bibliography(
        self,
        format: BibliographyFormat,
        selector: object,
        target: object,
        *,
        overwrite: bool = False,
    ) -> dict[str, str]:
        self.bibliography_exports.append((format, selector, target, overwrite))
        return {"operation": "export-metadata"}

    def export_artifact(
        self, reference: object, target: object, *, overwrite: bool = False
    ) -> None:
        self.artifact_exports.append((reference, target, overwrite))

    def open_artifact(self, reference: object):
        self.artifact_opens.append(reference)
        return nullcontext(io.BytesIO(self.artifact_payload))


class _RoutingObjectGraph:
    def __init__(self, entry_api: _RecordingEntryApi) -> None:
        self.entry_api = entry_api
        self.topic_provider_limits = (
            ProviderDiscoveryLimit(provider_name="topic-provider", scan_limit=101),
        )
        self.citation_provider_limits = (
            ProviderDiscoveryLimit(provider_name="citation-provider", scan_limit=202),
        )


class CliCommandTreeTests(unittest.TestCase):
    def test_root_help_contains_exactly_the_six_user_command_groups(self) -> None:
        code, stdout, stderr = _invoke("--help")

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(_positional_commands(stdout), set(EXPECTED_COMMANDS))
        self.assertTrue(_positional_commands(stdout).isdisjoint(FORBIDDEN_COMMANDS))

    def test_each_group_help_contains_only_its_fixed_leaf_paths(self) -> None:
        for group, leaves in EXPECTED_COMMANDS.items():
            with self.subTest(group=group):
                code, stdout, stderr = _invoke(group, "--help")
                self.assertEqual(code, 0)
                self.assertEqual(stderr, "")
                self.assertEqual(_positional_commands(stdout), set(leaves))

    def test_all_fixed_leaf_paths_have_help_without_bootstrapping(self) -> None:
        module = _cli_module()
        with (
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("help must not bootstrap Storage"),
            ),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                side_effect=AssertionError("help must not build a probe session"),
            ),
        ):
            for group, leaves in EXPECTED_COMMANDS.items():
                for leaf in leaves:
                    with self.subTest(path=f"{group} {leaf}"):
                        code, stdout, stderr = _invoke(group, leaf, "--help")
                        self.assertEqual(code, 0)
                        self.assertNotEqual(stdout, "")
                        self.assertEqual(stderr, "")

    def test_unknown_and_retired_paths_are_usage_errors(self) -> None:
        for path in (
            ("catalog",),
            ("exchange",),
            ("literature", "detail"),
            ("config", "check"),
            ("import", "asset"),
        ):
            with self.subTest(path=path):
                code, stdout, stderr = _invoke(*path)
                self.assertEqual(code, 2)
                self.assertEqual(stdout, "")
                self.assertIn("usage:", stderr)
                self.assertNotIn("Traceback", stderr)

    def test_parser_has_no_secret_argument_or_dynamic_runtime_factory(self) -> None:
        source = inspect.getsource(_cli_module())
        forbidden = (
            "SCIRETRIEVER_RUNTIME_FACTORY",
            "import_module(",
            "--api-key",
            "--token",
            "--secret",
            "runtime-factory",
            "service-locator",
        )
        for sentinel in forbidden:
            with self.subTest(sentinel=sentinel):
                self.assertNotIn(sentinel, source)


class CliProductionRoutingTests(unittest.TestCase):
    def test_literature_search_loads_configuration_and_routes_through_production_graph(
        self,
    ) -> None:
        module = _cli_module()
        configuration = Configuration()
        entry_api = _SearchEntryApi()
        graph = _ObjectGraph(entry_api)

        with (
            patch.object(
                module,
                "load_selected_configuration",
                return_value=configuration,
            ) as load_configuration,
            patch.object(
                module,
                "build_production_object_graph",
                return_value=graph,
            ) as build_graph,
        ):
            code, stdout, stderr = _invoke("literature", "search", "--json")

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout), {"items": [], "total_count": 0, "next_cursor": None})
        load_configuration.assert_called_once_with(None)
        build_graph.assert_called_once_with(
            configuration,
            scope=module.ProductionEntryScope.LOCAL_LIBRARY,
        )
        self.assertEqual(
            entry_api.requests,
            [
                LibrarySearchRequest(
                    query=LibraryQuery(),
                    sort="publication-year-desc",
                    limit=50,
                    cursor=None,
                )
            ],
        )

    def test_each_business_command_selects_only_its_required_production_scope(self) -> None:
        module = _cli_module()
        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)
        cases = (
            (("discover", "topic", "query", "--json"), module.ProductionEntryScope.TOPIC_DISCOVERY),
            (
                (
                    "discover",
                    "citations",
                    "--seed-literature-id",
                    LITERATURE_ID,
                    "--json",
                ),
                module.ProductionEntryScope.CITATION_DISCOVERY,
            ),
            (
                ("complete", "pdf", "--all-pending", "--json"),
                module.ProductionEntryScope.ASSET_COMPLETION,
            ),
            (
                ("complete", "content", "--all-pending", "--json"),
                module.ProductionEntryScope.CONTENT_COMPLETION,
            ),
            (
                ("literature", "search", "--json"),
                module.ProductionEntryScope.LOCAL_LIBRARY,
            ),
            (
                ("literature", "show", LITERATURE_ID, "--json"),
                module.ProductionEntryScope.LOCAL_LIBRARY,
            ),
            (
                ("literature", "references", LITERATURE_ID, "--json"),
                module.ProductionEntryScope.LOCAL_LIBRARY,
            ),
            (
                ("literature", "cited-by", LITERATURE_ID, "--json"),
                module.ProductionEntryScope.LOCAL_LIBRARY,
            ),
            (
                ("import", "metadata", "ris", "-", "--json"),
                module.ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE,
            ),
            (
                ("import", "pdf", LITERATURE_ID, "-", "--json"),
                module.ProductionEntryScope.MANUAL_PDF,
            ),
            (
                ("export", "metadata", "ris", "output.ris", "--json"),
                module.ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE,
            ),
        )
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(module, "build_production_object_graph", return_value=graph) as build,
            patch.object(module.sys, "stdin", _BinaryStandardInput(b"input")),
        ):
            for arguments, expected_scope in cases:
                with self.subTest(arguments=arguments):
                    build.reset_mock()
                    _invoke(*arguments)
                    build.assert_called_once_with(Configuration(), scope=expected_scope)

    def test_discovery_commands_build_exact_neutral_models_with_graph_limits(self) -> None:
        module = _cli_module()
        configuration = Configuration()
        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)

        with (
            patch.object(module, "load_selected_configuration", return_value=configuration),
            patch.object(module, "build_production_object_graph", return_value=graph),
        ):
            topic = _invoke(
                "discover",
                "topic",
                "  quantum materials  ",
                "--year-from",
                "2019",
                "--year-to",
                "2024",
                "--json",
            )
            citations = _invoke(
                "discover",
                "citations",
                "--seed-literature-id",
                LITERATURE_ID,
                "--seed-literature-id",
                OTHER_LITERATURE_ID,
                "--direction",
                "both",
                "--max-depth",
                "3",
                "--result-limit",
                "125",
                "--json",
            )

        self.assertEqual(topic, (0, '{"operation":"topic"}\n', ""))
        self.assertEqual(citations, (0, '{"operation":"citations"}\n', ""))
        self.assertEqual(
            entry_api.topic_requests,
            [
                TopicDiscoveryInput(
                    kind="topic",
                    query="quantum materials",
                    year_from=2019,
                    year_to=2024,
                    providers=graph.topic_provider_limits,
                )
            ],
        )
        self.assertEqual(
            entry_api.citation_requests,
            [
                CitationDiscoveryInput(
                    kind="citation",
                    seed_literature_ids=(
                        LiteratureId(LITERATURE_ID),
                        LiteratureId(OTHER_LITERATURE_ID),
                    ),
                    direction="both",
                    max_depth=3,
                    result_limit=125,
                    providers=graph.citation_provider_limits,
                )
            ],
        )

    def test_complete_supports_all_six_exclusive_selectors_and_goal_mapping(self) -> None:
        module = _cli_module()
        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)
        cases = (
            (("--all-pending",), AllPendingSelector(kind="all-pending")),
            (
                ("--discovery-run-id", DISCOVERY_RUN_ID),
                DiscoveryRunSelector(
                    kind="discovery-run",
                    discovery_run_id=DiscoveryRunId(DISCOVERY_RUN_ID),
                ),
            ),
            (
                (
                    "--import-meta-literature-id",
                    META_LITERATURE_ID,
                    "--import-meta-literature-id",
                    OTHER_META_LITERATURE_ID,
                ),
                ImportReportSelector(
                    kind="import-report",
                    meta_literature_ids=(
                        MetaLiteratureId(META_LITERATURE_ID),
                        MetaLiteratureId(OTHER_META_LITERATURE_ID),
                    ),
                ),
            ),
            (
                ("--query", "orbital material"),
                QuerySelector(kind="query", query=LibraryQuery(text="orbital material")),
            ),
            (
                (
                    "--meta-literature-id",
                    META_LITERATURE_ID,
                    "--meta-literature-id",
                    OTHER_META_LITERATURE_ID,
                ),
                MetaLiteratureSelector(
                    kind="meta-literatures",
                    meta_literature_ids=(
                        MetaLiteratureId(META_LITERATURE_ID),
                        MetaLiteratureId(OTHER_META_LITERATURE_ID),
                    ),
                ),
            ),
            (
                (
                    "--literature-id",
                    LITERATURE_ID,
                    "--literature-id",
                    OTHER_LITERATURE_ID,
                ),
                LiteratureSelector(
                    kind="literatures",
                    literature_ids=(
                        LiteratureId(LITERATURE_ID),
                        LiteratureId(OTHER_LITERATURE_ID),
                    ),
                ),
            ),
        )

        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(module, "build_production_object_graph", return_value=graph),
        ):
            for index, (selector_arguments, expected_selector) in enumerate(cases):
                with self.subTest(selector=expected_selector.kind):
                    goal = "pdf" if index % 2 == 0 else "content"
                    code, stdout, stderr = _invoke("complete", goal, *selector_arguments, "--json")
                    self.assertEqual((code, stderr), (0, ""))
                    self.assertEqual(json.loads(stdout), {"operation": "complete"})
                    self.assertEqual(
                        entry_api.batch_requests[-1],
                        BatchRequest(
                            selector=expected_selector,
                            goal="ASSET_READY" if goal == "pdf" else "CONTENT_READY",
                        ),
                    )

    def test_complete_rejects_missing_or_multiple_selectors_before_bootstrap(self) -> None:
        module = _cli_module()
        with patch.object(
            module,
            "build_production_object_graph",
            side_effect=AssertionError("invalid input must not bootstrap"),
        ):
            for arguments in (
                ("complete", "pdf"),
                (
                    "complete",
                    "content",
                    "--all-pending",
                    "--literature-id",
                    LITERATURE_ID,
                ),
            ):
                with self.subTest(arguments=arguments):
                    code, stdout, stderr = _invoke(*arguments)
                    self.assertEqual(code, 2)
                    self.assertEqual(stdout, "")
                    self.assertIn("usage:", stderr)

    def test_literature_search_maps_the_full_closed_query_surface(self) -> None:
        module = _cli_module()
        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)
        arguments = (
            "literature",
            "search",
            "--text",
            "topological",
            "--title",
            "specific title",
            "--author",
            "Ada",
            "--author-orcid",
            "0000-0002-1825-0097",
            "--identifier",
            "doi:10.1000/ABC",
            "--year-from",
            "2018",
            "--year-to",
            "2025",
            "--venue",
            "Journal",
            "--publisher",
            "Publisher",
            "--document-type",
            "article",
            "--language",
            "en",
            "--keyword",
            "quantum",
            "--version-role",
            "published",
            "--status",
            "CONTENT_READY",
            "--missing-step",
            "parser-result",
            "--needs-manual-pdf",
            "--discovery-run-id",
            DISCOVERY_RUN_ID,
            "--sort",
            "relevance",
            "--limit",
            "23",
            "--cursor",
            "opaque cursor",
            "--json",
        )
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(module, "build_production_object_graph", return_value=graph),
        ):
            code, stdout, stderr = _invoke(*arguments)

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(json.loads(stdout)["total_count"], 0)
        self.assertEqual(
            entry_api.search_requests,
            [
                LibrarySearchRequest(
                    query=LibraryQuery(
                        text="topological",
                        title="specific title",
                        author="Ada",
                        author_orcids=("0000-0002-1825-0097",),
                        identifiers=(Identifier(namespace="doi", value="10.1000/ABC"),),
                        publication_year_from=2018,
                        publication_year_to=2025,
                        venue="Journal",
                        publisher="Publisher",
                        document_types=("article",),
                        languages=("en",),
                        keywords=("quantum",),
                        version_roles=(VersionRole.PUBLISHED,),
                        statuses=(LiteratureStatus.CONTENT_READY,),
                        missing_steps=("parser-result",),
                        needs_manual_pdf=True,
                        discovery_run_ids=(DiscoveryRunId(DISCOVERY_RUN_ID),),
                    ),
                    sort="relevance",
                    limit=23,
                    cursor="opaque cursor",
                )
            ],
        )

    def test_literature_detail_reference_list_and_reference_detail_routing(self) -> None:
        module = _cli_module()
        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(module, "build_production_object_graph", return_value=graph),
        ):
            results = (
                _invoke("literature", "show", LITERATURE_ID, "--json"),
                _invoke(
                    "literature",
                    "references",
                    LITERATURE_ID,
                    "--limit",
                    "17",
                    "--cursor",
                    "next",
                    "--json",
                ),
                _invoke(
                    "literature",
                    "references",
                    "--reference-id",
                    REFERENCE_ID,
                    "--json",
                ),
                _invoke("literature", "cited-by", LITERATURE_ID, "--json"),
            )

        self.assertTrue(all(code == 0 and stderr == "" for code, _stdout, stderr in results))
        self.assertEqual(entry_api.detail_ids, [LiteratureId(LITERATURE_ID)])
        first, second = entry_api.reference_requests
        self.assertEqual(first.literature_id, LiteratureId(LITERATURE_ID))
        self.assertEqual((first.direction, first.limit, first.cursor), ("references", 17, "next"))
        self.assertEqual(second.literature_id, LiteratureId(LITERATURE_ID))
        self.assertEqual(second.direction, "cited-by")
        self.assertEqual(entry_api.reference_detail_ids, [ReferenceId(REFERENCE_ID)])


class CliExchangeRoutingTests(unittest.TestCase):
    def _patched_graph(self, entry_api: _RecordingEntryApi):
        module = _cli_module()
        return (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_object_graph",
                return_value=_RoutingObjectGraph(entry_api),
            ),
        )

    def test_import_metadata_and_pdf_pass_only_binary_streams_and_neutral_ids(self) -> None:
        entry_api = _RecordingEntryApi()
        with tempfile.TemporaryDirectory(prefix="sciretriever-cli-") as directory:
            root = Path(directory)
            metadata = root / "private-library.ris"
            pdf = root / "private-paper.pdf"
            metadata_payload = b"TY  - JOUR\nER  -\n"
            pdf_payload = b"%PDF-1.7\nfixture"
            metadata.write_bytes(metadata_payload)
            pdf.write_bytes(pdf_payload)
            first, second = self._patched_graph(entry_api)
            with first, second:
                metadata_result = _invoke("import", "metadata", "ris", str(metadata), "--json")
                pdf_result = _invoke("import", "pdf", LITERATURE_ID, str(pdf), "--json")

        self.assertEqual(metadata_result, (0, '{"operation":"import-metadata"}\n', ""))
        self.assertEqual(pdf_result, (0, '{"operation":"import-pdf"}\n', ""))
        self.assertEqual(entry_api.imports, [(BibliographyFormat.RIS, metadata_payload)])
        self.assertEqual(
            entry_api.manual_pdfs,
            [(LiteratureId(LITERATURE_ID), pdf_payload)],
        )
        combined = "".join(metadata_result[1:] + pdf_result[1:])
        self.assertNotIn(str(metadata), combined)
        self.assertNotIn(str(pdf), combined)

    def test_import_commands_support_controlled_binary_stdin(self) -> None:
        module = _cli_module()
        entry_api = _RecordingEntryApi()
        first, second = self._patched_graph(entry_api)
        stdin = _BinaryStandardInput(b"stdin bibliography")
        with first, second, patch.object(module.sys, "stdin", stdin):
            code, stdout, stderr = _invoke("import", "metadata", "csl-json", "-", "--json")

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(json.loads(stdout), {"operation": "import-metadata"})
        self.assertEqual(
            entry_api.imports,
            [(BibliographyFormat.CSL_JSON, b"stdin bibliography")],
        )

    def test_export_metadata_maps_each_supported_scope_and_atomic_target(self) -> None:
        entry_api = _RecordingEntryApi()
        scopes = (
            ((), None),
            (
                ("--discovery-run-id", DISCOVERY_RUN_ID),
                DiscoveryRunSelector(
                    kind="discovery-run", discovery_run_id=DiscoveryRunId(DISCOVERY_RUN_ID)
                ),
            ),
            (
                ("--query", "material"),
                QuerySelector(kind="query", query=LibraryQuery(text="material")),
            ),
            (
                ("--meta-literature-id", META_LITERATURE_ID),
                MetaLiteratureSelector(
                    kind="meta-literatures",
                    meta_literature_ids=(MetaLiteratureId(META_LITERATURE_ID),),
                ),
            ),
            (
                ("--literature-id", LITERATURE_ID),
                LiteratureSelector(
                    kind="literatures",
                    literature_ids=(LiteratureId(LITERATURE_ID),),
                ),
            ),
        )
        first, second = self._patched_graph(entry_api)
        with first, second, tempfile.TemporaryDirectory(prefix="sciretriever-cli-") as directory:
            target = Path(directory) / "export.json"
            for arguments, expected_scope in scopes:
                code, stdout, stderr = _invoke(
                    "export",
                    "metadata",
                    "csl-json",
                    str(target),
                    *arguments,
                    "--overwrite",
                    "--json",
                )
                self.assertEqual((code, stderr), (0, ""))
                self.assertEqual(json.loads(stdout), {"operation": "export-metadata"})
                self.assertEqual(
                    entry_api.bibliography_exports[-1],
                    (BibliographyFormat.CSL_JSON, expected_scope, str(target), True),
                )

    def test_export_pdf_and_content_select_detail_artifacts_for_file_targets(self) -> None:
        entry_api = _RecordingEntryApi()
        pdf_reference = object()
        content_reference = object()
        entry_api.detail_result = SimpleNamespace(
            primary_pdf=SimpleNamespace(asset=pdf_reference),
            content=SimpleNamespace(markdown=content_reference),
        )
        first, second = self._patched_graph(entry_api)
        with first, second, tempfile.TemporaryDirectory(prefix="sciretriever-cli-") as directory:
            pdf_target = str(Path(directory) / "paper.pdf")
            content_target = str(Path(directory) / "paper.md")
            pdf_result = _invoke(
                "export", "pdf", LITERATURE_ID, pdf_target, "--overwrite", "--json"
            )
            content_result = _invoke(
                "export",
                "content",
                LITERATURE_ID,
                content_target,
                "--overwrite",
                "--json",
            )

        self.assertEqual(pdf_result, (0, "true\n", ""))
        self.assertEqual(content_result, (0, "true\n", ""))
        self.assertEqual(
            entry_api.artifact_exports,
            [(pdf_reference, pdf_target, True), (content_reference, content_target, True)],
        )

    def test_export_artifact_output_conflict_is_a_stable_business_failure(self) -> None:
        entry_api = _RecordingEntryApi()
        reference = object()
        entry_api.detail_result = SimpleNamespace(
            primary_pdf=SimpleNamespace(asset=reference),
            content=None,
        )
        first, second = self._patched_graph(entry_api)
        private_target = "/private/user/existing-paper.pdf"
        with (
            first,
            second,
            patch.object(
                entry_api,
                "export_artifact",
                side_effect=UserOutputConflictError(private_target),
            ),
        ):
            code, stdout, stderr = _invoke("export", "pdf", LITERATURE_ID, private_target, "--json")

        self.assertEqual((code, stdout, stderr), (3, "", "output target already exists.\n"))
        self.assertNotIn(private_target, stderr)

    def test_export_artifact_to_stdout_uses_verified_open_and_raw_bytes_only(self) -> None:
        entry_api = _RecordingEntryApi()
        reference = object()
        entry_api.detail_result = SimpleNamespace(
            primary_pdf=SimpleNamespace(asset=reference),
            content=None,
        )
        first, second = self._patched_graph(entry_api)
        with first, second:
            code, text_output, binary_output, stderr = _invoke_binary_output(
                "export", "pdf", LITERATURE_ID, "-"
            )

        self.assertEqual((code, text_output, stderr), (0, "", ""))
        self.assertEqual(binary_output, entry_api.artifact_payload)
        self.assertEqual(entry_api.artifact_opens, [reference])
        self.assertEqual(entry_api.artifact_exports, [])

    def test_binary_stdout_rejects_json_and_missing_detail_artifacts_are_business_failures(
        self,
    ) -> None:
        module = _cli_module()
        with patch.object(
            module,
            "build_production_object_graph",
            side_effect=AssertionError("usage errors must not bootstrap"),
        ):
            code, stdout, stderr = _invoke("export", "pdf", LITERATURE_ID, "-", "--json")
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("usage:", stderr)

        entry_api = _RecordingEntryApi()
        entry_api.detail_result = SimpleNamespace(primary_pdf=None, content=None)
        first, second = self._patched_graph(entry_api)
        with first, second:
            pdf_result = _invoke("export", "pdf", LITERATURE_ID, "unused.pdf", "--json")
            content_result = _invoke("export", "content", LITERATURE_ID, "unused.md", "--json")
        for code, stdout, stderr in (pdf_result, content_result):
            self.assertEqual(code, 3)
            self.assertEqual(stdout, "")
            self.assertIn("not available", stderr)


class CliConfigurationTests(unittest.TestCase):
    def test_config_set_collects_all_fields_without_echo_and_honors_replace_cancel(
        self,
    ) -> None:
        module = _cli_module()
        specs = (
            CredentialFieldSpec(name="api_key", required=True),
            CredentialFieldSpec(name="institution_token", required=False),
        )
        with (
            patch.object(module, "credential_field_specs", return_value=specs),
            patch.object(module, "credential_section_exists", return_value=True),
            patch.object(module, "set_credentials") as set_credentials,
            patch.object(module, "_confirm", return_value=False),
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("config set must not build Storage"),
            ),
        ):
            cancelled = _invoke("config", "set", "elsevier", "--json")

        self.assertEqual(cancelled, (0, '{"provider":"elsevier","status":"cancelled"}\n', ""))
        set_credentials.assert_not_called()

        secret = "set-secret-sentinel"
        optional = "optional-secret-sentinel"
        with (
            patch.object(module, "credential_field_specs", return_value=specs),
            patch.object(module, "credential_section_exists", return_value=True),
            patch.object(module, "_confirm", return_value=True),
            patch.object(module.getpass, "getpass", side_effect=(secret, optional)) as hidden_input,
            patch.object(module, "set_credentials") as set_credentials,
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("config set must not build Storage"),
            ),
        ):
            replaced = _invoke("config", "set", "elsevier", "--json")

        self.assertEqual(replaced, (0, '{"provider":"elsevier","status":"replaced"}\n', ""))
        self.assertEqual(hidden_input.call_count, 2)
        set_credentials.assert_called_once_with(
            "elsevier",
            {"api_key": secret, "institution_token": optional},
            home=None,
        )
        rendered = "".join(replaced[1:])
        self.assertNotIn(secret, rendered)
        self.assertNotIn(optional, rendered)

    def test_config_set_omits_blank_optional_and_rejects_blank_required_without_write(
        self,
    ) -> None:
        module = _cli_module()
        specs = (
            CredentialFieldSpec(name="api_key", required=True),
            CredentialFieldSpec(name="institution_token", required=False),
        )
        with (
            patch.object(module, "credential_field_specs", return_value=specs),
            patch.object(module, "credential_section_exists", return_value=False),
            patch.object(module.getpass, "getpass", side_effect=("required-value", "   ")),
            patch.object(module, "set_credentials") as set_credentials,
        ):
            result = _invoke("config", "set", "elsevier", "--json")
        self.assertEqual(result, (0, '{"provider":"elsevier","status":"created"}\n', ""))
        set_credentials.assert_called_once_with(
            "elsevier", {"api_key": "required-value"}, home=None
        )

        with (
            patch.object(module, "credential_field_specs", return_value=specs),
            patch.object(module, "credential_section_exists", return_value=False),
            patch.object(module.getpass, "getpass", side_effect=("", "unused")),
            patch.object(module, "set_credentials") as set_credentials,
        ):
            code, stdout, stderr = _invoke("config", "set", "elsevier", "--json")
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("required credential field was empty", stderr)
        set_credentials.assert_not_called()

    def test_config_remove_distinguishes_removed_and_not_configured_without_storage(
        self,
    ) -> None:
        module = _cli_module()
        with (
            patch.object(module, "credential_section_exists", side_effect=(True, False)),
            patch.object(module, "remove_credentials") as remove_credentials,
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("config remove must not build Storage"),
            ),
        ):
            removed = _invoke("config", "remove", "web-of-science", "--json")
            missing = _invoke("config", "remove", "web-of-science", "--json")

        self.assertEqual(removed, (0, '{"provider":"web-of-science","status":"removed"}\n', ""))
        self.assertEqual(
            missing,
            (0, '{"provider":"web-of-science","status":"not-configured"}\n', ""),
        )
        remove_credentials.assert_called_once_with("web-of-science", home=None)

    def test_config_status_uses_configuration_boundary_only_and_omits_fingerprint(self) -> None:
        module = _cli_module()
        status = {
            "configuration_fingerprint": "sha256:" + "f" * 64,
            "capabilities": [{"provider": "crossref", "status": "configured"}],
        }
        with (
            patch.object(
                module, "load_selected_configuration", return_value=Configuration()
            ) as load_configuration,
            patch.object(
                module, "configuration_status", return_value=status
            ) as configuration_status,
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("config status must not build Storage"),
            ),
        ):
            code, stdout, stderr = _invoke("config", "status", "--json")

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(
            json.loads(stdout),
            {"capabilities": [{"provider": "crossref", "status": "configured"}]},
        )
        self.assertNotIn("fingerprint", stdout)
        load_configuration.assert_called_once_with(None)
        configuration_status.assert_called_once_with(
            load_configuration.return_value, credentials_home=None
        )

    def test_config_test_routes_named_and_all_to_probe_session_and_uses_result_exit_code(
        self,
    ) -> None:
        module = _cli_module()
        passed = ConfigurationProbeSummary(
            results=(
                ConfigurationProbeResult(
                    provider=ProviderName.CROSSREF,
                    capability=ProviderCapability.METADATA,
                    outcome=ProbeOutcome.PASSED,
                    local_ready=True,
                    network_reachable=True,
                    authentication_accepted=True,
                    api_product_usable=True,
                    minimal_response_parseable=True,
                ),
            )
        )
        skipped = ConfigurationProbeSummary(
            results=(
                ConfigurationProbeResult(
                    provider=ProviderName.WEB_OF_SCIENCE,
                    capability=ProviderCapability.METADATA,
                    outcome=ProbeOutcome.SKIPPED,
                    local_ready=False,
                    failure_code="credentials-missing",
                ),
            )
        )

        session = Mock()
        session.run.side_effect = (passed, skipped)
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ) as build_probe,
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("config test must not build Storage"),
            ),
        ):
            named = _invoke("config", "test", "crossref", "--json")
            all_result = _invoke("config", "test", "--all", "--json")

        self.assertEqual(named[0], 0)
        self.assertEqual(all_result[0], 3)
        self.assertEqual((named[2], all_result[2]), ("", ""))
        self.assertEqual(
            json.loads(named[1])["results"][0]["acquisition_entitlement"],
            "not-proven",
        )
        self.assertEqual(
            json.loads(all_result[1])["results"][0]["acquisition_entitlement"],
            "not-proven",
        )
        self.assertEqual(
            session.run.call_args_list,
            [
                call(provider="crossref", test_all=False),
                call(provider=None, test_all=True),
            ],
        )
        self.assertEqual(build_probe.call_count, 2)

    def test_config_test_named_provider_and_all_are_parser_exclusive(self) -> None:
        module = _cli_module()
        with patch.object(
            module,
            "build_production_configuration_probe_session",
            side_effect=AssertionError("invalid selection must not build probes"),
        ):
            code, stdout, stderr = _invoke("config", "test", "crossref", "--all", "--json")
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("usage:", stderr)


class CliResultAndFailureBoundaryTests(unittest.TestCase):
    def test_config_replacement_prompt_is_stderr_and_json_stdout_remains_one_value(self) -> None:
        module = _cli_module()
        with (
            patch.object(module, "credential_field_specs", return_value=()),
            patch.object(module, "credential_section_exists", return_value=True),
            patch.object(module.sys, "stdin", io.StringIO("n\n")),
            patch.object(module, "set_credentials") as set_credentials,
        ):
            code, stdout, stderr = _invoke("config", "set", "elsevier", "--json")

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout), {"provider": "elsevier", "status": "cancelled"})
        self.assertEqual(stdout.count("\n"), 1)
        self.assertIn("Replace credentials", stderr)
        self.assertNotIn("Replace credentials", stdout)
        set_credentials.assert_not_called()

    def test_typed_failed_and_interrupted_reports_are_the_only_json_stdout_value(self) -> None:
        module = _cli_module()
        failed = ImportReport(
            kind="import",
            end=FailedReportEnd(
                kind="failed",
                failure=StableFailure(
                    code="import-failed",
                    reason="The import could not finish.",
                    action="Check the input and retry.",
                    retryable=True,
                ),
            ),
            format=BibliographyFormat.RIS,
            input_record_count=0,
            records=(),
            not_processed_record_indexes=(),
            accepted_meta_literature_ids=(),
        )
        interrupted = ImportReport(
            kind="import",
            end=InterruptedReportEnd(kind="interrupted"),
            format=BibliographyFormat.RIS,
            input_record_count=0,
            records=(),
            not_processed_record_indexes=(),
            accepted_meta_literature_ids=(),
        )
        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(module, "build_production_object_graph", return_value=graph),
            patch.object(entry_api, "import_bibliography", side_effect=(failed, interrupted)),
            patch.object(module.sys, "stdin", _BinaryStandardInput(b"input")),
        ):
            failed_result = _invoke("import", "metadata", "ris", "-", "--json")
            interrupted_result = _invoke("import", "metadata", "ris", "-", "--json")

        self.assertEqual(failed_result[0], 3)
        self.assertEqual(interrupted_result[0], 130)
        for _code, stdout, stderr in (failed_result, interrupted_result):
            self.assertEqual(stderr, "")
            self.assertEqual(stdout.count("\n"), 1)
            self.assertIsInstance(json.loads(stdout), dict)

    def test_configuration_bootstrap_and_io_errors_are_redacted(self) -> None:
        module = _cli_module()
        sentinel = "secret-sentinel"
        private_path = "/private/user/catalog.db"
        external_url = "https://provider.invalid/path?token=secret-sentinel"
        cases = (
            (
                module.ConfigurationError(f"api_key={sentinel} {private_path}"),
                4,
                "configuration operation failed",
            ),
            (
                module.BootstrapError("paths-not-ready"),
                4,
                "bootstrap failed (paths-not-ready)",
            ),
            (OSError(f"{private_path}: {sentinel}"), 70, "internal operation failed"),
        )
        for exception, expected_code, expected_message in cases:
            with (
                self.subTest(exception=type(exception).__name__),
                patch.object(module, "load_selected_configuration", side_effect=exception),
            ):
                code, stdout, stderr = _invoke("literature", "search", "--json")
            self.assertEqual(code, expected_code)
            self.assertEqual(stdout, "")
            self.assertIn(expected_message, stderr)
            combined = stdout + stderr
            for unsafe in (sentinel, private_path, external_url, "Traceback", "ValueError"):
                self.assertNotIn(unsafe, combined)

    def test_unexpected_programming_errors_propagate_to_the_top_level_boundary(self) -> None:
        module = _cli_module()
        sentinel = "programming-error-sentinel"
        for exception in (
            AssertionError(sentinel),
            RuntimeError(sentinel),
            TypeError(sentinel),
        ):
            with (
                self.subTest(exception=type(exception).__name__),
                patch.object(module, "load_selected_configuration", side_effect=exception),
                self.assertRaises(type(exception)) as captured,
                redirect_stdout(io.StringIO()) as stdout,
                redirect_stderr(io.StringIO()) as stderr,
            ):
                module.main(["literature", "search", "--json"])
            self.assertIs(captured.exception, exception)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "")

    def test_pydantic_and_cli_value_errors_are_usage_failures_without_traceback(self) -> None:
        module = _cli_module()
        with (
            patch.object(
                module,
                "build_production_object_graph",
                return_value=_RoutingObjectGraph(_RecordingEntryApi()),
            ),
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
        ):
            results = (
                _invoke("discover", "topic", "   ", "--json"),
                _invoke("literature", "search", "--identifier", "malformed", "--json"),
                _invoke("literature", "show", "not-a-uuid", "--json"),
            )
        for code, stdout, stderr in results:
            self.assertEqual(code, 2)
            self.assertEqual(stdout, "")
            self.assertIn("invalid command input", stderr)
            self.assertNotIn("Traceback", stderr)

    def test_keyboard_interrupt_is_stable_and_does_not_print_exception_material(self) -> None:
        module = _cli_module()
        with patch.object(
            module,
            "load_selected_configuration",
            side_effect=KeyboardInterrupt("secret-sentinel /private/path"),
        ):
            code, stdout, stderr = _invoke("literature", "search", "--json")
        self.assertEqual((code, stdout), (130, ""))
        self.assertEqual(stderr, "operation interrupted.\n")
        self.assertNotIn("secret-sentinel", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_argparse_does_not_echo_secret_like_or_path_like_invalid_values(self) -> None:
        sentinel = "secret-sentinel"
        unsafe = f"/private/user/{sentinel}"
        code, stdout, stderr = _invoke("literature", "search", "--sort", unsafe)
        self.assertEqual((code, stdout), (2, ""))
        self.assertIn("usage:", stderr)
        self.assertIn("invalid command input", stderr)
        self.assertNotIn(unsafe, stderr)
        self.assertNotIn(sentinel, stderr)


class CliInstallationEntryTests(unittest.TestCase):
    def test_project_script_targets_the_same_main_as_python_m(self) -> None:
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        main_source = (ROOT / "src" / "sciretriever" / "__main__.py").read_text(encoding="utf-8")

        self.assertIn("[project.scripts]", pyproject)
        self.assertIn('sciretriever = "sciretriever.entry.cli.main:main"', pyproject)
        self.assertIn("from sciretriever.entry.cli.main import main", main_source)
        self.assertIn("raise SystemExit(main())", main_source)

    def test_main_uses_process_arguments_when_argv_is_omitted(self) -> None:
        with patch.object(sys, "argv", ["sciretriever", "--help"]):
            code, stdout, stderr = _invoke_process_main()

        self.assertEqual(code, 0)
        self.assertIn("discover", stdout)
        self.assertEqual(stderr, "")


def _invoke_process_main() -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = _cli_module().main()
    return code, stdout.getvalue(), stderr.getvalue()


if __name__ == "__main__":
    unittest.main()
