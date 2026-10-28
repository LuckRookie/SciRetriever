import {
  ACQUISITION_STAGES,
  ContractValidationError,
  parseAcquisitionAttempt,
  parseMetadataSourceProgress,
  parseMetadataSourceRecord,
  parsePdfSourceResult,
  parseTaskSourceResults,
  parseSourceStatistics,
  type AcquisitionAttempt,
  type MetadataSourceRecord,
  type MetadataSourceCounts,
  type MetadataSourceMetrics,
  type PdfSourceResult,
  type PdfSourceSummary,
  type SourceProblem,
  type SourceRatio,
  type SourceStatisticsRequest,
  type SourceStatistics,
  type TaskSourceResults,
} from "@sciretriever/contracts";
import type { ExecutionEvent } from "../storage/sqlite/worker.js";
import { LITERATURE_PROVIDERS } from "../providers/registry.js";
import {
  sourceProblem,
  combineSourceDetails,
} from "../providers/shared/source-problem.js";

export function sourceRatio(
  numerator: number,
  denominator: number,
): SourceRatio {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  return value as Record<string, unknown>;
};
const identifier = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value))
    throw new ContractValidationError();
  return value;
};
function problemList(values: readonly (SourceProblem | null)[]) {
  const grouped = new Map<SourceProblem["display"], SourceProblem[]>();
  for (const p of values)
    if (p) grouped.set(p.display, [...(grouped.get(p.display) ?? []), p]);
  return [...grouped].map(([display, ps]) => ({
    display,
    technical_details: combineSourceDetails(ps),
  }));
}
interface MetadataState {
  readonly job: string;
  readonly target: string;
  readonly row: MetadataSourceRecord;
  readonly included: Set<string>;
  readonly created: Set<string>;
  readonly matched: Set<string>;
}
interface PdfState {
  readonly job: string;
  readonly literature: string;
  readonly attempts: AcquisitionAttempt[];
  published: PdfSourceResult | null;
  terminal: boolean;
  legacyHit: AcquisitionAttempt | null;
}
/** The same reducer owns task totals and historical statistics. It never queries library facts. */
export class SourceResultAggregation {
  private readonly metadata = new Map<string, MetadataState>();
  private readonly pdf = new Map<string, PdfState>();
  accept(event: Pick<ExecutionEvent, "job_id" | "kind" | "payload">) {
    if (event.kind === "metadata-source") {
      const p = record(event.payload),
        progress = parseMetadataSourceProgress(p.progress),
        target = identifier(p.target_id),
        key = event.job_id + ":" + progress.record_id;
      const existing = this.metadata.get(key);
      if (progress.phase === "started") {
        if (existing) throw new ContractValidationError();
        this.metadata.set(key, {
          job: event.job_id,
          target,
          row: {
            record_id: progress.record_id,
            source: progress.source,
            purpose: progress.purpose,
            role: progress.role,
            unit_id: progress.unit_id,
            started_at: progress.at,
            finished_at: null,
            requested: false,
            returned: 0,
            included: 0,
            rejected: 0,
            result: "running",
            problem: null,
          },
          included: new Set(),
          created: new Set(),
          matched: new Set(),
        });
        return;
      }
      if (
        !existing ||
        existing.target !== target ||
        existing.row.source !== progress.source ||
        existing.row.purpose !== progress.purpose ||
        existing.row.role !== progress.role ||
        existing.row.unit_id !== progress.unit_id ||
        existing.row.finished_at !== null ||
        Date.parse(progress.at) < Date.parse(existing.row.started_at)
      )
        throw new ContractValidationError();
      let patch: Partial<MetadataSourceRecord> = {};
      if (progress.phase === "requested") patch = { requested: true };
      if (progress.phase === "returned")
        patch = { returned: existing.row.returned + progress.count };
      if (progress.phase === "rejected")
        patch = { rejected: existing.row.rejected + progress.count };
      if (progress.phase === "included") {
        existing.included.add(progress.result_id);
        patch = { included: existing.included.size };
      }
      if (progress.phase === "observed") {
        if (progress.disposition === "created")
          existing.created.add(progress.result_id);
        if (progress.disposition === "matched")
          existing.matched.add(progress.result_id);
      }
      if (progress.phase === "finished")
        patch = {
          result: progress.result,
          finished_at: progress.at,
          problem: progress.problem,
        };
      this.metadata.set(key, {
        ...existing,
        row: parseMetadataSourceRecord({ ...existing.row, ...patch }),
      });
      return;
    }
    if (
      event.kind !== "acquisition-attempt" &&
      event.kind !== "pdf-source-result"
    )
      return;
    const p = record(event.payload),
      final =
        event.kind === "pdf-source-result"
          ? parsePdfSourceResult(p.result)
          : null,
      // A MetaLiterature target may try multiple candidate versions. It is still
      // one requested paper and one final delivery channel in this task.
      literature =
        p.target_id === undefined
          ? (final?.literature_id ?? identifier(p.literature_id))
          : identifier(p.target_id),
      key = event.job_id + ":" + literature;
    let state = this.pdf.get(key);
    if (!state) {
      state = {
        job: event.job_id,
        literature,
        attempts: [],
        published: null,
        terminal: false,
        legacyHit: null,
      };
      this.pdf.set(key, state);
    }
    if (final) {
      state.terminal = true;
      // Later cleanup/attempt failures cannot revoke a recorded publication.
      if (final.result === "obtained") state.published = final;
    } else {
      const attempt = parseAcquisitionAttempt(p.attempt);
      // This is metadata evidence preparation, not a PDF delivery channel.
      if (attempt.source === "doi-resolution") return;
      state.attempts.push(attempt);
      if (attempt.result === "hit") state.legacyHit = attempt;
    }
  }
  private metadataSummary() {
    const states = [...this.metadata.values()];
    if (!states.length) return null;
    const allIncluded = new Set<string>(),
      created = new Set<string>(),
      matched = new Set<string>();
    for (const s of states) {
      for (const id of s.included) allIncluded.add(s.job + ":" + id);
      for (const id of s.created) created.add(s.job + ":" + id);
      for (const id of s.matched) matched.add(s.job + ":" + id);
    }
    const bySource = new Map<string, MetadataState[]>();
    for (const s of states)
      bySource.set(s.row.source, [...(bySource.get(s.row.source) ?? []), s]);
    const sources: MetadataSourceCounts[] = [...bySource].map(
      ([source, items]) => {
        const ids = new Set(
            items.flatMap((s) => [...s.included].map((id) => s.job + ":" + id)),
          ),
          purposes = new Set(items.map((s) => s.row.purpose)),
          requested = items.filter((s) => s.row.requested),
          units = new Set(
            requested.map((s) =>
              [s.job, s.target, s.row.purpose, s.row.unit_id].join(":"),
            ),
          ),
          hits = new Set(
            requested
              .filter((s) => s.row.result === "hit")
              .map((s) =>
                [s.job, s.target, s.row.purpose, s.row.unit_id].join(":"),
              ),
          ),
          problems = problemList(items.map((s) => s.row.problem));
        return {
          source,
          purpose: purposes.size === 1 ? items[0]!.row.purpose : "mixed",
          returned: items.reduce((n, s) => n + s.row.returned, 0),
          included: ids.size,
          requests: requested.length,
          attempted_units: units.size,
          hit_units: hits.size,
          errors: requested.filter((s) => s.row.result === "error").length,
          coverage: sourceRatio(ids.size, allIncluded.size),
          problems,
          technical_details: combineSourceDetails(problems),
        };
      },
    );
    return {
      returned: states.reduce((n, s) => n + s.row.returned, 0),
      merged: allIncluded.size,
      new_literatures: created.size,
      matched_literatures: [...matched].filter((id) => !created.has(id)).length,
      rejected: states.reduce((n, s) => n + s.row.rejected, 0),
      sources: sources.sort(
        (a, b) => b.returned - a.returned || a.source.localeCompare(b.source),
      ),
      records: states.slice(0, 200).map((s) => s.row),
      record_count: states.length,
      records_truncated: states.length > 200,
    };
  }
  private pdfSummary(): PdfSourceSummary {
    const documents = [...this.pdf.values()],
      bySource = new Map<
        string,
        {
          stage: AcquisitionAttempt["stage"];
          attempts: Set<string>;
          obtained: Set<string>;
          requests: number;
          errors: number;
          problems: SourceProblem[];
        }
      >();
    const row = (source: string, stage: AcquisitionAttempt["stage"]) => {
      let value = bySource.get(source);
      if (!value) {
        value = {
          stage,
          attempts: new Set(),
          obtained: new Set(),
          requests: 0,
          errors: 0,
          problems: [],
        };
        bySource.set(source, value);
      }
      if (value.stage !== stage) throw new ContractValidationError();
      return value;
    };
    let obtained = 0,
      notObtained = 0,
      unknown = 0;
    for (const d of documents) {
      const unit = d.job + ":" + d.literature;
      for (const a of d.attempts) {
        const r = row(a.source, a.stage);
        if (
          a.requested &&
          !["not-enabled", "cooldown", "escalated"].includes(a.result)
        ) {
          r.attempts.add(unit);
          r.requests++;
          if (
            ["failed", "rejected"].includes(a.result) &&
            !["execution-cancelled", "browser-flow-cancelled"].includes(
              a.code ?? "",
            )
          )
            r.errors++;
        }
        if (
          ["failed", "rejected", "unavailable"].includes(a.result) &&
          !["execution-cancelled", "browser-flow-cancelled"].includes(
            a.code ?? "",
          )
        )
          r.problems.push(
            a.problem ?? sourceProblem(a.code ?? "pdf-source-failed", "pdf"),
          );
      }
      const channel = d.published ?? d.legacyHit;
      if (channel?.source && channel.stage) {
        row(channel.source, channel.stage).obtained.add(unit);
        obtained++;
      } else if (d.terminal) notObtained++;
      else unknown++;
    }
    return {
      documents: documents.length,
      obtained,
      not_obtained: notObtained,
      unknown,
      sources: [...bySource]
        .map(([source, r]) => {
          const problems = problemList(r.problems),
            without = [...r.obtained].filter(
              (id) => !r.attempts.has(id),
            ).length;
          return {
            source,
            stage: r.stage,
            attempted: r.attempts.size,
            obtained: r.obtained.size,
            obtained_without_request: without,
            requests: r.requests,
            errors: r.errors,
            attempt_rate: sourceRatio(r.attempts.size, documents.length),
            hit_rate: sourceRatio(r.obtained.size - without, r.attempts.size),
            error_rate: sourceRatio(r.errors, r.requests),
            problems,
            technical_details: combineSourceDetails(problems),
          };
        })
        .sort(
          (a, b) =>
            ACQUISITION_STAGES.indexOf(a.stage) -
              ACQUISITION_STAGES.indexOf(b.stage) ||
            (a.source === "doi-landing"
              ? -1
              : b.source === "doi-landing"
                ? 1
                : 0),
        ),
    };
  }
  task(): TaskSourceResults {
    const metadata = this.metadataSummary(),
      pdf = this.pdf.size ? this.pdfSummary() : null;
    return parseTaskSourceResults({
      schema_version: 1,
      availability: metadata || pdf ? "recorded" : "unrecorded",
      metadata,
      pdf,
    });
  }
  statistics(
    request: SourceStatisticsRequest,
    asOf: string,
    recordedSince: string | null,
  ): SourceStatistics {
    const states = [...this.metadata.values()],
      groups = new Map<string, MetadataState[]>(),
      topicScopes = new Map<string, Set<string>>();
    for (const s of states) {
      groups.set(s.row.source, [...(groups.get(s.row.source) ?? []), s]);
      if (s.row.purpose === "topic-search" && s.row.role === "primary") {
        const scope = s.job + ":" + s.target,
          ids = topicScopes.get(scope) ?? new Set<string>();
        for (const id of s.included) ids.add(id);
        topicScopes.set(scope, ids);
      }
    }
    const sources: MetadataSourceMetrics[] = [...groups]
      .map(([source, items]) => {
        const ps = items.filter((s) => s.row.role === "primary"),
          requested = items.filter((s) => s.row.requested),
          capabilities = LITERATURE_PROVIDERS[source]?.metadata ?? [],
          purposes = new Set(items.map((s) => s.row.purpose)),
          supported = (p: MetadataSourceRecord["purpose"]) =>
            capabilities.includes(p) || purposes.has(p),
          hits = (purpose: MetadataSourceRecord["purpose"]) => {
            if (!supported(purpose)) return null;
            const calls = ps.filter(
                (s) => s.row.purpose === purpose && s.row.requested,
              ),
              units = new Set(
                calls.map((s) => [s.job, s.target, s.row.unit_id].join(":")),
              ),
              found = new Set(
                calls
                  .filter((s) => s.row.result === "hit")
                  .map((s) => [s.job, s.target, s.row.unit_id].join(":")),
              );
            return sourceRatio(found.size, units.size);
          },
          searches = new Map<string, Set<string>>();
        for (const s of ps.filter(
          (s) => s.row.purpose === "topic-search" && s.row.requested,
        )) {
          const key = s.job + ":" + s.target,
            ids = searches.get(key) ?? new Set<string>();
          for (const id of s.included) ids.add(id);
          searches.set(key, ids);
        }
        let numerator = 0,
          denominator = 0,
          covered = 0,
          merged = 0;
        for (const [scope, ids] of searches) {
          const size = topicScopes.get(scope)?.size ?? 0;
          if (!size) continue;
          numerator += ids.size / size;
          denominator++;
          covered += ids.size;
          merged += size;
        }
        const problems = problemList(items.map((s) => s.row.problem));
        return {
          source,
          topic_coverage: supported("topic-search")
            ? {
                ...sourceRatio(Math.min(numerator, denominator), denominator),
                method: "mean-per-search" as const,
                covered_results: covered,
                merged_results: merged,
              }
            : null,
          lookup_hit: hits("lookup"),
          reference_hit: hits("reference-query"),
          error_rate: sourceRatio(
            requested.filter((s) => s.row.result === "error").length,
            requested.length,
          ),
          problems,
          technical_details: combineSourceDetails(problems),
        };
      })
      .sort(
        (a, b) =>
          (b.topic_coverage?.ratio ?? -1) - (a.topic_coverage?.ratio ?? -1) ||
          a.source.localeCompare(b.source),
      );
    const units = (purpose: MetadataSourceRecord["purpose"]) =>
      new Set(
        states
          .filter(
            (s) =>
              s.row.purpose === purpose &&
              s.row.role === "primary" &&
              s.row.requested,
          )
          .map((s) => [s.job, s.target, s.row.unit_id].join(":")),
      ).size;
    return parseSourceStatistics({
      schema_version: 1,
      range: request.range,
      range_start:
        request.range === "all"
          ? null
          : new Date(Date.parse(asOf) - 30 * 86400000).toISOString(),
      as_of: asOf,
      recorded_since: recordedSince,
      history: "recorded-only",
      pdf: this.pdfSummary(),
      metadata: {
        topic_searches: units("topic-search"),
        lookup_documents: units("lookup"),
        reference_documents: units("reference-query"),
        sources,
      },
    });
  }
}
export function taskSourceResults(
  events: readonly Pick<ExecutionEvent, "job_id" | "kind" | "payload">[],
) {
  const totals = new SourceResultAggregation();
  for (const event of events) totals.accept(event);
  return totals.task();
}
