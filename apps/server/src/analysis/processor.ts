import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseProcessorInvocation,
  parseProcessorResult,
  parseProcessorBatchRequest,
  parseEvidenceRef,
  processorComparison,
  processorJson,
  processorPointer,
  sha256,
  type ProcessorBatchRequest,
  type ProcessorInvocation,
  type ProcessorInput,
  type ProcessorCitation,
  type ProcessorContent,
  type ProcessorCoverage,
  type ProcessorObject,
  type ProcessorResult,
  type ProcessorResultRef,
  type ProcessorRecord,
  type ProcessorCollection,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import type { DocumentReadService } from "../document/read.js";
import type { LiteratureQueryService } from "../literature/query.js";
import type { SqliteSynthesisStorage } from "../storage/synthesis.js";
import { validateRecordPayloads } from "../extraction/spec.js";

export class ProcessorError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super("processor operation failed", options);
  }
}
export function processorIdFromHash(hash: string) {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
export function processorError(code: string): never {
  throw new ProcessorError(code);
}
export interface StoredProcessorResult {
  readonly result: ProcessorResult;
  readonly ref: ProcessorResultRef;
}
export interface ProcessorSourceRecord {
  readonly record_id: string;
  readonly payload: ProcessorObject;
  readonly citation: ProcessorCitation;
  readonly literature_ids: readonly string[];
}
export interface ProcessorStore {
  byId(id: string, signal?: AbortSignal): Promise<StoredProcessorResult | null>;
  byComparison(
    hash: string,
    signal?: AbortSignal,
  ): Promise<StoredProcessorResult | null>;
  publish(
    result: ProcessorResult,
    signal?: AbortSignal,
  ): Promise<StoredProcessorResult>;
  records(
    input: Extract<ProcessorInput, { kind: "result" | "knowledge" }>,
    signal?: AbortSignal,
  ): Promise<readonly ProcessorSourceRecord[]>;
  verifyCitations(
    citations: readonly ProcessorCitation[],
    signal?: AbortSignal,
  ): Promise<readonly { readonly literature_ids: readonly string[] }[]>;
  publishCollection(collection: ProcessorCollection): Promise<string>;
}
export interface ProcessorSegment {
  readonly segment_id: string;
  readonly text: string;
  readonly citation: ProcessorCitation;
}
export interface ProcessorContext {
  readonly signal: AbortSignal;
  readDocument(
    input: Extract<ProcessorInput, { kind: "document" }>,
  ): Promise<readonly ProcessorSegment[]>;
  searchDocument(
    input: Extract<ProcessorInput, { kind: "document" }>,
    query: string,
  ): Promise<readonly ProcessorSegment[]>;
  readResult(
    input: Extract<ProcessorInput, { kind: "result" | "knowledge" }>,
  ): Promise<{
    readonly records: readonly ProcessorSourceRecord[];
    readonly complete: boolean;
    readonly gaps: readonly string[];
  }>;
  model(
    system: string,
    input: ProcessorObject,
    schema: ProcessorObject,
  ): Promise<ProcessorObject>;
}
export interface ProcessorOutput {
  readonly status: "ok" | "empty";
  readonly content: ProcessorContent;
  readonly coverage: readonly ProcessorCoverage[];
  readonly provenance?: ProcessorObject;
}
export interface Processor {
  readonly id: string;
  readonly version: string;
  readonly scope: "document" | "collection";
  readonly accepts: readonly ProcessorInput["kind"][];
  readonly model: boolean;
  readonly output_kind: ProcessorContent["kind"];
  outputSchema?(spec: ProcessorObject): ProcessorObject;
  readonly definition: ProcessorObject;
  readonly spec_schema: ProcessorObject;
  normalizeSpec(value: ProcessorObject): ProcessorObject;
  run(
    input: ProcessorInvocation,
    ctx: ProcessorContext,
  ): Promise<ProcessorOutput>;
}
export class ProcessorRegistry {
  private readonly entries = new Map<string, Processor>();
  register(processor: Processor): void {
    const key = `${processor.id}@${processor.version}`;
    if (this.entries.has(key)) processorError("processor-duplicate");
    this.entries.set(key, processor);
  }
  get(id: string, version: string): Processor {
    const processor = this.entries.get(`${id}@${version}`);
    if (!processor) processorError("processor-unknown");
    return processor;
  }
  list() {
    return [...this.entries.values()].map((p) => ({
      id: p.id,
      version: p.version,
      scope: p.scope,
      accepts: p.accepts,
      spec_schema: p.spec_schema,
      definition: p.definition,
      output_kind: p.output_kind,
      schema_policy: p.outputSchema
        ? "derived-from-normalized-spec"
        : "published-content",
    }));
  }
}
function equal(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(a)).equals(
    Buffer.from(canonicalJsonBytes(b)),
  );
}
export function resultCitations(
  content: ProcessorContent,
): readonly ProcessorCitation[] {
  return content.kind === "records"
    ? content.records.flatMap((r) => r.evidence.flatMap((e) => e.sources))
    : content.kind === "text"
      ? content.evidence
      : [];
}
export class ProcessorService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    readonly registry: ProcessorRegistry,
    private readonly documents: DocumentReadService,
    private readonly agents: DshAgentRuntime,
    private readonly literature: LiteratureQueryService,
    readonly store: ProcessorStore,
    private readonly knowledge: Pick<SqliteSynthesisStorage, "sourceById">,
  ) {}
  private async work<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.stop.signal.aborted) processorError("processor-closed");
    const active = signal
      ? AbortSignal.any([this.stop.signal, signal])
      : this.stop.signal;
    if (active.aborted) processorError("processor-cancelled");
    const promise = Promise.resolve().then(() => fn(active));
    this.active.add(promise);
    try {
      return await promise;
    } finally {
      this.active.delete(promise);
    }
  }
  async close(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
  private async execution(processor: Processor, spec: ProcessorObject) {
    return {
      method_sha256: await sha256(
        canonicalJsonBytes({
          id: processor.id,
          version: processor.version,
          definition: processor.definition,
          spec_schema: processor.spec_schema,
          output_kind: processor.output_kind,
          output_schema: processor.outputSchema?.(spec) ?? null,
        }),
      ),
      model: processor.model
        ? processorJson(this.agents.effectiveIdentity("analysis"))
        : null,
    };
  }
  prepare(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{
    request: ProcessorBatchRequest;
    invocations: readonly ProcessorInvocation[];
  }> {
    const request = parseProcessorBatchRequest(value);
    return this.work(async (active) => {
      const p = this.registry.get(
        request.processor.id,
        request.processor.version,
      );
      const spec = p.normalizeSpec(request.spec);
      if (p.outputSchema)
        await validateRecordPayloads(p.outputSchema(spec), [], active);
      const execution = await this.execution(p, spec);
      const inputs: ProcessorInput[] = [];
      for (const [index, selection] of request.inputs.entries()) {
        if (active.aborted) processorError("processor-cancelled");
        const input_id = `i${index}`;
        if (selection.kind === "result") {
          const stored = await this.store.byId(selection.result_id, active);
          if (!stored) processorError("processor-result-missing");
          const input = {
            kind: "result" as const,
            input_id,
            ...stored.ref,
            record_ids: selection.record_ids,
          };
          await this.store.records(input, active);
          inputs.push(input);
        } else if (selection.kind === "knowledge") {
          const source = await this.knowledge.sourceById(
            selection.artifact_id,
            active,
          );
          if (!source) processorError("processor-input-missing");
          inputs.push({
            kind: "knowledge",
            input_id,
            artifact_id: selection.artifact_id,
            content_sha256: source.artifact.content_ref.sha256,
          });
        } else {
          let versionId: string;
          if (selection.kind === "literature") {
            const detail = await this.literature.detail(
              selection.literature_id,
            );
            const asset = detail.primary_pdf?.asset;
            if (!asset) {
              inputs.push({
                kind: "missing",
                input_id,
                literature_id: selection.literature_id,
                reason: "material-missing",
              });
              continue;
            }
            const current = await this.documents.default(
              {
                literature_id: selection.literature_id,
                asset_id: asset.asset_id,
                asset_sha256: asset.sha256,
              },
              active,
            );
            if (!current.default) {
              inputs.push({
                kind: "missing",
                input_id,
                literature_id: selection.literature_id,
                reason: "document-missing",
              });
              continue;
            }
            versionId = current.default.document_version_id;
          } else versionId = selection.document_version_id;
          const described = await this.documents.describe(
            { document_version_id: versionId },
            active,
          );
          inputs.push({
            kind: "document",
            input_id,
            document: described.document,
          });
        }
      }
      if (
        inputs.some((i) => i.kind !== "missing" && !p.accepts.includes(i.kind))
      )
        processorError("processor-input-kind");
      // Per-document identities do not depend on the position in a batch.
      const groups =
        p.scope === "document"
          ? inputs.map((i) => [{ ...i, input_id: "document" }])
          : [inputs];
      return {
        request: { ...request, spec },
        invocations: groups.map((group) =>
          parseProcessorInvocation({
            schema_version: 1,
            processor: request.processor,
            spec,
            inputs: group,
            execution,
          }),
        ),
      };
    }, signal);
  }
  execute(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{
    result_id: string;
    content_sha256: string;
    reused: boolean;
    coverage: string;
  }> {
    const invocation = parseProcessorInvocation(value);
    return this.work(async (active) => {
      const p = this.registry.get(
        invocation.processor.id,
        invocation.processor.version,
      );
      if (
        !equal(invocation.spec, p.normalizeSpec(invocation.spec)) ||
        !equal(invocation.execution, await this.execution(p, invocation.spec))
      )
        processorError("processor-binding-changed");
      if (p.scope === "document" && invocation.inputs.length !== 1)
        processorError("processor-input-kind");
      if (
        invocation.inputs.some(
          (i) => i.kind !== "missing" && !p.accepts.includes(i.kind),
        )
      )
        processorError("processor-input-kind");
      const comparison = await processorComparison(invocation);
      const previous = await this.store.byComparison(comparison, active);
      if (previous)
        return { ...previous.ref, reused: true, coverage: "complete" };
      const seen = new Map<string, Set<string>>();
      const calls: ProcessorObject[] = [];
      const literatureIds = new Set<string>();
      for (const input of invocation.inputs) {
        if (input.kind === "document")
          literatureIds.add(input.document.source_material_ref.literature_id);
        else if (input.kind === "result") {
          const stored = await this.store.byId(input.result_id, active);
          if (!stored || stored.ref.content_sha256 !== input.content_sha256)
            processorError("processor-input-changed");
          for (const id of stored.result.literature_ids) literatureIds.add(id);
        } else if (input.kind === "knowledge") {
          const source = await this.knowledge.sourceById(
            input.artifact_id,
            active,
          );
          if (
            !source ||
            source.artifact.content_ref.sha256 !== input.content_sha256
          )
            processorError("processor-input-changed");
          for (const item of source.artifact.input.items)
            if ("literature_id" in item) literatureIds.add(item.literature_id);
        }
      }
      const checkInput = (input: ProcessorInput) => {
        if (!invocation.inputs.some((i) => equal(i, input)))
          processorError("processor-read-outside-scope");
        if (active.aborted) processorError("processor-cancelled");
      };
      const readDocument: ProcessorContext["readDocument"] = async (input) => {
        checkInput(input);
        return this.documents.withVerifiedVersion(
          input.document.document_version_id,
          async (version, bytes, structure) => {
            if (
              version.representation_sha256 !==
                input.document.representation_sha256 ||
              !equal(
                version.source_material_ref,
                input.document.source_material_ref,
              )
            )
              processorError("processor-input-changed");
            const ids = seen.get(input.input_id) ?? new Set<string>();
            seen.set(input.input_id, ids);
            return Promise.all(
              structure.segments.map(async (segment) => {
                ids.add(segment.segment_id);
                const text = bytes.subarray(
                  segment.start_utf8,
                  segment.end_utf8,
                );
                return {
                  segment_id: segment.segment_id,
                  text: new TextDecoder("utf-8", { fatal: true }).decode(text),
                  citation: {
                    kind: "document" as const,
                    evidence: parseEvidenceRef({
                      schema_version: 1,
                      target_kind: "document",
                      locator_scheme: "utf8-segment-v1",
                      document_version_id: version.document_version_id,
                      representation_sha256: version.representation_sha256,
                      locator: {
                        kind: "segment",
                        segment_id: segment.segment_id,
                      },
                      content_sha256: await sha256(text),
                    }),
                  },
                };
              }),
            );
          },
          active,
        );
      };
      const ctx: ProcessorContext = {
        signal: active,
        readDocument,
        searchDocument: async (input, query) => {
          const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
          return (await readDocument(input)).filter((s) =>
            terms.some((t) => s.text.toLocaleLowerCase().includes(t)),
          );
        },
        readResult: async (input) => {
          checkInput(input);
          const records = await this.store.records(input, active);
          if (input.kind === "result") {
            const stored = await this.store.byId(input.result_id, active);
            if (!stored || stored.ref.content_sha256 !== input.content_sha256)
              processorError("processor-input-changed");
            return {
              records,
              complete: stored.result.coverage.every(
                (c) => c.status === "complete",
              ),
              gaps: stored.result.coverage.flatMap((c) => c.gaps),
            };
          }
          const source = await this.knowledge.sourceById(
            input.artifact_id,
            active,
          );
          if (!source) processorError("processor-input-missing");
          const complete =
            source.state === "verified" &&
            source.artifact.coverage.status === "complete";
          return {
            records,
            complete,
            gaps: complete ? [] : ["upstream-incomplete"],
          };
        },
        model: async (system, input, schema) => {
          if (
            !p.model ||
            !equal(
              invocation.execution,
              await this.execution(p, invocation.spec),
            )
          )
            processorError("processor-binding-changed");
          const bytes = canonicalJsonBytes(input);
          const result = await this.agents.execute(
            {
              role: "analysis",
              required_capabilities: ["structured_text"],
              input_sha256: await sha256(bytes),
              messages: [
                {
                  role: "system",
                  parts: [{ media_type: "text/plain", text: system }],
                },
                {
                  role: "user",
                  parts: [
                    {
                      media_type: "application/json",
                      text: new TextDecoder().decode(bytes),
                    },
                  ],
                },
              ],
              response_schema: schema,
            },
            active,
          );
          if (result.kind !== "structured")
            processorError("processor-model-response");
          calls.push(processorJson(result.provenance));
          return processorJson(result.value);
        },
      };
      const output = await p.run(invocation, ctx);
      if (
        output.content.kind !== p.output_kind ||
        (p.outputSchema &&
          output.content.kind === "records" &&
          !equal(output.content.schema, p.outputSchema(invocation.spec)))
      )
        processorError("processor-output-schema");
      for (const coverage of output.coverage) {
        const input = invocation.inputs.find(
          (i) => i.input_id === coverage.input_id,
        );
        if (!input) processorError("processor-coverage");
        if (input.kind === "document" && output.content.kind !== "knowledge") {
          const read = seen.get(input.input_id) ?? new Set<string>();
          if (
            coverage.read_segments.some((id) => !read.has(id)) ||
            (coverage.status === "complete" &&
              (!read.size || read.size !== coverage.read_segments.length))
          )
            processorError("processor-coverage");
        }
      }
      if (output.content.kind !== "knowledge") literatureIds.clear();
      const citations = resultCitations(output.content);
      for (const citation of citations) {
        const allowed = invocation.inputs.some((input) => {
          if (citation.kind === "result")
            return (
              input.kind === "result" &&
              input.result_id === citation.result_id &&
              input.content_sha256 === citation.content_sha256 &&
              (input.record_ids === null ||
                input.record_ids.includes(citation.record_id))
            );
          if (citation.kind === "knowledge")
            return (
              input.kind === "knowledge" &&
              input.artifact_id === citation.artifact_id &&
              input.content_sha256 === citation.content_sha256
            );
          const evidence = citation.evidence;
          return (
            input.kind === "document" &&
            (evidence.target_kind === "document"
              ? evidence.document_version_id ===
                  input.document.document_version_id &&
                evidence.representation_sha256 ===
                  input.document.representation_sha256 &&
                seen.get(input.input_id)?.has(evidence.locator.segment_id) ===
                  true
              : equal(evidence.material, input.document.source_material_ref))
          );
        });
        if (!allowed) processorError("processor-evidence-outside-scope");
      }
      for (const source of await this.store.verifyCitations(
        citations,
        active,
      )) {
        source.literature_ids.forEach((id) => literatureIds.add(id));
      }
      if (output.content.kind === "records")
        await validateRecordPayloads(
          output.content.schema,
          output.content.records.map((r) => r.payload),
          active,
        );
      if (output.content.kind === "records")
        for (const record of output.content.records) this.verifyRecord(record);
      const result = await parseProcessorResult({
        schema_version: 1,
        result_id: randomUUID(),
        invocation,
        comparison_sha256: comparison,
        ...output,
        producer: "internal",
        provenance: { ...output.provenance, model_calls: calls },
        literature_ids: [...literatureIds].sort(),
        created_at: new Date().toISOString(),
      });
      const saved = await this.store.publish(result, active);
      return {
        ...saved.ref,
        reused: saved.ref.result_id !== result.result_id,
        coverage: saved.result.coverage.every((c) => c.status === "complete")
          ? "complete"
          : "partial",
      };
    }, signal);
  }
  private verifyRecord(record: ProcessorRecord) {
    for (const [key, value] of Object.entries(record.payload)) {
      const pointer = `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (
        !record.evidence.some(
          (e) => e.pointer === "" || e.pointer === pointer,
        ) &&
        !(value === null && record.missing[pointer])
      )
        processorError("processor-field-evidence");
    }
    for (const pointer of Object.keys(record.missing))
      if (processorPointer(record.payload, pointer) !== null)
        processorError("processor-missing-value");
  }
}
