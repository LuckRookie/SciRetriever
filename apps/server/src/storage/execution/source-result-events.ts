import {
  ACQUISITION_STAGES,
  ContractValidationError,
  parseAcquisitionAttempt,
  parseMetadataSourceProgress,
  parseMetadataSourceRecord,
  parsePdfSourceResult,
  type AcquisitionAttempt,
  type MetadataSourceProgress,
  type MetadataSourceRecord,
  type SourceRatio,
} from "@sciretriever/contracts";
import type { ExecutionEvent } from "../sqlite/worker.js";

export const SOURCE_RESULT_KINDS: ReadonlySet<string> = new Set([
  "metadata-source",
  "acquisition-attempt",
  "pdf-source-result",
]);

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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  return value as Record<string, unknown>;
}

function identifier(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value))
    throw new ContractValidationError();
  return value;
}

export function readMetadataProgress(value: unknown) {
  const p = record(value);
  return {
    progress: parseMetadataSourceProgress(p.progress),
    target: identifier(p.target_id),
  };
}

export function startMetadataRecord(
  progress: MetadataSourceProgress,
): MetadataSourceRecord {
  return {
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
  };
}

export function updateMetadataRecord(
  row: MetadataSourceRecord,
  targetMatches: boolean,
  progress: MetadataSourceProgress,
  include: (id: string) => number,
): MetadataSourceRecord {
  if (
    !targetMatches ||
    row.source !== progress.source ||
    row.purpose !== progress.purpose ||
    row.role !== progress.role ||
    row.unit_id !== progress.unit_id ||
    row.finished_at !== null ||
    Date.parse(progress.at) < Date.parse(row.started_at)
  )
    throw new ContractValidationError();
  let patch: Partial<MetadataSourceRecord> = {};
  if (progress.phase === "requested") patch = { requested: true };
  if (progress.phase === "returned")
    patch = { returned: row.returned + progress.count };
  if (progress.phase === "rejected")
    patch = { rejected: row.rejected + progress.count };
  if (progress.phase === "included")
    patch = { included: include(progress.result_id) };
  if (progress.phase === "finished")
    patch = {
      result: progress.result,
      finished_at: progress.at,
      problem: progress.problem,
    };
  return parseMetadataSourceRecord({ ...row, ...patch });
}

export function readPdfEvent(event: Pick<ExecutionEvent, "kind" | "payload">) {
  const p = record(event.payload);
  const final =
    event.kind === "pdf-source-result" ? parsePdfSourceResult(p.result) : null;
  // A MetaLiterature target may try multiple candidate versions. It is still
  // one requested paper and one final delivery channel in the task.
  const target =
    p.target_id === undefined
      ? (final?.literature_id ?? identifier(p.literature_id))
      : identifier(p.target_id);
  const attempt = final ? null : parseAcquisitionAttempt(p.attempt);
  return {
    target,
    final,
    // DOI resolution prepares metadata evidence. It still identifies a document.
    attempt: attempt?.source === "doi-resolution" ? null : attempt,
  };
}

export function pdfAttemptFacts(attempt: AcquisitionAttempt) {
  const requested =
    attempt.requested &&
    !["not-enabled", "cooldown", "escalated"].includes(attempt.result);
  const cancelled = ["execution-cancelled", "browser-flow-cancelled"].includes(
    attempt.code ?? "",
  );
  const error = !cancelled && ["failed", "rejected"].includes(attempt.result);
  const problem = error || (!cancelled && attempt.result === "unavailable");
  return { requested, error, problem };
}

type PdfSource = {
  readonly source: string;
  readonly stage: AcquisitionAttempt["stage"];
};

export function comparePdfSources(a: PdfSource, b: PdfSource) {
  return (
    ACQUISITION_STAGES.indexOf(a.stage) - ACQUISITION_STAGES.indexOf(b.stage) ||
    (a.source === "doi-landing" ? -1 : b.source === "doi-landing" ? 1 : 0)
  );
}
