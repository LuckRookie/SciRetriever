import {
  ACQUISITION_STAGES,
  combineSourceDetails,
  ContractValidationError,
  parseTaskSourceResults,
  sourceProblemForCode,
  type AcquisitionRouteStage,
  type MetadataSourceCounts,
  type MetadataSourceRecord,
  type MetadataSourceSummary,
  type PdfSourceSummary,
  type SourceProblem,
  type TaskSourceResults,
} from "@sciretriever/contracts";
import type { ExecutionEvent } from "../sqlite/worker.js";

const events: typeof import("./source-result-events.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./source-result-events.ts"
      : "./source-result-events.js",
    import.meta.url,
  ).href
);

/** Exact membership and mutable state that may exceed the worker's cache budget. */
export interface TaskResultScratch {
  mark(key: string): boolean;
  has(key: string): boolean;
  read<T>(key: string): T | undefined;
  write(key: string, value: unknown): void;
  delete(key: string): void;
  deletePrefix(prefix: string): void;
  firstKey(prefix: string): string | undefined;
  values<T>(prefix: string, limit: number): T[];
}

export function eventPosition(position: number) {
  return String(position).padStart(16, "0");
}

type Position = readonly [number, number];
const comparePosition = (a: Position, b: Position) =>
  a[0] - b[0] || a[1] - b[1];
type Diagnostic = SourceProblem["technical_details"]["diagnostics"][number];

type SourceProblemGroups = Map<
  SourceProblem["display"],
  {
    first: Position;
    diagnostics: {
      key: string;
      at: Position;
      offset: number;
      value: Diagnostic;
    }[];
  }
>;

/** Keep the first 32 unique diagnostics per display, in full replay order. */
class SourceProblems {
  readonly groups: SourceProblemGroups;

  constructor(groups: SourceProblemGroups = new Map()) {
    this.groups = groups;
  }

  add(problem: SourceProblem, at: Position) {
    let group = this.groups.get(problem.display);
    if (!group) {
      group = { first: at, diagnostics: [] };
      this.groups.set(problem.display, group);
    }
    if (comparePosition(at, group.first) < 0) group.first = at;
    const { diagnostics } = group;
    for (const [
      offset,
      value,
    ] of problem.technical_details.diagnostics.entries()) {
      const key = JSON.stringify(value);
      const existing = diagnostics.findIndex((d) => d.key === key);
      if (existing >= 0) {
        const previous = diagnostics[existing]!;
        if ((comparePosition(at, previous.at) || offset - previous.offset) >= 0)
          continue;
        diagnostics.splice(existing, 1);
      }
      const insert = diagnostics.findIndex(
        (d) => (comparePosition(at, d.at) || offset - d.offset) < 0,
      );
      if (insert >= 0)
        diagnostics.splice(insert, 0, { key, at, offset, value });
      else if (diagnostics.length < 32)
        diagnostics.push({ key, at, offset, value });
      if (diagnostics.length > 32) diagnostics.pop();
    }
  }

  summary() {
    const problems = [...this.groups]
      .sort(([, a], [, b]) => comparePosition(a.first, b.first))
      .map(([display, group]) => ({
        display,
        technical_details: {
          diagnostics: group.diagnostics.map((d) => d.value),
        },
      }));
    return { problems, technical_details: combineSourceDetails(problems) };
  }
}

interface MetadataTally {
  readonly purposes: Set<MetadataSourceRecord["purpose"]>;
  readonly problems: SourceProblems;
  returned: number;
  included: number;
  requests: number;
  attempted_units: number;
  hit_units: number;
  errors: number;
}

interface OpenRecord {
  readonly target: string;
  readonly ordinal: number;
  readonly row: MetadataSourceRecord;
}

interface MetadataTotalsState {
  readonly sources: [
    string,
    Omit<MetadataTally, "problems"> & { problems: SourceProblemGroups },
  ][];
  readonly samples: MetadataSourceRecord[];
  readonly open: Map<string, OpenRecord>;
  readonly count: number;
  readonly returned: number;
  readonly rejected: number;
  readonly merged: number;
  readonly created: number;
  readonly matched: number;
}

class MetadataTotals {
  private readonly scratch: TaskResultScratch;
  private readonly sources = new Map<string, MetadataTally>();
  private readonly samples: MetadataSourceRecord[];
  private readonly open: Map<string, OpenRecord>;
  private count = 0;
  private returned = 0;
  private rejected = 0;
  private merged = 0;
  private created = 0;
  private matched = 0;

