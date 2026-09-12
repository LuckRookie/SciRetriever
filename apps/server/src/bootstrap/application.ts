import { LiteratureCompletionService } from "../entry/literature-completion.js";
import { randomUUID } from "node:crypto";
import { ArtifactRecovery } from "../storage/files/recovery.js";
import { NoUsableContentService } from "../entry/no-usable-content.js";
import {
  AnalysisService,
  AnalysisFailure,
  type AnalysisOptions,
  type AnalysisLimits,
} from "../analysis/service.js";
import { LiteratureContentService } from "../literature/content.js";
import { ArtifactReclaimer } from "../storage/files/reclamation.js";
import { LiteratureCleanupService } from "../literature/cleanup.js";
import { CatalogWriteAdmission } from "../storage/write-admission.js";
import { ContentAnalysisService } from "../entry/content-analysis.js";
import { MinerULoopbackParser } from "../parsing/backends/mineru/index.js";
import { TypeScriptParserArtifactRules } from "../parsing/artifact-rules.js";
import { ParsingFailure } from "../parsing/ports.js";
import { ParsingService } from "../parsing/service.js";
import {
  MinerUParser,
  type MinerUHttpTransport,
} from "../parsing/backends/mineru/index.js";
import { ImmutableParserPublisher } from "../parsing/publication.js";
import { acceptPdf } from "../acquisition/pdf-acceptance.js";
import type { ParserBackend, ParserArtifactRules } from "../parsing/ports.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import { CandidatePublisher } from "../acquisition/candidate-publication.js";
import { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { CandidateAbandonmentService } from "../acquisition/candidate-abandonment.js";
import { LiteratureQueryService } from "../literature/query.js";
import { LiteratureIdentityService } from "../literature/identity.js";
import { LiteratureArtifactService } from "../literature/artifacts.js";
import { mkdir } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { join, resolve } from "node:path";
import { type OrdinaryConfiguration } from "../configuration/index.js";
import {
  loadCredentialBundle,
  issueCredentialGrant,
  readCredential,
  bundlePreview,
  CredentialBoundaryError,
  type CredentialBundle,
} from "../configuration/credentials.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import { createLogger, type Logger } from "../logging/index.js";
import {
  AssetRepository,
  ObservationRepository,
  ReferenceRepository,
} from "../storage/sqlite/repositories.js";
import { SqliteWorker } from "../storage/sqlite/worker.js";
import { FileStore } from "../storage/files/store.js";
import { AgentRuntime, type AgentBinding } from "../agents/runtime.js";
import { OpenAIChatAdapter, OpenAIResponsesAdapter } from "../agents/openai.js";
import { AnthropicMessagesAdapter } from "../agents/anthropic.js";
import {
  AgentFailure,
  type AgentAdapter,
  type AgentCapability,
} from "../agents/protocol.js";
import type { AgentTransport } from "../agents/protocol.js";
import { createAgentTransport } from "../network/http.js";
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
import {
  assemblePublicAcquisitionRegistry,
  type PublicAcquisitionAssemblyOptions,
} from "../acquisition/assembly.js";
import type { PublicAcquisitionRegistry } from "../acquisition/sources/public.js";
import { ExecutionRepository } from "../storage/execution/repository.js";
import {
  ExecutionJobService,
  ExecutionQueue,
  ExecutionTaskService,
} from "../application/jobs/service.js";
import { InterventionService } from "../application/jobs/interventions.js";

export interface Application {
  readonly bootId: string;
  readonly metadata: MetadataRegistry;
  readonly acquisition: PublicAcquisitionRegistry;
  readonly discovery: TopicDiscoveryService;
  readonly citations: CitationDiscoveryService;
  readonly identity: LiteratureIdentityService;
  readonly completion: LiteratureCompletionService | null;
  readonly artifactRecovery: ArtifactRecovery;
  readonly noUsableContent: NoUsableContentService;
  readonly artifactReclaimer: ArtifactReclaimer;
  readonly writes: CatalogWriteAdmission;
  readonly literatureCleanup: LiteratureCleanupService;
  readonly contentAnalysis: ContentAnalysisService | null;
  readonly analysis: AnalysisService | null;
  readonly literatureContent: LiteratureContentService;
  readonly parsing: ParsingService | null;
  readonly literatureArtifacts: LiteratureArtifactService;
  readonly library: LiteratureQueryService;
  readonly home: string;
  readonly configuration: OrdinaryConfiguration;
  readonly credentials: CredentialBundle;
  readonly database: SqliteWorker;
  readonly files: FileStore;
  readonly agents: AgentRuntime;
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
  close(): Promise<void>;
}

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
  /** Optional timeout seam for the pure TypeScript Analysis owner. */
  readonly analysisRuntime?: Omit<AnalysisOptions, "limits">;
  /** Explicit TS parser seam; transport is injected by the Network owner. */
  readonly typescriptParserRuntime?: {
    readonly transport: MinerUHttpTransport;
    readonly baseUrl: string;
    readonly modelIdentity: string;
  };
  readonly parsing?: {
    readonly parser: ParserBackend;
    readonly rules: ParserArtifactRules;
  };
  /** Optional pure TypeScript owner instance for tests and shared frontends. */
  readonly configurationOwner?: TypeScriptConfigurationOwner;
  /** Explicit opt-in, restricted to synthetic/copy catalogs during migration. */
  readonly executionSchema?: "upgrade-synthetic" | "require-v2";
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
  coordinator: NetworkBudgetCoordinator,
  resolver?: Resolver,
  connection?: ConnectionDependencies,
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
  const grant = issueCredentialGrant(
    credentials,
    "core",
    "mineru",
    "bearer_token",
    origin,
    "parser-upload",
  );
  const token = readCredential(
    credentials,
    grant,
    "mineru",
    "bearer_token",
    origin,
    "parser-upload",
  );
  const parsed = new URL(config.base_url);
  const raw = createAgentTransport({
    resolver:
      resolver ??
      (async (hostname) =>
        (await lookup(hostname, { all: true })).map((item) => item.address)),
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
      allowed_ports: [{ scheme: "https", port: Number(parsed.port || 443) }],
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
  const transport: MinerUHttpTransport = {
    request: (url, options) =>
      raw({
        endpoint: url,
        headers: [
          ["accept", "application/json, application/zip"],
          ["authorization", `Bearer ${token}`],
          ...Object.entries(options.headers),
        ],
        body: options.body,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
  };
  return {
    parser: new MinerUParser(transport, {
      baseUrl: config.base_url,
      modelIdentity: config.model_identity,
    }),
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
  const configuration = (await configurationOwner.read()).configuration;
  await options.afterStage?.("configuration");
  const credentials = await loadCredentialBundle(home);
  await options.afterStage?.("credentials");
  let database: SqliteWorker | undefined;
  let files: FileStore | undefined;
  let agents: AgentRuntime | undefined;
  let parsing: ParsingService | undefined;
  let analysis: AnalysisService | undefined;
  let contentAnalysis: ContentAnalysisService | undefined;
  let completion: LiteratureCompletionService | undefined;
  const catalogPath =
    configuration.paths.catalog_path ?? join(home, "catalog.sqlite");
  const writes = new CatalogWriteAdmission(catalogPath);
  try {
    database = new SqliteWorker(catalogPath, writes);
    await options.afterStage?.("database");
    files = new FileStore(
      configuration.paths.artifact_root ?? join(home, "artifacts"),
      writes,
    );
    await options.afterStage?.("files");
    const networkBudget = new NetworkBudgetCoordinator();
    await options.afterStage?.("network");
    const acquisition = assemblePublicAcquisitionRegistry(
      configuration,
      networkBudget,
      {
        ...(options.acquisitionAssembly ?? options.metadataAssembly ?? {}),
        credentials,
      },
    );
    const logger = createLogger("application");
    agents = new AgentRuntime(
      buildAgentBindings(configuration, credentials, networkBudget),
    );
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
    let execution: Application["execution"] = null;
    let jobs: ExecutionRepository | null = null;
    let queue: ExecutionQueue | null = null;
    let jobService: ExecutionJobService | null = null;
    let taskService: ExecutionTaskService | null = null;
    let interventions: InterventionService | null = null;
    if (options.executionSchema === "upgrade-synthetic")
      await database.upgradeExecutionSchema();
    if (options.executionSchema !== undefined) {
      const runtime = await database.inspectExecutionRuntime();
      if (!runtime.migrated)
        throw new Error("execution runtime is unavailable");
      jobs = new ExecutionRepository(database);
      queue = new ExecutionQueue(jobs);
      interventions = new InterventionService(jobs);
      const transfers = new BrowserTransferCollector(files, database);
      const publisher = new CandidatePublisher(transfers, database);
      execution = {
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
          networkBudget,
          options.metadataAssembly?.resolver,
          options.metadataAssembly?.connection,
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
    const library = new LiteratureQueryService(database, files);
    if (jobs) jobService = new ExecutionJobService(jobs, library);
    const analysisConfigured =
      configuration.analyze.model !== null &&
      [
        configuration.analyze.metadata_max_output_tokens,
        configuration.analyze.content_max_output_tokens,
        configuration.analyze.max_input_bytes,
        configuration.analyze.max_chunk_bytes,
        configuration.analyze.max_chunk_count,
        configuration.analyze.max_total_llm_requests,
        configuration.analyze.max_total_output_tokens,
      ].every((value) => value !== null);
    if (options.analysisRuntime || analysisConfigured) {
      const a = configuration.analyze;
      const required = (value: number | null): number => {
        if (value === null) throw new AnalysisFailure("analysis-configuration");
        return value;
      };
      const limits: AnalysisLimits = {
        metadata_max_output_tokens: required(a.metadata_max_output_tokens),
        content_max_output_tokens: required(a.content_max_output_tokens),
        max_input_bytes: required(a.max_input_bytes),
        max_chunk_bytes: required(a.max_chunk_bytes),
        max_chunk_count: required(a.max_chunk_count),
        max_total_llm_requests: required(a.max_total_llm_requests),
        max_total_output_tokens: required(a.max_total_output_tokens),
      };
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
          limits,
        },
      );
    }
    const literatureContent = new LiteratureContentService(
      library,
      database,
      files,
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
      contentAnalysis = new ContentAnalysisService(
        analysis,
        literatureContent,
        noUsableContent,
      );
    if (execution && parsing && contentAnalysis)
      completion = new LiteratureCompletionService(
        library,
        database,
        execution.acceptance,
        parsing,
        contentAnalysis,
      );
    if (jobs && queue && interventions)
      taskService = new ExecutionTaskService(jobs, queue, interventions, {
        detail: (literatureId) => library.detail(literatureId),
        completion: completion ?? null,
      });
    const observations = new ObservationRepository(database);
    const references = new ReferenceRepository(database);
    const metadata = options.metadata
      ? buildMetadataRegistry(options.metadata)
      : assembleMetadataRegistry(
          configuration,
          credentials,
          networkBudget,
          options.metadataAssembly,
        );
    const identity = new LiteratureIdentityService(database, writes);
    await database.schema();
    await artifactRecovery.recover();
    let executionRecovery: Application["executionRecovery"] = null;
    if (queue && execution) {
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
      artifactRecovery,
      noUsableContent,
      writes,
      artifactReclaimer,
      literatureCleanup,
      contentAnalysis: contentAnalysis ?? null,
      analysis: analysis ?? null,
      literatureContent,
      parsing: parsing ?? null,
      literatureArtifacts,
      library,
      execution,
      jobs,
      queue,
      jobService,
      taskService,
      interventions,
      executionRecovery,
      home,
      configuration,
      credentials,
      database,
      files,
      agents,
      networkBudget,
      logger,
      observations,
      assets: new AssetRepository(database, files),
      references,
      close: async () => {
        await completion?.close();
        await contentAnalysis?.close();
        analysis?.close();
        parsing?.close();
        await writes.close();
        await closeResources(agents, files, database);
      },
    };
    await options.afterStage?.("schema");
    return application;
  } catch (error) {
    await completion?.close();
    await contentAnalysis?.close();
    analysis?.close();
    parsing?.close();
    await writes.close();
    await closeResources(agents, files, database);
    throw error;
  }
}

async function closeResources(
  agents: AgentRuntime | undefined,
  files: FileStore | undefined,
  database: SqliteWorker | undefined,
): Promise<void> {
  let firstError: unknown;
  try {
    agents?.close();
  } catch (error) {
    firstError ??= error;
  }
  try {
    await files?.close();
  } catch (error) {
    firstError ??= error;
  }
  try {
    await database?.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

function buildAgentBindings(
  configuration: OrdinaryConfiguration,
  credentials: CredentialBundle,
  networkBudget: NetworkBudgetCoordinator,
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
      let credential: string | null = null;
      if (local) {
        if (
          bundlePreview(credentials).sections.some(
            (section) =>
              section.section === `providers.${providerName}` &&
              section.fields.some((field) => field.present),
          )
        )
          throw new CredentialBoundaryError();
      } else {
        const grant = issueCredentialGrant(
          credentials,
          "model",
          providerName,
          "api_key",
          origin,
          "model-request",
        );
        credential = readCredential(
          credentials,
          grant,
          providerName,
          "api_key",
          origin,
          "model-request",
        );
      }
      const scheme = local ? "http" : "https";
      const rawTransport = createAgentTransport({
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
        return rawTransport(request);
      };
      const adapterConfig = {
        provider: providerName,
        model: modelName,
        endpoint: target,
        credential,
        transport,
      };
      if (provider.api === "openai-responses")
        adapter = new OpenAIResponsesAdapter(adapterConfig);
      else if (provider.api === "openai-chat-completions")
        adapter = new OpenAIChatAdapter(adapterConfig);
      else adapter = new AnthropicMessagesAdapter(adapterConfig);
      adapters.set(key, adapter);
    }
    const capabilities: AgentCapability[] = ["structured_text"];
    if (config.image) capabilities.push("image_input");
    if (role === "browser") capabilities.push("tool_decision");
    bindings.push({
      role,
      provider: providerName,
      model: modelName,
      capabilities,
      reasoning: config.reasoning,
      stream: config.stream,
      context_window_tokens: 1_000_000,
      max_output_tokens: 1_000_000,
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
