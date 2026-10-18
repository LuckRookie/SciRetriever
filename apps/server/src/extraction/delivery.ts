import {
  extractionCanonicalJsonBytes,
  parseExtractionSpec,
  parseInputManifest,
  parseExtractionSubmission,
  parseExtractionCreateRequest,
  parseExtractionOperationResult,
  parseExtractionReceiptResult,
  parseExtractionAcceptedResult,
  extractionSubmissionHash,
  INPUT_MANIFEST_MAX_BYTES,
  EXTRACTION_MAX_JSON_DEPTH,
  EXTRACTION_MAX_JSON_NODES,
  requiredPreparationCapabilities,
  type ExtractionSpec,
  type InputManifest,
  type ExtractionSubmission,
  type ExtractionEvidenceSource,
  type ExtractionCandidateIssue,
  type ExtractionOperationResult,
  type ExtractionReceiptResult,
  ContractValidationError,
} from "@sciretriever/contracts";
import {
  DocumentReadError,
  type DocumentReadService,
} from "../document/read.js";
import {
  ExtractionStorageError,
  type SqliteWorker,
} from "../storage/sqlite/worker.js";
import { ExtractionPreparationService } from "./prepare.js";
import { ExtractionPreparationError } from "./prepare.js";
import { validateExtractionPayloads } from "./spec.js";
import { ExtractionSpecError } from "./spec.js";
import { WriteAdmissionError } from "../storage/write-admission.js";