  constructor(scratch: TaskResultScratch, state?: MetadataTotalsState) {
    this.scratch = scratch;
    this.samples = state?.samples ?? [];
    this.open = state?.open ?? new Map();
    if (state) {
      for (const [name, source] of state.sources)
        this.sources.set(name, {
          ...source,
          problems: new SourceProblems(source.problems),
        });
      this.count = state.count;
      this.returned = state.returned;
      this.rejected = state.rejected;
      this.merged = state.merged;
      this.created = state.created;
      this.matched = state.matched;
    }
  }

  state(): MetadataTotalsState {
    return {
      sources: [...this.sources].map(([name, source]) => [
        name,
        { ...source, problems: source.problems.groups },
      ]),
      samples: this.samples,
      open: this.open,
      count: this.count,
      returned: this.returned,
      rejected: this.rejected,
      merged: this.merged,
      created: this.created,
      matched: this.matched,
    };
  }

  private saveOpen(key: string, record: OpenRecord) {
    if (this.open.size >= 64 && !this.open.has(key)) {
      const oldest = this.open.entries().next().value!;
      this.scratch.write(oldest[0], oldest[1]);
      this.open.delete(oldest[0]);
    }
    this.open.set(key, record);
  }

  private source(name: string): MetadataTally {
    let source = this.sources.get(name);
    if (!source) {
      if (this.sources.size === 96) throw new ContractValidationError();
      source = {
        returned: 0,
        included: 0,
        requests: 0,
        attempted_units: 0,
        hit_units: 0,
        errors: 0,
        purposes: new Set(),
        problems: new SourceProblems(),
      };
      this.sources.set(name, source);
    }
    return source;
  }

  accept(payload: unknown) {
    const { progress, target } = events.readMetadataProgress(payload);
    const id = progress.record_id;
    const key = "metadata-open|" + id;
    const source = this.source(progress.source);
    if (progress.phase === "started") {
      if (!this.scratch.mark("metadata-record|" + id))
        throw new ContractValidationError();
      const row = events.startMetadataRecord(progress);
      const ordinal = this.count++;
      this.saveOpen(key, { target, ordinal, row });
      if (ordinal < 200) this.samples.push(row);
      source.purposes.add(row.purpose);
      return;
    }

    const inMemory = this.open.get(key);
    const previous = inMemory ?? this.scratch.read<OpenRecord>(key);
    if (!previous) throw new ContractValidationError();
    const prefix = `metadata-record-included|${id}|`;
    const row = events.updateMetadataRecord(
      previous.row,
      target === previous.target,
      progress,
      (included) =>
        previous.row.included + Number(this.scratch.mark(prefix + included)),
    );
    const unit = `${target}:${row.purpose}:${row.unit_id}`;
    if (row.requested && !previous.row.requested) {
      source.requests++;
      if (this.scratch.mark(`metadata-requested|${row.source}|${unit}`))
        source.attempted_units++;
    }
    if (progress.phase === "returned") {
      source.returned += progress.count;
      this.returned += progress.count;
    }
    if (progress.phase === "rejected") this.rejected += progress.count;
    if (progress.phase === "included") {
      if (this.scratch.mark("metadata-merged|" + progress.result_id))
        this.merged++;
      if (
        this.scratch.mark(
          `metadata-source-included|${row.source}|${progress.result_id}`,
        )
      )
        source.included++;
    }
    if (progress.phase === "observed") {
      const seenCreated = "metadata-created|" + progress.result_id;
      const seenMatched = "metadata-matched|" + progress.result_id;
      if (
        progress.disposition === "created" &&
        this.scratch.mark(seenCreated)
      ) {
        this.created++;
        if (this.scratch.has(seenMatched)) this.matched--;
      }
      if (
        progress.disposition === "matched" &&
        !this.scratch.has(seenCreated) &&
        this.scratch.mark(seenMatched)
      )
        this.matched++;
    }

    if (previous.ordinal < 200) this.samples[previous.ordinal] = row;
    if (progress.phase === "finished") {
      if (
        row.requested &&
        row.result === "hit" &&
        this.scratch.mark(`metadata-hit|${row.source}|${unit}`)
      )
        source.hit_units++;
      if (row.requested && row.result === "error") source.errors++;
      if (row.problem) source.problems.add(row.problem, [previous.ordinal, 0]);
      this.open.delete(key);
      if (!inMemory) this.scratch.delete(key);
      if (row.included) this.scratch.deletePrefix(prefix);
    } else if (inMemory) {
      this.saveOpen(key, { ...previous, row });
    } else {
      this.scratch.write(key, { ...previous, row });
    }
  }

