import {
  NetworkConfigurationError,
  DRAFT_FACT_SORTS,
} from "@sciretriever/contracts";
import {
  handleDeviceRequest,
  handleWebDeviceRoute,
  manageDevices,
  deviceMaterialInUrl,
  assertRequestContentType,
  RequestContentTypeError,
  type DeviceHttpOptions,
} from "./device-http.js";
import { catalogCorruption } from "../storage/sqlite/errors.js";
import { ScreencastRelay } from "./screencast-relay.js";
import {
  RestartAdmissionError,
  withoutRestartAdmission,
} from "../application/restart-admission.js";
import { SourceConfigurationError } from "../configuration/sources.js";
import {
  CONFIGURATION_OPERATIONS,
  type ConfigurationOperation,
} from "../entry/configuration-operations.js";
import { withActivity } from "../logging/activity.js";
import { createLogger } from "../logging/index.js";
import { cleanupStaging } from "../storage/files/staging.js";
import {
  ContractValidationError,
  EXTRACTION_SUBMISSION_WIRE_MAX_BYTES,
  parseDocumentRequest,
  parseLibrarySearchRequest,
  parsePageRegion,
  parseRetrievalGenerationReceipt,
  parseIndexVerificationResult,
  parseIndexRefreshStatus,
  parseIndexRefreshRequest,
  parseIndexRebuildRequest,
  parseStrictJsonObject,
  type ConfigurationReadiness,
  type AcquisitionRouteState,
  TranslationInputError,
} from "@sciretriever/contracts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { CandidateAcceptanceError } from "../acquisition/candidate-acceptance.js";
import { PdfAcceptanceError } from "../acquisition/pdf-acceptance.js";
import { AgentFailure } from "../agents/protocol.js";
import { ProcessorError } from "../analysis/processor.js";
import { ProcessingTaskError } from "../application/jobs/processing.js";
import type { QueryApplication } from "../bootstrap/application.js";
import type { BrowserPageInfo } from "../browser/host.js";
import {
  ConfigurationOwnerError,
  ConfigurationProbeError,
  isConfigurationProbeOwner,
  isConfigurationSection,
  type ConfigurationProbeRequest,
  type ConfigurationProbeResult,
  type ConfigurationSection,
  type TypeScriptConfigurationDiff,
  type TypeScriptConfigurationSnapshot,
  type TypeScriptCredentialEdit,
} from "../configuration/owner.js";
import { DocumentReadError } from "../document/read.js";
import {
  DocumentProcessingError,
  type DocumentProcessingService,
} from "../document/service.js";
import {
  executeExtraction,
  isMaintenanceFailure,
  type ExtractionOperation,
} from "../entry/maintenance-operations.js";
import type { ManualPdfIngestionService } from "../entry/manual-pdf.js";
import { ManualPdfInputError } from "../entry/manual-pdf.js";
import {
  PROCESSOR_QUERIES,
  queryProcessors,
} from "../entry/processor-operations.js";
import {
  executeQuery,
  isQueryFailure,
  type QueryOperation,
} from "../entry/query-operations.js";
import {
  ExtractionDeliveryError,
  type ExtractionDeliveryService,
} from "../extraction/delivery.js";
import { ExtractionSpecError } from "../extraction/spec.js";
import type { LiteratureArtifactService } from "../literature/artifacts.js";
import { exportBibliography } from "../literature/bibliography.js";
import { LiteraturePublicationError } from "../literature/primary-pdf.js";
import {
  LiteratureNotFoundError,
  LiteratureQueryError,
  LibrarySortScopeLimitError,
  type LiteratureQueryService,
} from "../literature/query.js";
import { ParsingFailure } from "../parsing/ports.js";
import { RetrievalStorageError } from "../retrieval/model.js";
import {
  TranslationError,
  type TranslationService,
} from "../translation/service.js";
import type { FullTextTranslation } from "../translation/fulltext.js";
import { RetrievalIndexError } from "../retrieval/index.js";
import { KnowledgeContextError } from "../retrieval/knowledge-query.js";
import { MaterialContextError } from "../retrieval/query.js";
import { ProcessorQueryError } from "../storage/processor-results.js";
import { ExtractionStorageError } from "../storage/sqlite/worker.js";
import {
  WorkbenchAccess,
  isLoopbackPeer,
  type WorkbenchAccessOptions,
} from "./access.js";
import { ProductionWorkbenchSession } from "./production-session.js";
import { WorkbenchSession, WorkbenchSessionError } from "./session.js";
import { staticAssetCacheControl } from "./assets.js";
import {
  materialBytesPath,
  pdfMaterialHeaders,
  sendMaterialBytes,
} from "./material-bytes.js";

export interface WorkbenchStaticAsset {
  readonly contentType: string;
  readonly body: string | Uint8Array;
}
export interface WorkbenchRuntimeCapabilities {
  readonly parsing: {
    readonly assembled: boolean;
    readonly unavailable_reason:
      | "startup-credential-missing"
      | "configuration-incomplete"
      | "assembly-unavailable"
      | null;
  };
  readonly metadata: readonly {
    readonly provider_name: string;
    readonly selected: boolean;
    readonly assembled: boolean;
    readonly production_available: boolean;
    readonly ready_at_startup: boolean;
    readonly failure_code: string | null;
  }[];
  readonly acquisition: readonly {
    readonly source_name: string;
    readonly selected: boolean;
    readonly assembled: boolean;
    readonly ready_at_startup: boolean;
    readonly failure_code: string | null;
  }[];
}
export interface WorkbenchWorkspace {
  readonly catalog_path: string | null;
  readonly artifact_root: string | null;
  readonly schema_version: number | null;
  readonly configuration_revision: string | null;
  readonly capabilities: {
    readonly tasks: boolean;
    readonly query: boolean;
    readonly maintenance: boolean;
    readonly discovery: boolean;
    readonly import: boolean;
  };
  readonly runtime_capabilities: WorkbenchRuntimeCapabilities | null;
}
export interface WorkbenchHttpOptions {
  readonly devices?: DeviceHttpOptions;
  readonly access?: WorkbenchAccessOptions;
  readonly session: WorkbenchSession | ProductionWorkbenchSession;
  /** Transport tuning for loopback measurements; production default is documented in Browser control. */
  readonly screencastMaxInFlight?: 1 | 2;
  readonly workspace?: WorkbenchWorkspace;
  /** Same catalog read services; shares routes, never creates a second HTTP server. */
  readonly query?: QueryOnlyHttpOptions;
  readonly tasks?: {
    list(
      limit?: number,
      cursor?: string,
      statusGroup?: "active" | "attention" | "ended",
    ): Promise<unknown>;
    read(taskId: string): Promise<unknown>;
    create(value: unknown): Promise<unknown>;
    start(
      taskId: string,
    ): Promise<{ readonly started: boolean; readonly task: unknown }>;
    control(
      taskId: string,
      action: "pause" | "cancel" | "resume" | "retry",
    ): Promise<unknown>;
  };
  readonly discovery?: (
    value: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly importBibliography?: (value: unknown) => Promise<unknown>;
  /** Reader translation (ADR 0049); Web only, never recorded as an operation. */
  readonly translation?: Pick<TranslationService, "catalog" | "translate">;
  /** Full-text translation (ADR 0051); Web only, kept outside the catalog. */
  readonly fullTextTranslation?: Pick<FullTextTranslation, "summary" | "page">;
  /** Explicit article completion; absent from the synthetic preview. */
  readonly acquisition?: { start(articleId: string): void };
  readonly tabs?: {
    list(): Promise<readonly BrowserPageInfo[]>;
    activate(pageId: string): Promise<void>;
  };
  readonly library?: {
    readonly queries: LiteratureQueryService;
    readonly artifacts: LiteratureArtifactService;
  };
  readonly maintenance?: {
    readonly ingestPdf: ManualPdfIngestionService["ingestPdf"];
    readonly ingestPdfStream?: ManualPdfIngestionService["ingestPdfStream"];
    readonly parseDocuments: DocumentProcessingService["parseDocuments"];
    readonly documentDefault?: (
      literatureId: string,
      assetId: string,
      assetSha256: string,
    ) => Promise<{
      readonly document_version_id: string;
      readonly revision: number;
    } | null>;
  };
  readonly configuration?: {
    lifecycleFlushed?(): void;
    sourceOperation?(
      operation: ConfigurationOperation,
      value: unknown,
      signal?: AbortSignal,
    ): Promise<unknown>;
    /** Ordinary configuration revision captured by the owning Application at startup. */
    readonly runtime_revision?: string;
    /** Actual process assembly snapshot; null/absent means the caller cannot confirm it. */
    readonly runtime_capabilities?: WorkbenchRuntimeCapabilities | null;
    status(signal?: AbortSignal): Promise<ConfigurationReadiness>;
    read?(signal?: AbortSignal): Promise<TypeScriptConfigurationSnapshot>;
    /** Route-only projection; configuration reads/publications must not invoke status. */
    acquisitionRoutes?(
      snapshot: TypeScriptConfigurationSnapshot,
      signal?: AbortSignal,
    ): Promise<AcquisitionRouteState>;
    diff?(
      payload: string,
      baseline: string,
      signal?: AbortSignal,
    ): Promise<TypeScriptConfigurationDiff>;
    publish?(
      payload: string,
      baseline: string,
      sections: readonly ConfigurationSection[],
      signal?: AbortSignal,
    ): Promise<TypeScriptConfigurationSnapshot>;
    publishConfiguration?(
      configuration: unknown,
      baseline: string,
      sections: readonly ConfigurationSection[],
      signal?: AbortSignal,
    ): Promise<TypeScriptConfigurationSnapshot>;
    probe?(
      request: ConfigurationProbeRequest,
      signal?: AbortSignal,
    ): Promise<ConfigurationProbeResult>;
    credential?(
      edit: TypeScriptCredentialEdit,
      baseline: string,
      signal?: AbortSignal,
    ): Promise<ConfigurationReadiness>;
  };
  /** Durable execution surface exposed through the same authenticated port. */
  readonly jobs?: {
    list(limit?: number): Promise<unknown>;
    get(jobId: string): Promise<unknown>;
    targets(jobId: string, limit?: number): Promise<unknown>;
    attempts(targetId: string, limit?: number): Promise<unknown>;
    events(jobId: string, after?: number, limit?: number): Promise<unknown>;
    policy(jobId: string): Promise<unknown>;
    budget(jobId: string): Promise<unknown>;
    interventions(jobId: string, limit?: number): Promise<unknown>;
    run(jobId: string, signal?: AbortSignal): Promise<unknown>;
    resolveIntervention(
      interventionId: string,
      resolution: "continue" | "skip" | "cancel",
    ): Promise<unknown>;
    create(input: unknown): Promise<unknown>;
    pause(jobId: string): Promise<unknown>;
    resume(jobId: string): Promise<unknown>;
    cancel(jobId: string): Promise<unknown>;
  };
  readonly assets: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
}
interface ClientGrant {
  readonly csrf: string;
  readonly authSessionId: string;
  touched: number;
}
const CLIENT_TTL = 180000;
const UI_SORTS = new Set([
  "opened-desc",
  "intake-desc",
  "collected-desc",
  "publication-year-desc",
  "publication-year-asc",
  "title-asc",
  "title-desc",
  "relevance",
  ...DRAFT_FACT_SORTS,
]);
const CONFIGURATION_ROOT_KEYS = [
  "network",
  "paths",
  "sources",
  "assets",
  "parsing",
  "providers",
  "models",
  "analyze",
  "proofread",
  "tags",
  "browser",
  "execution",
  "library",
] as const;
class WorkbenchInputError extends Error {
  readonly code = "invalid-command" as const;
  constructor() {
    super("invalid workbench command");
    this.name = "WorkbenchInputError";
  }
}
function invalidInput(): never {
  throw new WorkbenchInputError();
}
function acceptsHtml(accept: string | undefined): boolean {
  return (
    accept?.split(",").some((range) => {
      const [type, ...parameters] = range.split(";");
      return (
        type?.trim().toLowerCase() === "text/html" &&
        !parameters.some((parameter) =>
          /^\s*q\s*=\s*0(?:\.0*)?\s*$/iu.test(parameter),
        )
      );
    }) ?? false
  );
}
function validUiLocation(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some(
      (key) =>
        ![
          "view",
          "query",
          "reader",
          "focusLiterature",
          "agentSession",
          "agentStatus",
          "rerun",
          "rerunHash",
          "task",
          "artifact",
          "scope",
          "sort",
          "literature",
          "document",
          "knowledge",
          "result",
          "resultHash",
          "results",
          "collection",
          "tools",
          "source",
          "from",
          "asset",
          "assetHash",
          "representation",
          "start",
          "end",
          "contentHash",
          "manifest",
          "statement",
          "statementHash",
          "metadataHash",
          "metadataRevision",
          "session",
          "article",
          "setting",
          "inspect",
          "page",
          "region",
          "snapshot",
          "processor",
          "tag",
        ].includes(key),
    )
  )
    return false;
  const filters = url.searchParams.get("query");
  if (filters !== null) {
    if (filters.length > 16384) return false;
    try {
      parseLibrarySearchRequest({
        query: (() => {
          const value: unknown = JSON.parse(filters);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            delete (value as Record<string, unknown>).document_type;
            delete (value as Record<string, unknown>).document_types;
          }
          return value;
        })(),
        sort: "title-asc",
        limit: 50,
        cursor: null,
      });
    } catch {
      return false;
    }
  }
  for (const [key, values] of [
    [
      "view",
      [
        "lib",
        "disc",
        "ins",
        "ask",
        "syn",
        "ext",
        "task",
        "web",
        "agent",
        "stats",
        "set",
        "lab",
        "gallery",
        "archive",
        "tags",
        "snapshots",
      ],
    ],
    ["reader", ["pdf", "doc", "know", "edit", "results"]],
    ["inspect", ["1"]],
    ["processor", ["summary", "knowledge-synthesis", "labels", "records"]],
    ["scope", ["selection", "all"]],
    ["source", ["metadata", "document", "knowledge"]],
    ["from", ["ask", "ext", "syn"]],
    ["results", ["all"]],
    ["tools", ["delivery"]],
    [
      "setting",
      [
        "paths",
        "sources",
        "models",
        "parser",
        "network",
        "cred",
        "status",
        "advanced",
        "appearance",
        "devices",
        "archive",
      ],
    ],
  ] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && !(values as readonly string[]).includes(value))
      return false;
  }
  try {
    const region = url.searchParams.get("region");
    if (region !== null) parsePageRegion(JSON.parse(region));
  } catch {
    return false;
  }
  const sort = url.searchParams.get("sort");
  const literature = url.searchParams.get("literature");
  return (
    (sort === null || UI_SORTS.has(sort)) &&
    (literature === null || /^[A-Za-z0-9._:-]{1,256}$/u.test(literature)) &&
    [
      "assetHash",
      "representation",
      "contentHash",
      "manifest",
      "statementHash",
      "metadataHash",
      "resultHash",
    ].every((key) => {
      const value = url.searchParams.get(key);
      return value === null || /^[a-f0-9]{64}$/u.test(value);
    }) &&
    ["start", "end", "metadataRevision", "page"].every((key) => {
      const value = url.searchParams.get(key);
      return (
        value === null ||
        (/^\d{1,16}$/u.test(value) && Number.isSafeInteger(Number(value)))
      );
    }) &&
    [
      "document",
      "knowledge",
      "task",
      "artifact",
      "asset",
      "statement",
      "result",
      "collection",
      "session",
      "article",
      "snapshot",
      "tag",
    ].every((key) => {
      const value = url.searchParams.get(key);
      return value === null || /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
    })
  );
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
function runtimeConfigurationState(
  configuration: NonNullable<WorkbenchHttpOptions["configuration"]>,
  snapshot: TypeScriptConfigurationSnapshot,
  routes?: AcquisitionRouteState,
): {
  readonly acquisition_routes?: AcquisitionRouteState;
  readonly runtime_configuration_current: boolean | null;
  readonly ordinary_configuration_restart_required: boolean | null;
  readonly application_restart_required: boolean | null;
  readonly application_restart_reason:
    | "ordinary-configuration"
    | "capability-reassembly"
    | null;
  readonly runtime_capabilities: WorkbenchRuntimeCapabilities | null;
} {
  const current =
    configuration.runtime_revision === undefined
      ? null
      : snapshot.revision === configuration.runtime_revision;
  const capabilities = configuration.runtime_capabilities ?? null;
  const capabilityRestartRequired =
    capabilities === null
      ? null
      : capabilities.parsing.unavailable_reason ===
          "startup-credential-missing" ||
        capabilities.metadata.some(
          (item) =>
            item.selected &&
            !item.assembled &&
            item.failure_code === "credential-missing",
        ) ||
        capabilities.acquisition.some(
          (item) =>
            item.selected &&
            !item.assembled &&
            item.failure_code === "missing-credential",
        );
  const ordinaryRestartRequired = current === null ? null : current === false;
  const restartRequired =
    ordinaryRestartRequired === true ||
    capabilityRestartRequired === true ||
    routes?.restart_required === true
      ? true
      : ordinaryRestartRequired === false && capabilityRestartRequired === false
        ? false
        : null;
  return {
    ...(routes ? { acquisition_routes: routes } : {}),
    runtime_configuration_current: current,
    ordinary_configuration_restart_required: ordinaryRestartRequired,
    application_restart_required: restartRequired,
    application_restart_reason:
      ordinaryRestartRequired === true
        ? "ordinary-configuration"
        : capabilityRestartRequired === true ||
            routes?.restart_required === true
          ? "capability-reassembly"
          : null,
    runtime_capabilities: capabilities,
  };
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidInput();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  )
    invalidInput();
  return record;
}
function actorInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidInput();
  return value as Record<string, unknown>;
}
async function body(request: IncomingMessage): Promise<unknown> {
  assertRequestContentType(request);
  if (request.headers["content-encoding"] !== undefined) invalidInput();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > 65536) invalidInput();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    invalidInput();
  }
}
async function extractionBody(
  request: IncomingMessage,
  limit = 256 * 1024,
): Promise<Record<string, unknown>> {
  assertRequestContentType(request);
  if (request.headers["content-encoding"] !== undefined) invalidInput();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > limit) invalidInput();
    chunks.push(chunk);
  }
  try {
    return parseStrictJsonObject(Buffer.concat(chunks));
  } catch {
    invalidInput();
  }
}

