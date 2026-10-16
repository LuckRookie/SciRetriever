import {
  ContractValidationError,
  parseExtractionOperationResult,
  parseExtractionAcceptedResult,
  parseExtractionSubmission,
  parseExtractionReceiptResult,
} from "@sciretriever/contracts";
import type { Application } from "../bootstrap/application.js";
import {
  ExtractionDeliveryError,
  type ExtractionDeliveryService,
} from "../extraction/delivery.js";
import { createTaskOperations } from "./task-operations.js";
import { createMetadataOperations } from "./metadata-operations.js";
import { operationRecord, ProductOperationError } from "./query-operations.js";

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
  "discover",
  "import-bibliography",
  "task-create",
  "resolve-intervention",
  "rebuild-index",
  "rebuild-knowledge-index",
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
    case "rebuild-index":
    case "rebuild-knowledge-index": {
      operationRecord(input, []);
      const rebuild =
        operation === "rebuild-index"
          ? app.maintenance?.rebuildIndex
          : app.maintenance?.rebuildKnowledgeIndex;
      if (!rebuild) throw new ProductOperationError("maintenance-unavailable");
      return rebuild(signal);
    }
    default:
      throw new ContractValidationError();
  }
}

export function isMaintenanceFailure(
  error: unknown,
): error is ExtractionDeliveryError {
  return error instanceof ExtractionDeliveryError;
}