  summary(): MetadataSourceSummary | null {
    if (!this.count) return null;
    const sources: MetadataSourceCounts[] = [...this.sources].map(
      ([source, tally]) => ({
        source,
        purpose:
          tally.purposes.size === 1
            ? tally.purposes.values().next().value!
            : "mixed",
        returned: tally.returned,
        included: tally.included,
        requests: tally.requests,
        attempted_units: tally.attempted_units,
        hit_units: tally.hit_units,
        errors: tally.errors,
        coverage: events.sourceRatio(tally.included, this.merged),
        ...tally.problems.summary(),
      }),
    );
    return {
      returned: this.returned,
      merged: this.merged,
      new_literatures: this.created,
      matched_literatures: this.matched,
      rejected: this.rejected,
      sources: sources.sort(
        (a, b) => b.returned - a.returned || a.source.localeCompare(b.source),
      ),
      records: this.samples,
      record_count: this.count,
      records_truncated: this.count > this.samples.length,
    };
  }
}

interface PdfChannel {
  readonly source: string;
  readonly stage: AcquisitionRouteStage;
}

interface PdfDocument {
  readonly ordinal: number;
  terminal: boolean;
  published: PdfChannel | null;
  legacyHit: PdfChannel | null;
}

interface PdfTally {
  readonly source: string;
  firstAttempt: { stage: AcquisitionRouteStage; at: Position } | null;
  readonly finalStages: Partial<Record<AcquisitionRouteStage, number>>;
  attempted: number;
  requests: number;
  errors: number;
  obtained: number;
  withoutRequest: number;
}

interface PdfTotalsState {
  readonly documents: number;
  readonly obtained: number;
  readonly notObtained: number;
  readonly problems: [string, SourceProblemGroups][];
}

/** A retry can add requests or replace a publication for an earlier target. */
class PdfTotals {
  private readonly scratch: TaskResultScratch;
  private documents = 0;
  private obtained = 0;
  private notObtained = 0;
  private readonly problems = new Map<string, SourceProblems>();

  constructor(scratch: TaskResultScratch, state?: PdfTotalsState) {
    this.scratch = scratch;
    if (state) {
      this.documents = state.documents;
      this.obtained = state.obtained;
      this.notObtained = state.notObtained;
      for (const [name, group] of state.problems)
        this.problems.set(name, new SourceProblems(group));
    }
  }

  state(): PdfTotalsState {
    return {
      documents: this.documents,
      obtained: this.obtained,
      notObtained: this.notObtained,
      problems: [...this.problems].map(([name, group]) => [name, group.groups]),
    };
  }

  private source(name: string): PdfTally {
    return (
      this.scratch.read<PdfTally>("pdf-source|" + name) ?? {
        source: name,
        firstAttempt: null,
        finalStages: {},
        attempted: 0,
        requests: 0,
        errors: 0,
        obtained: 0,
        withoutRequest: 0,
      }
    );
  }

  private channel(target: string, document: PdfDocument, direction: 1 | -1) {
    const channel = document.published ?? document.legacyHit;
    if (!channel) {
      if (document.terminal) this.notObtained += direction;
      return;
    }
    this.obtained += direction;
    const { source, stage } = channel;
    const tally = this.source(source);
    tally.obtained += direction;
    tally.finalStages[stage] = (tally.finalStages[stage] ?? 0) + direction;
    if (!this.scratch.has(`pdf-requested|${source}|${target}`))
      tally.withoutRequest += direction;
    const slot = `pdf-channel|${source}|${eventPosition(document.ordinal)}`;
    if (direction === 1) this.scratch.mark(slot);
    else this.scratch.delete(slot);
    if (tally.firstAttempt || tally.obtained)
      this.scratch.write("pdf-source|" + source, tally);
    else this.scratch.delete("pdf-source|" + source);
  }

