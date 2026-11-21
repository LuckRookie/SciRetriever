import {
  combineSourceDetails,
  sourceProblemForCode,
  type AcquisitionAttempt,
  type SourceProblem,
} from "@sciretriever/contracts";
import { AuthorizedProviderError } from "./authorized-pdf.js";
import { isProxyUnavailable } from "../../network/egress.js";
export { combineSourceDetails } from "@sciretriever/contracts";

/** Stable facts only: never use a vendor message, URL, header or response body. */
export function sourceProblem(
  code: string,
  scope: "metadata" | "pdf" | "runtime",
  error?: unknown,
): SourceProblem {
  if (isProxyUnavailable(error)) code = "proxy-unavailable";
  let display: SourceProblem["display"] | undefined;
  let http_status: number | undefined;
  for (
    let current = error, i = 0;
    i < 5 && current instanceof Error;
    i++, current = current.cause
  ) {
    if (!(current instanceof AuthorizedProviderError)) continue;
    const f = current.failure;
    http_status = f.http_status;
    if (f.authentication === "accepted" && f.fulltext_permission === "denied")
      display = "no-fulltext-permission";
    else if (f.http_status === 401 || f.authentication === "rejected")
      display = "credential-invalid";
  }
  return sourceProblemForCode(code, scope, display, http_status);
}

/** Historical codes remain readable; display DTOs put them only in technical details. */
export function presentAcquisitionAttempt(
  attempt: AcquisitionAttempt,
): AcquisitionAttempt {
  const { code, problem: previousProblem, ...value } = attempt;
  const cancelled = ["execution-cancelled", "browser-flow-cancelled"].includes(
    code ?? "",
  );
  const problem = cancelled
    ? undefined
    : (previousProblem ??
      (["failed", "rejected", "unavailable"].includes(attempt.result)
        ? sourceProblem(code ?? "pdf-source-failed", "pdf")
        : undefined));
  const details = combineSourceDetails(problem ? [problem] : [], [
    attempt.technical_details ?? { diagnostics: [] },
    ...(code ? [sourceProblem(code, "pdf").technical_details] : []),
  ]);
  return {
    ...value,
    ...(problem ? { problem } : {}),
    ...(details.diagnostics.length ? { technical_details: details } : {}),
  };
}
