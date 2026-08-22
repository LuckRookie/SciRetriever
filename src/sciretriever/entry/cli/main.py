"""Foreground command-line boundary for SciRetriever."""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, NoReturn, TypeAlias, TypeVar, cast

from pydantic import ValidationError

from sciretriever.acquisition.api import (
    AUTHORIZED_PDF_API_PROVIDER_KEYS,
    CONTROLLED_BROWSER_PRODUCTION_AVAILABLE,
    CONTROLLED_BROWSER_PRODUCTION_ROUTE_COUNT,
    UNSUPPORTED_AUTHORIZED_PDF_API_PROVIDER_KEYS,
)
from sciretriever.bootstrap import (
    PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS,
    BibliographyExchangeObjectGraph,
    BootstrapError,
    CitationDiscoveryObjectGraph,
    DatabaseCompletionObjectGraph,
    LocalLibraryObjectGraph,
    ManualPdfObjectGraph,
    ProductionConfigurationProbeSession,
    ProductionEntryScope,
    TopicDiscoveryObjectGraph,
    build_production_configuration_probe_session,
    build_production_object_graph,
)
from sciretriever.configuration import (
    CLOAKBROWSER_BROWSER_VERSION,
    CLOAKBROWSER_ORIGIN,
    CloakRuntimeManager,
    ConfigurationError,
    CredentialLookup,
    browser_access_status,
    browser_profile_status,
    configurable_credential_providers,
    configuration_diff,
    configuration_runtime_status,
    configuration_service_origin,
    configuration_status,
    configure_browser_access_profile,
    core_credential_section_exists,
    credential_field_specs,
    credential_path,
    credential_section_exists,
    load_credentials,
    load_editable_configuration,
    load_selected_configuration,
    remove_browser_profile,
    remove_core_credentials,
    remove_credentials,
    select_configuration_edit_path,
    set_core_credentials,
    set_credentials,
    update_configuration_sections,
    update_core_service_configuration,
)
from sciretriever.entry.cli.config_ui import (
    ConfigConsole,
    ConfigStatusPresenter,
    ConfigTheme,
    TerminalChoice,
    interactive_terminal,
)
from sciretriever.entry.ports import UserOutputConflictError
from sciretriever.literature.api import LiteratureArtifactReference
from sciretriever.logging.api import configure_logging
from sciretriever.model.configuration import (
    AccessConfig,
    AgentAuthentication,
    AgentProtocol,
    AgentProvider,
    AgentRoleConfig,
    AgentsConfig,
    AnalysisConfig,
    BrowserAccessStatus,
    BrowserConfigurationProbeResult,
    BrowserProfilePresence,
    Configuration,
    ConfigurationCapabilityStatus,
    ConfigurationProbeSummary,
    ConfigurationRuntimeStatus,
    CoreConfigurationProbeResult,
    CoreCredentialService,
    CredentialStatus,
    ParserConnectionMode,
    ParsingConfig,
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
_ANALYSIS_BUDGET_PRESETS: dict[str, dict[str, int]] = {
    "conservative": {
        "metadata_max_output_tokens": 1_024,
        "content_max_output_tokens": 4_096,
        "reference_max_output_tokens": 1_024,
        "max_input_bytes": 1_048_576,
        "max_chunk_bytes": 262_144,
        "max_chunk_count": 4,
        "max_total_llm_requests": 6,
        "max_total_output_tokens": 12_288,
    },
    "balanced": {
        "metadata_max_output_tokens": 2_048,
        "content_max_output_tokens": 8_192,
        "reference_max_output_tokens": 2_048,
        "max_input_bytes": 4_194_304,
        "max_chunk_bytes": 1_048_576,
        "max_chunk_count": 4,
        "max_total_llm_requests": 8,
        "max_total_output_tokens": 32_768,
    },
    "large": {
        "metadata_max_output_tokens": 4_096,
        "content_max_output_tokens": 16_384,
        "reference_max_output_tokens": 4_096,
        "max_input_bytes": 8_388_608,
        "max_chunk_bytes": 2_097_152,
        "max_chunk_count": 8,
        "max_total_llm_requests": 16,
        "max_total_output_tokens": 65_536,
    },
}
_DEFAULT_ANALYSIS_BUDGETS: dict[str, int] = {
    "metadata_max_output_tokens": 2_048,
    "content_max_output_tokens": 8_192,
    "reference_max_output_tokens": 2_048,
    "max_input_bytes": 4_194_304,
    "max_chunk_bytes": 1_048_576,
    "max_chunk_count": 4,
    "max_total_llm_requests": 8,
    "max_total_output_tokens": 32_768,
}
_InputT = TypeVar("_InputT")
_CLI_INPUT_VALIDATION_PROVIDER = ProviderDiscoveryLimit(
    provider_name="cli-input-validation",
    scan_limit=1,
)

_PUBLIC_ACQUISITION_SERVICES: dict[str, tuple[str, str]] = {
    "arxiv": ("public-pdf-api", "public PDF API"),
    "europe-pmc": ("public-pdf-api", "public PDF API"),
    "unpaywall": ("oa-locator-api", "OA locator API"),
    "sci-hub": ("operator-locator", "operator locator"),
}

_UNSUPPORTED_AUTHORIZED_API_DETAILS: dict[str, str] = {
    "springer": "Full Text product returns JATS/XML, not primary PDF",
}


@dataclass(frozen=True)
class _CredentialGuide:
    display_name: str
    purpose: str
    credential_help: str
    application_url: str
    enablement_hint: str
    probe_available: bool = True


_CREDENTIAL_GUIDES: dict[ProviderName, _CredentialGuide] = {
    ProviderName.WEB_OF_SCIENCE: _CredentialGuide(
        display_name="Web of Science",
        purpose="Metadata search and citation data",
        credential_help="Clarivate API key (X-ApiKey)",
        application_url="https://developer.clarivate.com/",
        enablement_hint=(
            'Add "web-of-science" to [sources.metadata].providers and configure '
            "[sources.metadata.web-of-science] product/database."
        ),
    ),
    ProviderName.SEMANTIC_SCHOLAR: _CredentialGuide(
        display_name="Semantic Scholar",
        purpose="Metadata, citations, and open-PDF locators",
        credential_help="Optional Semantic Scholar API key (x-api-key)",
        application_url="https://www.semanticscholar.org/product/api",
        enablement_hint=(
            'Add "semantic-scholar" to [sources.metadata].providers and/or '
            "[sources.acquisition].providers."
        ),
    ),
    ProviderName.OPENALEX: _CredentialGuide(
        display_name="OpenAlex",
        purpose="Metadata, citations, and open-content locators",
        credential_help="Optional OpenAlex API key for a larger usage budget",
        application_url="https://developers.openalex.org/guides/authentication",
        enablement_hint=(
            'Add "openalex" to [sources.metadata].providers and/or [sources.acquisition].providers.'
        ),
    ),
    ProviderName.ELSEVIER: _CredentialGuide(
        display_name="Elsevier / Scopus",
        purpose="Scopus metadata and authorized primary-PDF object retrieval",
        credential_help="Elsevier API key; institution token is optional",
        application_url="https://dev.elsevier.com/",
        enablement_hint='Add "elsevier" to [sources.metadata].providers.',
    ),
    ProviderName.SPRINGER: _CredentialGuide(
        display_name="Springer Nature",
        purpose="Springer Nature metadata; authorized primary-PDF API unavailable",
        credential_help="Springer Nature API key",
        application_url="https://dev.springernature.com/",
        enablement_hint='Add "springer" to [sources.metadata].providers.',
    ),
    ProviderName.CORE: _CredentialGuide(
        display_name="CORE",
        purpose="Metadata and authorized full-text PDF download",
        credential_help="CORE API key; required for the authorized PDF route",
        application_url="https://core.ac.uk/services/api",
        enablement_hint=(
            'Add "core" to [sources.metadata].providers and/or [sources.acquisition].providers.'
        ),
    ),
    ProviderName.OPENCITATIONS: _CredentialGuide(
        display_name="OpenCitations",
        purpose="Identifier lookup and citation relations",
        credential_help="Optional OpenCitations access token",
        application_url="https://opencitations.net/accesstoken",
        enablement_hint='Add "opencitations" to [sources.metadata].providers.',
    ),
    ProviderName.WILEY: _CredentialGuide(
        display_name="Wiley Online Library",
        purpose="IP-authorized Wiley TDM PDF download",
        credential_help="Wiley-issued TDM token",
        application_url="https://static.wiley.com/tdm/",
        enablement_hint='Add "wiley" to [sources.acquisition].providers.',
        probe_available=False,
    ),
}

_CREDENTIAL_FIELD_LABELS: dict[tuple[ProviderName, str], str] = {
    (ProviderName.WEB_OF_SCIENCE, "api_key"): "Clarivate API key",
    (ProviderName.SEMANTIC_SCHOLAR, "api_key"): "Semantic Scholar API key",
    (ProviderName.OPENALEX, "api_key"): "OpenAlex API key",
    (ProviderName.ELSEVIER, "api_key"): "Elsevier API key",
    (ProviderName.ELSEVIER, "institution_token"): "Elsevier institution token",
    (ProviderName.SPRINGER, "api_key"): "Springer Nature API key",
    (ProviderName.CORE, "api_key"): "CORE API key",
    (ProviderName.OPENCITATIONS, "access_token"): "OpenCitations access token",
    (ProviderName.WILEY, "tdm_api_token"): "Wiley TDM API token",
}


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
            "Interactively configure LLM Analysis, MinerU Parser, Literature Provider "
            "credentials, and controlled Browser access, or inspect readiness and run "
            "explicit probes."
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
    _add_theme(status_parser)
    test_parser = _leaf(config, "test", "Run an explicit minimal read-only service probe.")
    _add_theme(test_parser)
    selection = test_parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("provider", nargs="?")
    selection.add_argument("--all", action="store_true", dest="test_all")
    selection.add_argument(
        "--browser",
        dest="browser_access_key",
        metavar="ACCESS_KEY",
        help="Probe one approved Publisher Browser target explicitly.",
    )
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
    configuration = load_selected_configuration(None)
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
    configuration = load_selected_configuration(None)
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


def _confirm(prompt: str) -> bool:
    try:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        answer = input()
    except EOFError:
        return False
    return answer.strip().lower() in {"y", "yes"}


def _credential_guide(provider: ProviderName) -> _CredentialGuide:
    guide = _CREDENTIAL_GUIDES.get(provider)
    if guide is None:
        raise ConfigurationError()
    return guide


def _format_credential_fields(provider: ProviderName) -> str:
    fields = credential_field_specs(provider)
    return ", ".join(
        f"{field.name} ({'required' if field.required else 'optional'})" for field in fields
    )


def _credential_field_prompt(provider: ProviderName, name: str) -> str:
    return _CREDENTIAL_FIELD_LABELS.get((provider, name), name)


def _read_line(prompt: str) -> str | None:
    try:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        return input().strip()
    except EOFError:
        return None


def _credential_setup_state(provider: ProviderName, credentials: CredentialLookup) -> str:
    if not credentials.has_provider(provider):
        return "not configured"
    present = frozenset(credentials.field_names(provider))
    missing = tuple(
        field.name
        for field in credential_field_specs(provider)
        if field.required and field.name not in present
    )
    if missing:
        return "incomplete: missing " + ", ".join(missing)
    optional_missing = tuple(
        field.name
        for field in credential_field_specs(provider)
        if not field.required and field.name not in present
    )
    if optional_missing:
        return "configured; optional missing: " + ", ".join(optional_missing)
    return "configured"


def _choose_credential_provider() -> ProviderName | None:
    providers = configurable_credential_providers()
    credentials = load_credentials(home=None)
    sys.stderr.write(
        "SciRetriever Provider credential manager\n"
        "Secrets are entered without echo and stored in "
        "~/.sciretriever/credentials.toml (mode 0600).\n"
        "This configures credentials only; Provider enablement remains in config.toml.\n\n"
    )
    for index, provider in enumerate(providers, start=1):
        guide = _credential_guide(provider)
        state = _credential_setup_state(provider, credentials)
        sys.stderr.write(
            f"  {index}. {guide.display_name} [{provider.value}] — {state}\n"
            f"     {guide.purpose}\n"
            f"     Fields: {_format_credential_fields(provider)}\n"
        )
    sys.stderr.write("\n")
    while True:
        answer = _read_line("Choose a Provider number or key (q to quit): ")
        if answer is None or answer.casefold() in {"q", "quit"}:
            return None
        if answer.isdecimal():
            index = int(answer)
            if 1 <= index <= len(providers):
                return providers[index - 1]
        try:
            provider = ProviderName(answer.casefold())
        except ValueError:
            provider = None
        if provider in providers:
            return provider
        sys.stderr.write("Invalid Provider selection. Choose a listed number/key, or q.\n")


def _choose_credential_action(
    provider: ProviderName,
) -> Literal["set", "remove", "back", "quit"]:
    guide = _credential_guide(provider)
    sys.stderr.write(
        f"\nManage {guide.display_name} [{provider.value}]\n\n"
        "  1. Set or update credentials\n"
        "  2. Remove credentials\n"
        "  b. Back\n"
        "  q. Quit\n\n"
    )
    while True:
        answer = _read_line("Choose an action: ")
        if answer is None or answer.casefold() in {"q", "quit"}:
            return "quit"
        if answer.casefold() in {"b", "back"}:
            return "back"
        if answer.casefold() in {"1", "set", "update"}:
            return "set"
        if answer.casefold() in {"2", "remove", "delete"}:
            return "remove"
        sys.stderr.write("Invalid action. Choose 1, 2, b, or q.\n")


def _render_credential_setup_intro(provider: ProviderName) -> None:
    guide = _credential_guide(provider)
    sys.stderr.write(
        f"\nConfigure {guide.display_name} [{provider.value}]\n"
        f"  Purpose: {guide.purpose}\n"
        f"  Credential: {guide.credential_help}\n"
        f"  Get or manage it: {guide.application_url}\n"
        f"  Fields: {_format_credential_fields(provider)}\n"
        "  Input is hidden. Press Ctrl+C to cancel without writing.\n\n"
    )


def _render_credential_setup_next_steps(provider: ProviderName) -> None:
    guide = _credential_guide(provider)
    lines = [
        "Next steps:",
        f"  1. {guide.enablement_hint}",
        "  2. Run: sciretriever config status",
    ]
    if guide.probe_available:
        lines.append(f"  3. Optional live check: sciretriever config test {provider.value}")
    else:
        lines.append("  3. No standalone live credential probe is available for this Provider.")
    lines.append(
        "     A local configured status does not prove external authentication or article access."
    )
    sys.stderr.write("\n".join(lines) + "\n")


def _read_credential_value(
    provider: ProviderName,
    *,
    name: str,
    required: bool,
) -> str | None:
    suffix = "required" if required else "optional; blank to omit"
    label = _credential_field_prompt(provider, name)
    while True:
        try:
            value = getpass.getpass(f"{label} [{name}] ({suffix}): ").strip()
        except EOFError:
            return None
        if value or not required:
            return value
        sys.stderr.write("This credential is required; enter a value or press Ctrl+C to cancel.\n")


def _configure_provider_credentials(selected: ProviderName) -> None:
    provider = selected.value
    specs = credential_field_specs(selected)
    if not specs:
        sys.stderr.write(
            f"{provider} has no configurable secret credential fields. "
            "Use config.toml for non-secret settings and run "
            "sciretriever config status.\n"
        )
        return
    existed = credential_section_exists(selected, home=None)
    _render_credential_setup_intro(selected)
    if existed and not _confirm(f"Replace credentials for {provider}? [y/N] "):
        sys.stderr.write("No credentials were changed.\n")
        return
    values: dict[str, str] = {}
    for spec in specs:
        value = _read_credential_value(
            selected,
            name=spec.name,
            required=spec.required,
        )
        if value is None:
            sys.stderr.write("Credential input ended; no credentials were changed.\n")
            return
        if not value:
            continue
        values[spec.name] = value
    if not values:
        sys.stderr.write("No credential value was entered; no credentials were changed.\n")
        return
    set_credentials(provider, values, home=None)
    guide = _credential_guide(selected)
    status = "updated" if existed else "saved"
    sys.stderr.write(f"Credentials for {guide.display_name} [{provider}] were {status}.\n")
    _render_credential_setup_next_steps(selected)


def _remove_provider_credentials(selected: ProviderName) -> None:
    provider = selected.value
    guide = _credential_guide(selected)
    if not credential_section_exists(selected, home=None):
        sys.stderr.write(f"{guide.display_name} [{provider}] is not configured; nothing changed.\n")
        return
    if not _confirm(f"Remove credentials for {provider}? [y/N] "):
        sys.stderr.write("No credentials were changed.\n")
        return
    remove_credentials(selected, home=None)
    sys.stderr.write(f"Credentials for {guide.display_name} [{provider}] were removed.\n")


def _run_config_manager() -> int:
    theme = getattr(_CONFIG_MANAGER_CONTEXT, "theme", ConfigTheme.AUTO.value)
    if interactive_terminal():
        return _run_rich_config_manager(theme)
    return _run_plain_config_manager()


def _run_plain_config_manager() -> int:  # noqa: C901
    """Deterministic fallback for pipes, redirected input, and basic terminals."""

    while True:
        try:
            configuration, runtime = _configuration_summary()
            browser = browser_access_status(configuration)
            cloak = CloakRuntimeManager().status()
            _render_configuration_home(
                ConfigConsole(ConfigTheme.MONO),
                configuration,
                runtime,
                browser,
                cloak,
            )
        except (ConfigurationError, OSError, TypeError, ValueError):
            # A redirected/fixture-backed configuration center may not have
            # enough local metadata to render readiness.  Keep the ordinary
            # deterministic menu usable; actions still validate at commit.
            pass
        sys.stderr.write(
            "SciRetriever configuration center\n\n"
            "  L. LLM Analysis\n"
            "  M. MinerU Parser\n"
            "  A. Provider API and Browser Access\n"
            "  B. CloakBrowser runtime and Profile identity\n"
            "  P. Literature Provider credentials\n"
            "  Q. Quit\n\n"
        )
        answer = _read_line("Choose L, M, A, B, P, or Q: ")
        if answer is None or answer.casefold() in {"q", "quit"}:
            return 0
        selected = answer.casefold()
        if selected in {"l", "llm"}:
            _manage_llm_plain(ConfigConsole(ConfigTheme.MONO))
            continue
        if selected in {"m", "mineru"}:
            _manage_mineru_plain(ConfigConsole(ConfigTheme.MONO))
            continue
        if selected in {"a", "access"}:
            _manage_browser_access_plain(ConfigConsole(ConfigTheme.MONO))
            continue
        if selected in {"b", "browser", "cloak", "cloakbrowser"}:
            _manage_cloak_runtime_plain(ConfigConsole(ConfigTheme.MONO))
            continue
        if selected not in {"p", "providers"}:
            sys.stderr.write("Invalid selection. Choose L, M, A, B, P, or Q.\n")
            continue
        while True:
            provider = _choose_credential_provider()
            if provider is None:
                break
            action = _choose_credential_action(provider)
            if action == "quit":
                return 0
            if action == "back":
                continue
            if action == "set":
                _configure_provider_credentials(provider)
            else:
                _remove_provider_credentials(provider)
            sys.stderr.write("\n")


@dataclass(slots=True)
class _ConfigManagerContext:
    theme: str = ConfigTheme.AUTO.value


_CONFIG_MANAGER_CONTEXT = _ConfigManagerContext()


@dataclass(frozen=True, slots=True)
class _ProviderAccessOverview:
    api_routes: tuple[tuple[str, str, str], ...]
    browser_state: str
    browser_detail: str
    browser_action: str
    profile_presence: BrowserProfilePresence

    @property
    def home_state(self) -> str:
        states = tuple(state for _name, state, _action in self.api_routes)
        if "Action required" in states or self.browser_state == "Action required":
            return "Action required"
        if "Ready" in states or self.browser_state == "Ready":
            return "Ready"
        return "Review"

    @property
    def home_detail(self) -> str:
        return (
            f"{len(self.api_routes)} authorized APIs · "
            f"{CONTROLLED_BROWSER_PRODUCTION_ROUTE_COUNT} production Browser routes"
        )


def _authorized_api_route_state(
    status: ConfigurationCapabilityStatus,
) -> tuple[str, str]:
    if not status.production_available:
        return "Unavailable", "No verified primary-PDF API implementation is installed."
    if not status.enabled:
        return "Available", f'Enable "{status.provider.value}" in [sources.acquisition].'
    if status.local_ready:
        return "Ready", "Locally ready; article entitlement is checked only during acquisition."
    if status.credential.status in {CredentialStatus.MISSING, CredentialStatus.PARTIAL}:
        return "Action required", "Configure the required Provider API credential."
    return "Action required", "Review the Provider ordinary settings and access policy."


def _provider_access_overview(
    configuration: Configuration,
    *,
    credentials: CredentialLookup | None = None,
) -> _ProviderAccessOverview:
    bundle = load_credentials(home=None) if credentials is None else credentials
    status = configuration_status(configuration, credentials=bundle)
    acquisition = {
        item.provider: item
        for item in status.capabilities
        if item.capability is ProviderCapability.ACQUISITION
    }
    api_routes: list[tuple[str, str, str]] = []
    for key in sorted(AUTHORIZED_PDF_API_PROVIDER_KEYS):
        provider = ProviderName(key)
        route_state, action = _authorized_api_route_state(acquisition[provider])
        api_routes.append((_credential_guide(provider).display_name, route_state, action))

    access = configuration.access
    browser = browser_access_status(configuration, home=None)
    profile_status = browser.profile
    identity = access.browser_profile
    selection = (
        "No profile is selected."
        if identity is None
        else f"Profile {identity!r} is {profile_status.presence.value}."
    )
    if not CONTROLLED_BROWSER_PRODUCTION_AVAILABLE:
        browser_state = "Unavailable"
        browser_action = (
            "No production Browser route is registered; local session setup does not enable "
            "automatic Completion."
        )
    elif not access.browser_enabled:
        browser_state = "Disabled"
        browser_action = "Select and initialize a profile to enable Browser-last access."
    elif browser.automatic_acquisition_available:
        browser_state = "Ready"
        browser_action = (
            browser.action_required[0].action
            if browser.action_required
            else "No local action; article entitlement is checked during acquisition."
        )
    else:
        browser_state = "Action required"
        browser_action = (
            browser.action_required[0].action
            if browser.action_required
            else "Review the local Browser runtime and selected profile."
        )
    browser_detail = (
        f"{selection} Browser access is {'enabled' if access.browser_enabled else 'disabled'}; "
        "one fixed-profile CloakBrowser process is shared by Publisher lanes, with "
        "same-Publisher articles serialized. Interactive authentication is unsupported, and "
        "profile presence does not prove article entitlement."
    )
    return _ProviderAccessOverview(
        api_routes=tuple(api_routes),
        browser_state=browser_state,
        browser_detail=browser_detail,
        browser_action=browser_action,
        profile_presence=profile_status.presence,
    )


def _configuration_summary() -> tuple[Configuration, ConfigurationRuntimeStatus]:
    path = select_configuration_edit_path()
    configuration = load_editable_configuration(path)
    credentials = load_credentials(home=None)
    return configuration, configuration_runtime_status(
        configuration,
        credentials=credentials,
    )


def _provider_home_rows() -> list[tuple[str, str, str]]:
    credentials = load_credentials(home=None)
    return [
        (
            _credential_guide(provider).display_name,
            _credential_guide(provider).purpose,
            _credential_setup_state(provider, credentials),
        )
        for provider in configurable_credential_providers()
    ]


def _configuration_home_rows(
    configuration: Configuration,
    runtime: ConfigurationRuntimeStatus,
    browser: BrowserAccessStatus,
    cloak: object,
) -> dict[str, tuple[str, str]]:
    """Build the secret-free capability rows shared by both config UIs.

    The configuration center deliberately keeps these facts together on its
    home screen.  They are all local readiness observations: no profile bytes,
    seed, Cookie, endpoint credential, Browser launch, or Agent request is
    needed to render them.
    """

    agents = configuration.agents
    analysis = agents.analysis
    browser_role = agents.browser
    analysis_key_ready = not runtime.analysis.api_key_required or (
        runtime.analysis.api_key_configured is True
        and runtime.analysis.credential_origin_matches is True
    )
    agents_transport_ready = all(
        value is not None
        for value in (
            agents.provider,
            agents.protocol,
            agents.base_url,
            agents.authentication,
        )
    )
    analysis_role_ready = runtime.analysis.reference_configuration_complete and analysis_key_ready
    browser_role_ready = (
        agents_transport_ready
        and analysis_key_ready
        and browser_role.model is not None
        and browser_role.context_window_tokens is not None
        and browser_role.max_output_tokens is not None
        and browser_role.image_input
        and browser_role.tool_decision
    )

    def value_text(value: object) -> str:
        if value is None:
            return "not set"
        return str(getattr(value, "value", value))

    provider_detail = (
        " · ".join(
            value_text(value) for value in (agents.provider, agents.protocol) if value is not None
        )
        or "not configured"
    )
    analysis_detail = (
        f"model {value_text(analysis.model)} · "
        f"context {analysis.context_window_tokens or 'not set'} · "
        f"structured text {'yes' if analysis.structured_output else 'no'}"
    )
    browser_detail = (
        f"model {value_text(browser_role.model)} · "
        f"context {browser_role.context_window_tokens or 'not set'} · "
        f"image {'yes' if browser_role.image_input else 'no'} · "
        f"tool {'yes' if browser_role.tool_decision else 'no'}"
    )
    cloak_version = getattr(cloak, "version", None)
    cloak_presence = getattr(cloak, "presence", "missing")
    cloak_verified = bool(getattr(cloak, "verified", False))
    cloak_detail = (
        f"{cloak_presence} · version {cloak_version or 'not installed'} · "
        f"{'verified' if cloak_verified else 'not verified'} · explicit install only"
    )
    profile = browser.profile
    profile_identity = profile.selected or "not selected"
    profile_detail = f"{profile_identity} · presence {profile.presence.value} · opaque identity"
    enabled_detail = (
        "automatic Browser admission is enabled"
        if configuration.access.browser_enabled
        else "automatic Browser admission is disabled"
    )
    return {
        "agent_provider": (
            provider_detail,
            "Ready" if agents_transport_ready and analysis_key_ready else "Incomplete",
        ),
        "analysis_role": (analysis_detail, "Ready" if analysis_role_ready else "Incomplete"),
        "browser_role": (browser_detail, "Ready" if browser_role_ready else "Not configured"),
        "cloak_binary": (cloak_detail, "Ready" if cloak_verified else "Review"),
        "selected_profile": (profile_detail, profile.presence.value),
        "browser_enabled": (
            enabled_detail,
            "Enabled" if configuration.access.browser_enabled else "Disabled",
        ),
    }


def _render_configuration_home(
    console: ConfigConsole,
    configuration: Configuration,
    runtime: ConfigurationRuntimeStatus,
    browser: BrowserAccessStatus,
    cloak: object,
) -> None:
    """Render one identical local readiness home for Rich and plain UIs."""

    agents = configuration.agents
    parser = configuration.parsing
    parser_ready = runtime.parsing.configuration_complete and (
        not runtime.parsing.bearer_token_required
        or (
            runtime.parsing.bearer_token_configured is True
            and runtime.parsing.credential_origin_matches is True
        )
    )
    access_overview = _provider_access_overview(configuration)
    rows = _configuration_home_rows(configuration, runtime, browser, cloak)
    console.home(
        llm_state=("Ready" if rows["analysis_role"][1] == "Ready" else "Incomplete"),
        llm_detail=(
            "Not configured"
            if agents.protocol is None
            else f"{agents.protocol.value} · {agents.analysis.model or 'model missing'}"
        ),
        mineru_state="Ready" if parser_ready else "Incomplete",
        mineru_detail=(
            "MinerU 3.4.4 · protocol 2 · vlm-engine"
            if parser.base_url is not None
            else "Not configured"
        ),
        providers=_provider_home_rows(),
        access_state=access_overview.home_state,
        access_detail=access_overview.home_detail,
        agent_provider=rows["agent_provider"],
        analysis_role=rows["analysis_role"],
        browser_role=rows["browser_role"],
        cloak_binary=rows["cloak_binary"],
        selected_profile=rows["selected_profile"],
        browser_enabled=rows["browser_enabled"],
    )


def _run_rich_config_manager(theme: str) -> int:
    active_theme = theme
    while True:
        console = ConfigConsole(active_theme)
        configuration, runtime = _configuration_summary()
        config_path = select_configuration_edit_path()
        browser = browser_access_status(configuration)
        cloak = CloakRuntimeManager().status()
        console.header(
            config_path=os.fspath(config_path),
            credentials_path=os.fspath(credential_path()),
        )
        _render_configuration_home(console, configuration, runtime, browser, cloak)
        options: list[tuple[object, str]] = [
            ("llm", "LLM Analysis"),
            ("mineru", "MinerU Parser"),
            ("access", "Provider APIs and Browser Access"),
            ("browser", "CloakBrowser runtime and Profile identity"),
            ("theme", "Change theme"),
        ]
        options.extend(
            (provider, f"Provider · {_credential_guide(provider).display_name}")
            for provider in configurable_credential_providers()
        )
        options.append(("quit", "Quit"))
        selected = TerminalChoice[object](
            message="Open a configuration area",
            options=options,
            theme=active_theme,
            shortcuts={
                "a": "access",
                "b": "browser",
                "l": "llm",
                "m": "mineru",
                "t": "theme",
                "q": "quit",
            },
        ).prompt()
        if selected == "quit":
            return 0
        if selected == "theme":
            active_theme = _choose_theme(active_theme)
        elif selected == "llm":
            _manage_llm_rich(console)
        elif selected == "mineru":
            _manage_mineru_rich(console)
        elif selected == "access":
            _manage_browser_access_rich(console)
        elif selected == "browser":
            _manage_cloak_runtime_rich(console)
        elif isinstance(selected, ProviderName):
            _manage_provider_rich(selected, active_theme)


def _choose_theme(current: str) -> str:
    return TerminalChoice[str](
        message="Choose a terminal theme",
        options=[
            (ConfigTheme.AUTO.value, "Auto"),
            (ConfigTheme.DARK.value, "Dark"),
            (ConfigTheme.LIGHT.value, "Light"),
            (ConfigTheme.MONO.value, "Monochrome"),
        ],
        default=current,
        theme=current,
    ).prompt()


def _manage_provider_rich(provider: ProviderName, theme: str) -> None:
    while True:
        action = TerminalChoice[str](
            message=f"Manage {_credential_guide(provider).display_name}",
            options=[
                ("set", "Set or update credentials"),
                ("remove", "Remove credentials"),
                ("back", "Back"),
            ],
            theme=theme,
        ).prompt()
        if action == "back":
            return
        if action == "set":
            _configure_provider_credentials(provider)
        else:
            _remove_provider_credentials(provider)


def _render_provider_access(
    console: ConfigConsole,
) -> tuple[Configuration, _ProviderAccessOverview]:
    path = select_configuration_edit_path()
    configuration = load_editable_configuration(path)
    credentials = load_credentials(home=None)
    overview = _provider_access_overview(configuration, credentials=credentials)
    console.section(
        "Provider API and Browser Access",
        "API credentials and Browser sessions are independent readiness layers.",
    )
    console.access(
        api_routes=overview.api_routes,
        browser_state=overview.browser_state,
        browser_detail=overview.browser_detail,
        browser_action=overview.browser_action,
    )
    return configuration, overview


def _plain_browser_access_action() -> str | None:
    sys.stderr.write(
        "\nManage Browser Access\n\n"
        "  1. Select or initialize a Browser profile\n"
        "  2. Remove the selected local Browser session\n"
        "  3. Disable Browser access and keep the local session\n"
        "  4. Set cross-Publisher Browser concurrency\n"
        "  b. Back\n\n"
    )
    answer = _read_line("Choose an action: ")
    if answer is None or answer.casefold() in {"b", "back", "q", "quit"}:
        return None
    return {
        "1": "select",
        "select": "select",
        "initialize": "select",
        "2": "remove",
        "remove": "remove",
        "delete": "remove",
        "3": "disable",
        "disable": "disable",
        "4": "concurrency",
        "concurrency": "concurrency",
    }.get(answer.casefold(), "invalid")


def _select_browser_access_profile(console: ConfigConsole) -> None:
    path = select_configuration_edit_path()
    before = load_editable_configuration(path)
    default = before.access.browser_profile or "institutional-access"
    console.section(
        "Select Browser profile",
        "The identity is stored in config.toml; sensitive session data stays in a fixed "
        "owner-only directory.",
    )
    answer = _read_line(f"Profile identity [{default}] (b to cancel): ")
    if answer is None or answer.casefold() in {"b", "back", "q", "quit"}:
        console.message("No Browser access setting was changed.", kind="muted")
        return
    identity = answer or default
    try:
        candidate = AccessConfig(
            browser_enabled=True,
            browser_profile=identity,
            browser_max_concurrency=before.access.browser_max_concurrency,
            browser_policy_overrides=before.access.browser_policy_overrides,
        )
    except (ValidationError, TypeError, ValueError):
        console.message(
            "Profile identity is invalid; use a short opaque name, not a path, URL, UUID, "
            "account, token, or Cookie label.",
            kind="warning",
        )
        return
    assert candidate.browser_profile is not None
    presence = browser_profile_status(candidate.browser_profile, home=None).presence
    if presence is BrowserProfilePresence.ATTENTION:
        console.message(
            "The selected profile requires operator inspection; ownership, permissions, or "
            "filesystem type is unsafe. Nothing was changed.",
            kind="warning",
        )
        return
    changes = configuration_diff(
        before,
        before.model_copy(update={"access": candidate}),
        sections=("access",),
    )
    if changes:
        console.changes(changes)
    elif presence is BrowserProfilePresence.CONFIGURED:
        console.message("This Browser profile is already selected and initialized.", kind="muted")
        return
    console.message(
        "This directory may contain login cookies and local storage. Keep it private; a local "
        "profile does not prove authentication or article entitlement.",
        kind="warning",
    )
    if not CONTROLLED_BROWSER_PRODUCTION_AVAILABLE:
        console.message(
            "No production Browser route is currently registered. Preparing this profile will "
            "not enable automatic Completion yet.",
            kind="warning",
        )
    if not _confirm("Initialize this profile and save Browser access settings? [y/N] "):
        console.message("No Browser access setting or profile was changed.", kind="muted")
        return
    configure_browser_access_profile(path, candidate, home=None)
    console.message("Browser access settings and the local profile were saved.", kind="success")


def _remove_browser_access_session(console: ConfigConsole) -> None:
    configuration = load_editable_configuration(select_configuration_edit_path())
    identity = configuration.access.browser_profile
    if identity is None:
        console.message("No Browser profile is selected; nothing was removed.", kind="muted")
        return
    presence = browser_profile_status(identity, home=None).presence
    if presence is BrowserProfilePresence.MISSING:
        console.message(
            "The selected Browser session is already missing; nothing changed.", kind="muted"
        )
        return
    if presence is BrowserProfilePresence.ATTENTION:
        console.message(
            "The selected profile requires manual filesystem inspection and was not removed.",
            kind="warning",
        )
        return
    console.message(
        "Removal permanently deletes this profile's local Browser session, including any login "
        "state. It does not remove Provider API keys or change config.toml.",
        kind="warning",
    )
    if not _confirm("Permanently remove this local Browser session? [y/N] "):
        console.message("No local Browser session was removed.", kind="muted")
        return
    removed = remove_browser_profile(identity, home=None)
    if not removed:
        console.message("The selected Browser session was already missing.", kind="muted")
        return
    console.message(
        "The local Browser session was removed and cannot be recovered. The selected profile "
        "identity remains in config.toml and now requires initialization.",
        kind="success",
    )


def _disable_browser_access(console: ConfigConsole) -> None:
    path = select_configuration_edit_path()
    before = load_editable_configuration(path)
    if not before.access.browser_enabled:
        console.message("Browser access is already disabled; nothing changed.", kind="muted")
        return
    candidate = AccessConfig(
        browser_enabled=False,
        browser_profile=before.access.browser_profile,
        browser_max_concurrency=before.access.browser_max_concurrency,
        browser_policy_overrides=before.access.browser_policy_overrides,
    )
    after = before.model_copy(update={"access": candidate})
    console.changes(configuration_diff(before, after, sections=("access",)))
    console.message(
        "Disabling stops automatic Browser admission but keeps the private local session for a "
        "later explicit re-enable.",
        kind="warning",
    )
    if not _confirm("Disable Browser access and keep the local session? [y/N] "):
        console.message("Browser access was not changed.", kind="muted")
        return
    update_configuration_sections(path, access=candidate)
    console.message("Browser access was disabled; the local session was retained.", kind="success")


def _set_browser_max_concurrency(console: ConfigConsole) -> None:
    path = select_configuration_edit_path()
    before = load_editable_configuration(path)
    raw_value = _read_line(
        "Maximum concurrently active Publisher Browser lanes "
        f"[current {before.access.browser_max_concurrency}, integer > 1]: "
    )
    if raw_value is None or not raw_value.strip():
        console.message("Browser concurrency was not changed.", kind="muted")
        return
    try:
        value = int(raw_value.strip())
    except ValueError:
        console.message("Browser concurrency must be an integer greater than 1.", kind="warning")
        return
    if value <= 1:
        console.message("Browser concurrency must be an integer greater than 1.", kind="warning")
        return
    if value == before.access.browser_max_concurrency:
        console.message("Browser concurrency is already set to that value.", kind="muted")
        return
    candidate = AccessConfig(
        browser_enabled=before.access.browser_enabled,
        browser_profile=before.access.browser_profile,
        browser_max_concurrency=value,
        browser_policy_overrides=before.access.browser_policy_overrides,
    )
    after = before.model_copy(update={"access": candidate})
    console.changes(configuration_diff(before, after, sections=("access",)))
    if not _confirm(f"Set the cross-Publisher Browser concurrency cap to {value}? [y/N] "):
        console.message("Browser concurrency was not changed.", kind="muted")
        return
    update_configuration_sections(path, access=candidate)
    console.message(
        f"Cross-Publisher Browser concurrency was set to {value}.",
        kind="success",
    )


def _cloak_runtime_status_text(status: object) -> str:
    """Render only the stable, path/secret-free Cloak status fields."""

    presence = getattr(status, "presence", "missing")
    version = getattr(status, "version", None) or "not installed"
    reason = getattr(status, "reason", None)
    verified = "verified" if getattr(status, "verified", False) else "not verified"
    suffix = f" · reason: {reason}" if reason else ""
    return f"{presence} · version {version} · {verified}{suffix}"


def _show_cloak_runtime(console: ConfigConsole) -> None:
    status = CloakRuntimeManager().status()
    credentials = load_credentials(home=None)
    console.section(
        "CloakBrowser runtime",
        "Pinned free v146 is explicit-install only; status never downloads or launches it.",
    )
    console.message(f"Runtime: {_cloak_runtime_status_text(status)}")
    console.message(
        "Wrapper: cloakbrowser 0.5.8 · Playwright API: 1.55.0 · binary is not bundled in the wheel."
    )
    console.message(
        "Optional Pro key: "
        + (
            "saved"
            if credentials.has_core_service(CoreCredentialService.CLOAKBROWSER)
            else "not set"
        )
        + " (reserved; the pinned free installer does not use it).",
        kind="muted",
    )


def _confirm_cloak_network_action(action: str) -> bool:
    """Require two explicit confirmations before any vendor network action."""

    if not _confirm(
        f"{action} downloads the pinned CloakBrowser binary from the vendor and "
        "verifies its signature/digest. Continue? [y/N] "
    ):
        return False
    return _confirm(
        "Confirm this explicit network and disk operation now "
        "(nothing else will be changed)? [y/N] "
    )


def _cloak_install_or_update(action: Literal["install", "update"], console: ConfigConsole) -> None:
    manager = CloakRuntimeManager()
    current = manager.status()
    if action == "install" and current.ready:
        console.message(
            "The pinned CloakBrowser binary is already installed and verified.",
            kind="muted",
        )
        return
    if action == "update" and current.ready and current.version == CLOAKBROWSER_BROWSER_VERSION:
        console.message(
            "The pinned CloakBrowser binary is already current and verified.",
            kind="muted",
        )
        return
    if not _confirm_cloak_network_action(action.title()):
        console.message("No CloakBrowser files were changed.", kind="muted")
        return
    try:
        result = (
            manager.install(CLOAKBROWSER_BROWSER_VERSION)
            if action == "install"
            else manager.update(CLOAKBROWSER_BROWSER_VERSION)
        )
    except ConfigurationError:
        console.message(
            "CloakBrowser installation was not completed; the current verified "
            "runtime was retained.",
            kind="warning",
        )
        return
    console.message(
        f"CloakBrowser {result.version or CLOAKBROWSER_BROWSER_VERSION} is installed and verified.",
        kind="success",
    )


def _cloak_rollback(console: ConfigConsole) -> None:
    manager = CloakRuntimeManager()
    current = manager.status()
    if not current.rollback_available:
        console.message(
            "No verified previous CloakBrowser version is available to roll back.",
            kind="muted",
        )
        return
    if not _confirm_cloak_network_action("Rollback"):
        console.message("No CloakBrowser files were changed.", kind="muted")
        return
    try:
        result = manager.rollback()
    except ConfigurationError:
        console.message(
            "CloakBrowser rollback was not completed; the current runtime was retained.",
            kind="warning",
        )
        return
    console.message(f"CloakBrowser was rolled back to {result.version}.", kind="success")


def _set_cloak_license(console: ConfigConsole) -> None:
    console.message(
        "The pinned free v146 installer explicitly rejects Pro credentials. The value is "
        "stored only as an origin-bound, optional future entitlement and is never used by "
        "normal Completion or status.",
        kind="warning",
    )
    if not _confirm("Save an optional CloakBrowser Pro key for future use? [y/N] "):
        console.message("No CloakBrowser credential was changed.", kind="muted")
        return
    try:
        secret = getpass.getpass("CloakBrowser Pro key (input hidden): ").strip()
    except EOFError:
        console.message("No CloakBrowser credential was changed.", kind="muted")
        return
    if not secret:
        console.message("An optional key was not entered; no credential was changed.", kind="muted")
        return
    try:
        set_core_credentials(
            CoreCredentialService.CLOAKBROWSER,
            secret=secret,
            origin=CLOAKBROWSER_ORIGIN,
            home=None,
        )
    except ConfigurationError:
        console.message("The optional CloakBrowser credential could not be saved.", kind="warning")
        return
    console.message(
        "Optional CloakBrowser Pro key saved (reserved; not used by v146).",
        kind="success",
    )


def _remove_cloak_license(console: ConfigConsole) -> None:
    credentials = load_credentials(home=None)
    if not credentials.has_core_service(CoreCredentialService.CLOAKBROWSER):
        console.message(
            "No optional CloakBrowser Pro key is configured; nothing changed.",
            kind="muted",
        )
        return
    if not _confirm("Remove the optional CloakBrowser Pro key? [y/N] "):
        console.message("No CloakBrowser credential was changed.", kind="muted")
        return
    try:
        remove_core_credentials(CoreCredentialService.CLOAKBROWSER, home=None)
    except ConfigurationError:
        console.message(
            "The optional CloakBrowser credential could not be removed.",
            kind="warning",
        )
        return
    console.message("Optional CloakBrowser Pro key removed.", kind="success")


def _manage_cloak_runtime_plain(console: ConfigConsole) -> None:
    while True:
        _show_cloak_runtime(console)
        sys.stderr.write(
            "\n  1. Install pinned free v146\n"
            "  2. Update to pinned free v146\n"
            "  3. Roll back to the verified previous version\n"
            "  4. Save or replace optional Pro key (reserved)\n"
            "  5. Remove optional Pro key\n"
            "  b. Back\n\n"
        )
        answer = _read_line("Choose a CloakBrowser action: ")
        if answer is None or answer.casefold() in {"b", "back", "q", "quit"}:
            return
        if answer in {"1", "install"}:
            _cloak_install_or_update("install", console)
        elif answer in {"2", "update"}:
            _cloak_install_or_update("update", console)
        elif answer in {"3", "rollback"}:
            _cloak_rollback(console)
        elif answer in {"4", "license", "pro"}:
            _set_cloak_license(console)
        elif answer in {"5", "remove"}:
            _remove_cloak_license(console)
        else:
            console.message("Invalid action; choose 1–5 or b.", kind="warning")


def _manage_cloak_runtime_rich(console: ConfigConsole) -> None:
    while True:
        _show_cloak_runtime(console)
        action = TerminalChoice[str](
            message="Manage CloakBrowser runtime",
            options=[
                ("install", "Install pinned free v146"),
                ("update", "Update to pinned free v146"),
                ("rollback", "Roll back verified previous version"),
                ("license", "Save/replace optional Pro key (reserved)"),
                ("remove-license", "Remove optional Pro key"),
                ("back", "Back"),
            ],
            theme=console.palette.name,
        ).prompt()
        if action == "back":
            return
        if action in {"install", "update"}:
            _cloak_install_or_update(cast(Literal["install", "update"], action), console)
        elif action == "rollback":
            _cloak_rollback(console)
        elif action == "license":
            _set_cloak_license(console)
        elif action == "remove-license":
            _remove_cloak_license(console)


def _perform_browser_access_action(action: str, console: ConfigConsole) -> None:
    if action == "select":
        _select_browser_access_profile(console)
    elif action == "remove":
        _remove_browser_access_session(console)
    elif action == "disable":
        _disable_browser_access(console)
    elif action == "concurrency":
        _set_browser_max_concurrency(console)
    else:
        console.message("Invalid action. Choose 1, 2, 3, 4, or b.", kind="warning")


def _manage_browser_access_plain(console: ConfigConsole) -> None:
    while True:
        _render_provider_access(console)
        action = _plain_browser_access_action()
        if action is None:
            return
        _perform_browser_access_action(action, console)


def _manage_browser_access_rich(console: ConfigConsole) -> None:
    while True:
        _render_provider_access(console)
        action = TerminalChoice[str](
            message="Manage Provider API and Browser Access",
            options=[
                ("select", "Select or initialize a Browser profile"),
                ("remove", "Remove the selected local Browser session"),
                ("disable", "Disable Browser access and keep the session"),
                ("concurrency", "Set cross-Publisher Browser concurrency"),
                ("back", "Back"),
            ],
            theme=console.palette.name,
        ).prompt()
        if action == "back":
            return
        _perform_browser_access_action(action, console)


def _configuration_action(service: Literal["LLM", "MinerU"]) -> str | None:
    menu = (
        f"\nManage {service}\n\n"
        "  1. Set up or edit\n"
        "  2. Test configuration\n"
        "  3. Reset configuration and credential\n"
    )
    if service == "LLM":
        menu += "  4. Configure Browser role capability\n"
    sys.stderr.write(menu + "  b. Back\n\n")
    answer = _read_line("Choose an action: ")
    if answer is None or answer.casefold() in {"b", "back", "q", "quit"}:
        return None
    return {
        "1": "edit",
        "edit": "edit",
        "set": "edit",
        "2": "test",
        "test": "test",
        "3": "reset",
        "reset": "reset",
        "remove": "reset",
        "4": "browser-role",
        "browser": "browser-role",
        "browser-role": "browser-role",
    }.get(answer.casefold(), "invalid")


def _run_core_test(service: Literal["llm", "mineru"]) -> None:
    if service == "llm" and not _confirm(
        "The LLM probe sends one minimal request and may consume a small amount of quota. "
        "Continue? [y/N] "
    ):
        sys.stderr.write("LLM probe cancelled.\n")
        return
    configuration = load_selected_configuration(None)
    session = build_production_configuration_probe_session(configuration)
    try:
        result = session.run_agents() if service == "llm" else session.run_mineru()
    finally:
        session.close()
    sys.stderr.write(f"{service.upper()} configuration test: {result.outcome.value}.\n")
    failure = result.failure_code
    if failure is not None:
        sys.stderr.write(f"  Failure: {failure}\n")


def _reset_core_configuration(service: Literal["llm", "mineru"], console: ConfigConsole) -> None:
    label = "LLM Analysis" if service == "llm" else "MinerU Parser"
    path = select_configuration_edit_path()
    before = load_editable_configuration(path)
    ordinary_configured = (
        before.agents != AgentsConfig() or before.analysis != AnalysisConfig()
        if service == "llm"
        else before.parsing != ParsingConfig()
    )
    secret_service = "agents" if service == "llm" else service
    secret_configured = core_credential_section_exists(secret_service)
    if not ordinary_configured and not secret_configured:
        console.message(f"{label} is not configured; nothing changed.", kind="muted")
        return
    if not _confirm(f"Reset {label} settings and remove its credential? [y/N] "):
        console.message("No configuration was changed.", kind="muted")
        return
    if service == "llm":
        update_core_service_configuration(
            path,
            "agents",
            agents=AgentsConfig(),
            secret=None,
            origin=None,
        )
        update_configuration_sections(path, analysis=AnalysisConfig())
    else:
        update_core_service_configuration(
            path,
            "mineru",
            parsing=ParsingConfig(),
            secret=None,
            origin=None,
        )
    console.message(f"{label} configuration was reset.", kind="success")


def _manage_llm_plain(console: ConfigConsole) -> None:
    while True:
        action = _configuration_action("LLM")
        if action is None:
            return
        if action == "edit":
            _configure_llm(console)
        elif action == "test":
            _run_core_test("llm")
        elif action == "reset":
            _reset_core_configuration("llm", console)
        elif action == "browser-role":
            _configure_browser_role(console)
        else:
            console.message("Invalid action. Choose 1, 2, 3, 4, or b.", kind="warning")


def _manage_mineru_plain(console: ConfigConsole) -> None:
    while True:
        action = _configuration_action("MinerU")
        if action is None:
            return
        if action == "edit":
            _configure_mineru(console)
        elif action == "test":
            _run_core_test("mineru")
        elif action == "reset":
            _reset_core_configuration("mineru", console)
        else:
            console.message("Invalid action. Choose 1, 2, 3, or b.", kind="warning")


def _manage_llm_rich(console: ConfigConsole) -> None:
    action = TerminalChoice[str](
        message="Manage LLM Analysis",
        options=[
            ("edit", "Set up or edit"),
            ("test", "Test configuration"),
            ("reset", "Reset settings and credential"),
            ("browser-role", "Configure Browser role capability"),
            ("back", "Back"),
        ],
        theme=console.palette.name,
    ).prompt()
    if action == "edit":
        _configure_llm(console)
    elif action == "test":
        _run_core_test("llm")
    elif action == "reset":
        _reset_core_configuration("llm", console)
    elif action == "browser-role":
        _configure_browser_role(console)


def _manage_mineru_rich(console: ConfigConsole) -> None:
    action = TerminalChoice[str](
        message="Manage MinerU Parser",
        options=[
            ("edit", "Set up or edit"),
            ("test", "Test configuration"),
            ("reset", "Reset settings and credential"),
            ("back", "Back"),
        ],
        theme=console.palette.name,
    ).prompt()
    if action == "edit":
        _configure_mineru(console)
    elif action == "test":
        _run_core_test("mineru")
    elif action == "reset":
        _reset_core_configuration("mineru", console)


def _select_value(
    prompt: str,
    values: list[tuple[str, str]],
    *,
    console: ConfigConsole,
) -> str | None:
    if interactive_terminal():
        return TerminalChoice[str | None](
            message=prompt,
            options=[*values, (None, "Cancel")],
            theme=console.palette.name,
        ).prompt()
    console.message(prompt, kind="muted")
    for index, (_value, label) in enumerate(values, start=1):
        sys.stderr.write(f"  {index}. {label}\n")
    answer = _read_line("Choose a number (b to cancel): ")
    if answer is None or answer.casefold() in {"b", "back", "q", "quit"}:
        return None
    if answer.isdecimal() and 1 <= int(answer) <= len(values):
        return values[int(answer) - 1][0]
    console.message("Invalid selection; no configuration was changed.", kind="warning")
    return None


def _ask_text(label: str, *, default: str | None = None) -> str | None:
    suffix = f" [{default}]" if default else ""
    value = _read_line(f"{label}{suffix}: ")
    if value is None:
        return None
    return default if not value and default is not None else value


def _ask_positive_integer(label: str, *, default: int | None = None) -> int | None:
    while True:
        raw = _ask_text(label, default=None if default is None else str(default))
        if raw is None:
            return None
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
        sys.stderr.write("Enter a positive integer, or press Ctrl+C to cancel.\n")


def _confirm_changes(
    console: ConfigConsole,
    before: Configuration,
    after: Configuration,
    *,
    section: Literal["agents", "analysis", "parsing"],
) -> bool:
    changes = configuration_diff(before, after, sections=(section,))
    if not changes:
        console.message("No ordinary configuration changes are needed.", kind="muted")
        return True
    console.changes(changes)
    return _confirm("Save these ordinary configuration changes? [y/N] ")


def _agents_candidate(
    *,
    provider: AgentProvider,
    service_name: str | None,
    protocol: AgentProtocol,
    base_url: str,
    model: str,
    context_window_tokens: int,
    authentication: AgentAuthentication,
    budgets: dict[str, int],
    browser: AgentRoleConfig,
) -> AgentsConfig:
    return AgentsConfig(
        provider=provider,
        service_name=service_name,
        protocol=protocol,
        base_url=base_url,
        authentication=authentication,
        analysis=AgentRoleConfig(
            model=model,
            context_window_tokens=context_window_tokens,
            max_output_tokens=budgets.get("content_max_output_tokens", 1),
            structured_output=True,
        ),
        browser=browser,
    )


def _custom_analysis_budgets(console: ConfigConsole) -> dict[str, int] | None:
    values: dict[str, int] = {}
    labels = {
        "metadata_max_output_tokens": "Metadata output reserve (tokens)",
        "content_max_output_tokens": "Content output reserve (tokens)",
        "reference_max_output_tokens": "Reference output reserve (tokens)",
        "max_input_bytes": "Maximum Analysis input (bytes)",
        "max_chunk_bytes": "Maximum content chunk (bytes)",
        "max_chunk_count": "Maximum content chunks",
        "max_total_llm_requests": "Maximum LLM requests per operation",
        "max_total_output_tokens": "Maximum total output tokens per operation",
    }
    for name, default in _DEFAULT_ANALYSIS_BUDGETS.items():
        value = _ask_positive_integer(labels[name], default=default)
        if value is None:
            console.message("Budget entry was cancelled; no configuration was changed.")
            return None
        values[name] = value
    return values


def _choose_analysis_budgets(console: ConfigConsole) -> dict[str, int] | None:
    preset = _select_value(
        "Choose an Analysis budget profile",
        [
            ("conservative", "Conservative · smaller requests and output reserves"),
            ("balanced", "Balanced · recommended default"),
            ("large", "Large context · larger chunks and request budget"),
            ("custom", "Custom · enter every limit"),
        ],
        console=console,
    )
    if preset is None:
        return None
    if preset == "custom":
        return _custom_analysis_budgets(console)
    return dict(_ANALYSIS_BUDGET_PRESETS[preset])


def _configure_llm(console: ConfigConsole) -> None:  # noqa: C901, PLR0915
    console.section(
        "LLM Analysis",
        "Explicit protocol, verified context window, and origin-bound credentials.",
    )
    preset = _select_value(
        "Choose a service preset",
        [
            ("openai", "OpenAI official · Responses API"),
            ("anthropic", "Anthropic official · Messages API"),
            ("custom", "Custom / compatible service"),
        ],
        console=console,
    )
    if preset is None:
        return
    if preset == "openai":
        provider = AgentProvider.OPENAI
        service_name = None
        protocol = AgentProtocol.OPENAI_RESPONSES
        base_url = "https://api.openai.com/v1"
        authentication = AgentAuthentication.API_KEY
    elif preset == "anthropic":
        provider = AgentProvider.ANTHROPIC
        service_name = None
        protocol = AgentProtocol.ANTHROPIC_MESSAGES
        base_url = "https://api.anthropic.com/v1"
        authentication = AgentAuthentication.API_KEY
    else:
        provider = AgentProvider.CUSTOM
        service_name = _ask_text("Safe service identity (letters/numbers/dash)")
        protocol_value = _select_value(
            "Choose the exact compatible protocol",
            [
                (AgentProtocol.OPENAI_RESPONSES.value, "OpenAI Responses"),
                (
                    AgentProtocol.OPENAI_CHAT_COMPLETIONS.value,
                    "OpenAI Chat Completions",
                ),
                (AgentProtocol.ANTHROPIC_MESSAGES.value, "Anthropic Messages"),
            ],
            console=console,
        )
        base_url = _ask_text("Service Base URL")
        if service_name is None or protocol_value is None or base_url is None:
            return
        protocol = AgentProtocol(protocol_value)
        authentication_value = _select_value(
            "Choose authentication",
            [
                (AgentAuthentication.API_KEY.value, "API key"),
                (
                    AgentAuthentication.NONE.value,
                    "No authentication · custom HTTP loopback only",
                ),
            ],
            console=console,
        )
        if authentication_value is None:
            return
        authentication = AgentAuthentication(authentication_value)
    model = _ask_text("Model / deployment name")
    context = _ask_positive_integer("Verified context window (tokens)", default=1_000_000)
    budgets = _choose_analysis_budgets(console)
    if model is None or context is None or budgets is None:
        return
    path = select_configuration_edit_path()
    before = load_editable_configuration(path)
    try:
        candidate = _agents_candidate(
            provider=provider,
            service_name=service_name,
            protocol=protocol,
            base_url=base_url,
            model=model,
            context_window_tokens=context,
            authentication=authentication,
            budgets=budgets,
            browser=before.agents.browser,
        )
    except (ValidationError, ValueError, TypeError):
        console.message(
            "The LLM settings are invalid or conflict with their budgets.", kind="warning"
        )
        return
    analysis_candidate = AnalysisConfig(**budgets)
    after = before.model_copy(update={"agents": candidate, "analysis": analysis_candidate})
    if not _confirm_changes(console, before, after, section="agents"):
        console.message("No configuration was changed.", kind="muted")
        return
    origin = (
        configuration_service_origin(base_url)
        if authentication is AgentAuthentication.API_KEY
        else None
    )
    secret: str | None = None
    if authentication is AgentAuthentication.API_KEY:
        try:
            secret = getpass.getpass("API key (input hidden): ").strip()
        except EOFError:
            return
        if not secret:
            console.message("An API key is required; no configuration was changed.", kind="warning")
            return
    update_core_service_configuration(
        path,
        "agents",
        agents=candidate,
        secret=secret,
        origin=origin,
    )
    update_configuration_sections(path, analysis=analysis_candidate)
    console.message("LLM Analysis configuration was saved.", kind="success")


def _configure_browser_role(console: ConfigConsole) -> None:  # noqa: C901
    """Configure the shared Agents Browser role without touching its secret."""

    path = select_configuration_edit_path()
    before = load_editable_configuration(path)
    agents = before.agents
    if any(
        value is None
        for value in (agents.provider, agents.protocol, agents.base_url, agents.authentication)
    ):
        console.message(
            "Configure the shared Agent provider and Analysis role first; the Browser role "
            "reuses that endpoint and credential.",
            kind="warning",
        )
        return
    console.section(
        "Browser role",
        "This role reuses the shared Agents provider; only image/tool capability is added.",
    )
    default_model = agents.browser.model or agents.analysis.model
    default_context = agents.browser.context_window_tokens or agents.analysis.context_window_tokens
    model = _ask_text("Browser model / deployment name", default=default_model)
    context = _ask_positive_integer(
        "Browser context window (tokens)",
        default=default_context or 32_768,
    )
    max_output = _ask_positive_integer(
        "Browser output limit (tokens)",
        default=agents.browser.max_output_tokens or 2_048,
    )
    image_enabled = _select_value(
        "Enable image input",
        [("yes", "Yes · allow bounded screenshots"), ("no", "No")],
        console=console,
    )
    tool_enabled = _select_value(
        "Enable closed tool decisions",
        [("yes", "Yes · Click/Scroll/Wait/Stop only"), ("no", "No")],
        console=console,
    )
    if None in (model, context, max_output, image_enabled, tool_enabled):
        console.message(
            "Browser role configuration was cancelled; no changes were made.", kind="muted"
        )
        return
    image_input = image_enabled == "yes"
    tool_decision = tool_enabled == "yes"
    if not image_input or not tool_decision:
        console.message(
            "The Browser Agent requires both image input and closed tool decisions; "
            "leave both enabled or cancel.",
            kind="warning",
        )
        return
    image_count = _ask_positive_integer(
        "Maximum images per turn",
        default=agents.browser.image_count or 1,
    )
    image_bytes = _ask_positive_integer(
        "Maximum total image bytes per turn",
        default=agents.browser.image_bytes or 4_194_304,
    )
    turns = _ask_positive_integer("Maximum Browser Agent turns", default=agents.browser.turns or 4)
    if image_count is None or image_bytes is None or turns is None:
        console.message(
            "Browser role configuration was cancelled; no changes were made.", kind="muted"
        )
        return
    try:
        role = AgentRoleConfig(
            model=model,
            context_window_tokens=context,
            max_output_tokens=max_output,
            structured_output=False,
            image_input=True,
            tool_decision=True,
            image_media_types=("image/png", "image/jpeg", "image/webp"),
            image_count=image_count,
            image_bytes=image_bytes,
            turns=turns,
        )
        candidate = agents.model_copy(update={"browser": role})
    except (ValidationError, ValueError, TypeError):
        console.message("Browser role settings are invalid; no changes were made.", kind="warning")
        return
    after = before.model_copy(update={"agents": candidate})
    if not _confirm_changes(console, before, after, section="agents"):
        console.message("No configuration was changed.", kind="muted")
        return
    update_configuration_sections(path, agents=candidate)
    console.message("Browser role configuration was saved.", kind="success")


def _configure_mineru(console: ConfigConsole) -> None:  # noqa: C901
    console.section(
        "MinerU Parser",
        "MinerU 3.4.4 · protocol 2 · vlm-engine · archive backend vlm · parse auto",
    )
    mode_value = _select_value(
        "Choose a connection mode",
        [("loopback", "Loopback · PDF stays on this machine"), ("remote", "Remote service")],
        console=console,
    )
    if mode_value is None:
        return
    mode = ParserConnectionMode(mode_value)
    default_url = "http://127.0.0.1:8000" if mode is ParserConnectionMode.LOOPBACK else None
    base_url = _ask_text("MinerU service Base URL", default=default_url)
    model_identity = _ask_text("Model / deployment identity", default="mineru-3.4.4-vlm")
    if base_url is None or model_identity is None:
        return
    authorized = False
    token: str | None = None
    origin: str | None = None
    if mode is ParserConnectionMode.REMOTE:
        console.message(
            "Remote mode uploads source PDFs outside this machine. Confirm only for an "
            "operator-approved service.",
            kind="warning",
        )
        authorized = _confirm("Authorize remote PDF upload to this exact service? [y/N] ")
        if not authorized:
            console.message(
                "Remote upload was not authorized; no configuration was changed.", kind="warning"
            )
            return
    try:
        candidate = ParsingConfig(
            base_url=base_url,
            connection_mode=mode,
            model_identity=model_identity,
            remote_upload_authorized=authorized,
        )
    except (ValidationError, ValueError, TypeError):
        console.message("The MinerU endpoint and connection mode are inconsistent.", kind="warning")
        return
    path = select_configuration_edit_path()
    before = load_editable_configuration(path)
    after = before.model_copy(update={"parsing": candidate})
    if not _confirm_changes(console, before, after, section="parsing"):
        console.message("No configuration was changed.", kind="muted")
        return
    if mode is ParserConnectionMode.REMOTE:
        try:
            token = getpass.getpass("MinerU bearer token (input hidden): ").strip()
        except EOFError:
            return
        if not token:
            console.message(
                "A remote bearer token is required; no configuration was changed.", kind="warning"
            )
            return
        origin = configuration_service_origin(base_url)
    update_core_service_configuration(
        path,
        "mineru",
        parsing=candidate,
        secret=token,
        origin=origin,
    )
    console.message("MinerU Parser configuration was saved.", kind="success")


def _ordinary_provider_settings(configuration: Configuration, provider: str) -> dict[str, object]:
    if provider == "web-of-science":
        settings = configuration.sources.metadata.web_of_science
        return (
            {}
            if settings is None
            else {
                "product": settings.product.value,
                "database": settings.database,
                "edition": settings.edition,
            }
        )
    if provider == "crossref":
        settings = configuration.sources.metadata.crossref
        return {} if settings is None else {"mode": settings.mode.value, "mailto": settings.mailto}
    if provider == "unpaywall":
        settings = configuration.sources.acquisition.unpaywall
        return {} if settings is None else {"contact_email": settings.contact_email}
    return {}


def _missing_ordinary_fields(
    configuration: Configuration,
    status: ConfigurationCapabilityStatus,
) -> tuple[str, ...]:
    if status.ordinary_parameters_ready:
        return ()
    if status.provider.value == "web-of-science":
        return ("product", "database")
    if status.provider.value == "crossref":
        return ("mode",)
    if status.provider.value == "unpaywall":
        return ("contact_email",)
    del configuration
    return ("provider-specific settings",)


def _provider_payload(
    configuration: Configuration,
    status: ConfigurationCapabilityStatus,
) -> dict[str, object]:
    return {
        "provider": status.provider.value,
        "enabled": status.enabled,
        "production_available": status.production_available,
        "local_ready": status.local_ready,
        "failure_code": status.failure_code,
        "ordinary_settings": _ordinary_provider_settings(
            configuration,
            status.provider.value,
        ),
        "missing_ordinary_fields": _missing_ordinary_fields(configuration, status),
        "credentials": {
            "status": status.credential.status.value,
            "fields": [
                {
                    "name": field.name,
                    "required": field.required,
                    "configured": field.present,
                }
                for field in status.credential.fields
            ],
        },
        "access_policy_ready": status.access_policy_ready,
        "probe_available": status.probe_available,
    }


def _acquisition_payload(
    configuration: Configuration,
    status: ConfigurationCapabilityStatus,
) -> dict[str, object]:
    payload = _provider_payload(configuration, status)
    provider = status.provider.value
    public_service = _PUBLIC_ACQUISITION_SERVICES.get(provider)
    public_service_payload: dict[str, object] | None = None
    if public_service is not None:
        kind, label = public_service
        missing = cast(tuple[str, ...], payload["missing_ordinary_fields"])
        if provider == "sci-hub":
            local_ready = status.failure_code != "missing-configured-resolver"
            failure_code = None if local_ready else "operator-resolver-required"
        else:
            local_ready = not missing
            failure_code = None if local_ready else "missing-ordinary-parameter"
        public_service_payload = {
            "kind": kind,
            "label": label,
            "production_available": True,
            "local_ready": local_ready,
            "failure_code": failure_code,
            "ordinary_settings": payload["ordinary_settings"],
            "missing_ordinary_fields": missing,
        }
    payload["public_source"] = {
        # The global direct Source consumes already-saved AssetHints regardless
        # of which Provider originally observed them.  Do not mislabel that
        # shared mechanism as twelve independent Provider services.
        "saved_asset_hints_supported": True,
        "provider_service": public_service_payload,
    }
    payload["authorized_api"] = {
        "available": provider in AUTHORIZED_PDF_API_PROVIDER_KEYS,
        "unsupported": provider in UNSUPPORTED_AUTHORIZED_PDF_API_PROVIDER_KEYS,
        "detail": _UNSUPPORTED_AUTHORIZED_API_DETAILS.get(provider),
        "credentials": payload["credentials"],
    }
    return payload


def _config_status_payload(
    configuration: Configuration,
    capabilities: tuple[ConfigurationCapabilityStatus, ...],
    runtime: ConfigurationRuntimeStatus,
    browser: BrowserAccessStatus,
    credentials: CredentialLookup | None = None,
) -> dict[str, object]:
    parser = configuration.parsing
    analysis = configuration.analysis
    parser_secret_ready = not runtime.parsing.bearer_token_required or (
        runtime.parsing.bearer_token_configured is True
        and runtime.parsing.credential_origin_matches is True
    )
    parser_ready = runtime.parsing.configuration_complete and parser_secret_ready
    analysis_key_ready = not runtime.analysis.api_key_required or (
        runtime.analysis.api_key_configured is True
        and runtime.analysis.credential_origin_matches is True
    )
    agents_transport_ready = all(
        value is not None
        for value in (
            configuration.agents.provider,
            configuration.agents.protocol,
            configuration.agents.base_url,
            configuration.agents.authentication,
        )
    )
    browser_role_capability_ready = (
        configuration.agents.browser.model is not None
        and configuration.agents.browser.context_window_tokens is not None
        and configuration.agents.browser.max_output_tokens is not None
        and configuration.agents.browser.image_input
        and configuration.agents.browser.tool_decision
    )
    return {
        "storage": {
            "configuration_complete": runtime.storage_configuration_complete,
            "catalog_path": configuration.paths.catalog_path,
            "artifact_root": configuration.paths.artifact_root,
            "missing_fields": runtime.storage_missing_fields,
        },
        "providers": {
            "credentials_file": "~/.sciretriever/credentials.toml",
            "metadata_scan_limit": configuration.discovery.metadata_scan_limit,
            "metadata": [
                _provider_payload(configuration, item)
                for item in capabilities
                if item.capability is ProviderCapability.METADATA
            ],
            "acquisition": [
                _acquisition_payload(configuration, item)
                for item in capabilities
                if item.capability is ProviderCapability.ACQUISITION
            ],
            "controlled_browser": {
                **browser.model_dump(mode="json"),
                # The compatibility value above describes when Completion
                # evaluates entitlement.  This explicit local-status marker
                # prevents callers from mistaking it for an assessment made
                # by ``config status`` itself.
                "article_entitlement_assessment": "not-evaluated",
                "article_entitlement_evaluated": False,
                "cloakbrowser_license": {
                    "configured": bool(
                        credentials is not None
                        and credentials.has_core_service("cloakbrowser") is True
                    ),
                    "status": "reserved-not-used-by-pinned-free-binary",
                },
            },
        },
        "parsing": {
            "locally_ready": parser_ready,
            "configuration_complete": runtime.parsing.configuration_complete,
            "base_url": parser.base_url,
            "connection_mode": (
                None if parser.connection_mode is None else parser.connection_mode.value
            ),
            "model_identity": parser.model_identity,
            "remote_upload_authorized": parser.remote_upload_authorized,
            "implementation": {
                "release": "3.4.4",
                "api_protocol": 2,
                "profile": "vlm-engine",
                "archive_backend": "vlm",
                "parse_method": "auto",
            },
            "missing_fields": runtime.parsing.missing_fields,
            "bearer_token": {
                "source": "credentials.toml" if runtime.parsing.bearer_token_required else None,
                "required": runtime.parsing.bearer_token_required,
                "configured": runtime.parsing.bearer_token_configured,
                "origin_matches": runtime.parsing.credential_origin_matches,
            },
        },
        "agents": {
            "reference_locally_ready": (
                runtime.analysis.reference_configuration_complete and analysis_key_ready
            ),
            "content_locally_ready": (
                runtime.analysis.content_configuration_complete and analysis_key_ready
            ),
            "provider": (
                None
                if configuration.agents.provider is None
                else configuration.agents.provider.value
            ),
            "service_name": configuration.agents.service_name,
            "protocol": (
                None
                if configuration.agents.protocol is None
                else configuration.agents.protocol.value
            ),
            "base_url": configuration.agents.base_url,
            "analysis_model": configuration.agents.analysis.model,
            "browser_model": configuration.agents.browser.model,
            "context_window_tokens": configuration.agents.analysis.context_window_tokens,
            "analysis_role": {
                "model": configuration.agents.analysis.model,
                "context_window_tokens": configuration.agents.analysis.context_window_tokens,
                "max_output_tokens": configuration.agents.analysis.max_output_tokens,
                "structured_output": configuration.agents.analysis.structured_output,
                "image_input": configuration.agents.analysis.image_input,
                "tool_decision": configuration.agents.analysis.tool_decision,
                "locally_ready": (
                    runtime.analysis.reference_configuration_complete and analysis_key_ready
                ),
                "required_capability": "structured-text",
            },
            "browser_role": {
                "model": configuration.agents.browser.model,
                "context_window_tokens": configuration.agents.browser.context_window_tokens,
                "max_output_tokens": configuration.agents.browser.max_output_tokens,
                "structured_output": configuration.agents.browser.structured_output,
                "image_input": configuration.agents.browser.image_input,
                "tool_decision": configuration.agents.browser.tool_decision,
                "image_media_types": list(configuration.agents.browser.image_media_types),
                "image_count": configuration.agents.browser.image_count,
                "image_bytes": configuration.agents.browser.image_bytes,
                "turns": configuration.agents.browser.turns,
                "locally_ready": (
                    agents_transport_ready and analysis_key_ready and browser_role_capability_ready
                ),
                "required_capabilities": ["image-input", "tool-decision"],
            },
            "authentication": (
                None
                if configuration.agents.authentication is None
                else configuration.agents.authentication.value
            ),
            "api_key": {
                "source": "credentials.toml" if runtime.analysis.api_key_required else None,
                "required": runtime.analysis.api_key_required,
                "configured": runtime.analysis.api_key_configured,
                "origin_matches": runtime.analysis.credential_origin_matches,
            },
        },
        "analysis": {
            "reference_configuration_complete": runtime.analysis.reference_configuration_complete,
            "content_configuration_complete": runtime.analysis.content_configuration_complete,
            "reference_missing_fields": runtime.analysis.reference_missing_fields,
            "content_missing_fields": runtime.analysis.content_missing_fields,
            "limits": {
                "metadata_max_output_tokens": analysis.metadata_max_output_tokens,
                "content_max_output_tokens": analysis.content_max_output_tokens,
                "reference_max_output_tokens": analysis.reference_max_output_tokens,
                "max_input_bytes": analysis.max_input_bytes,
                "max_chunk_bytes": analysis.max_chunk_bytes,
                "max_chunk_count": analysis.max_chunk_count,
                "max_total_llm_requests": analysis.max_total_llm_requests,
                "max_total_output_tokens": analysis.max_total_output_tokens,
            },
        },
        "execution": {"max_concurrency": configuration.execution.max_concurrency},
        "library": {"max_input_bytes": configuration.library.max_input_bytes},
    }


def _run_config_status(arguments: argparse.Namespace) -> int:
    configuration = load_selected_configuration(None)
    credentials = load_credentials(home=None)
    result = configuration_status(configuration, credentials=credentials)
    runtime = configuration_runtime_status(configuration, credentials=credentials)
    browser = browser_access_status(
        configuration,
        probe_supported_access_keys=PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS,
    )
    payload = _config_status_payload(
        configuration,
        result.capabilities,
        runtime,
        browser,
        credentials,
    )
    if arguments.json:
        _write_result(payload, as_json=True)
    else:
        ConfigStatusPresenter(arguments.theme).status(payload)
    return 0


def _run_config_test(arguments: argparse.Namespace) -> int:
    configuration = load_selected_configuration(None)
    session = build_production_configuration_probe_session(configuration)
    try:
        return _run_config_test_session(arguments, session)
    finally:
        session.close()


def _run_config_test_session(  # noqa: C901
    arguments: argparse.Namespace,
    session: ProductionConfigurationProbeSession,
) -> int:
    if arguments.browser_access_key is not None:
        if not arguments.json and not _confirm(
            "This starts one controlled headed Browser session and visits exactly one "
            "approved minimal Publisher target under the shared provider scheduler. It checks "
            "runtime and target reachability, and does not assess institution-IP or "
            "article-specific entitlement. Continue? [y/N] "
        ):
            sys.stderr.write("Browser probe cancelled.\n")
            return 0
        result = session.run_browser(arguments.browser_access_key)
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.provider == "llm":
        if not arguments.json and not _confirm(
            "The LLM probe sends one minimal external request and may consume a small amount "
            "of quota. Continue? [y/N] "
        ):
            sys.stderr.write("LLM probe cancelled.\n")
            return 0
        result: object = session.run_agents()
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.provider == "browser-agent":
        if not arguments.json and not _confirm(
            "The Browser Agent probe sends one minimal external request with a fixed synthetic "
            "image and one closed generic tool. It sends no Literature, PDF, page content, or "
            "Browser screenshot, and may consume a small amount of quota. It does not start a "
            "Browser or visit a Publisher. Continue? [y/N] "
        ):
            sys.stderr.write("Browser Agent probe cancelled.\n")
            return 0
        result = session.run_browser_agent()
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.provider == "mineru":
        result = session.run_mineru()
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.test_all:
        if not arguments.json and not _confirm(
            "This runs enabled Provider probes, one minimal LLM request that may consume a "
            "small amount of quota, and a MinerU health check that uploads no PDF. "
            "It also attempts the optional Browser Agent probe with one fixed synthetic image "
            "and one closed generic tool; it sends no Literature, PDF, page content, or Browser "
            "screenshot. "
            "Continue? [y/N] "
        ):
            sys.stderr.write("Configuration probes cancelled.\n")
            return 0
        provider_result = session.run(test_all=True)
        llm_result = session.run_agents()
        browser_agent_result = session.run_browser_agent()
        mineru_result = session.run_mineru()
        result = {
            "providers": provider_result.model_dump(mode="json"),
            "llm": llm_result.model_dump(mode="json"),
            "mineru": mineru_result.model_dump(mode="json"),
        }
        if isinstance(browser_agent_result, CoreConfigurationProbeResult):
            result["browser-agent"] = browser_agent_result.model_dump(mode="json")
        passed = provider_result.passed and all(
            item.outcome is ProbeOutcome.PASSED for item in (llm_result, mineru_result)
        )
        if isinstance(browser_agent_result, CoreConfigurationProbeResult):
            # Browser Agent is an optional role.  A local skip means it was
            # not configured and must not make required Provider/Analysis/
            # MinerU capabilities fail; an executed failure remains visible
            # and does fail the aggregate probe.
            passed = passed and (
                browser_agent_result.outcome is ProbeOutcome.PASSED
                or (
                    browser_agent_result.outcome is ProbeOutcome.SKIPPED
                    and not browser_agent_result.local_ready
                )
            )
    else:
        result = session.run(provider=arguments.provider)
        passed = result.passed
    if arguments.json:
        _write_result(result, as_json=True)
    else:
        if isinstance(
            result,
            (
                ConfigurationProbeSummary,
                CoreConfigurationProbeResult,
                BrowserConfigurationProbeResult,
            ),
        ):
            payload = result.model_dump(mode="json")
        else:
            payload = cast(dict[str, object], result)
        ConfigStatusPresenter(arguments.theme).probes(payload)
    return 0 if passed else 3


def _run_config(arguments: argparse.Namespace) -> int:
    configure_logging(level=logging.DEBUG if arguments.debug else logging.INFO)
    if arguments.action is None:
        _CONFIG_MANAGER_CONTEXT.theme = arguments.theme
        return _run_config_manager()
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
    except (KeyboardInterrupt, EOFError):
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