const MAX_MANUAL_PDF_BYTES = 16 * 1024 * 1024;
// Scoped to processor envelopes; ordinary commands retain their 64 KiB bound.
const PROCESSOR_SUBMIT_WIRE_BYTES = 1024 * 1024;
const PROCESSOR_QUERY_WIRE_BYTES = 310 * 1024;
const PROCESSOR_RESPONSE_BYTES = 16 * 1024 * 1024;

function processorFailure(error: unknown): { status: number; code: string } {
  if (error instanceof RequestContentTypeError)
    return { status: 415, code: error.code };
  if (
    error instanceof ContractValidationError ||
    error instanceof WorkbenchInputError
  )
    return { status: 400, code: "invalid-command" };
  if (error instanceof ProcessingTaskError)
    return { status: 409, code: error.code };
  if (error instanceof AgentFailure) return { status: 503, code: error.code };
  if (error instanceof ProcessorError || error instanceof ProcessorQueryError)
    return {
      code: error.code,
      status:
        error.code === "catalog-v10-required"
          ? 422
          : error.code.endsWith("missing")
            ? 404
            : error.code.includes("cancel") ||
                error.code.includes("changed") ||
                error.code.includes("conflict")
              ? 409
              : error.code.includes("unavailable") ||
                  error.code.includes("unconfigured") ||
                  error.code.includes("closed")
                ? 503
                : 422,
    };
  return { status: 503, code: "processor-unavailable" };
}
function processorReply(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > PROCESSOR_RESPONSE_BYTES) {
    json(response, 413, {
      protocol_version: 1,
      code: "processor-response-too-large",
    });
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
  });
  response.end(bytes);
}

function maintenanceError(error: unknown): {
  status: number;
  code: string;
  issue?: unknown;
  reason?: string;
  retryable?: boolean;
} {
  if (
    error instanceof ExtractionDeliveryError ||
    error instanceof ExtractionStorageError
  ) {
    const code = error.code;
    return {
      status:
        code === "unknown-or-expired"
          ? 404
          : code === "input-missing"
            ? 404
            : code === "invalid-request" ||
                code === "pointer-invalid" ||
                code === "coverage-invalid" ||
                code === "relation-invalid" ||
                code === "evidence-coverage"
              ? 400
              : code.endsWith("capacity")
                ? 429
                : code === "catalog-v5-required"
                  ? 422
                  : code === "storage-failed" ||
                      code === "storage-unavailable" ||
                      code === "storage-invalid" ||
                      code === "delivery-unavailable" ||
                      code === "delivery-write-security" ||
                      code === "delivery-write-closed" ||
                      code === "delivery-write-expired"
                    ? 503
                    : 409,
      code,
      ...(error instanceof ExtractionDeliveryError && error.issue
        ? { issue: error.issue }
        : {}),
    };
  }
  if (error instanceof ExtractionSpecError)
    return {
      status: error.code === "schema-busy" ? 429 : 422,
      code: error.code,
    };
  if (error instanceof RetrievalStorageError)
    return {
      status: error.code === "index-corrupt" ? 422 : 409,
      code: error.code,
    };
  if (error instanceof RetrievalIndexError)
    return {
      status: error.code === "index-cancelled" ? 409 : 422,
      code: error.code,
    };
  if (error instanceof DocumentProcessingError)
    return {
      status:
        error.code === "material-missing"
          ? 404
          : error.code === "material-stale"
            ? 409
            : 503,
      code: error.code,
    };
  if (error instanceof ParsingFailure)
    return {
      status: error.code === "parser-stale" ? 409 : 503,
      code: error.code,
    };
  if (error instanceof ManualPdfInputError)
    return { status: 400, code: error.code };
  if (error instanceof PdfAcceptanceError)
    return { status: 400, code: "manual-pdf-invalid" };
  if (error instanceof LiteraturePublicationError)
    return {
      status:
        error.code === "primary-asset-conflict" ||
        error.code === "literature-stale"
          ? 409
          : 400,
      code: error.code,
    };
  if (error instanceof CandidateAcceptanceError)
    return {
      status:
        error.code === "literature-not-found"
          ? 404
          : error.code === "candidate-receipt-conflict"
            ? 409
            : 400,
      code: error.code,
    };
  if (error instanceof LiteratureNotFoundError)
    return { status: 404, code: "literature-not-found" };
  if (
    error instanceof WorkbenchInputError ||
    error instanceof ContractValidationError
  )
    return { status: 400, code: "invalid-command" };
  return { status: 503, code: "maintenance-unavailable" };
}

async function receiveManualPdf(
  request: IncomingMessage,
  response: ServerResponse,
  literatureId: string,
  ingestPdf: ManualPdfIngestionService["ingestPdf"],
  serverSignal: AbortSignal,
  stream?: ManualPdfIngestionService["ingestPdfStream"],
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const responseClosed = () => {
    if (!response.writableFinished) abort();
  };
  request.on("aborted", abort);
  response.on("close", responseClosed);
  serverSignal.addEventListener("abort", abort, { once: true });
  try {
    if (serverSignal.aborted || request.aborted) abort();
    if (stream)
      return await stream(
        { literature_id: literatureId, chunks: request },
        controller.signal,
      );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of request) {
      if (controller.signal.aborted)
        throw new ManualPdfInputError("manual-pdf-cancelled");
      const chunk = Buffer.from(value as Uint8Array);
      size += chunk.byteLength;
      if (size > MAX_MANUAL_PDF_BYTES) invalidInput();
      chunks.push(chunk);
    }
    if (controller.signal.aborted)
      throw new ManualPdfInputError("manual-pdf-cancelled");
    return await ingestPdf(
      { literature_id: literatureId, bytes: Buffer.concat(chunks) },
      controller.signal,
    );
  } finally {
    request.off("aborted", abort);
    response.off("close", responseClosed);
    serverSignal.removeEventListener("abort", abort);
  }
}

async function receiveDocumentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  parseDocuments: DocumentProcessingService["parseDocuments"],
  serverSignal: AbortSignal,
): ReturnType<DocumentProcessingService["parseDocuments"]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const responseClosed = () => {
    if (!response.writableFinished) abort();
  };
  request.on("aborted", abort);
  response.on("close", responseClosed);
  serverSignal.addEventListener("abort", abort, { once: true });
  try {
    if (serverSignal.aborted || request.aborted) abort();
    const value = await body(request);
    if (controller.signal.aborted)
      throw new DocumentProcessingError("document-cancelled");
    return await parseDocuments(value, controller.signal);
  } finally {
    request.off("aborted", abort);
    response.off("close", responseClosed);
    serverSignal.removeEventListener("abort", abort);
  }
}

export interface WorkbenchHttpServer {
  readonly origin: string;
  readonly listenAddress: string;
  readonly urls: readonly string[];
  /** Generated startup credential; absent when a password was supplied. Never serve over HTTP. */
  readonly apiKey: string | undefined;
  close(): Promise<void>;
}

