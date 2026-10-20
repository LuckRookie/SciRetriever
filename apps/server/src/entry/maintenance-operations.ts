import {
  ContractValidationError,
  parseExtractionAcceptedResult,
  parseExtractionOperationResult,
  parseExtractionReceiptResult,
  parseExtractionSubmission,
  parseLiteratureId,
} from "@sciretriever/contracts";
import { SnapshotError } from "../analysis/snapshots.js";
import { ArchiveError } from "../archive/orchestrator.js";
import type { Application } from "../bootstrap/application.js";
import { AnnotationError } from "../document/annotations.js";
import { ProofreadDocumentError } from "../document/proofread-publication.js";
import {
  ExtractionDeliveryError,
  type ExtractionDeliveryService,
} from "../extraction/delivery.js";
import { ArchiveReferenceError } from "../literature/archive-references.js";
import { MetadataFieldError } from "../literature/metadata-service.js";
import { ProofreadError } from "../proofread/service.js";
import { TagError } from "../tags/rules.js";
import { createMetadataOperations } from "./metadata-operations.js";
import { operationRecord, ProductOperationError } from "./query-operations.js";
import { manageTags } from "./tag-operations.js";
import { createTaskOperations } from "./task-operations.js";

export const EXTRACTION_OPERATIONS = [
  "operation",
  "operation-read",
  "submit",
  "receipt",
  "close",
  "cancel",
  "cleanup",
] as const;
export type ExtractionOperation = (typeof EXTRACTION_OPERATIONS)[number];
export async function executeExtraction(
  delivery: ExtractionDeliveryService,
  operation: ExtractionOperation,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new ProductOperationError("operation-cancelled");
  switch (operation) {
    case "operation":
      return parseExtractionOperationResult(
        await delivery.create(input, signal),
      );
    case "submit":
      return parseExtractionAcceptedResult(
        await delivery.submit(input, signal),
        parseExtractionSubmission(input),
      );
    case "receipt": {
      const r = operationRecord(input, ["receipt_id"]);
      if (typeof r.receipt_id !== "string") throw new ContractValidationError();
      const value = await delivery.receipt(r.receipt_id);
      return value === null ? null : parseExtractionReceiptResult(value);
    }
    case "operation-read":
    case "close":
    case "cancel": {
      const r = operationRecord(input, ["operation_id"]);
      if (typeof r.operation_id !== "string")
        throw new ContractValidationError();
      const value =
        operation === "operation-read"
          ? await delivery.operation(r.operation_id)
          : operation === "close"
            ? await delivery.closeOperation(r.operation_id, signal)
            : await delivery.cancelOperation(r.operation_id, signal);
      return value === null ? null : parseExtractionOperationResult(value);
    }
    case "cleanup": {
      const r = operationRecord(input, ["limit"]);
      if (
        typeof r.limit !== "number" ||
        !Number.isSafeInteger(r.limit) ||
        r.limit < 1 ||
        r.limit > 1000
      )
        throw new ContractValidationError();
      return delivery.cleanupExpired(r.limit, signal);
    }
  }
}
export const MAINTENANCE_OPERATIONS = [
  "snapshots",
  "archive",
  "tags",
  "archive-references",
  "metadata-edit",
  "document-annotate",
  "document-role",
  "document-publish-proofread",
  "proofread-build",
  "proofread-decide",
  "proofread-revoke",
  "discover",
  "import-bibliography",
  "task-create",
  "resolve-intervention",
  "rebuild-index",
  ...EXTRACTION_OPERATIONS.map((name) => `extraction-${name}` as const),
] as const;
export type MaintenanceOperation = (typeof MAINTENANCE_OPERATIONS)[number];
export async function executeMaintenance(
  app: Application,
  operation: MaintenanceOperation,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new ProductOperationError("operation-cancelled");
  if (operation === "snapshots") return app.snapshots.create(input, signal);
  if (operation === "archive") {
    const r = operationRecord(input, ["operation", "request"]);
    if (r.operation === "build") return app.archive.build(r.request, signal);
    if (r.operation === "resolve")
      return app.archive.resolve(r.request, signal);
    if (r.operation === "resume") {
      const q = operationRecord(r.request, ["literature_id"]);
      return app.archive.resume(parseLiteratureId(q.literature_id), signal);
    }
    throw new ContractValidationError();
  }
  if (operation === "tags") return manageTags(app.tags, input, signal);
  if (operation === "archive-references")
    return app.archiveReferences.build(input, signal);
  if (operation === "metadata-edit") {
    const result = await app.metadataFields.edit(input, signal);
    return {
      literature_id: result.literature.literature_id,
      metadata: result.literature.metadata,
      metadata_revision: result.metadata_revision,
      metadata_sha256: result.metadata_sha256,
      fields: result.field_states,
    };
  }
  if (operation === "document-annotate" || operation === "document-role") {
    if (!app.structureAnnotations)
      throw new ProductOperationError("annotation-unavailable");
    return operation === "document-annotate"
      ? app.structureAnnotations.build(input, signal)
      : app.structureAnnotations.setRole(input, signal);
  }
  if (operation === "document-publish-proofread")
    return app.proofreadDocuments.publish(input, signal);
  if (operation.startsWith("proofread-")) {
    if (!app.proofreading)
      throw new ProductOperationError("proofread-unavailable");
    if (operation === "proofread-build") {
      const r = await app.proofreading.build(input, signal);
      return {
        proofread_id: r.version.proofread_id,
        content_sha256: r.version.content_sha256,
        status: r.version.status,
        stats: r.version.stats,
        failure: r.version.failure,
        pending_pages: r.version.pages.filter((p) => !p.checked),
        published: r.published,
        revision: r.revision,
      };
    }
    if (operation === "proofread-decide")
      return app.proofreading.decide(input, signal);
    return app.proofreading.revoke(input, signal);
  }
  if (operation.startsWith("extraction-"))
    return executeExtraction(
      app.extractionDelivery,
      operation.slice(11) as ExtractionOperation,
      input,
      signal,
    );
  switch (operation) {
    case "discover":
      return createMetadataOperations(app).discovery(input, signal);
    case "import-bibliography":
      return createMetadataOperations(app).importBibliography(input);
    case "task-create": {
      const tasks = createTaskOperations(app);
      if (!tasks) throw new ProductOperationError("processing-unavailable");
      return tasks.create(input);
    }
    case "resolve-intervention": {
      const r = operationRecord(input, [
        "job_id",
        "intervention_id",
        "resolution",
      ]);
      if (
        typeof r.job_id !== "string" ||
        typeof r.intervention_id !== "string" ||
        !["continue", "skip", "cancel"].includes(String(r.resolution))
      )
        throw new ContractValidationError();
      if (!app.jobs || !app.interventions)
        throw new ProductOperationError("processing-unavailable");
      const items = await app.jobs.listInterventions(r.job_id, 1000);
      if (!items.some((i) => i.intervention_id === r.intervention_id))
        throw new ProductOperationError("intervention-not-found");
      return app.interventions.resolve(
        r.intervention_id,
        r.resolution as "continue" | "skip" | "cancel",
      );
    }
    case "rebuild-index": {
      operationRecord(input, []);
      const rebuild = app.maintenance?.rebuildIndex;
      if (!rebuild) throw new ProductOperationError("maintenance-unavailable");
      return rebuild(signal);
    }
    default:
      throw new ContractValidationError();
  }
}

export function isMaintenanceFailure(
  error: unknown,
): error is
  | ExtractionDeliveryError
  | ProofreadError
  | SnapshotError
  | ArchiveError
  | TagError
  | MetadataFieldError
  | ArchiveReferenceError {
  return (
    error instanceof ExtractionDeliveryError ||
    error instanceof ProofreadError ||
    error instanceof SnapshotError ||
    error instanceof ArchiveError ||
    error instanceof TagError ||
    error instanceof MetadataFieldError ||
    error instanceof ArchiveReferenceError ||
    error instanceof AnnotationError ||
    error instanceof ProofreadDocumentError
  );
}
