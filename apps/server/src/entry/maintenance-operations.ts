import { parseIntakeBatchRename } from "@sciretriever/contracts";
import { RetrievalStorageError } from "../retrieval/model.js";
import {
  archiveHash,
  parseAssetId,
  annotationInteger,
} from "@sciretriever/contracts";
import { ArchiveContractObsoleteError } from "@sciretriever/contracts";
import { ArchiveTextError } from "../archive/text-source.js";
import { recordOperation } from "../application/operations.js";
import { activityContext } from "../logging/activity.js";
import { presentActors } from "../logging/actor-label.js";
import {
  ContractValidationError,
  parseCollectLiteraturesRequest,
  parseUncollectLiteraturesRequest,
  parseExtractionAcceptedResult,
  parseExtractionOperationResult,
  parseExtractionReceiptResult,
  parseExtractionSubmission,
  parseLiteratureId,
  parseIndexRebuildRequest,
  parseFormDraftsRequest,
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
import { submitLiteratureRecognition } from "./literature-recognition.js";
import { LiteratureNotFoundError, ftsMatchQuery } from "../literature/query.js";
import { WriteAdmissionError } from "../storage/write-admission.js";

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
  "intake-batch-rename",
  "snapshots",
  "snapshot-rename",
  "folders",
  "filters",
  "marks",
  "reading-open",
  "library-collect",
  "library-uncollect",
  "literature-recognize",
  "library-trash",
  "archive",
  "archive-arrangement-edit",
  "tags",
  "archive-references",
  "metadata-edit",
  "document-annotate",
  "document-role",
  "document-publish-proofread",
  "proofread-save",
  "proofread-build",
  "proofread-decide",
  "proofread-revoke",
  "discover",
  "import-bibliography",
  "import-lookup",
  "task-create",
  "form-drafts",
  "resolve-intervention",
  "rebuild-index",
  "index-refresh",
  "verify-index",
  "verify-catalog",
  ...EXTRACTION_OPERATIONS.map((name) => `extraction-${name}` as const),
] as const;
export type MaintenanceOperation = (typeof MAINTENANCE_OPERATIONS)[number];
export function executeMaintenance(
  app: Application,
  operation: MaintenanceOperation,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    [
      "proofread-save",
      "proofread-decide",
      "proofread-revoke",
      "document-role",
    ].includes(operation) &&
    input &&
    typeof input === "object" &&
    !Array.isArray(input)
  )
    input = { ...input, actor: activityContext().actor };
  const work = () =>
    recordOperation(app.database, operation, input, () =>
      performMaintenance(app, operation, input, signal).then(presentActors),
    );
  return app.restartAdmission &&
    operation !== "resolve-intervention" &&
    operation !== "extraction-cancel"
    ? app.restartAdmission.newWork(work)
    : work();
}
async function performMaintenance(
  app: Application,
  operation: MaintenanceOperation,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new ProductOperationError("operation-cancelled");
  if (operation === "form-drafts") {
    const request = parseFormDraftsRequest(input);
    if (!app.jobService || !app.processingTasks)
      throw new ProductOperationError("processing-unavailable");
    const job = await app.jobService.create({
      target_kind: "selector",
      goal: "draft",
      selector: request.selector,
      include_older_method: request.include_older_method,
      idempotency_key: request.idempotency_key,
      policy_version: "form-drafts-v1",
      policy: { mode: "never", max_retries: 0, max_model_calls: 0 },
    });
    await app.processingTasks.start(job.job_id);
    return job;
  }
  if (operation === "intake-batch-rename") {
    const r = parseIntakeBatchRename(input);
    await app.database.writeIntake({ operation: "rename", request: r });
    return app.library.intakeBatches({
      operation: "get",
      request: { batch_id: r.batch_id },
    });
  }
  if (operation === "archive-arrangement-edit")
    return app.archiveArrangement.edit(input, activityContext().actor, signal);
  if (operation === "proofread-save")
    return app.archiveArrangement.save(input, activityContext().actor, signal);
  if (operation === "folders") return app.folders.manage(input, signal);
  if (operation === "filters") return app.filters.manage(input, signal);
  if (operation === "marks") return app.marks.manage(input, signal);
  if (operation === "reading-open") return app.folders.opened(input, signal);
  if (operation === "library-collect" || operation === "library-uncollect") {
    let selection: ReturnType<typeof parseCollectLiteraturesRequest>;
    try {
      selection =
        operation === "library-collect"
          ? parseCollectLiteraturesRequest(input)
          : parseUncollectLiteraturesRequest(input);
    } catch (cause) {
      if (cause instanceof ContractValidationError)
        throw new ProductOperationError("invalid-request", { cause });
      throw cause;
    }
    const { selector } = selection;
    const ftsQuery =
      selector.kind === "query" && selector.query.text !== null
        ? ftsMatchQuery(selector.query.text)
        : null;
    try {
      const result =
        operation === "library-collect"
          ? await app.database.collectLiteratures(
              { selector, ftsQuery },
              signal,
            )
          : await app.database.uncollectLiteratures(
              { selector, ftsQuery },
              signal,
            );
      if (result === null) throw new LiteratureNotFoundError();
      // Membership is still derived from historical evidence: removing rows
      // would not change it, so refuse rather than report a removal.
      if (result === "collection-pending")
        throw new ProductOperationError("library-collection-pending");
      return result;
    } catch (cause) {
      if (
        (cause instanceof Error && cause.name === "AbortError") ||
        (cause instanceof WriteAdmissionError &&
          cause.code === "write-admission-cancelled")
      )
        throw new ProductOperationError("operation-cancelled", { cause });
      throw cause;
    }
  }
  if (operation === "literature-recognize")
    return submitLiteratureRecognition(app, input);
  if (operation === "library-trash") {
    try {
      return await app.trash.manage(input, signal);
    } catch (cause) {
      if (cause instanceof ContractValidationError)
        throw new ProductOperationError("invalid-request", { cause });
      if (
        (cause instanceof Error && cause.name === "AbortError") ||
        (cause instanceof WriteAdmissionError &&
          cause.code === "write-admission-cancelled")
      )
        throw new ProductOperationError("operation-cancelled", { cause });
      throw cause;
    }
  }
  if (operation === "snapshot-rename")
    return app.snapshots.rename(input, signal);
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
    return app.archiveReferences.build(input, signal, true);
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
  if (
    [
      "document-annotate",
      "proofread-build",
      "document-publish-proofread",
    ].includes(operation)
  ) {
    if (
      !input ||
      typeof input !== "object" ||
      !("schema_version" in input) ||
      input.schema_version !== 2
    )
      throw new ArchiveContractObsoleteError();
    if (!app.archiveText)
      throw new ArchiveTextError("archive-runtime-unavailable");
    if (operation === "document-annotate") {
      const r = operationRecord(input, [
        "schema_version",
        "document_version_id",
        "arrangement_id",
      ]);
      return app.archiveText.annotate(
        parseAssetId(r.document_version_id),
        archiveHash(r.arrangement_id),
        signal,
      );
    }
    if (operation === "proofread-build") {
      const r = operationRecord(input, [
          "schema_version",
          "asset_id",
          "arrangement_id",
          "retry_page_indexes",
        ]),
        asset = parseAssetId(r.asset_id),
        state = await app.archiveText.storage.state(asset, signal),
        current = state.current
          ? await app.archiveText.storage.load(
              String(state.current.proofread_id),
              signal,
            )
          : null;
      if (
        !current ||
        current.version.arrangement_id !== archiveHash(r.arrangement_id)
      )
        throw new ArchiveTextError("input-stale");
      const indexes = r.retry_page_indexes;
      if (
        indexes !== null &&
        (!Array.isArray(indexes) ||
          indexes.length > 10000 ||
          new Set(indexes).size !== indexes.length)
      )
        throw new ContractValidationError();
      return app.archiveText.proofread(
        asset,
        current.version.draft_input.profile === "vlm-engine-markdown-only"
          ? "legacy-vlm-markdown"
          : "full",
        indexes === null
          ? null
          : (indexes as unknown[]).map((i) => annotationInteger(i, 0, 9999)),
        signal,
      );
    }
    const r = operationRecord(input, [
      "schema_version",
      "literature_id",
      "asset_id",
      "proofread_id",
      "expected_default_revision",
    ]);
    return app.archiveText.render(
      parseLiteratureId(r.literature_id),
      parseAssetId(r.asset_id),
      signal,
      {
        proofread_id: parseAssetId(r.proofread_id),
        default_revision:
          r.expected_default_revision === null
            ? null
            : annotationInteger(r.expected_default_revision, 1),
      },
    );
  }
  if (
    operation === "document-annotate" ||
    operation === "document-role" ||
    operation === "proofread-build" ||
    operation === "proofread-decide" ||
    operation === "proofread-revoke" ||
    operation === "document-publish-proofread"
  )
    throw new ArchiveContractObsoleteError();
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
    case "import-lookup":
      return createMetadataOperations(app).importLookup(input);
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
      const value = operationRecord(input, [], ["background"]);
      const request = parseIndexRebuildRequest({ kind: "rebuild", ...value });
      if (request.background) {
        const queued = app.maintenance?.scheduleIndexRebuild;
        if (!queued) throw new ProductOperationError("maintenance-unavailable");
        return queued();
      }
      const rebuild = app.maintenance?.rebuildIndex;
      if (!rebuild) throw new ProductOperationError("maintenance-unavailable");
      return rebuild(signal);
    }
    case "index-refresh": {
      operationRecord(input, []);
      const refresh = app.maintenance?.scheduleIndexRefresh;
      if (!refresh) throw new ProductOperationError("maintenance-unavailable");
      return refresh();
    }
    case "verify-index": {
      operationRecord(input, []);
      const verify = app.maintenance?.verifyIndex;
      if (!verify) throw new ProductOperationError("maintenance-unavailable");
      return verify(signal);
    }
    case "verify-catalog": {
      operationRecord(input, []);
      const verify = app.maintenance?.verifyCatalog;
      if (!verify) throw new ProductOperationError("maintenance-unavailable");
      return verify(signal);
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
  | ArchiveTextError
  | ArchiveContractObsoleteError
  | TagError
  | MetadataFieldError
  | ArchiveReferenceError
  | RetrievalStorageError {
  return (
    error instanceof RetrievalStorageError ||
    error instanceof ExtractionDeliveryError ||
    error instanceof ProofreadError ||
    error instanceof SnapshotError ||
    error instanceof ArchiveError ||
    error instanceof ArchiveTextError ||
    error instanceof ArchiveContractObsoleteError ||
    error instanceof TagError ||
    error instanceof MetadataFieldError ||
    error instanceof ArchiveReferenceError ||
    error instanceof AnnotationError ||
    error instanceof ProofreadDocumentError
  );
}
