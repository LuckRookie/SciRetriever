import {
  canonicalJsonBytes,
  PROCESSOR_METHOD_REVISION,
  parseProcessorReads,
  parseProcessorBatchRequest,
  parseProcessorInvocation,
  processorJson,
  sha256,
  type ProcessorObject,
  type ProcessorBatchRequest,
  type ProcessorInvocation,
  type ProcessorInput,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import {
  processorError,
  type Processor,
  type ProcessorRegistry,
} from "./processor.js";
import type { ProcessorArchiveSource } from "./processor-archive.js";
import { validateRecordPayloads } from "../extraction/spec.js";
export class ProcessorPlanner {
  constructor(
    readonly registry: ProcessorRegistry,
    private readonly agents: Pick<
      DshAgentRuntime,
      "readiness" | "effectiveIdentity"
    >,
    readonly archiveSource: ProcessorArchiveSource,
    private readonly verifier?: { identity: () => Promise<string> },
  ) {}
  spec(p: Processor, value: ProcessorObject) {
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
  async execution(p: Processor, spec: ProcessorObject) {
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
          method_revision: PROCESSOR_METHOD_REVISION,
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
    const active = signal ?? new AbortController().signal;
    return (async () => {
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
    })();
  }
}
