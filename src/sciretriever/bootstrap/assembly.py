"""Production object-graph assembly for SciRetriever.

Construction is deliberately side-effect free with respect to external
services: no DNS, HTTP, Browser navigation, MinerU health check, LLM request,
or Provider probe is performed here.  The production factory validates every
selected ordinary/secret dependency before delegating to the lower-level
explicit-dependency object-graph builder.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import cast

from sciretriever.acquisition.browser_control import BrowserControllerKind
from sciretriever.agents.api import AgentRole, AgentRuntime
from sciretriever.bootstrap.browser import (
    PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS,
    _new_acquisition_execution_runtime,
)
from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.graphs import (
    ApplicationObjectGraph,
    BibliographyExchangeObjectGraph,
    BootstrapExternalDependencies,
    CitationDiscoveryObjectGraph,
    DatabaseCompletionObjectGraph,
    LocalLibraryObjectGraph,
    ManualPdfObjectGraph,
    ProductionEntryScope,
    TopicDiscoveryObjectGraph,
    _BibliographyExchangeEntry,
    _CitationDiscoveryEntry,
    _DatabaseCompletionEntry,
    _ManualPdfEntry,
    _TopicDiscoveryEntry,
)
from sciretriever.bootstrap.services import (
    _analysis_limits,
    _browser_agent_dependency,
    _build_agents_runtime,
    _build_metadata_components,
    _new_observation_id,
    _new_provenance_id,
    _new_shared_network,
    _production_dependencies,
    _raise_production_assembly_error,
    _require_analysis_configuration,
    _require_browser_agent_configuration,
    _require_parser_configuration,
    _require_paths_configuration,
    _require_reference_analysis_configuration,
    _required_production_configuration,
    _UtcClock,
    _UuidLiteratureIds,
)
from sciretriever.bootstrap.storage import (
    _build_local_library_graph,
    _build_scoped_storage,
    _build_storage_foundation,
    _CatalogWriteAdmission,
    _finish_scoped_graph,
    _project_logger_state,
    _release_fresh_storage_ownership,
    _restore_project_logger,
    _rollback_fresh_storage,
)
from sciretriever.configuration import (
    ConfigurationError,
    CredentialLookup,
    acquisition_source_providers,
    configurable_credential_providers,
    load_credentials,
    load_runtime_secrets,
    metadata_source_providers,
)
from sciretriever.model.configuration import (
    BrowserController,
    Configuration,
    ParserConnectionMode,
)
from sciretriever.parsing.ports import ParserPort


def _validate_low_level_inputs(
    configuration: Configuration,
    catalog_path: str | Path,
    artifact_root: str | Path,
    external_dependencies: BootstrapExternalDependencies,
) -> tuple[Path, Path]:
    if not isinstance(configuration, Configuration):
        raise BootstrapError("configuration-invalid")
    if not isinstance(external_dependencies, BootstrapExternalDependencies):
        raise BootstrapError("configuration-invalid")
    try:
        catalog = Path(catalog_path)
        artifacts = Path(artifact_root)
    except TypeError:
        raise BootstrapError("paths-not-ready") from None
    return catalog, artifacts


def build_object_graph(  # noqa: C901, PLR0915
    configuration: Configuration,
    *,
    catalog_path: str | Path,
    artifact_root: str | Path,
    external_dependencies: BootstrapExternalDependencies,
    credentials: CredentialLookup | None = None,
    credentials_home: str | Path | None = None,
    browser_profile_home: str | Path | None = None,
    configure_process_logging: bool = False,
    logging_level: int = logging.INFO,
) -> ApplicationObjectGraph:
    """Build a complete graph from explicit non-fake dependencies."""

    catalog_path_value, artifact_root_value = _validate_low_level_inputs(
        configuration,
        catalog_path,
        artifact_root,
        external_dependencies,
    )
    from sciretriever.acquisition.api import AcquisitionApi
    from sciretriever.acquisition.manual import ManualPdfAdmissionService
    from sciretriever.acquisition.publication import (
        PrimaryPdfPublisher,
        ValidatedPrimaryPdfPublisher,
    )
    from sciretriever.acquisition.registry import (
        AcquisitionAssemblyDependencies,
        build_acquisition_registry,
        production_web_access_profile_resolver,
    )
    from sciretriever.acquisition.tiered_service import TieredAcquisitionService
    from sciretriever.analysis.api import AnalysisApi
    from sciretriever.analysis.content import ContentAnalysisLimits
    from sciretriever.analysis.references import ReferenceLookupStage
    from sciretriever.analysis.service import AnalysisService
    from sciretriever.entry.api import EntryApi
    from sciretriever.entry.citations import CitationDiscoveryOperation
    from sciretriever.entry.completion import DatabaseCompletionOperation
    from sciretriever.entry.discovery import TopicDiscoveryOperation
    from sciretriever.entry.exchange import BibliographyCodecs, BibliographyOperations
    from sciretriever.entry.library import LibraryOperations
    from sciretriever.entry.manual import ManualPdfOperation
    from sciretriever.literature.api import LiteratureApi
    from sciretriever.literature.service import LiteratureService
    from sciretriever.metadata.api import MetadataApi
    from sciretriever.metadata.publication import MetadataPublication
    from sciretriever.metadata.registry import (
        MetadataAssemblyDependencies,
        build_metadata_registry,
    )
    from sciretriever.metadata.service import MetadataService
    from sciretriever.network.admission import AccessCoordinator
    from sciretriever.network.http import HttpClient, SecureHttpTransport, SystemResolver
    from sciretriever.parsing.api import ParsingApi
    from sciretriever.parsing.service import ParsingService
    from sciretriever.storage.analysis_artifacts import AnalysisArtifactPublisher
    from sciretriever.storage.completion import CompletionInputBuilder
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler
    from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
    from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging
    from sciretriever.storage.sqlite.acquisition_publication import SqliteAcquisitionPublication
    from sciretriever.storage.sqlite.analysis_artifacts import AnalysisArtifactReader
    from sciretriever.storage.sqlite.analysis_inputs import SqliteAnalysisCurrentInputs
    from sciretriever.storage.sqlite.artifact_references import SqliteArtifactReferenceStore
    from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
    from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
    from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
    from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
    from sciretriever.storage.sqlite.literature_reader import LiteratureReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
    from sciretriever.storage.sqlite.metadata_publication import (
        SqliteProviderRelationObservationPublication,
    )
    from sciretriever.storage.sqlite.no_usable_content_cleanup import (
        SqliteNoUsableContentCleanup,
    )
    from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

    # One process-local coordinator and one HTTP client are shared by every
    # external adapter in this graph.
    coordinator = AccessCoordinator()
    resolver = SystemResolver()
    http_client = HttpClient(
        resolver=resolver,
        transport=SecureHttpTransport(),
        coordinator=coordinator,
    )
    clock = _UtcClock()
    acquisition_runtime = _new_acquisition_execution_runtime(
        configuration,
        access_coordinator=coordinator,
        resolver=resolver,
        browser_profile_home=(
            credentials_home if browser_profile_home is None else browser_profile_home
        ),
    )
    browser_client = acquisition_runtime.browser_client

    # Every ordinary setting, credential, Provider registry and injected
    # Parser/LLM dependency is validated before either persistent root is
    # created.  A broken later Provider must therefore leave no half graph.
    if credentials is not None and credentials_home is not None:
        raise BootstrapError("configuration-invalid")
    credential_snapshot = (
        load_credentials(home=credentials_home) if credentials is None else credentials
    )
    if not isinstance(credential_snapshot, CredentialLookup):
        raise BootstrapError("configuration-invalid")
    # Construct the single shared Agents runtime before Acquisition. Analysis
    # is required by this complete graph; the Browser binding is required only
    # when the frozen controller choice is Agent.
    agent = external_dependencies.agents_factory(http_client, coordinator)
    if not isinstance(agent, AgentRuntime):
        raise BootstrapError("analysis-not-ready")
    browser_controller = BrowserControllerKind(configuration.access.browser_controller.value)
    browser_agent = (
        _browser_agent_dependency(agent)
        if browser_controller is BrowserControllerKind.AGENT
        else None
    )
    metadata_registry = build_metadata_registry(
        configuration,
        credential_snapshot,
        MetadataAssemblyDependencies(
            http_client=http_client,
            access_coordinator=coordinator,
            observation_id_factory=_new_observation_id,
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
        ),
    )
    acquisition_registry = build_acquisition_registry(
        configuration,
        AcquisitionAssemblyDependencies(
            http_client=http_client,
            access_coordinator=coordinator,
            web_access_profile_resolver=production_web_access_profile_resolver(),
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
            browser_session_broker=acquisition_runtime.browser_session_broker,
            credentials=credential_snapshot,
            configured_sci_hub_resolver=external_dependencies.configured_sci_hub_resolver,  # type: ignore[arg-type]
            browser_client=browser_client,
            browser_controller=browser_controller,
            browser_agent=browser_agent,
        ),
    )
    parser = external_dependencies.parser_factory(http_client, coordinator)
    if not isinstance(parser, ParserPort):
        raise BootstrapError("parser-not-ready")

    # Persistent construction begins only after the complete preflight above.
    # Bind the artifact root first: if catalog creation then fails, no catalog
    # is left paired with a missing artifact root.  StorageRoot itself uses a
    # secure create-or-bind operation, so an existing root is never removed.
    try:
        foundation = _build_storage_foundation(
            catalog_path_value,
            artifact_root_value,
        )
        engine = foundation.engine
        storage_root = foundation.storage_root
        artifact_store = foundation.artifact_store
        verified_reader = foundation.verified_reader
    except BaseException:
        raise
    try:
        atomic_user_output = AtomicOutput(max_bytes=536_870_912)
        discovery_repository = SqliteDiscoveryRepository(engine)
        entry_reader = SqliteEntryReader(engine, verified_reader)
        artifact_reference_store = SqliteArtifactReferenceStore(engine)
        artifact_reconciler = ArtifactStoreReconciler(storage_root, artifact_reference_store)
        write_admission = _CatalogWriteAdmission(engine.catalog_path, artifact_reconciler)

        literature_writer = LiteratureWriter(engine)
        literature_service = LiteratureService(
            read_port=LiteraturePreconditionReader(engine, verified_reader),
            identity_port=literature_writer,
            content_port=SqliteContentPublication(engine, artifact_store, verified_reader),
            reference_port=literature_writer,
            maintenance_port=literature_writer,
            id_factory=_UuidLiteratureIds(),
            query_port=LiteratureReader(engine, verified_reader),
            artifact_read_port=LiteratureArtifactReader(engine, verified_reader),
        )
        literature_api = LiteratureApi(literature_service)

        metadata_api = MetadataApi(
            MetadataService(
                topic_search_ports=metadata_registry.topic_search_ports,
                lookup_ports=metadata_registry.lookup_ports,
                reference_query_ports=metadata_registry.reference_query_ports,
            )
        )
        metadata_publication = MetadataPublication(
            literature_api,
            SqliteProviderRelationObservationPublication(literature_writer),
        )

        acquisition_publication = SqliteAcquisitionPublication(
            engine,
            artifact_store,
            verified_reader,
        )
        pdf_validation_staging = SystemPdfValidationStaging()
        validated_pdf_publisher = ValidatedPrimaryPdfPublisher(acquisition_publication)
        primary_pdf_publisher = PrimaryPdfPublisher(
            validated_pdf_publisher,
            staging=pdf_validation_staging,
        )
        acquisition_api = AcquisitionApi(
            TieredAcquisitionService(
                route_registry=acquisition_registry.route_registry,
                planner=acquisition_registry.planner,
                publication_port=primary_pdf_publisher,
                exhaustion_port=acquisition_publication,
                exhaustion_clear_port=acquisition_publication,
                cohort_executor=acquisition_runtime.cohort_executor,
            )
        )
        manual_admission = ManualPdfAdmissionService(
            publication_port=validated_pdf_publisher,
            staging=pdf_validation_staging,
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
        )

        parsing_api = ParsingApi(
            ParsingService(
                parser=parser,
                result_store=SqliteParserResultPublication(engine, artifact_store, verified_reader),
            )
        )

        limits = ContentAnalysisLimits(
            max_input_bytes=external_dependencies.analysis_max_input_bytes,
            max_chunk_bytes=external_dependencies.analysis_max_chunk_bytes,
            max_chunk_count=external_dependencies.analysis_max_chunk_count,
            max_total_llm_requests=external_dependencies.analysis_max_total_llm_requests,
            max_total_output_tokens=external_dependencies.analysis_max_total_output_tokens,
        )
        analysis_service = AnalysisService(
            runtime=agent,
            artifact_reader=AnalysisArtifactReader(engine, verified_reader),
            current_inputs=SqliteAnalysisCurrentInputs(engine),
            artifact_publisher=AnalysisArtifactPublisher(artifact_store),
            metadata_max_output_tokens=external_dependencies.metadata_max_output_tokens,
            content_max_output_tokens=external_dependencies.content_max_output_tokens,
            limits=limits,
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
        )
        analysis_api = AnalysisApi(
            content_service=analysis_service,
            reference_lookup_stage=ReferenceLookupStage(
                runtime=agent,
                max_output_tokens=external_dependencies.reference_max_output_tokens,
            ),
        )

        provider_precedence = tuple(
            registration.provider_name for registration in metadata_registry.registrations
        )
        completion_inputs = CompletionInputBuilder(engine, verified_reader)
        topic_operation = TopicDiscoveryOperation(
            metadata=metadata_api,
            metadata_publication=metadata_publication,
            repository=discovery_repository,
            publication=discovery_repository,
            clock=clock,
            write_admission=write_admission,
            recovery=discovery_repository,
            provider_precedence=provider_precedence,
        )
        citation_operation = CitationDiscoveryOperation(
            metadata=metadata_api,
            relation_publication=metadata_publication,
            literature=literature_api,
            analysis=analysis_api,
            candidate_reader=entry_reader,
            run_repository=discovery_repository,
            discovery_publication=discovery_repository,
            write_admission=write_admission,
            recovery=discovery_repository,
            clock=clock,
            provider_precedence=provider_precedence,
        )
        completion_operation = DatabaseCompletionOperation(
            selector_reader=entry_reader,
            current_facts_reader=entry_reader,
            write_admission=write_admission,
            recovery=discovery_repository,
            acquisition=acquisition_api,
            acquisition_requests=completion_inputs,
            parsing=parsing_api,
            parser_requests=completion_inputs,
            analysis=analysis_api,
            analysis_inputs=completion_inputs,
            literature=literature_api,
            cleanup=SqliteNoUsableContentCleanup(engine),
            max_concurrency=configuration.execution.max_concurrency,
        )
        manual_operation = ManualPdfOperation(
            current_facts_reader=entry_reader,
            manual_admission=manual_admission,
            write_admission=write_admission,
            recovery=discovery_repository,
        )
        library_operations = LibraryOperations(
            literature=literature_api,
            output=atomic_user_output,
        )
        bibliography_operations = BibliographyOperations(
            literature=literature_api,
            codec=BibliographyCodecs(max_input_bytes=configuration.library.max_input_bytes),
            output=atomic_user_output,
            selector_reader=entry_reader,
            clock=clock,
            write_admission=write_admission,
            recovery=discovery_repository,
            observation_id_factory=_new_observation_id,
            provenance_id_factory=_new_provenance_id,
            provider_precedence=provider_precedence,
        )
        entry_api = EntryApi(
            discover_topic_operation=topic_operation,
            discover_citations_operation=citation_operation,
            complete_database_operation=completion_operation,
            admit_manual_pdf_operation=manual_operation,
            search_literature_operation=library_operations.search_literature,
            get_literature_detail_operation=library_operations.get_literature_detail,
            list_literature_references_operation=library_operations.list_literature_references,
            get_reference_detail_operation=library_operations.get_reference_detail,
            open_artifact_operation=library_operations.open_artifact,
            export_artifact_operation=library_operations.export_artifact,
            import_bibliography_operation=bibliography_operations.import_bibliography,
            export_bibliography_operation=bibliography_operations.export_bibliography,
        )
        graph = ApplicationObjectGraph(
            configuration=configuration,
            catalog_engine=engine,
            storage_root=storage_root,
            artifact_store=artifact_store,
            verified_reader=verified_reader,
            atomic_user_output=atomic_user_output,
            write_admission=write_admission,
            discovery_repository=discovery_repository,
            entry_reader=entry_reader,
            artifact_reference_store=artifact_reference_store,
            artifact_reconciler=artifact_reconciler,
            access_coordinator=coordinator,
            http_client=http_client,
            browser_client=browser_client,
            metadata_registry=metadata_registry,
            acquisition_registry=acquisition_registry,
            acquisition_runtime=acquisition_runtime,
            topic_provider_limits=metadata_registry.topic_limits,
            citation_provider_limits=metadata_registry.citation_limits,
            metadata_api=metadata_api,
            literature_api=literature_api,
            acquisition_api=acquisition_api,
            parsing_api=parsing_api,
            analysis_api=analysis_api,
            entry_api=entry_api,
        )
    except BaseException:
        _rollback_fresh_storage(foundation.ownership)
        raise
    try:
        if configure_process_logging:
            logger_state = _project_logger_state()
            try:
                from sciretriever.logging.api import configure_logging

                configure_logging(level=logging_level)
            except BaseException:
                _restore_project_logger(logger_state)
                raise
    except BaseException as error:
        _rollback_fresh_storage(foundation.ownership)
        if isinstance(error, Exception):
            raise BootstrapError("assembly-failed") from None
        raise
    _release_fresh_storage_ownership(foundation.ownership)
    return graph


def _build_scoped_production_graph(  # noqa: C901, PLR0915
    configuration: Configuration,
    *,
    scope: ProductionEntryScope,
    credentials_home: str | Path | None,
    configure_process_logging: bool,
    logging_level: int,
) -> (
    TopicDiscoveryObjectGraph
    | CitationDiscoveryObjectGraph
    | DatabaseCompletionObjectGraph
    | ManualPdfObjectGraph
    | BibliographyExchangeObjectGraph
):
    from sciretriever.acquisition.api import AcquisitionApi
    from sciretriever.acquisition.manual import ManualPdfAdmissionService
    from sciretriever.acquisition.publication import (
        PrimaryPdfPublisher,
        ValidatedPrimaryPdfPublisher,
    )
    from sciretriever.acquisition.registry import (
        AcquisitionAssemblyDependencies,
        AcquisitionRegistry,
        build_acquisition_registry,
        production_web_access_profile_resolver,
    )
    from sciretriever.acquisition.tiered_service import TieredAcquisitionService
    from sciretriever.analysis.api import AnalysisApi
    from sciretriever.analysis.references import ReferenceLookupStage
    from sciretriever.analysis.service import AnalysisService
    from sciretriever.entry.citations import CitationDiscoveryOperation
    from sciretriever.entry.completion import (
        AssetDatabaseCompletionOperation,
        DatabaseCompletionOperation,
    )
    from sciretriever.entry.discovery import TopicDiscoveryOperation
    from sciretriever.entry.exchange import BibliographyCodecs, BibliographyOperations
    from sciretriever.entry.manual import ManualPdfOperation
    from sciretriever.metadata.publication import MetadataPublication
    from sciretriever.parsing.api import ParsingApi
    from sciretriever.parsing.service import ParsingService
    from sciretriever.storage.analysis_artifacts import AnalysisArtifactPublisher
    from sciretriever.storage.completion import CompletionInputBuilder
    from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging
    from sciretriever.storage.sqlite.acquisition_publication import SqliteAcquisitionPublication
    from sciretriever.storage.sqlite.analysis_artifacts import AnalysisArtifactReader
    from sciretriever.storage.sqlite.analysis_inputs import SqliteAnalysisCurrentInputs
    from sciretriever.storage.sqlite.metadata_publication import (
        SqliteProviderRelationObservationPublication,
    )
    from sciretriever.storage.sqlite.no_usable_content_cleanup import SqliteNoUsableContentCleanup
    from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

    needs_metadata = scope in {
        ProductionEntryScope.TOPIC_DISCOVERY,
        ProductionEntryScope.CITATION_DISCOVERY,
    }
    needs_acquisition = scope in {
        ProductionEntryScope.ASSET_COMPLETION,
        ProductionEntryScope.CONTENT_COMPLETION,
    }
    needs_parser = scope is ProductionEntryScope.CONTENT_COMPLETION
    needs_analysis = scope in {
        ProductionEntryScope.CITATION_DISCOVERY,
        ProductionEntryScope.CONTENT_COMPLETION,
    }
    needs_browser_agent = (
        scope
        in {
            ProductionEntryScope.ASSET_COMPLETION,
            ProductionEntryScope.CONTENT_COMPLETION,
        }
        and configuration.access.browser_controller is BrowserController.AGENT
    )
    metadata_providers = metadata_source_providers(configuration)
    acquisition_providers = acquisition_source_providers(configuration)
    credential_providers = frozenset(configurable_credential_providers())
    needs_provider_credentials = needs_metadata or (
        needs_acquisition
        and any(provider in credential_providers for provider in acquisition_providers)
    )
    selected_model_references = tuple(
        reference
        for enabled, reference in (
            (needs_analysis, configuration.analysis.model),
            (needs_browser_agent, configuration.access.model),
        )
        if enabled and reference is not None
    )
    selected_model_providers = tuple(
        configuration.providers.get(model.provider)
        for reference in selected_model_references
        if (model := configuration.models.get(reference)) is not None
    )
    needs_runtime_credentials = (
        needs_parser and configuration.parsing.connection_mode is ParserConnectionMode.REMOTE
    ) or any(
        provider is not None and provider.requires_api_key for provider in selected_model_providers
    )
    needs_credentials = needs_provider_credentials or needs_runtime_credentials
    _require_paths_configuration(configuration)
    if needs_parser:
        _require_parser_configuration(configuration)
    if scope is ProductionEntryScope.CITATION_DISCOVERY:
        _require_reference_analysis_configuration(configuration)
    elif needs_analysis:
        _require_analysis_configuration(configuration)
    if needs_browser_agent:
        _require_browser_agent_configuration(configuration)
    if needs_metadata and not metadata_providers:
        raise BootstrapError("metadata-not-ready")

    credentials = load_credentials(home=credentials_home) if needs_credentials else None
    try:
        secrets = load_runtime_secrets(
            configuration,
            credentials=credentials,
            include_parser=needs_parser,
            include_agents=needs_analysis or needs_browser_agent,
        )
    except ConfigurationError:
        if needs_analysis:
            raise BootstrapError("analysis-not-ready") from None
        if needs_browser_agent:
            raise BootstrapError("browser-agent-not-ready") from None
        raise
    coordinator, resolver, http_client = (
        _new_shared_network()
        if (needs_metadata or needs_acquisition or needs_parser or needs_analysis)
        else (None, None, None)
    )
    clock = _UtcClock()
    acquisition_registry: AcquisitionRegistry | None = None
    acquisition_runtime = (
        _new_acquisition_execution_runtime(
            configuration,
            access_coordinator=coordinator,
            resolver=resolver,
            browser_profile_home=credentials_home,
        )
        if needs_acquisition and coordinator is not None and resolver is not None
        else None
    )
    agent: AgentRuntime | None = None
    browser_agent = None
    if coordinator is not None and http_client is not None:
        if scope is ProductionEntryScope.CITATION_DISCOVERY:
            agent = _build_agents_runtime(
                configuration,
                secrets,
                http_client,
                coordinator,
                required_roles=frozenset({AgentRole.ANALYSIS}),
            )
        elif scope is ProductionEntryScope.CONTENT_COMPLETION:
            required_roles = {AgentRole.ANALYSIS}
            if needs_browser_agent:
                required_roles.add(AgentRole.BROWSER)
            agent = _build_agents_runtime(
                configuration,
                secrets,
                http_client,
                coordinator,
                required_roles=frozenset(required_roles),
            )
            if needs_browser_agent:
                browser_agent = _browser_agent_dependency(agent)
        elif scope is ProductionEntryScope.ASSET_COMPLETION and needs_browser_agent:
            agent = _build_agents_runtime(
                configuration,
                secrets,
                http_client,
                coordinator,
                required_roles=frozenset({AgentRole.BROWSER}),
            )
            browser_agent = _browser_agent_dependency(agent)
    if needs_acquisition:
        assert coordinator is not None and http_client is not None
        assert acquisition_runtime is not None
        acquisition_registry = build_acquisition_registry(
            configuration,
            AcquisitionAssemblyDependencies(
                http_client=http_client,
                access_coordinator=coordinator,
                web_access_profile_resolver=production_web_access_profile_resolver(),
                provenance_id_factory=_new_provenance_id,
                clock=clock.now,
                browser_session_broker=acquisition_runtime.browser_session_broker,
                credentials=credentials,
                browser_client=acquisition_runtime.browser_client,
                browser_controller=BrowserControllerKind(
                    configuration.access.browser_controller.value
                ),
                browser_agent=browser_agent,
            ),
        )

    # Acquisition readiness includes enabled authorized-API credentials.  It
    # must be closed before Catalog or ArtifactStore construction, even though
    # a later rollback could otherwise hide that persistent roots were touched.
    storage = _build_scoped_storage(configuration)
    try:
        pdf_validation_staging = SystemPdfValidationStaging()
        engine = storage.foundation.engine
        literature_api = storage.literature_api
        if scope is ProductionEntryScope.MANUAL_PDF:
            publication = SqliteAcquisitionPublication(
                engine,
                storage.foundation.artifact_store,
                storage.foundation.verified_reader,
            )
            operation = ManualPdfOperation(
                current_facts_reader=storage.entry_reader,
                manual_admission=ManualPdfAdmissionService(
                    publication_port=ValidatedPrimaryPdfPublisher(publication),
                    staging=pdf_validation_staging,
                    provenance_id_factory=_new_provenance_id,
                    clock=clock.now,
                ),
                write_admission=storage.write_admission,
                recovery=storage.discovery_repository,
            )
            graph: object = ManualPdfObjectGraph(
                configuration=configuration,
                entry_api=_ManualPdfEntry(operation),
            )
        elif scope is ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE:
            operation = BibliographyOperations(
                literature=literature_api,
                codec=BibliographyCodecs(max_input_bytes=configuration.library.max_input_bytes),
                output=storage.atomic_user_output,
                selector_reader=storage.entry_reader,
                clock=clock,
                write_admission=storage.write_admission,
                recovery=storage.discovery_repository,
                observation_id_factory=_new_observation_id,
                provenance_id_factory=_new_provenance_id,
                provider_precedence=tuple(item.value for item in metadata_providers),
            )
            graph = BibliographyExchangeObjectGraph(
                configuration=configuration,
                entry_api=_BibliographyExchangeEntry(
                    operation.import_bibliography,
                    operation.export_bibliography,
                ),
            )
        elif needs_metadata:
            assert credentials is not None and coordinator is not None and http_client is not None
            registry, metadata_api = _build_metadata_components(
                configuration, credentials, coordinator, http_client
            )
            publication = MetadataPublication(
                literature_api,
                SqliteProviderRelationObservationPublication(storage.literature_writer),
            )
            precedence = tuple(item.provider_name for item in registry.registrations)
            if scope is ProductionEntryScope.TOPIC_DISCOVERY:
                operation = TopicDiscoveryOperation(
                    metadata=metadata_api,
                    metadata_publication=publication,
                    repository=storage.discovery_repository,
                    publication=storage.discovery_repository,
                    clock=clock,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    provider_precedence=precedence,
                )
                graph = TopicDiscoveryObjectGraph(
                    configuration=configuration,
                    topic_provider_limits=registry.topic_limits,
                    entry_api=_TopicDiscoveryEntry(operation),
                )
            else:
                assert agent is not None
                analysis_api = AnalysisApi.for_reference_lookup(
                    ReferenceLookupStage(
                        runtime=agent,
                        max_output_tokens=configuration.analysis.reference_max_output_tokens or 0,
                    )
                )
                operation = CitationDiscoveryOperation(
                    metadata=metadata_api,
                    relation_publication=publication,
                    literature=literature_api,
                    analysis=analysis_api,
                    candidate_reader=storage.entry_reader,
                    run_repository=storage.discovery_repository,
                    discovery_publication=storage.discovery_repository,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    clock=clock,
                    provider_precedence=precedence,
                )
                graph = CitationDiscoveryObjectGraph(
                    configuration=configuration,
                    citation_provider_limits=registry.citation_limits,
                    entry_api=_CitationDiscoveryEntry(operation),
                )
        else:
            assert coordinator is not None and http_client is not None
            assert acquisition_registry is not None
            assert acquisition_runtime is not None
            acquisition_publication = SqliteAcquisitionPublication(
                engine,
                storage.foundation.artifact_store,
                storage.foundation.verified_reader,
            )
            validated = ValidatedPrimaryPdfPublisher(acquisition_publication)
            acquisition_api = AcquisitionApi(
                TieredAcquisitionService(
                    route_registry=acquisition_registry.route_registry,
                    planner=acquisition_registry.planner,
                    publication_port=PrimaryPdfPublisher(
                        validated,
                        staging=pdf_validation_staging,
                    ),
                    exhaustion_port=acquisition_publication,
                    exhaustion_clear_port=acquisition_publication,
                    cohort_executor=acquisition_runtime.cohort_executor,
                )
            )
            inputs = CompletionInputBuilder(engine, storage.foundation.verified_reader)
            if scope is ProductionEntryScope.ASSET_COMPLETION:
                completion = AssetDatabaseCompletionOperation(
                    selector_reader=storage.entry_reader,
                    current_facts_reader=storage.entry_reader,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    acquisition=acquisition_api,
                    acquisition_requests=inputs,
                    max_concurrency=configuration.execution.max_concurrency,
                )
            else:
                parser = _production_dependencies(configuration, secrets).parser_factory(
                    http_client, coordinator
                )
                assert agent is not None
                parsing_api = ParsingApi(
                    ParsingService(
                        parser=parser,
                        result_store=SqliteParserResultPublication(
                            engine,
                            storage.foundation.artifact_store,
                            storage.foundation.verified_reader,
                        ),
                    )
                )
                analysis_api = AnalysisApi(
                    content_service=AnalysisService(
                        runtime=agent,
                        artifact_reader=AnalysisArtifactReader(
                            engine, storage.foundation.verified_reader
                        ),
                        current_inputs=SqliteAnalysisCurrentInputs(engine),
                        artifact_publisher=AnalysisArtifactPublisher(
                            storage.foundation.artifact_store
                        ),
                        metadata_max_output_tokens=configuration.analysis.metadata_max_output_tokens
                        or 0,
                        content_max_output_tokens=configuration.analysis.content_max_output_tokens
                        or 0,
                        limits=_analysis_limits(configuration),
                        provenance_id_factory=_new_provenance_id,
                        clock=clock.now,
                    ),
                    reference_lookup_stage=ReferenceLookupStage(
                        runtime=agent,
                        max_output_tokens=configuration.analysis.reference_max_output_tokens or 0,
                    ),
                )
                completion = DatabaseCompletionOperation(
                    selector_reader=storage.entry_reader,
                    current_facts_reader=storage.entry_reader,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    acquisition=acquisition_api,
                    acquisition_requests=inputs,
                    parsing=parsing_api,
                    parser_requests=inputs,
                    analysis=analysis_api,
                    analysis_inputs=inputs,
                    literature=literature_api,
                    cleanup=SqliteNoUsableContentCleanup(engine),
                    max_concurrency=configuration.execution.max_concurrency,
                )
            graph = DatabaseCompletionObjectGraph(
                configuration=configuration,
                access_coordinator=coordinator,
                http_client=http_client,
                browser_client=acquisition_runtime.browser_client,
                acquisition_registry=acquisition_registry,
                acquisition_runtime=acquisition_runtime,
                acquisition_api=acquisition_api,
                entry_api=_DatabaseCompletionEntry(completion),
            )
    except BaseException:
        _rollback_fresh_storage(storage.foundation.ownership)
        raise
    return cast(
        TopicDiscoveryObjectGraph
        | CitationDiscoveryObjectGraph
        | DatabaseCompletionObjectGraph
        | ManualPdfObjectGraph
        | BibliographyExchangeObjectGraph,
        _finish_scoped_graph(
            storage,
            graph,
            configure_process_logging=configure_process_logging,
            logging_level=logging_level,
        ),
    )


def build_production_object_graph(  # noqa: C901
    configuration: Configuration,
    *,
    scope: ProductionEntryScope | None = None,
    credentials_home: str | Path | None = None,
    configure_process_logging: bool = True,
    logging_level: int = logging.INFO,
) -> (
    ApplicationObjectGraph
    | LocalLibraryObjectGraph
    | TopicDiscoveryObjectGraph
    | CitationDiscoveryObjectGraph
    | DatabaseCompletionObjectGraph
    | ManualPdfObjectGraph
    | BibliographyExchangeObjectGraph
):
    """Build the real graph after a complete no-storage static preflight."""

    try:
        if not isinstance(configuration, Configuration):
            raise BootstrapError("configuration-invalid")
        if scope is not None and not isinstance(scope, ProductionEntryScope):
            raise BootstrapError("configuration-invalid")
        if scope is ProductionEntryScope.LOCAL_LIBRARY:
            return _build_local_library_graph(
                configuration,
                configure_process_logging=configure_process_logging,
                logging_level=logging_level,
            )
        if scope is not None:
            return _build_scoped_production_graph(
                configuration,
                scope=scope,
                credentials_home=credentials_home,
                configure_process_logging=configure_process_logging,
                logging_level=logging_level,
            )
        _required_production_configuration(configuration)
        # Load ADR 0014 credentials exactly once.  The same short-lived bundle
        # is consumed by every readiness check and Provider adapter below.
        credentials = load_credentials(home=credentials_home)
        secrets = load_runtime_secrets(configuration, credentials=credentials)
        dependencies = _production_dependencies(configuration, secrets)
        return build_object_graph(
            configuration,
            catalog_path=configuration.paths.catalog_path or "",
            artifact_root=configuration.paths.artifact_root or "",
            external_dependencies=dependencies,
            credentials=credentials,
            browser_profile_home=credentials_home,
            configure_process_logging=configure_process_logging,
            logging_level=logging_level,
        )
    except BootstrapError:
        raise
    except ConfigurationError:
        raise BootstrapError("configuration-invalid") from None
    except Exception as error:
        _raise_production_assembly_error(error)


__all__ = (
    "ApplicationObjectGraph",
    "BibliographyExchangeObjectGraph",
    "BootstrapError",
    "BootstrapExternalDependencies",
    "CitationDiscoveryObjectGraph",
    "DatabaseCompletionObjectGraph",
    "LocalLibraryObjectGraph",
    "ManualPdfObjectGraph",
    "PRODUCTION_BROWSER_CONFIGURATION_PROBE_ACCESS_KEYS",
    "ProductionEntryScope",
    "TopicDiscoveryObjectGraph",
    "build_object_graph",
    "build_production_object_graph",
)
