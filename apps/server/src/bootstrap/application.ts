import { DeviceConnectionService } from "../workbench/device-connections.js";
import {
  ImportSessionService,
  ImportSessionReadService,
  type ImportSessionOptions,
} from "../entry/import-sessions.js";
import { CaptureService, type CaptureOptions } from "../entry/capture.js";
import { runMetadataTask } from "../entry/metadata-task.js";
import { ProxyUnavailableError } from "../network/egress.js";
import { outboundEgress } from "../configuration/egress.js";
import {
  RestartAdmission,
  guardRuntimeMethods,
  type RestartBootstrapPermit,
} from "../application/restart-admission.js";
import { ArchiveTextPipeline } from "../archive/text-pipeline.js";
import { ArchiveArrangementAccess } from "../archive/arrangement-access.js";
import { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import type { TypeScriptConfigurationSnapshot } from "../configuration/owner.js";
import { configuredAcquisitionRoutes } from "../configuration/acquisition-selection.js";
import type {
  AcquisitionRouteState,
  ConfigurationReadiness,
} from "@sciretriever/contracts";
import { recordMapProgress } from "../application/operations.js";
import { executeMetadataTask } from "../entry/metadata-task-runtime.js";
import { ArchiveReusePreview } from "../archive/reuse.js";
import { ProcessorPlanner } from "../analysis/processor-planning.js";
import { UsageEstimator } from "../analysis/usage-estimate.js";
import { valueVerificationIdentity } from "../analysis/value-check.js";
import {
  configuredAgentModels,
  agentModel,
  configuredAgentIdentity,
  endpoint,
} from "./agent-models.js";
import { AgentTraceService } from "../application/agent-traces.js";
import { ProcessorValueVerifier } from "../analysis/value-check.js";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assemblePublicAcquisitionRegistry,
  type BrowserRouteAdmission,
  type PublicAcquisitionAssemblyOptions,
} from "../acquisition/assembly.js";
import { BrowserCandidateIntake } from "../acquisition/browser-intake.js";
import { CandidateAbandonmentService } from "../acquisition/candidate-abandonment.js";
import { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { CandidatePublisher } from "../acquisition/candidate-publication.js";
import { acceptPdf } from "../acquisition/pdf-acceptance.js";
import type { PublicAcquisitionRegistry } from "../acquisition/sources/public.js";
import { AnthropicMessagesAdapter } from "../agents/anthropic.js";
import { DshAgentRuntime, type AgentBinding } from "../agents/dsh/runtime.js";
import { TranslationCache } from "../translation/cache.js";
import { TranslationService } from "../translation/service.js";
import { FullTextTranslation } from "../translation/fulltext.js";
import { OpenAIChatAdapter, OpenAIResponsesAdapter } from "../agents/openai.js";
import type { AgentTransport } from "../agents/protocol.js";
import {
  AgentFailure,
  type AgentAdapter,
  type AgentCapability,
} from "../agents/protocol.js";
import { ProcessorArchiveSource } from "../analysis/processor-archive.js";
import { ProcessorExternalRetention } from "../analysis/processor-external.js";
import { createProcessorRegistry } from "../analysis/processor-registry.js";
import { ProcessorService } from "../analysis/processor.js";
import { FolderService } from "../literature/folders.js";
import { MarkService } from "../literature/marks.js";
import { SnapshotService } from "../analysis/snapshots.js";
import { InterventionService } from "../application/jobs/interventions.js";
import {
  ProcessingTaskService,
  readProcessingTask,
} from "../application/jobs/processing.js";
import {
  ProcessorBatchService,
  processorRuntime,
} from "../application/jobs/processors.js";
import {
  ExecutionJobService,
  ExecutionQueue,
  ExecutionTaskService,
} from "../application/jobs/service.js";
import { ArchiveOrchestrator } from "../archive/orchestrator.js";
import { ArchiveReader, ArchiveService } from "../archive/service.js";
import {
  createBrowserArticleFlow,
  DEFAULT_FLOW_DEADLINE_MS,
  DEFAULT_FLOW_MAX_MODEL_CALLS,
  flowUnavailable,
  type BrowserArticleFlowFactoryOptions,
} from "../browser/article-flow.js";
import type {
  BrowserArticleExecution,
  BrowserArticleSessionIdentity,
} from "../browser/article-session.js";
import type {
  BrowserArticleFlowFactory,
  BrowserDeliveryRequest,
} from "../browser/boundary.js";
import {
  resolveBrowserHost,
  type BrowserArticleFlow,
  type BrowserHostRuntimeSeam,
  type BrowserSessionHost,
} from "../browser/boundary.js";
import { BrowserCaptureBatch } from "../browser/capture-batch.js";
import {
  createBrowserCapability,
  type BrowserAgentCapability,
} from "../browser/decision.js";
import type { BrowserHostOptions } from "../browser/host.js";
import { BrowserObservationStore } from "../browser/observation.js";
import { DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS } from "../browser/pacing.js";
import { PdfRegionRenderer } from "../browser/pdf-region.js";
import {
  createProductionBrowserHostFactory,
  productionBrowserCapability,
  resolveVerifiedCloakRuntime,
} from "../browser/production-host.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import {
  bundlePreview,
  CredentialBoundaryError,
  loadCredentialBundle,
  type CredentialBundle,
  type CurrentCredentialReader,
} from "../configuration/credentials.js";
import {
  effectiveBrowserConcurrency,
  loadConfiguration,
  parseConfiguration,
  type OrdinaryConfiguration,
} from "../configuration/index.js";
import { TypeScriptConfigurationOwner } from "../configuration/owner.js";
import { AnnotationReadService } from "../document/annotation-read.js";
import { StructureAnnotationService } from "../document/annotations.js";
import { ProofreadDocumentService } from "../document/proofread-publication.js";
import { DocumentReadService } from "../document/read.js";
import { dshSectionClassifier } from "../document/section-classifier.js";
import { DocumentProcessingService } from "../document/service.js";
import { SqliteDocumentStorage } from "../document/storage.js";
import { BrowserArticleScheduler } from "../entry/browser-scheduler.js";
import { DatabaseCompletionService } from "../entry/database-completion.js";
import {
  CitationDiscoveryService,
  TopicDiscoveryService,
} from "../entry/discovery.js";
import { LiteratureCompletionService } from "../entry/literature-completion.js";
import { ManualPdfIngestionService } from "../entry/manual-pdf.js";
import {
  EntryPdfAcquisitionService,
  type PdfAcquisitionPort,
} from "../entry/pdf-acquisition.js";
import { PublisherGovernanceService } from "../entry/publisher-governance.js";
import { createTaskReader } from "../entry/task-read.js";
import { ExtractionDeliveryService } from "../extraction/delivery.js";
import { ExtractionPreparationService } from "../extraction/prepare.js";
import { ArchiveMetadataService } from "../literature/archive-metadata.js";
import { ArchiveReferenceService } from "../literature/archive-references.js";
import { LiteratureArticleIdentityService } from "../literature/article-identity.js";
import { LiteratureArtifactService } from "../literature/artifacts.js";
import { LiteratureIdentityService } from "../literature/identity.js";
import { dshMetadataProposer } from "../literature/metadata-agent.js";
import { LiteratureMetadataService } from "../literature/metadata-service.js";
import { LiteratureQueryService } from "../literature/query.js";
import { createLogger, type Logger } from "../logging/index.js";
import {
  assembleMetadataRegistry,
  type MetadataAssemblyOptions,
} from "../metadata/assembly.js";
import type {
  MetadataLookupPort,
  ReferenceQueryPort,
  TopicSearchPort,
} from "../metadata/ports.js";
import {
  buildMetadataRegistry,
  type MetadataRegistry,
} from "../metadata/registry.js";
import { createBrowserNetworkAdmission } from "../network/browser-admission.js";
import type { BrowserNetworkProxy } from "../network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import { throwCatalogCorruption } from "../storage/sqlite/errors.js";
import type { ConnectionDependencies } from "../network/connection.js";
import { createAgentTransport, NetworkHttpError } from "../network/http.js";
import type { Resolver } from "../network/policy.js";
import { ArticleIdentityService } from "../parsing/article-identity.js";
import {
  createMinerUProtocolTransport,
  MinerULoopbackParser,
  MinerUParser,
  type MinerUHttpTransport,
} from "../parsing/backends/mineru/index.js";
import type { RawParserBackend } from "../parsing/ports.js";
import { ParsingFailure } from "../parsing/ports.js";
import { RawParsingService } from "../parsing/raw-service.js";
import { pdfPages } from "../proofread/pdf-pages.js";
import { MupdfPageRenderer, resolveMupdfRuntime } from "../proofread/mupdf.js";
import type { PdfPages } from "../proofread/contract.js";
import { DraftPublicationService } from "../document/draft-publication.js";
import { ProofreadService } from "../proofread/service.js";
import {
  IndexRefreshService,
  readIndexRefreshStatus,
} from "../retrieval/refresh.js";
import { RetrievalIndexService } from "../retrieval/index.js";
import { KnowledgeContextService } from "../retrieval/knowledge-query.js";
import { MaterialContextService } from "../retrieval/query.js";
import { ExecutionRepository } from "../storage/execution/repository.js";
import { acquireExecutionRuntime } from "../storage/execution/runtime-owner.js";
import { ArtifactReclaimer } from "../storage/files/reclamation.js";
import { ArtifactRecovery } from "../storage/files/recovery.js";
import { FileStore } from "../storage/files/store.js";
import { SqliteProcessorStorage } from "../storage/processor-results.js";
import { SqliteProofreadStorage } from "../storage/proofread.js";
import { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import {
  AssetRepository,
  ObservationRepository,
  ReferenceRepository,
} from "../storage/sqlite/repositories.js";
import { RetrievalStorageClient } from "../storage/sqlite/retrieval-client.js";
import { SqliteWorker } from "../storage/sqlite/worker.js";
import { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import {
  CatalogWriteAdmission,
  WriteAdmissionError,
} from "../storage/write-admission.js";
import { dshTagModel } from "../tags/model.js";
import { TagService } from "../tags/service.js";
export interface Application {
  readonly capture: CaptureService;
  readonly importSessions: ImportSessionService;
  readonly deviceConnections: DeviceConnectionService;
  readonly restartAdmission?: RestartAdmission;
  readonly archiveArrangement: ArchiveArrangementAccess;
  readonly archiveText: ArchiveTextPipeline | null;
  readonly snapshots: SnapshotService;
  readonly folders: FolderService;
  readonly marks: MarkService;
  /** Reader translation (ADR 0049); its cache lives outside the catalog. */
  readonly translation: TranslationService;
  /** Full-text translation placed on the page (ADR 0051), kept outside the catalog. */
  readonly fullTextTranslation: FullTextTranslation;
  readonly archive: ArchiveService;
  readonly tags: TagService;
  readonly metadataFields: LiteratureMetadataService;
  readonly archiveMetadata: ArchiveMetadataService;
  readonly archiveReferences: ArchiveReferenceService;
  readonly processors?: ProcessorBatchService | null;
  readonly processorRetention?: ProcessorExternalRetention | null;
  readonly processorRead?: ProcessorReader | null;
  readonly articleIdentity?: ArticleIdentityService | null;
  readonly processingTasks?: ProcessingTaskService | null;
  readonly bootId: string;
  readonly metadata: MetadataRegistry;
  readonly acquisition: PublicAcquisitionRegistry;
  configurationStatus(signal?: AbortSignal): Promise<ConfigurationReadiness>;
  configurationAcquisitionRoutes(
    snapshot: TypeScriptConfigurationSnapshot,
    signal?: AbortSignal,
  ): Promise<AcquisitionRouteState>;
  readonly discovery: TopicDiscoveryService;
  readonly citations: CitationDiscoveryService;
  readonly identity: LiteratureIdentityService;
  readonly completion: LiteratureCompletionService | null;
  readonly maintenance: {
    readonly ingestPdf: ManualPdfIngestionService["ingestPdf"];
    readonly ingestPdfStream: ManualPdfIngestionService["ingestPdfStream"];
    readonly parseDocuments: DocumentProcessingService["parseDocuments"];
    readonly documentDefault: SqliteWorker["documentDefault"];
    readonly rebuildIndex: IndexRefreshService["rebuild"];
    readonly refreshIndex?: IndexRefreshService["refresh"];
    readonly scheduleIndexRefresh?: IndexRefreshService["scheduleRefresh"];
    readonly scheduleIndexRebuild?: IndexRefreshService["scheduleRebuild"];
    readonly verifyIndex: RetrievalIndexService["verify"];
    readonly verifyCatalog: RetrievalStorageClient["verifyCatalog"];
    readonly extraction: ExtractionDeliveryService;
  } | null;
  readonly documentProcessing: DocumentProcessingService;
  readonly indexRefreshStatus?: () => Promise<
    import("@sciretriever/contracts").IndexRefreshStatus
  >;
  readonly documentRead: DocumentReadService;
  readonly extractionPreparation: ExtractionPreparationService;
  readonly extractionDelivery: ExtractionDeliveryService;
  readonly artifactRecovery: ArtifactRecovery;
  readonly artifactReclaimer: ArtifactReclaimer;
  readonly writes: CatalogWriteAdmission;
  readonly rawParsing: RawParsingService | null;
  readonly proofreading: ProofreadService | null;
  readonly proofreadDocuments: ProofreadDocumentService;
  readonly draftDocuments: DraftPublicationService;
  readonly structureAnnotations: StructureAnnotationService | null;
  readonly rawParseStorage: SqliteRawParseStorage | null;
  readonly literatureArtifacts: LiteratureArtifactService;
  readonly library: LiteratureQueryService;
  readonly publisherGovernance: PublisherGovernanceService;
  readonly home: string;
  readonly configuration: OrdinaryConfiguration;
  /** Owner revision of the ordinary configuration snapshot loaded at startup. */
  readonly configuration_revision: string;
  readonly credentials: CredentialBundle;
  readonly database: SqliteWorker;
  readonly files: FileStore;
  readonly agents: DshAgentRuntime;
  readonly browserCapability: BrowserAgentCapability;
  readonly networkBudget: NetworkBudgetCoordinator;
  readonly logger: Logger;
  readonly observations: ObservationRepository;
  readonly assets: AssetRepository;
  readonly references: ReferenceRepository;
  readonly execution: {
    readonly transfers: BrowserTransferCollector;
    readonly publisher: CandidatePublisher;
    readonly acceptance: CandidateAcceptanceService;
    readonly abandonment: CandidateAbandonmentService;
  } | null;
  readonly jobs: ExecutionRepository | null;
  readonly queue: ExecutionQueue | null;
  readonly jobService: ExecutionJobService | null;
  readonly taskService: ExecutionTaskService | null;
  readonly interventions: InterventionService | null;
  readonly executionRecovery: {
    readonly recovered_attempts: number;
    readonly recovered_targets: number;
    readonly recovered_jobs: number;
    readonly released_leases: number;
    readonly expired_interventions: number;
    readonly reconciled_publications: number;
  } | null;
  /**
   * Entry-owned automatic PDF acquisition over the process-wide acquisition
   * registry. Bootstrap constructs this exactly once so the CLI, the durable job
   * runtime and every other caller share one acquisition port instead of each
   * assembling an isolated `assistance: "never"` loop. Null when the execution
   * runtime (and therefore the transfer collector) is not assembled.
   */
  readonly pdfAcquisition: PdfAcquisitionPort | null;
  /**
   * Entry-owned database completion orchestration. Bootstrap constructs this once
   * and hands the same instance to the CLI; the durable job runtime receives the
   * same shared ports through its task runtime.
   */
  readonly databaseCompletion: DatabaseCompletionService | null;
  /**
   * The process-owned controlled Browser session, if one was demanded. Bootstrap is
   * the only constructor and the only closer; returning the session view keeps Page,
   * Context and CDP handles out of every caller.
   */
  browserHost(): BrowserSessionHost | null;
  /** Shares one cleanup result; rejects if any owned resource fails to close. */
  close(): Promise<void>;
}
export type ProcessorReader = Pick<
  SqliteProcessorStorage,
  | "byId"
  | "list"
  | "collections"
  | "collection"
  | "query"
  | "search"
  | "searchCollections"
  | "verifyCitation"
  | "records"
>;
export interface QueryApplication {
  readonly importSessions?: Pick<ImportSessionReadService, "status" | "report">;
  readonly archiveArrangement?: ArchiveArrangementAccess;
  readonly usageEstimate?: (
    request: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly reviewRead?: (
    action:
      | "audit-list"
      | "job-origin-get"
      | "session-list"
      | "session-read"
      | "session-revision"
      | "task-run"
      | "processor-runs"
      | "literature-results",
    value: unknown,
  ) => Promise<unknown>;
  readonly archiveProfile?: "pipeline" | "vlm-engine";
  readonly folders?: Pick<FolderService, "query">;
  readonly marks?: Pick<MarkService, "query">;
  readonly snapshots?: Pick<
    SnapshotService,
    "query" | "read" | "list" | "diff"
  >;
  readonly archive?: ArchiveReader;
  readonly tags?: TagService;
  readonly metadataFields?: Pick<LiteratureMetadataService, "read">;
  readonly annotationRead?: AnnotationReadService | null;
  readonly proofreadRead?: Pick<
    ProofreadService,
    "inspect" | "status" | "page" | "editor" | "readingStatus"
  > | null;
  readonly rawParseRead?: Pick<SqliteRawParseStorage, "current"> | null;
  readonly processorRead?: ProcessorReader | null;
  readonly tasks?: ReturnType<typeof createTaskReader>;
  readonly taskRead?: (jobId: string) => ReturnType<typeof readProcessingTask>;
  readonly articleIdentityRead?: (assessmentId: string) => Promise<{
    assessment: import("@sciretriever/contracts").ArticleIdentityAssessment;
    current: boolean;
  } | null>;
  readonly readiness: {
    readonly status: "ready" | "not-initialized" | "unavailable";
    readonly schema_version: number | null;
    readonly schema_fingerprint: string | null;
  };
  /** Read-only literature and artifact operations. No maintenance or Job port is exposed. */
  readonly query: Pick<
    LiteratureQueryService,
    | "search"
    | "counts"
    | "detail"
    | "references"
    | "referenceDetail"
    | "intakeBatches"
    | "facets"
    | "pdfSelection"
  > | null;
  readonly literatureArtifacts: LiteratureArtifactService | null;
  readonly indexRefreshStatus?: () => Promise<
    import("@sciretriever/contracts").IndexRefreshStatus
  >;
  readonly documentRead: DocumentReadService | null;
  readonly extractionPreparation: ExtractionPreparationService | null;
  readonly context: MaterialContextService | null;
  readonly knowledgeContext: KnowledgeContextService | null;
  close(): Promise<void>;
}
export interface QueryApplicationOptions {
  readonly proofreadPages?: PdfPages;
  readonly catalog_path?: string;
  readonly artifact_root?: string;
}
export class QueryApplicationError extends Error {
  readonly code: "query-not-initialized" | "query-unavailable";
  constructor(status: "not-initialized" | "unavailable") {
    super("query application is unavailable");
    this.code =
      status === "not-initialized"
        ? "query-not-initialized"
        : "query-unavailable";
  }
}
/** A flow that always refuses with the stable flow-unavailable reason. */
function flowUnavailableFlow(): BrowserArticleFlow {
  return { deliver: async () => flowUnavailable() };
}
const BROWSER_FLOW_BUDGET = Object.freeze({
  max_model_calls: DEFAULT_FLOW_MAX_MODEL_CALLS,
  deadline_ms: DEFAULT_FLOW_DEADLINE_MS,
  action_cooldown_ms: DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
});
export type ApplicationStage =
  | "home"
  | "configuration"
  | "credentials"
  | "database"
  | "files"
  | "network"
  | "agents"
  | "schema";
export interface ApplicationOptions {
  readonly capture?: CaptureOptions;
  readonly importSessions?: ImportSessionOptions;
  /** Poll timing seam; null gives isolated tests explicit ownership of index phases. */
  readonly indexRefreshIntervalMs?: number | null;
  readonly networkBudget?: NetworkBudgetCoordinator;
  readonly configurationSnapshot?: import("../configuration/owner.js").TypeScriptConfigurationSnapshot;
  readonly startupCredentials?: CredentialBundle;
  readonly restartBootstrapPermit?: RestartBootstrapPermit;
  /** Explicit PDF inspection/rendering port for isolated integrations; production uses verified bundled PDF.js. */
  readonly proofreadPages?: PdfPages;
  readonly metadata?: {
    readonly topic_search_ports?: readonly TopicSearchPort[];
    readonly lookup_ports?: readonly MetadataLookupPort[];
    readonly reference_query_ports?: readonly ReferenceQueryPort[];
    readonly readiness?: Readonly<Record<string, string | null>>;
  };
  /** Optional resolver/loopback seam for the shared production metadata Network. */
  readonly metadataAssembly?: MetadataAssemblyOptions;
  readonly acquisitionAssembly?: PublicAcquisitionAssemblyOptions;
  /**
   * Deferred controlled-Browser host construction. Bootstrap is the only owner: it
   * builds the host lazily through the browser boundary factory, holds the instance
   * for the process lifetime and closes it in `close()`. Tests inject a seam so the
   * object graph is exercised without launching a real Browser.
   */
  readonly browserHost?: (
    seam: BrowserHostRuntimeSeam,
  ) => BrowserSessionHost | null;
  /**
   * Operator-verified Cloak runtime for the production Browser. When absent (and no
   * seam is injected) the Browser tier stays stably unavailable.
   */
  readonly browserRuntime?: BrowserHostOptions["runtime"];
  /** Network-owned proxy connection handed to the host. */
  readonly browserProxy?: BrowserHostOptions["proxy"];
  /**
   * Network-approved navigation admission. A controlled Browser must never fall back to
   * the host's permissive default, so a process without an exact admission does not get
   * a usable host at all.
   */
  readonly browserAdmitNavigation?: BrowserHostOptions["admitNavigation"];
  /** Intake-owned capture callbacks; Acquisition interprets the bytes, not Browser. */
  readonly browserTransfers?: BrowserHostOptions["transfers"];
  /** Explicit "the Browser runtime is available" claim for hosts that report readiness. */
  readonly browserRuntimeAvailable?: boolean;
  /**
   * The bounded Browser article driver. Bootstrap wires it only when the process owns
   * a real driver; without one the tier keeps an owned host but reports a stable
   * flow-unavailable refusal instead of a fake delivery.
   */
  readonly browserArticleFlow?: BrowserArticleFlow;
  /** Optional same-page human collaboration port for an explicit live workbench. */
  readonly browserCollaboration?: NonNullable<
    BrowserArticleFlowFactoryOptions["collaboration"]
  > & {
    captured(
      articleId: string,
      candidate?: {
        readonly transfer_id: string;
        readonly sha256: string;
        readonly size_bytes: number;
        readonly page_count: number;
        readonly disposition: "accepted" | "uncertain" | "rejected";
        readonly publication: null;
      },
      sessionId?: string,
    ): void;
  };
  /** Optional timeout seam for the pure TypeScript Analysis owner. */
  /** Explicit TS parser seam; transport is injected by the Network owner. */
  readonly typescriptParserRuntime?: {
    readonly transport: MinerUHttpTransport;
    readonly baseUrl: string;
    readonly modelIdentity: string;
  };
  /** Offline transport seam; remote credential resolution remains per request. */
  readonly mineruTransportFactory?: (origin: string) => MinerUHttpTransport;
  readonly parsing?: {
    readonly rawParser: RawParserBackend;
  };
  /** Optional pure TypeScript owner instance for tests and shared frontends. */
  readonly configurationOwner?: TypeScriptConfigurationOwner;
  /** Offline socket seam; the real credential authorization boundary still runs. */
  readonly agentTransportFactory?: (
    provider: string,
    origin: string,
  ) => AgentTransport;
  /** Observes assembly stages without selecting a catalog layout. */
  readonly afterStage?: (stage: ApplicationStage) => void | Promise<void>;
}
function serviceOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new ParsingFailure("parser-unavailable");
  return parsed.origin;
}
function assembleConfiguredTypeScriptParser(
  configuration: OrdinaryConfiguration,
  credentials: CredentialBundle,
  currentCredential: CurrentCredentialReader,
  coordinator: NetworkBudgetCoordinator,
  resolver?: Resolver,
  connection?: ConnectionDependencies,
  transportFactory?: ApplicationOptions["mineruTransportFactory"],
): {
  readonly rawParser: RawParserBackend;
} | null {
  const config = configuration.parsing;
  if (
    config.connection_mode !== "remote" ||
    !config.remote_upload_authorized ||
    !config.base_url ||
    !config.model_identity
  )
    return null;
  let origin: string;
  try {
    origin = serviceOrigin(config.base_url);
  } catch {
    return null;
  }
  const section = bundlePreview(credentials).sections.find(
    (item) => item.section === "mineru" && item.origin === origin,
  );
  if (
    !section?.fields.some(
      (item) => item.field === "bearer_token" && item.present,
    )
  )
    return null;
  const parsed = new URL(config.base_url);
  const raw = transportFactory
    ? null
    : createAgentTransport({
        egress: outboundEgress(
          configuration.network,
          { kind: "mineru" },
          credentials,
          currentCredential,
        ),
        resolver:
          resolver ??
          (async (hostname) =>
            (await lookup(hostname, { all: true })).map(
              (item) => item.address,
            )),
        policy: {
          allowed_schemes: ["https"],
          allowed_classes: ["public"],
          allowed_origins: [
            {
              scheme: "https",
              hostname: parsed.hostname,
              port: Number(parsed.port || 443),
            },
          ],
          allowed_ports: [
            { scheme: "https", port: Number(parsed.port || 443) },
          ],
        },
        coordinator,
        scope: "parser",
        limits: {
          maxConcurrency: 1,
          maxHostConcurrency: 1,
          maxResponseBytes: 128 * 1024 * 1024,
          maxRedirects: 0,
          maxRetries: 0,
        },
        ...(connection ? { connection } : {}),
      });
  const injected = transportFactory?.(origin);
  const transport: MinerUHttpTransport = {
    request: async (url, options) => {
      const token = await currentCredential({
        namespace: "core",
        provider: "mineru",
        field: "bearer_token",
        origin,
        operation:
          options.method === "GET" && new URL(url).pathname.endsWith("/health")
            ? "parser-health"
            : "parser-upload",
      });
      if (token === null) throw new CredentialBoundaryError();
      const headers = {
        ...options.headers,
        authorization: `Bearer ${token}`,
      };
      if (injected) return injected.request(url, { ...options, headers });
      return raw!({
        endpoint: url,
        method: options.method ?? "POST",
        headers: Object.entries(headers),
        body: options.body,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
  };
  const parser = new MinerUParser(
    createMinerUProtocolTransport(transport, {
      baseUrl: config.base_url,
    }),
    {
      baseUrl: config.base_url,
      modelIdentity: config.model_identity,
    },
  );
  return {
    rawParser: parser,
  };
}
export async function createApplication(
  homeValue: string,
  options: ApplicationOptions = {},
): Promise<Application> {
  if (typeof homeValue !== "string" || !homeValue.startsWith("/"))
    throw new Error("application operation failed");
  const home = resolve(homeValue);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".sciretriever"), { recursive: true, mode: 0o700 });
  const owner =
    options.configurationOwner ?? new TypeScriptConfigurationOwner(home);
  const snapshot = options.configurationSnapshot ?? (await owner.read());
  const admission = new RestartAdmission(
    home,
    snapshot.configuration.paths.catalog_path ?? join(home, "catalog.sqlite"),
  );
  return admission.bootstrap(
    () =>
      createApplicationOwned(
        home,
        {
          ...options,
          configurationOwner: owner,
          configurationSnapshot: snapshot,
        },
        admission,
      ),
    options.restartBootstrapPermit,
  );
}
async function createApplicationOwned(
  homeValue: string,
  options: ApplicationOptions,
  admission: RestartAdmission,
): Promise<Application> {
  if (options.parsing && options.typescriptParserRuntime)
    throw new ParsingFailure("parser-unavailable");
  const home = resolve(homeValue);
  const bootId = randomUUID();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".sciretriever"), { recursive: true, mode: 0o700 });
  await options.afterStage?.("home");
  const configurationOwner =
    options.configurationOwner ?? new TypeScriptConfigurationOwner(home);
  if (configurationOwner.home !== home)
    throw new Error("application operation failed");
  const configurationSnapshot =
    options.configurationSnapshot ?? (await configurationOwner.read());
  const configuration = configurationSnapshot.configuration;
  await options.afterStage?.("configuration");
  const credentials =
    options.startupCredentials ?? (await loadCredentialBundle(home));
  await options.afterStage?.("credentials");
  let database: SqliteWorker | undefined;
  let files: FileStore | undefined;
  let agents: DshAgentRuntime | undefined;
  const translationRuntimes = new Map<string, DshAgentRuntime>();
  let translationCache: TranslationCache | undefined;
  let agentTraces: AgentTraceService | undefined;
  let browserAgentCapability: BrowserAgentCapability | undefined;
  let rawParsing: RawParsingService | undefined;
  let proofreadDocuments: ProofreadDocumentService | undefined;
  let draftDocuments: DraftPublicationService | undefined;
  let structureAnnotations: StructureAnnotationService | undefined;
  let proofreading: ProofreadService | undefined;
  let archiveText: ArchiveTextPipeline | undefined;
  let valueVerifier: ProcessorValueVerifier | undefined;
  let rawParseStorage: SqliteRawParseStorage | undefined;
  let regionRenderer: PdfRegionRenderer | undefined;
  let pageImages: MupdfPageRenderer | undefined;
  let completion: LiteratureCompletionService | undefined;
  let manualPdf: ManualPdfIngestionService | undefined;
  let importSessions: ImportSessionService | undefined;
  let capture: CaptureService | undefined;
  let pdfAcquisition: PdfAcquisitionPort | null = null;
  let execution: Application["execution"] = null;
  // Deferred callbacks must read the live execution context, but they are created
  // before it exists. They read this box instead, which is updated as soon as the
  // execution runtime is assembled; a direct read would also collapse to `never` under
  // control-flow analysis because the holder stays null until the first delivery.
  const executionBox: {
    current: Application["execution"];
  } = { current: null };
  const currentExecution = (): NonNullable<Application["execution"]> | null =>
    executionBox.current;
  const browserCapacity = effectiveBrowserConcurrency(configuration.browser);
  const browserScheduler = new BrowserArticleScheduler({
    sessions: browserCapacity.effective_sessions,
    workers: browserCapacity.decision_workers,
    onQueued: (identity, cancel) =>
      options.browserCollaboration?.queued?.(identity, cancel),
    onRemoved: (sessionId, outcome) =>
      options.browserCollaboration?.removed?.(sessionId, outcome),
    ...(configuration.browser.policy_overrides[0]
      ? { policy: configuration.browser.policy_overrides[0] }
      : {}),
  });
  const browserSessions = new Map<
    string,
    {
      readonly request: BrowserDeliveryRequest;
      readonly execution: BrowserArticleExecution;
      readonly target: {
        article_id: string;
        identifier: string;
        version: string;
        session_id: string;
      };
      readonly batch: BrowserCaptureBatch;
      closed: boolean;
    }
  >();
  let browserSessionHost: BrowserSessionHost | null = null;
  let ownedBrowserProxy: BrowserNetworkProxy | null = null;
  let databaseCompletion: DatabaseCompletionService | null = null;
  let documentProcessing: DocumentProcessingService | null = null;
  let documentRead: DocumentReadService | null = null;
  let processorRead: SqliteProcessorStorage | null = null;
  let articleIdentity: ArticleIdentityService | null = null;
  let processingTasks: ProcessingTaskService | null = null;
  let processorService: ProcessorService | null = null;
  let processorRetention: ProcessorExternalRetention | null = null;
  let processors: ProcessorBatchService | null = null;
  let extractionPreparation: ExtractionPreparationService | null = null;
  let extractionDelivery: ExtractionDeliveryService | null = null;
  let retrievalIndex: RetrievalIndexService | null = null;
  let indexDatabase: SqliteWorker | undefined;
  let indexRefresh: IndexRefreshService | null = null;
  const catalogPath =
    configuration.paths.catalog_path ?? join(home, "catalog.sqlite");
  const networkBudget = options.networkBudget ?? new NetworkBudgetCoordinator();
  // Other processes (Web, CLI, MCP) hold the catalog lock for short batches;
  // business writes wait briefly for them instead of failing at once.
  const writes = new CatalogWriteAdmission(catalogPath, { waitMs: 10_000 });
  let closing: Promise<void> | undefined;
  const closeApplication = (): Promise<void> => {
    // Publish the shared result before invoking any resource callback. This also
    // closes lazy Browser admission immediately, including during reentrant calls.
    closing ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      // Keep dependants before their stores and permits. A failed release must not
      // stop later owners from releasing resources or erase another cleanup error.
      const releases: readonly (() => void | Promise<void>)[] = [
        async () => capture?.close(),
        async () => importSessions?.close(),
        async () => processingTasks?.close(),
        async () => processorService?.close(),
        async () => processorRetention?.close(),
        async () => processorRead?.close(),
        async () => articleIdentity?.close(),
        async () => {
          const host = browserSessionHost;
          browserSessionHost = null;
          // Broker close aborts active work and rejects queued work. Closing the
          // host concurrently unblocks a page operation that has not returned to
          // the driver yet; both results settle before the proxy is released.
          const settled = await Promise.allSettled([
            Promise.resolve().then(() => pdfAcquisition?.close?.()),
            Promise.resolve().then(() => browserScheduler.close()),
            Promise.resolve().then(() => host?.close()),
          ]);
          for (const result of settled)
            if (result.status === "rejected") failures.push(result.reason);
          const proxy = ownedBrowserProxy;
          ownedBrowserProxy = null;
          try {
            await proxy?.close();
          } catch (error) {
            failures.push(error);
          }
        },
        () => completion?.close(),
        () => manualPdf?.close(),
        () => documentProcessing?.close(),
        () => draftDocuments?.close(),
        () => proofreading?.close(),
        () => proofreadDocuments?.close(),
        () => rawParsing?.close(),
        () => regionRenderer?.close(),
        () => pageImages?.close(),

        () => indexRefresh?.close(),
        () => retrievalIndex?.close(),
        () => indexDatabase?.close(),
        () => extractionDelivery?.shutdown(),
        () => extractionPreparation?.close(),
        () => documentRead?.close(),
        () => structureAnnotations?.close(),
        () => rawParseStorage?.close(),
        () => networkBudget.close(),
        () => agents?.close(),
        ...[...translationRuntimes.values()].map((r) => () => r.close()),
        () => translationCache?.close(),
        () => agentTraces?.close(),
        () => writes.close(),
        () => files?.close(),
        () => database?.close(),
      ];
      for (const release of releases) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "application cleanup failed");
    });
    return closing;
  };
  try {
    database = new SqliteWorker(catalogPath, writes, {
      maxTags: configuration.tags.max_per_literature,
      archiveProfile: configuration.parsing.archive_profile,
    });
    await options.afterStage?.("database");
    files = new FileStore(
      configuration.paths.artifact_root ?? join(home, "artifacts"),
      writes,
    );
    await options.afterStage?.("files");
    await options.afterStage?.("network");
    // The controlled-Browser route is admitted only on the operator's explicit
    // switch. Bootstrap owns BrowserHost construction through a deferred factory so
    // an idle route never starts a Browser, profile or Cloak bundle. A disabled
    // switch does not register the route at all (the tier is legitimately skipped);
    // an enabled-but-unavailable runtime stays registered as a not-ready source so
    // its stable reason remains visible instead of silently truncating the attempt.
    const browserEnabled = configuration.browser.enabled === true;
    // Bootstrap owns the one controlled Browser. The host is built lazily through the
    // boundary factory, so an idle tier never creates a profile directory, takes the
    // profile lock, opens a Network connection or launches Chromium.
    // The production runtime is resolved and verified *before* any host can be built:
    // an unverified bundle path must never admit the tier, and a factory without a
    // verified runtime must never fall back to the default Playwright Chromium. The
    // verification runs only when the operator enabled Browser and no seam was injected,
    // so an idle or disabled process touches no bundle at all.
    const injectedBrowserHostFactory = options.browserHost ?? null;
    const verifiedBrowserRuntime =
      options.browserRuntime ??
      (browserEnabled && injectedBrowserHostFactory === null
        ? await resolveVerifiedCloakRuntime(
            process.env.SCIRETRIEVER_CLOAK_BUNDLE,
          )
        : undefined);
    // A verified production runtime receives the Network-owned CONNECT transport
    // and URL/DNS admission automatically. The injected ports remain explicit
    // offline seams; ordinary CLI and Job callers need no private bootstrap option.
    let browserProxy = options.browserProxy;
    let browserAdmitNavigation = options.browserAdmitNavigation;
    if (
      browserEnabled &&
      verifiedBrowserRuntime &&
      injectedBrowserHostFactory === null &&
      browserProxy === undefined &&
      browserAdmitNavigation === undefined
    ) {
      const network = createBrowserNetworkAdmission({
        budget: networkBudget,
        egress: outboundEgress(
          configuration.network,
          { kind: "browser" },
          credentials,
          configurationOwner.authorizeCurrentCredential.bind(
            configurationOwner,
          ),
        ),
      });
      browserProxy = await network.proxy.start();
      browserAdmitNavigation = network.admitNavigation;
      ownedBrowserProxy = network.proxy;
    }
    const browserHostResolution = resolveBrowserHost(
      configuration.browser.profile
        ? {
            profile: join(home, "profile"),
            ...(browserProxy ? { proxy: browserProxy } : {}),
          }
        : null,
      injectedBrowserHostFactory ??
        createProductionBrowserHostFactory({
          runtime: verifiedBrowserRuntime,
          networkFailure: (url) =>
            ownedBrowserProxy?.failureFor(url)
              ? new ProxyUnavailableError()
              : null,
          maxSessions: browserCapacity.effective_sessions,
          ...(browserProxy ? { proxy: browserProxy } : {}),
          ...(browserAdmitNavigation
            ? { admitNavigation: browserAdmitNavigation }
            : {}),
          beforeRequest: (binding, url, drainPrevious) =>
            browserScheduler.beforeRequest(binding, url, drainPrevious),
          navigationRetryFailed: (binding) =>
            browserScheduler.navigationRetryFailed(binding),
          documentCommitted: (document) =>
            browserScheduler.documentCommitted(document),
          resumeDocument: (document, drainPrevious) =>
            browserScheduler.resumeDocument(document, drainPrevious),
          requestEnded: (binding) => browserScheduler.requestEnded(binding),
          onRuntimeLost: () => browserScheduler.runtimeLost(),
          rateLimited: (binding, retryAfter) => {
            let delay: number | undefined;
            if (retryAfter !== null) {
              try {
                delay = networkBudget.retryAfterMilliseconds(retryAfter, {
                  maxConcurrency: 1,
                  maxResponseBytes: 1,
                  maxRedirects: 0,
                  maxRetries: 0,
                  maxRetryAfterMs: 86400000,
                });
              } catch {
                delay = undefined;
              }
            }
            browserScheduler.rateLimited(binding.session_id, delay);
          },
          transfers: {
            resources: () => {
              const runtime = currentExecution();
              if (!runtime)
                throw new Error("Browser transfer resources unavailable");
              return runtime.transfers.resources;
            },
            captureContext: (
              pageId: string,
              generation: number,
              sourceUrl: string,
              sessionId?: string,
            ) => {
              const state = sessionId
                ? browserSessions.get(sessionId)
                : undefined;
              if (!state || state.closed) return null;
              return {
                session_id: state.target.session_id,
                article_id: state.target.article_id,
                page_id: pageId,
                document_generation: generation,
                source_url: sourceUrl,
                captured_at: new Date().toISOString(),
              };
            },
            started: (transferId, capture) =>
              browserSessions
                .get(capture.session_id)
                ?.execution.transferStarted(transferId),
            completed: (transferId, capture) =>
              browserSessions
                .get(capture.session_id)
                ?.execution.transferCompleted(transferId),
            failed: (transferId, capture, code) => {
              browserScheduler.transferFailed(capture.session_id);
              browserSessions
                .get(capture.session_id)
                ?.execution.transferFailed(
                  transferId,
                  code ?? "browser-transfer-failed",
                );
            },
            receive: async (input) => {
              const state = browserSessions.get(input.capture.session_id);
              const runtime = currentExecution();
              if (!state || state.closed || !runtime)
                throw new TypeError("no browser intake target");
              const intake = new BrowserCandidateIntake(
                runtime.transfers,
                state.target,
              );
              const result = await intake.receive(input);
              const excluded =
                state.request.excluded_sha256?.includes(
                  result.candidate.sha256,
                ) === true;
              if (
                state.closed ||
                browserSessions.get(input.capture.session_id) !== state ||
                excluded ||
                !state.batch.add({
                  transfer_id: result.candidate.transfer_id,
                  candidate: result.candidate,
                  accepted: true,
                })
              ) {
                await runtime.abandonment.abandon(
                  {
                    article_id: state.target.article_id,
                    transfer_id: result.candidate.transfer_id,
                    sha256: result.candidate.sha256,
                  },
                  new AbortController().signal,
                );
                if (!state.closed && excluded)
                  state.execution.candidateRejected(
                    "browser-candidate-excluded",
                  );
                return;
              }
              state.execution.candidateReady();
              options.browserCollaboration?.captured(
                state.target.article_id,
                {
                  transfer_id: result.candidate.transfer_id,
                  sha256: result.candidate.sha256,
                  size_bytes: result.candidate.size_bytes,
                  page_count: result.assessment.page_count,
                  disposition: "accepted",
                  publication: null,
                },
                state.target.session_id,
              );
            },
          },
          // The host factory owns the raw BrowserHost, so it supplies the real page
          // source; Bootstrap only builds the driver around it. A missing driver keeps
          // the stable flow-unavailable refusal instead of faking one.
          article_flow_factory: (pages) => {
            const build = demandBrowserFlowFactory();
            if (build === null) return flowUnavailableFlow();
            return build(pages);
          },
        }),
    );
    // Readiness must come from the actual capability, never from the seam alone: a
    // production factory without a verified runtime builds nothing, so the admission
    // has to stay unadmitted with a stable runtime reason instead of claiming a
    // controlled delivery that cannot exist.
    const browserCapability =
      injectedBrowserHostFactory !== null
        ? Object.freeze({
            available: true as const,
            reason: null,
          })
        : productionBrowserCapability({ runtime: verifiedBrowserRuntime });
    const browserAdmissionPresent = browserAdmitNavigation !== undefined;
    const browserRuntimeAvailable =
      browserEnabled &&
      browserAdmissionPresent &&
      browserCapability.available &&
      browserHostResolution.availability === "available" &&
      options.browserRuntimeAvailable !== false;
    // Controlled delivery is admitted only when the process actually owns a Browser
    // host AND the Entry acquisition port can present a Browser delivery as an
    // accepted candidate. Entry now runs the locator routes itself and escalates once
    // to this owned session, so an available host is an admitted route; a missing
    // runtime stays unadmitted and fails closed instead of faking an acquisition.
    const browserControlledDelivery = browserRuntimeAvailable;
    // Only an admitted Browser is expressed as a route. When the operator left
    // Browser off there is no admission to express, so the registry keeps the
    // Public -> authorized API order and the tier is skipped, not faked.
    // Built on first demand and then held for the process lifetime, so Bootstrap
    // stays the single owner and `close()` can release it deterministically.
    // The production driver is assembled lazily, at demand time: the Intake collector,
    // its transfers and the acceptance owner only exist after `execution` is built, and
    // the flow must read those real instances — never the host callbacks as a
    // substitute. Because every reference is resolved inside this closure, an idle tier
    // still constructs nothing and never starts a Browser.
    // Bootstrap supplies the driver factory, not a page source: the host factory owns
    // the raw BrowserHost and therefore supplies the pages, so `BrowserSessionHost`
    // never has to grow `start`/`openPage`.
    const demandBrowserFlowFactory = (): BrowserArticleFlowFactory | null => {
      if (!browserEnabled) return null;
      if (!agents || !agents.readiness("browser").configured) return null;
      return (pages) =>
        createBrowserArticleFlow({
          onSession: (
            execution: BrowserArticleExecution,
            request: BrowserDeliveryRequest,
          ) => {
            const identity = execution.identity;
            if (browserSessions.has(identity.session_id))
              throw new Error("duplicate Browser session");
            browserSessions.set(identity.session_id, {
              request,
              execution,
              target: {
                article_id: identity.literature_id,
                identifier: request.identifier,
                version: request.version,
                session_id: identity.session_id,
              },
              batch: new BrowserCaptureBatch(1),
              closed: false,
            });
            browserScheduler.attach(execution, request.signal);
          },
          onNetworkEnded: (identity, outcome) =>
            browserScheduler.networkEnded(identity.session_id, outcome),
          candidateSource: (identity: BrowserArticleSessionIdentity) => {
            const state = browserSessions.get(identity.session_id);
            if (!state)
              throw new Error("Browser candidate source is unavailable");
            return {
              hasCandidate: () => state.batch.hasCandidate(),
              next: (signal: AbortSignal) => state.batch.next(signal),
            };
          },
          pages: {
            openPage: async (request: BrowserDeliveryRequest) => {
              const identity = request.session_identity;
              const state = identity
                ? browserSessions.get(identity.session_id)
                : undefined;
              if (!state)
                throw new Error(
                  "Browser session was not registered before opening",
                );
              let opened;
              try {
                opened = await pages.openPage(request);
              } catch (error) {
                state.closed = true;
                state.batch.close();
                browserSessions.delete(state.target.session_id);
                throw error;
              }
              return {
                ...opened,
                close: async () => {
                  state.closed = true;
                  const failures: unknown[] = [];
                  try {
                    await opened.close();
                  } catch (error) {
                    failures.push(error);
                  }
                  const runtime = currentExecution();
                  for (const item of state.batch.close()) {
                    try {
                      await runtime?.abandonment.abandon(
                        {
                          article_id: state.target.article_id,
                          transfer_id: item.candidate.transfer_id,
                          sha256: item.candidate.sha256,
                        },
                        new AbortController().signal,
                      );
                    } catch (error) {
                      failures.push(error);
                    }
                  }
                  browserSessions.delete(state.target.session_id);
                  if (failures.length)
                    throw new AggregateError(
                      failures,
                      "Browser session cleanup failed",
                    );
                },
              };
            },
          },
          decide: undefined,
          capability: browserAgentCapability!,
          ...(options.browserCollaboration
            ? { collaboration: options.browserCollaboration }
            : {}),
          ...BROWSER_FLOW_BUDGET,
          observations: new BrowserObservationStore(),
          session_id: `browser-flow-${bootId}`,
          abandonCandidate: async (candidate, signal: AbortSignal) => {
            const runtime = currentExecution();
            const articleId = candidate.capture?.article_id;
            if (!runtime || !articleId) return;
            await runtime.abandonment.abandon(
              {
                article_id: articleId,
                transfer_id: candidate.transfer_id,
                sha256: candidate.sha256,
              },
              signal,
            );
          },
          // Only legacy low-level flow seams consume this fallback; production
          // always selects the per-session source registered before page creation.
          awaitCandidate: async () => null,
        });
    };
    const demandBrowserHost = (): BrowserSessionHost | null => {
      if (closing !== undefined) return null;
      if (!browserEnabled) return null;
      if (browserSessionHost) return browserSessionHost;
      // `browserHost()` is the public, process-owned demand surface the acquisition tier
      // consumes, so it fails closed on exactly the admission the registry reports:
      // without a Network-owned navigation admission (or without a verified runtime) this
      // process cannot deliver, and demanding a host must not construct one that can only
      // be refused later. An injected host factory is an explicit test/operator seam for
      // host *construction*; it is never an exemption from navigation admission, so the
      // synthetic owner tests inject an identity admission instead of relying on it.
      if (!browserRuntimeAvailable) return null;
      if (browserHostResolution.availability !== "available") return null;
      try {
        const owned = browserHostResolution.create();
        const open = owned.openArticle?.bind(owned);
        browserSessionHost = open
          ? Object.freeze({
              deliverCandidate: (request: BrowserDeliveryRequest) =>
                browserScheduler.deliver(request, open),
              openArticle: open,
              ...(owned.applyAction
                ? { applyAction: owned.applyAction.bind(owned) }
                : {}),
              close: () => owned.close(),
            })
          : owned;
      } catch {
        // An admitted tier whose runtime cannot actually be built stays stably
        // unavailable: the caller reports a Browser failure instead of aborting the
        // target with an internal error.
        return null;
      }
      return browserSessionHost;
    };
    const browserAdmission: BrowserRouteAdmission | undefined = browserEnabled
      ? Object.freeze({
          enabled: true,
          controlled_delivery: browserControlledDelivery,
          unavailable_reason: browserRuntimeAvailable
            ? null
            : ("browser-runtime-unavailable" as const),
        })
      : undefined;
    const acquisition = assemblePublicAcquisitionRegistry(
      configuration,
      networkBudget,
      {
        ...(options.acquisitionAssembly ?? options.metadataAssembly ?? {}),
        currentCredential:
          options.acquisitionAssembly?.currentCredential ??
          options.metadataAssembly?.currentCredential ??
          ((request) => configurationOwner.authorizeCurrentCredential(request)),
        credentials,
        ...(browserAdmission ? { browser_admission: browserAdmission } : {}),
      },
    );
    const logger = createLogger("application");
    agentTraces = new AgentTraceService(database);
    await agentTraces.initialize();
    agents = new DshAgentRuntime(
      buildAgentBindings(
        configuration,
        credentials,
        networkBudget,
        (request) => configurationOwner.authorizeCurrentCredential(request),
        (namespace, provider, field) =>
          configurationOwner.hasCurrentCredential(namespace, provider, field),
        options.agentTransportFactory,
      ),
      agentTraces,
    );
    browserAgentCapability = createBrowserCapability(agents);
    // Translation binds the model a reader picks, without traces: selected text
    // and its translation never enter the catalog (ADR 0049 §4).
    translationCache = new TranslationCache(
      join(home, ".sciretriever", "cache", "translations.sqlite"),
    );
    const translation = new TranslationService({
      models: Object.keys(configuration.models).filter(
        (reference) =>
          agentModel(configuration, "translation", reference) !== null,
      ),
      defaultModel: configuration.analyze.model,
      cache: translationCache,
      runtime: (reference) => {
        let runtime = translationRuntimes.get(reference);
        if (!runtime) {
          const model = agentModel(configuration, "translation", reference);
          let bindings: readonly AgentBinding[] = [];
          try {
            if (model)
              bindings = buildAgentBindings(
                configuration,
                credentials,
                networkBudget,
                (request) =>
                  configurationOwner.authorizeCurrentCredential(request),
                (namespace, provider, field) =>
                  configurationOwner.hasCurrentCredential(
                    namespace,
                    provider,
                    field,
                  ),
                options.agentTransportFactory,
                [model],
              );
          } catch {
            // A model without its startup credential stays unavailable.
          }
          runtime = new DshAgentRuntime(bindings);
          translationRuntimes.set(reference, runtime);
        }
        return runtime;
      },
    });
    await options.afterStage?.("agents");
    const artifactReclaimer = new ArtifactReclaimer(
      files.root,
      database,
      writes,
    );
    const artifactRecovery = new ArtifactRecovery(
      files,
      artifactReclaimer,
      writes,
    );
    let jobs: ExecutionRepository | null = null;
    let queue: ExecutionQueue | null = null;
    let jobService: ExecutionJobService | null = null;
    let taskService: ExecutionTaskService | null = null;
    let interventions: InterventionService | null = null;
    {
      const runtime = await database.inspectExecutionRuntime();
      if (!runtime.migrated) throw new Error("execution-runtime-integrity");
      jobs = new ExecutionRepository(database, admission);
      queue = new ExecutionQueue(jobs);
      interventions = new InterventionService(jobs, admission);
      const transfers = new BrowserTransferCollector(files, database);
      const publisher = new CandidatePublisher(transfers, database);
      const executionValue: NonNullable<Application["execution"]> = {
        transfers,
        publisher,
        acceptance: new CandidateAcceptanceService(
          database,
          transfers,
          publisher,
        ),
        abandonment: new CandidateAbandonmentService(
          database,
          transfers,
          artifactRecovery,
          writes,
        ),
      };
      execution = executionValue;
      executionBox.current = executionValue;
    }
    const literatureArtifacts = new LiteratureArtifactService(database, files);
    let parsingPorts = options.parsing;
    if (options.typescriptParserRuntime) {
      const parser = new MinerUParser(
        options.typescriptParserRuntime.transport,
        {
          baseUrl: options.typescriptParserRuntime.baseUrl,
          modelIdentity: options.typescriptParserRuntime.modelIdentity,
        },
      );
      parsingPorts = {
        rawParser: parser,
      };
    }
    if (!parsingPorts && !options.parsing) {
      if (
        configuration.parsing.connection_mode === "loopback" &&
        configuration.parsing.base_url &&
        configuration.parsing.model_identity
      ) {
        try {
          const parser = new MinerULoopbackParser({
            baseUrl: configuration.parsing.base_url,
            modelIdentity: configuration.parsing.model_identity,
            coordinator: networkBudget,
          });
          parsingPorts = {
            rawParser: parser,
          };
        } catch (error) {
          if (!(error instanceof ParsingFailure)) throw error;
        }
      }
      parsingPorts ??=
        assembleConfiguredTypeScriptParser(
          configuration,
          credentials,
          (request) => configurationOwner.authorizeCurrentCredential(request),
          networkBudget,
          options.metadataAssembly?.resolver,
          options.metadataAssembly?.connection,
          options.mineruTransportFactory,
        ) ?? undefined;
    }
    const scheduleDocumentIndex = async () => {
      if (!indexRefresh) throw new Error("index-unavailable");
      return indexRefresh.schedule();
    };
    {
      rawParseStorage = new SqliteRawParseStorage(
        database,
        files,
        scheduleDocumentIndex,
      );
      if (parsingPorts?.rawParser)
        rawParsing = new RawParsingService(
          {
            asset: (id) => database!.getAsset(id),
            currentFacts: (id) => database!.currentFacts(id),
            withArtifact: (asset, consume, readOptions) =>
              literatureArtifacts.withArtifact(asset, consume, readOptions),
            inspectPdf: (bytes, signal) => acceptPdf(bytes, 10000, signal),
          },
          parsingPorts.rawParser,
          rawParseStorage,
          configuration.parsing.archive_profile,
        );
    }
    if (rawParseStorage) {
      const proofreadStorage = new SqliteProofreadStorage(
        database,
        files,
        scheduleDocumentIndex,
      );
      const pages =
        options.proofreadPages ??
        pdfPages(
          database,
          files,
          proofreadStorage,
          async () => {
            if (!regionRenderer) {
              const runtime =
                verifiedBrowserRuntime ??
                (await resolveVerifiedCloakRuntime(
                  process.env.SCIRETRIEVER_CLOAK_BUNDLE,
                ));
              if (!runtime) throw new Error("proofread-renderer-unavailable");
              regionRenderer = new PdfRegionRenderer(runtime.executablePath);
            }
            return regionRenderer;
          },
          async () => {
            if (!pageImages) {
              const runtime = await resolveMupdfRuntime();
              if (!runtime) throw new Error("proofread-renderer-unavailable");
              pageImages = new MupdfPageRenderer(runtime);
            }
            return pageImages;
          },
        );
      draftDocuments = new DraftPublicationService(
        database,
        files,
        rawParseStorage,
        pages,
        scheduleDocumentIndex,
      );
      archiveText = new ArchiveTextPipeline(
        new SqliteArchiveTextStorage(database, files, scheduleDocumentIndex),
        rawParseStorage,
        pages,
        agents,
        configuration.parsing.archive_profile,
        async () => {
          if (!indexRefresh) throw new Error("index-unavailable");
          return indexRefresh.schedule();
        },
        configuration.proofread.max_concurrent_pages,
      );
      proofreading = new ProofreadService(
        rawParseStorage,
        proofreadStorage,
        pages,
        null,
        configuration.parsing.archive_profile,
      );
    }
    proofreadDocuments = new ProofreadDocumentService(
      database,
      files,
      async () => {
        if (!indexRefresh) throw new Error("index-unavailable");
        return indexRefresh.schedule();
      },
    );
    structureAnnotations = new StructureAnnotationService(
      new SqliteDocumentStorage(database, files),
      new SqliteAnnotationStorage(database, files),
      dshSectionClassifier(agents),
    );
    documentProcessing = new DocumentProcessingService(
      database,
      rawParsing ?? null,
      draftDocuments ?? null,
    );
    documentRead = new DocumentReadService(
      database,
      new SqliteDocumentStorage(database, files),
      new SqliteAnnotationStorage(database, files),
    );
    valueVerifier = new ProcessorValueVerifier(documentRead);
    const library = new LiteratureQueryService(database);
    articleIdentity = new ArticleIdentityService(
      documentRead,
      library,
      agents,
      database,
      new LiteratureArticleIdentityService(library, database),
    );
    {
      processorRead = new SqliteProcessorStorage(database, files, documentRead);
      processorService = new ProcessorService(
        createProcessorRegistry(),
        documentRead,
        agents,
        library,
        processorRead,
        new ProcessorArchiveSource(
          new ArchiveReader(database),
          new SnapshotService(database, library),
          new SqliteAnnotationStorage(database, files),
          documentRead,
        ),
        valueVerifier,
        (progress) => recordMapProgress(database!, progress),
      );
    }
    extractionPreparation = new ExtractionPreparationService(
      documentRead,
      library,
    );
    extractionDelivery = new ExtractionDeliveryService(database, documentRead);
    if (processorRead)
      processorRetention = new ProcessorExternalRetention(
        extractionDelivery,
        processorRead,
      );
    // Full-generation validation can occupy a worker synchronously. Keep its
    // generation/repair state on one dedicated worker, sharing business admission.
    indexDatabase = new SqliteWorker(catalogPath, writes, {
      maxTags: configuration.tags.max_per_literature,
      archiveProfile: configuration.parsing.archive_profile,
    });
    retrievalIndex = new RetrievalIndexService(
      new RetrievalStorageClient(indexDatabase),
      documentRead,
      library,
      writes,
    );
    const refreshState = new RetrievalStorageClient(database);
    indexRefresh = new IndexRefreshService(
      catalogPath,
      retrievalIndex,
      () => refreshState.revision(),
      options.indexRefreshIntervalMs === null
        ? undefined
        : {
            inspect: () => refreshState.state(),
            interval_ms: options.indexRefreshIntervalMs ?? 5000,
          },
      () => refreshState.active(),
    );
    await indexRefresh.start();
    // One process-wide acquisition port, built here and shared by every caller: the
    // CLI, the durable job runtime and any future frontend must not assemble their own
    // isolated acquisition loop. The completion orchestration is constructed later,
    // once `completion`/`rawParsing` exist, so it cannot capture a
    // half-built graph.
    if (execution) {
      pdfAcquisition = new EntryPdfAcquisitionService({
        registry: acquisition,
        network_budget: networkBudget,
        acquisition_options: {
          network: configuration.network,
          credentials,
          currentCredential:
            configurationOwner.authorizeCurrentCredential.bind(
              configurationOwner,
            ),
        },
        transfers: execution.transfers,
        acceptance: execution.acceptance,
        // The Browser tier is the same owned session the Application exposes, reached
        // lazily so an idle acquisition never starts one.
        browser_host: () => demandBrowserHost(),
        browser_scheduler: browserScheduler,
        ...(configuration.sources.publisher_aliases
          ? { publisher_aliases: configuration.sources.publisher_aliases }
          : {}),
      });
    }
    if (execution)
      manualPdf = new ManualPdfIngestionService(library, () => importSessions!);
    if (execution && rawParseStorage)
      completion = new LiteratureCompletionService(
        library,
        database,
        execution.acceptance,
        documentProcessing,
        rawParseStorage,
        configuration.parsing.archive_profile,
      );
    // Explicit completion may acquire a missing PDF, then stop at the raw parser boundary.
    if (execution)
      databaseCompletion = new DatabaseCompletionService({
        library,
        database,
        writes,
        max_concurrency: configuration.execution.max_concurrency,
        automatic_pdf_for_parsing: true,
        completion: completion ?? null,
        acquisition: pdfAcquisition,
      });
    if (jobs && databaseCompletion)
      jobService = new ExecutionJobService(
        jobs,
        databaseCompletion,
        library,
        writes,
      );
    if (jobs && queue && interventions && databaseCompletion)
      taskService = new ExecutionTaskService(jobs, queue, interventions, {
        completion: databaseCompletion,
      });
    const tags = new TagService(
      database,
      new SqliteDocumentStorage(database, files),
      new SqliteAnnotationStorage(database, files),
      new LiteratureMetadataService(database),
      await dshTagModel(agents),
      configuration.tags,
    );
    const metadataFields = new LiteratureMetadataService(database);
    const archiveReferences = new ArchiveReferenceService(
      database,
      new SqliteAnnotationStorage(database, files),
    );
    const archiveMetadata = new ArchiveMetadataService(
      database,
      metadataFields,
      new SqliteDocumentStorage(database, files),
      new SqliteAnnotationStorage(database, files),
      dshMetadataProposer(agents),
      new SqliteArchiveTextStorage(database, files),
    );
    const parser = documentProcessing;
    const archiveOrchestrator = new ArchiveOrchestrator(database, {
      ...(archiveText ? { text: archiveText } : {}),
      archiveProfile: configuration.parsing.archive_profile,
      parse: async (input, signal) => {
        try {
          const receipt = await parser.parseDocuments(
            {
              literature_id: input.literature_id,
              asset_id: input.asset_id,
              asset_sha256: input.asset_sha256,
              profiles: [input.profile],
              force: false,
            },
            signal,
          );
          const result = receipt.profiles.find(
            (p) => p.profile === input.profile,
          );
          return {
            receipt,
            failure_code:
              result && result.status !== "failed"
                ? null
                : (result?.failure_code ?? "parse-failed"),
          };
        } catch (error) {
          return {
            receipt: null,
            failure_code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "parse-failed",
          };
        }
      },
      proofread: proofreading!,
      documents: proofreadDocuments,
      structure: structureAnnotations,
      metadata: archiveMetadata,
      references: archiveReferences,
      tags,
      metadataFields,
      method_sha256: await sha256(
        canonicalJsonBytes({
          method: "archive-arrange-v2",
          proofread: { model: configuration.proofread.model },
          models: configuration.models,
          analyze: configuration.analyze,
          tags: configuration.tags,
        }),
      ),
    });
    const observations = new ObservationRepository(database);
    if (jobs && queue)
      processingTasks = new ProcessingTaskService(
        jobs,
        queue,
        {
          archive: archiveOrchestrator,
          tags,
          documents: documentProcessing,
          identity: articleIdentity,
          metadata: {
            execute: (request, signal, jobId, targetId) =>
              executeMetadataTask(
                {
                  registry: metadata,
                  identity,
                  library,
                  repository: jobs!,
                  topic: topicDiscovery,
                  citations: citationDiscovery,
                },
                request,
                signal,
                jobId,
                targetId,
              ),
          },
          ...(processorService && processorRead
            ? {
                processors: processorRuntime(
                  processorService,
                  processorRead,
                  jobs,
                ),
              }
            : {}),
        },
        taskService,
        bootId,
        configuration.execution.max_concurrency,
      );
    if (processorService && processorRead && jobs && processingTasks)
      processors = new ProcessorBatchService(
        processorService,
        processorRead,
        jobs,
        processingTasks,
      );
    const references = new ReferenceRepository(database);
    const metadata = options.metadata
      ? buildMetadataRegistry(options.metadata)
      : assembleMetadataRegistry(configuration, credentials, networkBudget, {
          ...(options.metadataAssembly ?? {}),
          currentCredential:
            options.metadataAssembly?.currentCredential ??
            ((request) =>
              configurationOwner.authorizeCurrentCredential(request)),
        });
    const identity = new LiteratureIdentityService(database, writes);
    const folders = new FolderService(database);
    importSessions = new ImportSessionService(
      database,
      identity,
      folders,
      files,
      writes,
      artifactRecovery,
      options.importSessions,
    );
    if (options.importSessions?.maintain === true)
      void importSessions
        .sweep()
        .catch(() => logger.warn("Import recovery failed"));
    const topicDiscovery = new TopicDiscoveryService(
      metadata.service,
      identity,
      observations,
      database,
    );
    const citationDiscovery = new CitationDiscoveryService(
      metadata.service,
      identity,
      observations,
      references,
      database,
    );
    await database.schema();
    let executionRecovery: Application["executionRecovery"] = null;
    let recoveryLease: Awaited<
      ReturnType<typeof acquireExecutionRuntime>
    > | null = null;
    try {
      recoveryLease = await acquireExecutionRuntime(catalogPath);
    } catch (error) {
      if (
        !(
          error instanceof WriteAdmissionError &&
          error.code === "write-admission-conflict"
        )
      )
        throw error;
    }
    try {
      if (recoveryLease) await artifactRecovery.recover();
      if (recoveryLease && queue && execution) {
        const recovered = await queue.recover(bootId);
        const publications = await execution.publisher.reconcile();
        executionRecovery = {
          recovered_attempts: recovered.recovered_attempts,
          recovered_targets: recovered.recovered_targets,
          recovered_jobs: recovered.recovered_jobs,
          released_leases: recovered.released_leases,
          expired_interventions: recovered.expired_interventions,
          reconciled_publications: publications.length,
        };
      }
    } finally {
      await recoveryLease?.release();
    }
    const effectiveAcquisitionRoutes = () =>
      configuredAcquisitionRoutes(
        configuration,
        bundlePreview(credentials),
      ).map((route) => {
        const status = acquisition.statuses.find(
          (s) => s.source_name === route.source,
        );
        const { unavailable_code: _code, ...base } = route;
        void _code;
        return {
          ...base,
          ready: status?.ready ?? false,
          ...(status?.ready
            ? {}
            : {
                unavailable_code:
                  status?.failure_code ?? "missing-source-adapter",
              }),
        };
      });
    const protect = <T extends object>(
      value: T | null,
      methods: readonly (keyof T)[],
    ): T | null =>
      value ? guardRuntimeMethods(value, methods, admission) : null;
    const application: Application = {
      capture: guardRuntimeMethods(
        (capture = new CaptureService(
          database,
          identity,
          folders,
          async (literatureId, captureId, signal) => {
            if (!metadata.lookup_selection.length || !processingTasks)
              return {
                status: "unavailable",
                job_id: null,
                code: "metadata-unavailable",
              };
            try {
              const result = await runMetadataTask(
                application,
                {
                  kind: "lookup",
                  literature_ids: [literatureId],
                  scan_limit: 1,
                },
                signal,
                `web-capture-${captureId}`,
              );
              return {
                status:
                  "status" in result && result.status === "COMPLETED"
                    ? "completed"
                    : "status" in result && result.status === "PARTIAL"
                      ? "partial"
                      : "failed",
                job_id: result.job_id,
                code:
                  "status" in result && result.status !== "COMPLETED"
                    ? "metadata-source-failed"
                    : null,
              };
            } catch {
              return {
                status: "failed",
                job_id: null,
                code: "metadata-task-failed",
              };
            }
          },
          options.capture,
        )),
        ["save"],
        admission,
      ),
      restartAdmission: admission,
      folders,
      importSessions: guardRuntimeMethods(
        importSessions,
        [
          "importBibliography",
          "create",
          "putData",
          "confirm",
          "confirmInBackground",
          "supplementPdf",
          "reportHash",
          "upload",
          "finish",
          "cancel",
        ],
        admission,
      ),
      marks: new MarkService(database, (id) => library.detail(id)),
      translation,
      fullTextTranslation: new FullTextTranslation({
        dir: join(home, ".sciretriever", "cache", "fulltext"),
        translation,
        source: async (literatureId, signal) => {
          const asset = (await library.detail(literatureId)).primary_pdf?.asset;
          const storage = archiveText?.storage;
          if (!asset || !storage) return null;
          const state = await storage.state(asset.asset_id, signal);
          if (!state.current) return null;
          const output = await storage.load(
            String(state.current.proofread_id),
            signal,
          );
          if (!output) return null;
          return {
            page_count: output.bundle.page_count,
            blocks: output.bundle.leaves.flatMap((l) =>
              l.destination.kind === "assigned"
                ? [
                    {
                      leaf_id: l.leaf.leaf_id,
                      type: l.leaf.type,
                      role: l.destination.target.role,
                      region: l.leaf.region,
                      page_index: l.leaf.page_index,
                      source: l.corrected_text ?? l.leaf.original_text,
                    },
                  ]
                : [],
            ),
          };
        },
      }),
      snapshots: new SnapshotService(database, library),
      archive: new ArchiveService(database, processingTasks, library),
      archiveText: archiveText ?? null,
      archiveArrangement: guardRuntimeMethods(
        new ArchiveArrangementAccess(
          new SqliteArchiveTextStorage(database, files, scheduleDocumentIndex),
          archiveText,
        ),
        ["edit", "save"],
        admission,
      ),
      tags,
      metadataFields,
      archiveReferences,
      archiveMetadata,
      bootId,
      metadata,
      acquisition,
      configurationStatus: (signal) =>
        configurationOwner.status(signal, effectiveAcquisitionRoutes()),
      configurationAcquisitionRoutes: (snapshot, signal) =>
        configurationOwner.acquisitionRoutes(
          snapshot,
          signal,
          effectiveAcquisitionRoutes(),
        ),
      discovery: guardRuntimeMethods(topicDiscovery, ["run"], admission),
      citations: guardRuntimeMethods(citationDiscovery, ["run"], admission),
      identity,
      completion: completion ?? null,
      maintenance: manualPdf
        ? guardRuntimeMethods<NonNullable<Application["maintenance"]>>(
            {
              ingestPdf: manualPdf.ingestPdf.bind(manualPdf),
              ingestPdfStream: manualPdf.ingestPdfStream.bind(manualPdf),
              parseDocuments:
                documentProcessing.parseDocuments.bind(documentProcessing),
              documentDefault: database.documentDefault.bind(database),
              rebuildIndex: indexRefresh.rebuild.bind(indexRefresh),
              refreshIndex: indexRefresh.refresh.bind(indexRefresh),
              scheduleIndexRefresh:
                indexRefresh.scheduleRefresh.bind(indexRefresh),
              scheduleIndexRebuild:
                indexRefresh.scheduleRebuild.bind(indexRefresh),
              verifyIndex: retrievalIndex.verify.bind(retrievalIndex),
              verifyCatalog: (signal) =>
                new RetrievalStorageClient(indexDatabase!).verifyCatalog(
                  signal,
                ),
              extraction: extractionDelivery,
            },
            [
              "ingestPdf",
              "ingestPdfStream",
              "parseDocuments",
              "rebuildIndex",
              "refreshIndex",
              "scheduleIndexRefresh",
              "scheduleIndexRebuild",
              "verifyIndex",
              "verifyCatalog",
            ],
            admission,
          )
        : null,
      indexRefreshStatus: () => indexRefresh!.status(),
      documentProcessing: guardRuntimeMethods(
        documentProcessing,
        ["parseDocuments"],
        admission,
      ),
      articleIdentity,
      processingTasks: processingTasks
        ? guardRuntimeMethods(
            processingTasks,
            ["submit", "run", "runResults", "control"],
            admission,
            (method, args) =>
              method === "control" &&
              ["pause", "cancel"].includes(String(args[1])),
          )
        : null,
      processors: protect(processors, ["submit", "rebuild"]),
      processorRetention: protect(processorRetention, ["retain"]),
      processorRead,
      documentRead,
      extractionPreparation,
      extractionDelivery: guardRuntimeMethods(
        extractionDelivery,
        ["create", "submit", "closeOperation", "cleanupExpired"],
        admission,
      ),
      artifactRecovery,
      writes,
      artifactReclaimer,

      rawParsing: rawParsing ?? null,
      proofreading: proofreading ?? null,
      proofreadDocuments,
      draftDocuments: draftDocuments!,
      structureAnnotations: structureAnnotations ?? null,
      rawParseStorage: rawParseStorage ?? null,
      literatureArtifacts,
      library,
      execution,
      publisherGovernance: guardRuntimeMethods(
        new PublisherGovernanceService(library, configurationOwner, agents),
        ["report"],
        admission,
      ),
      jobs,
      queue: protect(queue, ["recover", "resume"]),
      jobService: protect(jobService, ["create"]),
      taskService: protect(taskService, ["runJob"]),
      interventions,
      executionRecovery,
      pdfAcquisition: protect(pdfAcquisition, ["acquire", "acquireCohort"]),
      databaseCompletion: protect(databaseCompletion, ["run"]),
      browserHost: demandBrowserHost,
      home,
      configuration,
      configuration_revision: configurationSnapshot.revision,
      deviceConnections: new DeviceConnectionService(database),
      credentials,
      database,
      files,
      agents,
      browserCapability: browserAgentCapability,
      networkBudget,
      logger,
      observations,
      assets: new AssetRepository(database, files),
      references,
      close: closeApplication,
    };
    await options.afterStage?.("schema");
    return application;
  } catch (error) {
    try {
      await closeApplication();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "application startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
/**
 * Open the existing catalog for query only. This path never creates the home,
 * catalog, artifact root, schema, recovery tickets, or durable Jobs.
 */
export async function createQueryApplication(
  homeValue: string,
  options: QueryApplicationOptions = {},
): Promise<QueryApplication> {
  if (typeof homeValue !== "string" || !homeValue.startsWith("/"))
    throw new Error("query application operation failed");
  const home = resolve(homeValue);
  const unavailable = (): QueryApplication => ({
    readiness: {
      status: "unavailable",
      schema_version: null,
      schema_fingerprint: null,
    },
    query: null,
    literatureArtifacts: null,
    documentRead: null,
    extractionPreparation: null,
    context: null,
    knowledgeContext: null,

    close: async () => undefined,
  });
  let configuration: OrdinaryConfiguration;
  try {
    try {
      await lstat(join(home, ".sciretriever"));
      configuration = await loadConfiguration(home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      configuration = parseConfiguration("");
    }
  } catch {
    return unavailable();
  }
  const catalogPath =
    options.catalog_path ??
    configuration.paths.catalog_path ??
    join(home, "catalog.sqlite");
  const artifactRoot =
    options.artifact_root ??
    configuration.paths.artifact_root ??
    join(home, "artifacts");
  if (!catalogPath.startsWith("/") || !artifactRoot.startsWith("/"))
    return unavailable();
  let catalogStat;
  try {
    catalogStat = await lstat(catalogPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        readiness: {
          status: "not-initialized",
          schema_version: null,
          schema_fingerprint: null,
        },
        query: null,
        literatureArtifacts: null,
        documentRead: null,
        extractionPreparation: null,
        context: null,
        knowledgeContext: null,

        close: async () => undefined,
      };
    return unavailable();
  }
  if (!catalogStat.isFile() || catalogStat.isSymbolicLink())
    return unavailable();
  const database = new SqliteWorker(catalogPath, undefined, {
    readOnly: true,
    maxTags: configuration.tags.max_per_literature,
    archiveProfile: configuration.parsing.archive_profile,
  });
  let retrievalDatabase: SqliteWorker | undefined;
  let files: FileStore | undefined;
  let documentRead: DocumentReadService | null = null;
  let rawParseRead: SqliteRawParseStorage | null = null;
  let proofreadRead: ProofreadService | null = null;
  let proofreadRenderer: PdfRegionRenderer | undefined;
  let proofreadImages: MupdfPageRenderer | undefined;
  let extractionPreparation: ExtractionPreparationService | null = null;
  let context: MaterialContextService | null = null;
  let knowledgeContext: KnowledgeContextService | null = null;
  let processorRead: SqliteProcessorStorage | null = null;
  const importSessions = new ImportSessionReadService(database);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Publish the shared result before a resource callback can reenter close.
    closing ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const release of [
        () => importSessions.close(),
        async () => processorRead?.close(),
        async () => knowledgeContext?.close(),
        async () => context?.close(),
        async () => retrievalDatabase?.close(),
        async () => extractionPreparation?.close(),

        async () => documentRead?.close(),
        async () => proofreadRead?.close(),
        () => proofreadRenderer?.close(),
        () => proofreadImages?.close(),
        async () => rawParseRead?.close(),
        async () => files?.close(),
        () => database.close(),
      ]) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "query application cleanup failed");
    });
    return closing;
  };
  const closeAfterStartupFailure = async (error: unknown): Promise<void> => {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "query application startup and cleanup failed",
        { cause: error },
      );
    }
  };
  let preflight: Awaited<ReturnType<typeof database.queryPreflight>>;
  try {
    preflight = await database.queryPreflight();
  } catch (error) {
    await closeAfterStartupFailure(error);
    throwCatalogCorruption(error);
    return unavailable();
  }
  if (preflight.status === "not-initialized") {
    await close();
    return {
      readiness: {
        status: "not-initialized",
        schema_version: null,
        schema_fingerprint: null,
      },
      query: null,
      literatureArtifacts: null,
      documentRead: null,
      extractionPreparation: null,
      context: null,
      knowledgeContext: null,

      close,
    };
  }
  if (preflight.status !== "ready" || !preflight.schema) {
    await close();
    return unavailable();
  }
  try {
    files = new FileStore(artifactRoot);
    documentRead = new DocumentReadService(
      database,
      new SqliteDocumentStorage(database, files),
      new SqliteAnnotationStorage(database, files),
    );
    const literature = new LiteratureQueryService(database);
    rawParseRead = new SqliteRawParseStorage(database, files);
    if (rawParseRead) {
      const storage = new SqliteProofreadStorage(database, files);
      const pages =
        options.proofreadPages ??
        pdfPages(
          database,
          files,
          {
            read: (key, signal) => storage.read(key, signal),
            // Query rendering remains ephemeral; it never creates a cache row.
            save: async () => "",
          },
          async () => {
            if (!proofreadRenderer) {
              const runtime = await resolveVerifiedCloakRuntime(
                process.env.SCIRETRIEVER_CLOAK_BUNDLE,
              );
              if (!runtime) throw new Error("proofread-renderer-unavailable");
              proofreadRenderer = new PdfRegionRenderer(runtime.executablePath);
            }
            return proofreadRenderer;
          },
          async () => {
            if (!proofreadImages) {
              const runtime = await resolveMupdfRuntime();
              if (!runtime) throw new Error("proofread-renderer-unavailable");
              proofreadImages = new MupdfPageRenderer(runtime);
            }
            return proofreadImages;
          },
        );
      proofreadRead = new ProofreadService(rawParseRead, storage, pages);
    }
    extractionPreparation = new ExtractionPreparationService(
      documentRead,
      literature,
    );
    // Isolate retrieval candidate work from ordinary library/material reads;
    // share one bounded worker
    // between both retrieval services, never one worker per request.
    const retrievalStorage = new RetrievalStorageClient(
      (retrievalDatabase = new SqliteWorker(catalogPath, undefined, {
        readOnly: true,
        maxTags: configuration.tags.max_per_literature,
        archiveProfile: configuration.parsing.archive_profile,
      })),
    );
    context = new MaterialContextService(
      retrievalStorage,
      documentRead,
      literature,
    );
    processorRead = new SqliteProcessorStorage(database, files, documentRead);
    knowledgeContext = new KnowledgeContextService(context, processorRead);
    const identities = configuredAgentIdentity(configuration);
    const previewTags = new TagService(
      database,
      new SqliteDocumentStorage(database, files),
      new SqliteAnnotationStorage(database, files),
      new LiteratureMetadataService(database),
      null,
    );
    const archiveReuse = new ArchiveReusePreview(
      database,
      files,
      rawParseRead,
      previewTags,
      identities,
      await sha256(
        canonicalJsonBytes({
          method: "archive-arrange-v2",
          proofread: { model: configuration.proofread.model },
          models: configuration.models,
          analyze: configuration.analyze,
          tags: configuration.tags,
        }),
      ),
      configuration.parsing.archive_profile,
    );
    const estimating = new UsageEstimator(
      database,
      new ProcessorPlanner(
        createProcessorRegistry(),
        identities,
        new ProcessorArchiveSource(
          new ArchiveReader(database),
          new SnapshotService(database, literature),
          new SqliteAnnotationStorage(database, files),
          documentRead,
        ),
        {
          identity: () => valueVerificationIdentity(),
        },
      ),
      processorRead,
      literature,
      rawParseRead,
      previewTags,
      configuration.parsing.archive_profile,
      (state, signal) => archiveReuse.reusable(state, signal),
      await sha256(
        canonicalJsonBytes({
          method: "archive-arrange-v2",
          proofread: { model: configuration.proofread.model },
          models: configuration.models,
          analyze: configuration.analyze,
          tags: configuration.tags,
        }),
      ),
      (part, signal) => archiveReuse.textWork(part, signal),
    );
    return {
      importSessions,
      usageEstimate: (value, signal) => estimating.estimate(value, signal),
      readiness: {
        status: "ready",
        schema_version:
          typeof preflight.schema.schema_version === "number"
            ? preflight.schema.schema_version
            : null,
        schema_fingerprint:
          typeof preflight.schema.schema_fingerprint === "string"
            ? preflight.schema.schema_fingerprint
            : null,
      },
      reviewRead: (action, value) => database.review(action, value),
      processorRead,
      rawParseRead,
      archiveProfile: configuration.parsing.archive_profile,
      proofreadRead,
      annotationRead: new AnnotationReadService(
        new SqliteAnnotationStorage(database, files),
      ),
      folders: new FolderService(database),
      marks: new MarkService(database, (id) => literature.detail(id)),
      snapshots: new SnapshotService(database, literature),
      archive: new ArchiveReader(database),
      archiveArrangement: new ArchiveArrangementAccess(
        new SqliteArchiveTextStorage(database, files),
      ),
      tags: new TagService(
        database,
        new SqliteDocumentStorage(database, files),
        new SqliteAnnotationStorage(database, files),
        new LiteratureMetadataService(database),
        null,
      ),
      metadataFields: new LiteratureMetadataService(database),
      query: literature,
      tasks: createTaskReader(new ExecutionRepository(database)),
      taskRead: (jobId) =>
        readProcessingTask(new ExecutionRepository(database), jobId),
      articleIdentityRead: async (id) => {
        const assessment = await database.articleIdentity(id);
        if (!assessment) return null;
        const current = await database.currentArticleIdentity(
          assessment.literature_id,
          assessment.asset_id,
        );
        return {
          assessment,
          current: current?.assessment_id === assessment.assessment_id,
        };
      },
      literatureArtifacts: new LiteratureArtifactService(database, files),
      documentRead,
      extractionPreparation,
      context,
      knowledgeContext,
      indexRefreshStatus: () =>
        readIndexRefreshStatus(`${catalogPath}.index-refresh.json`, () =>
          retrievalStorage.active(),
        ),

      close,
    };
  } catch (error) {
    await closeAfterStartupFailure(error);
    return unavailable();
  }
}
function buildAgentBindings(
  configuration: OrdinaryConfiguration,
  credentials: CredentialBundle,
  networkBudget: NetworkBudgetCoordinator,
  authorizeCredential: CurrentCredentialReader,
  hasCredential: (
    namespace: "provider" | "model" | "core",
    provider: string,
    field: string,
  ) => Promise<boolean>,
  transportFactory?: ApplicationOptions["agentTransportFactory"],
  models: ReturnType<typeof configuredAgentModels> = configuredAgentModels(
    configuration,
  ),
): readonly AgentBinding[] {
  const bindings: AgentBinding[] = [];
  const adapters = new Map<string, AgentAdapter>();
  for (const {
    role,
    reference,
    providerName,
    modelName,
    provider,
    config,
  } of models) {
    const key = `${providerName}\u0000${reference}`;
    let adapter = adapters.get(key);
    if (!adapter) {
      const target = endpoint(provider.base_url, provider.api);
      const base = new URL(target);
      const origin = base.origin;
      const local = base.protocol === "http:";
      const startupCredential = bundlePreview(credentials).sections.find(
        (section) =>
          section.section === `providers.${providerName}` &&
          (local || section.origin === origin) &&
          section.fields.some(
            (field) => field.field === "api_key" && field.present,
          ),
      );
      if (local ? startupCredential !== undefined : !startupCredential)
        throw new CredentialBoundaryError();
      const scheme = local ? "http" : "https";
      const rawTransport =
        transportFactory?.(providerName, origin) ??
        createAgentTransport({
          egress: outboundEgress(
            configuration.network,
            { kind: "provider", id: providerName },
            credentials,
            authorizeCredential,
          ),
          resolver: async (hostname) =>
            (await lookup(hostname, { all: true })).map((item) => item.address),
          policy: {
            allowed_schemes: [scheme],
            allowed_classes: [local ? "loopback" : "public"],
            allowed_ports: [
              { scheme, port: Number(base.port || (local ? 80 : 443)) },
            ],
            ...(local
              ? {
                  allowed_addresses:
                    base.hostname === "localhost"
                      ? ["127.0.0.1", "::1"]
                      : [base.hostname.replace(/^\[|\]$/g, "")],
                }
              : {}),
          },
          coordinator: networkBudget,
          scope: "agent-model",
          limits: {
            maxConcurrency: Math.max(
              2,
              configuration.proofread.max_concurrent_pages,
            ),
            maxHostConcurrency: Math.max(
              2,
              configuration.proofread.max_concurrent_pages,
            ),
            maxResponseBytes: 4194304,
            maxRedirects: 0,
            maxRetries: 0,
          },
        });
      const transport: AgentTransport = (request) => {
        if (request.endpoint !== target)
          throw new AgentFailure("agent-configuration");
        return rawTransport(request).catch((error: unknown) => {
          if (error instanceof NetworkHttpError)
            throw new AgentFailure(
              error.reason === "timeout" ? "agent-timeout" : "agent-network",
              ["timeout", "request-failed", "response-incomplete"].includes(
                error.reason,
              ),
              { cause: error },
            );
          throw error;
        });
      };
      const adapterConfig = {
        provider: providerName,
        model: modelName,
        endpoint: target,
        credential: null,
        credentialProvider: async () => {
          if (local) {
            if (await hasCredential("model", providerName, "api_key"))
              throw new CredentialBoundaryError();
            return null;
          }
          try {
            const current = await authorizeCredential({
              namespace: "model",
              provider: providerName,
              field: "api_key",
              origin,
              operation: "model-request",
            });
            if (current === null) throw new CredentialBoundaryError();
            return current;
          } catch {
            throw new AgentFailure("agent-credentials");
          }
        },
        transport,
      };
      if (provider.api === "openai-responses")
        adapter = new OpenAIResponsesAdapter(adapterConfig);
      else if (provider.api === "openai-chat-completions")
        adapter = new OpenAIChatAdapter(adapterConfig);
      else adapter = new AnthropicMessagesAdapter(adapterConfig);
      adapters.set(key, adapter);
    }
    const capabilities: AgentCapability[] = [
      "structured_text",
      "tool_decision",
    ];
    if (config.image) capabilities.push("image_input");
    bindings.push({
      role,
      provider: providerName,
      model: modelName,
      capabilities,
      reasoning: config.reasoning,
      stream: config.stream,
      context_window_tokens: 1000000,
      max_output_tokens: 1000000,
      nonsecret_transport: {
        api: provider.api,
        endpoint: endpoint(provider.base_url, provider.api),
      },
      adapter,
    });
  }
  return bindings;
}
