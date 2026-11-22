import { ArchiveContractObsoleteError } from "@sciretriever/contracts";
import { ArchiveTextError } from "../archive/text-source.js";
import { FilterError } from "../literature/filters.js";
import { FolderError } from "../literature/folders.js";
import { presentActors } from "../logging/actor-label.js";
import {
  ContractValidationError,
  IMPORT_LIMITS,
  importInteger,
  createInputManifest,
  parseAssetId,
  parseDocumentReadRequest,
  parseDocumentDraftDifferencesRequest,
  parseDocumentDraftDifferencesResult,
  parseDocumentReadResult,
  parseFormDraftsPartResult,
  parseLiteratureId,
  type DocumentReadOperation,
  type InputManifestItem,
} from "@sciretriever/contracts";
import { SnapshotError } from "../analysis/snapshots.js";
import { ArchiveError } from "../archive/orchestrator.js";
import type { QueryApplication } from "../bootstrap/application.js";
import { AnnotationError } from "../document/annotations.js";
import { DocumentReadError } from "../document/read.js";
import { ExtractionPreparationError } from "../extraction/prepare.js";
import { ExtractionSpecError } from "../extraction/spec.js";
import { MetadataFieldError } from "../literature/metadata-service.js";
import {
  LiteratureNotFoundError,
  LiteratureQueryError,
  LibrarySortScopeLimitError,
} from "../literature/query.js";
import { ProofreadError } from "../proofread/service.js";
import { KnowledgeContextError } from "../retrieval/knowledge-query.js";
import { MaterialContextError } from "../retrieval/query.js";
import { TagError } from "../tags/rules.js";
import {
  exportBibliographyRequest,
  LibraryTransferError,
  readLibraryArtifact,
} from "./library-transfer.js";
import { queryTags } from "./tag-operations.js";