  accept(event: Pick<ExecutionEvent, "kind" | "payload">, position: number) {
    const { target, final, attempt } = events.readPdfEvent(event);
    const key = "pdf-target|" + target;
    const document = this.scratch.read<PdfDocument>(key) ?? {
      ordinal: this.documents++,
      terminal: false,
      published: null,
      legacyHit: null,
    };
    this.channel(target, document, -1);
    if (final) {
      document.terminal = true;
      if (final.source && final.stage)
        document.published = { source: final.source, stage: final.stage };
    }
    if (attempt) {
      const { source, stage } = attempt;
      const tally = this.source(source);
      const at: Position = [document.ordinal, position];
      if (tally.firstAttempt && tally.firstAttempt.stage !== stage)
        throw new ContractValidationError();
      if (!tally.firstAttempt || comparePosition(at, tally.firstAttempt.at) < 0)
        tally.firstAttempt = { stage, at };
      const facts = events.pdfAttemptFacts(attempt);
      if (facts.requested) {
        tally.requests++;
        if (facts.error) tally.errors++;
        if (this.scratch.mark(`pdf-requested|${source}|${target}`))
          tally.attempted++;
      }
      if (facts.problem) {
        let problems = this.problems.get(source);
        if (!problems) {
          if (this.problems.size === 64) throw new ContractValidationError();
          problems = new SourceProblems();
          this.problems.set(source, problems);
        }
        problems.add(
          attempt.problem ??
            sourceProblemForCode(attempt.code ?? "pdf-source-failed", "pdf"),
          at,
        );
      }
      if (attempt.result === "hit") document.legacyHit = { source, stage };
      this.scratch.write("pdf-source|" + source, tally);
    }
    this.channel(target, document, 1);
    this.scratch.write(key, document);
  }

  summary(): PdfSourceSummary | null {
    if (!this.documents) return null;
    const sources = this.scratch
      .values<PdfTally>("pdf-source|", 65)
      .map((row) => {
        const stages = ACQUISITION_STAGES.filter(
          (stage) =>
            row.firstAttempt?.stage === stage ||
            (row.finalStages[stage] ?? 0) > 0,
        );
        if (stages.length !== 1) throw new ContractValidationError();
        const first = this.scratch.firstKey(`pdf-channel|${row.source}|`);
        const finalAt: Position = [
          first ? Number(first.slice(-16)) : Infinity,
          Infinity,
        ];
        const at =
          row.firstAttempt && comparePosition(row.firstAttempt.at, finalAt) < 0
            ? row.firstAttempt.at
            : finalAt;
        return {
          at,
          metrics: {
            source: row.source,
            stage: stages[0]!,
            attempted: row.attempted,
            obtained: row.obtained,
            obtained_without_request: row.withoutRequest,
            requests: row.requests,
            errors: row.errors,
            attempt_rate: events.sourceRatio(row.attempted, this.documents),
            hit_rate: events.sourceRatio(
              row.obtained - row.withoutRequest,
              row.attempted,
            ),
            error_rate: events.sourceRatio(row.errors, row.requests),
            ...(this.problems.get(row.source)?.summary() ?? {
              problems: [],
              technical_details: { diagnostics: [] },
            }),
          },
        };
      });
    return {
      documents: this.documents,
      obtained: this.obtained,
      not_obtained: this.notObtained,
      unknown: this.documents - this.obtained - this.notObtained,
      sources: sources
        .sort(
          (a, b) =>
            events.comparePdfSources(a.metrics, b.metrics) ||
            comparePosition(a.at, b.at),
        )
        .map(({ metrics }) => metrics),
    };
  }
}

/** Incremental projection of one task's immutable source events. */
export class TaskSourceAggregation {
  private readonly metadata: MetadataTotals;
  private readonly pdf: PdfTotals;

  constructor(
    scratch: TaskResultScratch,
    state?: { metadata: MetadataTotalsState; pdf: PdfTotalsState },
  ) {
    this.metadata = new MetadataTotals(scratch, state?.metadata);
    this.pdf = new PdfTotals(scratch, state?.pdf);
  }

  state() {
    return { metadata: this.metadata.state(), pdf: this.pdf.state() };
  }

  accept(event: Pick<ExecutionEvent, "kind" | "payload">, position: number) {
    if (event.kind === "metadata-source") this.metadata.accept(event.payload);
    else this.pdf.accept(event, position);
  }

  summary(): TaskSourceResults {
    const metadata = this.metadata.summary(),
      pdf = this.pdf.summary();
    return parseTaskSourceResults({
      schema_version: 1,
      availability: metadata || pdf ? "recorded" : "unrecorded",
      metadata,
      pdf,
    });
  }
}
