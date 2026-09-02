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
from typing import BinaryIO
from unittest.mock import patch

from sciretriever.entry.ports import UserOutputConflictError
from sciretriever.model.configuration import (
    Configuration,
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


class _EmptyCredentials:
    """Secret-free CredentialLookup fixture; never touches the operator HOME."""

    def __init__(
        self,
        *,
        model_provider: str | None = None,
        model_secret: str | None = None,
        origin: str | None = None,
    ) -> None:
        self._model_provider = model_provider
        self._model_secret = model_secret
        self._origin = origin

    def get(self, _provider: object, _field: str, default: str | None = None) -> str | None:
        return default

    def field_names(self, _provider: object) -> tuple[str, ...]:
        return ()

    def has_provider(self, _provider: object) -> bool:
        return False

    def core_field_names(self, _service: object) -> tuple[str, ...]:
        return ()

    def has_core_service(self, service: object) -> bool:
        return bool(self.core_field_names(service))

    def core_secret_for_origin(self, _service: object, _origin: str) -> str | None:
        return None

    def model_provider_field_names(self, provider: str) -> tuple[str, ...]:
        if provider == self._model_provider and self._model_secret is not None:
            return ("api_key", "origin")
        return ()

    def has_model_provider(self, provider: str) -> bool:
        return bool(self.model_provider_field_names(provider))

    def model_secret_for_origin(self, provider: str, origin: str) -> str | None:
        if provider == self._model_provider and origin == self._origin:
            return self._model_secret
        return None


def _invoke(*arguments: str) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = _cli_module().main(list(arguments))
    return code, stdout.getvalue(), stderr.getvalue()


def _write_private_configuration(home: Path, payload: bytes) -> Path:
    private = home / ".sciretriever"
    private.mkdir(mode=0o700, exist_ok=True)
    path = private / "config.toml"
    path.write_bytes(payload)
    path.chmod(0o600)
    return path


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
        config_probes = importlib.import_module("sciretriever.entry.cli.config_center.probes")
        with (
            patch.object(
                module,
                "build_production_object_graph",
                side_effect=AssertionError("help must not bootstrap Storage"),
            ),
            patch.object(
                config_probes,
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

    def test_configuration_test_help_tree_is_owner_scoped(self) -> None:
        paths = (
            ("config", "test", "provider", "--help"),
            ("config", "test", "model", "--help"),
            ("config", "test", "search", "--help"),
            ("config", "test", "download", "--help"),
            ("config", "test", "parse", "--help"),
            ("config", "test", "analyze", "--help"),
            ("config", "test", "browser", "--help"),
            ("config", "test", "browser", "model", "--help"),
            ("config", "test", "browser", "site", "--help"),
        )
        for path in paths:
            with self.subTest(path=path):
                code, stdout, stderr = _invoke(*path)
                self.assertEqual(code, 0)
                self.assertNotEqual(stdout, "")
                self.assertEqual(stderr, "")

    def test_retired_and_incomplete_configuration_test_paths_are_usage_errors(self) -> None:
        paths = (
            ("config", "test"),
            ("config", "test", "llm"),
            ("config", "test", "mineru"),
            ("config", "test", "browser-agent"),
            ("config", "test", "--browser", "springerlink"),
            ("config", "test", "provider"),
            ("config", "test", "model"),
            ("config", "test", "search"),
            ("config", "test", "download"),
            ("config", "test", "browser", "site"),
        )
        for path in paths:
            with self.subTest(path=path):
                code, stdout, stderr = _invoke(*path)
                self.assertEqual(code, 2)
                self.assertEqual(stdout, "")
                self.assertIn("invalid command input", stderr)

    def test_configuration_test_leaf_options_do_not_overwrite_parent_choices(self) -> None:
        parser = _cli_module()._build_parser()
        arguments = parser.parse_args(("config", "--theme", "dark", "test", "--json", "parse"))

        self.assertEqual(arguments.theme, "dark")
        self.assertTrue(arguments.json)
        self.assertEqual(arguments.test_owner, "parse")

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
                "load_user_configuration",
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
        load_configuration.assert_called_once_with()
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
            patch.object(module, "load_user_configuration", return_value=configuration),
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
            patch.object(module, "load_user_configuration", return_value=configuration),
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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


class CliResultAndFailureBoundaryTests(unittest.TestCase):
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
                            "load_user_configuration",
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
                with patch.object(module, "load_user_configuration", side_effect=exception):
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
                patch.object(module, "load_user_configuration", side_effect=exception),
            ):
                code, stdout, stderr = _invoke("literature", "search", "--json")
            self.assertEqual(code, expected_code)
            self.assertEqual(stdout, "")
            self.assertIn(expected_message, stderr)
            combined = stdout + stderr
            for unsafe in (sentinel, private_path, external_url, "Traceback", "ValueError"):
                self.assertNotIn(unsafe, combined)

    def test_missing_user_configuration_points_to_the_fixed_config_manager(self) -> None:
        module = _cli_module()
        config_status = importlib.import_module("sciretriever.entry.cli.config_center.status")
        with patch.object(
            config_status,
            "load_user_configuration",
            side_effect=module.ConfigurationError("configuration file is unavailable"),
        ):
            code, stdout, stderr = _invoke("config", "status")

        self.assertEqual((code, stdout), (4, ""))
        self.assertEqual(
            stderr,
            "configuration is not initialized; run 'sciretriever config' to create "
            "~/.sciretriever/config.toml.\n",
        )

    def test_config_command_surfaces_only_value_free_configuration_diagnostics(self) -> None:
        module = _cli_module()
        config_status = importlib.import_module("sciretriever.entry.cli.config_center.status")
        with patch.object(
            config_status,
            "load_user_configuration",
            side_effect=module.ConfigurationError(
                "credentials file has unsafe ownership or permissions"
            ),
        ):
            safe = _invoke("config", "status")
        self.assertEqual(
            safe,
            (
                4,
                "",
                "configuration operation failed: credentials file has unsafe ownership or "
                "permissions.\n",
            ),
        )

        sentinel = "private-configuration-value-sentinel"
        with patch.object(
            config_status,
            "load_user_configuration",
            side_effect=module.ConfigurationError(sentinel),
        ):
            redacted = _invoke("config", "status")
        self.assertEqual(redacted, (4, "", "configuration operation failed.\n"))
        self.assertNotIn(sentinel, redacted[2])

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
                patch.object(module, "load_user_configuration", side_effect=exception),
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
            patch.object(module, "load_user_configuration", return_value=Configuration()),
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
            "load_user_configuration",
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
