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
  ARCHIVE_STEPS,
  parseDocumentTranslateRequest,
  isArchiveTranslationStep,
  type ArchiveState,
  type ArchiveEstimateComponent,
  type EstimateRange,
} from "@sciretriever/contracts";
import type { ProcessorPlanner } from "./processor-planning.js";
import type { ProcessorStore } from "./processor.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { LiteratureQueryService } from "../literature/query.js";
import type { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import type { TagService } from "../tags/service.js";
import { translationRefusal } from "../archive/orchestrator.js";

type Component =
  | ({ kind: string } & ReturnType<typeof range>)
  | (Omit<ArchiveEstimateComponent, "kind"> & { kind: string });
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
    private readonly archiveMethod: string | null = null,
    private readonly archiveTextWork?: (
      part: import("@sciretriever/contracts").ArchivePart,
      signal: AbortSignal,
    ) => Promise<{
      arrange_required: boolean;
      total_pdf_pages: number | null;
      expected_proofread_pages: number | null;
      page_basis: "accepted-arrangement" | "all-pdf-pages" | "unknown";
    }>,
    /** The main PDF still needs the translate step (ADR 0068). */
    private readonly archiveTranslationPending?: (
      part: import("@sciretriever/contracts").ArchivePart,
    ) => Promise<boolean>,
    /** The main PDF still needs the layers step (ADR 0069). */
    private readonly archiveLayersPending?: (
      part: import("@sciretriever/contracts").ArchivePart,
      signal: AbortSignal,
    ) => Promise<boolean>,
  ) {}
  /**
   * One archive step's estimate from matching history: the per-unit median
   * and P90 of successful attempts, times the units still to do.
   */
  private archiveComponent(
    step: (typeof ARCHIVE_STEPS)[number],
    unit: ArchiveEstimateComponent["unit"],
    units: number | null,
    history: readonly (Usage & {
      step: string;
      stats: Record<string, unknown>;
    })[],
  ): ArchiveEstimateComponent & { kind: string } {
    const deterministic = step === "render" || step === "references";
    const samples = history
      .filter(
        (s) =>
          // On-request translations into another language cost the same per page.
          (s.step === step ||
            (step === "translate" && isArchiveTranslationStep(s.step))) &&
          s.stats.workflow === "arranged-v2" &&
          s.stats.status === "done" &&
          s.stats.usage_complete === true &&
          this.archiveMethod !== null &&
          s.stats.method_sha256 === this.archiveMethod,
      )
      .flatMap((s) => {
        // Translation history counts per page of papers that asked the model.
        if (step === "translate" && !Number(s.stats.requested_units ?? 0))
          return [];
        // Layers history counts per paper that asked the model.
        if (step === "layers" && s.stats.requested !== true) return [];
        const n =
          step === "proofread"
            ? Number(s.stats.executed_pages ?? 0)
            : step === "translate"
              ? Number(s.stats.pages ?? 0)
              : 1;
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
    const estimate = (key: keyof Usage): EstimateRange | null => {
      if (deterministic || units === 0) return { median: 0, p90: 0 };
      if (units === null || !samples.length) return null;
      const sorted = samples.map((s) => s[key]).sort((a, b) => a - b),
        q = (p: number) =>
          Math.ceil(
            sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! * units,
          );
      return { median: q(0.5), p90: q(0.9) };
    };
    return {
      kind: step,
      step,
      unit,
      units,
      sample_count: samples.length,
      basis: deterministic
        ? "deterministic"
        : samples.length
          ? "matching-history"
          : "unknown",
      calls: estimate("calls"),
      input_tokens: estimate("input_tokens"),
      output_tokens: estimate("output_tokens"),
      unknown_code:
        deterministic || units === 0
          ? null
          : units === null
            ? "pages-unknown"
            : samples.length
              ? null
              : "no-matching-history",
    };
  }
  async estimate(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{
    count: number | null;
    reused_count: number | null;
    components: Component[];
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
    if (r.kind === "document-translate") {
      // Translate one paper on request (ADR 0072, spec 9.6.1): the translate
      // step alone, by the main PDF's pages and the same history.
      const request = parseDocumentTranslateRequest(r.request);
      const state = await this.planner.archiveSource.archive.status(
          request.literature_id,
          stop,
        ),
        main = state.parts.find((p) => p.part === "main"),
        refusal = translationRefusal(state);
      const existing =
        !refusal && main
          ? ((
              await this.db.archive<{ status: string } | null>(
                "translation",
                {
                  document_version_id: main.document_version_id,
                  content_version: main.content_version,
                  target_language: request.target_language,
                },
                stop,
              )
            )?.status ?? null)
          : null;
      const skipped = existing === "complete" || existing === "same-language",
        work =
          main && this.archiveTextWork
            ? await this.archiveTextWork(main, stop)
            : null,
        pdfPages = work?.total_pdf_pages ?? null;
      const history = await this.db.review<
        (Usage & { step: string; stats: Record<string, unknown> })[]
      >("usage-history", { kind: "archive" });
      const component = this.archiveComponent(
        "translate",
        "page",
        refusal || skipped ? 0 : pdfPages,
        history,
      );
      return {
        schema_version: 2,
        kind: "document-translate",
        literature_id: request.literature_id,
        target_language: request.target_language,
        refusal,
        state: existing,
        count: 1,
        reused_count: skipped ? 1 : 0,
        total_pdf_pages: pdfPages,
        components: [component],
        total: {
          calls: component.calls,
          input_tokens: component.input_tokens,
          output_tokens: component.output_tokens,
        },
        estimate_method: "archive-v2-matched-success-per-unit-v1",
        available: component.input_tokens !== null,
        no_hard_limit: true,
      };
    }
    if (r.kind === "processing") {
      const task = await parseProcessingTaskRequest(r.request);
      const components: Component[] = [];
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
        else if (op.operation === "build-archive" && op.request.translate_only)
          estimate = await this.estimate(
            {
              kind: "document-translate",
              request: {
                literature_id: op.request.literature_id,
                target_language: op.request.translate_only,
              },
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
        reused = 0,
        totalPages = 0,
        totalUnknown = 0,
        workParts = 0,
        translatePages = 0,
        translateUnknown = 0,
        layersParts = 0,
        acceptedBasis = true;
      for (const id of ids) {
        stop.throwIfAborted();
        const state = await this.planner.archiveSource.archive.status(id, stop);
        const fullyReusable = await this.archiveReuse(state, stop);
        if (fullyReusable) reused++;
        for (const part of state.parts) {
          if (this.archiveTextWork) {
            const work = await this.archiveTextWork(part, stop);
            if (work.total_pdf_pages === null) totalUnknown++;
            else totalPages += work.total_pdf_pages;
            // Translation is counted by the main PDF's pages, reused or not.
            if (await this.archiveTranslationPending?.(part)) {
              if (work.total_pdf_pages === null) translateUnknown++;
              else translatePages += work.total_pdf_pages;
            }
            // Reading layers are counted per main PDF, reused or not.
            if (await this.archiveLayersPending?.(part, stop)) layersParts++;
            if (fullyReusable) continue;
            if (work.arrange_required) workParts++;
            if (work.expected_proofread_pages === null) unknown++;
            else pages += work.expected_proofread_pages;
            acceptedBasis &&= work.page_basis === "accepted-arrangement";
            continue;
          }
          acceptedBasis = false;
          const current = await this.raw.current(part.asset_id, stop);
          const source = current.find(
            (c) => c.profile === this.profile,
          )?.result;
          if (source) totalPages += source.page_count;
          else totalUnknown++;
          if (fullyReusable) continue;
          workParts++;
          if (source) pages += source.page_count;
          else unknown++;
        }
      }
      const history = await this.db.review<
        (Usage & { step: string; stats: Record<string, unknown> })[]
      >("usage-history", { kind: "archive" });
      const components = ARCHIVE_STEPS.map(
        (step): ArchiveEstimateComponent & { kind: string } => {
          const unit =
            step === "proofread" || step === "translate"
              ? ("page" as const)
              : step === "arrange"
                ? ("part" as const)
                : ("literature" as const);
          const units =
            step === "proofread"
              ? unknown
                ? null
                : pages
              : step === "translate"
                ? translateUnknown
                  ? null
                  : translatePages
                : step === "layers"
                  ? layersParts
                  : step === "arrange"
                    ? workParts
                    : ids.length - reused;
          return this.archiveComponent(step, unit, units, history);
        },
      );
      const total = (
        key: "calls" | "input_tokens" | "output_tokens",
      ): EstimateRange | null =>
        components.some((c) => c[key] === null)
          ? null
          : {
              median: components.reduce((n, c) => n + c[key]!.median, 0),
              p90: components.reduce((n, c) => n + c[key]!.p90, 0),
            };
      return {
        schema_version: 2,
        kind: "archive",
        count: ids.length,
        reused_count: reused,
        total_pdf_pages: totalUnknown ? null : totalPages,
        expected_proofread_pages: unknown ? null : pages,
        page_basis: unknown
          ? "unknown"
          : acceptedBasis
            ? "accepted-arrangement"
            : "all-pdf-pages",
        components,
        total: {
          calls: total("calls"),
          input_tokens: total("input_tokens"),
          output_tokens: total("output_tokens"),
        },
        estimate_method: "archive-v2-matched-success-per-unit-v1",
        available: components.every((c) => c.input_tokens !== null),
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
    const selected = await this.library.search(
      {
        query,
        sort: "title-asc",
        limit: 10001,
        cursor: null,
      },
      signal,
      "selection",
    );
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
