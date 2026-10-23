import {
  processorJson,
  processorObject,
  tagRecord as operationRecord,
  type LibraryQuery,
  parseAssetId,
  parseProcessingTaskRequest,
  parseSnapshotDefinition,
  parseProcessorInvocation,
  processorComparison,
  type ProcessorInvocation,
  type ProcessorObject,
  type ArchiveState,
} from "@sciretriever/contracts";
import type { ProcessorPlanner } from "./processor-planning.js";
import type { ProcessorStore } from "./processor.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { LiteratureQueryService } from "../literature/query.js";
import type { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import type { TagService } from "../tags/service.js";

interface Usage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}
function range(samples: readonly Usage[], units: number) {
  if (units === 0)
    return {
      sample_count: samples.length,
      input_tokens: [0, 0],
      output_tokens: [0, 0],
    };
  if (!samples.length)
    return { sample_count: 0, input_tokens: null, output_tokens: null };
  const quantile = (key: "input_tokens" | "output_tokens", q: number) => {
    const values = samples.map((s) => s[key]).sort((a, b) => a - b);
    return Math.ceil(
      values[Math.max(0, Math.ceil(values.length * q) - 1)]! * units,
    );
  };
  return {
    sample_count: samples.length,
    input_tokens: [
      quantile("input_tokens", 0.5),
      quantile("input_tokens", 0.9),
    ],
    output_tokens: [
      quantile("output_tokens", 0.5),
      quantile("output_tokens", 0.9),
    ],
  };
}
export class UsageEstimator {
  constructor(
    private readonly db: SqliteWorker,
    private readonly planner: ProcessorPlanner,
    private readonly store: ProcessorStore,
    private readonly library: LiteratureQueryService,
    private readonly raw: Pick<SqliteRawParseStorage, "current">,
    private readonly tags: TagService,
    private readonly profile: string,
    private readonly archiveReuse: (
      state: ArchiveState,
      signal: AbortSignal,
    ) => Promise<boolean>,
  ) {}
  async estimate(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{
    count: number | null;
    reused_count: number | null;
    components: ({ kind: string } & ReturnType<typeof range>)[];
    available: boolean;
    no_hard_limit: boolean;
    [key: string]: unknown;
  }> {
    const r = operationRecord(value, ["kind", "request"]),
      stop = signal ?? new AbortController().signal;
    stop.throwIfAborted();
    if (r.kind === "synthesis") {
      const request = operationRecord(r.request, ["selector", "spec"]),
        definition = parseSnapshotDefinition(request.selector);
      const ids =
        definition.kind === "literatures"
          ? definition.literature_ids
          : await this.select(definition.query, stop);
      const captured = await this.db.snapshot<{
          members: { literature_id: string }[];
        }>("capture", { ids }, stop),
        ready = captured.members.map((m) => m.literature_id);
      const spec = this.planner.spec(
        this.planner.registry.get("knowledge-synthesis", "2"),
        processorJson(request.spec),
      );
      void spec;
      if (!ready.length)
        return {
          count: 0,
          reused_count: 0,
          available: true,
          components: [],
          excluded_count: ids.length,
          no_hard_limit: true,
        };
      const preview = await this.estimate(
        {
          kind: "processor",
          request: {
            schema_version: 1,
            idempotency_key: "estimate",
            name: "Mapped reading",
            processor: { id: "summary", version: "2" },
            spec: { purpose: "overview", question: null },
            inputs: ready.map((literature_id) => ({
              kind: "literature",
              literature_id,
            })),
          },
        },
        stop,
      );
      const summary = range(
        await this.db.review<Usage[]>("usage-history", {
          kind: "processor",
          processor: "knowledge-synthesis",
        }),
        1,
      );
      return {
        ...preview,
        excluded_count: ids.length - ready.length,
        components: [
          ...preview.components.map((c) => ({
            ...c,
            kind: "mapped-documents",
          })),
          { kind: "synthesis", ...summary },
        ],
        available: preview.available && summary.input_tokens !== null,
      };
    }
    if (r.kind === "archive-issues") {
      const request = operationRecord(r.request, ["issue_ids"]);
      if (!Array.isArray(request.issue_ids) || request.issue_ids.length > 10000)
        throw new Error("estimate-scope-limit");
      const ids = await this.db.review<string[]>("estimate-issues", {
        ids: request.issue_ids.map((v) => String(parseAssetId(v))),
      });
      return this.estimate(
        {
          kind: "archive",
          request: { selector: { kind: "literatures", literature_ids: ids } },
        },
        stop,
      );
    }
    if (r.kind === "processing") {
      const task = await parseProcessingTaskRequest(r.request);
      const components: ({ kind: string } & ReturnType<typeof range>)[] = [];
      let available = true;
      for (const op of task.operations) {
        stop.throwIfAborted();
        let estimate;
        if (op.operation === "run-processor")
          estimate = await this.processor([op.request], stop);
        else if (op.operation === "backfill-tags")
          estimate = await this.estimate(
            {
              kind: "tags",
              request: { operation: "backfill", tag_ids: op.request.tag_ids },
            },
            stop,
          );
        else if (
          op.operation === "build-archive" &&
          op.request.from_step === null &&
          op.request.mode === "full"
        )
          estimate = await this.estimate(
            {
              kind: "archive",
              request: {
                selector: {
                  kind: "literatures",
                  literature_ids: [op.request.literature_id],
                },
              },
            },
            stop,
          );
        else {
          const usesModel = op.operation !== "parse-documents";
          estimate = {
            available: !usesModel,
            components: [
              { kind: op.operation, ...range([], usesModel ? 1 : 0) },
            ],
          };
        }
        components.push(...estimate.components);
        available = available && estimate.available;
      }
      return {
        count: null,
        reused_count: null,
        operation_count: task.operations.length,
        components,
        available,
        no_hard_limit: true,
      };
    }
    if (r.kind === "processor") {
      const plan = await this.planner.prepare(r.request, stop);
      return this.processor(plan.invocations, stop);
    }
    if (r.kind === "archive") {
      const request = operationRecord(r.request, ["selector"]),
        selection = parseSnapshotDefinition(request.selector);
      const ids =
        selection.kind === "literatures"
          ? selection.literature_ids
          : await this.select(selection.query, stop);
      let pages = 0,
        unknown = 0,
        reused = 0;
      for (const id of ids) {
        stop.throwIfAborted();
        const state = await this.planner.archiveSource.archive.status(id, stop);
        if (await this.archiveReuse(state, stop)) {
          reused++;
          continue;
        }
        for (const part of state.parts) {
          const current = await this.raw.current(part.asset_id, stop);
          const source = current.find(
            (c) => c.profile === this.profile,
          )?.result;
          if (source?.page_sizes.length) pages += source.page_sizes.length;
          else unknown++;
        }
      }
      const history = await this.db.review<
        (Usage & { step: string; stats: Record<string, unknown> })[]
      >("usage-history", { kind: "archive" });
      const components = ["proofread", "structure", "metadata", "tags"].map(
        (step) => {
          const samples = history
            .filter((s) => s.step === step)
            .flatMap((s) => {
              if (step !== "proofread") return [s];
              const n =
                Number(s.stats.text_layer_pages ?? 0) +
                Number(s.stats.image_only_pages ?? 0) +
                Number(s.stats.blank_pages ?? 0);
              return n > 0
                ? [
                    {
                      calls: s.calls / n,
                      input_tokens: s.input_tokens / n,
                      output_tokens: s.output_tokens / n,
                    },
                  ]
                : [];
            });
          return {
            kind: step,
            unit: step === "proofread" ? "page" : "document",
            ...range(
              samples,
              step === "proofread" ? pages : ids.length - reused,
            ),
          };
        },
      );
      return {
        count: ids.length,
        reused_count: reused,
        reuse_basis: "fully-reusable-archive-papers",
        pages,
        unknown_page_parts: unknown,
        components,
        available: !unknown && components.every((c) => c.input_tokens !== null),
        no_hard_limit: true,
      };
    }
    if (r.kind === "tags") {
      const request = processorObject(r.request);
      if (
        Object.keys(request).some((k) => !["operation", "tag_ids"].includes(k))
      )
        throw new Error("estimate-invalid");
      if (!["backfill", "consolidate"].includes(String(request.operation)))
        throw new Error("estimate-invalid");
      const preview =
        request.operation === "backfill"
          ? await this.tags.backfill(
              Array.isArray(request.tag_ids)
                ? request.tag_ids.map((v) => String(parseAssetId(v)))
                : [],
              true,
              stop,
            )
          : null;
      const count =
          preview && "candidate_count" in preview
            ? Number(preview.candidate_count)
            : null,
        units =
          preview && "estimated_calls" in preview
            ? Number(preview.estimated_calls)
            : 1;
      const samples = await this.db.review<Usage[]>("usage-history", {
        kind: "tags",
        role:
          request.operation === "backfill"
            ? "tag-backfill"
            : "tag-consolidation",
      });
      const component = range(samples, units);
      return {
        count,
        reused_count: 0,
        components: [{ kind: String(request.operation), ...component }],
        available: component.input_tokens !== null,
        no_hard_limit: true,
      };
    }
    throw new Error("estimate-invalid");
  }
  private async processor(
    invocations: readonly ProcessorInvocation[],
    signal: AbortSignal,
  ) {
    const first = invocations[0];
    if (!first)
      return {
        count: 0,
        reused_count: 0,
        components: [],
        available: true,
        no_hard_limit: true,
      };
    const p = this.planner.registry.get(
      first.processor.id,
      first.processor.version,
    );
    const checks = await Promise.all(
      invocations.map((i) => this.reuse(i, signal)),
    );
    const count = checks.reduce((n, c) => n + c.count, 0),
      reused = checks.reduce((n, c) => n + c.reused, 0);
    const samples = await this.db.review<Usage[]>("usage-history", {
      kind: "processor",
      processor: p.id,
    });
    const components = [
      {
        kind: p.scope === "collection" ? "synthesis" : "document",
        ...range(
          samples,
          p.scope === "collection"
            ? checks.filter((c) => !c.ref).length
            : count - reused,
        ),
      },
    ];
    if (p.map) {
      const mapped = await this.db.review<Usage[]>("usage-history", {
        kind: "processor",
        processor: p.map.processor.id,
      });
      components.unshift({
        kind: "mapped-documents",
        ...range(mapped, count - reused),
      });
    }
    return {
      count,
      reused_count: reused,
      reuse_basis: "fixed-input-spec-method-model",
      components,
      available: components.every((c) => c.input_tokens !== null),
      no_hard_limit: true,
    };
  }
  private async select(query: LibraryQuery, signal: AbortSignal) {
    signal.throwIfAborted();
    const selected = await this.library.search({
      query,
      sort: "title-asc",
      limit: 10001,
      cursor: null,
    });
    if (selected.next_cursor || selected.items.length > 10000)
      throw new Error("estimate-scope-limit");
    return selected.items.map((v) => v.literature.literature_id);
  }
  private async reuse(
    invocation: ProcessorInvocation,
    signal: AbortSignal,
  ): Promise<{
    count: number;
    reused: number;
    ref: { result_id: string; content_sha256: string } | null;
  }> {
    signal.throwIfAborted();
    const input = invocation.inputs[0];
    let count = 1,
      reused = 0;
    if (input?.kind === "snapshot") {
      const snapshot = await this.planner.archiveSource.snapshots.all(
          input.snapshot_id,
          signal,
        ),
        map = invocation.execution.map;
      count = snapshot.members.length;
      if (map) {
        const target = this.planner.registry.get(
            map.processor.id,
            map.processor.version,
          ),
          spec = this.planner.spec(target, map.spec as ProcessorObject),
          execution = await this.planner.execution(target, spec),
          mapped = [];
        for (const member of snapshot.members) {
          const fixed = await this.planner.archiveSource.input(
              member.literature_id,
              execution.reads,
              signal,
              member,
            ),
            check = await this.reuse(
              parseProcessorInvocation({
                schema_version: 1,
                processor: map.processor,
                spec,
                execution,
                inputs: [fixed],
              }),
              signal,
            );
          reused += check.reused;
          if (check.ref)
            mapped.push({ literature_id: member.literature_id, ...check.ref });
        }
        if (mapped.length !== count) return { count, reused, ref: null };
        invocation = parseProcessorInvocation({
          ...invocation,
          inputs: [{ ...input, mapped_results: mapped }],
        });
      }
    }
    const old = await this.store.byComparison(
      await processorComparison(invocation),
      signal,
    );
    return {
      count,
      reused: input?.kind === "snapshot" ? reused : old ? 1 : 0,
      ref: old?.ref ?? null,
    };
  }
}