/** Deadlines cover receiving the body, never the duration of an admitted operation. */
function guardRequestBody(request: IncomingMessage, response: ServerResponse) {
  if (request.complete) return;
  const path = (request.url ?? "").split("?")[0];
  const idle =
    request.method === "POST" &&
    (path === "/mcp" ||
      path === "/api/v1/maintenance/ingest-pdf" ||
      path === "/api/maintenance/ingest-pdf" ||
      /^\/api\/v1\/intake\/literatures\/[^/]+\/pdf$/u.test(path!) ||
      /^\/api\/v1\/intake\/batches\/[^/]+\/(?:data|file-items|files\/[^/]+\/bytes)$/u.test(
        path!,
      ));
  let timer: ReturnType<typeof setTimeout>;
  let draining = false;
  const finished = () => {
    if (request.complete) {
      cleanup();
      return;
    }
    // A response finishing is not permission to destroy the shared socket.
    // Give an early response time to reach the peer, but bound the remaining
    // discard by total time even when the upload keeps making progress.
    draining = true;
    arm();
    request.off("readable", received);
    request.on("data", received);
    request.resume();
  };
  const closed = () => {
    // A completed response can close while its request is still being drained.
    if (!response.writableFinished) cleanup();
  };
  const cleanup = () => {
    clearTimeout(timer);
    request.off("readable", received);
    request.off("data", received);
    request.off("end", cleanup);
    request.off("aborted", cleanup);
    response.off("finish", finished);
    response.off("close", closed);
  };
  const expire = () => {
    cleanup();
    if (request.complete) return;
    if (response.writableEnded || response.destroyed) {
      request.destroy();
      return;
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.shouldKeepAlive = false;
    response.setHeader("Connection", "close");
    response.once("finish", () => request.destroy());
    if (idle)
      json(response, 408, {
        protocol_version: 1,
        code: "request-idle-timeout",
      });
    else {
      // Preserve the former Node requestTimeout response for ordinary routes.
      response.writeHead(408);
      response.end();
    }
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, idle && !draining ? 60000 : 5000);
    timer.unref();
  };
  const received = () => {
    if (request.complete) cleanup();
    else if (idle && !draining) arm();
  };
  // Observe availability without putting the request in flowing mode before auth.
  request.on("readable", received);
  request.once("end", cleanup);
  request.once("aborted", cleanup);
  response.once("finish", finished);
  response.once("close", closed);
  arm();
}

