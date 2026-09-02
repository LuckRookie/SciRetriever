"""Foreground command-line boundary for SciRetriever."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections.abc import Callable, Sequence
from typing import Any, Literal, NoReturn, TypeAlias, TypeVar, cast

from pydantic import ValidationError

from sciretriever.bootstrap import (
    BibliographyExchangeObjectGraph,
    BootstrapError,
    CitationDiscoveryObjectGraph,
    DatabaseCompletionObjectGraph,
    LocalLibraryObjectGraph,
    ManualPdfObjectGraph,
    ProductionEntryScope,
    TopicDiscoveryObjectGraph,
    build_production_object_graph,
)
from sciretriever.configuration import (
    ConfigurationError,
    load_user_configuration,
)
from sciretriever.entry.cli.config_center import run_config
from sciretriever.entry.cli.config_ui import ConfigTheme
from sciretriever.entry.ports import UserOutputConflictError
from sciretriever.literature.api import LiteratureArtifactReference
from sciretriever.model.discovery import (
    CitationDiscoveryInput,
    ProviderDiscoveryLimit,
    TopicDiscoveryInput,
)
from sciretriever.model.execution import (
    AllPendingSelector,
    BatchRequest,
    BatchSelector,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchRequest,
    LiteratureReferenceRequest,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ReferenceId,
)
from sciretriever.model.report import BibliographyFormat

_BibliographySelector: TypeAlias = (
    DiscoveryRunSelector | QuerySelector | MetaLiteratureSelector | LiteratureSelector | None
)
_BUSINESS_FAILURE = 3
_CONFIGURATION_FAILURE = 4
_INTERNAL_FAILURE = 70
_INTERRUPTED = 130
_InputT = TypeVar("_InputT")
_CLI_INPUT_VALIDATION_PROVIDER = ProviderDiscoveryLimit(
    provider_name="cli-input-validation",
    scan_limit=1,
)


class _CliInputError(ValueError):
    """A redacted failure while converting parsed argv into neutral Models."""


def _input_value(factory: Callable[[], _InputT]) -> _InputT:
    try:
        return factory()
    except (ValidationError, ValueError, TypeError):
        raise _CliInputError() from None


class _SafeArgumentParser(argparse.ArgumentParser):
    """Argparse shell that never repeats an unsafe argv value in diagnostics."""

    def error(self, message: str) -> NoReturn:
        del message
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: invalid command input\n")


def _add_json(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="Write one JSON result to stdout.")


def _add_nested_json(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Write one JSON result to stdout.",
    )


def _add_nested_debug(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--debug",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Write detailed step-by-step diagnostics to stderr.",
    )


def _add_theme(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--theme",
        choices=tuple(item.value for item in ConfigTheme),
        default=ConfigTheme.AUTO.value,
        help="Terminal theme for human-readable output.",
    )


def _add_nested_theme(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--theme",
        choices=tuple(item.value for item in ConfigTheme),
        default=argparse.SUPPRESS,
        help="Terminal theme for human-readable output.",
    )


def _add_library_query(parser: argparse.ArgumentParser, *, text_option: str = "--text") -> None:
    parser.add_argument(text_option, dest="text")
    parser.add_argument("--title")
    parser.add_argument("--author")
    parser.add_argument("--author-orcid", action="append", default=[])
    parser.add_argument("--identifier", action="append", default=[], metavar="NAMESPACE:VALUE")
    parser.add_argument("--year-from", type=int)
    parser.add_argument("--year-to", type=int)
    parser.add_argument("--venue")
    parser.add_argument("--publisher")
    parser.add_argument("--document-type", action="append", default=[])
    parser.add_argument("--language", action="append", default=[])
    parser.add_argument("--keyword", action="append", default=[])
    parser.add_argument(
        "--version-role",
        action="append",
        default=[],
        choices=("published", "accepted-manuscript", "preprint", "other"),
    )
    parser.add_argument(
        "--status",
        action="append",
        default=[],
        choices=("UNREVIEWED", "ASSET_READY", "CONTENT_READY"),
    )
    parser.add_argument(
        "--missing-step",
        action="append",
        default=[],
        choices=("primary-pdf", "parser-result", "literature-content"),
    )
    manual_pdf = parser.add_mutually_exclusive_group()
    manual_pdf.add_argument(
        "--needs-manual-pdf",
        action="store_const",
        const=True,
        dest="needs_manual_pdf",
    )
    manual_pdf.add_argument(
        "--no-needs-manual-pdf",
        action="store_const",
        const=False,
        dest="needs_manual_pdf",
    )
    parser.set_defaults(needs_manual_pdf=None)
    parser.add_argument("--discovery-run-id", action="append", default=[])


def _leaf(parent: argparse.ArgumentParser, name: str, help_text: str) -> argparse.ArgumentParser:
    subcommands = getattr(parent, "_sciretriever_subcommands")
    parser = subcommands.add_parser(name, help=help_text, description=help_text)
    _add_json(parser)
    _add_nested_debug(parser)
    return parser


def _group(
    root: argparse._SubParsersAction[_SafeArgumentParser],
    name: str,
    help_text: str,
) -> argparse.ArgumentParser:
    parser = root.add_parser(name, help=help_text, description=help_text)
    _add_nested_debug(parser)
    subcommands = parser.add_subparsers(dest="action", metavar="COMMAND", required=True)
    setattr(parser, "_sciretriever_subcommands", subcommands)
    return parser


def _build_parser() -> argparse.ArgumentParser:
    parser = _SafeArgumentParser(
        prog="sciretriever",
        description="Build and maintain a scientific-literature database.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Write detailed step-by-step diagnostics to stderr.",
    )
    commands = parser.add_subparsers(dest="command", metavar="COMMAND", required=True)

    discover = _group(commands, "discover", "Run bounded external literature discovery.")
    topic = _leaf(discover, "topic", "Discover literature for a topic.")
    topic.add_argument("query")
    topic.add_argument("--year-from", type=int)
    topic.add_argument("--year-to", type=int)
    citations = _leaf(discover, "citations", "Discover literature through citation relations.")
    citations.add_argument(
        "--seed-literature-id",
        action="append",
        required=True,
        dest="seed_literature_ids",
    )
    citations.add_argument(
        "--direction",
        choices=("references", "cited-by", "both"),
        default="both",
    )
    citations.add_argument("--max-depth", type=int, default=1)
    citations.add_argument("--result-limit", type=int, default=1000)

    complete = commands.add_parser(
        "complete",
        help="Complete selected database literature.",
        description="Complete selected database literature.",
    )
    _add_json(complete)
    _add_nested_debug(complete)
    complete.add_argument("goal", choices=("pdf", "content"))
    completion_selector = complete.add_mutually_exclusive_group(required=True)
    completion_selector.add_argument("--all-pending", action="store_true")
    completion_selector.add_argument("--discovery-run-id")
    completion_selector.add_argument("--import-meta-literature-id", action="append")
    completion_selector.add_argument("--query")
    completion_selector.add_argument("--meta-literature-id", action="append")
    completion_selector.add_argument("--literature-id", action="append")

    literature = _group(commands, "literature", "Read the local literature database.")
    search = _leaf(literature, "search", "Search local literature.")
    _add_library_query(search)
    search.add_argument(
        "--sort",
        choices=(
            "publication-year-desc",
            "publication-year-asc",
            "title-asc",
            "title-desc",
            "relevance",
        ),
        default="publication-year-desc",
    )
    search.add_argument("--limit", type=int, default=50)
    search.add_argument("--cursor")
    show = _leaf(literature, "show", "Show one concrete Literature.")
    show.add_argument("literature_id")
    references = _leaf(literature, "references", "List references from one Literature.")
    reference_selection = references.add_mutually_exclusive_group(required=True)
    reference_selection.add_argument("literature_id", nargs="?")
    reference_selection.add_argument("--reference-id")
    references.add_argument("--limit", type=int, default=50)
    references.add_argument("--cursor")
    cited_by = _leaf(literature, "cited-by", "List Literature citing one Literature.")
    cited_by.add_argument("literature_id")
    cited_by.add_argument("--limit", type=int, default=50)
    cited_by.add_argument("--cursor")

    import_group = _group(commands, "import", "Import user-provided literature data.")
    import_metadata = _leaf(import_group, "metadata", "Import bibliographic metadata.")
    import_metadata.add_argument("format", choices=tuple(item.value for item in BibliographyFormat))
    import_metadata.add_argument("source", help="Input file, or - for stdin.")
    import_pdf = _leaf(import_group, "pdf", "Admit a PDF for one concrete Literature.")
    import_pdf.add_argument("literature_id")
    import_pdf.add_argument("source", help="Input PDF, or - for stdin.")

    export_group = _group(commands, "export", "Export literature data.")
    export_metadata = _leaf(export_group, "metadata", "Export bibliographic metadata.")
    export_metadata.add_argument("format", choices=tuple(item.value for item in BibliographyFormat))
    export_metadata.add_argument("output")
    export_metadata.add_argument("--overwrite", action="store_true")
    metadata_scope = export_metadata.add_mutually_exclusive_group()
    metadata_scope.add_argument("--discovery-run-id")
    metadata_scope.add_argument("--query")
    metadata_scope.add_argument("--meta-literature-id", action="append")
    metadata_scope.add_argument("--literature-id", action="append")
    for name, help_text in (
        ("pdf", "Export one current primary PDF."),
        ("content", "Export one current Literature content document."),
    ):
        artifact = _leaf(export_group, name, help_text)
        artifact.add_argument("literature_id")
        artifact.add_argument("output", help="Output file, or - for raw stdout.")
        artifact.add_argument("--overwrite", action="store_true")

    config = commands.add_parser(
        "config",
        help="Manage local services, Provider credentials, and readiness.",
        description=(
            "Interactively configure Models, Search, Download, Parse, Analyze and Browser, "
            "or inspect local readiness and run explicit owner-scoped probes."
        ),
    )
    _add_nested_debug(config)
    _add_theme(config)
    config_commands = config.add_subparsers(
        dest="action",
        metavar="COMMAND",
        required=False,
    )
    setattr(config, "_sciretriever_subcommands", config_commands)
    status_parser = _leaf(config, "status", "Show local configuration readiness.")
    _add_nested_theme(status_parser)
    test_parser = config_commands.add_parser(
        "test",
        help="Run an explicit owner-scoped configuration probe.",
        description="Run an explicit owner-scoped configuration probe.",
    )
    _add_json(test_parser)
    _add_nested_debug(test_parser)
    _add_nested_theme(test_parser)
    test_parser.add_argument(
        "--all",
        action="store_true",
        dest="test_global_all",
        help="Run every active safe configuration probe.",
    )
    test_targets = test_parser.add_subparsers(dest="test_owner", metavar="TARGET")

    def test_target(name: str, help_text: str) -> argparse.ArgumentParser:
        target = test_targets.add_parser(name, help=help_text, description=help_text)
        _add_nested_json(target)
        _add_nested_debug(target)
        _add_nested_theme(target)
        return target

    provider_test = test_target("provider", "Probe one Model Provider catalog.")
    provider_test.add_argument("target")
    model_test = test_target("model", "Probe one exact reusable Model.")
    model_test.add_argument("target")
    model_test.add_argument(
        "--image",
        action="store_true",
        dest="test_image",
        help="Use one synthetic image instead of the text probe.",
    )
    for owner in ("search", "download"):
        source_test = test_target(owner, f"Probe {owner.title()} Sources.")
        source_selection = source_test.add_mutually_exclusive_group(required=True)
        source_selection.add_argument("target", nargs="?", metavar="SOURCE")
        source_selection.add_argument("--all", action="store_true", dest="test_area_all")
    test_target("parse", "Probe the configured MinerU service.")
    test_target("analyze", "Probe the selected Analyze Model contract.")

    browser_test = test_targets.add_parser(
        "browser",
        help="Probe the Browser Model or one approved site.",
        description="Probe the Browser Model or one approved site.",
    )
    browser_targets = browser_test.add_subparsers(
        dest="browser_test_target",
        metavar="TARGET",
        required=True,
    )
    browser_model_test = browser_targets.add_parser(
        "model",
        help="Probe the selected Browser Model contract.",
    )
    _add_nested_json(browser_model_test)
    _add_nested_debug(browser_model_test)
    _add_nested_theme(browser_model_test)
    browser_site_test = browser_targets.add_parser(
        "site",
        help="Probe one approved minimal Publisher site target.",
    )
    browser_site_test.add_argument("target", metavar="ACCESS_KEY")
    _add_nested_json(browser_site_test)
    _add_nested_debug(browser_site_test)
    _add_nested_theme(browser_site_test)
    return parser


def _write_result(value: object, *, as_json: bool) -> None:
    if hasattr(value, "model_dump"):
        payload = value.model_dump(mode="json")  # type: ignore[attr-defined]
    else:
        payload = value
    if as_json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        return
    sys.stdout.write(_human_result(payload) + "\n")


def _result_code(value: object) -> int:
    """Map the operation boundary to a stable shell exit code.

    A completed batch is a normal operation boundary even when individual
    targets are recorded in the report's ``failed`` partition.  Those
    per-target failures are business data for the caller to inspect (and are
    rendered identically in human and JSON output); only an operation-level
    failed end changes the process result.  Keeping that distinction here
    prevents a batch with useful partial results from being mistaken for an
    unhandled CLI failure while still giving scripts a deterministic code for
    cancellation and operation failure.
    """
    end = getattr(value, "end", None)
    kind = getattr(end, "kind", None)
    if kind == "failed":
        return _BUSINESS_FAILURE
    if kind == "interrupted":
        return _INTERRUPTED
    return 0


def _present_result(value: object, *, as_json: bool) -> int:
    _write_result(value, as_json=as_json)
    return _result_code(value)


def _human_result(payload: Any) -> str:
    if isinstance(payload, dict):
        if payload.get("kind") == "database-completion":
            return _human_database_completion(payload)
        return "\n".join(f"{key}: {value}" for key, value in payload.items())
    return str(payload)


def _human_database_completion(payload: dict[str, Any]) -> str:
    end = payload.get("end")
    end_mapping = end if isinstance(end, dict) else {}
    outcome = str(end_mapping.get("kind", "unknown"))
    goal = str(payload.get("goal", "unknown"))
    partition_names = (
        "goal_reached",
        "needs_manual_pdf",
        "failed",
        "interrupted",
        "not_started",
    )
    partitions = {name: _completion_partition(payload.get(name)) for name in partition_names}
    lines = [
        "Database completion",
        f"  Goal: {goal}",
        f"  Outcome: {outcome}",
        "",
        "Summary",
    ]
    lines.extend(f"  {name}: {len(partitions[name])}" for name in partition_names)
    for name in partition_names:
        lines.extend(("", f"{name} ({len(partitions[name])})"))
        items = partitions[name]
        if not items:
            lines.append("  (none)")
            continue
        for item in items:
            lines.extend(_completion_partition_item(name, item))
    no_usable = payload.get("no_usable_content_literature_ids")
    no_usable_ids = tuple(str(value) for value in no_usable) if isinstance(no_usable, list) else ()
    lines.extend(("", f"no_usable_content ({len(no_usable_ids)})"))
    lines.extend(
        ("  (none)",)
        if not no_usable_ids
        else tuple(f"  - literature:{value}" for value in no_usable_ids)
    )
    operation_failure = end_mapping.get("failure")
    if isinstance(operation_failure, dict):
        lines.extend(("", "operation_failure"))
        lines.extend(_human_failure_lines(operation_failure, indent="  "))
    return "\n".join(lines)


def _completion_partition(value: object) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, dict))


def _completion_target_text(item: dict[str, Any]) -> str:
    target = item.get("target")
    if not isinstance(target, dict):
        return "unknown-target"
    kind = str(target.get("kind", "unknown"))
    identity = target.get("literature_id", target.get("meta_literature_id", "-"))
    return f"{kind}:{identity}"


def _completion_partition_item(
    partition: str,
    item: dict[str, Any],
) -> tuple[str, ...]:
    target = _completion_target_text(item)
    if partition == "goal_reached":
        return (f"  + {target} -> literature:{item.get('literature_id', '-')}",)
    if partition == "needs_manual_pdf":
        literature_ids = item.get("literature_ids")
        values = (
            ", ".join(f"literature:{value}" for value in literature_ids)
            if isinstance(literature_ids, list)
            else "-"
        )
        return (f"  ? {target} -> {values}",)
    if partition == "failed":
        lines = [
            f"  ! {target} stage={item.get('stage', '-')} "
            f"literature={item.get('literature_id') or '-'}"
        ]
        failure = item.get("failure")
        if isinstance(failure, dict):
            lines.extend(_human_failure_lines(failure, indent="    "))
        return tuple(lines)
    if partition == "interrupted":
        return (f"  ~ {target} literature={item.get('literature_id') or '-'}",)
    return (f"  - {target}",)


def _human_failure_lines(
    failure: dict[str, Any],
    *,
    indent: str,
) -> tuple[str, ...]:
    retryable = str(bool(failure.get("retryable", False))).lower()
    return (
        f"{indent}code: {failure.get('code', '-')}",
        f"{indent}retryable: {retryable}",
        f"{indent}reason: {failure.get('reason', '-')}",
        f"{indent}action: {failure.get('action', '-')}",
    )


def _run_search(arguments: argparse.Namespace) -> int:
    request = _input_value(
        lambda: LibrarySearchRequest(
            query=_library_query(arguments),
            sort=arguments.sort,
            limit=arguments.limit,
            cursor=arguments.cursor,
        )
    )
    graph = _load_local_library_graph(debug=arguments.debug)
    result = graph.entry_api.search_literature(request)
    return _present_result(result, as_json=arguments.json)


def _parse_identifiers(values: Sequence[str]) -> tuple[Identifier, ...]:
    identifiers: list[Identifier] = []
    for value in values:
        namespace, separator, identifier_value = value.partition(":")
        if not separator:
            raise ValueError("identifier must use NAMESPACE:VALUE")
        identifiers.append(Identifier(namespace=namespace, value=identifier_value))
    return tuple(identifiers)


def _library_query(arguments: argparse.Namespace) -> LibraryQuery:
    return LibraryQuery(
        text=arguments.text,
        title=arguments.title,
        author=arguments.author,
        author_orcids=tuple(arguments.author_orcid),
        identifiers=_parse_identifiers(arguments.identifier),
        publication_year_from=arguments.year_from,
        publication_year_to=arguments.year_to,
        venue=arguments.venue,
        publisher=arguments.publisher,
        document_types=tuple(arguments.document_type),
        languages=tuple(arguments.language),
        keywords=tuple(arguments.keyword),
        version_roles=tuple(arguments.version_role),
        statuses=tuple(arguments.status),
        missing_steps=tuple(arguments.missing_step),
        needs_manual_pdf=arguments.needs_manual_pdf,
        discovery_run_ids=tuple(DiscoveryRunId(value) for value in arguments.discovery_run_id),
    )


def _load_local_library_graph(*, debug: bool) -> LocalLibraryObjectGraph:
    configuration = load_user_configuration()
    if debug:
        return cast(
            LocalLibraryObjectGraph,
            build_production_object_graph(
                configuration,
                scope=ProductionEntryScope.LOCAL_LIBRARY,
                logging_level=logging.DEBUG,
            ),
        )
    return cast(
        LocalLibraryObjectGraph,
        build_production_object_graph(
            configuration,
            scope=ProductionEntryScope.LOCAL_LIBRARY,
        ),
    )


def _load_scoped_graph(scope: ProductionEntryScope, *, debug: bool) -> object:
    configuration = load_user_configuration()
    if debug:
        return build_production_object_graph(
            configuration,
            scope=scope,
            logging_level=logging.DEBUG,
        )
    return build_production_object_graph(configuration, scope=scope)


def _run_discovery(arguments: argparse.Namespace) -> int:
    if arguments.action == "topic":
        request = _input_value(
            lambda: TopicDiscoveryInput(
                kind="topic",
                query=arguments.query,
                year_from=arguments.year_from,
                year_to=arguments.year_to,
                providers=(_CLI_INPUT_VALIDATION_PROVIDER,),
            )
        )
        graph = cast(
            TopicDiscoveryObjectGraph,
            _load_scoped_graph(
                ProductionEntryScope.TOPIC_DISCOVERY,
                debug=arguments.debug,
            ),
        )
        request = request.model_copy(
            update={"providers": graph.topic_provider_limits},
            deep=False,
        )
        result = graph.entry_api.discover_topic(request)
    else:
        request = _input_value(
            lambda: CitationDiscoveryInput(
                kind="citation",
                seed_literature_ids=tuple(
                    LiteratureId(value) for value in arguments.seed_literature_ids
                ),
                direction=arguments.direction,
                max_depth=arguments.max_depth,
                result_limit=arguments.result_limit,
                providers=(_CLI_INPUT_VALIDATION_PROVIDER,),
            )
        )
        graph = cast(
            CitationDiscoveryObjectGraph,
            _load_scoped_graph(
                ProductionEntryScope.CITATION_DISCOVERY,
                debug=arguments.debug,
            ),
        )
        request = request.model_copy(
            update={"providers": graph.citation_provider_limits},
            deep=False,
        )
        result = graph.entry_api.discover_citations(request)
    return _present_result(result, as_json=arguments.json)


def _completion_selector(arguments: argparse.Namespace) -> BatchSelector:
    if arguments.all_pending:
        return AllPendingSelector(kind="all-pending")
    if arguments.discovery_run_id is not None:
        return DiscoveryRunSelector(
            kind="discovery-run",
            discovery_run_id=DiscoveryRunId(arguments.discovery_run_id),
        )
    if arguments.import_meta_literature_id is not None:
        return ImportReportSelector(
            kind="import-report",
            meta_literature_ids=tuple(
                MetaLiteratureId(value) for value in arguments.import_meta_literature_id
            ),
        )
    if arguments.query is not None:
        return QuerySelector(kind="query", query=LibraryQuery(text=arguments.query))
    if arguments.meta_literature_id is not None:
        return MetaLiteratureSelector(
            kind="meta-literatures",
            meta_literature_ids=tuple(
                MetaLiteratureId(value) for value in arguments.meta_literature_id
            ),
        )
    return LiteratureSelector(
        kind="literatures",
        literature_ids=tuple(LiteratureId(value) for value in arguments.literature_id),
    )


def _run_complete(arguments: argparse.Namespace) -> int:
    goal: Literal["ASSET_READY", "CONTENT_READY"] = (
        "ASSET_READY" if arguments.goal == "pdf" else "CONTENT_READY"
    )
    scope = (
        ProductionEntryScope.ASSET_COMPLETION
        if goal == "ASSET_READY"
        else ProductionEntryScope.CONTENT_COMPLETION
    )
    request = _input_value(
        lambda: BatchRequest(selector=_completion_selector(arguments), goal=goal)
    )
    graph = cast(
        DatabaseCompletionObjectGraph,
        _load_scoped_graph(scope, debug=arguments.debug),
    )
    try:
        result = graph.entry_api.complete_database(request)
        return _present_result(result, as_json=arguments.json)
    finally:
        graph.close()


def _run_literature_read(arguments: argparse.Namespace) -> int:
    if arguments.action == "show":
        input_value = _input_value(lambda: LiteratureId(arguments.literature_id))
    elif arguments.action == "references" and arguments.reference_id is not None:
        input_value = _input_value(lambda: ReferenceId(arguments.reference_id))
    else:
        direction: Literal["references", "cited-by"] = (
            "references" if arguments.action == "references" else "cited-by"
        )
        input_value = _input_value(
            lambda: LiteratureReferenceRequest(
                literature_id=LiteratureId(arguments.literature_id),
                direction=direction,
                limit=arguments.limit,
                cursor=arguments.cursor,
            )
        )
    graph = _load_local_library_graph(debug=arguments.debug)
    if arguments.action == "show":
        result = graph.entry_api.get_literature_detail(cast(LiteratureId, input_value))
    elif arguments.action == "references" and arguments.reference_id is not None:
        result = graph.entry_api.get_reference_detail(cast(ReferenceId, input_value))
    else:
        result = graph.entry_api.list_literature_references(
            cast(LiteratureReferenceRequest, input_value)
        )
    return _present_result(result, as_json=arguments.json)


def _binary_input(source: str):
    if source == "-":
        return _BorrowedBinaryInput(sys.stdin.buffer)
    return open(source, "rb")


class _BorrowedBinaryInput:
    __slots__ = ("_stream",)

    def __init__(self, stream: Any) -> None:
        self._stream = stream

    def __enter__(self) -> Any:
        return self._stream

    def __exit__(self, *unused: object) -> None:
        return None


def _run_import(arguments: argparse.Namespace) -> int:
    format = (
        _input_value(lambda: BibliographyFormat(arguments.format))
        if arguments.action == "metadata"
        else None
    )
    literature_id = (
        None
        if arguments.action == "metadata"
        else _input_value(lambda: LiteratureId(arguments.literature_id))
    )
    with _binary_input(arguments.source) as source:
        if arguments.action == "metadata":
            assert format is not None
            graph = cast(
                BibliographyExchangeObjectGraph,
                _load_scoped_graph(
                    ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE,
                    debug=arguments.debug,
                ),
            )
            result = graph.entry_api.import_bibliography(format, source)
        else:
            graph = cast(
                ManualPdfObjectGraph,
                _load_scoped_graph(
                    ProductionEntryScope.MANUAL_PDF,
                    debug=arguments.debug,
                ),
            )
            assert literature_id is not None
            result = graph.entry_api.admit_manual_pdf(literature_id, source)
    return _present_result(result, as_json=arguments.json)


def _bibliography_selector(arguments: argparse.Namespace) -> _BibliographySelector:
    if arguments.discovery_run_id is not None:
        return DiscoveryRunSelector(
            kind="discovery-run",
            discovery_run_id=DiscoveryRunId(arguments.discovery_run_id),
        )
    if arguments.query is not None:
        return QuerySelector(kind="query", query=LibraryQuery(text=arguments.query))
    if arguments.meta_literature_id is not None:
        return MetaLiteratureSelector(
            kind="meta-literatures",
            meta_literature_ids=tuple(
                MetaLiteratureId(value) for value in arguments.meta_literature_id
            ),
        )
    if arguments.literature_id is not None:
        return LiteratureSelector(
            kind="literatures",
            literature_ids=tuple(LiteratureId(value) for value in arguments.literature_id),
        )
    return None


def _run_export_metadata(arguments: argparse.Namespace) -> int:
    format = _input_value(lambda: BibliographyFormat(arguments.format))
    selector = _input_value(lambda: _bibliography_selector(arguments))
    graph = cast(
        BibliographyExchangeObjectGraph,
        _load_scoped_graph(
            ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE,
            debug=arguments.debug,
        ),
    )
    result = graph.entry_api.export_bibliography(
        format,
        selector,
        arguments.output,
        overwrite=arguments.overwrite,
    )
    return _present_result(result, as_json=arguments.json)


def _select_artifact(detail: object, action: str) -> LiteratureArtifactReference | None:
    if action == "pdf":
        primary_pdf = getattr(detail, "primary_pdf", None)
        reference = None if primary_pdf is None else getattr(primary_pdf, "asset", None)
        return cast(LiteratureArtifactReference | None, reference)
    content = getattr(detail, "content", None)
    reference = None if content is None else getattr(content, "markdown", None)
    return cast(LiteratureArtifactReference | None, reference)


def _copy_to_stdout(source: Any) -> None:
    destination = sys.stdout.buffer
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            return
        destination.write(chunk)


def _run_export_artifact(arguments: argparse.Namespace) -> int:
    literature_id = _input_value(lambda: LiteratureId(arguments.literature_id))
    graph = _load_local_library_graph(debug=arguments.debug)
    detail = graph.entry_api.get_literature_detail(literature_id)
    reference = _select_artifact(detail, arguments.action)
    if reference is None:
        sys.stderr.write(f"{arguments.action} artifact is not available.\n")
        return 3
    if arguments.output == "-":
        with graph.entry_api.open_artifact(reference) as source:
            _copy_to_stdout(source)
        return 0
    graph.entry_api.export_artifact(reference, arguments.output, overwrite=arguments.overwrite)
    if arguments.json:
        _write_result(True, as_json=True)
    else:
        sys.stdout.write("exported\n")
    return 0


def _dispatch(arguments: argparse.Namespace) -> int:
    if arguments.command == "discover":
        return _run_discovery(arguments)
    if arguments.command == "complete":
        return _run_complete(arguments)
    if arguments.command == "literature" and arguments.action == "search":
        return _run_search(arguments)
    if arguments.command == "literature":
        return _run_literature_read(arguments)
    if arguments.command == "import":
        return _run_import(arguments)
    if arguments.command == "export" and arguments.action == "metadata":
        return _run_export_metadata(arguments)
    if arguments.command == "export":
        return _run_export_artifact(arguments)
    if arguments.command == "config":
        return run_config(arguments)
    raise RuntimeError("command is not implemented")


def _write_configuration_failure(arguments: argparse.Namespace, error: ConfigurationError) -> None:
    message = str(error)
    if message == "configuration file is unavailable":
        sys.stderr.write(
            "configuration is not initialized; run 'sciretriever config' to create "
            "~/.sciretriever/config.toml.\n"
        )
    elif arguments.command == "config" and message != "configuration operation failed":
        sys.stderr.write(f"configuration operation failed: {message}.\n")
    else:
        sys.stderr.write("configuration operation failed.\n")


def _validate_parsed_arguments(
    parser: argparse.ArgumentParser,
    arguments: argparse.Namespace,
) -> None:
    if (
        arguments.command == "export"
        and arguments.action in {"pdf", "content"}
        and arguments.output == "-"
        and arguments.json
    ):
        parser.error("--json cannot be combined with raw artifact stdout")
    if arguments.command != "config" or arguments.action != "test":
        return
    global_all = bool(getattr(arguments, "test_global_all", False))
    owner_selected = getattr(arguments, "test_owner", None) is not None
    if global_all == owner_selected:
        parser.error("select one configuration test target")


def main(argv: Sequence[str] | None = None) -> int:
    """Parse one foreground invocation and return its stable process code."""

    parser = _build_parser()
    try:
        arguments = parser.parse_args(None if argv is None else list(argv))
        _validate_parsed_arguments(parser, arguments)
    except SystemExit as error:
        return error.code if isinstance(error.code, int) else 2
    try:
        return _dispatch(arguments)
    except (KeyboardInterrupt, EOFError):
        sys.stderr.write("operation interrupted.\n")
        return _INTERRUPTED
    except BootstrapError as error:
        sys.stderr.write(f"bootstrap failed ({error.code}).\n")
        return _CONFIGURATION_FAILURE
    except ConfigurationError as error:
        _write_configuration_failure(arguments, error)
        return _CONFIGURATION_FAILURE
    except UserOutputConflictError:
        sys.stderr.write("output target already exists.\n")
        return _BUSINESS_FAILURE
    except _CliInputError:
        sys.stderr.write("invalid command input.\n")
        return 2
    except OSError:
        sys.stderr.write("internal operation failed.\n")
        return _INTERNAL_FAILURE


__all__ = ("main",)
