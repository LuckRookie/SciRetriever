import { ProcessorExternalRetention } from "../analysis/processor-external.js";
import {
  ProcessorBatchService,
  processorRuntime,
} from "../application/jobs/processors.js";
import { ProcessorService } from "../analysis/processor.js";
import { createProcessorRegistry } from "../analysis/processor-registry.js";
import { SqliteProcessorStorage } from "../storage/processor-results.js";
import { createTaskReader } from "../entry/task-read.js";
import { LiteratureCompletionService } from "../entry/literature-completion.js";
import { randomUUID } from "node:crypto";
import { ArtifactRecovery } from "../storage/files/recovery.js";
import { NoUsableContentService } from "../entry/no-usable-content.js";
import { ManualPdfIngestionService } from "../entry/manual-pdf.js";
import {
  AnalysisService,
  AnalysisFailure,
  type AnalysisOptions,
} from "../analysis/service.js";
import { LiteratureContentService } from "../literature/content.js";
import { ArtifactReclaimer } from "../storage/files/reclamation.js";
import { LiteratureCleanupService } from "../literature/cleanup.js";
import {
  CatalogWriteAdmission,
  WriteAdmissionError,
} from "../storage/write-admission.js";
import { acquireExecutionRuntime } from "../storage/execution/runtime-owner.js";
import { ContentAnalysisService } from "../entry/content-analysis.js";
import { MinerULoopbackParser } from "../parsing/backends/mineru/index.js";
import { TypeScriptParserArtifactRules } from "../parsing/artifact-rules.js";
import { ParsingFailure } from "../parsing/ports.js";
import { ParsingService } from "../parsing/service.js";
import {
  MinerUParser,
  createMinerUProtocolTransport,
  type MinerUHttpTransport,
} from "../parsing/backends/mineru/index.js";
import { ImmutableParserPublisher } from "../parsing/publication.js";
import { DocumentProcessingService } from "../document/service.js";
import { ArticleIdentityService } from "../parsing/article-identity.js";
import { LiteratureArticleIdentityService } from "../literature/article-identity.js";
import {
  ProcessingTaskService,
  readProcessingTask,
} from "../application/jobs/processing.js";
import { SqliteDocumentStorage } from "../document/storage.js";
import { DocumentReadService } from "../document/read.js";
import { KnowledgeAnalysisService } from "../analysis/knowledge.js";
import { KnowledgeSynthesisService } from "../analysis/synthesis.js";
import { SynthesisPreparationService } from "../analysis/synthesis-prepare.js";
import { SqliteKnowledgeStorage } from "../storage/knowledge.js";
import { SqliteSynthesisStorage } from "../storage/synthesis.js";
import { ExtractionPreparationService } from "../extraction/prepare.js";
import { ExtractionDeliveryService } from "../extraction/delivery.js";
import { RetrievalIndexService } from "../retrieval/index.js";
import { MaterialContextService } from "../retrieval/query.js";
import { KnowledgeRetrievalIndexService } from "../retrieval/knowledge-index.js";
import { KnowledgeContextService } from "../retrieval/knowledge-query.js";
import { RetrievalStorageClient } from "../storage/sqlite/retrieval-client.js";
import { acceptPdf } from "../acquisition/pdf-acceptance.js";
import type { ParserBackend, ParserArtifactRules } from "../parsing/ports.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import { BrowserCaptureBatch } from "../browser/capture-batch.js";
import { BrowserArticleScheduler } from "../entry/browser-scheduler.js";
import type {
  BrowserArticleExecution,
  BrowserArticleSessionIdentity,
} from "../browser/article-session.js";
import { CandidatePublisher } from "../acquisition/candidate-publication.js";
import { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { CandidateAbandonmentService } from "../acquisition/candidate-abandonment.js";
import { LiteratureQueryService } from "../literature/query.js";
import { LiteratureIdentityService } from "../literature/identity.js";
import { LiteratureArtifactService } from "../literature/artifacts.js";
import { lstat, mkdir } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { join, resolve } from "node:path";
import {
  loadConfiguration,
  effectiveBrowserConcurrency,
  parseConfiguration,
  type OrdinaryConfiguration,
} from "../configuration/index.js";
import {
  loadCredentialBundle,
  bundlePreview,
  CredentialBoundaryError,
  type CredentialBundle,
  type CurrentCredentialReader,
} from "../configuration/credentials.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import { createBrowserNetworkAdmission } from "../network/browser-admission.js";
import type { BrowserNetworkProxy } from "../network/browser-proxy.js";
import { createLogger, type Logger } from "../logging/index.js";
import {
  AssetRepository,
  ObservationRepository,
  ReferenceRepository,
} from "../storage/sqlite/repositories.js";
import { SqliteWorker } from "../storage/sqlite/worker.js";
import { FileStore } from "../storage/files/store.js";
import {
  DshAgentRuntime as AgentRuntime,
  type AgentBinding,
} from "../agents/runtime.js";
import { PublisherGovernanceService } from "../entry/publisher-governance.js";
import { OpenAIChatAdapter, OpenAIResponsesAdapter } from "../agents/openai.js";
import { AnthropicMessagesAdapter } from "../agents/anthropic.js";
import {
  AgentFailure,
  type AgentAdapter,
  type AgentCapability,
} from "../agents/protocol.js";
import type { AgentTransport } from "../agents/protocol.js";
import { createAgentTransport, NetworkHttpError } from "../network/http.js";
import type { ConnectionDependencies } from "../network/connection.js";
import type { Resolver } from "../network/policy.js";
import { TypeScriptConfigurationOwner } from "../configuration/owner.js";
import {
  buildMetadataRegistry,
  type MetadataRegistry,
} from "../metadata/registry.js";
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
  CitationDiscoveryService,
  TopicDiscoveryService,
} from "../entry/discovery.js";
import { DatabaseCompletionService } from "../entry/database-completion.js";
import {
  EntryPdfAcquisitionService,
  type PdfAcquisitionPort,
} from "../entry/pdf-acquisition.js";
import {
  assemblePublicAcquisitionRegistry,
  type BrowserRouteAdmission,
  type PublicAcquisitionAssemblyOptions,
} from "../acquisition/assembly.js";
import {
  resolveBrowserHost,
  type BrowserArticleFlow,
  type BrowserHostRuntimeSeam,
  type BrowserSessionHost,
} from "../browser/boundary.js";
import type { BrowserHostOptions } from "../browser/host.js";
import {
  DEFAULT_FLOW_DEADLINE_MS,
  DEFAULT_FLOW_MAX_MODEL_CALLS,
  createBrowserArticleFlow,
  flowUnavailable,
  type BrowserArticleFlowFactoryOptions,
} from "../browser/article-flow.js";
import { DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS } from "../browser/pacing.js";
import type {
  BrowserArticleFlowFactory,
  BrowserDeliveryRequest,
} from "../browser/boundary.js";
import { BrowserObservationStore } from "../browser/observation.js";
import {
  createBrowserCapability,
  type BrowserAgentCapability,
} from "../browser/decision.js";
import { BrowserCandidateIntake } from "../acquisition/browser-intake.js";
import {
  createProductionBrowserHostFactory,
  productionBrowserCapability,
  resolveVerifiedCloakRuntime,
} from "../browser/production-host.js";
import type { PublicAcquisitionRegistry } from "../acquisition/sources/public.js";
import { ExecutionRepository } from "../storage/execution/repository.js";
import {
  authorizeExecutionSchema,
  MigrationSafetyError,
} from "../storage/execution/migration-gate.js";
import {
  ExecutionJobService,
  ExecutionQueue,
  ExecutionTaskService,
} from "../application/jobs/service.js";
import { InterventionService } from "../application/jobs/interventions.js";