export class ExtractionDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly issue: ExtractionCandidateIssue | null = null,
    options?: ErrorOptions,
  ) {
    super("extraction delivery refused", options);
  }
}
type OperationRow = {
  operation_id: string;
  caller_id: string;
  spec_id: string;
  spec_version: string;
  spec_sha256: string;
  spec_json: string;
  manifest_sha256: string;
  manifest_json: string;
  status: "open" | "closed" | "cancelled";
  created_at: string;
  accept_until: string;
  closed_at: string | null;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("storage-invalid");
  return value as Record<string, unknown>;
}
function storageParse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractValidationError)
      throw new ExtractionDeliveryError("storage-invalid", null, {
        cause: error,
      });
    throw error;
  }
}
function storedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ExtractionDeliveryError("storage-invalid", null, {
      cause: error,
    });
  }
}
async function storedContract<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw new ExtractionDeliveryError("storage-invalid", null, {
      cause: error,
    });
  }
}
function operationRow(value: unknown): OperationRow {
  const row = object(value);
  if (
    typeof row.spec_json !== "string" ||
    typeof row.manifest_json !== "string"
  )
    fail("storage-invalid");
  const result = storageParse(() =>
    parseExtractionOperationResult({
      schema_version: 1,
      operation_id: row.operation_id,
      caller_id: row.caller_id,
      spec_id: row.spec_id,
      spec_version: row.spec_version,
      spec_sha256: row.spec_sha256,
      manifest_sha256: row.manifest_sha256,
      status: row.status,
      created_at: row.created_at,
      accept_until: row.accept_until,
      closed_at: row.closed_at,
    }),
  );
  return {
    ...result,
    spec_json: row.spec_json,
    manifest_json: row.manifest_json,
  };
}
function receiptRow(value: unknown): ExtractionReceiptResult {
  const row = object(value);
  return storageParse(() =>
    parseExtractionReceiptResult({
      schema_version: 1,
      receipt_id: row.receipt_id,
      operation_id: row.operation_id,
      submission_key: row.submission_key,
      batch_id: row.batch_id,
      submission_sha256: row.submission_sha256,
      accepted_at: row.accepted_at,
      receipt_expires_at: row.receipt_expires_at,
      protection_expires_at: row.protection_expires_at,
      checks: row.checks,
      protected_materials: row.protected_materials,
      protected_documents: row.protected_documents,
    }),
  );
}
const storageCodes = new Set([
  "catalog-v5-required",
  "operation-capacity",
  "receipt-capacity",
  "batch-capacity",
  "batch-conflict",
  "submission-conflict",
  "unknown-or-expired",
  "spec-conflict",
  "input-stale",
  "operation-not-open",
  "operation-expired",
  "invalid-cleanup-limit",
  "read-only",
  "write-admission-required",
]);
function mapped(error: unknown, stage: "input" | "evidence" = "input"): Error {
  if (error instanceof ExtractionDeliveryError) return error;
  if (error instanceof ExtractionStorageError)
    return new ExtractionDeliveryError(
      storageCodes.has(error.code) ? error.code : "storage-unavailable",
      null,
      { cause: error },
    );
  if (error instanceof WriteAdmissionError)
    return new ExtractionDeliveryError(
      error.code === "write-admission-cancelled"
        ? "delivery-cancelled"
        : error.code === "write-admission-conflict"
          ? "delivery-write-conflict"
          : error.code === "write-admission-security"
            ? "delivery-write-security"
            : error.code === "write-admission-closed"
              ? "delivery-write-closed"
              : "delivery-write-expired",
      null,
      { cause: error },
    );
  if (error instanceof ExtractionPreparationError)
    return new ExtractionDeliveryError(
      error.code === "preparation-cancelled"
        ? "delivery-cancelled"
        : error.code === "input-missing"
          ? "input-missing"
          : error.code === "input-unsupported"
            ? "input-unsupported"
            : error.code === "input-integrity"
              ? "input-integrity"
              : "input-stale",
      null,
      { cause: error },
    );
  if (error instanceof ExtractionSpecError && error.code === "schema-cancelled")
    return new ExtractionDeliveryError("delivery-cancelled", null, {
      cause: error,
    });
  if (error instanceof DocumentReadError)
    return new ExtractionDeliveryError(
      error.code === "document-cancelled" || error.code === "document-closed"
        ? "delivery-cancelled"
        : error.code === "material-missing" || error.code === "document-missing"
          ? stage === "input"
            ? "input-missing"
            : "evidence-unavailable"
          : error.code === "document-unsupported" ||
              error.code === "document-v3-required"
            ? stage === "input"
              ? "input-unsupported"
              : "evidence-unsupported"
            : stage === "input"
              ? "input-integrity"
              : "evidence-unavailable",
      null,
      { cause: error },
    );
  return error instanceof Error
    ? error
    : new ExtractionDeliveryError("delivery-unavailable");
}
function mappedWithInput(
  error: unknown,
  inputId: string,
  stage: "input" | "evidence",
): Error {
  const failure = mapped(error, stage);
  if (failure instanceof ExtractionDeliveryError && failure.issue === null)
    return new ExtractionDeliveryError(
      failure.code,
      {
        code: failure.code,
        input_id: inputId,
        record_id: null,
        pointer: null,
        relation_index: null,
        keyword: null,
        truncated: false,
      },
      { cause: error },
    );
  return failure;
}
function fail(
  code: string,
  context: Partial<ExtractionCandidateIssue> = {},
): never {
  throw new ExtractionDeliveryError(code, {
    code,
    record_id: context.record_id ?? null,
    pointer: context.pointer ?? null,
    input_id: context.input_id ?? null,
    relation_index: context.relation_index ?? null,
    keyword: context.keyword ?? null,
    truncated: context.truncated ?? true,
  });
}
function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  )
    fail("invalid-request");
  return value;
}
function encode(
  value: unknown,
  limit: number,
  limits?: { readonly maxDepth: number; readonly maxNodes: number },
): string {
  return new TextDecoder().decode(
    extractionCanonicalJsonBytes(value, limit, limits),
  );
}
function pointerValue(payload: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  let current: unknown = payload;
  for (const raw of pointer.slice(1).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part) || Number(part) >= current.length)
        return false;
      current = current[Number(part)];
    } else if (
      current &&
      typeof current === "object" &&
      Object.hasOwn(current, part)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else return false;
  }
  return true;
}
function scalarPointers(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      scalarPointers(item, `${prefix}/${index}`),
    );
  return Object.entries(value).flatMap(([key, item]) =>
    scalarPointers(
      item,
      `${prefix}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
    ),
  );
}
function checkSource(
  source: ExtractionEvidenceSource,
  manifest: InputManifest,
  spec: ExtractionSpec,
): void {
  const item = manifest.items.find(
    (entry) => entry.input_id === source.input_id,
  );
  if (!item || !item.material)
    fail("evidence-out-of-scope", { input_id: source.input_id });
  const evidence = source.evidence;
  if (
    spec.evidence_policy.field_granularity === "segment" &&
    evidence.target_kind !== "document"
  )
    fail("evidence-granularity", { input_id: source.input_id });
  if (evidence.target_kind === "material") {
    if (
      encode(evidence.material, 4096) !== encode(item.material, 4096) ||
      evidence.content_sha256 !== item.material.asset_sha256
    )
      fail("evidence-out-of-scope", { input_id: source.input_id });
  } else if (
    !item.document ||
    evidence.document_version_id !== item.document.document_version_id ||
    evidence.representation_sha256 !== item.document.representation_sha256 ||
    evidence.content_sha256 === null
  )
    fail("evidence-out-of-scope", { input_id: source.input_id });
}
function checkStructure(
  request: ExtractionSubmission,
  spec: ExtractionSpec,
  manifest: InputManifest,
) {
  if (
    request.coverage.length !== manifest.items.length ||
    request.coverage.some(
      (item, index) => item.input_id !== manifest.items[index]?.input_id,
    )
  )
    fail("coverage-invalid", {
      input_id:
        request.coverage.find(
          (item, index) => item.input_id !== manifest.items[index]?.input_id,
        )?.input_id ?? null,
    });
  const recordMap = new Map(
    request.records.map((item) => [item.record_id, item]),
  );
  const allSources: ExtractionEvidenceSource[] = [];
  for (const record of request.records) {
    const slots = new Set(record.field_evidence.map((item) => item.pointer));
    for (const field of record.field_evidence) {
      if (!pointerValue(record.payload, field.pointer))
        fail("pointer-invalid", {
          record_id: record.record_id,
          pointer: field.pointer,
        });
      for (const source of field.sources) {
        checkSource(source, manifest, spec);
        allSources.push(source);
      }
    }
    const required =
      spec.evidence_policy.required_pointers === "record-root"
        ? [""]
        : scalarPointers(record.payload);
    for (const pointer of required.length ? required : [""])
      if (!slots.has(pointer))
        fail("evidence-coverage", { record_id: record.record_id, pointer });
  }
  let hasCrossInputRelation = false;
  for (const [relationIndex, relation] of request.relations.entries()) {
    const from = recordMap.get(relation.from.record_id);
    const to = recordMap.get(relation.to.record_id);
    const fromField = from?.field_evidence.find(
      (field) => field.pointer === relation.from.pointer,
    );
    const toField = to?.field_evidence.find(
      (field) => field.pointer === relation.to.pointer,
    );
    if (
      !from ||
      !to ||
      !pointerValue(from.payload, relation.from.pointer) ||
      !pointerValue(to.payload, relation.to.pointer) ||
      !fromField ||
      !toField
    )
      fail("relation-invalid", { relation_index: relationIndex });
    const relationInputs = new Set<string>();
    for (const source of relation.evidence) {
      checkSource(source, manifest, spec);
      allSources.push(source);
      relationInputs.add(source.input_id);
    }
    const fromInputs = new Set(
      fromField.sources.map((source) => source.input_id),
    );
    const toInputs = new Set(toField.sources.map((source) => source.input_id));
    if (
      [...fromInputs].some((a) =>
        [...toInputs].some(
          (b) => a !== b && relationInputs.has(a) && relationInputs.has(b),
        ),
      )
    )
      hasCrossInputRelation = true;
  }
  if (
    spec.evidence_policy.cross_input_relation === "required" &&
    request.records.length > 0 &&
    !hasCrossInputRelation
  )
    fail("relation-required", {
      relation_index: request.relations.length ? 0 : null,
    });
  const usedInputs = new Set(allSources.map((source) => source.input_id));
  for (const [index, coverage] of request.coverage.entries()) {
    const item = manifest.items[index]!;
    if (
      (!item.material && coverage.status.startsWith("processed-")) ||
      (coverage.status === "processed-with-records") !==
        usedInputs.has(item.input_id) ||
      (coverage.status === "processed-no-records" &&
        usedInputs.has(item.input_id)) ||
      (["unreadable", "unsupported", "failed"].includes(coverage.status) &&
        coverage.reason === null)
    )
      fail("coverage-invalid", { input_id: item.input_id });
    if (
      coverage.status.startsWith("processed-") &&
      requiredPreparationCapabilities(spec).some(
        (capability) => !item.capabilities.includes(capability),
      )
    )
      fail("coverage-invalid", { input_id: item.input_id });
  }
  return {
    record_count: request.records.length,
    relation_count: request.relations.length,
    evidence_count: allSources.length,
    coverage_count: request.coverage.length,
    sources: allSources,
  };
}

/** The only Extraction writer; QueryApplication remains a separate read-only object graph. */
export class ExtractionDeliveryService {
  private closed = false;
  private readonly stopping = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly database: SqliteWorker,
    private readonly documents: DocumentReadService,
    private readonly preparation: ExtractionPreparationService,
  ) {}
  private run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new ExtractionDeliveryError("delivery-closed"));
    const combined = signal
      ? AbortSignal.any([signal, this.stopping.signal])
      : this.stopping.signal;
    const work = operation(combined);
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  create(value: unknown, signal?: AbortSignal) {
    return this.run(async (stop) => {
      const {
        caller_id: callerId,
        spec,
        manifest,
      } = await parseExtractionCreateRequest(value);
      if (stop.aborted) fail("delivery-cancelled");
      const selections = manifest.items.map((item) => ({
        input_id: item.input_id,
        literature_id: item.literature_id,
        asset_id: item.material?.asset_id ?? null,
        asset_sha256: item.material?.asset_sha256 ?? null,
        document_version_id: item.document?.document_version_id ?? null,
      }));
      try {
        const prepared = await this.preparation.prepare(
          { spec, inputs: selections },
          stop,
        );
        if (prepared.manifest.manifest_sha256 !== manifest.manifest_sha256)
          fail("input-stale");
        const row = await this.database.extraction<unknown>(
          "create",
          {
            caller_id: callerId,
            spec_id: spec.spec_id,
            spec_version: spec.spec_version,
            spec_sha256: spec.spec_sha256,
            spec_json: encode(spec, 64 * 1024),
            manifest_sha256: manifest.manifest_sha256,
            manifest_json: encode(manifest, INPUT_MANIFEST_MAX_BYTES + 90, {
              maxDepth: EXTRACTION_MAX_JSON_DEPTH,
              maxNodes: EXTRACTION_MAX_JSON_NODES + 1,
            }),
          },
          stop,
        );
        return this.describe(operationRow(row));
      } catch (error) {
        throw mapped(error);
      }
    }, signal);
  }
  private describe(row: OperationRow): ExtractionOperationResult {
    return parseExtractionOperationResult({
      schema_version: 1,
      operation_id: row.operation_id,
      caller_id: row.caller_id,
      spec_id: row.spec_id,
      spec_version: row.spec_version,
      spec_sha256: row.spec_sha256,
      manifest_sha256: row.manifest_sha256,
      status: row.status,
      created_at: row.created_at,
      accept_until: row.accept_until,
      closed_at: row.closed_at,
    });
  }
  private async verifyManifest(
    manifest: InputManifest,
    signal: AbortSignal,
  ): Promise<void> {
    for (const item of manifest.items) {
      if (signal.aborted) fail("delivery-cancelled");
      if (!item.material) continue;
      const material = await this.documents
        .materialEvidence(
          {
            literature_id: item.literature_id,
            asset_id: item.material.asset_id,
          },
          signal,
        )
        .catch((error: unknown) => {
          throw mappedWithInput(error, item.input_id, "input");
        });
      if (material.evidence.target_kind !== "material")
        fail("input-stale", { input_id: item.input_id });
      if (
        encode(material.evidence.material, 4096) !== encode(item.material, 4096)
      )
        fail("input-stale", { input_id: item.input_id });
      if (item.document) {
        const description = await this.documents
          .describe(
            { document_version_id: item.document.document_version_id },
            signal,
          )
          .catch((error: unknown) => {
            throw mappedWithInput(error, item.input_id, "input");
          });
        if (
          encode(description.document, 16384) !== encode(item.document, 16384)
        )
          fail("input-stale", { input_id: item.input_id });
      }
    }
  }
  operation(id: string) {
    return this.run(async () => {
      const row = await this.database
        .extraction<unknown>("operation", token(id))
        .catch((error: unknown) => {
          throw mapped(error);
        });
      return row ? this.describe(operationRow(row)) : null;
    });
  }
  receipt(id: string) {
    return this.run(async () => {
      const row = await this.database
        .extraction<unknown>("receipt", token(id))
        .catch((error: unknown) => {
          throw mapped(error);
        });
      return row ? receiptRow(row) : null;
    });
  }
  async acceptedForRetention(value: unknown, signal?: AbortSignal) {
    const request = parseExtractionSubmission(value);
    return this.run(async (stop) => {
      const accepted = await this.submit(request, stop);
      const raw = await this.database.extraction<unknown>(
        "operation",
        request.operation_id,
      );
      if (!raw) fail("unknown-or-expired");
      const row = operationRow(raw);
      return {
        accepted,
        spec: await parseExtractionSpec(storedJson(row.spec_json)),
        manifest: await parseInputManifest(storedJson(row.manifest_json)),
      };
    }, signal);
  }
  submit(value: unknown, signal?: AbortSignal) {
    const request = parseExtractionSubmission(value);
    return this.run(async (stop) => {
      const rowValue = await this.database
        .extraction<unknown>("operation", request.operation_id)
        .catch((error: unknown) => {
          throw mapped(error);
        });
      if (!rowValue) fail("unknown-or-expired");
      const row = operationRow(rowValue);
      const submissionHash = await extractionSubmissionHash(
        this.describe(row),
        request,
      );
      const historical = async () => {
        const receipt = await this.database
          .extraction<unknown>("receipt-key", {
            operation_id: row.operation_id,
            submission_key: request.submission_key,
          })
          .catch((error: unknown) => {
            throw mapped(error);
          });
        if (!receipt) return null;
        const checked = receiptRow(receipt);
        if (checked.submission_sha256 !== submissionHash)
          fail("submission-conflict");
        return checked;
      };
      const old = await historical();
      const acceptedResult = async (receipt: ExtractionReceiptResult) =>
        parseExtractionAcceptedResult(
          {
            schema_version: 1,
            receipt,
            accepted_batch: request,
          },
          request,
          submissionHash,
          this.describe(row),
          await storedContract(
            parseInputManifest(storedJson(row.manifest_json)),
          ),
        );
      if (old) return acceptedResult(old);
      try {
        const spec = await storedContract(
          parseExtractionSpec(storedJson(row.spec_json)),
        );
        const manifest = await storedContract(
          parseInputManifest(storedJson(row.manifest_json)),
        );
        await this.verifyManifest(manifest, stop);
        const checks = checkStructure(request, spec, manifest);
        const validation = await validateExtractionPayloads(
          spec,
          request.records.map((record) => record.payload),
          stop,
        );
        if (!validation.valid) {
          const match = /^\/(\d+)(\/.*)?$/.exec(
            validation.issue?.instance_path ?? "",
          );
          const index = match ? Number(match[1]) : -1;
          fail("payload-invalid", {
            record_id: request.records[index]?.record_id ?? null,
            pointer: match?.[2] ?? "",
            keyword: validation.issue?.keyword ?? "schema",
            truncated: true,
          });
        }
        const unique = new Map(
          checks.sources.map((source) => [
            encode(source.evidence, 4096),
            source,
          ]),
        );
        for (const source of unique.values()) {
          if (stop.aborted) fail("delivery-cancelled");
          try {
            await this.documents.resolveEvidence(source.evidence, stop);
          } catch (error) {
            throw mappedWithInput(error, source.input_id, "evidence");
          }
        }
        const summary = {
          record_count: checks.record_count,
          relation_count: checks.relation_count,
          evidence_count: checks.evidence_count,
          coverage_count: checks.coverage_count,
        };
        const accepted = await this.database.extraction<unknown>(
          "submit",
          {
            operation_id: request.operation_id,
            submission_key: request.submission_key,
            batch_id: request.batch_id,
            submission_sha256: submissionHash,
            checks_json: encode(summary, 4096),
          },
          stop,
        );
        return acceptedResult(receiptRow(accepted));
      } catch (error) {
        // A concurrent matching commit can become historical during validation.
        const committed = await historical();
        if (committed) return acceptedResult(committed);
        throw mapped(error);
      }
    }, signal);
  }
  closeOperation(id: string, signal?: AbortSignal) {
    return this.run(async (stop) => {
      try {
        return this.describe(
          operationRow(
            await this.database.extraction<unknown>("close", token(id), stop),
          ),
        );
      } catch (error) {
        throw mapped(error);
      }
    }, signal);
  }
  cancelOperation(id: string, signal?: AbortSignal) {
    return this.run(async (stop) => {
      try {
        return this.describe(
          operationRow(
            await this.database.extraction<unknown>("cancel", token(id), stop),
          ),
        );
      } catch (error) {
        throw mapped(error);
      }
    }, signal);
  }
  cleanupExpired(limit = 100, signal?: AbortSignal) {
    return this.run(async (stop) => {
      try {
        return await this.database.extraction<{
          receipts_deleted: number;
          operations_deleted: number;
        }>("cleanup", limit, stop);
      } catch (error) {
        throw mapped(error);
      }
    }, signal);
  }
  shutdown(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.stopping.abort();
      this.closing = Promise.allSettled([...this.active]).then(() => undefined);
    }
    return this.closing;
  }
}
