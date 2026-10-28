import {
  BROWSER_AGENT_STOP_REASONS,
  type WorkbenchView,
  type WorkbenchSessionStop,
  type WorkbenchSessionOutcome,
  type WorkbenchArticleCloseOutcome,
} from "@sciretriever/contracts";
import {
  combineSourceDetails,
  presentAcquisitionAttempt,
  sourceProblem,
} from "../providers/shared/source-problem.js";

const neutral = new Set([
  "user",
  "published",
  "delivered",
  "exhausted",
  "cancelled",
  "browser-flow-cancelled",
  "stopped",
  "no-candidate",
]);
const agent = (code: string) =>
  BROWSER_AGENT_STOP_REASONS.some(
    (r) => r === code || `browser-agent-${r}` === code,
  );
function stop(value: WorkbenchSessionStop): WorkbenchSessionStop {
  if (value.problem || neutral.has(value.reason) || agent(value.reason))
    return value;
  return { reason: "error", problem: sourceProblem(value.reason, "runtime") };
}
function outcome(value: WorkbenchSessionOutcome): WorkbenchSessionOutcome {
  if (value.problem || value.kind === "published" || neutral.has(value.code))
    return value;
  return {
    kind: "retained",
    code: "error",
    problem: sourceProblem(value.code, "runtime"),
  };
}
function close(
  value: WorkbenchArticleCloseOutcome | null,
): WorkbenchArticleCloseOutcome | null {
  if (
    !value ||
    value.kind !== "retained" ||
    value.problem ||
    neutral.has(value.code)
  )
    return value;
  return {
    kind: "retained",
    code: "error",
    problem: sourceProblem(value.code, "runtime"),
  };
}
/** Presentation only. Internal close/cancel/receipt decisions retain their original facts. */
export function presentWorkbenchSources(view: WorkbenchView): WorkbenchView {
  const problems = [
    ...(view.problem ? [view.problem] : []),
    ...(view.error && view.error !== "error"
      ? [sourceProblem(view.error, "runtime")]
      : []),
    ...(view.session_cleanup_failure && view.session_cleanup_failure !== "error"
      ? [sourceProblem(view.session_cleanup_failure, "runtime")]
      : []),
  ];
  return {
    ...view,
    ...(problems.length
      ? {
          problem: {
            display: "error",
            technical_details: combineSourceDetails(problems),
          },
        }
      : {}),
    error: view.error ? "error" : null,
    ...(view.session_cleanup_failure
      ? { session_cleanup_failure: "error" }
      : {}),
    ...(view.session_outcome === undefined
      ? {}
      : { session_outcome: close(view.session_outcome) }),
    ...(view.sessions
      ? {
          sessions: view.sessions.map((row) => ({
            ...row,
            ...(row.stop ? { stop: stop(row.stop) } : {}),
            ...(row.outcome ? { outcome: outcome(row.outcome) } : {}),
            ...(row.prior_attempts
              ? {
                  prior_attempts: row.prior_attempts.map(
                    presentAcquisitionAttempt,
                  ),
                }
              : {}),
          })),
        }
      : {}),
    ...(view.actions
      ? {
          actions: view.actions.map((row) => {
            if (
              row.actor !== "platform" ||
              ![
                "navigation-failed",
                "download-failed",
                "validation-failed",
                "flow-stopped",
              ].includes(row.kind) ||
              row.label === "错误" ||
              (row.label && neutral.has(row.label))
            )
              return row;
            const code =
              row.label?.match(/^[a-z][a-z0-9-]{0,95}$/u)?.[0] ??
              (row.kind === "navigation-failed"
                ? row.label?.match(/（([a-z-]+)）/u)?.[1]
                : undefined) ??
              "browser-action-failed";
            return {
              ...row,
              label: "错误",
              technical_details: combineSourceDetails(
                [sourceProblem(code, "runtime")],
                row.technical_details ? [row.technical_details] : [],
              ),
            };
          }),
        }
      : {}),
  };
}
