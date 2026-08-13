"""Foreground command-line boundary for SciRetriever."""

from __future__ import annotations

import argparse
import getpass
import json
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
    build_production_configuration_probe_session,
    build_production_object_graph,
)
from sciretriever.configuration import (
    ConfigurationError,
    configuration_status,
    credential_field_specs,
    credential_section_exists,
    load_selected_configuration,
    remove_credentials,
    set_credentials,
)
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
    return parser


def _group(
    root: argparse._SubParsersAction[_SafeArgumentParser],
    name: str,
    help_text: str,
) -> argparse.ArgumentParser:
    parser = root.add_parser(name, help=help_text, description=help_text)
    subcommands = parser.add_subparsers(dest="action", metavar="COMMAND", required=True)
    setattr(parser, "_sciretriever_subcommands", subcommands)
    return parser


def _build_parser() -> argparse.ArgumentParser:
    parser = _SafeArgumentParser(
        prog="sciretriever",
        description="Build and maintain a scientific-literature database.",
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

    config = _group(commands, "config", "Manage local Provider credentials and readiness.")
    set_parser = _leaf(config, "set", "Set one Provider credential section.")
    set_parser.add_argument("provider")
    remove_parser = _leaf(config, "remove", "Remove one Provider credential section.")
    remove_parser.add_argument("provider")
    _leaf(config, "status", "Show local Provider readiness.")
    test_parser = _leaf(config, "test", "Run an explicit minimal read-only Provider probe.")
    selection = test_parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("provider", nargs="?")
    selection.add_argument("--all", action="store_true", dest="test_all")
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
        return "\n".join(f"{key}: {value}" for key, value in payload.items())
    return str(payload)


def _run_search(arguments: argparse.Namespace) -> int:
    request = _input_value(
        lambda: LibrarySearchRequest(
            query=_library_query(arguments),
            sort=arguments.sort,
            limit=arguments.limit,
            cursor=arguments.cursor,
        )
    )
    graph = _load_local_library_graph()
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


def _load_local_library_graph() -> LocalLibraryObjectGraph:
    configuration = load_selected_configuration(None)
    return cast(
        LocalLibraryObjectGraph,
        build_production_object_graph(
            configuration,
            scope=ProductionEntryScope.LOCAL_LIBRARY,
        ),
    )


def _load_scoped_graph(scope: ProductionEntryScope) -> object:
    configuration = load_selected_configuration(None)
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
            _load_scoped_graph(ProductionEntryScope.TOPIC_DISCOVERY),
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
            _load_scoped_graph(ProductionEntryScope.CITATION_DISCOVERY),
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
    graph = cast(DatabaseCompletionObjectGraph, _load_scoped_graph(scope))
    result = graph.entry_api.complete_database(request)
    return _present_result(result, as_json=arguments.json)


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
    graph = _load_local_library_graph()
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
                _load_scoped_graph(ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE),
            )
            result = graph.entry_api.import_bibliography(format, source)
        else:
            graph = cast(
                ManualPdfObjectGraph,
                _load_scoped_graph(ProductionEntryScope.MANUAL_PDF),
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
        _load_scoped_graph(ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE),
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
    graph = _load_local_library_graph()
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


def _confirm(prompt: str) -> bool:
    try:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        answer = input()
    except EOFError:
        return False
    return answer.strip().lower() in {"y", "yes"}


def _run_config_set(arguments: argparse.Namespace) -> int:
    specs = credential_field_specs(arguments.provider)
    existed = credential_section_exists(arguments.provider, home=None)
    if existed and not _confirm(f"Replace credentials for {arguments.provider}? [y/N] "):
        _write_result(
            {"provider": arguments.provider, "status": "cancelled"},
            as_json=arguments.json,
        )
        return 0
    values: dict[str, str] = {}
    for spec in specs:
        suffix = "required" if spec.required else "optional; blank to omit"
        value = getpass.getpass(f"{arguments.provider} {spec.name} ({suffix}): ").strip()
        if not value:
            if spec.required:
                sys.stderr.write("required credential field was empty.\n")
                return 2
            continue
        values[spec.name] = value
    set_credentials(arguments.provider, values, home=None)
    _write_result(
        {
            "provider": arguments.provider,
            "status": "replaced" if existed else "created",
        },
        as_json=arguments.json,
    )
    return 0


def _run_config_remove(arguments: argparse.Namespace) -> int:
    existed = credential_section_exists(arguments.provider, home=None)
    if existed:
        remove_credentials(arguments.provider, home=None)
    _write_result(
        {
            "provider": arguments.provider,
            "status": "removed" if existed else "not-configured",
        },
        as_json=arguments.json,
    )
    return 0


def _status_payload(value: object) -> object:
    if hasattr(value, "model_dump"):
        payload = value.model_dump(mode="json")  # type: ignore[attr-defined]
    else:
        payload = value
    if isinstance(payload, dict):
        return {key: item for key, item in payload.items() if key != "configuration_fingerprint"}
    return payload


def _run_config_status(arguments: argparse.Namespace) -> int:
    configuration = load_selected_configuration(None)
    result = configuration_status(configuration, credentials_home=None)
    _write_result(_status_payload(result), as_json=arguments.json)
    return 0


def _run_config_test(arguments: argparse.Namespace) -> int:
    configuration = load_selected_configuration(None)
    session = build_production_configuration_probe_session(configuration)
    result = session.run(
        provider=arguments.provider,
        test_all=arguments.test_all,
    )
    _write_result(result, as_json=arguments.json)
    return 0 if result.passed else 3


def _run_config(arguments: argparse.Namespace) -> int:
    if arguments.action == "set":
        return _run_config_set(arguments)
    if arguments.action == "remove":
        return _run_config_remove(arguments)
    if arguments.action == "status":
        return _run_config_status(arguments)
    return _run_config_test(arguments)


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
        return _run_config(arguments)
    raise RuntimeError("command is not implemented")


def main(argv: Sequence[str] | None = None) -> int:
    """Parse one foreground invocation and return its stable process code."""

    parser = _build_parser()
    try:
        arguments = parser.parse_args(None if argv is None else list(argv))
        if (
            arguments.command == "export"
            and arguments.action in {"pdf", "content"}
            and arguments.output == "-"
            and arguments.json
        ):
            parser.error("--json cannot be combined with raw artifact stdout")
    except SystemExit as error:
        return error.code if isinstance(error.code, int) else 2
    try:
        return _dispatch(arguments)
    except KeyboardInterrupt:
        sys.stderr.write("operation interrupted.\n")
        return _INTERRUPTED
    except BootstrapError as error:
        sys.stderr.write(f"bootstrap failed ({error.code}).\n")
        return _CONFIGURATION_FAILURE
    except ConfigurationError:
        sys.stderr.write("configuration operation failed.\n")
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
