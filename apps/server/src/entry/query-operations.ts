import { KnowledgeReadError } from "../storage/knowledge.js";
import {
  readLibraryArtifact,
  exportBibliographyRequest,
  LibraryTransferError,
} from "./library-transfer.js";
import { SynthesisReadError } from "../storage/synthesis.js";
import { SynthesisPreparationError } from "../analysis/synthesis-prepare.js";
import { MaterialContextError } from "../retrieval/query.js";
import { KnowledgeContextError } from "../retrieval/knowledge-query.js";
import { ExtractionPreparationError } from "../extraction/prepare.js";
import { ExtractionSpecError } from "../extraction/spec.js";
import {
  LiteratureNotFoundError,
  LiteratureQueryError,
} from "../literature/query.js";
import { DocumentReadError } from "../document/read.js";
import {
  ContractValidationError,
  createInputManifest,
  parseLiteratureId,
  parseAssetId,
  parseLibrarySearchRequest,
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseKnowledgeReadSelection,
  parseKnowledgeReadResult,
  parseKnowledgeListSelection,
  parseKnowledgeListResult,
  parseKnowledgeDefaultSelection,
  parseKnowledgeDefaultResult,
  knowledgeQuestionSha256,
  parseSynthesisReadSelection,
  parseSynthesisReadResult,
  parseSynthesisSourceResult,
  parseSynthesisListSelection,
  parseSynthesisListResult,
  parseSynthesisPreparationRequest,
  parseSynthesisPreparationResult,
  type InputManifestItem,
  type DocumentReadOperation,
} from "@sciretriever/contracts";
import type { QueryApplication } from "../bootstrap/application.js";

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
  "status",
  "library-search",
  "literature-read",
  "artifact-chunk",
  "bibliography-export",
  "references",
  "reference-read",
  "article-identity",
  "task-read",
  "task-list",
  "task-detail",
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
  "knowledge-read",
  "knowledge-list",
  "knowledge-default",
  "synthesis-prepare",
  "synthesis-read",
  "synthesis-source",
  "synthesis-list",
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
  if (operation === "status") {
    operationRecord(value, []);
    return q.readiness;
  }
  if (q.readiness.status !== "ready" || !q.query) unavailable();
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
    case "library-search":
      return q.query.search(parseLibrarySearchRequest(value));
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
      return q.taskRead(r.job_id);
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
    case "knowledge-read": {
      if (!q.knowledgeRead) unavailable();
      const selection = parseKnowledgeReadSelection(value);
      const result = await q.knowledgeRead.byId(selection.artifact_id, signal);
      return result === null
        ? null
        : parseKnowledgeReadResult(result, selection);
    }
    case "knowledge-list": {
      if (!q.knowledgeRead) unavailable();
      const selection = parseKnowledgeListSelection(value);
      return parseKnowledgeListResult(
        await q.knowledgeRead.list(
          selection.literature_id,
          selection.limit,
          signal,
        ),
        selection,
      );
    }
    case "knowledge-default": {
      if (!q.knowledgeRead) unavailable();
      const selection = parseKnowledgeDefaultSelection(value);
      const pointer = await q.knowledgeRead.default(
        selection.literature_id,
        selection.purpose,
        await knowledgeQuestionSha256(selection.question),
        signal,
      );
      return pointer
        ? parseKnowledgeDefaultResult(
            {
              revision: pointer.revision,
              artifact: await q.knowledgeRead.byId(pointer.artifact_id, signal),
            },
            selection,
          )
        : null;
    }
    case "synthesis-prepare": {
      if (!q.synthesisPreparation) unavailable();
      const selection = parseSynthesisPreparationRequest(value);
      return parseSynthesisPreparationResult(
        await q.synthesisPreparation.prepare(selection, signal),
        selection,
      );
    }
    case "synthesis-read":
    case "synthesis-source": {
      if (!q.synthesisRead) unavailable();
      const selection = parseSynthesisReadSelection(value);
      if (operation === "synthesis-read") {
        const result = await q.synthesisRead.byId(
          selection.artifact_id,
          signal,
        );
        return result === null
          ? null
          : parseSynthesisReadResult(result, selection);
      }
      const result = await q.synthesisRead.sourceById(
        selection.artifact_id,
        signal,
      );
      return result === null
        ? null
        : parseSynthesisSourceResult(result, selection);
    }
    case "synthesis-list": {
      if (!q.synthesisRead) unavailable();
      const selection = parseSynthesisListSelection(value);
      return parseSynthesisListResult(
        await q.synthesisRead.list(
          selection.manifest_sha256,
          selection.limit,
          signal,
        ),
        selection,
      );
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
    error instanceof LibraryTransferError ||
    error instanceof DocumentReadError ||
    error instanceof KnowledgeReadError ||
    error instanceof SynthesisReadError ||
    error instanceof SynthesisPreparationError ||
    error instanceof MaterialContextError ||
    error instanceof KnowledgeContextError ||
    error instanceof ExtractionPreparationError ||
    error instanceof ExtractionSpecError ||
    error instanceof LiteratureNotFoundError ||
    error instanceof LiteratureQueryError
  );
}
export { readQuery as executeQuery };
