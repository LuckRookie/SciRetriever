from __future__ import annotations

import importlib
import inspect
import io
import json
import logging
import sys
import tempfile
import unittest
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import Any, BinaryIO
from unittest.mock import Mock, call, patch

from sciretriever.entry.ports import UserOutputConflictError
from sciretriever.model.configuration import (
    AccessConfig,
    AgentAuthentication,
    AgentConfigurationProbeDetails,
    AgentProtocol,
    AgentProvider,
    AgentRoleConfig,
    AgentsConfig,
    AnalysisConfigurationStatus,
    BrowserConfigurationProbeResult,
    BrowserProfilePresence,
    BrowserProfileStatus,
    Configuration,
    ConfigurationCapabilityStatus,
    ConfigurationProbeResult,
    ConfigurationProbeSummary,
    ConfigurationRuntimeStatus,
    ConfigurationStatus,
    CoreConfigurationProbeResult,
    CoreCredentialService,
    CredentialFieldSpec,
    CredentialFieldStatus,
    CredentialStatus,
    MinerUConfigurationProbeDetails,
    ParserConnectionMode,
    ParsingConfigurationStatus,
    ProbeOutcome,
    ProviderCapability,
    ProviderCredentialStatus,
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
    DatabaseCompletionReport,
    FailedCompletionTarget,
    FailedReportEnd,
    FinishedReportEnd,
    GoalReachedTarget,
    ImportReport,
    InterruptedCompletionTarget,
    InterruptedReportEnd,
    LiteratureCompletionTarget,
    NeedsManualPdfTarget,
    NotStartedCompletionTarget,
    ReportEnd,
    StableFailure,
)

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_COMMANDS = {
    "discover": ("topic", "citations"),
    "complete": (),
    "literature": ("search", "show", "references", "cited-by"),
    "import": ("metadata", "pdf"),
    "export": ("metadata", "pdf", "content"),
    "config": ("status", "test"),
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
        self.completion_result: object = {"operation": "complete"}
        self.artifact_payload = b"artifact-bytes"

    def discover_topic(self, request: TopicDiscoveryInput) -> dict[str, str]:
        self.topic_requests.append(request)
        return {"operation": "topic"}

    def discover_citations(self, request: CitationDiscoveryInput) -> dict[str, str]:
        self.citation_requests.append(request)
        return {"operation": "citations"}

    def complete_database(self, request: BatchRequest) -> object:
        self.batch_requests.append(request)
        return self.completion_result

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
        self.close_calls = 0
        self.topic_provider_limits = (
            ProviderDiscoveryLimit(provider_name="topic-provider", scan_limit=101),
        )
        self.citation_provider_limits = (
            ProviderDiscoveryLimit(provider_name="citation-provider", scan_limit=202),
        )

    def close(self) -> None:
        self.close_calls += 1


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
            ("config", "set"),
            ("config", "remove"),
            ("config", "--json"),
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

    def test_debug_option_selects_debug_logging_for_the_production_graph(self) -> None:
        module = _cli_module()
        configuration = Configuration()
        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)

        with (
            patch.object(module, "load_selected_configuration", return_value=configuration),
            patch.object(
                module,
                "build_production_object_graph",
                return_value=graph,
            ) as build_graph,
        ):
            code, _stdout, stderr = _invoke(
                "complete",
                "pdf",
                "--all-pending",
                "--debug",
                "--json",
            )

        self.assertEqual((code, stderr), (0, ""))
        build_graph.assert_called_once_with(
            configuration,
            scope=module.ProductionEntryScope.ASSET_COMPLETION,
            logging_level=logging.DEBUG,
        )
        self.assertEqual(graph.close_calls, 1)

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
    @staticmethod
    def _provider_access_overview(module: Any) -> Any:
        return module._ProviderAccessOverview(
            api_routes=(
                ("CORE", "Ready", "Locally ready."),
                ("Elsevier / Scopus", "Action required", "Configure the API credential."),
                ("Wiley Online Library", "Available", "Enable the Provider."),
            ),
            browser_state="Disabled",
            browser_detail=(
                "No profile is selected. One fixed-profile CloakBrowser process is shared by "
                "Publisher lanes."
            ),
            browser_action="Select and initialize a profile to enable Browser-last access.",
            profile_presence=BrowserProfilePresence.MISSING,
        )

    def test_plain_manager_configures_official_llm_and_never_renders_secret(self) -> None:
        module = _cli_module()
        secret = "llm-manager-secret-sentinel"
        browser_role = AgentRoleConfig(
            model="browser-model",
            context_window_tokens=32_768,
            max_output_tokens=2_048,
            image_input=True,
            tool_decision=True,
            image_media_types=("image/png",),
            image_count=1,
            image_bytes=1_024,
            turns=2,
        )
        before = Configuration(agents=AgentsConfig(browser=browser_role))
        with (
            patch(
                "builtins.input",
                side_effect=("l", "1", "1", "fixture-model", "", "2", "y", "b", "q"),
            ),
            patch.object(module.getpass, "getpass", return_value=secret),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=before),
            patch.object(module, "update_core_service_configuration") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("LLM Analysis", stderr)
        self.assertIn("Proposed ordinary configuration changes", stderr)
        self.assertIn("configuration was saved", stderr)
        self.assertNotIn(secret, stdout + stderr)
        update.assert_called_once()
        call_args = update.call_args
        self.assertEqual(call_args.args[:2], (Path("config.toml"), "agents"))
        candidate = call_args.kwargs["agents"]
        self.assertIsInstance(candidate, AgentsConfig)
        self.assertIs(candidate.protocol, AgentProtocol.OPENAI_RESPONSES)
        self.assertIs(candidate.authentication, AgentAuthentication.API_KEY)
        self.assertEqual(candidate.base_url, "https://api.openai.com/v1")
        self.assertEqual(candidate.analysis.model, "fixture-model")
        self.assertEqual(candidate.analysis.context_window_tokens, 1_000_000)
        self.assertEqual(candidate.browser, browser_role)
        self.assertEqual(call_args.kwargs["secret"], secret)
        self.assertEqual(call_args.kwargs["origin"], "https://api.openai.com")

    def test_plain_manager_configures_loopback_llm_without_reading_secret(self) -> None:
        module = _cli_module()
        before = Configuration()
        with (
            patch(
                "builtins.input",
                side_effect=(
                    "l",
                    "1",
                    "3",
                    "local-llm",
                    "2",
                    "http://127.0.0.1:1234/v1",
                    "2",
                    "local-model",
                    "128000",
                    "1",
                    "y",
                    "b",
                    "q",
                ),
            ),
            patch.object(
                module.getpass,
                "getpass",
                side_effect=AssertionError("loopback none-auth must not request a secret"),
            ),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=before),
            patch.object(module, "update_core_service_configuration") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("configuration was saved", stderr)
        candidate = update.call_args.kwargs["agents"]
        self.assertIs(candidate.protocol, AgentProtocol.OPENAI_CHAT_COMPLETIONS)
        self.assertIs(candidate.authentication, AgentAuthentication.NONE)
        self.assertEqual(update.call_args.kwargs["secret"], None)
        self.assertEqual(update.call_args.kwargs["origin"], None)

    def test_plain_manager_configures_browser_role_on_shared_agents_provider(self) -> None:
        module = _cli_module()
        before = Configuration(
            agents=AgentsConfig(
                provider=AgentProvider.OPENAI,
                protocol=AgentProtocol.OPENAI_RESPONSES,
                base_url="https://api.openai.com/v1",
                authentication=AgentAuthentication.API_KEY,
                analysis=AgentRoleConfig(
                    model="analysis-model",
                    context_window_tokens=128_000,
                    max_output_tokens=4_096,
                    structured_output=True,
                ),
            )
        )
        with (
            patch(
                "builtins.input",
                side_effect=(
                    "l",
                    "4",
                    "",
                    "",
                    "",
                    "1",
                    "1",
                    "",
                    "",
                    "",
                    "y",
                    "b",
                    "q",
                ),
            ),
            patch.object(
                module, "select_configuration_edit_path", return_value=Path("config.toml")
            ),
            patch.object(module, "load_editable_configuration", return_value=before),
            patch.object(module, "update_configuration_sections") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("Browser role configuration was saved", stderr)
        update.assert_called_once()
        candidate = update.call_args.kwargs["agents"]
        self.assertEqual(candidate.provider, AgentProvider.OPENAI)
        self.assertEqual(candidate.analysis, before.agents.analysis)
        self.assertEqual(candidate.browser.model, "analysis-model")
        self.assertTrue(candidate.browser.image_input)
        self.assertTrue(candidate.browser.tool_decision)
        self.assertEqual(
            candidate.browser.image_media_types, ("image/png", "image/jpeg", "image/webp")
        )

    def test_plain_manager_configures_loopback_mineru_without_upload_consent_or_token(
        self,
    ) -> None:
        module = _cli_module()
        before = Configuration()
        with (
            patch("builtins.input", side_effect=("m", "1", "1", "", "", "y", "b", "q")),
            patch.object(
                module.getpass,
                "getpass",
                side_effect=AssertionError("loopback MinerU must not request a token"),
            ),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=before),
            patch.object(module, "update_core_service_configuration") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("MinerU 3.4.4", stderr)
        self.assertNotIn("Authorize remote PDF upload", stderr)
        candidate = update.call_args.kwargs["parsing"]
        self.assertIs(candidate.connection_mode, ParserConnectionMode.LOOPBACK)
        self.assertEqual(candidate.base_url, "http://127.0.0.1:8000")
        self.assertFalse(candidate.remote_upload_authorized)
        self.assertEqual(update.call_args.kwargs["secret"], None)
        self.assertEqual(update.call_args.kwargs["origin"], None)

    def test_plain_manager_remote_mineru_refuses_save_without_upload_consent(self) -> None:
        module = _cli_module()
        with (
            patch(
                "builtins.input",
                side_effect=(
                    "m",
                    "1",
                    "2",
                    "https://mineru.example.invalid",
                    "",
                    "n",
                    "b",
                    "q",
                ),
            ),
            patch.object(module, "update_core_service_configuration") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("uploads source PDFs outside this machine", stderr)
        self.assertIn("Remote upload was not authorized", stderr)
        update.assert_not_called()

    def test_core_reset_removes_ordinary_configuration_and_bound_credential_together(self) -> None:
        module = _cli_module()
        configured = Configuration(
            agents=AgentsConfig(
                provider=module.AgentProvider.OPENAI,
                protocol=AgentProtocol.OPENAI_RESPONSES,
                base_url="https://api.openai.com/v1",
                authentication=AgentAuthentication.API_KEY,
                analysis=AgentRoleConfig(
                    model="fixture-model",
                    context_window_tokens=128_000,
                    max_output_tokens=256,
                    structured_output=True,
                ),
            )
        )
        with (
            patch("builtins.input", side_effect=("l", "3", "y", "b", "q")),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=configured),
            patch.object(module, "core_credential_section_exists", return_value=True),
            patch.object(module, "update_core_service_configuration") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("configuration was reset", stderr)
        update.assert_called_once_with(
            Path("config.toml"),
            "agents",
            agents=AgentsConfig(),
            secret=None,
            origin=None,
        )

    def test_config_test_all_human_mode_confirms_combined_side_effects_before_probe(self) -> None:
        module = _cli_module()
        session = Mock()
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
            patch("builtins.input", return_value="n"),
        ):
            code, stdout, stderr = _invoke("config", "test", "--all")
        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("may consume a small amount of quota", stderr)
        self.assertIn("uploads no PDF", stderr)
        self.assertIn("cancelled", stderr)
        session.run.assert_not_called()
        session.run_agents.assert_not_called()
        session.run_mineru.assert_not_called()

    def test_eof_during_hidden_core_secret_input_is_a_controlled_interruption(self) -> None:
        module = _cli_module()
        with (
            patch(
                "builtins.input",
                side_effect=("l", "1", "1", "fixture-model", "", "1", "y", "b", "q"),
            ),
            patch.object(module.getpass, "getpass", side_effect=EOFError),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=Configuration()),
            patch.object(module, "update_core_service_configuration") as update,
        ):
            code, stdout, stderr = _invoke("config")
        self.assertEqual((code, stdout), (0, ""))
        self.assertNotIn("Traceback", stderr)
        update.assert_not_called()

    def test_real_config_status_separates_public_authorized_and_browser_routes(self) -> None:
        import sciretriever.configuration as configuration_boundary

        module = _cli_module()
        configuration = configuration_boundary.parse_configuration(
            """
            [sources.acquisition]
            providers = ["arxiv", "unpaywall", "core"]

            [sources.acquisition.unpaywall]
            contact_email = "reader@example.invalid"
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            configuration_boundary.set_credentials(
                ProviderName.CORE,
                {"api_key": "status-secret-sentinel"},
                home=home,
            )
            with (
                patch.object(module, "load_selected_configuration", return_value=configuration),
                patch.object(
                    module,
                    "configuration_status",
                    side_effect=configuration_boundary.configuration_status,
                ),
                patch.object(
                    module,
                    "load_credentials",
                    return_value=configuration_boundary.load_credentials(home=home),
                ),
            ):
                code, stdout, stderr = _invoke("config", "status")

        self.assertEqual((code, stderr), (0, ""))
        self.assertIn("saved direct-PDF/landing hints", stdout)
        self.assertIn("arxiv", stdout)
        self.assertIn("unpaywall", stdout)
        self.assertIn("core", stdout)
        self.assertIn("api_key=configured", stdout)
        self.assertIn("elsevier, core, wiley · known unavailable: springer", stdout)
        self.assertIn("Controlled browser", stdout)
        self.assertIn("9 production routes", stdout)
        self.assertIn("9/9 routes locally eligible", stdout)
        self.assertIn("local Browser not", stdout)
        self.assertIn("Access mode", stdout)
        self.assertIn("fixed-profile", stdout)
        self.assertIn("Selected profile", stdout)
        self.assertIn("Browser lifecycle", stdout)
        self.assertIn("Publisher lanes", stdout)
        self.assertIn("Interactive authent", stdout)
        self.assertIn("Article access", stdout)
        self.assertIn("checked-per-article", stdout)
        self.assertIn("not evaluated by status", stdout)
        self.assertNotIn("status-secret-sentinel", stdout)

    def test_config_manager_sets_updates_and_removes_without_secret_output_or_storage(
        self,
    ) -> None:
        module = _cli_module()
        specs = (
            CredentialFieldSpec(name="api_key", required=True),
            CredentialFieldSpec(name="institution_token", required=False),
        )
        secret = "set-secret-sentinel"
        optional = "optional-secret-sentinel"
        with (
            patch.object(
                module,
                "configurable_credential_providers",
                return_value=(ProviderName.ELSEVIER,),
            ),
            patch.object(module, "load_credentials") as load_credentials,
            patch.object(module, "credential_field_specs", return_value=specs),
            patch.object(module, "credential_section_exists", side_effect=(True, True)),
            patch(
                "builtins.input",
                side_effect=("p", "elsevier", "1", "y", "elsevier", "2", "y", "q", "q"),
            ),
            patch.object(module.getpass, "getpass", side_effect=(secret, optional)) as hidden_input,
            patch.object(module, "set_credentials") as set_credentials,
            patch.object(module, "remove_credentials") as remove_credentials,
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("config manager must not build Storage"),
            ),
        ):
            load_credentials.return_value.has_provider.return_value = True
            load_credentials.return_value.field_names.return_value = (
                "api_key",
                "institution_token",
            )
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("SciRetriever Provider credential manager", stderr)
        self.assertIn("Manage Elsevier / Scopus [elsevier]", stderr)
        self.assertIn("Set or update credentials", stderr)
        self.assertIn("Remove credentials", stderr)
        self.assertIn("Replace credentials for elsevier?", stderr)
        self.assertIn("Remove credentials for elsevier?", stderr)
        self.assertIn("were updated", stderr)
        self.assertIn("were removed", stderr)
        self.assertIn("Next steps:", stderr)
        self.assertEqual(hidden_input.call_count, 2)
        set_credentials.assert_called_once_with(
            "elsevier",
            {"api_key": secret, "institution_token": optional},
            home=None,
        )
        remove_credentials.assert_called_once_with(ProviderName.ELSEVIER, home=None)
        self.assertNotIn(secret, stderr)
        self.assertNotIn(optional, stderr)

    def test_config_manager_selects_by_number_reprompts_required_and_omits_optional(
        self,
    ) -> None:
        module = _cli_module()
        providers = (ProviderName.WEB_OF_SCIENCE, ProviderName.WILEY)
        specs = (
            CredentialFieldSpec(name="tdm_api_token", required=True),
            CredentialFieldSpec(name="optional_token", required=False),
        )
        secret = "interactive-wiley-secret-sentinel"
        with (
            patch.object(module, "configurable_credential_providers", return_value=providers),
            patch.object(module, "load_credentials") as load_credentials,
            patch.object(module, "credential_section_exists", return_value=False),
            patch.object(module, "credential_field_specs", return_value=specs),
            patch("builtins.input", side_effect=("p", "2", "1", "q", "q")),
            patch.object(
                module.getpass, "getpass", side_effect=("", secret, "   ")
            ) as hidden_input,
            patch.object(module, "set_credentials") as set_credentials,
        ):
            load_credentials.return_value.has_provider.return_value = False
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("Web of Science [web-of-science]", stderr)
        self.assertIn("Wiley Online Library [wiley]", stderr)
        self.assertIn("https://static.wiley.com/tdm/", stderr)
        self.assertIn("This credential is required", stderr)
        self.assertIn("Wiley TDM API token", hidden_input.call_args_list[0].args[0])
        self.assertIn('Add "wiley" to [sources.acquisition].providers.', stderr)
        self.assertIn("No standalone live credential probe is available", stderr)
        self.assertEqual(hidden_input.call_count, 3)
        set_credentials.assert_called_once_with(
            "wiley",
            {"tdm_api_token": secret},
            home=None,
        )
        self.assertNotIn(secret, stdout + stderr)

    def test_config_manager_back_invalid_and_quit_never_write(self) -> None:
        module = _cli_module()
        providers = (ProviderName.WEB_OF_SCIENCE, ProviderName.WILEY)
        for selections, invalid_provider, invalid_action in (
            (("q",), False, False),
            (("p", "99", "q", "q"), True, False),
            (("p", "unknown-provider", "q", "q"), True, False),
            (("p", "1", "invalid", "b", "q", "q"), False, True),
        ):
            with (
                self.subTest(selections=selections),
                patch.object(module, "configurable_credential_providers", return_value=providers),
                patch.object(module, "load_credentials") as load_credentials,
                patch("builtins.input", side_effect=selections),
                patch.object(module, "set_credentials") as set_credentials,
                patch.object(module, "remove_credentials") as remove_credentials,
            ):
                load_credentials.return_value.has_provider.return_value = False
                code, stdout, stderr = _invoke("config")
            self.assertEqual((code, stdout), (0, ""))
            if invalid_provider:
                self.assertIn("Invalid Provider selection", stderr)
            if invalid_action:
                self.assertIn("Invalid action", stderr)
            set_credentials.assert_not_called()
            remove_credentials.assert_not_called()

    def test_config_manager_cancels_replace_remove_optional_blank_and_eof_safely(
        self,
    ) -> None:
        module = _cli_module()
        scenarios = (
            (ProviderName.ELSEVIER, True, "1", ("n", "q"), (), "No credentials were changed"),
            (ProviderName.ELSEVIER, True, "2", ("n", "q"), (), "No credentials were changed"),
            (
                ProviderName.SEMANTIC_SCHOLAR,
                False,
                "1",
                ("q",),
                ("",),
                "No credential value was entered",
            ),
            (
                ProviderName.WEB_OF_SCIENCE,
                False,
                "1",
                ("q",),
                (EOFError(),),
                "Credential input ended",
            ),
        )
        for provider, existed, action, remaining_input, hidden_input, expected in scenarios:
            with (
                self.subTest(provider=provider, action=action, hidden_input=hidden_input),
                patch.object(
                    module,
                    "configurable_credential_providers",
                    return_value=(provider,),
                ),
                patch.object(module, "load_credentials") as load_credentials,
                patch.object(module, "credential_section_exists", return_value=existed),
                patch.object(
                    module,
                    "credential_field_specs",
                    return_value=(
                        CredentialFieldSpec(
                            name="api_key",
                            required=provider is not ProviderName.SEMANTIC_SCHOLAR,
                        ),
                    ),
                ),
                patch(
                    "builtins.input",
                    side_effect=("p", provider.value, action, *remaining_input, "q"),
                ),
                patch.object(module.getpass, "getpass", side_effect=hidden_input),
                patch.object(module, "set_credentials") as set_credentials,
                patch.object(module, "remove_credentials") as remove_credentials,
            ):
                load_credentials.return_value.has_provider.return_value = existed
                load_credentials.return_value.field_names.return_value = ("api_key",)
                code, stdout, stderr = _invoke("config")
            self.assertEqual((code, stdout), (0, ""))
            self.assertIn(expected, stderr)
            set_credentials.assert_not_called()
            remove_credentials.assert_not_called()

    def test_config_manager_remove_not_configured_does_not_prompt_or_write(self) -> None:
        module = _cli_module()
        with (
            patch.object(
                module,
                "configurable_credential_providers",
                return_value=(ProviderName.WEB_OF_SCIENCE,),
            ),
            patch.object(module, "load_credentials") as load_credentials,
            patch.object(module, "credential_section_exists", return_value=False),
            patch("builtins.input", side_effect=("p", "1", "2", "q", "q")),
            patch.object(module, "remove_credentials") as remove_credentials,
        ):
            load_credentials.return_value.has_provider.return_value = False
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("is not configured; nothing changed", stderr)
        self.assertNotIn("Remove credentials for web-of-science?", stderr)
        remove_credentials.assert_not_called()

    def test_config_status_uses_configuration_boundary_only_and_omits_fingerprint(self) -> None:
        module = _cli_module()
        configuration = Configuration()
        capability = ConfigurationCapabilityStatus(
            provider=ProviderName.CROSSREF,
            capability=ProviderCapability.METADATA,
            production_available=True,
            enabled=False,
            ordinary_parameters_ready=False,
            credential=ProviderCredentialStatus(
                provider=ProviderName.CROSSREF,
                capability=ProviderCapability.METADATA,
                status=CredentialStatus.NOT_REQUIRED,
            ),
            access_policy_ready=False,
            probe_available=True,
            local_ready=False,
            failure_code="missing-ordinary-parameter",
        )
        status = Mock(spec=ConfigurationStatus)
        status.capabilities = (capability,)
        runtime = ConfigurationRuntimeStatus(
            storage_configuration_complete=False,
            storage_missing_fields=("catalog_path", "artifact_root"),
            parsing=ParsingConfigurationStatus(
                configuration_complete=False,
                bearer_token_required=False,
                missing_fields=("base_url", "connection_mode", "model_identity"),
            ),
            analysis=AnalysisConfigurationStatus(
                api_key_required=False,
                reference_configuration_complete=False,
                content_configuration_complete=False,
                reference_missing_fields=("provider", "model", "reference_max_output_tokens"),
                content_missing_fields=("provider", "model"),
            ),
        )
        with (
            patch.object(
                module, "load_selected_configuration", return_value=configuration
            ) as load_configuration,
            patch.object(module, "load_credentials") as load_credentials,
            patch.object(
                module, "configuration_status", return_value=status
            ) as configuration_status,
            patch.object(
                module, "configuration_runtime_status", return_value=runtime
            ) as configuration_runtime_status,
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("config status must not build Storage"),
            ),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                side_effect=AssertionError("config status must not build a probe session"),
            ),
        ):
            code, stdout, stderr = _invoke("config", "status", "--json")

        self.assertEqual((code, stderr), (0, ""))
        payload = json.loads(stdout)
        self.assertEqual(
            set(payload),
            {"storage", "providers", "parsing", "agents", "analysis", "execution", "library"},
        )
        self.assertEqual(
            payload["providers"]["metadata"][0]["missing_ordinary_fields"],
            ["mode"],
        )
        self.assertEqual(payload["agents"]["provider"], None)
        browser = payload["providers"]["controlled_browser"]
        self.assertEqual(browser["production_route_count"], 9)
        self.assertEqual(browser["automatic_route_count"], 9)
        self.assertFalse(browser["automatic_acquisition_available"])
        self.assertFalse(browser["runtime"]["launch_assessed"])
        self.assertEqual(browser["mode"], "headed-fixed-profile")
        self.assertIn("headed_display_available", browser["runtime"])
        self.assertFalse(browser["interactive_authentication_supported"])
        self.assertNotIn("framework_available", browser["runtime"])
        self.assertNotIn("chromium_executable_available", browser["runtime"])
        self.assertEqual(browser["article_entitlement"], "checked-per-article")
        self.assertEqual(browser["article_entitlement_assessment"], "not-evaluated")
        self.assertFalse(browser["article_entitlement_evaluated"])
        self.assertEqual(
            browser["profile"],
            {"selected": None, "presence": "missing"},
        )
        self.assertEqual(
            browser["session"],
            {
                "assessment": "not-assessed",
                "authenticated": None,
                "article_entitlement": "not-proven",
            },
        )
        self.assertTrue(browser["probe"]["available"])
        self.assertTrue(browser["probe"]["requires_explicit_target"])
        self.assertEqual(
            browser["probe"]["supported_access_keys"],
            [
                "acs-publications",
                "aip-publishing",
                "elsevier-sciencedirect",
                "iopscience",
                "oxford-academic",
                "rsc-publishing",
                "science-aaas",
                "springerlink",
                "wiley-online-library",
            ],
        )
        self.assertEqual(
            browser["action_required"][0]["code"],
            "browser-disabled",
        )
        self.assertNotIn("fingerprint", stdout)
        load_configuration.assert_called_once_with(None)
        configuration_status.assert_called_once_with(
            load_configuration.return_value, credentials=load_credentials.return_value
        )
        configuration_runtime_status.assert_called_once_with(
            configuration, credentials=load_credentials.return_value
        )

    def test_config_status_human_output_is_sectioned_and_never_renders_secret_value(self) -> None:
        module = _cli_module()
        configuration = Configuration()
        capability = ConfigurationCapabilityStatus(
            provider=ProviderName.WEB_OF_SCIENCE,
            capability=ProviderCapability.METADATA,
            production_available=True,
            enabled=False,
            ordinary_parameters_ready=False,
            credential=ProviderCredentialStatus(
                provider=ProviderName.WEB_OF_SCIENCE,
                capability=ProviderCapability.METADATA,
                status=CredentialStatus.CONFIGURED,
                fields=(CredentialFieldStatus(name="api_key", required=True, present=True),),
            ),
            access_policy_ready=False,
            probe_available=True,
            local_ready=False,
            failure_code="missing-ordinary-parameter",
        )
        status = Mock(spec=ConfigurationStatus)
        status.capabilities = (capability,)
        runtime = ConfigurationRuntimeStatus(
            storage_configuration_complete=False,
            storage_missing_fields=("catalog_path", "artifact_root"),
            parsing=ParsingConfigurationStatus(
                configuration_complete=False,
                bearer_token_required=False,
                missing_fields=("base_url",),
            ),
            analysis=AnalysisConfigurationStatus(
                api_key_required=False,
                reference_configuration_complete=False,
                content_configuration_complete=False,
                reference_missing_fields=("provider",),
                content_missing_fields=("provider",),
            ),
        )
        with (
            patch.object(module, "load_selected_configuration", return_value=configuration),
            patch.object(module, "load_credentials"),
            patch.object(module, "configuration_status", return_value=status),
            patch.object(module, "configuration_runtime_status", return_value=runtime),
        ):
            code, stdout, stderr = _invoke("config", "status")
        self.assertEqual((code, stderr), (0, ""))
        for heading in (
            "Core services",
            "LLM Analysis",
            "MinerU Parser",
            "Metadata APIs",
            "Authorized primary-PDF APIs",
            "PDF acquisition routes",
            "Public",
            "Authorized API",
            "Controlled Browser",
            "Access mode",
            "Selected profile",
            "Browser lifecycle",
            "Publisher lanes",
            "Interactive authent",
            "Article access",
            "Storage",
        ):
            self.assertIn(heading, stdout)
        self.assertIn("api_key=configured", stdout)
        self.assertNotIn("secret-value", stdout)

    def test_plain_access_manager_selects_and_initializes_a_persistent_profile(
        self,
    ) -> None:
        module = _cli_module()
        before = Configuration()
        overview = self._provider_access_overview(module)
        with (
            patch(
                "builtins.input",
                side_effect=("a", "1", "fixture-profile", "y", "b", "q"),
            ),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=before),
            patch.object(module, "load_credentials", return_value=Mock()),
            patch.object(module, "_provider_access_overview", return_value=overview),
            patch.object(
                module,
                "browser_profile_status",
                return_value=BrowserProfileStatus(presence=BrowserProfilePresence.MISSING),
            ),
            patch.object(module, "configure_browser_access_profile") as configure,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        for expected in (
            "Provider API and Browser Access",
            "CORE",
            "Elsevier / Scopus",
            "Select Browser profile",
            "headed fixed-profile CloakBrowser process",
            "sensitive session data",
        ):
            self.assertIn(expected, stderr)
        self.assertNotIn("browser-profiles", stderr)
        self.assertNotIn("Cookie path", stderr)
        configure.assert_called_once()
        self.assertEqual(configure.call_args.args[:1], (Path("config.toml"),))
        candidate = configure.call_args.args[1]
        self.assertIsInstance(candidate, AccessConfig)
        self.assertTrue(candidate.browser_enabled)
        self.assertEqual(candidate.browser_profile, "fixture-profile")
        self.assertEqual(candidate.browser_max_concurrency, 5)
        self.assertIsNone(configure.call_args.kwargs["home"])

    def test_access_enablement_cancellation_has_no_write_or_browser_side_effect(
        self,
    ) -> None:
        module = _cli_module()
        overview = self._provider_access_overview(module)
        with (
            patch(
                "builtins.input",
                side_effect=("a", "1", "fixture-profile", "n", "b", "q"),
            ),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=Configuration()),
            patch.object(module, "load_credentials", return_value=Mock()),
            patch.object(module, "_provider_access_overview", return_value=overview),
            patch.object(
                module,
                "browser_profile_status",
                return_value=BrowserProfileStatus(presence=BrowserProfilePresence.MISSING),
            ),
            patch.object(module, "configure_browser_access_profile") as configure,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("No Browser access setting or profile was changed", stderr)
        configure.assert_not_called()

    def test_plain_access_manager_accepts_cross_publisher_concurrency_without_upper_bound(
        self,
    ) -> None:
        module = _cli_module()
        before = Configuration()
        overview = self._provider_access_overview(module)
        with (
            patch("builtins.input", side_effect=("a", "4", "128", "y", "b", "q")),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=before),
            patch.object(module, "load_credentials", return_value=Mock()),
            patch.object(module, "_provider_access_overview", return_value=overview),
            patch.object(module, "update_configuration_sections") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        update.assert_called_once()
        candidate = update.call_args.kwargs["access"]
        self.assertEqual(candidate.browser_max_concurrency, 128)
        self.assertIn("integer > 1", stderr)
        self.assertIn("was set to 128", stderr)

    def test_access_manager_disables_browser_and_preserves_local_limits(self) -> None:
        module = _cli_module()
        configured = Configuration(
            access=AccessConfig(
                browser_enabled=True,
                browser_profile="fixture-profile",
                browser_max_concurrency=2,
            )
        )
        overview = self._provider_access_overview(module)
        with (
            patch("builtins.input", side_effect=("a", "3", "y", "b", "q")),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "load_editable_configuration", return_value=configured),
            patch.object(module, "load_credentials", return_value=Mock()),
            patch.object(module, "_provider_access_overview", return_value=overview),
            patch.object(module, "update_configuration_sections") as update,
        ):
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        update.assert_called_once()
        self.assertEqual(update.call_args.args, (Path("config.toml"),))
        candidate = update.call_args.kwargs["access"]
        self.assertFalse(candidate.browser_enabled)
        self.assertEqual(candidate.browser_profile, "fixture-profile")
        self.assertEqual(candidate.browser_max_concurrency, 2)
        self.assertEqual(candidate.browser_policy_overrides, ())
        self.assertIn("Browser access was disabled; the local session was retained", stderr)

    def test_tty_manager_exposes_access_area_and_returns_without_writing(self) -> None:
        module = _cli_module()
        configuration = Configuration()
        runtime = SimpleNamespace(
            analysis=SimpleNamespace(
                reference_configuration_complete=False,
                api_key_required=False,
                api_key_configured=None,
                credential_origin_matches=None,
            ),
            parsing=SimpleNamespace(
                configuration_complete=False,
                bearer_token_required=False,
                bearer_token_configured=None,
                credential_origin_matches=None,
            ),
        )
        overview = self._provider_access_overview(module)
        with (
            patch.object(module, "interactive_terminal", return_value=True),
            patch.object(module, "_configuration_summary", return_value=(configuration, runtime)),
            patch.object(module, "_provider_home_rows", return_value=[]),
            patch.object(module, "_provider_access_overview", return_value=overview),
            patch.object(
                module,
                "select_configuration_edit_path",
                return_value=Path("config.toml"),
            ),
            patch.object(module, "credential_path", return_value=Path("credentials.toml")),
            patch.object(module, "load_editable_configuration", return_value=configuration),
            patch.object(module, "load_credentials", return_value=Mock()),
            patch.object(
                module.TerminalChoice,
                "prompt",
                autospec=True,
                side_effect=("access", "back", "quit"),
            ) as prompt,
        ):
            code, stdout, stderr = _invoke("config", "--theme", "mono")

        self.assertEqual((code, stdout), (0, ""))
        first_choice = prompt.call_args_list[0].args[0]
        self.assertIn(("access", "Provider APIs and Browser Access"), first_choice.options)
        access_choice = prompt.call_args_list[1].args[0]
        self.assertEqual(
            access_choice.options,
            [
                ("select", "Select or initialize a Browser profile"),
                ("remove", "Remove the selected local Browser session"),
                ("disable", "Disable Browser access and keep the session"),
                ("concurrency", "Set cross-Publisher Browser concurrency"),
                ("back", "Back"),
            ],
        )
        self.assertIn("Provider Access", stderr)
        self.assertIn("Literature Provider access", stderr)
        self.assertNotIn("\x1b[", stderr)

    def test_access_overview_uses_three_authorized_apis_and_disabled_browser_routes(
        self,
    ) -> None:
        import sciretriever.configuration as configuration_boundary

        module = _cli_module()
        with tempfile.TemporaryDirectory(prefix="sciretriever-access-overview-") as temporary:
            credentials = configuration_boundary.load_credentials(home=Path(temporary))
            overview = module._provider_access_overview(
                Configuration(),
                credentials=credentials,
            )

        self.assertEqual(
            tuple(name for name, _state, _action in overview.api_routes),
            ("CORE", "Elsevier / Scopus", "Wiley Online Library"),
        )
        self.assertEqual(overview.browser_state, "Disabled")
        self.assertIn("Select and initialize a profile", overview.browser_action)
        self.assertIn("No profile is selected", overview.browser_detail)
        self.assertIn("fixed-profile CloakBrowser process", overview.browser_detail)

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
        session.run_agents.return_value = CoreConfigurationProbeResult(
            service=CoreCredentialService.AGENTS,
            outcome=ProbeOutcome.SKIPPED,
            local_ready=False,
            failure_code="analysis-not-ready",
            details=AgentConfigurationProbeDetails(),
        )
        session.run_mineru.return_value = CoreConfigurationProbeResult(
            service=CoreCredentialService.MINERU,
            outcome=ProbeOutcome.SKIPPED,
            local_ready=False,
            failure_code="parser-not-ready",
            details=MinerUConfigurationProbeDetails(),
        )
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
            json.loads(all_result[1])["providers"]["results"][0]["acquisition_entitlement"],
            "not-proven",
        )
        self.assertEqual(
            session.run.call_args_list,
            [
                call(provider="crossref"),
                call(test_all=True),
            ],
        )
        self.assertEqual(build_probe.call_count, 2)
        self.assertEqual(session.close.call_count, 2)
        session.run_browser.assert_not_called()

    def test_config_test_named_provider_and_all_are_parser_exclusive(self) -> None:
        module = _cli_module()
        cases = (
            ("crossref", "--all"),
            ("crossref", "--browser", "springerlink"),
            ("--all", "--browser", "springerlink"),
        )
        for selection in cases:
            with self.subTest(selection=selection):
                with patch.object(
                    module,
                    "build_production_configuration_probe_session",
                    side_effect=AssertionError("invalid selection must not build probes"),
                ):
                    code, stdout, stderr = _invoke("config", "test", *selection, "--json")
                self.assertEqual(code, 2)
                self.assertEqual(stdout, "")
                self.assertIn("usage:", stderr)

    def test_config_test_browser_is_explicit_single_target_and_reports_safe_skip(self) -> None:
        module = _cli_module()
        session = Mock()
        session.run_browser.return_value = BrowserConfigurationProbeResult(
            access_key="springerlink",
            outcome=ProbeOutcome.SKIPPED,
            local_ready=False,
            failure_code="browser-disabled",
        )
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("Browser config probe must not build Storage"),
            ),
        ):
            code, stdout, stderr = _invoke(
                "config",
                "test",
                "--browser",
                "springerlink",
                "--json",
            )

        self.assertEqual((code, stderr), (3, ""))
        payload = json.loads(stdout)
        self.assertEqual(payload["access_key"], "springerlink")
        self.assertEqual(payload["outcome"], "skipped")
        self.assertEqual(payload["failure_code"], "browser-disabled")
        self.assertEqual(payload["navigation_count"], 0)
        self.assertEqual(payload["article_entitlement"], "not-proven")
        self.assertFalse(payload["persisted"])
        session.run_browser.assert_called_once_with("springerlink")
        session.close.assert_called_once_with()
        session.run.assert_not_called()
        session.run_agents.assert_not_called()
        session.run_mineru.assert_not_called()

    def test_config_test_browser_passes_without_entitlement_claim(self) -> None:
        module = _cli_module()
        session = Mock()
        session.run_browser.return_value = BrowserConfigurationProbeResult(
            access_key="springerlink",
            outcome=ProbeOutcome.PASSED,
            local_ready=True,
            browser_launched=True,
            minimal_target_reached=True,
            navigation_count=1,
        )
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
        ):
            code, stdout, stderr = _invoke(
                "config",
                "test",
                "--browser",
                "springerlink",
                "--json",
            )

        self.assertEqual((code, stderr), (0, ""))
        payload = json.loads(stdout)
        self.assertEqual(payload["outcome"], "passed")
        self.assertNotIn("authentication_accepted", payload)
        self.assertEqual(payload["article_entitlement"], "not-proven")
        self.assertIsNone(payload["failure_code"])

    def test_human_browser_probe_requires_confirmation_before_execution(self) -> None:
        module = _cli_module()
        session = Mock()
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
            patch("builtins.input", return_value="n"),
        ):
            code, stdout, stderr = _invoke(
                "config",
                "test",
                "--browser",
                "springerlink",
            )

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("controlled headed Browser session", stderr)
        self.assertIn("exactly one approved minimal Publisher target", stderr)
        self.assertIn("runtime and target reachability", stderr)
        self.assertIn("does not assess institution-IP or article-specific entitlement", stderr)
        self.assertIn("cancelled", stderr)
        session.run_browser.assert_not_called()

    def test_named_browser_agent_probe_confirms_and_serializes_role_contract(self) -> None:
        module = _cli_module()
        session = Mock()
        session.run_browser_agent.return_value = CoreConfigurationProbeResult(
            service=CoreCredentialService.AGENTS,
            outcome=ProbeOutcome.PASSED,
            local_ready=True,
            details=AgentConfigurationProbeDetails(
                role="browser-agent",
                request_kind="browser-agent-tool",
                image_input=True,
                tool_decision=True,
                image_count=1,
                tool_count=1,
                tool_decision_parseable=True,
                model="browser-model",
                protocol=AgentProtocol.OPENAI_RESPONSES,
            ),
        )
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
        ):
            code, stdout, stderr = _invoke("config", "test", "browser-agent", "--json")

        self.assertEqual((code, stderr), (0, ""))
        payload = json.loads(stdout)
        self.assertEqual(payload["service"], "agents")
        self.assertEqual(payload["outcome"], "passed")
        self.assertEqual(payload["details"]["role"], "browser-agent")
        self.assertEqual(payload["details"]["request_kind"], "browser-agent-tool")
        session.run_browser_agent.assert_called_once_with()
        session.run_agents.assert_not_called()

    def test_named_browser_agent_human_confirmation_describes_synthetic_request(self) -> None:
        module = _cli_module()
        session = Mock()
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
            patch("builtins.input", return_value="n"),
        ):
            code, stdout, stderr = _invoke("config", "test", "browser-agent")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("fixed synthetic image", stderr)
        self.assertIn("closed generic tool", stderr)
        self.assertIn("no Literature, PDF, page content", stderr)
        self.assertIn("may consume a small amount of quota", stderr)
        self.assertIn("does not start a Browser or visit a Publisher", stderr)
        self.assertIn("cancelled", stderr)
        session.run_browser_agent.assert_not_called()

    def test_all_optional_browser_agent_skip_does_not_fail_required_probes(self) -> None:
        module = _cli_module()
        passed = ConfigurationProbeSummary(results=())
        session = Mock()
        session.run.return_value = passed
        session.run_agents.return_value = CoreConfigurationProbeResult(
            service=CoreCredentialService.AGENTS,
            outcome=ProbeOutcome.PASSED,
            local_ready=True,
            details=AgentConfigurationProbeDetails(strict_response_parseable=True),
        )
        session.run_browser_agent.return_value = CoreConfigurationProbeResult(
            service=CoreCredentialService.AGENTS,
            outcome=ProbeOutcome.SKIPPED,
            local_ready=False,
            failure_code="browser-agent-not-ready",
            details=AgentConfigurationProbeDetails(
                role="browser-agent",
                request_kind="browser-agent-tool",
                image_input=True,
                tool_decision=True,
                image_count=1,
                tool_count=1,
            ),
        )
        session.run_mineru.return_value = CoreConfigurationProbeResult(
            service=CoreCredentialService.MINERU,
            outcome=ProbeOutcome.PASSED,
            local_ready=True,
            details=MinerUConfigurationProbeDetails(
                health="healthy",
                release="3.4.4",
                api_protocol=2,
            ),
        )
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(
                module,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
        ):
            code, stdout, stderr = _invoke("config", "test", "--all", "--json")

        self.assertEqual((code, stderr), (0, ""))
        payload = json.loads(stdout)
        self.assertEqual(payload["browser-agent"]["outcome"], "skipped")
        self.assertEqual(payload["browser-agent"]["details"]["role"], "browser-agent")
        session.run_browser_agent.assert_called_once_with()


class CliResultAndFailureBoundaryTests(unittest.TestCase):
    def test_config_manager_prompts_are_stderr_only_and_manager_has_no_json_stream(self) -> None:
        module = _cli_module()
        secret = "manager-secret-sentinel"
        with (
            patch.object(
                module,
                "configurable_credential_providers",
                return_value=(ProviderName.ELSEVIER,),
            ),
            patch.object(module, "load_credentials") as load_credentials,
            patch.object(
                module,
                "credential_field_specs",
                return_value=(CredentialFieldSpec(name="api_key", required=True),),
            ),
            patch.object(module, "credential_section_exists", return_value=True),
            patch.object(module.sys, "stdin", io.StringIO("p\n1\n1\nn\nq\nq\n")),
            patch.object(module, "set_credentials") as set_credentials,
        ):
            load_credentials.return_value.has_provider.return_value = True
            load_credentials.return_value.field_names.return_value = ("api_key",)
            code, stdout, stderr = _invoke("config")

        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("Replace credentials", stderr)
        self.assertNotIn("{", stdout)
        self.assertNotIn(secret, stdout + stderr)
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

    def test_completion_human_and_json_views_preserve_the_same_five_partitions(self) -> None:
        module = _cli_module()
        literature_ids = tuple(
            LiteratureId(f"00000000-0000-0000-0000-{index:012d}") for index in range(1, 6)
        )
        targets = tuple(
            LiteratureCompletionTarget(kind="literature", literature_id=literature_id)
            for literature_id in literature_ids
        )
        stable_failure = StableFailure(
            code="acquisition-browser-login-required",
            reason="The Publisher page requires an unsupported login.",
            action="Use an authorized API or provide the PDF manually.",
            retryable=False,
        )
        report = DatabaseCompletionReport(
            kind="database-completion",
            end=FinishedReportEnd(kind="finished"),
            goal="ASSET_READY",
            goal_reached=(GoalReachedTarget(target=targets[0], literature_id=literature_ids[0]),),
            needs_manual_pdf=(
                NeedsManualPdfTarget(
                    target=targets[1],
                    literature_ids=(literature_ids[1],),
                ),
            ),
            failed=(
                FailedCompletionTarget(
                    target=targets[2],
                    literature_id=literature_ids[2],
                    stage="acquisition",
                    failure=stable_failure,
                ),
            ),
            interrupted=(
                InterruptedCompletionTarget(
                    target=targets[3],
                    literature_id=literature_ids[3],
                ),
            ),
            not_started=(NotStartedCompletionTarget(target=targets[4]),),
            no_usable_content_literature_ids=(),
        )
        entry_api = _RecordingEntryApi()
        entry_api.completion_result = report
        graph = _RoutingObjectGraph(entry_api)

        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(module, "build_production_object_graph", return_value=graph),
        ):
            human = _invoke("complete", "pdf", "--all-pending")
            machine = _invoke("complete", "pdf", "--all-pending", "--json")

        self.assertEqual((human[0], human[2]), (0, ""))
        self.assertEqual((machine[0], machine[2]), (0, ""))
        machine_payload = json.loads(machine[1])
        self.assertEqual(machine_payload, report.model_dump(mode="json"))
        self.assertIn("Database completion", human[1])
        self.assertIn("  Goal: ASSET_READY", human[1])
        self.assertIn("  Outcome: finished", human[1])
        for partition in (
            "goal_reached",
            "needs_manual_pdf",
            "failed",
            "interrupted",
            "not_started",
        ):
            self.assertIn(
                f"  {partition}: {len(machine_payload[partition])}",
                human[1],
            )
            self.assertIn(f"{partition} ({len(machine_payload[partition])})", human[1])
        for literature_id in literature_ids:
            self.assertIn(str(literature_id), human[1])
        self.assertIn("stage=acquisition", human[1])
        self.assertIn(f"code: {stable_failure.code}", human[1])
        self.assertIn(f"retryable: {str(stable_failure.retryable).lower()}", human[1])
        self.assertIn(f"reason: {stable_failure.reason}", human[1])
        self.assertIn(f"action: {stable_failure.action}", human[1])
        self.assertNotIn("{'", human[1])

    def test_completion_exit_code_distinguishes_operation_boundary_from_end_state(self) -> None:
        """Keep batch-partition failures separate from operation failures.

        A completion report may legitimately finish with every target in its
        ``failed`` partition: the operation reached its requested boundary
        and the report remains the source of per-target business outcomes.
        Only a failed report end is an operation-level failure.  This test
        fixes the contract for complete, partial, all-failed, failed and
        interrupted outcomes without making shell status depend on partition
        formatting.
        """

        module = _cli_module()
        target = LiteratureCompletionTarget(
            kind="literature",
            literature_id=LiteratureId("00000000-0000-0000-0000-000000000001"),
        )
        second_target = LiteratureCompletionTarget(
            kind="literature",
            literature_id=LiteratureId("00000000-0000-0000-0000-000000000002"),
        )
        failure = StableFailure(
            code="acquisition-no-source",
            reason="No usable source was found.",
            action="Provide the PDF manually or retry later.",
            retryable=True,
        )

        def report_with_end(
            end: ReportEnd,
            *,
            goal_reached: tuple[GoalReachedTarget, ...] = (),
            failed: tuple[FailedCompletionTarget, ...] = (),
        ) -> DatabaseCompletionReport:
            return DatabaseCompletionReport(
                kind="database-completion",
                end=end,
                goal="ASSET_READY",
                goal_reached=goal_reached,
                needs_manual_pdf=(),
                failed=failed,
                interrupted=(),
                not_started=(),
                no_usable_content_literature_ids=(),
            )

        failed_target = FailedCompletionTarget(
            target=second_target,
            literature_id=second_target.literature_id,
            stage="acquisition",
            failure=failure,
        )
        cases = (
            ("complete", report_with_end(FinishedReportEnd(kind="finished")), 0),
            (
                "partial",
                report_with_end(
                    FinishedReportEnd(kind="finished"),
                    goal_reached=(
                        GoalReachedTarget(
                            target=target,
                            literature_id=target.literature_id,
                        ),
                    ),
                    failed=(failed_target,),
                ),
                0,
            ),
            (
                "all-failed",
                report_with_end(
                    FinishedReportEnd(kind="finished"),
                    failed=(failed_target,),
                ),
                0,
            ),
            (
                "operation-failed",
                report_with_end(
                    FailedReportEnd(
                        kind="failed",
                        failure=failure,
                    ),
                    failed=(failed_target,),
                ),
                3,
            ),
            (
                "interrupted",
                report_with_end(InterruptedReportEnd(kind="interrupted")),
                130,
            ),
        )
        for name, report, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(module._result_code(report), expected)

    def test_completion_exit_codes_are_enforced_by_the_cli_boundary(self) -> None:
        """Exercise completion through ``main`` in both output modes.

        The helper-level contract above protects the mapping itself.  This
        test additionally proves that ``complete`` writes the typed report,
        closes its graph, and returns the same code for human and JSON output
        for every accepted report boundary.
        """

        module = _cli_module()
        target = LiteratureCompletionTarget(
            kind="literature",
            literature_id=LiteratureId("00000000-0000-0000-0000-000000000011"),
        )
        second_target = LiteratureCompletionTarget(
            kind="literature",
            literature_id=LiteratureId("00000000-0000-0000-0000-000000000012"),
        )
        failure = StableFailure(
            code="acquisition-no-source",
            reason="No usable source was found.",
            action="Provide the PDF manually or retry later.",
            retryable=True,
        )
        failed_target = FailedCompletionTarget(
            target=second_target,
            literature_id=second_target.literature_id,
            stage="acquisition",
            failure=failure,
        )

        def report(
            end: ReportEnd,
            *,
            goal_reached: tuple[GoalReachedTarget, ...] = (),
            failed: tuple[FailedCompletionTarget, ...] = (),
        ) -> DatabaseCompletionReport:
            return DatabaseCompletionReport(
                kind="database-completion",
                end=end,
                goal="ASSET_READY",
                goal_reached=goal_reached,
                needs_manual_pdf=(),
                failed=failed,
                interrupted=(),
                not_started=(),
                no_usable_content_literature_ids=(),
            )

        cases = (
            (
                "finished-all-success",
                report(
                    FinishedReportEnd(kind="finished"),
                    goal_reached=(
                        GoalReachedTarget(target=target, literature_id=target.literature_id),
                    ),
                ),
                0,
            ),
            (
                "finished-partial",
                report(
                    FinishedReportEnd(kind="finished"),
                    goal_reached=(
                        GoalReachedTarget(target=target, literature_id=target.literature_id),
                    ),
                    failed=(failed_target,),
                ),
                0,
            ),
            (
                "finished-all-targets-failed",
                report(FinishedReportEnd(kind="finished"), failed=(failed_target,)),
                0,
            ),
            (
                "operation-failed",
                report(
                    FailedReportEnd(kind="failed", failure=failure),
                    failed=(failed_target,),
                ),
                3,
            ),
            (
                "user-cancelled-report",
                report(InterruptedReportEnd(kind="interrupted")),
                130,
            ),
        )
        for name, expected_report, expected_code in cases:
            for as_json in (False, True):
                with self.subTest(name=name, output="json" if as_json else "human"):
                    entry_api = _RecordingEntryApi()
                    entry_api.completion_result = expected_report
                    graph = _RoutingObjectGraph(entry_api)
                    arguments = ["complete", "pdf", "--all-pending"]
                    if as_json:
                        arguments.append("--json")
                    with (
                        patch.object(
                            module,
                            "load_selected_configuration",
                            return_value=Configuration(),
                        ),
                        patch.object(module, "build_production_object_graph", return_value=graph),
                    ):
                        code, stdout, stderr = _invoke(*arguments)
                    self.assertEqual(code, expected_code)
                    self.assertEqual(stderr, "")
                    self.assertEqual(graph.close_calls, 1)
                    if as_json:
                        self.assertEqual(
                            json.loads(stdout),
                            expected_report.model_dump(mode="json"),
                        )
                    else:
                        self.assertIn("Database completion", stdout)
                        self.assertIn(f"Outcome: {expected_report.end.kind}", stdout)

    def test_completion_keyboard_cancellation_and_boundary_errors_keep_stable_codes(self) -> None:
        module = _cli_module()
        sentinel = "completion-secret-sentinel"
        private_path = "/private/user/catalog.db"

        entry_api = _RecordingEntryApi()
        graph = _RoutingObjectGraph(entry_api)
        with (
            patch.object(module, "load_selected_configuration", return_value=Configuration()),
            patch.object(module, "build_production_object_graph", return_value=graph),
            patch.object(
                entry_api,
                "complete_database",
                side_effect=KeyboardInterrupt(f"{sentinel} {private_path}"),
            ),
        ):
            cancelled = _invoke("complete", "pdf", "--all-pending", "--json")
        self.assertEqual(cancelled, (130, "", "operation interrupted.\n"))
        self.assertEqual(graph.close_calls, 1)
        self.assertNotIn(sentinel, cancelled[2])
        self.assertNotIn(private_path, cancelled[2])

        for exception, expected_code, expected_message in (
            (
                module.ConfigurationError(f"api_key={sentinel} {private_path}"),
                4,
                "configuration operation failed",
            ),
            (OSError(f"{private_path}: {sentinel}"), 70, "internal operation failed"),
        ):
            with self.subTest(exception=type(exception).__name__):
                with patch.object(module, "load_selected_configuration", side_effect=exception):
                    code, stdout, stderr = _invoke(
                        "complete",
                        "pdf",
                        "--all-pending",
                        "--json",
                    )
                self.assertEqual(code, expected_code)
                self.assertEqual(stdout, "")
                self.assertIn(expected_message, stderr)
                self.assertNotIn(sentinel, stderr)
                self.assertNotIn(private_path, stderr)

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