export class ProductOperationError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
export function operationRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(r, k)) ||
    Object.keys(r).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new ContractValidationError();
  return r;
}
function unavailable(): never {
  throw new ProductOperationError("query-unavailable");
}
export const QUERY_OPERATIONS = [
  "intake-batch-status",
  "intake-batch-report",
  "operation-history",
  "agent-sessions",
  "task-run",
  "source-statistics",
  "index-status",
  "usage-estimate",
  "processor-runs",
  "literature-results",
  "snapshots",
  "archive",
  "archive-arrangement",
  "tags",
  "metadata-fields",
  "status",
  "intake-batches",
  "library-facets",
  "acquire-pdf-preview",
  "form-drafts-preview",
  "library-search",
  "library-counts",
  "library-exact-count",
  "folders",
  "filters",
  "marks",
  "literature-read",
  "artifact-chunk",
  "bibliography-export",
  "references",
  "reference-read",
  "article-identity",
  "task-read",
  "task-list",
  "task-detail",
  "document-annotation",
  "document-figures",
  "document-reference-texts",
  "proofread-text",
  "reading-status",
  "proofread-inspect",
  "proofread-page",
  "document-parts",
  "document-corrections",
  "document-draft-differences",
  "document-parsing-status",
  "document-default",
  "document-describe",
  "document-outline",
  "document-segments",
  "document-slice",
  "document-resources",
  "document-resource",
  "document-evidence",
  "document-material",
  "analysis-inputs",
  "context",
  "knowledge-context",
  "extraction-prepare",
] as const;
export type QueryOperation = (typeof QUERY_OPERATIONS)[number];
/** Closed product operations shared by protocol adapters. Never initializes or writes a library. */
async function readQuery(
  q: QueryApplication,
  operation: QueryOperation,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new ProductOperationError("operation-cancelled");
  if (
    operation === "intake-batch-status" ||
    operation === "intake-batch-report"
  ) {
    const r = operationRecord(
      value,
      ["batch_id"],
      operation === "intake-batch-report" ? ["cursor", "limit"] : [],
    );
    if (!q.importSessions) unavailable();
    const sessionId = parseAssetId(r.batch_id);
    if (operation === "intake-batch-status")
      return { batch: await q.importSessions.status(sessionId) };
    const cursor =
      r.cursor === undefined || r.cursor === null ? null : r.cursor;
    if (
      cursor !== null &&
      (typeof cursor !== "string" || !/^\d{1,4}:\d{1,6}$/u.test(cursor))
    )
      throw new ContractValidationError();
    const limit =
      r.limit === undefined
        ? 50
        : importInteger(r.limit, IMPORT_LIMITS.page_items);
    if (limit < 1) throw new ContractValidationError();
    return q.importSessions.report(sessionId, cursor, limit);
  }
  if (operation === "status") {
    operationRecord(value, []);
    return q.readiness;
  }
  if (operation === "source-statistics") {
    if (!q.tasks || q.readiness.status !== "ready") unavailable();
    return q.tasks.sourceStatistics(value, signal);
  }
  if (operation === "index-status") {
    operationRecord(value, []);
    if (!q.indexRefreshStatus) unavailable();
    return q.indexRefreshStatus();
  }
  if (q.readiness.status !== "ready" || !q.query) unavailable();
  if (
    operation === "document-figures" ||
    operation === "document-reference-texts"
  ) {
    if (!q.annotationRead) unavailable();
    const r = operationRecord(value, [
      "document_version_id",
      "annotation_id",
      "max_bytes",
      "continuation",
    ]);
    return q.annotationRead.read(
      {
        ...r,
        field: operation === "document-figures" ? "figures" : "references",
      },
      signal,
    );
  }
  if (operation === "filters") {
    if (!q.filters) unavailable();
    return q.filters.query(value, signal);
  }
  if (operation === "folders") {
    if (!q.folders) unavailable();
    return q.folders.query(value, signal);
  }
  if (operation === "marks") {
    if (!q.marks) unavailable();
    return q.marks.query(value, signal);
  }
  if (operation === "snapshots") {
    if (!q.snapshots) unavailable();
    return q.snapshots.query(value, signal);
  }
  if (operation === "archive-arrangement") {
    if (!q.archiveArrangement) unavailable();
    return q.archiveArrangement.read(value, signal);
  }
  if (operation === "archive") {
    if (!q.archive) unavailable();
    return q.archive.query(value, signal);
  }
  if (operation === "tags") {
    if (!q.tags) unavailable();
    return queryTags(q.tags, value, signal);
  }
  if (operation === "metadata-fields") {
    if (!q.metadataFields) unavailable();
    const r = operationRecord(value, ["literature_id"]);
    const result = await q.metadataFields.read(
      parseLiteratureId(r.literature_id),
      signal,
    );
    return {
      literature_id: result.literature.literature_id,
      metadata: result.literature.metadata,
      metadata_revision: result.metadata_revision,
      metadata_sha256: result.metadata_sha256,
      fields: result.field_states,
    };
  }
  if (operation === "document-annotation") {
    if (!q.annotationRead) unavailable();
    return q.annotationRead.read(value, signal);
  }
  if (operation === "processor-runs" || operation === "literature-results") {
    if (!q.reviewRead) unavailable();
    if (operation === "processor-runs")
      operationRecord(
        value,
        [],
        [
          "processor_id",
          "snapshot_id",
          "literature_id",
          "literature_query",
          "stale",
          "offset",
          "limit",
        ],
      );
    else operationRecord(value, ["literature_id"], ["offset", "limit"]);
    return q.reviewRead(operation, value);
  }
  if (operation === "intake-batches") return q.query.intakeBatches(value);
  if (operation === "library-facets") return q.query.facets(value, signal);
  if (operation === "acquire-pdf-preview") {
    const r = operationRecord(value, ["selector"]);
    return (await q.query.pdfSelection(r.selector, signal)).counts;
  }
  if (operation === "form-drafts-preview") {
    if (!q.formDraftsPreview) unavailable();
    return q.formDraftsPreview(value, signal);
  }
  if (operation === "usage-estimate") {
    if (!q.usageEstimate) unavailable();
    return q.usageEstimate(value, signal);
  }
  if (operation === "task-run") {
    if (!q.reviewRead) unavailable();
    const r = operationRecord(
      value,
      ["job_id"],
      ["offset", "limit", "target_id", "member_offset", "member_limit"],
    );
    const report = await q.reviewRead("task-run", value);
    if (!report || !q.tasks) return report;
    const task = await q.tasks.read(String(r.job_id));
    const selector = task.job.selector;
    if (
      selector &&
      typeof selector === "object" &&
      "goal" in selector &&
      selector.goal === "draft"
    ) {
      if (
        typeof report !== "object" ||
        !("items" in report) ||
        !Array.isArray(report.items)
      )
        throw new TypeError("draft task run report is invalid");
      const receipts = new Map<
        string,
        ReturnType<typeof parseFormDraftsPartResult>[]
      >();
      // A complete receipt wins over earlier partial attempts; otherwise the
      // latest partial receipt preserves committed work after cancellation.
      for (const value of [...task.partial_results, ...task.results]) {
        if (
          !value ||
          typeof value !== "object" ||
          !("target_id" in value) ||
          !("result" in value)
        )
          continue;
        const result = value.result;
        if (
          result &&
          typeof result === "object" &&
          "parts" in result &&
          Array.isArray(result.parts)
        )
          receipts.set(
            String(value.target_id),
            result.parts.map(parseFormDraftsPartResult),
          );
      }
      return {
        ...report,
        items: report.items.map((item: Record<string, unknown>) => ({
          ...item,
          operation: "form-drafts",
          draft_parts: receipts.get(String(item.target_id)) ?? [],
        })),
        source_results: task.source_results,
        scope: task.scope,
      };
    }
    return {
      ...report,
      source_results: task.source_results,
      scope: task.scope,
    };
  }
  if (operation === "agent-sessions") {
    if (!q.reviewRead) unavailable();
    const r = operationRecord(value, ["operation", "request"]);
    if (r.operation === "list") {
      operationRecord(
        r.request,
        [],
        ["job_id", "literature_id", "status", "before", "limit"],
      );
      return q.reviewRead("session-list", r.request);
    }
    if (r.operation === "read") {
      operationRecord(r.request, ["session_id"], ["after", "limit"]);
      return q.reviewRead("session-read", r.request);
    }
    if (r.operation === "revision") {
      operationRecord(r.request, []);
      return q.reviewRead("session-revision", {});
    }
    throw new ContractValidationError();
  }
  if (operation === "operation-history") {
    if (!q.reviewRead) unavailable();
    operationRecord(value, [], ["actor", "operation", "after", "limit"]);
    return q.reviewRead("audit-list", value);
  }
  if (operation === "reading-status") {
    if (!q.proofreadRead) unavailable();
    return q.proofreadRead.readingStatus(value, signal);
  }
  if (operation === "proofread-text") {
    if (!q.proofreadRead) unavailable();
    return q.proofreadRead.editor(value, signal);
  }
  if (operation === "proofread-page") {
    if (!q.proofreadRead) unavailable();
    return q.proofreadRead.page(value, signal);
  }
  if (operation === "proofread-inspect") {
    const arranged = await q.archiveArrangement?.inspect(value, signal);
    if (arranged) return arranged;
    if (!q.proofreadRead) unavailable();
    return q.proofreadRead.inspect(value, signal);
  }
  if (operation === "document-draft-differences") {
    if (!q.documentRead) unavailable();
    let request;
    try {
      request = parseDocumentDraftDifferencesRequest(value);
    } catch (error) {
      throw new DocumentReadError("document-invalid", { cause: error });
    }
    return parseDocumentDraftDifferencesResult(
      await q.documentRead.draftDifferences(request, signal),
      request,
    );
  }
  if (operation === "document-corrections") {
    if (!q.documentRead) unavailable();
    return q.documentRead.corrections(value, signal);
  }
  if (operation === "document-parts") {
    const r = operationRecord(value, ["literature_id", "offset", "limit"]);
    const literatureId = parseLiteratureId(r.literature_id);
    if (
      !Number.isSafeInteger(r.offset) ||
      Number(r.offset) < 0 ||
      !Number.isSafeInteger(r.limit) ||
      Number(r.limit) < 1 ||
      Number(r.limit) > 200
    )
      throw new ContractValidationError();
    if (!q.documentRead) unavailable();
    // Verify the literature even if it has no accepted parts; ordering is acceptance row order, never source observation time.
    await q.query.detail(literatureId);
    const offset = Number(r.offset),
      page = await q.documentRead.parts(
        literatureId,
        offset,
        Number(r.limit),
        signal,
      );
    const parts = [];
    for (const a of page.items) {
      if (signal?.aborted)
        throw new ProductOperationError("operation-cancelled");
      const material = await q.documentRead.default(
        {
          literature_id: literatureId,
          asset_id: a.asset_id,
          asset_sha256: a.asset_sha256,
        },
        signal,
      );
      const proofread = await q.proofreadRead?.status(
        { asset_id: a.asset_id },
        signal,
      );
      parts.push({
        ...a,
        default: material.default,
        proofread: proofread?.current ?? null,
      });
    }
    const end = offset + page.items.length;
    return {
      literature_id: literatureId,
      parts,
      total: page.total,
      next_offset: end < page.total ? end : null,
    };
  }
  if (operation === "document-parsing-status") {
    const request = operationRecord(value, ["literature_id", "asset_id"]);
    const literatureId = parseLiteratureId(request.literature_id);
    const assetId = parseAssetId(request.asset_id);
    const detail = await q.query.detail(literatureId);
    const assets = [
      ...(detail.primary_pdf ? [detail.primary_pdf] : []),
      ...detail.additional_assets,
    ];
    const asset = assets.find((a) => a.asset.asset_id === assetId)?.asset;
    if (!asset) throw new ProductOperationError("material-missing");
    if (!q.rawParseRead) unavailable();
    const statuses = await q.rawParseRead.current(assetId, signal);
    return {
      literature_id: literatureId,
      asset_id: assetId,
      asset_sha256: asset.sha256,
      archive_profile: q.archiveProfile ?? "vlm-engine",
      profiles: ["pipeline", "vlm-engine", "vlm-engine-markdown-only"].map(
        (profile) => {
          const status = statuses.find((s) => s.profile === profile);
          return {
            profile,
            is_archive_profile: profile === (q.archiveProfile ?? "vlm-engine"),
            raw_parse_id: status?.result?.raw_parse_id ?? null,
            result_sha256: status?.result?.result_sha256 ?? null,
            failure_code: status?.last_failure_code ?? null,
          };
        },
      ),
    };
  }
  if (operation.startsWith("document-")) {
    const reader = q.documentRead;
    if (!reader) unavailable();
    const kind = operation.slice(9) as DocumentReadOperation;
    let request;
    try {
      request = parseDocumentReadRequest(kind, value);
    } catch (error) {
      throw new DocumentReadError("document-invalid", { cause: error });
    }
    let result: unknown;
    switch (kind) {
      case "default":
        result = await reader.default(request, signal);
        break;
      case "describe":
        result = await reader.describe(request, signal);
        break;
      case "outline":
        result = await reader.outline(request, signal);
        break;
      case "segments":
        result = await reader.segments(request, signal);
        break;
      case "slice":
        result = await reader.slice(request, signal);
        break;
      case "resources":
        result = await reader.resources(request, signal);
        break;
      case "resource":
        result = await reader.resource(request, signal);
        break;
      case "evidence":
        result = await reader.resolveEvidence(request, signal);
        break;
      case "material":
        result = await reader.materialEvidence(request, signal);
        break;
      default:
        throw new ContractValidationError();
    }
    try {
      return parseDocumentReadResult(kind, result, request);
    } catch (error) {
      throw new DocumentReadError("document-integrity", { cause: error });
    }
  }
  switch (operation) {
    case "artifact-chunk":
      return readLibraryArtifact(q, value, signal);
    case "bibliography-export":
      return exportBibliographyRequest(q, value);
    case "library-counts":
      return q.query.counts(operationRecord(value, ["query"]).query, signal);
    case "library-exact-count":
      return q.query.exactCount(value, signal);
    case "library-search":
      return q.query.search(value, signal, "browse");
    case "literature-read":
      return q.query.detail(
        parseLiteratureId(
          operationRecord(value, ["literature_id"]).literature_id,
        ),
      );
    case "references":
      return q.query.references(value);
    case "reference-read":
      return q.query.referenceDetail(
        operationRecord(value, ["reference_id"]).reference_id,
      );
    case "article-identity":
      if (!q.articleIdentityRead) unavailable();
      return q.articleIdentityRead(
        parseAssetId(operationRecord(value, ["assessment_id"]).assessment_id),
      );
    case "task-read": {
      if (!q.taskRead) unavailable();
      const r = operationRecord(value, ["job_id"]);
      if (
        typeof r.job_id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(r.job_id)
      )
        throw new ContractValidationError();
      return q.tasks ? q.tasks.read(r.job_id) : q.taskRead(r.job_id);
    }
    case "task-list": {
      if (!q.tasks) unavailable();
      const r = operationRecord(value, [], ["limit", "cursor", "status_group"]);
      const limit = r.limit ?? 100;
      if (
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        (r.cursor !== undefined &&
          r.cursor !== null &&
          typeof r.cursor !== "string") ||
        (r.status_group !== undefined &&
          !["active", "attention", "ended"].includes(String(r.status_group)))
      )
        throw new ContractValidationError();
      return q.tasks.list(
        limit,
        typeof r.cursor === "string" ? r.cursor : undefined,
        r.status_group as "active" | "attention" | "ended" | undefined,
      );
    }
    case "task-detail": {
      if (!q.tasks) unavailable();
      const r = operationRecord(value, ["job_id"]);
      if (
        typeof r.job_id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(r.job_id)
      )
        throw new ContractValidationError();
      return q.tasks.read(r.job_id);
    }
    case "context":
      if (!q.context) unavailable();
      return q.context.search(value, signal);
    case "knowledge-context":
      if (!q.knowledgeContext) unavailable();
      return q.knowledgeContext.search(value, signal);
    case "extraction-prepare":
      if (!q.extractionPreparation) unavailable();
      return q.extractionPreparation.prepare(value, signal);
    case "analysis-inputs": {
      if (!q.documentRead) unavailable();
      const input = operationRecord(value, ["literature_ids"]);
      if (
        !Array.isArray(input.literature_ids) ||
        !input.literature_ids.length ||
        input.literature_ids.length > 100 ||
        new Set(input.literature_ids).size !== input.literature_ids.length
      )
        throw new ContractValidationError();
      input.literature_ids = input.literature_ids.map(parseLiteratureId);
      const items: InputManifestItem[] = [];
      const identities = [];
      for (const [i, id] of (input.literature_ids as string[]).entries()) {
        if (signal?.aborted)
          throw Object.assign(new Error("cancelled"), {
            code: "operation-cancelled",
          });
        const detail = await q.query.detail(id);
        const asset = detail.primary_pdf?.asset;
        identities.push({
          literature_id: id,
          metadata_revision: detail.metadata_revision,
          metadata_sha256: detail.metadata_sha256,
        });
        if (!asset) {
          items.push({
            input_id: `paper-${i + 1}`,
            literature_id: id,
            material: null,
            document: null,
            capabilities: [],
            gaps: ["material-missing"],
          });
          continue;
        }
        const current = await q.documentRead.default(
          {
            literature_id: id,
            asset_id: asset.asset_id,
            asset_sha256: asset.sha256,
          },
          signal,
        );
        const described = current.default
          ? await q.documentRead.describe(
              { document_version_id: current.default.document_version_id },
              signal,
            )
          : null;
        items.push({
          input_id: `paper-${i + 1}`,
          literature_id: id,
          material: current.material,
          document: described?.document ?? null,
          capabilities: described
            ? [
                "material-file-v1",
                "document-segment-v1",
                "document-text-v1",
                "document-outline-v1",
                "document-resources-v1",
              ]
            : ["material-file-v1"],
          gaps: described ? [] : ["document-missing"],
        });
      }
      return { input: await createInputManifest(items), identities };
    }
    default:
      throw new ContractValidationError();
  }
}

