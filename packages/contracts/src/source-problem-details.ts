import type {
  SourceProblem,
  SourceTechnicalDetails,
} from "./source-configuration.js";

/** Stable facts only. Vendor messages, URLs, headers and bodies stay private. */
export function sourceProblemForCode(
  code: string,
  scope: "metadata" | "pdf" | "runtime",
  display?: SourceProblem["display"],
  httpStatus?: number,
): SourceProblem {
  return {
    display:
      display ??
      (scope !== "runtime" &&
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
          : "error"),
    technical_details: {
      diagnostics: [
        {
          code: /^[a-z][a-z0-9-]{0,95}$/u.test(code)
            ? code
            : "source-request-failed",
          scope,
          ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
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
