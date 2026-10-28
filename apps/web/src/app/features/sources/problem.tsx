import type {
  SourceProblem,
  SourceProblemDisplay,
} from "@sciretriever/contracts";
import { TechDetails } from "../../components/index.js";
import "./problem.css";

/**
 * Requests fail in ways that cannot be enumerated, so the interface never sorts them:
 * every failure reads “错误”, and only the three cases a person can act on get a name.
 * Reason codes stay in the technical details.
 */
const problemNames: Readonly<Record<SourceProblemDisplay, string>> = {
  error: "错误",
  "not-configured": "未配置",
  "credential-invalid": "凭据无效",
  "no-fulltext-permission": "无全文权限",
};

export function problemText(display: string): string {
  return problemNames[display as SourceProblemDisplay] ?? "错误";
}

/** One short failure label; shared by source tests, task details, source statistics and the browser page. */
export function ProblemLabel({
  display,
}: {
  display: SourceProblemDisplay | string;
}) {
  return (
    <span className="problem-label" data-display={display}>
      {problemText(display)}
    </span>
  );
}

/** Reason codes for troubleshooting, folded away; nothing here is shown as the main message. */
export function ProblemDetails({ problem }: { problem: SourceProblem | null }) {
  const diagnostics = problem?.technical_details.diagnostics ?? [];
  if (!diagnostics.length) return null;
  const text = diagnostics
    .map((d) =>
      [
        d.code,
        d.scope,
        d.field,
        d.http_status === undefined ? null : `HTTP ${d.http_status}`,
      ]
        .filter(Boolean)
        .join(" · "),
    )
    .join("\n");
  return (
    <TechDetails copyText={text}>
      <pre>{text}</pre>
    </TechDetails>
  );
}