export function isQueryFailure(
  error: unknown,
): error is Error & { readonly code: string } {
  return (
    error instanceof ProductOperationError ||
    error instanceof SnapshotError ||
    error instanceof FolderError ||
    error instanceof FilterError ||
    error instanceof ArchiveError ||
    error instanceof ArchiveTextError ||
    error instanceof ArchiveContractObsoleteError ||
    error instanceof TagError ||
    error instanceof MetadataFieldError ||
    error instanceof AnnotationError ||
    error instanceof ProofreadError ||
    error instanceof LibraryTransferError ||
    error instanceof DocumentReadError ||
    error instanceof MaterialContextError ||
    error instanceof KnowledgeContextError ||
    error instanceof ExtractionPreparationError ||
    error instanceof ExtractionSpecError ||
    error instanceof LiteratureNotFoundError ||
    error instanceof LiteratureQueryError ||
    error instanceof LibrarySortScopeLimitError
  );
}
export async function executeQuery(
  q: QueryApplication,
  operation: QueryOperation,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await readQuery(q, operation, value, signal);
  return [
    "operation-history",
    "agent-sessions",
    "task-run",
    "processor-runs",
    "tags",
    "metadata-fields",
    "proofread-inspect",
    "proofread-text",
  ].includes(operation)
    ? presentActors(result)
    : result;
}