/** Authenticated UI transport. Startup credentials stay with the process owner. */
export async function startWorkbenchHttp(
  input: WorkbenchHttpOptions,
): Promise<WorkbenchHttpServer> {
  const { access: accessOptions, ...options } = input;
  const session = options.session;
  const projectedView = (clientId?: string) =>
    session instanceof ProductionWorkbenchSession
      ? session.view(clientId)
      : session.view();
  const cookieName = `sr_workbench_${randomBytes(8).toString("hex")}`;
  const cookie = randomBytes(32).toString("hex");
  const clients = new Map<string, ClientGrant>();
  const access = await WorkbenchAccess.create(accessOptions ?? {}, (id) => {
    for (const [clientId, grant] of clients) {
      if (grant.authSessionId === id) {
        clients.delete(clientId);
        screencast?.revoke(clientId);
        session.detach(clientId);
      }
    }
  });
  const streams = new Set<ServerResponse>();
  const pending = new Set<Promise<void>>();
  const stopUploads = new AbortController();
  let closing = false;
  const queryHandler = options.query
    ? createQueryHttpHandler(
        options.query,
        (request) =>
          access.address(request) ?? {
            origin: access.origin,
            host: new URL(access.origin).host,
          },
      )
    : undefined;
  const server = createServer(
    { requestTimeout: 0, headersTimeout: 5000, maxHeaderSize: 8192 },
    (request, response) => {
      guardRequestBody(request, response);
      const operation = withoutRestartAdmission(() =>
        handle(request, response),
      ).catch((error: unknown) => {
        if (error instanceof RequestContentTypeError) {
          if (response.headersSent || response.destroyed) response.destroy();
          else json(response, 415, { protocol_version: 1, code: error.code });
          return;
        }
        if (
          request.url?.startsWith("/api/maintenance/ingest-pdf") ||
          request.url?.startsWith("/api/maintenance/parse-document") ||
          request.url?.startsWith("/api/v1/maintenance/ingest-pdf")
        ) {
          const failure = maintenanceError(error);
          if (response.headersSent || response.destroyed) response.destroy();
          else
            json(response, failure.status, {
              protocol_version: 1,
              code: failure.code,
              ...(failure.issue ? { issue: failure.issue } : {}),
              ...(failure.reason
                ? { reason: failure.reason, retryable: failure.retryable }
                : {}),
            });
          return;
        }
        const code =
          error instanceof NetworkConfigurationError
            ? error.code
            : error instanceof ProcessingTaskError
              ? error.code
              : error instanceof WorkbenchSessionError
                ? error.code
                : error instanceof ManualPdfInputError ||
                    error instanceof LiteraturePublicationError ||
                    error instanceof CandidateAcceptanceError
                  ? error.code
                  : error instanceof PdfAcceptanceError
                    ? "manual-pdf-invalid"
                    : error instanceof ConfigurationOwnerError ||
                        error instanceof SourceConfigurationError ||
                        error instanceof RestartAdmissionError ||
                        error instanceof ConfigurationProbeError
                      ? error.code
                      : error instanceof WorkbenchInputError
                        ? error.code
                        : error instanceof ContractValidationError
                          ? "invalid-command"
                          : "command-rejected";
        if (response.destroyed) return;
        if (
          error instanceof LibrarySortScopeLimitError &&
          !response.headersSent
        ) {
          json(response, 400, { code: error.code });
          return;
        }
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.removeHeader("Content-Disposition");
        const status =
          error instanceof WorkbenchSessionError &&
          error.code === "viewer-limit"
            ? 429
            : error instanceof ProcessingTaskError
              ? error.code === "processing-not-found"
                ? 404
                : 409
              : error instanceof LiteratureNotFoundError
                ? 404
                : error instanceof ManualPdfInputError ||
                    error instanceof PdfAcceptanceError ||
                    (error instanceof LiteraturePublicationError &&
                      error.code !== "primary-asset-conflict")
                  ? 400
                  : error instanceof CandidateAcceptanceError &&
                      error.code === "literature-not-found"
                    ? 404
                    : error instanceof NetworkConfigurationError ||
                        error instanceof WorkbenchInputError ||
                        error instanceof ContractValidationError ||
                        (error instanceof SourceConfigurationError &&
                          error.code === "source-configuration-invalid") ||
                        (error instanceof ConfigurationOwnerError &&
                          error.code === "configuration-invalid") ||
                        (error instanceof ConfigurationProbeError &&
                          error.code === "configuration-probe-invalid")
                      ? 400
                      : 409;
        json(response, status, {
          ...(error instanceof SourceConfigurationError
            ? {
                protocol_version: 1,
                problem: {
                  display: "error",
                  technical_details: {
                    diagnostics: [{ code: error.code, scope: "configuration" }],
                  },
                },
                ...(error.current_revision
                  ? { current_revision: error.current_revision }
                  : {}),
              }
            : {}),
          code:
            error instanceof LiteratureNotFoundError
              ? "literature-not-found"
              : code,
        });
      });
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => {
          pending.delete(operation);
          response.destroy();
        },
      );
    },
  );
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self' blob:; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (closing) {
      json(response, 503, { code: "workbench-closing" });
      return;
    }
    if (deviceMaterialInUrl(request.url ?? "/")) {
      json(response, 400, { protocol_version: 1, code: "device-token-in-url" });
      return;
    }
    if (
      request.headers.authorization !== undefined ||
      /^\/api\/v1\/device-connections\/(?:exchange|instructions|skill)(?:\?|$)/u.test(
        request.url ?? "",
      )
    ) {
      const address = access.hostAddress(request);
      let url: URL;
      try {
        url = new URL(request.url ?? "/", address?.origin);
      } catch {
        json(response, 403, { code: "origin-not-allowed" });
        return;
      }
      if (!address || url.origin !== address.origin) {
        json(response, 403, { code: "origin-not-allowed" });
        return;
      }
      if (await handleDeviceRequest(request, response, url, options.devices))
        return;
    }
    const authorization = await access.authorize(
      request,
      response,
      options.assets,
    );
    if (!authorization) return;
    return withActivity({ actor: authorization.actor }, async () => {
      const { origin, sessionId: authSessionId } = authorization;
      const requestOrigin = request.headers.origin;
      const url = new URL(request.url ?? "/", origin);
      const pathname = url.pathname.startsWith("/api/v1/")
        ? `/api/${url.pathname.slice("/api/v1/".length)}`
        : url.pathname;
      if (
        url.origin !== origin ||
        !["GET", "POST"].includes(request.method ?? "")
      ) {
        json(response, 405, { code: "method-not-allowed" });
        return;
      }
      const cookies = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim());
      const authenticated = cookies.some((part) =>
        equal(part, `${cookieName}=${cookie}`),
      );
      if (request.method === "GET" && pathname === "/") {
        if (!validUiLocation(url) && !acceptsHtml(request.headers.accept)) {
          json(response, 400, { code: "invalid-ui-location" });
          return;
        }
        response.setHeader(
          "Set-Cookie",
          `${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Strict`,
        );
        const asset = options.assets.get(pathname);
        if (!asset) {
          json(response, 404, { code: "ui-unavailable" });
          return;
        }
        response.writeHead(200, { "Content-Type": asset.contentType });
        response.end(asset.body);
        return;
      }
      if (!authenticated) {
        json(response, 401, { code: "authentication-required" });
        return;
      }
      if (
        request.method === "GET" &&
        !url.search &&
        options.assets.has(pathname)
      ) {
        const asset = options.assets.get(pathname)!;
        response.setHeader("Cache-Control", staticAssetCacheControl(pathname));
        response.writeHead(200, { "Content-Type": asset.contentType });
        response.end(asset.body);
        return;
      }
      if (
        request.method === "POST" &&
        pathname === "/api/clients" &&
        !url.search
      ) {
        if (
          requestOrigin !== origin ||
          request.headers["x-workbench-init"] !== "1"
        ) {
          json(response, 403, { code: "csrf-required" });
          return;
        }
        object(await body(request), []);
        const clientId = session.attach();
        const grant = {
          csrf: randomBytes(32).toString("hex"),
          authSessionId,
          touched: Date.now(),
        };
        clients.set(clientId, grant);
        json(response, 201, {
          client_id: clientId,
          csrf: grant.csrf,
          view: projectedView(clientId),
        });
        return;
      }
      if (request.method === "GET" && !pathname.startsWith("/api/")) {
        json(response, 404, { code: "endpoint-not-found" });
        return;
      }
      const materialGet =
        request.method === "GET" && materialBytesPath(url.pathname) !== null;
      const queryKeys = [...url.searchParams.keys()];
      if (
        (materialGet && url.search) ||
        queryKeys.some(
          (key) =>
            ![
              "client_id",
              "session_id",
              "frame_seq",
              "limit",
              "after",
            ].includes(key) &&
            !(
              pathname === "/api/tasks" &&
              ["cursor", "status_group"].includes(key)
            ) &&
            !(
              pathname === "/api/translation/fulltext" &&
              ["literature_id", "target_language"].includes(key)
            ),
        ) ||
        new Set(queryKeys).size !== queryKeys.length
      ) {
        json(response, 400, { code: "invalid-query" });
        return;
      }
      let clientId: string;
      if (materialGet) {
        const ids = request.headersDistinct["x-sciretriever-client-id"];
        clientId = ids?.length === 1 ? ids[0]! : "";
      } else clientId = url.searchParams.get("client_id") ?? "";
      const grant = clients.get(clientId);
      if (!grant || grant.authSessionId !== authSessionId) {
        json(response, 401, { code: "client-required" });
        return;
      }
      grant.touched = Date.now();
      const sharedQueryRoute =
        queryHandler &&
        (url.pathname.startsWith("/api/v1/query/") ||
          url.pathname.startsWith("/api/v1/maintenance/"));
      if (sharedQueryRoute && request.method === "GET") {
        await queryHandler.handle(
          request,
          response,
          grant.csrf,
          authorization.actor,
        );
        return;
      }
      if (request.method === "GET" && pathname === "/api/workspace") {
        json(response, 200, {
          workspace: options.workspace ?? {
            catalog_path: null,
            artifact_root: null,
            schema_version: null,
            configuration_revision:
              options.configuration?.runtime_revision ?? null,
            capabilities: {
              tasks: !!options.tasks,
              query: !!options.query,
              maintenance: !!options.maintenance,
              discovery: !!options.discovery,
              import: !!options.importBibliography,
            },
            runtime_capabilities:
              options.configuration?.runtime_capabilities ?? null,
          },
        });
        return;
      }
      if (
        request.method === "GET" &&
        (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/"))
      ) {
        if (!options.tasks) {
          json(response, 503, { code: "tasks-unavailable" });
          return;
        }
        const parts = pathname.split("/").filter(Boolean);
        if (parts.length === 2) {
          const limit = Number(url.searchParams.get("limit") ?? "100");
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            invalidInput();
          const statusGroup = url.searchParams.get("status_group");
          if (
            statusGroup !== null &&
            !["active", "attention", "ended"].includes(statusGroup)
          )
            invalidInput();
          json(
            response,
            200,
            await options.tasks.list(
              limit,
              url.searchParams.get("cursor") ?? undefined,
              (statusGroup ?? undefined) as
                | "active"
                | "attention"
                | "ended"
                | undefined,
            ),
          );
        } else if (
          parts.length === 3 &&
          /^[A-Za-z0-9._:-]{1,128}$/u.test(parts[2]!)
        ) {
          json(response, 200, { task: await options.tasks.read(parts[2]!) });
        } else json(response, 404, { code: "endpoint-not-found" });
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/api/translation/fulltext"
      ) {
        if (!options.fullTextTranslation) {
          json(response, 503, { code: "translation-unavailable" });
          return;
        }
        try {
          json(response, 200, {
            summary: await options.fullTextTranslation.summary(
              url.searchParams.get("literature_id"),
              url.searchParams.get("target_language"),
            ),
          });
        } catch (error) {
          if (error instanceof TranslationInputError) invalidInput();
          if (error instanceof TranslationError) {
            json(response, 409, { code: error.code });
            return;
          }
          throw error;
        }
        return;
      }
      if (request.method === "GET" && pathname === "/api/translation") {
        if (!options.translation) {
          json(response, 503, { code: "translation-unavailable" });
          return;
        }
        json(response, 200, { catalog: options.translation.catalog() });
        return;
      }
      if (request.method === "GET" && pathname === "/api/view") {
        json(response, 200, projectedView(clientId));
        return;
      }
      if (request.method === "GET" && pathname === "/api/version") {
        json(response, 200, { api_version: 1 });
        return;
      }
      if (request.method === "GET" && pathname === "/api/tabs") {
        if (!options.tabs) {
          json(response, 503, { code: "tabs-unavailable" });
          return;
        }
        json(response, 200, { tabs: await options.tabs.list() });
        return;
      }
      if (request.method === "GET" && pathname === "/api/events") {
        if (streams.size >= 16) {
          json(response, 429, { code: "viewer-limit" });
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        });
        streams.add(response);
        let last = "",
          sentAt = 0;
        const send = () => {
          if (!clients.has(clientId) || !access.valid(grant.authSessionId)) {
            response.end();
            return;
          }
          const value = JSON.stringify(projectedView(clientId)),
            now = Date.now();
          // Push a changed projection promptly and an unchanged one as a 3 s heartbeat.
          if (value === last && now - sentAt < 3000) return;
          grant.touched = now;
          // A slow viewer gets the current projection after drain, never an unbounded frame queue.
          if (!response.destroyed && !response.writableNeedDrain) {
            response.write(`event: view\ndata: ${value}\n\n`);
            last = value;
            sentAt = now;
          }
        };
        send();
        // Metadata only: viewing never triggers an Agent observation.
        const timer = setInterval(send, 500);
        timer.unref();
        const archiveStop = new AbortController();
        let archiveBusy = false,
          lastRevision: string | null = null,
          agentRevision: number | null = null;
        const archiveTimer = setInterval(() => {
          const reader = options.query?.application.archive;
          if (
            !reader ||
            archiveBusy ||
            response.destroyed ||
            response.writableNeedDrain
          )
            return;
          archiveBusy = true;
          const agentReader = options.query?.application.reviewRead;
          void (async () => {
            if (agentReader) {
              const value = (await agentReader("session-revision", {})) as {
                revision: number;
              };
              if (
                !archiveStop.signal.aborted &&
                agentRevision !== value.revision
              ) {
                agentRevision = value.revision;
                response.write(
                  `event: agents\ndata: ${JSON.stringify(value)}\n\n`,
                );
              }
            }
            return reader
              .query({ operation: "revision", request: {} }, archiveStop.signal)
              .then((value) => {
                const revision = (value as { revision: string }).revision;
                if (!archiveStop.signal.aborted && revision !== lastRevision) {
                  lastRevision = revision;
                  response.write(
                    `event: materials\ndata: ${JSON.stringify({ revision })}\n\n`,
                  );
                }
              })
              .catch(() => {
                if (!archiveStop.signal.aborted) response.end();
              });
          })()
            .catch(() => {
              if (!archiveStop.signal.aborted) response.end();
            })
            .finally(() => {
              archiveBusy = false;
            });
        }, 3000);
        archiveTimer.unref();
        response.once("close", () => {
          clearInterval(timer);
          clearInterval(archiveTimer);
          archiveStop.abort();
          streams.delete(response);
        });
        return;
      }
      if (request.method === "GET" && pathname.startsWith("/api/jobs")) {
        const jobs = options.jobs;
        if (!jobs) {
          json(response, 503, { code: "jobs-unavailable" });
          return;
        }
        const parts = pathname.split("/").filter(Boolean);
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const after = Number(url.searchParams.get("after") ?? "-1");
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 1000 ||
          !Number.isSafeInteger(after) ||
          after < -1
        ) {
          json(response, 400, { code: "invalid-query" });
          return;
        }
        const id = parts[2] ?? "";
        if (id && !/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) {
          json(response, 400, { code: "invalid-job-id" });
          return;
        }
        if (parts.length === 2) {
          json(response, 200, { jobs: await jobs.list(limit) });
          return;
        }
        if (parts.length === 3) {
          json(response, 200, { job: await jobs.get(id) });
          return;
        }
        if (parts.length === 4 && parts[3] === "targets") {
          json(response, 200, { targets: await jobs.targets(id, limit) });
          return;
        }
        if (parts.length === 4 && parts[3] === "events") {
          json(response, 200, { events: await jobs.events(id, after, limit) });
          return;
        }
        if (parts.length === 4 && parts[3] === "policy") {
          json(response, 200, { policy: await jobs.policy(id) });
          return;
        }
        if (parts.length === 4 && parts[3] === "budget") {
          json(response, 200, { budget: await jobs.budget(id) });
          return;
        }
        if (parts.length === 4 && parts[3] === "interventions") {
          json(response, 200, {
            interventions: await jobs.interventions(id, limit),
          });
          return;
        }
        if (
          parts.length === 6 &&
          parts[3] === "targets" &&
          parts[5] === "attempts"
        ) {
          const targetId = parts[4] ?? "";
          if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(targetId)) {
            json(response, 400, { code: "invalid-target-id" });
            return;
          }
          json(response, 200, {
            attempts: await jobs.attempts(targetId, limit),
          });
          return;
        }
        json(response, 404, { code: "endpoint-not-found" });
        return;
      }
      if (
        request.method === "GET" &&
        (pathname === "/api/configuration/sources" ||
          pathname === "/api/configuration/apply")
      ) {
        if (!options.configuration?.sourceOperation) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        json(response, 200, {
          protocol_version: 1,
          result: await options.configuration.sourceOperation(
            pathname.endsWith("/apply") ? "apply" : "sources",
            {},
          ),
        });
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/api/configuration/status"
      ) {
        if (!options.configuration) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        json(response, 200, { status: await options.configuration.status() });
        return;
      }
      if (request.method === "GET" && pathname === "/api/configuration/read") {
        if (!options.configuration?.read) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        const snapshot = await options.configuration.read();
        json(response, 200, {
          snapshot,
          ...runtimeConfigurationState(
            options.configuration,
            snapshot,
            await options.configuration.acquisitionRoutes?.(snapshot),
          ),
        });
        return;
      }
      if (request.method === "GET") {
        if (await handleWebDeviceRoute(request, response, url, options.devices))
          return;
        json(response, 404, { code: "endpoint-not-found" });
        return;
      }
      if (
        request.method !== "POST" ||
        requestOrigin !== origin ||
        typeof request.headers["x-workbench-csrf"] !== "string" ||
        !equal(request.headers["x-workbench-csrf"], grant.csrf)
      ) {
        json(response, 403, { code: "csrf-required" });
        return;
      }
      if (sharedQueryRoute) {
        await queryHandler.handle(
          request,
          response,
          grant.csrf,
          authorization.actor,
        );
        return;
      }
      if (await manageDevices(request, response, url, origin, options.devices))
        return;
      if (await handleWebDeviceRoute(request, response, url, options.devices))
        return;
      if (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/")) {
        if (!options.tasks) {
          json(response, 503, { code: "tasks-unavailable" });
          return;
        }
        const value = await extractionBody(request, 1024 * 1024);
        const parts = pathname.split("/").filter(Boolean);
        if (parts.length === 2) {
          json(response, 201, { task: await options.tasks.create(value) });
          return;
        }
        const id = parts[2] ?? "";
        if (parts.length !== 4 || !/^[A-Za-z0-9._:-]{1,128}$/u.test(id))
          invalidInput();
        object(value, []);
        if (parts[3] === "start") {
          json(response, 202, await options.tasks.start(id));
          return;
        }
        if (!["pause", "cancel", "resume", "retry"].includes(parts[3]!))
          invalidInput();
        json(response, 200, {
          task: await options.tasks.control(
            id,
            parts[3] as "pause" | "cancel" | "resume" | "retry",
          ),
        });
        return;
      }
      if (pathname === "/api/translation/fulltext/page") {
        if (!options.fullTextTranslation) {
          json(response, 503, { code: "translation-unavailable" });
          return;
        }
        const value = await body(request);
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        try {
          json(response, 200, {
            page: await options.fullTextTranslation.page(
              value,
              controller.signal,
            ),
          });
        } catch (error) {
          if (error instanceof TranslationInputError) invalidInput();
          if (error instanceof TranslationError) {
            json(response, error.code === "translation-failed" ? 502 : 409, {
              code: error.code,
              ...(error.reason ? { reason: error.reason } : {}),
            });
            return;
          }
          throw error;
        } finally {
          response.off("close", abort);
        }
        return;
      }
      if (pathname === "/api/translation") {
        if (!options.translation) {
          json(response, 503, { code: "translation-unavailable" });
          return;
        }
        const value = await body(request);
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        try {
          json(response, 200, {
            result: await options.translation.translate(
              value,
              controller.signal,
            ),
          });
        } catch (error) {
          if (error instanceof TranslationInputError) invalidInput();
          if (error instanceof TranslationError) {
            json(
              response,
              error.code === "translation-model-unavailable" ? 409 : 502,
              {
                code: error.code,
                ...(error.reason ? { reason: error.reason } : {}),
              },
            );
            return;
          }
          throw error;
        } finally {
          response.off("close", abort);
        }
        return;
      }
      if (pathname === "/api/discovery") {
        if (!options.discovery) {
          json(response, 503, { code: "discovery-unavailable" });
          return;
        }
        const value = await body(request);
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        streams.add(response);
        try {
          json(response, 200, {
            report: await options.discovery(
              value,
              AbortSignal.any([controller.signal, stopUploads.signal]),
            ),
          });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      if (pathname === "/api/import") {
        if (!options.importBibliography) {
          json(response, 503, { code: "import-unavailable" });
          return;
        }
        json(response, 200, {
          report: await options.importBibliography(
            await extractionBody(request, 1024 * 1024),
          ),
        });
        return;
      }
      if (pathname === "/api/maintenance/ingest-pdf") {
        if (!options.maintenance) {
          json(response, 503, {
            protocol_version: 1,
            code: "maintenance-unavailable",
          });
          return;
        }
        assertRequestContentType(request, "bytes");
        if (
          request.headers["content-encoding"] !== undefined ||
          request.headers["x-sciretriever-protocol-version"] !== "1"
        )
          invalidInput();
        const literatureId = request.headers["x-literature-id"];
        if (typeof literatureId !== "string") invalidInput();
        const receipt = await receiveManualPdf(
          request,
          response,
          literatureId,
          (input, signal) => options.maintenance!.ingestPdf(input, signal),
          stopUploads.signal,
          options.maintenance.ingestPdfStream?.bind(options.maintenance),
        );
        json(response, 200, { protocol_version: 1, receipt });
        return;
      }
      if (pathname === "/api/maintenance/parse-document") {
        if (!options.maintenance) {
          json(response, 503, { code: "maintenance-unavailable" });
          return;
        }
        assertRequestContentType(request);
        if (
          request.headers["content-encoding"] !== undefined ||
          request.headers["x-sciretriever-protocol-version"] !== "1"
        )
          invalidInput();
        const receipt = await receiveDocumentRequest(
          request,
          response,
          options.maintenance.parseDocuments,
          stopUploads.signal,
        );
        json(response, 200, { protocol_version: 1, receipt });
        return;
      }
      if (
        pathname.startsWith("/api/configuration/source-") ||
        pathname === "/api/configuration/sources" ||
        pathname === "/api/configuration/apply" ||
        pathname === "/api/configuration/apply-cancel"
      ) {
        const operation = pathname.slice(
          "/api/configuration/".length,
        ) as ConfigurationOperation;
        if (
          !CONFIGURATION_OPERATIONS.includes(operation) ||
          !options.configuration?.sourceOperation
        ) {
          json(response, 404, { code: "endpoint-not-found" });
          return;
        }
        const value = await extractionBody(request, 1_048_576);
        const result = await options.configuration.sourceOperation(
          operation,
          value,
        );
        if (operation === "apply")
          response.once("finish", () =>
            options.configuration?.lifecycleFlushed?.(),
          );
        json(
          response,
          operation === "source-test" ||
            operation === "source-test-all" ||
            operation === "apply"
            ? 202
            : 200,
          { protocol_version: 1, result },
        );
        return;
      }
      const value = await body(request);
      if (pathname === "/api/acquisition/start") {
        if (!options.acquisition) {
          json(response, 503, { code: "acquisition-unavailable" });
          return;
        }
        const command = object(value, ["article_id"]);
        if (typeof command.article_id !== "string") invalidInput();
        options.acquisition.start(command.article_id);
        json(response, 202, { view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/clients/disconnect") {
        object(value, []);
        session.detach(clientId);
        clients.delete(clientId);
        json(response, 200, { disconnected: true });
        return;
      }
      if (pathname === "/api/sessions/select") {
        const command = object(value, ["session_id"]);
        if (session instanceof ProductionWorkbenchSession) {
          session.selectSession(clientId, command.session_id);
          await session.refresh(clientId);
        } else {
          if (command.session_id !== session.id) invalidInput();
          await session.refresh();
        }
        json(response, 200, { view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/guidance") {
        const guidance = session.submitGuidance(clientId, value);
        json(response, 200, { guidance, view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/guidance/cancel") {
        const guidance = session.cancelGuidance(clientId, value);
        json(response, 200, { guidance, view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/tabs/activate") {
        if (!options.tabs) {
          json(response, 503, { code: "tabs-unavailable" });
          return;
        }
        const command = object(value, ["page_id"]);
        if (
          typeof command.page_id !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/u.test(command.page_id)
        )
          invalidInput();
        await options.tabs.activate(command.page_id);
        await session.refresh();
        json(response, 200, { view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/jobs") {
        if (!options.jobs) {
          json(response, 503, { code: "jobs-unavailable" });
          return;
        }
        json(response, 201, { job: await options.jobs.create(value) });
        return;
      }
      if (pathname.startsWith("/api/jobs/") && options.jobs) {
        const parts = pathname.split("/").filter(Boolean);
        if (
          parts.length === 6 &&
          parts[3] === "interventions" &&
          parts[5] === "resolve"
        ) {
          const command = object(value, ["resolution"]);
          if (
            !["continue", "skip", "cancel"].includes(
              command.resolution as string,
            )
          )
            invalidInput();
          json(response, 200, {
            intervention: await options.jobs.resolveIntervention(
              parts[4]!,
              command.resolution as "continue" | "skip" | "cancel",
            ),
          });
          return;
        }
      }
      if (pathname.startsWith("/api/jobs/") && options.jobs) {
        const parts = pathname.split("/").filter(Boolean);
        if (parts.length === 4 && parts[3] === "run") {
          const id = parts[2] ?? "";
          if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) {
            json(response, 400, { code: "invalid-job-command" });
            return;
          }
          object(value, []);
          const controller = new AbortController();
          const abort = () => controller.abort();
          response.once("close", abort);
          try {
            json(response, 200, {
              results: await options.jobs.run(
                id,
                AbortSignal.any([controller.signal, stopUploads.signal]),
              ),
            });
          } finally {
            response.off("close", abort);
          }
          return;
        }
        const id = parts[2] ?? "";
        if (
          parts.length !== 4 ||
          !/^[A-Za-z0-9._:-]{1,128}$/u.test(id) ||
          !["pause", "resume", "cancel"].includes(parts[3]!)
        ) {
          json(response, 400, { code: "invalid-job-command" });
          return;
        }
        const action = parts[3];
        const job =
          action === "pause"
            ? await options.jobs.pause(id)
            : action === "resume"
              ? await options.jobs.resume(id)
              : await options.jobs.cancel(id);
        json(response, 200, { job });
        return;
      }
      if (pathname.startsWith("/api/library/")) {
        const library = options.library;
        if (!library) {
          json(response, 503, { code: "library-unavailable" });
          return;
        }
        switch (pathname) {
          case "/api/library/intake-batches":
            json(response, 200, {
              result: await library.queries.intakeBatches(value),
            });
            return;
          case "/api/library/facets":
            json(response, 200, {
              result: await library.queries.facets(value, stopUploads.signal),
            });
            return;
          case "/api/library/acquire-pdf/preview": {
            const r = object(value, ["selector"]);
            json(response, 200, {
              result: (
                await library.queries.pdfSelection(
                  r.selector,
                  stopUploads.signal,
                )
              ).counts,
            });
            return;
          }
          case "/api/library/intake-batches/rename":
            if (!options.query?.archiveOperation) {
              json(response, 503, { code: "operation-unavailable" });
              return;
            }
            json(response, 200, {
              result: await options.query.archiveOperation(
                "intake-batch-rename",
                value,
                stopUploads.signal,
              ),
            });
            return;
          case "/api/library/search": {
            const stop = new AbortController();
            const abort = () => stop.abort();
            response.once("close", abort);
            try {
              const page = await library.queries.search(
                value,
                AbortSignal.any([stop.signal, stopUploads.signal]),
                "browse",
              );
              if (!response.destroyed) json(response, 200, { page });
            } finally {
              response.off("close", abort);
            }
            return;
          }
          case "/api/library/detail": {
            const command = object(value, ["literature_id"]);
            json(response, 200, {
              detail: await library.queries.detail(command.literature_id),
            });
            return;
          }
          case "/api/library/references":
            json(response, 200, {
              page: await library.queries.references(value),
            });
            return;
          case "/api/library/reference": {
            const command = object(value, ["reference_id"]);
            json(response, 200, {
              detail: await library.queries.referenceDetail(
                command.reference_id,
              ),
            });
            return;
          }
          case "/api/library/bibliography": {
            const command = object(value, ["literature_id", "format"]);
            if (
              command.format !== "bibtex" &&
              command.format !== "biblatex" &&
              command.format !== "ris" &&
              command.format !== "csl-json"
            )
              invalidInput();
            if (typeof command.literature_id !== "string") invalidInput();
            const detail = await library.queries.detail(command.literature_id);
            const bytes = exportBibliography(detail, command.format);
            const contentType =
              command.format === "bibtex" || command.format === "biblatex"
                ? "application/x-bibtex; charset=utf-8"
                : command.format === "ris"
                  ? "application/x-research-info-systems; charset=utf-8"
                  : "application/json; charset=utf-8";
            const extension =
              command.format === "bibtex"
                ? "bib"
                : command.format === "biblatex"
                  ? "biblatex"
                  : command.format === "ris"
                    ? "ris"
                    : "json";
            response.writeHead(200, {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="${detail.literature.literature_id}.${extension}"`,
              "Content-Length": bytes.byteLength,
            });
            response.end(bytes);
            return;
          }
          case "/api/library/artifact": {
            const command = object(value, ["literature_id", "kind"]);
            if (command.kind !== "primary-pdf") invalidInput();
            const detail = await library.queries.detail(command.literature_id);
            const descriptor = detail.primary_pdf?.asset;
            if (!descriptor) {
              json(response, 404, { code: "artifact-not-found" });
              return;
            }
            const stop = new AbortController();
            const abort = () => stop.abort();
            response.once("close", abort);
            response.setHeader(
              "Content-Type",
              command.kind === "primary-pdf"
                ? "application/pdf"
                : "text/markdown; charset=utf-8",
            );
            response.setHeader(
              "Content-Disposition",
              `attachment; filename="${detail.literature.literature_id}.${command.kind === "primary-pdf" ? "pdf" : "md"}"`,
            );
            try {
              await library.artifacts.withArtifact(
                descriptor,
                async (chunks) => {
                  for await (const chunk of chunks) {
                    if (stop.signal.aborted)
                      throw new Error("download cancelled");
                    if (!response.write(chunk))
                      await once(response, "drain", { signal: stop.signal });
                  }
                },
                { signal: stop.signal },
              );
              response.end();
            } finally {
              response.off("close", abort);
            }
            return;
          }
          default:
            json(response, 404, { code: "endpoint-not-found" });
            return;
        }
      }
      if (pathname === "/api/configuration/status") {
        if (!options.configuration) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        json(response, 200, { status: await options.configuration.status() });
        return;
      }
      if (pathname === "/api/configuration/read") {
        if (!options.configuration?.read) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        const snapshot = await options.configuration.read();
        json(response, 200, {
          snapshot,
          ...runtimeConfigurationState(
            options.configuration,
            snapshot,
            await options.configuration.acquisitionRoutes?.(snapshot),
          ),
        });
        return;
      }
      if (pathname === "/api/configuration/diff") {
        if (!options.configuration?.diff) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        const command = object(value, ["payload", "baseline"]);
        if (
          typeof command.payload !== "string" ||
          typeof command.baseline !== "string"
        )
          invalidInput();
        json(response, 200, {
          diff: await options.configuration.diff(
            command.payload,
            command.baseline,
          ),
        });
        return;
      }
      if (pathname === "/api/configuration/publish") {
        if (!options.configuration?.publish) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        const command = object(value, ["payload", "baseline", "sections"]);
        if (
          typeof command.payload !== "string" ||
          typeof command.baseline !== "string" ||
          !Array.isArray(command.sections) ||
          command.sections.some((section) => !isConfigurationSection(section))
        )
          invalidInput();
        const snapshot = await options.configuration.publish(
          command.payload,
          command.baseline,
          command.sections as ConfigurationSection[],
        );
        json(response, 200, {
          snapshot,
          ...runtimeConfigurationState(
            options.configuration,
            snapshot,
            await options.configuration.acquisitionRoutes?.(snapshot),
          ),
        });
        return;
      }
      if (pathname === "/api/configuration/publish-json") {
        if (!options.configuration?.publishConfiguration) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        const command = object(value, [
          "configuration",
          "baseline",
          "sections",
        ]);
        if (
          typeof command.baseline !== "string" ||
          !Array.isArray(command.sections) ||
          command.sections.some((section) => !isConfigurationSection(section))
        )
          invalidInput();
        object(
          command.configuration,
          command.configuration &&
            typeof command.configuration === "object" &&
            !Object.hasOwn(command.configuration, "network")
            ? CONFIGURATION_ROOT_KEYS.filter((key) => key !== "network")
            : CONFIGURATION_ROOT_KEYS,
        );
        const snapshot = await options.configuration.publishConfiguration(
          command.configuration,
          command.baseline,
          command.sections as ConfigurationSection[],
        );
        json(response, 200, {
          snapshot,
          ...runtimeConfigurationState(
            options.configuration,
            snapshot,
            await options.configuration.acquisitionRoutes?.(snapshot),
          ),
        });
        return;
      }
      if (pathname === "/api/configuration/probe") {
        if (!options.configuration?.probe) {
          json(response, 503, { code: "configuration-probe-unavailable" });
          return;
        }
        const command = object(value, ["owner", "target", "image"]);
        if (
          !isConfigurationProbeOwner(command.owner) ||
          (command.target !== null && typeof command.target !== "string") ||
          typeof command.image !== "boolean"
        )
          invalidInput();
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        try {
          json(response, 200, {
            result: await options.configuration.probe(
              command as unknown as ConfigurationProbeRequest,
              AbortSignal.any([controller.signal, stopUploads.signal]),
            ),
          });
        } finally {
          response.off("close", abort);
        }
        return;
      }
      if (pathname === "/api/configuration/credential") {
        if (!options.configuration?.credential) {
          json(response, 503, { code: "configuration-unavailable" });
          return;
        }
        const command = object(value, ["edit", "baseline"]);
        if (typeof command.baseline !== "string") invalidInput();
        const status = await options.configuration.credential(
          command.edit as TypeScriptCredentialEdit,
          command.baseline,
        );
        const snapshot = await options.configuration.read?.();
        json(response, 200, {
          status,
          credential_effective_at: "next-external-request",
          in_flight_credential_action: "may-complete",
          ...(snapshot
            ? runtimeConfigurationState(
                options.configuration,
                snapshot,
                status.acquisition_routes,
              )
            : {
                runtime_configuration_current: null,
                ordinary_configuration_restart_required: null,
                application_restart_required: null,
                application_restart_reason: null,
                runtime_capabilities: null,
              }),
        });
        return;
      }
      if (pathname === "/api/candidate/accept") {
        await session.acceptCandidate(clientId, value);
        json(response, 200, { view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/candidate/abandon") {
        await session.abandonCandidate(clientId, value);
        json(response, 200, { view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/action") {
        const result = await session.command(clientId, value);
        await session.refresh();
        json(response, 200, { result, view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/control") {
        const production = session instanceof ProductionWorkbenchSession;
        const command = object(
          value,
          production
            ? ["kind", "control_epoch", "session_id", "article_id"]
            : ["kind", "control_epoch"],
        );
        if (production)
          session.assertBinding(
            clientId,
            command.session_id,
            command.article_id,
          );
        const epoch = command.control_epoch;
        if (
          typeof epoch !== "number" ||
          !Number.isSafeInteger(epoch) ||
          epoch < 0
        )
          invalidInput();
        switch (command.kind) {
          case "takeover":
            if (production)
              session.takeover(clientId, epoch, command.session_id as string);
            else session.takeover(clientId, epoch);
            break;
          case "release":
            if (production)
              session.release(clientId, epoch, command.session_id as string);
            else session.release(clientId, epoch);
            break;
          case "pause":
            if (production)
              session.pause(clientId, epoch, command.session_id as string);
            else session.pause(clientId, epoch);
            break;
          case "resume":
            if (production)
              session.resume(clientId, epoch, command.session_id as string);
            else session.resume(clientId, epoch);
            break;
          case "cancel":
            if (production)
              session.cancel(clientId, epoch, command.session_id as string);
            else session.cancel(clientId, epoch);
            break;
          case "agent-step": {
            // Respond immediately so a slow model cannot hold the human control channel.
            void session.runAgent(clientId, epoch).catch(() => undefined);
            break;
          }
          default:
            invalidInput();
        }
        json(response, 200, { view: projectedView(clientId) });
        return;
      }
      if (pathname === "/api/target") {
        const command = object(value, ["article_id", "control_epoch"]);
        if (
          typeof command.article_id !== "string" ||
          typeof command.control_epoch !== "number" ||
          !Number.isSafeInteger(command.control_epoch)
        )
          invalidInput();
        await session.selectTarget(
          clientId,
          command.control_epoch,
          command.article_id,
        );
        json(response, 200, { view: projectedView(clientId) });
        return;
      }
      json(response, 404, { code: "endpoint-not-found" });
    });
  }
  const screencast = new ScreencastRelay({
    server,
    ...(options.screencastMaxInFlight
      ? { maxInFlight: options.screencastMaxInFlight }
      : {}),
    authenticate: (request) => {
      const authenticated = (request.headers.cookie ?? "")
        .split(";")
        .some((part) => equal(part.trim(), `${cookieName}=${cookie}`));
      return authenticated ? access.authenticateWebSocket(request) : null;
    },
    grant: (clientId, csrf, authSessionId) => {
      const grant = clients.get(clientId);
      if (
        !grant ||
        !access.valid(authSessionId) ||
        grant.authSessionId !== authSessionId ||
        !equal(grant.csrf, csrf)
      )
        return false;
      grant.touched = Date.now();
      return true;
    },
    valid: (clientId, authSessionId) => {
      const grant = clients.get(clientId);
      if (
        !grant ||
        !access.valid(authSessionId) ||
        grant.authSessionId !== authSessionId
      )
        return false;
      grant.touched = Date.now();
      return true;
    },
    session: (clientId, sessionId) => {
      if (session instanceof ProductionWorkbenchSession)
        return session.screencastSession(clientId, sessionId);
      if (sessionId !== session.id)
        throw new WorkbenchSessionError("stale-command");
      return session;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, access.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("workbench listen failed");
  access.listening(address.port);
  // Only the serving process owns staging maintenance, never Application/CLI
  // construction. The production workspace supplies the configured store root.
  const stagingRoot = options.workspace?.artifact_root;
  const stagingLog = createLogger("file-staging");
  let stagingCleanup: Promise<void> | undefined;
  const sweepStaging = () => {
    if (closing || !stagingRoot) return Promise.resolve();
    if (stagingCleanup) return stagingCleanup;
    stagingCleanup = cleanupStaging(stagingRoot)
      .then(
        ({ files, bytes }) => {
          stagingLog.info(
            `Staging cleanup completed: removed ${files} files (${bytes} bytes)`,
          );
        },
        () => {
          stagingLog.warn("Staging cleanup failed");
        },
      )
      .finally(() => {
        stagingCleanup = undefined;
      });
    return stagingCleanup;
  };
  await sweepStaging();
  const stagingTimer = stagingRoot
    ? setInterval(() => {
        void sweepStaging();
      }, 3600000)
    : undefined;
  stagingTimer?.unref();
  const refreshTimer = setInterval(() => {
    access.sweep();
    for (const [id, grant] of clients)
      if (Date.now() - grant.touched > CLIENT_TTL) {
        clients.delete(id);
        screencast?.revoke(id);
        session.detach(id);
      }
  }, 10000);
  refreshTimer.unref();
  return {
    origin: access.origin,
    listenAddress: access.listenAddress,
    urls: access.urls,
    apiKey: access.apiKey,
    close: async () => {
      if (closing) return;
      closing = true;
      const screenClose = await Promise.allSettled([
        screencast.close(),
        options.devices?.routes?.close(),
      ]);
      access.close();
      stopUploads.abort();
      queryHandler?.close();
      clearInterval(refreshTimer);
      clearInterval(stagingTimer);
      await stagingCleanup;
      for (const response of streams) response.end();
      for (const id of clients.keys()) session.detach(id);
      clients.clear();
      const done = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await done;
      await Promise.allSettled([...pending]);
      for (const result of screenClose)
        if (result.status === "rejected") throw result.reason;
    },
  };
}

const ARCHIVE_HTTP_WRITES = [
  "form-drafts",
  "intake-batch-rename",
  "archive-arrangement-edit",
  "folders",
  "filters",
  "marks",
  "reading-open",
  "library-collect",
  "snapshot-rename",
  "archive",
  "tags",
  "snapshots",
  "metadata-edit",
  "document-role",
  "document-annotate",
  "document-publish-proofread",
  "proofread-save",
  "proofread-build",
  "proofread-decide",
  "proofread-revoke",
  "archive-references",
] as const;
const ARCHIVE_HTTP_READS = [
  "form-drafts-preview",
  "intake-batches",
  "library-facets",
  "acquire-pdf-preview",
  "index-status",
  "source-statistics",
  "archive-arrangement",
  "reading-status",
  "folders",
  "filters",
  "marks",
  "library-counts",
  "library-exact-count",
  "processor-runs",
  "literature-results",
  "usage-estimate",
  "task-run",
  "agent-sessions",
  "operation-history",
  "archive",
  "tags",
  "snapshots",
  "metadata-fields",
  "document-parts",
  "document-corrections",
  "document-annotation",
  "document-figures",
  "document-reference-texts",
  "proofread-text",
  "proofread-inspect",
  "proofread-page",
] as const;
export interface QueryOnlyHttpOptions {
  readonly archiveOperation?: (
    operation: (typeof ARCHIVE_HTTP_WRITES)[number],
    request: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly application: QueryApplication;
  /** Explicit processor submission adapter; available only with maintenance authorization. */
  readonly submitProcessor?: (
    request: unknown,
    start: boolean,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Optional explicit maintenance surface; the query-only composition never supplies it. */
  readonly maintenance?: {
    readonly ingestPdf: ManualPdfIngestionService["ingestPdf"];
    readonly ingestPdfStream?: ManualPdfIngestionService["ingestPdfStream"];
    readonly parseDocuments: DocumentProcessingService["parseDocuments"];
    readonly documentDefault?: (
      literatureId: string,
      assetId: string,
      assetSha256: string,
    ) => Promise<{
      readonly document_version_id: string;
      readonly revision: number;
    } | null>;
    readonly rebuildIndex?: (signal?: AbortSignal) => Promise<unknown>;
    readonly scheduleIndexRefresh?: () => Promise<unknown>;
    readonly scheduleIndexRebuild?: () => Promise<unknown>;
    readonly verifyIndex?: (signal?: AbortSignal) => Promise<unknown>;
    readonly verifyCatalog?: (signal?: AbortSignal) => Promise<unknown>;
    readonly extraction?: ExtractionDeliveryService;
  };
  readonly assets?: ReadonlyMap<string, WorkbenchStaticAsset>;
  readonly port?: number;
}

/** Loopback HTTP adapter for a query-only Application; it owns no Browser or Jobs. */
function createQueryHttpHandler(
  options: QueryOnlyHttpOptions,
  address: (request: IncomingMessage) => {
    readonly origin: string;
    readonly host: string;
  },
) {
  let closing = false;
  const maintenanceCookie = `sr_maintenance_${randomBytes(8).toString("hex")}`;
  const maintenanceToken = randomBytes(32).toString("hex");
  const maintenanceCsrf = randomBytes(32).toString("hex");
  const maintenanceActor = `maintenance-session:${randomBytes(16).toString("hex")}`;
  const streams = new Set<ServerResponse>();
  const verifiedBinaryStreams = new Set<ServerResponse>();
  const stopUploads = new AbortController();
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    workbenchCsrf?: string,
    authenticatedActor?: string,
  ): Promise<void> {
    if (
      deviceMaterialInUrl(request.url ?? "/") ||
      request.headers.authorization !== undefined
    ) {
      json(response, 403, {
        code: deviceMaterialInUrl(request.url ?? "/")
          ? "device-token-in-url"
          : "device-purpose-forbidden",
      });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const { origin, host } = address(request);
    const requestOrigin = request.headers.origin;
    if (
      closing ||
      request.headers.host !== host ||
      (requestOrigin !== undefined && requestOrigin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      request.headers["sec-fetch-site"] === "same-site" ||
      (workbenchCsrf === undefined && !isLoopbackPeer(request))
    ) {
      json(response, 403, {
        protocol_version: 1,
        code: "local-origin-required",
      });
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin) {
      json(response, 403, {
        protocol_version: 1,
        code: "local-origin-required",
      });
      return;
    }
    if (options.maintenance && request.method === "GET" && url.pathname === "/")
      response.setHeader(
        "Set-Cookie",
        `${maintenanceCookie}=${maintenanceToken}; Path=/; HttpOnly; SameSite=Strict`,
      );
    if (url.pathname === "/api/v1/maintenance/session") {
      if (
        !options.maintenance ||
        request.method !== "GET" ||
        (workbenchCsrf === undefined &&
          !(request.headers.cookie ?? "")
            .split(";")
            .map((part) => part.trim())
            .some((part) =>
              equal(part, `${maintenanceCookie}=${maintenanceToken}`),
            ))
      ) {
        json(response, 403, {
          protocol_version: 1,
          code: "maintenance-auth-required",
        });
        return;
      }
      json(response, 200, {
        protocol_version: 1,
        csrf: workbenchCsrf ?? maintenanceCsrf,
        actor: authenticatedActor ?? maintenanceActor,
      });
      return;
    }
    if (url.pathname === "/api/v1/maintenance/ingest-pdf") {
      if (!options.maintenance) {
        json(response, 404, {
          protocol_version: 1,
          code: "endpoint-not-found",
        });
        return;
      }
      if (
        request.method !== "POST" ||
        requestOrigin !== origin ||
        (workbenchCsrf === undefined &&
          (request.headers["x-sciretriever-csrf"] !== maintenanceCsrf ||
            !(request.headers.cookie ?? "")
              .split(";")
              .map((part) => part.trim())
              .some((part) =>
                equal(part, `${maintenanceCookie}=${maintenanceToken}`),
              )))
      ) {
        json(response, 403, {
          protocol_version: 1,
          code: "maintenance-auth-required",
        });
        return;
      }
      assertRequestContentType(request, "bytes");
      if (
        request.headers["content-encoding"] !== undefined ||
        request.headers["x-sciretriever-protocol-version"] !== "1" ||
        typeof request.headers["x-literature-id"] !== "string"
      )
        invalidInput();
      const receipt = await receiveManualPdf(
        request,
        response,
        request.headers["x-literature-id"],
        (input, signal) => options.maintenance!.ingestPdf(input, signal),
        stopUploads.signal,
        options.maintenance.ingestPdfStream?.bind(options.maintenance),
      );
      json(response, 200, { protocol_version: 1, receipt });
      return;
    }
    const extractionPaths = new Set([
      "/api/v1/maintenance/extraction-operation",
      "/api/v1/maintenance/extraction-operation-read",
      "/api/v1/maintenance/extraction-submit",
      "/api/v1/maintenance/extraction-close",
      "/api/v1/maintenance/extraction-cancel",
      "/api/v1/maintenance/extraction-receipt",
      "/api/v1/maintenance/extraction-cleanup",
    ]);
    if (
      url.pathname === "/api/v1/maintenance/parse-document" ||
      url.pathname === "/api/v1/maintenance/document-default" ||
      url.pathname === "/api/v1/maintenance/rebuild-index" ||
      url.pathname === "/api/v1/maintenance/index-refresh" ||
      url.pathname === "/api/v1/maintenance/verify-index" ||
      url.pathname === "/api/v1/maintenance/verify-catalog" ||
      url.pathname === "/api/v1/maintenance/processor-submit" ||
      extractionPaths.has(url.pathname) ||
      ARCHIVE_HTTP_WRITES.some(
        (name) => url.pathname === `/api/v1/maintenance/${name}`,
      )
    ) {
      if (!options.maintenance) {
        json(response, 404, {
          protocol_version: 1,
          code: "endpoint-not-found",
        });
        return;
      }
      if (
        request.method !== "POST" ||
        requestOrigin !== origin ||
        (workbenchCsrf === undefined &&
          (request.headers["x-sciretriever-csrf"] !== maintenanceCsrf ||
            !(request.headers.cookie ?? "")
              .split(";")
              .map((part) => part.trim())
              .some((part) =>
                equal(part, `${maintenanceCookie}=${maintenanceToken}`),
              )))
      ) {
        json(response, 403, {
          protocol_version: 1,
          code: "maintenance-auth-required",
        });
        return;
      }
      assertRequestContentType(request);
      if (
        request.headers["content-encoding"] !== undefined ||
        request.headers["x-sciretriever-protocol-version"] !== "1"
      )
        invalidInput();
      const archiveOperation = ARCHIVE_HTTP_WRITES.find(
        (name) => url.pathname === `/api/v1/maintenance/${name}`,
      );
      if (archiveOperation) {
        if (!options.archiveOperation) {
          json(response, 503, {
            protocol_version: 1,
            code: "operation-unavailable",
          });
          return;
        }
        const stop = new AbortController(),
          abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        try {
          const command = object(
            await extractionBody(
              request,
              archiveOperation === "proofread-save"
                ? 9 * 1024 * 1024
                : 1024 * 1024,
            ),
            ["protocol_version", "request"],
          );
          if (command.protocol_version !== 1) invalidInput();
          const result = await options.archiveOperation(
            archiveOperation,
            [
              "proofread-save",
              "proofread-decide",
              "proofread-revoke",
              "document-role",
            ].includes(archiveOperation)
              ? {
                  ...actorInput(command.request),
                  actor: authenticatedActor ?? maintenanceActor,
                }
              : command.request,
            AbortSignal.any([stop.signal, stopUploads.signal]),
          );
          processorReply(response, 200, { protocol_version: 1, result });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      if (url.pathname === "/api/v1/maintenance/processor-submit") {
        if (!options.submitProcessor) {
          json(response, 503, {
            protocol_version: 1,
            code: "processor-submit-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        const signal = AbortSignal.any([stop.signal, stopUploads.signal]);
        streams.add(response);
        try {
          const envelope = object(
            await extractionBody(request, PROCESSOR_SUBMIT_WIRE_BYTES),
            ["protocol_version", "request", "start"],
          );
          if (
            envelope.protocol_version !== 1 ||
            typeof envelope.start !== "boolean"
          )
            invalidInput();
          if (response.destroyed || signal.aborted) return;
          const task = await options.submitProcessor(
            envelope.request,
            envelope.start,
            signal,
          );
          if (!signal.aborted)
            processorReply(response, 202, { protocol_version: 1, task });
        } catch (error) {
          const failure = processorFailure(error);
          if (!signal.aborted)
            json(response, failure.status, {
              protocol_version: 1,
              code: failure.code,
            });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      if (extractionPaths.has(url.pathname)) {
        if (!options.maintenance.extraction) {
          json(response, 503, {
            protocol_version: 1,
            code: "maintenance-unavailable",
          });
          return;
        }
        const envelope = object(
          await extractionBody(request, EXTRACTION_SUBMISSION_WIRE_MAX_BYTES),
          ["protocol_version", "request"],
        );
        if (envelope.protocol_version !== 1) invalidInput();
        const delivery = options.maintenance.extraction;
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        stopUploads.signal.addEventListener("abort", abort, { once: true });
        streams.add(response);
        try {
          const result = await executeExtraction(
            delivery,
            url.pathname.slice(
              "/api/v1/maintenance/extraction-".length,
            ) as ExtractionOperation,
            envelope.request,
            stop.signal,
          );
          json(response, 200, { protocol_version: 1, result });
        } finally {
          streams.delete(response);
          response.off("close", abort);
          stopUploads.signal.removeEventListener("abort", abort);
        }
        return;
      }
      if (url.pathname === "/api/v1/maintenance/document-default") {
        if (!options.maintenance.documentDefault) {
          json(response, 503, {
            protocol_version: 1,
            code: "maintenance-unavailable",
          });
          return;
        }
        const selection = parseDocumentRequest(await body(request));
        const current = await options.maintenance.documentDefault(
          selection.literature_id,
          selection.asset_id,
          selection.asset_sha256,
        );
        json(response, 200, { protocol_version: 1, default: current });
        return;
      }
      if (
        [
          "/api/v1/maintenance/rebuild-index",
          "/api/v1/maintenance/index-refresh",
          "/api/v1/maintenance/verify-index",
          "/api/v1/maintenance/verify-catalog",
        ].includes(url.pathname)
      ) {
        const catalog = url.pathname.endsWith("/verify-catalog");
        const verifying = url.pathname.endsWith("/verify-index");
        const refreshing = url.pathname.endsWith("/index-refresh");
        const command = object(await body(request), [
          "protocol_version",
          "request",
        ]);
        if (command.protocol_version !== 1) invalidInput();
        let background = false;
        if (refreshing) parseIndexRefreshRequest(command.request);
        else if (catalog || verifying) {
          if (object(command.request, ["kind"]).kind !== "verify")
            invalidInput();
        } else
          background =
            parseIndexRebuildRequest(command.request).background === true;
        if (refreshing || background) {
          const queue = refreshing
            ? options.maintenance.scheduleIndexRefresh
            : options.maintenance.scheduleIndexRebuild;
          if (!queue) {
            json(response, 503, {
              protocol_version: 1,
              code: "maintenance-unavailable",
            });
            return;
          }
          // Once accepted this belongs to Application, independent of the
          // response/connection AbortController used by synchronous maintenance.
          const result = parseIndexRefreshStatus(await queue());
          json(response, 200, { protocol_version: 1, result });
          return;
        }
        const rebuild = catalog
          ? options.maintenance.verifyCatalog
          : verifying
            ? options.maintenance.verifyIndex
            : options.maintenance.rebuildIndex;
        if (!rebuild) {
          json(response, 503, {
            protocol_version: 1,
            code: "maintenance-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        stopUploads.signal.addEventListener("abort", abort, { once: true });
        streams.add(response);
        try {
          const receipt = await rebuild(stop.signal);
          const result = catalog
            ? receipt
            : verifying
              ? parseIndexVerificationResult(receipt)
              : parseRetrievalGenerationReceipt(receipt);
          json(response, 200, { protocol_version: 1, result });
        } finally {
          streams.delete(response);
          response.off("close", abort);
          stopUploads.signal.removeEventListener("abort", abort);
        }
        return;
      }
      const receipt = await receiveDocumentRequest(
        request,
        response,
        options.maintenance.parseDocuments,
        stopUploads.signal,
      );
      json(response, 200, { protocol_version: 1, receipt });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/query/status") {
      json(response, 200, {
        protocol_version: 1,
        readiness: options.application.readiness,
      });
      return;
    }
    const staticAsset =
      request.method === "GET" ? options.assets?.get(url.pathname) : undefined;
    if (staticAsset) {
      response.setHeader(
        "Cache-Control",
        staticAssetCacheControl(url.pathname),
      );
      response.writeHead(200, { "Content-Type": staticAsset.contentType });
      response.end(staticAsset.body);
      return;
    }
    const application = options.application;
    const material =
      request.method === "GET" ? materialBytesPath(url.pathname) : null;
    if (material) {
      if (url.search) {
        json(response, 400, { protocol_version: 1, code: "invalid-query" });
        return;
      }
      if (
        !application.query ||
        !application.documentRead ||
        application.readiness.status !== "ready"
      ) {
        json(response, 503, {
          protocol_version: 1,
          code:
            application.readiness.status === "not-initialized"
              ? "query-not-initialized"
              : "query-unavailable",
        });
        return;
      }
      const stop = new AbortController();
      const abort = () => stop.abort();
      response.once("close", abort);
      streams.add(response);
      verifiedBinaryStreams.add(response);
      try {
        await sendMaterialBytes(
          request,
          response,
          application.documentRead,
          material,
          AbortSignal.any([stop.signal, stopUploads.signal]),
        );
      } finally {
        verifiedBinaryStreams.delete(response);
        streams.delete(response);
        response.off("close", abort);
      }
      return;
    }
    if (request.method !== "POST") {
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        json(response, 404, { protocol_version: 1, code: "not-found" });
        return;
      }
      json(response, 405, { protocol_version: 1, code: "method-not-allowed" });
      return;
    }
    if (url.pathname === "/api/v1/query/processors") {
      const stop = new AbortController();
      const abort = () => stop.abort();
      response.once("close", abort);
      const signal = AbortSignal.any([stop.signal, stopUploads.signal]);
      streams.add(response);
      try {
        const envelope = object(
          await extractionBody(request, PROCESSOR_QUERY_WIRE_BYTES),
          ["protocol_version", "operation", "request"],
        );
        if (
          envelope.protocol_version !== 1 ||
          !(PROCESSOR_QUERIES as readonly unknown[]).includes(
            envelope.operation,
          )
        )
          invalidInput();
        if (response.destroyed || signal.aborted) return;
        const result = await queryProcessors(
          application,
          String(envelope.operation),
          envelope.request,
          signal,
        );
        processorReply(response, 200, { protocol_version: 1, result });
      } catch (error) {
        const failure = processorFailure(error);
        if (!response.destroyed)
          json(response, failure.status, {
            protocol_version: 1,
            code: failure.code,
          });
      } finally {
        streams.delete(response);
        response.off("close", abort);
      }
      return;
    }
    if (!application.query || application.readiness.status !== "ready") {
      const code =
        application.readiness.status === "not-initialized"
          ? "query-not-initialized"
          : "query-unavailable";
      json(response, 503, { protocol_version: 1, code });
      return;
    }
    const command = object(
      await (url.pathname === "/api/v1/query/extraction-prepare" ||
      url.pathname.startsWith("/api/v1/query/knowledge-") ||
      url.pathname.startsWith("/api/v1/query/synthesis-")
        ? extractionBody(
            request,
            url.pathname === "/api/v1/query/extraction-prepare" ||
              url.pathname === "/api/v1/query/synthesis-prepare" ||
              url.pathname === "/api/v1/query/knowledge-context"
              ? 310 * 1024
              : 8192,
          )
        : body(request)),
      ["protocol_version", "request"],
    );
    if (command.protocol_version !== 1) invalidInput();
    const archiveRead = ARCHIVE_HTTP_READS.find(
      (name) => url.pathname === `/api/v1/query/${name}`,
    );
    if (archiveRead) {
      const stop = new AbortController(),
        abort = () => stop.abort();
      response.once("close", abort);
      streams.add(response);
      try {
        const signal = AbortSignal.any([stop.signal, stopUploads.signal]);
        const result =
          archiveRead === "intake-batches" &&
          (command.request as { operation?: unknown } | null)?.operation ===
            "list-summary"
            ? await application.query.intakeBatchSummaries(
                command.request,
                signal,
              )
            : await executeQuery(
                application,
                archiveRead,
                command.request,
                signal,
              );
        processorReply(response, 200, { protocol_version: 1, result });
      } finally {
        streams.delete(response);
        response.off("close", abort);
      }
      return;
    }
    switch (url.pathname) {
      case "/api/v1/query/folders-export": {
        if (!application.folders) {
          json(response, 503, {
            protocol_version: 1,
            code: "query-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        const signal = AbortSignal.any([stop.signal, stopUploads.signal]);
        response.once("close", abort);
        streams.add(response);
        try {
          await application.folders.withExportFile(
            command.request,
            async (chunks) => {
              response.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Disposition":
                  'attachment; filename="sciretriever-folders.json"',
                "X-Sciretriever-Protocol-Version": "1",
              });
              for await (const chunk of chunks) {
                signal.throwIfAborted();
                if (!response.write(chunk))
                  await once(response, "drain", { signal });
              }
            },
            signal,
          );
          response.end();
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      case "/api/v1/query/extraction-prepare":
      case "/api/v1/query/context": {
        const operation =
          url.pathname === "/api/v1/query/extraction-prepare"
            ? "extraction-prepare"
            : "context";
        if (
          operation === "context"
            ? !application.context
            : !application.extractionPreparation
        ) {
          json(response, 503, {
            protocol_version: 1,
            code: "query-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        try {
          const result = await executeQuery(
            application,
            operation,
            command.request,
            AbortSignal.any([stop.signal, stopUploads.signal]),
          );
          json(response, 200, { protocol_version: 1, result });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      case "/api/v1/query/knowledge-context": {
        if (!application.knowledgeContext) {
          json(response, 422, {
            protocol_version: 1,
            code: "catalog-v8-required",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        try {
          const result = await executeQuery(
            application,
            "knowledge-context",
            command.request,
            stop.signal,
          );
          json(response, 200, { protocol_version: 1, result });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      case "/api/v1/query/document-parsing-status": {
        const result = await executeQuery(
          application,
          "document-parsing-status",
          command.request,
        );
        json(response, 200, { protocol_version: 1, result });
        return;
      }
      case "/api/v1/query/document-default":
      case "/api/v1/query/document-describe":
      case "/api/v1/query/document-outline":
      case "/api/v1/query/document-segments":
      case "/api/v1/query/document-resources":
      case "/api/v1/query/document-slice":
      case "/api/v1/query/document-draft-differences":
      case "/api/v1/query/document-resource":
      case "/api/v1/query/material-evidence":
      case "/api/v1/query/evidence-resolve": {
        const reader = application.documentRead;
        if (!reader) {
          json(response, 503, {
            protocol_version: 1,
            code: "query-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        try {
          const kind =
            url.pathname === "/api/v1/query/document-default"
              ? "default"
              : url.pathname === "/api/v1/query/document-describe"
                ? "describe"
                : url.pathname === "/api/v1/query/document-outline"
                  ? "outline"
                  : url.pathname === "/api/v1/query/document-segments"
                    ? "segments"
                    : url.pathname === "/api/v1/query/document-resources"
                      ? "resources"
                      : url.pathname ===
                          "/api/v1/query/document-draft-differences"
                        ? "draft-differences"
                        : url.pathname === "/api/v1/query/document-slice"
                          ? "slice"
                          : url.pathname === "/api/v1/query/document-resource"
                            ? "resource"
                            : url.pathname === "/api/v1/query/material-evidence"
                              ? "material"
                              : "evidence";
          const readRequest =
            kind === "evidence" &&
            command.request &&
            typeof command.request === "object" &&
            !Array.isArray(command.request) &&
            !Object.hasOwn(command.request, "evidence")
              ? {
                  evidence: command.request,
                  max_bytes: 65536,
                  continuation: null,
                }
              : command.request;
          const parsed = await executeQuery(
            application,
            `document-${kind}` as QueryOperation,
            readRequest,
            stop.signal,
          );
          json(response, 200, { protocol_version: 1, result: parsed });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      case "/api/v1/query/search": {
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        try {
          const page = await executeQuery(
            application,
            "library-search",
            command.request,
            AbortSignal.any([stop.signal, stopUploads.signal]),
          );
          if (!response.destroyed)
            json(response, 200, { protocol_version: 1, page });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      case "/api/v1/query/read": {
        const request = object(command.request, ["literature_id"]);
        json(response, 200, {
          protocol_version: 1,
          detail: await executeQuery(application, "literature-read", request),
        });
        return;
      }
      case "/api/v1/query/references":
        json(response, 200, {
          protocol_version: 1,
          page: await executeQuery(application, "references", command.request),
        });
        return;
      case "/api/v1/query/reference": {
        const request = object(command.request, ["reference_id"]);
        json(response, 200, {
          protocol_version: 1,
          detail: await executeQuery(application, "reference-read", request),
        });
        return;
      }
      case "/api/v1/query/document-resource-bytes": {
        if (!application.documentRead) {
          json(response, 503, {
            protocol_version: 1,
            code: "query-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        verifiedBinaryStreams.add(response);
        try {
          await application.documentRead.withResourceBytes(
            command.request,
            async (document, resource, chunks) => {
              const extension = resource.artifact.media_type.slice(6);
              response.writeHead(200, {
                "Content-Type": resource.artifact.media_type,
                "Content-Disposition": `inline; filename="${resource.artifact.sha256}.${extension === "jpeg" ? "jpg" : extension}"`,
                "X-Sciretriever-Protocol-Version": "1",
                "X-Sciretriever-Document-Version-Id":
                  document.document_version_id,
                "X-Sciretriever-Representation-Sha256":
                  document.representation_sha256,
                "X-Sciretriever-Resource-Id": resource.resource_id,
                "X-Sciretriever-Resource-Sha256": resource.artifact.sha256,
                "X-Sciretriever-Byte-Size": String(resource.artifact.byte_size),
              });
              for await (const chunk of chunks) {
                if (stop.signal.aborted)
                  throw new DocumentReadError("document-cancelled");
                if (!response.write(chunk))
                  await once(response, "drain", { signal: stop.signal });
              }
            },
            stop.signal,
          );
          response.end();
        } finally {
          verifiedBinaryStreams.delete(response);
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      case "/api/v1/query/material-bytes": {
        if (!application.documentRead) {
          json(response, 503, {
            protocol_version: 1,
            code: "query-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        verifiedBinaryStreams.add(response);
        try {
          await application.documentRead.withMaterialBytes(
            command.request,
            async (material, chunks) => {
              response.writeHead(200, pdfMaterialHeaders(material));
              for await (const chunk of chunks) {
                if (stop.signal.aborted)
                  throw new DocumentReadError("document-cancelled");
                if (!response.write(chunk))
                  await once(response, "drain", { signal: stop.signal });
              }
            },
            stop.signal,
          );
          response.end();
        } finally {
          verifiedBinaryStreams.delete(response);
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      case "/api/v1/query/artifact": {
        const read = object(command.request, ["literature_id", "kind"]);
        if (read.kind !== "primary-pdf") invalidInput();
        const detail = await application.query.detail(read.literature_id);
        const artifact = detail.primary_pdf?.asset;
        if (!artifact) {
          json(response, 200, {
            protocol_version: 1,
            gap: {
              literature_id: detail.literature.literature_id,
              code: "missing-primary-pdf",
            },
          });
          return;
        }
        if (!application.literatureArtifacts) {
          json(response, 503, {
            protocol_version: 1,
            code: "artifact-unavailable",
          });
          return;
        }
        const stop = new AbortController();
        const abort = () => stop.abort();
        response.once("close", abort);
        streams.add(response);
        try {
          await application.literatureArtifacts.withArtifact(
            artifact,
            async (chunks) => {
              response.writeHead(200, {
                "Content-Type": artifact.media_type,
                "Content-Disposition": `attachment; filename="${detail.literature.literature_id}.${read.kind === "primary-pdf" ? "pdf" : "md"}"`,
                "X-Sciretriever-Protocol-Version": "1",
              });
              for await (const chunk of chunks) {
                if (stop.signal.aborted)
                  throw new Error("query artifact read cancelled");
                if (!response.write(chunk))
                  await once(response, "drain", { signal: stop.signal });
              }
            },
            { signal: stop.signal },
          );
          response.end();
        } catch {
          if (response.headersSent) response.destroy();
          else
            json(response, 503, {
              protocol_version: 1,
              code: "artifact-unavailable",
            });
        } finally {
          streams.delete(response);
          response.off("close", abort);
        }
        return;
      }
      default:
        json(response, 404, {
          protocol_version: 1,
          code: "endpoint-not-found",
        });
    }
  }

  return {
    handle: (
      request: IncomingMessage,
      response: ServerResponse,
      workbenchCsrf?: string,
      authenticatedActor?: string,
    ) =>
      withActivity({ actor: authenticatedActor ?? maintenanceActor }, () =>
        handle(request, response, workbenchCsrf, authenticatedActor),
      ).catch((error: unknown) => {
        if (error instanceof RequestContentTypeError) {
          if (response.headersSent || response.destroyed) response.destroy();
          else json(response, 415, { protocol_version: 1, code: error.code });
          return;
        }
        const corruption = catalogCorruption(error);
        if (corruption) {
          if (response.headersSent || response.destroyed) response.destroy();
          else
            json(response, 503, {
              protocol_version: 1,
              code: corruption.code,
              maintenance_hint: corruption.maintenance_hint,
              technical_details: { sqlite_code: corruption.sqlite_code },
            });
          return;
        }
        const route = (request.url ?? "").split("?")[0]!;
        if (
          route === "/api/v1/query/folders-export" ||
          ARCHIVE_HTTP_READS.some((n) => route === `/api/v1/query/${n}`) ||
          ARCHIVE_HTTP_WRITES.some((n) => route === `/api/v1/maintenance/${n}`)
        ) {
          const code =
            isMaintenanceFailure(error) || isQueryFailure(error)
              ? error.code
              : error instanceof ContractValidationError ||
                  (route === "/api/v1/maintenance/library-collect" &&
                    error instanceof WorkbenchInputError)
                ? "invalid-request"
                : "operation-unavailable";
          if (response.headersSent || response.destroyed) response.destroy();
          else
            json(
              response,
              /conflict|stale|busy/.test(code)
                ? 409
                : /invalid/.test(code)
                  ? 400
                  : 422,
              { protocol_version: 1, code },
            );
          return;
        }
        if (
          request.url?.startsWith("/api/v1/maintenance/ingest-pdf") ||
          request.url?.startsWith("/api/v1/maintenance/parse-document") ||
          request.url?.startsWith("/api/v1/maintenance/document-default") ||
          request.url?.startsWith("/api/v1/maintenance/rebuild-index") ||
          request.url?.startsWith("/api/v1/maintenance/index-refresh") ||
          request.url?.startsWith("/api/v1/maintenance/verify-index") ||
          request.url?.startsWith("/api/v1/maintenance/verify-catalog") ||
          request.url?.startsWith("/api/v1/maintenance/extraction-")
        ) {
          const failure = maintenanceError(error);
          if (response.headersSent || response.destroyed) response.destroy();
          else
            json(response, failure.status, {
              protocol_version: 1,
              code: failure.code,
              ...(failure.issue ? { issue: failure.issue } : {}),
              ...(failure.reason
                ? { reason: failure.reason, retryable: failure.retryable }
                : {}),
            });
          return;
        }
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (error instanceof LibrarySortScopeLimitError) {
          json(response, 400, { protocol_version: 1, code: error.code });
          return;
        }
        const code =
          error instanceof MaterialContextError ||
          error instanceof KnowledgeContextError
            ? error.code
            : error instanceof DocumentReadError
              ? error.code
              : error instanceof ContractValidationError ||
                  error instanceof WorkbenchInputError
                ? "invalid-command"
                : error instanceof ManualPdfInputError ||
                    error instanceof LiteraturePublicationError ||
                    error instanceof CandidateAcceptanceError
                  ? error.code
                  : error instanceof PdfAcceptanceError
                    ? "manual-pdf-invalid"
                    : error instanceof LiteratureNotFoundError
                      ? "literature-not-found"
                      : error instanceof LiteratureQueryError
                        ? "query-reference-invalid"
                        : "query-unavailable";
        const status =
          error instanceof MaterialContextError ||
          error instanceof KnowledgeContextError
            ? error.code === "context-cursor-invalid" ||
              error.code === "context-budget-invalid" ||
              error.code === "context-tokenizer-unsupported"
              ? 400
              : 503
            : error instanceof DocumentReadError
              ? error.code === "document-invalid"
                ? 400
                : error.code === "material-stale"
                  ? 409
                  : error.code === "document-missing" ||
                      error.code === "material-missing"
                    ? 404
                    : error.code === "document-v3-required" ||
                        error.code === "document-unsupported"
                      ? 422
                      : 503
              : error instanceof ContractValidationError ||
                  error instanceof WorkbenchInputError
                ? 400
                : error instanceof ManualPdfInputError ||
                    error instanceof PdfAcceptanceError ||
                    (error instanceof LiteraturePublicationError &&
                      error.code !== "primary-asset-conflict")
                  ? 400
                  : error instanceof CandidateAcceptanceError &&
                      error.code === "literature-not-found"
                    ? 404
                    : error instanceof LiteratureNotFoundError
                      ? 404
                      : error instanceof LiteratureQueryError
                        ? 409
                        : 503;
        json(response, status, { protocol_version: 1, code });
      }),
    close: () => {
      closing = true;
      stopUploads.abort();
      for (const response of streams)
        if (verifiedBinaryStreams.has(response)) response.destroy();
        else response.end();
    },
  };
}

/** Loopback HTTP adapter for a query-only Application; it owns no Browser or Jobs. */
export async function startQueryOnlyHttp(
  options: QueryOnlyHttpOptions,
): Promise<{ readonly origin: string; close(): Promise<void> }> {
  let origin = "";
  let host = "";
  let closing = false;
  const pending = new Set<Promise<void>>();
  const handler = createQueryHttpHandler(options, () => ({ origin, host }));
  const server = createServer(
    { requestTimeout: 0, headersTimeout: 5000, maxHeaderSize: 8192 },
    (request, response) => {
      guardRequestBody(request, response);
      const operation = withoutRestartAdmission(() =>
        handler.handle(request, response),
      );
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => {
          pending.delete(operation);
          response.destroy();
        },
      );
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("query HTTP listen failed");
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  return {
    origin,
    close: async () => {
      if (closing) return;
      closing = true;
      handler.close();
      const done = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await done;
      await Promise.allSettled([...pending]);
    },
  };
}
