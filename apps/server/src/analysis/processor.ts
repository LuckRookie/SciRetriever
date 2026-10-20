import type { ProcessorValueVerifier } from "./value-check.js";
import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseProcessorReads,
  createInputManifest,
  type ProcessorReads,
  type ArchiveProcessorInput,
  type SnapshotProcessorInput,
  type ProcessorPartOutcome,
  type SnapshotMember,
  parseProcessorInvocation,
  parseProcessorResult,
  parseProcessorBatchRequest,
  processorComparison,
  processorJson,
  processorPointer,
  sha256,
  type ProcessorBatchRequest,
  type ProcessorInvocation,
  type ProcessorInput,
  type ProcessorRecordSource,
  type ProcessorCitation,
  type ProcessorContent,
  type ProcessorCoverage,
  type ProcessorObject,
  type ProcessorResult,
  type ProcessorResultRef,
  type ProcessorRecord,
  type ProcessorCollection,
  uncheckedProcessorValues,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import type { DocumentReadService } from "../document/read.js";
import type { LiteratureQueryService } from "../literature/query.js";
import { ProcessorArchiveSource } from "./processor-archive.js";
import {
  analyzeDocumentSession,
  type DocumentAnalysisResult,
} from "./knowledge-session.js";
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
  readonly freshness?: {
    readonly state: "current" | "stale";
    readonly reasons: readonly unknown[];
    readonly reasons_truncated: boolean;
  };
  readonly result: ProcessorResult;
  readonly ref: ProcessorResultRef;
}
export interface ProcessorSourceRecord {
  readonly value_checks?: readonly import("@sciretriever/contracts").ProcessorValueCheck[];
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
    input: ProcessorRecordSource,
    signal?: AbortSignal,
  ): Promise<readonly ProcessorSourceRecord[]>;
  verifyCitations(
    citations: readonly ProcessorCitation[],
    signal?: AbortSignal,
  ): Promise<readonly { readonly literature_ids: readonly string[] }[]>;
  publishCollection(collection: ProcessorCollection): Promise<string>;
}
export interface ProcessorSegment {
  readonly basis?: import("@sciretriever/contracts").ProofreadBasis;
  readonly uncertainty?:
    | import("@sciretriever/contracts").ProofreadUncertainty
    | null;
  readonly segment_id: string;
  readonly text: string;
  readonly citation: ProcessorCitation;
}
export interface ProcessorContext {
  readonly signal: AbortSignal;
  readDocument(
    input: ArchiveProcessorInput,
  ): Promise<readonly ProcessorSegment[]>;
  searchDocument(
    input: ArchiveProcessorInput,
    query: string,
  ): Promise<readonly ProcessorSegment[]>;
  readMappedResults(): Promise<readonly ProcessorSourceRecord[]>;
  mappedCoverage(): readonly ProcessorPartOutcome[];
  describeSnapshot(): Promise<{
    count: number;
    members: readonly Pick<
      SnapshotMember,
      "literature_id" | "metadata" | "tags"
    >[];
    citation: (literature: string | null, pointer: string) => ProcessorCitation;
  }>;
  resolveEvidence(citation: ProcessorCitation): Promise<unknown>;
  summarize(
    input: ArchiveProcessorInput,
    purpose: "overview" | "detailed" | "question",
    question: string | null,
  ): Promise<DocumentAnalysisResult>;
  model(
    system: string,
    input: ProcessorObject,
    schema: ProcessorObject,
  ): Promise<ProcessorObject>;
}
export interface ProcessorOutput {
  readonly status: "ok" | "empty";
  readonly content: ProcessorContent;
  readonly coverage: readonly Omit<ProcessorCoverage, "parts">[];
  readonly provenance?: ProcessorObject;
}
export interface Processor {
  readonly id: string;
  readonly version: string;
  readonly scope: "document" | "collection";
  readonly accepts: readonly ProcessorInput["kind"][];
  readonly reads?: ProcessorReads;
  readonly uses_description?: boolean;
  readonly map?: {
    readonly processor: { readonly id: string; readonly version: string };
    readonly spec: ProcessorObject;
  };
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
    if (
      processor.accepts.length !== 1 ||
      processor.accepts[0] !==
        (processor.scope === "document" ? "archive-document" : "snapshot") ||
      (processor.scope === "document" &&
        (processor.map || processor.uses_description))
    )
      processorError("processor-definition-invalid");
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
      reads: p.reads ?? { parts: "main", roles: "all" },
      uses_description: p.uses_description ?? false,
      map: p.map ?? null,
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
    : content.kind === "report"
      ? content.claims.flatMap((c) => c.sources)
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
    readonly archiveSource: ProcessorArchiveSource,
    private readonly verifier?: ProcessorValueVerifier,
  ) {}
  private async work<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
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
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
  private spec(p: Processor, value: ProcessorObject) {
    const { reads, ...rest } = value;
    const normalized = p.normalizeSpec(rest);
    return {
      ...normalized,
      reads: processorJson(
        reads === undefined
          ? (p.reads ?? { parts: "main", roles: "all" })
          : parseProcessorReads(reads),
      ),
    };
  }
  private async execution(p: Processor, spec: ProcessorObject) {
    const reads = parseProcessorReads(spec.reads);
    const map = p.map ?? null;
    if (map) {
      const target = this.registry.get(map.processor.id, map.processor.version);
      if (
        target.scope !== "document" ||
        !target.accepts.includes("archive-document")
      )
        processorError("processor-map-invalid");
    }
    return {
      method_sha256: await sha256(
        canonicalJsonBytes({
          value_verification: this.verifier
            ? await this.verifier.identity()
            : "unconfigured",
          id: p.id,
          version: p.version,
          definition: p.definition,
          spec_schema: p.spec_schema,
          output_kind: p.output_kind,
          output_schema: p.outputSchema?.(spec) ?? null,
          reads,
          map,
          uses_description: p.uses_description ?? false,
        }),
      ),
      model:
        p.model && this.agents.readiness("analysis").configured
          ? processorJson(this.agents.effectiveIdentity("analysis"))
          : null,
      reads,
      uses_description: p.uses_description ?? false,
      map,
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
        ),
        spec = this.spec(p, request.spec),
        execution = await this.execution(p, spec),
        inputs: ProcessorInput[] = [];
      if (p.outputSchema)
        await validateRecordPayloads(p.outputSchema(spec), [], active);
      if (
        p.scope === "collection" &&
        (request.inputs.length !== 1 || request.inputs[0]!.kind !== "snapshot")
      )
        processorError("processor-snapshot-required");
      for (const selected of request.inputs) {
        if (selected.kind === "snapshot") {
          const snapshot = await this.archiveSource.snapshots.all(
            selected.snapshot_id,
            active,
          );
          if (p.scope === "collection")
            inputs.push({
              kind: "snapshot",
              input_id: "snapshot",
              snapshot_id: snapshot.snapshot_id,
              content_sha256: snapshot.content_sha256,
              mapped_results: [],
            });
          else
            for (const member of snapshot.members)
              inputs.push(
                await this.archiveSource.input(
                  member.literature_id,
                  execution.reads,
                  active,
                  member,
                ),
              );
        } else if (selected.kind === "literature" && p.scope === "document")
          inputs.push(
            await this.archiveSource.input(
              selected.literature_id,
              execution.reads,
              active,
            ),
          );
        else processorError("processor-archive-selection-required");
      }
      if (!inputs.length) processorError("processor-empty-snapshot");
      return {
        request: { ...request, spec },
        invocations: (p.scope === "document"
          ? inputs.map((i) => [i])
          : [inputs]
        ).map((group) =>
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
    let invocation = parseProcessorInvocation(value);
    return this.work(async (active) => {
      const p = this.registry.get(
          invocation.processor.id,
          invocation.processor.version,
        ),
        spec = this.spec(p, invocation.spec),
        execution = await this.execution(p, spec);
      if (
        !equal(spec, invocation.spec) ||
        !equal(execution, invocation.execution)
      )
        processorError("processor-binding-changed");
      if (invocation.inputs.length !== 1)
        processorError("processor-input-kind");
      let input = invocation.inputs[0]!;
      if (input.kind !== "missing" && !p.accepts.includes(input.kind))
        processorError("processor-input-kind");
      if (!["archive-document", "snapshot", "missing"].includes(input.kind))
        processorError("processor-corrected-required");
      if (
        input.kind === "archive-document" &&
        (await this.archiveSource.archive.status(input.literature_id, active))
          .status !== "READY"
      ) {
        input = {
          kind: "missing",
          input_id: input.input_id,
          literature_id: input.literature_id,
          reason: "not-ready",
        };
        invocation = parseProcessorInvocation({
          ...invocation,
          inputs: [input],
        });
      }
      const mapResults: StoredProcessorResult[] = [];
      if (input.kind === "snapshot") {
        const snapshot = await this.archiveSource.snapshots.all(
          input.snapshot_id,
          active,
        );
        if (snapshot.content_sha256 !== input.content_sha256)
          processorError("processor-snapshot-changed");
        const mapped: SnapshotProcessorInput["mapped_results"][number][] = [];
        if (execution.map) {
          const map = execution.map,
            target = this.registry.get(map.processor.id, map.processor.version),
            mapSpec = this.spec(target, map.spec),
            binding = await this.execution(target, mapSpec);
          for (const member of snapshot.members) {
            const fixed = await this.archiveSource.input(
              member.literature_id,
              binding.reads,
              active,
              member,
            );
            let result;
            try {
              result = await this.execute(
                {
                  schema_version: 1,
                  processor: map.processor,
                  spec: mapSpec,
                  inputs: [fixed],
                  execution: binding,
                },
                active,
              );
            } catch (error) {
              if (active.aborted) throw error;
              result = await this.execute(
                {
                  schema_version: 1,
                  processor: map.processor,
                  spec: mapSpec,
                  inputs: [
                    {
                      kind: "missing",
                      input_id: "document",
                      literature_id: member.literature_id,
                      reason: "map-failed",
                    },
                  ],
                  execution: binding,
                },
                active,
              );
            }
            const stored = await this.store.byId(result.result_id, active);
            if (!stored) processorError("processor-map-result-missing");
            mapResults.push(stored);
            mapped.push({ literature_id: member.literature_id, ...stored.ref });
          }
        }
        input = { ...input, mapped_results: mapped };
        invocation = parseProcessorInvocation({
          ...invocation,
          inputs: [input],
        });
      }
      const comparison = await processorComparison(invocation),
        previous = await this.store.byComparison(comparison, active);
      if (previous)
        return {
          ...previous.ref,
          reused: true,
          coverage: previous.result.coverage.every(
            (c) => c.status === "complete",
          )
            ? "complete"
            : "partial",
        };
      const reads = execution.reads,
        seen = new Set<string>(),
        calls: ProcessorObject[] = [];
      const segments =
        input.kind === "archive-document"
          ? await this.archiveSource.segments(input, reads, active)
          : [];
      const check = (candidate: ArchiveProcessorInput) => {
        if (!equal(input, candidate))
          processorError("processor-read-outside-scope");
        if (active.aborted) processorError("processor-cancelled");
      };
      const records: ProcessorSourceRecord[] = [];
      for (const source of mapResults)
        records.push(
          ...(await this.store.records(
            {
              kind: "result",
              input_id: "mapped",
              ...source.ref,
              record_ids: null,
            },
            active,
          )),
        );
      const allowedMap = (citation: ProcessorCitation) =>
        citation.kind === "result" &&
        mapResults.some(
          (r) =>
            r.ref.result_id === citation.result_id &&
            r.ref.content_sha256 === citation.content_sha256,
        );
      const snapshotCitation = (citation: ProcessorCitation) =>
        input.kind === "snapshot" &&
        citation.kind === "snapshot" &&
        citation.snapshot_id === input.snapshot_id &&
        citation.content_sha256 === input.content_sha256 &&
        (execution.uses_description ||
          (citation.literature_id === null && citation.pointer === "/count"));
      const ctx: ProcessorContext = {
        signal: active,
        describeSnapshot: async () => {
          if (input.kind !== "snapshot" || execution.map)
            processorError("processor-read-outside-scope");
          const snapshot = input,
            source = await this.archiveSource.snapshots.all(
              snapshot.snapshot_id,
              active,
            );
          return {
            count: source.member_count,
            members: execution.uses_description
              ? source.members.map(({ literature_id, metadata, tags }) => ({
                  literature_id,
                  metadata,
                  tags,
                }))
              : [],
            citation: (literature_id, pointer) => ({
              kind: "snapshot",
              snapshot_id: snapshot.snapshot_id,
              content_sha256: snapshot.content_sha256,
              literature_id,
              pointer,
            }),
          };
        },
        readDocument: async (candidate) => {
          check(candidate);
          segments.forEach((s) => seen.add(s.segment_id));
          return segments;
        },
        searchDocument: async (candidate, query) => {
          check(candidate);
          const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean),
            found = segments.filter((s) =>
              terms.some((t) => s.text.toLocaleLowerCase().includes(t)),
            );
          found.forEach((s) => seen.add(s.segment_id));
          return found;
        },
        mappedCoverage: () =>
          mapResults.flatMap((r) =>
            r.result.coverage.flatMap((c) => c.parts ?? []),
          ),
        readMappedResults: async () => {
          if (input.kind !== "snapshot")
            processorError("processor-read-outside-scope");
          return records;
        },
        resolveEvidence: async (citation) => {
          if (!allowedMap(citation) && !snapshotCitation(citation))
            processorError("processor-read-outside-scope");
          return this.store.verifyCitations([citation], active);
        },
        summarize: async (candidate, purpose, question) => {
          check(candidate);
          if (
            p.id !== "summary" ||
            reads.parts !== "main" ||
            reads.roles !== "all" ||
            candidate.parts.length !== 1 ||
            !candidate.parts[0]!.available
          )
            processorError("processor-summary-scope");
          const ref = (
            await this.documents.describe(
              { document_version_id: candidate.parts[0]!.document_version_id },
              active,
            )
          ).document;
          const manifest = await createInputManifest([
            {
              input_id: "document",
              literature_id: candidate.literature_id,
              material: ref.source_material_ref,
              document: ref,
              capabilities: [
                "material-file-v1",
                "document-segment-v1",
                "document-text-v1",
              ],
              gaps: [],
            },
          ]);
          const accounting = {
            calls: 0,
            canonical_call_bytes: 0,
            reported_calls: 0,
            reported_input_tokens: 0,
            reported_output_tokens: 0,
          };
          const result = await analyzeDocumentSession(
            { input: manifest, purpose, question },
            this.documents,
            this.agents,
            this.agents.effectiveIdentity("analysis"),
            active,
            accounting,
            true,
          );
          segments.forEach((s) => seen.add(s.segment_id));
          calls.push({
            accounting: "session-aggregate",
            calls: accounting.calls,
            reported_calls: accounting.reported_calls,
            provider: result.provider,
            model: result.model,
            usage: {
              input_tokens: accounting.reported_input_tokens,
              output_tokens: accounting.reported_output_tokens,
            },
          });
          return result;
        },
        model: async (system, body, schema) => {
          if (!p.model || !equal(execution, await this.execution(p, spec)))
            processorError("processor-binding-changed");
          const result = await this.agents.execute(
            {
              role: "analysis",
              required_capabilities: ["structured_text"],
              input_sha256: await sha256(canonicalJsonBytes(body)),
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
                      text: JSON.stringify(body),
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
      let output: ProcessorOutput;
      if (
        input.kind === "missing" ||
        (input.kind === "archive-document" && !segments.length)
      )
        output = {
          status: "empty",
          content:
            p.output_kind === "report"
              ? { kind: "report", text: "", claims: [] }
              : {
                  kind: "records",
                  schema: p.outputSchema?.(spec) ?? { type: "object" },
                  records: [],
                },
          coverage: [
            {
              input_id: input.input_id,
              status: input.kind === "missing" ? "none" : "complete",
              read_segments: [],
              gaps: input.kind === "missing" ? [input.reason] : [],
            },
          ],
        };
      else output = await p.run(invocation, ctx);
      if (
        output.content.kind !== p.output_kind ||
        (p.outputSchema &&
          output.content.kind === "records" &&
          !equal(output.content.schema, p.outputSchema(spec)))
      )
        processorError("processor-output-schema");
      const citations = resultCitations(output.content);
      for (const citation of citations) {
        if (
          input.kind === "snapshot"
            ? !allowedMap(citation) && !snapshotCitation(citation)
            : citation.kind !== "document" ||
              citation.evidence.target_kind !== "document" ||
              !segments.some(
                (s) => seen.has(s.segment_id) && equal(s.citation, citation),
              )
        )
          processorError("processor-evidence-outside-scope");
      }
      await this.store.verifyCitations(citations, active);
      const reported = output.coverage.flatMap((c) => c.read_segments);
      if (reported.some((id) => !seen.has(id)))
        processorError("processor-coverage");
      const parts: ProcessorPartOutcome[] = [];
      if (input.kind === "archive-document") {
        for (const role of (reads.parts === "all"
          ? ["main", "supplementary"]
          : [reads.parts]) as ("main" | "supplementary")[]) {
          const selected = input.parts.filter((p) => p.part === role);
          if (!selected.length)
            parts.push({
              literature_id: input.literature_id,
              asset_id: null,
              part: role,
              outcome: "part-absent",
              read_segments: [],
              gaps: ["part-absent"],
            });
          for (const part of selected) {
            const eligible = segments.filter(
                (s) => s.asset_id === part.asset_id,
              ),
              read = eligible.filter((s) => reported.includes(s.segment_id)),
              complete = part.available && read.length === eligible.length;
            const extracted = citations.some((c) =>
              eligible.some((s) => equal(s.citation, c)),
            );
            parts.push({
              literature_id: input.literature_id,
              asset_id: part.asset_id,
              part: role,
              outcome: !complete
                ? "incomplete"
                : extracted
                  ? "extracted"
                  : "not-reported",
              read_segments: read.map((s) => s.segment_id),
              gaps: !part.available
                ? ["part-unavailable"]
                : complete
                  ? []
                  : ["unread-segments"],
            });
          }
        }
      } else if (input.kind === "missing")
        parts.push({
          literature_id: input.literature_id,
          asset_id: null,
          part: reads.parts === "supplementary" ? "supplementary" : "main",
          outcome: "incomplete",
          read_segments: [],
          gaps: [input.reason],
        });
      else
        parts.push(
          ...mapResults.flatMap((r) =>
            r.result.coverage.flatMap((c) => c.parts ?? []),
          ),
        );
      const incomplete = parts.some((p) => p.outcome === "incomplete"),
        coverage: ProcessorCoverage[] = [
          {
            input_id: input.input_id,
            status: incomplete
              ? reported.length
                ? "partial"
                : "none"
              : "complete",
            read_segments: reported,
            gaps: [...new Set(parts.flatMap((p) => p.gaps))],
            parts,
          },
        ];
      if (output.content.kind === "records") {
        await validateRecordPayloads(
          output.content.schema,
          output.content.records.map((r) => r.payload),
          active,
        );
        for (const record of output.content.records) this.verifyRecord(record);
      }
      const literature_ids =
        input.kind === "archive-document" || input.kind === "missing"
          ? [input.literature_id]
          : input.kind === "snapshot"
            ? (
                await this.archiveSource.snapshots.all(
                  input.snapshot_id,
                  active,
                )
              ).members.map((m) => m.literature_id)
            : [];
      const verification = this.verifier
        ? await this.verifier.check(
            output.content,
            mapResults.map((r) => r.result),
            active,
          )
        : {
            checks: uncheckedProcessorValues(
              output.content,
              "verification-not-configured",
            ),
            usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
          };
      const result = await parseProcessorResult({
        schema_version: 1,
        result_id: randomUUID(),
        invocation,
        comparison_sha256: comparison,
        ...output,
        value_checks: verification.checks,
        status: incomplete ? "ok" : output.status,
        coverage,
        producer: "internal",
        provenance: {
          ...output.provenance,
          model_calls: calls,
          value_check_usage: verification.usage,
        },
        literature_ids: [...new Set(literature_ids)].sort(),
        created_at: new Date().toISOString(),
      });
      const saved = await this.store.publish(result, active);
      return {
        ...saved.ref,
        reused: saved.ref.result_id !== result.result_id,
        coverage: incomplete ? "partial" : "complete",
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
