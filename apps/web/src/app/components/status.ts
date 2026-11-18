/**
 * Design core rule 5: the one map from a state to its status colour. Every
 * page marks a status with `data-tone` from here; the colours themselves are
 * the `--status-*` and `--chart-*` tokens, applied in `components.css`.
 *
 * - done: green, ready and finished;
 * - pdf: blue, has a PDF;
 * - problem: red, failed or needs a person;
 * - other: grey, the rest (excluded, cancelled, stale, unobtainable, waiting);
 * - running: grey with a turning ring, work in progress.
 */
export type StatusTone = "done" | "pdf" | "problem" | "other" | "running";

/** A paper's material state (the library's status column and filters). */
export function literatureTone(state: string): StatusTone {
  switch (state) {
    case "READY":
      return "done";
    case "ASSET_READY":
      return "pdf";
    case "ARCHIVE_FAILED":
      return "problem";
    case "ARCHIVING":
      return "running";
    default:
      // UNREVIEWED, EXCLUDED, UNAVAILABLE.
      return "other";
  }
}

/** A durable task's state. */
export function taskTone(status: string): StatusTone {
  if (status === "running") return "running";
  if (status === "completed" || status === "complete") return "done";
  if (status === "failed" || status === "interrupted") return "problem";
  return "other";
}

export type BadgeStatus =
  | "metadata"
  | "pdf"
  | "ready"
  | "running"
  | "partial"
  | "stale"
  | "completed"
  | "failed"
  | "unavailable";
export const badgeTones: Readonly<Record<BadgeStatus, StatusTone>> = {
  metadata: "other",
  pdf: "pdf",
  ready: "done",
  running: "running",
  partial: "other",
  stale: "other",
  completed: "done",
  failed: "problem",
  unavailable: "other",
};

/** A value check on an operator result: found, not found, or neither. */
export function valueCheckTone(status: string): StatusTone {
  if (status === "found") return "done";
  if (status === "not-found") return "problem";
  return "other";
}

/**
 * Rule 4: a progress bar is ink while it runs, green once complete and red
 * when it failed; no tone keeps the ink.
 */
export function progressTone(status: string): StatusTone | undefined {
  const tone = taskTone(status);
  return tone === "done" || tone === "problem" ? tone : undefined;
}
