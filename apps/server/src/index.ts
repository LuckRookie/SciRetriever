export {
  CatalogWriteAdmission,
  WriteAdmissionError,
  acquireCatalogWriteLock,
} from "./storage/write-admission.js";
export {
  LiteratureCleanupService,
  ContentCleanupFailure,
  type ContentCleanupRepository,
  type ContentCleanupCommand,
  type ContentCleanupSnapshot,
  type RetiredArtifact,
} from "./literature/cleanup.js";
export {
  ContentAnalysisService,
  ContentAnalysisFailure,
  type ContentAnalysisPort,
  type ContentAnalysisResult,
} from "./entry/content-analysis.js";
export {
  ConfigurationBoundaryError,
  configurationPath,
  loadConfiguration,
  publishConfiguration,
  parseConfiguration,
  type OrdinaryConfiguration,
} from "./configuration/index.js";
export {
  TypeScriptConfigurationOwner,
  ConfigurationOwnerError,
  type TypeScriptCredentialEdit,
  type ConfigurationSection,
  type TypeScriptConfigurationDiff,
  type TypeScriptConfigurationSnapshot,
} from "./configuration/owner.js";
export {
  FilePublicationError,
  isRelativeArtifactReference,
  publishStagedFile,
  readPublishedFile,
  type PublishedFile,
} from "./storage/files/publication.js";
export { FileStore, FileStoreError } from "./storage/files/store.js";
export { VerifiedReaderError } from "./storage/files/reader.js";
export {
  LiteratureArtifactService,
  LiteratureArtifactError,
  type ArtifactReadOptions,
} from "./literature/artifacts.js";
export {
  exportArtifact,
  exportBytes,
  ArtifactExportError,
  type ArtifactExportOptions,
} from "./entry/artifact-export.js";
export {
  decodeBibliography,
  importBibliography,
  type BibliographyDecodeItem,
  type BibliographyDecodeOptions,
  type BibliographyDecodeResult,
  type BibliographyInputFormat,
  type BibliographyIdentityPort,
  type BibliographyImportDisposition,
  type BibliographyImportItem,
  type BibliographyImportResult,
  type BibliographyItemStatus,
} from "./entry/bibliography.js";
export {
  BibliographyExportError,
  prepareBibliographyExport,
  type BibliographyExportSelector,
  type PreparedBibliographyExport,
} from "./entry/bibliography-export.js";
export {
  selectLiteratures,
  type LiteratureSelector,
} from "./entry/selectors.js";
export {
  acquireFileLock,
  FileLockError,
  type FileLock,
} from "./storage/locking.js";
export {
  AgentFailure,
  type AgentAdapter,
  type AgentCall,
  type AgentCapability,
  type AgentImagePart,
  type AgentMessage,
  type AgentResult,
  type AgentRole,
  type AgentStructuredResult,
  type AgentToolCall,
  type AgentToolDeclaration,
  type AgentTextPart,
  type AgentTransport,
  type ReasoningEffort,
} from "./agents/protocol.js";
export { MetadataApi } from "./metadata/api.js";
export {
  MetadataProviderFailure,
  topicSearchQuery,
  type MetadataBatchResult,
  type MetadataLookupPort,
  type MetadataLookupRequest,
  type MetadataProviderInvocation,
  type MetadataProviderResult,
  type MetadataReferenceQueryRequest,
  type NeutralMetadataItem,
  type ProviderInvocationOutcome,
  type ProviderOutcome,
  type ReferenceQueryContext,
  type ReferenceQueryDirection,
  type ReferenceQueryPort,
  type RawItemSession,
  type TopicSearchPort,
  type TopicSearchQuery,
} from "./metadata/ports.js";
export { MetadataService } from "./metadata/service.js";
export {
  TopicDiscoveryService,
  CitationDiscoveryService,
  type TopicDiscoveryRequest,
  type TopicDiscoveryReport,
  type CitationDiscoveryRequest,
  type CitationDiscoveryReport,
} from "./entry/discovery.js";
export {
  ArxivAdapter,
  CoreAdapter,
  CrossrefAdapter,
  DataCiteAdapter,
  ElsevierAdapter,
  EuropePmcAdapter,
  JsonMetadataAdapter,
  OpenAlexAdapter,
  OpenCitationsAdapter,
  SemanticScholarAdapter,
  SpringerAdapter,
  WebOfScienceAdapter,
  createMetadataTransport,
  type MetadataRecordDecoder,
  type MetadataTransport,
} from "./metadata/providers.js";
export {
  CrossrefRestAdapter,
  type CrossrefAdapterOptions,
} from "./metadata/crossref.js";
export {
  EuropePmcRestAdapter,
  type EuropePmcAdapterOptions,
} from "./metadata/europe-pmc.js";
export {
  DataCiteRestAdapter,
  type DataCiteAdapterOptions,
} from "./metadata/datacite.js";
export {
  OpenAlexRestAdapter,
  type OpenAlexAdapterOptions,
} from "./metadata/openalex.js";
export {
  SemanticScholarRestAdapter,
  type SemanticScholarAdapterOptions,
} from "./metadata/semantic-scholar.js";
export {
  ArxivRestAdapter,
  type ArxivAdapterOptions,
} from "./metadata/arxiv.js";
export {
  OpenCitationsRestAdapter,
  type OpenCitationsAdapterOptions,
} from "./metadata/opencitations.js";
export { CoreRestAdapter, type CoreAdapterOptions } from "./metadata/core.js";
export {
  SpringerRestAdapter,
  type SpringerAdapterOptions,
} from "./metadata/springer.js";
export {
  ElsevierRestAdapter,
  type ElsevierAdapterOptions,
} from "./metadata/elsevier.js";
export {
  WebOfScienceRestAdapter,
  WebOfScienceStarterRestAdapter,
  WebOfScienceExpandedRestAdapter,
  type WebOfScienceAdapterOptions,
} from "./metadata/web-of-science.js";
export { TypeScriptParserArtifactRules } from "./parsing/artifact-rules.js";
export {
  MinerUParser,
  MinerUParser as TypeScriptMinerUParser,
  type MinerUHttpTransport,
} from "./parsing/backends/mineru/index.js";
export {
  convertMinerUArchive,
  type MinerUArchiveOptions,
} from "./parsing/backends/mineru/index.js";
export {
  METADATA_PROVIDER_ORDER,
  METADATA_AUTO_PROVIDERS,
  buildMetadataRegistry,
  resolveMetadataSelection,
  configuredMetadataSelections,
  type MetadataCapability,
  type MetadataProviderStatus,
  type MetadataRegistry,
} from "./metadata/registry.js";
export {
  assembleMetadataRegistry,
  type MetadataAssemblyOptions,
} from "./metadata/assembly.js";
export { AgentRuntime, type AgentBinding } from "./agents/runtime.js";
export {
  BrowserHost,
  BrowserHostError,
  type BrowserHostDiagnostics,
  type BrowserHostOptions,
  type BrowserNavigationAdmission,
  type BrowserPageHandle,
  type BrowserPageInfo,
} from "./browser/host.js";
export {
  BrowserObservationStore,
  type BrowserCaptureState,
  type BrowserObservation,
  type BrowserObservationSource,
  type BrowserPageSnapshot,
  type BrowserPageState,
  type BrowserViewport,
} from "./browser/observation.js";
export {
  BrowserControlCoordinator,
  BrowserControlError,
  type BrowserAction,
  type BrowserControlClient,
  type BrowserControlLease,
  type BrowserControlState,
} from "./browser/control.js";
export {
  BrowserTransferCollector,
  BrowserTransferError,
  type DurableCandidate,
  type TransferState,
  type TransferStatus,
} from "./browser/transfer.js";
export {
  SqliteWorker,
  SqliteWorkerError,
  type SqliteCommand,
  type SqliteSnapshotCounts,
  type ExecutionJob,
  type ExecutionJobStatus,
  type ExecutionTarget,
  type ExecutionTargetStage,
  type ExecutionAttempt,
  type ExecutionAttemptStage,
  type ExecutionAttemptStatus,
  type ExecutionEvent,
  type ExecutionLease,
  type ExecutionRuntimeInspection,
  type ExecutionMigrationReceipt,
  type ExecutionRestoreCheck,
  type ExecutionRecoveryResult,
} from "./storage/sqlite/worker.js";
export {
  ExecutionRepository,
  type CreateExecutionJobInput,
} from "./storage/execution/repository.js";
export {
  ExecutionJobService,
  ExecutionQueue,
  ExecutionScheduler,
  ExecutionSchedulerError,
  ExecutionTaskService,
  QueuePausedError,
  QueueInterruptedError,
  QueueRetryableError,
  type ExecutionRunResult,
  type ExecutionTaskRuntime,
  type ExecutionTargetHandler,
} from "./application/jobs/service.js";
export {
  InterventionService,
  type InterventionResolution,
} from "./application/jobs/interventions.js";
export { runCli, type CliOptions, type CliResult } from "./cli/main.js";
export {
  ExecutionPolicy,
  ExecutionPolicyError,
  type ExecutionBudget,
  type ExecutionState,
  type ExecutionUsage,
} from "./acquisition/execution-policy.js";
export {
  ExecutionLoop,
  ExecutionLoopError,
  type ExecutionRequest,
  type ExecutionResult,
} from "./acquisition/execution-loop.js";
export {
  acceptPdf,
  PdfAcceptanceError,
  type PdfAcceptance,
} from "./acquisition/pdf-acceptance.js";
export {
  judgeIdentity,
  IdentityVerdictError,
  type IdentityDisposition,
  type IdentityEvidence,
  type IdentityVerdict,
} from "./acquisition/identity-verdict.js";
export {
  arxivPdf,
  authorizedLocator,
  configuredMirrors,
  doiLanding,
  europePmcPdf,
  safeLocator,
  SourceLocatorError,
  unpaywallLocations,
  type OpenLocation,
  type SourceCandidate,
} from "./acquisition/sources/locators.js";
export {
  AuthorizedProviderError,
  CoreAuthorizedPdfClient,
  ElsevierAuthorizedPdfClient,
  WileyAuthorizedPdfClient,
  type AuthorizedProvider,
  type AuthorizedTransport,
  type AuthorizedLookupTarget,
  type AuthorizedLookupResult,
  type AuthorizedDownloadLocator,
  type AuthorizedDownloadResult,
} from "./acquisition/providers/authorized.js";
export {
  routeCandidates,
  type RouteResult,
} from "./acquisition/sources/route.js";
export {
  ArxivPdfSource,
  AuthorizedPdfSource,
  ConfiguredSciHubSource,
  DirectPdfSource,
  DoiLandingSource,
  EuropePmcPdfSource,
  downloadPdfCandidate,
  downloadSourceCandidate,
  PublicAcquisitionRegistry,
  UnpaywallSource,
  type AcquisitionSourcePort,
  type AcquisitionSourceRequest,
  type AcquisitionSourceStatus,
  type PdfDownloadOptions,
  type PdfDownloadTransport,
  type SourceDownloadOptions,
  type PublicAcquisitionTransport,
  type AuthorizedPdfClientPort,
} from "./acquisition/sources/public.js";
export {
  TieredAcquisitionService,
  type AcquisitionBatchDisposition,
  type AcquisitionBatchFailure,
  type AcquisitionBatchItem,
  type AcquisitionBatchProgress,
  type AcquisitionBatchResult,
  type TieredAcquisitionOptions,
  type AcquisitionCandidateDownloader,
} from "./acquisition/tiered.js";
export {
  assemblePublicAcquisitionRegistry,
  BUILTIN_SCI_HUB_MIRROR_URLS,
  type PublicAcquisitionAssemblyOptions,
} from "./acquisition/assembly.js";
export {
  CandidatePublisher,
  CandidatePublicationError,
  type CandidatePublication,
  type CandidatePublicationInput,
} from "./acquisition/candidate-publication.js";
export {
  CandidateAcceptanceService,
  CandidateAcceptanceError,
  type AcceptCandidateCommand,
} from "./acquisition/candidate-acceptance.js";
export { LiteraturePublicationError } from "./literature/primary-pdf.js";
export {
  LiteratureQueryService,
  LiteratureQueryError,
  LiteratureNotFoundError,
} from "./literature/query.js";
export {
  createAgentTransport,
  NetworkHttpError,
  requestFollowingRedirects,
  requestOnce,
  type AgentTransportOptions,
  type HttpResponse,
} from "./network/http.js";
export {
  createApplication,
  type Application,
  type ApplicationOptions,
} from "./bootstrap/application.js";
export { loadWorkbenchAssets } from "./workbench/assets.js";
export {
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "./entry/doctor.js";
export {
  createLogger,
  type Logger,
  type LogLevel,
  type SafeLogFields,
} from "./logging/index.js";

export { ParsingService, type PreparedParsing } from "./parsing/service.js";
export {
  ParsingFailure,
  type ParserBackend,
  type ParserPort,
  type ParserArtifactRules,
  type ParserRequest,
  type StagedParserOutput,
} from "./parsing/ports.js";

export {
  MinerULoopbackParser,
  MinerULoopbackParser as TypeScriptLoopbackMinerUParser,
} from "./parsing/backends/mineru/index.js";

export {
  LiteratureContentService,
  ContentAcceptanceError,
} from "./literature/content.js";

export {
  AnalysisService,
  AnalysisFailure,
  type AnalysisOptions,
  type AnalysisResult,
} from "./analysis/service.js";
export { parseCrossrefRecord } from "./metadata/crossref-fixture.js";
export {
  exportBibliography,
  exportBibliographyBatch,
  type BibliographyFormat,
  type BibliographySource,
} from "./literature/bibliography.js";
export {
  LiteratureIdentityService,
  type LiteratureIdentityDecision,
} from "./literature/identity.js";
export {
  STABLE_IDENTIFIER_NAMESPACES,
  fallbackIdentityKey,
  fallbackIdentitySha256,
  normalizeIdentityText,
  providerKeyMatchesSeed,
  resolveLiteratureIdentity,
  resolveMetaLiterature,
  stableIdentifierIndex,
  stableIdentifierKeys,
  type FallbackIdentityKey,
  type LiteratureIdentityResolution,
  type MetaLiteratureResolution,
  type StableIdentifierKey,
  type VersionEvidence,
} from "./literature/identity-rules.js";
export {
  acceptMetadataObservation,
  projectMetadata,
  sameProviderObservation,
  sameUserObservation,
  userObservationSemanticSha256,
  type MetadataObservationAcceptanceDecision,
  type MetadataProjectionDecision,
} from "./literature/metadata-rules.js";
export {
  WorkbenchSession,
  WorkbenchSessionError,
  type BrowserDecision,
  type WorkbenchSessionState,
} from "./workbench/session.js";
export {
  startWorkbenchHttp,
  type WorkbenchHttpOptions,
  type WorkbenchStaticAsset,
} from "./workbench/http.js";
export { createBrowserDecision } from "./browser/decision.js";
