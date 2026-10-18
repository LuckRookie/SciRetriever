import {
  canonicalJsonBytes,
  parseExtractionSubmission,
  parseProcessorResult,
  processorComparison,
  processorJson,
  sha256,
  type ProcessorInput,
} from "@sciretriever/contracts";
import type { ExtractionDeliveryService } from "../extraction/delivery.js";
import type { SqliteProcessorStorage } from "../storage/processor-results.js";
import { processorError, processorIdFromHash } from "./processor.js";
/** Explicit retention; receipt-only delivery keeps its established behavior. */
export class ProcessorExternalRetention {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
  constructor(
    private readonly delivery: ExtractionDeliveryService,
    private readonly store: SqliteProcessorStorage,
  ) {}
  async retain(value: unknown, signal?: AbortSignal) {
    if (this.stop.signal.aborted) processorError("processor-closed");
    const request = parseExtractionSubmission(value);
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const operation = this.retainWork(request, active);
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }
  private async retainWork(value: unknown, signal: AbortSignal) {
    const submission = parseExtractionSubmission(value);
    const requestHash = await sha256(canonicalJsonBytes(submission));
    const id = processorIdFromHash(
      await sha256(
        canonicalJsonBytes({
          operation_id: submission.operation_id,
          submission_key: submission.submission_key,
        }),
      ),
    );
    const existing = await this.store.byId(id, signal);
    if (existing) {
      if (existing.result.provenance.submission_sha256 !== requestHash)
        processorError("processor-submission-conflict");
      return existing.ref;
    }
    const { accepted, spec, manifest } =
      await this.delivery.acceptedForRetention(submission, signal);
    const inputs: ProcessorInput[] = manifest.items.map((item) =>
      item.document
        ? { kind: "document", input_id: item.input_id, document: item.document }
        : item.material
          ? {
              kind: "material",
              input_id: item.input_id,
              material: item.material,
            }
          : {
              kind: "missing",
              input_id: item.input_id,
              literature_id: item.literature_id,
              reason: "material-missing",
            },
    );
    const invocation = {
      schema_version: 1 as const,
      processor: { id: "external-extraction", version: "1" },
      spec: processorJson(spec),
      inputs,
      execution: {
        method_sha256: await sha256(canonicalJsonBytes(submission.producer)),
        model: null,
      },
    };
    const coverage = inputs.map((input) => {
      const c = submission.coverage.find((c) => c.input_id === input.input_id);
      const complete =
        input.kind !== "missing" &&
        (c?.status === "processed-with-records" ||
          c?.status === "processed-no-records");
      return {
        input_id: input.input_id,
        status: complete ? "complete" : "none",
        read_segments: [],
        gaps: complete ? [] : [c?.reason ?? c?.status ?? "not-submitted"],
      };
    });
    const stored = await this.store.publish(
      await parseProcessorResult({
        schema_version: 1,
        result_id: id,
        invocation,
        comparison_sha256: await processorComparison(invocation),
        status:
          !submission.records.length &&
          coverage.every((c) => c.status === "complete")
            ? "empty"
            : "ok",
        content: {
          kind: "records",
          schema: {
            type: "object",
            properties: { record: spec.output_schema },
            required: ["record"],
            additionalProperties: false,
          },
          records: submission.records.map((r) => ({
            record_id: r.record_id,
            payload: { record: r.payload },
            evidence: r.field_evidence.map((e) => ({
              pointer: `/record${e.pointer}`,
              sources: e.sources.map((s) => ({
                kind: "document",
                evidence: s.evidence,
              })),
            })),
            missing: {},
          })),
        },
        coverage,
        producer: "external",
        provenance: processorJson(
          {
            submission_sha256: requestHash,
            accepted,
            spec,
            manifest,
          },
          4 * 1024 * 1024,
        ),
        literature_ids: [
          ...new Set(
            [
              ...submission.records.flatMap((r) =>
                r.field_evidence.flatMap((e) => e.sources),
              ),
              ...submission.relations.flatMap((r) => r.evidence),
            ].map(
              (source) =>
                manifest.items.find((i) => i.input_id === source.input_id)!
                  .literature_id,
            ),
          ),
        ].sort(),
        created_at: accepted.receipt.accepted_at,
      }),
      signal,
    );
    await this.store.rebuild([stored.ref.result_id], signal);
    return stored.ref;
  }
}