export interface Application {
  readonly processors?: ProcessorBatchService | null;
  readonly processorRetention?: ProcessorExternalRetention | null;
  readonly processorRead?: ProcessorReader | null;
  readonly articleIdentity?: ArticleIdentityService | null;
  readonly processingTasks?: ProcessingTaskService | null;
  readonly bootId: string;
  readonly metadata: MetadataRegistry;
  readonly acquisition: PublicAcquisitionRegistry;
  readonly discovery: TopicDiscoveryService;
  readonly citations: CitationDiscoveryService;
  readonly identity: LiteratureIdentityService;
  readonly completion: LiteratureCompletionService | null;
  readonly maintenance: {
    readonly ingestPdf: ManualPdfIngestionService["ingestPdf"];
    readonly parseDocuments: DocumentProcessingService["parseDocuments"];
    readonly documentDefault: SqliteWorker["documentDefault"];
    readonly rebuildIndex: RetrievalIndexService["build"];
    readonly rebuildKnowledgeIndex?: KnowledgeRetrievalIndexService["build"];
    readonly extraction: ExtractionDeliveryService;
    readonly analyze: KnowledgeAnalysisService["analyze"];
    readonly analyzeLong: KnowledgeAnalysisService["analyzeLong"];
    readonly synthesize?: KnowledgeSynthesisService["synthesize"];
  } | null;
  readonly documentProcessing: DocumentProcessingService;
  readonly documentRead: DocumentReadService;
  readonly extractionPreparation: ExtractionPreparationService;
  readonly extractionDelivery: ExtractionDeliveryService;
  readonly artifactRecovery: ArtifactRecovery;
  readonly noUsableContent: NoUsableContentService;
  readonly artifactReclaimer: ArtifactReclaimer;
  readonly writes: CatalogWriteAdmission;
  readonly literatureCleanup: LiteratureCleanupService;
  readonly contentAnalysis: ContentAnalysisService | null;
  readonly analysis: AnalysisService | null;
  readonly knowledgeAnalysis: KnowledgeAnalysisService;
  readonly synthesisAnalysis: KnowledgeSynthesisService | null;
  readonly synthesisPreparation: SynthesisPreparationService | null;
  readonly synthesisRead: SqliteSynthesisStorage | null;
  readonly literatureContent: LiteratureContentService;
  readonly parsing: ParsingService | null;
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
  readonly agents: AgentRuntime;
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
    "search" | "detail" | "references" | "referenceDetail"
  > | null;
  readonly literatureArtifacts: LiteratureArtifactService | null;
  readonly documentRead: DocumentReadService | null;
  readonly extractionPreparation: ExtractionPreparationService | null;
  readonly context: MaterialContextService | null;
  readonly knowledgeContext: KnowledgeContextService | null;
  readonly knowledgeRead: Pick<
    SqliteKnowledgeStorage,
    "byId" | "list" | "default"
  > | null;
  readonly synthesisRead: Pick<
    SqliteSynthesisStorage,
    "byId" | "sourceById" | "list"
  > | null;
  readonly synthesisPreparation: SynthesisPreparationService | null;
  close(): Promise<void>;
}
export interface QueryApplicationOptions {
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
  readonly metadata?: {
    readonly topic_search_ports?: readonly TopicSearchPort[];
    readonly lookup_ports?: readonly MetadataLookupPort[];
    readonly reference_query_ports?: readonly ReferenceQueryPort[];
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
  readonly analysisRuntime?: Omit<AnalysisOptions, "limits">;
  /** Explicit TS parser seam; transport is injected by the Network owner. */
  readonly typescriptParserRuntime?: {
    readonly transport: MinerUHttpTransport;
    readonly baseUrl: string;
    readonly modelIdentity: string;
  };
  /** Offline transport seam; remote credential resolution remains per request. */
  readonly mineruTransportFactory?: (origin: string) => MinerUHttpTransport;
  readonly parsing?: {
    readonly parser: ParserBackend;
    readonly rules: ParserArtifactRules;
  };
  /** Optional pure TypeScript owner instance for tests and shared frontends. */
  readonly configurationOwner?: TypeScriptConfigurationOwner;
  /** Offline socket seam; the real credential authorization boundary still runs. */
  readonly agentTransportFactory?: (
    provider: string,
    origin: string,
  ) => AgentTransport;
  /**
   * Explicit opt-in for the durable execution runtime. `"upgrade-synthetic"`
   * requests the v1 -> v2 upgrade and is only accepted for a target that the
   * migration safety gate independently verifies as a synthetic copy;
   * `"require-v2"` performs no write and refuses anything that is not already v2;
   * `"inspect"` only verifies a read-only target for migration dry-runs.
   */
  readonly executionSchema?: "upgrade-synthetic" | "require-v2" | "inspect";
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
  readonly parser: ParserBackend;
  readonly rules: ParserArtifactRules;
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
  return {
    parser: new MinerUParser(
      createMinerUProtocolTransport(transport, {
        baseUrl: config.base_url,
      }),
      {
        baseUrl: config.base_url,
        modelIdentity: config.model_identity,
      },
    ),
    rules: new TypeScriptParserArtifactRules(),
  };
}

export async function createApplication(
  homeValue: string,
  options: ApplicationOptions = {},
): Promise<Application> {
  if (typeof homeValue !== "string" || !homeValue.startsWith("/"))
    throw new Error("application operation failed");
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
  const configurationSnapshot = await configurationOwner.read();
  const configuration = configurationSnapshot.configuration;
  await options.afterStage?.("configuration");
  const credentials = await loadCredentialBundle(home);
  await options.afterStage?.("credentials");
  let database: SqliteWorker | undefined;
  let files: FileStore | undefined;
  let agents: AgentRuntime | undefined;
  let browserAgentCapability: BrowserAgentCapability | undefined;
  let parsing: ParsingService | undefined;
  let analysis: AnalysisService | undefined;
  let contentAnalysis: ContentAnalysisService | undefined;
  let completion: LiteratureCompletionService | undefined;
  let manualPdf: ManualPdfIngestionService | undefined;
  let pdfAcquisition: PdfAcquisitionPort | null = null;
  let execution: Application["execution"] = null;
  // Deferred callbacks must read the live execution context, but they are created
  // before it exists. They read this box instead, which is updated as soon as the
  // execution runtime is assembled; a direct read would also collapse to `never` under
  // control-flow analysis because the holder stays null until the first delivery.
  const executionBox: { current: Application["execution"] } = { current: null };
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
  let knowledgeAnalysis: KnowledgeAnalysisService | null = null;
  let synthesisAnalysis: KnowledgeSynthesisService | null = null;
  let synthesisPreparation: SynthesisPreparationService | null = null;
  let synthesisRead: SqliteSynthesisStorage | null = null;
  let processorRead: SqliteProcessorStorage | null = null;
  let articleIdentity: ArticleIdentityService | null = null;
  let processingTasks: ProcessingTaskService | null = null;
  let processorService: ProcessorService | null = null;
  let processorRetention: ProcessorExternalRetention | null = null;
  let processors: ProcessorBatchService | null = null;
  let extractionPreparation: ExtractionPreparationService | null = null;
  let extractionDelivery: ExtractionDeliveryService | null = null;
  let retrievalIndex: RetrievalIndexService | null = null;
  let knowledgeIndex: KnowledgeRetrievalIndexService | null = null;
  const catalogPath =
    configuration.paths.catalog_path ?? join(home, "catalog.sqlite");
  // Fail closed before the catalog is created or opened for writing.
  if (options.executionSchema !== undefined)
    await authorizeExecutionSchema(options.executionSchema, {
      catalog_path: catalogPath,
    });
  const networkBudget = new NetworkBudgetCoordinator();
  const writes = new CatalogWriteAdmission(catalogPath);
  let closing: Promise<void> | undefined;
  const closeApplication = (): Promise<void> => {
    // Publish the shared result before invoking any resource callback. This also
    // closes lazy Browser admission immediately, including during reentrant calls.
    closing ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      // Keep dependants before their stores and permits. A failed release must not
      // stop later owners from releasing resources or erase another cleanup error.
      const releases: readonly (() => void | Promise<void>)[] = [
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
        () => contentAnalysis?.close(),
        () => analysis?.close(),
        () => knowledgeAnalysis?.close(),
        () => synthesisAnalysis?.close(),
        () => synthesisPreparation?.close(),
        () => knowledgeIndex?.close(),
        () => synthesisRead?.close(),
        () => retrievalIndex?.close(),
        () => documentProcessing?.close(),
        () => extractionDelivery?.shutdown(),
        () => extractionPreparation?.close(),
        () => documentRead?.close(),
        () => parsing?.close(),
        () => networkBudget.close(),
        () => writes.close(),
        () => agents?.close(),
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
    database = new SqliteWorker(catalogPath, writes);
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
      const network = createBrowserNetworkAdmission({ budget: networkBudget });
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
                  maxRetryAfterMs: 86_400_000,
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
    agents = new AgentRuntime(
      buildAgentBindings(
        configuration,
        credentials,
        networkBudget,
        (request) => configurationOwner.authorizeCurrentCredential(request),
        (namespace, provider, field) =>
          configurationOwner.hasCurrentCredential(namespace, provider, field),
        options.agentTransportFactory,
      ),
    );
    browserAgentCapability = createBrowserCapability(agents);
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
    if (options.executionSchema === "upgrade-synthetic")
      await database.upgradeExecutionSchema();
    if (
      options.executionSchema === "upgrade-synthetic" ||
      options.executionSchema === "require-v2"
    ) {
      const runtime = await database.inspectExecutionRuntime();
      if (!runtime.migrated)
        throw new MigrationSafetyError("migration-target-v1");
      jobs = new ExecutionRepository(database);
      queue = new ExecutionQueue(jobs);
      interventions = new InterventionService(jobs);
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
      parsingPorts = {
        parser: new MinerUParser(options.typescriptParserRuntime.transport, {
          baseUrl: options.typescriptParserRuntime.baseUrl,
          modelIdentity: options.typescriptParserRuntime.modelIdentity,
        }),
        rules: new TypeScriptParserArtifactRules(),
      };
    }
    if (!parsingPorts && !options.parsing) {
      if (
        configuration.parsing.connection_mode === "loopback" &&
        configuration.parsing.base_url &&
        configuration.parsing.model_identity
      ) {
        try {
          parsingPorts = {
            parser: new MinerULoopbackParser({
              baseUrl: configuration.parsing.base_url,
              modelIdentity: configuration.parsing.model_identity,
              coordinator: networkBudget,
            }),
            rules: new TypeScriptParserArtifactRules(),
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
    if (parsingPorts)
      parsing = new ParsingService(
        {
          currentFacts: (id) => database!.currentFacts(id),
          withArtifact: (asset, consume, readOptions) =>
            literatureArtifacts.withArtifact(asset, consume, readOptions),
          inspectPdf: (bytes, signal) => acceptPdf(bytes, 10000, signal),
        },
        parsingPorts.parser,
        parsingPorts.rules,
        new ImmutableParserPublisher(database, files),
      );
    documentProcessing = new DocumentProcessingService(
      database,
      new SqliteDocumentStorage(database, files),
      parsingPorts?.rules ?? new TypeScriptParserArtifactRules(),
      parsing ?? null,
    );
    documentRead = new DocumentReadService(
      database,
      new SqliteDocumentStorage(database, files),
    );
    knowledgeAnalysis = new KnowledgeAnalysisService(
      documentRead,
      agents,
      new SqliteKnowledgeStorage(database, files, documentRead),
    );
    const library = new LiteratureQueryService(database, files);
    if ([9, 10].includes(Number((await database.schema()).schema_version)))
      articleIdentity = new ArticleIdentityService(
        documentRead,
        library,
        agents,
        database,
        new LiteratureArticleIdentityService(library, database),
      );
    if (
      [7, 8, 9, 10].includes(Number((await database.schema()).schema_version))
    ) {
      synthesisRead = new SqliteSynthesisStorage(database, files, documentRead);
      synthesisPreparation = new SynthesisPreparationService(
        documentRead,
        library,
        synthesisRead,
      );
      synthesisAnalysis = new KnowledgeSynthesisService(
        documentRead,
        agents,
        synthesisPreparation,
        synthesisRead,
      );
    }
    if ((await database.schema()).schema_version === 10 && synthesisRead) {
      processorRead = new SqliteProcessorStorage(
        database,
        files,
        documentRead,
        synthesisRead,
      );
      processorService = new ProcessorService(
        createProcessorRegistry(knowledgeAnalysis),
        documentRead,
        agents,
        library,
        processorRead,
        synthesisRead,
      );
    }
    extractionPreparation = new ExtractionPreparationService(
      documentRead,
      library,
    );
    extractionDelivery = new ExtractionDeliveryService(
      database,
      documentRead,
      extractionPreparation,
    );
    if (processorRead)
      processorRetention = new ProcessorExternalRetention(
        extractionDelivery,
        processorRead,
      );
    retrievalIndex = new RetrievalIndexService(
      new RetrievalStorageClient(database),
      documentRead,
      library,
      writes,
    );
    if (
      [8, 9, 10].includes(Number((await database.schema()).schema_version)) &&
      synthesisRead
    )
      knowledgeIndex = new KnowledgeRetrievalIndexService(
        new RetrievalStorageClient(database),
        synthesisRead,
        writes,
      );
    // One process-wide acquisition port, built here and shared by every caller: the
    // CLI, the durable job runtime and any future frontend must not assemble their own
    // isolated acquisition loop. The completion orchestration is constructed later,
    // once `completion`/`parsing`/`contentAnalysis` exist, so it cannot capture a
    // half-built graph.
    if (execution) {
      pdfAcquisition = new EntryPdfAcquisitionService({
        registry: acquisition,
        network_budget: networkBudget,
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
    const analysisConfigured = configuration.analyze.model !== null;
    if (options.analysisRuntime || analysisConfigured) {
      if (
        !agents.readiness("analysis").configured ||
        agents.readiness("analysis").missing.length
      )
        throw new AnalysisFailure("analysis-configuration");
      analysis = new AnalysisService(
        library,
        literatureArtifacts,
        files,
        agents,
        {
          ...(options.analysisRuntime ?? {}),
        },
      );
    }
    const literatureContent = new LiteratureContentService(
      library,
      database,
      files,
    );
    if (execution)
      manualPdf = new ManualPdfIngestionService(
        library,
        execution.transfers,
        execution.acceptance,
        execution.abandonment,
      );
    const literatureCleanup = new LiteratureCleanupService(database, files);
    const noUsableContent = new NoUsableContentService(
      literatureCleanup,
      database,
      artifactRecovery,
      writes,
      execution?.transfers,
    );
    if (analysis)
      contentAnalysis = new ContentAnalysisService(analysis, literatureContent);
    if (execution && parsing && contentAnalysis)
      completion = new LiteratureCompletionService(
        library,
        database,
        execution.acceptance,
        parsing,
        contentAnalysis,
      );
    // Construct the shared completion orchestration only now that `completion` is
    // final. Building it earlier would capture `completion: null` forever, so a
    // configured CONTENT_READY target would wrongly report
    // `content-completion-unavailable` even with Parsing and Analysis ready.
    if (execution)
      databaseCompletion = new DatabaseCompletionService({
        library,
        database,
        writes,
        max_concurrency: configuration.execution.max_concurrency,
        automatic_pdf_for_content: true,
        completion: completion ?? null,
        acquisition: pdfAcquisition,
      });
    if (jobs && databaseCompletion)
      jobService = new ExecutionJobService(jobs, databaseCompletion, library);
    if (jobs && queue && interventions && databaseCompletion)
      taskService = new ExecutionTaskService(jobs, queue, interventions, {
        completion: databaseCompletion,
      });
    const observations = new ObservationRepository(database);
    if (jobs && queue)
      processingTasks = new ProcessingTaskService(
        jobs,
        queue,
        {
          documents: documentProcessing,
          analysis: knowledgeAnalysis,
          synthesis: synthesisAnalysis,
          identity: articleIdentity,
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
    const application: Application = {
      bootId,
      metadata,
      acquisition,
      discovery: new TopicDiscoveryService(
        metadata.service,
        identity,
        observations,
        database,
      ),
      citations: new CitationDiscoveryService(
        metadata.service,
        identity,
        observations,
        references,
        database,
      ),
      identity,
      completion: completion ?? null,
      maintenance: manualPdf
        ? {
            ingestPdf: manualPdf.ingestPdf.bind(manualPdf),
            parseDocuments:
              documentProcessing.parseDocuments.bind(documentProcessing),
            documentDefault: database.documentDefault.bind(database),
            rebuildIndex: retrievalIndex.build.bind(retrievalIndex),
            ...(knowledgeIndex
              ? {
                  rebuildKnowledgeIndex:
                    knowledgeIndex.build.bind(knowledgeIndex),
                }
              : {}),
            extraction: extractionDelivery,
            analyze: knowledgeAnalysis.analyze.bind(knowledgeAnalysis),
            analyzeLong: knowledgeAnalysis.analyzeLong.bind(knowledgeAnalysis),
            ...(synthesisAnalysis
              ? {
                  synthesize:
                    synthesisAnalysis.synthesize.bind(synthesisAnalysis),
                }
              : {}),
          }
        : null,
      documentProcessing,
      articleIdentity,
      processingTasks,
      processors,
      processorRetention,
      processorRead,
      documentRead,
      extractionPreparation,
      extractionDelivery,
      artifactRecovery,
      noUsableContent,
      writes,
      artifactReclaimer,
      literatureCleanup,
      contentAnalysis: contentAnalysis ?? null,
      analysis: analysis ?? null,
      knowledgeAnalysis,
      synthesisAnalysis,
      synthesisPreparation,
      synthesisRead,
      literatureContent,
      parsing: parsing ?? null,
      literatureArtifacts,
      library,
      execution,
      publisherGovernance: new PublisherGovernanceService(
        library,
        configurationOwner,
        agents,
      ),
      jobs,
      queue,
      jobService,
      taskService,
      interventions,
      executionRecovery,
      pdfAcquisition,
      databaseCompletion,
      browserHost: demandBrowserHost,
      home,
      configuration,
      configuration_revision: configurationSnapshot.revision,
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
    knowledgeRead: null,
    synthesisRead: null,
    synthesisPreparation: null,
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
        knowledgeRead: null,
        synthesisRead: null,
        synthesisPreparation: null,
        close: async () => undefined,
      };
    return unavailable();
  }
  if (!catalogStat.isFile() || catalogStat.isSymbolicLink())
    return unavailable();

  const database = new SqliteWorker(catalogPath, undefined, {
    readOnly: true,
  });
  let files: FileStore | undefined;
  let documentRead: DocumentReadService | null = null;
  let extractionPreparation: ExtractionPreparationService | null = null;
  let context: MaterialContextService | null = null;
  let knowledgeContext: KnowledgeContextService | null = null;
  let knowledgeRead: SqliteKnowledgeStorage | null = null;
  let synthesisRead: SqliteSynthesisStorage | null = null;
  let processorRead: SqliteProcessorStorage | null = null;
  let synthesisPreparation: SynthesisPreparationService | null = null;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Publish the shared result before a resource callback can reenter close.
    closing ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const release of [
        async () => processorRead?.close(),
        async () => knowledgeContext?.close(),
        async () => context?.close(),
        async () => extractionPreparation?.close(),
        async () => knowledgeRead?.close(),
        async () => synthesisPreparation?.close(),
        async () => synthesisRead?.close(),
        async () => documentRead?.close(),
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
      knowledgeRead: null,
      synthesisRead: null,
      synthesisPreparation: null,
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
    );
    const literature = new LiteratureQueryService(database, files);
    extractionPreparation = new ExtractionPreparationService(
      documentRead,
      literature,
    );
    context = new MaterialContextService(
      preflight.schema.schema_version === 4 ||
      preflight.schema.schema_version === 5 ||
      preflight.schema.schema_version === 6 ||
      preflight.schema.schema_version === 7 ||
      [8, 9, 10].includes(Number(preflight.schema.schema_version))
        ? new RetrievalStorageClient(database)
        : null,
      documentRead,
      literature,
    );
    knowledgeRead =
      preflight.schema.schema_version === 6 ||
      preflight.schema.schema_version === 7 ||
      [8, 9, 10].includes(Number(preflight.schema.schema_version))
        ? new SqliteKnowledgeStorage(database, files, documentRead)
        : null;
    if (
      preflight.schema.schema_version === 7 ||
      [8, 9, 10].includes(Number(preflight.schema.schema_version))
    ) {
      synthesisRead = new SqliteSynthesisStorage(database, files, documentRead);
      synthesisPreparation = new SynthesisPreparationService(
        documentRead,
        literature,
        synthesisRead,
      );
    }
    if (preflight.schema.schema_version === 10 && synthesisRead)
      processorRead = new SqliteProcessorStorage(
        database,
        files,
        documentRead,
        synthesisRead,
      );
    if ([8, 9, 10].includes(Number(preflight.schema.schema_version)))
      knowledgeContext = new KnowledgeContextService(
        context,
        new RetrievalStorageClient(database),
        synthesisRead,
      );
    return {
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
      processorRead,
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
      knowledgeRead,
      synthesisRead,
      synthesisPreparation,
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
): readonly AgentBinding[] {
  const bindings: AgentBinding[] = [];
  const adapters = new Map<string, AgentAdapter>();
  const roleModels: readonly ["analysis" | "browser", string | null][] = [
    ["analysis", configuration.analyze.model],
    [
      "browser",
      configuration.browser.enabled ? configuration.browser.model : null,
    ],
  ];
  for (const [role, reference] of roleModels) {
    if (reference === null) continue;
    const providerName = reference.slice(0, reference.indexOf("/"));
    const modelName = reference.slice(reference.indexOf("/") + 1);
    const provider = configuration.providers[providerName];
    if (!provider) continue;
    const config = configuration.models[reference];
    if (!config) continue;
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
            maxConcurrency: 2,
            maxHostConcurrency: 2,
            maxResponseBytes: 4_194_304,
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
      context_window_tokens: 1_000_000,
      max_output_tokens: 1_000_000,
      nonsecret_transport: {
        api: provider.api,
        endpoint: endpoint(provider.base_url, provider.api),
      },
      adapter,
    });
  }
  return bindings;
}

function endpoint(baseUrl: string, api: string): string {
  const suffix =
    api === "openai-responses"
      ? "/responses"
      : api === "openai-chat-completions"
        ? "/chat/completions"
        : "/messages";
  const base = new URL(baseUrl);
  if (base.pathname.endsWith("/")) base.pathname = base.pathname.slice(0, -1);
  base.pathname = `${base.pathname}${suffix}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}
