import type {
  ProcessorCoverage,
  ProofreadSource,
} from "@sciretriever/contracts";
import { Badge, Disclosure } from "../../components/index.js";
import { archiveStrings } from "../../strings.js";
export function SourceBadge({
  source,
  pageOnly = false,
}: {
  source: ProofreadSource;
  pageOnly?: boolean;
}) {
  return (
    <Badge status="completed">
      {
        {
          parser: "解析初稿",
          rule: "规则清理",
          agent: "Agent 矫正",
          manual: "人工修订",
        }[source]
      }
      {pageOnly ? " · 仅页级定位" : ""}
    </Badge>
  );
}
export function ResultState({
  coverage,
  freshness,
}: {
  coverage: readonly ProcessorCoverage[];
  freshness: { state: "current" | "stale"; reasons: readonly unknown[] };
}) {
  const parts = coverage.flatMap((c) => c.parts);
  return (
    <section aria-label="结果覆盖与版本">
      <div className="archive-inline-actions">
        <Badge status={freshness.state === "stale" ? "partial" : "completed"}>
          {freshness.state === "stale" ? "已过时" : "当前版本"}
        </Badge>
        {Object.entries(archiveStrings.outcomes).map(([key, label]) => (
          <span key={key}>
            {label} {parts.filter((p) => p.outcome === key).length}
          </span>
        ))}
      </div>
      {freshness.state === "stale" ? (
        <Disclosure title={`过时原因 · ${freshness.reasons.length}`}>
          <ul>
            {freshness.reasons.map((reason, index) => {
              const r =
                reason && typeof reason === "object"
                  ? (reason as Record<string, unknown>)
                  : {};
              return (
                <li key={index}>
                  {r.kind === "description-version-changed"
                    ? "所用的元数据或标签已变化"
                    : "所读取部分的内容或章节角色已变化"}
                </li>
              );
            })}
          </ul>
          <p>现有结果仍保留。请选择当前文献或生成新快照后显式运行。</p>
        </Disclosure>
      ) : null}
    </section>
  );
}
