import type {
  AcquisitionAttempt,
  SourceProblem,
  SourceTechnicalDetails,
} from "@sciretriever/contracts";
import { AuthorizedProviderError } from "./authorized-pdf.js";

/** Stable facts only: never use a vendor message, URL, header or response body. */
export function sourceProblem(
  code: string,
  scope: "metadata" | "pdf" | "runtime",
  error?: unknown,
): SourceProblem {
  let display: SourceProblem["display"] =
    scope !== "runtime" &&
    [
      "missing-credential",
      "credential-missing",
      "missing-provider-configuration",
      "metadata-provider-credential-unavailable",
      "metadata-provider-not-configured",
      "metadata-source-credential-missing",
      "metadata-source-configuration-missing",
    ].includes(code)
      ? "not-configured"
      : scope === "metadata" && code === "metadata-provider-authentication"
        ? "credential-invalid"
        : "error";
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
  const safe = /^[a-z][a-z0-9-]{0,95}$/u.test(code)
    ? code
    : "source-request-failed";
  return {
    display,
    technical_details: {
      diagnostics: [
        {
          code: safe,
          scope,
          ...(http_status === undefined ? {} : { http_status }),
        },
      ],
    },
  };
}
export function combineSourceDetails(
  problems: readonly SourceProblem[],
  extra: readonly SourceTechnicalDetails[] = [],
): SourceTechnicalDetails {
  return {
    diagnostics: [
      ...new Map(
        [...problems.map((p) => p.technical_details), ...extra]
          .flatMap((d) => d.diagnostics)
          .map((d) => [JSON.stringify(d), d]),
      ).values(),
    ].slice(0, 32),
  };
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
